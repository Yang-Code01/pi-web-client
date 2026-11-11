/**
 * Probe: 登录 Radius 之后顺手配 Radius MCP（D229）。
 *
 * 桩桥演一遍登录的后半段：`auth.started` → `auth.done(ok)` → `auth.radiusMcp`，看页面有没有
 * 问那一句、点「配上」发的是什么、写完的提示去没去、点「不用」收不收得起来。
 *
 * 检查：
 *   1. 登录成功后面板里出现那张卡，写着要写的 mcp.json 与服务名；
 *   2. 点「配上」→ 桥收到 {type:"mcp.radius.add", cwd}，且 cwd 是当前会话的目录；
 *   3. 桥回 mcp.radius.added → 卡片消失、出现「已写进 mcp.json」的提示；
 *   4. 再来一次，点「不用」→ 卡片消失，桥没有收到第二条 mcp.radius.add。
 *
 * Run: npm run build:web && PI_WEB_PORT=7946 node probes/radius-mcp.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7946);
const OUT = path.join(REPO, ".scratch/radius-mcp/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(60);
  }
  log(`timeout waiting for ${what}`);
  return false;
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const CWD = "/Users/someone/work/app";
const SESSION = { id: "probe-radius", name: "登录探针", cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const MCP_PATH = "/Users/someone/.pi/agent/mcp.json";
const PROVIDERS = [
  { id: "radius", name: "Radius", methods: [{ type: "oauth", label: "Sign in" }], configured: true, source: "auth.json", label: null, stored: "oauth" },
];

let sock = null;
const sent = [];
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ME));
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("close", () => {
    if (sock === ws) sock = null;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    sent.push(msg);
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [], approvals: [], asks: [], budget: null }));
    }
    if (msg.type === "auth.list") ws.send(JSON.stringify({ type: "auth.providers", providers: PROVIDERS }));
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const logins = () => sent.filter((m) => m.type === "mcp.radius.add");
const card = (page) => page.locator(".login-run .login-prompt").filter({ hasText: "Radius MCP" });

let browser;
const errors = [];
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 880 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();

  // 打开登录面板：输入框里敲 /login（和用户手上的路径一样）。
  const box = page.locator(".composer-input textarea");
  await box.click();
  await box.fill("/login");
  await box.press("Enter");
  const opened = await until(async () => (await page.locator(".login-run, .settings-row, .login-list").count()) >= 1, 8000, "login sheet");
  check(opened, "登录面板打开了");
  await until(() => sent.some((m) => m.type === "auth.list"), 5000, "auth.list");
  await sleep(150);

  // 1. 登录走完：auth.done + auth.radiusMcp。
  send({ type: "auth.started", loginId: "lg1", provider: "radius", method: "oauth" });
  send({ type: "auth.done", loginId: "lg1", provider: "radius", ok: true });
  send({ type: "auth.radiusMcp", loginId: "lg1", provider: "radius", mcpPath: MCP_PATH, name: "radius" });
  const shown = await until(async () => (await card(page).count()) === 1, 8000, "radius card");
  check(shown, "登录成功后问了一句要不要配 Radius MCP");
  const text = shown ? await card(page).innerText() : "";
  check(text.includes(MCP_PATH) && text.includes("radius"), `卡片里写着路径与服务名（${text.replace(/\s+/g, " ").slice(0, 40)}…）`);
  await page.screenshot({ path: path.join(OUT, "1-ask.png") });

  // 2. 配上。
  await card(page).locator("button", { hasText: "配上" }).click();
  const asked = await until(() => logins().length === 1, 5000, "mcp.radius.add");
  check(asked, "点「配上」发了 mcp.radius.add");
  check(logins()[0]?.cwd === CWD, `带的是当前会话的目录（${logins()[0]?.cwd}）`);

  // 3. 写完：卡片消失、提示出现。
  send({ type: "mcp.radius.added", mcpPath: MCP_PATH, name: "radius" });
  const gone = await until(async () => (await card(page).count()) === 0, 5000, "card gone");
  check(gone, "写完之后卡片收起来了");
  // 提示落在设置页顶上那条 note 里（`flashSettings`），抽屉没开时才退化成聊天里的一条 notice。
  const hint = await until(async () => (await page.locator(".settings-note", { hasText: "Radius MCP" }).count()) >= 1, 4000, "hint");
  check(hint, "并说了已经写进 mcp.json");
  await page.screenshot({ path: path.join(OUT, "2-added.png") });

  // 4. 再来一次，点「不用」：不再问、不再写。
  send({ type: "auth.radiusMcp", loginId: "lg1", provider: "radius", mcpPath: MCP_PATH, name: "radius" });
  await until(async () => (await card(page).count()) === 1, 5000, "card again");
  await card(page).locator("button", { hasText: "不用" }).click();
  const dismissed = await until(async () => (await card(page).count()) === 0, 5000, "card dismissed");
  check(dismissed, "「不用」把卡片收起来了");
  check(logins().length === 1, "没有第二次 mcp.radius.add");

  check(errors.length === 0, `控制台没有报错${errors.length ? `：${errors.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser?.close().catch(() => {});
  wss.close();
  server.close();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
