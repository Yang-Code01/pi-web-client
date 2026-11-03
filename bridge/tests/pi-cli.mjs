/**
 * pi's package / MCP subcommands from the web (#33): the real pi CLI, run by the bridge, against a
 * fixture agent dir (PI_CODING_AGENT_DIR) so nothing in the real ~/.pi/agent changes.
 *
 *   npm run build:bridge && node bridge/tests/pi-cli.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7907;
const ROOT = path.join(REPO, ".scratch", "pi-cli");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PKG = path.join(ROOT, "demo-pkg");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(PKG, "extensions"), { recursive: true });
fs.writeFileSync(path.join(PKG, "package.json"), JSON.stringify({ name: "demo-pkg", version: "1.0.0", keywords: ["pi-package"] }));
fs.writeFileSync(path.join(PKG, "extensions", "x.ts"), "export default function () {}\n");

// The parsers, without a bridge.
const { buildArgs, parsePackages } = await import("../dist/picli.js");

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

log("A. argv is built, not passed through");
check(JSON.stringify(buildArgs({ op: "pkg.install", source: "npm:foo", local: true }).args) === JSON.stringify(["install", "npm:foo", "--local"]), "install argv");
check(JSON.stringify(buildArgs({ op: "mcp.add", name: "gh", command: "npx", args: ["-y", "srv"], env: ["A=1"] }).args) === JSON.stringify(["mcp", "add", "gh", "--env", "A=1", "--", "npx", "-y", "srv"]), "mcp add argv (stdio)");
let threw = 0;
for (const bad of [{ op: "mcp.add", name: "a b", command: "x" }, { op: "pkg.install", source: "x\n--evil" }, { op: "mcp.add", name: "a", url: "file:///etc" }, { op: "rm -rf" }]) {
  try {
    buildArgs(bad);
  } catch {
    threw++;
  }
}
check(threw === 4, "bad names / newlines / non-http URLs / unknown ops refused");
check(JSON.stringify(parsePackages("User packages:\n  npm:a\n    C:\\x\\a\n  ..\\pkg\n    C:\\pkg\nProject packages:\n  npm:b\n")) === JSON.stringify([{ scope: "user", source: "npm:a", path: "C:\\x\\a" }, { scope: "user", source: "..\\pkg", path: "C:\\pkg" }, { scope: "project", source: "npm:b", path: null }]), "pi list parsed");

delete process.env.PI_BIN;
const bridgeOut = [];
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT, PI_OFFLINE: "1" },
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
const run = async (req, what, ms = 120000) => {
  const mark = seen.length;
  ws.send(JSON.stringify({ type: "picli", cwd: ROOT, ...req }));
  return waitFor((m) => m.type === "picli.done" && m.op === req.op, ms, what, mark);
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

  log("B. packages");
  let d = await run({ op: "pkg.list" }, "list empty");
  check(Array.isArray(d.data) && d.data.length === 0, "nothing installed in the fixture");
  const mark = seen.length;
  d = await run({ op: "pkg.install", source: PKG }, "install");
  const out = seen.slice(mark).filter((m) => m.type === "picli.out").map((m) => m.text).join("");
  check(d.code === 0 && /Installed/.test(out), `installed, output streamed (${out.trim().split("\n").pop()})`);
  check(JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8")).packages?.length === 1, "pi recorded it in the fixture settings.json");
  d = await run({ op: "pkg.list" }, "list one");
  const row = d.data?.[0];
  check(row?.scope === "user" && path.resolve(row.path) === path.resolve(PKG), `listed with its path (${JSON.stringify(row)})`);
  await waitFor((m) => m.type === "catalog", 30000, "catalog after install");
  d = await run({ op: "pkg.remove", source: row.path }, "remove");
  check(d.code === 0 && JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8")).packages.length === 0, "removed by its resolved path");

  log("C. MCP servers");
  d = await run({ op: "mcp.add", name: "bogus", command: "definitely-not-a-command", args: ["--x"] }, "mcp add");
  check(d.code === 0 && JSON.parse(fs.readFileSync(path.join(AGENT, "mcp.json"), "utf8")).mcpServers?.bogus?.command === "definitely-not-a-command", "added to the fixture mcp.json");
  d = await run({ op: "mcp.list" }, "mcp list");
  const srv = d.data?.servers?.find((x) => x.name === "bogus");
  check(srv && srv.state === "failed" && srv.error, `listed with its state and error even though pi exits 1 (${srv?.state})`);
  d = await run({ op: "mcp.remove", name: "bogus" }, "mcp remove");
  check(d.code === 0 && !JSON.parse(fs.readFileSync(path.join(AGENT, "mcp.json"), "utf8")).mcpServers?.bogus, "removed");
  const bad = await run({ op: "mcp.add", name: "bad name", command: "x" }, "bad");
  check(d && bad.code === -1 && /服务名/.test(bad.error ?? ""), "invalid request refused before anything runs");
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
