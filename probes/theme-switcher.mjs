/**
 * Probe: 配色主题 —— main 自带的四套 + 本分支追加的三套，共七套。
 *
 * 票面要的是：在 main 的「配色主题」里追加素白 / 深海 / 沙丘，并让终端跟着主题走；
 * 主题只换底，强调色与文字亮度仍是独立设置（强调色按明暗各有一支 ramp）。
 *
 * 这里量的是「换完以后整页真的换了」——不是某个变量改了：
 *  - 开箱是 main 的午夜；七颗 chip 的文案与顺序；小样各自的内联 --td-* 是自己的底色；
 *  - 点晨光 / 素白 / 沙丘：'<html data-theme>'、--bg、设置面板 / 顶栏 / 输入框的**实际背景色**都跟着变；
 *  - 七套主题下正文 / 次要 / 提示三档文字对各自底的对比度（浅底最容易翻车）；
 *  - 强调色仍是独立设置：同一个 ice，深底主题取 #7dd3fc、浅底主题取 #0369a1，选项本身没被重置；
 *  - 「恢复默认」把主题拉回午夜；刷新后主题还在（bootTheme 在登录页之前就落过）；
 *  - 新增一个子类后底栏仍贴底（AGENTS.md「网格里的可隐藏子元素」那条）。
 *
 * 终端配色不在这儿量：桩桥没有 pty，改由单测 web/tests/theme-unit.mjs 覆盖七套 16 色。
 *
 * Run: npm run build:web && PI_WEB_PORT=7936 node probes/theme-switcher.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.THEME_DIST ? path.resolve(process.env.THEME_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7936);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

// ---------------------------------------------------------------- 颜色小工具
// 令牌可能是 #hex，也可能是 rgba()/color(srgb …) —— 一个都别漏：
// 早先的版本只认 rgb 里的整数，把 "#9aa2b1" 数成 9/2/1，对比度算出来是假的。
const parse = (v) => {
  const str = String(v ?? "").trim();
  const hex = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  const nums = (str.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (/^color\(srgb/i.test(str)) return { rgb: nums.slice(0, 3).map((n) => n * 255), a: nums.length > 3 ? nums[3] : 1 };
  return { rgb: nums.slice(0, 3), a: nums.length > 3 ? nums[3] : 1 };
};
const lum = (v) => {
  const [r, g, b] = parse(v).rgb.map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** 半透明的面（顶栏 / 浮层）按底下那层合成后再判：`rgba(255,255,255,.92)` 压在深色上仍是浅的。 */
const perceived = (fg, under) => {
  const f = parse(fg);
  const u = parse(under);
  const a = Number.isFinite(f.a) ? f.a : 1;
  const mix = f.rgb.map((c, i) => c * a + u.rgb[i] * (1 - a));
  return `rgb(${mix.map((c) => Math.round(c)).join(", ")})`;
};

// ---------------------------------------------------------------- 桩桥（一份最小会话）
const SESSION = {
  id: "s-theme-1",
  name: "主题探针会话",
  cwd: "F:/theme-probe",
  ws: "f:/theme-probe",
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
};
const GROUP = { id: "f:/theme-probe", name: "主题探针", key: "F:/theme-probe", manual: false };
const ME = {
  version: "stub",
  pi: "stub",
  public: false,
  tunnel: { status: "off", url: null, error: null, updatedAt: Date.now() },
  pushKey: null,
  pushCount: 0,
  sessionsRoot: "stub",
};
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
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe" && msg.sessionId === SESSION.id) {
        ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "manage") return;
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        me: ME,
        sessions: [SESSION],
        manage: { pin: [], order: [SESSION.id], archived: [] },
        trash: [],
        tunnel: ME.tunnel,
        workspace: { groups: [GROUP], overrides: {}, keys: { [SESSION.cwd.toLowerCase()]: SESSION.ws }, order: [GROUP.id], max: 6 },
      }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "zh-CN" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** 一眼看清整页：主题标记、令牌、关键块的真实背景色、设置面板结构、底栏位置。 */
