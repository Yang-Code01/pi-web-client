/**
 * Probe: Q-022 — a session started from the pin strip's ＋ is pinned right away (otherwise the new
 * session is invisible in the strip that started it), and the ★ on a pin chip un-pins without
 * opening the session.
 *
 * Stands in for the bridge, so it can record the `create` / `manage` frames the UI puts on the wire.
 *
 * Run: node probes/round16-pin.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7910;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round16-pin/shots";
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
const base = (id, name, cwd, extra = {}) => ({ id, name, cwd, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", ...extra });
const A = base("probe-a", "一置顶着的会话", "F:/pi-web-client");
const NEW = base("probe-new", "", "F:/pi-web-client/sub", { preview: "刚建的" });
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let manage = { pin: [A.id], order: [A.id], archived: [] };
const creates = [];
const arrangements = [];
let sock = null;
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
const hello = (ws, sessions) => ws.send(JSON.stringify({ type: "hello", me: ME, sessions, manage, trash: [], tunnel: TUNNEL }));
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
      const state = msg.sessionId === A.id ? A : NEW;
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: [], approvals: [], asks: [], budget: null }));
      return;
    }
    // Q-022: the strip's ＋ must ask for the pin on the wire; the bridge owns the arrangement.
    if (msg.type === "create") {
      creates.push(msg);
      ws.send(JSON.stringify({ type: "session", sessionId: NEW.id, state: NEW, items: [], approvals: [], asks: [], budget: null }));
      ws.send(JSON.stringify({ type: "session.state", session: NEW }));
      if (msg.pin) {
        manage = { ...manage, pin: [...manage.pin.filter((id) => id !== NEW.id), NEW.id] };
        ws.send(JSON.stringify({ type: "manage", manage }));
      }
      return;
    }
    if (msg.type === "manage" && msg.action === "arrange") {
      arrangements.push(msg);
      manage = { pin: msg.pin ?? [], order: msg.order ?? [], archived: manage.archived };
      ws.send(JSON.stringify({ type: "manage", manage }));
    }
  });
  hello(ws, [A]);
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");

  // 0) The ordinary 开新会话 button stays a plain create — only the strip's ＋ pins (decision 4).
  await page.locator(".new-session [data-act=\"new\"]").click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 5000, "new-session sheet");
  // The sheet's 浏览 pane lists the start directory on mount and writes the result back into the
  // field — let that settle before typing, or the listing overwrites the typed path.
  await sleep(700);
  await page.locator(".sheet.new-sheet .ns-row .ns-input.mono").first().fill("F:/pi-web-client");
  await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
  await until(async () => creates.length >= 1, 5000, "create frame");
  assert(!("pin" in creates[0]), `the sidebar button does not pin (got ${JSON.stringify(creates[0])})`);
  log("sidebar create:", JSON.stringify({ type: creates[0].type, cwd: creates[0].cwd, pin: creates[0].pin }));
  await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 5000, "sheet closes");

  // 1) Collapse the left pane: the strip is now the only way in, so its ＋ must pin.
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".pin-strip .pin-chip").count()) >= 1, 8000, "pin strip with one chip");
  assert(await page.locator(".pin-strip").isVisible(), "the strip is visible with the left pane collapsed");

  // 2) The chip is a container with two hit areas (a button cannot nest a button).
  const chip = page.locator(".pin-strip .pin-chip").first();
  assert((await chip.locator(".pin-star").count()) === 1, "the chip has a ★ button");
  assert((await chip.locator(".pin-open").count()) === 1, "the chip has an open area");
  const star = chip.locator(".pin-star");
  assert((await star.getAttribute("aria-label")).startsWith("取消置顶"), "the ★ says what it does");
  log("chip text:", (await chip.innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(OUT, "1-strip.png") });

  // 3) Clicking ★ un-pins without opening the session.
  await star.click();
  await until(async () => arrangements.length >= 1, 5000, "arrange frame");
  const arr = arrangements[0];
  assert(!arr.pin.includes(A.id), `the star removes the pin (got ${JSON.stringify(arr.pin)})`);
  assert(!arr.order.includes(A.id), `the star clears the order slot too (got ${JSON.stringify(arr.order)})`);
  assert((await page.locator(".pin-strip .pin-open").count()) === 0, "the chip disappears after un-pinning");
  // The clicked ★ no longer exists — focus must land on something usable, not on <body>.
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}.${a.className}` : "null";
  });
  log("focus after un-pin:", focused);
  assert(focused.includes("pin-new"), `focus falls back to the ＋ (got ${focused})`);

  // 4) ＋ opens the sheet and the create frame carries pin:true.
  await page.locator(".pin-strip .pin-new").click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 5000, "new-session sheet from ＋");
  await sleep(700);
  await page.locator(".sheet.new-sheet .ns-row .ns-input.mono").first().fill("F:/pi-web-client/sub");
  await page.locator(".sheet.new-sheet .dir-foot .btn.primary").click();
  await until(async () => creates.length >= 2, 5000, "create frame from ＋");
  const second = creates[1];
  log("strip create:", JSON.stringify({ cwd: second.cwd, pin: second.pin }));
  assert(second.pin === true, `the strip's ＋ asks for a pin (got ${JSON.stringify(second.pin)})`);
  assert(second.cwd === "F:/pi-web-client/sub", `the cwd is the one typed (got ${JSON.stringify(second.cwd)})`);

  // 5) The bridge echoes the arrangement → the new session sits at the end of the strip, next to ＋.
  await until(async () => (await page.locator(".pin-strip .pin-open").count()) === 1, 5000, "the new chip arrives");
  const chips = page.locator(".pin-strip .pin-chip:not(.pin-new):not(.pin-expand)");
  assert((await chips.count()) === 1, `exactly one pinned chip (got ${await chips.count()})`);
  const last = await chips.last().innerText();
  log("new chip:", last.replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(OUT, "2-pinned-new.png") });
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
