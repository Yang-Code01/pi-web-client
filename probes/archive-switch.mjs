/**
 * Probe: 归档当前会话 → 中栏切到 ★ 行的邻居（#189 右邻，#190 左邻 / 空态；#188 的 1/4 → 2/4）。
 *
 * 报障的样子是「归档之后那颗会话跑到横向第一个」：归档照常落库、它从 ★ 行消失，但中栏还停在它上面，
 * 于是 ★ 行第 1 格的 nowchip（画的就是当前会话）被一颗已归档的会话占住。本票的语义是
 * 「归档它 = 离开它」：点击与回声之间不预切、不闪回，回声到达后只切一次，落在右邻 → 左邻 → 空态。
 *
 * 断言（对应票面 acceptance）：
 *   1. 点胶囊气泡里的归档 → 点击瞬间中栏仍是原会话，且归档帧还没发出去（不预切）；
 *   2. 桥回声到达后 → 中栏是右邻（hash / 左栏 .active / ★ 行 .cur 三处一致），归档只发一帧；
 *   3. ★ 行第 1 格（nowchip）自始至终没有画过那颗被归档的会话 —— 用 MutationObserver 全程采样；
 *   4. 归档一颗**不是**当前会话的胶囊（走卡片底部按钮）→ 中栏一动不动；
 *   5. 从「已归档」段主动点开一个归档会话 → 不被踢走（判定只看「本次刚变归档」的那批）；
 *   6. 归档 ★ 行最右那颗（没有右邻）→ 落在左邻；
 *   7. 归档唯一一颗 ★ → 中栏是现成空态、地址栏回到 `#/`；刷新后仍是空态，且从左侧打开会话能回去；
 *   8. #191：管理面板批量归档（含当前会话）→ 与气泡演出的落点完全一致（同一初始局面下都是右邻）；
 *   9. #191：一次批量同时带走当前会话和它的右邻 → 邻居按**归档之后**的 ★ 行算，跳过同批那颗、落到左邻；
 *  10. #191：批量把 ★ 行整行带走 → 与单颗一样进空态；
 *  11. #191：批量里**不含**当前会话 → 中栏 / hash / ★ 行 .cur 一动不动（回归）；
 *  12. #191：窄屏（★ 行整行不显示）批量归档当前会话 → 落点与壳 A 一致；
 *  13. #191：壳 B / C / D（★ 行不显示）同上 —— 同一份 ★ 顺序，不因壳而异。
 *
 * 桩桥只实现归档：更新 archived、广播 manage 回声、按会话 id 回订阅快照 —— 与真桥的落库语义一致。
 *
 * Run: npm run build:web && node probes/archive-switch.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.ARCHIVE_DIST ? path.resolve(process.env.ARCHIVE_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.ARCHIVE_SHOT ?? "archive-switch";
// 7899 可能被别的程序占着（这台机器上是 VPN 客户端），照仓库里其它探针的惯例允许换端口。
const PORT = Number(process.env.PI_WEB_PORT ?? 7899);
let BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const state = (id, name) => ({
  id,
  name,
  cwd: "E:/demo",
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

// 一颗工作区里的 5 个会话：★ 行 = st-1 … st-4（st-5 没置顶，用来占住左栏）。
const NAMES = { "st-1": "会话 01", "st-2": "会话 02", "st-3": "会话 03", "st-4": "会话 04", "st-5": "会话 05" };
const SESSIONS = Object.entries(NAMES).map(([id, name]) => state(id, name));
const byId = (id) => SESSIONS.find((s) => s.id === id);
const CUR = "st-2"; // 开在 ★ 行中间的那颗
const RIGHT = "st-3"; // 它的右邻
// 一个工作区：桩桥也带 workspace 快照，走的是真桥那条「本区 ★」的路，而不是置顶列表的兜底。
const WS = { groups: [{ id: "e:/demo", name: "demo", key: "E:/demo", manual: false }], overrides: {}, keys: { "e:/demo": "e:/demo" } };
const MANAGE = { pin: ["st-1", "st-2", "st-3", "st-4"], order: [], archived: [] };
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
const cast = (msg) => {
  for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify(msg));
};
/** 前端发来的归档帧 —— 断言「只发一帧」「点击瞬间还没发」。 */
const frames = [];
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
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "manage" && msg.action === "archive") {
        const ids = (Array.isArray(msg.ids) ? msg.ids : []).map(String);
        frames.push({ ids, on: msg.on !== false });
        for (const id of ids) {
          if (msg.on === false) MANAGE.archived = MANAGE.archived.filter((x) => x !== id);
          else if (!MANAGE.archived.includes(id)) MANAGE.archived.push(id);
        }
        // 真桥的落库 + 广播：先写 manage，再发回声。
        cast({ type: "manage", manage: MANAGE });
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, workspace: WS, trash: [], tunnel: TUNNEL }));
  });
});
// 7899 可能被别的程序占着（这台机器上是 VPN 客户端），占着就换一个空闲口，不要求调用方带 env。
const listen = (port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
try {
  await listen(PORT);
} catch (e) {
  if (e.code !== "EADDRINUSE") throw e;
  BASE = `http://127.0.0.1:${await listen(0)}`;
  console.log(`port ${PORT} busy, serving on ${BASE}`);
}
fs.mkdirSync(path.join(REPO, ".scratch"), { recursive: true });

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 860 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

/** 中栏现在是谁：hash + 左栏 .active 卡片 + ★ 行里带 .cur 的那颗。 */
const current = () =>
  page.evaluate(() => ({
    hash: location.hash.slice(4),
    active: document.querySelector(".session-card.active")?.dataset.id ?? null,
    curChip: document.querySelector(".pin-strip .pin-chip.cur")?.dataset.pinId ?? null,
  }));

const row = () =>
  page.evaluate(() => ({
    chips: [...document.querySelectorAll(".pin-strip .pin-chip[data-pin-id]")].map((c) => ({
      id: c.dataset.pinId,
      name: c.querySelector(".pin-name")?.textContent ?? "",
      cur: c.classList.contains("cur"),
    })),
    now: (() => {
      const btn = document.querySelector(".ws-session-row .now-chip-slot .now-btn");
      const chip = btn?.querySelector(".now-chip");
      return { shown: Boolean(btn) && !btn.hidden && !(chip && chip.hidden), name: btn?.querySelector(".now-name")?.textContent?.trim() ?? "" };
    })(),
  }));

// 首屏：#/s/st-2，★ 行 = st-1 … st-4，当前会话那颗带 .cur
await page.goto(`${BASE}/#/s/${CUR}`, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".pin-strip .pin-chip[data-pin-id]", { timeout: 15000 });
await sleep(800);
let box = await row();
ok(box.chips.map((c) => c.id).join(",") === "st-1,st-2,st-3,st-4", `★ 行 = ${box.chips.map((c) => c.id).join(" → ")}`);
ok(box.now.shown === false, "当前会话已在 ★ 行里 → 第 1 格 nowchip 不出场");

// 全程采样第 1 格：它一旦显示那颗被归档的会话，`hit` 就永久为真。
const ARCHIVED_NAME = NAMES[CUR];
await page.evaluate((archivedName) => {
  window.__firstCell = [];
  window.__firstCellHit = false;
  const sample = () => {
    const btn = document.querySelector(".ws-session-row .now-chip-slot .now-btn");
    const chip = btn?.querySelector(".now-chip");
    const name = btn?.querySelector(".now-name")?.textContent?.trim() ?? "";
    const shown = Boolean(btn) && !btn.hidden && !(chip && chip.hidden);
    window.__firstCell.push({ shown, name });
    if (window.__firstCell.length > 400) window.__firstCell.shift();
    if (shown && name === archivedName) window.__firstCellHit = true;
  };
  sample();
  window.__firstCellTimer = setInterval(sample, 20);
  new MutationObserver(sample).observe(document.querySelector(".ws-session-row"), {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
}, ARCHIVED_NAME);

// 1) 胶囊气泡里的归档（带收起动画：帧在 520 + 240ms 之后才发）
await page.locator(`.pin-strip .pin-chip[data-pin-id="${CUR}"]`).hover();
await page.waitForSelector('.pin-menu .pm-item[data-act="archive"]', { timeout: 4000 });
await page.locator('.pin-menu .pm-item[data-act="archive"]').click();
await sleep(140);
const atClick = await current();
ok(atClick.hash === CUR && atClick.active === CUR, `点击瞬间中栏仍是原会话（hash = ${atClick.hash || "空"}）`);
ok(frames.length === 0, `……而且归档帧还没发出去（已发 ${frames.length} 帧）`);

// 2) 回声到达 → 切到右邻
await page.waitForFunction((id) => location.hash === `#/s/${id}`, RIGHT, { timeout: 8000 });
await sleep(500);
const after = await current();
ok(frames.length === 1 && frames[0].ids.join(",") === CUR, `归档只发了一帧（${JSON.stringify(frames)}）`);
ok(after.hash === RIGHT, `回声后 hash 落在右邻 ${RIGHT}（实际 ${after.hash}）`);
ok(after.active === RIGHT, `回声后左栏 .active 是右邻 ${RIGHT}（实际 ${after.active}）`);
ok(after.curChip === RIGHT, `回声后 ★ 行 .cur 是右邻 ${RIGHT}（实际 ${after.curChip}）`);
box = await row();
ok(!box.chips.some((c) => c.id === CUR), "被归档那颗已经从 ★ 行消失");
ok(box.chips.map((c) => c.id).join(",") === "st-1,st-3,st-4", `★ 行的邻居没挪位（${box.chips.map((c) => c.id).join(" → ")}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-right.png`), clip: { x: 0, y: 0, width: 1100, height: 170 } });

// 3) 第 1 格自始至终没有画过那颗被归档的会话
const firstCell = await page.evaluate(() => ({ hit: window.__firstCellHit, samples: window.__firstCell.length }));
ok(firstCell.hit === false, `★ 行第 1 格全程没画过「${ARCHIVED_NAME}」（采样 ${firstCell.samples} 次）`);

// 4) 归档**不是**当前会话的那颗（卡片底部按钮）→ 中栏一动不动
const notCur = "st-1";
const before = await current();
// 卡片的归档 / 删除按钮只在鼠标指上去时才显示（styles.css:322）。
await page.locator(`.session-card[data-id="${notCur}"]`).hover();
await sleep(200);
await page.locator(`.session-card[data-id="${notCur}"] .card-acts.bottom .card-act:not(.del)`).click();
for (let i = 0; i < 40 && !MANAGE.archived.includes(notCur); i += 1) await sleep(100);
await sleep(500);
const still = await current();
ok(frames.length === 2 && frames[1].ids.join(",") === notCur, `卡片按钮也走同一个归档收口（${JSON.stringify(frames[1])}）`);
ok(still.hash === before.hash && still.active === before.active, `归档非当前会话：中栏一动不动（${still.hash}）`);
ok(MANAGE.archived.includes(notCur), "……而它确实进了归档");

// 5) 从「已归档」段主动点开一个归档会话 → 不被踢走
await page.locator('.session-sec[data-sec="archived"] .label').click();
await sleep(300);
await page.locator(`.session-card[data-id="${CUR}"]`).click();
await sleep(1000);
const reread = await current();
ok(reread.hash === CUR, `归档会话能正常打开并留在中栏（hash = ${reread.hash}）`);
ok(frames.length === 2, `打开归档会话不发任何归档帧（仍是 ${frames.length} 帧）`);
const rereadBox = await row();
ok(rereadBox.now.shown === false, `已归档的当前会话也不许占第 1 格（第 1 格显示 ${rereadBox.now.shown ? rereadBox.now.name : "（没有出场）"}）`);

// 控制组：打开一颗不在 ★ 行里的会话 → 第 1 格必须出场并写着它。
// 没这一步，上面的「自始至终没画过」就可能是采样器永远看不见东西导致的假绿。
await page.locator(`.session-card[data-id="st-5"]`).click();
await sleep(700);
const ctrl = await row();
ok(ctrl.now.shown === true && ctrl.now.name === NAMES["st-5"], `控制组：不在 ★ 行的当前会话占住第 1 格（显示「${ctrl.now.name}」）`);

/** 中栏的空态：现成那句「还没有打开会话 / 左边选一个，或者开一个新的」。 */
const emptyState = () =>
  page.evaluate(() => {
    const box = document.querySelector(".chat-empty");
    return {
      hash: location.hash,
      empty: Boolean(box && box.getClientRects().length),
      title: document.querySelector(".chat-empty-title")?.textContent?.trim() ?? "",
      hint: document.querySelector(".chat-empty-hint")?.textContent?.trim() ?? "",
      active: document.querySelector(".session-card.active")?.dataset.id ?? null,
      chips: [...document.querySelectorAll(".pin-strip .pin-chip[data-pin-id]")].map((c) => c.dataset.pinId),
      now: (() => {
        const btn = document.querySelector(".ws-session-row .now-chip-slot .now-btn");
        const chip = btn?.querySelector(".now-chip");
        return { shown: Boolean(btn) && !btn.hidden && !(chip && chip.hidden) };
      })(),
    };
  });

/** 在 ★ 行里归档当前那颗（走胶囊气泡，与上面同一条入口）。 */
const archiveChip = async (id) => {
  await page.locator(`.pin-strip .pin-chip[data-pin-id="${id}"]`).hover();
  await page.waitForSelector('.pin-menu .pm-item[data-act="archive"]', { timeout: 4000 });
  await page.locator('.pin-menu .pm-item[data-act="archive"]').click();
};

// 6) #190：归档 ★ 行最右那颗（没有右邻）→ 落在左邻
await page.locator(`.session-card[data-id="st-4"]`).click();
await page.waitForFunction(() => location.hash === "#/s/st-4", null, { timeout: 5000 });
await sleep(400);
const rightmostBefore = await row();
ok(rightmostBefore.chips.map((c) => c.id).join(",") === "st-3,st-4", `归档前 ★ 行 = ${rightmostBefore.chips.map((c) => c.id).join(" → ")}（st-4 是最右那颗）`);
await archiveChip("st-4");
await page.waitForFunction(() => location.hash === "#/s/st-3", null, { timeout: 8000 });
await sleep(500);
const left = await current();
ok(frames.length === 3 && frames[2].ids.join(",") === "st-4", `最右那颗只发了一帧归档（${JSON.stringify(frames[2])}）`);
ok(left.hash === "st-3", `没有右邻 → 落在左邻 st-3（hash = ${left.hash}）`);
ok(left.active === "st-3", `左栏 .active 也落在左邻 st-3（实际 ${left.active}）`);
ok(left.curChip === "st-3", `★ 行 .cur 也落在左邻 st-3（实际 ${left.curChip}）`);
box = await row();
ok(box.chips.map((c) => c.id).join(",") === "st-3", `★ 行只剩 st-3（${box.chips.map((c) => c.id).join(" → ")}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-left.png`), clip: { x: 0, y: 0, width: 1100, height: 170 } });

