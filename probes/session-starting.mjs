/**
 * Probe: pi 正在启动的窗口期，消息照常能发 —— 气泡先带「正在启动 pi…」，交给 pi 之后变「处理中…」。
 *
 * 背景：`create` 不再等 pi 启动（D122），所以新会话会先出现、pi 还在起。D177 推翻了 D122 第 3 条
 * （「启动期输入框置灰、不让人打字」）：桥会把这段时间的消息收下、等 pi 就绪再交出去，所以界面这
 * 几秒里应当照常可用。这一页要钉住的是**气泡的两种状态**：
 *   1. 启动期：状态行仍是「pi 正在启动（加载扩展，通常几秒）…」、没有中断按钮，但输入框可用、
 *      placeholder 是平常那句；
 *   2. 发出去的这条立刻出现，带「正在启动 pi…」；每一页只有一份（乐观气泡按 clientId 认领）；
 *   3. `starting` 翻假 + 运行态为真 → 同一枚气泡变「处理中…」，本轮结束消失。
 *
 * 桩桥照真桥的形状回 `item.add` / `item.replace`，不收 pi，所以这一秒钟级、可重复。
 *
 * Run: npm --prefix web run build && node probes/session-starting.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7915);
const OUT = path.join(REPO, ".scratch/session-starting/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
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
    try {
      if (await fn()) return;
    } catch {
      /* page not ready */
    }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const base = { id: "probe-starting", name: "启动中", cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0 };
const ITEMS = [{ kind: "user", id: "u1", ts: Date.now() - 60_000, text: "刚建好的会话" }];

/** 桥那份记录：启动期发出去的消息在这里躺着，第二个标签页 subscribe 时看到的也是它。 */
const items = [...ITEMS];

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
/** 页面就是靠这条消息知道「pi 起来了没有」、以及这一轮在不在跑。 */
const broadcast = (payload) => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(payload));
};
let userSeq = 1;
/** 最近一次收下的那条，模拟桥把它交出去时补的那枚 `item.replace`（pending 翻 "sent"）。 */
let lastUser = null;
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: base.id, state: { ...base, starting: true }, items, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "prompt") {
      // 真桥在启动期做的事：立刻把 user item 落地并广播，item 上带 `pending: "booting"`，
      // 广播里带回 clientId —— 那一页据此认领自己的乐观气泡，别的页照常新画一条。
      const item = { id: `user:${++userSeq}`, kind: "user", text: String(msg.text ?? ""), images: [], pending: "booting", ts: new Date().toISOString() };
      items.push(item);
      lastUser = item;
      broadcast({ type: "item.add", sessionId: base.id, item, clientId: msg.clientId });
      return;
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: ME,
      sessions: [{ ...base, starting: true }],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 1, 8000, "messages");

  // ---- 1. 启动中：状态行照旧说清楚，但输入框照常可用、没有中断按钮
  broadcast({ type: "session.state", session: { ...base, starting: true } });
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "starting hint");
  const hint = await page.locator(".hint-status").innerText();
  const box = page.locator(".composer textarea");
  check(hint.includes("pi 正在启动"), `状态行写的是启动中（「${hint.replace(/\s+/g, " ").trim()}」）`);
  check(hint.includes("加载扩展"), "状态行顺带解释了为什么慢（加载扩展）");
  check((await page.locator('.hint-status [data-act="interrupt"]').count()) === 0, "启动期状态行没有中断按钮（没东西可中断）");
  check(await box.isEnabled(), "输入框可用（D177 推翻了「启动期置灰」）");
  const placeholder = await box.getAttribute("placeholder");
  check(!String(placeholder).includes("正在启动"), `placeholder 是平常那句，不是「pi 正在启动…」（${placeholder}）`);
  await page.screenshot({ path: path.join(OUT, "1-starting.png") });

  // ---- 2. 启动窗口里发一条：气泡立刻出现，带「正在启动 pi…」
  const TEXT = "启动期发的第一条";
  await box.fill(TEXT);
  await box.press("Enter");
  const bubble = page.locator(".msg.user", { hasText: TEXT });
  await until(async () => (await bubble.count()) >= 1, 8000, "user bubble");
  await until(async () => (await bubble.locator(".msg-pending").innerText().catch(() => "")).includes("正在启动 pi"), 8000, "booting badge");
  check((await bubble.count()) === 1, "只有一份气泡（乐观那条按 clientId 认领了桥的广播）");
  check((await box.inputValue()) === "", "回车真的发出去了（输入框被清空）");
  check(!(await bubble.locator(".msg-pending").getAttribute("class"))?.includes("failed"), "启动中的徽标是「进行中」样式，不是报错");
  check((await page.locator(".notice, .msg.notice").count()) === 0, "没有错误提示");
  await page.screenshot({ path: path.join(OUT, "2-booting.png") });

  // ---- 3. 另一个标签页看到的是同一份：一样的气泡、一样的说法
  const page2 = await context.newPage();
  page2.on("pageerror", (e) => log("page2 error:", e.message));
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page2.locator(".session-card").count()) >= 1, 8000, "page2 session card");
  await page2.locator(".session-card").first().click();
  const bubble2 = page2.locator(".msg.user", { hasText: TEXT });
  await until(async () => (await bubble2.count()) >= 1, 8000, "page2 bubble");
  check((await bubble2.count()) === 1, "第二个标签页也只有一份气泡");
  check((await bubble2.locator(".msg-pending").innerText()).includes("正在启动 pi"), "第二个标签页的说法一样（正在启动 pi…）");

  // ---- 4. pi 就绪、这一轮跑起来：同一枚徽标变「处理中…」
  // 桥把这条交给 pi 的时候先补一枚 item.replace（`booting` → `sent`），运行态随后才翻上来。
  broadcast({ type: "item.replace", sessionId: base.id, id: lastUser.id, item: { ...lastUser, pending: "sent" } });
  broadcast({ type: "session.state", session: { ...base, starting: false, running: true } });
  await until(async () => (await bubble.locator(".msg-pending").innerText().catch(() => "")).includes("处理中"), 8000, "running badge");
  check(true, "交给 pi 之后徽标变成「处理中…」");
  check((await page.locator(".hint-status").innerText()).includes("正在启动") === false, "状态行不再是启动文案");
  await page.screenshot({ path: path.join(OUT, "3-running.png") });

  // ---- 5. 本轮结束：徽标消失
  broadcast({ type: "session.state", session: { ...base, starting: false, running: false } });
  await until(async () => (await bubble.locator(".msg-pending").count()) === 0, 8000, "badge gone");
  check(true, "本轮结束之后徽标消失");
  await page.screenshot({ path: path.join(OUT, "4-done.png") });
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
} finally {
  await browser?.close();
  server.close();
}
log(failed ? `FAILED (${failed})` : "all checks passed");
process.exit(failed ? 1 : 0);
