/**
 * The memory watermark (#79, D120 §2): with every live pi together above `maxBytes`, the sessions
 * that have been silent longest sleep until the total is back under it.
 *
 * Guardrails, one phase each:
 *   A. ordered reaping — the longest-idle one goes first, and the pass stops as soon as the total is
 *      back under the cap (a decoy pid in the table proves only our own children are counted);
 *   B. never to zero — one live pi always stays, however small the cap;
 *   C. never a pi that just woke — the protection window holds it, and the same session is reaped
 *      once the window is over;
 *   D. never on a bad reading — a broken process table reaps nobody (D120 §6), while the idle rule
 *      next to it still fires: only one of the two judgements needs the numbers.
 *
 * Everything is observed from outside: WS notices and the stub pi's log
 * (bridge/tests/fixtures/fake-pi.mjs), so "the process really went away" is provable. The process
 * table is fixtures/fake-tasklist.mjs (`PI_WEB_PROCESS_TABLE_BIN`), which prints the pids this test
 * writes, so the readings are the **real** pids of the real stub children.
 *
 * Run: npm --prefix bridge run build && node bridge/tests/memory-cap.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "memory-cap");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const FAKE_TABLE = path.join(REPO, "bridge", "tests", "fixtures", "fake-tasklist.mjs");
/**
 * One port per phase. A bridge started right after another one on the same port was refused the
 * bind here (EADDRINUSE, with the previous phase's sockets still around), and a test file that
 * starts five bridges should not depend on that; 7903 is the port this ticket was handed, the rest
 * are free ones next to it.
 */
const PORTS = { order: 7903, keepOne: 7880, protect: 7882, blindCap: 7883, blindIdle: 7884 };
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 4;
const MB = 1024 * 1024;
/** 30 minutes squeezed out of the way: the idle rule must not be what reaps anybody here. */
const IDLE_MS = 600_000;

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

