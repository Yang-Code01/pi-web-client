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
 * #276 再接上：横条成员开定 —— 悬停任意可见标签出 ⊙（当前组也有），点掉只是 `ws.row {inRow:false}`；
 * 组还在左栏，toast 能撤销；当前组被移出后仍占最后一格（虚线 + 名字划掉，名额不涨）；
 * `＋N` 分两段：装不下（只切组）/ 不在横条里（放回并切组），刷新后成员状态还在。
 * 旧桥没有 `inRow` 时全部当成员、不画 ⊙、组头菜单也没有「在横条中」。
 *
 * #175 再接上：标签行末尾、`＋N` 左边多一颗「＋」—— 点一下就是树底的「新建工作区」（同一个
 * `ws.create`）：左栏多一个空组并就地改名；左栏收着时先展开，名字才看得见。名额满了照样能建，
 * 新组按规则追加到 `order` 末尾、收进 `＋N`，页面用一条小提示说明它去哪了。
 * #279 再接上：空组在组头标「空」，删除边界改成「有会话才拦」—— 空的手动组与空的目录组都能从 ⋯
 * 里删掉（快照 / order / 左栏一起消失），有会话时仍置灰并说清原因；当前组被删掉（别的客户端删的）
 * 时页面落到右邻，不留在空白页上。
 * #277 再接上：双击当前标签就地改名（浮层贴标签、不吃行高、窄窗口不出视口）；非当前组的一次双击里
 * 第一下只切组、第二下才编辑；Enter / 点别处保存，Esc 不改，留空回落目录名；拖动过的手不许弹浮层；
 * 桥没收下（桩桥故意不回写）时提示并保留原值。
 *
 * 上一票（#119）的断言留着：A 壳顶栏只有一行、标签紧跟在 ◧ 后面、B/C/D 不画标签、800px 不破版。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs`（名额 / 顺序）、`ws.create`
 * （造空的手动组、追加到 order 末尾）与 `ws.drop`（数会话：有就回 notice，空的才真删）落到内存里
 * 再广播 —— 刷新页面拿到的就是「重启后的桥」。
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
  return { id: `f:/proj-${n}`, name: `客户 ${n} 号的后台系统`, key: `F:/proj-${n}`, manual: false, inRow: true };
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
/** #277：桩桥故意不收改名，用来核对「拒绝时提示 + 保留原值」。 */
let RENAME_DROP = false;
const WS = {
  groups: [...GROUPS],
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
  order: GROUPS.map((g) => g.id),
  max: 3,
};
const workspace = () => ({ ...WS, groups: WS.groups.map((g) => ({ ...g })), order: [...WS.order] });
/** #278：hello 的 `caps` —— 默认空（旧桥）；「按目录新建」那一段再把它打开。 */
const CAPS = [];
/**
 * #278：桩目录树（键 = 小写归一化路径）。真桥的 `/api/dirs` 形状照 `bridge/src/dirs.ts`：
 * `{ path, parent, dirs, files }`，不存在时带 `error`。只铺页面走到的那几层。
 */
const DIRS = new Map([
  ["", { path: "", parent: null, dirs: ["F:/"] }],
  ["f:/", { path: "F:/", parent: "", dirs: [] }],
]);
/** 归一化：反斜杠→斜杠、去掉尾部分隔符；盘符根补回 `/`（`F:` 与 `F:/` 是同一个地方）。 */
const normDir = (raw) => {
  let want = String(raw ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:$/.test(want)) want += "/";
  return want;
};
const stubDirs = (raw) => {
  const want = normDir(raw);
  const hit = DIRS.get(want.toLowerCase());
  if (hit) return { ...hit, files: [] };
  return { path: want, parent: null, dirs: [], files: [], error: "目录不存在", errCode: "ENOENT" };
};
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
  if (url.pathname === "/api/dirs") return json(200, stubDirs(url.searchParams.get("path") ?? ""));
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
        // #276 真桥的 `setRow()`：组存在且 inRow 是布尔才写，写完广播；否则静默忽略。
        if (msg.action === "ws.row") {
          const group = WS.groups.find((g) => g.id === msg.id);
          if (group && typeof msg.inRow === "boolean") {
            group.inRow = msg.inRow;
            cast();
          }
        }
        // #277 真桥的 `rename()`：trim + slice(0,80)，组不在 / 同名都静默不写，但照样广播快照。
        // RENAME_DROP 让桩桥扮演「拒收」：收下动作、不回写名字，页面只能靠下一份快照发现。
        if (msg.action === "ws.rename") {
          const group = WS.groups.find((g) => g.id === msg.id);
          const name = String(msg.name ?? "").trim().slice(0, 80);
          if (group && !RENAME_DROP && group.name !== name) group.name = name;
          cast();
        }
        // 真桥的 `workspaces.create()`：造一个空名的手动组，追加到 order 末尾。
        // #278：带 `dir` 时目录就是组的身份 —— 同目录不重建（回 created:false），`f:/broken` 回拒绝。
        if (msg.action === "ws.create" && typeof msg.dir === "string" && msg.dir) {
          const dir = normDir(msg.dir);
          const key = DIRS.get(dir.toLowerCase())?.path ?? dir;
          const id = key.toLowerCase();
          if (id === "f:/broken") {
            ws.send(JSON.stringify({ type: "notice", text: `打不开这个目录：${key}`, level: "warn" }));
            return;
          }
          const existed = WS.groups.some((g) => g.id === id);
          if (!existed) WS.groups.push({ id, name: "", key, manual: false, inRow: true });
          WS.order = existed ? [...WS.order] : [...WS.order, id];
          WS.keys[dir.toLowerCase()] = key;
          cast();
          ws.send(JSON.stringify({ type: "ws.created", id, created: !existed }));
          return;
        }
        if (msg.action === "ws.create") {
          createdGroups += 1;
          const id = `manual:stub${createdGroups}`;
          WS.groups.push({ id, name: String(msg.name ?? ""), key: "", manual: true, inRow: true });
          WS.order = [...WS.order, id];
          cast();
        }
        // 真桥的 `dropWorkspace()`（#279）：组里还有会话就回 notice，空的才真删，再广播新快照。
        if (msg.action === "ws.drop") {
          const id = String(msg.id ?? "");
          if (SESSIONS.some((x) => x.ws === id)) {
            ws.send(JSON.stringify({ type: "notice", text: "这个工作区里还有会话", level: "warn" }));
          } else {
            WS.groups = WS.groups.filter((g) => g.id !== id);
            WS.order = WS.order.filter((x) => x !== id);
            for (const [sid, wid] of Object.entries(WS.overrides)) if (wid === id) delete WS.overrides[sid];
            cast();
          }
        }
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace(), caps: [...CAPS] }));
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
  const rowUi = await page.evaluate(() => ({
    toggles: document.querySelectorAll(".ws-tab-row-toggle").length,
    board: document.querySelectorAll(".ws-tabs-board, .ws-tray").length,
  }));
  ok(rowUi.toggles === 0 && rowUi.board === 0, `${id.toUpperCase()}：不画 ⊙，也没有两段式托盘（${rowUi.toggles} / ${rowUi.board}）`);
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

