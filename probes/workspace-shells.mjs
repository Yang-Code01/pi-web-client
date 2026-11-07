/**
 * Probe: 四套壳（#98）。
 *
 * 同一份桩桥、同一份数据，对 a/b/c/d 各跑一遍同一张表：
 *   1. 面板上那颗 chip 点得动，点了 `html[data-layout]` 与 `pi.prefs` 都跟上，刷新还在；
 *   2. 左栏收起后，**仍然看得到当前会话** —— A 的行 2 那颗 / B 的顶栏那颗 / C 的竖列高亮 /
 *      D 的色点条高亮；B/C/D 另外都必须有顶栏那颗；
 *   3. 切工作区走各壳自己的入口（A 标签行 / B 浮层段头 / C 竖列 / D 色点条），当前组跟着变；
 *   4. 切会话照旧（左栏卡片），那颗的名字跟着变；刷新后会话与布局都还在；
 *   5. 新会话入口在各壳都开着（A 的 ＋ / B 浮层底部 / C、D 的竖列底部）。
 *
 * Run: npm run build:web && PI_WEB_PORT=7922 node probes/workspace-shells.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.WS_DIST ? path.resolve(process.env.WS_DIST) : path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7906);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const state = (id, name, cwd, ws, owned = true) => ({
  id,
  name,
  cwd,
  ws,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
  owned,
});

const GROUPS = ["01", "02", "03"].map((n) => ({ id: `f:/proj-${n}`, name: `客户${n}号`, key: `F:/proj-${n}`, manual: false }));
const SESSIONS = GROUPS.flatMap((g) => {
  const n = g.id.slice(-2);
  return [1, 2].map((k) => state(`s-${n}-${k}`, `工程 ${n} · 会话 ${k}`, k === 1 ? g.key : `${g.key}/sub/${k}`, g.id));
});
const byId = (id) => SESSIONS.find((s) => s.id === id);
/** 拖动会改 override，之后每次 hello / 回声都按它算组。 */
const OVERRIDES = {};
const KEYS = Object.fromEntries(SESSIONS.map((s) => [s.cwd.toLowerCase(), s.ws]));
const workspace = () => ({ groups: GROUPS, overrides: OVERRIDES, keys: KEYS });
/** 页面发上来的每一条（B 的浮层拖拽要断言真的发了 `ws.move`）。 */
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
      if (msg.type === "manage" && msg.action === "ws.move") {
        // #94：跨组靠 override + 会话身上的 ws；空串 = 删掉（放回 cwd 推导的组）。
        for (const id of (msg.ids ?? []).map(String)) {
          const wsId = String(msg.wsId ?? "");
          if (wsId) OVERRIDES[id] = wsId;
          else delete OVERRIDES[id];
          const s2 = byId(id);
          if (s2) s2.ws = wsId || KEYS[s2.cwd.toLowerCase()] || "";
        }
        ws.send(JSON.stringify({ type: "workspaces", workspace: workspace() }));
        ws.send(JSON.stringify({ type: "sessions.list", sessions: SESSIONS, workspace: workspace() }));
      }
      if (msg.type === "manage" && msg.action === "opened") {
        const id = String(msg.id ?? "");
        MANAGE.order = [id, ...MANAGE.order.filter((x) => x !== id)];
        ws.send(JSON.stringify({ type: "manage", manage: MANAGE, workspace: workspace() }));
      }
    });
    ws.send(
      JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

const prefs = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    } catch {
      return {};
    }
  });
const htmlLayout = (page) => page.evaluate(() => document.documentElement.dataset.layout ?? "");
const collapsed = (page) => page.evaluate(() => document.querySelector(".main")?.classList.contains("no-left") ?? false);