// 7) #190：归档唯一一颗 ★ → 中栏空态 + 地址栏无会话形态；刷新后仍是空态
await archiveChip("st-3");
await page.waitForFunction(() => location.hash === "#/" && document.querySelector(".chat-empty"), null, { timeout: 8000 });
await sleep(500);
const empty = await emptyState();
ok(frames.length === 4 && frames[3].ids.join(",") === "st-3", `唯一那颗只发了一帧归档（${JSON.stringify(frames[3])}）`);
ok(empty.hash === "#/", `地址栏回到无会话形态（hash = ${JSON.stringify(empty.hash)}）`);
ok(empty.empty === true, "中栏是现成的空态（.chat-empty 可见）");
ok(empty.title === "还没有打开会话", `空态标题用的是现成文案（「${empty.title}」）`);
ok(empty.hint === "左边选一个，或者开一个新的", `空态提示用的是现成文案（「${empty.hint}」）`);
ok(empty.active === null, "左栏没有任何会话被选中（不是残影）");
ok(empty.chips.length === 0, `★ 行一颗都不剩（${empty.chips.join(" → ") || "空"}）`);
ok(empty.now.shown === false, "第 1 格 nowchip 也没有画那颗归档会话");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-empty.png`) });

// 刷新：hash 仍是 `#/`，空态仍是空态（没把归档会话从 hash 里又拉回来）
await page.reload({ waitUntil: "networkidle" });
await sleep(800);
const reloaded = await emptyState();
ok(reloaded.hash === "#/", `刷新后地址栏仍是 ${JSON.stringify(reloaded.hash)}`);
ok(reloaded.empty === true && reloaded.title === "还没有打开会话", "刷新后仍是空态（没有把归档会话又拉回中栏）");
ok(reloaded.active === null, "刷新后左栏也没有选中任何会话");
ok(reloaded.chips.length === 0, "刷新后 ★ 行仍然一颗都不剩");

