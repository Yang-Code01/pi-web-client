/**
 * Probe: 分区字号（D441）—— 五块区域各自缩放，叠在全局「字号」之上相乘。
 *
 * 桩桥 + 真 Chromium，量的是这套机制本身：
 *   1. 默认（没存过 `regionScale`）：五块 computed zoom 全是 1，界面与今天一模一样；
 *   2. 种子偏好把五块各设一档：每块的**盒子**不变、**内容**按倍率缩小（zoom 不撑盒子）；
 *   3. 区域内 `--vh1` 按倍率除回来了：10% 视口的探针在区域里量出来还是 10% 视口；
 *   4. 壳 A 的标签行挂在顶栏里，父子不许各乘一次（双倍）：computed zoom 必须是 1，壳 B 里才是 1.3；
 *   5. 设置里那根「对话正文」滑杆动一下：只有正文变，其余四块一像素不动；双击轨道回 100%。
 *
 * Run: npm --prefix web run build && node probes/region-font.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = Number(process.env.PI_WEB_PORT ?? 7929);
const OUT = path.join(REPO, ".scratch/region-font");
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Date.now();
const LONG = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行：区域倍率叠在全局字号之上相乘，栏宽与窄版判定只认全局那一层。`).join("\n");
const ITEMS = [
  { id: "u0", kind: "user", images: [], ts: new Date(now - 400000).toISOString(), text: "第一轮：字号想每块分开调。" },
  { id: "a0", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 380000).toISOString(), text: LONG },
  { id: "u1", kind: "user", images: [], ts: new Date(now - 300000).toISOString(), text: "第二轮：点缩略图要能准准地跳回这一句。" },
  { id: "a1", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 280000).toISOString(), text: LONG },
  { id: "u2", kind: "user", images: [], ts: new Date(now - 200000).toISOString(), text: "第三轮：往回翻页锚定别跳。" },
  { id: "a2", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 180000).toISOString(), text: LONG },
  { id: "u3", kind: "user", images: [], ts: new Date(now - 100000).toISOString(), text: "第四轮：最后一轮。" },
  { id: "a3", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 80000).toISOString(), text: LONG },
];
let ITEMS_NOW = ITEMS;
const mk = (id, name, extra) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work"), file: null, owned: true, origin: "web",
  running: false, done: false, updatedAt: now, approvals: 0, asks: 0, locked: false, preview: "", ...extra,
});
const SESSIONS = [mk("s-1", "分区字号"), mk("s-2", "别的会话", { updatedAt: now - 90000, done: true })];
const TUNNEL = { status: "off", url: null, error: null, updatedAt: now };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["s-1"], order: [], archived: [] };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
  if (url.pathname === "/api/dirs") return json(200, { path: "", parent: "/", dirs: [], files: [], error: "" });
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
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
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
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: s.id === "s-1" ? ITEMS_NOW : [], approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage, trash: [], tunnel: TUNNEL }));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/** 五块的标记 → prefs 里的字段名（`data-region` 的取值就是字段名）。 */
const REGIONS = ["topbar", "sessions", "chat", "composer", "queue"];

/**
 * 量一次现场。三套坐标要分清楚（Chromium 实测，2026-11 的 Chrome 159）：
 *   · `getBoundingClientRect()` 是**视觉 px**（zoom 之后）；computed / offset 是**元素自己的局域 px**。
 *   · 区域自己的倍率 `own`、祖先到它为止的倍率 `total`（含它自己）都要乘进去，否则跨倍率没法比。
 * 于是：局域 = rect / total；父级坐标里的盒子 = 局域 × own。
 */
async function snap(page) {
  return page.evaluate((regions) => {
    const ui = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
    const totalZoom = (el) => {
      let z = 1;
      for (let n = el; n; n = n.parentElement) {
        const v = Number(getComputedStyle(n).zoom);
        if (Number.isFinite(v) && v > 0) z *= v;
      }
      return z;
    };
    const out = { ui, vw: innerWidth, vh: innerHeight, regions: {} };
    for (const id of regions) {
      const el = document.querySelector(`[data-region="${id}"]`);
      if (!el) { out.regions[id] = null; continue; }
      const total = totalZoom(el);
      const own = Number(getComputedStyle(el).zoom) || 1;
      const local = el.getBoundingClientRect().width / total;
      // vh1：区域内插一个「10% 视口高」的盒子 —— 它的 computed height 就是局域 px
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;height:calc(var(--vh1) * 10);width:1px;visibility:hidden";
      el.append(probe);
      const vhLocal = parseFloat(getComputedStyle(probe).height) || 0;
      probe.remove();
      out.regions[id] = {
        local,                       // 元素自己坐标系里的宽度（倍率越大越小）
        box: local * own,            // 父级坐标里的盒子（跨倍率应当是同一个数）
        own,
        total,
        vh10: vhLocal * total,       // → 视觉 px，应当等于 10% 视口
      };
    }
    return out;
  }, REGIONS);
}

