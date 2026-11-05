/**
 * Approvals and asks expire when nobody is in front of a page (#82, D120 point 4).
 *
 * The rule is about `present` (a page that is visible *and* in a focused window, D91), not about who
 * is subscribed to which session: opening session A must never silently expire session B's approval,
 * because that person is still sitting at the keyboard. And while one page is in front, nothing
 * expires, however long it has been on screen.
 *
 * Everything is observed from outside: WS messages and the stub pi's own log
 * (`bridge/tests/fixtures/fake-pi.mjs`, scenarios `"APPROVAL…"` and `"ASK…"`), so "the tool call was
 * really discarded" and "the process really went away" are both provable.
 *
 * Two clocks have to agree (review of #82): nobody in front of a page for the threshold, **and** the
 * card itself hanging for the threshold. An approval that pops up long after you left is still too
 * young to be thrown away — phase D.
 *
 * `npm --prefix bridge run build && node bridge/tests/approval-expiry.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(REPO, ".scratch", "approval-expiry");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
/** The GC tick the tests inject: a real one is 60 s, and the expiry rides it. */
const TICK_MS = 1000;
const TICK_WAIT = TICK_MS * 4;
/** The threshold the tests inject: 30 minutes would take 30 minutes. */
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

/** A bridge on its own state dir, pointed at the stub pi, with the thresholds squeezed to seconds. */
async function startBridge({ name, port }) {
  const root = path.join(ROOT, name);
  const state = path.join(root, "state");
  const agent = path.join(root, "agent");
  const piLog = path.join(root, "fake-pi.jsonl");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });

  const base = `http://127.0.0.1:${port}`;
  // A previous run's bridge may still be letting go of the port; never mistake it for ours.
  await until(
    async () => {
      try {
        await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    },
    15000,
    `port ${port} free`,
  );

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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => out.push(b.toString()));

  /** Killing the bridge is not instant (it closes its sessions first), and a killed child reports
   * `signalCode` instead of `exitCode` — wait for either, then force it. */
  const stop = async () => {
    const gone = () => child.exitCode !== null || child.signalCode !== null;
    child.kill();
    await until(gone, 8000, `bridge on ${port} exits`).catch(() => child.kill("SIGKILL"));
    await until(gone, 5000, `bridge on ${port} is gone`).catch(() => {});
  };

  try {
    await waitReady();
  } catch (err) {
    // A bridge nobody will ever talk to must not linger on the port and poison the next run.
    await stop();
    throw err;
  }

  async function waitReady() {
    await until(() => fs.existsSync(path.join(state, "passphrase.txt")), 20000, "passphrase");
    await until(async () => (await fetch(`${base}/healthz`)).ok, 20000, "bridge up");
    const pass = fs.readFileSync(path.join(state, "passphrase.txt"), "utf8").trim();
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: pass }),
    });
    if (!login.ok) throw new Error(`login failed (${login.status}) — is another bridge still holding port ${port}?\n${out.join("")}`);
    return (login.headers.get("set-cookie") ?? "").split(";")[0];
  }
  const cookie = await waitReady();

  /** Every line the stub pi wrote: launches (`argv`), turns, dialogs, aborts, exits. */
  const records = () =>
    fs.existsSync(piLog)
      ? fs
          .readFileSync(piLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return { port, out, cookie, records, stop };
}

