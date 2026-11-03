/**
 * Terminal ↔ web session lock (#30).
 *
 *  A. The terminal-side extension (bridge/ext/session-lock.ts, driven directly): it registers the
 *     session a terminal pi has open, releases it, warns before opening one the web is writing, and
 *     does nothing inside the web's own pi children.
 *  B. The bridge honours that registration: 「终端占用」 on the list, takeover refused with a reason,
 *     allowed again once the terminal lets go; 安装 / 移除 edits pi's global `extensions`.
 *
 *   npm run build:bridge && node bridge/tests/session-lock.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
// A pid that is alive and is not this process: our parent shell.
const OTHER = process.ppid;

// ------------------------------------------------------------------ A. the extension itself
log("A. terminal-side extension");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-lock-"));
  const locks = path.join(tmp, "locks");
  const ext = path.join(tmp, "session-lock.ts");
  fs.writeFileSync(ext, fs.readFileSync(path.join(REPO, "bridge", "ext", "session-lock.ts"), "utf8").replace('"__LOCK_DIR__"', JSON.stringify(locks)));
  const { default: sessionLock } = await import(pathToFileURL(ext).href);
  const load = () => {
    const handlers = {};
    sessionLock({ on: (ev, fn) => (handlers[ev] = fn) });
    return handlers;
  };
  const ctx = (id, pick) => {
    const c = { cwd: tmp, hasUI: true, quit: false, asked: null };
    c.sessionManager = { getSessionId: () => id };
    c.ui = { select: async (title) => ((c.asked = title), pick) };
    c.shutdown = () => (c.quit = true);
    return c;
  };
  const delete_env = process.env.PI_WEB_ALLOW_FILE;
  delete process.env.PI_WEB_ALLOW_FILE;
  let h = load();
  await h.session_start({ reason: "startup" }, ctx("s1"));
  const tty = path.join(locks, "s1.tty.json");
  check(fs.existsSync(tty) && JSON.parse(fs.readFileSync(tty, "utf8")).pid === process.pid, "open session registered with this pid");
  await h.session_start({ reason: "new" }, ctx("s2"));
  check(!fs.existsSync(tty) && fs.existsSync(path.join(locks, "s2.tty.json")), "switching sessions moves the registration");
  await h.session_shutdown({ reason: "quit" }, ctx("s2"));
  check(!fs.existsSync(path.join(locks, "s2.tty.json")), "released on shutdown");

  fs.writeFileSync(path.join(locks, "s3.lock"), JSON.stringify({ pid: OTHER, at: Date.now() }));
  const c3 = ctx("s3", "退出 pi");
  await h.session_start({ reason: "resume" }, c3);
  check(Boolean(c3.asked) && c3.quit && !fs.existsSync(path.join(locks, "s3.tty.json")), "a session the web is writing: asks, quits, registers nothing");
  const c4 = ctx("s3", "仍然打开（会分叉）");
  await h.session_start({ reason: "resume" }, c4);
  check(!c4.quit && fs.existsSync(path.join(locks, "s3.tty.json")), "…or opens it anyway when the user insists");
  await h.session_shutdown({ reason: "quit" }, c4);

  process.env.PI_WEB_ALLOW_FILE = "x";
  h = load();
  check(!h.session_start, "inside the web's own pi children it registers nothing");
  if (delete_env === undefined) delete process.env.PI_WEB_ALLOW_FILE;
  else process.env.PI_WEB_ALLOW_FILE = delete_env;
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ B. the bridge side
log("B. bridge honours it");
const PORT = 7906;
const ROOT = path.join(REPO, ".scratch", "session-lock");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(STATE, "locks"), { recursive: true });
const ID = "zz-lock-session";
const file = path.join(AGENT, "sessions", "--fixture--", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const old = new Date(Date.now() - 3600_000);
fs.writeFileSync(
  file,
  [
    { type: "session", version: 3, id: ID, timestamp: old.toISOString(), cwd: REPO },
    { type: "message", id: "u1", parentId: null, timestamp: old.toISOString(), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
fs.utimesSync(file, old, old);
const ttyLock = path.join(STATE, "locks", `${ID}.tty.json`);
fs.writeFileSync(ttyLock, JSON.stringify({ pid: OTHER, at: Date.now() }));

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"), PI_WEB_PI_PKG: realPkg },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));
const until = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
};
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

  const row = async () => (await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json()).sessions.find((s) => s.id === ID);
  check((await row())?.locked === true, "listed as 「终端占用」 while the terminal holds it");
  let mark = seen.length;
  send({ type: "claim", sessionId: ID });
  const refused = await waitFor((m) => m.type === "notice" && m.level === "error", 5000, "refused", mark);
  check(/终端里的 pi（PID \d+）正开着这个会话/.test(refused.text), `takeover refused with the reason (${refused.text})`);
  fs.rmSync(ttyLock);
  check((await row())?.locked !== true, "free again once the terminal lets go");
  // A stale registration (dead pid) is pruned, not obeyed.
  fs.writeFileSync(ttyLock, JSON.stringify({ pid: 999999, at: Date.now() }));
  check((await row())?.locked !== true && !fs.existsSync(ttyLock), "a dead terminal's registration is pruned");
  mark = seen.length;
  send({ type: "claim", sessionId: ID });
  const claimed = await waitFor((m) => m.type === "session" && m.sessionId === ID && m.state?.owned, 10000, "claimed", mark);
  check(Boolean(claimed), "takeover works afterwards");
  // install / remove in pi's global settings
  const settings = path.join(AGENT, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ extensions: ["/other/ext.ts"], theme: "dark" }, null, 2));
  mark = seen.length;
  send({ type: "lockext.set", on: true });
  const on = await waitFor((m) => m.type === "lockext" && m.saved, 10000, "installed", mark);
  const extFile = path.join(STATE, "ext", "session-lock.ts");
  const s1 = JSON.parse(fs.readFileSync(settings, "utf8"));
  check(on.installed && s1.extensions.length === 2 && s1.extensions.includes("/other/ext.ts") && s1.theme === "dark", `added to extensions, rest kept (${JSON.stringify(s1)})`);
  check(fs.readFileSync(extFile, "utf8").includes(JSON.stringify(path.join(STATE, "locks"))), "installed copy points at this bridge's lock dir");
  mark = seen.length;
  send({ type: "lockext.set", on: false });
  const off = await waitFor((m) => m.type === "lockext" && m.saved, 10000, "removed", mark);
  const s2 = JSON.parse(fs.readFileSync(settings, "utf8"));
  check(!off.installed && JSON.stringify(s2.extensions) === JSON.stringify(["/other/ext.ts"]) && !fs.existsSync(extFile), "removed again, other extensions untouched");
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
