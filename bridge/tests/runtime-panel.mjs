/**
 * 运行时面板（#77 / D120）：桥到底握着几个 pi 进程、它们吃了多少内存。
 *
 * 两个缝：
 *   A. `parseProcessTable` 是纯函数 —— `tasklist` CSV / `ps` 输出 + 我们关心的 pid → pid → 字节。
 *      别人的行必须丢掉（不按进程名匹配），认不出的输出必须回空表，而不是回一堆猜出来的数。
 *   B. WS 面：`runtime.stats` 请求与 GC tick 上的广播、采样命令坏掉时的「不可用」，以及
 *      「采样失败不影响其它回收判据」。
 *
 * 进程表用 fixtures/fake-tasklist.mjs 顶替（`PI_WEB_PROCESS_TABLE_BIN`，和 `PI_BIN` 同一套写法），
 * 表内容来自测试写的 JSON：因此可以把**真的** pi 子进程 pid 写进去，也可以掺一行别人的 pid。
 *
 * Run: npm --prefix bridge run build && node bridge/tests/runtime-panel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "runtime-panel");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const FAKE_TABLE = path.join(REPO, "bridge", "tests", "fixtures", "fake-tasklist.mjs");
const PORT = 7903;
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 5;
/** The idle threshold the last phase injects: it must still reap while the sampler is broken. */
const IDLE_MS = 2000;

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

// ---------------------------------------------------------------- A. the parser is a pure function
async function parser() {
  log("A. tasklist / ps 的原始输出 → pid → 字节，只认我们自己拉起的 pid");
  const { parseProcessTable } = await import(pathToFileURL(path.join(REPO, "bridge/dist/runtime.js")).href);

  // Real `tasklist /FO CSV /NH` shape: every field quoted, memory in KiB with thousands separators.
  const tasklist = [
    '"node.exe","15320","Console","1","285,484 K"',
    '"node.exe","38344","Console","1","474,096 K"',
    '"chrome.exe","4242","Console","1","900,000 K"',
  ].join("\r\n");
  const ours = [15320, 38344];
  const windows = parseProcessTable("tasklist", tasklist, ours);
  check(windows.size === 2, `tasklist: 只回了我们自己那 2 个 pid（实际 ${windows.size}）`);
  check(windows.get(15320) === 285484 * 1024, `tasklist: 15320 = 285,484 KiB → ${windows.get(15320)} 字节`);
  check(windows.get(38344) === 474096 * 1024, `tasklist: 38344 = 474,096 KiB → ${windows.get(38344)} 字节`);
  check(!windows.has(4242), "tasklist: 别人家的 pid（chrome.exe）没有混进来");

  // Real `ps -A -o pid=,rss=` shape: right-aligned columns, rss also in KiB.
  const ps = ["  15320  292352", "  38344  485376", "      1     512"].join("\n");
  const unix = parseProcessTable("ps", ps, [15320, 38344]);
  check(unix.size === 2, `ps: 同样只留我们那 2 个（实际 ${unix.size}）`);
  check(unix.get(15320) === 292352 * 1024, `ps: 15320 = 292352 KiB → ${unix.get(15320)} 字节`);
  check(!unix.has(1), "ps: pid 1 不是我们的，丢掉了");

  // "格式变了" / "命令吐了别的东西"：空表，绝不猜。
  const garbage = [
    "tasklist: command not found",
    '{"pid":15320,"rss":123}',
    '"node.exe","15320"',
    '"node.exe","15320","Console","1","285,484"',
    "",
  ];
  for (const raw of garbage) {
    check(parseProcessTable("tasklist", raw, ours).size === 0, `不认识的 tasklist 输出回空表：${JSON.stringify(raw.slice(0, 34))}`);
    check(parseProcessTable("ps", raw, ours).size === 0, `不认识的 ps 输出回空表：${JSON.stringify(raw.slice(0, 34))}`);
  }
}

/** A bridge on its own state dir, pointed at the stub pi and at the stub process table. */
async function startBridge({ name, env = {}, table, garbage }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  const tableFile = path.join(root, "table.json");
  const tableLog = path.join(root, "table.jsonl");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  if (table) fs.writeFileSync(tableFile, JSON.stringify(table));

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
      PI_WEB_GC_TICK_MS: String(TICK_MS),
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

  const readJsonl = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return {
    port: PORT,
    out,
    cookie,
    /** Every `tasklist` / `ps` call the bridge made (the stub logs one line per run). */
    samples: () => readJsonl(tableLog),
    /** `{t:"argv", pid}` / `{t:"exit", pid}` lines from the stub pi. */
    pi: () => readJsonl(piLog),
    /** Rows in the process table the sampler reads: pid → KiB. */
    setTable: (rows) => fs.writeFileSync(tableFile, JSON.stringify(rows)),
    stop: () => child.kill(),
  };
}

