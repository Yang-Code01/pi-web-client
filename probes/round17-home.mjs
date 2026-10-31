/**
 * Probe: Q-019 — every directory browser carries a ⌂ 工作目录 button that jumps back to the
 * session's cwd (no session → the button is there but disabled, so the absence is explained).
 *
 * Stands in for the bridge, so `/api/dirs` can pretend the machine has a couple of folders.
 *
 * Run: node probes/round17-home.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7911;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round17-home/shots";
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
const A = { id: "probe-home", name: "有工作目录的会话", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "定位探针" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

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
  if (url.pathname === "/api/dirs") {
    const dir = url.searchParams.get("path") ?? "";
    const files = url.searchParams.get("files") === "1";
    if (!dir) return json(200, { path: "", parent: null, dirs: ["C:", "F:"], files: [], error: "" });
    // Two folders deep, so the probe can walk away from the cwd and then come back with ⌂.
    return json(200, {
      path: dir,
      parent: dir === "F:/pi-web-client" ? "F:" : "F:/pi-web-client",
      // A name that is not a substring of the cwd — "web" would match "pi-web-client" by accident.
      dirs: dir === "F:/pi-web-client" ? ["subfolder", "bridge"] : [],
      files: files ? ["package.json"] : [],
      error: "",
    });
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
      ws.send(JSON.stringify({ type: "session", sessionId: A.id, state: A, items: [], approvals: [], asks: [], budget: null }));
    }
  });
  // Starts with no sessions: the first half of the probe is the "there is no cwd yet" case.
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
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
  await until(async () => (await page.locator(".new-session [data-act=\"new\"]").count()) >= 1, 8000, "new-session button");

  // 1) No session → the button exists, disabled, and says why (an absent button reads as a bug).
  await page.locator(".new-session [data-act=\"new\"]").click();
  await until(async () => page.locator(".sheet.new-sheet").isVisible(), 5000, "new-session sheet");
  await page.locator(".sheet.new-sheet .ns-row .btn.ghost", { hasText: "浏览" }).click();
  const sheetHome = page.locator(".sheet.new-sheet .dir-head [data-act=\"dir-home\"]");
  await until(async () => sheetHome.isVisible(), 5000, "⌂ inside the sheet's browser");
  const label = (await sheetHome.innerText()).trim();
  log("label:", label, "| disabled:", await sheetHome.isDisabled(), "| title:", await sheetHome.getAttribute("title"));
  assert(label.includes("工作目录"), `the button is labelled 工作目录 (got ${JSON.stringify(label)})`);
  assert(await sheetHome.isDisabled(), "without a session it is disabled");
  assert(String(await sheetHome.getAttribute("title")).includes("还没有会话"), "the tooltip explains why it is disabled");
  await page.screenshot({ path: path.join(OUT, "1-no-session.png") });
  await page.locator(".sheet.new-sheet .sheet-head .btn.ghost", { hasText: "取消" }).click();
  await until(async () => (await page.locator(".sheet.new-sheet").count()) === 0, 5000, "sheet closes");

  // 2) With a session: the file explorer's browser starts at the cwd, walks away, and ⌂ brings it back.
  send({ type: "session.state", session: A });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 5000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => await page.locator("[data-act=\"files\"]").isVisible(), 8000, "file explorer button");
  await page.locator("[data-act=\"files\"]").click();
  const home = page.locator(".viewer [data-act=\"dir-home\"]").first();
  await until(async () => home.isVisible(), 8000, "⌂ in the file explorer");
  assert(!(await home.isDisabled()), "with a session it is enabled");
  log("explorer title:", await home.getAttribute("title"));

  await page.locator(".viewer .dir-row", { hasText: "subfolder" }).first().click();
  await until(async () => (await page.locator(".viewer .dir-path").first().innerText()).trim().endsWith("subfolder"), 5000, "walked into subfolder/");
  log("walked to:", (await page.locator(".viewer .dir-path").first().innerText()).replace(/\s+/g, " "));

  await home.click();
  await until(async () => {
    const crumbs = (await page.locator(".viewer .dir-path").first().innerText()).replace(/\s+/g, " ").trim();
    return crumbs.endsWith("pi-web-client");
  }, 5000, "⌂ jumps back to the session cwd");
  const back = (await page.locator(".viewer .dir-path").first().innerText()).replace(/\s+/g, " ").trim();
  log("after ⌂:", back);
  assert(back.includes("pi-web-client"), `back at the cwd (got ${JSON.stringify(back)})`);
  await page.screenshot({ path: path.join(OUT, "2-back-home.png") });

  // 3) ⌂ is a no-op when the browser is already there — it must not crash or blank the list.
  await home.click();
  await sleep(400);
  assert((await page.locator(".viewer .dir-row").count()) >= 1, "the list survives a redundant ⌂");
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
