/**
 * Probe: #123 设置面板的「标签行」——固定名额步进器 + 固定组勾选。
 *
 * 票面要的是：步进器范围 1–5、初值来自桥端、到边界那颗置灰；勾选列表顺序与左栏一致、每行带色点、
 * 勾满名额后其余行置灰并写明原因；名额调小导致超出时，桥在同一次写里截断，面板明确报出被取消了几个；
 * 勾选 / 调名额都立刻发 `ws.tabs`，标签行跟着变，刷新后设置与标签行都还在；面板不写「最多 N 个」。
 *
 * 桩桥照 #94 的协议发 `workspace` 快照，并像真桥那样把 `ws.tabs` 落到内存里再广播（名额 clamp 1–5，
 * 固定组去重 / 剔脏，并截到名额）—— 于是刷新页面拿到的就是「重启后的桥」，人和标签行看的是同一份。
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
// 组序「最近活动倒序」：01 最新 → 01→09，跟名字顺序一致 —— 左栏序与勾选列表预期能直接写出来。
const SESSIONS = GROUPS.map((g, i) => ({
  ...state(`s-${g.id.slice(-2)}-1`, `工程 ${g.id.slice(-2)} · 会话 1`, g.key, g.id),
  updatedAt: Date.UTC(2026, 0, 1) - i * 1000,
}));
const byId = (id) => SESSIONS.find((s) => s.id === id);

// 桥端权威值：名额与固定组都存在这里（刷新 = 重启后的桥，同一份内存）。
const WS = {
  groups: GROUPS,
  overrides: {},
  keys: Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws])),
  pinned: [],
  max: 3,
};
const workspace = () => ({ ...WS, groups: WS.groups.map((g) => ({ ...g })), pinned: [...WS.pinned] });
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
        // 真桥的 `setTabs()`：名额 clamp 到 1–5，列表去重 / 剔脏 / 截到名额，一次落盘再广播。
        if (msg.action === "ws.tabs") {
          if (msg.max !== undefined) WS.max = Math.min(5, Math.max(1, Math.trunc(Number(msg.max))));
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

/** 设置面板里「标签行」这一块 + 标签行本身的状况。 */
const paneState = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ws-pin-row")];
    const hint = document.querySelector(".ws-max-hint");
    const why = document.querySelector(".ws-pin-why");
    const note = document.querySelector(".ws-pin-note");
    const btn = (act) => document.querySelector(`.ws-max-btn[data-act="${act}"]`);
    const sheet = document.querySelector(".display-sheet");
    return {
      open: Boolean(sheet),
      n: document.querySelector(".ws-max-n")?.textContent ?? "",
      downOff: Boolean(btn("ws-max-down")?.disabled),
      upOff: Boolean(btn("ws-max-up")?.disabled),
      ids: rows.map((r) => r.dataset.ws ?? ""),
      names: rows.map((r) => r.querySelector(".ws-pin-name")?.textContent ?? ""),
      dots: rows.map((r) => getComputedStyle(r.querySelector(".ws-pin-dot")).backgroundColor),
      checked: rows.filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => r.dataset.ws ?? ""),
      disabled: rows.filter((r) => r.disabled).map((r) => r.dataset.ws ?? ""),
      hint: hint?.textContent ?? "",
      why: why?.textContent ?? "",
      note: note?.textContent ?? "",
      sheetText: sheet?.textContent ?? "",
      label: document.querySelector(".ws-pin-label")?.textContent ?? "",
      // 左栏的组序（勾选列表要跟它一致）。
      leftOrder: [...document.querySelectorAll(".ws-sec[data-ws]")].map((n) => n.dataset.ws ?? ""),
      // 标签行：画了哪几颗、＋N 报多少。
      tabs: [...document.querySelectorAll(".ws-tab")].map((n) => n.dataset.ws ?? ""),
      moreText: document.querySelector(".ws-tabs-more")?.textContent ?? "",
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

