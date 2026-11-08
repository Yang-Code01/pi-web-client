/**
 * Probe: 左栏树里的拖拽整理（#99）。
 *
 * 桩桥只认识三样东西：hello 里那份会话 / manage / workspace，`manage arrange`（重排），
 * `manage ws.move`（跨组 / 放回工程）。拖拽全部用 `page.mouse` 真拖（不用 dispatchEvent 造假），
 * 于是这一遍考到的是浏览器真的在发 dragstart / dragover / drop。
 *
 * 断言：
 *   1. 拖动时出现落点线，线的 dataset 指对组与插入位置（2px 一条）；
 *   2. 拖进别的组 → 只发一条 `ws.move`，刷新后仍在那个组；
 *   3. 组内重排 → 发 `arrange`，刷新后顺序记得；
 *   4. 拖到「放回工程」→ `ws.move` 且 `wsId` 是空串，刷新后按 cwd 回到原组；
 *   5. 空组也是落点；
 *   6. Esc / 窗口失焦 / 拖离树 → 高亮清掉，松手也不发消息；
 *   7. 树外（标签页行、竖列、图标条）没有任何可拖元素。
 *
 * Run: npm run build:web && PI_WEB_PORT=7913 node probes/workspace-drag.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.WS_SHOT ?? "workspace-drag";
const PORT = Number(process.env.PI_WEB_PORT ?? 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const APP = { id: "f:/demo/app", name: "app", key: "F:/demo/app", manual: false };
const BLOG = { id: "f:/demo/blog", name: "blog", key: "F:/demo/blog", manual: false };
const FRESH = { id: "manual:fresh", name: "fresh", key: "F:/demo/fresh", manual: true };
const WORKSPACE = { groups: [APP, BLOG, FRESH], overrides: {}, keys: {} };

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
  state("d-1", "app 一", "F:/demo/app", APP.id),
  state("d-2", "app 二", "F:/demo/app", APP.id),
  state("d-3", "app 三", "F:/demo/app", APP.id),
  state("d-blog", "blog 一", "F:/demo/blog", BLOG.id),
];
const MANAGE = { pin: [], order: ["d-1", "d-2", "d-3"], archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
/** 页面发来的所有消息（断言「发了什么 / 什么也没发」）。 */
const msgs = [];

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

