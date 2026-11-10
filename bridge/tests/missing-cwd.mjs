/**
 * D228 / pi 1.5.2: 会话的工作目录没了。
 *
 * 终端里 pi 对这种情况问 Continue / Fork / Cancel；RPC 模式下没有 Continue（pi 带着
 * MissingSessionCwdError 退出），所以桥不 spawn，把事实交给页面，页面给「复制到新目录成新会话」。
 *
 * 这份用例盯的是桥那一侧：
 *   A. 列表里就标出来（cwdMissing），不必先点开一次才发现；
 *   B. 点开 / 接管不会拉起 pi，状态里是 cwdMissing，排队等启动的消息被标红而不是挂着；
 *   C. forkCwd 用 pi 自己的 SessionManager.forkFrom() 复制：新 ID、新目录、历史不动、原文件一个字节不变；
 *   D. 复制出来的新会话能正常打开（这时 pi 才被拉起）。
 *
 * 真 pi 的 settings / session-manager 模块做文件读写（PI_WEB_PI_PKG），pi 本身用 fixtures/fake-pi.mjs。
 *
 *   npm run build:bridge && node bridge/tests/missing-cwd.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7908;
const ROOT = path.join(REPO, ".scratch", "missing-cwd-run");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const GONE = path.join(ROOT, "renamed-away");
const TARGET = path.join(ROOT, "target");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(TARGET, { recursive: true });
// GONE 故意不建：会话记录里指着它，磁盘上已经没有这个目录。

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = false;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed = true;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readRows = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const userTexts = (f) => readRows(f).filter((r) => r.type === "message" && r.message?.role === "user").map((r) => r.message.content[0].text);
const encode = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

// ---------------------------------------------------------------- 一个「目录没了」的会话
const ID = "0190cccc-0000-7000-8000-00000000000a";
const t = (n) => new Date(Date.UTC(2026, 0, 2, 0, n)).toISOString();
const user = (id, parentId, text, n) => ({ type: "message", id, parentId, timestamp: t(n), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(t(n)) } });
const asst = (id, parentId, text, n) => ({
  type: "message",
  id,
  parentId,
  timestamp: t(n),
  message: { role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(t(n)) },
});
const dir = path.join(AGENT, "sessions", encode(GONE));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `2026-01-02T00-00-00-000Z_${ID}.jsonl`);
fs.writeFileSync(
  file,
  [
    { type: "session", version: 3, id: ID, timestamp: t(0), cwd: GONE },
    user("u1", null, "这个项目原来叫什么", 1),
    asst("a1", "u1", "原来的名字在这里", 2),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
const old = new Date(Date.now() - 3600_000);
fs.utimesSync(file, old, old);
const sourceBytes = fs.readFileSync(file);

// ---------------------------------------------------------------- 桥
const CHILD_ENV = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  PI_WEB_PI_PKG: realPkg,
  FAKE_PI_LOG: PI_LOG,
};
const bridgeOut = [];
const child = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (b) => bridgeOut.push(b.toString()));
child.stderr.on("data", (b) => bridgeOut.push(b.toString()));

/**
 * 桥自己会把每个会话的 pi 启动写进 stdout（`[boot] <id> pi 启动完成 …`）—— 比数假 pi 的日志准：
 * 目录这些地方还会临时 spawn（模型目录的 `-ne`），数进程数会把它们也算进来。
 */
const booted = (id) => bridgeOut.join("").includes(`[boot] ${id} pi 启动完成`);

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

