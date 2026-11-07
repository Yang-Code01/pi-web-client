/**
 * Probe: 迁移预览（#101）。
 *
 * 第一次看到分组之前先弹一次「会建哪些工作区、各几个会话、其中几个是你拖过的」，确认后才写标记
 * （`pi.prefs.wsIntroSeen`，跟别的偏好同一份）；取消什么都不写，所以下次打开还会弹。断言六件事：
 *   1. 首次打开弹预览，行数 = 左栏组数；
 *   2. 每行的名字与会话数跟左栏那一组逐项相同（数字来自同一棵 `buildTree()` 树，不是另算一套）；
 *   3. 归档会话不计入预览，但组内卡片数仍按左栏算；「拖过的」只数桥记了 override 的那些；
 *   4. 点「就这样开始」→ 标记落进 `pi.prefs.wsIntroSeen`（不另开 storage key），刷新不再弹；
 *   5. 点「以后再说」→ 什么都没写，刷新仍然弹；
 *   6. 同一张页面里只弹一次（关掉之后左栏交互不会把它重新推上来）；
 *   7. 旧桥兼容（#178）：快照没有 `order` → 标签按显示名字母序，且不绑拖动（拖了不发 ws.tabs）。
 *
 * 桩桥照真桥：`opened` 只回快照（D146），页面也不再发它；`WORKSPACE` 故意不带 `order`，就是旧桥的形状。
 *
 * Run: npm run build:web && node probes/workspace-migrate.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.WS_SHOT ?? "workspace-migrate";
const PORT = Number(process.env.PI_WEB_PORT ?? 7907);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const LIB = { id: "f:/pi-web-client", name: "pi-web-client", key: "F:/pi-web-client", manual: false };
const BLOG = { id: "f:/demo/blog", name: "blog", key: "F:/demo/blog", manual: false };
const TOOLS = { id: "f:/demo/tools", name: "tools", key: "F:/demo/tools", manual: false };
// 两条手拖过的：一条从 blog 拖进 library，一条从 blog 拖进 tools。
// 真桥会把 override 折进会话自己的 `ws` 再发下来（D126），桩桥照这个约定造数据 —— 前端只信 `ws`。
const WORKSPACE = { groups: [LIB, BLOG, TOOLS], overrides: { "s-loose": LIB.id, "s-moved": TOOLS.id }, keys: {} };
const MOVED = Object.keys(WORKSPACE.overrides).length;

let n = 0;
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
  updatedAt: Date.now() - ++n * 1000,
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});

const SESSIONS = [
  state("s-main", "主仓：左栏两级树", "F:/pi-web-client", LIB.id),
  state("s-wt95", "worktree 95：票 #95", "F:/pi-web-client-wt/95", LIB.id),
  state("s-loose", "从 blog 拖过来的", "F:/demo/blog", LIB.id),
  state("s-blog", "写篇博客", "F:/demo/blog", BLOG.id),
  state("s-tools", "整理脚本", "F:/demo/tools", TOOLS.id),
  state("s-moved", "也拖进 tools 的", "F:/demo/blog", TOOLS.id),
];
// 归档：桥仍然给它 ws，但预览和左栏都不许把它算进任何组。
const ARCH = state("s-arch", "归档里的旧会话", "F:/demo/blog", BLOG.id);
SESSIONS.push(ARCH);

const MANAGE = { pin: ["s-tools"], order: ["s-main"], archived: [ARCH.id] };
/** 页面发来的 manage 指令（#178 旧桥兼容：拖标签不该发 ws.tabs）。 */
const MSGS = [];
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
      if (msg.type === "manage") MSGS.push(msg);
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, workspace: WORKSPACE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

const passGate = async (page) => {
  await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
    await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  }
};

