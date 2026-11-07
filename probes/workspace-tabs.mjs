/**
 * Probe: #121 标签行只画 N 个 + `＋N`；#122 固定组落库 + 组头 ⋯ 固定项。
 *
 * 票面要的是：标签行只画 N 颗（N 由桥端下发，默认 3），剩下的组数报在槽外的 `＋N` 上；点 `＋N` 只列
 * 被折叠的组，点一行切过去并关掉下拉；当前组排在组序很后面时它仍然在圈内（挤掉最后一个补位组）。
 * #122 接上：在组头 ⋯ 里固定一个组 → 它排到标签行最前、左栏组头出现「已固定」标记、刷新后还在；
 * 名额满了再点固定 → 那一项置灰并写明原因，不会静默失败。
 * #124 再接上：固定组可以用鼠标拖着换顺序（落点竖线跟手，松手发一条 `ws.tabs`，刷新后还记得）；
 * 补位组拖不动、悬停会说清楚；位移不到 4px 仍算一次点击，拖回原位一个字都不发。
 *
 * 上一票（#119）的断言留着：A 壳顶栏只有一行、标签紧跟在 ◧ 后面、B/C/D 不画标签、800px 不破版。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs` 落到内存里再广播 —— 刷新页面
 * 拿到的就是「重启后的桥」，固定组与名额都在。造 9 个长名组，用显式 `updatedAt` 把组序钉成 01→09
 * （组序 = 待处理 → 最近活动倒序 → 名字），否则同一毫秒里建出来的 9 个组谁在前全凭运气。
 *
 * Run: npm run build:web && PI_WEB_PORT=7931 node probes/workspace-tabs.mjs
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
const SESSIONS = GROUPS.map((g, i) => ({
  ...state(`s-${g.id.slice(-2)}-1`, `工程 ${g.id.slice(-2)} · 会话 1`, g.key, g.id),
  // 组序「最近活动倒序」：01 最新 → 01→09，和名字顺序一致，`＋N` 里点哪一行都能预判。
  updatedAt: Date.UTC(2026, 0, 1) - i * 1000,
}));
const byId = (id) => SESSIONS.find((s) => s.id === id);

// #122：固定组与名额也持久化 —— 存在内存里，刷新页面就像重启后的桥一样把它们拿回来。
const WS = {
  groups: GROUPS,
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
  pinned: [],
  max: 3,
};
const workspace = () => ({ ...WS, groups: WS.groups.map((g) => ({ ...g })), pinned: [...WS.pinned] });
/** 桥收到过的 manage 动作（固定要能核对「发了几条 / 该不发的时候发了没有」）。 */
const CALLS = [];
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
      if (msg.type === "manage") {
        CALLS.push(msg);
        // 真桥的 `setTabs()`：名额 clamp 到 1–12，列表去重 / 剔脏 / 截到名额，最后一次落盘再广播。
        if (msg.action === "ws.tabs") {
          if (msg.max !== undefined) WS.max = Math.min(12, Math.max(1, Math.trunc(Number(msg.max))));
          if (msg.pinned !== undefined) {
            const known = new Set(WS.groups.map((g) => g.id));
            WS.pinned = msg.pinned.filter((id, i, all) => typeof id === "string" && known.has(id) && all.indexOf(id) === i);
          }
          WS.pinned = WS.pinned.slice(0, WS.max);
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(JSON.stringify({ type: "workspaces", workspace: workspace() }));
          }
        }
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
      moreText: document.querySelector(".ws-tabs-more")?.textContent ?? "",
      moreShown: (() => {
        const n = document.querySelector(".ws-tabs-more");
        return Boolean(n && !n.hidden);
      })(),
      // `＋N` 是标签槽的兄弟、不在槽里：槽横滚时它才不跟着跑。
      moreOutside: (() => {
        const m = document.querySelector(".ws-tabs-more");
        const tabs = document.querySelector(".ws-tabs");
        return Boolean(m && tabs && m.parentElement === tabs.parentElement && !tabs.contains(m));
      })(),
      menuRows: document.querySelectorAll(".ws-tabs-menu .pm-item").length,
      visibleIds: [...document.querySelectorAll(".ws-tab")].map((n) => n.dataset.ws ?? ""),
      foldedIds: [...document.querySelectorAll(".ws-tabs-menu .pm-item")].map((n) => n.dataset.ws ?? ""),
      tabsOverflow: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : false,
      tabsScrollbar: tabs ? tabs.offsetHeight - tabs.clientHeight : -1,
      tabsScrollLeft: tabs ? tabs.scrollLeft : -1,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });

