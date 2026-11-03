/**
 * Run lifecycle against a scripted pi (fixtures/fake-pi.mjs) — issues #9 #10 #11 #12.
 *
 *  A. #10/#12  A retried run stays "running" until agent_settled; a message sent between
 *              agent_end and agent_settled is queued, not rejected; provider errors reach the
 *              transcript (errorMessage) and the final retry failure is announced.
 *  B. #9       Stop clears pi's queue first: queued messages do not run afterwards, their text
 *              comes back (queue.restore) and their bubbles leave the transcript.
 *  C. #11      A compaction longer than 20 s is not reported as a timeout, and a message sent
 *              during it is held and delivered afterwards instead of being bounced.
 *
 * Needs a built bridge: `npm run build:bridge && node bridge/tests/run-lifecycle.mjs` (~40 s).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7893;
const ROOT = path.join(REPO, ".scratch", "run-lifecycle");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;
const COMPACT_MS = 22_000;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

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
const piLog = () =>
  fs.existsSync(PI_LOG)
    ? fs
        .readFileSync(PI_LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    FAKE_PI_LOG: PI_LOG,
    FAKE_COMPACT_MS: String(COMPACT_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

/** Every message the bridge sent, in order, so checks can look at sequences after the fact. */
const seen = [];
const waits = [];
function waitFor(pred, ms, label) {
  const hit = seen.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const entry = { pred, resolve };
    entry.timer = setTimeout(() => {
      waits.splice(waits.indexOf(entry), 1);
      reject(new Error(`timeout: ${label}`));
    }, ms);
    waits.push(entry);
  });
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

