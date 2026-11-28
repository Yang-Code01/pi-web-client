/**
 * Probe: 右栏四颗页签（需要你 / 执行 / 浏览器 / 代码评审）在**三套主题下**都得看得清。
 *
 * 症状：深色 / 午夜蓝下选中的那颗是**白底**，(选中的) 字跟着主题是浅色 —— 白字白底，那颗页签等于
 * 消失了。成因是选中底 `var(--mac-knob)`：那颗变量本来是给开关滑块（`.sw::after` / checkbox）用的
 * 白色小圆点，深色主题里也是近白（mac-dark `#f2f2f4`、mac-midnight `#f1f4fb`），拿它当「选中滑块」
 * 的底色时就没人反相（设置台 `.st-tabs__btn.on` 早踩过，那边按主题补了两条覆盖，右栏这四颗漏了）。
 *
 * 这里量的是浏览器里真实画出来的东西：每套主题下把选中那颗**截图取像素**，背景取区域内最多的那个
 * 颜色，再跟文字色算 WCAG 对比度；同时比一下未选中那颗、灰槽本身，确认选中态既看得清、又区分得开。
 *
 * Run: npm --prefix web run build && node probes/queue-tabs-contrast.mjs
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

const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7957));
const DIST = path.resolve(DIST_RAW);
const OUT = path.join(REPO, ".scratch/queue-tabs-contrast/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// 右栏里只要有一颗「需要你」的批准卡就画得出四颗页签，不用把栏撑长（那不是这个探针的事）。
const APPROVALS = [{ id: "ap-1", sessionId: "probe-contrast", title: "一条批准", message: "只为让右栏画出来。", createdAt: Date.now() }];
const SESSION = { id: "probe-contrast", name: "页签对比度探针", cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: APPROVALS.length, asks: 0, locked: false, preview: "量页签对比度" };
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

const openQueueRail = async () => {
  const tab = page.locator('.tabs button[data-tab="queue"]');
  if (await page.evaluate(() => document.documentElement.dataset.compact === "true")) await tab.click();
  await until(async () => (await page.locator('.pane[data-region="queue"] .exec-tabs button.on').count()) === 1, 8000, "tab bar");
};

/** 截图一小块 → 区域内最多的那个颜色（CSS px 的 clip，跟 `getBoundingClientRect` 同一套）。 */
const modeColor = async (rect) => {
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
      for (let i = 0; i < d.length; i += 4) counts.set((d[i] << 16) | (d[i + 1] << 8) | d[i + 2], (counts.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) ?? 0) + 1);
      let mode = 0;
      let best = -1;
      for (const [k, n] of counts) if (n > best) [mode, best] = [k, n];
      return { rgb: [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255], px: d.length / 4, distinct: counts.size };
    },
    { b64: png.toString("base64") },
  );
};

/** `rgb()` / `rgba()` / `color(srgb …)` 都可能来；只认这里真会用到的两三种，认不出就抛。 */
const parseColor = (s) => {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s.trim());
  if (!m) throw new Error(`看不懂的颜色：${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** WCAG 2.x 相对亮度与对比度。 */
const lin = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * 一颗页签的两个数：实际底色（截图取像素）与文字声明色（computed —— 字是从抗锯齿里猜出来的，猜不准）。
 * 采样盒内缩 3px：圆角与 `box-shadow` 的暗边不进统计。
 */
const tabMetrics = (sel) =>
  page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    const r = btn.getBoundingClientRect();
    return {
      text: getComputedStyle(btn).color,
      label: btn.textContent.trim(),
      box: { x: r.left + 3, y: r.top + 3, width: r.width - 6, height: r.height - 6 },
    };
  }, sel);

const THEMES = ["mac-light", "mac-dark", "mac-midnight"];
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  // 外观默认 125%：先钉 100%，量到的像素才是 1:1（DPR 1 时 CSS px = 设备 px）。
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: 1 }));
  });

  for (const theme of THEMES) {
    await page.evaluate((theme) => {
      const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, theme }));
    }, theme);
    await page.reload({ waitUntil: "networkidle" });
    await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
    await page.locator(".session-card").first().click();
    await openQueueRail();
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    ok(applied === theme, `${theme}：主题真的落到 <html>（data-theme=${applied}）`);
    await sleep(120);

    const on = await tabMetrics('.pane[data-region="queue"] .exec-tabs button.on');
    const off = await tabMetrics('.pane[data-region="queue"] .exec-tabs button:not(.on)');
    const onBg = (await modeColor(on.box)).rgb;
    const offBg = (await modeColor(off.box)).rgb;
    const onText = parseColor(on.text);
    const offText = parseColor(off.text);
    const onRatio = ratio(onText, onBg);
    const offRatio = ratio(offText, offBg);
    // 未选中那颗的底就是灰槽（按钮自己是透明的）—— 拿它当「灰槽色」，比另挑一格纯槽像素稳：
    // `.exec-tabs` 只有 2px 内边距，挑进去多半正好压在选中块上（1.00:1 那种假红）。
    const knobVsGroove = ratio(onBg, offBg);

    console.log(
      `     ${theme}：选中「${on.label}」底 rgb(${onBg}) 字 rgb(${onText}) → ${onRatio.toFixed(2)}:1` +
        `｜未选中「${off.label}」底 rgb(${offBg}) 字 rgb(${offText}) → ${offRatio.toFixed(2)}:1` +
        `｜选中块 vs 灰槽 → ${knobVsGroove.toFixed(2)}:1`,
    );
    // 12px 小字，WCAG AA 要 4.5:1。像素量出来的底色 + 声明的字色，都是真实渲染值。
    ok(onRatio >= 4.5, `${theme}：选中页签的字看得清（${onRatio.toFixed(2)}:1 ≥ 4.5，底 rgb(${onBg}) 字 rgb(${onText})）`);
    ok(offRatio >= 4.5, `${theme}：未选中页签的字看得清（${offRatio.toFixed(2)}:1 ≥ 4.5）`);
    // 选中态除了字要清，还得跟灰槽分得开 —— 否则四颗看着一样，不知道停在哪颗（1.2:1 就够肉眼分辨）。
    ok(knobVsGroove >= 1.2, `${theme}：选中块的底色与灰槽区分得开（${knobVsGroove.toFixed(2)}:1 ≥ 1.2）`);
    await page.locator('.pane[data-region="queue"] .exec-tabs-bar').screenshot({ path: path.join(OUT, `${theme}.png`) });
  }
} finally {
  await browser?.close();
  server.close();
  wss.close();
}

console.log(bad ? `\n${bad} 条不通过` : "\n全部通过");
process.exitCode = bad ? 1 : 0;
