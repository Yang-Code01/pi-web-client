/**
 * 运行时阈值的写的那一半（#78 / D120）：面板上那两个数能改，而且改了不会丢。
 *
 * 观察面全是 WS：
 *   A. 改值 → 回一条带新值的 `runtime.stats`；**重启桥**之后再问，还是新值（不是默认的 30 分钟 / 2.5 GB）；
 *   B. 非法值（0 / 负数 / 非数字 / 空 / 什么都没有）被拒绝：回 `saved: false`，值不变，也不写盘
 *      （重启后依旧不变）—— **整份 patch 要么都过、要么都不写**（一好一坏也不写）；
 *      走公共隧道来的连接连改都不许改（step-up，与其它写设置的动作同级）；
 *   C. 改空闲阈值**立即**生效：不重启、不设 `PI_WEB_IDLE_MS`，改完下一个 tick 就按新值休眠；
 *   D. 改小水位之后，**下一个 tick 的广播**里就是新值：判定用的那个数每个 tick 重取，不在启动时缓存。
 *      （按水位踢人是 #79，这里只验它将来会读到的那个数。）
 *
 * Run: npm --prefix bridge run build && node bridge/tests/runtime-settings.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "runtime-settings");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = 7902;
/** The GC tick the tests inject: the real one is 60 s, and a phase sits out a whole tick. */
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 5;
const MIN = 60_000;
const GB = 1024 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30 * MIN;
const DEFAULT_WATERMARK_BYTES = 2.5 * GB;

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

/**
 * A bridge on its own state dir, pointed at the stub pi. `reuse` keeps the state dir (a restart);
 * `lifecycle` seeds `lifecycle.json` before it boots, exactly like a previous run left it.
 */
async function startBridge({ name, reuse = false, env = {}, lifecycle }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  if (!reuse) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  if (lifecycle) fs.writeFileSync(path.join(state, "lifecycle.json"), JSON.stringify(lifecycle));

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
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));
  const exited = new Promise((resolve) => child.once("exit", resolve));

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

  const records = () =>
    fs.existsSync(piLog)
      ? fs
          .readFileSync(piLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return {
    port: PORT,
    out,
    cookie,
    state,
    records,
    /** Every line the stub pi wrote: launches, turns, aborts, exits. */
    stop: async () => {
      child.kill();
      await exited;
    },
  };
}