/** 预览弹层 + 底下那棵左栏树 + prefs，一次取全，好逐项对账。 */
const snapshot = (page) =>
  page.evaluate(() => {
    const num = (txt) => Number((txt ?? "").replace(/\D/g, "")) || 0;
    const sheet = document.querySelector(".ws-intro-sheet");
    const prefs = (() => {
      try {
        return JSON.parse(localStorage.getItem("pi.prefs") ?? "{}") ?? {};
      } catch {
        return {};
      }
    })();
    return {
      intro: sheet
        ? {
            sum: sheet.querySelector(".ws-intro-sum")?.textContent ?? "",
            rows: [...sheet.querySelectorAll(".ws-intro-row")].map((r) => ({
              ws: r.dataset.ws ?? "",
              name: r.querySelector(".ws-intro-name")?.textContent ?? "",
              n: num(r.querySelector(".ws-intro-n")?.textContent),
              moved: num(r.querySelector(".ws-intro-moved")?.textContent),
            })),
          }
        : null,
      groups: [...document.querySelectorAll(".ws-sec")].map((sec) => ({
        ws: sec.dataset.ws ?? "",
        name: sec.querySelector(".ws-head .label")?.textContent ?? "",
        n: sec.querySelectorAll(".session-card").length,
      })),
      // 归档段默认是收起的，卡片不一定在 DOM 里，数它组头的「(N)」更稳。
      archived: Number((document.querySelector('.session-sec[data-sec="archived"] .sess-head .n')?.textContent ?? "").replace(/\D/g, "")) || 0,
      prefs,
      storageKeys: Object.keys(localStorage),
    };
  });

const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
  // 页面在 `navigator.webdriver` 为真时不弹预览（D146，避免把自动化全挡在模态下面）；
  // 这张探针要考的正是它，所以先把标记摘掉。
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  return { context, page };
};

// 1) 第一次打开：弹预览，且每一行都跟左栏对得上
const first = await newPage();
await first.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await passGate(first.page);
await sleep(800);
let s = await snapshot(first.page);

