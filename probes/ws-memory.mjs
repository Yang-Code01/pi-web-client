/**
 * Probe: 工作区记忆（#647 / D390）—— 切回一个工作区时打开「你上次停下的那颗」。
 *
 * 用户的原话：「从当前会话切换到另一个工作区时，另一个默认进入的是该工作区的第一个会话，
 * 而不是之前切换的会话。现在想要会话在切换工作区时具有记忆功能。」
 *
 * 桩桥发一份真工作区快照：alpha 与 beta 各有两颗会话（各一颗「新」、一颗「旧」），gamma 是空组。
 * 只看用户看得见的三件事：地址栏 hash、中栏里是哪颗、横杠停在哪一组 —— 外加 `pi.ws.last` 本身。
 *
 * 十二段：
 *   0. 深链 `#/s/wm-a1` 打开 → alpha 那颗成为记忆（任何来源都算）；
 *   1. 切 beta（无记忆）→ 落到 updatedAt 最大的 wm-b2，不是数组第一颗；
 *   2. beta 里点旧的 wm-b1 → 记忆换人；切回 alpha → 记忆里那颗 wm-a1（它比 wm-a2 旧，照样赢）；
 *   3. 再切 beta → wm-b1（记忆压过更新的 wm-b2）；
 *   4. 刷新 → 仍停在 wm-b1；来回切组记忆都还在；
 *   5. 记忆那颗被删（别处删掉）→ 切过去落到 updatedAt 最大的 wm-a2，死记忆被改写；
 *   6. 记忆那颗被归档 → 落到 wm-b2（不自动请回来，D386 只在主动打开时发生）；
 *   7. 空组（从 ＋N 里切）→ D374 空态，一个字没变，也不落任何会话；
 *   8. 左栏搜索把记忆那颗滤掉 → 切组照样打开它（落点不看过滤）；
 *   9. 壳 C 竖列 / 壳 D 色点条切组也落在记忆那颗；
 *  10. 壳 B 浮层段头同样；`session` 帧送来的新会话（不走 openSession）也会写记忆；
 *  11. 旧桥（hello 里没有 workspace）：切组照旧开排最上面那颗，**不许**跌进空工作区那条路。
 *
 * Run: npm run build:web && PI_WEB_PORT=7946 node probes/ws-memory.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7946);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch/ws-memory");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const CWD_A = path.join(REPO, ".scratch/probe-work/wsa");
const CWD_B = path.join(REPO, ".scratch/probe-work/wsb");
const CWD_G = path.join(REPO, ".scratch/probe-work/wsg");
const A = CWD_A.toLowerCase();
const B = CWD_B.toLowerCase();
const G = CWD_G.toLowerCase();

const state = (id, name, cwd, ws, updatedAt) => ({
  id,
  name,
  cwd,
  ws,
  file: null,
  owned: true,
  origin: "web",
  running: false,
  done: false,
  updatedAt,
  approvals: 0,
  asks: 0,
  locked: false,
  preview: "",
});
/** 时间戳故意拉开：wm-a2 / wm-b2 是「最近活动」那颗，wm-a1 / wm-b1 是「你上次停下的」那颗。 */
const SESSIONS = [
  state("wm-a1", "alpha 旧", CWD_A, A, 1_700_000_100_000),
  state("wm-a2", "alpha 新", CWD_A, A, 1_700_000_900_000),
  state("wm-b1", "beta 旧", CWD_B, B, 1_700_000_100_000),
  state("wm-b2", "beta 新", CWD_B, B, 1_700_000_900_000),
];
const byId = (id) => SESSIONS.find((s) => s.id === id);
const manage = { pin: [], order: [], archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
/** `max: 2` —— gamma 被收进 ＋N，第 7 段顺便把那条入口也走一遍。 */
const workspace = () => ({
  groups: [
    { id: A, key: CWD_A, name: "alpha", color: "blue", manual: false },
    { id: B, key: CWD_B, name: "beta", color: "purple", manual: false },
    { id: G, key: CWD_G, name: "gamma", color: "green", manual: false },
  ],
  overrides: {},
  keys: { [A]: CWD_A, [B]: CWD_B, [G]: CWD_G },
  order: [A, B, G],
  max: 2,
});
const stripOf = ({ items: _drop, ...rest }) => rest;

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
  if (url.pathname === "/api/git") return json(200, { repo: CWD_A, branch: "main", detached: false, empty: false, dirty: 0 });
  if (url.pathname === "/api/dirs") {
    const dir = url.searchParams.get("path") ?? "";
    return json(200, { path: dir, parent: path.dirname(dir), dirs: [], files: [], error: "" });
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

/** 第 11 段用：让下一次连接的 hello 不带 `workspace`（旧桥 / 桩桥的样子）。 */
let legacyHello = false;
const wss = new WebSocketServer({ noServer: true });
const cast = (msg) => {
  for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify(msg));
};
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
      if (msg.type === "subscribe") {
        const s = byId(msg.sessionId);
        if (!s) return;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: stripOf(s), items: [], approvals: [], asks: [], budget: null }));
      }
    });
    const hello = { type: "hello", me: ME, sessions: SESSIONS.map(stripOf), manage, workspace: workspace(), trash: [], tunnel: TUNNEL };
    if (legacyHello) delete hello.workspace;
    ws.send(JSON.stringify(hello));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("stub bridge on", BASE);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("PAGEERROR", e.message));

