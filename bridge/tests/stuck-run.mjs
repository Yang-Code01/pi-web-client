/**
 * The stuck-run watchdog (#81, D120): a `running` turn is *stuck* only when nothing is in flight.
 *
 *  A. Silent, nothing in flight (no tool, no `!cmd`, no approval) → abort reaches pi, and a run that
 *     has not settled `abortGraceMs` later has its process ended. Messages stay.
 *  B. A tool in flight and total silence → exactly one notice, never an abort: a 40-minute build
 *     sends no events either, so the decision stays with the user.
 *  C. A `!cmd` in flight and silence → same as B (a long command is not a hang).
 *  D. A pending approval and silence → same as B (a session waiting for a human is not a hang).
 *  E. The abort works: the run settles inside the grace → nothing is killed.
 *
 * Everything is observed from outside — WS messages and the stub pi's own log
 * (bridge/tests/fixtures/fake-pi.mjs) — so "the abort reached pi" and "the process really went away"
 * are provable: the stub reads its own stdin EOF and records one `exit` line per process.
 *
 * `npm --prefix bridge run build && node bridge/tests/stuck-run.mjs` (~25 s).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "stuck-run");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
/** The GC tick the tests inject: a real one is 60 s, and the watchdog needs a few of them. */
const TICK_MS = 1000;
/** D120's 30 minutes, squeezed. */
const IDLE_MS = 2000;
/** D120's 60 s grace, squeezed. */
const GRACE_MS = 1500;
/** Long enough for the threshold plus a couple of ticks. */
const PAST_IDLE = IDLE_MS + TICK_MS * 3;

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

/** A bridge on its own state dir, pointed at the stub pi, with all three thresholds squeezed. */
async function startBridge(port) {
  const root = ROOT;
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
      PI_WEB_PORT: String(port),
      PI_WEB_STATE: state,
      PI_WEB_TUNNEL: "0",
      PI_AGENT_DIR: agent,
      PI_BIN: FAKE_PI,
      FAKE_PI_LOG: piLog,
      PI_WEB_GC_TICK_MS: String(TICK_MS),
      PI_WEB_IDLE_MS: String(IDLE_MS),
      PI_WEB_ABORT_GRACE_MS: String(GRACE_MS),
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

async function client(bridge) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { cookie: bridge.cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("    notice:", String(msg.sessionId ?? "").slice(0, 8), msg.code ?? "", msg.text);
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

const launches = (records, sid) => records.filter((e) => e.t === "argv" && e.argv.includes(sid));
const lastLaunch = (records, sid) => launches(records, sid).at(-1) ?? null;
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

/** Start a prompt and wait until pi says the run is on. */
async function startRun(bridge, page, name, text) {
  const sid = await newSession(page, name);
  page.send({ type: "prompt", sessionId: sid, text });
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === true, 20000, `running ${text}`);
  await until(() => Boolean(lastLaunch(bridge.records(), sid)), 10000, "pi launch");
  return sid;
}

const abortedPid = (records, pid) => records.some((e) => e.t === "abort" && e.pid === pid);

/** Watchdog notices for a session that only the watchdog could have written. */
const watchdog = (page, sid) => page.notices(sid).filter((n) => String(n.code ?? "").startsWith("stuck_run_"));

// ------------------------------------------------- A. silent with nothing in flight
async function silentIsStuck(bridge, page) {
  log("A. silent run, nothing in flight → abort, then the process ends after the grace");
  const sid = await startRun(bridge, page, "silent", "SILENT forever");
  const pid = lastLaunch(bridge.records(), sid).pid;

  const aborted = await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "stuck_run_aborted", PAST_IDLE + 3000, "abort notice");
  check(Boolean(aborted), "the watchdog said it aborted the run");
  // The Chinese sentence is the fallback (#81): `params` is what the en / ja dictionaries fill in.
  check(Number(aborted.params?.p1) >= 1 && Number(aborted.params?.p2) >= 1, `the notice carries its numbers (${JSON.stringify(aborted.params)})`);
  const abortAt = aborted._at;
  // The abort is a real RPC to pi, not just a line in the transcript.
  await until(() => abortedPid(bridge.records(), pid), 5000, "stub saw the abort");
  check(abortedPid(bridge.records(), pid), "stub pi recorded the abort");
  check(!exited(bridge.records(), pid), "nothing killed the process before the grace was over");

  const ended = await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "stuck_run_ended", GRACE_MS + PAST_IDLE, "ended notice");
  check(ended._at - abortAt >= GRACE_MS - 200, `the grace was honoured (${ended._at - abortAt} ms after the abort)`);
  await until(() => exited(bridge.records(), pid), 10000, "process exit");
  check(exited(bridge.records(), pid), "the pi process really exited");
  const exitAt = bridge.records().find((e) => e.t === "exit" && e.pid === pid).at;
  check(exitAt - abortAt >= GRACE_MS - 200, `the process outlived the abort by the grace (${exitAt - abortAt} ms)`);

  const settled = await page.waitFor((m) => m.type === "session.state" && m.session?.id === sid && m.session.running === false, 10000, "not running");
  check(Boolean(settled), "the session is no longer running");
  check(
    !page.notices(sid).some((n) => /意外退出/.test(String(n.text))),
    "the end is reported as the watchdog's, not as a crash",
  );
}

