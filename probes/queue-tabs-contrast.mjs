/**
 * Probe: 右栏四颗页签（需要你 / 执行 / 浏览器 / 代码评审）在**三套主题、任意强调色**下都得看得清。
 *
 * 它守的是两件事，分属两个决定：
 *
 * 1. **选中不是白底**（D455）：`--mac-knob` 是开关里那颗白圆点的颜色，深色主题下也近白（mac-dark
 *    `#f2f2f4`、mac-midnight `#f1f4fb`）。拿它当选中滑块的底时就白底配浅色字，实测 1.03:1，整颗页签
 *    等于消失。**任何**不透明近白的底都会被下面「选中块 vs 灰槽」与「选中字对比」两条拦住。
 * 2. **右栏选中是中性抬起滑块**（D457，取代这一处的 D456）：底色取 `--mac-control` 那档中性面、
 *    字取 `--text`，12px 也要 ≥4.5:1；同时不许再是强调色实底。设置台的页签 / 分段仍按 D456 用
 *    强调色 + `--accent-ink`，下面 `checkConsole` 单独守。
 *
 * 底色一律用**截图取像素**（区域内最多的那个颜色），不解析 `color-mix()` / 半透明写法 —— 那些正则
 * 一旦取了默认值断言就恒真（D449 踩过）。字色用 computed：字是从抗锯齿里猜不出来的。
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

/** 截图一小块 → 区域内最多的那个颜色（CSS px 的 clip，跟 `getBoundingClientRect` 同一套）。
 *  `exclude` 用来跳过文字的本色：滑块是渐变时没有「一片同色底」，而粗体汉字内部大片纯字的
 *  像素反而最多，会把底色量成字色（1.00:1 的假红）。跳过字色、留下被抗锯齿打碎的渐变行。 */
const modeColor = async (rect, exclude = null) => {
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(
    async ({ b64, exclude }) => {
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
        if (exclude && Math.abs(d[i] - exclude[0]) <= 24 && Math.abs(d[i + 1] - exclude[1]) <= 24 && Math.abs(d[i + 2] - exclude[2]) <= 24) continue;
        counts.set((d[i] << 16) | (d[i + 1] << 8) | d[i + 2], (counts.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) ?? 0) + 1);
      }
      let mode = 0;
      let best = -1;
      for (const [k, n] of counts) if (n > best) [mode, best] = [k, n];
      return { rgb: [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255], px: d.length / 4, distinct: counts.size };
    },
    { b64: png.toString("base64"), exclude },
  );
};

/** 自定义属性里存的是 `#rrggbb`，computed 的 `color` 是 `rgb()`；两样都要认。 */
const parseColor = (s) => {
  const t = s.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(t);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(t);
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
/** 三通道各差 ≤ 3 算「就是这颗色」：截图只给人眼看的像素，量化误差一两格是常态。 */
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);

/** 在某个主题 + 强调色下打开右栏，量选中 / 未选中 / 灰槽三处。 */
const checkTheme = async (theme, accent) => {
  await page.evaluate(
    ({ theme, accent }) => {
      const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      // accentTone 显式钉死：柔和档（D438）会换另一张色表，那不是这一段要测的。
      localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, theme, macAccent: accent, accentTone: "vivid" }));
    },
    { theme, accent },
  );
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await openQueueRail();
  const applied = await page.evaluate(() => document.documentElement.dataset.theme);
  ok(applied === theme, `${theme}/${accent}：主题真的落到 <html>（data-theme=${applied}）`);
  await sleep(120);

  const on = await tabMetrics('.pane[data-region="queue"] .exec-tabs button.on');
  const off = await tabMetrics('.pane[data-region="queue"] .exec-tabs button:not(.on)');
  const vars = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { accent: cs.getPropertyValue("--accent").trim(), ink: cs.getPropertyValue("--accent-ink").trim(), text: cs.getPropertyValue("--text").trim() };
  });
  const onText = parseColor(on.text);
  const offText = parseColor(off.text);
  const onBg = (await modeColor(on.box, onText)).rgb;
  const offBg = (await modeColor(off.box, offText)).rgb;
  const accentRgb = parseColor(vars.accent);
  const textRgb = parseColor(vars.text);
  const onRatio = ratio(onText, onBg);
  const offRatio = ratio(offText, offBg);
  // 未选中那颗的底就是灰槽（按钮自己是透明的）—— 拿它当「灰槽色」，比另挑一格纯槽像素稳：
  // `.exec-tabs` 只有 2px 内边距，挑进去多半正好压在选中块上（1.00:1 那种假红）。
  const knobVsGroove = ratio(onBg, offBg);

  console.log(
    `     ${theme}/${accent}：选中「${on.label}」底 rgb(${onBg}) 字 rgb(${onText}) → ${onRatio.toFixed(2)}:1` +
      `｜未选中「${off.label}」底 rgb(${offBg}) 字 rgb(${offText}) → ${offRatio.toFixed(2)}:1` +
      `｜选中块 vs 灰槽 → ${knobVsGroove.toFixed(2)}:1`,
  );
  // 1) 右栏的选中块是中性抬起面（D457），不是强调色实底（D456 只管设置台）。
  ok(!near(onBg, accentRgb), `${theme}/${accent}：右栏选中块不是强调色（量到 rgb(${onBg})，强调色 rgb(${accentRgb})）`);
  ok(near(onText, textRgb), `${theme}/${accent}：右栏选中页签的字是 --text rgb(${textRgb})（量到 rgb(${onText})）`);
  // 2) 读得清：12px 字按正文的 4.5:1 守（中性滑块上做得到，不必再走 UI 组件的 3:1）。
  ok(onRatio >= 4.5, `${theme}/${accent}：右栏选中页签的字读得出（${onRatio.toFixed(2)}:1 ≥ 4.5）`);
  ok(offRatio >= 4.5, `${theme}/${accent}：未选中页签的字看得清（${offRatio.toFixed(2)}:1 ≥ 4.5）`);
  // 3) 选中态除了字要清，还得跟灰槽分得开 —— 否则四颗看着一样，不知道停在哪颗。浅色下
  //    macOS 原生滑块就只有 1.18:1（白 vs 浅灰槽），剩下那点边界靠 0.5px 描边与投影；
  //    中性滑块按 1.15 守，别拿强调色那套 1.2+ 的期望来套。
  ok(knobVsGroove >= 1.15, `${theme}/${accent}：选中块与灰槽区分得开（${knobVsGroove.toFixed(2)}:1 ≥ 1.15）`);
  await page.locator('.pane[data-region="queue"] .exec-tabs-bar').screenshot({ path: path.join(OUT, `${theme}-${accent}.png`) });
};