/**
 * 五个 `[data-region]` 节点都在？缺一个就当场记一条可读的失败（带上缺了谁），
 * 别让后面某处 `.box` / `.own` 抛 TypeError 把整个探针崩在没头没尾的地方。
 */
const regionsPresent = (s, label) => {
  const missing = REGIONS.filter((id) => !s.regions[id]);
  if (!missing.length) return true;
  check(`${label}：五个区域节点都在`, false, `缺 ${missing.join(" / ")}（[data-region] 没挂上？）`);
  return false;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
// 静态资源 404（favicon / manifest）不算页面错：桩桥只发 dist 里真有的文件。
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

/** 带种子偏好打开一次（`regionScale` 决定五块倍率；不传就完全不写这个键）。 */
async function boot({ regionScale, layout = "a", scale = 1.25, items } = {}) {
  if (items) ITEMS_NOW = items;
  else if (ITEMS_NOW !== ITEMS) ITEMS_NOW = ITEMS;
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ regionScale, layout, scale }) => {
    const prefs = {
      scale, theme: "mac-light", macAccent: "blue", accentTone: "vivid", lang: "zh-Hans",
      wsCollapsed: [], layout, settingsTab: "look", wsIntroSeen: true, themeIntroSeen: true,
      retellHint: true, githubCards: true, githubAutoPanel: false,
      longCardUser: true, longCardAssistant: false, longCardTool: false,
    };
    if (regionScale) prefs.regionScale = regionScale;
    localStorage.setItem("pi.prefs", JSON.stringify(prefs));
  }, { regionScale, layout, scale });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".session-card").first().click();
  await page.waitForSelector(".chat-scroll .msg", { timeout: 8000 });
  await sleep(200);
}

// ---------------------------------------------------------------- 1. 默认：全部 1.0
await boot();
{
  const s = await snap(page);
  const zooms = REGIONS.map((id) => s.regions[id]?.own ?? NaN);
  check("1. 默认五块 zoom 都是 1（行为零变化）", zooms.every((z) => z === 1), zooms.join(" / "));
  const vh = REGIONS.map((id) => s.regions[id]?.vh10 ?? 0);
  check("1b. 默认区域内 --vh1 就是 10% 视口", vh.every((v) => Math.abs(v - s.vh * 0.1) < 1.5), `${vh.map((v) => v.toFixed(1)).join(" / ")} vs ${(s.vh * 0.1).toFixed(1)}`);
  await page.screenshot({ path: path.join(OUT, "1-default.png") });
}

// ---------------------------------------------------------------- 2. 五块各一档：盒子不变、内容变小
const SEED = { topbar: 1.3, sessions: 0.9, chat: 1.3, composer: 1.2, queue: 0.85 };
await boot({ regionScale: SEED });
const seeded = await snap(page);
await page.screenshot({ path: path.join(OUT, "2-seeded.png") });
{
  const base = await (async () => {
    await boot();
    return snap(page);
  })();
  const haveAll = regionsPresent(seeded, "2 种子态") && regionsPresent(base, "2 基线态");
  // 容差 2.5px：局域 px 会被像素吸附成整数，换算回父级坐标后最多差 1/倍率（实测 1.0–1.5）。
  const boxOk = haveAll && REGIONS.every((id) => Math.abs(seeded.regions[id].box - base.regions[id].box) < 2.5);
  check(
    "2. 盒子不变（会话 / 正文 / 输入框 / 右栏换算回父级坐标后同一个数）",
    boxOk,
    REGIONS.map((id) => `${id} ${seeded.regions[id]?.box?.toFixed(1) ?? "—"}↔${base.regions[id]?.box?.toFixed(1) ?? "—"}`).join(" · "),
  );
  // 内容按倍率缩小：区域矩形的局域宽度 = 盒子 / 总倍率
  const shrinkOk = haveAll && REGIONS.every((id) => {
    const want = base.regions[id].local / (SEED[id] ?? 1);
    return Math.abs(seeded.regions[id].local - want) < 2.5;
  });
  check(
    "2b. 内容宽度按倍率缩小（zoom 只缩内部坐标空间）",
    shrinkOk,
    REGIONS.map((id) => `${id} ${seeded.regions[id]?.local?.toFixed(1) ?? "—"}/${(base.regions[id]?.local ? base.regions[id].local / (SEED[id] ?? 1) : NaN).toFixed(1)}`).join(" · "),
  );
  const vh = REGIONS.map((id) => seeded.regions[id]?.vh10 ?? NaN);
  check("2c. 区域内 --vh1 按倍率除回来（还是 10% 视口）", vh.every((v) => Math.abs(v - seeded.vh * 0.1) < 1.5), vh.map((v) => v.toFixed(1)).join(" / "));
}

