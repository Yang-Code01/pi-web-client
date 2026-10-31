/**
 * Probe: Q-023 — the terminal dock's 「管理员」 button must actually ask for elevation.
 *
 * A fake bridge serves `web/dist` and speaks just enough of the ws protocol to show one session and
 * to hand back a terminal. The dock's button only sends a ws message, so this probe records the
 * `term.elevate` frame instead of letting a real PowerShell window (and a UAC prompt) pop up on the
 * desktop.
 *
 * Checks: opening the dock sends `term.open` with the session cwd, and clicking 「管理员」 sends
 * `term.elevate` with `admin: true` — the flag the bridge turns into `-Verb RunAs`
 * (bridge/src/terminal.ts:178). Without it the button opened a plain shell while still calling
 * itself 管理员; that is the whole defect.
 *
 * The notice wording is produced by the bridge (bridge/src/terminal.ts:192-199), not by the page, so
 * it cannot be asserted against a fake bridge — read it there.
 *
 * Run: node probes/round14-admin.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7902;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round14-admin/shots";
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
const CWD = "C:/ai/library/performance/library";
const SESSION = {
  id: "probe-sess",
  name: "提权探针",
  cwd: CWD,
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: true,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  locked: false,
  preview: "点一下管理员，看线上发的是什么",
};

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
let sock = null;
const seen = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
  }
  if (url.pathname === "/api/dirs") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ path: CWD, parent: null, dirs: [], files: [] }));
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
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
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
    if (msg.type !== "term.data") log("client →", msg.type, msg.admin === undefined ? "" : `admin=${msg.admin}`);
    if (msg.type === "term.open") {
      seen.push(msg);
      send({ type: "term.opened", id: "tprobe", shell: "powershell.exe", cwd: String(msg.cwd ?? "") });
      return;
    }
    if (msg.type === "term.elevate" || msg.type === "open.script") {
      seen.push(msg);
      send({ type: "notice", text: `记下了 ${msg.type}`, level: "info" });
      return;
    }
    if (msg.type === "subscribe") {
      send({ type: "session", sessionId: SESSION.id, state: SESSION, items: [{ kind: "user", id: "u1", text: "开个管理员终端。" }], approvals: [], asks: [], budget: null });
    }
  });
  send({
    type: "hello",
    me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
    sessions: [SESSION],
    manage: { pin: [], order: [], archived: [] },
    trash: [],
    tunnel: TUNNEL,
  });
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

  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".topbar .title").innerText()).includes("提权探针"), 6000, "session opened");

  // The terminal entry lives in the right pane (通道 / 终端 / 快捷键 / 关于). The pane may already be
  // open — the toggle persists in localStorage — so only collapse/expand when it is actually hidden.
  const termBtn = page.locator('[data-act="terminal"]').first();
  if (!(await termBtn.isVisible().catch(() => false))) {
    await page.locator(".icon-btn.side-toggle[data-side=right]").first().click();
  }
  await until(async () => termBtn.isVisible(), 6000, "打开终端 button");
  await termBtn.click();
  await until(async () => (await page.locator(".term-dock").count()) > 0, 8000, "terminal dock");

  const open = seen.find((m) => m.type === "term.open");
  assert(open, "term.open reached the bridge");
  assert(open.cwd === CWD, `term.open carries the session cwd (got ${JSON.stringify(open.cwd)})`);

  const dock = page.locator(".term-dock");
  const title = (await dock.locator(".term-title").innerText()).trim();
  assert(title.includes(CWD), `dock header names the shell and its cwd (got ${title})`);
  log("dock:", title);

  const admin = dock.getByRole("button", { name: "管理员" });
  await until(async () => admin.isVisible(), 6000, "管理员 button");
  await admin.click();
  await until(async () => seen.some((m) => m.type === "term.elevate"), 4000, "term.elevate on the wire");

  const sent = seen.find((m) => m.type === "term.elevate");
  assert(sent.admin === true, `the admin flag must be on the wire (got admin=${JSON.stringify(sent.admin)})`);
  assert(sent.cwd === CWD, `term.elevate carries the session cwd (got ${JSON.stringify(sent.cwd)})`);
  assert(sent.file === undefined, `a bare terminal sends no script path (got ${JSON.stringify(sent.file)})`);
  log("sent:", JSON.stringify(sent));
  await page.screenshot({ path: path.join(OUT, "1-admin.png") });

  // The dock must survive elevation: Q-008 decided the current pane is not replaced.
  assert((await dock.count()) === 1, "opening an elevated window must not close the dock");

  log("ALL OK");
} finally {
  await browser.close();
  server.close();
  wss.close();
}
