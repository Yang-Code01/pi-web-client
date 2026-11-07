/**
 * Probe: #121 标签行只画 N 个 + `＋N`；#173 一份 `order` 接管顺序；#174 横条上每一颗都能拖。
 *
 * 票面要的是：标签行只画 N 颗（N 由桥端下发，默认 6、范围 1–12），剩下的组数报在槽外的 `＋N` 上；
 * 点 `＋N` 只列被折叠的组，点一行切过去并关掉下拉；当前组排在组序很后面时它仍然在圈内（占最后一格）。
 * #173 接上：组头 ⋯ 里只剩重命名 / 移到最前 / 删除（#177 加的第二项），左栏不再有额外徽记，
 * 标签行与左栏共用一份 `order`。
 * #174 再接上：**每一颗看得见的标签**都能用鼠标拖着换顺序，落点竖线跟手，松手
 * 只发一条 `ws.tabs { order, max }` 把整份 order 写回，刷新后还记得；位移不到 4px 仍算一次点击，
 * 拖回原位一个字都不发，拖完不误切组；`＋N` 里的折叠组没有 DOM，拖不起来。
 * #175 再接上：标签行末尾、`＋N` 左边多一颗「＋」—— 点一下就是树底的「新建工作区」（同一个
 * `ws.create`）：左栏多一个空组并就地改名；左栏收着时先展开，名字才看得见。名额满了照样能建，
 * 新组按规则追加到 `order` 末尾、收进 `＋N`，页面用一条小提示说明它去哪了。
 *
 * 上一票（#119）的断言留着：A 壳顶栏只有一行、标签紧跟在 ◧ 后面、B/C/D 不画标签、800px 不破版。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs`（名额 / 顺序）与 `ws.create`
 * （造空的手动组、追加到 order 末尾）落到内存里再广播 —— 刷新页面拿到的就是「重启后的桥」。
 * 造 9 个长名组，用显式 `updatedAt` 把组序钉成 01→09（组序 = 待处理 → 最近活动倒序 → 名字），
 * 否则同一毫秒里建出来的 9 个组谁在前全凭运气。
 *
 * Run: npm run build:web && PI_WEB_PORT=7931 node probes/workspace-tabs.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

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

// #173：一份 order 与名额也持久化 —— 存在内存里，刷新页面就像重启后的桥一样把它们拿回来。
// 起点就是名字顺序 01→09（#174 的拖动段与 #175 的 ＋ 段都以它为基准）；`ws.create` 往末尾追加。
let createdGroups = 0;
const WS = {
  groups: [...GROUPS],
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
  order: GROUPS.map((g) => g.id),
  max: 3,
};
const workspace = () => ({ ...WS, groups: WS.groups.map((g) => ({ ...g })), order: [...WS.order] });
/** 桥广播一份完整快照（真桥每次写盘后都这么干）。 */
const cast = () => {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(JSON.stringify({ type: "workspaces", workspace: workspace() }));
  }
};
/** 桥收到过的 manage 动作（顺序要能核对「发了几条 / 该不发的时候发了没有」）。 */
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
        // 真桥的 `setTabs()`：名额 clamp 到 1–12（#176），order 去重 / 剔脏（不按名额截断），最后广播。
        if (msg.action === "ws.tabs") {
          if (msg.max !== undefined) {
            const m = Number(msg.max);
            if (Number.isInteger(m) && m >= 1 && m <= 12) WS.max = m;
          }
          if (msg.order !== undefined) {
            const known = new Set(WS.groups.map((g) => g.id));
            WS.order = msg.order.filter((id, i, all) => typeof id === "string" && known.has(id) && all.indexOf(id) === i);
          }
          cast();
        }
        // 真桥的 `workspaces.create()`：造一个空名的手动组，追加到 order 末尾。
        if (msg.action === "ws.create") {
          createdGroups += 1;
          const id = `manual:stub${createdGroups}`;
          WS.groups.push({ id, name: String(msg.name ?? ""), key: "", manual: true });
          WS.order = [...WS.order, id];
          cast();
        }
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
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