// ---------------------------------------------------------------- 3. 壳 A 的标签行不许双倍
// 必须自己再种一次：上面为了量「盒子不变」的基线把它切回默认态了（`--rs-topbar` 是 1 的话，
// 双倍不双倍都看不出来 —— 这条断言会假绿）。
await boot({ regionScale: SEED });
{
  const z = await page.evaluate(() => ({
    layout: document.documentElement.dataset.layout,
    topbar: getComputedStyle(document.querySelector(".topbar")).zoom,
    tabsNested: Boolean(document.querySelector(".topbar > .ws-tabs-row")),
    tabsZoom: getComputedStyle(document.querySelector(".ws-tabs-row")).zoom,
  }));
  check("3. 壳 A 标签行挂在顶栏里、自己不再乘一次", z.layout === "a" && z.tabsNested && Number(z.tabsZoom) === 1, JSON.stringify(z));
}

// ---------------------------------------------------------------- 4. 壳 B 的标签行是网格子项，要乘
await boot({ regionScale: SEED, layout: "b" });
{
  const z = await page.evaluate(() => ({
    layout: document.documentElement.dataset.layout,
    nested: Boolean(document.querySelector(".topbar > .ws-tabs-row")),
    tabsZoom: Number(getComputedStyle(document.querySelector(".ws-tabs-row")).zoom),
  }));
  check("4. 壳 B 标签行是独立一行，zoom 跟着顶栏倍率走", z.layout === "b" && !z.nested && Math.abs(z.tabsZoom - 1.3) < 0.001, JSON.stringify(z));
  await page.screenshot({ path: path.join(OUT, "3-shell-b.png") });
}

// ---------------------------------------------------------------- 5. 设置面板：只有一根区域滑杆，动它只影响正文
await boot();
const openLook = async () => {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  const nav = page.locator('.display-sheet .st-nav__item[data-tab="look"]');
  if (await nav.count()) await nav.first().click().catch(() => {});
  await page.locator('.display-sheet .st-nav__item[data-sec="lang"]').click().catch(() => {});
  await sleep(150);
};
await openLook();

/**
 * 按「这一行的 label」找设置行。只在 `.settings-label` 子树里匹配 —— 整行 `hasText` 会被 hint 里的
 * 同名文字带跑（顶栏那行的 hint 就写着「顶栏按钮」），命中两行时 strict 直接报错、看不出是撞了名字。
 */
