/**
 * Probe: 设置控制台跟着字号缩放（D454）＋ 拖动时让开（#742 / D450）。
 *
 * 桩桥 + 真 Chromium，量的是**用户看得见的行为**，不是类名或 DOM 结构：
 *   1. 控制台跟着「整页字号」一起放大（D454）：它仍挂在 body 上（不在 `#app` 的 zoom 子树里），
 *      但自己吃 `zoom: var(--st-zoom)`；外框按 `--st-frame` 长大到吃满窗口，所以 2.0 下字与框都变大、
 *      那根字号滑杆仍在视口内（反证：改之前 2.0 下面板撑满整屏、轨道视觉 y ≈ 984 > 836）。
 *   2. 阈值：指针只挪 3px 不让开，挪 40px 才让开（单击轨道 / 点刻度不闪），量在「字号」那根上。
 *      分区轨道同一套阈值；只有「设置与控制台」整根不让开（D455）—— 它改的就是面板自己的框，
 *      再淡掉等于「拖一下就关掉了设置」。
 *   3. 让开：控制台淡到几乎全隐、遮罩全透且不模糊；真页面里正文那一块的视觉尺寸跟着变
 *      （证明它真的在变，不只是画了个透明层）。
 *   4. 胶囊：读数文本 + 只读细轨道的填充宽度。
 *   5. 键盘：方向键调值也让它露一下，约 400ms 自己回来；松手是下一帧就回来。
 *   6. Esc：拖动中按 Esc 撤掉这次拖动（值回原样、面板不关）。
 *
 * Run: npm --prefix web run build && node probes/console-peek.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
const OUT = path.join(REPO, ".scratch/console-peek");
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
  { id: "u0", kind: "user", images: [], ts: new Date(now - 60000).toISOString(), text: "字号想一眼看出效果。" },
  {
    id: "a0",
    kind: "assistant",
    thinking: "",
    model: "probe",
    ts: new Date(now - 50000).toISOString(),
    text: "让开之后这一块会跟着倍率重新换行，正文越宽、字号越大，一行装得下的字越少。",
  },
];
const mk = (id, name) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work"), file: null, owned: true, origin: "web",
  running: false, done: false, updatedAt: now, approvals: 0, asks: 0, locked: false, preview: "",
});
const SESSIONS = [mk("s-1", "控制台让开"), mk("s-2", "别的会话")];
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
  // 前缀要比到分隔符：只写 `startsWith(DIST)` 的话 `dist-other/…` 也能通过。
  if (!path.resolve(file).startsWith(path.resolve(DIST) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage, trash: [], tunnel: TUNNEL }));
});
await new Promise((r, reject) => {
  // 端口被占时 `listen` 不会调回调：不接住这个 error，探针会静默挂死，看不出是被谁占了。
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", r);
}).catch((err) => {
  console.log(`FAIL 桩桥起不来（端口 ${PORT}）：${err?.message ?? err}`);
  process.exit(1);
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 836 }, locale: "zh-CN" });
const page = await ctx.newPage();
// 面板可用宽 / 内容宽的量法注入一次，geo() 与 modelGeo() 都调它：
// 两处各写一遍就是两个口径（上一版一块读 computed padding、另一块写死 40，app.ts 一改就分家）。
await page.addInitScript(() => {
  const hostOf = (con) => {
    const parent = con?.parentElement ?? null;
    if (parent && (parent.classList.contains("st-back") || parent.classList.contains("sheet-back"))) return parent;
    return document.querySelector(".st-back, .sheet-back");
  };
  // 宿主 content box 的宽（视觉 px）—— 与 app.ts 的 `consoleAvail()` 同一口径：
  // `.st-back` 的留白跟着档位变，固定用基准 20×2；`.sheet-back` 才读 computed。
  window.__probeConsoleAvail = (con) => {
    const host = hostOf(con);
    if (!host || host.clientWidth <= 0) return -1;
    if (host.classList.contains("st-back")) return host.clientWidth - 40;
    const cs = getComputedStyle(host);
    return host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  };
  // 宿主的**真实** content box 宽（视觉 px，按 computed padding 算）。
  // `__probeConsoleAvail()` 量的是 app 的估算口径（`.st-back` 写死 20×2），窄档留白只有 10px 时两者差 20；
  // 探针要拿它当预期值的上限，那面得用真值，不然 2.0 档会差出 10 css px（容差 2 就假红）。
  window.__probeHostContent = (con) => {
    const host = hostOf(con);
    if (!host || host.clientWidth <= 0) return -1;
    const cs = getComputedStyle(host);
    return Math.round((host.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)) * 10) / 10;
  };
  // 面板真实内容宽（css px，与 `clientWidth` / `offsetWidth` 同单位）—— 与 `paintConsoleFolds()` 同一口径：
  // 有面板就量它自己的 `clientWidth`（zoom 子树里它就是布局 px，不用再除）。
  window.__probeConsoleWidth = (con) => {
    const cs = con ? getComputedStyle(con) : null;
    const zoom = cs ? Number(cs.zoom) || 1 : 1;
    const avail = window.__probeConsoleAvail(con);
    if (con && con.clientWidth > 0) return { w: con.clientWidth, avail, measured: true };
    const frame = cs ? Number(cs.getPropertyValue("--st-frame")) || 1 : 1;
    return { w: Math.min(1080 * frame, avail) / zoom, avail, measured: false };
  };
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});

/** 带种子偏好打开一次（`scale` 决定全局字号）。 */
async function boot({ scale = 1.25 } = {}) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate((scale) => {
    localStorage.setItem(
      "pi.prefs",
      JSON.stringify({
        scale, theme: "mac-light", macAccent: "blue", accentTone: "vivid", lang: "zh-Hans",
        wsCollapsed: [], layout: "a", settingsTab: "look", wsIntroSeen: true, themeIntroSeen: true,
        retellHint: true, githubCards: true, githubAutoPanel: false,
        longCardUser: true, longCardAssistant: false, longCardTool: false,
      }),
    );
  }, scale);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".session-card").first().click();
  await page.waitForSelector(".chat-scroll .msg", { timeout: 8000 });
  await sleep(200);
}

