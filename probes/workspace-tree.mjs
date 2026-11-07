/**
 * Probe: 左栏两级树（#95）。
 *
 * 桩桥按本机那种数据造：`library` 一个工程 + 它下面几份 worktree、另外两个工程、一个待回答的
 * 会话、一条归档。断言五件事：
 *   1. 出现多个工作区组（不是「置顶 / 会话」两段平铺）；
 *   2. worktree 并回主仓：library 组里有全部 6 条，单独一个 worktree 目录不会自成一组；
 *   3. 组头可收起，收起状态写进 `pi.prefs`（不另开 storage key），刷新后记得；
 *   4. 过滤框打组名 → 整组留下（一组不剩别的组），打会话名才拆组；
 *   5. 归档是末尾的全局分区，不在任何工作区组里。
 *
 * 桩桥只实现页面真正会发的那些消息（hello / subscribe）。`opened` 在 D146 之后只是「回一份快照」，
 * 页面也不再发它；`ws.rename` 之类留给别的票。
 *
 * Run: npm run build:web && node probes/workspace-tree.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.WS_SHOT ?? "workspace-tree";
const PORT = Number(process.env.PI_WEB_PORT ?? 7906);
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

const LIB = { id: "f:/pi-web-client", name: "pi-web-client", key: "F:/pi-web-client", manual: false };
const BLOG = { id: "f:/demo/blog", name: "blog", key: "F:/demo/blog", manual: false };
const TOOLS = { id: "f:/demo/tools", name: "tools", key: "F:/demo/tools", manual: false };
const WORKSPACE = {
  groups: [LIB, BLOG, TOOLS],
  overrides: {},
  keys: {},
  // #173 一份组序（横条与左栏共用）。#177 起组头 ⋯ 能把它改写；初始顺序与旧探针的字母序一致。
  order: [BLOG.id, LIB.id, TOOLS.id],
  // 名额 2（旧桥默认 3）：tools 因此收在 ＋N 里，折叠组也能走「移到最前」。
  max: 2,
};
/** 页面发过来的 manage 消息，用来断言「只发既有的 ws.tabs { order }」。 */
const SENT = [];

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

// library：主仓 + 5 份 worktree，全都在同一个工作区里（#94 已把它们并回主仓）。
const SESSIONS = [
  state("s-main", "主仓：左栏两级树", "F:/pi-web-client", LIB.id),
  state("s-wt1", "worktree 95：票 #95", "F:/pi-web-client-wt/95", LIB.id),
  state("s-wt2", "worktree 96：顶栏色点", "F:/pi-web-client-wt/96", LIB.id),
  state("s-wt3", "worktree 97：布局开关", "F:/pi-web-client-wt/97", LIB.id),
  state("s-wt4", "worktree 98：布局开关二", "F:/pi-web-client-wt/98", LIB.id),
  state("s-wt5", "worktree 99：拖拽", "F:/pi-web-client-wt/99", LIB.id),
  state("s-blog", "写篇博客", "F:/demo/blog", BLOG.id),
  state("s-tools", "整理脚本", "F:/demo/tools", TOOLS.id),
];
// 归档：桥仍然给它 ws，但页面不许把它放进任何组。
const ARCH = state("s-arch", "归档里的旧会话", "F:/demo/blog", BLOG.id);
SESSIONS.push(ARCH);
// 待回答：blog 组头要有角标，并且整组排到最前。
SESSIONS.find((s) => s.id === "s-blog").asks = 1;