// 5) #121：当前组排在组序很后面时，它占住最后一格（#173 起「当前组临时替最后一格」）
page = await open(null, "s-09-1");
s = await barState();
ok(s.onWs === "f:/proj-09", `A：组序第 9 的当前组也在标签行上（${s.onWs}）`);
ok(s.count === 3, `A：它只占最后一格、没多画（${s.count} 颗）`);
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
  const addShown = await page.evaluate(() => {
    const add = document.querySelector(".ws-tabs-add");
    return Boolean(add && !add.hidden && add.getClientRects().length > 0);
  });
  ok(!addShown, `${id.toUpperCase()}：横条那颗 ＋ 也不出现（#175 只属于 A）`);
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
const addBox = await page.evaluate(() => {
  const add = document.querySelector(".ws-tabs-add");
  const more = document.querySelector(".ws-tabs-more");
  return { add: add ? Math.round(add.getBoundingClientRect().left) : -1, more: more ? Math.round(more.getBoundingClientRect().left) : -1 };
});
ok(addBox.add > 0 && addBox.add < addBox.more, `800px：＋ 还在 ＋N 左边、没被槽带走（${addBox.add} < ${addBox.more}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-800.png`), clip: { x: 0, y: 0, width: 800, height: 140 } });
await page.close();

// 7) #173 组头菜单：只剩重命名 / 移到最前 / 删除，左栏没有额外徽记
page = await open(null);
const openWsMore = async (id) => {
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head`).hover();
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head .ws-more`).click();
  await sleep(250);
};
const treeOrder = () => page.evaluate(() => [...document.querySelectorAll(".ws-sec")].map((n) => n.dataset.ws ?? ""));
const lastTabs = () => CALLS.filter((c) => c.action === "ws.tabs").at(-1) ?? null;
const tabsCalls = () => CALLS.filter((c) => c.action === "ws.tabs").length;
await openWsMore("f:/proj-09");
const menu = await page.evaluate(() => ({
  acts: [...document.querySelectorAll(".ws-menu .pm-item")].map((n) => n.dataset.act ?? ""),
  text: document.querySelector(".ws-menu")?.textContent ?? "",
  fixed: document.querySelectorAll(".ws-fixed").length,
}));
ok(JSON.stringify(menu.acts) === JSON.stringify(["rename", "front", "drop"]), `组头 ⋯ 只剩重命名 / 移到最前 / 删除（${menu.acts.join(" / ")}）`);
ok(!/固定/.test(menu.text), `菜单里没有固定入口（${menu.text.replace(/\s+/g, " ").trim()}）`);
ok(menu.fixed === 0, `左栏没有「已固定」徽记（${menu.fixed} 个）`);
await page.keyboard.press("Escape");
await sleep(150);
s = await barState();
const treeIds = await treeOrder();
ok(JSON.stringify(treeIds) === JSON.stringify(WS.order), `左栏组序就是那份 order（${treeIds.slice(0, 3).join(" / ")} …）`);
ok(JSON.stringify(s.visibleIds) === JSON.stringify(WS.order.slice(0, 3)), `标签行是 order 的前 3 颗（${s.visibleIds.join(" / ")}）`);

// 8) #174 任意标签可拖：竖线跟手，松手发一条 ws.tabs（整份 order），拖完不误切组
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
/**
 * 按住 from 的中间横拖到 to 的某一侧：中途量一次、落点量一次、松手后再量一次。
 * 坐标夹在标签槽的可见区里 —— 槽是 `overflow-x: auto`，#121 的名额只保证「画出来」不保证「整个露出来」，
 * 靠后的标签有一截压在 `＋N` 底下（那里 elementFromPoint 摸到的是 ＋N）。人手也是抓露出来的那半截。
 */
