/**
 * Probe: session management (D46) against the real bridge.
 *
 * Covers: hand-set order survives a restart, archiving hides nothing from the API,
 * deleting a plain session removes the file + its name override, a live session is released
 * and then binned instead of refusing (D198), a terminal-held one is still skipped with a
 * reason (Q-001), and a mixed batch still deletes what it can.
 *
 * Run: node bridge/tests/manage-check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 7876);
const ROOT = path.join(REPO, ".scratch/manage-check");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;

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

mkSession("zz-manage-b", "第二个会话", 3);
const fileC = mkSession("zz-manage-c", "第三个会话", 2);
const fileA = mkSession("zz-manage-a", "第一个会话", 1);
const ids = { b: "zz-manage-b", c: "zz-manage-c", a: "zz-manage-a" };

let bridge = null;
const bridgeOut = [];
function startBridge() {
  bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
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
  const archivedEcho = await waitFor("manage", (m) => m.manage?.archived?.includes(ids.a));
  const beforeOrder = archivedEcho.manage.order.slice();
  rows = await list();
  assert(rows.length === 3, "archived session still listed for the API");
  assert(rows.find((s) => s.id === ids.a).archived === true, "archived flag on the row");
  assert((await order())[2] === ids.a, "archived sorts last");
  send({ type: "manage", action: "archive", ids: [ids.a], on: false });
  await waitFor("manage", (m) => !m.manage?.archived?.includes(ids.a));
  log("archive / restore ok");

  // 2b. D146 废止了 D125：打开会话不改排列 —— 不置顶、不解归档、manage.json 一个字节都不动。
  // 旧页面仍会发这条消息，桥要照常回一份快照（它乐观改过自己的 manage，得被纠正回来）。
  send({ type: "manage", action: "archive", ids: [ids.a], on: true });
  await waitFor("manage", (m) => m.manage?.archived?.includes(ids.a));
  const manageFile = path.join(STATE, "manage.json");
  const beforeOpen = fs.readFileSync(manageFile, "utf8");

  send({ type: "manage", action: "opened", id: ids.a });
  const echo = await waitFor("manage", (m) => Array.isArray(m.manage?.pin));
  assert(echo, "opened 会回一份快照（旧页面靠它纠正乐观状态）");
  assert(echo.manage.archived.includes(ids.a), "打开归档会话不再解除归档");
  assert(!echo.manage.pin.includes(ids.a), "打开归档会话也不再置顶");

  send({ type: "manage", action: "opened", id: ids.c });
  const echo2 = await waitFor("manage", (m) => Array.isArray(m.manage?.order));
  assert(echo2.manage.pin.length === 1 && echo2.manage.pin[0] === ids.b, `打开没置顶的会话不动 pin（pin = ${echo2.manage.pin.map((x) => x.slice(-1)).join("")}）`);
  assert(echo2.manage.order.join() === beforeOrder.join(), `order 也不动（${echo2.manage.order.map((x) => x.slice(-1)).join("")}）`);
  assert(fs.readFileSync(manageFile, "utf8") === beforeOpen, "manage.json 没被 opened 改写");

  send({ type: "manage", action: "opened", id: "zz-does-not-exist" });
  const bogus = await waitFor("manage", (m) => Array.isArray(m.manage?.pin));
  assert(bogus && !bogus.manage.pin.includes("zz-does-not-exist"), "陌生 id 也不会被写进 manage.json");
  log("opened 成了纯读操作：不置顶、不解归档、不动 manage.json");
  send({ type: "manage", action: "archive", ids: [ids.a], on: false });
  await waitFor("manage", (m) => !m.manage?.archived?.includes(ids.a));

  // 3. A name override must be forgotten together with the file.
  send({ type: "rename", sessionId: ids.a, name: "临时名字" });
  await until(async () => (await list()).find((s) => s.id === ids.a)?.name === "临时名字", 5000, "rename");
  send({ type: "manage", action: "delete", ids: [ids.a] });
  const gone = await waitFor("session.gone");
  assert(gone && gone.ids.includes(ids.a), "session.gone broadcast");
  const binA = path.join(STATE, "trash", `${ids.a}.jsonl`);
  const binIndex = () => JSON.parse(fs.readFileSync(path.join(STATE, "trash.json"), "utf8")).items;
  assert(!fs.existsSync(fileA), "deleted session left the sessions dir");
  assert(fs.existsSync(binA), "payload landed in the bin");
  const recA = binIndex().find((it) => it.id === ids.a);
  assert(recA && recA.file === fileA && recA.size > 0, `bin remembers where it came from (got ${JSON.stringify(recA)})`);
  assert(!(await order()).includes(ids.a), "deleted session left the list");
  const names = JSON.parse(fs.readFileSync(path.join(STATE, "names.json"), "utf8"));
  assert(!names[ids.a], "name override cleaned up");
  assert(!JSON.parse(fs.readFileSync(path.join(STATE, "manage.json"), "utf8")).order.includes(ids.a), "manage.json cleaned up");
  log("delete moved the file to the bin, not into the void");

  // 3b. Restore puts the file back where it came from and the list picks it up again.
  send({ type: "manage", action: "restore", ids: [ids.a] });
  const back = await waitFor("restore.result", (m) => m.restored?.includes(ids.a), 8000);
  assert(back, `restore reported (got ${JSON.stringify(back)})`);
  assert(fs.existsSync(fileA), "restored file is back at its original path");
  assert(!fs.existsSync(binA), "payload left the bin");
  assert(!binIndex().some((it) => it.id === ids.a), "bin index dropped the row");
  assert((await order()).includes(ids.a), "restored session is listed again");
  log("restore undid the delete");

  // 3c. Bin it again, so the restart check below means something.
  send({ type: "manage", action: "delete", ids: [ids.a] });
  await waitFor("session.gone", (m) => m.ids?.includes?.(ids.a), 8000);

  // 4. A live session is released, then binned: being busy is no longer a refusal (D198).
  ws.send(JSON.stringify({ type: "create", cwd: CWD }));
  const created = await waitFor("session", (m) => m.state?.owned === true, 90000);
  assert(created, "live session created");
  const liveId = created.sessionId;
  // pi 要到第一条消息才落盘；先替它把文件写出来，这一条才真的走到「搬文件」。
  const liveRow = await until(
    async () => (await list()).find((s) => s.id === liveId && s.file),
    30000,
    "live session file path",
  );
  const liveFile = liveRow.file;
  const at = new Date().toISOString();
  fs.mkdirSync(path.dirname(liveFile), { recursive: true });
  fs.writeFileSync(
    liveFile,
    [
      { type: "session", version: 3, id: liveId, timestamp: at, cwd: CWD },
      { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "运行中的会话" }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const liveBin = path.join(STATE, "trash", `${liveId}.jsonl`);
  const liveLock = path.join(STATE, "locks", `${liveId}.lock`);
  assert(fs.existsSync(liveLock), "a live web session holds its write lock");
  const result = waitFor("delete.result", () => true, 30000);
  send({ type: "manage", action: "delete", ids: [liveId] });
  const only = await result;
  assert(only?.removed?.includes(liveId), `live delete removed it (got ${JSON.stringify(only)})`);
  assert(only?.released?.includes(liveId), `live delete names what it released (got ${JSON.stringify(only)})`);
  assert(only?.binned?.includes(liveId), `live delete says it reached the bin (got ${JSON.stringify(only)})`);
  assert(!only?.skipped?.length, `nothing skipped (got ${JSON.stringify(only?.skipped)})`);
  assert(fs.existsSync(liveBin) && !fs.existsSync(liveFile), "live payload moved to the bin");
  assert(!fs.existsSync(liveLock), "its write lock was handed back");
  assert(!(await order()).includes(liveId), "live session left the list");
  log("live delete released", only.released.length, "session(s) first, then binned it");

  // 4b. A session pi never wrote a file for (created, nothing said yet) leaves no bin row: there is
  // nothing on disk to keep, and nothing to restore.
  ws.send(JSON.stringify({ type: "create", cwd: CWD }));
  const fresh = await waitFor("session", (m) => m.state?.owned === true && m.sessionId !== liveId, 90000);
  assert(fresh, "fresh live session created");
  const freshId = fresh.sessionId;
  const freshWait = waitFor("delete.result", () => true, 30000);
  send({ type: "manage", action: "delete", ids: [freshId] });
  const freshRes = await freshWait;
  assert(freshRes?.removed?.includes(freshId), `empty live session removed (got ${JSON.stringify(freshRes)})`);
  assert(freshRes?.released?.includes(freshId), "empty live session was released");
  assert(!freshRes?.binned?.includes(freshId), "an empty session is not reported as binned");
  assert(!binIndex().some((it) => it.id === freshId), "no bin row for a session that never hit disk");
  assert(!(await order()).includes(freshId), "empty live session left the list");
  log("empty live delete: released, no bin row");

  // 4c. A terminal's pi still refuses: its pid is not ours, so nothing here can stop it. Both
  // markers count — the write lock another bridge takes, and the tty marker the terminal extension
  // writes (readTtyLock); the file must not move under either one.
  const fileD = mkSession("zz-manage-d", "终端里开着的会话", 1.5);
  await until(async () => (await order()).includes("zz-manage-d"), 15000, "terminal-held session listed");
  const lockD = path.join(STATE, "locks", "zz-manage-d.lock");
  const ttyD = path.join(STATE, "locks", "zz-manage-d.tty.json");
  fs.mkdirSync(path.dirname(lockD), { recursive: true });
  // 测试进程充当「终端里的 pi」：pid 是外来的，而且确实活着。
  fs.writeFileSync(lockD, JSON.stringify({ pid: process.pid, at: Date.now() }));
  fs.writeFileSync(ttyD, JSON.stringify({ pid: process.pid }));
  const held = waitFor("delete.result", () => true, 8000);
  send({ type: "manage", action: "delete", ids: ["zz-manage-d"] });
  const refused = await held;
  assert(
    refused?.skipped?.some((s) => s.id === "zz-manage-d" && s.reason === "终端正在使用"),
    `terminal lock still refuses (got ${JSON.stringify(refused)})`,
  );
  assert(!refused?.removed?.length, "nothing removed while the terminal holds it");
  assert(fs.existsSync(fileD), "a terminal-held file is not moved");
  // discover() 一直把「别人持锁」的文件排除在列表外（`filter((m) => !readLock(m.id))`）：那不是网页
  // 能管的东西。锁一出现它就从列表消失，这里把这条既有语义显式断言下来。
  assert(!(await order()).includes("zz-manage-d"), "a foreign lock hides it from discovery");
  log("terminal-held delete refused:", refused.skipped[0].reason);

  // 4d. Mixed batch: the idle one goes, the terminal-held one comes back as skipped.
  const mixed = waitFor("delete.result", (m) => m.removed?.length > 0, 8000);
  send({ type: "manage", action: "delete", ids: [ids.c, "zz-manage-d"] });
  const report = await mixed;
  assert(report.removed.includes(ids.c), `idle session in the batch deleted (got ${JSON.stringify(report)})`);
  assert(!report.removed.includes("zz-manage-d"), "terminal-held session not deleted");
  const binC = path.join(STATE, "trash", `${ids.c}.jsonl`);
  assert(!fs.existsSync(fileC), "mixed batch moved the idle file out of the sessions dir");
  assert(fs.existsSync(binC), "mixed batch put the idle file in the bin");
  assert(fs.existsSync(fileD), "…and left the terminal-held one where it was");
  log("mixed batch: removed", report.removed.length, "skipped", report.skipped.length);

  // 4e. Once the terminal lets go, the same file goes too — the lock was the only thing holding it.
  fs.unlinkSync(lockD);
  fs.unlinkSync(ttyD);
  const freed = waitFor("delete.result", () => true, 8000);
  send({ type: "manage", action: "delete", ids: ["zz-manage-d"] });
  const freedRes = await freed;
  assert(freedRes.removed.includes("zz-manage-d"), `lock gone → delete goes through (got ${JSON.stringify(freedRes)})`);
  assert(!fs.existsSync(fileD), "released-by-terminal file moved out of the sessions dir");

  // 4f. Purging is the only irreversible step: the payloads are really unlinked.
  const purgeResult = waitFor("purge.result", (m) => m.purged?.length > 0, 8000);
  send({ type: "manage", action: "purge", ids: [] });
  const purged = await purgeResult;
  assert(purged.purged.includes(ids.c) && purged.purged.includes(ids.a), `purge reported ${JSON.stringify(purged)}`);
  assert(purged.purged.includes(liveId) && purged.purged.includes("zz-manage-d"), "purge also took the released + terminal ones");
  assert(!fs.existsSync(binC) && !fs.existsSync(binA) && !fs.existsSync(liveBin), "purged payloads are gone from disk");
  assert(!fs.existsSync(fileC) && !fs.existsSync(fileA), "…and did not come back to the sessions dir");
  assert(binIndex().length === 0, "bin index emptied");
  log("purge destroyed", purged.purged.length, "payloads");

  // 5. Restart: the arrangement is part of the state, not of this process.
  ws.close();
  bridge.kill();
  await sleep(1200);
  startBridge();
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 15000, "passphrase (restart)");
  await connect();
  now = await order();
  assert(now[0] === ids.b, `pinned survived restart (got ${now.map((x) => x.slice(-1)).join("")})`);
  // A live session is released before its file moves, so nothing here can still hold a lock.
  assert(
    !now.includes(ids.a) && !now.includes(ids.c) && !now.includes(liveId) && !now.includes(freshId) && !now.includes("zz-manage-d"),
    "deleted sessions stay deleted after restart",
  );
  assert(JSON.parse(fs.readFileSync(path.join(STATE, "manage.json"), "utf8")).pin[0] === ids.b, "pin still in manage.json");
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
