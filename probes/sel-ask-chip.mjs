/**
 * Probe: 聊天记录拖选 → 「问一下」小胶囊 → 点它把这段引用进随手问（D416）。
 *
 * 桩桥：一条用户消息 + 一段带列表的助手回答。量的是那条链子本身：
 *   - 在聊天区真拖一段（`mouse.down/move/up`，不是 `addRange`）→ 胶囊出现在选区末行下方；
 *   - 胶囊不出窗口（含字号 1.25 时 —— `#app` 有 zoom，位置算错就会偏出去）；
 *   - 输入框 / 可编辑区里的选区、聊天区外的选区都不弹；
 *   - 点胶囊 → 随手问打开，输入框里是 `> ` 逐行引用，已写的草稿还在；
 *   - 点别处 / Esc / 滚轮都收起来。
 *
 * 截图写到 .scratch/sel-ask/。
 *
 * Run: npm --prefix web run build && node probes/sel-ask-chip.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = Number(process.env.PI_WEB_PORT ?? 7919);
const OUT = path.join(REPO, ".scratch/sel-ask");
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Date.now();
const ITEMS = [
  {
    id: "u0",
    kind: "user",
    images: [],
    ts: new Date(now - 120000).toISOString(),
    text: "拖动选中不明显，看看主题色和选中色是不是打架了",
  },
  {
    id: "a0",
    kind: "assistant",
    thinking: "",
    model: "probe",
    ts: new Date(now - 100000).toISOString(),
    text: [
      "选中底和用户气泡的底色是同一个强调色，所以叠上去一点变化都没有。",
      "",
      "改法是：",
      "- 全局把选中底改成实心强调色，字用强调色的反相色；",
      "- 强调色实底的气泡里再反过来一次。",
    ].join("\n"),
  },
];
const mk = (id, name, extra) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work"), file: null, owned: true, origin: "web",
  running: false, done: false, updatedAt: now, approvals: 0, asks: 0, locked: false, preview: "", ...extra,
});
const SESSIONS = [mk("s-1", "选区可见性"), mk("s-2", "别的会话", { updatedAt: now - 90000, done: true })];
const TUNNEL = { status: "off", url: null, error: null, updatedAt: now };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["s-1", "s-2"], order: [], archived: [] };

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
  if (url.pathname === "/api/dirs") return json(200, { path: "", parent: "F:", dirs: [], files: [], error: "" });
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
    // 随手问打开时桥会回一帧状态；这里只给个空会话，输入框那侧不等它。
    if (msg.type === "scratch.open") {
      ws.send(JSON.stringify({ type: "scratch", sessionId: "scratch-probe", state: { id: "scratch-probe", running: false, scratch: true }, items: [], models: [], ctx: null }));
    }
    if (msg.type === "subscribe") {
      const s = SESSIONS.find((x) => x.id === msg.sessionId) ?? SESSIONS[0];
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: s.id === "s-1" ? ITEMS : [], approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage, trash: [], tunnel: TUNNEL }));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/** 在 selector 指的内容上真拖一遍（首行 → 末行），返回选中的文字。 */
async function dragOver(page, sel) {
  const pts = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
    if (!rects.length) return null;
    const first = rects[0];
    const last = rects[rects.length - 1];
    return {
      x1: Math.round(first.left + 2),
      y1: Math.round(first.top + first.height / 2),
      x2: Math.round(last.right - 2),
      y2: Math.round(last.top + last.height / 2),
    };
  }, sel);
  if (!pts) return "";
  await page.mouse.move(pts.x1, pts.y1);
  await page.mouse.down();
  await page.mouse.move(pts.x2, pts.y2, { steps: 14 });
  await page.mouse.up();
  await sleep(120);
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 胶囊与选区末行的几何关系（视觉 px）。 */
async function chipGeo(page) {
  return page.evaluate(() => {
    const chip = document.querySelector(".sel-ask");
    if (!chip) return null;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const rects = range ? [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 2) : [];
    const last = rects[rects.length - 1] ?? null;
    const r = chip.getBoundingClientRect();
    return {
      hidden: chip.hidden,
      label: (chip.textContent ?? "").trim(),
      chip: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height },
      last: last ? { left: last.left, top: last.top, right: last.right, bottom: last.bottom } : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
      inApp: Boolean(chip.closest("#app")),
      zoom: getComputedStyle(document.getElementById("app") ?? document.body).zoom,
      appW: Math.round((document.getElementById("app") ?? document.body).getBoundingClientRect().width),
      bodyFont: getComputedStyle(document.querySelector(".chat-scroll .msg.assistant .body") ?? document.body).fontSize,
    };
  });
}