// 7) #173 组头菜单：只剩重命名 / 移到最前 / 删除，左栏没有「已固定」那种额外徽记（#279 的「空」是另一回事）
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
ok(
  JSON.stringify(menu.acts) === JSON.stringify(["rename", "row", "front", "drop"]),
  `组头 ⋯ 有重命名 / 在横条中 / 移到最前 / 删除（${menu.acts.join(" / ")}）`,
);
const rowItem = await page.evaluate(() => {
  const n = document.querySelector('.ws-menu .pm-item[data-act="row"]');
  return n ? { checked: n.getAttribute("aria-checked"), on: n.classList.contains("on"), text: n.textContent ?? "" } : null;
});
ok(rowItem?.checked === "true" && rowItem.on && /在横条中/.test(rowItem.text), `组头菜单的「在横条中」是勾上的（${rowItem?.checked ?? "缺"} / ${rowItem?.text ?? ""}）`);
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
  focus.buttons.length === 8 &&
    focus.buttons.every((c) => c === "ws-tabs-more" || c === "ws-tabs-add" || /^ws-tab(\s|$)/.test(c) || /^ws-tab-row-toggle(\s|$)/.test(c)),
  `可聚焦元素 = 3 颗标签 + 3 个 ⊙ + ＋N + ＋（${focus.buttons.join(" / ")}，额外 ${focus.extra} 个）`,
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

// ── #276 横条成员开定 ───────────────────────────────────────────────────────
const rowState = () =>
  page.evaluate(() => {
    const cols = [...document.querySelectorAll(".ws-tabs-board .ws-tray-col")];
    const ids = (col) => [...(col?.querySelectorAll(".pm-item") ?? [])].map((n) => n.dataset.ws ?? "");
    const off = document.querySelector(".ws-tab.off-row");
    const name = off?.querySelector(".ws-tab-name");
    const toggle = document.querySelector(".ws-tab-slot.row .ws-tab-row-toggle");
    return {
      visibleIds: [...document.querySelectorAll(".ws-tab")].map((n) => n.dataset.ws ?? ""),
      toggles: document.querySelectorAll(".ws-tab-row-toggle").length,
      toggleOpacity: toggle ? getComputedStyle(toggle).opacity : "missing",
      board: document.querySelectorAll(".ws-tabs-board").length,
      trayCols: cols.length,
      leftIds: ids(cols[0]),
      rightIds: ids(cols[1]),
      leftTitle: cols[0]?.querySelector(".ws-tray-title")?.textContent ?? "",
      rightTitle: cols[1]?.querySelector(".ws-tray-title")?.textContent ?? "",
      rightEmpty: cols[1]?.querySelector(".pm-why")?.textContent ?? "",
      rows: document.querySelectorAll(".ws-tabs-menu .pm-item").length,
      offCount: document.querySelectorAll(".ws-tab.off-row").length,
      offBorder: off ? getComputedStyle(off).borderTopStyle : "missing",
      offLine: name ? getComputedStyle(name).textDecorationLine : "missing",
      stray: document.querySelectorAll(".ws-tab-stray").length,
      moreText: document.querySelector(".ws-tabs-more")?.textContent ?? "",
      toast: document.querySelector(".fail-toast")?.textContent ?? "",
      undo: Boolean(document.querySelector(".fail-toast-undo")),
    };
  });

const rowCalls = () => CALLS.filter((c) => c.action === "ws.row");
const lastRowCall = () => rowCalls().at(-1) ?? null;
const hoverToggle = async (id) => {
  const tab = page.locator(`.ws-tab[data-ws="${id}"]`);
  await tab.hover();
  await tab.locator("xpath=..").locator(".ws-tab-row-toggle").click();
};
const openTray = async () => {
  await page.click(".ws-tabs-more");
  await sleep(220);
};

// 回到原始 9 组、order 01→09、名额 3。
WS.groups = GROUPS.map((g) => ({ ...g }));
WS.order = GROUPS.map((g) => g.id);
WS.max = 3;
cast();
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(600);

s = await rowState();
ok(s.toggles === 3 && s.toggleOpacity === "0", `A：3 颗可见标签各有一个 ⊙，默认藏着（${s.toggles} / ${s.toggleOpacity}）`);
const beforeHover = await page.evaluate(() => {
  const n = document.querySelector(".ws-tab-slot.row .ws-tab-row-toggle");
  const slot = n?.parentElement;
  return { opacity: n ? getComputedStyle(n).opacity : "missing", slot: Boolean(slot) };
});
await page.locator(".ws-tab.on").hover();
await sleep(100);
const currentToggle = await page.evaluate(() => {
  const n = document.querySelector('.ws-tab-slot:has(.ws-tab.on) .ws-tab-row-toggle');
  return n ? getComputedStyle(n).opacity : "missing";
});
ok(currentToggle === "1", `A：当前组自己也有 ⊙（${currentToggle}）`);
await page.locator('.ws-tab[data-ws="f:/proj-02"]').hover();
await sleep(120);
const afterHover = await page.evaluate(() => {
  const n = document.querySelector('.ws-tab-slot:has(.ws-tab[data-ws="f:/proj-02"]) .ws-tab-row-toggle');
  return { opacity: n ? getComputedStyle(n).opacity : "missing", pointer: n ? getComputedStyle(n).pointerEvents : "missing" };
});
ok(beforeHover.slot && afterHover.opacity === "1" && afterHover.pointer === "auto", `A：悬停标签才浮出 ⊙（${beforeHover.opacity} → ${afterHover.opacity}）`);

