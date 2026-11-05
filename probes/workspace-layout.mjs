/**
 * Probe: 壳 A 两行制 + 设置里的「工作区布局」（#97）。
 *
 * 票面要的是：顶栏下第一行是工作区标签页（横向、溢出渐隐不出横滚条、当前组高亮、带待处理点、
 * 点一下切到那组），第二行是「当前会话那颗 + 本区会话胶囊 + ＋」；设置在「外观与语言」里有四颗
 * 布局 chip，这一票只点亮 A，其余置灰且点不动；布局偏好写进既有 `pi.prefs`，刷新保留、恢复默认
 * 回 A。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照；造 9 个组（够宽、必然溢出）+ 每组 3 颗会话，其中一组带
 * 待回答、一组有几颗置顶，用来验证标签的待处理点与胶囊的 ★ 顺序。
 *
 * Run: npm run build:web && PI_WEB_PORT=7912 node probes/workspace-layout.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.NOWCHIP_DIST ? path.resolve(process.env.NOWCHIP_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.LAYOUT_SHOT ?? "workspace-layout";
const PORT = Number(process.env.PI_WEB_PORT ?? 7908);
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

const state = (id, name, cwd, ws, owned = false) => ({
  id,
  name,
  cwd,
  ws,
  file: null,
  owned,
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

const SUBS = ["sub/a", "sub/b"];
const SESSIONS = GROUPS.flatMap((g, gi) =>
  [1, 2, 3].map((k) => {
    const n = g.id.slice(-2);
    const cwd = k === 1 ? g.key : `${g.key}/${SUBS[k - 2]}`;
    const s = state(`s-${n}-${k}`, `工程 ${n} · 会话 ${k}`, cwd, g.id, k === 1);
    // 第 3 组有一颗在等人：标签上应该点一颗点。
    if (gi === 2 && k === 1) s.asks = 1;
    return s;
  }),
);
const byId = (id) => SESSIONS.find((s) => s.id === id);

const workspace = () => ({
  groups: GROUPS,
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
});
// 第 2 组里置顶两颗（且 ★ 顺序与「新到旧」不同）：切过去后胶囊按 ★ 排。
const MANAGE = { pin: ["s-02-3", "s-02-1"], order: SESSIONS.map((s) => s.id), archived: [] };
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
      if (msg.type === "manage" && msg.action === "opened") {
        const id = String(msg.id ?? "");
        MANAGE.order = [id, ...MANAGE.order.filter((x) => x !== id)];
        ws.send(JSON.stringify({ type: "manage", manage: MANAGE, workspace: workspace() }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 820 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

const prefs = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    } catch {
      return {};
    }
  });
const htmlLayout = () => page.evaluate(() => document.documentElement.dataset.layout ?? "");
const tabState = () =>
  page.evaluate(() => {
    const row = document.querySelector(".ws-tabs-row");
    const box = document.querySelector(".ws-tabs");
    const on = document.querySelector(".ws-tab.on");
    return {
      rowVisible: Boolean(row) && !row.hidden && row.getClientRects().length > 0,
      count: document.querySelectorAll(".ws-tab").length,
      onWs: on?.dataset.ws ?? "",
      onName: on?.querySelector(".ws-tab-name")?.textContent ?? "",
      todo: [...document.querySelectorAll(".ws-tab")].filter((t) => t.querySelector(".ws-tab-todo")).map((t) => t.dataset.ws),
      overflow: box ? box.scrollWidth > box.clientWidth + 1 : false,
      fade: Boolean(box?.classList.contains("fade")),
      scrollbarHeight: box ? box.offsetHeight - box.clientHeight : -1,
    };
  });
const rowState = () =>
  page.evaluate(() => {
    const line = document.querySelector(".ws-session-row");
    const strip = document.querySelector(".pin-strip");
    return {
      visible: Boolean(line) && line.getClientRects().length > 0,
      hasChip: Boolean(line?.querySelector(".now-chip")),
      hasStrip: Boolean(line?.querySelector(".pin-strip")),
      stripHidden: Boolean(strip?.hidden),
      topbarChip: document.querySelectorAll(".topbar .now-chip").length,
      nowName: document.querySelector(".now-chip .now-name")?.textContent ?? "",
      chips: [...document.querySelectorAll(".pin-strip .pin-chip:not(.pin-new):not(.pin-expand):not(.pin-more)")].map(
        (c) => c.querySelector(".pin-name")?.textContent ?? "",
      ),
    };
  });
const sheetState = () =>
  page.evaluate(() => {
    const chips = [...document.querySelectorAll(".display-sheet .layout-chip")];
    return {
      open: Boolean(document.querySelector(".display-sheet")),
      count: chips.length,
      demos: document.querySelectorAll(".display-sheet .layout-demo").length,
      ids: chips.map((c) => c.dataset.layout),
      on: chips.filter((c) => c.classList.contains("on")).map((c) => c.dataset.layout),
      off: chips.filter((c) => c.classList.contains("off")).map((c) => c.dataset.layout),
      disabled: chips.filter((c) => c.disabled).map((c) => c.dataset.layout),
      tips: chips.map((c) => c.title),
    };
  });

await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(900);

// 1) 两行都在，且第二行的左端就是那颗「当前在哪」
let t = await tabState();
let r = await rowState();
ok(t.rowVisible, "顶栏下有工作区标签页那一行");
ok(r.visible && r.hasChip && r.hasStrip, "第二行同时装着当前会话那颗和本区胶囊");
ok(r.topbarChip === 0, "顶栏里不再挂着那颗（它已经搬进第二行）");
ok(t.count === 9, `标签页按组数排开（${t.count}）`);
ok(t.onWs === "f:/proj-01" && t.onName === "客户 01 号的后台系统", `当前工作区高亮（${t.onName}）`);
ok(t.todo.length === 1 && t.todo[0] === "f:/proj-03", `有待处理的组带一颗点（${t.todo.join(",")}）`);
ok(r.nowName === "工程 01 · 会话 1", `行 2 左端写着当前会话（${r.nowName}）`);
ok(r.chips.length === 2 && !r.chips.includes("工程 01 · 会话 1"), `本区胶囊不含当前那颗（${r.chips.length} 颗）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-rows.png`), clip: { x: 0, y: 0, width: 1000, height: 170 } });

// 2) 溢出：右端渐隐、但不出横滚条
ok(t.overflow, "9 个长名的组在 1000px 下确实装不下（scrollWidth > clientWidth）");
ok(t.fade, "装不下时右端渐隐（.ws-tabs.fade）");
ok(t.scrollbarHeight === 0, `没有横向滚动条占位（offsetHeight - clientHeight = ${t.scrollbarHeight}）`);

// 3) 点标签切组：打开那组排最上面的一颗
await page.locator('.ws-tab[data-ws="f:/proj-05"]').click();
await sleep(700);
t = await tabState();
r = await rowState();
ok((await page.evaluate(() => location.hash)) === "#/s/s-05-1", "点标签打开了那组排最上面的一颗（#/s/s-05-1）");
ok(t.onWs === "f:/proj-05", "高亮跟着换到被点的那组");
ok(r.nowName === "工程 05 · 会话 1", `行 2 左端换成新会话（${r.nowName}）`);
ok(r.chips.length === 2 && r.chips.every((n) => n.startsWith("工程 05")), `胶囊整条换成本区的（${r.chips.join(" / ")}）`);

// 4) 本区胶囊按 ★ 优先，不按新到旧
await page.locator('.ws-tab[data-ws="f:/proj-02"]').click();
await sleep(700);
r = await rowState();
ok(r.chips[0] === "工程 02 · 会话 1" && r.chips[1] === "工程 02 · 会话 2", `置顶的排在前面（${r.chips.join(" / ")}）`);

// 5) 设置里的四颗布局 chip：#98 起四颗都点得动，没有置灰的
await page.locator('.icon-btn[data-act="look"]').click();
await sleep(400);
let s = await sheetState();
ok(s.open, "点 Aa 打开了「外观与语言」");
ok(s.count === 4 && s.demos === 4, `四颗布局 chip，各带一张示意图（${s.count} / ${s.demos}）`);
ok(s.ids.join(",") === "a,b,c,d", `顺序是 a,b,c,d（${s.ids.join(",")}）`);
ok(s.on.join(",") === "a", `当前布局那一下是亮的（${s.on.join(",")}）`);
ok(s.disabled.length === 0 && s.off.length === 0, `四颗都能点（禁用 ${s.disabled.length} 颗 / 置灰 ${s.off.length} 颗）`);
ok(!s.tips.slice(1).some((x) => x.includes("下一步补上")), "没有「下一步补上」的提示了");

// 6) 点 B：写进 pi.prefs、立刻换壳（两行横栏收起）
await page.locator('.layout-chip[data-layout="b"]').click();
await sleep(400);
ok((await prefs()).layout === "b", `布局写进既有 pi.prefs（layout = ${(await prefs()).layout}）`);
ok((await htmlLayout()) === "b", "html[data-layout=b]，样式立刻跟上");
t = await tabState();
r = await rowState();
ok(!t.rowVisible, "B：工作区标签行收起");
ok(!r.visible && r.stripHidden, "B：行 2（那颗 + 胶囊）也收起");
ok(r.topbarChip === 1, `B：顶栏里那颗在（${r.topbarChip} 颗）`);
const curName = await page.evaluate(() => document.querySelector(".session-card.active .name")?.textContent ?? "");
ok(r.nowName !== "" && r.nowName === curName, `B：那颗仍写着当前会话（${r.nowName} / 左栏当前 ${curName}）`);
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click();
await sleep(200);

// 7) 刷新保留（B 存下来就还是 B）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
ok((await prefs()).layout === "b", "刷新后偏好仍是 b");
ok((await htmlLayout()) === "b", "刷新后仍是 B 的外壳");
ok((await rowState()).topbarChip === 1, "刷新后顶栏那颗还在");

// 8) 手写进去的 layout 值直接生效（#98：四套都实现了，不用迁数据）
await page.evaluate(() => {
  try {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    p.layout = "c";
    localStorage.setItem("pi.prefs", JSON.stringify(p));
  } catch {
    /* 读到的不是 JSON：当作没有偏好，下面照样能验 */
  }
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
ok((await prefs()).layout === "c", "手写进去的 layout 值原样留着");
ok((await htmlLayout()) === "c", "手写的 c 直接按 C 画（不再是「没实现」退回 A）");
await page.locator('.icon-btn[data-act="look"]').click();
await sleep(400);
s = await sheetState();
ok(s.on.join(",") === "c", "面板亮着的是 c");
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click();
await sleep(200);