/** A bridge on its own state dir and its own port, pointed at the stub pi and the stub process table. */
async function startBridge({ name, port, env = {}, garbage }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  const tableFile = path.join(root, "table.json");
  const tableLog = path.join(root, "table.jsonl");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  fs.writeFileSync(tableFile, JSON.stringify({}));

  const out = [];
  const child = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PI_WEB_PORT: String(port),
      PI_WEB_STATE: state,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: agent,
      PI_BIN: FAKE_PI,
      FAKE_PI_LOG: piLog,
      PI_WEB_GC_TICK_MS: String(TICK_MS),
      PI_WEB_IDLE_MS: String(IDLE_MS),
      PI_WEB_PROCESS_TABLE_BIN: FAKE_TABLE,
      FAKE_TABLE: tableFile,
      FAKE_TABLE_LOG: tableLog,
      ...(garbage ? { FAKE_TABLE_GARBAGE: garbage } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  const base = `http://127.0.0.1:${port}`;
  await until(() => fs.existsSync(path.join(state, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${base}/healthz`)).ok, 20000, "bridge up");
  /**
   * A cookie, or "". Reading the passphrase file can land before the bridge has finished writing it
   * and a login then comes back 401, so this re-reads the file and tries again — a fresh bridge per
   * phase keeps it far inside the bridge's five-attempts-a-minute limit.
   */
  const relogin = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pass = fs.readFileSync(path.join(state, "passphrase.txt"), "utf8").trim();
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      const cookie = login.ok ? (login.headers.get("set-cookie") ?? "").split(";")[0] : "";
      if (cookie) return cookie;
      await sleep(300);
    }
    return "";
  };
  const cookie = await relogin();
  if (!cookie) throw new Error(`login failed on port ${port}:\n${out.join("")}`);

  const readJsonl = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return {
    port,
    out,
    cookie,
    relogin,
    /** Every process-table read the bridge made: one line per spawn, i.e. one line per tick. */
    samples: () => readJsonl(tableLog),
    /** `{t:"argv"}` / `{t:"turn"}` / `{t:"exit"}` lines from the stub pi. */
    pi: () => readJsonl(piLog),
    /** Rows the sampler reads: pid → KiB (`toLocaleString` grouping is the fixture's business). */
    setTable: (rows) => fs.writeFileSync(tableFile, JSON.stringify(rows)),
    stop: async () => {
      // The child's own exit is the signal, not a probe of the port: a fetch can fail for reasons
      // that have nothing to do with this bridge being gone.
      child.kill();
      await until(() => child.exitCode !== null || child.signalCode !== null, 10000, "bridge exited");
    },
  };
}

/** Open one page, retrying with a freshly minted cookie if the upgrade is refused. */
async function client(bridge) {
  let cookie = bridge.cookie;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openClient(bridge, cookie);
    } catch (err) {
      // A 401 on a token minted a moment ago is a known flake of a brand-new state dir; a re-login
      // is the whole fix, and a real auth problem fails all three attempts with the same message.
      if (attempt >= 2) throw err;
      log("    ws retry:", err.message);
      await sleep(300);
      cookie = await bridge.relogin();
      if (!cookie) throw err;
    }
  }
}

async function openClient(bridge, cookie) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("    notice:", String(msg.sessionId ?? "").slice(0, 8), msg.text);
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
    ws.once("error", (err) => {
      ws.terminate();
      reject(new Error(`ws: ${err?.message ?? err}`));
    });
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

/** The launch line of the pi that owns this session id (`--session-id <id>`). */
const lastPid = (records, sid) => records.filter((e) => e.t === "argv" && e.argv.includes(sid)).at(-1)?.pid ?? null;
const exited = (records, pid) => records.some((e) => e.t === "exit" && e.pid === pid);
const sleptNotice = (page, sid) => page.notices(sid).find((n) => /休眠/.test(n.text)) ?? null;

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

async function runOneTurn(page, sid, text) {
  page.send({ type: "prompt", sessionId: sid, text });
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === false, 20000, `settle ${text}`);
}

/** The notice the memory cap produces, kept so phase D can prove the idle rule says the same thing. */
let capNoticeText = "";

// ---------------------------------------------------------------- A. ordered, and only as far as the cap
async function orderedReaping() {
  log("A. 超水位 → 最久没活动的先收，降到水位以下就停；别人的 pid 不算");
  const bridge = await startBridge({
    name: "order",
    port: PORTS.order,
    env: { PI_WEB_MAX_BYTES: String(500 * MB), PI_WEB_CAP_PROTECT_MS: "1500" },
  });
  try {
    const page = await client(bridge);
    const older = await newSession(page, "最老的那个");
    await runOneTurn(page, older, "hello");
    const olderPid = lastPid(bridge.pi(), older);
    await sleep(2000); // long enough for the older one to be out of the protection window
    const newer = await newSession(page, "第二老");
    await runOneTurn(page, newer, "hello");
    const newerPid = lastPid(bridge.pi(), newer);
    check(olderPid !== null && newerPid !== null && olderPid !== newerPid, `两个 pi 是两个进程（${olderPid} / ${newerPid}）`);

    // 400 MB each = 800 MB over a 500 MB cap: one reap is enough, and there is a decoy 3 GB row
    // that must not be counted (counting it would reap both).
    const rows = { [olderPid]: 409_600, [newerPid]: 409_600, 4242: 3_000_000 };
    bridge.setTable(rows);

    page.send({ type: "runtime.stats" });
    const before = await page.waitFor((m) => m.type === "runtime.stats" && m.running === 2, 10000, "runtime.stats 超水位");
    check(before.totalBytes === 819_200 * 1024, `总额只算我们自己那两个 pid（${before.totalBytes} 字节）`);
    check(before.sessions[0].id === older, "闲得最久的排在第一位");

    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === older && /休眠/.test(m.text),
      TICK_WAIT,
      "水位回收 notice",
    );
    capNoticeText = slept.text;
    check(exited(bridge.pi(), olderPid), "最久没活动的那个 pi 真的退出了");

    // Under the cap after one reap, so the second one keeps its process.
    await sleep(TICK_MS * 3);
    check(!sleptNotice(page, newer), "第二个没有被收（800 → 400 MB 已经在水位以下）");
    check(!exited(bridge.pi(), newerPid), "第二个的 pi 还在");
    check(sleptNotice(page, older) && page.notices(older).filter((n) => /休眠/.test(n.text)).length === 1, "同一个会话只收到一条休眠说明");

    page.send({ type: "runtime.stats" });
    const after = await page.waitFor((m) => m.type === "runtime.stats" && m.running === 1, 10000, "runtime.stats 降下来");
    check(after.totalBytes === 409_600 * 1024, `总额降到水位以下（${after.totalBytes} ≤ ${500 * MB}）`);

    // One tick, one reading: a second sample per tick would mean the panel and the cap each sample.
    await sleep(200);
    const mark = bridge.samples().length;
    await sleep(TICK_MS * 3);
    const samples = bridge.samples().length - mark;
    check(samples >= 2 && samples <= 4, `一个 tick 只采一次（3 个 tick 里采了 ${samples} 次，不是两次/tick）`);
  } finally {
    await bridge.stop();
  }
}

// ---------------------------------------------------------------- B. never reaps the last one
async function keepsOne() {
  log("B. 水位小到永远超 → 仍然留一个：只收最久没活动的那个");
  const bridge = await startBridge({
    name: "keep-one",
    port: PORTS.keepOne,
    env: { PI_WEB_MAX_BYTES: String(MB), PI_WEB_CAP_PROTECT_MS: "1500" },
  });
  try {
    const page = await client(bridge);
    const older = await newSession(page, "要被收的");
    await runOneTurn(page, older, "hello");
    const olderPid = lastPid(bridge.pi(), older);
    await sleep(2000);
    const survivor = await newSession(page, "必须留下的");
    await runOneTurn(page, survivor, "hello");
    const survivorPid = lastPid(bridge.pi(), survivor);
    bridge.setTable({ [olderPid]: 409_600, [survivorPid]: 409_600 });

    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === older && /休眠/.test(m.text),
      TICK_WAIT,
      "水位回收 notice",
    );
    check(Boolean(slept), "最久没活动的那个被收了");
    await sleep(TICK_MS * 3);
    check(!sleptNotice(page, survivor), "最后一个没有被收（1 MB 的水位也收不到它）");
    check(!exited(bridge.pi(), survivorPid), "它的 pi 还在，会话还能用");
  } finally {
    await bridge.stop();
  }
}

// ---------------------------------------------------------------- C. the wake-up protection window
async function protectionWindow() {
  log("C. 刚启动 / 刚唤醒的 4 秒保护期内不收，过了保护期照收");
  const bridge = await startBridge({
    name: "protect",
    port: PORTS.protect,
    env: { PI_WEB_MAX_BYTES: String(MB), PI_WEB_CAP_PROTECT_MS: "4000" },
  });
  try {
    const page = await client(bridge);
    // A second live pi, mid-turn: the cap cannot pick it, and it is what keeps "at least one" from
    // being the reason nobody is reaped.
    const busy = await newSession(page, "一直在跑的那个");
    page.send({ type: "prompt", sessionId: busy, text: "SLOW forever" });
    await page.waitFor((m) => m.type === "pi.status" && m.sessionId === busy && m.running === true, 20000, "running");
    const busyPid = lastPid(bridge.pi(), busy);

    const sid = await newSession(page, "刚跑完一轮");
    await runOneTurn(page, sid, "hello");
    const pid = lastPid(bridge.pi(), sid);
    bridge.setTable({ [pid]: 409_600, [busyPid]: 409_600 });

    // Two ticks inside the window: the cap cannot touch it, however small it is.
    await sleep(2500);
    check(!sleptNotice(page, sid), "保护期内没有被收");
    check(!exited(bridge.pi(), pid), "保护期内的 pi 还在");
    const tried = bridge.samples().length;
    check(tried >= 2, `这几轮 tick 确实量过（${tried} 次采样），不是「还没轮到」`);

    // One more tick, still inside the 4 s window: at tick resolution, only the protection window is
    // holding this session back — the cap and the keep-one rule would both have reaped it.
    await sleep(TICK_MS);
    check(!sleptNotice(page, sid), "保护期最后一段里仍然没有被收");
    check(bridge.samples().length > tried, "这中间 tick 又量过一次（不是一直没跑）");

    // Once the window is over the same reading reaps it: the protection is a window, not an exemption.
    await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      TICK_WAIT * 2,
      "过了保护期被收",
    );
    check(exited(bridge.pi(), pid), "过了保护期，pi 真的退出了");
    check(!sleptNotice(page, busy), "一直在跑的那个从头到尾没被收");
  } finally {
    await bridge.stop();
  }
}

// ------------------------------------------------ D. a broken table reaps nobody, the idle rule still fires
async function brokenTable() {
  log("D. 采样不可用 → 水位这一级整级跳过；空闲那一级照旧");
  const garbage = "tasklist: 命令没有找到 / ps: not found";
  const cap = await startBridge({
    name: "blind-cap",
    port: PORTS.blindCap,
    env: { PI_WEB_MAX_BYTES: String(MB), PI_WEB_CAP_PROTECT_MS: "1500" },
    garbage,
  });
  try {
    const page = await client(cap);
    const sid = await newSession(page, "读不到数时的会话");
    await runOneTurn(page, sid, "hello");
    const pid = lastPid(cap.pi(), sid);

    // Past the protection window with a 1 MB cap: only the missing reading can be holding this back.
    await sleep(1800 + TICK_MS * 3);
    check(!sleptNotice(page, sid), "采样不可用时一个都不收");
    check(!exited(cap.pi(), pid), "它的 pi 还在（宁可多占内存，不猜）");
    check(cap.samples().length >= 3, `这几轮 tick 都试过采样（${cap.samples().length} 次），不是没跑`);
  } finally {
    await cap.stop();
  }

  // The idle rule is somebody else's judgement and does not need the numbers (D120).
  const idle = await startBridge({
    name: "blind-idle",
    port: PORTS.blindIdle,
    env: { PI_WEB_IDLE_MS: "2000" },
    garbage,
  });
  try {
    const page = await client(idle);
    const sid = await newSession(page, "读不到数也要休眠");
    await runOneTurn(page, sid, "hello");
    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      2000 + TICK_WAIT,
      "空闲休眠 notice",
    );
    check(Boolean(slept), "采样不可用期间，空闲回收仍然到点执行");
    check(slept.text === capNoticeText, `两条路径是同一条文案（「${slept.text}」）`);
  } finally {
    await idle.stop();
  }
}

try {
  await orderedReaping();
  await keepsOne();
  await protectionWindow();
  await brokenTable();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