const rowOrderBefore = [...WS.order];
await hoverToggle("f:/proj-02");
await sleep(420);
s = await rowState();
const removed = lastRowCall();
ok(removed?.id === "f:/proj-02" && removed?.inRow === false, `A：点 ⊙ 发 ws.row 移出 f:/proj-02（${removed?.id}/${removed?.inRow}）`);
ok(WS.groups.find((g) => g.id === "f:/proj-02")?.inRow === false, "A：成员状态落到桥里");
ok(!s.visibleIds.includes("f:/proj-02") && s.visibleIds.length === 3, `A：横条立刻少一颗、只剩 3 颗（${s.visibleIds.join(" / ")}）`);
ok((await treeOrder()).includes("f:/proj-02"), "A：组还在左栏树里");
ok(/移出横条/.test(s.toast) && s.undo, `A：toast 说明去哪了，并且有撤销（${s.toast.trim()}）`);
ok(s.moreText === "＋6", `A：被移出的组收进 ＋N（${s.moreText}）`);

await page.locator(".fail-toast-undo").click();
await sleep(420);
s = await rowState();
const undone = lastRowCall();
ok(undone?.id === "f:/proj-02" && undone?.inRow === true, `A：撤销发 ws.row 放回（${undone?.id}/${undone?.inRow}）`);
ok(JSON.stringify(WS.order) === JSON.stringify(rowOrderBefore), "A：撤销没有改 order");
ok(s.visibleIds[1] === "f:/proj-02" && !s.toast, `A：撤销回到原来的位置（${s.visibleIds.join(" / ")}）`);

// 再移出 02，验两段式托盘。
await hoverToggle("f:/proj-02");
await sleep(420);
await openTray();
s = await rowState();
ok(s.board === 1 && s.trayCols === 2, `＋N 是两段式托盘（${s.board} / ${s.trayCols} 列）`);
ok(s.leftIds.length === 5 && s.leftTitle === "装不下 5", `左段只列装不下的 5 组（${s.leftTitle} / ${s.leftIds.length}）`);
ok(s.rightIds.length === 1 && s.rightIds[0] === "f:/proj-02" && s.rightTitle === "不在横条里 1", `右段列不在横条里的 1 组（${s.rightTitle} / ${s.rightIds.join(" / ")}）`);

let rowCount = rowCalls().length;
await page.locator('.ws-tabs-board .ws-tray-col:nth-child(1) .pm-item[data-ws="f:/proj-05"]').click();
await sleep(650);
s = await rowState();
ok((await barState()).onWs === "f:/proj-05" && rowCalls().length === rowCount, "左段点一行只切组，不发 ws.row");
ok(s.visibleIds.includes("f:/proj-05"), "左段点的那组顶到最后一格");
ok(WS.groups.find((g) => g.id === "f:/proj-02")?.inRow === false, "左段点一行没顺手改成员");

await openTray();
await page.locator('.ws-tabs-board .ws-tray-col:nth-child(2) .pm-item[data-ws="f:/proj-02"]').click();
await sleep(700);
s = await rowState();
ok(lastRowCall()?.id === "f:/proj-02" && lastRowCall()?.inRow === true, "右段点一行先放回横条（ws.row true）");
ok((await barState()).onWs === "f:/proj-02", `右段点一行还切到它（当前 ${(await barState()).onWs}）`);
ok(s.visibleIds.includes("f:/proj-02") && s.moreText === "＋6", `放回后横条恢复 3 颗 + ＋6（${s.visibleIds.join(" / ")} / ${s.moreText}）`);

// 切回 01 当前组，再把它移出：仍占最后一格，且 ＋N 不能重复数。
await page.locator('.ws-tab[data-ws="f:/proj-01"]').click();
await sleep(500);
await hoverToggle("f:/proj-01");
await sleep(450);
s = await rowState();
ok(s.visibleIds.length === 3 && s.visibleIds[2] === "f:/proj-01", `当前组被移出仍占最后一格（${s.visibleIds.join(" / ")}）`);
ok(s.offCount === 1 && s.offBorder === "dashed" && s.offLine === "line-through" && s.stray === 1, `当前组是虚线 + 名字划掉 + ⊘（${s.offBorder} / ${s.offLine} / ${s.stray}）`);
ok(/当前组/.test(s.toast), `toast 说清它还是当前组（${s.toast.trim()}）`);
ok(s.moreText === "＋6", `＋N 不把临时占位的当前组重复数（${s.moreText}）`);
await openTray();
s = await rowState();
ok(s.leftIds.length === 6 && s.rightIds.length === 0 && s.rightTitle === "不在横条里 0", `托盘左 6 / 右 0，当前组不算「不在横条里」（${s.leftTitle} / ${s.rightTitle}）`);
ok(/全都在横条里/.test(s.rightEmpty), `右段空态说全都放回来了（${s.rightEmpty}）`);
await page.keyboard.press("Escape");
await sleep(150);

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(650);
s = await rowState();
ok(WS.groups.find((g) => g.id === "f:/proj-01")?.inRow === false, "刷新后桥里仍记得当前组被移出");
ok(JSON.stringify(s.visibleIds) === JSON.stringify(["f:/proj-02", "f:/proj-03", "f:/proj-01"]) && s.offCount === 1, `刷新后仍是 3 颗、当前组虚线占最后一格（${s.visibleIds.join(" / ")}）`);