let page = await open();
const openSheet = async () => {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet .ws-pin-row", { timeout: 5000 });
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
const pinRow = (id) => page.locator(`.ws-pin-row[data-ws="${id}"]`);

// 1) 步进器：初值来自桥端（3），范围 1–5，边界那颗置灰
await openSheet();
let s = await paneState();
ok(s.open, "点 Aa 打开「外观与语言」，里面有「标签行」这一块");
ok(s.n === "3", `步进器初值来自桥端（${s.n}）`);
ok(!s.downOff && !s.upOff, "在 3 的两边都能点：两颗都没置灰");
ok(s.ids.length === 9, `勾选列表一行一个组（${s.ids.length} 行）`);
ok(JSON.stringify(s.ids) === JSON.stringify(s.leftOrder), `勾选列表顺序与左栏一致（${s.ids.join(" / ")}）`);
ok(s.names.every((x) => x.startsWith("客户")) && s.dots.every((c) => c !== "rgba(0, 0, 0, 0)"), "每行都有组名 + 色点");
ok(/前\s*3\s*个位置/.test(s.hint), `说明里写清前几个位置留给固定组（${s.hint}）`);
ok(!s.sheetText.includes("最多"), "面板不写「最多 N 个」这种绝对话术（当前组会破例多一颗）");
ok(s.note === "" && s.why === "", "刚打开时没有旧提示，也没有置灰原因（还有空位）");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-open.png`), clip: { x: 0, y: 0, width: 1000, height: 900 } });

// 2) 步进器即时发 ws.tabs { max }（不带 pinned），标签行跟着变；到 1 / 5 时对应的那颗置灰
await stepMax("down", 2);
s = await paneState();
let last = lastTabs();
ok(last?.max === 1 && last?.pinned === undefined, `名额减到 1：发的是 ws.tabs { max: 1 }（${JSON.stringify(last)}）`);
ok(s.n === "1" && s.downOff && !s.upOff, `到 1 就到底：步进器显示 1、减号置灰（${s.n} / ${s.downOff}）`);
ok(s.tabs.length === 1 && s.moreText === "＋8", `标签行立刻只剩 1 颗、＋N 报 8（${s.tabs.length} / ${s.moreText}）`);
await stepMax("up", 4);
s = await paneState();
last = lastTabs();
ok(last?.max === 5, `名额加到 5：发的是 ws.tabs { max: 5 }（max = ${last?.max}）`);
ok(s.n === "5" && s.upOff && !s.downOff, `到 5 就到底：步进器显示 5、加号置灰（${s.n} / ${s.upOff}）`);
ok(s.tabs.length === 5 && s.moreText === "＋4", `标签行跟着画 5 颗、＋N 报 4（${s.tabs.length} / ${s.moreText}）`);
// 点在边界上那颗灰按钮：不发请求（点得动却没反应比灰着更让人怀疑）。
const sentAtEdge = tabsSent();
await page.locator('.ws-max-btn[data-act="ws-max-up"]').click({ force: true }).catch(() => {});
await sleep(250);
ok(tabsSent() === sentAtEdge, "点置灰的加号：没有再发 ws.tabs");

// 3) 名额回到 3，勾三个组：每次即时发一整份 pinned 列表，标签行按勾选顺序排
await stepMax("down", 2);
s = await paneState();
ok(s.n === "3", `名额回到 3（${s.n}）`);
for (const id of ["f:/proj-05", "f:/proj-09", "f:/proj-03"]) {
  await pinRow(id).click();
  await sleep(350);
}
s = await paneState();
last = lastTabs();
const sorted = (list) => [...list].sort();
ok(
  JSON.stringify(last?.pinned) === JSON.stringify(["f:/proj-05", "f:/proj-09", "f:/proj-03"]),
  `勾选即时发 ws.tabs { pinned }，顺序 = 勾选顺序（${JSON.stringify(last?.pinned)}）`,
);
ok(last?.max === undefined, "勾选只写 pinned，不顺手把名额也写一遍");
// 勾选列表按左栏顺序排（R10），所以「勾着哪几个」按组序读出来是 03 / 05 / 09 这种顺序。
ok(JSON.stringify(sorted(s.checked)) === JSON.stringify(["f:/proj-03", "f:/proj-05", "f:/proj-09"]), `三行勾着（${s.checked.join(" / ")}）`);
ok(
  JSON.stringify(s.tabs) === JSON.stringify(["f:/proj-05", "f:/proj-09", "f:/proj-03", "f:/proj-01"]),
  `标签行立刻按勾选顺序排 + 圈外的当前组多一颗（${s.tabs.join(" / ")}）`,
);

// 4) 勾满名额：其余几行置灰并写明原因，点了也不发请求
ok(JSON.stringify(s.disabled) === JSON.stringify(["f:/proj-01", "f:/proj-02", "f:/proj-04", "f:/proj-06", "f:/proj-07", "f:/proj-08"]), `其余 6 行置灰（${s.disabled.length} 行）`);
ok(s.why.includes("3"), `置灰原因写清名额是几个（${s.why}）`);
ok(!s.disabled.some((id) => s.checked.includes(id)), "勾着的三行没有一行被置灰（取消固定不受名额限制）");
const sentFull = tabsSent();
await pinRow("f:/proj-07").click({ force: true }).catch(() => {});
await sleep(250);
ok(tabsSent() === sentFull && JSON.stringify((await paneState()).checked) === JSON.stringify(s.checked), "点置灰的行：没发请求，勾选没变");
// 取消一个勾：立刻空出位置，置灰的那几行重新可点
await pinRow("f:/proj-09").click();
await sleep(350);
s = await paneState();
ok(
  JSON.stringify(sorted(s.checked)) === JSON.stringify(["f:/proj-03", "f:/proj-05"]),
  `取消勾选后只剩两个（${s.checked.join(" / ")}）`,
);
ok(s.disabled.length === 0 && s.why === "", "名额空出一个：其余行重新可点，原因也收了");
ok(
  JSON.stringify(s.tabs) === JSON.stringify(["f:/proj-05", "f:/proj-03", "f:/proj-01"]) && s.moreText === "＋6",
  `标签行跟着剩两个 + 圈外那颗 + ＋6（${s.tabs.join(" / ")} / ${s.moreText}）`,
);
// 勾回来，凑满 3 个做截断
await pinRow("f:/proj-09").click();
await sleep(350);
s = await paneState();
ok(s.checked.length === 3, `重新勾满 3 个（${s.checked.length}）`);

// 5) 名额调小 → 桥截断 + 面板明确报出「取消了几个」，标签行跟着缩
await stepMax("down", 1);
s = await paneState();
last = lastTabs();
ok(last?.max === 2 && last?.pinned === undefined, `名额减到 2 只写 max，截断由桥在同一次写里做（${JSON.stringify(last)}）`);
ok(s.n === "2", `步进器显示 2（${s.n}）`);
ok(/取消/.test(s.note) && /1/.test(s.note), `面板明确报出被取消了 1 个（${s.note}）`);
ok(
  JSON.stringify(sorted(s.checked)) === JSON.stringify(["f:/proj-03", "f:/proj-05"]) && !s.checked.includes("f:/proj-09"),
  `超出名额的那个自动取消（剩下 ${s.checked.join(" / ")}）`,
);
ok(
  JSON.stringify(s.tabs) === JSON.stringify(["f:/proj-05", "f:/proj-03", "f:/proj-01"]) && s.moreText === "＋6",
  `标签行跟着缩到两个 + 圈外那颗 + ＋6（${s.tabs.join(" / ")} / ${s.moreText}）`,
);
ok(s.why.includes("2"), `名额 2 已满：置灰原因跟着更新（${s.why}）`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-shrink.png`), clip: { x: 0, y: 0, width: 1000, height: 900 } });