const dragTab = async (fromId, toId, side) => {
  const strip = await page.locator(".ws-tabs").boundingBox();
  const from = await page.locator(`.ws-tab[data-ws="${fromId}"]`).boundingBox();
  const to = await page.locator(`.ws-tab[data-ws="${toId}"]`).boundingBox();
  const lo = strip.x + 6;
  const hi = strip.x + strip.width - 6;
  const y = Math.round(from.y + from.height / 2);
  const x0 = Math.round(Math.max(lo, Math.min(hi - 16, from.x + from.width / 2)));
  const x1 = Math.round(side === "before" ? Math.min(hi, Math.max(lo, to.x + 8)) : Math.min(hi, Math.max(lo, to.x + to.width - 8)));
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

const ORDER0 = [
  "f:/proj-01",
  "f:/proj-02",
  "f:/proj-03",
  "f:/proj-04",
  "f:/proj-05",
  "f:/proj-06",
  "f:/proj-07",
  "f:/proj-08",
  "f:/proj-09",
];
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(ORDER0.slice(0, 3)), `起点：组序前三颗（${s.visibleIds.join(" / ")}）`);
// 窗口先放宽到 1400：#121 只保证名额内的标签「画出来」，1000px 下第 3 颗有一截压在 ＋N 底下，
// #175 又让 ＋ 占了横条右侧一小段 —— 想按住每一颗的中间拖，就得先让三颗整个露出来。
await page.setViewportSize({ width: 1400, height: 820 });
await sleep(300);
const calls0 = tabsCalls();
// 拖的是第 3 颗 —— #174 起可见段里任意一颗都能拖。
const swap = await dragTab("f:/proj-03", "f:/proj-01", "before");
ok(swap.mid.lines === 1 && swap.during.lines === 1, "拖动时画一条落点竖线");
ok(swap.during.width === 2, `竖线是 2px（${swap.during.width}px）`);
ok(swap.during.height >= swap.during.tabHeight - 14, `竖线跟标签一样高（${swap.during.height}px / 标签 ${swap.during.tabHeight}px）`);
ok(swap.during.left < swap.mid.left, `竖线跟着鼠标走（${swap.mid.left} → ${swap.during.left}）`);
ok(Math.abs(swap.during.left - swap.toLeft) <= 2, `拖到 proj-01 左半：竖线贴在它左缘（${swap.during.left} vs ${swap.toLeft}）`);
ok(swap.during.body && swap.during.dragging === 1, "拖拽期间 body 带 ws-tab-dragging、被拖那颗标成 .drag");
ok(!swap.after.body && swap.after.dragging === 0 && swap.after.lines === 0, "松手后拖拽类与竖线都清掉");
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-03", "f:/proj-01", "f:/proj-02"]), `拖到第一颗左边：它排到最前（${s.visibleIds.join(" / ")}）`);
ok(s.count === 3 && s.moreText === "＋6", `拖完仍是 3 颗 + ＋N（${s.count} / ${s.moreText}）`);
ok(tabsCalls() === calls0 + 1, `松手只发一条 ws.tabs（${tabsCalls() - calls0} 条）`);
const ORDER1 = ["f:/proj-03", "f:/proj-01", "f:/proj-02", ...ORDER0.slice(3)];
ok(JSON.stringify(lastTabs()?.order) === JSON.stringify(ORDER1), `写回的是整份 order（含折叠组，${lastTabs()?.order?.length} 个）`);
ok(lastTabs()?.max === undefined, `拖拽只交顺序、不带上名额（max ${lastTabs()?.max}）`);
ok(s.onWs === "f:/proj-01", `拖拽的尾巴没误触发切组（当前 ${s.onWs}）`);
// 可聚焦元素没变多：标签仍是原来那几颗 button，另一颗是 ＋N，再加上 #175 的 ＋。
const focus = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll(".ws-tabs-row button")].map((n) => (n.className || "").trim()),
  extra: document.querySelectorAll(".ws-tabs-row [tabindex]:not(button)").length,
}));
ok(
  focus.buttons.length === 5 && focus.buttons.every((c) => c === "ws-tabs-more" || c === "ws-tabs-add" || /^ws-tab(\s|$)/.test(c)),
  `拖拽没有多出可聚焦元素（${focus.buttons.join(" / ")}，额外 ${focus.extra} 个）`,
);

