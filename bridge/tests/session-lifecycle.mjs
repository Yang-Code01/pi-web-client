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
import { freePort } from "../../tools/free-port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "session-lifecycle");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
/** The GC tick the tests inject: a real one is 60 s, and a phase may sit out a whole one. */
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 4;
/** The idle threshold the tests inject: the real default (two hours, D372) would take two hours. */
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

/**
 * A bridge on its own state dir, pointed at the stub pi. `lifecycle` is written before it boots.
 * `keep` reuses the same state dir (a restart), `seed` writes whatever a test needs there first.
 */
async function startBridge({ name, port, env = {}, lifecycle, keep = false, seed }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
  if (lifecycle) fs.writeFileSync(path.join(state, "lifecycle.json"), JSON.stringify(lifecycle));
  seed?.(state);

  const out = [];
  const child = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      // 从 7864 那份壳起的会话里跑本文件时，环境里带着 `PI_HOST_LINK`：子桥会去连壳的命名管道、连不上就退（
      // probes/ 里几个探针也是因为这个才删掉它）。这里自己开一个口子，不归壳管。
      PI_HOST_LINK: "",
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
const launches = (records, sid) =>
  records.filter((e) => e.t === "argv" && e.argv.some((arg) => typeof arg === "string" && arg.includes(sid)));
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
  const bridge = await startBridge({ name: "idle", port: await freePort(), env: { PI_WEB_IDLE_MS: String(IDLE_MS) } });
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
  const bridge = await startBridge({ name: "file", port: await freePort(), lifecycle: { idleMs: IDLE_MS } });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "file-lifecycle");
    await runOneTurn(page, sid, "hello");
    const slept = await page.waitFor(
      (m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text),
      TICK_WAIT,
      "sleep notice from the file's threshold",
    );
    check(Boolean(slept), "the threshold in lifecycle.json took effect (the default did not)");
    // The panel can write this file too (`runtime.settings`, #78); nothing in this run edits it,
    // so the value on disk must still be the one the test put there.
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "file", "state", "lifecycle.json"), "utf8"));
    check(onDisk.idleMs === IDLE_MS, `the file is untouched (${JSON.stringify(onDisk)})`);
  } finally {
    bridge.stop();
  }
}

// ---------------------------------------------------------------- D. archiving is a promise to release (D421)
/** What the tests inject for 「归档后多久释放」; the real default is five minutes (DEFAULT_ARCHIVE_IDLE_MS). */
const ARCHIVE_MS = 1500;
/** The sidebar's archive action, over the same socket the page uses. */
const archive = (page, sid, on = true) => page.send({ type: "manage", action: "archive", ids: [sid], on });
const sleptOn = (page, sid) => page.notices(sid).filter((n) => /休眠/.test(n.text));
const assistantsIn = (frame) => (frame?.items ?? []).filter((i) => i.kind === "assistant").map((i) => String(i.text));

async function archiveRelease() {
  log("D. an archived session lets its pi go after the archive threshold — and its transcript with it");
  const bridge = await startBridge({
    name: "archive",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS), FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "archived");
    await runOneTurn(page, sid, "hello");
    const firstPid = lastLaunch(bridge.records(), sid)?.pid;

    archive(page, sid);
    const manage = await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");
    const stamp = manage.manage.archivedAt?.[sid];
    check(typeof stamp === "number" && stamp > 0, `archiving recorded when it happened (${stamp})`);

    const slept = await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "release after archive");
    check(slept._at - stamp >= ARCHIVE_MS, `the release came after the threshold (${slept._at - stamp} ms)`);
    check(exited(bridge.records(), firstPid), "the pi process really exited (stub recorded its exit)");
    check(lastLaunch(bridge.records(), sid)?.pid === firstPid, "no relaunch: the release did not wake it back up");

    // This stub's session file holds only its header, so a transcript that still says "echo: hello"
    // would mean the bridge kept its own copy (what the idle rule does). Nobody was watching here.
    const mark = page.seen.length;
    page.send({ type: "subscribe", sessionId: sid });
    const after = await page.waitFor(
      (m) => m.type === "session" && m.sessionId === sid && page.seen.indexOf(m) > mark,
      10000,
      "snapshot after release",
    );
    const said = assistantsIn(after);
    check(!said.some((t) => t.includes("echo: hello")), `the bridge dropped its transcript (${JSON.stringify(said)})`);

    // Nothing was lost: the next message cold-starts the same session from its file.
    page.send({ type: "prompt", sessionId: sid, text: "after release" });
    await page.waitFor((m) => m.type === "item.replace" && m.item?.text === "echo: after release", 20000, "answer after release");
    check(launches(bridge.records(), sid).length === 2, "the next message woke a new pi on the same session");
  } finally {
    bridge.stop();
  }
}

