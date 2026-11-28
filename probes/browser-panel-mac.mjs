/**
 * Probe: 右栏「浏览器」面板的观感与几个硬约束。
 *
 * 这是 2026-11-29 那次 Mac 风格改版的守卫（D457）。它不测业务判断（那在 browser-ops 的单测里），
 * 只测「画出来是否还是一个像 Mac 的列表」：
 *
 *  A 三套主题各截一张右栏整栏：卡片之间不许再是一张张独立描边的灰卡，而是一个分组列表；
 *    列表行之间是发丝线，不是 6px 的空气缝。
 *  B 每张卡的头一行都能在一行里放下：标题、耗时、徽标不许把行高撑到两行（量首行 ≤ 2 行文字高）。
 *  C 没有横向溢出：最长的标题用省略号，面板的 scrollWidth 不许超过 clientWidth。
 *  D 选中的页签是**抬起的滑块**、不再是强调色实底（用户 2026-11-29：「浏览器面板很丑，用 mac 风格
 *    重新设计」）。这一条只看底色是渐变滑块而不是纯色；字与滑块 / 槽的对比度由
 *    `probes/queue-tabs-contrast.mjs` 逐像素守（D457）。
 *
 * 截图落在 `.scratch/browser-panel-mac/shots/`，供人眼复核（探针不判「好看」）。
 *
 * Run: npm --prefix web run build && node probes/browser-panel-mac.mjs
 *      （没装 playwright 时：PW_PATH=.scratch/pw/node_modules/playwright/index.mjs node …）
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

const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7958));
const DIST = path.resolve(DIST_RAW);
const OUT = path.join(REPO, ".scratch/browser-panel-mac/shots");
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
let browser;
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = {
  id: "probe-browser-mac", name: "浏览器面板探针", cwd: REPO, file: null, owned: true, origin: "disk",
  running: true, done: false, model: "stub", modelName: "stub", thinkingLevel: "medium",
  updatedAt: Date.now(), approvals: 0, asks: 0, preview: "看浏览器面板", locked: false,
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

const at = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const SCRIPT = `import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:7874/");
await page.getByRole("button", { name: "会话" }).click();
await page.locator("#kw").fill("今天的天气");
await page.locator("#kw").press("Enter");
await page.screenshot({ path: "shot.png" });
`;

const ITEMS = [
  { id: "a1", kind: "assistant", text: "先连上本机浏览器，把「会话」那一栏的排序点一遍，确认列表刷新时不会闪。然后把首页截图存下来。", ts: at(90) },
  {
    id: "w1", kind: "tool", toolCallId: "call_write", name: "write", status: "ok", durationMs: 30, ts: at(88),
    args: { path: `${REPO}/.scratch-cdp.mjs`, content: SCRIPT }, result: "wrote 1 file",
  },
  {
    id: "t1", kind: "tool", toolCallId: "call_1", name: "bash", status: "ok", durationMs: 2200, ts: at(87),
    args: { command: "node .scratch-cdp.mjs" },
    result: "::browser launch headless\n::browser nav http://127.0.0.1:7874/\n::browser click 会话\n::browser shot shot.png\nsaved shot.png",
  },
  {
    id: "t2", kind: "tool", toolCallId: "call_2", name: "mcp__browser_use", status: "ok", durationMs: 4900, ts: at(80),
    args: { code: "await page.click('text=排序');\nawait page.waitForSelector('.rows');\nawait page.screenshot({ path: 'rows.png' })" },
    result: "clicked 排序\nrows.png",
  },
  {
    id: "t3", kind: "tool", toolCallId: "call_3", name: "bash", status: "ok", durationMs: 15000, ts: at(70),
    args: { command: "node cdp2.mjs" }, result: "::browser click 全部折叠\n::browser value 共 85 次 · 440 秒\nok",
  },
  {
    id: "t4", kind: "tool", toolCallId: "call_4", name: "mcp__browser_use", status: "ok", durationMs: 9300, ts: at(55),
    args: { code: "await page.goto('http://127.0.0.1:7874/');\nawait page.click('text=浏览器');" },
    result: "ok",
  },
  {
    id: "t5", kind: "tool", toolCallId: "call_5", name: "bash", status: "ok", durationMs: 5200, ts: at(40),
    args: { command: "node cdp.mjs" }, result: "::browser click 保存\n::browser shot out.png\nok",
  },
  {
    id: "t6", kind: "tool", toolCallId: "call_6", name: "bash", status: "ok", durationMs: 121000, ts: at(30),
    args: { command: "node cdp.mjs" }, result: "::browser nav http://127.0.0.1:7874/\n::browser click 需要你\n::browser print 卡在第二栏等审批\nok",
  },
  {
    id: "t7", kind: "tool", toolCallId: "call_7", name: "bash", status: "running", durationMs: 15000, ts: at(15),
    args: { command: "node cdp.mjs" },
    partialResult: "已上线。当前状态：PR #30 已合并，main 在 0ed58c7，服务 http://127.0.0.1:7874（PID 36284，HTTP 200）。工作区干净，临时 worktree 已清理。\n::browser click 会话\n::browser input 今天的天气 · #kw\n::browser print 3) 等结果出来再截图\n::browser shot saved",
  },
  {
    id: "t8", kind: "tool", toolCallId: "call_8", name: "mcp__browser_use", status: "error", isError: true, durationMs: 200, ts: at(5),
    args: { code: "await page.click('#missing')" }, result: "Error: locator('#missing'): timeout 30000ms exceeded",
  },
];

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
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: ITEMS, approvals: [], asks: [], budget: null }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "toolResult", sessionId: SESSION.id, toolCallId: "call_7", partialResult: ITEMS.find((i) => i.toolCallId === "call_7").partialResult }));
      }, 200);
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const openBrowserTab = async () => {
  const tab = page.locator('.tabs button[data-tab="queue"]');
  if (await page.evaluate(() => document.documentElement.dataset.compact === "true")) await tab.click();
  await until(async () => (await page.locator('.pane[data-region="queue"] .exec-tabs button.on').count()) === 1, 8000, "tab bar");
  await page.locator('.pane[data-region="queue"] .exec-tabs button[data-exec-tab="browser"]').click();
  await until(async () => (await page.locator(".browser-card").count()) > 0, 8000, "browser cards");
};

const textLines = (node) => {
  const cs = getComputedStyle(node);
  return (node.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight || "16");
};

browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
page = await context.newPage();
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(BASE, { waitUntil: "networkidle" });

const THEMES = ["mac-light", "mac-dark", "mac-midnight"];
for (const theme of THEMES) {
  const accent = theme === "mac-dark" ? "green" : "blue";
  await page.evaluate(
    ({ theme, accent }) => {
      const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, theme, macAccent: accent, accentTone: "vivid", scale: 1 }));
    },
    { theme, accent },
  );
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await openBrowserTab();
  // 用户截图里那一栏大约 340px：把它拉到同一档，再量。
  await page.evaluate(() => document.querySelector(".main")?.style.setProperty("--queue-w", "340px"));
  await sleep(400);

  const rail = page.locator('.pane[data-region="queue"]');
  const railBox = await rail.boundingBox();
  ok(!!railBox && railBox.width >= 330, `${theme}：右栏拉到了 340（量到 ${railBox ? Math.round(railBox.width) : "?"}px）`);

  const geom = await page.evaluate(() => {
    const pane = document.querySelector('.pane[data-region="queue"]');
    const cards = [...document.querySelectorAll('.pane[data-region="queue"] .browser-card')];
    const list = document.querySelector('.browser-list');
    const first = cards[0];
    const next = cards[1];
    const head = first?.querySelector(".browser-head");
    const sum = pane.querySelector(".browser-sum");
    const only = sum?.querySelector(".browser-only");
    const tools = sum?.querySelector(".browser-sum-tools");
    const center = (elm) => { const r = elm.getBoundingClientRect(); return r.top + r.height / 2; };
    const expanded = cards.find((card) => card.querySelector(".browser-body"));
    const body = expanded?.querySelector(".browser-body");
    return {
      overflow: pane.scrollWidth - pane.clientWidth,
      cards: cards.length,
      listRadius: list ? parseFloat(getComputedStyle(list).borderTopLeftRadius) : 0,
      // 卡片之间若是独立灰卡：要么有间距，要么各自有完整描边。
      gap: first && next ? Math.round(next.getBoundingClientRect().top - first.getBoundingClientRect().bottom) : -1,
      headLines: head ? (head.getBoundingClientRect().height - 12) / 19 : 0,
      headHeight: head ? head.getBoundingClientRect().height : 0,
      sumRow: only && tools ? Math.abs(center(only) - center(tools)) : -1,
      labels: body ? [...body.querySelectorAll(".browser-label")].map((node) => node.textContent) : [],
      metaLast: body ? body.lastElementChild?.classList.contains("browser-meta") ?? false : false,
      // 选中页签的底：滑块是近中性的一档，不是强调色。
      onBg: getComputedStyle(document.querySelector('.pane[data-region="queue"] .exec-tabs button.on')).backgroundColor,
      onImage: getComputedStyle(document.querySelector('.pane[data-region="queue"] .exec-tabs button.on')).backgroundImage,
      onShadow: getComputedStyle(document.querySelector('.pane[data-region="queue"] .exec-tabs button.on')).boxShadow,
      groove: getComputedStyle(document.querySelector('.pane[data-region="queue"] .exec-tabs')).backgroundColor,
      titles: cards.slice(0, 4).map((card) => {
        const title = card.querySelector(".browser-title");
        return { text: title?.innerText ?? "", attr: title?.getAttribute("title") ?? "", name: title?.querySelector(".browser-name")?.textContent ?? "" };
      }),
    };
  });
  console.log(`     ${theme}：卡片 ${geom.cards} 张，卡间距 ${geom.gap}px，行高 ${geom.headHeight.toFixed(1)}px（${geom.headLines.toFixed(1)} 行），列表圆角 ${geom.listRadius}px，横向溢出 ${geom.overflow}px`);
  console.log(`     选中页签底 ${geom.onBg}｜滑块图 ${geom.onImage.slice(0, 60)}｜槽 ${geom.groove}｜投影 ${geom.onShadow.slice(0, 50)}`);
  ok(/gradient/.test(geom.onImage), `${theme}：选中页签是抬起的渐变滑块，不是纯色实底（${geom.onImage.slice(0, 40)}）`);
  ok(geom.overflow <= 0, `${theme}：面板没有横向溢出（scrollWidth - clientWidth = ${geom.overflow}）`);
  ok(geom.listRadius >= 8, `${theme}：卡片组是一个大圆角容器（量到 ${geom.listRadius}px）`);
  ok(geom.headHeight >= 38 && geom.headHeight <= 40, `${theme}：卡片首行有 40px 的呼吸（${geom.headHeight.toFixed(1)}px）`);
  ok(geom.gap <= 1, `${theme}：卡片之间不是空气缝（${geom.gap}px）`);
  if (theme !== "150%") ok(geom.sumRow <= 2, `${theme}：汇总是一行（筛选与工具中心差 ${geom.sumRow.toFixed(1)}px）`);
  ok(geom.labels.includes("意图") && geom.labels.includes("步骤"), `${theme}：展开体有「意图 / 步骤」分段（${geom.labels.join(" / ")}）`);
  ok(geom.metaLast, `${theme}：技术元信息落在展开体最后（${geom.metaLast}）`);
  for (const t of geom.titles) {
    ok(t.text === t.attr, `${theme}：标题 innerText 与悬停全文一致（${JSON.stringify(t.text).slice(0, 50)} vs ${JSON.stringify(t.attr).slice(0, 50)}）`);
    ok(t.text.startsWith(`${t.name} · `) && !/[\r\n]/.test(t.text), `${theme}：标题仍是「名字 · 动作」单行（${JSON.stringify(t.text).slice(0, 50)}）`);
  }

  if (process.env.DEBUG_HEAD) {
    const dbg = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.browser-card')].find((c) => c.querySelector('.browser-out'));
      if (!card) return null;
      const pick = (elm) => {
        const r = elm.getBoundingClientRect();
        const s = getComputedStyle(elm);
        return { cls: elm.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), lh: s.lineHeight, disp: s.display, wrap: s.flexWrap, align: s.alignItems };
      };
      return { head: pick(card.querySelector('.browser-head')), title: pick(card.querySelector('.browser-title')), name: pick(card.querySelector('.browser-name')), act: pick(card.querySelector('.browser-act')), dur: pick(card.querySelector('.browser-dur')), body: pick(card.querySelector('.browser-body')) };
    });
    console.log(JSON.stringify(dbg, null, 1));
  }
  await rail.screenshot({ path: path.join(OUT, `${theme}.png`) });
  const bar = page.locator('.pane[data-region="queue"] .exec-tabs-bar');
  await bar.screenshot({ path: path.join(OUT, `${theme}-tabs.png`) });
}

// 150% 字号：`#app` 上的 zoom 不许把面板推出右缘，也不许把行高撑破。
// 视口跟着放大，保持有效宽度 > 900（否则会掉进窄版抽屉，量的就不是这一栏了）。
await page.setViewportSize({ width: 1600, height: 1000 });
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
  localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, theme: "mac-dark", macAccent: "green", scale: 1.5 }));
});
await page.reload({ waitUntil: "networkidle" });
await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
await page.locator(".session-card").first().click();
await openBrowserTab();
await sleep(300);
const big = await page.evaluate(() => {
  const pane = document.querySelector('.pane[data-region="queue"]');
  return { overflow: pane.scrollWidth - pane.clientWidth };
});
ok(big.overflow <= 0, `150%：面板没有横向溢出（${big.overflow}px）`);
if (process.env.DEBUG_HEAD) {
  const dbg = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.browser-card')].find((c) => c.querySelector('.browser-out'));
    if (!card) return null;
    const pick = (elm) => {
      const r = elm.getBoundingClientRect();
      const s = getComputedStyle(elm);
      return { cls: elm.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), lh: s.lineHeight, fs: s.fontSize, disp: s.display, wrap: s.flexWrap, ws: s.whiteSpace, flex: s.flex, minw: s.minWidth };
    };
    return { head: pick(card.querySelector('.browser-head')), title: pick(card.querySelector('.browser-title')), name: pick(card.querySelector('.browser-name')), act: pick(card.querySelector('.browser-act')), dur: pick(card.querySelector('.browser-dur')) };
  });
  console.log("150%", JSON.stringify(dbg, null, 1));
}
await page.locator('.pane[data-region="queue"]').screenshot({ path: path.join(OUT, "scale-150.png") });

await browser.close();
server.close();
console.log(bad ? `\n${bad} 条失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