const snap = () =>
  page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const tok = (n) => cs.getPropertyValue(n).trim();
    const bgOf = (sel) => {
      const n = document.querySelector(sel);
      return n ? getComputedStyle(n).backgroundColor : null;
    };
    const sheet = document.querySelector(".display-sheet");
    const foot = sheet?.querySelector(".st-foot");
    const sr = sheet?.getBoundingClientRect();
    const fr = foot?.getBoundingClientRect();
    return {
      theme: root.dataset.theme ?? "",
      text: root.dataset.text ?? "",
      bg: tok("--bg"),
      panel3: tok("--panel-3"),
      colorText: tok("--text"),
      colorDim: tok("--dim"),
      colorFaint: tok("--faint"),
      accent: tok("--accent"),
      accentDim: tok("--accent-dim"),
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "",
      scheme: cs.colorScheme ?? "",
      sheetBg: bgOf(".display-sheet"),
      panelBg: bgOf(".display-sheet .settings-panel"),
      rowBg: bgOf(".display-sheet .settings-row"),
      topBg: bgOf(".topbar"),
      cardBg: bgOf(".session-card"),
      navBg: bgOf(".display-sheet .st-nav"),
      composerBg: bgOf(".composer textarea") ?? bgOf(".composer"),
      swatch: bgOf(".display-sheet .swatch[data-accent]"),
      title: sheet?.querySelector('[data-role="dtitle"]')?.textContent ?? "",
      activeSec: sheet?.querySelector(".st-nav__item.on")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      navSecs: [...(sheet?.querySelectorAll(".st-nav__item") ?? [])].map((n) => n.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      chips: [...(sheet?.querySelectorAll(".theme-chip") ?? [])].map((n) => n.textContent?.trim() ?? ""),
      onChips: [...(sheet?.querySelectorAll(".theme-chip.on") ?? [])].map((n) => n.dataset.theme ?? ""),
      demoBgs: [...(sheet?.querySelectorAll(".theme-demo") ?? [])].map((n) => getComputedStyle(n).getPropertyValue("--td-bg").trim()),
      demoBtn: (() => {
        const d = sheet?.querySelector(".theme-demo .td-btn");
        return d ? getComputedStyle(d).backgroundColor : null;
      })(),
      cardText: sheet?.querySelector(".st-cards")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      footBottom: fr ? Math.round(fr.bottom) : null,
      sheetBottom: sr ? Math.round(sr.bottom) : null,
      resetTitle: sheet?.querySelector('[data-role="dreset"]')?.getAttribute("title") ?? "",
    };
  });

const openSheet = async () => {
  if (!(await page.locator(".display-sheet").count())) {
    await page.locator('.icon-btn[data-act="look"]').click();
    await page.waitForSelector(".display-sheet", { timeout: 5000 });
  }
  const themeNav = page.locator(".display-sheet .st-nav__item", { hasText: "配色主题" });
  if (!(await page.locator(".display-sheet .st-nav__item.on", { hasText: "配色主题" }).count())) {
    await themeNav.click();
    await sleep(250);
  }
  await sleep(150);
};
const pick = async (id) => {
  // Mac 那三套在「Mac 风格」那一页，别的在「配色主题」：先切到那一页，隐藏页里的 chip 点不到。
  const nav = id.startsWith("mac-") ? "Mac 风格" : "配色主题";
  if (!(await page.locator(".display-sheet .st-nav__item.on", { hasText: nav }).count())) {
    await page.locator(".display-sheet .st-nav__item", { hasText: nav }).click();
    await sleep(200);
  }
  await page.locator(`.theme-chip[data-theme="${id}"]`).click();
  await sleep(250);
};

await page.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector('.icon-btn[data-act="look"]', { timeout: 15000 });
await sleep(700);

// 1) 开箱是 main 那套「午夜」
let s = await snap();
ok(s.theme === "midnight", `默认主题是 midnight（${s.theme}）`);
ok(s.bg === "#0b0d10", `默认底色还是 #0b0d10（${s.bg}）`);
ok(s.meta === "#0b0d10", `meta theme-color 跟着底色（${s.meta}）`);
ok(s.scheme === "dark", `默认 color-scheme 是 dark（${s.scheme}）`);