let ws;
const seen = [];
const waits = [];
const waitFor = (pred, ms, what, from = 0) => {
  const hit = seen.slice(from).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      waits.splice(waits.indexOf(w), 1);
      reject(new Error(`timeout: ${what}`));
    }, ms);
    waits.push(w);
  });
};
const send = (m) => ws.send(JSON.stringify(m));
const ask = async (m, pred, what) => {
  const mark = seen.length;
  send(m);
  return waitFor(pred, 15000, what, mark);
};

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  const hello = await waitFor((m) => m.type === "hello", 8000, "hello");

  // ---------------------------------------------------------- A. 列表里就看得出来
  log("A. 列表里标出「目录没了」");
  const listed = (hello.sessions ?? []).find((s) => s.id === ID);
  check(Boolean(listed), "磁盘上的会话在列表里");
  check(listed?.cwdMissing === true, "cwdMissing 已标出（不必先点开一次）");
  check(!booted(ID), "没有为它起过 pi");

  // ---------------------------------------------------------- B. 打开 / 接管不 spawn
  log("B. 点开、接管都不会拉起 pi");
  await ask({ type: "subscribe", sessionId: ID }, (m) => m.type === "session" && m.sessionId === ID, "subscribe");
  const claim = await ask({ type: "claim", sessionId: ID }, (m) => m.type === "session" && m.sessionId === ID, "claim");
  check(claim.state?.cwdMissing === true, "接管后的状态仍是 cwdMissing");
  check(claim.state?.starting !== true, "没有停在「启动中」");
  // 排一条消息进去：pi 永远不会起来，它不能被挂在「处理中」。
  const mark = seen.length;
  send({ type: "prompt", sessionId: ID, text: "这条不该发出去", clientId: "c1" });
  const noticed = await waitFor((m) => m.type === "notice" && m.sessionId === ID, 10000, "notice", mark);
  check(/工作目录已经不存在/.test(String(noticed.text ?? "")), `说了为什么没发（${String(noticed.text ?? "").slice(0, 30)}…）`);
  check(noticed.level === "error", "是按错误报的");
  await sleep(500);
  check(!booted(ID), "全程没有为它起 pi");

  // ---------------------------------------------------------- C. 复制到新目录
  log("C. forkCwd：pi 自己的 forkFrom() 复制，新 ID / 新目录 / 历史不动");
  const fork = await ask({ type: "forkCwd", reqId: "fc1", sessionId: ID, cwd: TARGET }, (m) => m.type === "forkCwd.result", "forkCwd");
  const newId = String(fork.sessionId ?? "");
  check(!fork.error && newId && newId !== ID, `拿到新会话 id（${fork.error ?? newId.slice(0, 8)}）`);
  const newDir = path.join(AGENT, "sessions", encode(TARGET));
  const landedName = fs.existsSync(newDir) ? fs.readdirSync(newDir).find((f) => f.endsWith(`${newId}.jsonl`)) : "";
  const landed = landedName ? path.join(newDir, landedName) : "";
  check(Boolean(landed), `新会话文件落在目标目录下（${path.relative(ROOT, landed || "?")}）`);
  const header = readRows(landed)[0];
  check(header.type === "session" && header.id === newId, "会话头是新的 id");
  check(path.resolve(String(header.cwd)) === path.resolve(TARGET), `会话头里的 cwd 换成了 ${TARGET}`);
  const texts = userTexts(landed);
  check(texts.includes("这个项目原来叫什么") && texts.includes("这条不该发出去") === false, `历史被带过去（${JSON.stringify(texts)}）`);
  check(fs.readFileSync(file).equals(sourceBytes), "原会话文件一个字节都没动");

  // ---------------------------------------------------------- D. 复制出来的会话能正常打开
  log("D. 新会话能打开，这时 pi 才被拉起");
  const opened = await ask({ type: "claim", sessionId: newId }, (m) => m.type === "session" && m.sessionId === newId, "claim new");
  check(opened.state?.cwdMissing !== true, "新会话没有 cwdMissing");
  await until(() => booted(newId), 20000, "boot");
  check(booted(newId), "pi 起来了（桥的启动日志里有它）");
  check(String(opened.state?.cwd).toLowerCase().includes("target"), `state.cwd 是目标目录（${opened.state?.cwd}）`);
} catch (err) {
  failed = true;
  console.error("  FAIL", err instanceof Error ? err.message : err);
} finally {
  try {
    ws?.close();
  } catch {}
  child.kill();
  await sleep(300);
  if (!failed) log("all checks passed");
  else {
    console.error("\n—— 桥的日志尾巴 ——");
    console.error(bridgeOut.join("").split("\n").slice(-25).join("\n"));
  }
  process.exit(failed ? 1 : 0);
}
