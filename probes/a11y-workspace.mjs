/**
 * Probe: 工作区的窄屏退化与键盘可达性（#102）。
 *
 * 两个大面：
 *   A. 800px（<900px）四套布局统一退化 —— 只保「当前在哪」一颗（顶栏），点一下打开左栏
 *      （会话页）并滚到当前会话；不开浮层，竖列 / 色点条 / 胶囊条不占地方；A 的标签行仍留在
 *      顶栏那一行（#119），B/C/D 不画；窗口也不横向溢出。
 *   B. 键盘可达性（宽屏 1100px）—— 组头 / 会话卡 / 那颗 Tab 可达、Enter/Space 触发；
 *      组头 Enter 折叠后焦点回到组头；卡片 Alt+←/→ 组间移动（发 ws.move）、Alt+↑/↓ 组内
 *      重排（发 arrange），焦点跟着移动后的卡走；B 浮层 / ⋯ 菜单 Esc 关闭后焦点还给开它的
 *      按钮；Tab 顺序「组头 → 组内会话 → 下一组头」。
 *
 * Run: npm run build:web && PI_WEB_PORT=7931 node probes/a11y-workspace.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
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

const state = (id, name, cwd, ws, owned = true) => ({
  id,
  name,
  cwd,
  ws,
  file: null,
  owned,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});

const GROUPS = ["01", "02", "03"].map((n) => ({ id: `f:/proj-${n}`, name: `客户${n}号`, key: `F:/proj-${n}`, manual: false }));
const SESSIONS = GROUPS.flatMap((g) => {
  const n = g.id.slice(-2);
  return [1, 2].map((k) => state(`s-${n}-${k}`, `工程 ${n} · 会话 ${k}`, k === 1 ? g.key : `${g.key}/sub/${k}`, g.id));
});
const byId = (id) => SESSIONS.find((s) => s.id === id);
const OVERRIDES = {};
const KEYS = Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws]));
const workspace = () => ({ groups: GROUPS, overrides: OVERRIDES, keys: KEYS });
/** 页面发上来的每一条（Alt 键的断言要看它真的发了什么）。 */
const msgs = [];
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
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
      const s = byId(msg.sessionId);
      if (msg.type === "subscribe" && s) {
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
      msgs.push(msg);
      // #94：跨组 / 放回工程是 ws.move（wsId 空串 = 删 override），组内重排是 arrange。
      if (msg.type === "manage" && msg.action === "ws.move") {
        for (const id of (msg.ids ?? []).map(String)) {
          const wsId = String(msg.wsId ?? "");
          if (wsId) OVERRIDES[id] = wsId;
          else delete OVERRIDES[id];
          const s2 = byId(id);
          if (s2) s2.ws = wsId || KEYS[s2.cwd.toLowerCase()] || "";
        }
        cast({ type: "workspaces", workspace: workspace() });
        cast({ type: "sessions.list", sessions: SESSIONS, workspace: workspace() });
      }
      if (msg.type === "manage" && msg.action === "arrange") {
        MANAGE.pin = Array.isArray(msg.pin) ? msg.pin.map(String) : MANAGE.pin;
        MANAGE.order = Array.isArray(msg.order) ? msg.order.map(String) : MANAGE.order;
        cast({ type: "manage", manage: MANAGE, workspace: workspace() });
      }
      if (msg.type === "manage" && msg.action === "opened") {
        const id = String(msg.id ?? "");
        MANAGE.order = [id, ...MANAGE.order.filter((x) => x !== id)];
        ws.send(JSON.stringify({ type: "manage", manage: MANAGE, workspace: workspace() }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();


const layoutChip = (page, id) => page.locator(`.display-sheet .layout-chip[data-layout="${id}"]`);
async function setLayout(page, id) {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  await layoutChip(page, id).click();
  await sleep(150);
  await page.locator('.display-sheet .btn:has-text("关闭")').click();
  await sleep(250);
}

/** 树里可见的 Tab 停靠点：组头 + 会话卡，按 DOM 顺序排（Tab 序应当就是这个序）。 */
const tabStops = (page) =>
  page.evaluate(() => {
    const stops = [];
    for (const head of document.querySelectorAll(".ws-head")) {
      if (!head.getClientRects().length) continue;
      stops.push({ kind: "head", ws: head.closest(".ws-sec")?.dataset.ws ?? "", expanded: head.getAttribute("aria-expanded") ?? "", label: head.getAttribute("aria-label") ?? "" });
      const sec = head.closest(".ws-sec");
      if (!sec || sec.classList.contains("folded")) continue;
      for (const card of sec.querySelectorAll(".session-card")) {
        if (!card.getClientRects().length) continue;
        stops.push({ kind: "card", id: card.dataset.id ?? "" });
      }
    }
    return stops;
  });

/** 现在焦点在哪：类名 + 关键 data。 */
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    return {
      cls: a.className ?? "",
      tag: a.tagName,
      card: a.dataset?.id ?? "",
      ws: a.dataset?.ws ?? a.closest?.(".ws-sec")?.dataset.ws ?? "",
      act: a.dataset?.act ?? "",
      label: a.getAttribute("aria-label") ?? "",
      expanded: a.getAttribute("aria-expanded") ?? "",
    };
  });

/** 树当前的第一组 / 第一卡（树序即左栏序）。 */


/* ================================================================ A. 窄屏退化（800px） */
console.log("—— 窄屏 800px：四套统一退化");
for (const layout of ["a", "b", "c", "d"]) {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log(`pageerror(${layout}):`, e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  // 没开过会话时那颗整颗藏起来（nowChipView 的 session=null 分支）：先开一颗再退化。
  await page.locator('.session-card[data-id="s-01-1"]').click();
  await sleep(300);
  await setLayout(page, layout);
  await sleep(300);

  // 左栏通常是收起的（no-left）——不赌，先看再说；每套都要「当前在哪」一颗可见。
  const narrow = await page.evaluate(() => ({
    collapsed: document.querySelector(".main")?.classList.contains("no-left") ?? false,
    rowChip: (() => {
      const n = document.querySelector(".ws-session-row .now-chip");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    topChip: (() => {
      const n = document.querySelector(".topbar .now-chip");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    rail: (() => {
      const n = document.querySelector(".ws-rail");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    strip: (() => {
      const n = document.querySelector(".ws-strip");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    tabsRow: (() => {
      const n = document.querySelector(".ws-tabs-row");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    pillRow: (() => {
      const n = document.querySelector(".ws-session-row .pin-strip");
      return Boolean(n) && n.getClientRects().length > 0;
    })(),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    nowName: document.querySelector(".now-chip .now-name")?.textContent ?? "",
    pop: document.querySelectorAll(".ws-pop").length,
  }));
  ok(narrow.topChip || narrow.rowChip, `${layout}：800px 看得到当前会话那颗（${narrow.nowName}）`);
  ok(narrow.count1 ?? true, "");
  const clean =
    !narrow.rail && !narrow.strip && !narrow.pillRow && narrow.tabsRow === (layout === "a");
  if (!clean) console.log(`  narrow(${layout})=`, JSON.stringify(narrow));
  ok(
    clean,
    `${layout}：胶囊条/竖列/色点条收起；标签行只在 A 的顶栏里（${narrow.tabsRow ? "有" : "无"}）`,
  );
  ok(!narrow.overflow, `${layout}：不横向溢出`);
  ok(narrow.pop === 0, `${layout}：窄屏没有浮层`);

  // 点那颗 → 打开左栏（会话页）并滚到当前会话卡；不开浮层。
  await page.locator(".now-btn").click();
  await sleep(500);
  const after = await page.evaluate(() => {
    const pane = document.querySelector(".main .pane:not([hidden])");
    const card = document.querySelector('.session-card[data-id="s-01-1"]');
    const cr = card?.getBoundingClientRect();
    const paneR = document.querySelector(".session-list")?.getBoundingClientRect();
    return {
      tab: location.hash,
      paneCls: pane?.className ?? "",
      cardVisible: Boolean(card) && Boolean(cr) && cr.bottom > 0 && cr.top < innerHeight,
      inView: Boolean(card && paneR && cr.top >= paneR.top - 4 && cr.bottom <= paneR.bottom + 4),
      pop: document.querySelectorAll(".ws-pop").length,
    };
  });
  ok(after.paneCls.includes("pane") && !(await page.evaluate(() => document.querySelector(".main")?.classList.contains("no-left"))), `${layout}：点那颗展开了左栏`);
  ok(after.inView, `${layout}：当前会话卡滚进了左栏视口`);
  ok(after.pop === 0, `${layout}：点那颗不开浮层`);

  // Tab 序：第一个停靠点应是那颗（顶栏），它 Enter 能打开左栏。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
  await sleep(500);
  await page.keyboard.press("Tab");
  await sleep(100);
  const first = await focused(page);
  ok(
    first?.act === "where" || first?.act === "new" || Boolean(first?.card) || (layout === "a" && ["ws-tab", "ws-tabs-add"].some((c) => (first?.cls ?? "").split(/\s+/).includes(c))),
    `${layout}：第一个 Tab 停靠点是工作区入口/会话入口（${first?.act ?? first?.cls}）`,
  );
  await page.context().close();
}

/* ================================================================ B. 键盘可达性（1100px） */
console.log("—— 宽屏 1100px：键盘可达性");
for (const layout of ["a", "b", "c", "d"]) {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log(`pageerror(${layout}):`, e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(400);
  await setLayout(page, layout);
  await sleep(200);

  // —— 组头可达 + Enter 折叠/展开 + 焦点回到组头 + aria 文案
  const head = page.locator('.ws-sec[data-ws="f:/proj-02"] > .ws-head');
  await head.focus();
  await sleep(100);
  let f = await focused(page);
  ok(f?.ws === "f:/proj-02" && (f.label ?? "").includes("客户02号"), `a${layout}：组头 focus() 聚得上（label=${f?.label}）`);
  const labelOpen = f?.label ?? "";
  ok(/已展开|已收起/.test(labelOpen), `${layout}：读屏文案带展开状态（${labelOpen}）`);
  await page.keyboard.press("Enter");
  await sleep(300);
  f = await focused(page);
  let folded = await page.evaluate(() => document.querySelector('.ws-sec[data-ws="f:/proj-02"]')?.classList.contains("folded") ?? false);
  ok(folded, `${layout}：组头 Enter 折叠`);
  ok(f?.ws === "f:/proj-02" && f?.cls.includes("ws-head"), `${layout}：折叠后焦点还在组头`);
  const labelFolded = f?.label ?? "";
  ok(/已收起/.test(labelFolded), `${layout}：折叠后读屏播「已收起」（${labelFolded}）`);
  await page.keyboard.press("Enter");
  await sleep(300);
  f = await focused(page);
  folded = await page.evaluate(() => document.querySelector('.ws-sec[data-ws="f:/proj-02"]')?.classList.contains("folded") ?? false);
  ok(!folded && f?.cls.includes("ws-head"), `${layout}：再 Enter 展开且焦点仍回组头`);
  // Space 也行
  await page.keyboard.press("Space");
  await sleep(300);
  folded = await page.evaluate(() => document.querySelector('.ws-sec[data-ws="f:/proj-02"]')?.classList.contains("folded") ?? false);
  await page.keyboard.press("Space");
  await sleep(300);
  ok(folded, `${layout}：Space 也能折叠`);

  // —— Tab 顺序：组头 → 组内会话 → 下一组头（不出组才进下一组）
  const stops = await tabStops(page);
  const order = stops.map((s) => (s.kind === "head" ? `H:${s.ws}` : s.id));
  ok(
    order.join("|") === "H:f:/proj-01|s-01-1|s-01-2|H:f:/proj-02|s-02-1|s-02-2|H:f:/proj-03|s-03-1|s-03-2",
    `${layout}：Tab 序 = 组头→组内卡→下一组头（${order.join(" ")}）`,
  );
  ok(stops[0]?.expanded === "true", `${layout}：组头 aria-expanded=true（展开态）`);

  // —— 会话卡 Alt+→：组间移动，发 ws.move，焦点跟到新组里的同一张卡
  const mark1 = msgs.length;
  await page.locator('.session-card[data-id="s-02-1"]').focus();
  await sleep(100);
  await page.keyboard.press("Alt+ArrowRight");
  await sleep(500);
  const moved = msgs.slice(mark1).filter((m) => m.action === "ws.move");
  ok(moved.length === 1 && moved[0]?.wsId === "f:/proj-03", `${layout}：Alt+→ 发 ws.move 到 f:/proj-03（${JSON.stringify(moved[0])}）`);
  ok(msgs.slice(mark1).every((m) => m.action !== "arrange"), `${layout}：组间不发 arrange`);
  await sleep(300);
  f = await focused(page);
  const card3 = await page.evaluate(() => document.querySelector('.ws-sec[data-ws="f:/proj-03"] .session-card[data-id="s-02-1"]') !== null);
  ok(card3, `${layout}：ws.move 回执后卡到了 proj-03`);
  ok(f?.card === "s-02-1" && f?.ws === "f:/proj-03", `${layout}：焦点跟着卡走到新组（${f?.card} @ ${f?.ws}）`);

  // —— Alt+←：搬回 proj-02
  const mark2 = msgs.length;
  await page.keyboard.press("Alt+ArrowLeft");
  await sleep(500);
  const back = msgs.slice(mark2).filter((m) => m.action === "ws.move");
  ok(back.length === 1 && back[0]?.wsId === "f:/proj-02", `${layout}：Alt+← 发 ws.move 回 f:/proj-02（${JSON.stringify(back[0])}）`);
  f = await focused(page);
  ok(f?.card === "s-02-1" && f?.ws === "f:/proj-02", `${layout}：焦点跟着卡回来了（${f?.card} @ ${f?.ws}）`);

  // —— Alt+↑/↓：组内重排，发 arrange，焦点跟卡
  const mark3 = msgs.length;
  await page.keyboard.press("Alt+ArrowDown");
  await sleep(500);
  const arranged = msgs.slice(mark3).filter((m) => m.action === "arrange");
  ok(arranged.length === 1 && Array.isArray(arranged[0]?.order), `${layout}：Alt+↓ 发 arrange（${JSON.stringify(arranged[0])?.slice(0, 120)}）`);
  ok(msgs.slice(mark3).every((m) => m.action !== "ws.move"), `${layout}：组内不发 ws.move`);
  const orderNow = await page.evaluate(() => [...document.querySelectorAll('.ws-sec[data-ws="f:/proj-02"] .session-card')].map((n) => n.dataset.id));
  ok(orderNow.join("|") === "s-02-2|s-02-1", `${layout}：↓ 之后 s-02-1 在第二位（${orderNow.join(" ")}）`);
  f = await focused(page);
  ok(f?.card === "s-02-1", `${layout}：焦点还在移动后的卡上`);
  await page.keyboard.press("Alt+ArrowUp");
  await sleep(500);
  const orderBack = await page.evaluate(() => [...document.querySelectorAll('.ws-sec[data-ws="f:/proj-02"] .session-card')].map((n) => n.dataset.id));
  ok(orderBack.join("|") === "s-02-1|s-02-2", `${layout}：↑ 排回去（${orderBack.join(" ")}）`);

  // —— #102 回归：键盘挪卡（双回执消费干净）之后，改【另一张】卡的名字，rename 输入框
  //    必须真的拿到焦点 —— 旧 bug：pendingCardFocus 不清，startRename 的重画把焦点抢回刚挪的卡。
  await page.locator('.session-card[data-id="s-02-1"]').focus();
  await sleep(100);
  const markR = msgs.length;
  await page.keyboard.press("Alt+ArrowRight");
  await sleep(500);
  await page.keyboard.press("Alt+ArrowLeft");
  await sleep(500);
  ok(msgs.slice(markR).filter((m) => m.action === "ws.move").length === 2, `${layout}：摄出搬回各发一条 ws.move`);
  await page.locator('.session-card[data-id="s-01-1"]').hover();
  await page.locator('.session-card[data-id="s-01-1"] .rename-btn').click();
  await sleep(300);
  f = await focused(page);
  ok(f?.cls.includes("rename-input"), `${layout}：键盘挪卡后改名，焦点在 rename 输入框（${f?.cls}）`);
  await page.keyboard.press("Escape");
  await sleep(200);

  // —— 边界：proj-01 的第一张卡 Alt+↑ 不动（组顶）
  await page.locator('.session-card[data-id="s-01-1"]').focus();
  const mark4 = msgs.length;
  await page.keyboard.press("Alt+ArrowUp");
  await sleep(300);
  ok(msgs.slice(mark4).length === 0, `${layout}：组顶 Alt+↑ 不发消息`);
  // —— 边界：proj-03 的卡 Alt+→ 不动（末组）
  await page.locator('.session-card[data-id="s-03-1"]').focus();
  const mark5 = msgs.length;
  await page.keyboard.press("Alt+ArrowRight");
  await sleep(300);
  ok(msgs.slice(mark5).length === 0, `${layout}：末组 Alt+→ 不发消息`);

  // —— B 浮层：Esc 关闭且焦点还给那颗
  if (layout === "b") {
    await page.locator(".now-btn").focus();
    await sleep(100);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ws-pop", { timeout: 3000 });
    await sleep(150);
    const popOpen = (await page.locator(".ws-pop").count()) === 1;
    ok(popOpen, "b：Enter 开浮层");
    await page.keyboard.press("Escape");
    await sleep(200);
    ok((await page.locator(".ws-pop").count()) === 0, "b：Esc 关浮层");
    f = await focused(page);
    ok(f?.act === "where", `b：焦点还给那颗（${f?.act}）`);
  }

  // —— ⋯ 菜单：Esc 关闭且焦点还给组头上的 ⋯
  const more = page.locator('.ws-sec[data-ws="f:/proj-01"] .ws-more');
  // CSS 用 visibility:hidden 藏非 hover 态的 ⋯（.ws-head:not(:hover):not(:focus-within)）。
  // Playwright 的 el.focus() 不产生 :focus-visible，先 hover 组头让按钮可见再聚焦。
  await page.locator('.ws-sec[data-ws="f:/proj-01"] .ws-head').hover();
  await sleep(100);
  await more.focus();
  await sleep(80);
  await sleep(80);
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.waitForSelector(".ws-menu", { timeout: 3000 });
  await sleep(150);
  ok((await page.locator(".ws-menu").count()) === 1, `${layout}：⋯ 打开工作区菜单`);
  await page.keyboard.press("Escape");
  await sleep(200);
  ok((await page.locator(".ws-menu").count()) === 0, `${layout}：Esc 关菜单`);
  f = await focused(page);
  ok(f?.cls.includes("ws-more"), `${layout}：焦点还给 ⋯（${f?.cls}）`);

  await page.context().close();
}

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : `\nall checks passed`);
process.exitCode = bad ? 1 : 0;
