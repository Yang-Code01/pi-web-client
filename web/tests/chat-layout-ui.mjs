/**
 * 中栏网格（`.chat-pane`）的几何回归：**只有一个滚动条，输入框整块贴在栏底**。
 *
 * 为什么需要一条量几何的测试：`.chat-pane` 是 `display: grid`，「转录 / 输入框 / 接管横幅」三块
 * 各占一行，靠行模板对齐。行模板写错、或者某个子项被 `display: none` 掉之后，元素全都还在、
 * 还能点、也不报错 —— 只是谁落到 `auto` 行、谁落到 `minmax(0,1fr)` 行由内容高度决定：
 * 转录一长，输入框被压成一行并掉出栏外（多出一条滚动条）；转录一空，输入框被拉伸到整栏、
 * 里面几块被均分撒开。2026-11-11 的 #368/#372 就是这样从眼皮底下过去的，所以这里用
 * stub 桥 + Chromium 把「打开会话之后长什么样」钉住。
 *
 * 判据只用量出来的事实，不认具体像素：
 *   A1 整页不滚（`documentElement.scrollHeight ≈ clientHeight`）
 *   A2 `.chat-pane` 自己不全栏滚（滚动条只该出现在 `.chat-scroll` 里）
 *   A3 `.composer` 完整落在栏内、不是一个被压扁的条
 *   A4 转录为空时 `.composer` 不被拉伸到整栏
 *
 * Run: node web/tests/chat-layout-ui.mjs        （需要先 `npm run build:web`，且装好 Chromium）
 *      PI_WEB_PORT=7961 PI_WEB_DIST=web/dist …  换端口 / 换产物目录
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const ROOT = process.env.PI_WEB_DIST ? path.resolve(process.env.PI_WEB_DIST) : DIST;
const PORT = Number(process.env.PI_WEB_PORT ?? 7961);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "layout-ui-pass";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error(`没有产物：${path.join(ROOT, "index.html")}。先跑 \`npm run build:web\`。`);
  process.exit(2);
}

// --- stub 桥：只喂这一个会话，不碰真 pi -------------------------------------
const SESSION = {
  id: "stub-layout",
  name: "布局回归",
  cwd: REPO,
  cwdName: "pi-web-client",
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: true,
  model: "stub",
  modelName: "stub",
  thinkingLevel: "medium",
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
};
const LINE = "这是一段用来把转录撑长的文字：长到足以让 .chat-scroll 自己就需要一条滚动条。";
const items = [];
for (let i = 0; i < 12; i += 1) {
  const ts = new Date(Date.now() - 60_000 + i).toISOString();
  items.push({ id: `u${i}`, kind: "user", text: `第 ${i + 1} 个问题：${LINE}`, images: [], ts });
  items.push({ id: `a${i}`, kind: "assistant", text: `第 ${i + 1} 个回答：${LINE}`, thinking: "", model: "stub", ts });
}
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: REPO };
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
  if (url.pathname === "/api/login") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": `pwc=${PASS}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(ROOT, rel);
  if (!path.resolve(file).startsWith(path.resolve(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);
const wss = new WebSocketServer({ noServer: true });
let sendItems = items;
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
      if (msg.type === "subscribe")
        ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: sendItems, approvals: [], asks: [], budget: null }));
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// --- 量几何 -----------------------------------------------------------------
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

const geometry = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight };
    };
    const de = document.documentElement;
    return {
      page: { scrollHeight: de.scrollHeight, clientHeight: de.clientHeight },
      pane: box(".chat-pane"),
      scroll: box(".chat-scroll"),
      composer: box(".composer"),
      rows: getComputedStyle(document.querySelector(".chat-pane")).gridTemplateRows,
    };
  });

const openSession = async (viewport, { messages }) => {
  sendItems = messages ? items : [];
  const ctx = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', PASS);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-card", { timeout: 20_000 });
  await page.locator(".session-card").first().click();
  await page.waitForSelector(".composer", { timeout: 20_000 });
  await sleep(800); // 让首屏渲染、图片/字体落位
  return { ctx, page, errors };
};

const check = (label, g, { empty }) => {
  const notes = [
    `rows=${g.rows}`,
    `pane=${g.pane.clientHeight}/${g.pane.scrollHeight}`,
    `composer=${g.composer.height}px@${g.composer.bottom} (栏底 ${g.pane.bottom})`,
  ].join("  ");
  console.log(`  ${label}: ${notes}`);
  assert.ok(g.page.scrollHeight <= g.page.clientHeight + 1, `${label}：整页在滚（${g.page.scrollHeight} > ${g.page.clientHeight}）`);
  assert.ok(g.pane.scrollHeight <= g.pane.clientHeight + 1, `${label}：.chat-pane 自己多了一条滚动条（${g.pane.scrollHeight} > ${g.pane.clientHeight}）`);
  assert.ok(g.composer.bottom <= g.pane.bottom + 1, `${label}：输入框掉出栏外（bottom ${g.composer.bottom} > ${g.pane.bottom}）`);
  assert.ok(g.composer.height >= 120, `${label}：输入框被压成 ${g.composer.height}px`);
  if (empty) assert.ok(g.composer.height <= g.pane.clientHeight / 2, `${label}：空会话里输入框被拉伸到整栏（${g.composer.height}px / 栏 ${g.pane.clientHeight}px）`);
};

const scenes = [];
let failures = 0;
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  for (const [kind, messages] of [
    ["有消息", true],
    ["空会话", false],
  ]) {
    const label = `${viewport.width}x${viewport.height} ${kind}`;
    const { ctx, page, errors } = await openSession(viewport, { messages });
    try {
      check(label, await geometry(page), { empty: !messages });
      scenes.push(label);
    } catch (err) {
      failures += 1;
      console.log(`  ✗ ${err.message}`);
      await page.screenshot({ path: path.join(REPO, ".scratch", "shots", `chat-layout-${viewport.width}-${messages ? "msgs" : "empty"}.png`) });
    }
    assert.deepEqual(errors, [], `${label}：页面有未捕获异常`);
    await ctx.close();
  }
}

// 接管横幅显示时是另一套行模板（3 行）——#372 的另一条分支，同样要量。
const { ctx, page, errors } = await openSession({ width: 1280, height: 800 }, { messages: true });
try {
  await page.evaluate(() => {
    document.querySelector(".session-reclaim").hidden = false;
  });
  await sleep(300);
  check("1280x800 接管横幅", await geometry(page), { empty: false });
  scenes.push("1280x800 接管横幅");
} catch (err) {
  failures += 1;
  console.log(`  ✗ ${err.message}`);
  await page.screenshot({ path: path.join(REPO, ".scratch", "shots", "chat-layout-reclaim.png") });
}
assert.deepEqual(errors, [], "接管横幅：页面有未捕获异常");
await ctx.close();

await browser.close();
server.close();
fs.mkdirSync(path.join(REPO, ".scratch", "shots"), { recursive: true });
console.log(`\n中栏几何：${scenes.length} 个场景通过${failures ? `，${failures} 个失败` : ""}`);
process.exit(failures ? 1 : 0);
