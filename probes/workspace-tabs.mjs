/**
 * Probe: #119 壳 A 顶栏并两行 —— 标签接管第一行，会话名让位。
 *
 * 票面要的是：A 壳下顶栏只剩一行，最左是折叠左栏的 `◧`、紧接着工作区标签、再往右是原来那排
 * 工具按钮；会话名 / 顶栏那串小字 / 连接状态点在这一行都不再出现（会话名在行 2 那颗上）。
 * B/C/D 三套壳的顶栏原样不动，标签行仍然只属于 A。800px 窄屏下 A 这一行不破版，标签可以横向
 * 滚动且不占滚动条的位置。
 *
 * 这一票只动布局：标签行仍然画**全部**工作区组（只画 N 个 + ＋N 是 #121 的事），所以这里按组数
 * 断言标签数量。行 2 的胶囊归 #120，这里不碰。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照；造 9 个长名组 —— 装不下才看得出横向滚动与渐隐。
 *
 * Run: npm run build:web && PI_WEB_PORT=7913 node probes/workspace-tabs.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.NOWCHIP_DIST ? path.resolve(process.env.NOWCHIP_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.TABS_SHOT ?? "workspace-tabs";
const PORT = Number(process.env.PI_WEB_PORT ?? 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

async function launchPlaywright() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache */
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      await mod.chromium.launch().then((b) => b.close());
      return mod;
    } catch {
      /* half-installed playwright: try the next one */
    }
  }
  throw new Error("找不到可用的 playwright（设 PW_PATH=<.../playwright/index.mjs>）");
}

const state = (id, name, cwd, ws) => ({
  id,
  name,
  cwd,
  ws,
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
});

const GROUPS = Array.from({ length: 9 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { id: `f:/proj-${n}`, name: `客户 ${n} 号的后台系统`, key: `F:/proj-${n}`, manual: false };
});
const SESSIONS = GROUPS.map((g, i) => state(`s-${g.id.slice(-2)}-1`, `工程 ${g.id.slice(-2)} · 会话 1`, g.key, g.id));
const byId = (id) => SESSIONS.find((s) => s.id === id);

const workspace = () => ({
  groups: GROUPS,
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
});
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
      const s = byId(msg.sessionId);
      if (msg.type === "subscribe" && s) {
        // 真桥的 state 不带 ws（它只挂在 sessions.list 的条目上）。
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();

/**
 * 顶栏这一行的几何：标签行是不是顶栏的孩子、紧不紧跟在 `◧` 后面、和工具按钮是不是同一条线、
 * 那一行有多高，以及会话名 / 那串小字 / 状态点还在不在。
 */
const barState = () =>
  page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    const row = document.querySelector(".ws-tabs-row");
    const tabs = document.querySelector(".ws-tabs");
    const tools = [...document.querySelectorAll('.topbar [data-act="terminal"], .topbar [data-act="look"]')];
    const box = (n) => {
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: r.top + r.height / 2, h: r.height };
    };
    const shown = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return false;
      return getComputedStyle(n).display !== "none" && n.getClientRects().length > 0;
    };
    const kids = [...(bar?.children ?? [])];
    return {
      inTopbar: Boolean(bar && row && row.parentElement === bar),
      firstChild: kids[0]?.className ?? "",
      secondIsRow: Boolean(row && kids[1] === row),
      bar: box(bar),
      row: box(row),
      tool: box(tools[0]),
      tab: box(document.querySelector(".ws-tab.on")),
      title: shown(".topbar > .title"),
      sub: shown(".topbar > .sub"),
      dot: shown(".topbar > .dot"),
      titleDisplay: (() => {
        const n = document.querySelector(".topbar > .title");
        return n ? getComputedStyle(n).display : "missing";
      })(),
      subDisplay: (() => {
        const n = document.querySelector(".topbar > .sub");
        return n ? getComputedStyle(n).display : "missing";
      })(),
      count: document.querySelectorAll(".ws-tab").length,
      onWs: document.querySelector(".ws-tab.on")?.dataset.ws ?? "",
      tabsOverflow: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : false,
      tabsScrollbar: tabs ? tabs.offsetHeight - tabs.clientHeight : -1,
      tabsScrollLeft: tabs ? tabs.scrollLeft : -1,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });

async function open(layout) {
  // 布局偏好直接写进 localStorage 再刷新：这里要验的是「按壳摆哪儿」，不是设置面板（#97 验过）。
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-card", { timeout: 15000 });
  if (layout) {
    await page.evaluate((id) => {
      try {
        const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
        p.layout = id;
        localStorage.setItem("pi.prefs", JSON.stringify(p));
      } catch {
        /* 读到的不是 JSON：当作没有偏好 */
      }
    }, layout);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".session-card", { timeout: 15000 });
  }
  await sleep(700);
  return page;
}

let page = await open(null);

// 1) A：标签行搬进顶栏，紧跟在 ◧ 后面，和工具按钮同一条线
let s = await barState();
ok(s.inTopbar, "A：工作区标签行挂在顶栏里（.topbar > .ws-tabs-row）");
ok(s.firstChild.includes("side-toggle") && s.secondIsRow, `A：标签紧跟在折叠左栏的 ◧ 后面（第 1 颗 ${s.firstChild}）`);
ok(Boolean(s.bar && s.row && s.bar.top <= s.row.top + 1 && s.row.bottom <= s.bar.bottom + 1), "A：标签行在顶栏的框内");
ok(Boolean(s.tool && s.row && Math.abs(s.tool.cy - s.row.cy) < 14), "A：标签和工具按钮在同一行（中心线相差不到 14px）");
ok(Boolean(s.bar && s.bar.h <= 60), `A：顶栏只有一行高（${s.bar?.h}px）`);

// 2) A：会话名 / 顶栏那串小字 / 连接状态点都不再出现在这一行
ok(!s.title && !s.sub && !s.dot, `A：会话名 / 小字 / 状态点都藏了（title ${s.title} · sub ${s.sub} · dot ${s.dot}）`);

// 3) 这一票只换挂载点，标签仍画全部组
ok(s.count === 9, `A：标签行仍画全部组（${s.count} 个）`);
ok(s.onWs === "f:/proj-01", `A：当前组仍然高亮（${s.onWs}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-a.png`), clip: { x: 0, y: 0, width: 1000, height: 140 } });
await page.close();

// 4) B/C/D：标签行不进顶栏，顶栏那三样照旧
for (const id of ["b", "c", "d"]) {
  page = await open(id);
  s = await barState();
  ok(!s.inTopbar, `${id.toUpperCase()}：标签行没有搬进顶栏`);
  ok(!s.title && s.titleDisplay === "none", `${id.toUpperCase()}：会话名那条规矩没变（title display: ${s.titleDisplay}）`);
  ok(s.subDisplay !== "none", `${id.toUpperCase()}：顶栏那串小字照旧（sub display: ${s.subDisplay}）`);
  const chips = await page.evaluate(() => ({
    top: document.querySelectorAll(".topbar .now-chip").length,
    rows: document.querySelectorAll(".ws-session-row .now-chip").length,
  }));
  ok(chips.top === 1 && chips.rows === 0, `${id.toUpperCase()}：那颗仍在顶栏（顶栏 ${chips.top} / 行 2 ${chips.rows}）`);
  ok(s.tabsOverflow === false && (await page.evaluate(() => document.querySelector(".ws-tabs-row")?.hidden ?? false)), `${id.toUpperCase()}：标签行不画`);
  await page.close();
}

// 5) 800px 窄屏：A 这一行不破版，标签横向滚得动、又不占滚动条的位置
page = await open(null);
await page.setViewportSize({ width: 800, height: 820 });
await sleep(600);
s = await barState();
ok(s.inTopbar && s.secondIsRow, "800px：标签仍在顶栏里、仍紧跟在 ◧ 后面");
ok(Boolean(s.bar && s.bar.h <= 60), `800px：顶栏还是一行（${s.bar?.h}px）`);
ok(Boolean(s.tool && s.row && Math.abs(s.tool.cy - s.row.cy) < 14), "800px：标签和工具按钮仍在同一行");
ok(!s.docOverflow, "800px：整页没有横向溢出（没破版）");
ok(s.tabsOverflow, "800px：9 个长名装不下，标签槽真的溢出");
ok(s.tabsScrollbar === 0, `800px：没有横向滚动条占位（offsetHeight - clientHeight = ${s.tabsScrollbar}）`);
const scrolled = await page.evaluate(() => {
  const box = document.querySelector(".ws-tabs");
  box.scrollLeft = 9999;
  return { left: box.scrollLeft, max: box.scrollWidth - box.clientWidth };
});
ok(scrolled.left > 0 && Math.abs(scrolled.left - scrolled.max) <= 1, `800px：标签能横向滚到底（${scrolled.left} / ${scrolled.max}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-800.png`), clip: { x: 0, y: 0, width: 800, height: 140 } });
await page.close();

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
