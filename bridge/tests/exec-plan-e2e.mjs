/**
 * Exercise plan snapshot WS frames against the real bridge and scripted pi (no model/API key).
 * Run after `npm run build:bridge` with `node bridge/tests/exec-plan-e2e.mjs`.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-exec-plan-"));
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const WORK = path.join(ROOT, "work");
const DIST = path.join(REPO, "bridge", "dist", "index.js");
const FAKE_PI = path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs");
const PORT = Number(process.env.EXEC_PLAN_PORT ?? 7914);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "exec-plan-e2e-pass";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_AGENT_DIR: AGENT,
  PI_WEB_PORT: String(PORT),
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_TUNNEL: "0",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_BIN: FAKE_PI,
  FAKE_PI_SESSION: "1",
};

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

let bridgeLog = "";
function startBridge() {
  const child = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (buf) => (bridgeLog += buf.toString()));
  child.stderr.on("data", (buf) => (bridgeLog += buf.toString()));
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* bridge is starting */ }
    await sleep(100);
  }
  throw new Error(`bridge did not become healthy:\n${bridgeLog.slice(-3000)}`);
}
async function login() {
  const response = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}
function connect(cookie, extraHeaders = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, ...extraHeaders } });
  const frames = [];
  ws.on("message", (buf) => frames.push(JSON.parse(buf.toString())));
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, frames, opened };
}
async function waitFor(frames, predicate, from = 0, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = frames.slice(from).find(predicate);
    if (found) return found;
    await sleep(50);
  }
  return null;
}
async function stopBridge(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, sleep(3000)]);
}

let bridge = null;
let socket = null;
try {
  bridge = startBridge();
  await waitHealthy();
  const cookie = await login();
  const first = connect(cookie);
  socket = first.ws;
  await first.opened;
  await waitFor(first.frames, (frame) => frame.type === "hello");

  const createAt = first.frames.length;
  first.ws.send(JSON.stringify({ type: "create", cwd: WORK, name: "exec-plan-e2e" }));
  const created = await waitFor(first.frames, (frame) => frame.type === "session" && frame.history, createAt);
  assert.ok(created, "create returns a session frame");
  const sessionId = created.sessionId;
  assert.equal(typeof sessionId, "string");

  const promptAt = first.frames.length;
  first.ws.send(JSON.stringify({ type: "prompt", sessionId, text: "PLAN snapshot scenario" }));
  const planFrame = await waitFor(
    first.frames,
    (frame) => frame.type === "plan" && frame.sessionId === sessionId && frame.plan?.tasks?.some((task) => task.id === 2 && task.status === "in_progress"),
    promptAt,
  );
  assert.ok(planFrame, "todo tool completion broadcasts the full plan snapshot");
  assert.deepEqual(planFrame.plan.tasks.map((task) => task.id), [1, 2, 3, 4]);
  assert.ok(await waitFor(first.frames, (frame) => frame.type === "pi.status" && frame.sessionId === sessionId && frame.running === false, promptAt));
  socket.close();
  socket = null;
  await stopBridge(bridge);
  bridge = null;

  // A fresh bridge reads the persisted plan from the session branch and returns it alongside a
  // tail page; the turn that originally listed the plan is deliberately outside that page.
  bridge = startBridge();
  await waitHealthy();
  const second = connect(await login(), { "cf-connecting-ip": "203.0.113.7" });
  socket = second.ws;
  await second.opened;
  await waitFor(second.frames, (frame) => frame.type === "hello");
  second.ws.send(JSON.stringify({ type: "subscribe", sessionId }));
  const reopened = await waitFor(second.frames, (frame) => frame.type === "session" && frame.sessionId === sessionId && frame.history);
  assert.ok(reopened, "reopening a session returns its history frame");
  assert.deepEqual(reopened.plan?.tasks.map((task) => task.id), [1, 2, 3, 4]);
  assert.equal(reopened.plan?.tasks.find((task) => task.id === 2)?.status, "in_progress");
  assert.ok(reopened.history.turns.length > reopened.items.length, `${reopened.history.turns.length} full turns vs ${reopened.items.length} tail-page items`);
  assert.equal(reopened.history.turns[1]?.id, reopened.plan?.listedRound, "listing round is retained from the persisted branch snapshot");
  assert.equal(reopened.items.some((item) => item.id === reopened.plan?.listedRound), false, "the listed round is not on the returned tail page");
  assert.ok(reopened.history.turns.some((turn) => turn.id === reopened.plan?.listedRound), "the full turn index still resolves the listing round");

  console.log("exec-plan-e2e: plan frame and replayed session snapshot passed");
} catch (error) {
  console.error(error);
  console.error(bridgeLog.slice(-4000));
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  await stopBridge(bridge);
  fs.rmSync(ROOT, { recursive: true, force: true });
}
