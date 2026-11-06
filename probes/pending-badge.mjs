/**
 * Probe: D156 — 答完 / 批完的会话不许在卡片上继续挂着「待确认」。
 *
 * 用户的现场（2026-11-07）：聊天里那条提问已经选了「加备用源 + 修报错」，卡右下角还是「待确认」。
 * 根因是列表里的两个计数：提问被记进了 `approvals`，`ask.remove` 又从来不减；批准那条则只给
 * 「当前不在看的会话」减数，切过去再批就永远清不掉。
 *
 * 这里用假桥 + 真界面把两条路都走一遍（不点桥，只发事件）：
 *
 *   1. 正在看 A 时 B 来一个问题 → B 卡是「待回答」，**不能**是「待确认」；
 *   2. 打开 B、点选项作答（桥回 `ask.remove`）→ B 卡不再有待处理徽标；
 *   3. 正在看 B 时 A 来一个批准 → A 卡「待确认」；
 *   4. 打开 A、点「批准」（桥回 `approval.remove`）→ A 卡不再有待处理徽标。
 *
 * Run: npm run build:web && node probes/pending-badge.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, scratch, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7913);
const OUT = scratch("pending-badge");
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
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const base = { cwd: REPO, file: null, owned: false, origin: "disk", updatedAt: Date.now() - 60_000, preview: "" };
const SESSIONS = [
  { ...base, id: "s-other", name: "别的事", running: false, done: false, approvals: 0, asks: 0, locked: false },
  { ...base, id: "s-bug", name: "skill 商店安装报错", running: true, done: false, approvals: 0, asks: 0, locked: false },
];
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ASK = {
  id: "ask_probe1",
  sessionId: "s-bug",
  sessionName: "skill 商店安装报错",
  createdAt: Date.now(),
  questions: [{ id: "q1", label: "Q1", prompt: "技能商店的 raw.githubusercontent.com 被重置，怎么修？", options: [{ value: "a", label: "加备用源 + 修报错（推荐）" }, { value: "b", label: "只修报错" }], allowOther: true }],
};
const APPROVAL = { id: "appr_probe1", sessionId: "s-other", title: "需要确认", message: "rm -rf build", createdAt: Date.now() };

/** 每条会话当前待着的队列 —— 假桥的「权威值」，subscribe 时原样发回去。 */
const pending = { "s-other": { approvals: [], asks: [] }, "s-bug": { approvals: [], asks: [] } };
let sock = null;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));
const snapshot = (id) => {
  const s = SESSIONS.find((x) => x.id === id);
  return { type: "session", sessionId: id, state: { ...s, approvals: pending[id].approvals.length, asks: pending[id].asks.length }, items: [{ kind: "user", id: "u1", text: "帮我看看这个报错。" }], approvals: pending[id].approvals, asks: pending[id].asks, budget: null };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
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
    log("client →", msg.type, msg.sessionId ?? "", msg.askId ?? msg.approvalId ?? msg.decision ?? "");
    if (msg.type === "subscribe") {
      send(snapshot(String(msg.sessionId)));
      return;
    }
    if (msg.type === "answer") {
      // 真桥答完就把这条 ask 从队列里删掉、回 ask.remove（bridge/src/sessions.ts 的 answerAsk）。
      const box = pending[msg.sessionId];
      if (box) box.asks = box.asks.filter((a) => a.id !== msg.askId);
      send({ type: "ask.remove", sessionId: msg.sessionId, id: msg.askId, reason: "已作答" });
      return;
    }
    if (msg.type === "approve") {
      const box = pending[msg.sessionId];
      if (box) box.approvals = box.approvals.filter((a) => a.id !== msg.approvalId);
      send({ type: "approval.remove", sessionId: msg.sessionId, id: msg.approvalId });
    }
  });
  send({
    type: "hello",
    me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
    sessions: SESSIONS.map((s) => ({ ...s })),
    manage: { pin: SESSIONS.map((s) => s.id), order: [], archived: [] },
    trash: [],
    tunnel: TUNNEL,
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  const card = (id) => page.locator(`.session-card[data-id="${id}"]`);
  const badge = async (id) => ((await card(id).locator(".badge").count()) ? (await card(id).locator(".badge").first().innerText()).trim() : "");
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");

  // 1. 看 A 时 B 来一个问题：旧代码把这条 ask 记进 approvals —— 卡片会显示「待确认」。
  await card("s-other").click();
  await until(async () => (await card("s-other").getAttribute("class"))?.includes("active"), 4000, "A active");
  pending["s-bug"].asks = [ASK];
  send({ type: "ask.add", sessionId: "s-bug", ask: ASK, tool: "question", toolCallId: "t1" });
  await until(async () => (await badge("s-bug")) === "待回答", 4000, "B 待回答");
  assert((await badge("s-bug")) !== "待确认", `回答类待办不许显示成待确认（got ${await badge("s-bug")}）`);
  log("1 OK 问题到达 → B 卡:", await badge("s-bug"));
  await page.screenshot({ path: path.join(OUT, "1-ask-arrived.png") });

  // 2. 打开 B、点选项作答 → 桥回 ask.remove → 徽标必须清掉（这正是用户截图里的那一步）。
  await card("s-bug").click();
  await until(async () => (await card("s-bug").getAttribute("class"))?.includes("active"), 4000, "B active");
  const opt = page.locator(".ask-slot .ask-opt").first();
  await until(async () => (await opt.count()) === 1, 4000, "ask options");
  await opt.click();
  await until(async () => !["待回答", "待确认"].includes(await badge("s-bug")), 4000, "B badge cleared");
  log("2 OK 作答后 B 卡:", (await badge("s-bug")) || "(无徽标)");
  await page.screenshot({ path: path.join(OUT, "2-answered.png") });

  // 3/4. 同一套账的反面：批准。看 B 时 A 来批准 → 打开 A 再批 → 不许留「待确认」。
  pending["s-other"].approvals = [APPROVAL];
  send({ type: "approval.add", sessionId: "s-other", approval: APPROVAL });
  await until(async () => (await badge("s-other")) === "待确认", 4000, "A 待确认");
  await card("s-other").click();
  await until(async () => (await card("s-other").getAttribute("class"))?.includes("active"), 4000, "A active again");
  // 批准卡同时出现在输入框上方（.approval-slot）和队列页里，只点前者。
  const approve = page.locator(".approval-slot .actions .btn.primary").first();
  await until(async () => (await approve.count()) >= 1, 4000, "approve button");
  await approve.click();
  await until(async () => !["待回答", "待确认"].includes(await badge("s-other")), 4000, "A badge cleared");
  log("4 OK 批准后 A 卡:", (await badge("s-other")) || "(无徽标)");
  await page.screenshot({ path: path.join(OUT, "4-approved.png") });

  log("ALL OK");
} finally {
  await browser.close();
  server.close();
  wss.close();
}
