/**
 * Probe: 问卷（问答卡）也算一次用户输入 —— 刻度带上占一格、一份问卷只有一格、点它能回到那张卡。
 *
 * 会话切成两页：末尾一页只有「第二个用户消息 + 旧单题问卷」，前面那页有一个用户消息和一道两题问卷。
 * 于是同时验到三条路：
 *   1. 未载入的问卷以 ghost 行出现，文字是「问卷概况：数据库 · 等 2 题」；
 *   2. 点 ghost → 自动往回翻页 → 问卷卡到货并闪一下；
 *   3. 已载入的问卷行悬停 → 正文里那张 `.qa-card` 亮边（不是用户气泡）。
 *
 * Run: npm run build:web && node probes/rail-ask.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 8301);
const OUT = path.join(REPO, ".scratch/rail-ask/shots");
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

const askTwo = {
  questions: [
    { header: "数据库", question: "用哪个？", options: [{ label: "MySQL" }, { label: "Postgres" }] },
    { header: "端口", question: "几号？", options: [] },
  ],
};
const askOne = { question: "旧的单题？", options: [{ label: "左" }, { label: "右" }] };

const ALL = [
  { id: "u0", kind: "user", images: [], ts: new Date(Date.now() - 60000).toISOString(), text: "先把这轮问卷答了" },
  {
    id: "a0:call0", kind: "tool", toolCallId: "call0", name: "ask_user_question", args: askTwo,
    ts: new Date(Date.now() - 59000).toISOString(),
    result: 'User has answered your questions: "用哪个？"="MySQL", "几号？"="3306". You can now continue.',
  },
  { id: "a1", kind: "assistant", thinking: "", model: "probe", ts: new Date(Date.now() - 58000).toISOString(), text: "收到。" },
  { id: "u1", kind: "user", images: [], ts: new Date(Date.now() - 57000).toISOString(), text: "再来一个单题" },
  {
    id: "a2:call1", kind: "tool", toolCallId: "call1", name: "question", args: askOne,
    ts: new Date(Date.now() - 56000).toISOString(), result: "",
  },
];
// 末尾一页从 u1 开始：u0 与那道两题问卷都还没载入。
const PAGE = ALL.slice(3);
const TURNS = [
  { id: "u0", kind: "user", text: "先把这轮问卷答了", images: 0 },
  { id: "a0:call0", kind: "ask", text: "数据库", images: 0, questions: 2 },
  { id: "u1", kind: "user", text: "再来一个单题", images: 0 },
  { id: "a2:call1", kind: "ask", text: "旧的单题？", images: 0, questions: 1 },
];

const S = {
  id: "probe-ask", name: "问卷刻度", cwd: path.join(REPO, ".scratch/probe-work/exam"), file: null, owned: true,
  origin: "web", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "",
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };

function pageBefore(before) {
  const at = ALL.findIndex((x) => x.id === before);
  if (at <= 0) return { items: [], hasMore: false };
  return { items: ALL.slice(0, at), hasMore: false };
}

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
let olderRequests = 0;
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({
        type: "session", sessionId: S.id, state: S, items: PAGE, approvals: [], asks: [], budget: null,
        history: { hasMore: true, truncated: false, turns: TURNS },
      }));
      return;
    }
    if (msg.type === "history.before") {
      olderRequests += 1;
      const page = pageBefore(msg.before);
      ws.send(JSON.stringify({ type: "history", sessionId: S.id, before: msg.before, items: page.items, hasMore: page.hasMore }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [S], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rows = (page) => page.locator(".turn-row");
const rowTexts = (page) => page.evaluate(() => [...document.querySelectorAll(".turn-row .txt")].map((n) => n.textContent));
const askCards = (page) => page.locator(".qa-card");
async function openPanel(page) {
  if (await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open"))) return;
  await page.locator(".turn-hit").hover();
  await until(async () => page.evaluate(() => document.querySelector(".turn-rail").classList.contains("settled")), 4000, "the list settles");
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 1, 8000, "one session card");
  await page.locator(`.session-card[data-id="${S.id}"]`).click();
  await until(async () => (await askCards(page).count()) === 1, 8000, "the tail page loads");
  await sleep(300);

  // 1) 四格：两个用户消息 + 两处问卷，其中前两格是 ghost（未载入）。
  assert((await rows(page).count()) === 4, `刻度带共 4 格（实际 ${await rows(page).count()}）`);
  assert((await page.locator(".turn-row.ghost").count()) === 2, "前两个是未载入的 ghost");
  const texts = await rowTexts(page);
  log("rows:", JSON.stringify(texts));
  assert(texts[0] === "先把这轮问卷答了", "第一格还是用户消息");
  assert(texts[1] === "问卷概况：数据库 · 等 2 题", `ghost 问卷也有一行字（实际 ${JSON.stringify(texts[1])}）`);
  assert(texts[3] === "问卷概况：旧的单题？", "单题不补「等 N 题」");

  // 同一份问卷里两道题只占一格：总格数 4 = 2 用户 + 2 问卷，而不是 5。
  assert((await page.locator('.turn-row .txt:has-text("数据库")').count()) === 1, "两题问卷只渲染一行");

  // 2) 悬停已载入的问卷行：亮的是正文里的问答卡，不是用户气泡。
  await openPanel(page);
  await rows(page).nth(3).hover();
  await until(async () => (await page.locator(".qa-card.turn-flash").count()) === 1, 5000, "the ask card flashes");
  const flashedText = await page.locator(".qa-card.turn-flash").textContent();
  assert(flashedText.includes("旧的单题？"), `亮的是那张旧单题问卷（实际 ${JSON.stringify(flashedText.slice(0, 60))}）`);
  assert((await page.locator(".msg.user.turn-flash").count()) === 0, "用户气泡不该跟着亮");
  await page.screenshot({ path: path.join(OUT, "hover-ask.png") });

  // 3) 点 ghost 里的两题问卷：自动往回翻页，卡到货并闪一下。
  const ghostRow = page.locator('.turn-row.ghost[aria-label*="数据库"]');
  assert((await ghostRow.count()) === 1, "ghost 行在（aria-label 带问卷标题）");
  await ghostRow.click();
  await until(async () => (await askCards(page).count()) === 2, 20000, "older page arrives with the ask card");
  await until(async () => (await page.locator(".qa-card.turn-flash").count()) === 1, 5000, "the arrived ask card flashes");
  const arrived = await page.locator(".qa-card.turn-flash").textContent();
  assert(arrived.includes("数据库") && arrived.includes("端口"), "到货的是那道两题问卷");
  assert(olderRequests === 1, `只翻了一页（实际 ${olderRequests} 次）`);
  const after = await rowTexts(page);
  assert(JSON.stringify(after) === JSON.stringify(texts), "翻页后四格文字不变，ghost 变成了正式行");
  assert((await page.locator(".turn-row.ghost").count()) === 0, "ghost 被新载入的两格吃掉");
  await page.screenshot({ path: path.join(OUT, "ghost-ask.png") });

  log("rail-ask: ok");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