let ws;
const send = (msg) => ws.send(JSON.stringify(msg));
const notices = (sid) => seen.filter((m) => m.type === "notice" && m.sessionId === sid);

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    msg._at = Date.now();
    seen.push(msg);
    if (msg.type === "notice") log("notice:", msg.level, msg.text);
    for (const w of [...waits]) {
      if (w.pred(msg)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  await waitFor((m) => m.type === "hello", 5000, "hello");

  send({ type: "create", cwd: REPO, name: "run-lifecycle" });
  const created = await waitFor((m) => m.type === "session" && m.sessionId, 20000, "session created");
  const sid = created.sessionId;
  log("session", sid);

  // ------------------------------------------------------------------ A. retry (#10, #12)
  log("A. retry keeps the run alive; errors are shown");
  const markA = seen.length;
  send({ type: "prompt", sessionId: sid, text: "RETRY please" });
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /第 1\/2 次/.test(m.text), 10000, "auto_retry_start notice");
  // Between agent_end(willRetry) and agent_settled: pi rejects a bare prompt here.
  send({ type: "prompt", sessionId: sid, text: "sent during retry" });
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /重试后仍失败/.test(m.text), 10000, "auto_retry_end notice");
  await waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === false && seen.indexOf(m) >= markA, 10000, "settled");
  const sliceA = seen.slice(markA);
  const firstIdle = sliceA.findIndex((m) => m.type === "pi.status" && m.running === false);
  const retryEnd = sliceA.findIndex((m) => m.type === "notice" && /重试后仍失败/.test(m.text));
  check(firstIdle > retryEnd, "no idle status before the retried run settled (agent_end ≠ end)");
  const duringRetry = piLog().find((e) => e.text === "sent during retry");
  check(duringRetry?.t === "prompt" && (duringRetry.behavior === "steer" || duringRetry.behavior === "followUp"), `message sent mid-retry was queued (pi saw ${JSON.stringify(duringRetry)})`);
  check(!notices(sid).some((n) => /already processing/i.test(n.text)), "no 'Agent is already processing' error");
  const errs = sliceA.filter((m) => (m.type === "item.replace" || m.type === "item.add") && m.item?.stopReason === "error").map((m) => m.item.errorMessage);
  check(errs.includes("429 Too Many Requests") && errs.includes("401 invalid api key"), `errorMessage carried on assistant items (${JSON.stringify(errs)})`);
  check(sliceA.some((m) => m.type === "notice" && /401 invalid api key/.test(m.text)), "final retry failure names the error");

  // ------------------------------------------------------------------ B. stop clears the queue (#9)
  log("B. stop clears the queue");
  const markB = seen.length;
  send({ type: "prompt", sessionId: sid, text: "SLOW stream" });
  await waitFor((m) => m.type === "delta" && m.sessionId === sid && seen.indexOf(m) >= markB, 10000, "streaming");
  send({ type: "prompt", sessionId: sid, text: "queued-1" });
  send({ type: "prompt", sessionId: sid, text: "queued-2" });
  await waitFor((m) => m.type === "queue" && m.sessionId === sid && (m.steering?.length ?? 0) + (m.followUp?.length ?? 0) === 2, 10000, "two queued");
  send({ type: "abort", sessionId: sid });
  const restore = await waitFor((m) => m.type === "queue.restore" && m.sessionId === sid, 10000, "queue.restore");
  check(JSON.stringify(restore.texts) === JSON.stringify(["queued-1", "queued-2"]), `queued text handed back (${JSON.stringify(restore.texts)})`);
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /已撤回 2 条/.test(m.text), 10000, "withdraw notice");
  const removed = seen.slice(markB).find((m) => m.type === "item.remove" && m.sessionId === sid);
  const userIdsByText = new Map(seen.filter((m) => m.type === "item.add" && m.item?.kind === "user").map((m) => [m.item.text, m.item.id]));
  check(
    removed && removed.ids.includes(userIdsByText.get("queued-1")) && removed.ids.includes(userIdsByText.get("queued-2")),
    "withdrawn bubbles removed from the transcript (item.remove)",
  );
  check(removed && !removed.ids.includes(userIdsByText.get("SLOW stream")), "the sent message stays");
  await sleep(2000);
  const after = piLog();
  check(after.some((e) => e.t === "clear_queue" && (e.steering?.length ?? 0) + (e.followUp?.length ?? 0) === 2), "clear_queue reached pi");
  check(!after.some((e) => (e.t === "turn" || e.t === "resume-queue") && /^queued-/.test(e.text)), "queued messages did not run after stop");

  // ------------------------------------------------------------------ C. long compaction (#11)
  log(`C. compaction of ${COMPACT_MS / 1000}s with a message sent in the middle`);
  const markC = seen.length;
  send({ type: "compact", sessionId: sid });
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /开始压缩/.test(m.text) && seen.indexOf(m) >= markC, 10000, "compaction_start");
  await sleep(500);
  send({ type: "prompt", sessionId: sid, text: "after compact" });
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /压缩完成后发出/.test(m.text), 5000, "held notice");
  await waitFor((m) => m.type === "notice" && m.sessionId === sid && /上下文已压缩/.test(m.text), COMPACT_MS + 10000, "compaction_end");
  await waitFor((m) => m.type === "item.replace" && m.sessionId === sid && m.item?.text === "echo: after compact", 10000, "held message answered");
  const sliceC = seen.slice(markC);
  check(!sliceC.some((m) => m.type === "notice" && /timeout after/.test(m.text)), "no 20 s timeout reported");
  check(!sliceC.some((m) => m.type === "notice" && /compaction is in progress/.test(m.text)), "prompt was not bounced by pi");
  const logC = piLog();
  const endAt = logC.find((e) => e.t === "compact-end")?.at ?? Infinity;
  const sentAt = logC.find((e) => e.t === "prompt" && e.text === "after compact")?.at ?? 0;
  check(sentAt >= endAt, "held prompt reached pi only after compaction ended");
  check(!logC.some((e) => e.t === "prompt-rejected"), "pi rejected nothing in the whole run");
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  try {
    ws?.close();
  } catch {}
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
