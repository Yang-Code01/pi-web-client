/**
 * pi settings / project trust / launch options / runtime settings / reload — issues #26 #21 #28.
 *
 * A scripted pi (fixtures/fake-pi.mjs) records its argv and the runtime commands it gets; pi's own
 * settings-manager and trust-manager modules (from the installed pi, PI_WEB_PI_PKG) do the file work
 * against a fixture agent dir, so nothing under the real ~/.pi/agent is touched.
 *
 *   npm run build:bridge && node bridge/tests/settings-trust.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7902;
const ROOT = path.join(REPO, ".scratch", "settings-trust");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PROJECT = path.join(ROOT, "project");
const PI_LOG = path.join(ROOT, "fake-pi.jsonl");
const BASE = `http://127.0.0.1:${PORT}`;

// The real pi package, for its settings / trust modules.
delete process.env.PI_BIN;
const { resolvePi } = await import("../dist/pi.js");
const realPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(PROJECT, ".pi"), { recursive: true });
fs.writeFileSync(path.join(PROJECT, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }, null, 2));

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
const piLog = () => (fs.existsSync(PI_LOG) ? fs.readFileSync(PI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PI_WEB_PORT: String(PORT),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
    PI_WEB_PI_PKG: realPkg,
    FAKE_PI_LOG: PI_LOG,
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
const ask = async (m, pred, what) => {
  const mark = seen.length;
  send(m);
  return waitFor(pred, 10000, what, mark);
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
    if (m.type === "notice") log("notice:", m.level, m.text);
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
  const globalFile = path.join(AGENT, "settings.json");

  // ------------------------------------------------------------------ A. global settings (#26)
  log("A. global settings: patch merges under pi's lock, null removes, raw replaces");
  let v = await ask({ type: "settings.get", scope: "global" }, (m) => m.type === "settings" && m.scope === "global", "get");
  check(v.exists === false && v.path === globalFile && v.writable, "no file yet; path is <agentDir>/settings.json");
  v = await ask({ type: "settings.set", scope: "global", patch: { "compaction.enabled": false, steeringMode: "all", enabledModels: ["claude-*"] } }, (m) => m.type === "settings" && m.saved, "set");
  check(JSON.stringify(readJson(globalFile)) === JSON.stringify({ compaction: { enabled: false }, steeringMode: "all", enabledModels: ["claude-*"] }), `file written (${fs.readFileSync(globalFile, "utf8").replace(/\s+/g, "")})`);
  // Someone else (a terminal pi, a hand edit) changes the file in between.
  fs.writeFileSync(globalFile, JSON.stringify({ ...readJson(globalFile), theme: "dark", compaction: { enabled: false, keepRecentTokens: 1000 } }, null, 2));
  await ask({ type: "settings.set", scope: "global", patch: { "compaction.enabled": null, "compaction.keepRecentTokens": null } }, (m) => m.type === "settings" && m.saved, "remove");
  const after = readJson(globalFile);
  check(after.theme === "dark" && !("compaction" in after) && after.steeringMode === "all", `untouched keys kept, emptied object pruned (${JSON.stringify(after)})`);
  const bad = await ask({ type: "settings.set", scope: "global", raw: "{ nope" }, (m) => m.type === "settings.error", "bad raw");
  check(/不是合法的 JSON/.test(bad.message) && readJson(globalFile).theme === "dark", "invalid JSON refused, file unchanged");
  await ask({ type: "settings.set", scope: "global", raw: JSON.stringify({ defaultProjectTrust: "never", theme: "dark" }) }, (m) => m.type === "settings" && m.saved, "raw");
  check(JSON.stringify(readJson(globalFile)) === JSON.stringify({ defaultProjectTrust: "never", theme: "dark" }), "raw replaces the whole file");
  const proto = await ask({ type: "settings.set", scope: "global", patch: { "__proto__.polluted": 1 } }, (m) => m.type === "settings" && m.saved, "proto");
  check(proto && !("polluted" in {}) && !JSON.stringify(readJson(globalFile)).includes("polluted"), "__proto__ keys ignored");

  // ------------------------------------------------------------------ B. project trust (#21)
  log("B. project trust");
  let t = await ask({ type: "trust.get", cwd: PROJECT }, (m) => m.type === "trust" && m.cwd === PROJECT, "trust.get");
  check(t.trust.needed && !t.trust.saved && t.trust.fallback === "never" && t.trust.effective === false, `undecided project with .pi/settings.json → not loaded (${JSON.stringify(t.trust)})`);
  check(t.trust.options[0].label === "Trust" && t.trust.options.some((o) => o.label === "Do not trust"), "options are pi's own /trust options");
  const refused = await ask({ type: "settings.set", scope: "project", cwd: PROJECT, patch: { defaultThinkingLevel: "high" } }, (m) => m.type === "settings.error", "untrusted write");
  check(/没有被信任/.test(refused.message) && readJson(path.join(PROJECT, ".pi", "settings.json")).defaultThinkingLevel === "low", "untrusted project settings are not written (like pi)");
  t = await ask({ type: "trust.set", cwd: PROJECT, option: 0 }, (m) => m.type === "trust" && m.saved, "trust.set");
  const trustFile = path.join(AGENT, "trust.json");
  check(t.trust.effective && t.trust.saved?.decision === true && fs.existsSync(trustFile) && fs.readFileSync(trustFile, "utf8").includes("true"), `decision saved in <agentDir>/trust.json (${fs.existsSync(trustFile) ? fs.readFileSync(trustFile, "utf8").replace(/\s+/g, "") : "missing"})`);
  await ask({ type: "settings.set", scope: "project", cwd: PROJECT, patch: { defaultThinkingLevel: "high" } }, (m) => m.type === "settings" && m.saved && m.scope === "project", "trusted write");
  check(readJson(path.join(PROJECT, ".pi", "settings.json")).defaultThinkingLevel === "high", "trusted project settings written");

  // ------------------------------------------------------------------ C. launch options (#28)
  log("C. launch options reach pi's argv, survive /reload, bad ones are refused");
  const badCreate = await ask({ type: "create", cwd: PROJECT, options: { tools: "read,-write" } }, (m) => m.type === "notice" && m.level === "error", "bad options");
  check(/不能把普通名字和/.test(badCreate.text), "mixed tool list refused before spawning");
  const options = { model: "stub/fake-model", thinking: "high", tools: "read,grep", extensions: ["extra.ts"], appendSystemPrompt: "be brief", noContextFiles: true, offline: true, noMcp: true };
  const created = await ask({ type: "create", cwd: PROJECT, name: "launch", options }, (m) => m.type === "session" && m.sessionId, "create");
  const sid = created.sessionId;
  check(/模型 stub\/fake-model/.test(created.state.launch ?? "") && /离线/.test(created.state.launch ?? ""), `state.launch summary (${created.state.launch})`);
  check(created.trust?.effective === true, "session snapshot carries the trust state");
  const argvOf = () => piLog().filter((e) => e.t === "argv" && e.argv.includes("--mode") && (e.argv.includes(sid) || e.argv.some((a) => a.includes(sid))));
  await until(() => argvOf().length >= 1, 5000, "argv");
  const want = ["--model", "stub/fake-model", "--thinking", "high", "--tools", "read,grep", "--extension", "extra.ts", "--append-system-prompt", "be brief", "--no-context-files", "--no-mcp", "--offline"];
  const has = (argv) => want.every((w, i) => (i % 2 === 0 && want[i + 1] && !want[i + 1].startsWith("--") ? argv[argv.indexOf(w) + 1] === want[i + 1] : argv.includes(w)));
  check(has(argvOf()[0].argv), `flags on the first start (${JSON.stringify(argvOf()[0].argv)})`);
  check(argvOf()[0].argv.includes("-e"), "approval gate still loaded");

  // ------------------------------------------------------------------ D. runtime settings + reload (#26)
  log("D. runtime settings and /reload");
  const markD = seen.length;
  send({ type: "runtime", sessionId: sid, steeringMode: "all", followUpMode: "one-at-a-time", autoCompaction: false, autoRetry: true });
  await waitFor((m) => m.type === "notice" && /已应用到当前会话/.test(m.text), 5000, "runtime applied", markD);
  const rt = piLog();
  check(
    rt.some((e) => e.t === "set_steering_mode" && e.mode === "all") &&
      rt.some((e) => e.t === "set_follow_up_mode" && e.mode === "one-at-a-time") &&
      rt.some((e) => e.t === "set_auto_compaction" && e.enabled === false) &&
      rt.some((e) => e.t === "set_auto_retry" && e.enabled === true),
    "set_steering_mode / set_follow_up_mode / set_auto_compaction / set_auto_retry reached pi",
  );
  await ask({ type: "reload", sessionId: sid }, (m) => m.type === "notice" && /已重新加载/.test(m.text), "reload");
  await until(() => argvOf().length >= 2, 8000, "second start");
  check(has(argvOf()[1].argv), "same flags after /reload (restart of this session's pi)");
  const resumed = argvOf()[1].argv;
  // No file yet (nothing was said): pi reopens by the same id; with a file it gets --session <file>.
  check(resumed.includes("--session") || resumed[resumed.indexOf("--session-id") + 1] === sid, "reload reopens the same session");

  // ------------------------------------------------------------------ E. changelog
  const cl = await (await fetch(`${BASE}/api/changelog`, { headers: { cookie } })).json();
  check(typeof cl.text === "string", `changelog endpoint answers (${cl.text.length} chars)`);
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