async function client(bridge, headers = {}) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { cookie: bridge.cookie, ...headers } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("    notice:", msg.text);
    for (const w of [...waits]) {
      if (seen.indexOf(msg) >= (w.from ?? 0) && w.pred(msg)) {
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
    /** Everything the bridge said after `mark` — a request's answer must not be an older frame. */
    since: (mark, pred) => seen.filter((m, i) => i >= mark && pred(m)),
    waitFor: (pred, ms, label) => page.waitAfter(0, pred, ms, label),
    /** Like `waitFor`, but only frames that arrived after index `from` count. */
    waitAfter: (from, pred, ms, label) => {
      const hit = seen.find((m, i) => i >= from && pred(m));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const entry = { pred, from, resolve };
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

/** Ask for the numbers and wait for the answer to *this* request. */
async function stats(page, label = "runtime.stats") {
  const mark = page.seen.length;
  page.send({ type: "runtime.stats" });
  return page.waitAfter(mark, (m) => m.type === "runtime.stats", 10000, label);
}

/** Send one edit and wait for the frame it answers with. */
async function edit(page, patch, label = "runtime.settings") {
  const mark = page.seen.length;
  page.send({ type: "runtime.settings", ...patch });
  return page.waitAfter(mark, (m) => m.type === "runtime.stats", 10000, label);
}

/** The launch line of the pi that owns this session id (`--session-id <id>`). */
const launches = (records, sid) => records.filter((e) => e.t === "argv" && e.argv.includes(sid));
const exited = (records, pid) => records.some((e) => e.t === "exit" && e.pid === pid);

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

// ------------------------------------------ A. change → restart → still the new values
async function persists() {
  log("A. 面板上改两个阈值 → 回一条新值 → 重启桥之后还是新值（不是默认）");
  const first = await startBridge({ name: "persist" });
  const idleMs = 5 * MIN;
  const watermarkBytes = 800 * 1024 * 1024;
  try {
    const page = await client(first);
    const before = await stats(page, "defaults");
    check(
      before.lifecycle?.idleMs === DEFAULT_IDLE_MS && before.lifecycle?.watermarkBytes === DEFAULT_WATERMARK_BYTES,
      `没改过时是默认的 30 分钟 / 2.5 GB（${JSON.stringify(before.lifecycle)}）`,
    );

    const saved = await edit(page, { idleMs, watermarkBytes }, "saved");
    check(saved.saved === true, `改值回了 saved: true（${JSON.stringify(saved.saved)}）`);
    check(saved.lifecycle?.idleMs === idleMs, `空闲阈值立刻变成 ${idleMs} ms（${saved.lifecycle?.idleMs}）`);
    check(saved.lifecycle?.watermarkBytes === watermarkBytes, `水位立刻变成 ${watermarkBytes} 字节（${saved.lifecycle?.watermarkBytes}）`);
  } finally {
    await first.stop();
  }

  const second = await startBridge({ name: "persist", reuse: true });
  try {
    const page = await client(second);
    const after = await stats(page, "after restart");
    check(after.lifecycle?.idleMs === idleMs, `重启桥之后空闲阈值仍是 5 分钟（${after.lifecycle?.idleMs}）`);
    check(after.lifecycle?.watermarkBytes === watermarkBytes, `重启桥之后水位仍是 800 MB（${after.lifecycle?.watermarkBytes}）`);
  } finally {
    await second.stop();
  }
}

// ------------------------- B. bad values are refused, and nothing lands on disk
async function refusedValues() {
  log("B. 0 / 负数 / 非数字 / 空 都被拒（saved: false），值不变、也不写盘；公共隧道来的连接连改都不许改");
  const bridge = await startBridge({ name: "refuse", lifecycle: { idleMs: 5 * MIN, watermarkBytes: 800 * 1024 * 1024 } });
  const keep = { idleMs: 5 * MIN, watermarkBytes: 800 * 1024 * 1024 };
  try {
    const page = await client(bridge);
    const bads = [
      { what: "0", patch: { idleMs: 0 } },
      { what: "负数", patch: { watermarkBytes: -1 } },
      { what: "非数字", patch: { idleMs: "abc" } },
      { what: "空字串", patch: { watermarkBytes: "" } },
      { what: "什么都没有", patch: {} },
      { what: "true", patch: { idleMs: true } },
      // 一好一坏：合法的那一半也不能偷偷写进去 —— 面板看到非 null 就说「已保存」，
      // 那样用户会以为两个数都生效了。
      { what: "一好一坏（idleMs 合法、watermarkBytes 是 -1）", patch: { idleMs: 9 * MIN, watermarkBytes: -1 } },
    ];
    for (const bad of bads) {
      const answer = await edit(page, bad.patch, `refused ${bad.what}`);
      check(answer.saved === false, `${bad.what} → saved: false（${JSON.stringify(answer.saved)}）`);
      check(
        answer.lifecycle?.idleMs === keep.idleMs && answer.lifecycle?.watermarkBytes === keep.watermarkBytes,
        `${bad.what} 被拒后值还是旧的（${JSON.stringify(answer.lifecycle)}）`,
      );
    }

    // A tunnel caller is a read-only page (D15): the write needs step-up, like every other one.
    const pub = await client(bridge, { "cf-connecting-ip": "203.0.113.9" });
    const mark = pub.seen.length;
    pub.send({ type: "runtime.settings", idleMs: 9 * MIN });
    const demand = await pub.waitAfter(mark, (m) => m.type === "need-stepup" || m.type === "runtime.stats", 5000, "public edit");
    check(demand.type === "need-stepup", `从公共隧道改阈值被要求重新输口令（${demand.type}）`);
    check(pub.since(mark, (m) => m.type === "runtime.stats").length === 0, "而且没有回 stats —— 那条写入没有走到写盘");
    pub.close();

    const now = await stats(page, "after refusals");
    check(now.lifecycle?.idleMs === keep.idleMs && now.lifecycle?.watermarkBytes === keep.watermarkBytes, "被拒的那些写一个都没生效");
  } finally {
    await bridge.stop();
  }

  // "不写盘" means the next boot does not see them either.
  const again = await startBridge({ name: "refuse", reuse: true });
  try {
    const page = await client(again);
    const after = await stats(page, "after restart");
    check(
      after.lifecycle?.idleMs === keep.idleMs && after.lifecycle?.watermarkBytes === keep.watermarkBytes,
      `重启桥之后还是改之前的 5 分钟 / 800 MB（${JSON.stringify(after.lifecycle)}）`,
    );
  } finally {
    await again.stop();
  }
}

// ------------------------------- C. the idle threshold takes effect on the next tick
async function idleTakesEffectNow() {
  log("C. 改空闲阈值不用重启：默认 30 分钟回收不了，改成 2 秒之后下一个 tick 就休眠");
  const bridge = await startBridge({ name: "idle-now" });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "idle-now");
    await runOneTurn(page, sid, "hello");
    const pid = launches(bridge.records(), sid).at(-1)?.pid;

    // Two whole ticks at the default 30 minutes: nothing may happen (that is the "before" state).
    const mark = page.seen.length;
    await sleep(TICK_MS * 2 + 500);
    check(!page.since(mark, (m) => m.type === "notice" && m.sessionId === sid).length, "默认的 30 分钟还没到：两个 tick 都没休眠");
    check(exited(bridge.records(), pid) === false, "pi 进程还在");

    const editedAt = Date.now();
    const edited = await edit(page, { idleMs: 2000 }, "idle → 2s");
    check(edited.lifecycle?.idleMs === 2000, `阈值已经改成 2 秒（${edited.lifecycle?.idleMs}）`);
    // Measured from the moment the edit was *sent*: the reply itself can be a tick behind, because
    // answering a write samples the process table first.
    const slept = await page.waitAfter(mark, (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), 2000 + TICK_WAIT, "sleep after edit");
    check(slept._at >= editedAt, "改完之后才休眠（之前那两个 tick 一次都没有）");
    check(slept._at - editedAt <= TICK_MS * 2, `改完下一个 tick 就休眠了（改了 ${slept._at - editedAt} ms 之后）`);
    check(exited(bridge.records(), pid), "pi 进程真的退了（桩记录了 exit）");
  } finally {
    await bridge.stop();
  }
}

// ------------- D. the watermark the tick judges by is re-read, not cached at boot
async function watermarkOnTheNextTick() {
  log("D. 改小水位 → 下一个 tick 的广播里就是新值（判定读的那个数每个 tick 重取）");
  const bridge = await startBridge({ name: "watermark", lifecycle: { watermarkBytes: 2.5 * GB } });
  try {
    const page = await client(bridge);
    // Ask once: only a page that wants the numbers gets the tick broadcast (#77).
    await stats(page, "defaults");
    const small = 600 * 1024 * 1024;
    const edited = await edit(page, { watermarkBytes: small }, "watermark → 600 MB");
    check(edited.lifecycle?.watermarkBytes === small, `回的那条里水位已经是 600 MB（${edited.lifecycle?.watermarkBytes}）`);

    // No request: this frame can only come from the GC tick, which is where the cap judgement runs.
    // (按水位踢人是 #79；这里验的是它将来读到的那个数不在启动时缓存。)
    const mark = page.seen.length;
    const ticked = await page.waitAfter(mark, (m) => m.type === "runtime.stats", TICK_WAIT, "tick 广播");
    check(ticked.lifecycle?.watermarkBytes === small, `下一个 tick 的广播带的就是 600 MB（${ticked.lifecycle?.watermarkBytes}）`);
    check(ticked.lifecycle?.idleMs === DEFAULT_IDLE_MS, `没改空闲阈值，所以它还是 30 分钟（${ticked.lifecycle?.idleMs}）`);
  } finally {
    await bridge.stop();
  }
}

try {
  await persists();
  await refusedValues();
  await idleTakesEffectNow();
  await watermarkOnTheNextTick();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
