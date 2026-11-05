/**
 * Probe: pi 正在启动时，界面要把这件事说出来，而且不让人往一个还没起来的 pi 里打字（D122）。
 *
 * 背景：`create` 不再等 pi 启动（它要 8 秒，机器忙时 15 秒），所以新会话会先出现、pi 还在起。
 * 这几秒里如果 composer 照常可用，用户敲字发出去会石沉大海。桥用 `state.starting` 告诉页面，
 * 页面负责两件事：
 *   1. 状态行写「pi 正在启动（加载扩展，通常几秒）…」而不是「Enter 发送」的快捷键提示；
 *   2. 输入框置灰、placeholder 换成「pi 正在启动…」，发送兜底也拦住。
 * `starting` 翻成 false 之后，两样都必须恢复。
 *
 * 桩桥只推状态帧，不接 pi，所以这一秒钟级、可重复。
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
/** 页面就是靠这条消息知道「pi 起来了没有」。 */
let push = null;
wss.on("connection", (ws) => {
  push = (state) => ws.send(JSON.stringify({ type: "session.state", session: state }));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: base.id, state: base, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  const starting = { ...base, starting: true };
  ws.send(
    JSON.stringify({
      type: "hello",
      me: ME,
      sessions: [starting],
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

  // ---- 1. 启动中：状态行说清楚、输入框禁掉
  await page.evaluate(() => {
    const app = document.querySelector(".session-card");
    return app !== null;
  });
  if (push) push({ ...base, starting: true });
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "starting hint");
  const hint = await page.locator(".hint-status").innerText();
  const box = page.locator(".composer textarea");
  check(hint.includes("pi 正在启动"), `状态行写的是启动中（「${hint.replace(/\s+/g, " ").trim()}」）`);
  check(hint.includes("加载扩展"), "状态行顺带解释了为什么慢（加载扩展）");
  check(await box.isDisabled(), "输入框被禁用（不会往还没起来的 pi 里打字）");
  check((await box.getAttribute("placeholder"))?.includes("正在启动"), `placeholder 也换成了启动中（${await box.getAttribute("placeholder")}）`);
  await page.screenshot({ path: path.join(OUT, "1-starting.png") });

  // ---- 2. 起来了：一切恢复
  push({ ...base, starting: false });
  await until(async () => !(await box.isDisabled().catch(() => true)), 8000, "composer enabled");
  const hint2 = await page.locator(".hint-status").innerText();
  check(await box.isEnabled(), "starting=false 之后输入框恢复可用");
  check(!hint2.includes("正在启动"), `状态行回到普通提示（「${hint2.replace(/\s+/g, " ").trim().slice(0, 40)}」）`);
  await page.screenshot({ path: path.join(OUT, "2-ready.png") });

  // ---- 3. 真能打字发出去（兜底：sendPrompt 里也有一次 starting 检查）
  await box.fill("你好");
  await box.press("Enter");
  await sleep(300);
  const sent = await page.locator(".composer textarea").inputValue();
  check(sent === "", "起来之后回车真的能把消息发出去（输入框被清空）");
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
} finally {
  await browser?.close();
  server.close();
}
log(failed ? `FAILED (${failed})` : "all checks passed");
process.exit(failed ? 1 : 0);
