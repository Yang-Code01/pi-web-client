/**
 * The 扩展 manager (D81): installed inventory with versions, enable / disable, MCP version bumps,
 * store → `pi mcp add` translation, the composer-button preference, and read-only over the tunnel.
 * Real pi CLI against a fixture agent dir (PI_AGENT_DIR + PI_CODING_AGENT_DIR); the store's network
 * sources are not used here (see .scratch probes), only the npm "latest" lookup for one MCP package.
 *
 *   npm run build:bridge && node bridge/tests/ext-manager.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7912;
const ROOT = path.join(REPO, ".scratch", "ext-manager");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const PKG = path.join(ROOT, "demo-pkg");
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(path.join(AGENT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(AGENT, "extensions"), { recursive: true });
fs.writeFileSync(path.join(AGENT, "extensions", "loose.ts"), "export default function () {}\n");
fs.mkdirSync(path.join(PKG, "extensions"), { recursive: true });
fs.writeFileSync(path.join(PKG, "package.json"), JSON.stringify({ name: "demo-pkg", version: "1.2.3", keywords: ["pi-package"] }));
fs.writeFileSync(path.join(PKG, "extensions", "x.ts"), "export default function () {}\n");
fs.writeFileSync(path.join(AGENT, "mcp.json"), JSON.stringify({ mcpServers: { everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@0.0.1"] } } }, null, 2));

process.env.PI_WEB_STATE = STATE;
process.env.PI_AGENT_DIR = AGENT;
const market = await import("../dist/market.js");
const extmgr = await import("../dist/extmgr.js");

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

// ------------------------------------------------------------------ A. pure pieces
log("A. store → pi mcp add, versions, files");
check(market.newer("1.10.0", "1.9.9") && !market.newer("1.0.0", "1.0.0") && market.newer("2.0.0", "2.0.0-beta.1") === false, "version compare");
const opt = {
  kind: "npm",
  label: "npx",
  identifier: "@acme/mcp",
  version: "2.1.0",
  transport: "stdio",
  env: [
    { name: "ACME_KEY", description: "", required: true, secret: true, default: null },
    { name: "ACME_REGION", description: "", required: false, secret: false, default: "eu" },
  ],
  headers: [],
  args: ["\u0000", "--stdio"],
};
let r = market.mcpAddRequest(opt, { name: "acme", values: { "env:ACME_REGION": "us" } });
check(JSON.stringify(r.req.args) === JSON.stringify(["-y", "@acme/mcp@2.1.0", "--stdio"]) && r.req.command === "npx", `npx argv (${JSON.stringify(r.req.args)})`);
check(r.req.env.includes("ACME_KEY=${ACME_KEY}") && r.req.env.includes("ACME_REGION=us") && JSON.stringify(r.vars) === JSON.stringify(["ACME_KEY"]), "secret written as ${VAR}, plain value as typed");
r = market.mcpAddRequest({ ...opt, kind: "remote", url: "https://x.example/mcp", env: [], headers: [{ name: "Authorization", description: "", required: true, secret: true, default: null, template: "Bearer {api_key}" }] }, { name: "x-svc", values: {} });
check(r.req.url === "https://x.example/mcp" && r.req.headers[0] === "Authorization=Bearer ${X_SVC_AUTHORIZATION}", `remote header template kept, secret → variable (${r.req.headers[0]})`);
r = market.mcpAddRequest({ ...opt, kind: "oci", identifier: "ghcr.io/acme/mcp", version: "1.0" }, { name: "acme", values: {} });
check(JSON.stringify(r.req.args) === JSON.stringify(["run", "-i", "--rm", "-e", "ACME_KEY", "ghcr.io/acme/mcp:1.0", "--stdio"]), `docker argv forwards the secret by name (${JSON.stringify(r.req.args)})`);
r = market.mcpAddRequest({ ...opt, kind: "pypi", identifier: "acme-mcp", version: "0.3" }, { name: "acme", values: {} });
check(r.req.command === "uvx" && r.req.args[0] === "acme-mcp==0.3", "uvx pins with ==");
let threw = false;
try {
  market.mcpAddRequest({ ...opt, env: [{ name: "NEED", description: "", required: true, secret: false, default: null }] }, { name: "a", values: {} });
} catch {
  threw = true;
}
check(threw, "missing required non-secret value refused");
check(JSON.stringify(market.mcpPackageOf("npx", ["-y", "@a/b@1.2.3"])) === JSON.stringify({ registry: "npm", identifier: "@a/b", version: "1.2.3" }), "npx spec parsed");
check(market.mcpPackageOf("uvx", ["tool==0.1"]).version === "0.1" && market.mcpPackageOf("docker", ["run", "-i", "--rm", "-e", "K", "img/x:2"]).version === "2", "uvx / docker spec parsed");
let bad = false;
try {
  extmgr.assertMcpFile(path.join(AGENT, "settings.json"));
} catch {
  bad = true;
}
check(bad, "only mcp.json files can be edited");

// ------------------------------------------------------------------ B. bridge
log("B. bridge");
delete process.env.PI_BIN;
const env = { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT, PI_CODING_AGENT_DIR: AGENT };
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
const pages = [];
async function page(cookie, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, ...headers } });
  const seen = [];
  const waits = [];
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
  const ask = async (m, pred, what, ms = 120000) => {
    const mark = seen.length;
    ws.send(JSON.stringify(m));
    return waitFor(pred, ms, what, mark);
  };
  pages.push(ws);
  return { ws, seen, waitFor, ask };
}
try {
  await until(() => fs.existsSync(path.join(STATE, "passphrase.txt")), 20000, "passphrase");
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 20000, "bridge up");
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: pass }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const a = await page(cookie);
  const hello = await a.waitFor((m) => m.type === "hello", 5000, "hello");
  check(hello.ui?.showExtButton === true, "hello carries the button preference (on by default)");

  const inst = await a.ask({ type: "picli", op: "pkg.install", source: PKG }, (m) => m.type === "picli.done" && m.op === "pkg.install", "install");
  check(inst.code === 0, "local package installed through pi");
  let inv = await a.ask({ type: "ext.inventory", check: true }, (m) => m.type === "ext.inventory", "inventory");
  const pkg = inv.packages?.find((p) => p.name === "demo-pkg");
  check(pkg && pkg.version === "1.2.3" && pkg.origin === "local" && !pkg.update, `package with its version, local → not checked (${JSON.stringify(pkg)})`);
  const loose = inv.extensions?.find((x) => x.label === "loose.ts");
  check(loose && loose.enabled && loose.how === "discovered", "loose extension from <agentDir>/extensions listed");
  check(inv.extensions?.filter((x) => x.scope === "builtin").length === 4, "four built-ins listed");
  const mcp = inv.mcp?.find((m) => m.name === "everything");
  check(mcp && mcp.version.version === "0.0.1", `MCP server with its pinned version (${JSON.stringify(mcp?.version)})`);
  if (mcp?.version.latest) check(mcp.version.update === true, `newer release found on npm (${mcp.version.latest})`);
  else log("  (npm not reachable: update check skipped)");
  check(typeof inv.updates === "number", `update count ${inv.updates}`);

  // disable / enable a built-in and the loose extension
  await a.ask({ type: "ext.toggle", id: "builtin:codemode", scope: "builtin", how: "builtin", enable: false }, (m) => m.type === "ext.changed", "toggle builtin");
  const s1 = JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8"));
  check(s1.extensions.includes("-builtin:codemode"), "built-in disabled as -builtin:codemode");
  await a.ask({ type: "ext.toggle", id: loose.id, scope: "user", how: "discovered", enable: false }, (m) => m.type === "ext.changed", "toggle loose");
  inv = await a.ask({ type: "ext.inventory", check: false }, (m) => m.type === "ext.inventory", "inventory 2");
  check(inv.extensions.find((x) => x.id === "builtin:codemode")?.enabled === false && inv.extensions.find((x) => x.label === "loose.ts")?.enabled === false, "both show as disabled");
  await a.ask({ type: "ext.toggle", id: "builtin:codemode", scope: "builtin", how: "builtin", enable: true }, (m) => m.type === "ext.changed", "re-enable");
  await a.ask({ type: "ext.toggle", id: loose.id, scope: "user", how: "discovered", enable: true }, (m) => m.type === "ext.changed", "re-enable loose");
  const s2 = JSON.parse(fs.readFileSync(path.join(AGENT, "settings.json"), "utf8"));
  check(!s2.extensions && Array.isArray(s2.packages), `exclusions removed again, packages untouched (${JSON.stringify(s2)})`);

  // MCP disable + version bump
  const mcpFile = path.join(AGENT, "mcp.json");
  await a.ask({ type: "mcp.toggle", file: mcpFile, name: "everything", enable: false }, (m) => m.type === "ext.changed", "mcp off");
  check(JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.everything.enabled === false, "MCP server disabled in its mcp.json");
  await a.ask({ type: "mcp.bump", file: mcpFile, name: "everything", version: "0.0.2" }, (m) => m.type === "ext.changed", "bump");
  const e2 = JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.everything;
  check(e2.args.includes("@modelcontextprotocol/server-everything@0.0.2") && e2.enabled === false, "pinned version moved, the rest kept");
  const err = await a.ask({ type: "mcp.toggle", file: path.join(AGENT, "settings.json"), name: "x", enable: true }, (m) => m.type === "ext.error", "bad file");
  check(/mcp\.json/.test(err.message), "editing anything but an mcp.json refused");

  // store install → pi mcp add
  const done = await a.ask(
    { type: "mcp.install", option: { ...opt, kind: "remote", url: "https://x.example/mcp", env: [], headers: [{ name: "Authorization", description: "", required: true, secret: true, default: null, template: "Bearer {k}" }] }, name: "xsvc", values: {} },
    (m) => m.type === "picli.done" && m.op === "mcp.add",
    "mcp.install",
  );
  const added = JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.xsvc;
  check(done.code === 0 && added?.url === "https://x.example/mcp" && added.headers?.Authorization === "Bearer ${XSVC_AUTHORIZATION}", `remote server added with a variable, not a secret (${JSON.stringify(added)})`);
  check(JSON.stringify(done.vars) === JSON.stringify(["XSVC_AUTHORIZATION"]), "page told which variable to set");

  // preference
  const pref = await a.ask({ type: "ui.set", showExtButton: false }, (m) => m.type === "ui", "ui.set");
  check(pref.ui.showExtButton === false && JSON.parse(fs.readFileSync(path.join(STATE, "ui.json"), "utf8")).showExtButton === false, "button preference saved in the bridge");

  // tunnel: read-only
  const pub = await page(cookie, { "cf-connecting-ip": "203.0.113.9" });
  await pub.waitFor((m) => m.type === "hello", 5000, "hello pub");
  const refused = await pub.ask({ type: "mcp.toggle", file: mcpFile, name: "everything", enable: true }, (m) => m.type === "notice", "public toggle");
  check(/只能查看/.test(refused.text) && JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.everything.enabled === false, "over the tunnel: refused, nothing changed");
  const refused2 = await pub.ask({ type: "picli", op: "pkg.install", source: "npm:x" }, (m) => m.type === "picli.done", "public install");
  check(/只能查看/.test(refused2.error ?? ""), "package install over the tunnel refused");
  const inv3 = await pub.ask({ type: "ext.inventory", check: false }, (m) => m.type === "ext.inventory", "public inventory");
  check(Array.isArray(inv3.packages), "…but the inventory is readable");
} catch (e) {
  failed = true;
  console.error("ERROR", e.message);
  console.error(bridgeOut.join("").slice(-3000));
} finally {
  for (const w of pages) {
    try {
      w.close();
    } catch {}
  }
  bridge.kill();
}
log(failed ? "FAILED" : "PASS");
process.exit(failed ? 1 : 0);
