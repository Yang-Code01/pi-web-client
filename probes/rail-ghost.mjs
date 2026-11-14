/**
 * Probe: #244 —— 点刻度带里**还没载入**的那一轮，自动往回翻页，直到它到货再跳过去；找不到就说一声。
 * 也顺手量两件相关的事：翻页途中用户自己动手（滚轮 / 点「载入更早」）就不再被拽走；
 * 跳转的平滑滚动还在飞的时候换会话，新会话不能被那半截动画带偏。
 *
 * 假桥把会话切成页：320 轮只发最后 20 轮，`history.turns` 仍是全量索引。
 *
 * Run: npm run build:web && node probes/rail-ghost.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7916);
const OUT = path.join(REPO, ".scratch/rail-ghost/shots");
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
const PAGE = 40; // 每页条目数（20 轮）

/** 320 轮：用户一问、助手一段短答。 */
function rounds(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `u${i}`, kind: "user", images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString(),
      text: `第 ${i + 1} 轮：把第 ${i + 1} 套卷子的解析补齐，并且只改 exam-lock.js 一个文件。`,
    });
    out.push({
      id: `a${i}`, kind: "assistant", thinking: "", model: "probe", ts: new Date(Date.now() - (n - i) * 59000).toISOString(),
      text: `第 ${i + 1} 轮做完了。\n\n- buildModal() 换成共用的一份\n- 解析区改成 <details>\n- 其余一行不动。`,
    });
  }
  return out;
}

const LONG = rounds(320);
const ODD = rounds(4); // 索引里混了一个正文里没有的 id
const sess = (id, name, all, loadedFrom) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work/exam"), file: null, owned: true, origin: "web",
  running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "",
  all, page: all.slice(loadedFrom),
});
const LONG_S = sess("probe-long", "320 轮 · 分页载入", LONG, LONG.length - PAGE);
const ODD_S = sess("probe-odd", "索引与正文对不上", ODD, 0);

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };
const strip = (s) => {
  const { all: _a, page: _p, ...rest } = s;
  return rest;
};
const turnsIndex = (s, ids) =>
  ids.map((id, i) => {
    const item = s.all.find((x) => x.id === id);
    return { id, text: item ? item.text : `第 ${i + 1} 轮：正文里没有这一条`, images: [] };
  });
const ids = (s) => s.all.filter((x) => x.kind === "user").map((x) => x.id);