await hoverToggle("f:/proj-01");
await sleep(450);
s = await rowState();
ok(lastRowCall()?.id === "f:/proj-01" && lastRowCall()?.inRow === true && s.offCount === 0, "当前组的 ⊙ 也能把它放回横条");

// 组头 ⋯ 的「在横条中」= 同一颗 ⊙：勾选状态跟着桥走。
await openWsMore("f:/proj-06");
let item = await page.evaluate(() => {
  const n = document.querySelector('.ws-menu .pm-item[data-act="row"]');
  return n ? { checked: n.getAttribute("aria-checked"), on: n.classList.contains("on") } : null;
});
ok(item?.checked === "true" && item.on, "组头菜单「在横条中」对成员是勾上的");
await page.locator('.ws-menu .pm-item[data-act="row"]').click();
await sleep(420);
ok(lastRowCall()?.id === "f:/proj-06" && lastRowCall()?.inRow === false, "点菜单项等于点 ⊙（ws.row false）");
ok(WS.groups.find((g) => g.id === "f:/proj-06")?.inRow === false, "菜单点击也落到桥里");
await openWsMore("f:/proj-06");
item = await page.evaluate(() => {
  const n = document.querySelector('.ws-menu .pm-item[data-act="row"]');
  return n ? { checked: n.getAttribute("aria-checked"), on: n.classList.contains("on") } : null;
});
ok(item?.checked === "false" && !item.on, "移出后菜单项不勾");
await page.locator('.ws-menu .pm-item[data-act="row"]').click();
await sleep(420);
ok(lastRowCall()?.id === "f:/proj-06" && lastRowCall()?.inRow === true, "再点一下放回横条（ws.row true）");

// 旧桥（组上没有 inRow）：全部当成员、不画 ⊙、菜单里没有这一项，托盘仍是单段。
for (const g of WS.groups) delete g.inRow;
cast();
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(600);
s = await rowState();
ok(s.toggles === 0, "旧桥：不画任何 ⊙");
await openWsMore("f:/proj-09");
const oldActs = await page.evaluate(() => [...document.querySelectorAll(".ws-menu .pm-item")].map((n) => n.dataset.act ?? ""));
ok(JSON.stringify(oldActs) === JSON.stringify(["rename", "front", "drop"]), `旧桥：组头菜单没有「在横条中」（${oldActs.join(" / ")}）`);
await page.keyboard.press("Escape");
await sleep(150);
await openTray();
s = await rowState();
ok(s.board === 0 && s.trayCols === 0 && s.rows === 6, `旧桥：＋N 还是原来那一种单段菜单（${s.board} / ${s.rows} 行）`);
await page.keyboard.press("Escape");
await sleep(150);
for (const g of WS.groups) g.inRow = true;
cast();
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(500);

await page.close();

// ── #277 横条标签双击改名 ───────────────────────────────────────────────────
// 浮层是 body 上的 fixed 输入框：贴当前标签下沿、不改标签行高度；Enter / 点别处存，Esc 丢，
// 空串交给桥回落目录名。非当前组的两下规则、拖动阈值、桥拒收的提示都在这一段里。
WS.groups = GROUPS.map((g) => ({ ...g }));
WS.order = GROUPS.map((g) => g.id);
WS.max = 3;
RENAME_DROP = false;
cast();
page = await open(null);
await sleep(500);

const renameCalls = () => CALLS.filter((c) => c.action === "ws.rename");
const lastRenameCall = () => renameCalls().at(-1) ?? null;
/** 当前标签上那颗改名浮层：在不在、值、焦点、贴在哪儿、有没有出视口，以及提示条。 */
const tabRenameState = () =>
  page.evaluate(() => {
    const input = document.querySelector(".ws-tab-rename-input");
    const tab = document.querySelector(".ws-tab.on");
    const row = document.querySelector(".ws-tabs-row");
    const ir = input?.getBoundingClientRect();
    const tr = tab?.getBoundingClientRect();
    const rr = row?.getBoundingClientRect();
    return {
      exists: Boolean(input),
      value: input?.value ?? "",
      focused: document.activeElement === input,
      input: ir ? { left: ir.left, top: ir.top, right: ir.right, bottom: ir.bottom, height: ir.height } : null,
      tabBottom: tr?.bottom ?? null,
      rowH: rr?.height ?? 0,
      inViewport: Boolean(ir && ir.left >= 6 && ir.top >= 6 && ir.right <= window.innerWidth - 6 && ir.bottom <= window.innerHeight - 6),
      gap: ir && tr ? Math.round(ir.top - tr.bottom) : null,
      onWs: tab?.dataset.ws ?? "",
      toast: document.querySelector(".fail-toast")?.textContent ?? "",
    };
  });
/** 某一组在横条与左栏同时显示的名字（两处要一起变）。 */
const shownNames = (id) =>
  page.evaluate((id) => {
    const tab = document.querySelector(`.ws-tab[data-ws="${id}"] .ws-tab-name`);
    const sec = document.querySelector(`.ws-sec[data-ws="${id}"]`);
    return { tab: tab?.textContent ?? "", tree: sec?.querySelector(".ws-head > .label")?.textContent ?? "" };
  }, id);
const dblTab = async (id) => {
  await page.locator(`.ws-tab[data-ws="${id}"]`).dblclick();
  await sleep(260);
};

// A. 双击当前标签：浮层贴在标签下沿，行高不变，值就是原名。
const rowH0 = await page.evaluate(() => document.querySelector(".ws-tabs-row")?.getBoundingClientRect().height ?? 0);
await dblTab("f:/proj-01");
let rn = await tabRenameState();
ok(rn.exists && rn.focused, "双击当前标签弹出改名输入框并聚焦");
ok(rn.value === "客户 01 号的后台系统", `浮层里是原来的全名（${rn.value}）`);
ok(rn.input && Math.abs(rn.input.height - 30) < 1, `浮层高度 30（${rn.input?.height}）`);
ok(Math.abs(rn.rowH - rowH0) < 1, `浮层不撑高标签行（${rowH0} → ${rn.rowH}）`);
ok(rn.gap != null && rn.gap >= 2 && rn.gap <= 8, `浮层贴着标签下沿（间距 ${rn.gap}px）`);
ok(rn.inViewport, "浮层整个落在视口里");

