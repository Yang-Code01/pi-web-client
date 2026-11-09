/**
 * Probe: 「外观与语言」里的实时预览 + 开关墙（#291）。
 *
 * 纯函数还是 `web/tests/chrome-unit.mjs` 那一份；这里验的是浏览器里的四件事：
 *   A 点预览里的胶囊 → 真顶栏 / 下沿那颗立刻不画、对应方块变虚线；点方块 → 回来；
 *   B 预览切「手机 390」→ 没人碰过的文件管理器自己从预览里消失；点亮它的方块后窄档也在；
 *   C 每块「全部显示」= 删掉这组键（桥端真的少了 key，不是写 true），两块互不牵连；
 *   D 桥断了 → 整块置灰、一句说明、点什么都没反应；
 * 另加票里两条硬约定：「恢复默认」不碰 `chrome`；`Aa` 不在开关墙里。手机宽度下不裁切。
 *
 * 桥是探针自己起的：`ui.set` 按 bridge 的规则落盘（`null` 删键），再照真桥那样广播 `ui`。
 *
 * Run: npm run build:web && node probes/chrome-sheet.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.CHROME_DIST ? path.resolve(process.env.CHROME_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7932);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const TOP = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira"];
const BOTTOM = ["skills", "ext", "attach", "model"];
const ALL = [...TOP, ...BOTTOM];

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
const SESSIONS = [state("s-1", "开关墙会话", "F:/proj-01")];
const byId = (id) => SESSIONS.find((s) => s.id === id);
const GROUP = { id: "f:/proj-01", name: "proj-01", key: "F:/proj-01", manual: false };
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const workspace = () => ({ groups: [GROUP], overrides: {}, keys: { "f:/proj-01": GROUP.id } });

/** 桥端那份偏好：键缺失 = 默认。 */
let chrome = {};
/** 页面发过来的 `ui.set`，原样留着看它到底发了什么。 */
let sent = [];
const uiPayload = () => ({ showExtButton: chrome.ext !== false, chrome: { ...chrome } });
/** bridge/src/extmgr.ts 的落盘规则：`null` 删键，boolean 写值，其余忽略。 */
function applyPatch(patch) {
  for (const [id, choice] of Object.entries(patch ?? {})) {
    if (choice === null || choice === undefined) delete chrome[id];
    else if (typeof choice === "boolean") chrome[id] = choice;
  }
}

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
const clients = new Set();
const broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  for (const ws of clients) ws.send(raw);
};
/** 断桥段：不再接新连接，免得 600ms 后的自动重连把「断开」变回「连着」。 */
let acceptUpgrades = true;

server.on("upgrade", (req, socket, head) => {
  if (!acceptUpgrades || !(req.url ?? "").startsWith("/ws")) return socket.destroy();
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
      if (msg.type === "ui.set") {
        sent.push(msg);
        applyPatch(msg.chrome);
        broadcast({ type: "ui", ui: uiPayload() });
      }
    });
    ws.send(
      JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace(), ui: uiPayload() }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

/** 那颗按钮在不在「看得见」的那一侧（`display:none` 与 `hidden` 都算）。 */
const seen = (page, act) =>
  page.evaluate((a) => {
    const n = document.querySelector(`.topbar [data-act="${a}"]`);
    return Boolean(n) && n.getClientRects().length > 0;
  }, act);

/** 预览 + 开关墙的一张快照：胶囊/方块画没画、亮没亮、虚线没、灰没灰。 */
const snap = (page) =>
  page.evaluate((ALL) => {
    const pane = document.querySelector(".chrome-pane");
    const shot = (n) => Boolean(n) && n.getClientRects().length > 0;
    const tile = (id) => pane?.querySelector(`.chrome-tile[data-chrome="${id}"]`) ?? null;
    const cap = (id) => pane?.querySelector(`.chrome-pv [data-chrome="${id}"]`) ?? null;
    const rects = (n) => (n ? n.getBoundingClientRect() : null);
    const right = Math.max(0, ...[...document.querySelectorAll(".chrome-pane .chrome-tile")].map((n) => rects(n).right));
    return {
      exists: Boolean(pane),
      pvNarrow: pane?.querySelector(".chrome-pv")?.classList.contains("narrow") ?? false,
      caps: Object.fromEntries(ALL.map((id) => [id, shot(cap(id))])),
      tiles: Object.fromEntries(ALL.map((id) => [id, tile(id) ? !tile(id).classList.contains("off") : null])),
      tileDash: Object.fromEntries(ALL.map((id) => [id, tile(id) ? getComputedStyle(tile(id)).borderTopStyle : ""])),
      capsDisabled: ALL.map((id) => cap(id)?.disabled ?? null),
      tileDisabled: ALL.map((id) => tile(id)?.disabled ?? null),
      offline: pane?.classList.contains("offline") ?? false,
      note: pane?.querySelector(".chrome-offline")?.textContent ?? "",
      wallAa: /\bAa\b/.test(pane?.querySelector(".chrome-wall")?.textContent ?? ""),
      topRight: Math.round(right),
      docScroll: Math.round(document.documentElement.scrollWidth),
      viewport: Math.round(document.documentElement.clientWidth),
    };
  }, ALL);

