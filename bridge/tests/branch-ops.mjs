/**
 * Tree / fork / clone / import / export against the REAL pi (no model call: pi only reads and
 * writes session files here) — issues #17 #24.
 *
 *  A. tree    user messages of a two-branch file, nested, the resumed branch marked current
 *  B. fork    before a message on the current branch → new file with the history before it,
 *             the message text handed back; the source file is byte-for-byte unchanged
 *  C. fork    before a message on the abandoned branch (not in pi's get_fork_messages list)
 *  D. clone   the current branch, whole, into a new session
 *  E. import  a .jsonl from elsewhere is copied into the sessions folder for its cwd
 *  F. export  /api/export html (pi --export) and jsonl, /api/log 404 for a never-live session
 *
 * Needs a built bridge and pi installed: `npm run build:bridge && node bridge/tests/branch-ops.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7899;
const ROOT = path.join(REPO, ".scratch", "branch-ops");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });

const encode = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const DIR = path.join(AGENT, "sessions", encode(REPO));
fs.mkdirSync(DIR, { recursive: true });
const ID = "0190aaaa-0000-7000-8000-000000000001";
const file = path.join(DIR, `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
const t = (n) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const user = (id, parentId, text, n) => ({ type: "message", id, parentId, timestamp: t(n), message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(t(n)) } });
const asst = (id, parentId, text, n) => ({
  type: "message",
  id,
  parentId,
  timestamp: t(n),
  message: { role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(t(n)) },
});
const rows = [
  { type: "session", version: 3, id: ID, timestamp: t(0), cwd: REPO },
  user("u1", null, "first question", 1),
  asst("a1", "u1", "first answer", 2),
  user("u2", "a1", "abandoned question", 3),
  asst("a2", "u2", "abandoned answer", 4),
  user("u3", "a1", "second question", 5),
  asst("a3", "u3", "second answer", 6),
  user("u4", "a3", "third question", 7),
  asst("a4", "u4", "third answer", 8),
];
fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const old = new Date(Date.now() - 3600_000);
fs.utimesSync(file, old, old);
const sourceBytes = fs.readFileSync(file);

// A session file somewhere else, for /import.
const outside = path.join(ROOT, "outside");
fs.mkdirSync(outside, { recursive: true });
const IMPORT_ID = "0190bbbb-0000-7000-8000-000000000002";
const importFile = path.join(outside, `exported_${IMPORT_ID}.jsonl`);
fs.writeFileSync(importFile, [{ type: "session", version: 3, id: IMPORT_ID, timestamp: t(0), cwd: REPO }, user("x1", null, "imported hello", 1)].map((r) => JSON.stringify(r)).join("\n") + "\n");

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
const readRows = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const userTexts = (f) => readRows(f).filter((r) => r.type === "message" && r.message.role === "user").map((r) => r.message.content[0].text);

const bridgeOut = [];
const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT };
delete env.PI_BIN;
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

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
const seen = [];
const waits = [];
const waitFor = (pred, ms, what, from = 0) => {
  const hit = seen.slice(from).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    w.timer = setTimeout(() => {
      waits.splice(waits.indexOf(w), 1);
      reject(new Error(`timeout: ${what}`));
    }, ms);
    waits.push(w);
  });
};
const send = (m) => ws.send(JSON.stringify(m));

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    for (const w of [...waits]) {
      if (w.pred(m)) {
        waits.splice(waits.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  await new Promise((r) => ws.on("open", r));
  await waitFor((m) => m.type === "hello", 5000, "hello");

  // A. tree
  log("A. tree");
  send({ type: "tree", sessionId: ID });
  const tree = await waitFor((m) => m.type === "tree" && m.sessionId === ID, 5000, "tree");
  const byId = Object.fromEntries(tree.nodes.map((n) => [n.id, n]));
  check(tree.nodes.length === 4, `four user messages (${tree.nodes.length})`);
  check(byId.u2.parent === "u1" && byId.u3.parent === "u1" && byId.u4.parent === "u3", "nested by nearest user ancestor");
  check(byId.u1.current && byId.u3.current && byId.u4.current && !byId.u2.current, "resumed branch marked current, abandoned one not");

  // B. fork on the current branch
  log("B. fork before 'third question' (current branch)");
  let mark = seen.length;
  send({ type: "fork", sessionId: ID, entryId: "u4" });
  let res = await waitFor((m) => m.type === "branch.result" && m.from === ID, 60000, "fork result", mark);
  check(!res.error, `no error (${res.error ?? ""})`);
  check(res.text === "third question", `message text handed back (${JSON.stringify(res.text)})`);
  let newFile = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => readRows(f)[0].id === res.sessionId);
  check(newFile && JSON.stringify(userTexts(newFile)) === JSON.stringify(["first question", "second question"]), `new file = history before it (${newFile && JSON.stringify(userTexts(newFile))})`);
  check(newFile && readRows(newFile)[0].parentSession && path.resolve(readRows(newFile)[0].parentSession) === path.resolve(file), "new header points at the source (parentSession)");
  check(Buffer.compare(fs.readFileSync(file), sourceBytes) === 0, "source file untouched");

  // C. fork on the abandoned branch
  log("C. fork on the abandoned branch, and by position for a live bubble");
  mark = seen.length;
  send({ type: "fork", sessionId: ID, entryId: "u2" });
  res = await waitFor((m) => m.type === "branch.result" && m.from === ID, 60000, "fork result 2", mark);
  newFile = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => readRows(f)[0].id === res.sessionId);
  check(!res.error && res.text === "abandoned question" && newFile && JSON.stringify(userTexts(newFile)) === JSON.stringify(["first question"]), `fork point off the resumed branch (${res.error ?? JSON.stringify(newFile && userTexts(newFile))})`);

  // A live bubble has a bridge id ("user:N"): the bridge finds it by position + text.
  mark = seen.length;
  send({ type: "fork", sessionId: ID, entryId: "user:9", index: 1, text: "second question" });
  res = await waitFor((m) => m.type === "branch.result" && m.from === ID, 60000, "fork by index", mark);
  newFile = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => readRows(f)[0].id === res.sessionId);
  check(!res.error && res.text === "second question" && newFile && JSON.stringify(userTexts(newFile)) === JSON.stringify(["first question"]), `fork by index + text (${res.error ?? ""})`);

  // D. clone
  log("D. clone");
  mark = seen.length;
  send({ type: "clone", sessionId: ID });
  res = await waitFor((m) => m.type === "branch.result" && m.from === ID, 60000, "clone result", mark);
  newFile = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => readRows(f)[0].id === res.sessionId);
  check(!res.error && newFile && JSON.stringify(userTexts(newFile)) === JSON.stringify(["first question", "second question", "third question"]), `clone = current branch only (${res.error ?? JSON.stringify(newFile && userTexts(newFile))})`);
  const listed = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
  check(listed.sessions.some((x) => x.id === res.sessionId), "the clone is on the session list");

  // E. import
  log("E. import");
  mark = seen.length;
  send({ type: "import", path: importFile });
  const imp = await waitFor((m) => m.type === "import.result", 10000, "import", mark);
  check(imp.sessionId === IMPORT_ID && fs.existsSync(path.join(DIR, path.basename(importFile))), `copied into the folder for its cwd (${imp.error ?? ""})`);
  check(fs.existsSync(importFile), "the original stays where it was");
  mark = seen.length;
  send({ type: "import", path: importFile });
  const again = await waitFor((m) => m.type === "import.result", 10000, "import again", mark);
  check(/已经在列表里/.test(again.error ?? ""), "importing the same session twice is refused");

  // F. export / log
  log("F. export");
  const html = await fetch(`${BASE}/api/export?id=${ID}`, { headers: { cookie } });
  const body = await html.text();
  check(html.ok && /text\/html/.test(html.headers.get("content-type") ?? "") && body.includes("<title>Session Export"), `HTML export (${html.status}, ${body.length} bytes)`);
  const jsonl = await fetch(`${BASE}/api/export?id=${ID}&format=jsonl`, { headers: { cookie } });
  check(jsonl.ok && Buffer.compare(Buffer.from(await jsonl.arrayBuffer()), sourceBytes) === 0 && /attachment/.test(jsonl.headers.get("content-disposition") ?? ""), "JSONL download = the file");
  const nolog = await fetch(`${BASE}/api/log?id=${ID}`, { headers: { cookie } });
  check(nolog.status === 404, "no pi log for a never-live session → 404");
  const anon = await fetch(`${BASE}/api/export?id=${ID}`);
  check(anon.status === 401, "export needs the login cookie");

  // G. `@` file search and the `/` command list (#25)
  log("G. @ files / commands");
  const found = await (await fetch(`${BASE}/api/files?id=${ID}&q=chat.ts`, { headers: { cookie } })).json();
  check(found.files?.[0] === "web/src/chat.ts", `@chat.ts → web/src/chat.ts first (${JSON.stringify(found.files?.slice(0, 3))})`);
  const fuzzy = await (await fetch(`${BASE}/api/files?id=${ID}&q=brtstbrops`, { headers: { cookie } })).json();
  check(fuzzy.files?.includes("bridge/tests/branch-ops.mjs"), `subsequence match (${JSON.stringify(fuzzy.files?.slice(0, 3))})`);
  check(!(found.files ?? []).some((f) => f.startsWith("node_modules/")), "ignored folders stay out");
  mark = seen.length;
  send({ type: "commands", sessionId: ID });
  const cmds = await waitFor((m) => m.type === "commands" && m.sessionId === ID, 10000, "commands", mark);
  check(Array.isArray(cmds.commands), `commands list for a read-only session (${cmds.commands?.length ?? "?"} from disk)`);
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