ok(Boolean(s.intro), "第一次打开就弹「工作区」预览（.ws-intro-sheet 在）");
ok(s.intro?.rows.length === s.groups.length, `预览里的组数 = 左栏组数（${s.intro?.rows.length} / ${s.groups.length}）`);
const mismatch = s.groups.filter((g) => {
  const row = s.intro?.rows.find((r) => r.ws === g.ws);
  return !row || row.name !== g.name || row.n !== g.n;
});
ok(s.groups.length === 3 && mismatch.length === 0, `每行的名字与会话数跟左栏一致（${s.groups.map((g) => `${g.name}:${g.n}`).join(" / ")}）`);
const sumN = (s.intro?.sum ?? "").match(/会建 (\d+) 个工作区、(\d+) 个会话/);
ok(Boolean(sumN) && Number(sumN[1]) === s.groups.length, `汇总句里的组数取自同一棵树（${s.intro?.sum}）`);
const nonArchived = s.groups.reduce((k, g) => k + g.n, 0);
ok(Number(sumN?.[2]) === nonArchived && nonArchived === 6, `汇总句里的会话数 = 左栏卡片总数 ${nonArchived}（归档的那条不算）`);
ok(s.archived === 1 && !s.intro?.rows.some((r) => r.name === "归档里的旧会话"), `归档区自己有一条（${s.archived}），但不进预览的任何一行`);
const movedRows = s.intro?.rows.reduce((k, r) => k + r.moved, 0) ?? -1;
ok(movedRows === MOVED, `「拖过的」只数桥记下的 override：${movedRows} / 期望 ${MOVED}`);
ok(s.prefs.wsIntroSeen === undefined, "确认之前不写标记（prefs.wsIntroSeen 还没出现）");
await first.page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-intro.png`) });

// 2) 确认 → 标记进 pi.prefs，刷新不再弹
s = await snapshot(first.page);
await first.page.locator(".ws-intro-sheet .sheet-foot .btn.primary").click();
await sleep(500);
s = await snapshot(first.page);
ok(s.intro === null, "点「就这样开始」后预览收掉");
ok(s.prefs.wsIntroSeen === true, "标记写进同一份 prefs：pi.prefs.wsIntroSeen = true");
ok(s.storageKeys.filter((k) => k !== "pi.prefs" && /intro|ws|work/i.test(k)).length === 0, `没有为预览另开 storage key（${s.storageKeys.join(", ")}）`);

await first.page.reload({ waitUntil: "networkidle" });
await passGate(first.page);
await sleep(1000);
s = await snapshot(first.page);
ok(s.intro === null, "确认后刷新不再弹预览");
ok(s.groups.length === 3, `左栏照样按工作区分好组（${s.groups.map((g) => g.name).join(" / ")}）`);

// 3) 取消：什么都不写，同一张页面里也不再自己弹回来
const second = await newPage();
await second.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await passGate(second.page);
await sleep(800);
s = await snapshot(second.page);
ok(Boolean(s.intro), "全新 profile（没标记）打开照样弹预览");
await second.page.locator(".ws-intro-sheet .sheet-foot .btn.ghost").click();
await sleep(500);
s = await snapshot(second.page);
ok(s.intro === null, "点「以后再说」后预览收掉");
ok(s.prefs.wsIntroSeen === undefined, "取消不写标记（下次还能看到）");
await second.page.locator(".ws-sec:first-child .ws-head").click();
await sleep(600);
s = await snapshot(second.page);
ok(s.intro === null, "关掉之后左栏交互不会把它重新推上来（同一张页面只弹一次）");

// 4) 取消后刷新 → 仍然弹
await second.page.reload({ waitUntil: "networkidle" });
await passGate(second.page);
await sleep(1000);
s = await snapshot(second.page);
ok(Boolean(s.intro), "取消后刷新仍然弹预览");

// 5) #178 旧桥兼容：快照没有 order → 标签按显示名字母序，且不绑拖动
await first.page.reload({ waitUntil: "networkidle" });
await passGate(first.page);
await sleep(700);
const legacy = await first.page.evaluate(() => ({
  tree: [...document.querySelectorAll(".ws-sec")].map((n) => n.querySelector(".ws-head .label")?.textContent ?? ""),
  tabs: [...document.querySelectorAll(".ws-tab")].map((n) => n.querySelector(".ws-tab-name")?.textContent ?? ""),
}));
const ALPHA = ["blog", "pi-web-client", "tools"];
ok(JSON.stringify(legacy.tree) === JSON.stringify(ALPHA), `旧桥：左栏按显示名字母序（${legacy.tree.join(" / ")}）`);
ok(JSON.stringify(legacy.tabs) === JSON.stringify(ALPHA), `旧桥：标签行也按显示名字母序（${legacy.tabs.join(" / ")}）`);
const beforeDrag = MSGS.filter((m) => m.action === "ws.tabs").length;
const boxA = await first.page.locator(".ws-tab").first().boundingBox();
const boxB = await first.page.locator(".ws-tab").last().boundingBox();
if (boxA && boxB) {
  const y = Math.round(boxA.y + boxA.height / 2);
  await first.page.mouse.move(Math.round(boxA.x + boxA.width / 2), y);
  await first.page.mouse.down();
  await first.page.mouse.move(Math.round(boxA.x + boxA.width / 2) + 12, y, { steps: 4 });
  const line = await first.page.locator(".ws-tab-line").count();
  await first.page.mouse.move(Math.round(boxB.x + boxB.width - 8), y, { steps: 8 });
  await first.page.mouse.up();
  await sleep(400);
  ok(line === 0, "旧桥：按住标签横拖不画落点竖线（没绑拖动）");
}
ok(
  MSGS.filter((m) => m.action === "ws.tabs").length === beforeDrag,
  `旧桥：拖标签没发 ws.tabs（${MSGS.filter((m) => m.action === "ws.tabs").length - beforeDrag} 条）`,
);

await second.context.close();
await first.context.close();
await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