// 9) 再点 A：把偏好改回来，并且刷新后保留
await page.locator('.icon-btn[data-act="look"]').click();
await sleep(400);
await page.locator('.layout-chip[data-layout="a"]').click();
await sleep(300);
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click();
await sleep(200);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(600);
ok((await prefs()).layout === "a", "刷新后偏好仍是 a");
ok((await htmlLayout()) === "a", "刷新后仍是 A 的渲染");
ok((await rowState()).visible, "刷新后两行也还在");

// 10) 恢复默认把布局带回 A
await page.evaluate(() => {
  try {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    p.layout = "c";
    localStorage.setItem("pi.prefs", JSON.stringify(p));
  } catch {
    /* 读到的不是 JSON：当作没有偏好，下面照样能验 */
  }
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
await page.locator('.icon-btn[data-act="look"]').click();
await sleep(400);
await page.locator('.display-sheet .btn:has-text("恢复默认")').click();
await sleep(400);
ok((await prefs()).layout === "a", `恢复默认把布局带回 A（layout = ${(await prefs()).layout}）`);
ok((await sheetState()).on.join(",") === "a", "恢复默认后面板上亮着的也是 A");
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click().catch(() => {});
await sleep(200);

// 11) 窄屏：标签行收起，那颗仍在；点它打开左栏那一页（窄屏四套统一退化）
await page.setViewportSize({ width: 800, height: 820 });
await sleep(500);
ok((await tabState()).rowVisible === false, "800px 下标签行收起");
r = await rowState();
ok(r.stripHidden, "800px 下胶囊条也收起");
ok((await page.locator(".now-chip").count()) === 1, "800px 下「当前在哪」那颗仍只有一颗");
await page.locator(".now-btn").click();
await sleep(400);
ok(await page.evaluate(() => document.querySelector('button[data-tab="sessions"]')?.classList.contains("on") ?? false), "窄屏点那颗打开左栏（会话）那一页");
ok((await page.locator(".ws-pop").count()) === 0, "窄屏不开浮层");

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
