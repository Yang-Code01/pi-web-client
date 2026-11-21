/**
 * Probe: 外观只剩 Mac 风格三套（D352）—— 七套「配色主题」已删。
 *
 * 票面（#583）要的是：删掉配色主题，全面转向 Mac 风格；强调色只剩 macOS 八色，
 * 文字亮度三档退场，老偏好按明暗 + 最近色落进三套。
 *
 * 这里量的是「换完以后整页真的换了」——不是某个变量改了：
 *  - 开箱是 Mac 浅色且 `data-ui=mac` 恒挂；设置里只剩「Mac 风格」与「颜色」两页，三颗 chip；
 *  - 「颜色」页只剩 macOS 八色一行（六色行与文字亮度行都不在了）；点色块立即换 `--accent`；
 *  - 三套主题逐套：'<html data-theme>'、`--bg`、color-scheme、三档文字对比度，以及浅底下
 *    设置面板 / 顶栏 / 输入框 / 会话卡都真的是浅的（漏网的写死深色会红）；
 *  - 「恢复默认」把主题拉回 Mac 浅色；刷新后主题还在（bootTheme 在登录页之前就落过）；
 *  - 老偏好迁移：种 `theme: fjord / accent: teal` 进去，落点是 Mac 深色 + macOS 绿，并写回 `pi.prefs`；
 *    已经用着 Mac 主题的人，旧 `accent` 是残值，不许盖掉他选的 `macAccent`；
 *  - 首次弹窗只剩一排三颗，点一颗立即换，刷新不再弹；
 *  - 底栏仍贴底（AGENTS.md「网格里的可隐藏子元素」那条）。
 *
 * 终端配色不在这儿量：桩桥没有 pty，改由单测 web/tests/theme-unit.mjs 覆盖三套 16 色。
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
      ui: root.dataset.ui ?? "",
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
      swatch: bgOf(".display-sheet .swatch[data-mac-accent]"),
      title: sheet?.querySelector('[data-role="dtitle"]')?.textContent ?? "",
      activeSec: sheet?.querySelector(".st-nav__item.on")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      navSecs: [...(sheet?.querySelectorAll(".st-nav__item") ?? [])].map((n) => n.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      chips: [...(sheet?.querySelectorAll(".theme-chip") ?? [])].map((n) => n.textContent?.trim() ?? ""),
      onChips: [...(sheet?.querySelectorAll(".theme-chip.on") ?? [])].map((n) => n.dataset.theme ?? ""),
      demoBgs: [...(sheet?.querySelectorAll(".theme-demo") ?? [])].map((n) => getComputedStyle(n).getPropertyValue("--td-bg").trim()),
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
  const macNav = page.locator(".display-sheet .st-nav__item", { hasText: "Mac 风格" });
  if (!(await page.locator(".display-sheet .st-nav__item.on", { hasText: "Mac 风格" }).count())) {
    await macNav.click();
    await sleep(250);
  }
  await sleep(150);
};
const pick = async (id) => {
  await openSheet();
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

// 1) 开箱是「Mac 浅色」，Mac 材质恒挂；探针带 webdriver，第一次打开的主题弹窗不会挡在前面（弹窗在第 7 段单独量）
let s = await snap();
ok(s.theme === "mac-light", `默认主题是 mac-light（${s.theme}）`);
ok(s.ui === "mac", `默认就挂着 data-ui=mac（${s.ui}）`);
ok(s.bg === "#f5f5f7", `默认底色是 #f5f5f7（${s.bg}）`);
ok(s.meta === "#f5f5f7", `meta theme-color 跟着底色（${s.meta}）`);
ok(s.scheme === "light", `默认 color-scheme 是 light（${s.scheme}）`);
ok(!(await page.locator(".theme-intro-sheet").count()), "自动化下不弹主题选择");

// 2) 设置 → 外观：外观只剩「Mac 风格」「颜色」两页；Mac 风格一页三颗；「配色主题」整页没了
await openSheet();
s = await snap();
ok(s.navSecs.some((t) => t.startsWith("Mac 风格")), `左栏有「Mac 风格」（${s.navSecs.join(" | ")}）`);
ok(!s.navSecs.some((t) => t.includes("配色主题")), `左栏不再有「配色主题」（${s.navSecs.join(" | ")}）`);
ok(s.activeSec.includes("Mac 风格"), `打开设置落在 Mac 风格（${s.activeSec}）`);
const WANT_CHIPS = ["Mac 浅色", "Mac 深色", "Mac 午夜蓝"];
ok(JSON.stringify(s.chips) === JSON.stringify(WANT_CHIPS), `三颗主题按顺序列出（${s.chips.join(" / ")}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["mac-light"]), `当前那套亮着（${s.onChips.join(",")}）`);
const WANT_DEMO_BG = ["#f5f5f7", "#1c1c1e", "#171c26"];
ok(JSON.stringify(s.demoBgs) === JSON.stringify(WANT_DEMO_BG), `三个小样各自是自己的底色（${s.demoBgs.join(",")}）`);
const lights = await page.locator('.display-sheet .set-sub[data-sec="mac"] .theme-demo.mac .td-lights').count();
ok(lights === 3, `每颗小样都画了红绿灯（${lights}）`);
ok(s.cardText.includes("Mac 浅色") && s.cardText.includes("默认"), `顶上卡片写清当前主题（${s.cardText}）`);
ok(s.resetTitle.includes("主题"), `「恢复默认」的说明覆盖了主题（${s.resetTitle}）`);
ok(s.footBottom !== null && Math.abs(s.footBottom - s.sheetBottom) <= 1, `底栏仍贴底（${s.footBottom} vs ${s.sheetBottom}）`);
const glass = await page.evaluate(() => getComputedStyle(document.querySelector(".display-sheet")).backdropFilter);
ok(/blur/.test(glass), `设置台是毛玻璃（backdrop-filter: ${glass}）`);

// 2b) 「颜色」页：只剩 macOS 八色一行；六色行与文字亮度行都不在了
await page.locator(".display-sheet .st-nav__item", { hasText: "颜色" }).click();
await sleep(250);
const swatches = await page.locator(".display-sheet .swatch[data-mac-accent]").count();
ok(swatches === 8, `macOS 强调色八颗（${swatches}）`);
const goneRows = await page.evaluate(() => ({
  six: document.querySelectorAll(".display-sheet .swatch[data-accent]").length,
  text: [...document.querySelectorAll(".display-sheet .settings-row")].some((r) => (r.textContent ?? "").includes("文字亮度")),
}));
ok(goneRows.six === 0 && goneRows.text === false, `六色行与文字亮度行都删掉了（${JSON.stringify(goneRows)}）`);
await page.locator('.display-sheet .swatch[data-mac-accent="purple"]').click();
await sleep(200);
s = await snap();
ok(s.accent === "#8944ab", `Mac 浅色点紫色 → 亮色表那档 #8944ab（${s.accent}）`);

// 3) 三套主题逐套量：底色、color-scheme、材质开关、三档文字对比度、强调色跟明暗换表
const THEMES = [
  ["mac-light", "#f5f5f7", "light", "#8944ab"],
  ["mac-dark", "#1c1c1e", "dark", "#bf5af2"],
  ["mac-midnight", "#171c26", "dark", "#bf5af2"],
];
for (const [id, want, scheme, accent] of THEMES) {
  await pick(id);
  s = await snap();
  ok(s.theme === id, `${id}：data-theme 已切（${s.theme}）`);
  ok(s.ui === "mac", `${id}：data-ui=mac（${s.ui}）`);
  ok(s.bg === want, `${id}：底色 ${want}（${s.bg}）`);
  ok(s.scheme === scheme, `${id}：color-scheme=${scheme}（${s.scheme}）`);
  ok(s.accent === accent, `${id}：同是紫色，明暗两档各取各的（${s.accent}）`);
  ok(contrast(s.colorText, s.bg) >= 7, `${id}：正文对比度 ≥ 7（${contrast(s.colorText, s.bg).toFixed(1)}:1）`);
  ok(contrast(s.colorDim, s.bg) >= 4.5, `${id}：次要文字 ≥ 4.5（${contrast(s.colorDim, s.bg).toFixed(1)}:1）`);
  ok(contrast(s.colorFaint, s.panel3) >= 4.5, `${id}：提示文字对面板 3 ≥ 4.5（${contrast(s.colorFaint, s.panel3).toFixed(1)}:1）`);
  if (scheme === "light") {
    // 浅底最容易翻车：面板 / 顶栏 / 输入框都不许留写死的深色。
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
      ok(lum(seen) > 0.55, `${name}在浅底主题下是浅的（${seen}）—— 没有漏网的写死深色`);
    }
  }
}

// 4) 「恢复默认」把主题拉回 Mac 浅色，强调色也回系统蓝
await page.locator('.display-sheet [data-role="dreset"]').click();
await sleep(350);
s = await snap();
ok(s.theme === "mac-light", `恢复默认后主题回 Mac 浅色（${s.theme}）`);
ok(s.bg === "#f5f5f7", `恢复默认后底色回 #f5f5f7（${s.bg}）`);
ok(JSON.stringify(s.onChips) === JSON.stringify(["mac-light"]), `恢复默认后 Mac 浅色那颗亮着（${s.onChips.join(",")}）`);

// 5) 选深色后刷新：主题与强调色都还在（bootTheme 在登录页之前就落了）
await pick("mac-midnight");
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('.icon-btn[data-act="look"]', { timeout: 15000 });
await sleep(500);
s = await snap();
ok(s.theme === "mac-midnight", `刷新后还是 Mac 午夜蓝（${s.theme}）`);
ok(s.bg === "#171c26", `午夜蓝底 #171c26（${s.bg}）`);
ok(s.meta === "#171c26", `刷新后 meta theme-color 也是午夜蓝（${s.meta}）`);

// 6) 老偏好迁移：旧配色主题 + 旧六色强调色落进 Mac 三套，并当场写回 pi.prefs
{
  const ctx3 = await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "zh-CN" });
  await ctx3.addInitScript(() => {
    localStorage.setItem("pi.prefs", JSON.stringify({ theme: "fjord", accent: "teal", scale: 1.25 }));
  });
  const p3 = await ctx3.newPage();
  await p3.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });
  if (await p3.locator('input[type="password"]').count()) {
    await p3.fill('input[type="password"]', "probe");
    await p3.click('button:has-text("进入")');
  }
  await p3.waitForSelector('.icon-btn[data-act="look"]', { timeout: 15000 });
  await sleep(500);
  const m = await p3.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    return {
      theme: document.documentElement.dataset.theme ?? "",
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase(),
      storedTheme: stored.theme,
      storedAccent: stored.macAccent,
      keptOld: "accent" in stored || "text" in stored,
    };
  });
  ok(m.theme === "mac-dark", `旧主题 fjord → Mac 深色（${m.theme}）`);
  ok(m.accent === "#30d158", `旧强调色 teal → macOS 绿（${m.accent}）`);
  ok(m.storedTheme === "mac-dark" && m.storedAccent === "green", `迁移当场写回 pi.prefs（${m.storedTheme} / ${m.storedAccent}）`);
  ok(!m.keptOld, "旧键（accent / text）不再留在 pi.prefs 里");
  await ctx3.close();
}

// 6b) 已经用着 Mac 主题的人：旧 accent 是残值，不许盖掉他选的 macAccent
{
  const ctx4 = await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "zh-CN" });
  await ctx4.addInitScript(() => {
    localStorage.setItem("pi.prefs", JSON.stringify({ theme: "mac-dark", accent: "teal", macAccent: "pink" }));
  });
  const p4 = await ctx4.newPage();
  await p4.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });
  if (await p4.locator('input[type="password"]').count()) {
    await p4.fill('input[type="password"]', "probe");
    await p4.click('button:has-text("进入")');
  }
  await p4.waitForSelector('.icon-btn[data-act="look"]', { timeout: 15000 });
  await sleep(400);
  const m = await p4.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? "",
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim().toLowerCase(),
  }));
  ok(m.theme === "mac-dark", `已是 Mac 深色的用户主题不动（${m.theme}）`);
  ok(m.accent === "#ff375f", `强调色仍是自己选的粉（${m.accent}）`);
  await ctx4.close();
}

// 7) 第一次打开：主题选择弹窗只有一排三颗；点了立即换，刷新不再弹
{
  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "zh-CN" });
  await ctx2.addInitScript(() => sessionStorage.setItem("pi.probe.themeIntro", "1"));
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });
  if (await p2.locator('input[type="password"]').count()) {
    await p2.fill('input[type="password"]', "probe");
    await p2.click('button:has-text("进入")');
  }
  await p2.waitForSelector(".theme-intro-sheet", { timeout: 15000 });
  await sleep(400);
  fs.mkdirSync(path.join(REPO, ".scratch"), { recursive: true });
  await p2.screenshot({ path: path.join(REPO, ".scratch", "theme-intro.png") });
  const intro = await p2.evaluate(() => {
    const sh = document.querySelector(".theme-intro-sheet");
    const ids = [...(sh?.querySelectorAll("[data-role] .theme-chip") ?? [])].map((n) => n.dataset.theme);
    const groups = [...(sh?.querySelectorAll("[data-role]") ?? [])].filter((n) => n.querySelector(".theme-chip")).map((n) => n.dataset.role);
    const foot = sh?.querySelector(".sheet-foot")?.getBoundingClientRect();
    return {
      ids,
      groups,
      on: [...(sh?.querySelectorAll(".theme-chip.on") ?? [])].map((n) => n.dataset.theme),
      theme: document.documentElement.dataset.theme,
      footIn: !!foot && foot.bottom <= innerHeight + 1,
      seen: JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").themeIntroSeen,
    };
  });
  ok(JSON.stringify(intro.ids) === JSON.stringify(["mac-light", "mac-dark", "mac-midnight"]), `弹窗只有一排三颗（${intro.ids.join(",")}）`);
  ok(JSON.stringify(intro.groups) === JSON.stringify(["theme-intro-mac"]), `弹窗只有 Mac 那一组（${intro.groups.join(",")}）`);
  ok(JSON.stringify(intro.on) === JSON.stringify(["mac-light"]) && intro.theme === "mac-light", `默认亮着 Mac 浅色（${intro.on.join(",")} / ${intro.theme}）`);
  ok(intro.footIn, "「开始使用」在视口里");
  ok(intro.seen === true, "弹出即记 themeIntroSeen");
  await p2.locator('.theme-intro-sheet .theme-chip[data-theme="mac-dark"]').click();
  await sleep(250);
  ok((await p2.evaluate(() => document.documentElement.dataset.theme)) === "mac-dark", "点 Mac 深色立即换上");
  await p2.locator('.theme-intro-sheet [data-role="theme-intro-ok"]').click();
  await sleep(250);
  ok(!(await p2.locator(".theme-intro-sheet").count()), "「开始使用」关掉弹窗");
  await p2.reload({ waitUntil: "networkidle" });
  await sleep(1200);
  ok(!(await p2.locator(".theme-intro-sheet").count()), "刷新后不再弹");
  ok((await p2.evaluate(() => document.documentElement.dataset.theme)) === "mac-dark", "刷新后还是 Mac 深色");
  await ctx2.close();
}

ok(errors.length === 0, `没有 pageerror（${errors.join(" | ") || "无"}）`);

// 8) 截图：三套主题各一张设置页、一张整页（设置面板自己换了色不代表对话区 / 输入框 / 顶栏也换了）
fs.mkdirSync(path.join(REPO, ".scratch"), { recursive: true });
for (const id of ["mac-light", "mac-dark", "mac-midnight"]) {
  if (!(await page.locator(".display-sheet").count())) await openSheet();
  await pick(id);
  await page.screenshot({ path: path.join(REPO, ".scratch", `theme-${id}.png`) });
  await sleep(120);
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
