/**
 * Probe: 归档当前会话 → 中栏切到 ★ 行的右邻（#189，#188 的 1/4）。
 *
 * 报障的样子是「归档之后那颗会话跑到横向第一个」：归档照常落库、它从 ★ 行消失，但中栏还停在它上面，
 * 于是 ★ 行第 1 格的 nowchip（画的就是当前会话）被一颗已归档的会话占住。本票的语义是
 * 「归档它 = 离开它」：点击与回声之间不预切、不闪回，回声到达后只切一次，落在右邻那颗 ★ 上。
 *
 * 断言（对应票面 acceptance）：
 *   1. 点胶囊气泡里的归档 → 点击瞬间中栏仍是原会话，且归档帧还没发出去（不预切）；
 *   2. 桥回声到达后 → 中栏是右邻（hash / 左栏 .active / ★ 行 .cur 三处一致），归档只发一帧；
 *   3. ★ 行第 1 格（nowchip）自始至终没有画过那颗被归档的会话 —— 用 MutationObserver 全程采样；
 *   4. 归档一颗**不是**当前会话的胶囊（走卡片底部按钮）→ 中栏一动不动；
 *   5. 从「已归档」段主动点开一个归档会话 → 不被踢走（判定只看「本次刚变归档」的那批）。
 *
 * 桩桥只实现归档：更新 archived、广播 manage 回声、按会话 id 回订阅快照 —— 与真桥的落库语义一致。
 *
 * Run: npm run build:web && node probes/archive-switch.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const { chromium } = await launchPlaywright();
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

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