/** 页面现场：地址栏、横杠落在哪组、中栏空态说了什么。 */
const snap = () =>
  page.evaluate(() => {
    const onTab = document.querySelector(".ws-tab.on");
    return {
      hash: location.hash,
      onTab: onTab?.dataset.ws ?? null,
      empty: document.querySelector(".chat-empty-title")?.textContent ?? null,
    };
  });
/** D390 那份记忆：`{ 组 id: { id, at } }`。 */
const last = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("pi.ws.last") ?? "{}");
    } catch {
      return {};
    }
  });
const tab = (id) => page.locator(`.ws-tab[data-ws="${id}"]`);
const card = (id) => page.locator(`.session-card[data-id="${id}"]`);
/** 等到中栏里是 `id`（地址栏跟着走，`openFromList()` 会推 hash）。 */
const opens = async (id) => {
  await until(async () => (await snap()).hash === `#/s/${id}`, 8000, `打开 ${id}`);
  return snap();
};
const boot = async (hash) => {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
  await sleep(400);
};
const setLayout = async (id) => {
  await page.evaluate((layout) => {
    try {
      const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      p.layout = layout;
      localStorage.setItem("pi.prefs", JSON.stringify(p));
    } catch {
      /* 不是 JSON：当作没有偏好 */
    }
  }, id);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
  await sleep(500);
};

// ---------------------------------------------------------------- 0. 深链写记忆
await boot("#/s/wm-a1");
let s = await snap();
ok(s.hash === "#/s/wm-a1" && s.onTab === A, `0. 深链打开 alpha 那颗（${s.hash} / ${s.onTab}）`);
ok((await last())[A]?.id === "wm-a1", `0. 深链也算「我看过它」：alpha → wm-a1（${JSON.stringify((await last())[A])}）`);

// ---------------------------------------------------------------- 1. 没有记忆时按最近活动
await tab(B).click();
s = await opens("wm-b2");
ok(s.onTab === B, `1. 切 beta 落在 updatedAt 最大的 wm-b2（没有记忆，不是数组第一颗）`);
ok((await last())[B]?.id === "wm-b2", `1. beta 的记忆跟上（${JSON.stringify((await last())[B])}）`);

// ---------------------------------------------------------------- 2/3. 记忆压过「更新」
await card("wm-b1").click();
await opens("wm-b1");
ok((await last())[B]?.id === "wm-b1", "2. 在 beta 里点旧的那颗：记忆换人");
await tab(A).click();
s = await opens("wm-a1");
ok(s.onTab === A, `2. 切回 alpha 落在记忆里的 wm-a1（它比 wm-a2 旧，照样赢）`);
await tab(B).click();
await opens("wm-b1");
ok(true, "3. 再切 beta 仍是 wm-b1（记忆压过更新的 wm-b2）");

// ---------------------------------------------------------------- 4. 刷新之后还在
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
await sleep(500);
s = await snap();
ok(s.hash === "#/s/wm-b1" && s.onTab === B, `4. 刷新仍停在 wm-b1（${s.hash} / ${s.onTab}）`);
await tab(A).click();
await opens("wm-a1");
ok(true, "4. 刷新后切 alpha 仍是记忆里的 wm-a1");
await tab(B).click();
await opens("wm-b1");
ok(true, "4. 刷新后切 beta 仍是记忆里的 wm-b1");

// ---------------------------------------------------------------- 5. 记忆那颗被删
SESSIONS.splice(SESSIONS.findIndex((x) => x.id === "wm-a1"), 1);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
await sleep(500);
await tab(A).click();
s = await opens("wm-a2");
ok(s.onTab === A, "5. 记忆那颗被删了：落到 updatedAt 最大的 wm-a2");
ok((await last())[A]?.id === "wm-a2", `5. 死记忆被改写成 wm-a2（${JSON.stringify((await last())[A])}）`);

// ---------------------------------------------------------------- 6. 记忆那颗被归档
manage.archived = ["wm-b1"];
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
await sleep(500);
await tab(B).click();
s = await opens("wm-b2");
ok(s.hash === "#/s/wm-b2", "6. 记忆那颗被归档：落到 wm-b2，不自动请回来");

// ---------------------------------------------------------------- 7. 空组（从 ＋N 里切）
await page.locator(".ws-tabs-more").click();
await until(async () => (await page.locator(`.ws-tabs-menu .pm-item[data-ws="${G}"]`).count()) > 0, 4000, "＋N 里的 gamma");
await page.locator(`.ws-tabs-menu .pm-item[data-ws="${G}"]`).first().click();
await until(async () => (await snap()).empty !== null, 6000, "gamma 的空态");
s = await snap();
ok(s.hash === "#/" && s.onTab === G, `7. 空组：横杠落在 gamma、地址栏回到 #/（${s.hash} / ${s.onTab}）`);
ok(/gamma/.test(s.empty ?? "") && /还没有会话/.test(s.empty ?? ""), `7. D374 空态原样（「${s.empty}」）`);
ok(!(G in (await last())), "7. 空组不写记忆（没有会话可记）");