async function open(layout, session = "s-01-1") {
  // 布局偏好直接写进 localStorage 再刷新：这里要验的是「按壳摆哪儿」，不是设置面板（#97 验过）。
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${BASE}/#/s/${session}`, { waitUntil: "networkidle" });
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

// 3) #121：只画前 3 组，剩下的收进槽外那颗 ＋N
ok(s.count === 3, `A：标签行只画 3 颗（${s.count} 个）`);
ok(s.moreShown && s.moreText === "＋6", `A：＋N 报剩下的 6 组（${s.moreText || "没出现"}）`);
ok(s.moreOutside, "A：＋N 挂在标签槽外面（槽横滚时它不跟着跑）");
ok(s.onWs === "f:/proj-01", `A：当前组仍然高亮（${s.onWs}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-a.png`), clip: { x: 0, y: 0, width: 1000, height: 140 } });

// 4) #121：点 ＋N 只列被折叠的组，点一行切过去并关掉下拉
await page.click(".ws-tabs-more");
await sleep(200);
s = await barState();
ok(s.menuRows === 6, `＋N 展开只列被折叠的 6 组（${s.menuRows} 行）`);
ok(s.foldedIds.every((id) => !s.visibleIds.includes(id)), "菜单里没有已经在标签行上的组");
ok(new Set(s.foldedIds).size === 6, "菜单里的组不重复、不多不少");
// 两种关法：Esc 与点外面（和胶囊的 more 各关各的，不互相牵连）。
await page.keyboard.press("Escape");
await sleep(150);
s = await barState();
ok(s.menuRows === 0, `Esc 关掉下拉（还剩 ${s.menuRows} 行）`);
ok(s.moreShown, "Esc 只关下拉、＋N 还在");
await page.click(".ws-tabs-more");
await sleep(150);
await page.click(".session-card", { position: { x: 5, y: 5 } });
await sleep(150);
s = await barState();
ok(s.menuRows === 0, `点外面关掉下拉（还剩 ${s.menuRows} 行）`);
await page.click(".ws-tabs-more");
await sleep(150);
s = await barState();
ok(s.menuRows === 6, `再点开还是 6 行（${s.menuRows}）`);
const pick = s.foldedIds[0];
await page.locator(".ws-tabs-menu .pm-item").first().click();
await sleep(600);
s = await barState();
ok(s.onWs === pick, `点折叠组切过去（期望 ${pick}，实际 ${s.onWs}）`);
ok(s.count === 3, `切过去之后标签行仍是 3 颗（${s.count} 个）`);
ok(s.menuRows === 0, `切完下拉关掉（还剩 ${s.menuRows} 行）`);
await page.close();

// 5) #121：当前组排在组序很后面时，它挤掉最后一个补位组进圈（N+1 是 #122 固定组的事）
page = await open(null, "s-09-1");
s = await barState();
ok(s.onWs === "f:/proj-09", `A：组序第 9 的当前组也在标签行上（${s.onWs}）`);
ok(s.count === 3, `A：它挤掉了一个补位组，没多画（${s.count} 颗）`);
ok(s.moreShown && s.moreText === "＋6", `A：被挤掉的那组回到 ＋N（${s.moreText}）`);
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

