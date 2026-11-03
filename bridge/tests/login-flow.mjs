/**
 * `/login` / `/logout` from the web (#27): pi's ModelRuntime runs the flow in the bridge, its prompts
 * and events travel over the WebSocket. Fixture agent dir (auth.json there), real pi modules
 * (PI_WEB_PI_PKG), scripted pi for sessions. No real credentials, no network needed.
 *
 *   npm run build:bridge && node bridge/tests/login-flow.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7904;
const ROOT = path.join(REPO, ".scratch", "login-flow");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "sk-test-web-login-0123456789";

delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });

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
const authFile = path.join(AGENT, "auth.json");
const auth = () => (fs.existsSync(authFile) && fs.readFileSync(authFile, "utf8").trim() ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {});

// No ambient keys: the test must see "not configured" before it logs in.
const env = { ...process.env };
for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$/.test(k)) delete env[k];
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    PI_OFFLINE: "1",
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

let ws;
const seen = [];
const raw = [];
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
    raw.push(buf.toString());
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

  // A. provider list
  log("A. providers as pi sees them");
  let mark = seen.length;
  send({ type: "auth.list" });
  let list = await waitFor((m) => m.type === "auth.providers", 20000, "providers", mark);
  const openai = list.providers.find((p) => p.id === "openai");
  check(list.providers.length > 10, `${list.providers.length} providers`);
  check(openai && openai.methods.some((m) => m.type === "api_key") && openai.methods.some((m) => m.type === "oauth"), "openai: API key and OAuth methods");
  check(openai && !openai.configured && !openai.stored, "not configured before login");

  // B. API-key login: secret prompt → answer → stored by pi
  log("B. API key login");
  mark = seen.length;
  send({ type: "auth.login", provider: "openai", method: "api_key" });
  const started = await waitFor((m) => m.type === "auth.started", 10000, "started", mark);
  let prompt = await waitFor((m) => m.type === "auth.prompt" && m.loginId === started.loginId, 10000, "prompt", mark);
  log(`      prompt: ${prompt.prompt.type} — ${prompt.prompt.message}`);
  // Some flows ask more than one thing (e.g. a select first): answer until the secret.
  for (let i = 0; i < 4 && prompt.prompt.type !== "secret" && prompt.prompt.type !== "text"; i++) {
    const m2 = seen.length;
    send({ type: "auth.answer", loginId: started.loginId, promptId: prompt.promptId, value: prompt.prompt.options?.[0]?.id ?? "" });
    prompt = await waitFor((m) => m.type === "auth.prompt" && m.loginId === started.loginId, 10000, "next prompt", m2);
  }
  check(prompt.prompt.type === "secret", `key asked as a secret prompt (${prompt.prompt.type})`);
  send({ type: "auth.answer", loginId: started.loginId, promptId: prompt.promptId, value: SECRET });
  const done = await waitFor((m) => m.type === "auth.done" && m.loginId === started.loginId, 15000, "done", mark);
  check(done.ok === true, `login finished (${done.error ?? "ok"})`);
  check(auth().openai?.type === "api_key" && auth().openai?.key === SECRET, "pi stored the key in <agentDir>/auth.json");
  list = await waitFor((m) => m.type === "auth.providers" && seen.indexOf(m) > seen.indexOf(done), 10000, "providers after", mark);
  check(list.providers.find((p) => p.id === "openai")?.stored === "api_key", "list shows it stored (type only)");
  await waitFor((m) => m.type === "catalog" && seen.indexOf(m) > seen.indexOf(done), 20000, "catalog refresh", mark);
  check(true, "model catalog re-broadcast after login");
  check(!raw.some((r) => r.includes(SECRET)), "the key never went back to a page");

  // C. cancel
  log("C. cancel a login at its prompt");
  mark = seen.length;
  send({ type: "auth.login", provider: "anthropic", method: "api_key" });
  const s2 = await waitFor((m) => m.type === "auth.started", 10000, "started 2", mark);
  const p2 = await waitFor((m) => m.type === "auth.prompt" && m.loginId === s2.loginId, 10000, "prompt 2", mark);
  send({ type: "auth.answer", loginId: s2.loginId, promptId: p2.promptId, value: null });
  const d2 = await waitFor((m) => m.type === "auth.done" && m.loginId === s2.loginId, 10000, "done 2", mark);
  check(d2.ok === false && d2.error === "已取消" && !auth().anthropic, `cancelled, nothing stored (${JSON.stringify(d2)})`);

  // D. OAuth: the flow's own URL / prompt reaches the page; cancel leaves nothing behind
  log("D. OAuth flow events are relayed");
  mark = seen.length;
  send({ type: "auth.login", provider: "anthropic", method: "oauth" });
  const s3 = await waitFor((m) => m.type === "auth.started", 10000, "started 3", mark);
  const first = await waitFor((m) => (m.type === "auth.event" || m.type === "auth.prompt") && m.loginId === s3.loginId, 15000, "oauth event", mark);
  log(`      first: ${first.type} ${JSON.stringify(first.event ?? first.prompt).slice(0, 120)}`);
  if (first.type === "auth.prompt" && first.prompt.type === "select") {
    // Anthropic asks browser vs. manual first: take the browser flow, which must hand us a URL.
    send({ type: "auth.answer", loginId: s3.loginId, promptId: first.promptId, value: first.prompt.options[0].id });
    await waitFor((m) => m.type === "auth.event" && m.loginId === s3.loginId && m.event?.type === "auth_url", 15000, "auth_url", mark);
  }
  const url = seen.slice(mark).find((m) => m.type === "auth.event" && m.event?.type === "auth_url");
  log(`      auth_url: ${String(url?.event?.url ?? "").slice(0, 80)}…`);
  check(Boolean(url) && /^https:\/\//.test(url.event.url), "the provider's authorization URL reached the page");
  send({ type: "auth.cancel", loginId: s3.loginId });
  const d3 = await waitFor((m) => m.type === "auth.done" && m.loginId === s3.loginId, 15000, "done 3", mark);
  check(d3.ok === false && !auth().anthropic, "cancelled OAuth stores nothing");

  // E. logout
  log("E. logout");
  mark = seen.length;
  send({ type: "auth.logout", provider: "openai" });
  list = await waitFor((m) => m.type === "auth.providers", 10000, "providers after logout", mark);
  check(!auth().openai && !list.providers.find((p) => p.id === "openai")?.stored, "credential removed from auth.json");
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