const settingsRow = (label) =>
  page.locator(".display-sheet .settings-row").filter({ has: page.locator(".settings-label", { hasText: label }) });
{
  const rows = await page.evaluate(() => {
    const sheet = document.querySelector(".display-sheet");
    const all = [...sheet.querySelectorAll(".settings-row")].filter((r) => r.querySelector(".size-ctl"));
    const head = [...sheet.querySelectorAll(".settings-group")].find((g) => (g.textContent ?? "").includes("分区字号"));
    return {
      rows: all.map((r) => ({
        label: (r.querySelector(".settings-label")?.textContent ?? "").replace(/\d+%$/, "").trim(),
        read: (r.querySelector(".size-read")?.textContent ?? "").trim(),
      })),
      head: head ? (head.textContent ?? "").trim() : "",
    };
  });
  // 顺手留一张「分组头 + 前两行」的样张：面板比一屏长，默认停在中段看不到头。
  await page.locator(".display-sheet .settings-panel").first().evaluate((el) => { el.scrollTop = 0; el.parentElement?.scrollTo?.(0, 0); });
  await sleep(120);
  await page.screenshot({ path: path.join(OUT, "4-panel-top.png") });
  const wantLabels = ["字号", "顶栏", "会话列表", "对话正文", "输入框", "右栏面板"];
  check(
    "5. 「语言与字号」里六行滑杆：全局字号 + 五块，顺序照界面上到下 / 左到右",
    rows.rows.length === 6 && wantLabels.every((l, i) => rows.rows[i].label === l),
    JSON.stringify(rows.rows.map((r) => r.label)),
  );
  check("5b. 五块都从 100% 起步，分组头写明乘法关系", rows.rows.slice(1).every((r) => r.read === "100%") && rows.head.includes("各自叠在"), JSON.stringify({ head: rows.head, reads: rows.rows.map((r) => r.read) }));

  const before = await snap(page);
  const chatRow = settingsRow("对话正文");
  const range = chatRow.locator('input[type="range"]');
  // 键盘按 10 下 = +10%（步长 1%，键盘不吃磁吸）
  await range.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab"); // blur → 落盘
  await sleep(250);
  const after = await snap(page);
  const grew = after.regions.chat.local < before.regions.chat.local - 5;
  const othersStill = ["sessions", "composer", "queue"].every((id) => Math.abs(after.regions[id].box - before.regions[id].box) < 0.6);
  check("5c. 拖正文那根：正文变窄（内容空间变小）", grew, `局域 ${before.regions.chat.local.toFixed(1)} → ${after.regions.chat.local.toFixed(1)}（倍率 ${before.regions.chat.own} → ${after.regions.chat.own}）`);
  check("5d. 其余三块一像素不动", othersStill, ["sessions", "composer", "queue"].map((id) => `${id} ${before.regions[id].box.toFixed(1)}→${after.regions[id].box.toFixed(1)}`).join(" · "));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").regionScale);
  check("5e. 区域倍率写进 prefs（其余四块不动）", Math.abs((saved?.chat ?? 0) - 1.1) < 0.02 && saved?.sessions === 1 && saved?.queue === 1, JSON.stringify(saved));
  await page.screenshot({ path: path.join(OUT, "4-panel.png") });

  // 双击轨道回 100%
  await chatRow.locator(".size-rail").dblclick();
  await sleep(250);
  const back = await snap(page);
  check("5f. 双击轨道回 100%", Math.abs(back.regions.chat.local - before.regions.chat.local) < 1, `${back.regions.chat.local.toFixed(1)} vs ${before.regions.chat.local.toFixed(1)}`);
}