// 9) 刷新后顺序还在（桥落库了 —— 桩桥在内存里持久化整份 order）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-03", "f:/proj-01", "f:/proj-02"]), `刷新后顺序还在（${s.visibleIds.join(" / ")}）`);
ok(s.moreText === "＋6", `刷新后 ＋N 也没变（${s.moreText}）`);

// 10) 拖回原位一个字都不发；位移不到 4px 还是一次点击；拖完点击照常切组
const calls1 = tabsCalls();
const same = await dragTab("f:/proj-01", "f:/proj-02", "before");
ok(same.during.lines === 1, "拖回原位：竖线照画");
s = await barState();
ok(tabsCalls() === calls1, `拖回原位：顺序没变就不发 ws.tabs（${tabsCalls() - calls1} 条）`);
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-03", "f:/proj-01", "f:/proj-02"]), `拖回原位：标签行一动不动（${s.visibleIds.join(" / ")}）`);
const calls2 = tabsCalls();
// 3px 那次点击打在完全露出来的第一颗上（靠后的标签有一截压在 ＋N 底下）。
const box3 = await page.locator('.ws-tab[data-ws="f:/proj-03"]').boundingBox();
await page.mouse.move(Math.round(box3.x + box3.width / 2), Math.round(box3.y + box3.height / 2));
await page.mouse.down();
await page.mouse.move(Math.round(box3.x + box3.width / 2) + 3, Math.round(box3.y + box3.height / 2));
await page.mouse.up();
await sleep(600);
s = await barState();
ok(s.onWs === "f:/proj-03", `位移 3px 没到阈值：当成普通点击切组（当前 ${s.onWs}）`);
ok(tabsCalls() === calls2, "那次点击没发 ws.tabs（不是拖拽）");
await page.locator('.ws-tab[data-ws="f:/proj-01"]').click();
await sleep(600);
s = await barState();
ok(s.onWs === "f:/proj-01", `拖过之后再点标签，点击语义照常（当前 ${s.onWs}）`);

// 11) ＋N 里的折叠组没有 DOM：从那一行起拖也不发消息、不改顺序
const calls3 = tabsCalls();
const orderBefore = JSON.stringify((await barState()).visibleIds);
const before13id = (await barState()).onWs;
const folded = await page.evaluate(() => ({
  rows: [...document.querySelectorAll(".ws-tabs-menu .pm-item")].map((n) => n.dataset.ws ?? ""),
  inRow: document.querySelectorAll(".ws-tab-line").length,
}));
await page.click(".ws-tabs-more");
await sleep(200);
const rowBox = await page.locator(".ws-tabs-menu .pm-item").first().boundingBox();
const tab1 = await page.locator(".ws-tab").first().boundingBox();
await page.mouse.move(Math.round(rowBox.x + rowBox.width / 2), Math.round(rowBox.y + rowBox.height / 2));
await page.mouse.down();
await page.mouse.move(Math.round(tab1.x + 8), Math.round(tab1.y + tab1.height / 2), { steps: 8 });
await page.mouse.up();
await sleep(400);
s = await barState();
ok(tabsCalls() === calls3, `从 ＋N 那一行起拖：没发 ws.tabs（${tabsCalls() - calls3} 条）`);
ok(JSON.stringify(s.visibleIds) === orderBefore, `顺序没动（${s.visibleIds.join(" / ")}）`);
ok(folded.inRow === 0 && s.foldedIds.length === 6, "折叠组在横条上没有第二份 DOM（只有 ＋N 里那 6 行）");
ok(s.menuRows === 6 && s.onWs === before13id, `下拉照开、也没顺手切组（剩 ${s.menuRows} 行 / 当前 ${s.onWs}）`);
await page.keyboard.press("Escape");
await sleep(150);