// 6) 800px 窄屏：A 这一行不破版，标签横向滚得动、又不占滚动条的位置，`＋N` 不跟着跑
page = await open(null);
await page.setViewportSize({ width: 800, height: 820 });
await sleep(600);
s = await barState();
ok(s.inTopbar && s.secondIsRow, "800px：标签仍在顶栏里、仍紧跟在 ◧ 后面");
ok(Boolean(s.bar && s.bar.h <= 60), `800px：顶栏还是一行（${s.bar?.h}px）`);
ok(Boolean(s.tool && s.row && Math.abs(s.tool.cy - s.row.cy) < 14), "800px：标签和工具按钮仍在同一行");
ok(!s.docOverflow, "800px：整页没有横向溢出（没破版）");
ok(s.tabsOverflow, "800px：3 颗长名 + ＋N 还是装不下，标签槽真的溢出");
ok(s.tabsScrollbar === 0, `800px：没有横向滚动条占位（offsetHeight - clientHeight = ${s.tabsScrollbar}）`);
const before = await page.evaluate(() => {
  const box = document.querySelector(".ws-tabs");
  const more = document.querySelector(".ws-tabs-more");
  return { left: more.getBoundingClientRect().left, scroll: box.scrollLeft };
});
const scrolled = await page.evaluate(() => {
  const box = document.querySelector(".ws-tabs");
  box.scrollLeft = 9999;
  return { left: box.scrollLeft, max: box.scrollWidth - box.clientWidth };
});
ok(scrolled.left > 0 && Math.abs(scrolled.left - scrolled.max) <= 1, `800px：标签能横向滚到底（${scrolled.left} / ${scrolled.max}）`);
const after = await page.evaluate(() => {
  const more = document.querySelector(".ws-tabs-more");
  return { left: more.getBoundingClientRect().left };
});
ok(scrolled.left > before.scroll && Math.abs(after.left - before.left) < 1, `800px：槽横滚了 ${scrolled.left}px，＋N 位置一动不动（${before.left} → ${after.left}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-800.png`), clip: { x: 0, y: 0, width: 800, height: 140 } });
await page.close();

// 7) #122 固定：组头 ⋯ →「固定到第一行」→ 它排到标签行最前，左栏组头带「已固定」标记
const openWsMore = async (id) => {
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head`).hover();
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head .ws-more`).click();
  await sleep(250);
};
const fixedItem = () => page.locator(".ws-menu .pm-item[data-act='fixed']");
const fixedText = async () => (await page.locator(".ws-menu .pm-item[data-act='fixed'] .pm-text").textContent())?.trim() ?? "";
const lastTabs = () => CALLS.filter((c) => c.action === "ws.tabs").at(-1) ?? null;
const fixedCount = (id) => page.locator(`.ws-sec[data-ws="${id}"] .ws-head .ws-fixed`).count();
const fixedViaMenu = async (id) => {
  await openWsMore(id);
  await fixedItem().click();
  await sleep(450);
};

page = await open(null);
await openWsMore("f:/proj-09");
ok((await fixedText()) === "固定到第一行", `未固定的组：菜单那行是「固定到第一行」（${await fixedText()}）`);
await fixedItem().click();
await sleep(500);
ok(
  JSON.stringify(lastTabs()?.pinned) === JSON.stringify(["f:/proj-09"]),
  `点固定发出一条 ws.tabs，列表里只有它（${JSON.stringify(lastTabs()?.pinned)}）`,
);
s = await barState();
ok(s.visibleIds[0] === "f:/proj-09", `固定后排到标签行最前（${s.visibleIds.join(" / ")}）`);
ok(s.count === 3 && s.moreText === "＋6", `固定组不占额外位置：仍是 3 颗 + ＋N（${s.count} / ${s.moreText}）`);
ok((await fixedCount("f:/proj-09")) === 1, "左栏组头出现「已固定」标记");
ok((await fixedCount("f:/proj-01")) === 0, "没固定的组不打这个标记");

