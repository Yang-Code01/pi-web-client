/**
 * 「全部休眠」（#80 / D120）：设置 → 运行时的那个出口，一次性收掉所有空闲会话，**正在跑的一轮绝不动**。
 *
 * 三件事，都从外面看（WS 消息 + 桩 pi 自己的记录，bridge/tests/fixtures/fake-pi.mjs）：
 *   1. 回执 `runtime.sleepAll` 带 `slept` 与 `skipped[{id,name,why:"running"}]` —— 在跑的那个被点名跳过；
 *   2. 桩 pi 的记录里，在跑那个进程**没有收到 abort**，也没退出；空闲那个真退了（`exit` 行）；
 *   3. 回执之后桥立刻广播一条新的 `runtime.stats`（数字当场变小），不必等下一个 GC tick。
 *
 * 阈值不用挤：这条消息不吃空闲阈值，所以 `idleMs` 留在 30 分钟、GC tick 留在 60 秒，
 * 期间发生的任何休眠都只可能是按钮点出来的。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/sleep-all.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "sleep-all");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = 7904;

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

/** A bridge on its own state dir, pointed at the stub pi. Thresholds left at their real values. */
async function startBridge(name) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });

  const out = [];
  const child = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(PORT),
      PI_WEB_STATE: state,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: agent,
      PI_BIN: FAKE_PI,
      FAKE_PI_LOG: piLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  const base = `http://127.0.0.1:${PORT}`;
  await until(() => fs.existsSync(path.join(state, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${base}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(state, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  /** Every line the stub pi wrote: launches (`argv`), turns, aborts, exits. */
  const records = () =>
    fs.existsSync(piLog)
      ? fs
          .readFileSync(piLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return { out, cookie, records, stop: () => child.kill() };
}

async function client(bridge) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: bridge.cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("    notice:", msg.text);
    for (const w of [...waits]) {
      if (w.pred(msg)) {
        waits.delete(w);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (err) => reject(new Error(`ws: ${err?.message ?? err}`)));
  });
  const page = {
    seen,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    notices: (sid) => seen.filter((m) => m.type === "notice" && m.sessionId === sid),
    waitFor: (pred, ms, label) => {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const entry = { pred, resolve };
        entry.timer = setTimeout(() => {
          waits.delete(entry);
          reject(new Error(`timeout: ${label}`));
        }, ms);
        waits.add(entry);
      });
    },
  };
  await page.waitFor((m) => m.type === "hello", 5000, "hello");
  return page;
}

/** The launch line of the pi that owns this session (`--session-id <id>`, or `--session <file>`). */
const lastLaunch = (records, sid) => records.filter((e) => e.t === "argv" && e.argv.includes(sid)).at(-1) ?? null;
const exited = (records, pid) => records.some((e) => e.t === "exit" && e.pid === pid);
const aborted = (records, pid) => records.some((e) => e.t === "abort" && e.pid === pid);

async function newSession(page, name) {
  const mark = page.seen.length;
  page.send({ type: "create", cwd: REPO, name });
  const created = await page.waitFor(
    (m) => m.type === "session" && m.sessionId && page.seen.indexOf(m) >= mark,
    20000,
    `create ${name}`,
  );
  return created.sessionId;
}

async function settled(page, sid, text) {
  page.send({ type: "prompt", sessionId: sid, text });
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === false, 20000, `settle ${text}`);
}