async function archiveWhileWatched() {
  log("D2. a page is looking at it: the pi still goes, the session is still served (no relaunch, same file)");
  const bridge = await startBridge({
    name: "archive-watched",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS), FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "watched");
    await runOneTurn(page, sid, "hello");
    const pid = lastLaunch(bridge.records(), sid)?.pid;
    page.send({ type: "subscribe", sessionId: sid });
    await page.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot");

    archive(page, sid);
    await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "sleep while watched");
    check(exited(bridge.records(), pid), "the pi process really exited even though a page is watching");

    const mark = page.seen.length;
    page.send({ type: "subscribe", sessionId: sid });
    const after = await page.waitFor(
      (m) => m.type === "session" && m.sessionId === sid && page.seen.indexOf(m) > mark,
      10000,
      "snapshot still watched",
    );
    // 桩的会话文件只有表头，所以「转录还在不在」区分不出「对象留着」和「从文件重建」—— 内存那半由
    // D7（无文件的会话）证明。这里证明页面还看得见它：同一份文件、没有人重开 pi。
    check(
      after.state?.id === sid && typeof after.state?.file === "string" && after.state.file !== "",
      `the page still gets the same session back (${JSON.stringify({ id: after.state?.id, file: after.state?.file })})`,
    );
    check(launches(bridge.records(), sid).length === 1, "watching it did not wake a pi at any point");
  } finally {
    bridge.stop();
  }
}

async function archiveDisabled() {
  log("D3. the threshold 0 turns the rule off (an archived session keeps its pi until another rule ends it)");
  const bridge = await startBridge({
    name: "archive-off",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: "0", FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "kept");
    await runOneTurn(page, sid, "hello");
    const pid = lastLaunch(bridge.records(), sid)?.pid;
    archive(page, sid);
    await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");
    await sleep(TICK_WAIT);
    check(sleptOn(page, sid).length === 0, "several ticks went by and nothing slept it");
    check(!exited(bridge.records(), pid), "the pi process is still there");
  } finally {
    bridge.stop();
  }
}

async function archiveCancelledByUnarchive() {
  log("D4. unarchiving inside the window cancels the countdown (opening it again must not kill it)");
  const bridge = await startBridge({
    name: "archive-cancel",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS), FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "cancelled");
    await runOneTurn(page, sid, "hello");
    const pid = lastLaunch(bridge.records(), sid)?.pid;
    archive(page, sid);
    await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");

    await sleep(ARCHIVE_MS / 2);
    archive(page, sid, false);
    const off = await page.waitFor((m) => m.type === "manage" && !m.manage?.archived?.includes(sid), 5000, "unarchived");
    check(off.manage.archivedAt?.[sid] === undefined, "unarchiving cleared the clock");

    await sleep(TICK_WAIT);
    check(sleptOn(page, sid).length === 0, "the cancelled countdown never fired");
    check(!exited(bridge.records(), pid), "the pi process is still there");
  } finally {
    bridge.stop();
  }
}

async function archiveRunningNotInterrupted() {
  log("D5. archived mid-run: the run is never interrupted, the release waits for it to settle");
  const bridge = await startBridge({
    name: "archive-running",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS), FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "running");
    page.send({ type: "prompt", sessionId: sid, text: "SLOW forever" });
    await page.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === true, 20000, "running");
    const pid = lastLaunch(bridge.records(), sid)?.pid;

    archive(page, sid);
    await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");
    await sleep(TICK_WAIT);
    check(sleptOn(page, sid).length === 0, "the tick did not reap a running session");
    check(!exited(bridge.records(), pid), "its pi process is still there");
    check(!bridge.records().some((e) => e.t === "abort"), "nothing aborted the run");

    // Once the run settles the same archive clock is still older than the threshold: it goes now.
    page.send({ type: "abort", sessionId: sid });
    const slept = await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT * 2, "release after the run");
    check(Boolean(slept), "the settled run was released on the next tick");
    check(exited(bridge.records(), pid), "the pi process really exited then");
  } finally {
    bridge.stop();
  }
}

async function archiveApprovalHoldsIt() {
  log("D6. a pending approval is a person's call: the archive rule leaves it to the 120-minute rule");
  const bridge = await startBridge({
    name: "archive-approval",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS), FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "approval-archived");
    page.send({ type: "prompt", sessionId: sid, text: "APPROVAL now" });
    await page.waitFor((m) => m.type === "approval.add" && m.sessionId === sid, 20000, "approval card");
    const pid = lastLaunch(bridge.records(), sid)?.pid;

    archive(page, sid);
    await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");
    await sleep(TICK_WAIT * 2);
    check(sleptOn(page, sid).length === 0, "the process was not taken down under the card");
    check(!exited(bridge.records(), pid), "its pi process is still there");
    check(!page.seen.some((m) => m.type === "approval.remove" && m.sessionId === sid), "the card was not discarded either");
  } finally {
    bridge.stop();
  }
}