// 8) 刷新后固定组与顺序还在（桥落库了 —— 桩桥在内存里持久化）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
s = await barState();
ok(s.visibleIds[0] === "f:/proj-09", `刷新后固定组还在最前（${s.visibleIds.join(" / ")}）`);
ok((await fixedCount("f:/proj-09")) === 1, "刷新后「已固定」标记也还在");

// 9) 菜单两项互斥：已固定 →「取消固定」；取消后它排回组序的位置
await openWsMore("f:/proj-09");
ok((await fixedText()) === "取消固定", `已固定的组：菜单那行换成「取消固定」（${await fixedText()}）`);
await fixedItem().click();
await sleep(450);
s = await barState();
ok(JSON.stringify(lastTabs()?.pinned) === "[]", `取消固定发的是空列表（${JSON.stringify(lastTabs()?.pinned)}）`);
ok(s.visibleIds[0] === "f:/proj-01", `取消后排回组序（${s.visibleIds.join(" / ")}）`);
ok((await fixedCount("f:/proj-09")) === 0, "取消后组头标记消失");

// 10) 名额满了再固定：那一项置灰并写明原因，点了也不发请求
for (const id of ["f:/proj-09", "f:/proj-08", "f:/proj-07"]) await fixedViaMenu(id);
s = await barState();
ok(s.count === 4 && s.visibleIds[3] === "f:/proj-01", `固定组占满名额：当前组多画一颗（${s.visibleIds.join(" / ")}）`);
const tabsBefore = CALLS.filter((c) => c.action === "ws.tabs").length;
await openWsMore("f:/proj-06");
ok((await fixedItem().isDisabled()) === true, "名额满了：第 4 个组的「固定」是灰的");
const why = await page.locator(".ws-menu .pm-why").first().textContent();
ok(/3/.test(why ?? ""), `灰掉的原因写清名额（${why?.trim()}）`);
await fixedItem().click({ force: true }).catch(() => {});
await sleep(250);
ok(CALLS.filter((c) => c.action === "ws.tabs").length === tabsBefore, "点灰掉的固定项：没有发 ws.tabs");
await page.keyboard.press("Escape");
await page.close();

// 11) #124 固定组拖拽重排：只有固定组能拖，竖线跟手，松手发一条 ws.tabs，刷新后顺序还在
page = await open(null);
s = await barState();
ok(
  JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-09", "f:/proj-08", "f:/proj-07", "f:/proj-01"]),
  `起点：3 个固定组 + 当前组多画一颗（${s.visibleIds.join(" / ")}）`,
);
const fillTitle = await page.locator('.ws-tab[data-ws="f:/proj-01"]').getAttribute("title");
ok(/拖不动/.test(fillTitle ?? ""), `补位组：悬停写明拖不动（${fillTitle}）`);
const tabsCalls = () => CALLS.filter((c) => c.action === "ws.tabs").length;
/** 拖拽期间的现场：竖线在不在、画在哪、body 上的类还在不在。 */
const dragMark = () =>
  page.evaluate(() => {
    const line = document.querySelector(".ws-tab-line");
    const r = line?.getBoundingClientRect();
    const tab = document.querySelector(".ws-tab")?.getBoundingClientRect();
    return {
      lines: document.querySelectorAll(".ws-tab-line").length,
      left: r ? Math.round(r.left) : -1,
      width: r ? Math.round(r.width) : 0,
      height: r ? Math.round(r.height) : 0,
      tabHeight: Math.round(tab?.height ?? 0),
      body: document.body.classList.contains("ws-tab-dragging"),
      dragging: document.querySelectorAll(".ws-tab.drag").length,
    };
  });
