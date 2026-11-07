/**
 * Probe: #121 标签行只画 N 个 + `＋N`；#173 一份 `order` 接管组序；#175 横条的「＋ 新建工作区」。
 *
 * 票面要的是：标签行只画 N 颗（N 由桥端下发，默认 3），剩下的组数报在槽外的 `＋N` 上；点 `＋N` 只列
 * 被折叠的组，点一行切过去并关掉下拉；当前组排在组序很后面时它仍然在圈内（挤掉最后一格）。
 * #173 接上：组序只有桥端那一份 `order`（左栏树与标签行共用），组头 ⋯ 里的「固定」退役，
 * 拖拽换序也不再是标签行的事 —— 刷新页面拿到的就是桥里那份顺序。
 * #175 再接上：标签行末尾、`＋N` 左边多一颗「＋」—— 点一下就是树底的「新建工作区」（同一个
 * `ws.create`）：左栏多一个空组并就地改名；左栏收着时先展开，名字才看得见。名额满了照样能建，
 * 新组按规则追加到 `order` 末尾、收进 `＋N`，页面用一条小提示说明它去哪了。
 *
 * 上一票（#119）的断言留着：A 壳顶栏只有一行、标签紧跟在 ◧ 后面、B/C/D 不画标签、800px 不破版。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs`（名额 / 顺序）与 `ws.create`
 * （造空的手动组、追加到 order 末尾）落到内存里再广播 —— 刷新页面拿到的就是「重启后的桥」。
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

// #173：组序只有一份 `order`，名额也在桥里 —— 都存在内存里，刷新页面就像重启后的桥一样拿回来。
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
        // 真桥的 `setTabs()`：名额 clamp 到 1–5，顺序去重 / 剔脏（悬空 id 不进 order），再广播。
        if (msg.action === "ws.tabs") {
          if (msg.max !== undefined) WS.max = Math.min(5, Math.max(1, Math.trunc(Number(msg.max))));
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

// 5) #121：当前组排在组序很后面时，它挤掉最后一格进圈（圈内仍是 N 颗）
page = await open(null, "s-09-1");
s = await barState();
ok(s.onWs === "f:/proj-09", `A：组序第 9 的当前组也在标签行上（${s.onWs}）`);
ok(s.count === 3, `A：它挤掉了一个补位组，没多画（${s.count} 颗）`);
ok(s.moreShown && s.moreText === "＋6", `A：被挤掉的那组回到 ＋N（${s.moreText}）`);
await page.close();

// 5b) B/C/D：标签行不进顶栏，顶栏那三样照旧
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

// 7) #173：组序只有一份 —— 组头 ⋯ 里不再有「固定」，左栏树与标签行同序
page = await open(null);
const openWsMore = async (id) => {
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head`).hover();
  await page.locator(`.ws-sec[data-ws="${id}"] .ws-head .ws-more`).click();
  await sleep(250);
};
const menuActs = () =>
  page.evaluate(() => [...document.querySelectorAll(".ws-menu .pm-item")].map((n) => n.dataset.act ?? ""));
const treeOrder = () => page.evaluate(() => [...document.querySelectorAll(".ws-sec")].map((n) => n.dataset.ws ?? ""));
await openWsMore("f:/proj-05");
const acts = await menuActs();
ok(acts.join("/") === "rename/drop", `组头 ⋯ 只剩改名 / 删除（${acts.join(" / ") || "空"}）`);
await page.keyboard.press("Escape");
await sleep(150);
s = await barState();
const treeIds = await treeOrder();
ok(JSON.stringify(treeIds) === JSON.stringify(WS.order), `左栏组序就是那份 order（${treeIds.slice(0, 3).join(" / ")} …）`);
ok(JSON.stringify(s.visibleIds) === JSON.stringify(WS.order.slice(0, 3)), `标签行是 order 的前 3 颗（${s.visibleIds.join(" / ")}）`);

// 8) 刷新后组序还在（桥落库了 —— 桩桥在内存里持久化）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(WS.order.slice(0, 3)), `刷新后组序还在（${s.visibleIds.join(" / ")}）`);

// 9) 点标签切组：点第 2 颗 → 当前变它，顺序一动没动
const secondId = s.visibleIds[1];
await page.click(`.ws-tab[data-ws="${secondId}"]`);
await sleep(600);
s = await barState();
ok(s.onWs === secondId, `点第 2 颗切到它（${s.onWs}）`);
ok(JSON.stringify(s.visibleIds) === JSON.stringify(WS.order.slice(0, 3)), "切组没改组序");

// 10) #126：切会话不改标签行的顺序 —— 组序只认 order，「最近活动」不再让它换人
for (const id of ["s-05-1", "s-09-1"]) {
  await page.goto(`${BASE}/#/s/${id}`, { waitUntil: "networkidle" });
  await sleep(700);
  const now = await barState();
  ok(now.visibleIds.slice(0, 2).join() === WS.order.slice(0, 2).join(), `切到 ${id}：前两颗原地不动（${now.visibleIds.join(" / ")}）`);
  ok(now.count <= 4, `切到 ${id}：圈内最多 N+1 颗（${now.count}）`);
}
await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
await sleep(700);
s = await barState();
ok(JSON.stringify(s.visibleIds) === JSON.stringify(WS.order.slice(0, 3)), `切回第一组：标签行完全复原（${s.visibleIds.join(" / ")}）`);
await page.close();

// 11) #175：横条末尾那颗 ＋（在 ＋N 左边、槽外面）—— 点一下就是树底的「新建工作区」
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
const tabCalls = () => CALLS.filter((c) => c.action === "ws.tabs").length;

page = await open(null);
await sleep(500);
let a = await addState();
ok(a.shown && a.text === "＋", `A：横条末尾有 ＋（${a.text || "没有"}）`);
ok(a.title === "新建工作区", `A：悬停说明是「${a.title}」`);
ok(a.inRow && a.outsideSlot && a.between, "A：＋ 挂在横条里、标签槽外面、紧贴在 ＋N 左边");
ok(a.left > 0 && a.left < a.moreLeft, `A：＋ 在 ＋N 左边（${a.left} < ${a.moreLeft}）`);
ok(!a.editing, "点之前树里没有正在改名的组");

// 12) 点名：新组按 #173 规则追加到 order 末尾；名额满了就收进 ＋N，并且说一声
const orderBefore = [...WS.order];
const creates0 = createCalls();
const tabs0 = tabCalls();
await page.click(".ws-tabs-add");
await sleep(700);
ok(createCalls() === creates0 + 1, `点 ＋ 发一条 ws.create（${createCalls() - creates0} 条）`);
const createMsg = CALLS.filter((c) => c.action === "ws.create").at(-1);
ok(createMsg?.name === "", `发的是空名（"${createMsg?.name ?? "缺"}")—— 名字留给改名行`);
a = await addState();
ok(a.groups === 10, `左栏多了一个组（${a.groups}）`);
ok(a.editing && a.placeholder === "新工作区", `新组直接在原地改名：「${a.placeholder}」`);
ok(a.focused, "改名行拿到焦点（直接打字就是名字）");
ok(tabCalls() === tabs0, "点 ＋ 没有顺手改 order（没发 ws.tabs）");
const born = WS.order.at(-1);
ok(WS.order.length === orderBefore.length + 1 && !orderBefore.includes(born ?? ""), `新组追加到 order 末尾（${born}）`);
ok(a.moreText === "＋7", `名额满了：新组收在 ＋N 里（${a.moreText}）`);
ok(/已新建，收在 ＋7 里/.test(a.toast), `并且用提示说清它去哪了（${a.toast.trim() || "没提示"}）`);

// 13) Esc 取消改名：空组留着，名字回落成「新工作区」，顺序仍是末尾
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

// 14) 左栏收着时点 ＋：先把左栏展开，再进改名态（否则按下去什么都看不见）
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

await page.close();

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