// ------------------------------------------------- B. a tool in flight is silence, not a hang
async function toolInFlightOnlyNotices(bridge, page) {
  log("B. tool in flight + silence → one notice, no abort");
  const sid = await startRun(bridge, page, "tools", "TOOLHANG forever");
  const pid = lastLaunch(bridge.records(), sid).pid;
  await page.waitFor(
    (m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "tool" && m.item.status === "running",
    10000,
    "tool card running",
  );
  const mark = page.seen.length;

  await sleep(PAST_IDLE);
  const said = watchdog(page, sid);
  check(said.length === 1, `exactly one watchdog notice over ${PAST_IDLE} ms (${said.length})`);
  check(said[0]?.code === "stuck_run_busy", `it is the "looks stuck" one (${said[0]?.code})`);
  check(!abortedPid(bridge.records(), pid), "pi was never aborted");
  check(!exited(bridge.records(), pid), "and its process is still there");
  check(
    !page.seen.slice(mark).some((m) => (m.type === "pi.status" && m.sessionId === sid && m.running === false) || (m.type === "session.state" && m.session?.id === sid && m.session.running === false)),
    "the run stayed running the whole time",
  );
}

// ------------------------------------------------- C. a `!cmd` in flight is not a hang either
async function bashInFlightOnlyNotices(bridge, page) {
  log("C. `!cmd` in flight + silence → no abort");
  const sid = await startRun(bridge, page, "bash", "SILENT forever");
  const pid = lastLaunch(bridge.records(), sid).pid;
  page.send({ type: "bash", sessionId: sid, command: "quiet 1", excludeFromContext: false });
  await page.waitFor((m) => m.type === "item.add" && m.sessionId === sid && m.item?.kind === "bash" && m.item.status === "running", 10000, "bash card running");
  // A silent command emits nothing, so the only thing keeping this session alive is "in flight".
  await sleep(PAST_IDLE);
  check(!abortedPid(bridge.records(), pid), "pi was never aborted while the command ran");
  check(!exited(bridge.records(), pid), "and its process is still there");
  check(watchdog(page, sid).every((n) => n.code !== "stuck_run_aborted"), "no abort notice either");
  // Same silence, only the command is finishing now: the watchdog does abort this run, which is what
  // makes the "in flight" excuse above mean something.
  page.send({ type: "abortBash", sessionId: sid });
  const after = await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "stuck_run_aborted", PAST_IDLE + 3000, "abort once the command is gone");
  check(Boolean(after), "with nothing in flight the same silence is a hang");
}

// ------------------------------------------------- D. somebody has to answer first
async function pendingApprovalIsNotStuck(bridge, page) {
  log("D. pending approval + silence → no abort");
  const sid = await startRun(bridge, page, "approval", "SILENT ask please");
  const pid = lastLaunch(bridge.records(), sid).pid;
  const approval = await page.waitFor((m) => m.type === "approval.add" && m.sessionId === sid, 10000, "approval");
  await sleep(PAST_IDLE);
  check(!abortedPid(bridge.records(), pid), "pi was never aborted while the approval waits");
  check(!exited(bridge.records(), pid), "and its process is still there");
  check(
    page.seen.some((m) => m.type === "approval.add" && m.sessionId === sid && m.approval?.id === approval.approval?.id),
    "the approval is still the user's to answer",
  );
}

// ------------------------------------------------- E. the abort worked: nothing is killed
async function settlesInsideTheGrace(bridge, page) {
  log("E. the run settles inside the grace → the process is kept");
  const sid = await startRun(bridge, page, "soft", "SILENT soft");
  const pid = lastLaunch(bridge.records(), sid).pid;
  await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "stuck_run_aborted", PAST_IDLE + 3000, "abort notice");
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === false, GRACE_MS + 5000, "settled after the abort");
  check(true, "the aborted run settled instead of dying");

  await sleep(GRACE_MS + TICK_MS * 2);
  check(!watchdog(page, sid).some((n) => n.code === "stuck_run_ended"), "the watchdog did not end the process");
  // The process may still go away later — but only because the session went idle (#76), never as a kill.
  const slept = page.notices(sid).some((n) => /休眠/.test(String(n.text)));
  if (exited(bridge.records(), pid)) check(slept, "the exit belongs to the idle rule, not to the watchdog");
}

/** A port of its own: 7893 / 7894 / 7895 / 7898 / 7899 belong to the other bridge tests. */
const PORT = 7901;
const bridge = await startBridge(PORT);
try {
  const page = await client(bridge);
  await silentIsStuck(bridge, page);
  await toolInFlightOnlyNotices(bridge, page);
  await pendingApprovalIsNotStuck(bridge, page);
  await settlesInsideTheGrace(bridge, page);
  // Last: it leaves a silent run behind, which the watchdog then rightly ends.
  await bashInFlightOnlyNotices(bridge, page);
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
  console.error(bridge.out.join("").slice(-4000));
} finally {
  bridge.stop();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