/** 带名字收场：打印一条 FAIL、关掉浏览器与服务，退出码 1。 */
async function bail(label, extra) {
  check(label, false, extra);
  await browser.close();
  server.close();
  wss.close();
  process.exit(1);
}

/**
 * 量一个元素的盒子；拿不到就**带名字** FAIL 并退出，别让后面 `box.x` 崩成 TypeError ——
 * 那种崩法只报「undefined 没有属性」，看不出是面板没开、还是轨道被推到了视口外。
 */
async function mustBox(locator, label) {
  const box = await locator.boundingBox();
  if (box) return box;
  await bail(`${label}：量得到`, "boundingBox() 返回 null（面板没开 / 元素不可见）");
  throw new Error("unreachable");
}

/** 打开「外观 → 语言与字号」。 */
async function openLook() {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  // 不吞异常：导航项改名 / 选择器写错时，后面只会报「量不到轨道」，看不出真正原因。
  const langNav = page.locator('.display-sheet .st-nav__item[data-sec="lang"]');
  if (!(await langNav.count())) await bail("打开「语言与字号」：导航项在", '找不到 .st-nav__item[data-sec="lang"]');
  await langNav.click();
  await sleep(200);
}

/** 控制台与字号轨道的几何。 */
async function geo() {
  return page.evaluate(() => {
    const back = document.querySelector(".st-back");
    const con = back?.querySelector(".st-console");
    const rail = document.querySelector(".size-rail");
    const app = document.getElementById("app");
    const rr = rail?.getBoundingClientRect();
    const cs = con ? getComputedStyle(con) : null;
    const zoom = cs ? Number(cs.zoom) || 1 : 1;
    const label = con?.querySelector(".st-nav__item, .settings-name");
    const fs = label ? parseFloat(getComputedStyle(label).fontSize) : 0;
    return {
      inApp: Boolean(app && back && app.contains(back)),
      inBody: Boolean(back && back.parentElement === document.body),
      // 布局尺寸（offset）而不是 rect：入场动画的 transform 会把 rect 缩一圈。
      w: con ? con.offsetWidth : -1,
      h: con ? con.offsetHeight : -1,
      // D454：控制台自己带 zoom（--st-zoom），外框按 --st-frame 长大。
      zoom: Math.round(zoom * 1000) / 1000,
      stZoom: cs ? cs.getPropertyValue("--st-zoom").trim() : "",
      stFrame: cs ? cs.getPropertyValue("--st-frame").trim() : "",
      // 面板里的字：css px × zoom 才是用户看到的视觉大小。
      textVisual: Math.round(fs * zoom * 100) / 100,
      // 遮罩层能给的宽度 —— 共用页面里注入的 `__probeConsoleAvail()`（与 app.ts 同一口径）。
      avail: window.__probeConsoleAvail(con),
      // 遮罩真实 content box 宽（视觉 px）：预期值的上限用这一份（见 `__probeHostContent`）。
      hostContent: window.__probeHostContent(con),
      // 面板自己的内容宽（css px）：有面板时是量出来的，不是估的。
      contentW: Math.round(window.__probeConsoleWidth(con).w * 10) / 10,
      contentMeasured: window.__probeConsoleWidth(con).measured,
      railY: rr ? Math.round(rr.y) : -1,
      railBottom: rr ? Math.round(rr.bottom) : -1,
      vh: innerHeight,
      vw: innerWidth,
      scale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
      // 壳的窄版仍看**有效宽度**（D158）：2.0 字号下 1200px 窗口只有 600 布局 px，必须判窄。
      compact: document.documentElement.dataset.compact,
      // 控制台自己的折叠档位：按面板内容宽（÷ zoom）判，不是视口宽（D454）。
      narrow: document.documentElement.dataset.stNarrow,
      mid: document.documentElement.dataset.stMid,
      tight: document.documentElement.dataset.stTight,
    };
  });
}