async function client(bridge) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { cookie: bridge.cookie } });
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

// ---------------------------------------------------------------- B. the request
async function sampling() {
  log("B. 两个在跑的 pi → runtime.stats：会话数、总额、每人一份、按闲得久降序");
  const bridge = await startBridge({ name: "sample" });
  try {
    const page = await client(bridge);
    const first = await newSession(page, "跑着的 A");
    const firstPid = lastPid(bridge.pi(), first);
    await runOneTurn(page, first, "hello");
    await sleep(1200); // A must end up the one idle longest, so the order is not accidental
    const second = await newSession(page, "跑着的 B");
    const secondPid = lastPid(bridge.pi(), second);
    await runOneTurn(page, second, "hello");
    check(firstPid !== null && secondPid !== null && firstPid !== secondPid, `两个 pi 是两个进程（${firstPid} / ${secondPid}）`);

    // The table lists our two children plus a decoy nobody owns.
    bridge.setTable({ [firstPid]: 300_000, [secondPid]: 200_000, 4242: 999_999 });
    page.send({ type: "runtime.stats" });
    const stats = await page.waitFor((m) => m.type === "runtime.stats" && m.running === 2, 10000, "runtime.stats");

    check(stats.unavailable === false, "采到了真实读数：unavailable = false");
    check(stats.totalBytes === (300_000 + 200_000) * 1024, `总额 = 两个 pi 之和，不含别人家的（${stats.totalBytes}）`);
    check(stats.sessions.length === 2, `每个运行中的会话一行（${stats.sessions.length}）`);
    check(stats.sessions[0].id === first, "闲得最久的排第一（降序）");
    check(
      stats.sessions[0].idleMs > stats.sessions[1].idleMs,
      `idleMs 确实降序（${stats.sessions[0].idleMs} > ${stats.sessions[1].idleMs}）`,
    );
    check(stats.sessions[0].bytes === 300_000 * 1024, `第一行带自己的字节数（${stats.sessions[0].bytes}）`);
    check(stats.sessions[1].bytes === 200_000 * 1024, `第二行带自己的字节数（${stats.sessions[1].bytes}）`);
    check(stats.sessions[0].name === "跑着的 A", `每行带会话名（${JSON.stringify(stats.sessions[0].name)}）`);
    check(stats.sessions.every((s) => s.running === false), "settled 的会话 running = false，idleMs 是距上次 pi 事件的毫秒数");

    // The same numbers also ride the GC tick: no request, no extra timer (D120).
    const mark = page.seen.length;
    const pushed = await page.waitFor(
      (m) => m.type === "runtime.stats" && page.seen.indexOf(m) >= mark,
      TICK_WAIT,
      "runtime.stats 广播",
    );
    check(pushed.running === 2 && pushed.totalBytes === stats.totalBytes, "GC tick 上广播的也是同一份数字");
    const samples = bridge.samples();
    check(samples.length >= 2, `采样跟着 tick 走：${samples.length} 次命令调用，没有新增定时器`);
  } finally {
    bridge.stop();
  }
}

// ------------------------------------------------ C. a broken sampler reports, reaps nothing
async function brokenSampler() {
  log("C. 采样命令吐垃圾 → 不可用 + 字节数 null，而空闲休眠照旧发生");
  const bridge = await startBridge({
    name: "garbage",
    env: { PI_WEB_IDLE_MS: String(IDLE_MS) },
    garbage: "tasklist.exe has encountered a problem",
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "垃圾表下的会话");
    await runOneTurn(page, sid, "hello");

    page.send({ type: "runtime.stats" });
    const stats = await page.waitFor((m) => m.type === "runtime.stats" && m.running === 1, 10000, "runtime.stats 不可用");
    check(stats.unavailable === true, "采样失败 → unavailable = true（面板写「不可用」）");
    check(stats.totalBytes === null, `不可用时总额是 null，不是 0（${JSON.stringify(stats.totalBytes)}）`);
    check(stats.sessions.length === 1 && stats.sessions[0].bytes === undefined, "行里也不给一个假的字节数");

    // The idle rule is a different judgement: a broken sampler must not hold a session awake.
    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      IDLE_MS + TICK_WAIT,
      "休眠 notice",
    );
    check(Boolean(slept), "采样不可用期间，空闲回收仍然到点执行");

    // And with nothing running the sampler is not even spawned (D120 §2: no reason to look).
    await sleep(TICK_MS * 2); // the sleep itself lands on the tick, and close() is async
    const before = bridge.samples().length;
    await sleep(TICK_WAIT);
    check(bridge.samples().length === before, `没有运行中的 pi 时不再去采样（${before} → ${bridge.samples().length}）`);
  } finally {
    bridge.stop();
  }
}

try {
  await parser();
  await sampling();
  await brokenSampler();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
