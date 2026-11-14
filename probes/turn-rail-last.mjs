/**
 * Probe: 轮次刻度带 —— 点**最后一行/最后一根刻度**，也要落在「这一轮的输入」上。
 *
 * 老行为（D60）把最后一轮特判成「回到底部并继续跟流」：回答一长，人就被甩到几千像素外的末尾，
 * 看不到自己点的那句输入。这里用一条 4 轮的假会话验两件事：
 *   1. 点最后一行 / 最后一根刻度 → 最后一轮的用户气泡顶到正文视口顶部、亮一下、下面还有内容，
 *      跟流停掉（与点中间那些行同观感）；
 *   2. 点中间一行照旧（顶对齐 + 跟流停掉），别为了最后一轮把别的行带坏。
 *
 * 假桥：一轮 = 一条用户输入 + 一段够长的回答（保证最后一轮下面还有一大截，能滚）。
 *
 * Run: npm run build:web && node probes/turn-rail-last.mjs
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
const OUT = path.join(REPO, ".scratch/turn-rail-last/shots");
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

const ASK = [
  "第一轮：先看现在的结构，别改文件。",
  "第二轮：把年份下拉按月份分组，缺月份的不留空。",
  "第三轮：解析改成可折叠，键盘也能开合。",
  "最后一轮：我现在 pi cli 装了很多扩展后，启动会很慢，能否优化，先给方案别动手。",
];
const BULLET = (i) =>
  `第 ${i} 轮的回复故意写长：先摸清结构，再把卷子数据补齐；不动数据格式、不重新加密、不重跑 verify。` +
  `这一行只是把高度撑起来，好让「点最后一行」有地方可滚 —— 如果它被甩到末尾，就说明特判还在。`;
const answers = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, kind: "user", text: ASK[i], images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    const paras = [];
    for (let k = 0; k < 14; k++) paras.push(`${BULLET(i)}\n\n- 要点 ${k + 1}：把 buildModal() 换成共用的一份\n- 要点 ${k + 1}：计时器挪到右上角`);
    out.push({ id: `a${i}`, kind: "assistant", text: paras.join("\n\n"), thinking: "", model: "probe", ts: new Date(Date.now() - (n - i) * 59000).toISOString() });
  }
  return out;
};

const SESSION = {
  id: "probe-last", name: "最后一轮 · 4 轮", cwd: path.join(REPO, ".scratch/probe-work/x"), file: null,
  owned: true, origin: "web", running: false, done: false, updatedAt: Date.now(),
  approvals: 0, asks: 0, locked: false, preview: "", items: answers(4),
};
const strip = ({ items: _drop, ...rest }) => rest;
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
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: strip(SESSION), items: SESSION.items, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(SESSION)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rect = (page, sel, i = 0) =>
  page.evaluate(([s, k]) => {
    const node = document.querySelectorAll(s)[k];
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  }, [sel, i]);
const gapBelow = (page) => page.evaluate(() => {
  const s = document.querySelector(".chat-scroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight;
});
const scrollTopOf = (page) => page.evaluate(() => document.querySelector(".chat-scroll").scrollTop);
/** 那一轮的用户气泡此刻是否在闪（.turn-flash 只亮 1200ms，必须在点完后立刻读）。 */
const flashing = (page, k) =>
  page.evaluate((n) => document.querySelectorAll(".chat-scroll .msg.user")[n]?.classList.contains("turn-flash") ?? false, k);
/** 等平滑滚动停下来：连续三次采样同一个 scrollTop。 */
async function settle(page) {
  let last = -1;
  let stable = 0;
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const st = await scrollTopOf(page);
    stable = st === last ? stable + 1 : 0;
    last = st;
    if (stable >= 3) return st;
    await sleep(80);
  }
  return last;
}
const paneTop = async (page) => (await rect(page, ".chat-scroll")).top;
const lastUserSel = ".chat-scroll .msg.user";
const userCount = (page) => page.locator(lastUserSel).count();

/** 点一行/刻度之后量「那一轮的用户气泡在哪」。`i` 是用户消息在正文里的序号。 */
async function checkLandsOn(page, i, label, flash) {
  const top = await paneTop(page);
  await settle(page);
  const r = await rect(page, lastUserSel, i);
  const gap = await gapBelow(page);
  log(`${label}: round ${i + 1} top`, r.top.toFixed(1), "pane", top.toFixed(1), "gap below", gap, "flash", flash);
  assert(Math.abs(r.top - (top + 6)) < 20, `${label}: round ${i + 1} lands at the top (top ${r.top.toFixed(1)}, pane ${top.toFixed(1)})`);
  assert(gap > 200, `${label}: there is still a long way down from round ${i + 1} (gap ${gap})`);
  assert(flash, `${label}: round ${i + 1} flashes its user bubble`);
  assert(await page.locator(".chat-jump").isVisible(), `${label}: jumping up stops following (回到底部 is back)`);
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 1, 8000, "the session card");
  await page.locator('.session-card[data-id="probe-last"]').click();
  await until(async () => (await userCount(page)) === 4, 8000, "4 user messages");
  await until(async () => (await gapBelow(page)) < 4, 5000, "the transcript follows to the bottom");
  await sleep(400);

  const ticks = await page.locator(".turn-tick").count();
  assert(ticks === 4, `4 rounds = 4 ticks (got ${ticks})`);

  // 1) 最后一根刻度 → 落在最后一轮的输入上（不是末尾）。
  //    指针扫到带子上时列表会盖住刻度那一列（D60 的「融合同一个框」），所以鼠标点不到刻度；
  //    这里用 evaluate 直接触发它的 click（键盘聚焦 + Enter 是同一条路），点的仍是那个处理器。
  await page.mouse.move(40, 40);
  await page.evaluate(() => document.querySelectorAll(".turn-tick")[document.querySelectorAll(".turn-tick").length - 1].click());
  const flash1 = await flashing(page, 3);
  await checkLandsOn(page, 3, "last tick", flash1);
  await page.screenshot({ path: path.join(OUT, "1-last-tick.png") });

  // 2) 回到末尾，再从展开的列表里点最后一行 → 同样落在最后一轮的输入上。
  await page.locator(".chat-jump").click();
  await until(async () => (await gapBelow(page)) < 4, 5000, "back at the bottom");
  await sleep(300);
  await page.locator(".turn-rail").hover();
  await until(async () => page.locator(".turn-list").isVisible(), 4000, "the list opens");
  const cur = await page.evaluate(() => [...document.querySelectorAll(".turn-row")].findIndex((r) => r.classList.contains("cur")));
  assert(cur === 3, `at the bottom the last row is current (got ${cur})`);
  await page.locator(".turn-row").last().click();
  const flash2 = await flashing(page, 3);
  await checkLandsOn(page, 3, "last row", flash2);
  await page.screenshot({ path: path.join(OUT, "2-last-row.png") });

  // 3) 中间一行照旧：别为了最后一轮把普通行带坏。
  await page.locator(".turn-rail").hover();
  await until(async () => page.locator(".turn-list").isVisible(), 4000, "the list opens again");
  await page.locator(".turn-row").nth(1).click();
  const flash3 = await flashing(page, 1);
  await checkLandsOn(page, 1, "middle row", flash3);
  await page.screenshot({ path: path.join(OUT, "3-middle-row.png") });

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