// ---------------------------------------------------------------- 1. 控制台跟着字号放大（D454）
await boot({ scale: 1 });
await openLook();
const at100 = await geo();
await page.screenshot({ path: path.join(OUT, "1-scale-100.png") });

await page.keyboard.press("Escape");
await sleep(200);
await boot({ scale: 2 });
await openLook();
const at200 = await geo();
await page.screenshot({ path: path.join(OUT, "1-scale-200.png") });

// 外框该多大：min(基数 × frame, 遮罩真实 content box)，再除以 zoom 就是 css 宽（与 `w` / `offsetWidth` 同单位）。
// 基数按层给：设置页 1080×840、模型层 1000×760（后者以前被写死成 1080 判过，必然红）。
const wantW = (g, base = 1080) => Math.min(base * (Number(g.stFrame) || 1), g.hostContent) / (Number(g.zoom) || 1);
check("1. 控制台挂在 body 上、不在 #app 的 zoom 子树里", !at200.inApp && at200.inBody, JSON.stringify(at200));
check(
  "1a. 1.0 是原位不动：zoom 1、外框 1080、字没被二次缩放",
  at100.zoom === 1 && Math.abs(at100.w - wantW(at100)) <= 1 && Math.abs(at100.textVisual - 12.5) < 0.6,
  `${at100.w}×${at100.h} · zoom ${at100.zoom} · 字 ${at100.textVisual}px · frame ${at100.stFrame}`,
);
check(
  "1b. 2.0 下控制台自己缩：zoom 2、外框按 frame=max(字号,设置) 长到吃满窗口、字视觉翻倍",
  Math.abs(at200.zoom - 2) < 0.01 &&
    Number(at200.stFrame) === 2 &&
    Math.abs(at200.w - wantW(at200)) <= 2 &&
    Math.abs(at200.textVisual / at100.textVisual - 2) < 0.1,
  `${at200.w}×${at200.h}（应 ${wantW(at200)}）· zoom ${at200.zoom} · 字 ${at200.textVisual}px vs ${at100.textVisual}px`,
);
check(
  "1e. 壳的宽窄仍按有效宽度判（控制台自己的缩不放跑 data-compact）",
  at100.compact === "false" && at200.compact === "true",
  `1.0 → ${at100.compact} / 2.0 → ${at200.compact}（1200px ÷ 2 = 600 布局 px，必须判窄）`,
);
check(
  "1e2. 控制台自己的折叠按面板内容宽判（÷ zoom 后 2.0 是 580px → 窄版 + 中版）",
  at100.narrow === "false" && at100.mid === "false" && at200.narrow === "true" && at200.mid === "true",
  `1.0 → narrow ${at100.narrow}/mid ${at100.mid} · 2.0 → narrow ${at200.narrow}/mid ${at200.mid}`,
);
check(
  "1c. 2.0 下那根字号滑杆仍在视口内",
  at200.railY > 0 && at200.railBottom <= at200.vh,
  `rail ${at200.railY}–${at200.railBottom} / 视口 ${at200.vh}`,
);

