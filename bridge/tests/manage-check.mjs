/**
 * Probe: session management (D46) against the real bridge.
 *
 * Covers: hand-set order survives a restart, archiving hides nothing from the API,
 * deleting a plain session removes the file + its name override, and a live session
 * refuses to be deleted.
 *
 * Run: node bridge/tests/manage-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 7876;
const ROOT = "F:/pi-web-client/.scratch/manage-check";
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(SESSIONS, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A session file pi itself would accept: header row + one user message. */
function mkSession(id, text, hoursAgo) {
  const dir = path.join(SESSIONS, `--${id}--`);
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  const rows = [
    { type: "session", version: 3, id, timestamp: at, cwd: CWD },
    { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.utimesSync(file, new Date(), new Date(at));
  return file;
}

const fileB = mkSession("zz-manage-b", "第二个会话", 3);
const fileC = mkSession("zz-manage-c", "第三个会话", 2);
const fileA = mkSession("zz-manage-a", "第一个会话", 1);
const ids = { b: "zz-manage-b", c: "zz-manage-c", a: "zz-manage-a" };

let bridge = null;
const bridgeOut = [];
function startBridge() {
  bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: "F:/pi-web-client",
    env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
  bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  console.error(bridgeOut.join("").slice(-2000));
  assert(false, `timeout waiting for ${label}`);
}

let ws = null;
const waits = new Map();
function waitFor(type, fn = () => true, ms = 10000) {
  return new Promise((resolve) => {
    const entry = { fn, resolve };
    entry.timer = setTimeout(() => {
      const list = waits.get(type) ?? [];
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      resolve(null);
    }, ms);
    if (!waits.has(type)) waits.set(type, []);
    waits.get(type).push(entry);
  });
}
function attach() {
  ws.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    const list = waits.get(msg.type) ?? [];
    for (const entry of [...list]) {
      if (entry.fn(msg)) {
        list.splice(list.indexOf(entry), 1);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
    if (msg.type === "notice") log("notice:", msg.level, msg.text);
  });
}

let cookie = "";
const list = async () => (await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json()).sessions;
const order = async () => (await list()).map((s) => s.id);
const send = (msg) => ws.send(JSON.stringify(msg));

async function connect() {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  attach();
  await new Promise((r) => ws.on("open", r));
  await waitFor("hello", () => true);
}

try {
  startBridge();
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase");
  await connect();

  let rows = await list();
  assert(rows.length === 3, `three sessions listed (got ${rows.length})`);
  assert(rows.some((s) => s.id === ids.a && s.pinned === false && s.archived === false), "flags present on rows");
  log("initial:", (await order()).map((id) => id.slice(-1)).join(" → "));

  // 1. Arrange: pin b, then c before a.
  send({ type: "manage", action: "arrange", pin: [ids.b], order: [ids.c, ids.a] });
  await waitFor("manage", (m) => m.manage?.pin?.[0] === ids.b);
  let now = await order();
  assert(now[0] === ids.b && now[1] === ids.c && now[2] === ids.a, `arranged order (got ${now.map((x) => x.slice(-1)).join("")})`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(STATE, "manage.json"), "utf8"));
  assert(onDisk.pin[0] === ids.b && onDisk.order[1] === ids.a, "manage.json written");
  log("pinned + ordered, persisted to manage.json");

  // 2. Archive keeps the row (the client decides to hide it).
  send({ type: "manage", action: "archive", ids: [ids.a], on: true });
  await waitFor("manage", (m) => m.manage?.archived?.includes(ids.a));
  rows = await list();
  assert(rows.length === 3, "archived session still listed for the API");
  assert(rows.find((s) => s.id === ids.a).archived === true, "archived flag on the row");
  assert((await order())[2] === ids.a, "archived sorts last");
  send({ type: "manage", action: "archive", ids: [ids.a], on: false });
  await waitFor("manage", (m) => !m.manage?.archived?.includes(ids.a));
  log("archive / restore ok");

  // 3. A name override must be forgotten together with the file.
  send({ type: "rename", sessionId: ids.a, name: "临时名字" });
  await until(async () => (await list()).find((s) => s.id === ids.a)?.name === "临时名字", 5000, "rename");
  send({ type: "manage", action: "delete", ids: [ids.a] });
  const gone = await waitFor("session.gone");
  assert(gone && gone.ids.includes(ids.a), "session.gone broadcast");
  assert(!fs.existsSync(fileA), "session file deleted");
  assert(!(await order()).includes(ids.a), "deleted session left the list");
  const names = JSON.parse(fs.readFileSync(path.join(STATE, "names.json"), "utf8"));
  assert(!names[ids.a], "name override cleaned up");
  assert(!JSON.parse(fs.readFileSync(path.join(STATE, "manage.json"), "utf8")).order.includes(ids.a), "manage.json cleaned up");
  log("delete removed file + name + manage entry");

  // 4. A live session refuses to go.
  ws.send(JSON.stringify({ type: "create", cwd: CWD }));
  const created = await waitFor("session", (m) => m.state?.owned === true, 90000);
  assert(created, "live session created");
  const liveId = created.sessionId;
  const refusal = waitFor("notice", (m) => m.level === "error" && /不能删/.test(m.text), 8000);
  send({ type: "manage", action: "delete", ids: [liveId] });
  const notice = await refusal;
  assert(notice, `live delete refused (got ${JSON.stringify(notice)})`);
  assert((await order()).includes(liveId), "live session still there");
  log("live delete refused:", notice.text.slice(0, 40));

  // 5. Restart: the arrangement is part of the state, not of this process.
  ws.close();
  bridge.kill();
  await sleep(1200);
  startBridge();
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase (restart)");
  await connect();
  now = await order();
  const pinnedFirst = now[0] === ids.b;
  const afterPin = now.slice(1).filter((id) => id === ids.c || id === ids.a);
  assert(pinnedFirst, `pinned survived restart (got ${now.map((x) => x.slice(-1)).join("")})`);
  assert(afterPin[0] === ids.c, "manual order survived restart");
  log("restart kept the arrangement");

  console.log("ALL OK");
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  bridge?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