/** 各壳「当前在哪」的证据：谁的 DOM 上带着当前会话。 */
const shells = (page) =>
  page.evaluate(() => {
    const vis = (sel) => {
      const n = document.querySelector(sel);
      return Boolean(n) && n.getClientRects().length > 0;
    };
    const on = (sel) => {
      const n = document.querySelector(sel);
      return { count: document.querySelectorAll(sel).length, ws: n?.dataset.ws ?? "", label: n?.querySelector(".ws-axis-label")?.textContent ?? "" };
    };
    return {
      rowChip: vis(".ws-session-row .now-chip"),
      topChip: vis(".topbar .now-chip"),
      nowName: document.querySelector(".now-chip .now-name")?.textContent ?? "",
      rail: vis(".ws-rail"),
      strip: vis(".ws-strip"),
      railOn: on(".ws-rail .ws-axis-item.on"),
      stripOn: on(".ws-strip .ws-axis-item.on"),
      tabOn: document.querySelector(".ws-tab.on")?.dataset.ws ?? "",
      tabsVisible: vis(".ws-tabs-row"),
    };
  });

const layoutChip = (page, id) => page.locator(`.display-sheet .layout-chip[data-layout="${id}"]`);
async function setLayout(page, id) {
  await page.locator('.icon-btn[data-act="look"]').click();
  await page.waitForSelector(".display-sheet", { timeout: 5000 });
  await layoutChip(page, id).click();
  await sleep(150);
  await page.locator('.display-sheet .btn:has-text("关闭")').click();
  await sleep(250);
}
async function toggleLeft(page) {
  await page.locator('.icon-btn[data-side="left"]').first().click();
  await sleep(350);
}

const center = async (loc) => {
  const b = await loc.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/**
 * 真拖（HTML5 DnD 只在鼠标动起来之后才发 dragstart）：按下 → 蹭一下 → 分十步挪到目标 →
 * 停在目标上读一眼落点线 → 松手。与 probes/workspace-drag.mjs 的手法一致。
 */
async function gripPop(page, id) {
  const from = await center(page.locator(`.ws-pop-item[data-id="${id}"]`));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 6, { steps: 4 });
  await sleep(80);
  return {
    last: from,
    async to(x, y) {
      const start = this.last;
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(start.x + ((x - start.x) * i) / 10, start.y + ((y - start.y) * i) / 10);
        await sleep(12);
      }
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
  };
}

const ENTRY = {
  a: '.ws-tabs-row .ws-tab[data-ws="f:/proj-02"]',
  b: '.ws-pop-sec-head[data-ws="f:/proj-02"]',
  c: '.ws-rail .ws-axis-item[data-ws="f:/proj-02"]',
  d: '.ws-strip .ws-axis-item[data-ws="f:/proj-02"]',
};
const ADD = {
  a: '.new-session .btn[data-act="new"]',
  b: ".ws-pop-add",
  c: '.ws-rail .ws-axis-ghost[data-act="new"]',
  d: '.ws-strip .ws-axis-ghost[data-act="new"]',
};