/** 按住 from 的中间横拖到 to 的某一侧：中途量一次、落点量一次、松手后再量一次。 */
const dragTab = async (fromId, toId, side) => {
  const from = await page.locator(`.ws-tab[data-ws="${fromId}"]`).boundingBox();
  const to = await page.locator(`.ws-tab[data-ws="${toId}"]`).boundingBox();
  const y = Math.round(from.y + from.height / 2);
  const x0 = Math.round(from.x + from.width / 2);
  const x1 = Math.round(side === "before" ? to.x + 8 : to.x + to.width - 8);
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x0 + 12, y, { steps: 4 }); // 过 4px 阈值：起拖
  const mid = await dragMark();
  await page.mouse.move(x1, y, { steps: 10 });
  const during = await dragMark();
  await page.mouse.up();
  await sleep(450);
  return { mid, during, after: await dragMark(), toLeft: Math.round(to.x), toRight: Math.round(to.x + to.width) };
};

const calls0 = tabsCalls();
const swap = await dragTab("f:/proj-09", "f:/proj-08", "after");
ok(swap.mid.lines === 1 && swap.during.lines === 1, "拖动时画一条落点竖线");
ok(swap.during.width === 2, `竖线是 2px（${swap.during.width}px）`);
ok(swap.during.height >= swap.during.tabHeight - 14, `竖线跟标签一样高（${swap.during.height}px / 标签 ${swap.during.tabHeight}px）`);
ok(swap.during.left > swap.mid.left, `竖线跟着鼠标走（${swap.mid.left} → ${swap.during.left}）`);
ok(
  Math.abs(swap.during.left - swap.toRight) <= 2,
  `拖到 proj-08 右半：竖线贴在它右缘（${swap.during.left} vs ${swap.toRight}）`,
);
ok(swap.during.body && swap.during.dragging === 1, "拖拽期间 body 带 ws-tab-dragging、被拖那颗标成 .drag");
ok(!swap.after.body && swap.after.dragging === 0 && swap.after.lines === 0, "松手后拖拽类与竖线都清掉");
s = await barState();
ok(
  JSON.stringify(s.visibleIds.slice(0, 3)) === JSON.stringify(["f:/proj-08", "f:/proj-09", "f:/proj-07"]),
  `拖到第二颗右边：两颗对调（${s.visibleIds.join(" / ")}）`,
);
ok(tabsCalls() === calls0 + 1, `松手只发一条 ws.tabs（${tabsCalls() - calls0} 条）`);
ok(JSON.stringify(lastTabs()?.pinned) === JSON.stringify(["f:/proj-08", "f:/proj-09", "f:/proj-07"]), `发出的是新顺序（${JSON.stringify(lastTabs()?.pinned)}）`);
ok(s.onWs === "f:/proj-01", `拖拽的尾巴没误触发切组（当前 ${s.onWs}）`);

// 12) 刷新后顺序还在（桥落库了）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
s = await barState();
ok(
  JSON.stringify(s.visibleIds.slice(0, 3)) === JSON.stringify(["f:/proj-08", "f:/proj-09", "f:/proj-07"]),
  `刷新后顺序还在（${s.visibleIds.join(" / ")}）`,
);

// 13) 补位组拖不动：不画线、不进拖拽态、不发请求、顺序一动不动
const calls1 = tabsCalls();
const fill = await dragTab("f:/proj-01", "f:/proj-08", "before");
ok(fill.mid.lines === 0 && fill.during.lines === 0 && fill.after.lines === 0, "补位组按住拖动：一条竖线都不画");
ok(!fill.during.body && fill.during.dragging === 0, "补位组不进拖拽态（body 无类、标签无 .drag）");
s = await barState();
ok(tabsCalls() === calls1, `补位组拖完：没有发 ws.tabs（${tabsCalls() - calls1} 条）`);
ok(
  JSON.stringify(s.visibleIds.slice(0, 3)) === JSON.stringify(["f:/proj-08", "f:/proj-09", "f:/proj-07"]),
  `补位组拖完：顺序一动不动（${s.visibleIds.join(" / ")}）`,
);