// 空态之后从左侧打开任意会话 → 正常回到会话页
await page.locator(`.session-card[data-id="st-5"]`).click();
await page.waitForFunction(() => location.hash === "#/s/st-5", null, { timeout: 5000 });
await sleep(400);
const back = await emptyState();
ok(back.hash === "#/s/st-5" && back.active === "st-5", `空态后从左侧打开会话能正常回去（hash = ${back.hash}，active = ${back.active}）`);
ok(back.empty === false, "……空态随之收起");

/* ------------------------------------------------------------------ #191
 *
 * 上面那条走的是「胶囊气泡 + 收起演出」：帧在 520 + 240ms 之后才发，回声比别处晚到。
 * 下面从同一个初始局面出发，走**批量归档**（会话管理面板多选）与**别的壳 / 窄屏**，
 * 断言落点与演出路径完全一致：右邻 → 左邻 → 空态，且邻居按归档之后的 ★ 行算。
 */
await page.context().close();

/** 帧里的 ids 顺序是面板里「显示顺序」，不是断言对象 —— 只比集合。 */
const sameSet = (got, want) => [...got].sort().join(",") === [...want].sort().join(",");

/** 每个场景都从同一个局面开始：★ 行 = st-1 … st-4，当前会话 st-2，没有归档。 */
const resetBridge = () => {
  MANAGE.pin = ["st-1", "st-2", "st-3", "st-4"];
  MANAGE.archived = [];
  frames.length = 0;
};