// ---------------------------------------------------------------- 8. 落点不看左栏过滤
// 第 5 段把 wm-a1 从桩桥的数据里删了；这一段要把「被过滤掉的那颗」当记忆，所以先把它放回去、
// 让页面重新拿一份 hello（不重新拿的话 `sessions` 里没有它，点了也打不开）。
SESSIONS.unshift(state("wm-a1", "alpha 旧", CWD_A, A, 1_700_000_100_000));
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
await sleep(500);
await tab(A).click();
await opens("wm-a2");
await card("wm-a1").click();
await opens("wm-a1");
ok((await last())[A]?.id === "wm-a1", "8. 记忆回到 wm-a1");
await page.locator(".session-filter").fill("新");
await sleep(400);
ok((await page.locator('.session-card[data-id="wm-a1"]').count()) === 0, "8. 过滤把 wm-a1 从左栏藏掉了");
await tab(A).click();
s = await opens("wm-a1");
ok(s.hash === "#/s/wm-a1", "8. 左栏搜索把 wm-a1 滤掉了，切组照样打开它（落点不看过滤）");
await page.locator(".session-filter").fill("");
await sleep(200);

// ---------------------------------------------------------------- 9. 壳 C 竖列 / 壳 D 色点条
await setLayout("c");
await page.locator(`.ws-rail .ws-axis-item[data-ws="${B}"]`).first().click();
s = await opens("wm-b2");
ok(s.hash === "#/s/wm-b2", `9. 壳 C 竖列切 beta 落在记忆里的 wm-b2（${s.hash}）`);
await setLayout("d");
// 色点条只在左栏收起时出现（它就是那颗「展开回去」的按钮）。
const collapsed = () => page.evaluate(() => document.querySelector(".main")?.classList.contains("no-left") ?? false);
if (!(await collapsed())) await page.locator('.icon-btn[data-side="left"]').first().click();
await until(async () => ((await page.locator(".ws-strip").count()) > 0 && (await page.locator(".ws-strip").isVisible())), 6000, "壳 D 色点条");
await page.locator(`.ws-strip .ws-axis-item[data-ws="${A}"]`).first().click();
s = await opens("wm-a1");
ok(s.hash === "#/s/wm-a1", `9. 壳 D 色点条切 alpha 落在记忆里的 wm-a1（${s.hash}）`);

// ---------------------------------------------------------------- 10. 壳 B 浮层段头 + 会话帧
await setLayout("b");
await page.locator(".now-btn").click();
await until(async () => (await page.locator(`.ws-pop-sec-head[data-ws="${B}"]`).count()) > 0, 4000, "壳 B 浮层");
await page.locator(`.ws-pop-sec-head[data-ws="${B}"]`).first().click();
s = await opens("wm-b2");
ok(s.hash === "#/s/wm-b2", `10. 壳 B 浮层段头切 beta 落在记忆里的 wm-b2（${s.hash}）`);
// 新会话不走 `openSession()`：`session` 帧到了就该记下它。
const a3 = state("wm-a3", "alpha 刚建", CWD_A, A, 1_700_000_050_000);
SESSIONS.push(a3);
cast({ type: "session", sessionId: a3.id, state: stripOf(a3), items: [], approvals: [], asks: [], budget: null });
await until(async () => (await last())[A]?.id === "wm-a3", 5000, "会话帧写进记忆");
ok(true, "10. `session` 帧送来的新会话也成为 alpha 的记忆（不走 openSession）");

// ---------------------------------------------------------------- 11. 旧桥（没有工作区快照）
legacyHello = true;
const legacy = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const lp = await legacy.newPage();
lp.on("pageerror", (e) => log("PAGEERROR(legacy)", e.message));
await lp.goto(BASE, { waitUntil: "domcontentloaded" });
await lp.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
await sleep(500);
await lp.locator(`.ws-tab[data-ws="${B}"]`).first().click();
await until(async () => (await lp.evaluate(() => location.hash)).startsWith("#/s/wm-"), 8000, "旧桥切组也开会话");
const legacyHash = await lp.evaluate(() => location.hash);
ok(legacyHash === "#/s/wm-b2", `11. 旧桥没有工作区快照：切组照旧开排最上面那颗（${legacyHash}）`);
legacyHello = false;
await legacy.close();

// ---------------------------------------------------------------- 收尾
const errors = await page.evaluate(() => document.querySelectorAll(".fail-toast").length);
ok(errors === 0, `没有失败提示（${errors}）`);
await page.screenshot({ path: path.join(OUT, "ws-memory.png") });
await browser.close();
wss.close();
server.close();
console.log(bad ? `\n${bad} FAILED` : "\nALL OK");
process.exit(bad ? 1 : 0);