// ---------------------------------------------------------------- A. one idle + one running
async function oneIdleOneRunning() {
  log("A. 一个空闲 + 一个在跑 → 只睡空闲的，回执把在跑的列进 skipped，且它没收到 abort");
  const bridge = await startBridge("mixed");
  try {
    const page = await client(bridge);
    const idleSid = await newSession(page, "空闲的");
    await settled(page, idleSid, "hello");
    const idlePid = lastLaunch(bridge.records(), idleSid)?.pid;

    const runSid = await newSession(page, "还在跑的");
    page.send({ type: "prompt", sessionId: runSid, text: "SLOW forever" });
    await page.waitFor((m) => m.type === "pi.status" && m.sessionId === runSid && m.running === true, 20000, "running");
    const runPid = lastLaunch(bridge.records(), runSid)?.pid;
    check(idlePid && runPid && idlePid !== runPid, `两个会话是两个 pi 进程（${idlePid} / ${runPid}）`);

    // The panel asks first: the new numbers are broadcast to pages that want them (D120 / #77).
    page.send({ type: "runtime.stats" });
    const stats = await page.waitFor((m) => m.type === "runtime.stats" && m.running === 2, 10000, "runtime.stats 2 个");
    check(stats.sessions.length === 2, `面板上先看得见 2 个（${stats.sessions.length}）`);
    const mark = page.seen.length;

    page.send({ type: "runtime.sleepAll" });
    const receipt = await page.waitFor((m) => m.type === "runtime.sleepAll" && page.seen.indexOf(m) >= mark, 20000, "回执");

    check(Array.isArray(receipt.slept) && receipt.slept.length === 1 && receipt.slept[0] === idleSid, `slept = 空闲那个（${JSON.stringify(receipt.slept)}）`);
    check(Array.isArray(receipt.skipped) && receipt.skipped.length === 1, `skipped 只有一条（${JSON.stringify(receipt.skipped)}）`);
    const skip = receipt.skipped?.[0] ?? {};
    check(skip.id === runSid, `跳过的就是还在跑的那个（${skip.id}）`);
    check(skip.name === "还在跑的", `回执点名：${JSON.stringify(skip.name)}`);
    check(skip.why === "running", `原因写明 running（${JSON.stringify(skip.why)}）`);

    // The evidence that matters: pi's own log. The running turn was never aborted.
    check(!aborted(bridge.records(), runPid), "在跑的那个进程没有收到 abort");
    check(!exited(bridge.records(), runPid), "在跑的那个进程还在");
    check(
      !page.notices(runSid).some((n) => /休眠/.test(n.text)),
      "在跑的会话没有收到休眠说明",
    );

    // The idle one really went away, and the notice says so.
    await until(() => exited(bridge.records(), idlePid), 15000, "空闲的进程退出");
    check(true, "空闲那个的 pi 进程真的退了（桩记录到 exit 行）");
    check(
      page.notices(idleSid).some((n) => /休眠/.test(n.text)),
      "空闲那个收到「已休眠」说明",
    );

    // The numbers drop without waiting for the 60 s tick.
    const after = await page.waitFor((m) => m.type === "runtime.stats" && page.seen.indexOf(m) > page.seen.indexOf(receipt), 10000, "回执后的 runtime.stats");
    check(after.running === 1, `回执之后广播的新数字是 1 个（${after.running}）`);
    check(
      !after.sessions.some((s) => s.id === idleSid),
      `睡掉的会话不在新清单里（${JSON.stringify(after.sessions.map((s) => s.id))}）`,
    );
    check(after.sessions.some((s) => s.id === runSid && s.running === true), "还在跑的那个仍然列着，且标着 running");

    // Pressing it again: nothing left to sleep but the running one, so it is all skips.
    page.send({ type: "runtime.sleepAll" });
    const again = await page.waitFor(
      (m) => m.type === "runtime.sleepAll" && page.seen.indexOf(m) > page.seen.indexOf(receipt),
      20000,
      "第二次回执",
    );
    check(again.slept.length === 0 && again.skipped.length === 1 && again.skipped[0].id === runSid, `再按一次：一个都没睡，只点名在跑的（${JSON.stringify(again)}）`);
    check(!aborted(bridge.records(), runPid), "第二次也没碰在跑的那个");
  } finally {
    bridge.stop();
  }
}

// ---------------------------------------------------------------- B. nothing live at all
async function nothingToSleep() {
  log("B. 一个 pi 都没起 → 回执是两张空清单（界面据此说「本来就是空的」）");
  const bridge = await startBridge("empty");
  try {
    const page = await client(bridge);
    // A page only hears the runtime numbers after it asked for them (D120 / #77), and the button
    // lives on that panel — so it has always asked by the time it can be pressed.
    page.send({ type: "runtime.stats" });
    const before = await page.waitFor((m) => m.type === "runtime.stats", 10000, "空统计");
    check(before.running === 0, `先看到 0 个（${before.running}）`);
    page.send({ type: "runtime.sleepAll" });
    const receipt = await page.waitFor((m) => m.type === "runtime.sleepAll", 10000, "空回执");
    check(Array.isArray(receipt.slept) && receipt.slept.length === 0, `slept 是空清单（${JSON.stringify(receipt.slept)}）`);
    check(Array.isArray(receipt.skipped) && receipt.skipped.length === 0, `skipped 是空清单（${JSON.stringify(receipt.skipped)}）`);
    const stats = await page.waitFor((m) => m.type === "runtime.stats" && page.seen.indexOf(m) > page.seen.indexOf(receipt), 10000, "空广播");
    check(stats.running === 0, `随后广播的统计是 0 个（${stats.running}）`);
  } finally {
    bridge.stop();
  }
}

try {
  await oneIdleOneRunning();
  await nothingToSleep();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
