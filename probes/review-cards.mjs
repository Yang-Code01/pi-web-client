/**
 * Probe D426: 代码评审的**记录卡**——整卡不再可点，入口是右下角的「完整详情」。
 *
 * 为什么不用真桥：这几件事（卡上按钮的位置、整卡点击不弹浮层、开评不再自动跳走）
 * 全是前端的形状，验的是 DOM 与几何；起桥跑一次真评审要 ocr + 真模型，慢而且不稳。
 * 这里用一只假 WS 把 `review.state` / `review.progress` 播进去，逐条量像素。
 *
 * Run: npm run build:web && node probes/review-cards.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch/review-cards");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

// ---- 假桥 ------------------------------------------------------------------
const SID = "zz-review-cards";
const CWD = REPO;
const SESSION = {
  id: SID,
  name: "评审卡片",
  cwd: CWD,
  ws: "",
  file: null,
  owned: true,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const WORKSPACE = { groups: [], overrides: {}, keys: { [CWD.toLowerCase()]: "" } };
const MANAGE = { pin: [SID], order: [SID], archived: [] };
const OCR = { installed: true, version: "1.14.2", tooOld: false };

const run = (over = {}) => ({
  id: "r1",
  status: "done",
  startedAt: new Date(Date.now() - 6 * 60000).toISOString(),
  finishedAt: new Date(Date.now() - 6 * 60000 + 4000).toISOString(),
  mode: "pr",
  from: "",
  to: "HEAD",
  mergeBase: "abc",
  pr: 0,
  prTitle: "",
  prHead: "",
  prBase: "",
  model: "Kimi-K2.8-Preview",
  provider: "wb2_mac",
  lang: "zh",
  findings: [],
  resolved: [],
  resolvedPaths: [],
  skipped: [],
  reviewedFiles: 0,
  totalFiles: 0,
  tokens: 1_000_000,
  error: "",
  errorCode: "",
  log: [],
  ...over,
});

// 面板按 startedAt 倒序画，而 run() 的默认值来自同一个 Date.now() 基准：三条挤在同一毫秒时靠
// 稳定排序才恰好是新在前。写成明确的时刻，跨毫秒也不会把 r-700 顶到第一张。
const RUNS = [
  run({
    id: "r-live",
    status: "running",
    pr: 702,
    prTitle: "fix(chat): 卡片在窄版下换成两行",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: "",
  }),
  run({
    id: "r-701",
    pr: 701,
    prTitle: "feat(review): 记录卡多选模型",
    model: "GLM-5.4",
    tokens: 900_000,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date(Date.now() - 116_000).toISOString(),
  }),
  run({
    id: "r-700",
    pr: 700,
    prTitle: "fix(chat): 没成卡时 .lm-scroll 也拆掉，用户气泡不再被挤成窄条…",
    model: "GLM-5.4",
    startedAt: new Date(Date.now() - 180_000).toISOString(),
    finishedAt: new Date(Date.now() - 176_000).toISOString(),
  }),
];
const STATE = { repo: CWD, runs: RUNS, marks: {} };
const PROGRESS = {
  repo: CWD,
  runId: "r-live",
  status: "running",
  phase: "review",
  totalFiles: 3,
  reviewedFiles: 1,
  currentFile: "web/src/review.ts",
  tokens: 20_000,
  startedAt: new Date().toISOString(),
  error: "",
  errorCode: "",
  group: 1,
  groups: 1,
  log: [],
};

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
      if (msg.type === "subscribe") {
        ws.send(JSON.stringify({ type: "session", sessionId: SID, state: SESSION, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "review.get") {
        // 卡上的模型显示名来自目录（app.ts 的 reviewModelLabels() 拿 run.model 去 this.models 里配），
        // 不是 review.state 带的字段 —— 桩里补一帧 catalog，走与生产同一条路。
        ws.send(
          JSON.stringify({
            type: "catalog",
            models: [
              { id: "Kimi-K2.8-Preview", provider: "wb2_mac", name: "Kimi-K2.8-Preview · x0.77 · 1M" },
              { id: "GLM-5.4", provider: "wb2_mac", name: "GLM-5.4 · x0.69 · 1M" },
            ],
            fast: [],
            error: "",
          }),
        );
        ws.send(JSON.stringify({ type: "review.ocr", ocr: OCR }));
        ws.send(JSON.stringify({ type: "review.pinned", pinned: "" }));
        ws.send(JSON.stringify({ type: "review.prs", dir: CWD, prs: [], open: 0, error: "" }));
        ws.send(
          JSON.stringify({
            type: "review.state",
            dir: CWD,
            sessionId: SID,
            state: STATE,
            progresses: [PROGRESS],
            cap: 2,
            pinned: "",
          }),
        );
      }
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        me: ME,
        sessions: [SESSION],
        manage: MANAGE,
        trash: [],
        tunnel: TUNNEL,
        workspace: WORKSPACE,
      }),
    );
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---- 页面 ------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
await page.addInitScript(() => localStorage.setItem("pi.queueTab", "review"));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".session-card").first().click();
await page.locator(".rv-run-card").first().waitFor({ timeout: 15000 });
await sleep(400);

const count = (sel) => page.locator(sel).count();
/** 这条规则在**构建产物**里还在不在。已删掉的旧页签只能这样守：DOM 里查不到任何东西，断言恒真。 */
const cssHas = (needle) =>
  page.evaluate(
    (needle) =>
      [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some((rule) => String(rule.cssText).includes(needle));
        } catch {
          return false;
        }
      }),
    needle,
  );