// B. Enter 保存：横条与左栏同时改，刷新后还在。
await page.locator(".ws-tab-rename-input").fill("客户 01 号 · 改名");
await page.locator(".ws-tab-rename-input").press("Enter");
await sleep(450);
rn = await tabRenameState();
ok(!rn.exists, "Enter 后浮层收起");
ok(lastRenameCall()?.id === "f:/proj-01" && lastRenameCall()?.name === "客户 01 号 · 改名", `发出去的是 ws.rename（${lastRenameCall()?.name}）`);
let names = await shownNames("f:/proj-01");
ok(names.tab === "客户 01 号 · 改名" && names.tree === "客户 01 号 · 改名", `横条与左栏同时更新（${names.tab} / ${names.tree}）`);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(600);
names = await shownNames("f:/proj-01");
ok(names.tab === "客户 01 号 · 改名" && names.tree === "客户 01 号 · 改名", "刷新后名字仍在（桥里真写了）");

// C. Esc：什么都不发，名字不动。
let rename0 = renameCalls().length;
await dblTab("f:/proj-01");
await page.locator(".ws-tab-rename-input").fill("不要这个名字");
await page.locator(".ws-tab-rename-input").press("Escape");
await sleep(300);
rn = await tabRenameState();
names = await shownNames("f:/proj-01");
ok(!rn.exists && renameCalls().length === rename0, "Esc 收起浮层、不发 ws.rename");
ok(names.tab === "客户 01 号 · 改名" && names.tree === "客户 01 号 · 改名", "Esc 后横条与左栏都还是原值");

// D. 点浮层外面 = 保存。
await dblTab("f:/proj-01");
await page.locator(".ws-tab-rename-input").fill("点外面保存");
await page.mouse.click(620, 220);
await sleep(450);
rn = await tabRenameState();
names = await shownNames("f:/proj-01");
ok(!rn.exists && lastRenameCall()?.name === "点外面保存", "点别处收起浮层并按当前值保存");
ok(names.tab === "点外面保存" && names.tree === "点外面保存", "点别处保存后两处一起更新");

// E. 留空：发空串，桥负责回落目录名；这里核对动作本身，显示回落由桥的单测管。
await dblTab("f:/proj-01");
await page.locator(".ws-tab-rename-input").fill("");
await page.locator(".ws-tab-rename-input").press("Enter");
await sleep(400);
ok(lastRenameCall()?.id === "f:/proj-01" && lastRenameCall()?.name === "", "留空发出 name:\"\"（交给桥回落目录名）");
ok(WS.groups.find((g) => g.id === "f:/proj-01")?.name === "", "桩桥收到空名（真桥会换成目录名）");
WS.groups.find((g) => g.id === "f:/proj-01").name = "客户 01 号的后台系统";
cast();
await sleep(350);

// F. 非当前组的两下规则：一次双击里第一下只切组、第二下才进编辑。
rename0 = renameCalls().length;
await dblTab("f:/proj-02");
rn = await tabRenameState();
ok(rn.exists && rn.onWs === "f:/proj-02" && rn.value === "客户 02 号的后台系统", "双击非当前组：第一下切组、第二下进编辑，浮层出现时组已切过去");
ok(renameCalls().length === rename0, "只切组的那一下不发 ws.rename");
await page.locator(".ws-tab-rename-input").fill("客户 02 号 · 改名");
await page.locator(".ws-tab-rename-input").press("Enter");
await sleep(400);
names = await shownNames("f:/proj-02");
ok(names.tab === "客户 02 号 · 改名" && names.tree === "客户 02 号 · 改名", "第二下改名照常写入");

// G. 拖动 4px 阈值：拖过之后不弹浮层；单击仍然只是切组。
const dragBox = await page.locator('.ws-tab[data-ws="f:/proj-02"]').boundingBox();
await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
await page.mouse.down();
await page.mouse.move(dragBox.x + dragBox.width / 2 + 30, dragBox.y + dragBox.height / 2, { steps: 5 });
await page.mouse.up();
await sleep(450);
rn = await tabRenameState();
ok(!rn.exists, "拖动超过 4px 不弹改名浮层");
await page.locator('.ws-tab[data-ws="f:/proj-03"]').click();
await sleep(450);
rn = await tabRenameState();
ok(rn.onWs === "f:/proj-03" && !rn.exists, "拖过之后单击仍是切组，不会误进编辑");

// H. 桥拒收：页面不做乐观改名，靠下一份快照发现没写进去，提示并保留原值。
RENAME_DROP = true;
await dblTab("f:/proj-03");
await page.locator(".ws-tab-rename-input").fill("不会保存的名字");
await page.locator(".ws-tab-rename-input").press("Enter");
await sleep(1900);
rn = await tabRenameState();
names = await shownNames("f:/proj-03");
ok(/改名没存下/.test(rn.toast), `桥没收下时提示没存下（${rn.toast}）`);
ok(names.tab === "客户 03 号的后台系统" && names.tree === "客户 03 号的后台系统", `提示后横条与左栏保留原值（${names.tab}）`);
RENAME_DROP = false;

await page.close();

// 20) #279 空组：左栏标「空」、能删（手动组 / 目录组都行）；有会话仍然删不掉；删掉当前组落到右邻
// 桩桥重摆一组「干净」的工作区：两个空组（一个目录组、一个手动组）+ 一个装了会话的手动组 ——
// #279 的两条边界都得有东西可看：空得掉、非空拦得住。
const IDLE = { id: "f:/idle", name: "空工程", key: "F:/idle", manual: false };
const EMPTY = { id: "manual:empty", name: "空的手动组", key: "", manual: true };
const BUSY = { id: "manual:busy", name: "有会话的手动组", key: "", manual: true };
WS.groups = [...GROUPS.map((g) => ({ ...g })), IDLE, EMPTY, BUSY];
WS.order = WS.groups.map((g) => g.id);
WS.max = 10;
byId("s-09-1").ws = BUSY.id; // 手动组装了会话之后，跟目录组一样删不掉
cast();
page = await open(null);
await sleep(600);