// 2) 设置 → 外观：配色主题在首屏，七颗 chip，小样各是各的底色
await openSheet();
s = await snap();
ok(s.activeSec.includes("配色主题"), `打开设置先落在「配色主题」（${s.activeSec}）`);
const WANT_CHIPS = ["午夜", "晨光", "暖炉", "峡湾", "素白", "深海", "沙丘", "Mac 浅色", "Mac 深色", "Mac 午夜蓝"];
ok(JSON.stringify(s.chips) === JSON.stringify(WANT_CHIPS), `十套主题按顺序列出（后三颗在「Mac 风格」页）（${s.chips.join(" / ")}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["midnight"]), `当前那套亮着（${s.onChips.join(",")}）`);
const WANT_DEMO_BG = ["#0b0d10", "#f5f6f8", "#151210", "#2a303b", "#ffffff", "#070b14", "#f4efe4", "#f5f5f7", "#1c1c1e", "#171c26"];
ok(JSON.stringify(s.demoBgs) === JSON.stringify(WANT_DEMO_BG), `十个小样各自是自己的底色（${s.demoBgs.join(",")}）`);
ok(lum(s.demoBgs[4]) > 0.95, `素白小样的底是纯白（${s.demoBgs[4]}）`);
ok(s.cardText.includes("午夜") && s.cardText.includes("默认"), `顶上卡片写清当前主题（${s.cardText}）`);
ok(s.resetTitle.includes("主题"), `「恢复默认」的说明覆盖了主题（${s.resetTitle}）`);
ok(s.footBottom !== null && Math.abs(s.footBottom - s.sheetBottom) <= 1, `新增一个子类后底栏仍贴底（${s.footBottom} vs ${s.sheetBottom}）`);

// 3) 素白：main 的晨光之外再加的纯白浅底 —— 整页真的变浅，强调色换成浅 ramp
await pick("light");
s = await snap();
ok(s.theme === "light", `切素白：data-theme=light（${s.theme}）`);
ok(s.bg === "#ffffff", `素白底 #ffffff（${s.bg}）`);
ok(s.scheme === "light", `color-scheme 跟着变 light（${s.scheme}）`);
ok(s.meta === "#ffffff", `meta theme-color 换成纯白底（${s.meta}）`);
for (const [name, c] of [
  ["设置面板", s.panelBg],
  ["设置行", s.rowBg],
  ["顶栏", s.topBg],
  ["会话卡", s.cardBg],
  ["左栏导航", s.navBg],
  ["输入框", s.composerBg],
]) {
  if (c === null) {
    ok(false, `${name}没找到（选择器变了？）`);
    continue;
  }
  const seen = perceived(c, s.bg);
  ok(lum(seen) > 0.55, `${name}在素白下是浅的（${seen}）—— 没有漏网的写死深色`);
}
ok(s.accent === "#0369a1", `ice 在浅底主题取深饱和 #0369a1（${s.accent}）`);
ok(lum(s.swatch) < 0.5, `强调色块也换成深 ramp（${s.swatch}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["light"]), `亮着的是素白（${s.onChips.join(",")}）`);
ok(s.cardText.includes("素白") && s.cardText.includes("已调整"), `卡片改成素白 / 已调整（${s.cardText}）`);

// 4) 七套主题逐套量：底色、color-scheme、三档文字对比度
const THEMES = [
  ["midnight", "#0b0d10", "dark"],
  ["daylight", "#f5f6f8", "light"],
  ["ember", "#151210", "dark"],
  ["fjord", "#2a303b", "dark"],
  ["light", "#ffffff", "light"],
  ["dusk", "#070b14", "dark"],
  ["paper", "#f4efe4", "light"],
  ["mac-light", "#f5f5f7", "light"],
  ["mac-dark", "#1c1c1e", "dark"],
  ["mac-midnight", "#171c26", "dark"],
];
for (const [id, want, scheme] of THEMES) {
  await pick(id);
  s = await snap();
  ok(s.theme === id, `${id}：data-theme 已切（${s.theme}）`);
  ok(s.bg === want, `${id}：底色 ${want}（${s.bg}）`);
  ok(s.scheme === scheme, `${id}：color-scheme=${scheme}（${s.scheme}）`);
  ok(contrast(s.colorText, s.bg) >= 7, `${id}：正文对比度 ≥ 7（${contrast(s.colorText, s.bg).toFixed(1)}:1）`);
  ok(contrast(s.colorDim, s.bg) >= 4.5, `${id}：次要文字 ≥ 4.5（${contrast(s.colorDim, s.bg).toFixed(1)}:1）`);
  ok(contrast(s.colorFaint, s.panel3) >= 4.5, `${id}：提示文字对面板 3 ≥ 4.5（${contrast(s.colorFaint, s.panel3).toFixed(1)}:1）`);
}

// 4b) Mac 风格是左栏单独一项，点进去只有三颗、带红绿灯；切过去后两页的「亮着」一致
await pick("mac-dark");
s = await snap();
ok(s.navSecs.some((t) => t.startsWith("Mac 风格")), `左栏有「Mac 风格」（${s.navSecs.join(" | ")}）`);
ok(s.activeSec.includes("Mac 风格"), `点进去落在 Mac 风格（${s.activeSec}）`);
const macVisible = await page.locator('.display-sheet .set-sub[data-sec="mac"] .theme-chip').count();
ok(macVisible === 3, `Mac 风格页里三颗（${macVisible}）`);
const lights = await page.locator('.display-sheet .set-sub[data-sec="mac"] .theme-demo.mac .td-lights').count();
ok(lights === 3, `每颗小样都画了红绿灯（${lights}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["mac-dark"]), `两页合起来只亮 Mac 深色（${s.onChips.join(",")}）`);
ok(s.cardText.includes("Mac 深色"), `顶上卡片写的是 Mac 深色（${s.cardText}）`);
ok(s.footBottom !== null && Math.abs(s.footBottom - s.sheetBottom) <= 1, `Mac 风格页底栏贴底（${s.footBottom} vs ${s.sheetBottom}）`);

