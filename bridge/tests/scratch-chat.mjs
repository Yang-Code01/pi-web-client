/**
 * 随手问（#86）：不进列表、懒建、同进程清空、三条豁免。
 *
 * 全部从外面看：`/api/sessions` 的输出、桩 pi 自己的 jsonl（argv / 收到的命令 / 退出）、
 * 磁盘上的临时目录。不看桥的内部字段。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/scratch-chat.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "scratch-chat");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const SCRATCH = path.join(STATE, "scratch");
const PORT = 7906;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

/** The stub pi's own record: argv, commands, exits. One line per fact, JSONL. */
function piNotes() {
  if (!fs.existsSync(PI_LOG)) return [];
  return fs
    .readFileSync(PI_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
const notesOf = (pid) => piNotes().filter((n) => n.pid === pid);
/** 只有真正的会话进程才算：桥自己还会 spawn 一个 `pi --version` 探针，那个不算。 */
const sessionArgv = () => piNotes().filter((n) => n.t === "argv" && (n.argv ?? []).includes("-e"));
const argvWith = (name) => sessionArgv().find((n) => (n.argv ?? []).includes(name));

let bridge = null;
let bridgeOut = [];
let cookie = "";
let ws = null;
const seen = [];

async function startBridge(extraEnv = {}) {
  bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_STATE: STATE,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: AGENT,
      PI_BIN: FAKE_PI,
      FAKE_PI_LOG: PI_LOG,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeOut = [];
  bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  seen.length = 0;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", (e) => j(new Error(`ws: ${e.message}`)));
  });
}

async function stopBridge() {
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  if (!bridge) return;
  const dead = new Promise((r) => bridge.once("exit", r));
  bridge.kill();
  await Promise.race([dead, sleep(8000)]);
  bridge = null;
  // 关桥 = 清空：shutdown 里会擦一次临时目录，给它一点时间。
  await until(() => !fs.existsSync(path.join(SCRATCH, "sessions")) || fs.readdirSync(path.join(SCRATCH, "sessions")).length === 0, 8000, "临时目录被清空").catch(() => {});
}

const waitFor = async (pred, ms, label) => {
  await until(() => seen.some(pred), ms, label);
  return seen.find(pred);
};
const send = (obj) => ws.send(JSON.stringify(obj));
const listIds = async () => {
  const res = await fetch(`${BASE}/api/sessions`, { headers: { cookie } });
  const body = await res.json();
  return (body.sessions ?? []).map((s) => s.id);
};