/**
 * 面板在跑的时候会按计时器重画，DOM 一直在换 —— `locator.click()` 会卡在「等元素稳定」上。
 * 这里先量坐标再用鼠标真点：走的是命中测试，不会绕过「点到的是不是这颗按钮」。
 */
const centerOf = (sel, idx = 0) =>
  page.evaluate(
    ({ sel, idx }) => {
      const el = document.querySelectorAll(sel)[idx];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
    { sel, idx },
  );
/** 第 idx 张卡里的某个子元素（卡片之间还夹着表头，不能用 :nth-of-type）。 */
const centerIn = (parentSel, idx, childSel) =>
  page.evaluate(
    ({ parentSel, idx, childSel }) => {
      const el = document.querySelectorAll(parentSel)[idx]?.querySelector(childSel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
    { parentSel, idx, childSel },
  );
const clickIn = async (parentSel, idx, childSel) => {
  const at = await centerIn(parentSel, idx, childSel);
  ok(!!at, `点得到 ${parentSel}[${idx}] ${childSel}`);
  if (at) await page.mouse.click(at.x, at.y);
};
/** 面板按计时器重画，「量坐标 → 点」之间卡片可能已经换了一批；点不到就重来两次。 */
const openDetails = async (idx) => {
  for (let i = 0; i < 3; i += 1) {
    await clickIn(".rv-run-card", idx, ".rv-run-more");
    const opened = await page.locator(".rv-sheet").waitFor({ timeout: 1500 }).then(() => true).catch(() => false);
    if (opened) return true;
  }
  return false;
};
const clickSel = async (sel, idx = 0) => {
  const at = await centerOf(sel, idx);
  ok(!!at, `点得到 ${sel}[${idx}]`);
  if (at) await page.mouse.click(at.x, at.y);
};

// 1. 三条记录，面板里没有展开页
ok((await count(".rv-run-card")) === 3, "三条记录画成三张卡");
ok(!(await cssHas(".rv-focus")), "旧的内嵌展开页（.rv-focus）连样式一起删掉了");

// 2. 「完整详情」在卡底右下角
{
  // 一次 evaluate 量完：面板会定时重画（计时器），locator 句柄会随时失效。
  const debug = await page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return {
      cards: [...document.querySelectorAll(".rv-run-card")].map((card) => ({
        card: r(card),
        more: card.querySelector(".rv-run-more") ? r(card.querySelector(".rv-run-more")) : null,
      })),
    };
  });
  const rects = debug.cards;
  ok(rects.length === 3 && rects.every((x) => x.more), "每张卡都有「完整详情」");
  // 距卡边：# > 0 = 在卡内，< 0 = 已经溢出卡外。这里看**最小**那个：只取绝对值最大的，
  // 某张卡按钮往右溢出（负值）会被另一张更大的正值吞掉，恰恰漏掉「按钮出卡」这种回归。
  const gaps = rects.map((it) => ({
    dx: it.card.x + it.card.w - (it.more.x + it.more.w),
    dy: it.card.y + it.card.h - (it.more.y + it.more.h),
  }));
  rects.forEach((it, i) => {
    const { card, more } = it;
    ok(more.x > card.x + card.w / 2, `第 ${i + 1} 张卡的按钮在右半边（x=${Math.round(more.x - card.x)}/${Math.round(card.w)}）`);
    ok(more.y > card.y + card.h / 2, `第 ${i + 1} 张卡的按钮在下半边（y=${Math.round(more.y - card.y)}/${Math.round(card.h)}）`);
  });
  const span = (k) => `${Math.min(...gaps.map((g) => g[k])).toFixed(1)}–${Math.max(...gaps.map((g) => g[k])).toFixed(1)}`;
  const min = (k) => Math.min(...gaps.map((g) => g[k]));
  const max = (k) => Math.max(...gaps.map((g) => g[k]));
  // 卡自己有 8px 内边距 + 1px 边框：按钮贴着内边角就是「右下角」，比这再多 2px 也算贴身。
  ok(min("dx") >= -0.5 && max("dx") <= 12, `按钮都在卡内贴右边（距卡边 ${span("dx")}px，内边距 8+1）`);
  ok(min("dy") >= -0.5 && max("dy") <= 12, `按钮都在卡内贴下边（距卡边 ${span("dy")}px，内边距 7+1）`);
}

// 3. 跑着的那张：停止也在底行，且不再压住时间
{
  const live = await page.evaluate(() => {
    const card = document.querySelector(".rv-run-card.is-live");
    if (!card) return null;
    const r = (sel) => {
      const el = card.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    return { stop: r(".rv-run-stop"), more: r(".rv-run-more"), at: r(".rv-run-at") };
  });
  ok(!!live?.stop && !!live?.more && !!live?.at, "在跑的那张卡有「停止」「完整详情」与时间");
  if (live?.stop && live?.more && live?.at) {
    const inFoot = await page.evaluate(
      () => document.querySelectorAll(".rv-run-card.is-live .rv-run-foot .rv-run-stop, .rv-run-card.is-live .rv-run-foot .rv-run-more").length,
    );
    ok(inFoot === 2, "「停止」与「完整详情」在同一行（.rv-run-foot）");
    ok(live.stop.x + live.stop.w <= live.more.x + 1, "「停止」排在「完整详情」左边");
    const overlap = !(
      live.stop.y + live.stop.h <= live.at.y ||
      live.at.y + live.at.h <= live.stop.y ||
      live.stop.x + live.stop.w <= live.at.x ||
      live.at.x + live.at.w <= live.stop.x
    );
    ok(!overlap, "「停止」不再压住同一行的时间（两个矩形不相交）");
  }
}

// 4. 整卡不是按钮，点正文不弹浮层
{
  const attrs = await page.evaluate(() => {
    const card = document.querySelectorAll(".rv-run-card")[2];
    return { role: card?.getAttribute("role") ?? null, tab: card?.getAttribute("tabindex") ?? null };
  });
  ok(attrs.role === null, "卡片没有 role=button");
  ok(attrs.tab === null, "卡片不可 Tab 聚焦");
  await clickIn(".rv-run-card", 2, ".rv-run-title");
  await sleep(300);
  ok((await count(".rv-sheet")) === 0, "点卡片正文不打开「评审详情」");
  ok((await count(".rv-run-card")) === 3, "点卡片正文后面板还是那三张卡");
}

// 5. 「完整详情」打开的是**这一张卡**那次，不是最新那次
{
  ok(await openDetails(2), "「完整详情」打开浮层");
  const eyebrow = (await page.locator(".rv-sheet-eyebrow").first().innerText()).trim();
  const title = (await page.locator(".rv-sheet-title").first().innerText()).trim();
  ok(eyebrow.includes("PR #700"), `浮层抬头是这张卡的 PR（实际：${eyebrow}）`);
  ok(title.startsWith("fix(chat): 没成卡时"), `浮层标题是这张卡的 PR 标题（实际：${title}）`);
  await page.screenshot({ path: path.join(OUT, "sheet-700.png") });
  await clickSel(".rv-sheet-headright .btn.ghost:not(.rv-stop-btn)");
  await sleep(300);
  ok((await count(".rv-sheet")) === 0, "关闭浮层");
  ok((await count(".rv-run-card")) === 3, "关掉浮层后面板回到记录列表");
}

// 6. 开评不再把人拽走：新的一条只多一张卡
{
  const before = await count(".rv-run-card");
  const liveBefore = await count(".rv-run-card.is-live");
  cast({ type: "review.started", sessionId: SID, runId: "r-new" });
  // 桥是先落一条 running 记录、再广播 review.state / review.started；这里照同一顺序来。
  const fresh = run({ id: "r-new", status: "running", pr: 703, prTitle: "feat(review): 新开一条", model: "GLM-5.4" });
  RUNS.unshift(fresh);
  cast({
    type: "review.state",
    dir: CWD,
    sessionId: SID,
    state: STATE,
    progresses: [PROGRESS, { ...PROGRESS, runId: "r-new", startedAt: new Date().toISOString(), totalFiles: 5, reviewedFiles: 0 }],
    cap: 2,
    pinned: "",
  });
  // 等卡片数真的变成 before+1，不用固定的 sleep 赌渲染时序。
  const grew = await page
    .waitForFunction((n) => document.querySelectorAll(".rv-run-card").length === n, before + 1, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  ok(grew, `新开一条多一张卡（${before} → ${before + 1}）`);
  ok((await count(".rv-sheet")) === 0, "新开一条不会把面板换成展开页（没开浮层）");
  // 桩里开局就有一条 r-live，光数「>= 1」不管新那条画没画成都过：要的是在跑卡真的多一张、
  // 多出来的那张就是排在最前的新记录（startedAt 最新），并且它带自己的「停止」。
  ok((await count(".rv-run-card.is-live")) === liveBefore + 1, `新开的那条也画成在跑（在跑卡 ${liveBefore} → ${liveBefore + 1}）`);
  const newestLive = await page.evaluate(() => {
    const card = document.querySelector(".rv-run-card");
    return { live: !!card?.classList.contains("is-live"), stop: !!card?.querySelector(".rv-run-stop") };
  });
  ok(newestLive.live && newestLive.stop, "最新那张卡是在跑、且带自己的「停止」");
}

// 7. 字号 150%（#app 有 zoom）下按钮仍在卡内右下角
{
  // 同一把尺子先量 100%：缩放那一段红了才能分辨「缩放的问题」还是「本来就不在角落」。
  const corner = () =>
    page.evaluate(() => {
      const card = document.querySelector(".rv-run-card");
      const more = card?.querySelector(".rv-run-more");
      if (!card || !more) return null;
      const a = card.getBoundingClientRect();
      const b = more.getBoundingClientRect();
      return { cx: a.x, cw: a.width, cy: a.y, ch: a.height, x: b.x, y: b.y, w: b.width, h: b.height };
    });
  const inCorner = (m) => !!m && m.x + m.w <= m.cx + m.cw + 0.5 && m.y + m.h <= m.cy + m.ch + 0.5 && m.x > m.cx + m.cw / 2;
  const base = await corner();
  ok(inCorner(base), "100%：按钮在卡内右下角");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
  await sleep(400);
  const scaled = await corner();
  ok(!!scaled && scaled.x + scaled.w <= scaled.cx + scaled.cw + 0.5 && scaled.y + scaled.h <= scaled.cy + scaled.ch + 0.5, "150% 缩放：按钮仍在卡内");
  ok(!!scaled && scaled.x > scaled.cx + scaled.cw / 2, "150% 缩放：按钮仍在右下角");
  ok(
    !!base && !!scaled && scaled.w > base.w * 1.2,
    !!base && !!scaled ? `150% 缩放真的生效了（按钮 ${base.w.toFixed(1)} → ${scaled.w.toFixed(1)}px）` : "按钮没量到",
  );
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-scale"));
}

await page.screenshot({ path: path.join(OUT, "cards.png") });
console.log(`\n截图：${OUT}\\cards.png`);
await browser.close();
wss.close();
server.close();
process.exitCode = bad ? 1 : 0;
console.log(bad ? `\n${bad} 项失败` : "\n全部通过");