// 12) 当前组临时替最后一格：它也能拖，拖完就变成顺序里的一员，横条不涨颗
// 窗口放宽到 1400：#121 只保证名额内的标签「画出来」，1000px 下第 3 颗有一截压在 ＋N 底下，
// 想拖到「最右端」就得先把三颗整个露出来。
await page.setViewportSize({ width: 1400, height: 820 });
await sleep(300);
await page.goto(`${BASE}/#/s/s-06-1`, { waitUntil: "networkidle" });
await sleep(700);
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-03", "f:/proj-01", "f:/proj-06"]), `当前组（组序第 6）替最后一格（${s.visibleIds.join(" / ")}）`);
const calls4 = tabsCalls();
const sub = await dragTab("f:/proj-06", "f:/proj-03", "before");
ok(sub.during.lines === 1, "替位组拖起来也画线");
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-06", "f:/proj-03", "f:/proj-01"]), `替位组拖到最前：它成了第一颗（${s.visibleIds.join(" / ")}）`);
ok(s.count === 3 && s.moreText === "＋6", `替位组拖完横条不涨颗（${s.count} / ${s.moreText}）`);
const ORDER2 = ["f:/proj-06", "f:/proj-03", "f:/proj-01", "f:/proj-02", "f:/proj-04", "f:/proj-05", "f:/proj-07", "f:/proj-08", "f:/proj-09"];
ok(JSON.stringify(lastTabs()?.order) === JSON.stringify(ORDER2), `替位组也写回整份 order（${lastTabs()?.order?.length} 个）`);
ok(tabsCalls() === calls4 + 1, `替位组拖完只发一条 ws.tabs（${tabsCalls() - calls4} 条）`);
// 拖到最右端 = 排在可见段最后（落点夹在画出来的标签里，折叠组不会被拽进来）
const right = await dragTab("f:/proj-06", "f:/proj-01", "after");
ok(right.during.lines === 1, "拖到最右端：竖线照画");
s = await barState();
ok(s.visibleIds[2] === "f:/proj-06", `拖到最右端：它排在可见段最后（${s.visibleIds.join(" / ")}）`);
ok(s.count === 3 && s.moreText === "＋6", `拖到最右端也没把折叠组拽进前 3（${s.count} / ${s.moreText}）`);
const calls5 = tabsCalls();
const parked = await dragTab("f:/proj-06", "f:/proj-01", "after");
ok(parked.during.lines === 1, "替位组拖回自己那一格：竖线照画");
ok(tabsCalls() === calls5, `替位组原地松手也不发 ws.tabs（${tabsCalls() - calls5} 条）`);

// 13) D149 只认鼠标：触屏 / 笔的 pointerdown 不进 4px 起拖判定（不画竖线、不发 ws.tabs、也不切组）
const calls6 = tabsCalls();
const before13 = await barState();
const target = before13.visibleIds[1];
const touchBox = await page.locator(`.ws-tab[data-ws="${target}"]`).boundingBox();
const tx = Math.round(touchBox.x + touchBox.width / 2);
const ty = Math.round(touchBox.y + touchBox.height / 2);
const pointer = (type, where, x, y, pointerType) =>
  page.evaluate(
    ([type, where, x, y, pointerType]) => {
      const node = where === "tab" ? document.querySelector(".ws-tab") : window;
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
    [type, where, x, y, pointerType],
  );
for (const kind of ["touch", "pen"]) {
  await pointer("pointerdown", "tab", tx, ty, kind);
  await pointer("pointermove", "window", tx + 80, ty, kind);
  const st = await dragMark();
  ok(st.lines === 0 && !st.body && st.dragging === 0, `${kind} 按住横拖：一条竖线都不画、不进拖拽态`);
  await pointer("pointerup", "window", tx + 80, ty, kind);
  await sleep(350);
}
s = await barState();
ok(s.onWs === before13.onWs, `触屏 / 笔那两下没切组（当前 ${s.onWs}）`);
ok(tabsCalls() === calls6, `触屏 / 笔那两下没发 ws.tabs（${tabsCalls() - calls6} 条）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-drag.png`), clip: { x: 0, y: 0, width: 1000, height: 140 } });