/** 新开一张页面（可选换壳 / 换视口），停在 `#/s/st-2`。 */
async function freshPage({ layout = "a", viewport = { width: 1100, height: 860 } } = {}) {
  resetBridge();
  const ctx = await browser.newContext({ viewport, locale: "zh-CN" });
  // 壳是 localStorage 里的 `pi.prefs.layout`（readPrefs → layoutPref）—— 开页前种进去，等同设置里点那颗 chip。
  if (layout !== "a") {
    await ctx.addInitScript((id) => {
      try {
        const raw = localStorage.getItem("pi.prefs");
        const prefs = raw ? JSON.parse(raw) : {};
        localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, layout: id }));
      } catch {
        /* private mode */
      }
    }, layout);
  }
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`pageerror(${layout}):`, e.message));
  await p.goto(`${BASE}/#/s/${CUR}`, { waitUntil: "networkidle" });
  if (await p.locator('input[type="password"]').count()) {
    await p.fill('input[type="password"]', "probe");
    await p.click('button:has-text("进入")');
  }
  // 窄屏下左栏是另一个标签页（`.session-card` 只是挂着、不可见），所以只等它进 DOM。
  await p.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
  await sleep(800);
  return p;
}

/** 中栏现在是谁：hash + 左栏 .active。壳 B/C/D 与窄屏没有 ★ 行，所以 .cur 只在这时有值。 */
const landing = (p) =>
  p.evaluate(() => ({
    hash: location.hash,
    active: document.querySelector(".session-card.active")?.dataset.id ?? null,
    curChip: document.querySelector(".pin-strip .pin-chip.cur")?.dataset.pinId ?? null,
    chips: [...document.querySelectorAll(".pin-strip .pin-chip[data-pin-id]")].map((c) => c.dataset.pinId),
    empty: Boolean(document.querySelector(".chat-empty")?.getClientRects().length),
  }));