async function archiveWithoutFileKeepsTranscript() {
  log("D7. a web-born session with no file yet: the process goes, the transcript stays (there is nowhere to read it back from)");
  const bridge = await startBridge({
    name: "archive-nofile",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: String(ARCHIVE_MS) },
  });
  try {
    const page = await client(bridge);
    const sid = await newSession(page, "no-file");
    await runOneTurn(page, sid, "hello");
    const pid = lastLaunch(bridge.records(), sid)?.pid;
    archive(page, sid);
    await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "release without a file");
    check(exited(bridge.records(), pid), "the pi process really exited");

    const mark = page.seen.length;
    page.send({ type: "subscribe", sessionId: sid });
    const after = await page.waitFor((m) => m.type === "session" && m.sessionId === sid && page.seen.indexOf(m) > mark, 10000, "snapshot kept");
    check(assistantsIn(after).some((t) => t.includes("echo: hello")), "the transcript is still there");
  } finally {
    bridge.stop();
  }
}

async function archiveSurvivesRestart() {
  log("D8. the clock lives on disk: a bridge restart does not hand the archived session a fresh countdown");
  const name = "archive-restart";
  let sid = "";
  let stamp;
  const first = await startBridge({
    name,
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: "60000", FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(first);
    sid = await newSession(page, "restart");
    await runOneTurn(page, sid, "hello");
    archive(page, sid);
    const manage = await page.waitFor((m) => m.type === "manage" && m.manage?.archived?.includes(sid), 5000, "archived");
    stamp = manage.manage.archivedAt?.[sid];
    check(typeof stamp === "number" && stamp > 0, `stamped before the restart (${stamp})`);
  } finally {
    first.stop();
  }
  await sleep(600);
  // 重启后阈值压到 1.5 秒：戳还在，第一两个 tick 就该看到它睡 —— 只断言「戳还在」的话，
  // 「重启把倒计时清零」这个 bug 照样能过。
  const second = await startBridge({
    name,
    port: await freePort(),
    keep: true,
    env: { PI_WEB_ARCHIVE_IDLE_MS: "1500", FAKE_PI_SESSION: "1" },
  });
  try {
    const page = await client(second);
    await page.waitFor((m) => m.type === "hello", 5000, "hello");
    const hello = page.seen.find((m) => m.type === "hello");
    check(hello?.manage?.archived?.includes(sid), "the session is still archived after the restart");
    check(hello?.manage?.archivedAt?.[sid] === stamp, `the timestamp survived the restart (${hello?.manage?.archivedAt?.[sid]} vs ${stamp})`);
    // 订阅得赶在第一个 tick 之前：这样即便对象没被丢掉，休眠通知也会送到这里。
    page.send({ type: "subscribe", sessionId: sid });
    await page.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text ?? ""), TICK_WAIT * 2, "released after the restart");
  } finally {
    second.stop();
  }
}

async function archiveBackfilledAtBoot() {
  log("D9. a manage.json written before timestamps existed gets one at boot, and it is written back");
  const legacy = "legacy-archived";
  const bridge = await startBridge({
    name: "archive-legacy",
    port: await freePort(),
    env: { PI_WEB_ARCHIVE_IDLE_MS: "60000" },
    seed: (state) => fs.writeFileSync(path.join(state, "manage.json"), JSON.stringify({ pin: [], order: [], archived: [legacy] })),
  });
  try {
    const bootedAt = Date.now();
    const page = await client(bridge);
    const hello = page.seen.find((m) => m.type === "hello");
    const at = hello?.manage?.archivedAt?.[legacy];
    check(typeof at === "number" && Math.abs(at - bootedAt) < 20000, `the boot stamped the old archive (${at} vs ${bootedAt})`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "archive-legacy", "state", "manage.json"), "utf8"));
    check(onDisk.archivedAt?.[legacy] === at, `the stamp was written back (${JSON.stringify(onDisk.archivedAt)})`);
  } finally {
    bridge.stop();
  }
}

try {
  await idleReaping();
  await thresholdFile();
  await archiveRelease();
  await archiveWhileWatched();
  await archiveDisabled();
  await archiveCancelledByUnarchive();
  await archiveRunningNotInterrupted();
  await archiveApprovalHoldsIt();
  await archiveWithoutFileKeepsTranscript();
  await archiveSurvivesRestart();
  await archiveBackfilledAtBoot();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
