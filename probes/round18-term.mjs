/**
 * Probe: Q-025 — opening the terminal folds the right pane away (the dock lives in the chat column,
 * so that column is the only thing stealing its width), and the dock's top edge is a grip you can
 * drag up/down, remembered across mounts, double-click to reset.
 *
 * Stands in for the bridge: it answers `term.open` with `term.opened` and ignores input.
 *
 * Run: node probes/round18-term.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7912;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round18-term/shots";
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

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const A = { id: "probe-term", name: "终端探针", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "终端高度" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let sock = null;
let shells = 0;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

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
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: A.id, state: A, items: [], approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "term.open") {
      shells += 1;
      ws.send(JSON.stringify({ type: "term.opened", id: `probe-term-${shells}`, shell: "PowerShell", cwd: msg.cwd ?? A.cwd }));
      return;
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [A], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => await page.locator("[data-act=\"terminal\"]").isVisible(), 8000, "terminal button");
  const main = page.locator(".main");
  assert(!(await main.getAttribute("class")).includes("no-right"), "the right pane starts expanded");

  // 1) Opening the shell folds the right pane — that column is the only one next to the dock.
  await page.locator("[data-act=\"terminal\"]").click();
  await until(async () => page.locator(".term-dock").isVisible(), 8000, "terminal dock");
  await until(async () => (await main.getAttribute("class")).includes("no-right"), 4000, "right pane folds on open");
  const flag = await page.evaluate(() => localStorage.getItem("pi.collapse.queue"));
  log("right pane collapsed:", flag);
  assert(flag === "1", `the collapse is remembered like a manual one (got ${flag})`);
  assert(!(await page.locator("[data-act=\"terminal\"]").isVisible()), "the pane that opened it is out of the way");
  await page.screenshot({ path: path.join(OUT, "1-open.png") });

  // 2) The top edge is a grip: drag it up and the dock grows by (almost) what the pointer moved.
  const grip = page.locator(".term-grip").first();
  const dock = page.locator(".term-dock").first();
  assert(await grip.isVisible(), "the dock has a drag grip");
  const before = (await dock.boundingBox()).height;
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 140, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  const after = (await dock.boundingBox()).height;
  const savedH = Number(await page.evaluate(() => localStorage.getItem("pi.termH")));
  log(`dock height: ${Math.round(before)} → ${Math.round(after)} | pi.termH=${savedH}`);
  assert(after > before + 80, `dragging up grows the dock (${Math.round(before)} → ${Math.round(after)})`);
  assert(Number.isFinite(savedH) && Math.abs(savedH - after) <= 2, "the height is remembered");
  await page.screenshot({ path: path.join(OUT, "2-dragged.png") });

  // Dragging far past the top stops where the chat still has room — and the grip has moved up with
  // the dock, so take its box again instead of reusing stale coordinates.
  const box2 = await grip.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, 0, { steps: 10 });
  await page.mouse.up();
  await sleep(200);
  const tallest = (await dock.boundingBox()).height;
  assert(tallest > after + 40, `dragging further up still grows the dock (${Math.round(after)} → ${Math.round(tallest)})`);
  assert(tallest <= 620 + 2, `the dock stops with the chat still on screen (${Math.round(tallest)}px)`);
  log("max height clamp:", Math.round(tallest), "(window 860 − 240 = 620)");

  // 3) Closing and re-opening keeps the size (it is in localStorage, not in the mount).
  await page.locator(".term-btn", { hasText: "关闭" }).click();
  await until(async () => (await page.locator(".term-dock").count()) === 0, 4000, "dock closed");
  await page.locator("[data-act=\"queue\"]").click();
  await until(async () => await page.locator("[data-act=\"terminal\"]").isVisible(), 4000, "right pane back");
  await page.locator("[data-act=\"terminal\"]").click();
  await until(async () => page.locator(".term-dock").isVisible(), 8000, "dock reopened");
  const reopened = (await dock.boundingBox()).height;
  log("reopened height:", Math.round(reopened));
  assert(Math.abs(reopened - tallest) <= 2, `the height survives a remount (${Math.round(tallest)} → ${Math.round(reopened)})`);

  // 4) Double-click forgets the size.
  await page.locator(".term-grip").first().dblclick();
  await sleep(250);
  const reset = (await dock.boundingBox()).height;
  const gone = await page.evaluate(() => localStorage.getItem("pi.termH"));
  log("after reset:", Math.round(reset), "| pi.termH:", gone);
  assert(gone === null, "double-click forgets the saved height");
  assert(reset < tallest - 40, `double-click returns to the default (${Math.round(tallest)} → ${Math.round(reset)})`);
  await page.screenshot({ path: path.join(OUT, "3-reset.png") });
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