/** 等中栏落到某处；等不到也**不抛** —— 让断言打 FAIL 行，而不是把探针整个炸掉。 */
async function settle(p, pred, arg) {
  try {
    await p.waitForFunction(pred, arg, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** 会话管理面板：开 → 勾这几行 → 点「归档」。窄屏与 B/C/D 里那颗「管理」按钮不在可视区，按 DOM 点。 */
async function openManager(p) {
  await p.evaluate(() => document.querySelector('.manage-bar .tool-btn[data-act="manage"]')?.click());
  await p.waitForSelector(".mgr-sheet .mgr-row", { timeout: 5000 });
  await sleep(250);
}

async function bulkArchive(p, ids) {
  await openManager(p);
  for (const id of ids) {
    await p.locator(".mgr-sheet .mgr-row").filter({ hasText: NAMES[id] }).first().locator('input[type="checkbox"]').check();
    await sleep(150);
  }
  await p.locator(".mgr-sheet .mgr-foot .btn").filter({ hasText: /^归档$/ }).click();
}

/** 关掉面板，好让 DOM 断言不被浮层挡着（overlay 不挡查询，但关掉更接近用户看到的结局）。 */
async function closeManager(p) {
  await p.evaluate(() => {
    const head = document.querySelector(".mgr-sheet .sheet-head");
    const btn = head ? [...head.querySelectorAll("button")].find((b) => b.textContent?.trim() === "关闭") : undefined;
    btn?.click();
  });
  await sleep(350);
}

// 8) 批量归档（会话管理面板）含当前会话 → 与气泡演出同落点：右邻
let p2 = await freshPage();
let start = await landing(p2);
ok(start.hash === `#/s/${CUR}` && start.chips.join(",") === "st-1,st-2,st-3,st-4", `批量场景起点：中栏 ${start.hash}，★ 行 ${start.chips.join(" → ")}`);
await bulkArchive(p2, [CUR]);
await settle(p2, (id) => location.hash === `#/s/${id}`, RIGHT);
await closeManager(p2);
let land = await landing(p2);
ok(frames.length === 1 && frames[0].ids.join(",") === CUR, `管理面板批量（一颗）只发一帧归档（${JSON.stringify(frames)}）`);
ok(land.hash === `#/s/${RIGHT}` && land.active === RIGHT && land.curChip === RIGHT, `批量归档当前会话 → 与演出路径同落点 ${RIGHT}（hash = ${land.hash}，active = ${land.active}，★ 行 = ${land.curChip}）`);
ok(land.chips.join(",") === "st-1,st-3,st-4", `★ 行少掉那颗（${land.chips.join(" → ")}）`);

// 9) 批量里同时带走当前会话和它的右邻 → 邻居按**归档之后**的 ★ 行算，跳过同批那颗，落到左邻
await bulkArchive(p2, ["st-3", "st-4"]);
await settle(p2, () => location.hash === "#/s/st-1");
await closeManager(p2);
land = await landing(p2);
ok(frames.length === 2 && sameSet(frames[1].ids, ["st-3", "st-4"]), `第二次批量只发一帧、带走两颗（${JSON.stringify(frames[1])}）`);
ok(land.hash === "#/s/st-1" && land.active === "st-1", `同批右邻被跳过 → 落在归档后 ★ 行的左邻 st-1（hash = ${land.hash}，active = ${land.active}）`);
ok(land.chips.join(",") === "st-1", `★ 行只剩 st-1（${land.chips.join(" → ")}）`);

// 10) 批量把 ★ 行整行带走 → 与单颗一样进空态
await bulkArchive(p2, ["st-1"]);
await settle(p2, () => location.hash === "#/" && Boolean(document.querySelector(".chat-empty")));
await closeManager(p2);
land = await landing(p2);
ok(frames.length === 3 && frames[2].ids.join(",") === "st-1", `第三次批量只发一帧（${JSON.stringify(frames[2])}）`);
ok(land.hash === "#/" && land.active === null && land.empty === true, `★ 行整行被带走 → 空态（hash = ${JSON.stringify(land.hash)}）`);
ok(land.chips.length === 0, "……★ 行一颗都不剩");
await p2.context().close();

// 11) 批量里**不含**当前会话 → 中栏一动不动（回归）
let p3 = await freshPage();
await bulkArchive(p3, ["st-3", "st-4"]);
for (let i = 0; i < 40 && !MANAGE.archived.includes("st-4"); i += 1) await sleep(100);
await closeManager(p3);
const untouched = await landing(p3);
ok(frames.length === 1 && sameSet(frames[0].ids, ["st-3", "st-4"]), `批量不含当前会话：只发一帧、两颗都在里面（${JSON.stringify(frames[0])}）`);
ok(untouched.hash === `#/s/${CUR}` && untouched.active === CUR, `……中栏一动不动（hash = ${untouched.hash}，active = ${untouched.active}）`);
ok(untouched.curChip === CUR, `……★ 行 .cur 仍是当前会话（${untouched.curChip}）`);
await p3.context().close();

// 12) 窄屏（★ 行整行不显示）：落点与壳 A 一致
const p4 = await freshPage({ viewport: { width: 760, height: 900 } });
ok((await p4.evaluate(() => document.documentElement.dataset.compact)) === "true", "窄屏：data-compact 生效（★ 行整行不显示）");
await bulkArchive(p4, [CUR]);
await settle(p4, (id) => location.hash === `#/s/${id}`, RIGHT);
await closeManager(p4);
const narrow = await landing(p4);
ok(narrow.hash === `#/s/${RIGHT}` && narrow.active === RIGHT, `窄屏批量归档当前会话 → 与壳 A 同落点 ${RIGHT}（hash = ${narrow.hash}，active = ${narrow.active}）`);
ok(narrow.chips.length === 0, "……窄屏确实没有 ★ 行（落点靠的是同一份顺序）");
await p4.context().close();

// 13) 壳 B/C/D：★ 行不显示，落点仍与壳 A 一致
for (const layout of ["b", "c", "d"]) {
  const p = await freshPage({ layout });
  ok((await p.evaluate(() => document.documentElement.dataset.layout)) === layout, `壳 ${layout}：data-layout 跟上`);
  await bulkArchive(p, [CUR]);
  await settle(p, (id) => location.hash === `#/s/${id}`, RIGHT);
  await closeManager(p);
  const got = await landing(p);
  ok(got.hash === `#/s/${RIGHT}` && got.active === RIGHT, `壳 ${layout}：批量归档当前会话 → 与壳 A 同落点 ${RIGHT}（hash = ${got.hash}，active = ${got.active}）`);
  ok(got.chips.length === 0, `壳 ${layout}：没有 ★ 行（落点不受壳影响）`);
  await p.context().close();
}

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