/** 某一组在左栏的样子：在不在、有没有「空」徽标、空态那句话、组头的会话数。 */
const groupState = (id) =>
  page.evaluate((id) => {
    const sec = document.querySelector(`.ws-sec[data-ws="${id}"]`);
    return {
      exists: Boolean(sec),
      badge: sec?.querySelector(".ws-head .ws-empty-badge")?.textContent ?? "",
      emptyCard: sec?.querySelector(".ws-empty")?.textContent ?? "",
      count: sec?.querySelector(".ws-head .n")?.textContent ?? "",
    };
  }, id);
/** 组头 ⋯ 里删除那一项：能不能点、悬停说明、置灰时的原因行。 */
const menuState = () =>
  page.evaluate(() => {
    const drop = document.querySelector('.ws-menu .pm-item[data-act="drop"]');
    return {
      disabled: Boolean(drop?.disabled),
      aria: drop?.getAttribute("aria-disabled") ?? "",
      title: drop?.title ?? "",
      why: document.querySelector('.ws-menu .pm-why[data-for="drop"]')?.textContent ?? "",
    };
  });
const dropCalls = () => CALLS.filter((c) => c.action === "ws.drop");

let gs = await groupState(IDLE.id);
ok(gs.exists && gs.badge === "空", `空目录组在左栏标「空」（${gs.badge || "没有徽标"}）`);
ok(gs.emptyCard.includes("这个工作区里还没有会话"), `「空」徽标与空态那句话并存（${gs.emptyCard}）`);
ok(gs.count === "0", `空组的会话数是 0（${gs.count}）`);
gs = await groupState(EMPTY.id);
ok(gs.badge === "空" && gs.emptyCard.includes("这个工作区里还没有会话"), "空的手动组一样标「空」、一样有空态");
gs = await groupState("f:/proj-01");
ok(gs.exists && gs.badge === "" && gs.emptyCard === "", `有会话的组没有「空」徽标（${gs.badge || "没有徽标"}）`);
gs = await groupState(BUSY.id);
ok(gs.badge === "" && gs.count === "1", `装了会话的手动组也没有「空」（${gs.count} 个会话）`);

// 20a) 有会话：目录组与手动组都拒绝，原因沿用原文案，点了也不发 ws.drop
const dropCalls0 = dropCalls().length;
await openWsMore("f:/proj-01");
let ms = await menuState();
ok(ms.disabled && ms.aria === "true", "有会话的目录组：删除项置灰");
ok(/跟着目录走/.test(ms.why), `原因还是「跟着目录走」（${ms.why}）`);
await page.locator('.ws-menu .pm-item[data-act="drop"]').click({ force: true });
await sleep(250);
ok(dropCalls().length === dropCalls0, `点灰掉的删除项没发 ws.drop（${dropCalls().length - dropCalls0} 条）`);
await page.keyboard.press("Escape");
await sleep(150);

await openWsMore(BUSY.id);
ms = await menuState();
ok(ms.disabled && /还有 1 个会话/.test(ms.why), `有会话的手动组：删不掉，原因是「还有 1 个会话」（${ms.why}）`);
await page.keyboard.press("Escape");
await sleep(150);

// 20b) 空的手动组：能删，说明写的是「只删这个空组」，删掉后快照 / order / 左栏同时少一项
await openWsMore(EMPTY.id);
ms = await menuState();
ok(!ms.disabled && ms.aria === "", "空的手动组：删除项可点");
ok(/只删这个空组/.test(ms.title), `手动组的删除说明分得清删的是组（${ms.title}）`);
await page.locator('.ws-menu .pm-item[data-act="drop"]').click();
await sleep(600);
ok(dropCalls().at(-1)?.id === EMPTY.id, `发出去的是 ws.drop ${dropCalls().at(-1)?.id}（期望 ${EMPTY.id}）`);
ok(!WS.groups.some((g) => g.id === EMPTY.id) && !WS.order.includes(EMPTY.id), "桥的快照与 order 里都没它了");
ok(!(await treeOrder()).includes(EMPTY.id) && !(await groupState(EMPTY.id)).exists, "左栏里那块整个不见了");

// 20c) 空的目录组：同样能删，说明写的是「只把这个目录移出列表」
await openWsMore(IDLE.id);
ms = await menuState();
ok(!ms.disabled, "空的目录组：删除项可点");
ok(/移出列表/.test(ms.title), `目录组的删除说明只说把这一项移出列表（${ms.title}）`);
await page.locator('.ws-menu .pm-item[data-act="drop"]').click();
await sleep(600);
ok(dropCalls().at(-1)?.id === IDLE.id, `发出去的是 ws.drop ${dropCalls().at(-1)?.id}（期望 ${IDLE.id}）`);
ok(!(await groupState(IDLE.id)).exists && !(await treeOrder()).includes(IDLE.id), "空的目录组从快照 / order / 左栏一起消失");

// 删完刷新：桥那边真删了，两个组都不会自己长回来
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
const afterReload = await treeOrder();
ok(!afterReload.includes(EMPTY.id) && !afterReload.includes(IDLE.id), `刷新后两个空组也没回来（${afterReload.length} 组）`);

// 20d) 删掉的要是当前组：页面落到相邻组（右邻优先），不留在空白页
//      页面上删不掉自己的组（有会话就拦），所以这里模拟「别的客户端 / 上一秒的快照」把它删了：
//      桩桥直接广播一份没有它的快照，和真桥 `ws.drop` 的广播同一个形状（keys 不动，会话因此没了归属）。
await page.goto(`${BASE}/#/s/s-04-1`, { waitUntil: "networkidle" });
await sleep(700);
s = await barState();
ok(s.onWs === "f:/proj-04", `先站到 proj-04（当前 ${s.onWs}）`);
WS.groups = WS.groups.filter((g) => g.id !== "f:/proj-04");
WS.order = WS.order.filter((id) => id !== "f:/proj-04");
cast();
await sleep(900);
s = await barState();
ok(s.onWs === "f:/proj-05", `当前组没了：落到右邻 proj-05（当前 ${s.onWs}）`);
ok((await page.evaluate(() => location.hash)) === "#/s/s-05-1", "落点是右邻那颗会话");
ok((await page.locator(".session-card").count()) > 0, "页面上有卡片，不是空白页");

