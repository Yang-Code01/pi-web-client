/**
 * Probe: 顶栏七颗的可见性（#281 / #289）。
 *
 * 纯函数 `isChromeVisible()` 的表格在 `web/tests/chrome-unit.mjs`；这里把关的是浏览器里那件事：
 * 桥说「关掉」之后真顶栏里那一颗**不在 DOM 的可视范围里**、不留空位，切语言 / 换壳 / 收 `ui` /
 * 建会话 / 关会话都走同一个重画点。产物与文件管理器还要叠加「没开会话就没有内容」：
 * 显式打开也换不来一个会话，原因写进 title。
 *
 * 四档宽度 390 / 560 / 620 / 1440 各跑一遍；断言尺寸沿用 D138 的口径：
 * `documentElement.scrollWidth == 视口宽`。
 *
 * 下沿四颗（#290）与 Aa 里的开关墙（#291）、窄屏强制显示（#292）不在这里验。
 *
 * Run: npm run build:web && node probes/chrome-topbar.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.CHROME_DIST ? path.resolve(process.env.CHROME_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const TOP = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira"];
/** 会话里的六颗（产物 / 文件管理器在没会话时不该出现，所以另有断言）。 */
const DESK_ONLY = ["terminal", "notes", "peer", "scratch", "jira"];

const state = (id, name, cwd) => ({
  id,
  name,
  cwd,
  ws: "f:/proj-01",
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
  owned: true,
});
const SESSIONS = [state("s-1", "顶栏会话一", "F:/proj-01"), state("s-2", "顶栏会话二", "F:/proj-02")];
const byId = (id) => SESSIONS.find((s) => s.id === id);
const GROUP = { id: "f:/proj-01", name: "proj-01", key: "F:/proj-01", manual: false };
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const workspace = () => ({ groups: [GROUP], overrides: {}, keys: { "f:/proj-01": GROUP.id, "f:/proj-02": GROUP.id } });

/** 桥端那份偏好：`undefined` 表示删键（回默认）。 */
let chrome = {};
const uiPayload = () => ({ showExtButton: chrome.ext !== false, chrome: { ...chrome } });

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
/** 页面连着的每一条：探针从服务端广播 `ui`，走的是「另一台设备改了偏好」那条真实路径。 */
const clients = new Set();
const broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  for (const ws of clients) ws.send(raw);
};
async function setChrome(patch) {
  for (const [id, choice] of Object.entries(patch)) {
    if (choice === undefined) delete chrome[id];
    else chrome[id] = choice;
  }
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(150);
}

server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const s = byId(msg.sessionId);
      if (msg.type === "subscribe" && s) {
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "ui.get") ws.send(JSON.stringify({ type: "ui", ui: uiPayload() }));
    });
    ws.send(
      JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace(), ui: uiPayload() }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

/** 那颗按钮在不在「看得见」的那一侧（CSS 的 `display:none` 与 `hidden` 都算）。 */
const seen = (page, act) =>
  page.evaluate((a) => {
    const n = document.querySelector(`.topbar [data-act="${a}"]`);
    return Boolean(n) && n.getClientRects().length > 0;
  }, act);
const dom = (page) =>
  page.evaluate(() => {
    const top = document.querySelector(".topbar");
    const acts = Array.from(document.querySelectorAll(".topbar [data-act]"))
      .filter((n) => n.getClientRects().length > 0)
      .map((n) => n.dataset.act);
    const btn = (a) => document.querySelector(`.topbar [data-act="${a}"]`);
    return {
      acts,
      topScroll: top ? Math.round(top.scrollWidth) : -1,
      topClient: top ? Math.round(top.clientWidth) : -1,
      docScroll: Math.round(document.documentElement.scrollWidth),
      viewport: Math.round(document.documentElement.clientWidth),
      hidden: Object.fromEntries(["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira"].map((a) => [a, btn(a)?.hidden ?? null])),
      labels: Object.fromEntries(["artifacts", "terminal", "files", "peer", "scratch", "jira"].map((a) => [a, btn(a)?.querySelector(".lb")?.textContent ?? btn(a)?.textContent ?? ""])),
      titles: Object.fromEntries(["artifacts", "files"].map((a) => [a, btn(a)?.title ?? ""])),
    };
  });
