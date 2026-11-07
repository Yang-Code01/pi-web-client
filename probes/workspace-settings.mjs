/**
 * Probe: #176 设置面板的「标签行」——「最多显示」步进器（1–12、默认 6）。
 *
 * 票面要的是：标签「最多显示」、初值来自桥端快照、范围 1–12、到 1 / 12 时对应按钮置灰、旁注一句
 * 「横条最多放 N 个，装不下的收进 ＋N」且 N 跟着当前值变；步进即时发 `ws.tabs { max }`，标签行
 * 立刻跟着少画 / 多画；调到 8 刷新后还是 8；设置里不再有「固定组」勾选块和它的旧提示。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs` 落到内存里再广播（名额 clamp 1–12）
 * —— 于是刷新页面拿到的就是「重启后的桥」，人和标签行看的是同一份。
 *
 * Run: npm run build:web && PI_WEB_PORT=7934 node probes/workspace-settings.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.NOWCHIP_DIST ? path.resolve(process.env.NOWCHIP_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.SETTINGS_SHOT ?? "workspace-settings";
const PORT = Number(process.env.PI_WEB_PORT ?? 7934);
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
// 组序 = order 的前 9 颗：01→09，标签行预期能直接按这份顺序写出来。
const SESSIONS = GROUPS.map((g, i) => ({
  ...state(`s-${g.id.slice(-2)}-1`, `工程 ${g.id.slice(-2)} · 会话 1`, g.key, g.id),
  updatedAt: Date.UTC(2026, 0, 1) - i * 1000,
}));
const byId = (id) => SESSIONS.find((s) => s.id === id);

// 桥端权威值：顺序与名额都存在这里（刷新 = 重启后的桥，同一份内存）。新桥默认 6。
const WS = {
  groups: GROUPS,
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
  order: GROUPS.map((g) => g.id),
  max: 6,
};
const workspace = () => ({ ...WS, groups: WS.groups.map((g) => ({ ...g })), order: [...WS.order] });
/** 桥收到过的 manage 动作（要核对发了几条、带了哪些字段）。 */
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
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "manage") {
        CALLS.push(msg);
        // 真桥的 `setTabs()`：名额 clamp 到 1–12，一次落盘再广播（#176）。
        if (msg.action === "ws.tabs") {
          if (msg.max !== undefined) {
            const m = Number(msg.max);
            if (Number.isInteger(m) && m >= 1 && m <= 12) WS.max = m;
          }
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

/** 设置面板里「标签行」这一块 + 标签行本身的状况。 */
const paneState = () =>
  page.evaluate(() => {
    const hint = document.querySelector(".ws-max-hint");
    const btn = (act) => document.querySelector(`.ws-max-btn[data-act="${act}"]`);
    const sheet = document.querySelector(".display-sheet");
    const more = document.querySelector(".ws-tabs-more");
    return {
      open: Boolean(sheet),
      n: document.querySelector(".ws-max-n")?.textContent ?? "",
      downOff: Boolean(btn("ws-max-down")?.disabled),
      upOff: Boolean(btn("ws-max-up")?.disabled),
      hint: hint?.textContent ?? "",
      label: document.querySelector(".ws-max-label")?.textContent ?? "",
      fixedRows: document.querySelectorAll(".ws-fixed-row").length,
      sheetText: sheet?.textContent ?? "",
      leftOrder: [...document.querySelectorAll(".ws-sec[data-ws]")].map((n) => n.dataset.ws ?? ""),
      tabs: [...document.querySelectorAll(".ws-tab")].map((n) => n.dataset.ws ?? ""),
      moreText: more?.textContent ?? "",
      moreHidden: Boolean(more?.hidden),
    };
  });

async function open() {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${BASE}/#/s/s-01-1`, { waitUntil: "networkidle" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(700);
  return page;
}

const page = await open();
const openSheet = async () => {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet .ws-max-row", { timeout: 5000 });
  await sleep(250);
};
const lastTabs = () => CALLS.filter((c) => c.action === "ws.tabs").at(-1) ?? null;
const tabsSent = () => CALLS.filter((c) => c.action === "ws.tabs").length;
const stepMax = async (dir, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.locator(`.ws-max-btn[data-act="ws-max-${dir}"]`).click({ force: true });
    await sleep(300);
  }
};
const IDS = GROUPS.map((g) => g.id);

// 1) 面板：标签「最多显示」，初值来自桥端（6），范围 1–12，旁注随当前值，旧「固定组」块不在
await openSheet();
let s = await paneState();
ok(s.open, "点 Aa 打开「外观与语言」，里面有「标签行」这一块");
ok(s.label === "最多显示", `步进器标签是「最多显示」（${s.label}）`);
ok(s.n === "6", `步进器初值来自桥端快照（${s.n}）`);
ok(!s.downOff && !s.upOff, "在 6 的两边都能点：两颗都没置灰");
ok(s.hint === "横条最多放 6 个，装不下的收进 ＋N", `旁注写清最多放几个、装不下的去哪（${s.hint}）`);
ok(s.fixedRows === 0 && !s.sheetText.includes("固定组") && !s.sheetText.includes("固定名额"), "设置里不再有「固定组」勾选块 / 旧文案");
ok(JSON.stringify(s.tabs) === JSON.stringify(IDS.slice(0, 6)), `标签行按 order 画前 6 颗（${s.tabs.join(" / ")}）`);
ok(!s.moreHidden && s.moreText === "＋3", `装不下的 3 个收进 ＋N（${s.moreText}）`);
ok(JSON.stringify(s.leftOrder) === JSON.stringify(IDS), "左栏组序与 order 一致（九颗都在）");
fs.mkdirSync(path.join(REPO, ".scratch"), { recursive: true });
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-open.png`), clip: { x: 0, y: 0, width: 1000, height: 900 } });

// 2) 减到 1：即时发 ws.tabs { max: 1 }（不带 pinned），标签行立刻只剩 1 颗，减号置灰
await stepMax("down", 5);
s = await paneState();
let last = lastTabs();
ok(last?.max === 1 && last?.pinned === undefined, `名额减到 1：发的是 ws.tabs { max: 1 }（${JSON.stringify(last)}）`);
ok(s.n === "1" && s.downOff && !s.upOff, `到 1 就到底：步进器显示 1、减号置灰（${s.n} / ${s.downOff}）`);
ok(s.tabs.length === 1 && s.moreText === "＋8", `标签行立刻只剩 1 颗、＋N 报 8（${s.tabs.length} / ${s.moreText}）`);
ok(s.hint === "横条最多放 1 个，装不下的收进 ＋N", `旁注跟着变成 1（${s.hint}）`);
// 点在边界上那颗灰按钮：不发请求（点得动却没反应比灰着更让人怀疑）。
const sentAtEdge = tabsSent();
await page.locator('.ws-max-btn[data-act="ws-max-down"]').click({ force: true }).catch(() => {});
await sleep(250);
ok(tabsSent() === sentAtEdge, "点置灰的减号：没有再发 ws.tabs");

// 3) 加到 12：加号置灰；九颗全画出来，＋N 不出现
await stepMax("up", 11);
s = await paneState();
last = lastTabs();
ok(last?.max === 12, `名额加到 12：发的是 ws.tabs { max: 12 }（max = ${last?.max}）`);
ok(s.n === "12" && s.upOff && !s.downOff, `到 12 就到底：步进器显示 12、加号置灰（${s.n} / ${s.upOff}）`);
ok(s.tabs.length === 9 && s.moreHidden, `组只有 9 个：全画出来、＋N 收起（${s.tabs.length} / hidden=${s.moreHidden}）`);

// 4) 回到 8：标签行画 8 颗、＋N 报 1；刷新后名额与标签行都还在（桩桥在内存里持久化）
await stepMax("down", 4);
s = await paneState();
last = lastTabs();
ok(last?.max === 8 && s.n === "8", `名额落到 8（max = ${last?.max} / 显示 ${s.n}）`);
ok(JSON.stringify(s.tabs) === JSON.stringify(IDS.slice(0, 8)) && s.moreText === "＋1", `标签行画前 8 颗、＋N 报 1（${s.tabs.length} / ${s.moreText}）`);
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
await openSheet();
s = await paneState();
ok(s.n === "8", `刷新后名额还是 8（${s.n}）`);
ok(JSON.stringify(s.tabs) === JSON.stringify(IDS.slice(0, 8)), `刷新后标签行还是前 8 颗（${s.tabs.join(" / ")}）`);
ok(s.hint === "横条最多放 8 个，装不下的收进 ＋N", `刷新后旁注仍是 8（${s.hint}）`);

// 5) 名额 8 已满时切到圈外的组：前 7 颗 + 当前组，总数仍是 8（替位，不涨颗数）
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click();
await sleep(250);
await page.locator(".ws-tabs-more").click();
await sleep(200);
await page.locator(".ws-tabs-menu .pm-item").last().click();
await sleep(600);
s = await paneState();
const expect = [...IDS.slice(0, 7), IDS[8]];
ok(JSON.stringify(s.tabs) === JSON.stringify(expect), `切到圈外的组：前 7 颗 + 当前组、总数仍是 8（${s.tabs.join(" / ")}）`);
ok(!s.moreHidden && s.moreText === "＋1", `被替下的那颗进了 ＋N、计数不变（${s.moreText}）`);

await page.close();
await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