try {
  // ---------------------------------------------------------------- A. 懒建 / 参数 / 不进列表 / 清空
  log("A. 懒建 + 启动参数 + 不进列表 + 同进程清空");
  await startBridge();
  const before = piNotes().length;
  check(before === 0, "桥刚起来时桩 pi 一条日志都没有（没人打开随手问，就不该有进程）");

  const list0 = await listIds();
  send({ type: "scratch.open" });
  const first = await waitFor((m) => m.type === "scratch", 30000, "scratch 快照");
  const sid = first.sessionId;
  check(Boolean(sid), `打开后拿到 sessionId（${sid}）`);
  check(first.state?.scratch === true, "快照里标着 scratch（页面据此不把它当会话）");
  check((await listIds()).join(",") === list0.join(","), "会话列表里从头到尾没有它");

  // 桩 pi 写自己的 argv 是在它启动之后，跟 `scratch` 快照不是同一个时序：等它落盘。
  await until(() => argvWith("--session-dir"), 15000, "桩 pi 的 argv 日志");
  const argvNote = argvWith("--session-dir");
  const argv = argvNote?.argv ?? [];
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : "";
  };
  const dirArg = argOf("--session-dir");
  check(Boolean(dirArg) && path.resolve(dirArg) === path.resolve(path.join(SCRATCH, "sessions")), `pi 被指到临时会话目录（--session-dir ${dirArg}）`);
  check(argOf("--tools") === "read,grep,find,ls", `只给读工具（--tools ${argOf("--tools")}）`);
  check(path.resolve(argvNote?.cwd ?? "") === path.resolve(path.join(SCRATCH, "cwd")), `pi 跑在中性空目录（cwd ${argvNote?.cwd}）`);

  send({ type: "prompt", sessionId: sid, text: "问一句" });
  // 回答可能是 item.add，也可能是流式 delta / item.replace —— 只关心那段文字到没到。
  const replied = await waitFor(
    (m) =>
      m.sessionId === sid &&
      ((m.type === "delta" && /echo: 问一句/.test(m.text ?? "")) ||
        ((m.type === "item.add" || m.type === "item.replace") && /echo: 问一句/.test(m.item?.text ?? ""))),
    30000,
    "回答",
  );
  check(Boolean(replied), "能提问、能回答");

  const pid1 = argvNote.pid;
  const framesBefore = seen.filter((m) => m.type === "scratch").length;
  send({ type: "scratch.clear" });
  // 清空的证据在桩 pi 自己的日志里：同一个 pid 收到过 new_session。
  await until(() => notesOf(pid1).some((n) => n.t === "new_session"), 30000, "new_session");
  await until(() => seen.filter((m) => m.type === "scratch").length > framesBefore, 15000, "清空后的快照");
  const cleared = seen.filter((m) => m.type === "scratch").at(-1);
  check(Boolean(cleared), "清空后回到空对话");
  const bump = notesOf(pid1).find((n) => n.t === "new_session");
  check(Boolean(bump), "同一个 pi 进程收到了 new_session（不是重新 spawn）");
  check(sessionArgv().length === 1, "全程只有一个会话进程（没有第二个 argv 记录）");
  check(sessionArgv().every((n) => n.pid === pid1), "清空没有换进程（pid 不变）");
  check(Boolean(bump?.before) && !fs.existsSync(bump.before), `旧的会话文件被删掉了（${path.basename(bump?.before ?? "")}）`);
  check(cleared.state?.file === bump?.file, "桥跟着换到了新的会话文件");

  // ---------------------------------------------- B. 休眠：它有自己的时间，比普通会话长
  log("B. 休眠豁免：普通会话 1.5 秒睡，随手问按自己的 60 秒走");
  await stopBridge();
  // 注：Windows 上 kill() 是直接结束进程，SIGTERM 处理器不一定跑得到 —— 所以「关桥即清空」在
  // 这里不做断言，改为在 C 段断言真正兜底的那条：启动时无条件清空。
  await startBridge({ PI_WEB_IDLE_MS: "1500", PI_WEB_SCRATCH_IDLE_MS: "60000", PI_WEB_GC_TICK_MS: "200" });

  send({ type: "create", cwd: REPO, name: "普通会话" });
  await waitFor((m) => m.type === "session" && m.state?.name === "普通会话", 30000, "普通会话");
  send({ type: "scratch.open" });
  await waitFor((m) => m.type === "scratch" && m.sessionId, 30000, "随手问");
  await until(() => argvWith("普通会话") && argvWith("随手问"), 20000, "两个会话进程的 argv");
  const normalPid = argvWith("普通会话")?.pid;
  const scratchPid = argvWith("随手问")?.pid;
  check(Boolean(normalPid && scratchPid), `两个会话进程都在（普通 ${normalPid} / 随手问 ${scratchPid}）`);
  const exits = () => new Set(piNotes().filter((n) => n.t === "exit").map((n) => n.pid));
  await until(() => exits().has(normalPid), 25000, "普通会话被休眠");
  check(exits().has(normalPid), "普通会话按 1.5 秒的通用阈值睡了");
  check(!exits().has(scratchPid), "随手问没睡（它按自己那 60 秒的规则走）");

  // ---------------------------------------------------------------- C. 重启后不留残留
  log("C. 桥重启：临时目录清空，页面重新问一次就是空的");
  await stopBridge();
  fs.writeFileSync(path.join(SCRATCH, "sessions", "leftover.jsonl"), "{}\n");
  await startBridge();
  check(!fs.existsSync(path.join(SCRATCH, "sessions", "leftover.jsonl")), "启动时把崩溃残留清掉了");
  send({ type: "scratch.open" });
  const fresh = await waitFor((m) => m.type === "scratch" && m.sessionId, 30000, "重启后的随手问");
  check((fresh.items ?? []).length === 0, "重启后的随手问是空的（不装作还记得）");

  await stopBridge();
} catch (err) {
  failed += 1;
  console.error("FAIL", err?.message ?? err);
  console.error(bridgeOut.join("").slice(-3000));
  await stopBridge();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
