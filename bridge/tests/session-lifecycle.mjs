/**
 * Session lifecycle (#76, D120): once a run has settled, a session with no pi event for `idleMs`
 * lets its pi process go — messages stay, the next message wakes it on the same session. A run in
 * flight is never reaped, and a page somebody is looking at does not count as activity.
 *
 * Everything is observed from outside: WS messages and the stub pi's own log
 * (bridge/tests/fixtures/fake-pi.mjs), so "the process really went away" is provable — a wake-up
 * shows up as a *second* launch line for the same session id, plus an exit line for the first.
 *
 * The rules ride the bridge's existing GC tick (no second timer, D120). The tick interval is
 * squeezed for the same reason as the threshold, so the whole file runs in ~20 s:
 * `npm --prefix bridge run build && node bridge/tests/session-lifecycle.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "session-lifecycle");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
/** The GC tick the tests inject: a real one is 60 s, and a phase may sit out a whole one. */
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 4;
/** The idle threshold the tests inject: 30 minutes would take 30 minutes. */
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

/** A bridge on its own state dir, pointed at the stub pi. `lifecycle` is written before it boots. */
async function startBridge({ name, port, env = {}, lifecycle }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  if (lifecycle) fs.writeFileSync(path.join(state, "lifecycle.json"), JSON.stringify(lifecycle));

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
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  const base = `http://127.0.0.1:${port}`;
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

  return { port, out, cookie, records, stop: () => child.kill() };
}

/** One page. Two of them let a test close a tab without losing the ability to watch. */
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
const launches = (records, sid) => records.filter((e) => e.t === "argv" && e.argv.includes(sid));
const lastLaunch = (records, sid) => launches(records, sid).at(-1) ?? null;
const exited = (records, pid) => records.some((e) => e.t === "exit" && e.pid === pid);

async function newSession(page, name) {
  const mark = page.seen.length;
  page.send({ type: "create", cwd: REPO, name });
  // Only a `session` that arrived after this create counts: earlier ones are other sessions.
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

// ---------------------------------------------------------------- A. idle reaping
async function idleReaping() {
  log("A. settled + idle > threshold → pi exits, transcript stays, the next message wakes it");
  const bridge = await startBridge({ name: "idle", port: 7894, env: { PI_WEB_IDLE_MS: String(IDLE_MS) } });
  try {
    const tab = await client(bridge);
    const sid = await newSession(tab, "lifecycle");
    log("  session", sid);
    await runOneTurn(tab, sid, "hello");
    const settledAt = Date.now();
    const firstPid = lastLaunch(bridge.records(), sid)?.pid;

    // Looking is not activity (D120): two subscribe round-trips, then this tab goes away for good.
    tab.send({ type: "subscribe", sessionId: sid });
    await tab.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot");
    tab.send({ type: "subscribe", sessionId: sid });
    const watcher = await client(bridge); // a second page that never subscribes to this session
    tab.close();

    const slept = await watcher.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      TICK_WAIT,
      "sleep notice",
    );
    check(slept._at - settledAt >= IDLE_MS, `the sleep came after the threshold (${slept._at - settledAt} ms)`);
    check(exited(bridge.records(), firstPid), "the pi process really exited (stub recorded its exit)");

    // Messages are untouched: same transcript, no relaunch needed to read it.
    watcher.send({ type: "subscribe", sessionId: sid });
    const after = await watcher.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot after sleep");
    const said = (after.items ?? []).filter((i) => i.kind === "assistant").map((i) => i.text);
    check(said.some((t) => t.includes("echo: hello")), `the transcript is still there (${JSON.stringify(said)})`);

    // The next message wakes it: a second launch of the same session id, in a new process.
    watcher.send({ type: "prompt", sessionId: sid, text: "after sleep" });
    await watcher.waitFor((m) => m.type === "item.replace" && m.item?.text === "echo: after sleep", 20000, "answer after waking");
    const all = launches(bridge.records(), sid);
    check(all.length === 2, `two launches for the session (${all.length})`);
    check(all.length === 2 && all[1].pid !== all[0].pid, "the wake-up is a new process");
    const resumedAt = all.length === 2 ? all[1].argv.indexOf("--session-id") : -1;
    check(resumedAt >= 0 && all[1].argv[resumedAt + 1] === sid, "it resumed the same session id");

    // Bridge settings never leak into pi's environment (#76).
    const argvLines = bridge.records().filter((e) => e.t === "argv");
    const inherited = argvLines.flatMap((e) => e.piWeb ?? []);
    check(argvLines.every((e) => Array.isArray(e.piWeb)), "the stub records which PI_WEB_* vars it was given");
    check(
      !inherited.includes("PI_WEB_IDLE_MS") &&
        !inherited.includes("PI_WEB_ABORT_GRACE_MS") &&
        !inherited.includes("PI_WEB_GC_TICK_MS"),
      `the test's thresholds did not reach pi (saw ${JSON.stringify([...new Set(inherited)])})`,
    );

    await runningNotReaped(bridge, watcher, sid);
  } finally {
    bridge.stop();
  }
}

/**
 * B. A turn still in flight is never reaped, however long it has been quiet. The tick is proven to
 * have run by the idle session sleeping at it, so this is not just "we did not wait long enough".
 */
async function runningNotReaped(bridge, page, idleSid) {
  log("B. a run in flight is not reaped, even when the tick sleeps an idle session next to it");
  const slowSid = await newSession(page, "slow");
  page.send({ type: "prompt", sessionId: slowSid, text: "SLOW forever" });
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === slowSid && m.running === true, 20000, "running");
  const slowPid = lastLaunch(bridge.records(), slowSid)?.pid;
  const mark = page.seen.length;

  await page.waitFor(
    (m) => m.type === "notice" && m.sessionId === idleSid && /休眠/.test(m.text) && page.seen.indexOf(m) > mark,
    TICK_WAIT,
    "the idle session sleeps at the next tick",
  );
  check(!page.notices(slowSid).some((n) => /休眠/.test(n.text)), "the running session was not reaped at that tick");
  check(!exited(bridge.records(), slowPid), "its pi process is still there");
  check(!bridge.records().some((e) => e.t === "abort"), "nothing aborted a running turn");
}

// ---------------------------------------------------------------- C. the threshold file
async function thresholdFile() {
  log("C. `<state>/lifecycle.json` sets the threshold (no environment override)");
  const bridge = await startBridge({ name: "file", port: 7895, lifecycle: { idleMs: IDLE_MS } });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "file-lifecycle");
    await runOneTurn(page, sid, "hello");
    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      TICK_WAIT,
      "sleep notice from the file's threshold",
    );
    check(Boolean(slept), "the threshold in lifecycle.json took effect (the 30-minute default did not)");
    // The panel can write this file too (`runtime.settings`, #78); nothing in this run edits it,
    // so the value on disk must still be the one the test put there.
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "file", "state", "lifecycle.json"), "utf8"));
    check(onDisk.idleMs === IDLE_MS, `the file is untouched (${JSON.stringify(onDisk)})`);
  } finally {
    bridge.stop();
  }
}

try {
  await idleReaping();
  await thresholdFile();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