// 14) #126 / #173：切会话不改标签行的顺序 —— 一份 order 说了算，「最近活动」不再让它换人
await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
await sleep(700);
const baseIds = (await barState()).visibleIds;
ok(baseIds.length === 3, `切会话前：标签行画满 N 颗（${baseIds.join(" / ")}）`);
for (const id of ["s-05-1", "s-09-1", "s-01-1"]) {
  await page.goto(`${BASE}/#/s/${id}`, { waitUntil: "networkidle" });
  await sleep(700);
  const now = (await barState()).visibleIds;
  ok(now.slice(0, 2).join() === baseIds.slice(0, 2).join(), `切到 ${id}：前两颗原地不动（${now.join(" / ")}）`);
  ok(now.length === 3, `切到 ${id}：圈内仍是 N 颗（${now.length}）`);
}
await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
await sleep(700);
const backIds = (await barState()).visibleIds;
ok(backIds.join() === baseIds.join(), `切回第一组：标签行完全复原（${backIds.join(" / ")}）`);

await page.close();

// 15) #175：横条末尾那颗 ＋（在 ＋N 左边、槽外面）—— 点一下就是树底的「新建工作区」
const addState = () =>
  page.evaluate(() => {
    const row = document.querySelector(".ws-tabs-row");
    const tabs = document.querySelector(".ws-tabs");
    const add = document.querySelector(".ws-tabs-row .ws-tabs-add");
    const more = document.querySelector(".ws-tabs-more");
    const r = add?.getBoundingClientRect();
    const mr = more?.getBoundingClientRect();
    const field = document.querySelector(".ws-sec .ws-rename-input");
    return {
      inRow: Boolean(add && row && add.parentElement === row),
      outsideSlot: Boolean(add && tabs && !tabs.contains(add)),
      between: Boolean(add && tabs && more && tabs.nextElementSibling === add && add.nextElementSibling === more),
      shown: Boolean(add && !add.hidden && add.getClientRects().length > 0),
      text: add?.textContent?.trim() ?? "",
      title: add?.title ?? "",
      left: r ? Math.round(r.left) : -1,
      moreLeft: mr ? Math.round(mr.left) : -1,
      moreText: more?.textContent ?? "",
      groups: document.querySelectorAll(".ws-sec").length,
      editing: Boolean(field),
      placeholder: field?.placeholder ?? "",
      focused: Boolean(field && document.activeElement === field),
      noLeft: document.querySelector(".app .main")?.classList.contains("no-left") ?? false,
      toast: document.querySelector(".fail-toast")?.textContent ?? "",
    };
  });
const createCalls = () => CALLS.filter((c) => c.action === "ws.create").length;

page = await open(null);
await sleep(500);
let a = await addState();
ok(a.shown && a.text === "＋", `A：横条末尾有 ＋（${a.text || "没有"}）`);
ok(a.title === "新建工作区", `A：悬停说明是「${a.title}」`);
ok(a.inRow && a.outsideSlot && a.between, "A：＋ 挂在横条里、标签槽外面、紧贴在 ＋N 左边");
ok(a.left > 0 && a.left < a.moreLeft, `A：＋ 在 ＋N 左边（${a.left} < ${a.moreLeft}）`);
ok(!a.editing, "点之前树里没有正在改名的组");

