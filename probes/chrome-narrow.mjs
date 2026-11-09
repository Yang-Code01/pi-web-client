/**
 * Probe: 窄屏「开关优先」（#281 / #292）。
 *
 * D138 在 560px 以下用 CSS 把「📁 文件管理器」藏掉。`true` 是**显式显示**：根元素带
 * `data-chrome-narrow="files"`，样式表里排在 D138 之后的那条规则把那颗顶回来；没人动过（没键）
 * 与显式 `false` 各自保持今天的默认 / 全宽不画。纯函数的表格在 `web/tests/chrome-unit.mjs`，
 * 这里把关的是浏览器里那三态，以及 390 与 560–620 过渡处页面不横向溢出：
 * `documentElement.scrollWidth == 视口宽`。
 *
 * Run: npm run build:web && node probes/chrome-narrow.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.CHROME_DIST ? path.resolve(process.env.CHROME_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7932);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const state = (id, name, cwd) => ({
  id,
  name,
  cwd,
  ws: "f:/proj-01",
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
  owned: true,
});
const SESSIONS = [state("s-1", "窄屏会话", "F:/proj-01")];
const GROUP = { id: "f:/proj-01", name: "proj-01", key: "F:/proj-01", manual: false };
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const workspace = () => ({ groups: [GROUP], overrides: {}, keys: { "f:/proj-01": GROUP.id } });

/** 桥端那份偏好：`undefined` 表示删键（回默认）。 */
let chrome = {};
const uiPayload = () => ({ showExtButton: chrome.ext !== false, chrome: { ...chrome } });

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
const broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  for (const ws of clients) ws.send(raw);
};
/** 改偏好像「另一台设备动了开关」：广播 `ui`，走真实的重画路径。 */
async function setChrome(patch) {
  for (const [id, choice] of Object.entries(patch)) {
    if (choice === undefined) delete chrome[id];
    else chrome[id] = choice;
  }
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(180);
}

server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "ui.get") ws.send(JSON.stringify({ type: "ui", ui: uiPayload() }));
    });
    ws.send(
      JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace(), ui: uiPayload() }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

/** 那颗按钮在不在「看得见」的那一侧（CSS 的 `display:none` 与 `hidden` 都算）。 */
const seen = (page, act) =>
  page.evaluate((a) => {
    const n = document.querySelector(`.topbar [data-act="${a}"]`);
    return Boolean(n) && n.getClientRects().length > 0;
  }, act);
const dom = (page) =>
  page.evaluate(() => {
    const top = document.querySelector(".topbar");
    const r = top?.getBoundingClientRect();
    return {
      marker: document.documentElement.getAttribute("data-chrome-narrow"),
      acts: Array.from(document.querySelectorAll(".topbar [data-act]"))
        .filter((n) => n.getClientRects().length > 0)
        .map((n) => n.dataset.act),
      topScroll: top ? Math.round(top.scrollWidth) : -1,
      topClient: top ? Math.round(top.clientWidth) : -1,
      topOverflowX: top ? getComputedStyle(top).overflowX : "",
      topRight: r ? Math.round(r.right) : -1,
      docScroll: Math.round(document.documentElement.scrollWidth),
      viewport: Math.round(document.documentElement.clientWidth),
      title: document.querySelector('.topbar [data-act="files"]')?.title ?? "",
    };
  });
/** D138 的口径：断言文档宽度，不看截图。 */
const docFits = (d) => d.docScroll <= d.viewport;
const topbarFits = (d) => d.topRight <= d.viewport;
const filesSeen = (d) => d.acts.includes("files");