// ---------------------------------------------------------------- 6. 窄屏：多出来的那一行不许把面板顶出去
{
  // 面板就开着（步骤 5 没关）：只改窗口，看它怎么重排 —— 这样测的正是「多一行之后窄屏还放不放得下」。
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const narrow = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".display-sheet .settings-row")].find((r) => (r.textContent ?? "").includes("对话正文"));
    const r = row?.getBoundingClientRect();
    return {
      rowRight: r ? r.right : null,
      rowWidth: r ? r.width : null,
      vw: innerWidth,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      sheetOverflow: (() => {
        const pnl = document.querySelector(".display-sheet .settings-panel");
        return pnl ? pnl.scrollWidth - pnl.clientWidth : -1;
      })(),
    };
  });
  check("6a. 窄屏下多出来的那行不把页面 / 面板撑出横向滚动", narrow.docOverflow <= 0 && narrow.sheetOverflow <= 0, JSON.stringify(narrow));
  check("6b. 窄屏下那行在窗口里", narrow.rowRight !== null && narrow.rowRight <= narrow.vw + 1, JSON.stringify(narrow));
  await page.screenshot({ path: path.join(OUT, "5-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 860 });
  await sleep(150);
}

// ---------------------------------------------------------------- 7. 刻度值必须夹成两位小数（不是 1.2000000000000002）
{
  // 面板在上一步还开着。字号那根点「120」档：SIZE_MARKS 是 0.8 + i*0.2 算出来的浮点。
  const sizeRow = settingsRow("字号");
  await sizeRow.locator(".mark", { hasText: /^120$/ }).click();
  await sleep(200);
  const sizeMarked = await page.evaluate(() => ({
    prefs: JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").scale,
    uiVar: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
    range: document.querySelector('.display-sheet .settings-row input[type="range"]')?.value,
  }));
  check("7. 点 120 档存成 1.2（不是 1.2000000000000002）", sizeMarked.prefs === 1.2 && sizeMarked.uiVar === "1.2" && sizeMarked.range === "1.2", JSON.stringify(sizeMarked));

  const chatRow2 = settingsRow("对话正文");
  // 刻度是 80…200 每 0.2：点 120 档同样会碰到 1.2000000000000002 的浮点尾巴
  await chatRow2.locator(".mark", { hasText: /^120$/ }).click();
  await sleep(200);
  const chatMarked = await page.evaluate(() => ({
    prefs: JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").regionScale?.chat,
    rsVar: getComputedStyle(document.documentElement).getPropertyValue("--rs-chat").trim(),
    zoom: Number(getComputedStyle(document.querySelector('[data-region="chat"]')).zoom),
  }));
  check("7b. 区域那根点 120 档：prefs / --rs-chat / 实际 zoom 三处都是 1.2", chatMarked.prefs === 1.2 && chatMarked.rsVar === "1.2" && chatMarked.zoom === 1.2, JSON.stringify(chatMarked));

  // 复位，别把 120% 带进后面的段
  await sizeRow.locator(".size-rail").dblclick();
  await chatRow2.locator(".size-rail").dblclick();
  await sleep(200);
}

// ---------------------------------------------------------------- 8. 区域倍率 ≠ 100% 时点缩略图跳轮次，落点要对
// 出问题的是 `contentTopOf()`：它以前只除全局 `--ui-scale`，正文 130% 时会按 1.3 倍滚过头，
// 起步位置还可能 ≥ maxScroll 被误判成「已在最后一屏」而直接回到底部。
for (const rs of [1, 1.3]) {
  await boot({ regionScale: { ...SEED, chat: rs } });
  const rows = page.locator(".turn-row:not(.ghost)");
  const count = await rows.count();
  // 照真人走一遍：先悬停那颗「轮次」命中区把带子摊开（收起态按短横算，行本身没高度），
  // 再按展开后的行位置点第 2 轮。直接对行派发 click 会落在 0 尺寸的盒子上，什么都不会发生。
  await page.locator(".turn-rail .turn-hit").hover();
  await sleep(420);
  const rowBox = await rows.nth(1).boundingBox();
  if (!rowBox) throw new Error("第 2 轮那一行量不到位置");
  await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  // 平滑滚动 + holdFollow（900ms）走完再看
  await sleep(1200);
  const jump = await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    const users = [...document.querySelectorAll(".chat-scroll .msg.user")];
    const target = users[1];
    const ui = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
    const own = Number.parseFloat(getComputedStyle(root).zoom) || 1;
    const box = root.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    return {
      // 目标轮的首行离视口顶部多远（换算回布局 px：代码里期望是 6px 呼吸）
      deltaLocal: (r.top - box.top) / (ui * own),
      scrollTop: root.scrollTop,
      max: root.scrollHeight - root.clientHeight,
    };
  });
  const landed = Math.abs(jump.deltaLocal - 6) < 6;
  const notBottom = jump.scrollTop < jump.max - 40;
  check(`8. 正文 ${Math.round(rs * 100)}%：点缩略图第 2 轮，目标落在视口顶部（6px 呼吸）`, landed, JSON.stringify({ deltaLocal: +jump.deltaLocal.toFixed(1), scrollTop: Math.round(jump.scrollTop), max: Math.round(jump.max) }));
  check(`8b. 正文 ${Math.round(rs * 100)}%：没有被误判成贴底而弹回底部`, notBottom, JSON.stringify({ scrollTop: Math.round(jump.scrollTop), max: Math.round(jump.max) }));
  check(`8c. 正文 ${Math.round(rs * 100)}%：缩略图行数对得上（4 轮都载入了）`, count >= 4, `rows=${count}`);
  await page.screenshot({ path: path.join(OUT, `6-jump-${Math.round(rs * 100)}.png`) });
}