/** cwd → 组 id（桩桥版的推导，够用：没有 keys 映射时就是 cwd 小写）。 */
const derive = (cwd) => String(cwd ?? "").toLowerCase();

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
      if (msg.type === "manage" && msg.action !== "opened") msgs.push(msg);
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      // 组内重排：#94 的 arrange 只动 pin / order，组的顺序由派生规则决定，不整写。
      if (msg.type === "manage" && msg.action === "arrange") {
        MANAGE.pin = Array.isArray(msg.pin) ? msg.pin.map(String) : MANAGE.pin;
        MANAGE.order = Array.isArray(msg.order) ? msg.order.map(String) : MANAGE.order;
        cast({ type: "manage", manage: MANAGE, workspace: WORKSPACE });
      }
      // 跨组 / 放回工程：#94 的 ws.move —— wsId 为空串 = 删掉 override。
      if (msg.type === "manage" && msg.action === "ws.move") {
        for (const id of (msg.ids ?? []).map(String)) {
          const s2 = SESSIONS.find((x) => x.id === id);
          if (!s2) continue;
          const wsId = String(msg.wsId ?? "");
          if (wsId) WORKSPACE.overrides[id] = wsId;
          else delete WORKSPACE.overrides[id];
          s2.ws = wsId || derive(s2.cwd);
        }
        cast({ type: "workspaces", workspace: WORKSPACE });
        cast({ type: "sessions.list", sessions: SESSIONS, workspace: WORKSPACE });
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, workspace: WORKSPACE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
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

/** 左栏现在的树：组的 id / 名字 / 组内卡片顺序；外加落点线。 */
const tree = () =>
  page.evaluate(() => ({
    groups: [...document.querySelectorAll(".ws-sec")].map((sec) => ({
      id: sec.dataset.ws ?? "",
      name: sec.querySelector(".ws-head .label")?.textContent ?? "",
      cards: [...sec.querySelectorAll(".session-card")].map((c) => c.dataset.id),
      empty: Boolean(sec.querySelector(".ws-empty")),
    })),
    line: (() => {
      const line = document.querySelector(".drop-line");
      if (!line) return null;
      const box = line.getBoundingClientRect();
      return { ws: line.dataset.ws, index: line.dataset.index, pool: line.dataset.pool, height: Math.round(box.height), top: Math.round(box.top) };
    })(),
    pool: Boolean(document.querySelector(".ws-pool")),
    dragging: [...document.querySelectorAll(".session-card.dragging, .session-card.over-top, .session-card.over-bottom")].map((c) => c.dataset.id),
  }));

const groupOrder = (t, id) => t.groups.find((g) => g.id === id)?.cards ?? [];
const center = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("元素不可见，量不到位置");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

/** DRAG_DEBUG=1：把树里每一块的矩形与最后落点打出来（查落点判定偏了才用）。 */
const debugRects = async (label, point) => {
  if (!process.env.DRAG_DEBUG) return;
  const dump = await page.evaluate(() => ({
    groups: [...document.querySelectorAll(".ws-sec")].map((s) => ({ ws: s.dataset.ws, top: Math.round(s.getBoundingClientRect().top), bottom: Math.round(s.getBoundingClientRect().bottom) })),
    head: (() => {
      const h = document.querySelector(".ws-head");
      const r = h?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
    })(),
    cards: [...document.querySelectorAll(".session-card")].map((c) => {
      const r = c.getBoundingClientRect();
      return { id: c.dataset.id, top: Math.round(r.top), bottom: Math.round(r.bottom) };
    }),
  }));
  console.log(`[debug ${label}] point=${JSON.stringify(point)} ${JSON.stringify(dump)}`);
};

/**
 * 真拖：按下 → 几十步移动（HTML5 DnD 要动起来才认 dragstart）→ 停在目标上，先别松手，
 * 让调用方读一眼高亮，再 `mouse.up()`。返回一个收尾函数。
 */
async function grip(cardId) {
  const card = page.locator(`.session-card[data-id="${cardId}"]`);
  const from = await center(card);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // 先横向蹭一下：这一步之后浏览器才发 dragstart，页面把 dragId 记下来。
  await page.mouse.move(from.x + 10, from.y + 6, { steps: 4 });
  await sleep(80);
  return {
    last: { x: from.x, y: from.y },
    async to(x, y) {
      // 逐步移动 + 小停顿：Chromium 的 dragover 按帧节流，一口气丢 14 个点会让高亮停在中途。
      const start = this.last;
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(start.x + ((x - start.x) * i) / 10, start.y + ((y - start.y) * i) / 10);
        await sleep(12);
      }
      // 落定后在目标上蹭一下：保证最后一条 dragover 就是目标点（否则会差一截）。
      await page.mouse.move(x, y - 2);
      await sleep(20);
      await page.mouse.move(x, y);
      await sleep(150);
      this.last = { x, y };
    },
    async drop() {
      await page.mouse.up();
      await sleep(250);
    },
    async cancel() {
      await page.mouse.up();
      await sleep(200);
    },
  };
}

/** 目标：某张卡的上/下半边 / 某个组头 / 「放回工程」。 */
const cardPoint = async (id, half = "bottom") => {
  const { x, y, box } = await center(page.locator(`.session-card[data-id="${id}"]`));
  return { x, y: half === "bottom" ? y + box.height / 4 : y - box.height / 4 };
};
const groupHeadPoint = async (wsId) => {
  const { box } = await center(page.locator(`.ws-sec[data-ws="${wsId}"] .ws-head`));
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await passGate();
await sleep(500);

let t = await tree();
ok(t.groups.length === 3, `左栏出现 ${t.groups.length} 个组（app / blog / fresh，fresh 是空组）`);
ok(groupOrder(t, APP.id).join(",") === "d-1,d-2,d-3", `app 组初始顺序 ${groupOrder(t, APP.id).join(",")}`);
ok(t.groups.find((g) => g.id === FRESH.id)?.empty === true, "空的手建组显示空态，也能当落点");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-open.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });

// ── 1) 拖动中出现落点线，指对组与位置 ──────────────────────────────
let drag = await grip("d-3");
let point = await cardPoint("d-blog", "bottom");
await drag.to(point.x, point.y);
t = await tree();
await debugRects("cross", point);
ok(t.line !== null, `拖动到 blog 卡片下沿：出现落点线（${JSON.stringify(t.line)}）`);
ok(t.line?.ws === BLOG.id, `落点线指向 blog 组（${t.line?.ws}）`);
ok(t.line?.index === "1", `落点线标出插入位置 1（穿过唯一卡片的中线，实际 ${t.line?.index}）`);
ok(t.line?.height === 2, `落点线是 2px 一条（实测 ${t.line?.height}px）`);
ok(t.pool === true, "拖动期间出现「放回工程」落点");
ok(t.dragging.includes("d-3"), "被拖的卡片带 .dragging，没有残留旧的 over-top/over-bottom");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-line.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });

const before = msgs.length;
await drag.drop();
t = await tree();
const moved = msgs.slice(before).filter((m) => m.action === "ws.move");
ok(moved.length === 1, `松手只发一条 ws.move（实际 ${moved.length} 条：${JSON.stringify(msgs.slice(before))}）`);
ok(moved[0]?.ids?.join(",") === "d-3" && moved[0]?.wsId === BLOG.id, `ws.move 带对 ids 与目标组（${JSON.stringify(moved[0])}）`);
ok(msgs.slice(before).every((m) => m.action !== "arrange"), "跨组不发 arrange（别顺手重写 order）");
ok(groupOrder(t, BLOG.id).join(",").includes("d-3") && !groupOrder(t, APP.id).includes("d-3"), `d-3 到了 blog（blog=${groupOrder(t, BLOG.id).join(",")}；app=${groupOrder(t, APP.id).join(",")}）`);
ok(t.line === null && t.pool === false, "松手后高亮与「放回工程」都收掉了");
await sleep(400);
await page.reload({ waitUntil: "networkidle" });
await passGate();
await sleep(400);
t = await tree();
ok(groupOrder(t, BLOG.id).join(",").includes("d-3"), `刷新后 d-3 仍在 blog（${groupOrder(t, BLOG.id).join(",")}）`);

// ── 2) 组内重排发 arrange，刷新后记得 ────────────────────────────
const orderBefore = groupOrder(t, APP.id);
drag = await grip("d-1");
point = await cardPoint("d-2", "bottom");
await drag.to(point.x, point.y);
t = await tree();
ok(t.line?.ws === APP.id && t.line?.index === "1", `同组落点：线留在 app 组、位置 1（${JSON.stringify(t.line)}）`);
ok(t.pool === true, "同组拖动时「放回工程」也在（可以中途改主意）");
const mark = msgs.length;
await drag.drop();
const arranged = msgs.slice(mark).filter((m) => m.action === "arrange");
ok(arranged.length === 1, `同组重排发一条 arrange（${JSON.stringify(msgs.slice(mark))}）`);
const orderSent = arranged[0]?.order ?? [];
ok(orderSent.indexOf("d-2") >= 0 && orderSent.indexOf("d-2") < orderSent.indexOf("d-1"), `arrange 里 d-1 排到了 d-2 后面（${orderSent.join(",")}）`);
ok(msgs.slice(mark).every((m) => m.action !== "ws.move"), "同组重排不发 ws.move");
t = await tree();
ok(groupOrder(t, APP.id).join(",") === "d-2,d-1", `app 组变成 ${groupOrder(t, APP.id).join(",")}（原 ${orderBefore.join(",")}）`);
await sleep(400);
await page.reload({ waitUntil: "networkidle" });
await passGate();
await sleep(400);
t = await tree();
ok(groupOrder(t, APP.id).join(",") === "d-2,d-1", `刷新后组内顺序仍是 ${groupOrder(t, APP.id).join(",")}`);