const errors = [];
const newPage = async (width) => {
  const page = await (await browser.newContext({ viewport: { width, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log(`pageerror(${width}):`, e.message);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(300);
  return page;
};
const openSession = async (page, id) => {
  await page.evaluate((sid) => {
    location.hash = `#/s/${sid}`;
  }, id);
  await page.waitForFunction(() => document.querySelector(".topbar .title")?.textContent !== "pi", null, { timeout: 8000 });
  await sleep(300);
};
/** 改视口宽度 = 拖窗口跨过 560，走页面自己的 resize → paintChrome 路径。 */
const resize = async (page, width) => {
  await page.setViewportSize({ width, height: 820 });
  await sleep(320);
};

// ---------------------------------------------------------------- 390 的三种状态
{
  chrome = {};
  const page = await newPage(390);

  // 没键：与今天完全一样 —— 没有标记，文件管理器不画，文档不横向溢出。
  let d = await dom(page);
  ok(d.marker === null, "390、没键：根元素没有 data-chrome-narrow（D138 原样）");
  ok(!filesSeen(d), "390、没键：文件管理器不画（与今天一样）");
  ok(docFits(d), `390、没键：页面不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 没会话 + 显式 true：标记在，但 hidden 仍赢，那颗不复活。
  await setChrome({ files: true });
  d = await dom(page);
  ok(d.marker === "files", "390、没会话、files:true：标记照写");
  ok(!filesSeen(d), "390、没会话、files:true：仍然不画（hidden 赢过覆盖规则）");
  ok(d.title.includes("没开会话"), `390、没会话、files:true：title 说明原因（${d.title}）`);
  ok(docFits(d), `390、没会话、files:true：不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 开会话之后，显式 true 才真的出现在窄屏顶栏里。
  await openSession(page, "s-1");
  d = await dom(page);
  ok(d.marker === "files", "390、files:true、开会话：根元素带 data-chrome-narrow=\"files\"");
  ok(filesSeen(d), "390、files:true、开会话：文件管理器出现");
  ok(docFits(d), `390、files:true、开会话：文档不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  ok(topbarFits(d), `390、files:true、开会话：顶栏盒子不出视口（right ${d.topRight} <= ${d.viewport}）`);
  ok(d.topOverflowX === "auto", `390、files:true、开会话：排不下时顶栏自己滚（overflow-x: ${d.topOverflowX}）`);

  // 删键：回到没动过的默认，标记与那颗一起退场。
  await setChrome({ files: undefined });
  d = await dom(page);
  ok(d.marker === null, "390、删键：标记撤掉，D138 重新生效");
  ok(!filesSeen(d), "390、删键：文件管理器回到默认不画");
  ok(docFits(d), `390、删键：不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 显式 false：任何宽度都不画。
  await setChrome({ files: false });
  d = await dom(page);
  ok(d.marker === null && !filesSeen(d), "390、files:false：不画、也不带标记");
  ok(docFits(d), `390、files:false：不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  await resize(page, 620);
  d = await dom(page);
  ok(!filesSeen(d), "620、files:false：宽屏也不画");
  ok(docFits(d), `620、files:false：不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  await resize(page, 1440);
  d = await dom(page);
  ok(!filesSeen(d), "1440、files:false：任何宽度都不画");
  ok(docFits(d), `1440、files:false：不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 560–620 过渡：真值不随宽度翻，就没有闪烁 / 半状态。
  await setChrome({ files: true });
  for (const width of [1440, 620, 561, 560, 559, 390]) {
    await resize(page, width);
    d = await dom(page);
    ok(filesSeen(d) && d.marker === "files", `${width}、files:true：跨 560 也一直画（不是半状态）`);
    ok(docFits(d), `${width}、files:true：不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  }

  // 默认态跨 560：隐藏只由 D138 的媒体查询决定，560 及以下不画、561 起画。
  await setChrome({ files: undefined });
  for (const width of [390, 559, 560, 561, 620]) {
    await resize(page, width);
    d = await dom(page);
    const want = width > 560;
    ok(filesSeen(d) === want, `${width}、没键：${want ? "画" : "不画"}（D138 的默认）`);
    ok(d.marker === null, `${width}、没键：不带标记`);
    ok(docFits(d), `${width}、没键：不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  }

  await page.context().close();
}

ok(errors.length === 0, `页面没有 JS 异常（${errors.length}）`);

await browser.close();
wss.close();
server.close();
console.log(bad ? `\n${bad} FAIL` : "\nall ok");
process.exit(bad ? 1 : 0);
