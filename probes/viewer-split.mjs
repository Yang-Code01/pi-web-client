/**
 * Probe: 文件预览面板的宽度 —— 拖到最右不能把出口拖没，拖到覆盖聊天区要自动全屏。
 *
 * 三件事：
 *   1. 把分隔条拖到最右（面板最窄）：**关闭 / 全屏这两个按钮必须还在视口里、还能点**。
 *      修之前 `.viewer` 是「右对齐 + overflow 可见」、`.viewer-tools` 是 `flex: none`，
 *      面板一窄工具就溢出到右边缘之外 —— 屏幕上什么都点不到，只能 Esc。
 *   2. 一直往左拖到预览左缘越过聊天区左缘 → 自动进全屏（`.viewer.full`，宽度 = 视口宽）。
 *   3. 全屏里点「退出全屏」→ 回到默认宽度 `min(760px, 55vw)`，并清掉 localStorage 里的拖拽记忆。
 *
 * Stands in for the bridge: 一个会话 + /api/preview + /raw，够画出面板。
 *
 * Run: npm --prefix web run build && node probes/viewer-split.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7914);
const OUT = path.join(REPO, ".scratch/viewer-split/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
const MD = path.join(REPO, "docs/DECISIONS.md");
const VIEWPORT = { width: 1440, height: 900 };
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-split", name: "拖宽度", cwd: CWD, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "拖宽度" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "拖一下预览的宽度。" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "拖到最右看看还能不能关。" },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  if (url.pathname === "/api/preview" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const name = path.basename(MD);
      return json(200, { token: "tok", rel: name, name, abs: MD, root: CWD, size: 40, mtime: Date.now(), kind: "markdown" });
    });
    return;
  }
  if (url.pathname.startsWith("/raw/")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("# 预览\n\n这是预览面板里的内容。");
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SES.id, state: SES, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 打开预览（页面自己的入口就是这条事件，见 app.ts 的 pi-preview 监听）。
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: p } })), MD);
  await until(async () => (await page.locator(".viewer-body").innerText().catch(() => "")).includes("预览面板里"), 8000, "preview");
  await sleep(200);

  const geom = () =>
    page.evaluate(() => {
      const v = document.querySelector(".viewer");
      const grip = document.querySelector(".viewer-grip");
      const chat = document.querySelector(".chat-pane");
      const vr = v.getBoundingClientRect();
      return {
        w: Math.round(vr.width),
        left: Math.round(vr.left),
        right: Math.round(vr.right),
        full: v.classList.contains("full"),
        chatLeft: chat ? Math.round(chat.getBoundingClientRect().left) : null,
        grip: grip ? { x: Math.round(grip.getBoundingClientRect().x + grip.getBoundingClientRect().width / 2), y: 300 } : null,
        vw: window.innerWidth,
        saved: localStorage.getItem("pi.viewerW"),
      };
    });

  /** 面板头部里那几个按钮：是否都在视口内、且那一点真的是它自己。 */
  const headerButtons = () =>
    page.evaluate(() => {
      const btns = [...document.querySelectorAll(".viewer-head button")];
      const out = [];
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        // display:none 的按钮（窄面板下被容器查询收起的次要按钮）不算「越界」，直接跳过。
        if (!r.width || !r.height) continue;
        const cx = Math.round(r.x + r.width / 2);
        const cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        out.push({
          label: b.getAttribute("title") ?? b.textContent?.trim() ?? "?",
          right: Math.round(r.right),
          // 在视口内 + 这一点确实点到它（没被别的东西盖住 / 没跑到屏幕外）
          inside: r.x >= 0 && r.right <= window.innerWidth && r.width > 0,
          hittable: Boolean(hit && (hit === b || b.contains(hit))),
          vw: window.innerWidth,
        });
      }
      return out;
    });

  // ---------------------------------------------------------------- 1. 拖到最右：出口必须还在
  log("1. 把分隔条一直拖到最右（面板最窄）");
  let g = await geom();
  if (!g.grip) throw new Error("没找到 .viewer-grip");
  await page.mouse.move(g.grip.x, g.grip.y);
  await page.mouse.down();
  // 分几步移动，模拟真人拖拽（一步到位可能被当成点击）。
  for (const x of [g.grip.x + 120, g.grip.x + 400, VIEWPORT.width - 2]) {
    await page.mouse.move(x, g.grip.y, { steps: 6 });
    await sleep(60);
  }
  await page.mouse.up();
  await sleep(200);
  g = await geom();
  log("   面板宽度", g.w, "px（下限应保住）");
  check(g.w >= 320, `面板没有被拖没（${g.w}px ≥ 320）`);
  const btns = await headerButtons();
  const closeBtn = btns.find((b) => /关闭/.test(b.label));
  const fullBtn = btns.find((b) => /全屏/.test(b.label));
  check(Boolean(closeBtn), `找到关闭按钮（${closeBtn?.label}）`);
  check(Boolean(fullBtn), `找到全屏按钮（${fullBtn?.label}）`);
  check(Boolean(closeBtn?.inside), `关闭按钮在视口内（right=${closeBtn?.right} / vw=${closeBtn?.vw}）`);
  check(Boolean(fullBtn?.inside), `全屏按钮在视口内（right=${fullBtn?.right} / vw=${fullBtn?.vw}）`);
  check(Boolean(closeBtn?.hittable), "关闭按钮那一点真的点到它（没被盖住）");
  check(Boolean(fullBtn?.hittable), "全屏按钮那一点真的点到它");
  const escaped = btns.filter((b) => !b.inside);
  check(escaped.length === 0, `没有按钮跑出视口（${escaped.length} 个越界：${escaped.map((b) => b.label).join(" / ") || "无"}）`);
  await page.screenshot({ path: path.join(OUT, "1-narrowest.png") });

  // ---------------------------------------------------------------- 2. 拖到覆盖聊天区：自动全屏
  log("2. 把分隔条往左拖，直到预览左缘越过聊天区左缘");
  g = await geom();
  check(g.chatLeft !== null, "量到聊天区左缘");
  const grip2 = await geom();
  await page.mouse.move(grip2.grip.x, grip2.grip.y);
  await page.mouse.down();
  const target = Math.max(2, (g.chatLeft ?? 300) - 40); // 越过左缘 40px，确保跨过判定线
  for (const frac of [0.3, 0.6, 0.85, 1]) {
    const x = Math.round(grip2.grip.x + (target - grip2.grip.x) * frac);
    await page.mouse.move(x, grip2.grip.y, { steps: 4 });
    await sleep(60);
  }
  await page.mouse.up();
  await sleep(200);
  g = await geom();
  log("   面板", g.w, "px / full =", g.full, "/ left =", g.left, "/ 聊天区左缘 =", g.chatLeft);
  check(g.full === true, "拖到覆盖聊天区时自动进了全屏（.viewer.full）");
  check(g.w >= VIEWPORT.width - 2, `全屏宽度 = 视口宽（${g.w} vs ${g.vw}）`);
  await page.screenshot({ path: path.join(OUT, "2-auto-full.png") });

  // ---------------------------------------------------------------- 3. 退出全屏 → 回默认大小
  log("3. 在全屏里点「退出全屏」");
  const exit = page.locator('.viewer-head button[title*="退出全屏"]');
  await exit.click();
  await sleep(250);
  g = await geom();
  const expected = Math.min(760, Math.round(VIEWPORT.width * 0.55));
  log("   回到", g.w, "px（期望", expected, "）/ localStorage =", String(g.saved));
  check(g.full === false, "退出了全屏");
  check(Math.abs(g.w - expected) <= 2, `回到默认宽度 min(760px, 55vw) = ${expected}px（拿到 ${g.w}）`);
  check(g.saved === null, `拖拽记忆被清掉（localStorage pi.viewerW = ${String(g.saved)}）`);
  await page.screenshot({ path: path.join(OUT, "3-back-to-default.png") });

  // 收尾：默认宽度下头部按钮当然也得都在
  const after = await headerButtons();
  check(
    after.every((b) => b.inside),
    `默认宽度下所有头部按钮都在视口内（${after.filter((b) => !b.inside).map((b) => b.label).join(" / ") || "全部"}）`,
  );
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
} finally {
  await browser?.close();
  server.close();
}
log(failed ? `FAILED (${failed})` : "all checks passed");
process.exit(failed ? 1 : 0);
