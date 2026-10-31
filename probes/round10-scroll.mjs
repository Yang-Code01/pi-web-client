/**
 * Probe: Q-018 — scrolling up while a reply streams must not be dragged back to the bottom.
 *
 * Stands in for the bridge (serves `web/dist`, speaks enough ws) so it can stream `delta` events at a
 * controlled rate: that is the only way to reproduce the race (a burst of updates in flight while the
 * user wheels up). The old code wrote `scrollTop = scrollHeight` for every update scheduled, so one
 * wheel gesture lost against the queue.
 *
 * Checks: following while streaming, wheel-up wins and stays won, a small (30px) upward scroll also
 * wins, the "回到底部" button appears with 有新内容, reaching the bottom by hand resumes following,
 * the button jumps to the bottom, and a 600-update burst ends pinned at the bottom.
 *
 * Run: node probes/round10-scroll.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7906;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round10-scroll/shots";
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
const SESSION = { id: "probe-scroll", name: "滚动探针", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: true, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "正在长回复" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

// Sixty turns of history: enough to scroll, and the reply keeps growing under them.
const HISTORY = Array.from({ length: 60 }, (_, i) => ({
  kind: "user",
  id: `u${i}`,
  ts: Date.now() - (60 - i) * 60_000,
  text: `第 ${i + 1} 条历史消息：这一行只是用来把转录撑长的，方便验证滚动位置。`,
}));
const REPLY = { kind: "assistant", id: "a1", ts: Date.now(), model: "pi", text: "" };

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
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [...HISTORY, REPLY], approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let streaming = false;
const startStream = (everyMs) => {
  streaming = true;
  const tick = () => {
    if (!streaming) return;
    send({ type: "delta", sessionId: SESSION.id, id: "a1", field: "text", text: `正在写第 ${Math.random().toString(36).slice(2, 8)} 个字。\n` });
    setTimeout(tick, everyMs);
  };
  tick();
};
const stopStream = () => {
  streaming = false;
};

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  page.on("console", (m) => {
    if (m.type() === "error") log("console error:", m.text().slice(0, 160));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg.user").count()) >= 60, 8000, "history");

  const gap = () => page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
  const top = () => page.evaluate(() => Math.round(document.querySelector(".chat-scroll").scrollTop));
  const jump = page.locator(".chat-jump");
  const jumpVisible = async () => (await jump.count()) > 0 && (await jump.first().isVisible());

  await sleep(300);
  assert((await gap()) <= 4, `opens at the bottom (gap ${await gap()})`);

  // 1. Following: a stream keeps the view pinned and never shows the button.
  startStream(16);
  await sleep(600);
  // Mid-stream the gap can lag by the line that arrived since the last frame; what matters is that it
  // never grows past "one line" and that it settles at 0 once the stream stops.
  const gapWhileStreaming = await gap();
  assert(gapWhileStreaming <= 60, `streaming keeps us near the bottom (gap ${gapWhileStreaming})`);
  assert(!(await jumpVisible()), "no jump button while following");
  await page.screenshot({ path: path.join(OUT, "1-following.png") });
  stopStream();
  await sleep(300);
  assert((await gap()) <= 4, `and settles at the bottom after the stream (gap ${await gap()})`);
  startStream(16);
  await sleep(200);
  log("following ok, gap while streaming", gapWhileStreaming);

  // 2. The reported bug: wheel up 200px *while* the burst is in flight.
  const box = await page.locator(".chat-scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const beforeWheel = await top();
  await page.mouse.wheel(0, -200);
  await sleep(120);
  const afterWheel = await top();
  await sleep(700);
  const held = await top();
  assert(Math.abs(held - afterWheel) <= 3, `wheel-up wins over the stream (${afterWheel} → ${held})`);
  assert(afterWheel < beforeWheel - 100, `and it really moved up (${beforeWheel} → ${afterWheel})`);
  assert(await jumpVisible(), "the jump button shows up once we are not following");
  assert(await jump.first().locator(".jump-new").isVisible(), "the arrow grows a “new” badge while something arrived");
  const grown = await jump.first().boundingBox();
  assert((await jump.first().innerText()).includes("new"), `the badge reads new (got ${JSON.stringify(await jump.first().innerText())})`);
  assert(Math.round(grown.width) >= 34 && Math.round(grown.width) < 90, `it widens just enough for the badge (${Math.round(grown.width)}px)`);
  await page.screenshot({ path: path.join(OUT, "2-scrolled-up.png") });
  log("wheel-up held at", held, "gap", await gap());

  // 3. A small scroll (30px, under the old 80px threshold) must win too.
  await jump.first().click();
  await sleep(300);
  // While the stream is still running the gap can lag by one line; 1019 → under 60 is the real signal.
  assert((await gap()) <= 60, `the button jumps back to the bottom (gap ${await gap()})`);
  assert(!(await jumpVisible()), "and hides itself");
  await page.mouse.wheel(0, -30);
  await sleep(120);
  const small = await top();
  await sleep(600);
  assert(Math.abs((await top()) - small) <= 3, `a 30px scroll also wins (${small} → ${await top()})`);

  // 4. Reaching the bottom by hand resumes following: new content pins again and clears the hint.
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    el.scrollTop = el.scrollHeight;
  });
  await sleep(300);
  assert(!(await jumpVisible()), "hint clears once we are back at the bottom");
  const pinned = await gap();
  await sleep(400);
  // Still streaming: one line of lag is expected, a lost follow would be hundreds of px.
  assert((await gap()) <= 60, `following resumed (gap was ${pinned}, now ${await gap()})`);

  // 5. Burst: 600 updates in ~200ms must not pile up frames or leave us mid-transcript.
  stopStream();
  const t0 = Date.now();
  for (let i = 0; i < 600; i += 1) send({ type: "delta", sessionId: SESSION.id, id: "a1", field: "text", text: `x${i} ` });
  await sleep(500);
  assert((await gap()) <= 4, `a 600-update burst ends at the bottom (gap ${await gap()})`);
  log("burst of 600 handled in", Date.now() - t0, "ms, gap", await gap());

  // 6. Q-027: with nothing arriving the hint is one round arrow in the middle of the transcript — no
  //    sentence, no bar; the “new” badge only exists while something is waiting up top.
  const vp = await page.locator(".chat-scroll").boundingBox();
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(0, -400);
  await sleep(280);
  assert(await jumpVisible(), "the arrow appears once we leave the bottom");
  const circle = await jump.first().boundingBox();
  assert(Math.round(circle.width) <= 34 && Math.round(circle.height) <= 34, `it is a small circle (${Math.round(circle.width)}×${Math.round(circle.height)})`);
  assert(!(await jump.first().locator(".jump-new").isVisible()), "with nothing new there is no badge");
  assert((await jump.first().innerText()).trim() === "↓", `its text is the arrow alone (got ${JSON.stringify(await jump.first().innerText())})`);
  const mid = circle.x + circle.width / 2 - vp.x;
  assert(Math.abs(mid - vp.width / 2) <= 8, `it sits in the middle of the transcript (${Math.round(mid)} vs ${Math.round(vp.width / 2)})`);
  await page.screenshot({ path: path.join(OUT, "4-arrow-only.png") });
  await jump.first().click();
  await sleep(280);
  assert((await gap()) <= 4, `clicking the arrow jumps back (gap ${await gap()})`);
  log("arrow-only circle", `${Math.round(circle.width)}×${Math.round(circle.height)}`);

  log("ALL OK");
  await page.screenshot({ path: path.join(OUT, "3-burst.png") });
} finally {
  stopStream();
  await browser?.close();
  server.close();
  wss.close();
}