// 1c2：外框的视觉尺寸只由 `--st-frame` 决定 —— 80% 字号下仍是 1080，不能跟着缩小。
// （2026-11-28 真实踩过：`.st-console.display-sheet` 里多一条 `width: min(1080px, 100%)`，
//  特异性赢过基础规则，于是 80% 下外框成了 864；2.0 下反而看不出来，被遮罩的 100% 一夹就抹平了。）
await page.keyboard.press("Escape");
await sleep(200);
await boot({ scale: 0.8 });
await openLook();
const at80 = await geo();
check(
  "1c2. 0.8 字号下外框视觉尺寸不变（frame=1 时还是 1080，不是 864）",
  Math.abs(at80.zoom - 0.8) < 0.01 && Math.abs(at80.w * at80.zoom - 1080) <= 3,
  `css ${at80.w} × zoom ${at80.zoom} = ${Math.round(at80.w * at80.zoom)} 视觉 px`,
);

// ---------------------------------------------------------------- 1d. 别的控制台同样跟着缩（8 个入口不止外观这一扇）
// 模型层是「另一扇 `.st-console`」：走同一条 `overlay()` 才挂得对，漏了就当场红。
// 控制台带了自己的 zoom 之后，`:root` 那两个「除过缩放」的视口变量在它内部又要再除一道（`--st-zoom`），
// 否则控制台里任何 `calc(var(--vh1) * N)` 都再缩一圈（D123 那一族坑）。
const vhInside = await page.evaluate(() => {
  const con = document.querySelector(".st-console");
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;height:calc(var(--vh1) * 10);width:1px;visibility:hidden";
  con.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return { h: Math.round(h * 100) / 100, vh: innerHeight };
});
check(
  "1f. 控制台里 --vh1 仍是 10% 视口（除过 --st-zoom 之后重算对了）",
  Math.abs(vhInside.h - vhInside.vh * 0.1) < 1.5,
  `${vhInside.h}px vs ${(vhInside.vh * 0.1).toFixed(1)}px`,
);