const openSession = async (page) => {
  await page.evaluate(() => {
    location.hash = "#/s/s-1";
  });
  await page.waitForFunction(() => document.querySelector(".topbar .title")?.textContent !== "pi", null, { timeout: 8000 });
  await sleep(250);
};
const openSheet = async (page) => {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".chrome-pane", { timeout: 5000 });
  await sleep(200);
};
const docFits = (d) => d.docScroll <= d.viewport;

const errors = [];
const newPage = async (width) => {
  const page = await (await browser.newContext({ viewport: { width, height: 860 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.log(`pageerror(${width}):`, e.message);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(300);
  return page;
};

// ---------------------------------------------------------------- A 点胶囊：预览即开关
{
  chrome = {};
  sent = [];
  const page = await newPage(1440);
  await openSession(page);
  await openSheet(page);
  let d = await snap(page);
  ok(d.exists, "A 预览与开关墙画出来了");
  ok(d.caps.terminal && d.tiles.terminal === true && d.tileDash.terminal === "solid", "A 默认：终端在预览里、方块实线亮着");
  ok(d.caps.artifacts && d.caps.files, "A 开了会话：产物与文件管理器也在预览里");

  await page.locator('.chrome-pv-btn[data-chrome="terminal"]').click();
  await sleep(250);
  d = await snap(page);
  ok(chrome.terminal === false, "A 点预览里的终端：桥收到 terminal:false");
  ok(!d.caps.terminal, "A 点完那颗立刻从预览里消失");
  ok(!(await seen(page, "terminal")), "A 真顶栏那颗跟着不画");
  ok(d.tiles.terminal === false && d.tileDash.terminal === "dashed", "A 对应方块变虚线（未亮）");
  ok(docFits(d), `A 关一颗：不留空位、不溢出（${d.docScroll} <= ${d.viewport}）`);

  await page.locator('.chrome-tile[data-chrome="terminal"]').click();
  await sleep(250);
  d = await snap(page);
  ok(chrome.terminal === true, "A 点方块：桥收到 terminal:true");
  ok(d.caps.terminal && (await seen(page, "terminal")), "A 点方块：预览与真顶栏那颗一起回来");
  ok(d.tiles.terminal === true && d.tileDash.terminal === "solid", "A 方块回实线");

  // 下沿那颗同一条路：预览里的「技能」→ chrome.skills。
  await page.locator('.chrome-pv [data-chrome="skills"]').click();
  await sleep(250);
  d = await snap(page);
  ok(chrome.skills === false && !d.caps.skills, "A 点预览下沿的「技能」：桥收到 skills:false，预览里消失");
  ok(!(await page.evaluate(() => Boolean(document.querySelector('.hint-tools [data-act="skills"]')?.getClientRects().length))), "A 真下沿的「技能」跟着不画");
  await page.context().close();
}

// ---------------------------------------------------------------- B 预览切宽度：文件管理器自己退场
{
  chrome = {};
  sent = [];
  const page = await newPage(1440);
  await openSession(page);
  await openSheet(page);
  await page.locator('.chrome-seg [data-width="narrow"]').click();
  await sleep(250);
  let d = await snap(page);
  ok(d.pvNarrow, "B 切到「手机 390」：预览收窄");
  ok(!d.caps.files && d.tiles.files === false && d.tileDash.files === "dashed", "B 窄档下没人碰过的文件管理器从预览里消失、方块虚着");
  ok(d.caps.artifacts && d.tiles.artifacts === true, "B 窄档只收文件管理器，产物还在");
  ok(await seen(page, "files"), "B 真顶栏（1440）不受预览宽度影响，文件管理器照画");
  ok(chrome.files === undefined, "B 只是看，不写盘：chrome 里没有 files");

  await page.locator('.chrome-tile[data-chrome="files"]').click();
  await sleep(250);
  d = await snap(page);
  ok(chrome.files === true, "B 点亮方块：桥收到 files:true");
  ok(d.caps.files && d.tiles.files === true, "B 点亮后窄档预览里也在");

  await page.locator('.chrome-seg [data-width="wide"]').click();
  await sleep(200);
  d = await snap(page);
  ok(!d.pvNarrow && d.caps.files, "B 切回桌面：文件管理器还在（显式 true）");

  await page.locator('.chrome-all[data-group="top"]').click();
  await sleep(250);
  ok(chrome.files === undefined, "B「全部显示」把 files 删回默认");
  await page.locator('.chrome-seg [data-width="narrow"]').click();
  await sleep(200);
  d = await snap(page);
  ok(!d.caps.files && d.tiles.files === false, "B 删键后再进窄档：文件管理器又自己消失");
  ok(docFits(d), `B 窄档预览不裁切（${d.docScroll} <= ${d.viewport}）`);
  await page.context().close();
}

// ---------------------------------------------------------------- C 每块「全部显示」= 删该组键
{
  chrome = { terminal: false, peer: false, ext: false };
  sent = [];
  const page = await newPage(1440);
  await openSession(page);
  await openSheet(page);
  let d = await snap(page);
  ok(d.tiles.terminal === false && d.tiles.peer === false && d.tiles.ext === false, "C 起始：两份 false 都在方块上（虚线）");

  await page.locator('.chrome-all[data-group="top"]').click();
  await sleep(250);
  d = await snap(page);
  const topPatch = sent.at(-1)?.chrome ?? {};
  ok(TOP.every((id) => topPatch[id] === null), "C 顶栏「全部显示」发的是 null（删键），不是 true");
  ok(TOP.every((id) => !(id in chrome)), "C 顶栏组的键全删了");
  ok(chrome.ext === false, "C 顶栏「全部显示」不碰下沿的 ext");
  ok(TOP.every((id) => d.tiles[id] === true) && d.tiles.ext === false, "C 顶栏方块全亮，下沿的扩展还虚着");

  await page.locator('.chrome-all[data-group="bottom"]').click();
  await sleep(250);
  d = await snap(page);
  const botPatch = sent.at(-1)?.chrome ?? {};
  ok(BOTTOM.every((id) => botPatch[id] === null), "C 下沿「全部显示」发的也是 null");
  ok(Object.keys(chrome).length === 0, `C 下沿组的键全删了，桥端回到默认（${JSON.stringify(chrome)}）`);
  ok(ALL.every((id) => d.tiles[id] === true), "C 十一块全亮");
  await page.context().close();
}

// ---------------------------------------------------------------- 恢复默认 / Aa
{
  chrome = { terminal: false };
  const page = await newPage(1440);
  await openSession(page);
  await openSheet(page);
  let d = await snap(page);
  ok(d.wallAa === false, "「Aa」不在开关墙里");
  await page.locator('.display-sheet .sheet-foot .btn').click();
  await page.waitForSelector(".chrome-pane", { timeout: 5000 });
  await sleep(300);
  d = await snap(page);
  ok(chrome.terminal === false, "「恢复默认」不碰 chrome");
  ok(d.exists && d.tiles.terminal === false, "重开的表里那颗还是虚的");
  await page.context().close();
}

// ---------------------------------------------------------------- 手机宽度：不裁切
{
  chrome = {};
  const page = await newPage(390);
  await openSession(page);
  await openSheet(page);
  const d = await snap(page);
  ok(docFits(d), `390：整页不横向溢出（${d.docScroll} <= ${d.viewport}）`);
  ok(d.topRight <= d.viewport, `390：开关墙最右边那块不越界（${d.topRight} <= ${d.viewport}）`);
  await page.locator('.chrome-seg [data-width="narrow"]').click();
  await sleep(200);
  ok(docFits(await snap(page)), "390：预览收窄后也不溢出");
  await page.context().close();
}

// ---------------------------------------------------------------- D 断桥：整块置灰、点了没反应
{
  chrome = {};
  sent = [];
  const page = await newPage(1440);
  await openSession(page);
  await openSheet(page);
  const before = sent.length;
  acceptUpgrades = false;
  for (const ws of clients) ws.close();
  await page.waitForFunction(() => document.querySelector(".chrome-pane")?.classList.contains("offline"), null, { timeout: 5000 });
  await sleep(200);
  let d = await snap(page);
  ok(d.offline, "D 桥断了：整块标成 offline（置灰）");
  ok(d.note.includes("桥") && d.note.length > 4, `D 断桥时有一句说明（${d.note}）`);
  ok(d.tiles.terminal === true, "D 置灰只是灰，内容还画着");
  ok(d.capsDisabled.every((x) => x === true) && d.tileDisabled.every((x) => x === true), "D 预览与方块都不可点");

  await page.evaluate(() => {
    document.querySelector('.chrome-tile[data-chrome="terminal"]')?.click();
    document.querySelector('.chrome-pv-btn[data-chrome="terminal"]')?.click();
  });
  await sleep(250);
  ok(sent.length === before, "D 断桥时点击不发 ui.set");
  ok(!("terminal" in chrome), "D 断桥时桥端偏好没动");
  await page.context().close();
}

ok(errors.length === 0, `页面没有 JS 异常（${errors.length}）`);

await browser.close();
wss.close();
server.close();
console.log(bad ? `\n${bad} FAIL` : "\nall ok");
process.exit(bad ? 1 : 0);
