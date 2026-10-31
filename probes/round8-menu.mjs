/**
 * Probe: Q-008 — right-click a file in the browser: scripts get 用 PowerShell 运行 / 以管理员身份运行.
 *
 * A fake bridge serves `web/dist` and speaks just enough of the ws protocol to show one session;
 * nothing here needs pi to be running.
 *
 * The menu talks to the bridge over ws, so this probe records the `open.script` message instead of
 * letting a real PowerShell window pop up on the desktop.
 *
 * Checks: a .ps1 row offers the two run entries, a .txt row does not, and picking one sends the
 * right message (`open.script` with the absolute path, cwd and admin flag).
 *
 * Run: node probes/round8-menu.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7901;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round8-menu/shots";
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = { id: "probe-sess", name: "脚本探针", cwd: "F:/pi-web-client/.scratch/round8-fs", file: null, owned: false, origin: "disk", running: true, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "问两个问题" };
const ASK = {
  id: "ask_probe1",
  sessionId: SESSION.id,
  sessionName: SESSION.name,
  createdAt: Date.now(),
  questions: [
    { id: "q1", label: "Q1", prompt: "先确认一下：这次改动要动 bridge 吗？", options: [{ value: "yes", label: "要动" }, { value: "no", label: "不动" }], allowOther: true },
    { id: "q2", label: "Q2", prompt: "第二题：截图要不要一起给你？", options: [{ value: "yes", label: "要" }, { value: "no", label: "不要" }], allowOther: true },
  ],
};

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
let sock = null;
const seen = [];
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/dirs") {
    const dir = url.searchParams.get("path") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ path: dir || "F:/pi-web-client/.scratch/round8-fs", parent: null, dirs: [], files: ["hello.ps1", "readme.txt"] }));
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
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
    log("client →", msg.type);
    if (msg.type === "open.script" || msg.type === "term.elevate") {
      seen.push(msg);
      ws.send(JSON.stringify({ type: "notice", text: `记下了 ${msg.type}`, level: "info" }));
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: SESSION.id,
          state: { ...SESSION, asks: 1 },
          items: [{ kind: "user", id: "u1", text: "帮我把问卷答了。" }],
          approvals: [],
          asks: [ASK],
          budget: null,
        }),
      );
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: [SESSION],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 5).join(" | ")));
  page.on("console", (m) => log("console:", m.type(), m.text().slice(0, 160)));
  page.on("requestfailed", (r) => log("request failed:", r.url(), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 400) log("http", r.status(), r.url());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  // Open the session, then the file browser from the top bar.
  await page.locator(".session-card").first().click();
  const fsBtn = page.getByRole("button", { name: /文件管理器/ });
  await until(async () => fsBtn.isVisible(), 8000, "文件管理器 button");
  await fsBtn.click();
  const row = page.locator(".file-row", { hasText: "hello.ps1" });
  await until(async () => (await row.count()) > 0, 8000, "hello.ps1 in the list");

  // Right-click a script: two run entries + the generic ones.
  await row.first().click({ button: "right" });
  const menu = page.locator(".ctx-menu");
  await until(async () => menu.isVisible(), 4000, "context menu");
  const labels = (await menu.locator(".ctx-item").allInnerTexts()).map((s) => s.trim());
  assert(labels.includes("用 PowerShell 运行"), `run entry present (got ${JSON.stringify(labels)})`);
  assert(labels.includes("以管理员身份运行"), `admin entry present (got ${JSON.stringify(labels)})`);
  log("script menu:", labels.join(" / "));
  await page.screenshot({ path: path.join(OUT, "1-menu.png") });

  // Pick the plain run: the bridge must receive the absolute path and the cwd.
  await menu.getByRole("button", { name: "用 PowerShell 运行" }).click();
  await until(async () => seen.some((m) => m.type === "open.script"), 4000, "open.script on the wire");
  const sent = seen.find((m) => m.type === "open.script");
  assert(String(sent.file).endsWith("hello.ps1"), `absolute path sent (got ${sent.file})`);
  assert(sent.admin === false, `admin flag (got ${sent.admin})`);
  log("sent:", JSON.stringify(sent));

  // Q-014: the path row is a breadcrumb — every segment is a button that jumps back.
  const crumbs = page.locator(".dir-path .crumb");
  const crumbLabels = (await crumbs.allInnerTexts()).map((t) => t.trim());
  assert(crumbLabels[0] === "此电脑", `breadcrumb starts at 此电脑 (got ${JSON.stringify(crumbLabels)})`);
  assert(crumbLabels.length >= 4, `breadcrumb splits the path (got ${JSON.stringify(crumbLabels)})`);
  log("breadcrumb:", crumbLabels.join(" / "));
  await crumbs.filter({ hasText: "pi-web-client" }).first().click();
  await until(async () => (await page.locator(".dir-path .crumb").allInnerTexts()).length < crumbLabels.length, 5000, "crumb click goes up a level");
  log("after crumb click:", (await page.locator(".dir-path .crumb").allInnerTexts()).map((t) => t.trim()).join(" / "));
  const after = (await page.locator(".dir-path .crumb").allInnerTexts()).map((t) => t.trim());
  assert(after[after.length - 1] === "pi-web-client", `jumped to that level (got ${JSON.stringify(after)})`);

  // A non-script row gets no run entries.
  const plain = page.locator(".file-row", { hasText: "readme.txt" });
  await plain.first().click({ button: "right" });
  await until(async () => menu.isVisible(), 4000, "menu again");
  const plainLabels = (await menu.locator(".ctx-item").allInnerTexts()).map((s) => s.trim());
  assert(!plainLabels.some((l) => l.includes("PowerShell")), `no PowerShell entries for .txt (got ${JSON.stringify(plainLabels)})`);
  log("txt menu:", plainLabels.join(" / "));
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".ctx-menu").count()) === 0, 3000, "menu closed by Esc");

  log("ALL OK");
} finally {
  await browser.close();
  server.close();
  wss.close();
}