/**
 * 设置台的两处同类控件 —— 「外观 / 连接与设置」的页签（`.st-tabs__btn`）与作用域分段
 * （`.st-seg__btn`）—— 跟右栏同一套组合（D456）。`?settings=` 深链每次进来都开（打开后会把参数抹掉，
 * 所以每一轮都是新 goto）。
 */
const checkConsole = async (theme, accent) => {
  await page.evaluate(
    ({ theme, accent }) => {
      const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, theme, macAccent: accent, accentTone: "vivid" }));
    },
    { theme, accent },
  );
  for (const [url, sel, what] of [
    ["/?settings=tools", ".st-tabs__btn.on", "设置页签"],
    ["/?settings=global", ".st-seg__btn.on", "作用域分段"],
  ]) {
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await until(async () => (await page.locator(".st-console").count()) === 1, 10000, `console ${what}`);
    await sleep(150);
    const m = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return {
        text: getComputedStyle(btn).color,
        label: btn.textContent.trim(),
        box: { x: r.left + 3, y: r.top + 3, width: r.width - 6, height: r.height - 6 },
      };
    }, sel);
    if (!m) {
      ok(false, `${theme}/${accent}：${what}在（${sel} 找不到）`);
      continue;
    }
    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { accent: cs.getPropertyValue("--accent").trim(), ink: cs.getPropertyValue("--accent-ink").trim() };
    });
    const bg = (await modeColor(m.box)).rgb;
    const text = parseColor(m.text);
    const accentRgb = parseColor(vars.accent);
    const inkRgb = parseColor(vars.ink);
    const r = ratio(text, bg);
    console.log(`     ${theme}/${accent}：${what}「${m.label}」底 rgb(${bg}) 字 rgb(${text}) → ${r.toFixed(2)}:1`);
    ok(near(bg, accentRgb), `${theme}/${accent}：${what}的选中底是强调色 rgb(${accentRgb})（量到 rgb(${bg})）`);
    ok(near(text, inkRgb), `${theme}/${accent}：${what}的选中字是 accent-ink rgb(${inkRgb})（量到 rgb(${text})）`);
    ok(r >= 3.0, `${theme}/${accent}：${what}的选中字读得出（${r.toFixed(2)}:1 ≥ 3.0）`);
    await page.locator(".st-console").screenshot({ path: path.join(OUT, `${theme}-console-${sel.includes("seg") ? "seg" : "tabs"}.png`) });
  }
};

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

  for (const theme of THEMES) await checkTheme(theme, "blue");
  // 强调色可换：黄色会走 accentInk 的「亮底换深字」那一支，两种字色都得在选中块上可读。
  await checkTheme("mac-light", "yellow");
  await checkTheme("mac-dark", "yellow");
  // 右栏换中性滑块后，黄色仍然要跑：设置台还是强调色实底，黄色会走 accentInk 的「亮底换深字」那一支。
  for (const [theme, accent] of [
    ["mac-light", "blue"],
    ["mac-dark", "blue"],
    ["mac-light", "yellow"],
    ["mac-dark", "yellow"],
  ]) {
    await checkConsole(theme, accent);
  }
} finally {
  await browser?.close();
  server.close();
  wss.close();
}

console.log(bad ? `\n${bad} 条不通过` : "\n全部通过");
process.exitCode = bad ? 1 : 0;