// 14) 拖回原位不发；位移不到 4px 还是一次点击
const calls2 = tabsCalls();
const same = await dragTab("f:/proj-08", "f:/proj-09", "before");
ok(same.during.lines === 1, "拖回原位：竖线照画");
s = await barState();
ok(tabsCalls() === calls2, `拖回原位：顺序没变就不发 ws.tabs（${tabsCalls() - calls2} 条）`);
ok(s.onWs === "f:/proj-01", `拖回原位也没误切组（当前 ${s.onWs}）`);
const calls3 = tabsCalls();
const box9 = await page.locator('.ws-tab[data-ws="f:/proj-09"]').boundingBox();
await page.mouse.move(Math.round(box9.x + box9.width / 2), Math.round(box9.y + box9.height / 2));
await page.mouse.down();
await page.mouse.move(Math.round(box9.x + box9.width / 2) + 3, Math.round(box9.y + box9.height / 2));
await page.mouse.up();
await sleep(500);
s = await barState();
ok(s.onWs === "f:/proj-09", `位移 3px 没到阈值：当成普通点击切组（当前 ${s.onWs}）`);
ok(tabsCalls() === calls3, "那次点击没发 ws.tabs（不是拖拽）");

// 15) D149 只认鼠标：触屏 / 笔的 pointerdown 不进 4px 起拖判定（不画竖线、不发 ws.tabs、也不切组）
const calls4 = tabsCalls();
const before15 = await barState();
const touchBox = await page.locator('.ws-tab[data-ws="f:/proj-08"]').boundingBox();
const tx = Math.round(touchBox.x + touchBox.width / 2);
const ty = Math.round(touchBox.y + touchBox.height / 2);
const pointer = (type, target, x, y, pointerType) =>
  page.evaluate(
    ([type, target, x, y, pointerType]) => {
      const node = target === "tab" ? document.querySelector('.ws-tab[data-ws="f:/proj-08"]') : window;
      node.dispatchEvent(
        new PointerEvent(type, {
          pointerType,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    },
    [type, target, x, y, pointerType],
  );
await pointer("pointerdown", "tab", tx, ty, "touch");
await pointer("pointermove", "window", tx + 80, ty, "touch");
const touch = await dragMark();
ok(touch.lines === 0 && !touch.body && touch.dragging === 0, "触屏按住横拖：一条竖线都不画、不进拖拽态");
await pointer("pointerup", "window", tx + 80, ty, "touch");
await sleep(400);
s = await barState();
ok(s.onWs === before15.onWs, `触屏那一下没切组（当前 ${s.onWs}）`);
ok(tabsCalls() === calls4, `触屏那一下没发 ws.tabs（${tabsCalls() - calls4} 条）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-drag.png`), clip: { x: 0, y: 0, width: 1000, height: 140 } });

// 16) #126：切会话不改标签行的补位序 —— 组序按组名钉死，「最近活动」不再让它换人
await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
await sleep(700);
const baseIds = (await barState()).visibleIds;
ok(baseIds.length >= 3, `切会话前：标签行至少画满 N 颗（${baseIds.join(" / ")}）`);
for (const id of ["s-05-1", "s-09-1", "s-01-1"]) {
  await page.goto(`${BASE}/#/s/${id}`, { waitUntil: "networkidle" });
  await sleep(700);
  const now = (await barState()).visibleIds;
  ok(now.slice(0, 2).join() === baseIds.slice(0, 2).join(), `切到 ${id}：前两颗原地不动（${now.join(" / ")}）`);
  ok(now.length <= 4, `切到 ${id}：圈内最多 N+1 颗（${now.length}）`);
}
await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
await sleep(700);
const backIds = (await barState()).visibleIds;
ok(backIds.join() === baseIds.join(), `切回第一组：标签行完全复原（${backIds.join(" / ")}）`);

await page.close();

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