// 16) 点名：新组按 #173 规则追加到 order 末尾；名额满了就收进 ＋N，并且说一声
const orderBeforeCreate = [...WS.order];
const creates0 = createCalls();
const tabs0 = tabsCalls();
await page.click(".ws-tabs-add");
await sleep(700);
ok(createCalls() === creates0 + 1, `点 ＋ 发一条 ws.create（${createCalls() - creates0} 条）`);
const createMsg = CALLS.filter((c) => c.action === "ws.create").at(-1);
ok(createMsg?.name === "", `发的是空名（"${createMsg?.name ?? "缺"}"）—— 名字留给改名行`);
a = await addState();
ok(a.groups === 10, `左栏多了一个组（${a.groups}）`);
ok(a.editing && a.placeholder === "新工作区", `新组直接在原地改名：「${a.placeholder}」`);
ok(a.focused, "改名行拿到焦点（直接打字就是名字）");
ok(tabsCalls() === tabs0, "点 ＋ 没有顺手改 order（没发 ws.tabs）");
const born = WS.order.at(-1);
ok(WS.order.length === orderBeforeCreate.length + 1 && !orderBeforeCreate.includes(born ?? ""), `新组追加到 order 末尾（${born}）`);
ok(a.moreText === "＋7", `名额满了：新组收在 ＋N 里（${a.moreText}）`);
ok(/已新建，收在 ＋7 里/.test(a.toast), `并且用提示说清它去哪了（${a.toast.trim() || "没提示"}）`);

// 17) Esc 取消改名：空组留着，名字回落成「新工作区」，顺序仍是末尾
await page.keyboard.press("Escape");
await sleep(350);
a = await addState();
const treeAfter = await treeOrder();
ok(!a.editing, "Esc 取消改名");
ok(a.groups === 10 && treeAfter.at(-1) === born, `空组留着、还是最后一组（${treeAfter.at(-1)}）`);
ok(
  (await page.locator(`.ws-sec[data-ws="${born}"] .ws-head .label`).textContent()) === "新工作区",
  "没起名字的组显示「新工作区」",
);
await page.click(".ws-tabs-more");
await sleep(220);
s = await barState();
ok(s.foldedIds.at(-1) === born, `＋N 菜单最后一行就是它（${s.foldedIds.at(-1)}）`);
await page.keyboard.press("Escape");
await sleep(150);

// 18) 左栏收着时点 ＋：先把左栏展开，再进改名态（否则按下去什么都看不见）
await page.click('.side-toggle[data-act="sessions"]');
await sleep(450);
ok((await addState()).noLeft, "左栏已收起（.main 带 no-left）");
const creates1 = createCalls();
await page.click(".ws-tabs-add");
await sleep(700);
a = await addState();
ok(createCalls() === creates1 + 1, `左栏收起时点 ＋ 照样发 ws.create（${createCalls() - creates1} 条）`);
ok(!a.noLeft, "左栏自己展开了");
ok(a.editing && a.focused, "改名行可见、并且拿到焦点");
ok(a.groups === 11, `左栏又多一个组（${a.groups}）`);
await page.keyboard.press("Escape");
await sleep(300);