/** One page. `present` is the page's own answer to "is it visible and focused". */
async function client(bridge) {
  const seen = [];
  const waits = new Set();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { cookie: bridge.cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("    notice:", String(msg.sessionId).slice(0, 8), msg.text);
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
    present: (active) => ws.send(JSON.stringify({ type: "presence", active })),
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
  const created = await page.waitFor((m) => m.type === "session" && m.sessionId && page.seen.indexOf(m) >= mark, 20000, `create ${name}`);
  return created.sessionId;
}

/** Start a run that hangs on a confirm and wait for the bridge to show it as an approval. */
async function hangApproval(page, sid) {
  page.send({ type: "prompt", sessionId: sid, text: "APPROVAL now" });
  await page.waitFor((m) => m.type === "approval.add" && m.sessionId === sid, 20000, "approval card");
}

/** A session that finishes a turn and then just sits there — proof that a tick really ran. */
async function idleSibling(page) {
  const other = await newSession(page, "ticker");
  page.send({ type: "prompt", sessionId: other, text: "hello" });
  await page.waitFor((m) => m.type === "pi.status" && m.sessionId === other && m.running === false, 20000, "ticker settled");
  await page.waitFor((m) => m.type === "notice" && m.sessionId === other && /休眠/.test(m.text), IDLE_MS + TICK_WAIT, "ticker slept");
  return other;
}

// ---------------------------------------------------------------- A. nobody present → expire
async function expiresWhenNobodyPresent() {
  log("A. an approval whose pages are all unpresent expires at the threshold, says so, and sleeps");
  const bridge = await startBridge({ name: "away", port: 7901 });
  try {
    const tab = await client(bridge);
    tab.present(true); // somebody is at the keyboard when the approval comes up
    const sid = await newSession(tab, "approval");
    log("  session", sid);
    // The page keeps watching this session the whole time: subscription is not the criterion.
    tab.send({ type: "subscribe", sessionId: sid });
    await tab.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot");
    await hangApproval(tab, sid);
    const pid = lastLaunch(bridge.records(), sid)?.pid;

    // Walking away before the threshold must not expire anything yet.
    const awayAt = Date.now();
    tab.present(false);
    await sleep(IDLE_MS / 2);
    check(!tab.seen.some((m) => m.type === "approval.remove"), "half a threshold away is not enough to expire it");

    const expired = await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "approval_expired", TICK_WAIT + IDLE_MS, "expiry notice");
    check(expired._at - awayAt >= IDLE_MS, `it expired only after the threshold (${expired._at - awayAt} ms)`);
    check(/过期/.test(String(expired.text)) && /重/.test(String(expired.text)), `the notice says it expired and can be sent again (${JSON.stringify(expired.text)})`);

    const removed = tab.seen.find((m) => m.type === "approval.remove" && m.sessionId === sid);
    check(removed?.decision === "cancel", `the approval was dropped through the cancel path (${removed?.decision})`);
    // The discard reached pi before the process went: the tool call is answered, not just killed off.
    await until(() => bridge.records().some((e) => e.t === "confirm-reply"), 5000, "pi saw the discard");
    check(
      bridge.records().some((e) => e.t === "confirm-reply" && e.reply === "cancelled"),
      "pi saw the tool call discarded (stub recorded the cancelled confirm)",
    );

    const slept = await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "sleep notice");
    check(slept._at >= expired._at, "it slept as part of the same expiry");
    check(bridge.records().some((e) => e.t === "abort"), "the turn was aborted before pi was ended (the idle-sleep close)");
    check(exited(bridge.records(), pid), "the pi process really exited (stub recorded its exit)");

    // Messages stay: the next message wakes the same session in a new process.
    tab.send({ type: "prompt", sessionId: sid, text: "hello" });
    await tab.waitFor((m) => m.type === "item.replace" && m.item?.text === "echo: hello", 20000, "answer after waking");
    const all = launches(bridge.records(), sid);
    check(all.length === 2 && all[1].pid !== all[0].pid, `the next message woke it as a new process (${all.length} launches)`);
  } finally {
    await bridge.stop();
  }
}

// ---------------------------------------------------------------- B. somebody present → never
async function neverExpiresWhileSomebodyIsPresent() {
  log("B. with one page in front, the approval survives far past the threshold");
  const bridge = await startBridge({ name: "here", port: 7902 });
  try {
    // The page that watches this session is not in front (another monitor, another device)…
    const watcher = await client(bridge);
    const sid = await newSession(watcher, "approval");
    log("  session", sid);
    watcher.send({ type: "subscribe", sessionId: sid });
    await watcher.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot");
    await hangApproval(watcher, sid);
    const pid = lastLaunch(bridge.records(), sid)?.pid;
    watcher.present(false);
    // …while this one is: the person is at the keyboard, so nothing expires.
    const phone = await client(bridge);
    phone.present(true);

    // Ticks really do run in this window: a settled session next to it sleeps at one.
    const ticker = await idleSibling(phone);
    await sleep(IDLE_MS * 2);

    check(!watcher.seen.some((m) => m.type === "notice" && m.code === "approval_expired"), `no expiry ${Math.round(IDLE_MS * 2)} ms after the threshold (it would have been 3×)`);
    check(!watcher.seen.some((m) => m.type === "approval.remove"), "the approval card is still there");
    check(!watcher.notices(sid).some((n) => /休眠/.test(n.text)), "the approval session did not sleep");
    check(!watcher.notices(ticker).some((n) => /过期/.test(n.text)), "the ticker had nothing to expire");
    check(!exited(bridge.records(), pid), "its pi process is still there");
    check(!bridge.records().some((e) => e.t === "confirm-reply"), "pi was never told the call was discarded");

    // Still answerable: the approval is live, not a leftover card.
    const stamp = watcher.seen.length;
    watcher.send({ type: "subscribe", sessionId: sid });
    const snap = await watcher.waitFor((m) => m.type === "session" && m.sessionId === sid && watcher.seen.indexOf(m) >= stamp, 10000, "snapshot with the approval");
    check((snap.approvals ?? []).length === 1, `the snapshot still carries the pending approval (${(snap.approvals ?? []).length})`);

    // And it really is answerable: approving it ends the turn.
    watcher.send({ type: "approve", sessionId: sid, approvalId: snap.approvals[0].id, decision: "approve" });
    await watcher.waitFor((m) => m.type === "item.replace" && m.item?.text === "confirm: approved", 20000, "the approved turn finishes");
    check(bridge.records().some((e) => e.t === "confirm-reply" && e.reply === "approved"), "pi ran the call after the approval");
  } finally {
    await bridge.stop();
  }
}