// 4c) Mac 模式：html 挂 data-ui=mac；颜色页换成 macOS 八色、六色与文字亮度两行藏起来；点紫色强调色就跟着换
const macUi = await page.evaluate(() => document.documentElement.dataset.ui ?? "");
ok(macUi === "mac", `Mac 主题下 html[data-ui=mac]（${macUi}）`);
const rows = await page.evaluate(() => {
  const vis = (r) => { const n = document.querySelector(`.display-sheet [data-role="${r}"]`); return n ? !n.hidden : null; };
  return { mac: vis("mac-accent-row"), six: vis("accent-row"), text: vis("text-row") };
});
ok(rows.mac === true && rows.six === false && rows.text === false, `八色行露出、六色与文字亮度藏起（${JSON.stringify(rows)}）`);
const macSw = await page.locator(".display-sheet .swatch[data-mac-accent]").count();
ok(macSw === 8, `macOS 强调色八颗（${macSw}）`);
await page.evaluate(() => document.querySelector('.display-sheet .swatch[data-mac-accent="purple"]').click());
await sleep(150);
const purple = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase());
ok(purple === "#bf5af2", `Mac 深色点紫色 → --accent #bf5af2（${purple}）`);
const glass = await page.evaluate(() => getComputedStyle(document.querySelector(".display-sheet")).backdropFilter);
ok(/blur/.test(glass), `设置台是毛玻璃（backdrop-filter: ${glass}）`);

// 4d) Mac 快捷键：Esc 关掉（带退场动画），Ctrl+, 再打开
await page.keyboard.press("Escape");
await sleep(400);
ok((await page.locator(".display-sheet").count()) === 0, "Esc 关掉设置台（退场动画后移除）");
await page.keyboard.press("Control+,");
await sleep(400);
ok((await page.locator(".display-sheet").count()) === 1, "Mac 主题下 Ctrl+, 打开设置");

// 5) 强调色跟明暗走、但不被主题重置：暖炉是深底拿亮粉彩，沙丘是浅底拿深饱和
await pick("ember");
s = await snap();
ok(s.accent === "#7dd3fc", `暖炉（深底）ice 取亮粉彩 #7dd3fc（${s.accent}）`);
ok(lum(s.swatch) > 0.5, `强调色块跟着回亮色（${s.swatch}）`);
const offMac = await page.evaluate(() => document.documentElement.dataset.ui ?? "");
ok(offMac === "", `离开 Mac 主题后 data-ui 摘掉（${offMac || "无"}）`);
await pick("paper");
s = await snap();
ok(s.accent === "#0369a1", `沙丘（浅底）ice 取深饱和 #0369a1（${s.accent}）`);
const onAccents = await page.locator(".display-sheet .swatch[data-accent].on").count();
ok(onAccents === 1, `强调色选项没被主题重置（亮着的色块 ${onAccents} 个）`);

// 6) 刷新后主题还在（bootTheme 在登录页之前就落了）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('.icon-btn[data-act="look"]', { timeout: 15000 });
await sleep(500);
s = await snap();
ok(s.theme === "paper", `刷新后还是沙丘（${s.theme}）`);
ok(s.bg === "#f4efe4", `沙丘底 #f4efe4（${s.bg}）`);
ok(s.meta === "#f4efe4", `刷新后 meta theme-color 也是沙丘（${s.meta}）`);

// 7) 「恢复默认」把主题也拉回午夜
await openSheet();
await page.locator('.display-sheet [data-role="dreset"]').click();
await sleep(350);
s = await snap();
ok(s.theme === "midnight", `恢复默认后主题回午夜（${s.theme}）`);
ok(s.bg === "#0b0d10", `恢复默认后底色回 #0b0d10（${s.bg}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["midnight"]), `恢复默认后午夜那颗亮着（${s.onChips.join(",")}）`);

ok(errors.length === 0, `没有 pageerror（${errors.join(" | ") || "无"}）`);

fs.mkdirSync(path.join(REPO, ".scratch"), { recursive: true });
for (const id of ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper", "mac-light", "mac-dark", "mac-midnight"]) {
  if (!(await page.locator(".display-sheet").count())) await openSheet();
  await pick(id);
  await page.screenshot({ path: path.join(REPO, ".scratch", `theme-${id}.png`) });
  await sleep(120);
  // 关掉抽屉再看一眼整页：设置面板自己换了色不代表对话区 / 输入框 / 顶栏也换了。
  await page.locator('.display-sheet .st-head__actions button:has-text("关闭")').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(REPO, ".scratch", `theme-${id}-app.png`) });
  await sleep(120);
}
console.log(`\n${bad === 0 ? "theme-switcher: ok" : `theme-switcher: ${bad} FAIL`}（截图在 .scratch/theme-*.png）`);
await browser.close();
wss.close();
server.close();
process.exit(bad === 0 ? 0 : 1);
