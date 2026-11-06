/**
 * 默认权限（D157）: `web.defaultPermission` 写进 pi 的 settings.json，项目覆盖全局；会话第一次被
 * 桥看见时钉进 `state/allow/<id>.json`（带 `from: "default"`），手动改过的会话从此不再被
 * 「应用到现有会话」碰到。
 *
 * 真 pi 的 settings 模块做文件读写（PI_WEB_PI_PKG），pi 本身用 fixtures/fake-pi.mjs。
 *
 *   npm run build:bridge && node bridge/tests/default-permission.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7903;
const ROOT = path.join(REPO, ".scratch", "default-permission-run");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const OTHER = path.join(ROOT, "other");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(PROJECT, ".pi"), { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });

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
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const allowPath = (id) => path.join(STATE, "allow", `${id}.json`);
const allowOf = (id) => (fs.existsSync(allowPath(id)) ? readJson(allowPath(id)) : null);

// Everything both launches need. Never `{}`: an empty env sends the bridge to its real state dir.
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
const launch = () => {
  const child = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  child.stderr.on("data", (b) => bridgeOut.push(b.toString()));
  return child;
};
let bridge = launch();
let bridge2 = null;

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
  return waitFor(pred, 10000, what, mark);
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
  await waitFor((m) => m.type === "hello", 5000, "hello");

  // ---------------------------------------------------------- A. 出厂值 = ask
  log("A. 没有任何设置时，新会话钉的是 ask");
  const a = await ask({ type: "create", cwd: OTHER, name: "no-default" }, (m) => m.type === "session" && m.sessionId, "create");
  await until(() => allowOf(a.sessionId), 5000, "allow file");
  check(allowOf(a.sessionId)?.mode === "ask" && allowOf(a.sessionId)?.from === "default", `allow file pinned (${JSON.stringify(allowOf(a.sessionId))})`);
  check(a.state.permission === "ask", "session state agrees with the file");

  // ---------------------------------------------------------- B. 全局默认
  log("B. 全局 web.defaultPermission 生效；老会话不动");
  await ask({ type: "settings.set", scope: "global", patch: { "web.defaultPermission": "strict" } }, (m) => m.type === "settings" && m.saved, "set global");
  check(readJson(path.join(AGENT, "settings.json")).web?.defaultPermission === "strict", "written under the web namespace");
  const b = await ask({ type: "create", cwd: OTHER, name: "global-default" }, (m) => m.type === "session" && m.sessionId, "create");
  await until(() => allowOf(b.sessionId), 5000, "allow file");
  check(allowOf(b.sessionId)?.mode === "strict" && allowOf(b.sessionId)?.from === "default", `new session got strict (${JSON.stringify(allowOf(b.sessionId))})`);
  check(allowOf(a.sessionId)?.mode === "ask", "the older session kept ask — pinned at its own creation");

  // ---------------------------------------------------------- C. 项目覆盖全局（且要信任）
  log("C. 项目设置覆盖全局，但未信任的项目不算");
  fs.writeFileSync(path.join(PROJECT, ".pi", "settings.json"), JSON.stringify({ web: { defaultPermission: "auto" } }, null, 2));
  const c1 = await ask({ type: "create", cwd: PROJECT, name: "untrusted-project" }, (m) => m.type === "session" && m.sessionId, "create");
  await until(() => allowOf(c1.sessionId), 5000, "allow file");
  check(allowOf(c1.sessionId)?.mode === "strict", `untrusted project ignored → global strict (${JSON.stringify(allowOf(c1.sessionId))})`);

  const t = await ask({ type: "trust.set", cwd: PROJECT, option: 0 }, (m) => m.type === "trust" && m.saved, "trust");
  check(t.trust.effective, "project trusted");
  const c2 = await ask({ type: "create", cwd: PROJECT, name: "trusted-project" }, (m) => m.type === "session" && m.sessionId, "create");
  await until(() => allowOf(c2.sessionId), 5000, "allow file");
  check(allowOf(c2.sessionId)?.mode === "auto", `trusted project wins over global (${JSON.stringify(allowOf(c2.sessionId))})`);

  // ---------------------------------------------------------- D. 手动改过的不再算默认
  log("D. 手动切换权限会去掉 from 标记");
  await ask({ type: "setPermission", sessionId: b.sessionId, mode: "readonly" }, (m) => m.type === "session.state" && m.session?.id === b.sessionId && m.session.permission === "readonly", "setPermission");
  check(allowOf(b.sessionId)?.mode === "readonly" && !("from" in allowOf(b.sessionId)), `manual pick cleared the marker (${JSON.stringify(allowOf(b.sessionId))})`);

  // ---------------------------------------------------------- E. 清单 + 应用
  log("E. permission.defaults / permission.applyDefault");
  await ask({ type: "settings.set", scope: "global", patch: { "web.defaultPermission": "readonly" } }, (m) => m.type === "settings" && m.saved, "set global");
  let d = await ask({ type: "permission.defaults" }, (m) => m.type === "permission.defaults" && m.cwd === null, "defaults");
  check(d.mode === "readonly" && d.source === "global", `resolved to the new global value (${d.mode}/${d.source})`);
  // a (ask, pinned), b (manual readonly), c1 (strict, pinned), c2 (auto, pinned)
  // The reply carries a count, not the ids: the manual session is proven excluded by the apply below.
  check(d.total === 3, `three sessions still on defaults, the manual one excluded (${d.total})`);
  const applied = await ask({ type: "permission.applyDefault" }, (m) => m.type === "permission.applied", "apply");
  check(applied.applied === 3, `applied to three (${applied.applied})`);
  // Each session resolves against its own cwd: PROJECT now has auto, OTHER falls back to global readonly.
  check(allowOf(a.sessionId)?.mode === "readonly", "OTHER session → global readonly");
  check(allowOf(c2.sessionId)?.mode === "auto", "PROJECT session → its own project auto");
  check(allowOf(a.sessionId)?.from === "default" && allowOf(c2.sessionId)?.from === "default", "still marked as default (a second apply keeps working)");
  check(allowOf(b.sessionId)?.mode === "readonly" && !("from" in allowOf(b.sessionId)), "manual session untouched");

  // ---------------------------------------------------------- F. 启动扫描
  log("F. 重启桥后，磁盘上没见过允许文件的会话被补钉");
  // 一个桥从没见过的磁盘会话：直接写 pi 的会话文件（fake pi 不写，--session-dir 才写）。
  process.env.PI_AGENT_DIR = AGENT;
  const { encodeCwd } = await import("../dist/sessions.js");
  const diskId = "11111111-2222-4333-8444-555555555555";
  const diskDir = path.join(AGENT, "sessions", encodeCwd(OTHER));
  fs.mkdirSync(diskDir, { recursive: true });
  fs.writeFileSync(path.join(diskDir, `${diskId}.jsonl`), `${JSON.stringify({ type: "session", id: diskId, cwd: OTHER })}
`);
  check(!fs.existsSync(allowPath(diskId)), "no allow file before the restart");
  ws.close();
  bridge.kill("SIGTERM");
  await until(() => bridge.exitCode !== null || bridge.signalCode !== null, 10000, "bridge exit");
  bridge2 = launch();
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up again");
  await until(() => allowOf(diskId), 15000, "startup pin");
  check(allowOf(diskId)?.mode === "readonly" && allowOf(diskId)?.from === "default", `startup scan pinned the disk session (${JSON.stringify(allowOf(diskId))})`);
  check(allowOf(b.sessionId)?.mode === "readonly" && !("from" in allowOf(b.sessionId)), "the manual pick survived the restart");
  bridge2.kill("SIGTERM");
  await until(() => bridge2.exitCode !== null || bridge2.signalCode !== null, 10000, "bridge2 exit");
} catch (err) {
  failed = true;
  console.error("FAIL", err?.message ?? err);
} finally {
  try {
    ws?.close();
  } catch {}
  for (const child of [bridge, bridge2]) {
    try {
      child?.kill("SIGTERM");
    } catch {}
  }
  if (failed) {
    const tail = bridgeOut.join("").split("\n").slice(-30).join("\n");
    console.error("\n--- bridge output (tail) ---\n" + tail);
    process.exit(1);
  }
  console.log("\nall checks passed");
  process.exit(0);
}