// ── 3) 放进空组 ────────────────────────────────────────────────
drag = await grip("d-2");
point = await groupHeadPoint(FRESH.id);
await drag.to(point.x, point.y);
t = await tree();
await debugRects("empty", point);
ok(t.line?.ws === FRESH.id && t.line?.index === "0", `空组也是落点：线画在组头下面、位置 0（${JSON.stringify(t.line)}）`);
const markEmpty = msgs.length;
await drag.drop();
const toEmpty = msgs.slice(markEmpty).filter((m) => m.action === "ws.move");
ok(toEmpty.length === 1 && toEmpty[0]?.wsId === FRESH.id, `拖进空组发 ws.move（${JSON.stringify(toEmpty[0])}）`);
t = await tree();
ok(groupOrder(t, FRESH.id).join(",") === "d-2", `fresh 组里出现 d-2（${groupOrder(t, FRESH.id).join(",")}）`);

// ── 4) 放回工程：wsId 空串，刷新后按 cwd 回去 ────────────────────
await sleep(300);
drag = await grip("d-blog");
await drag.to(point.x, point.y); // 先挪动一下，让 dragstart 落地
const poolBox = await page.locator(".ws-pool").boundingBox();
await drag.to(poolBox.x + poolBox.width / 2, poolBox.y + poolBox.height / 2);
t = await tree();
ok(t.line?.pool === "true", `指针在「放回工程」上：线切成放回色并标 pool（${JSON.stringify(t.line)}）`);
const markPool = msgs.length;
await drag.drop();
const restored = msgs.slice(markPool).filter((m) => m.action === "ws.move");
ok(restored.length === 1 && restored[0]?.wsId === "", `放回工程发 ws.move 且 wsId 是空串（${JSON.stringify(restored[0])}）`);
t = await tree();
ok(groupOrder(t, BLOG.id).includes("d-blog") && !("d-blog" in WORKSPACE.overrides), `d-blog 回到 cwd 推导的 blog 组、override 删掉了（blog=${groupOrder(t, BLOG.id).join(",")}，overrides=${JSON.stringify(WORKSPACE.overrides)}）`);

// ── 5) Esc / 失焦 / 拖离：高亮清掉，且什么也不发 ──────────────────
drag = await grip("d-1");
point = await cardPoint("d-2", "bottom");
await drag.to(point.x, point.y);
t = await tree();
ok(t.line !== null, "Esc 之前先确认高亮在");
const markEsc = msgs.length;
await page.keyboard.press("Escape");
await sleep(150);
t = await tree();
ok(t.line === null && t.pool === false, "按 Esc：高亮与「放回工程」立刻清掉");
await drag.cancel();
ok(msgs.length === markEsc, `Esc 取消后松手不发任何 manage（${msgs.length - markEsc} 条）`);
ok(groupOrder(await tree(), APP.id).join(",") === "d-1", "Esc 取消不挪卡片");

drag = await grip("d-1");
await drag.to(point.x, point.y);
const markBlur = msgs.length;
await page.evaluate(() => window.dispatchEvent(new Event("blur")));
await sleep(150);
t = await tree();
ok(t.line === null && t.pool === false, "窗口失焦：高亮与「放回工程」清掉");
await drag.cancel();
ok(msgs.length === markBlur, `失焦取消后松手不发任何 manage（${msgs.length - markBlur} 条）`);

drag = await grip("d-1");
await drag.to(point.x, point.y);
ok((await tree()).line !== null, "拖离之前先确认高亮在");
await drag.to(1100, 700); // 移出左栏
t = await tree();
ok(t.line === null, "指针拖离树：高亮清掉");
const markAway = msgs.length;
await drag.cancel();
ok(msgs.length === markAway, `拖离后松手不发任何 manage（${msgs.length - markAway} 条）`);
ok(groupOrder(await tree(), APP.id).join(",") === "d-1", "拖离后树没变");

// ── 6) 树外不许有可拖元素 ──────────────────────────────────────
const outside = await page.evaluate(() =>
  [...document.querySelectorAll('[draggable="true"]')]
    .filter((node) => !node.closest(".session-cards"))
    .map((node) => `${node.tagName.toLowerCase()}.${node.className}`),
);
ok(outside.length === 0, `标签页行 / 竖列 / 图标条里没有可拖元素（${outside.length} 个：${outside.join(", ")}）`);
const draggableCount = await page.evaluate(() => document.querySelectorAll('[draggable="true"]').length);
ok(draggableCount > 0, `树里的卡片确实可拖（${draggableCount} 张）`);

await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-done.png`), clip: { x: 0, y: 0, width: 380, height: 820 } });
await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