for (const layout of ["a", "b", "c", "d"]) {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 820 }, locale: "zh-CN" })).newPage();
  page.on("pageerror", (e) => console.log(`pageerror(${layout}):`, e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await sleep(300);

  await setLayout(page, layout);
  const p1 = await prefs(page);
  ok((await htmlLayout(page)) === layout, `${layout}：data-layout 跟上（${await htmlLayout(page)}）`);
  ok(p1.layout === layout, `${layout}：写进 pi.prefs（layout = ${p1.layout}）`);

  // —— 先开一颗会话（否则「当前会话」无从谈起），再收起左栏：四套都得让人看见它
  await page.locator('.session-card[data-id="s-01-1"]').click();
  await sleep(400);
  if (!(await collapsed(page))) await toggleLeft(page);
  ok(await collapsed(page), `${layout}：左栏收起了`);
  const s1 = await shells(page);
  const chips = { a: s1.rowChip, b: s1.topChip, c: s1.topChip, d: s1.topChip };
  ok(chips[layout], `${layout}：收起态看得到当前会话那颗（${layout === "a" ? "行 2" : "顶栏"}）`);
  ok(s1.nowName !== "", `${layout}：那颗写着名字（${s1.nowName}）`);
  if (layout === "a") ok(!s1.rail && !s1.strip, "a：没有竖列也没有色点条");
  if (layout === "b") ok(!s1.rail && !s1.strip && !s1.tabsVisible, "b：标签行 / 竖列 / 色点条都不占地方");
  if (layout === "c") ok(s1.rail && s1.railOn.ws !== "", `c：竖列常驻且当前组高亮（${s1.railOn.ws}）`);
  if (layout === "d") ok(s1.strip && s1.stripOn.ws !== "", `d：收起后缩成色点条且当前组高亮（${s1.stripOn.ws}）`);

  // —— 切工作区：走各壳自己的入口
  if (layout === "b") {
    await page.locator(".now-btn").click();
    await page.waitForSelector(".ws-pop", { timeout: 3000 });
  }
  await page.locator(ENTRY[layout]).first().click();
  await sleep(400);
  if (layout === "b") {
    ok((await page.locator(".ws-pop").count()) === 0, "b：点段头后浮层自己关掉");
  }
  // —— B 的浮层里也能拖（票面要求）：把 proj-01 的一颗拖到 proj-03 的段头上
  if (layout === "b") {
    await page.locator(".now-btn").click();
    await page.waitForSelector(".ws-pop", { timeout: 3000 });
    const target = await center(page.locator('.ws-pop-sec[data-ws="f:/proj-03"] .ws-pop-sec-head'));
    const before = msgs.length;
    const drag = await gripPop(page, "s-01-1");
    await drag.to(target.x, target.y);
    const line = await page.evaluate(() => document.querySelector(".ws-pop .drop-line")?.dataset.ws ?? "");
    ok(line === "f:/proj-03", `b：浮层里拖动出现落点线并指对组（${line}）`);
    await drag.drop();
    const moved = msgs.slice(before).filter((m) => m.action === "ws.move");
    ok(moved.length === 1 && moved[0]?.wsId === "f:/proj-03", `b：浮层里松手只发一条 ws.move（${JSON.stringify(moved[0])}）`);
    ok(
      (await page.locator('.ws-pop-sec[data-ws="f:/proj-03"] .ws-pop-item[data-id="s-01-1"]').count()) === 1,
      "b：浮层重画后那颗已经列在 proj-03 段里",
    );
    await page.keyboard.press("Escape");
    await sleep(150);
  }

  const s2 = await shells(page);
  ok(s2.nowName.includes("工程 02"), `${layout}：切组后那颗换成 proj-02（${s2.nowName}）`);
  if (layout === "a") ok(s2.tabOn === "f:/proj-02", "a：标签行高亮跟着换");
  if (layout === "c") ok(s2.railOn.ws === "f:/proj-02", "c：竖列高亮跟着换");
  if (layout === "d") ok(s2.stripOn.ws === "f:/proj-02", "d：色点条高亮跟着换");

  // —— 切会话：展开左栏点第二张卡
  await toggleLeft(page);
  ok(!(await collapsed(page)), `${layout}：左栏展开了`);
  await page.locator('.session-card[data-id="s-02-2"]').click();
  await sleep(350);
  const s3 = await shells(page);
  ok(s3.nowName.includes("会话 2"), `${layout}：切会话后那颗跟着换（${s3.nowName}）`);
  await toggleLeft(page);

  // —— 新会话入口
  if (layout === "a" && (await collapsed(page))) await toggleLeft(page);
  if (layout === "b") await page.locator(".now-btn").click();
  if (layout !== "a" && layout !== "b") {
    /* C/D 的 ＋ 就在竖列 / 色点条底部，收起态也在 */
  }
  await page.locator(ADD[layout]).first().click();
  await page.waitForSelector(".new-sheet", { timeout: 3000 });
  ok(true, `${layout}：新会话面板开得出来`);
  await page.locator('.new-sheet .btn:has-text("取消")').first().click();
  await sleep(200);

  // —— 刷新：布局、会话都还在
  await page.reload({ waitUntil: "domcontentloaded" });
  // 左栏可能仍是收起的（卡不在屏上但已经在 DOM 里）——等 attached 而不是 visible。
  await page.waitForSelector(".session-card", { state: "attached", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".now-chip .now-name")?.textContent ?? "", null, { timeout: 15000 });
  await sleep(400);
  const p2 = await prefs(page);
  ok((await htmlLayout(page)) === layout && p2.layout === layout, `${layout}：刷新后还是这一套`);
  const s4 = await shells(page);
  ok(s4.nowName.includes("会话 2"), `${layout}：刷新后当前会话还在（${s4.nowName}）`);
  await page.context().close();
}

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : `\nall checks passed`);
process.exitCode = bad ? 1 : 0;