const openSession = async (page, id) => {
  await page.evaluate((sid) => {
    location.hash = `#/s/${sid}`;
  }, id);
  await page.waitForFunction(() => document.querySelector(".topbar .title")?.textContent !== "pi", null, { timeout: 8000 });
  await sleep(250);
};
/** 关会话走桥的 `session.gone`（页面里唯一会把 currentId 清空的真实路径）。 */
const closeSession = async (id) => {
  broadcast({ type: "session.gone", ids: [id] });
  await sleep(300);
};
const docFits = (d) => d.docScroll <= d.viewport;

async function setLang(page, lang) {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  await page.locator(`.display-sheet .chips .chip[lang="${lang}"]`).click();
  await sleep(300);
  await page.locator('.display-sheet .btn:has-text("关闭"), .display-sheet .btn:has-text("Close")').first().click();
  await sleep(250);
}
async function setLayout(page, id) {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  await page.locator(`.display-sheet .layout-chip[data-layout="${id}"]`).click();
  await sleep(200);
  await page.locator('.display-sheet .btn:has-text("关闭"), .display-sheet .btn:has-text("Close")').first().click();
  await sleep(300);
}

const errors = [];
const newPage = async (width) => {
  const page = await (await browser.newContext({ viewport: { width, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log(`pageerror(${width}):`, e.message);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(300);
  return page;
};

// ---------------------------------------------------------------- 桌面：默认 / 逐颗开关 / 会话叠加
{
  chrome = {};
  const page = await newPage(1440);
  let d = await dom(page);
  ok(DESK_ONLY.every((a) => d.acts.includes(a)), "桌面、没开会话：终端 / 记录 / 内网通 / 随手问 / Jira 都画");
  ok(!(await seen(page, "artifacts")) && !(await seen(page, "files")), "桌面、没开会话：产物与文件管理器不在顶栏");
  ok(docFits(d), `桌面、没开会话：页面不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  await setChrome({ artifacts: true, files: true });
  ok(!(await seen(page, "artifacts")) && !(await seen(page, "files")), "显式 true 也换不来一个会话：产物 / 文件管理器仍不画");
  d = await dom(page);
  ok(d.titles.artifacts.includes("没开会话") || d.titles.artifacts.includes("先"), `没会话时 title 说明原因（${d.titles.artifacts}）`);
  ok(docFits(d), `显式 true 但没会话：不留空位（${d.docScroll} <= ${d.viewport}）`);
  await setChrome({ artifacts: undefined, files: undefined });

  await openSession(page, "s-1");
  d = await dom(page);
  ok(TOP.every((a) => d.hidden[a] === false) && TOP.every((a) => d.acts.includes(a)), `开会话、默认：七颗全画（${d.acts.join(",")}）`);
  ok(docFits(d), `开会话、默认：页面不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 逐颗关掉再打开：只有那一颗变化，别的原位不动。
  for (const id of TOP) {
    chrome = { [id]: false };
    broadcast({ type: "ui", ui: uiPayload() });
    await sleep(180);
    d = await dom(page);
    const left = TOP.filter((a) => a !== id);
    ok(!d.acts.includes(id) && d.hidden[id] === true, `${id}:false → 那颗不画`);
    ok(left.every((a) => d.hidden[a] === false && d.acts.includes(a)), `${id}:false → 其余六颗原位不动`);
    ok(docFits(d), `${id}:false → 不留空位、不溢出（${d.docScroll} <= ${d.viewport}）`);

    chrome = {};
    broadcast({ type: "ui", ui: uiPayload() });
    await sleep(180);
    d = await dom(page);
    ok(TOP.every((a) => d.hidden[a] === false && d.acts.includes(a)), `${id} 删键 → 回默认，七颗全回来`);
  }

  // 一次关掉整排：顶栏不该剩一排空壳 / 空位。
  chrome = Object.fromEntries(TOP.map((a) => [a, false]));
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(200);
  d = await dom(page);
  ok(!TOP.some((a) => d.acts.includes(a)), `七颗全关：顶栏一颗都不画（${d.acts.join(",") || "空"}）`);
  ok(docFits(d), `七颗全关：页面不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  // 切语言：文字与可见性一起换，不能「字变了但少了一颗」。
  chrome = { notes: false, jira: true };
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(200);
  await setLang(page, "en");
  d = await dom(page);
  ok(!d.acts.includes("notes") && d.acts.includes("jira"), `切英文后可见性不裂（${d.acts.join(",")}）`);
  ok(d.labels.artifacts === "Artifacts" && d.labels.files === "Files", `切英文后按钮文字跟着换（${d.labels.artifacts} / ${d.labels.files}）`);
  await setLang(page, "zh-Hans");
  d = await dom(page);
  ok(d.labels.artifacts === "产物" && d.labels.files === "文件管理器", `切回中文后文字复位（${d.labels.artifacts} / ${d.labels.files}）`);
  ok(!d.acts.includes("notes") && d.acts.includes("jira"), "切回中文后可见性还是那份偏好");

  // 关会话：产物 / 文件管理器立刻退场，其余六颗照旧。
  await closeSession("s-1");
  d = await dom(page);
  ok(!(await seen(page, "artifacts")) && !(await seen(page, "files")), "关会话：产物与文件管理器立刻不画");
  ok(["terminal", "peer", "scratch", "jira"].every((a) => d.acts.includes(a)), "关会话：不跟会话绑定的四颗原位不动");
  ok(docFits(d), `关会话：不留空位、不溢出（${d.docScroll} <= ${d.viewport}）`);

  // 再开一个会话：回来了。
  await openSession(page, "s-2");
  ok((await seen(page, "artifacts")) && (await seen(page, "files")), "重新开会话：产物与文件管理器回来");
  await page.context().close();
}

// ---------------------------------------------------------------- 四套壳
for (const layout of ["a", "b", "c", "d"]) {
  chrome = {};
  const page = await newPage(1100);
  await openSession(page, "s-1");
  await setLayout(page, layout);
  ok((await page.evaluate(() => document.documentElement.dataset.layout)) === layout, `${layout}：壳切过去了`);

  chrome = { peer: false };
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(200);
  let d = await dom(page);
  ok(!d.acts.includes("peer") && d.hidden.peer === true, `${layout}：内网通关掉后不画`);
  ok(d.acts.includes("notes") && d.acts.includes("jira") && d.acts.includes("artifacts"), `${layout}：其余顶栏按钮不受影响`);

  chrome = {};
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(200);
  d = await dom(page);
  ok(d.hidden.peer === false && d.acts.includes("peer"), `${layout}：内网通回默认后回来`);
  ok(docFits(d), `${layout}：页面不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  await page.context().close();
}

// ---------------------------------------------------------------- 四档宽度
for (const width of [390, 560, 620, 1440]) {
  chrome = {};
  const page = await newPage(width);
  await openSession(page, "s-1");
  let d = await dom(page);
  ok((await seen(page, "artifacts")) && DESK_ONLY.every((a) => d.acts.includes(a)), `${width}：开会话后产物与常驻五颗都在`);
  ok(width > 560 ? d.acts.includes("files") : !d.acts.includes("files"), `${width}：文件管理器按 D138 的默认（${d.acts.includes("files") ? "画" : "不画"}）`);
  ok(docFits(d), `${width}：默认不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  chrome = { artifacts: false, terminal: false, files: false, notes: false, peer: false, scratch: false, jira: false };
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(220);
  d = await dom(page);
  const left = d.acts.filter((a) => TOP.includes(a));
  ok(left.length === 0, `${width}：七颗关掉后顶栏不剩可见按钮（${left.join(",") || "空"}）`);
  ok(docFits(d), `${width}：全关后不横向溢出（${d.docScroll} <= ${d.viewport}）`);

  chrome = { jira: true };
  broadcast({ type: "ui", ui: uiPayload() });
  await sleep(200);
  d = await dom(page);
  ok(d.acts.includes("jira") && d.hidden.jira === false, `${width}：只开 Jira 就只画 Jira`);
  ok(docFits(d), `${width}：只画一颗时不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  await page.context().close();
}

ok(errors.length === 0, `页面没有 JS 异常（${errors.length}）`);

await browser.close();
wss.close();
server.close();
console.log(bad ? `\n${bad} FAIL` : "\nall ok");
process.exit(bad ? 1 : 0);