const modelGeo = async () => {
  await page.locator(".model-chip").first().click();
  await page.waitForSelector(".st-console.model-sheet", { timeout: 5000 });
  await sleep(400); // 等入场动画走完：`getBoundingClientRect()` 会把动画里的 scale 算进去
  const out = await page.evaluate(() => {
    const sheet = document.querySelector(".st-console.model-sheet");
    return {
      onBody: sheet.parentElement?.parentElement === document.body,
      inApp: Boolean(document.querySelector("#app")?.contains(sheet)),
      // offset 是布局尺寸（不含入场动画的 transform），跨字号比较用它。
      w: sheet.offsetWidth,
      h: sheet.offsetHeight,
      zoom: Number(getComputedStyle(sheet).zoom) || 1,
      // 宿主 content box（`.st-back` 两侧各 20px）：与 paintConsoleFolds 同一个口径。
      avail: window.__probeConsoleAvail(sheet),
      hostContent: window.__probeHostContent(sheet),
      contentW: Math.round(window.__probeConsoleWidth(sheet).w * 10) / 10,
      stFrame: getComputedStyle(sheet).getPropertyValue("--st-frame").trim(),
      narrow: document.documentElement.dataset.stNarrow,
    };
  });
  if (out.w) await page.screenshot({ path: path.join(OUT, `1d-model-${out.w}.png`) });
  await page.keyboard.press("Escape");
  await sleep(200);
  return out;
};
await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1 });
const model100 = await modelGeo();
await boot({ scale: 2 });
const model200 = await modelGeo();
await boot({ scale: 0.8 });
const model80 = await modelGeo();
check(
  "1d. 模型层也吃同一套规则：基数是 1000×760（不是设置页的 1080）、1.0 原位、2.0 吃满窗口并判窄版",
  model100.onBody &&
    model200.onBody &&
    model80.onBody &&
    !model200.inApp &&
    Math.abs(model100.zoom - 1) < 0.01 &&
    Math.abs(model200.zoom - 2) < 0.01 &&
    Math.abs(model100.w - wantW(model100, 1000)) <= 2 &&
    Math.abs(model100.h - 760) <= 2 &&
    Math.abs(model200.w - wantW(model200, 1000)) <= 2 &&
    model200.narrow === "true",
  `${model100.w}×${model100.h}（应 ${wantW(model100, 1000)}×760）→ ${model200.w}×${model200.h}（应 ${wantW(model200, 1000)}）· zoom ${model200.zoom} / narrow ${model200.narrow}`,
);
check(
  "1d2. 模型层 0.8 字号下仍是 1000 视觉 px（`--st-frame` 真生效，不是被 100% 上限夹出来的巧合）",
  Math.abs(model80.zoom - 0.8) < 0.01 && Math.abs(model80.w * model80.zoom - 1000) <= 3,
  `css ${model80.w} × zoom ${model80.zoom} = ${Math.round(model80.w * model80.zoom)} 视觉 px`,
);
await page.keyboard.press("Escape");
await sleep(200);

// ---------------------------------------------------------------- 2 / 3. 阈值 + 让开 + 胶囊
/** 让开相关的现场：控制台透明度、遮罩、真页面里正文那一块、读数胶囊。 */
async function peekState() {
  return page.evaluate(() => {
    const back = document.querySelector(".st-back");
    const con = back?.querySelector(".st-console");
    const chat = document.querySelector('[data-region="chat"]');
    const hud = document.querySelector(".console-peek");
    const fill = document.querySelector(".console-peek__fill");
    const cs = con ? getComputedStyle(con) : null;
    const bs = back ? getComputedStyle(back) : null;
    const hs = hud ? getComputedStyle(hud) : null;
    return {
      conOpacity: cs ? Number(cs.opacity) : -1,
      backBg: bs ? bs.backgroundColor : "",
      backBlur: bs ? bs.backdropFilter : "",
      chatW: chat ? Math.round(chat.getBoundingClientRect().width * 100) / 100 : -1,
      // 正文那一块的**视觉宽度**本来就不跟着字号变（它是视口宽的百分比），变的是文本：
      // 一条消息的总高度 = 字号 × 换行行数。这才是用户拿眼睛判断的东西。
      msgsH: Math.round(
        [...document.querySelectorAll(".chat-scroll .msg")].reduce((a, m) => a + m.getBoundingClientRect().height, 0) * 100,
      ) / 100,
      lines: (() => {
        const body = document.querySelector(".chat-scroll .msg .body");
        if (!body) return -1;
        const r = document.createRange();
        r.selectNodeContents(body);
        return r.getClientRects().length;
      })(),
      hudText: hud ? (hud.textContent ?? "").replace(/\s+/g, " ").trim() : "",
      hudOpacity: hs ? Number(hs.opacity) : -1,
      hudFill: fill ? Number.parseFloat((fill.style.width || "0").replace("%", "")) : -1,
    };
  });
}