const chipVisible = (g) => Boolean(g) && g.hidden === false && g.chip.w > 0;
/** 胶囊在窗口里、并且落在选区末行下方（翻上去时落在末行上方）。 */
const chipPlaced = (g) => {
  if (!g || !g.last) return false;
  const inside = g.chip.left >= -1 && g.chip.top >= -1 && g.chip.right <= g.vw + 1 && g.chip.bottom <= g.vh + 1;
  const horizontal = g.chip.left < g.last.right + 1 && g.chip.right > g.last.left - 1;
  const below = g.chip.top >= g.last.bottom - 1;
  const above = g.chip.bottom <= g.last.top + 1;
  return inside && horizontal && (below || above);
};
const hidden = (g) => !g || g.hidden === true || g.chip.w === 0;

const lum = ([r, g, b]) => {
  const ch = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const chanDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** 胶囊周围一圈（含上方选区末行与下方一点影子），用来截图看效果。 */
const cropAround = (g) => ({
  x: Math.max(0, Math.floor(g.chip.left) - 260),
  y: Math.max(0, Math.floor(g.chip.top) - 46),
  width: Math.ceil(g.chip.w) + 300,
  height: Math.ceil(g.chip.h) + 76,
});

/**
 * 截图量胶囊的材质：右侧留白处那圈底色、label 的字色、左边那条描边。
 * 玻璃是半透明的，computed style 只能给到 rgba，真正叠出来什么色必须看像素。
 */
async function sampleChip(page, g) {
  const clip = {
    x: Math.floor(g.chip.left) - 2,
    y: Math.floor(g.chip.top) - 2,
    width: Math.ceil(g.chip.w) + 4,
    height: Math.ceil(g.chip.h) + 4,
  };
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ b64, ox, oy, w, h }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const read = (r) => {
        const x = Math.max(0, Math.floor(r.x));
        const y = Math.max(0, Math.floor(r.y));
        const rw = Math.max(1, Math.min(Math.ceil(r.w), c.width - x));
        const rh = Math.max(1, Math.min(Math.ceil(r.h), c.height - y));
        const d = ctx.getImageData(x, y, rw, rh).data;
        const counts = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        let mode = 0;
        let best = -1;
        for (const [k, n] of counts) if (n > best) [mode, best] = [k, n];
        const mc = [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255];
        let ink = null;
        let inkBest = 0;
        const inkCounts = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const dist = Math.abs(d[i] - mc[0]) + Math.abs(d[i + 1] - mc[1]) + Math.abs(d[i + 2] - mc[2]);
          if (dist < 90) continue;
          const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          inkCounts.set(k, (inkCounts.get(k) ?? 0) + 1);
        }
        for (const [k, n] of inkCounts) if (n > inkBest) [ink, inkBest] = [k, n];
        return { bg: mc, ink: ink === null ? null : [(ink >> 16) & 255, (ink >> 8) & 255, ink & 255] };
      };
      return {
        // 右侧内边距里没有字，只可能是玻璃叠出来的底色
        fill: read({ x: ox + w - 9, y: oy + h / 2 - 3, w: 4, h: 6 }),
        ink: read({ x: ox + 26, y: oy + 7, w: Math.max(4, w - 40), h: h - 14 }),
        edge: read({ x: ox, y: oy + h / 2 - 3, w: 1, h: 6 }),
      };
    },
    { b64: png.toString("base64"), ox: Math.floor(g.chip.left) - clip.x, oy: Math.floor(g.chip.top) - clip.y, w: g.chip.w, h: g.chip.h },
  );
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  // 默认字号是 1.25（DEFAULT_SCALE），这里钉成 100%，让主流程跑在「不用换算」的那条路上
  await context.addInitScript(() => {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    p.scale = 1;
    localStorage.setItem("pi.prefs", JSON.stringify(p));
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".session-card", { timeout: 8000 });
  await page.locator(".session-card", { hasText: "选区可见性" }).first().click();
  await page.waitForSelector(".chat-scroll .msg.assistant", { timeout: 8000 });
  await sleep(600);

  // ---- 1. 聊天区里拖选：胶囊出来，位置对
  const text = await dragOver(page, ".chat-scroll .msg.assistant .body");
  check("拖选拿到了文字", text.trim().length > 10, `${text.length} 字`);
  let geo = await chipGeo(page);
  check("拖选后胶囊可见", chipVisible(geo), JSON.stringify(geo?.chip));
  check("100% 字号下胶囊是 CSS 原尺寸（没被多除一次）", geo?.zoom === "1" && Math.abs(geo.chip.h - 26) < 1.5, `zoom=${geo?.zoom} h=${geo?.chip?.h}`);
  check("胶囊文字是「问一下」", geo?.label === "问一下", geo?.label ?? "没找到");
  check("胶囊在选区末行下方、不出窗口", chipPlaced(geo), JSON.stringify({ chip: geo?.chip, last: geo?.last }));
  check("胶囊挂在 #app 里（跟着字号缩放）", geo?.inApp === true);
  await page.screenshot({ path: path.join(OUT, "drag-chip.png") });

  // ---- 2. 点胶囊：随手问打开，输入框里是引用
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  await page.click(".sel-ask");
  await page.waitForSelector(".scratch-back:not([hidden]) .sc-input", { timeout: 8000 });
  await sleep(150);
  const quoted = await page.inputValue(".sc-input");
  check("点胶囊后随手问打开了", await page.isVisible(".scratch-sheet"));
  check("引用逐行带「> 」", quoted.startsWith("> ") && quoted.split("\n").filter((l) => l.startsWith("> ")).length === lines.length, JSON.stringify(quoted.slice(0, 60)));
  check("引用里有选中的首行与末行", lines.length > 0 && quoted.includes(lines[0]) && quoted.includes(lines[lines.length - 1]));
  check("引用块后留了空行给用户接着写", /\n\n$/.test(quoted), JSON.stringify(quoted.slice(-8)));
  geo = await chipGeo(page);
  check("点完胶囊自己收起来了", hidden(geo));
  await page.screenshot({ path: path.join(OUT, "quoted.png") });

  // ---- 3. 已有草稿：追加，不覆盖
  await page.fill(".sc-input", "草稿：先别丢");
  await page.click(".scratch-close");
  await sleep(150);
  await dragOver(page, ".chat-scroll .msg.user .body");
  await page.click(".sel-ask");
  await page.waitForSelector(".scratch-back:not([hidden]) .sc-input", { timeout: 8000 });
  const appended = await page.inputValue(".sc-input");
  check("已有草稿保留在前面", appended.startsWith("草稿：先别丢"), JSON.stringify(appended.slice(0, 20)));
  check("草稿与引用块之间空了一行", appended.startsWith("草稿：先别丢\n\n> "), JSON.stringify(appended.slice(0, 24)));
  await page.fill(".sc-input", "");
  await page.click(".scratch-close");
  await sleep(150);

  // ---- 4. 不该弹的地方：聊天区之外的选区、输入框里的选区
  const railText = await page.evaluate(() => {
    const card = document.querySelector(".session-card");
    return card ? card.textContent.trim().slice(0, 6) : "";
  });
  if (railText) {
    await dragOver(page, ".session-card");
    geo = await chipGeo(page);
    check("左栏会话卡上的选区不弹（只管聊天区）", hidden(geo), railText);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }
  const composer = ".composer textarea";
  if (await page.isVisible(composer)) {
    await dragOver(page, composer);
    geo = await chipGeo(page);
    check("输入框里的选区不弹", hidden(geo));
  }

  // ---- 5. 点别处 / Esc / 滚轮都收起来
  await dragOver(page, ".chat-scroll .msg.assistant .body");
  check("（前置）胶囊先出来", chipVisible(await chipGeo(page)));
  const empty = await page.evaluate(() => {
    const r = document.querySelector(".chat-scroll").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 60) };
  });
  await page.mouse.click(empty.x, empty.y);
  await sleep(80);
  check("点聊天区空白处（选区被点掉）后收起", hidden(await chipGeo(page)), JSON.stringify(empty));

  await dragOver(page, ".chat-scroll .msg.assistant .body");
  await page.keyboard.press("Escape");
  await sleep(80);
  check("Esc 收起", hidden(await chipGeo(page)));
  if (await page.isVisible(".scratch-sheet")) await page.click(".scratch-close");

  await dragOver(page, ".chat-scroll .msg.assistant .body");
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 240);
  await sleep(150);
  check("滚轮滚动后收起", hidden(await chipGeo(page)));

  // ---- 6. 字号 150%：位置按 zoom 换算，仍然贴着末行、不出窗口
  const zoomCtx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  await zoomCtx.addInitScript(() => {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    p.scale = 1.5;
    localStorage.setItem("pi.prefs", JSON.stringify(p));
  });
  const zoomPage = await zoomCtx.newPage();
  zoomPage.on("pageerror", (e) => console.log("page error:", e.message));
  await zoomPage.goto(BASE, { waitUntil: "networkidle" });
  await zoomPage.waitForSelector(".session-card", { timeout: 8000 });
  await zoomPage.locator(".session-card", { hasText: "选区可见性" }).first().click();
  await zoomPage.waitForSelector(".chat-scroll .msg.assistant", { timeout: 8000 });
  await sleep(600);
  const zoomApplied = await zoomPage.evaluate(() => getComputedStyle(document.getElementById("app")).zoom);
  await dragOver(zoomPage, ".chat-scroll .msg.assistant .body");
  const zgeo = await chipGeo(zoomPage);
  check("字号 150% 下胶囊可见", chipVisible(zgeo), `zoom=${zoomApplied}`);
  check("字号 150% 下胶囊是 26px 的 1.5 倍（zoom 真生效了）", Math.abs((zgeo?.chip?.h ?? 0) - 26 * 1.5) < 2, `zoom=${zgeo?.zoom} h=${zgeo?.chip?.h}`);
  check("字号 150% 下仍贴着选区末行、不出窗口", chipPlaced(zgeo), JSON.stringify({ chip: zgeo?.chip, last: zgeo?.last, zoom: zgeo?.zoom }));
  await zoomPage.screenshot({ path: path.join(OUT, "zoom-150.png") });
  await zoomCtx.close();

  // ---- 7. 胶囊的材质跟主题走：玻璃 + 主题描边 + 主题投影
  //    叠在强调色实底的气泡上和叠在面板上必须不是一个色 —— 这条会红，如果胶囊是一块不透明的 --panel。
  const skins = [];
  for (const theme of ["mac-light", "mac-dark", "mac-midnight"]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
    await ctx.addInitScript((t) => {
      const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      p.theme = t;
      p.scale = 1;
      localStorage.setItem("pi.prefs", JSON.stringify(p));
    }, theme);
    const tp = await ctx.newPage();
    tp.on("pageerror", (e) => console.log("page error:", e.message));
    await tp.goto(BASE, { waitUntil: "networkidle" });
    await tp.waitForSelector(".session-card", { timeout: 8000 });
    await tp.locator(".session-card", { hasText: "选区可见性" }).first().click();
    await tp.waitForSelector(".chat-scroll .msg.assistant", { timeout: 8000 });
    await sleep(500);
    await tp.bringToFront();

    // 叠在助手面板（玻璃面板）上
    await dragOver(tp, ".chat-scroll .msg.assistant .body");
    const gAsst = await chipGeo(tp);
    check(`${theme} · 拖选后胶囊可见`, chipVisible(gAsst), JSON.stringify(gAsst?.chip));
    const onPanel = await sampleChip(tp, gAsst);
    const style = await tp.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".sel-ask"));
      return {
        blur: cs.backdropFilter || cs.webkitBackdropFilter,
        shadow: cs.boxShadow,
        borderW: cs.borderTopWidth,
        border: cs.borderTopColor,
      };
    });
    await tp.screenshot({ path: path.join(OUT, `${theme}-chip.png`) });
    await tp.screenshot({ path: path.join(OUT, `${theme}-chip-crop.png`), clip: cropAround(gAsst) });

    // 叠在用户气泡（强调色实底）上
    await dragOver(tp, ".chat-scroll .msg.user .body");
    const gUser = await chipGeo(tp);
    const onBubble = await sampleChip(tp, gUser);
    // 旁边也存一张：胶囊压在蓝气泡上时玻璃会收进那点蓝，跟面板上的那张摆一起看
    await tp.screenshot({ path: path.join(OUT, `${theme}-chip-on-bubble.png`), clip: cropAround(gUser) });

    const panelVar = ratio(onPanel.ink.ink, onPanel.fill.bg);
    const bubbleVar = ratio(onBubble.ink.ink, onBubble.fill.bg);
    check(
      `${theme} · 胶囊上的字读得出（字对胶囊底 ≥ 4.5）`,
      panelVar >= 4.5 && bubbleVar >= 4.5,
      `面板 ${panelVar.toFixed(2)}:1 ${hex(onPanel.ink.ink)}/${hex(onPanel.fill.bg)} · 气泡 ${bubbleVar.toFixed(2)}:1 ${hex(onBubble.ink.ink)}/${hex(onBubble.fill.bg)}`,
    );
    check(`${theme} · 胶囊是玻璃（backdrop-filter 带 blur）`, /blur/.test(style.blur), style.blur || "没有 backdrop-filter");
    check(
      `${theme} · 玻璃是透的：叠在蓝气泡上和叠在面板上不是一个色`,
      chanDiff(onBubble.fill.bg, onPanel.fill.bg) >= 8,
      `气泡上 ${hex(onBubble.fill.bg)} / 面板上 ${hex(onPanel.fill.bg)}`,
    );
    check(
      `${theme} · 胶囊有一圈发丝描边（半透明、跟主题的 glass-line 同款）`,
      // DPR 1 上 CSS 的 0.5px 会被浏览器向上取到 1 个设备像素，所以只能“不超过 1px”
      parseFloat(style.borderW) <= 1 && /rgba?\([^)]*,[\s]*0?\.\d+\)/.test(style.border),
      `${style.borderW} ${style.border}`,
    );
    check(
      `${theme} · 描边真的画出来了（边缘像素与底色不同）`,
      chanDiff(onPanel.edge.bg, onPanel.fill.bg) >= 3,
      `描边 ${hex(onPanel.edge.bg)} / 底色 ${hex(onPanel.fill.bg)}`,
    );
    skins.push({ theme, shadow: style.shadow });
    await ctx.close();
  }
  check(
    "三套主题的胶囊投影各不相同（不是写死的黑）",
    new Set(skins.map((s) => s.shadow)).size === 3,
    skins.map((s) => `${s.theme}: ${s.shadow.slice(0, 40)}`).join(" | "),
  );
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
