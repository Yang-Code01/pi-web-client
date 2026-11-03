/**
 * `/share` and `/bug` from the web (#38). Real pi (export, bug-report modules), a stand-in GitHub
 * CLI (fixtures/fake-gh.mjs via PI_WEB_GH_JS), a fixture agent dir, offline: nothing leaves the
 * machine.
 *
 *   npm run build:bridge && node bridge/tests/share-bug.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7909;
const ROOT = path.join(REPO, ".scratch", "share-bug");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const GH_STATE = path.join(ROOT, "gh-state.json");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
const ID = "0190abcd-0000-7000-8000-000000000007";
const file = path.join(AGENT, "sessions", "--fixture--", `2026-01-01T00-00-00-000Z_${ID}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });
const t = new Date(Date.now() - 3600_000).toISOString();
fs.writeFileSync(
  file,
  [
    { type: "session", version: 3, id: ID, timestamp: t, cwd: REPO },
    { type: "message", id: "u1", parentId: null, timestamp: t, message: { role: "user", content: [{ type: "text", text: "the secret word is PELICAN" }], timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: t, message: { role: "assistant", content: [], provider: "openai", model: "gpt-5", api: "openai-responses", stopReason: "error", errorMessage: "429 rate limit", timestamp: 2 } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
const old = new Date(Date.now() - 3600_000);
fs.utimesSync(file, old, old);

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

const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_OFFLINE: "1", PI_WEB_GH_JS: path.join(REPO, "bridge", "tests", "fixtures", "fake-gh.mjs"), FAKE_GH_STATE: GH_STATE };
delete env.PI_BIN;
delete env.PI_SHARE_VIEWER_URL;
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
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
const ask = async (m, type, what) => {
  const mark = seen.length;
  ws.send(JSON.stringify(m));
  return waitFor((x) => x.type === type, 60000, what, mark);
};

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

  log("A. /share");
  let d = await ask({ type: "share", sessionId: ID }, "share.done", "share gist");
  check(!d.error && d.via === "gist" && d.url === "https://pi.dev/session/#0123abcd" && d.gistUrl === "https://gist.github.com/someone/0123abcd", `no Radius login → private gist, pi's viewer URL (${d.error ?? d.url})`);
  const up = JSON.parse(fs.readFileSync(GH_STATE, "utf8"));
  check(up.args.includes("--public=false") && /Session Export/.test(up.uploaded), "gh got pi's HTML export, as a private gist");
  check(seen.some((m) => m.type === "share.progress" && /导出 HTML/.test(m.text)), "progress reached the page");
  fs.writeFileSync(GH_STATE, "logged-out");
  d = await ask({ type: "share", sessionId: ID }, "share.done", "gh logged out");
  check(/gh auth login/.test(d.error ?? ""), `gh not logged in → says how to fix (${d.error})`);
  fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify({ sessionShareDestination: "radius" }));
  d = await ask({ type: "share", sessionId: ID }, "share.done", "radius required");
  check(/Radius/.test(d.error ?? "") && /登录/.test(d.error ?? ""), `destination radius without a Radius login → refused (${d.error})`);
  fs.rmSync(path.join(AGENT, "settings.json"));

  log("B. /bug");
  d = await ask({ type: "bug", sessionId: ID, hint: "网页测试", includeSession: true, delivery: "zip" }, "bug.done", "bug zip");
  check(!d.error && d.delivery === "zip" && /^\/api\/bugzip\?name=pi-bug-report-/.test(d.download ?? ""), `zip written (${d.error ?? d.download})`);
  const zip = await fetch(`${BASE}${d.download}`, { headers: { cookie } });
  const bytes = Buffer.from(await zip.arrayBuffer());
  check(zip.ok && bytes.subarray(0, 2).toString() === "PK" && bytes.includes(Buffer.from("session.jsonl")) && bytes.includes(Buffer.from("report.json")), `downloadable zip with report.json + session.jsonl (${bytes.length} bytes)`);
  d = await ask({ type: "bug", sessionId: ID, hint: "x", includeSession: false, delivery: "zip" }, "bug.done", "bug zip no session");
  const bytes2 = Buffer.from(await (await fetch(`${BASE}${d.download}`, { headers: { cookie } })).arrayBuffer());
  check(!bytes2.includes(Buffer.from("session.jsonl")) && !bytes2.includes(Buffer.from("PELICAN")), "without the transcript: no session.jsonl, conversation text absent");
  d = await ask({ type: "bug", sessionId: ID, includeSession: false, delivery: "upload" }, "bug.done", "bug upload offline");
  check(/离线/.test(d.error ?? ""), `upload refused offline (${d.error})`);
  const bad = await fetch(`${BASE}/api/bugzip?name=..%2F..%2Fpassphrase.txt`, { headers: { cookie } });
  check(bad.status === 404, "bugzip only serves report archives");
  const anon = await fetch(`${BASE}${d.download ?? "/api/bugzip?name=x"}`);
  check(anon.status === 401 || anon.status === 404, "needs the login cookie");
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