await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.25 });
await openLook();

// D455：只有「设置与控制台」那根不让开 —— 它改的就是面板自己的框，再淡掉等于「拖一下就关掉了设置」。
// 先拿它验**不让开**，后面的阈值 / 胶囊仍量「字号」（那根真的改的是面板背后那片页面）。
// 按行内 **名字** 找，不靠 DOM 顺序也不靠整行文本子串：`.settings-label` 只装名字（+ 当前读数），
// 行内 hint 写什么都不会误命中；以后在它前面插一根滑杆也不会悄悄量到别人身上。
const railFor = (label) =>
  page
    .locator(".settings-row")
    .filter({ has: page.locator(".settings-label", { hasText: new RegExp(`^${label}`) }) })
    .locator(".size-rail")
    .first();
const conRailLoc = railFor("设置与控制台");
await conRailLoc.scrollIntoViewIfNeeded();
const conRail = await mustBox(conRailLoc, "2 段：设置与控制台轨道");
const conY = conRail.y + conRail.height / 2;
const conX = conRail.x + conRail.width * 0.375;
await page.mouse.move(conX, conY);
await page.mouse.down();
await page.mouse.move(conX + 40, conY, { steps: 4 });
await sleep(250);
const conDrag = await peekState();
await page.screenshot({ path: path.join(OUT, "2-console-no-peek.png") });
await page.mouse.up();
await sleep(150);
check(
  "2. 拖「设置与控制台」不让开：面板一直不透明、也不露胶囊（D455）",
  conDrag.conOpacity > 0.99 && conDrag.hudOpacity < 0.1 && conDrag.backBlur !== "none",
  `opacity ${conDrag.conOpacity} / 胶囊 ${conDrag.hudOpacity} / backdrop ${conDrag.backBlur}`,
);

await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.25 });
await openLook();
const railBox = await mustBox(railFor("字号"), "2/3 段：字号轨道");
const startX = railBox.x + railBox.width * 0.375; // 125%
const startY = railBox.y + railBox.height / 2;
const restState = await peekState();
check("2 段前置：拖动开始之前面板是不透明的（否则下面两条测的是别的东西）", restState.conOpacity > 0.99, `opacity ${restState.conOpacity}`);

await page.mouse.move(startX, startY);
await page.mouse.down();
await page.mouse.move(startX + 3, startY, { steps: 2 });
await sleep(150);
const at3px = await peekState();

await page.mouse.move(startX + 40, startY, { steps: 4 });
await sleep(200);
const at40px = await peekState();
await page.screenshot({ path: path.join(OUT, "2-peek.png") });
await page.mouse.up();
await sleep(200);
const afterUp = await peekState();
await page.screenshot({ path: path.join(OUT, "3-after-up.png") });

check(
  "2. 只挪 3px 不让开（单击轨道跳档不闪）",
  at3px.conOpacity > 0.9 && at3px.backBlur !== "none",
  `opacity ${at3px.conOpacity} / backdrop ${at3px.backBlur}`,
);
check(
  "2b. 挪到 40px 让开：控制台几乎全隐、遮罩不压暗也不模糊",
  at40px.conOpacity < 0.05 && at40px.backBg === "rgba(0, 0, 0, 0)" && at40px.backBlur === "none",
  `opacity ${at40px.conOpacity} / bg ${at40px.backBg} / backdrop ${at40px.backBlur}`,
);
check(
  "3. 让开时真页面真的在变（同一条消息的视觉高度 / 行数跟着字号走）",
  Math.abs(at40px.msgsH - at3px.msgsH) >= 2 || at40px.lines !== at3px.lines,
  `消息总高 ${at3px.msgsH} → ${at40px.msgsH} / 行数 ${at3px.lines} → ${at40px.lines} / 正文宽 ${at3px.chatW} → ${at40px.chatW}`,
);
// 期望值**独立写一份**（0.8–2.0 的滑杆区间），别从代码里借 `sizePct()` —— 借来就成了同义反复。
const hudPct = Number(at40px.hudText.split("·").pop()?.trim().replace("%", ""));
const wantFill = ((hudPct / 100 - 0.8) / (2.0 - 0.8)) * 100;
check(
  "4. 读数胶囊：文本是「字号 · N%」，只读细轨道的填充按 (v-0.8)/1.2",
  /字号 · \d+%$/.test(at40px.hudText) && at40px.hudOpacity > 0.9 && Math.abs(at40px.hudFill - wantFill) <= 1,
  `${JSON.stringify(at40px.hudText)} / fill ${at40px.hudFill.toFixed(1)}% vs ${wantFill.toFixed(1)}% / opacity ${at40px.hudOpacity}`,
);
check(
  "3b. 松手立刻复原（下一帧就回，不等动画）",
  afterUp.conOpacity > 0.99 && afterUp.hudOpacity < 0.1,
  `opacity ${afterUp.conOpacity} / hud ${afterUp.hudOpacity} / 出发时 ${restState.conOpacity}`,
);

