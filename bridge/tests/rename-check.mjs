/**
 * Probe: sidebar rename (D43).
 *  1. a read-only disk session renames as a label only — its file stays byte-identical (D31)
 *  2. a newer `session_info` written by pi takes the card back from a stale label
 *  3. a live (resumed) session renames through pi — the name lands in the session .jsonl
 *  4. an empty name is rejected
 *
 * Touches the real sessions root for a few seconds and removes what it added.
 * Run: node bridge/tests/rename-check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 7871);
const ROOT = path.join("F:/pi-web-client/.scratch", "rename-probe");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(os.homedir(), ".pi", "agent");
const SESSIONS = path.join(AGENT, "sessions");
const FAKE_DIR = path.join(SESSIONS, "--zz-rename-probe--");
const CWD = "F:/pi-web-client";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(FAKE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(FAKE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};
const old = new Date(Date.now() - 3600_000);

const fakeId = "0199aaaa-0000-4000-8000-000000000001";
const fakeFile = path.join(FAKE_DIR, `2025-01-01T00-00-00-000Z_${fakeId}.jsonl`);
const resumeId = "0199aaaa-0000-4000-8000-000000000002";
const resumeFile = path.join(FAKE_DIR, `2025-02-02T00-00-00-000Z_${resumeId}.jsonl`);

function writeSession(file, id, text) {
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd: CWD }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2025-01-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ].join("\n") + "\n",
  );
  fs.utimesSync(file, old, old); // openLive refuses files touched in the last 20 s
}
writeSession(fakeFile, fakeId, "磁盘里的老会话");
writeSession(resumeFile, resumeId, "可以接管的会话");

const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: CWD,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
const bridgeOut = [];
bridge.stdout.on("data", (b) => bridgeOut.push(b.toString()));
bridge.stderr.on("data", (b) => bridgeOut.push(b.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(150);
  }
  fail(`timeout waiting for ${label}\n${bridgeOut.join("").slice(-2000)}`);
};

try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 10000, "passphrase");
  const BASE = `http://127.0.0.1:${PORT}`;
  await until(
    async () => {
      try {
        return (await fetch(`${BASE}/healthz`)).ok;
      } catch {
        return false;
      }
    },
    15000,
    "bridge up",
  );
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  if (!login.ok) fail(`login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const listNames = async () => {
    const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
    return new Map(sessions.map((s) => [s.id, s.name]));
  };
  const waitName = async (id, want, label, ms = 15000) => {
    let got;
    const ok = await until(async () => {
      got = (await listNames()).get(id);
      return got === want;
    }, ms, label);
    return ok && got;
  };

  // The bridge rescans the sessions root every 5 s.
  await until(async () => (await listNames()).has(fakeId), 20000, "fake session discovered");
  log("discovered read-only session as:", JSON.stringify((await listNames()).get(fakeId)));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    seen.push(m);
    if (m.type === "notice" && m.level === "error") log("bridge error notice:", m.text);
  });
  await new Promise((r) => ws.on("open", r));
  const waitFor = async (pred, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = seen.find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    fail(`timeout waiting for ${label}`);
  };
  const send = (obj) => ws.send(JSON.stringify(obj));

  // ---- 1. read-only: label only, file untouched
  const fakeBefore = fs.readFileSync(fakeFile);
  const fakeMtime = fs.statSync(fakeFile).mtimeMs;
  send({ type: "rename", sessionId: fakeId, name: "磁盘会话改名" });
  await waitFor((m) => m.type === "session.state" && m.session?.id === fakeId && m.session?.name === "磁盘会话改名", 10000, "read-only rename");
  await waitName(fakeId, "磁盘会话改名", "/api/sessions read-only name");
  if (!fs.readFileSync(fakeFile).equals(fakeBefore)) fail("read-only session file changed (D31 violated)");
  if (fs.statSync(fakeFile).mtimeMs !== fakeMtime) fail("read-only session mtime changed");
  log("read-only rename ok, file byte-identical");

  // ---- 2. newest wins: pi writes a newer session_info into the same file
  const newer = new Date(Date.now() + 60000).toISOString(); // later than the label's `at`
  fs.appendFileSync(
    fakeFile,
    JSON.stringify({ type: "session_info", id: "s2", parentId: "m1", timestamp: newer, name: "pi 那边的新名字" }) + "\n",
  );
  await waitName(fakeId, "pi 那边的新名字", "pi-side name wins", 20000);
  log("newer pi-side name took the card back");

  // ---- 3. live resume: pi appends the name to the file
  send({ type: "claim", sessionId: resumeId });
  await waitFor((m) => m.type === "session.state" && m.session?.id === resumeId && m.session?.owned === true, 60000, "claim");
  log("resume session claimed");
  send({ type: "rename", sessionId: resumeId, name: "  续接后的   名字 " });
  await waitFor((m) => m.type === "session.state" && m.session?.id === resumeId && m.session?.name === "续接后的 名字", 20000, "live rename");
  await waitName(resumeId, "续接后的 名字", "/api/sessions live name");
  let inFile = null;
  for (let i = 0; i < 40 && inFile == null; i++) {
    await sleep(150);
    for (const line of fs.readFileSync(resumeFile, "utf8").trim().split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.type === "session_info" && e.name) inFile = e.name;
      } catch {}
    }
  }
  if (inFile !== "续接后的 名字") fail(`session file name = ${JSON.stringify(inFile)}`);
  log("pi appended the name to the session file:", inFile);

  // ---- 4. empty name is rejected
  const before = seen.length;
  send({ type: "rename", sessionId: fakeId, name: "   " });
  await waitFor((m) => m.type === "notice" && m.level === "error" && seen.indexOf(m) >= before, 5000, "empty-name error");
  log("empty name rejected");

  ws.close();
  log("ALL OK");
} finally {
  bridge.kill();
  await sleep(500);
  fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  log("cleaned up", FAKE_DIR);
}