const MANAGE = { pin: ["s-tools"], order: ["s-main", "s-wt1"], archived: [ARCH.id] };
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
      if (msg.type === "manage") SENT.push(msg);
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      // D146：打开不改排列。旧页面还会发这条消息，桥只回快照；这里照样实现，免得哪天改回去没覆盖。
      if (msg.type === "manage" && msg.action === "opened") cast({ type: "manage", manage: MANAGE, workspace: WORKSPACE });
      // #177：组头「移到最前」只发既有的 `ws.tabs { order }`。洗法与真桥 readOrder 一致：
      // 去重、剔未知 id、缺的补到末尾；广播一份新快照（真桥也是 broadcast，发送方自己收到）。
      if (msg.type === "manage" && msg.action === "ws.tabs") {
        if (Array.isArray(msg.order)) {
          const known = new Set(WORKSPACE.groups.map((g) => g.id));
          const order = [...new Set(msg.order)].filter((id) => known.has(id));
          for (const g of WORKSPACE.groups) if (!order.includes(g.id)) order.push(g.id);
          WORKSPACE.order = order;
        }
        cast({ type: "workspaces", workspace: WORKSPACE });
        return;
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, workspace: WORKSPACE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

const passGate = async () => {
  await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
    await page.waitForSelector(".session-card, .ws-head", { timeout: 15000 });
  }
};

/** 左栏现在的树：每个组的名字、数量、是否收起、组内卡片 id；外加归档区和 prefs。 */
const tree = () =>
  page.evaluate(() => ({
    groups: [...document.querySelectorAll(".ws-sec")].map((sec) => ({
      id: sec.dataset.ws ?? "",
      name: sec.querySelector(".ws-head .label")?.textContent ?? "",
      count: sec.querySelector(".ws-head .n")?.textContent ?? "",
      todo: sec.querySelector(".ws-head .todo")?.textContent?.trim() ?? null,
      folded: sec.querySelector(".ws-head")?.classList.contains("folded") === true,
      cardsVisible: [...sec.querySelectorAll(".session-card")].filter((c) => c.offsetParent !== null).map((c) => c.dataset.id),
      cardsAll: [...sec.querySelectorAll(".session-card")].map((c) => c.dataset.id),
      empty: sec.querySelector(".ws-empty")?.textContent?.trim() ?? null,
    })),
    archived: {
      present: Boolean(document.querySelector('.session-sec[data-sec="archived"]')),
      count: document.querySelector('.session-sec[data-sec="archived"] .sess-head .n')?.textContent ?? null,
    },
    prefs: (() => {
      try {
        return JSON.parse(localStorage.getItem("pi.prefs") ?? "{}") ?? {};
      } catch {
        return {};
      }
    })(),
  }));

/** 横条现在画了哪几颗、＋N 收了几颗（#173 起横条与左栏共用同一份 order）。 */
const tabs = () =>
  page.evaluate(() => ({
    visible: [...document.querySelectorAll(".ws-tabs .ws-tab")].map((t) => t.dataset.ws ?? ""),
    more: document.querySelector(".ws-tabs-more")?.textContent?.trim() ?? "",
    moreHidden: document.querySelector(".ws-tabs-more")?.hidden ?? null,
  }));

/** 组头 ⋯ 菜单里的每一项：动作、文字、是否置灰、置灰理由（title）+ 菜单底部的灰字理由行。 */
const menu = () =>
  page.evaluate(() => {
    const box = document.querySelector(".ws-menu");
    if (!box) return null;
    return {
      items: [...box.querySelectorAll(".pm-item")].map((btn) => ({
        act: btn.dataset.act ?? "",
        text: btn.textContent?.trim() ?? "",
        disabled: btn.disabled,
        title: btn.title,
      })),
      reasons: [...box.querySelectorAll(".pm-why")].map((n) => n.textContent?.trim() ?? ""),
    };
  });

/** 点组头的 ⋯ 并把菜单内容读回来。`.ws-more` 默认 visibility:hidden，先把鼠标悬到组头上（真用户也是这么点的）。 */
const openMenu = async (wsId) => {
  await page.locator(`.ws-sec[data-ws="${wsId}"] .ws-head`).hover();
  await page.locator(`.ws-sec[data-ws="${wsId}"] .ws-more`).click();
  await sleep(150);
  return menu();
};

/** 页面发过的 `ws.tabs` 消息（从第 `from` 条起）。 */
const tabWrites = (from = 0) => SENT.filter((m) => m.type === "manage" && m.action === "ws.tabs").slice(from);

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await passGate();
await sleep(500);