await page.close();

// 21) #278 按目录新建：对话框两栏、这里徽标、已有目录「带你过去」、新目录就地建组并切过去
// 摆回一份干净快照（#279 段删过组、挪过会话），再给每个目录组补一层「空目录」的桩。
for (const g of GROUPS) g.inRow = true;
WS.groups = GROUPS.map((g) => ({ ...g }));
WS.order = GROUPS.map((g) => g.id);
WS.max = 10;
byId("s-01-1").ws = "f:/proj-01";
byId("s-09-1").ws = "f:/proj-09";
DIRS.set("f:/", { path: "F:/", parent: "", dirs: [...GROUPS.map((g) => g.key.split("/").pop()), "fresh-app", "broken"] });
for (const g of GROUPS) DIRS.set(g.key.toLowerCase(), { path: g.key, parent: "F:/", dirs: [] });
DIRS.set("f:/fresh-app", { path: "F:/fresh-app", parent: "F:/", dirs: [] });
DIRS.set("f:/broken", { path: "F:/broken", parent: "F:/", dirs: [] });
// 新桥才有的能力：hello 的 `caps` 带上 `ws.create.dir` 之后，＋ 才走「挑目录」。
CAPS.push("ws.create.dir");
cast();
page = await open(null);
await sleep(700);

const toastText = () => page.evaluate(() => document.querySelector(".fail-toast")?.textContent ?? "");
/** 对话框此刻的样子：标题、左栏每一行（带不带「这里」）、脚注、按钮、面包屑、目录行。 */
const wsNewState = () =>
  page.evaluate(() => {
    const sheet = document.querySelector(".ws-new-sheet");
    if (!sheet) return null;
    return {
      title: sheet.querySelector(".sheet-title")?.textContent ?? "",
      side: [...sheet.querySelectorAll(".ws-new-side .ws-new-pick")].map((n) => ({
        id: n.dataset.ws ?? "",
        name: n.querySelector(".m-name")?.textContent ?? "",
        here: n.querySelector(".ws-here")?.textContent ?? "",
      })),
      note: sheet.querySelector(".ws-new-note")?.textContent ?? "",
      primary: sheet.querySelector(".sheet-foot .btn.primary")?.textContent ?? "",
      disabled: Boolean(sheet.querySelector(".sheet-foot .btn.primary")?.disabled),
      crumbs: [...sheet.querySelectorAll(".ws-new-dir .crumb")].map((n) => n.textContent ?? ""),
      rows: [...sheet.querySelectorAll(".ws-new-dir .dir-row")].map((n) => (n.textContent ?? "").replace(/^\u{1F4C1}/u, "").trim()),
    };
  });

const createsA = createCalls();
await page.click(".ws-tabs-add");
await sleep(600);
let ns = await wsNewState();
ok(Boolean(ns), "新桥：点 ＋ 打开「按目录新建」对话框");
ok(ns?.title === "新建工作区 · 选一个目录", `标题是「${ns?.title}」`);
ok(ns?.side.length === 9, `左栏列出 9 个已有工作区（${ns?.side.length} 行）`);
ok(
  ns?.side[0].here === "这里" && ns.side.slice(1).every((r) => r.here === ""),
  `当前工作区标「这里」，别的不标（${ns?.side.map((r) => r.here || "-").join(" ")}）`,
);
ok(/这个目录已经在列表里：proj-01/.test(ns?.note ?? ""), `起点就是当前目录：说明会带你过去（${ns?.note}）`);
ok(ns?.primary === "带你过去" && !ns?.disabled, `已有目录时按钮是「${ns?.primary}」`);
ok((await page.locator(".ws-new-dir .dir-filter").count()) === 1, "右侧是真目录浏览（筛选框在）");
ok(createCalls() === createsA, "只是打开对话框，没发 ws.create");

// 21a) 左栏点一行 = 目录跳过去；已有目录只「带你过去」，不发创建
await page.click('.ws-new-side .ws-new-pick[data-ws="f:/proj-02"]');
await sleep(600);
ns = await wsNewState();
ok(ns?.crumbs.includes("proj-02"), `点左栏那一行，目录跳到 proj-02（${ns?.crumbs.join(" / ")}）`);
ok(/这个目录已经在列表里：proj-02/.test(ns?.note ?? "") && ns?.primary === "带你过去", "还是已有目录：按钮仍「带你过去」");
await page.click(".ws-new-sheet .sheet-foot .btn.primary");
await sleep(700);
s = await barState();
ok(createCalls() === createsA, `「带你过去」不发 ws.create（${createCalls() - createsA} 条）`);
ok((await wsNewState()) === null, "对话框关掉");
ok(/这个工作区已经在列表里/.test(await toastText()), `提示「这个工作区已经在列表里」（${(await toastText()).trim()}）`);
ok(s.onWs === "f:/proj-02" && (await page.evaluate(() => location.hash)) === "#/s/s-02-1", `切到了 proj-02（${s.onWs}）`);

