/**
 * Probe: D59 — the new-session dialog defaults its 工作目录 to the directory of the session you
 * are currently in. Sits in A, ＋ must offer A's cwd; switch to B, ＋ must offer B's.
 *
 * Stands in for the bridge (two seeded sessions, distinct cwds) and seeds `pi.lastCwd` with a third
 * directory, so a stale "last created" value would be caught immediately.
 *
 * Run: npm run build:web && node probes/round19-default-cwd.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7913;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round19-default-cwd/shots";
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
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const base = (id, name, cwd, extra = {}) => ({ id, name, cwd, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", ...extra });
const A = base("probe-a", "A 会话", "F:/probe-work/alpha", { updatedAt: Date.now() - 120000 });
const B = base("probe-b", "B 会话", "F:/probe-work/beta", { updatedAt: Date.now() - 60000 });
const STALE = "F:/probe-work/stale-last-created";
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };
const creates = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  // The sheet's 浏览 pane lists on mount; keep it empty so it never rewrites the field under us.
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
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
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      const state = [A, B].find((s) => s.id === msg.sessionId) ?? A;
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: [], approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "create") creates.push(msg);
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [A, B], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const cwdField = (page) => page.locator(".sheet.new-sheet .ns-row .ns-input.mono").first();

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  // A stale "last created" directory must not win over wherever we are now.
  await page.evaluate((dir) => localStorage.setItem("pi.lastCwd", dir), STALE);
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");

  // 1) In session A → ＋ defaults to A's cwd.
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator('.session-card[data-id="probe-a"].active').count()) === 1, 5000, "A is the open session");
  await page.locator(".new-session [data-act=\"new\"]").click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 5000, "new-session sheet");
  await sleep(600); // let the browse pane's first listing settle before reading the field
  const inA = await cwdField(page).inputValue();
  log("A 会话默认目录:", JSON.stringify(inA));
  assert(inA === A.cwd, `在 A 会话时默认目录应是 A 的 ${A.cwd}（实际 ${inA}）`);
  await page.screenshot({ path: path.join(OUT, "1-default-in-a.png") });
  await page.locator(".sheet.new-sheet .sheet-head .btn.ghost").click();
  await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 5000, "sheet closes");

  // 2) Switch to session B → ＋ defaults to B's cwd, not A's and not the stale lastCwd.
  await page.locator('.session-card[data-id="probe-b"]').click();
  await until(async () => (await page.locator('.session-card[data-id="probe-b"].active').count()) === 1, 5000, "B is the open session");
  await page.locator(".new-session [data-act=\"new\"]").click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 5000, "new-session sheet again");
  await sleep(600);
  const inB = await cwdField(page).inputValue();
  log("B 会话默认目录:", JSON.stringify(inB));
  assert(inB === B.cwd, `在 B 会话时默认目录应是 B 的 ${B.cwd}（实际 ${inB}）`);
  await page.screenshot({ path: path.join(OUT, "2-default-in-b.png") });

  // 3) Submitting keeps the already-good default: the create frame carries B's cwd untouched.
  await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
  await until(async () => creates.length >= 1, 5000, "create frame");
  log("create 帧 cwd:", JSON.stringify(creates[0].cwd));
  assert(creates[0].cwd === B.cwd, `不改就提交，cwd 仍是 B 的 ${B.cwd}（实际 ${creates[0].cwd}）`);
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
