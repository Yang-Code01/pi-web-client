/**
 * Probe: 空工作区可以切过去 + 唯一会话的归档/删除入口（#611 / D373）。
 *
 * 用户的两句话：
 *   「当工作区中只剩一个会话时，横排鼠标移动到最后一个会话时，没有出现弹出，归档、删除的小 dialog。」
 *   「当某个工作区中没有会话时，现在无法切换，希望改成可以切换。切换后，允许内容为空显示。」
 *
 * 桩桥发真的工作区快照（`hello.workspace`）：alpha 里只有一颗**没点 ★** 的会话，beta 是空工作区。
 * 会话列表只有一个 alpha 会话，所以它既不在 ★ 行里（D146/D210），也没有任何可悬停的胶囊 ——
 * 「只剩一颗」这个状态就是用户报的那条缝。
 *
 * 七段：
 *   0. 前置：alpha 唯一那颗会话打开着，★ 行没有胶囊、NowChip 露着；
 *   1. NowChip 悬停 → 气泡出来，三项动作齐全（**没有**「取消置顶」，它本来不在 pin 里）；
 *   2. 点标签行里的 beta（空工作区）→ 真的切过去：横杠落在 beta、中栏认领、NowChip 收起、★ 行只剩 ＋；
 *   3. 刷新 → 仍停在 beta（选中态不进地址栏，只记在 localStorage）；
 *   4. 空态按钮与 ★ 行那颗 ＋ 都预填 beta 的目录（新会话弹层里「将在 … 新建」就是它）；
 *   5. beta 后来有了会话（桩桥塞一颗再刷新）→ 文案换成「里的会话还没打开」，且**不**自动打开任何会话；
 *   6. 回 alpha → NowChip 气泡里归档 → 中栏进空态、横杠留在 alpha；
 *   7. 再回 alpha（重开一颗）→ NowChip 气泡里删除 → 发删除帧、中栏进空态、横杠仍在 alpha。
 *
 * Run: npm run build:web && node probes/empty-workspace.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7945);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch/empty-workspace");
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

const CWD_ALPHA = path.join(REPO, ".scratch/probe-work/alpha");
const CWD_BETA = path.join(REPO, ".scratch/probe-work/beta");
const ALPHA = CWD_ALPHA.toLowerCase();
const BETA = CWD_BETA.toLowerCase();

const state = (id, name, cwd) => ({
  id, name, cwd, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", ws: cwd.toLowerCase(),
});
/** alpha 里唯一那颗：没点 ★（`manage.pin` 是空数组）——正是用户报的那种状态。 */
const SESSIONS = [state("ew-a", "只剩这一颗", CWD_ALPHA)];
const byId = (id) => SESSIONS.find((s) => s.id === id);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };
const resetFixtures = () => {
  SESSIONS.splice(0, SESSIONS.length, state("ew-a", "只剩这一颗", CWD_ALPHA));
  manage.pin = [];
  manage.archived = [];
};
/** 两个工作区：alpha 有那颗会话，beta 一个会话都没有。 */
const workspace = () => ({
  groups: [
    { id: ALPHA, key: CWD_ALPHA, name: "alpha", color: "blue", manual: false },
    { id: BETA, key: CWD_BETA, name: "beta", color: "purple", manual: false },
  ],
  overrides: {},
  keys: { [ALPHA]: CWD_ALPHA, [BETA]: CWD_BETA },
  order: [ALPHA, BETA],
  max: 6,
});
const stripOf = ({ items: _drop, ...rest }) => rest;