// ---------------------------------------------------------------- 9. 缩略图带子的几何不许跟着正文倍率变
// 带子挂在 `.chat-pane` 上（只乘 `--ui-scale`），而 `.chat-scroll` 自己还挂着一层区域倍率。
// 它以前拿 `viewport.clientHeight`（正文局域 px）当视口高，正文 130% 时高度上限就按 1/1.3 缩一圈。
{
  const MANY = [
    { id: "uM0", kind: "user", images: [], ts: new Date(now - 900000).toISOString(), text: "起个头" },
    { id: "aM0", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 890000).toISOString(), text: "好。" },
  ];
  for (let i = 1; i < 20; i++) {
    MANY.push({ id: `uM${i}`, kind: "user", images: [], ts: new Date(now - 900000 + i * 2000).toISOString(), text: `第 ${i + 1} 轮` });
    MANY.push({ id: `aM${i}`, kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 899000 + i * 2000).toISOString(), text: "收到。" });
  }
  const railGeo = async (rs) => {
    await boot({ regionScale: { ...SEED, chat: rs }, items: MANY });
    await page.locator(".turn-rail .turn-hit").hover();
    await sleep(420);
    return page.evaluate(() => {
      const rail = document.querySelector(".turn-rail");
      const cs = getComputedStyle(rail);
      const root = document.querySelector(".chat-scroll");
      const ui = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
      return {
        panel: cs.getPropertyValue("--turn-panel-h").trim(),
        compact: cs.getPropertyValue("--turn-compact-h").trim(),
        rows: cs.getPropertyValue("--turn-rows-h").trim(),
        // 带子自己的坐标空间（只乘 --ui-scale）：正文视口在它这里有多高
        viewH: Math.round(root.getBoundingClientRect().height / ui),
      };
    });
  };
  const at100 = await railGeo(1);
  const at130 = await railGeo(1.3);
  check(
    "9. 正文 130% 时缩略图带子的高度 / 行高与 100% 一模一样",
    at100.panel === at130.panel && at100.compact === at130.compact && at100.rows === at130.rows && at100.viewH === at130.viewH,
    JSON.stringify({ at100, at130 }),
  );
  await page.screenshot({ path: path.join(OUT, "7-rail-130.png") });
}

// 5g. 五根各管各的：每根按 10 下方向键，只有它那一块变、其余四块的盒子不动
{
  // 起点显式种成 SEED（顶栏 1.3 / 会话 0.9 / 正文 1.3 / 输入框 1.2 / 右栏 0.85），
  // 不再依赖「上一段 boot 完之后刚好是 SEED」这种隐式前提 —— 段落顺序一调，这里就会静默漂走。
  await boot({ regionScale: SEED });
  await openLook();
  const PAIRS = [
    ["topbar", "顶栏"],
    ["sessions", "会话列表"],
    ["chat", "对话正文"],
    ["composer", "输入框"],
    ["queue", "右栏面板"],
  ];
  for (const [id, label] of PAIRS) {
    const row = settingsRow(label);
    const before = await snap(page);
    await row.locator('input[type="range"]').focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Tab"); // blur → 落盘
    await sleep(200);
    const after = await snap(page);
    if (!regionsPresent(before, `5g ${label} 前`) || !regionsPresent(after, `5g ${label} 后`)) continue;
    // 起点：**这一块自己**的倍率还是 SEED 那一档（每轮末尾的 dblclick 只把自己复位成 100%，
    // 也不影响下一轮 —— 下一轮比的是它自己的 before/after 快照）。所以断言写成「自己的倍率 +0.1、
    // 局域宽度按新倍率缩小」，不是写死的 ×1.1 —— 否则这条只有在从 100% 起步时才成立。
    // 其余四块在后续几轮里早已不是 SEED 了（被前面几轮的 dblclick 复位过），`still` 比的是同一轮的
    // 前后快照，所以照样成立。
    const from = before.regions[id].own;
    const wantOwn = Math.round((from + 0.1) * 100) / 100;
    const ratio = before.regions[id].local / after.regions[id].local;
    const wantRatio = wantOwn / from;
    const stillIds = PAIRS.map(([x]) => x).filter((x) => x !== id);
    const still = stillIds.every((x) => Math.abs(after.regions[x].box - before.regions[x].box) < 0.6);
    check(
      `5g. 「${label}」+10%：只有这一块变，其余四块盒子不动`,
      Math.abs(after.regions[id].own - wantOwn) < 0.011 && Math.abs(ratio - wantRatio) < 0.02 && still,
      `own ${from}→${after.regions[id].own}（预期 ${wantOwn}）· 局域 ×${ratio.toFixed(3)}（预期 ×${wantRatio.toFixed(3)}）· ` +
        stillIds.map((x) => `${x} ${before.regions[x].box.toFixed(1)}→${after.regions[x].box.toFixed(1)}`).join(" · "),
    );
    await row.locator(".size-rail").dblclick();
    await sleep(150);
  }
}

check("10. 没有页面报错"
, errors.length === 0, errors.slice(0, 3).join(" | "));

await ctx.close();
await browser.close();
server.close();
wss.close();
console.log(bad ? `\n${bad} 项失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