// ---------------------------------------------------------------- 5. 键盘：调值也露一下，400ms 自己回来
await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.25 });
await openLook();
const kRange = page.locator(".size-rail input[type=range]").first();
await kRange.focus();
await page.keyboard.press("ArrowRight");
await sleep(120);
const keyOn = await peekState();
await sleep(450);
const keyOff = await peekState();
await page.screenshot({ path: path.join(OUT, "4-keyboard.png") });
check(
  "5. 纯键盘调值也让开（否则键盘用户永远看不到效果）",
  keyOn.conOpacity < 0.05 && keyOn.hudOpacity > 0.9,
  `本帧 opacity ${keyOn.conOpacity} / 胶囊 ${keyOn.hudOpacity} / ${JSON.stringify(keyOn.hudText)}`,
);
check(
  "5b. 没有再动，约 400ms 后自己回来（不是一直露着）",
  keyOff.conOpacity > 0.99 && keyOff.hudOpacity < 0.1,
  `+570ms 时 opacity ${keyOff.conOpacity} / 胶囊 ${keyOff.hudOpacity}`,
);

// ---------------------------------------------------------------- 6. Esc：撤掉这次拖动，面板不关
await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.25 });
await openLook();
const beforeEsc = await geo();
check("6 段前置：Esc 之前面板是开着的、不在 #app 里", beforeEsc.w > 0 && !beforeEsc.inApp, JSON.stringify({ w: beforeEsc.w, h: beforeEsc.h, inApp: beforeEsc.inApp }));
const escBox = await mustBox(railFor("字号"), "6 段：字号轨道");
const escY = escBox.y + escBox.height / 2;
const escX = escBox.x + escBox.width * 0.375;
await page.mouse.move(escX, escY);
await page.mouse.down();
await page.mouse.move(escX + 60, escY, { steps: 4 });
await sleep(150);
const dragged = await page.evaluate(() => ({
  scale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
  read: document.querySelector(".size-read")?.textContent ?? "",
}));
await page.keyboard.press("Escape");
await sleep(200);
const afterEsc = await page.evaluate(() => ({
  scale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
  read: document.querySelector(".size-read")?.textContent ?? "",
  saved: JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").scale,
  sheetOpen: Boolean(document.querySelector(".st-back .st-console")),
  // 面板要是真被 Esc 关掉了（正是这条要防的回归），这里给 -1，让断言带名字地红。
  conOpacity: (() => {
    const con = document.querySelector(".st-console");
    return con ? Number(getComputedStyle(con).opacity) : -1;
  })(),
}));
await page.mouse.up();
await sleep(150);
check(
  "6. 拖动中 Esc：值回到拖动前（界面上、prefs 里都是）",
  afterEsc.scale === "1.25" && afterEsc.read === "125%" && afterEsc.saved === 1.25 && dragged.scale !== "1.25",
  `拖到 ${dragged.scale}（${dragged.read}）→ Esc 后 ${afterEsc.scale}（${afterEsc.read}）/ prefs ${afterEsc.saved}`,
);
check(
  "6b. Esc 之后面板还开着、也让开了回去（不关面板、不留在半透明）",
  afterEsc.sheetOpen && afterEsc.conOpacity > 0.99,
  JSON.stringify(afterEsc),
);

