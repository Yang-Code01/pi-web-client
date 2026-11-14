/**
 * Probe: 读历史时发一条消息 —— 自己刚发的那条得看得见。
 *
 * 现在的口径是「跟流才钉底，用户滚上去就是他在读历史」，但发送是**用户自己按的回车**：那一刻他要看的是
 * 自己刚发的这条与随后的回答，不是几屏前的旧文。同一条链上另一半证据是 `chat.ts` 里 `follow()` 的注释
 * 已经写着它被「I just sent a message」用到 —— 而 `sendPrompt()` 只 add 了气泡，没叫 follow()。
 *
 * 桩桥：6 轮长回答；点发送后它只把 prompt 记下来（不需要回包，乐观气泡已经画出来了）。
 *
 * Run: npm run build:web && node probes/send-while-reading.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7917);
const OUT = path.join(REPO, ".scratch/send-while-reading/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
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

// --- fixture -----------------------------------------------------------------------------------
const ANSWER = Array.from({ length: 22 }, (_, k) => `- 第 ${k + 1} 条：把 exam-lock.js 里缺的月份补齐，模板不动。`).join("\n");
const ITEMS = [];
for (let i = 0; i < 6; i++) {
  ITEMS.push({
    id: `u${i}`, kind: "user", images: [], ts: new Date(Date.now() - (6 - i) * 60000).toISOString(),
    text: `第 ${i + 1} 轮：把第 ${i + 1} 套卷子的解析补齐，并且只改 exam-lock.js 一个文件。`,
  });
  ITEMS.push({
    id: `a${i}`, kind: "assistant", thinking: "", model: "probe", ts: new Date(Date.now() - (6 - i) * 59000).toISOString(),
    text: `第 ${i + 1} 轮做完了。\n\n${ANSWER}`,
  });
}
const SESSION = {
  id: "probe-send", name: "读历史时发消息", cwd: path.join(REPO, ".scratch/probe-work/exam"), file: null,
  owned: true, origin: "web", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0,
  locked: false, preview: "",
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
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
const sent = [];
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: ITEMS, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "prompt") sent.push(msg);
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const gapBelow = (page) => page.evaluate(() => {
  const s = document.querySelector(".chat-scroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight;
});
const rectOf = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}, sel);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 1, 8000, "the session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 6, 8000, "6 rounds");
  await sleep(400);
  assert((await gapBelow(page)) < 4, "a fresh session starts at the bottom");

  // 像用户那样往上滚（真滚轮：直接写 scrollTop 不算「动手」，跟流不会被关掉）。
  const pane = await rectOf(page, ".chat-scroll");
  await page.mouse.move(pane.top + 300, 400);
  await page.mouse.wheel(0, -1600);
  await until(async () => page.locator(".chat-jump").isVisible(), 4000, "the jump button after wheeling up");
  const up = await gapBelow(page);
  log("after wheeling up, gap below:", Math.round(up));
  assert(up > 600, `the view really moved up (gap ${Math.round(up)})`);

  // 读着旧文时发一条：回车就是「我要发出去」，那就该看得见它。
  await page.locator(".composer-input > textarea").fill("把第 7 套也补上，只改 exam-lock.js");
  await page.locator(".composer-input > textarea").press("Enter");
  await until(async () => sent.length > 0, 5000, "the prompt goes out");
  await sleep(600);

  const mine = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".chat-scroll .msg.user")];
    const node = nodes[nodes.length - 1];
    const s = document.querySelector(".chat-scroll");
    const r = node.getBoundingClientRect();
    const view = s.getBoundingClientRect();
    return { text: node.textContent?.slice(0, 30) ?? "", top: r.top, bottom: r.bottom, viewTop: view.top, viewBottom: view.bottom };
  });
  const gap = await gapBelow(page);
  const jump = await page.locator(".chat-jump").isVisible();
  const unread = await page.locator(".chat-jump.has-new").count();
  log("sent bubble:", JSON.stringify(mine), "gap below:", Math.round(gap), "jump:", jump, "has-new:", unread);
  await page.screenshot({ path: path.join(OUT, "1-after-send.png") });

  assert(mine.text.includes("第 7 套"), `the composer's text went out (bubble: ${JSON.stringify(mine.text)})`);
  assert(sent[0].text.includes("第 7 套"), "the bridge got the prompt");
  assert(mine.top >= mine.viewTop - 1 && mine.bottom <= mine.viewBottom + 1, "the message I just sent is inside the viewport");
  assert(gap < 24, `sending follows to the bottom (gap ${Math.round(gap)})`);
  assert(!jump, "no 回到底部 button right after sending");

  // 回到底部之后仍然跟流：桥推一条助手回答，视口不能被留在半空。
  wss.clients.forEach((client) => client.send(JSON.stringify({
    type: "item.add", sessionId: SESSION.id,
    item: { id: "a7", kind: "assistant", thinking: "", model: "probe", ts: new Date().toISOString(), text: `第 7 轮做完了。\n\n${ANSWER}` },
  })));
  await sleep(700);
  log("after the reply streams in, gap below:", Math.round(await gapBelow(page)));
  assert((await gapBelow(page)) < 24, "the reply keeps the view pinned at the bottom");

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
