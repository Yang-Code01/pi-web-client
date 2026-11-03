/**
 * Probe: D63 — 预览里的链接点了之后能返回。
 *
 * 用**真的** bridge 模块（bridge/dist/preview.js 的 openPreview + serveRaw）当假桥，所以注入脚本、
 * token 换发、越界 403 全是生产路径；探针只负责页面和断言。
 *
 * 覆盖：链接跳转后记一步 / ← 回退 / → 前进 / 外链也记一步（iframe 白屏但回得来）/
 *      ⟳ 不多记一步 / #锚点不算一步 / 换会话各一份 / 关预览不丢历史 / 回放滚动位置。
 *
 * Run: node probes/round23-nav.mjs   (needs `npm run build:web` and `npm run build:bridge` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;
const previewMod = await import(pathToFileURL("F:/pi-web-client/bridge/dist/preview.js").href);

const PORT = 7917;
const DIST = "F:/pi-web-client/web/dist";
const SCRATCH = "F:/pi-web-client/.scratch/round23-nav";
const OUT = `${SCRATCH}/shots`;
const WORK = `${SCRATCH}/work`;
const OTHER = `${SCRATCH}/other`;
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OTHER, { recursive: true });

const PAD = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 段，用来把页面撑长一点，好试滚动回放。</p>`).join("\n");
fs.writeFileSync(`${WORK}/page1.html`, `<!doctype html><html><head><meta charset="utf-8"><title>第一页</title></head>
<body><h1 id="top">第一页</h1>
<p><a href="page2.html">去第二页</a></p>
<p><a href="#top">页内锚点</a></p>
<p><a href="http://127.0.0.1:${PORT}/away">一个外站链接</a></p>
</body></html>`);
fs.writeFileSync(`${WORK}/page2.html`, `<!doctype html><html><head><meta charset="utf-8"><title>第二页</title></head>
<body><h1>第二页</h1>
<p><a href="page1.html">回第一页</a></p>
<p><a href="http://127.0.0.1:${PORT}/away">外站</a></p>
${PAD}
</body></html>`);
// GBK 页面：注入的脚本必须是纯 ASCII，响应头也不能锁 utf-8，否则老站点中文全花。
// 正文和链接文字都用 GBK 字节写进去（中文 = D6D0 CEC4，去第二页 = C8A5 B5DA B6FE D2B3）。
const gbkA = (s) => Buffer.from(s, "ascii");
fs.writeFileSync(
  `${WORK}/gbk.html`,
  Buffer.concat([
    gbkA('<!doctype html><html><head><meta charset="gbk"><title>gbk page</title></head><body><h1>'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    gbkA('</h1><p><a href="page2.html">'),
    Buffer.from([0xc8, 0xa5, 0xb5, 0xda, 0xb6, 0xfe, 0xd2, 0xb3]),
    gbkA("</a></p></body></html>"),
  ]),
);
fs.writeFileSync(`${OTHER}/page3.html`, `<!doctype html><html><head><meta charset="utf-8"><title>第三页</title></head>
<body><h1>第三页</h1></body></html>`);

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
    try {
      if (await fn()) return;
    } catch {
      /* keep polling */
    }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SESSIONS = [
  { id: "probe-a", name: "会话甲", cwd: WORK, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false },
  { id: "probe-b", name: "会话乙", cwd: OTHER, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now() - 1000, approvals: 0, asks: 0, locked: false },
];
const ITEMS_A = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "看看这两个页面" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, text: `第一页在 ${WORK}/page1.html，第二页在 ${WORK}/page2.html，GBK 页面在 ${WORK}/gbk.html` },
];
const ITEMS_B = [
  { kind: "user", id: "u2", ts: Date.now() - 40_000, text: "另一个会话" },
  { kind: "assistant", id: "a2", ts: Date.now() - 30_000, text: `第三页在 ${OTHER}/page3.html` },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ME));
  if (url.pathname === "/away") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<h1>外站</h1>");
  }
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
      const session = SESSIONS.find((s) => s.id === body.sessionId) ?? SESSIONS[0];
      try {
        // 生产路径：token、root、rel、注入都在这里头。
        const info = previewMod.openPreview({ cwd: session.cwd, file: null }, String(body.path ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(info));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    });
    return;
  }
  if (url.pathname.startsWith("/raw/")) {
    if (!previewMod.serveRaw(req, res, url.pathname)) res.writeHead(404, { "content-type": "text/plain" }).end("no");
    return;
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
      const s = SESSIONS.find((x) => x.id === msg.sessionId) ?? SESSIONS[0];
      const items = s.id === "probe-b" ? ITEMS_B : ITEMS_A;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const name = () => page.locator(".viewer-head .viewer-name");
const backBtn = () => page.locator(".viewer-nav .viewer-btn").first();
const fwdBtn = () => page.locator(".viewer-nav .viewer-btn").last();
const frame = () => page.frameLocator("iframe.viewer-frame");
const disabled = async (b) => await b.isDisabled();
const nameOf = async () => (await name().innerText()).trim();

let browser;
let page;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "session cards");
  await page.locator(".session-card", { hasText: "会话甲" }).first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) 打开 page1：两个按钮都该灰着
  await page.locator(".msg a", { hasText: "page1.html" }).first().click();
  await until(async () => (await nameOf()) === "page1.html", 8000, "page1 preview");
  await until(async () => (await page.locator("iframe.viewer-frame").count()) === 1, 8000, "iframe");
  assert(await disabled(backBtn()), "刚打开第一个文件时「←」该是灰的");
  assert(await disabled(fwdBtn()), "刚打开第一个文件时「→」该是灰的");
  log("1) opened page1, both nav buttons disabled");

  // 2) 页面里的相对链接：跳过去、记一步
  await until(async () => (await frame().locator("a", { hasText: "去第二页" }).count()) === 1, 8000, "link in page1");
  await frame().locator("a", { hasText: "去第二页" }).click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "page2 tracked");
  assert(!(await disabled(backBtn())), "跳到第二页后「←」该亮起来");
  assert(await disabled(fwdBtn()), "在最前面一步时「→」该是灰的");
  assert((await frame().locator("h1").innerText()) === "第二页", "iframe 里显示的该是第二页");
  log("2) clicked page2 link, header tracked, ← enabled");
  await page.screenshot({ path: path.join(OUT, "1-page2.png") });

  // 3) ← 回第一页（iframe 真的回到第一页）
  await backBtn().click();
  await until(async () => (await nameOf()) === "page1.html", 8000, "back to page1");
  await until(async () => (await frame().locator("h1").innerText()) === "第一页", 8000, "iframe shows page1 again");
  assert(await disabled(backBtn()), "回到栈底后「←」该重新变灰");
  assert(!(await disabled(fwdBtn())), "回到栈底后「→」该亮起来");
  log("3) ← back to page1");

  // 4) → 再回第二页
  await fwdBtn().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "forward to page2");
  await until(async () => (await frame().locator("h1").innerText()) === "第二页", 8000, "iframe shows page2 again");
  log("4) → forward to page2");

  // 5) 外链：iframe 会白掉，但必须记一步并且回得来
  await frame().locator("a", { hasText: "外站" }).first().click();
  await until(async () => !(await nameOf()).includes("page2"), 8000, "external step recorded");
  assert(!(await disabled(backBtn())), "点了外链之后「←」该亮着（这就是用户要的那一下）");
  log("5) external click recorded as step:", await nameOf());
  await backBtn().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "back from external");
  await until(async () => (await frame().locator("h1").innerText()) === "第二页", 8000, "page2 back after external");
  log("5b) ← came back from the external page");

  // 6) → 前进到外链那一格：给占位说明 + 出口
  await fwdBtn().click();
  await until(async () => (await page.locator(".viewer-msg.ext").count()) === 1, 8000, "ext placeholder");
  const extText = await page.locator(".viewer-msg.ext").innerText();
  assert(extText.includes("/away"), `外链占位里该有那个地址（拿到 ${JSON.stringify(extText.slice(0, 80))}）`);
  assert(extText.includes("回到上一个文件"), "外链占位要告诉人按 ← 能回去");
  assert((await page.locator(".viewer-msg.ext .btn").count()) === 1, "外链占位要有「在新标签打开」");
  log("6) forward into external shows placeholder");
  await page.screenshot({ path: path.join(OUT, "2-external.png") });

  // 7) 回到第一页，⟳ 不该多记一步
  await backBtn().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "back to page2 again");
  await backBtn().click();
  await until(async () => (await nameOf()) === "page1.html", 8000, "back to page1 again");
  assert(await disabled(backBtn()), "退到底了，⟳ 之前「←」是灰的");
  await page.locator(".viewer-tools .viewer-btn", { hasText: "⟳" }).first().click();
  await sleep(600);
  assert(await disabled(backBtn()), "⟳ 刷新不该往历史里多记一步");
  log("7) ⟳ does not add a step");

  // 8) 页内锚点不算一步
  await until(async () => (await frame().locator("a", { hasText: "页内锚点" }).count()) === 1, 8000, "anchor link");
  await frame().locator("a", { hasText: "页内锚点" }).click();
  await sleep(400);
  assert(await disabled(backBtn()), "#锚点不该算作一步");
  assert((await nameOf()) === "page1.html", "点锚点后仍该是第一页");
  log("8) in-page anchor ignored");

  // 9) 关预览不丢历史：关掉再打开，前进分支还在
  await page.locator(".viewer-tools .viewer-btn", { hasText: "✕" }).first().click();
  await until(async () => (await page.locator(".viewer-head").count()) === 0, 8000, "viewer closed");
  await page.locator(".msg a", { hasText: "page1.html" }).first().click();
  await until(async () => (await nameOf()) === "page1.html", 8000, "reopened page1");
  assert(await disabled(backBtn()), "重新打开 page1 时它就在栈顶，不该多一格");
  assert(!(await disabled(fwdBtn())), "关掉预览再打开，前进分支（page2）该还在");
  log("9) history survives closing the viewer");

  // 10) 滚动位置回放：在第二页滚一段，来回一趟要回到原处
  await fwdBtn().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "page2 for scroll");
  await until(async () => (await frame().locator("h1").innerText()) === "第二页", 8000, "page2 rendered");
  await frame().locator("h1").evaluate(() => window.scrollTo(0, 420));
  await sleep(400);
  // 用按钮来回，不要点 iframe 里的链接：那会算成新的一步、把前进分支截断（和浏览器一致）。
  await backBtn().click();
  await until(async () => (await nameOf()) === "page1.html", 8000, "left page2");
  await fwdBtn().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "forward to page2 again");
  await sleep(800);
  const scrolled = await frame().locator("h1").evaluate(() => window.scrollY);
  log("10) scrollY after round trip:", scrolled);
  assert(Math.abs(scrolled - 420) <= 60, `回到第二页时该回到原来的滚动位置（期望 ~420，拿到 ${scrolled}）`);

  // 11) 换会话各一份：会话乙的历史是空的
  //    （预览面板开着的时候 iframe 会盖住对话里的链接，先关掉再点）
  await page.locator(".viewer-tools .viewer-btn", { hasText: "✕" }).first().click();
  await until(async () => (await page.locator(".viewer-head").count()) === 0, 8000, "viewer closed before switching");
  await page.locator(".session-card", { hasText: "会话乙" }).first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "session b messages");
  await page.locator(".msg a", { hasText: "page3.html" }).first().click();
  await until(async () => (await nameOf()) === "page3.html", 8000, "page3 preview");
  assert(await disabled(backBtn()), "会话乙第一次开文件，「←」该是灰的（历史按会话分开）");
  log("11) session B has its own empty history");
  await page.screenshot({ path: path.join(OUT, "3-session-b.png") });

  // 12) 切回会话甲：它的历史还在
  await page.locator(".viewer-tools .viewer-btn", { hasText: "✕" }).first().click();
  await until(async () => (await page.locator(".viewer-head").count()) === 0, 8000, "viewer closed before switching back");
  await page.locator(".session-card", { hasText: "会话甲" }).first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "back to session a");
  await page.locator(".msg a", { hasText: "page2.html" }).first().click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "page2 in session a");
  assert(!(await disabled(backBtn())), "切回会话甲，它的返回栈该还在");
  log("12) session A history preserved");

  // 13) GBK 编码的老页面：中文不能变乱码，链接照样记步
  await page.locator(".viewer-tools .viewer-btn", { hasText: "✕" }).first().click();
  await until(async () => (await page.locator(".viewer-head").count()) === 0, 8000, "viewer closed for gbk");
  await page.locator(".msg a", { hasText: "gbk.html" }).first().click();
  await until(async () => (await nameOf()) === "gbk.html", 8000, "gbk preview");
  await until(async () => (await frame().locator("h1").innerText()).trim() === "中文", 8000, "gbk page decoded");
  await frame().locator("a", { hasText: "去第二页" }).click();
  await until(async () => (await nameOf()) === "page2.html", 8000, "gbk page link tracked");
  log("13) gbk page stays readable and still tracks");

  console.log(process.exitCode ? "\nFAILED" : "\nALL OK");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
