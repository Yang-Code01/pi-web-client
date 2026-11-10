/** Exercise incremental child-session subscriptions through a real bridge and fake pi. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-exec-child-"));
const STATE = path.join(ROOT, "state");
const PORT = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "exec-child-pass";
const RUN_ID = `del_exec_${process.pid}`;
const CHILD_FILE = path.join(os.tmpdir(), "acp-delegate", `${RUN_ID}.session.jsonl`);
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let bridge;
let socket;
let secondSocket;
let publicSocket;
let bridgeLog = "";

function client(ws) {
  const frames = [];
  ws.on("message", (chunk) => frames.push(JSON.parse(chunk.toString())));
  return {
    ws,
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: async (predicate, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const found = frames.find(predicate);
        if (found) return found;
        await sleep(20);
      }
      throw new Error(`timed out waiting for ${label}; frames: ${JSON.stringify(frames.slice(-8))}`);
    },
    open: () => new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
  };
}

try {
  fs.mkdirSync(STATE, { recursive: true });
  const env = {
    ...process.env,
    PI_WEB_STATE: STATE,
    PI_AGENT_DIR: path.join(ROOT, "agent"),
    PI_WEB_PORT: String(PORT),
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_TUNNEL: "0",
    PI_WEB_ROOT: path.join(REPO, "web", "dist"),
    PI_BIN: FAKE_PI,
    FAKE_PI_CHILD_RUN_ID: RUN_ID,
  };
  execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });
  bridge = spawn(process.execPath, [DIST], { env, stdio: ["ignore", "pipe", "pipe"] });
  bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
  bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));
  let healthy = false;
  for (let i = 0; i < 100; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/healthz`)).ok;
      if (healthy) break;
    } catch { /* bridge is starting */ }
    await sleep(100);
  }
  assert.equal(healthy, true, "bridge starts for the child subscription test");

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  assert.equal(login.ok, true, `login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const local = client(new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } }));
  socket = local.ws;
  await local.open();
  const created = local.waitFor((frame) => frame.type === "session" && frame.state?.id, "created parent session");
  local.send({ type: "create", cwd: REPO, name: "exec child subscription" });
  const parent = await created;
  const sessionId = parent.state.id;
  local.send({ type: "subscribe", sessionId });
  await local.waitFor((frame) => frame.type === "session" && frame.sessionId === sessionId, "parent snapshot");

  local.send({ type: "prompt", sessionId, text: "BGCHILD" });
  await local.waitFor((frame) => frame.type === "item.replace" && frame.sessionId === sessionId && frame.item?.name === "acp_delegate", "child dispatch result");
  local.send({ type: "bg.list", sessionId });
  const runs = await local.waitFor((frame) => frame.type === "bg.list" && frame.sessionId === sessionId, "child run list");
  assert.equal(runs.runs.some((run) => run.id === RUN_ID && run.toolCallId), true, "run list links the child run to its dispatch tool call");

  local.send({ type: "exec.child.subscribe", sessionId, runId: RUN_ID });
  const snapshot = await local.waitFor((frame) => frame.type === "exec.child.snapshot" && frame.runId === RUN_ID, "initial child snapshot");
  assert.equal(snapshot.items.some((item) => item.kind === "assistant" && item.text === "child-first"), true);
  assert.deepEqual(snapshot.plan.tasks.map((task) => [task.id, task.status]), [[1, "completed"], [2, "in_progress"]]);
  assert.deepEqual(snapshot.items.find((item) => item.kind === "tool" && item.name === "todo").plan, snapshot.plan);
  assert.equal(snapshot.stats.tokens.total, 15);
  assert.equal(snapshot.stats.cost, 0.01);
  const planUpdate = await local.waitFor((frame) => frame.type === "exec.child.delta" && frame.runId === RUN_ID && frame.plan?.tasks?.[1]?.status === "completed", "plan-only child update", 7000);
  assert.deepEqual(planUpdate.items, [], "a changed plan snapshot is sent even without a new display item");
  assert.equal(planUpdate.plan.tasks.filter((task) => task.status === "completed").length, 2);
  const appended = await local.waitFor((frame) => frame.type === "exec.child.delta" && frame.runId === RUN_ID && frame.items.some((item) => item.kind === "assistant" && item.text === "child-second"), "incremental child append", 7000);
  assert.equal(appended.items.length, 1, "appends arrive as one added child item, not a full transcript replay");
  assert.equal(appended.stats.tokens.total, 30);
  assert.equal(appended.stats.cost, 0.02);

  local.send({ type: "exec.child.unsubscribe", sessionId, runId: RUN_ID });
  const deltaCount = local.frames.filter((frame) => frame.type === "exec.child.delta" && frame.runId === RUN_ID).length;
  await sleep(1800);
  assert.equal(local.frames.filter((frame) => frame.type === "exec.child.delta" && frame.runId === RUN_ID).length, deltaCount, "unsubscribe stops incremental frames");

  secondSocket = client(new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } }));
  await secondSocket.open();
  secondSocket.send({ type: "exec.child.subscribe", sessionId, runId: RUN_ID });
  await secondSocket.waitFor((frame) => frame.type === "exec.child.snapshot" && frame.runId === RUN_ID, "second subscriber snapshot");
  secondSocket.ws.close();
  await new Promise((resolve) => secondSocket.ws.once("close", resolve));
  await sleep(1800);

  publicSocket = client(new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, "cf-connecting-ip": "198.51.100.12" } }));
  await publicSocket.open();
  publicSocket.send({ type: "exec.child.subscribe", sessionId, runId: RUN_ID });
  const refused = await publicSocket.waitFor((frame) => frame.type === "exec.child.unavailable" && frame.runId === RUN_ID, "public child refusal");
  assert.equal(refused.error, "public");

  console.log("PASS child subscription sends snapshots and incremental item/stats updates, stops on unsubscribe/disconnect, and refuses public access.");
} finally {
  for (const ws of [publicSocket?.ws, secondSocket?.ws, socket]) if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  bridge?.kill();
  await sleep(150);
  try { fs.rmSync(CHILD_FILE, { force: true }); } catch { /* absent if startup failed */ }
  fs.rmSync(ROOT, { recursive: true, force: true });
  if (bridgeLog.includes("Error:")) console.error(bridgeLog.slice(-3000));
}