// ---------------------------------------------------------------- C. an ask expires too
async function askExpiresToo() {
  log("C. a question nobody is in front of expires the same way as an approval");
  const bridge = await startBridge({ name: "ask", port: 7903 });
  try {
    const tab = await client(bridge);
    tab.present(true);
    const sid = await newSession(tab, "ask");
    log("  session", sid);
    tab.send({ type: "prompt", sessionId: sid, text: "ASK me" });
    await tab.waitFor((m) => m.type === "ask.add" && m.sessionId === sid, 20000, "ask drawer");
    const pid = lastLaunch(bridge.records(), sid)?.pid;

    const awayAt = Date.now();
    tab.present(false);
    const expired = await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "ask_expired", TICK_WAIT + IDLE_MS, "ask expiry notice");
    check(expired._at - awayAt >= IDLE_MS, `it expired only after the threshold (${expired._at - awayAt} ms)`);
    const removed = tab.seen.find((m) => m.type === "ask.remove" && m.sessionId === sid);
    check(removed?.status === "cancelled", `the ask was dropped through the cancel path (${removed?.status})`);
    await until(() => bridge.records().some((e) => e.t === "ask-reply"), 5000, "the pending post was answered");
    check(bridge.records().some((e) => e.t === "ask-reply" && e.cancelled), "pi saw the question cancelled instead of waiting forever");
    await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "sleep notice");
    check(exited(bridge.records(), pid), "the pi process really exited");
  } finally {
    await bridge.stop();
  }
}

// ---------------------------------- D. an absence that began earlier cannot expire a new card
async function freshCardIsNotExpired() {
  log("D. 人早就走了之后才冒出来的审批，在它自己变老之前不会被丢");
  const bridge = await startBridge({ name: "fresh", port: 7911 });
  try {
    // Nobody ever reports presence, so `absentFor()` has been growing since the bridge booted.
    // Waiting here is what makes the first half of the rule true *before* the card exists.
    await sleep(IDLE_MS + 1500);
    const tab = await client(bridge);
    const sid = await newSession(tab, "approval");
    log("  session", sid);
    tab.send({ type: "subscribe", sessionId: sid });
    await tab.waitFor((m) => m.type === "session" && m.sessionId === sid, 10000, "snapshot");
    await hangApproval(tab, sid);
    const bornAt = Date.now();
    const pid = lastLaunch(bridge.records(), sid)?.pid;

    // TICK_MS is shorter than IDLE_MS, so at least one tick really looked at this card while it
    // was still young. The absence half was already past the threshold; the card's own age was not.
    await sleep(TICK_MS + 300);
    check(!tab.seen.some((m) => m.type === "notice" && m.code === "approval_expired"), "人早走了满阈值，但卡片才挂上 1 秒多 —— 这一轮 tick 没丢它");
    check(!tab.seen.some((m) => m.type === "approval.remove"), "审批卡片还在（没走 cancel 那条路）");
    check(!exited(bridge.records(), pid), "它的 pi 进程也还在");

    // The card's own clock runs out eventually: same threshold, counted from its birth.
    const expired = await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && m.code === "approval_expired", IDLE_MS + TICK_WAIT, "eventual expiry");
    check(expired._at - bornAt >= IDLE_MS, `它自己挂满阈值之后才过期（挂上后 ${expired._at - bornAt} ms）`);
    check(tab.seen.some((m) => m.type === "approval.remove" && m.decision === "cancel"), "到那时才走 cancel 那条路");
    await tab.waitFor((m) => m.type === "notice" && m.sessionId === sid && /休眠/.test(m.text), TICK_WAIT, "sleep notice");
    check(exited(bridge.records(), pid), "然后 pi 进程真的退了");
  } finally {
    await bridge.stop();
  }
}

try {
  await expiresWhenNobodyPresent();
  await neverExpiresWhileSomebodyIsPresent();
  await askExpiresToo();
  await freshCardIsNotExpired();
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