const frames = [];
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
  if (url.pathname === "/api/git") return json(200, { repo: CWD_ALPHA, branch: "main", detached: false, empty: false, dirty: 0 });
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
        return;
      }
      frames.push(msg);
      if (msg.type !== "manage") return;
      if (msg.action === "archive") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        manage.archived = msg.on ? [...new Set([...manage.archived, ...ids])] : manage.archived.filter((id) => !ids.includes(id));
        cast({ type: "manage", manage, workspace: workspace() });
        return;
      }
      if (msg.action === "delete") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        for (let i = SESSIONS.length - 1; i >= 0; i -= 1) if (ids.includes(SESSIONS[i].id)) SESSIONS.splice(i, 1);
        cast({ type: "manage", manage, workspace: workspace() });
        cast({ type: "session.gone", ids });
        cast({ type: "trash", items: ids.map((id) => ({ id, name: id, cwd: CWD_ALPHA, file: `x/${id}.jsonl`, deletedAt: Date.now(), size: 1024 })) });
        ws.send(JSON.stringify({ type: "delete.result", removed: ids, binned: ids, released: [], skipped: [] }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS.map(stripOf), manage, workspace: workspace(), trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("stub bridge on", BASE);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("PAGEERROR", e.message));

/** 页面现场：横杠落在哪、中栏说什么、★ 行几颗、NowChip 收没收起。 */
const snap = () =>
  page.evaluate(() => {
    const onTab = document.querySelector(".ws-tab.on");
    return {
      tabs: [...document.querySelectorAll(".ws-tab")].map((t) => t.querySelector(".ws-tab-name")?.textContent ?? ""),
      onTab: onTab?.querySelector(".ws-tab-name")?.textContent ?? null,
      onTabCurrent: onTab?.getAttribute("aria-current") === "true",
      title: document.querySelector(".chat-empty-title")?.textContent ?? null,
      hint: document.querySelector(".chat-empty-hint")?.textContent ?? null,
      action: document.querySelector(".chat-empty .btn")?.textContent ?? null,
      chips: document.querySelectorAll(".pin-strip .pin-chip:not(.pin-new):not(.pin-more)").length,
      // NowChip 的显隐在里层那颗（外层 .now-btn 是壳 B/C/D 的点击热区，一直在）：
      nowHidden: document.querySelector(".now-chip")?.hidden ?? null,
      hash: location.hash,
    };
  });
const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const menuActs = () => page.evaluate(() => [...document.querySelectorAll(".pin-menu .pm-item")].map((b) => b.dataset.act));
const tab = (name) => page.locator(".ws-tab").filter({ has: page.locator(".ws-tab-name", { hasText: name }) }).first();

/** 等到横杠落在 `name` 上（空态那几行要等快照回来才画出来）。 */
const settlesOn = async (name) =>
  until(async () => (await snap()).onTab === name, 8000, `横杠落在 ${name}`);
const hoverNow = async () => {
  // 指针得先离开再进来：`pointerenter` 只在跨边界那一下触发，鼠标本来就停在这颗上时再 hover 是空操作。
  // 离开再进来；间隔要盖过 220ms 的「离开才收」延时，否则应用手里还攥着上一张已关掉的气泡。
  await page.mouse.move(4, 640);
  await sleep(320);
  await page.locator(".now-btn").hover();
  await until(async () => (await count(".pin-menu")) === 1, 2500, "NowChip 的悬停气泡");
};

try {
  await page.goto(`${BASE}/#/s/ew-a`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await settlesOn("alpha");
  await until(async () => (await snap()).nowHidden === false, 6000, "NowChip 露出来");

  /* --------------------------------------------------- 0. 前置：只剩一颗、没点 ★ */
  log("0) 前置：alpha 唯一那颗会话打开着，★ 行里没有胶囊");
  const s0 = await snap();
  log("snap:", JSON.stringify(s0));
  ok(s0.chips === 0, `★ 行没有胶囊（实际 ${s0.chips} 颗）—— 这正是用户报的那种状态`);
  ok(s0.nowHidden === false, "NowChip 露着，代表那颗会话");
  ok(s0.hash === "#/s/ew-a", `地址栏是那颗会话（实际 ${s0.hash}）`);

  /* --------------------------------------------------- 1. NowChip 悬停出气泡 */
  log("1) NowChip 悬停 → 气泡");
  await hoverNow();
  const acts1 = await menuActs();
  log("menu:", JSON.stringify(acts1));
  await page.screenshot({ path: `${OUT}/1-nowchip-menu.png` });
  ok(acts1.join(",") === "archive,rename,delete", `三项动作齐全且顺序不变（实际：${acts1.join(",") || "空"}）`);
  ok(!acts1.includes("star") && !acts1.includes("unpin"), "没有「取消置顶」——它本来就不在 pin 里");
  await page.keyboard.press("Escape");
  await until(async () => (await count(".pin-menu")) === 0, 1500, "Esc 关掉气泡");

  /* --------------------------------------------------- 1b. 气泡里就地改名 */
  log("1b) NowChip 气泡里改名");
  await hoverNow();
  await page.click('.pm-item[data-act="rename"]');
  await page.locator(".pin-menu .pm-input").fill("改过的名字");
  await page.locator(".pin-menu .pm-input").press("Enter");
  await until(async () => (await page.evaluate(() => document.querySelector(".now-name")?.textContent)) === "改过的名字", 3000, "NowChip 换名字");
  ok(frames.some((f) => f.type === "rename" && f.name === "改过的名字"), "改名真的发了 rename 帧，NowChip 上就是新名字");

  /* --------------------------------------------------- 2. 切到空工作区 beta */
  log("2) 点标签行里的 beta（空工作区）");
  await tab("beta").click();
  await settlesOn("beta");
  await until(async () => (await snap()).title !== null, 6000, "中栏空态");
  const s2 = await snap();
  log("snap:", JSON.stringify(s2));
  await page.screenshot({ path: `${OUT}/2-empty-workspace.png` });
  ok(s2.onTabCurrent === true, "横杠与 aria-current 都落在 beta 上");
  ok(s2.title === "beta里还没有会话", `中栏认领这个工作区（实际：${s2.title}）`);
  ok((s2.action ?? "").includes("beta"), `空态里有一颗在 beta 里开新会话的按钮（实际：${s2.action}）`);
  ok(s2.nowHidden === true, "没有当前会话：NowChip 收起（★ 行只剩 ＋）");
  ok(s2.chips === 0, `★ 行仍没有胶囊（实际 ${s2.chips} 颗）`);
  ok(s2.hash === "#/", `地址栏回到无会话形态（实际 ${s2.hash}）`);

  /* --------------------------------------------------- 3. 刷新仍停在 beta */
  log("3) 刷新");
  await page.reload({ waitUntil: "domcontentloaded" });
  await settlesOn("beta");
  await until(async () => (await snap()).title !== null, 6000, "刷新后的空态");
  const s3 = await snap();
  log("snap:", JSON.stringify(s3));
  ok(s3.title === "beta里还没有会话", `刷新后仍停在这个空工作区（实际：${s3.title}）`);
  ok(s3.nowHidden === true, "刷新也不会替你打开会话");

  /* --------------------------------------------------- 4. ＋ 预填该组目录 */
  log("4) 空态按钮 / ★ 行那颗 ＋ 都预填 beta 的目录");
  await page.locator(".chat-empty .btn").click();
  await until(async () => (await count(".ns-where")) === 1, 4000, "新会话弹层");
  const where1 = await page.evaluate(() => document.querySelector(".ns-where")?.textContent ?? "");
  log("ns-where:", where1);
  ok(where1.includes("beta"), `空态按钮把目录预填成 beta（实际：${where1}）`);
  await page.evaluate(() => [...document.querySelectorAll(".sheet-head .btn.ghost")].find((b) => b.textContent?.trim() === "关闭")?.click());
  await sleep(250);
  await page.locator(".pin-new").click();
  await until(async () => (await count(".ns-where")) === 1, 4000, "新会话弹层（＋）");
  const where2 = await page.evaluate(() => document.querySelector(".ns-where")?.textContent ?? "");
  log("ns-where:", where2);
  ok(where2.includes("beta"), `★ 行那颗 ＋ 也预填 beta（实际：${where2}）`);
  await page.evaluate(() => [...document.querySelectorAll(".sheet-head .btn.ghost")].find((b) => b.textContent?.trim() === "关闭")?.click());
  await sleep(250);

  /* --------------------------------------------------- 5. beta 后来有了会话 */
  log("5) beta 后来有了一颗会话（不自动打开）");
  SESSIONS.push(state("ew-b", "后来那一颗", CWD_BETA));
  await page.reload({ waitUntil: "domcontentloaded" });
  await settlesOn("beta");
  await until(async () => (await snap()).title !== null, 6000, "刷新后的空态（有会话版）");
  const s5 = await snap();
  log("snap:", JSON.stringify(s5));
  ok(s5.title === "beta里的会话还没打开", `文案换成「还没打开」，不说假话（实际：${s5.title}）`);
  ok(s5.hash === "#/", `没有替我们打开它（实际 ${s5.hash}）`);
  ok(s5.nowHidden === true, "NowChip 仍是收起的");
  SESSIONS.splice(SESSIONS.findIndex((s) => s.id === "ew-b"), 1);

  /* --------------------------------------------------- 6. 回 alpha，从 NowChip 归档 */
  log("6) 回 alpha → NowChip 气泡里归档");
  await tab("alpha").click();
  await settlesOn("alpha");
  await until(async () => (await snap()).hash === "#/s/ew-a", 6000, "打开 alpha 那颗会话");
  await hoverNow();
  await page.click('.pm-item[data-act="archive"]');
  await until(async () => frames.some((f) => f.type === "manage" && f.action === "archive"), 6000, "归档帧");
  await settlesOn("alpha");
  await until(async () => (await snap()).title !== null, 6000, "归档后的空态");
  const s6 = await snap();
  log("snap:", JSON.stringify(s6));
  ok(s6.hash === "#/", `归档后中栏进空态（实际 ${s6.hash}）`);
  ok((s6.title ?? "").startsWith("alpha"), `空态归原来那个工作区（实际：${s6.title}）`);
  await page.screenshot({ path: `${OUT}/6-after-archive.png` });

  /* --------------------------------------------------- 7. 回 alpha，从 NowChip 删除 */
  log("7) 重开 alpha 那颗 → NowChip 气泡里删除");
  resetFixtures();
  await page.goto(`${BASE}/#/s/ew-a`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await settlesOn("alpha");
  await until(async () => (await snap()).nowHidden === false, 6000, "NowChip 回来");
  await hoverNow();
  await page.click('.pm-item[data-act="delete"]');
  await until(async () => frames.some((f) => f.type === "manage" && f.action === "delete"), 8000, "删除帧");
  await settlesOn("alpha");
  await until(async () => (await snap()).title !== null, 6000, "删除后的空态");
  const s7 = await snap();
  log("snap:", JSON.stringify(s7));
  ok(s7.hash === "#/", `删除后中栏进空态（实际 ${s7.hash}）`);
  ok(s7.title === "alpha里还没有会话", `一颗都不剩时文案是「还没有会话」（实际：${s7.title}）`);
  ok(s7.onTabCurrent === true, "横杠仍留在 alpha（不是无归属的空态）");
  await page.screenshot({ path: `${OUT}/7-after-delete.png` });

  /* --------------------------------------------------- 8. 壳 C：竖列那一格也认同一份选中态 */
  log("8) 壳 C 的竖列：高亮跟着选中的空工作区走");
  await page.evaluate(() => localStorage.setItem("pi.prefs", JSON.stringify({ layout: "c" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  const railOn = () => page.evaluate(() => document.querySelector(".ws-axis-item.on")?.dataset.ws ?? null);
  await until(async () => (await count(".ws-axis-item")) === 2, 8000, "竖列两格");
  // 壳 C 不画标签行（`parts.tabsRow` 为假），高亮只能从竖列上看。
  await until(async () => (await railOn()) === ALPHA, 8000, "竖列高亮落在 alpha");
  ok((await railOn()) === ALPHA, `刷新后竖列高亮仍在那个选中的空工作区上（实际 ${await railOn()}）`);
  await page.locator(`.ws-axis-item[data-ws="${BETA}"]`).click();
  await until(async () => (await railOn()) === BETA, 4000, "竖列高亮挪到 beta");
  ok((await snap()).title === "beta里还没有会话", "从竖列切到空工作区：中栏同样认领它");
  await page.screenshot({ path: `${OUT}/8-shell-c.png` });

  /* --------------------------------------------------- 9. 壳 D 色点条 / 壳 B 浮层段头 */
  log("9) 壳 D 的色点条与壳 B 的浮层段头也认这份选中态");
  // 删除动效会把左栏自动展开并写进 pi.collapse.sessions；色点条只在左栏收起时才有，先收回去。
  await page.evaluate(() => {
    localStorage.setItem("pi.collapse.sessions", "1");
    localStorage.setItem("pi.prefs", JSON.stringify({ layout: "d" }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const stripOn = () => page.evaluate(() => document.querySelector(".ws-strip .ws-axis-item.on")?.dataset.ws ?? null);
  await until(async () => (await count(".ws-strip .ws-axis-item")) === 2, 8000, "色点条两格");
  await until(async () => (await stripOn()) === BETA, 8000, "色点条高亮落在 beta");
  ok((await stripOn()) === BETA, `壳 D 色点条的高亮跟着选中的空工作区（实际 ${await stripOn()}）`);
  await page.screenshot({ path: `${OUT}/9-shell-d.png` });

  // 壳 B 的那颗只在有当前会话时才画得出内容（没会话时它整颗是空壳、点不到），先开一颗。
  resetFixtures();
  await page.evaluate(() => localStorage.setItem("pi.prefs", JSON.stringify({ layout: "b" })));
  await page.goto(`${BASE}/#/s/ew-a`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await snap()).nowHidden === false, 8000, "顶栏那颗有内容");
  await page.locator(".now-btn").click();
  await until(async () => (await count(".ws-pop")) === 1, 4000, "工作区浮层");
  const popOn = await page.evaluate(() => document.querySelector(".ws-pop-sec-head.on")?.dataset.ws ?? null);
  ok(popOn === ALPHA, `壳 B 浮层里段头高亮在会话所在那一组（实际 ${popOn}）`);
  await page.locator(`.ws-pop-sec-head[data-ws="${BETA}"]`).click();
  await until(async () => (await count(".ws-pop")) === 0, 3000, "点完段头浮层收掉");
  await until(async () => (await snap()).title === "beta里还没有会话", 6000, "从浮层切到一个空工作区");
  ok((await snap()).title === "beta里还没有会话", "从壳 B 的浮层段头也能切到没有会话的工作区");
  await page.screenshot({ path: `${OUT}/9-shell-b.png` });

  console.log(bad ? `\n${bad} FAIL` : "\nALL OK");
  process.exitCode = bad ? 1 : 0;
} finally {
  await browser.close();
  wss.close();
  server.close();
}