// ---------------------------------------------------------------- 7. 拖动中窗口失焦：自己收干净
const blurBox = await mustBox(railFor("字号"), "7 段：字号轨道");
await page.mouse.move(blurBox.x + blurBox.width * 0.375, blurBox.y + blurBox.height / 2);
await page.mouse.down();
await page.mouse.move(blurBox.x + blurBox.width * 0.375 + 50, blurBox.y + blurBox.height / 2, { steps: 3 });
await sleep(150);
const beforeBlur = await peekState();
await page.evaluate(() => window.dispatchEvent(new Event("blur")));
await sleep(200);
const afterBlur = await peekState();
await page.mouse.up();
await sleep(150);
check(
  "7. 拖动中窗口失焦：让开自己收掉，不停在半透明",
  beforeBlur.conOpacity < 0.05 && afterBlur.conOpacity > 0.99 && afterBlur.hudOpacity < 0.1,
  `失焦前 ${beforeBlur.conOpacity} → 之后 ${afterBlur.conOpacity} / 胶囊 ${afterBlur.hudOpacity}`,
);

// ---------------------------------------------------------------- 8. 层带：从控制台里开的预览仍压得住它
// 控制台从 `#app` 挪到 body 之后，`.viewer.hi`(63) 与 `.st-back`(60) 还同不同一个层叠上下文？
// `#app` 只有 `height` + `zoom`（既不定位也不 filter），按规矩不建上下文 —— 这条守的就是那个前提。
await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.5 });
await openLook();
const layered = await page.evaluate(() => {
  const v = document.createElement("div");
  v.className = "viewer hi";
  v.style.cssText = "position:fixed;inset:0;z-index:63;background:rgb(1,2,3)";
  document.getElementById("app").append(v);
  const el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
  const onTop = el === v || v.contains(el);
  v.remove();
  return { onTop, hit: el?.className ?? el?.tagName ?? "" };
});
check(
  "8. 从控制台里打开的预览（.viewer.hi，63）仍压得住控制台（60）",
  layered.onTop,
  JSON.stringify(layered),
);

// ---------------------------------------------------------------- 10. 六根滑杆共用同一个让开：A 的键盘收尾不许抢走 B 的拖动
await page.keyboard.press("Escape");
await sleep(150);
await boot({ scale: 1.25 });
await openLook();
await page.evaluate(() => document.querySelectorAll(".size-rail")[1].closest(".settings-row").scrollIntoView({ block: "center" }));
await sleep(150);
// A（字号）只按键盘：让开起来，同时挂上 400ms 的自动收起
await page.evaluate(() => document.querySelectorAll(".size-rail")[0].querySelector("input").focus({ preventScroll: true }));
await page.keyboard.press("ArrowRight");
const bBox = await mustBox(railFor("顶栏"), "10 段：顶栏轨道");
const by = bBox.y + bBox.height / 2;
const bx = bBox.x + bBox.width * 0.2;
await page.mouse.move(bx, by);
await page.mouse.down();
await page.mouse.move(bx + 40, by, { steps: 4 });
await sleep(700); // 熬过 A 的 400ms
const shared = await peekState();
await page.mouse.up();
await sleep(200);
check(
  "10. 按 A 的方向键后立刻拖 B：让开还在，且胶囊写的是 B（不是 A 的残留）",
  shared.conOpacity < 0.05 && shared.hudText.startsWith("顶栏"),
  `拖动第 700ms 时 opacity ${shared.conOpacity} / 胶囊 ${JSON.stringify(shared.hudText)}`,
);

// ---------------------------------------------------------------- 11. 页面没有 JS 异常
check("11. 页面没有 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.close();
wss.close();
console.log(bad ? `\nconsole-peek: ${bad} 条失败` : "\nconsole-peek: ok");
process.exit(bad ? 1 : 0);
