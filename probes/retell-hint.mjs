/**
 * Probe: D361 — 输入框上方那一行「重讲」。
 *
 * 用桩桥 + 真 Chromium（要 `npm run build:web` 先）：这一行的三态判在 `retellState()` 里单测过，
 * 剩下全是「页面上到底长在哪、点了发什么」：位置在输入框上方（`.composer > .retell-bar` 紧挨
 * `.row`）、有回答才亮、跑着就灰、点了把本地化指令当一条普通用户消息发出去、而且**不动草稿**、
 * 界面语言换成英文时文案跟着换。
 *
 * Run: node probes/retell-hint.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "./port.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7951));
const OUT = path.join(REPO, ".scratch/retell-hint/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(OUT, { recursive: true, force: true });
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

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const base = { cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: true, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false };
const ANSWERED = { ...base, id: "probe-retell", name: "重讲探针", preview: "有一轮回答" };
const EMPTY = { ...base, id: "probe-retell-empty", name: "空会话", preview: "还没有回答" };
const ITEMS = {
  [ANSWERED.id]: [
    { kind: "user", id: "u1", ts: Date.now() - 90_000, text: "新会话里敲 /skill 是空的，等几秒再敲全出来了。" },
    {
      kind: "assistant",
      id: "a1",
      ts: Date.now() - 60_000,
      model: "pi",
      text: "这两件事不是同一个：一是命令表没到，二是技能加载慢。先等它启动完再看。",
    },
  ],
  [EMPTY.id]: [{ kind: "user", id: "u2", ts: Date.now() - 30_000, text: "这条还没有人答。" }],
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let sock = null;
const prompts = [];
const send = (msg) => (sock?.readyState === 1 ? sock.send(JSON.stringify(msg)) : false);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ME));
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
  sock = ws;
  ws.on("close", () => {
    if (sock === ws) sock = null;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      const state = [ANSWERED, EMPTY].find((s) => s.id === msg.sessionId) ?? ANSWERED;
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: ITEMS[state.id] ?? [], approvals: [], asks: [], budget: null }));
    }
    if (msg.type === "prompt") {
      prompts.push(msg);
      ws.send(JSON.stringify({ type: "ack", sessionId: ANSWERED.id, clientId: msg.clientId }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [ANSWERED, EMPTY], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const ZH_TEXT = "等一下。我不明白你在这里进行到哪一步。请重新说明。先提供上下文。然后使用简体技术中文来说明。";

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "session cards");
  await page.locator(".session-card", { hasText: "重讲探针" }).first().click();
  await until(async () => (await page.locator(".composer .row").count()) === 1, 8000, "composer");

  // 1. 位置：就在输入行上面，紧跟 queue-bar 之后的那一格。
  const order = await page.evaluate(() => {
    const host = document.querySelector(".composer");
    return host ? [...host.children].map((n) => n.className || n.tagName.toLowerCase()) : [];
  });
  const barAt = order.findIndex((c) => c.includes("retell-bar"));
  assert(barAt >= 0, `composer 里找不到 .retell-bar：${JSON.stringify(order)}`);
  assert(order[barAt + 1] === "row", `.retell-bar 不在输入行上面：${JSON.stringify(order.slice(barAt))}`);

  // 2. 有回答 → 亮，标题说清楚点下去会发生什么。
  const bar = page.locator(".composer .retell-bar");
  const btn = page.locator(".composer .retell-btn");
  assert(await bar.isVisible(), ".retell-bar 应该可见");
  assert((await btn.innerText()).includes("重讲"), "按钮文字应该是「重讲」");
  assert(!(await btn.isDisabled()), "有回答、没在跑，按钮应该可点");
  assert((await btn.getAttribute("title"))?.includes("先提供上下文"), "title 应说明重讲要什么");
  await page.screenshot({ path: path.join(OUT, "1-ready.png"), clip: await page.locator(".composer").boundingBox() });

  // 3. 点一下：发一条普通 prompt（带本地化指令、behavior steer），草稿一个字节都不动。
  const field = page.locator(".composer textarea");
  await field.fill("我正在写的草稿");
  await btn.click();
  await btn.click({ force: true }); // 双击的第二下：桥的 running 还没到，也该被按住
  await until(async () => prompts.length >= 1, 5000, "prompt frame");
  await page.waitForTimeout(600);
  assert(prompts.length === 1, `连点两下只该发一句，实际 ${prompts.length} 句`);
  const sent = prompts[0];
  assert(sent.text === ZH_TEXT, `发出去的指令不对：${JSON.stringify(sent.text)}`);
  assert(sent.behavior === "steer", `behavior 应为 steer：${sent.behavior}`);
  assert(sent.type === "prompt" && sent.sessionId === ANSWERED.id, "prompt 帧的会话不对");
  assert((await field.inputValue()) === "我正在写的草稿", "重讲不该动输入框里的草稿");
  await until(async () => (await page.locator(".msg.user", { hasText: "我不明白你在这里进行到哪一步" }).count()) === 1, 3000, "own bubble");
  await page.screenshot({ path: path.join(OUT, "2-sent.png"), clip: await page.locator(".composer").boundingBox() });

  // 4. 跑着一轮 → 灰，原因写进 title。
  send({ type: "pi.status", sessionId: ANSWERED.id, running: true });
  await until(async () => await btn.isDisabled(), 3000, "disabled while running");
  assert((await btn.getAttribute("title"))?.includes("还在跑"), "跑着时 title 应说明等它讲完");
  await page.screenshot({ path: path.join(OUT, "3-running.png"), clip: await page.locator(".composer").boundingBox() });
  send({ type: "pi.status", sessionId: ANSWERED.id, running: false });
  send({ type: "state", state: { ...ANSWERED, running: false } });
  await until(async () => !(await btn.isDisabled()), 3000, "enabled again");

  // 5. 新建的空会话（还没有回答）→ 整行不画，只留输入框。
  await page.locator(".session-card", { hasText: "空会话" }).first().click();
  await until(async () => (await page.locator(".composer textarea").count()) === 1, 5000, "composer on empty session");
  await page.waitForTimeout(400);
  assert(!(await page.locator(".composer .retell-bar").isVisible()), "空会话不该画「重讲」那一行");

  // 5b. 设置 → 对话 里那颗拨杆：关掉立刻收起，打开立刻回来（不刷新）。
  await page.locator(".session-card", { hasText: "重讲探针" }).first().click();
  await until(async () => await page.locator(".composer .retell-bar").isVisible(), 5000, "bar back on answered session");
  await page.locator(".icon-btn.set-btn").click();
  await page.locator(".st-nav__item", { hasText: "对话" }).first().click();
  const hintBox = () => page.evaluate(() => document.querySelector('.set-sub[data-sec="chat"] input[type="checkbox"]')?.click());
  await hintBox();
  await until(async () => !(await page.locator(".composer .retell-bar").isVisible()), 3000, "switch hides bar");
  await hintBox();
  await until(async () => await page.locator(".composer .retell-bar").isVisible(), 3000, "switch shows bar");
  await page.keyboard.press("Escape");

  // 5b. 设置里关掉：整个不画；再打开回来（存在 pi.prefs，跟着这台机器）。
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, retellHint: false }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "cards after reload");
  await page.locator(".session-card", { hasText: "重讲探针" }).first().click();
  await until(async () => (await page.locator(".composer textarea").count()) === 1, 5000, "composer after reload");
  await page.waitForTimeout(500);
  assert(!(await page.locator(".composer .retell-bar").isVisible()), "关掉后不该再画「重讲」那一行");
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, retellHint: true, lang: "en" }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "cards after reload");
  await page.locator(".session-card", { hasText: "重讲探针" }).first().click();
  await until(async () => (await page.locator(".composer .retell-bar").count()) === 1, 5000, "bar after reload");
  const enBtn = page.locator(".composer .retell-btn");
  assert((await enBtn.innerText()).includes("Re-pitch") && !(await enBtn.innerText()).includes("重讲"), `英文按钮文字不对：${await enBtn.innerText()}`);
  assert((await page.locator(".composer .retell-lead").innerText()).includes("Didn't follow"), "英文引导语不对");
  await enBtn.click();
  await until(async () => prompts.length >= 2, 5000, "second prompt frame");
  assert(prompts[1].text.includes("Simplified Technical English"), `英文指令不对：${JSON.stringify(prompts[1].text)}`);
  await page.screenshot({ path: path.join(OUT, "4-en.png"), clip: await page.locator(".composer").boundingBox() });

  log("ok — 位置 / 三态 / 空会话不出 / 开关生效 / 发送内容 / 草稿保留 / 双击只发一句 / 英文文案都对");
} finally {
  await browser?.close();
  wss.close();
  server.close();
}