/** `history.before`：给定游标那一轮之前的两页。 */
function pageBefore(s, before) {
  const all = s.all;
  const at = all.findIndex((x) => x.id === before);
  if (at <= 0) return { items: [], hasMore: false };
  const from = Math.max(0, at - PAGE);
  return { items: all.slice(from, at), hasMore: from > 0 };
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
const sessions = { "probe-long": LONG_S, "probe-odd": ODD_S };
let olderRequests = 0;
let pageDelay = 0;
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const s = sessions[msg.sessionId];
    if (msg.type === "subscribe") {
      const src = s ?? LONG_S;
      const idx = ids(src);
      // odd：索引最后那一条正文里没有（模拟索引与正文不一致）
      const listed = src === ODD_S ? [...idx, "ghost-missing"] : idx;
      ws.send(JSON.stringify({
        type: "session", sessionId: src.id, state: strip(src), items: src.page, approvals: [], asks: [], budget: null,
        history: { hasMore: src.id !== "probe-odd", truncated: false, turns: turnsIndex(src, listed) },
      }));
      return;
    }
    if (msg.type === "history.before") {
      olderRequests += 1;
      const src = s ?? LONG_S;
      const page = pageBefore(src, msg.before);
      if (pageDelay) await sleep(pageDelay);
      ws.send(JSON.stringify({ type: "history", sessionId: src.id, before: msg.before, items: page.items, hasMore: page.hasMore }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(LONG_S), strip(ODD_S)], manage, trash: [], tunnel: TUNNEL }));
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
const paneTop = (page) => rect(page, ".chat-scroll").then((r) => r.top);
const gapBelow = (page) => page.evaluate(() => {
  const s = document.querySelector(".chat-scroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight;
});
const userCount = (page) => page.locator(".chat-scroll .msg.user").count();
/** 展开面板：收起时悬停那块透明的 .turn-hit，等它真的展开并落定（`.open` + `.settled`）。
 *  已经展开时再 hover .turn-hit 会撞上 pointer-events:none —— 它被自己的面板盖住了。 */
async function openPanel(page) {
  if (await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open"))) return;
  await page.locator(".turn-hit").hover();
  await until(async () => page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open")), 4000, "the list opens");
  await until(async () => page.evaluate(() => document.querySelector(".turn-rail").classList.contains("settled")), 4000, "the expansion settles");
}
/** 把面板滚到最下面（最新那一轮）。 */
async function listToBottom(page) {
  await page.evaluate(() => {
    const l = document.querySelector(".turn-list");
    l.scrollTop = l.scrollHeight;
  });
  await sleep(250);
}
/** 把面板滚到最上面（ghost 那一段在顶上）：窗口化只画看得见的那几行，不滚过去 DOM 里就没有它们。 */
async function listToTop(page) {
  await page.evaluate(() => {
    document.querySelector(".turn-list").scrollTop = 0;
  });
  await sleep(250);
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");
  await page.locator('.session-card[data-id="probe-long"]').click();
  await until(async () => (await userCount(page)) === 20, 8000, "20 loaded rounds");
  await sleep(300);

  // 1) 未载入的那一段以 ghost 行占位（320 轮里 300 轮还没载入）。行是窗口化的，只画看得见的
  //    那几行 —— 所以这里先把面板展开、滚到最上面，再看最前面那几条是不是 ghost。
  await openPanel(page);
  await listToTop(page);
  const total320 = await page.evaluate(() => {
    const l = document.querySelector(".turn-list");
    return Math.round(Number(getComputedStyle(document.querySelector(".turn-rail")).getPropertyValue("--turn-rows-h").replace("px", "")) / 28);
  });
  const rows = page.locator(".turn-row");
  const ghosts = await page.locator(".turn-row.ghost").count();
  log("rendered rows:", await rows.count(), "ghosts on screen:", ghosts, "rounds (rows-h/28 ≈):", total320);
  assert((await rows.count()) > 3 && (await rows.count()) < 320, `the rows are windowed (got ${await rows.count()})`);
  assert(ghosts > 0, `the top of the list is ghost rows (got ${ghosts})`);

  // 2) 点第 4 轮（未载入）→ 自动往回翻页，直到它到货、顶到视口、闪一下。
  // 行的 DOM 顺序不等于轮次顺序（窗口化会复用节点、新节点补在末尾），一律按 data-i 找。
  const target = await page.evaluate(() => document.querySelector('.turn-row[data-i="3"]')?.textContent?.trim() ?? null);
  log("target row:", JSON.stringify(target));
  assert(target !== null && target.includes("第 4 轮"), `the 4th row is the 4th round (got ${JSON.stringify(target)})`);
  await page.locator('.turn-row[data-i="3"]').click();
  await until(async () => (await userCount(page)) > 20, 20000, "older pages arrive");
  // 高亮只亮 1200ms，而平滑滚动要飞一阵 —— 在等落点的同时记下「它闪过了没有」。
  let flashed = false;
  await until(async () => {
    const state = await page.evaluate(() => {
      const users = [...document.querySelectorAll(".chat-scroll .msg.user")];
      const pane = document.querySelector(".chat-scroll").getBoundingClientRect();
      const hit = users.findIndex((m) => m.classList.contains("turn-flash"));
      const target = users[3];
      return { flash: hit, top: target ? target.getBoundingClientRect().top - pane.top : null };
    });
    if (state.flash === 3) flashed = true;
    return state.top !== null && Math.abs(state.top - 6) < 20;
  }, 20000, "the 4th round reaches the top");
  const landed = await rect(page, ".chat-scroll .msg.user", 3);
  log("round 4 top:", landed.top.toFixed(1), "pane:", (await paneTop(page)).toFixed(1), "gap below:", await gapBelow(page), "requests:", olderRequests, "loaded:", await userCount(page));
  assert(flashed, "the target round flashes while the jump lands");
  assert(await page.locator(".chat-jump").isVisible(), "auto-paging jump stops following");
  // `.turn-note` 是常驻节点（turns.ts 建一次，setNote(null) 只把它 hidden 起来），所以看可见性。
  assert(!(await page.locator(".turn-note").isVisible()), "no failure note on a successful jump");
  await page.mouse.move(40, 40);
  await page.screenshot({ path: path.join(OUT, "1-ghost-jump.png") });

  // 2b) 跳完以后「你在哪一轮」得对得上 —— 行上的 cur 与刻度上的 cur 都指向第 4 轮。
  const curRow = await page.evaluate(() => document.querySelector(".turn-row.cur")?.textContent?.trim() ?? null);
  const curDash = await page.evaluate(() => {
    const row = document.querySelector(".turn-row.cur");
    return row ? row.querySelector(".dash").getBoundingClientRect().width : 0;
  });
  log("cur row:", JSON.stringify(curRow), "cur dash width:", curDash);
  assert(curRow !== null && curRow.includes("第 4 轮"), `the current row is the round we landed on (got ${JSON.stringify(curRow)})`);
  assert(curDash > 10, `the current dash is the long one (got ${curDash})`);

  // 2b2) 「你在哪」跟着视口顶部走：滚到第 200 轮，行上的 cur 必须正好是第 200 轮（320 轮已全载入）。
  const at200 = await page.evaluate(() => {
    const s = document.querySelector(".chat-scroll");
    const node = document.querySelectorAll(".chat-scroll .msg.user")[199];
    const top = node.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 6;
    s.scrollTop = top;
    return top;
  });
  await sleep(400);
  const cur200 = await page.evaluate(() => document.querySelector(".turn-row.cur")?.textContent?.trim() ?? null);
  log("scrolled to round 200 (scrollTop", Math.round(at200), ") → cur row:", JSON.stringify(cur200?.slice(0, 10)));
  assert(cur200 !== null && cur200.startsWith("第 200 轮"), `the current row follows the viewport top (got ${JSON.stringify(cur200)}`);

  // 2c) 键盘这条路：焦点进到某一行上（面板自己会展开），Enter 落在那一轮的顶上。
  await openPanel(page);
  const tickRound = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".turn-row")].sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i))[8];
    row.focus();
    return Number(row.dataset.i);
  });
  await page.keyboard.press("Enter");
  await sleep(50);
  const kbFlash = await page.evaluate(() => document.querySelector(".chat-scroll .msg.user.turn-flash")?.textContent?.slice(0, 12) ?? null);
  log("keyboard pick → tick index", tickRound, "flash:", JSON.stringify(kbFlash));
  assert(kbFlash !== null, "Enter on a focused tick jumps to its round and flashes it");
  await sleep(600);

  // 3) 中途换会话：平滑滚动半路切到另一条，新会话不能被带偏（仍停在底部、仍在跟流）。
  await openPanel(page);
  await listToBottom(page);
  await page.locator(".turn-row").last().click();   // 最后一轮：从第 4 轮跳过去，平滑滚动要飞一阵
  await sleep(80);
  await page.locator('.session-card[data-id="probe-odd"]').click();
  await until(async () => (await userCount(page)) === 4, 8000, "switched to the 4-round session");
  await sleep(700);
  log("after switching mid-jump → gap below:", await gapBelow(page), "jump button visible:", await page.locator(".chat-jump").isVisible());
  assert((await gapBelow(page)) < 4, "the new session is still at the bottom after a jump was in flight");

  // 4) 索引里有一条正文没有的轮次：点了就说一声，3 秒后自己消失，不把带子卡在 busy。
  const busy = await page.locator(".turn-rail.busy").count();
  assert(busy === 0, "the rail is not left spinning");
  await openPanel(page);
  await listToTop(page);
  const ghostRows = page.locator(".turn-row.ghost");
  await until(async () => (await ghostRows.count()) === 1, 4000, "the not-loaded round shows up as a ghost row");
  log("odd session ghost rows:", await ghostRows.count());
  assert((await ghostRows.count()) === 1, `one round is missing from the transcript index (got ${await ghostRows.count()})`);
  await ghostRows.first().click();
  await until(async () => page.locator(".turn-note").isVisible(), 6000, "the failure note shows up");
  const note = (await page.locator(".turn-note").innerText()).trim();
  log("note:", JSON.stringify(note));
  assert(note.includes("没翻到第"), `the note says which round was not found (got ${JSON.stringify(note)})`);
  await page.screenshot({ path: path.join(OUT, "2-note.png") });
  await until(async () => !(await page.locator(".turn-note").isVisible()), 5000, "the note clears itself (hidden, not removed)");
  assert((await page.locator(".turn-rail.busy").count()) === 0, "the rail stops spinning after the failure");

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