// 6) 刷新：设置（名额 + 勾选）与标签行都还在（桥落库了 —— 桩桥在内存里持久化）
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(700);
await openSheet();
s = await paneState();
ok(s.n === "2", `刷新后名额还是 2（${s.n}）`);
ok(JSON.stringify(sorted(s.checked)) === JSON.stringify(["f:/proj-03", "f:/proj-05"]), `刷新后固定组还在（${s.checked.join(" / ")}）`);
ok(
  JSON.stringify(s.tabs) === JSON.stringify(["f:/proj-05", "f:/proj-03", "f:/proj-01"]),
  `刷新后标签行还是那两个固定组 + 圈外那颗（${s.tabs.join(" / ")}）`,
);
ok(s.note === "", "刷新后不带上一轮那句提示（它不是常驻规矩）");

// 7) 当前组在圈外且名额已满：设置不误导 —— 标签行会多画一颗（面板文案没有「最多」兜着）
await page.locator(".display-sheet .btn:has-text(\"关闭\")").click();
await sleep(250);
await page.locator('.ws-tabs-more').click();
await sleep(200);
await page.locator(".ws-tabs-menu .pm-item").first().click();
await sleep(600);
s = await paneState();
ok(
  s.tabs.length === 3 && s.tabs[0] === "f:/proj-05" && s.tabs[1] === "f:/proj-03" && !s.checked.includes(s.tabs[2]),
  `名额 2 已满时切到圈外的组：固定组照旧，当前组被破例多画一颗（${s.tabs.join(" / ")}）`,
);

await page.close();
await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