await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-add.png`), clip: { x: 0, y: 0, width: 1000, height: 820 } });

// 19) #178 六步端到端：新建 → 拖动 → 刷新 → 从 ＋N 切回 → 移到最前 → 设置改 max
await page.setViewportSize({ width: 1400, height: 820 });
await sleep(300);
const groups0 = (await addState()).groups;
await page.click(".ws-tabs-add");
await sleep(700);
const sixNewState = await addState();
ok(sixNewState.groups === groups0 + 1, `六步 1/6 新建：左栏多一个组（${groups0} → ${sixNewState.groups}）`);
const sixNew = WS.order.at(-1);
ok(
  sixNew === "manual:stub3" && sixNewState.moreText === "＋9",
  `六步 1/6 新建：新组追加到 order 末尾、收在 ＋N（${sixNew} / ${sixNewState.moreText}）`,
);
await page.keyboard.press("Escape");
await sleep(300);

const sixBefore = (await barState()).visibleIds;
const sixMoved = sixBefore[0];
const sixLast = sixBefore.at(-1);
await dragTab(sixMoved, sixLast, "after");
s = await barState();
ok(
  s.visibleIds.at(-1) === sixMoved && s.visibleIds.join() !== sixBefore.join(),
  `六步 2/6 拖动：${sixMoved} 拖到可见段最后（${s.visibleIds.join(" / ")}）`,
);
const sixOrder = [...WS.order];

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
s = await barState();
ok(JSON.stringify(WS.order) === JSON.stringify(sixOrder), "六步 3/6 刷新：桥里的 order 没变");
ok(
  JSON.stringify(s.visibleIds) === JSON.stringify(sixOrder.slice(0, 3)),
  `六步 3/6 刷新：前三颗仍是刷新前那份 order（${s.visibleIds.join(" / ")}）`,
);

const switchTo = "f:/proj-02";
ok(!s.visibleIds.includes(switchTo), `六步 4/6 切回：${switchTo} 此刻在 ＋N 里`);
await page.click(".ws-tabs-more");
await sleep(220);
await page.locator(`.ws-tabs-menu .pm-item[data-ws="${switchTo}"]`).click();
await sleep(700);
s = await barState();
ok(s.onWs === switchTo, `六步 4/6 切回：点 ＋N 那一行切到 ${switchTo}（当前 ${s.onWs}）`);
ok(s.visibleIds.includes(switchTo), `六步 4/6 切回：当前组占住最后一格（${s.visibleIds.join(" / ")}）`);

await openWsMore(switchTo);
await sleep(200);
await page.locator(".ws-menu .pm-item[data-act='front']").click();
await sleep(600);
s = await barState();
ok(
  s.visibleIds[0] === switchTo && WS.order[0] === switchTo,
  `六步 5/6 移到最前：${switchTo} 排到第一（${s.visibleIds.join(" / ")}）`,
);
ok((await treeOrder())[0] === switchTo, `六步 5/6 移到最前：左栏也一起变（${(await treeOrder())[0]}）`);

await page.locator('.icon-btn[data-act="look"]').click();
await page.waitForSelector(".display-sheet .ws-max-row", { timeout: 5000 });
await sleep(250);
for (let i = 0; i < 9; i++) {
  await page.locator('.ws-max-btn[data-act="ws-max-up"]').click({ force: true });
  await sleep(220);
}
const sixMax = await page.evaluate(() => ({
  n: document.querySelector(".ws-max-n")?.textContent ?? "",
  count: document.querySelectorAll(".ws-tab").length,
  moreHidden: document.querySelector(".ws-tabs-more")?.hidden ?? true,
  groups: document.querySelectorAll(".ws-sec").length,
}));
ok(
  sixMax.n === "12" && sixMax.count === sixMax.groups,
  `六步 6/6 设置改 max：12 颗名额画下全部 ${sixMax.count} 组（${sixMax.n} / ${sixMax.count}）`,
);
ok(sixMax.moreHidden, "六步 6/6 设置改 max：装得下就不再出 ＋N");
ok(lastTabs()?.max === 12, `六步 6/6 设置改 max：最后一条 ws.tabs 是 max 12（${lastTabs()?.max}）`);
await page.locator('.display-sheet .btn:has-text("关闭")').click().catch(() => {});
await sleep(200);

// 过滤态：左栏搜索只画命中的组，拖出来的 order 会缺项 —— 此时标签不绑拖动，一个字都不发。
await page.evaluate(() => {
  const i = document.querySelector(".session-filter");
  i.value = "proj-01";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(350);
const one = await barState();
ok(one.visibleIds.length === 1 && one.visibleIds[0] === "f:/proj-01", `过滤后只画命中的组（${one.visibleIds.join(" / ")}）`);
const fb = await page.locator('.ws-tab[data-ws="f:/proj-01"]').boundingBox();
const fcalls = tabsCalls();
const fy = Math.round(fb.y + fb.height / 2);
const fx = Math.round(fb.x + fb.width / 2);
await page.mouse.move(fx, fy);
await page.mouse.down();
await page.mouse.move(fx + 24, fy, { steps: 5 });
const fm = await dragMark();
await page.mouse.up();
await sleep(250);
ok(!fm.body && fm.dragging === 0 && fm.lines === 0, "过滤态拖动：不起拖、不画竖线");
ok(tabsCalls() === fcalls, `过滤态拖动不发 ws.tabs（${tabsCalls() - fcalls} 条）`);
await page.evaluate(() => {
  const i = document.querySelector(".session-filter");
  i.value = "";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(300);

await page.close();

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
