/**
 * Probe: Q-009 — the 快捷键 sheet: bind a combo, see it in the tooltip, fire the action, survive a reload.
 *
 * A fake bridge serves `web/dist` and speaks just enough of the ws protocol to show one session;
 * nothing here needs pi to be running.
 *
 * Checks: the sheet lists every action, a combo can be captured and is refused for browser keys,
 * the combo survives a reload and actually fires the action, and the button tooltip shows it.
 *
 * Run: node probes/round6-keys.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7897;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round6-keys/shots";
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
const SESSION = { id: "probe-sess", name: "问卷探针", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: true, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "问两个问题" };
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
  // The 快捷键 card sits in the right rail, above 关于.
  const rail = page.locator(".pane").last();
  const openBtn = rail.getByRole("button", { name: /设置快捷键|快捷键（已设/ });
  await until(async () => (await openBtn.count()) > 0, 8000, "shortcut card");
  await openBtn.click();
  const sheet = page.locator(".keys-sheet");
  await until(async () => sheet.isVisible(), 4000, "keys sheet");
  const rows = sheet.locator(".keys-row");
  assert((await rows.count()) === 11, `eleven actions are listed (got ${await rows.count()})`);
  log("sheet lists actions:", await rows.count());

  // Bind 开新会话 → Ctrl+Shift+Y.
  await rows.nth(0).locator(".keys-chip").click();
  await until(async () => (await rows.nth(0).innerText()).includes("按下组合键"), 3000, "capture mode");
  await page.evaluate(() => window.addEventListener("keydown", (e) => console.log("seen", e.key, e.ctrlKey, e.shiftKey), true));
  await page.keyboard.press("Control+Shift+Y");
  await sleep(300);
  log("after press, stored:", await page.evaluate(() => localStorage.getItem("pi.keys")));
  log("row text:", await rows.nth(0).innerText());
  await until(async () => (await rows.nth(0).innerText()).includes("Ctrl+Shift+Y"), 3000, "combo shown");
  const stored = await page.evaluate(() => localStorage.getItem("pi.keys"));
  assert(stored?.includes("ctrl+shift+y"), `binding persisted (got ${stored})`);

  // A browser key is refused and the row stays empty.
  await rows.nth(2).locator(".keys-chip").click();
  await until(async () => (await rows.nth(2).innerText()).includes("按下组合键"), 3000, "capture mode 2");
  await page.keyboard.press("Control+W");
  await sleep(200);
  assert((await rows.nth(2).innerText()).includes("未设置"), "Ctrl+W is refused");
  await page.screenshot({ path: path.join(OUT, "1-keys.png") });

  // Bind 收起/展开左栏 → Ctrl+Shift+U, so the tooltip check has something to look at.
  await rows.nth(2).locator(".keys-chip").click();
  await page.keyboard.press("Control+Shift+U");
  await until(async () => (await rows.nth(2).innerText()).includes("Ctrl+Shift+U"), 3000, "combo 2 shown");
  await sheet.getByRole("button", { name: "完成" }).click();
  await until(async () => (await page.locator(".keys-sheet").count()) === 0, 3000, "sheet closed");

  const tip = await page.locator('[data-act="sessions"]').first().getAttribute("title");
  assert(tip?.includes("Ctrl+Shift+U"), `tooltip carries the combo (got ${tip})`);
  log("tooltip:", tip);

  // The combo fires the action it was bound to.
  await page.keyboard.press("Control+Shift+U");
  await sleep(300);
  assert((await page.evaluate(() => localStorage.getItem("pi.collapse.sessions"))) === "1", "combo fired 收起左栏");
  await page.keyboard.press("Control+Shift+U");
  await sleep(300);

  // And it still works after a reload (the sheet + localStorage round trip).
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card after reload");
  await page.keyboard.press("Control+Shift+Y");
  await until(async () => (await page.locator(".sheet .sheet-title").count()) > 0, 5000, "new-session sheet from the shortcut");
  log("combo still fires after reload:", await page.locator(".sheet .sheet-title").first().innerText());
  await page.screenshot({ path: path.join(OUT, "2-fired.png") });

  log("ALL OK");
} finally {
  await browser.close();
  server.close();
  wss.close();
}
