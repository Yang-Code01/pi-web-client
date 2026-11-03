/**
 * Composer actions against a scripted pi (fixtures/fake-pi.mjs) — issues #14 #16.
 *
 *  A. #14  While a run is going, a plain send steers it and `behavior:"followUp"` waits for it;
 *          pi's queue reaches the page (and a page opened later via the snapshot); 撤回 takes the
 *          queue back into the editor without stopping the run.
 *  B. #16  `!cmd` runs through pi's RPC bash: a card that streams, then settles with the exit code;
 *          `!!` keeps it out of the context; 停止 aborts it; only one at a time.
 *  C. #16  A bashExecution message already in a session file renders as the same card.
 *
 * Needs a built bridge: `npm run build:bridge && node bridge/tests/composer-actions.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7897;
const ROOT = path.join(REPO, ".scratch", "composer-actions");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

// A session whose history holds a `!ls` the user ran in the terminal.
const DISK_ID = "zz-bash-history";
const diskFile = path.join(AGENT, "sessions", "--fixture--", `2026-01-01T00-00-00-000Z_${DISK_ID}.jsonl`);
fs.mkdirSync(path.dirname(diskFile), { recursive: true });
const at = new Date(Date.now() - 3600_000).toISOString();
fs.writeFileSync(
  diskFile,
  [
    { type: "session", version: 3, id: DISK_ID, timestamp: at, cwd: REPO },
    { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "look around" }] } },
    {
      type: "message",
      id: "b1",
      parentId: "u1",
      timestamp: at,
      message: { role: "bashExecution", command: "ls -la", output: "total 0\nREADME.md\n", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
fs.utimesSync(diskFile, new Date(at), new Date(at));

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
const piLog = () => (fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

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
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

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

async function page(cookie, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  const waits = [];
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    if (m.type === "notice") log(`notice(${label}):`, m.level, m.text);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms, what, from = 0) => {
    const hit = seen.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        waits.splice(waits.indexOf(w), 1);
        reject(new Error(`timeout (${label}): ${what}`));
      }, ms);
      waits.push(w);
    });
  };
  const send = (m) => ws.send(JSON.stringify(m));
  await waitFor((m) => m.type === "hello", 5000, "hello");
  return { ws, seen, waitFor, send };
}

const pages = [];
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const a = await page(cookie, "A");
  pages.push(a);

  a.send({ type: "create", cwd: REPO, name: "composer-actions" });
  const sid = (await a.waitFor((m) => m.type === "session" && m.sessionId, 20000, "created")).sessionId;

  // ------------------------------------------------------------------ A. steer / followUp / queue (#14)
  log("A. steer by default, followUp on request, queue visible and withdrawable");
  a.send({ type: "prompt", sessionId: sid, text: "SLOW work" });
  await a.waitFor((m) => m.type === "delta" && m.sessionId === sid, 10000, "streaming");
  a.send({ type: "prompt", sessionId: sid, text: "steer me" });
  a.send({ type: "prompt", sessionId: sid, text: "later", behavior: "followUp" });
  const q = await a.waitFor((m) => m.type === "queue" && m.sessionId === sid && m.steering?.length === 1 && m.followUp?.length === 1, 5000, "queue");
  check(q.steering[0] === "steer me" && q.followUp[0] === "later", "queue message carries both lists");
  const sent = piLog().filter((e) => e.t === "prompt");
  check(sent.find((e) => e.text === "steer me")?.behavior === "steer", "plain send while running = steer (Enter)");
  check(sent.find((e) => e.text === "later")?.behavior === "followUp", "behavior followUp passes through (Alt+Enter)");
  const b = await page(cookie, "B");
  pages.push(b);
  b.send({ type: "subscribe", sessionId: sid });
  const snap = await b.waitFor((m) => m.type === "session" && m.sessionId === sid, 5000, "B snapshot");
  check(JSON.stringify(snap.queue) === JSON.stringify({ steering: ["steer me"], followUp: ["later"] }), "a page opened mid-run gets the queue in the snapshot");
  const markA = a.seen.length;
  a.send({ type: "clearQueue", sessionId: sid });
  const restore = await a.waitFor((m) => m.type === "queue.restore" && m.sessionId === sid, 5000, "restore", markA);
  check(JSON.stringify(restore.texts) === JSON.stringify(["steer me", "later"]), "撤回 hands both texts back");
  await a.waitFor((m) => m.type === "queue" && m.sessionId === sid && !m.steering.length && !m.followUp.length, 5000, "queue emptied", markA);
  const removed = await a.waitFor((m) => m.type === "item.remove" && m.sessionId === sid, 5000, "bubbles removed", markA);
  check(removed.ids.length === 2, "both queued bubbles removed");
  await sleep(500);
  check(!a.seen.slice(markA).some((m) => m.type === "pi.status" && m.running === false), "the run keeps going (撤回 is not stop)");
  check(!piLog().some((e) => e.t === "abort"), "no abort sent");
  a.send({ type: "abort", sessionId: sid });
  await a.waitFor((m) => m.type === "pi.status" && m.sessionId === sid && m.running === false, 5000, "stopped");

  // ------------------------------------------------------------------ B. !cmd (#16)
  log("B. !cmd / !!cmd / stop / one at a time");
  let mark = a.seen.length;
  a.send({ type: "bash", sessionId: sid, command: "echo hi", excludeFromContext: false });
  const started = await a.waitFor((m) => m.type === "item.add" && m.item?.kind === "bash", 5000, "bash card", mark);
  check(started.item.status === "running" && started.item.command === "echo hi", "card appears as running");
  const delta = await a.waitFor((m) => m.type === "bash.delta" && m.id === started.item.id, 5000, "bash delta", mark);
  check(delta.text === "ran: echo hi\n", "output streams into the card");
  const fin = await a.waitFor((m) => m.type === "item.replace" && m.id === started.item.id, 5000, "bash done", mark);
  check(fin.item.status === "done" && fin.item.exitCode === 0 && fin.item.output === "ran: echo hi\n" && !fin.item.excludeFromContext, "settles with exit 0, output kept");
  check(piLog().find((e) => e.t === "bash" && e.command === "echo hi")?.exclude === false, "! → in context");

  mark = a.seen.length;
  a.send({ type: "bash", sessionId: sid, command: "fail now", excludeFromContext: true });
  const failed2 = await a.waitFor((m) => m.type === "item.replace" && m.item?.kind === "bash" && m.item.command === "fail now", 5000, "fail done", mark);
  check(failed2.item.exitCode === 2 && failed2.item.excludeFromContext === true, "!! → excluded; exit code 2 reported");
  check(piLog().find((e) => e.t === "bash" && e.command === "fail now")?.exclude === true, "excludeFromContext reached pi");

  mark = a.seen.length;
  a.send({ type: "bash", sessionId: sid, command: "sleep 5", excludeFromContext: false });
  const sleeping = await a.waitFor((m) => m.type === "item.add" && m.item?.command === "sleep 5", 5000, "sleep card", mark);
  await a.waitFor((m) => m.type === "bash.delta" && m.id === sleeping.item.id, 5000, "ticks", mark);
  a.send({ type: "bash", sessionId: sid, command: "echo second", excludeFromContext: false });
  await a.waitFor((m) => m.type === "notice" && /还在跑/.test(m.text), 5000, "one at a time", mark);
  a.send({ type: "abortBash", sessionId: sid });
  const stopped = await a.waitFor((m) => m.type === "item.replace" && m.id === sleeping.item.id, 5000, "aborted", mark);
  check(stopped.item.cancelled === true && stopped.item.status === "done", "停止 → cancelled");
  check(piLog().some((e) => e.t === "abort_bash"), "abort_bash reached pi");
  check(!piLog().some((e) => e.t === "bash" && e.command === "echo second"), "second command refused while the first ran");

  // ------------------------------------------------------------------ C. bashExecution from disk (#16)
  log("C. a bashExecution message in the file renders as a card");
  a.send({ type: "subscribe", sessionId: DISK_ID });
  const disk = await a.waitFor((m) => m.type === "session" && m.sessionId === DISK_ID, 5000, "disk snapshot");
  const card = disk.items.find((it) => it.kind === "bash");
  check(card?.command === "ls -la" && card.output === "total 0\nREADME.md\n" && card.exitCode === 0 && card.excludeFromContext === true, `disk card (${JSON.stringify(card)})`);
} catch (err) {
  failed = true;
  console.error("ERROR", err.message);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  for (const p of pages) {
    try {
      p.ws.close();
    } catch {}
  }
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
