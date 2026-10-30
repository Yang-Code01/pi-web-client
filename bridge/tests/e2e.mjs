/**
 * End-to-end check for M1: login → sessions → create → prompt → stream → approval → abort.
 * Run against a live bridge: PI_WEB_PORT=7867 PI_WEB_STATE=... node tests/e2e.mjs
 */
import fs from "node:fs";
import { WebSocket } from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 7867);
const STATE = process.env.PI_WEB_STATE ?? "F:/pi-web-client/.scratch/test-state";
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = process.env.PI_WEB_TEST_CWD ?? "F:/pi-web-client";

const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const res = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
if (!res.ok) throw new Error(`login failed ${res.status}`);
const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
log("login ok");

const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
log("sessions:", sessions.length, "| newest:", sessions[0]?.name?.slice(0, 30));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
const seen = [];
const waiters = [];
ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  seen.push(msg);
  if (msg.type === "error") log("bridge error:", msg.message);
  for (const w of waiters.slice()) {
    if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  }
});
const waitFor = (pred, ms = 120000, label = "event") =>
  new Promise((resolve, reject) => {
    const hit = seen.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => {
      const i = waiters.findIndex((w) => w.timer === timer);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, ms);
    waiters.push({ pred, timer, resolve });
  });

await new Promise((r) => ws.on("open", r));
log("ws open");

// 1. create a live session
ws.send(JSON.stringify({ type: "create", cwd: CWD, name: "e2e 测试会话" }));
const created = await waitFor((m) => m.type === "session" || (m.type === "session.state" && m.session?.name === "e2e 测试会话"), 60000, "session");
const sessionId = created.session?.id ?? created.sessionId ?? created.session?.id;
log("session:", sessionId);

// 2. plain prompt, expect a streamed reply
const mark = seen.length;
ws.send(JSON.stringify({ type: "prompt", sessionId, text: "只回复两个字：你好" }));
await waitFor((m) => m.type === "pi.status" && m.sessionId === sessionId && m.running === false, 180000, "turn end");
const slice = seen.slice(mark);
const text = slice.filter((m) => m.type === "delta" && m.field === "text").map((m) => m.text).join("");
log(`prompt#1 → deltas=${slice.filter((m) => m.type === "delta").length} reply="${text.slice(0, 40)}"`);

// 3. approval path: a destructive bash command must go through the gate extension
ws.send(JSON.stringify({ type: "prompt", sessionId, text: "用 bash 工具执行：rm -rf F:/pi-web-client/.scratch/e2e-nonexistent" }));
const approval = await waitFor((m) => m.type === "approval.add" && m.sessionId === sessionId, 120000, "approval.add");
log("approval.add:", approval.approval?.title, "|", approval.approval?.message);
ws.send(JSON.stringify({ type: "approve", sessionId, approvalId: approval.approval.id, decision: "reject" }));
const removed = await waitFor((m) => m.type === "approval.remove" && m.id === approval.approval.id, 20000, "approval.remove");
log("approval.remove:", removed.decision);
const toolEnd = await waitFor((m) => m.type === "tool" && m.phase === "end", 120000, "tool end");
log(`tool end: name=${toolEnd.toolCallId} isError=${toolEnd.isError} result="${String(toolEnd.result ?? "").slice(0, 80)}"`);
await waitFor((m) => m.type === "pi.status" && m.sessionId === sessionId && m.running === false, 180000, "turn end");
log("prompt#2 settled");

// 4. abort a running turn
ws.send(JSON.stringify({ type: "prompt", sessionId, text: "用 bash 执行 sleep 45" }));
await waitFor((m) => m.type === "tool" && m.phase === "start", 90000, "tool start");
log("sleep running; sending abort");
ws.send(JSON.stringify({ type: "abort", sessionId }));
await waitFor((m) => m.type === "pi.status" && m.sessionId === sessionId && m.running === false, 60000, "abort settle");
const last = seen.filter((m) => m.type === "tool" && m.phase === "end").pop();
log("abort settled; last tool end isError=", last?.isError);

const counts = {};
for (const e of seen) counts[e.type] = (counts[e.type] ?? 0) + 1;
log("events:", seen.length, JSON.stringify(counts));
fs.writeFileSync(`${STATE}/e2e-events.json`, JSON.stringify(seen, null, 1));
ws.close();
log("PASS");
process.exit(0);