// 21b) 选新目录：按钮变「就在这里新建」，建完直接切过去、不进改名态
await page.click(".ws-tabs-add");
await sleep(600);
ns = await wsNewState();
ok(ns?.crumbs.includes("proj-02") && ns?.primary === "带你过去", "再打开：从当前目录 proj-02 起步");
await page.click('.ws-new-dir .crumb:has-text("F:")');
await sleep(500);
ns = await wsNewState();
ok(ns?.rows.includes("fresh-app") && ns?.rows.includes("broken"), `F:/ 下面看得见 fresh-app 与 broken（${ns?.rows.join(" / ")}）`);
const createsB = createCalls();
await page.click('.ws-new-dir .dir-row:has-text("fresh-app")');
await sleep(500);
ns = await wsNewState();
ok(/将新建：fresh-app/.test(ns?.note ?? ""), `新目录：说明将新建（${ns?.note}）`);
ok(ns?.primary === "就在这里新建" && !ns?.disabled, `按钮变成「${ns?.primary}」`);
await page.click(".ws-new-sheet .sheet-foot .btn.primary");
await sleep(900);
s = await barState();
const dirMsg = CALLS.filter((c) => c.action === "ws.create").at(-1);
ok(
  createCalls() === createsB + 1 && String(dirMsg?.dir ?? "").toLowerCase() === "f:/fresh-app",
  `发一条带 dir 的 ws.create（${dirMsg?.dir ?? "没有 dir"}）`,
);
ok((await wsNewState()) === null, "建完对话框关掉");
ok(WS.order.at(-1) === "f:/fresh-app", `新组追加到 order 末尾（${WS.order.at(-1)}）`);
const freshGroup = WS.groups.find((g) => g.id === "f:/fresh-app");
ok(freshGroup?.inRow === true && freshGroup?.name === "", "新组在横条里、名字留给目录名");
ok((await page.locator(".ws-rename-input").count()) === 0, "没有进改名态");
ok(s.onWs === "f:/proj-02", `空组没有会话可开，当前会话不变（${s.onWs}）`);
const freshRow = await page.evaluate(() => {
  const sec = document.querySelector('.ws-sec[data-ws="f:/fresh-app"]');
  if (!sec) return null;
  const r = sec.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, inView: r.top >= 0 && r.bottom <= window.innerHeight };
});
ok(freshRow?.inView === true, `左栏把新组那一行滚到眼前（${freshRow ? `${Math.round(freshRow.top)}–${Math.round(freshRow.bottom)}px` : "没找到"}）`);
ok((await page.locator('.ws-sec[data-ws="f:/fresh-app"] .ws-empty').count()) === 1, "左栏看得见这个空组");

// 21c) 别的客户端刚建过同一个目录：本页快照还旧，按下去桥只回 created:false —— 带 id 切过去，别说又建了一个
const stale = workspace();
stale.groups = stale.groups.filter((g) => g.id !== "f:/fresh-app");
stale.order = stale.order.filter((id) => id !== "f:/fresh-app");
for (const client of wss.clients) {
  if (client.readyState === 1) client.send(JSON.stringify({ type: "workspaces", workspace: stale }));
}
await sleep(400);
await page.goto(`${BASE}/#/s/s-09-1`, { waitUntil: "networkidle" });
await sleep(500);
await page.click(".ws-tabs-add");
await sleep(600);
ns = await wsNewState();
ok(Boolean(ns) && ns.side.every((r) => r.id !== "f:/fresh-app"), "旧快照：对话框左栏里还没有 fresh-app");
await page.click('.ws-new-dir .crumb:has-text("F:")');
await sleep(500);
const createsC = createCalls();
await page.click('.ws-new-dir .dir-row:has-text("fresh-app")');
await sleep(500);
await page.click(".ws-new-sheet .sheet-foot .btn.primary");
await sleep(900);
ok(createCalls() === createsC + 1, "旧快照下会发 ws.create（客户端不知道它已经存在）");
ok(/这个工作区已经在列表里/.test(await toastText()), "桥回 created:false：提示「这个工作区已经在列表里」");
ok(WS.groups.filter((g) => g.id === "f:/fresh-app").length === 1, "桥里仍然只有一个 fresh-app");
ok((await wsNewState()) === null, "created:false 也把对话框关掉");

// 21d) 桥拒绝：只在对话框里说一声 —— 不建半个组、不切走、按钮能重试
await page.click(".ws-tabs-add");
await sleep(600);
await page.click('.ws-new-dir .crumb:has-text("F:")');
await sleep(500);
await page.click('.ws-new-dir .dir-row:has-text("broken")');
await sleep(500);
ns = await wsNewState();
ok(/将新建：broken/.test(ns?.note ?? ""), "broken 也能选（页面不替桥做主）");
const createsD = createCalls();
const groupsBefore = WS.groups.length;
await page.click(".ws-new-sheet .sheet-foot .btn.primary");
await sleep(900);
ns = await wsNewState();
ok(Boolean(ns), "失败后对话框还开着（不把人踢走）");
ok(/打不开这个目录/.test(await toastText()), `提示说清原因（${(await toastText()).trim()}）`);
ok(createCalls() === createsD + 1 && WS.groups.length === groupsBefore, "发了 ws.create，但桥里没多出半个组");
ok(WS.groups.every((g) => g.id !== "f:/broken"), "broken 没进快照");
ok((await barState()).onWs === "f:/proj-09", "当前工作区没变");
ok(ns?.primary === "就在这里新建" && ns?.disabled === false, "按钮回到可点（可以重试）");

// 21e) 旧桥（hello 里没有 caps）：＋ 退回「空壳组 + 就地改名」，不摆一张点了会坏的对话框
await page.click(".ws-new-sheet .sheet-foot .btn.ghost");
await sleep(300);
ok((await wsNewState()) === null, "取消关掉对话框");
CAPS.length = 0;
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(600);
const createsE = createCalls();
await page.click(".ws-tabs-add");
await sleep(800);
ok((await wsNewState()) === null, "旧桥：点 ＋ 不打开目录对话框");
const oldMsg = CALLS.filter((c) => c.action === "ws.create").at(-1);
ok(createCalls() === createsE + 1 && oldMsg?.name === "" && oldMsg?.dir === undefined, "旧桥：还是发空名 ws.create（没有 dir）");
a = await addState();
ok(a.editing && a.placeholder === "新工作区", "旧桥：新组照样就地改名");
await page.keyboard.press("Escape");
await sleep(300);
await page.close();

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `
${bad} FAILURE(S)` : `
all checks passed`);
process.exitCode = bad ? 1 : 0;
