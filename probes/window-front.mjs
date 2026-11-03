/**
 * Probe: D94 — 文件预览与终端是两扇平等的浮窗，谁最后被点 / 聚焦谁在上面。
 *
 * 用真 Chromium 量 `elementFromPoint`，而不是只看 class：断言的是「重叠那一块现在归谁」。
 *   1. 只开预览：面板在最上面；
 *   2. 打开终端：终端盖过预览（重叠点命中 .term-dock），预览回落到 46；
 *   3. 点预览的可见区域（终端上方）：预览盖回来（重叠点命中 .viewer）；
 *   4. 点终端的可见区域（预览左边）：终端又盖上去；
 *   5. 点进预览里的 iframe（指针事件不跨文档，只有 window blur）：预览仍然能盖回来；
 *   6. 两扇窗的 z-index 始终 ≤ 47，仍低于口令 modal（50）。
 *
 * Stands in for the bridge: /api/preview + /raw 给预览，term.open 回一个不接 pty 的标签
 * （xterm 只要 term.opened 就能挂上，输入框不参与本探针）。
 *
 * Run: npm run build:web && node probes/window-front.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7921;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/window-front/shots";
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";
const MD = "F:/pi-web-client/docs/DECISIONS.md";
const HTML = "F:/pi-web-client/docs/demo.html";
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
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-front", name: "浮窗叠放", cwd: CWD, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "浮窗" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "浮窗叠放" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "打开左边的预览和终端，点谁谁在上面。" },
];

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
  if (url.pathname === "/api/preview" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      const want = String(body.path ?? "");
      const html = want === HTML;
      const abs = html ? HTML : MD;
      const name = path.basename(abs);
      return json(200, { token: "tok", rel: name, name, abs, root: CWD, size: 40, mtime: Date.now(), kind: html ? "html" : "markdown" });
    });
    return;
  }
  if (url.pathname.startsWith("/raw/")) {
    const html = url.searchParams.get("path") === HTML || url.pathname.includes("demo");
    res.writeHead(200, { "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
    return res.end(html ? "<!doctype html><body style='margin:0;background:#123;height:100vh'><p id='in'>iframe 内容</p></body>" : "# 预览\n\n这是预览面板里的内容。");
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
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SES.id, state: SES, items: ITEMS, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "term.open") {
      ws.send(JSON.stringify({ type: "term.opened", id: "probe-front-term", shell: "PowerShell", cwd: msg.cwd ?? CWD }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

/** 重叠点的归属：命中元素最近的浮窗类名，没有就返回 null。 */
const hitAt = (page, x, y) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      const win = el?.closest?.(".viewer, .term-dock");
      const z = (sel) => {
        const n = document.querySelector(sel);
        return n ? getComputedStyle(n).zIndex : null;
      };
      return {
        win: win ? (win.classList.contains("viewer") ? "viewer" : "term") : null,
        front: win ? win.classList.contains("front") : false,
        viewerZ: z(".viewer"),
        termZ: z(".term-dock"),
      };
    },
    [x, y],
  );

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) 先开终端（顶栏那颗按钮只在没有预览盖住时点得到 —— 这正是这次要解决的问题之一）
  await page.locator('[data-act="terminal"]').click();
  await until(async () => await page.locator(".term-dock").isVisible(), 8000, "terminal dock");
  await sleep(250);
  const tBox = await page.locator(".term-dock").boundingBox();
  log("terminal box:", tBox);

  // 2) 打开 markdown 预览 → 它刚被打开，所以在最上面
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: p } })), MD);
  await until(async () => (await page.locator(".viewer-body").innerText().catch(() => "")).includes("预览面板里"), 8000, "markdown preview");
  const vBox = await page.locator(".viewer").boundingBox();
  // 重叠区域：预览左沿到终端右沿、终端顶边到底边之间。
  const OVERLAP = { x: Math.round((vBox.x + tBox.x + tBox.width) / 2), y: Math.round((tBox.y + tBox.y + tBox.height) / 2) };
  log("viewer box:", vBox, "overlap point:", OVERLAP);
  let hit = await hitAt(page, OVERLAP.x, OVERLAP.y);
  assert(hit.win === "viewer" && hit.front, `打开预览后它盖过终端（拿到 ${hit.win} / front=${hit.front}）`);
  assert(hit.viewerZ === "47" && hit.termZ === "45", `预览 47 / 终端 45（拿到 ${hit.viewerZ} / ${hit.termZ}）`);
  await page.screenshot({ path: path.join(OUT, "1-viewer-front.png") });

  // 3) 点终端左侧那块可见区域 → 终端回到最上面
  await page.mouse.click(300, Math.round(tBox.y + tBox.height / 2));
  await sleep(200);
  hit = await hitAt(page, OVERLAP.x, OVERLAP.y);
  log("after clicking terminal:", hit);
  assert(hit.win === "term" && hit.front, `点终端后它盖过预览（拿到 ${hit.win} / front=${hit.front}）`);
  assert(hit.termZ === "47" && hit.viewerZ === "46", `终端 47 / 预览 46（拿到 ${hit.termZ} / ${hit.viewerZ}）`);
  await page.screenshot({ path: path.join(OUT, "2-terminal-front.png") });

  // 4) 点预览上方那块可见区域 → 预览盖回来
  await page.mouse.click(1300, 200);
  await sleep(200);
  hit = await hitAt(page, OVERLAP.x, OVERLAP.y);
  log("after clicking viewer:", hit);
  assert(hit.win === "viewer" && hit.front, `点预览后它盖过终端（拿到 ${hit.win} / front=${hit.front}）`);
  await page.screenshot({ path: path.join(OUT, "3-viewer-back.png") });

  // 5) html 预览里的 iframe：点进 iframe 只有 window blur，预览仍要盖回来
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: p } })), HTML);
  await until(async () => (await page.locator(".viewer-frame").count()) === 1, 8000, "html iframe");
  await until(async () => await page.locator(".viewer-frame").isVisible(), 4000, "iframe visible");
  // 先把终端放回最上面，这样「盖回来」只能归功于 iframe 里的那一下点击。
  await page.mouse.click(300, Math.round(tBox.y + tBox.height / 2));
  await sleep(200);
  hit = await hitAt(page, OVERLAP.x, OVERLAP.y);
  assert(hit.win === "term", `iframe 测试前终端在最上面（拿到 ${hit.win}）`);
  await page.mouse.click(1300, 200);
  await sleep(300);
  hit = await hitAt(page, OVERLAP.x, OVERLAP.y);
  log("after clicking into iframe:", hit);
  assert(hit.win === "viewer" && hit.front, `点进 iframe 后预览仍能盖回来（拿到 ${hit.win} / front=${hit.front}）`);
  await page.screenshot({ path: path.join(OUT, "4-iframe-front.png") });

  // 6) 层带不越过模态：47 < 口令 modal 50
  const caps = await page.evaluate(() => ({
    modal: [...document.styleSheets]
      .flatMap((s) => {
        try {
          return [...s.cssRules];
        } catch {
          return [];
        }
      })
      .filter((r) => r.selectorText === ".modal")
      .map((r) => r.style.zIndex)[0],
  }));
  log("modal z-index rule:", caps.modal);
  assert(Number(caps.modal) > 47, `口令 modal 仍压在两扇浮窗之上（modal=${caps.modal}）`);

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