let t = await tree();
ok(t.groups.length === 3, `左栏出现 ${t.groups.length} 个工作区组（library / blog / tools）`);
ok(
  t.groups.some((g) => g.name === "pi-web-client") && t.groups.some((g) => g.name === "blog") && t.groups.some((g) => g.name === "tools"),
  `组头按工程名分：${t.groups.map((g) => g.name).join(" / ")}`,
);
const lib = t.groups.find((g) => g.name === "pi-web-client");
ok(lib?.cardsAll.length === 6, `worktree 并回主仓：library 组里 ${lib?.cardsAll.length} 条（主仓 + 5 份 worktree）`);
ok(lib?.count === "6", `组头数量显示 ${lib?.count}`);
ok(t.groups[0]?.name === "blog" && t.groups[0]?.todo === "待 1", `有待回答的组排最前并带角标（${t.groups[0]?.name} ${t.groups[0]?.todo}）`);
ok(t.archived.present && t.archived.count === "1", `归档是独立分区，计数 ${t.archived.count}`);
ok(
  t.groups.every((g) => !g.cardsAll.includes("s-arch")),
  "归档会话不在任何工作区组里",
);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-open.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });

// 2) 收起 library → 卡片藏起来，状态写进 pi.prefs
await page.locator(`.ws-sec[data-ws="${LIB.id}"] .ws-head`).click();
await sleep(300);
t = await tree();
const libFolded = t.groups.find((g) => g.name === "pi-web-client");
ok(libFolded?.folded === true, "点组头后 library 收起（组头带 folded）");
ok(libFolded?.cardsVisible.length === 0, "收起后组内卡片不可见");
const otherGroup = t.groups.find((g) => g.name === "blog");
ok(otherGroup?.cardsVisible.length === 1, "别的组不受影响（blog 仍展开）");
ok(Array.isArray(t.prefs.wsCollapsed) && t.prefs.wsCollapsed.includes(LIB.id), `收起状态记进 pi.prefs.wsCollapsed（${JSON.stringify(t.prefs.wsCollapsed)}）`);
const keys = await page.evaluate(() => Object.keys(localStorage));
ok(keys.filter((k) => /ws|work/i.test(k)).length === 0, `没有为工作区另开 storage key（现有 ${keys.join(", ")}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-folded.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });

// 3) 刷新 → 记得收起
await page.reload({ waitUntil: "networkidle" });
await passGate();
await sleep(500);
t = await tree();
ok(t.groups.find((g) => g.name === "pi-web-client")?.folded === true, "刷新后 library 仍是收起的");
ok(t.groups.find((g) => g.name === "blog")?.folded === false, "刷新后 blog 仍是展开的");

// 4) 过滤：打组名 → 整组留下（连收起的也算），别的组走开
await page.fill(".session-filter", "library");
await sleep(300);
t = await tree();
ok(t.groups.length === 0, "打 library：没有组名里含 library 的组，树空掉（不显示空组头）");
await page.fill(".session-filter", "pi-web-client");
await sleep(300);
t = await tree();
ok(t.groups.length === 1 && t.groups[0].name === "pi-web-client", `打组名 pi-web-client：只留这一组（${t.groups.map((g) => g.name).join(" / ")}）`);
ok(t.groups[0]?.cardsAll.length === 6, "整组留下：6 条一条不少");
ok(!t.groups[0]?.empty, "有内容的组不显示空态");
await page.fill(".session-filter", "worktree 99");
await sleep(300);
t = await tree();
ok(t.groups.length === 1 && t.groups[0].cardsAll.length === 1, `打会话名：组还在、只留命中的 1 条（${t.groups[0]?.cardsAll.length}）`);

// 5) 清空过滤 → 树回来，再展开 library
await page.fill(".session-filter", "");
await sleep(300);
await page.locator(`.ws-sec[data-ws="${LIB.id}"] .ws-head`).click();
await sleep(300);
t = await tree();
ok(t.groups.find((g) => g.name === "pi-web-client")?.cardsVisible.length === 6, "清空过滤并展开后 library 的 6 条都在");
ok(t.prefs.wsCollapsed.length === 0, "再点一次把收起状态也清掉了");

// 6) #177 组头 ⋯「移到最前」：折叠组（tools 在 ＋N 里）也能用，菜单顺序是改名 / 移到最前 / 删除。
let tab = await tabs();
ok(
  tab.visible.join() === [BLOG.id, LIB.id].join() && tab.more === "＋1",
  `横条按 order 前 2 颗、tools 收在 ＋1 里（${tab.visible.join(" / ")} ${tab.more}）`,
);
let m = await openMenu(TOOLS.id);
ok(
  m?.items.map((i) => i.act).join() === "rename,front,drop",
  `菜单项依次是改名 / 移到最前 / 删除（${m?.items.map((i) => i.act).join(" / ")}）`,
);
ok(m?.items.find((i) => i.act === "front")?.disabled === false, "折叠组的「移到最前」可点（入口在左栏组头，不依赖横条 DOM）");
ok(
  m?.items.find((i) => i.act === "drop")?.disabled === true && (m?.reasons ?? []).some((r) => r.includes("跟着目录走")),
  "删除仍按原规则置灰并写明原因（派生组）",
);

// 键盘：Tab 得到这颗菜单项（role=menuitem 的 button），Enter 触发。
await page.locator('.ws-menu .pm-item[data-act="front"]').focus();
await page.keyboard.press("Enter");
await sleep(300);
let writes = tabWrites();
ok(
  writes.length === 1 && writes[0].order.join() === [TOOLS.id, BLOG.id, LIB.id].join() && !("max" in writes[0]),
  `键盘 Enter 只发一条既有的 ws.tabs { order }（${JSON.stringify(writes[0]?.order)}）`,
);
tab = await tabs();
t = await tree();
ok(tab.visible[0] === TOOLS.id, `横条立刻把 tools 排到第一（${tab.visible.join(" / ")}）`);
ok(
  t.groups.map((g) => g.id).join() === [TOOLS.id, BLOG.id, LIB.id].join(),
  `左栏组序同步（${t.groups.map((g) => g.name).join(" / ")}）`,
);

// 7) 刷新 → 仍是 tools 第一（桩桥已经把 order 存下）；已是第一时置灰并写原因。
await page.reload({ waitUntil: "networkidle" });
await passGate();
await sleep(500);
tab = await tabs();
t = await tree();
ok(tab.visible[0] === TOOLS.id && t.groups[0]?.id === TOOLS.id, "刷新后 tools 仍在第一（横条与左栏一起）");
m = await openMenu(TOOLS.id);
ok(m?.items.find((i) => i.act === "front")?.disabled === true, "已经在最前：「移到最前」置灰");
ok((m?.reasons ?? []).some((r) => r.includes("已经是第一个")), `置灰理由写在菜单里（${m?.reasons.join(" / ")}）`);
await page.keyboard.press("Escape");
await sleep(150);
ok((await menu()) === null, "Esc 关掉菜单");

// 8) 鼠标点它也一样生效（blog 现在排第二）。
m = await openMenu(BLOG.id);
await page.locator('.ws-menu .pm-item[data-act="front"]').click();
await sleep(300);
writes = tabWrites(1);
tab = await tabs();
t = await tree();
ok(
  writes.length === 1 && writes[0].order.join() === [BLOG.id, TOOLS.id, LIB.id].join(),
  `点击也只发一条 ws.tabs { order }（${JSON.stringify(writes[0]?.order)}）`,
);
ok(tab.visible.join() === [BLOG.id, TOOLS.id].join() && t.groups[0]?.id === BLOG.id, "点击「移到最前」也把 blog 排到第一");

// 9) 改名项行为不变：点它仍是组头行内改名，Esc 退出。
m = await openMenu(LIB.id);
ok(m?.items.find((i) => i.act === "rename")?.disabled === false, "改名项仍可点");
await page.locator('.ws-menu .pm-item[data-act="rename"]').click();
await sleep(200);
ok((await page.locator(`.ws-sec[data-ws="${LIB.id}"] .ws-rename-input`).count()) === 1, "点改名 → 组头变行内输入框（和以前一样）");
await page.keyboard.press("Escape");
await sleep(200);
ok((await page.locator(".ws-rename-input").count()) === 0, "Esc 退出改名，组头恢复");

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
