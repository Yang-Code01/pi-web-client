/**
 * Probe: #744 — 右栏那四颗页签（需要你 / 执行 / 浏览器 / 代码评审）滚起来要贴顶。
 *
 * 症状：`.exec-tabs` 是 `.queue` 的第一个子元素，而 `.queue` 整体跟着 `.pane` 一起滚；评审面板的
 * 输入那么多，滚到中间就再也点不到别颗页签，只能一路滚回顶。
 *
 * 做法（D418 那套材质）：页签条外面包一层 `.exec-tabs-bar`，桌面三栏里 `position: sticky; top: 0`，
 * 用负边距吃掉 `.queue` 的 12px 上 / 左右内边距铺满整栏，底子是跟主题走的玻璃 + 毛玻璃 + 0.5px 描边，
 * 且不随滚动变样（不监听 scroll、无淡入淡出）。窄版（手机，右栏铺满整屏）不贴顶。
 *
 * 这里量的是浏览器里才成立的那半：贴住的位置、铺满的宽度、玻璃是否真的挡得住、切页签归零、
 * 放大后仍然贴住、窄版一像素不变。fixture 只负责让右栏够长好滚（二十张真的批准卡），不去伪造
 * 评审面板的数据。
 *
 * Run: npm --prefix web run build && node probes/queue-tabs-sticky.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST as DIST_RAW, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "./port.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7947));
const DIST = path.resolve(DIST_RAW);
const OUT = path.join(REPO, ".scratch/queue-tabs-sticky/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 下面几个助手都要用它；在 `try` 里才 newPage()，所以先声明、别在助手后面再 `let`。 */
let page;
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
// 右栏要够长才谈得上滚动：二十张真的批准卡（`.exec-tabs` 下面是它们），不垫假 div ——
// 整栏重画时垫进去的东西会被抹掉，连已经滚到的位置一起归零，探针会假红。
const APPROVALS = Array.from({ length: 20 }, (_, i) => ({
  id: `ap-${i + 1}`,
  sessionId: "probe-tabs",
  title: `第 ${i + 1} 条批准`,
  message: "这条只为把右栏撑长，好让页签条非贴顶不可。",
  createdAt: Date.now() - i * 1000,
}));
const SESSION = { id: "probe-tabs", name: "页签探针", cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: APPROVALS.length, asks: 0, locked: false, preview: "量页签条贴顶" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

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
  const file = path.resolve(DIST, rel);
  // 前缀要比带分隔符的那份：只比 `DIST` 的话 `/…/dist-evil/x` 也会通过。
  const inside = file === DIST || file.startsWith(DIST + path.sep);
  if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [], approvals: APPROVALS, asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/**
 * 打开右栏。窄版只有一屏一个栏（底部页签），得先切过去 —— 150% 那一段在 1280 的窗口里就已经是
 * 窄版了（有效宽度 853 < 900），别以为它还是三栏。
 */
const openQueueRail = async () => {
  const tab = page.locator('.tabs button[data-tab="queue"]');
  if (await page.evaluate(() => document.documentElement.dataset.compact === "true")) await tab.click();
  await until(async () => (await page.locator('.pane[data-region="queue"] .exec-tabs-bar').count()) === 1, 8000, "tab bar");
  // 页签选择是记在 localStorage 里的：第 4 段点过「代码评审」，重载之后还停在那里（那边没有内容
  // 可滚）。撑长右栏的是「需要你」里的批准卡，所以下面两段先切回来。
  const needs = page.locator('.pane[data-region="queue"] .exec-tabs button[data-exec-tab="needs"]');
  if ((await needs.getAttribute("aria-selected")) !== "true") await needs.click();
  await until(async () => (await metrics()).scrollable > 300, 8000, "queue to overflow");
};

/**
 * 截图里某块矩形「最多的那个颜色」：量像素用，跟 `probes/selection-visible.mjs` 那套一样 —— 截图回
 * 页内画到 canvas 再读，不依赖 PNG 解码库。`clip` 用的是 CSS px（与 `getBoundingClientRect` 同一套）。
 */
const sampleRect = async (rect) => {
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(
    async ({ b64 }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let mode = 0;
      let best = -1;
      for (const [k, n] of counts) if (n > best) [mode, best] = [k, n];
      return [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255];
    },
    { b64: png.toString("base64") },
  );
};

/** 页签条与它所在的栏：位置、宽度、材质、能不能点。量的是视觉 px —— `#app` 的 zoom 会把两边一起缩放，差值仍然可比。 */
const metrics = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane[data-region="queue"]');
    const bar = pane.querySelector(".exec-tabs-bar");
    const tabs = pane.querySelector(".exec-tabs");
    const pr = pane.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const bs = getComputedStyle(bar);
    const hit = document.elementFromPoint(Math.round(br.left + br.width / 2), Math.round(br.top + 4));
    // 「内容真的从条下面过」：有一张批准卡横跨条的下沿，说明滚出去的不止一像素。
    const underBar = [...pane.querySelectorAll(".queue .approval")].some((card) => {
      const r = card.getBoundingClientRect();
      return r.top < br.bottom - 1 && r.bottom > br.bottom + 1;
    });
    return {
      scrollTop: pane.scrollTop,
      scrollable: pane.scrollHeight - pane.clientHeight,
      position: bs.position,
      background: bs.backgroundColor,
      blur: bs.backdropFilter || bs.webkitBackdropFilter,
      borderBottom: bs.borderBottomWidth,
      barTopFromPane: br.top - pr.top,
      barLeftFromPane: br.left - pr.left,
      barRightFromPane: pr.right - br.right,
      // 铺满的判据：条的盒子 = `.pane` 的内容盒（clientWidth 已经扣过边框与滚动条，别再减一次）
      paneInner: pane.clientWidth,
      barWidth: br.width,
      grooveInsetLeft: tabs.getBoundingClientRect().left - br.left,
      hitInBar: Boolean(hit && bar.contains(hit)),
      underBar,
    };
  });

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  // 外观默认 125%，量到的每个数都会被乘一遍；先钉在 100%，第 5 段再自己调到 150%。
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1 }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await openQueueRail();

  // ---------------------------------------------------------------- 1. 静止：看起来和以前一样
  const rest = await metrics();
  ok(rest.position === "sticky", `桌面三栏：页签条是 sticky（实际 ${rest.position}）`);
  ok(Math.abs(rest.barTopFromPane) <= 1, `静止时玻璃条已经贴住栏顶，占掉的就是原来那 12px 内边距（差 ${rest.barTopFromPane.toFixed(1)}px）`);
  ok(Math.abs(rest.grooveInsetLeft - 12) <= 1.5, `灰槽仍内缩 12px，静止观感没变（实际 ${rest.grooveInsetLeft.toFixed(1)}px）`);
  ok(Math.abs(rest.barLeftFromPane) <= 1 && Math.abs(rest.barRightFromPane) <= 1, "玻璃条两侧贴住栏的内容盒（不留缝）");
  ok(Math.abs(rest.barWidth - rest.paneInner) <= 1, `条宽 ${rest.barWidth.toFixed(1)} 正好等于栏的内容盒 ${rest.paneInner}（不多不少，不是靠溢出裁出来的）`);

  // ---------------------------------------------------------------- 2. 滚到底：条不动、内容从下面过
  const beforeScroll = await metrics();
  await page.evaluate(() => {
    const pane = document.querySelector('.pane[data-region="queue"]');
    pane.scrollTop = pane.scrollHeight;
  });
  await sleep(120);
  const scrolled = await metrics();
  ok(scrolled.scrollTop > 400, `栏真的滚了（scrollTop ${Math.round(scrolled.scrollTop)}）`);
  ok(Math.abs(scrolled.barTopFromPane) <= 1, `滚到底页签条仍停在栏顶（差 ${scrolled.barTopFromPane.toFixed(1)}px）`);
  ok(scrolled.hitInBar, "条顶那一行点到的是页签条，不是从下面过的内容");
  ok(scrolled.underBar, "内容确实从条的下沿穿过（不是只有一两像素的滚动）");
  await page.locator('.pane[data-region="queue"]').screenshot({ path: path.join(OUT, "scrolled.png") });

  // ---------------------------------------------------------------- 3. 底子恒定、挡得住
  ok(scrolled.background === beforeScroll.background, `底色不随滚动变（${scrolled.background}）`);
  ok((scrolled.blur ?? "none") === (beforeScroll.blur ?? "none"), `毛玻璃不随滚动变（${scrolled.blur}）`);
  // 「挡得住」量像素，不解析颜色字符串：`color-mix()` / `rgb(0 0 0 / .6)` 这些写法会让正则取不到第
  // 4 段而默认成 1，断言就恒真了。做法是把一块纯黑的内容滚到条后面，再看条里那颗像素。
  const black = await page.evaluate(() => {
    const host = document.querySelector(".queue");
    const patch = document.createElement("div");
    patch.className = "probe-black";
    patch.style.cssText = "height:400px;background:#000";
    host.insertBefore(patch, host.children[1] ?? null);
    const pane = document.querySelector('.pane[data-region="queue"]');
    const bar = pane.querySelector(".exec-tabs-bar");
    // 别猜 scrollTop：按黑块现在的位置补一段滚动，把它顶到栏顶上一像素，条 sticky 在原地等着。
    pane.scrollTop += patch.getBoundingClientRect().top - pane.getBoundingClientRect().top - 1;
    const b = bar.getBoundingClientRect();
    const q = patch.getBoundingClientRect();
    const box = { x: b.left + 2, y: b.top + 2, width: 24, height: 8 };
    return { box, barTop: b.top, barBottom: b.bottom, patchTop: q.top, patchBottom: q.bottom, scrollTop: pane.scrollTop, paneTop: pane.getBoundingClientRect().top, children: host.children.length };
  });
  // 采样点必须真的落在黑块上：不然「条后面什么都没有」也会量出亮色，这条断言就是恒真的。
  const covers = black.patchTop <= black.box.y && black.patchBottom >= black.box.y + black.box.height;
  ok(covers, `黑块垫在采样点下面（块 ${black.patchTop.toFixed(0)}–${black.patchBottom.toFixed(0)}，采样 ${black.box.y.toFixed(0)}–${(black.box.y + black.box.height).toFixed(0)}）`);
  await sleep(120);
  const under = await sampleRect(black.box);
  const brightness = (under[0] + under[1] + under[2]) / 3;
  ok(brightness >= 170, `纯黑内容滚到条后面时条里仍是玻璃色 rgb(${under.join(",")})，内容透不出来（亮度 ${brightness.toFixed(0)}，透明的条会是 0）`);
  await page.evaluate(() => document.querySelector(".probe-black")?.remove());
  // 0.5px 描边在 DPR 1 与 2 下 Chromium 都算成 1px（实测），不会变 0 —— 与 mac.css 全站的
  // `0.5px solid var(--mac-glass-line)` 发丝线同一个档，不为了 CI 改粗。
  ok(parseFloat(scrolled.borderBottom) > 0, `条底有发丝描边（计算值 ${scrolled.borderBottom}）`);

  // ---------------------------------------------------------------- 4. 切页签归零
  await page.locator('.pane[data-region="queue"] .exec-tabs button[data-exec-tab="review"]').click();
  await sleep(200);
  const afterSwitch = await metrics();
  ok(afterSwitch.scrollTop === 0, `换页签后滚回顶部（scrollTop ${Math.round(afterSwitch.scrollTop)}）`);
  // 「需要你」不是提前 return 的那三个分支，它走 `drawQueue()` 末尾的兜底路（`scrollTop = kept` 在
  // 最后一行）。切回来看它也在顶部 —— 那条路没有 `kept` 的话，这里会留着上一屏的位置。
  await page.locator('.pane[data-region="queue"] .exec-tabs button[data-exec-tab="needs"]').click();
  await sleep(200);
  ok((await metrics()).scrollTop === 0, "切回「需要你」（兜底分支）同样在顶部");

  // ---------------------------------------------------------------- 5. 字号 150% 也贴住
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1.5 }));
  });
  // 150% 这一档必须还站在桌面三栏里：1280 的窗口在 150% 下有效宽度只剩 853（< 900），早就切成
  // 窄版了 —— 那时贴顶本来就不该发生，量出来的「没贴住」是设计而不是缺陷。窗口先放大到 1900。
  await page.setViewportSize({ width: 1900, height: 900 });
  await page.reload({ waitUntil: "networkidle" });
  await openQueueRail();
  await page.evaluate(() => {
    const pane = document.querySelector('.pane[data-region="queue"]');
    pane.scrollTop = pane.scrollHeight;
  });
  await sleep(120);
  const zoomed = await metrics();
  ok(zoomed.scrollTop > 300, `150% 下栏也滚了（scrollTop ${Math.round(zoomed.scrollTop)}）`);
  ok(Math.abs(zoomed.barTopFromPane) <= 2, `150% 下仍停在栏顶（差 ${zoomed.barTopFromPane.toFixed(1)}px）`);

  // ---------------------------------------------------------------- 6. 窄版：不贴顶，也不多出玻璃
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1 }));
  });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.compact)) === "true", 8000, "compact shell");
  await openQueueRail();
  await page.evaluate(() => {
    const pane = document.querySelector('.pane[data-region="queue"]');
    pane.scrollTop = pane.scrollHeight;
  });
  await sleep(120);
  const compact = await metrics();
  ok(compact.position === "static" || compact.position === "relative", `窄版页签条不贴顶（position ${compact.position}）`);
  ok(compact.background === "rgba(0, 0, 0, 0)", `窄版不多出玻璃底（${compact.background}）`);
  ok(compact.barTopFromPane < -100, `窄版确实跟着内容滚走了（条顶离栏顶 ${compact.barTopFromPane.toFixed(0)}px）`);
  await page.locator('.pane[data-region="queue"]').screenshot({ path: path.join(OUT, "compact.png") });
} finally {
  await browser?.close();
  server.close();
  wss.close();
}

console.log(bad ? `\n${bad} 条不通过` : "\n全部通过");
process.exitCode = bad ? 1 : 0;
