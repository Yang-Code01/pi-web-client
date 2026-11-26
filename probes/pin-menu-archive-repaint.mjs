/**
 * Probe: 气泡开着时 ★ 行被重画，气泡里的「归档 / 删除」还必须发得出去。
 *
 * 报障的样子：★ 行里一颗「完成」的会话，悬停打开气泡、点归档 —— 毫无反应，胶囊留在原地，
 * 桥那边连一帧 manage 都没收到。当时别的会话都在「运行中」，`pi.status` 一直在流。
 *
 * 根因：气泡把「打开那一刻」的胶囊节点闭包进 `onArchive` / `onDelete`；`frames.ts` 把 `pi.status`
 * 一律映射成 "sessions"，`renderSessionRow()` → `pillBar.render()` → `replaceChildren()` 整条重建。
 * 旧节点脱离文档后 `host.contains(chip)` 永远为假，`archiveFromPin()` 在这里静默 return。
 *
 * 这里复现的是**真实手势**：先悬停打开气泡，把指针挪进气泡里（否则重建后新胶囊会重新触发
 * pointerenter、重开气泡锚到新节点，归档反而能成功 —— 那是假绿），再广播一帧 pi.status，
 * 最后点气泡里的按钮。断言：动作帧照发、且只发一帧；★ 行按回声收敛；没有重画的对照组照旧演动效。
 *
 * Run: npm --prefix web run build && node probes/pin-menu-archive-repaint.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST as REPO_DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

// PROBE_DIST：拿别处的构建去验同一段代码（用来在改前的 dist 上确认这条探针会红）。
const DIST = process.env.PROBE_DIST ? path.resolve(process.env.PROBE_DIST) : REPO_DIST;
const PORT = Number(process.env.PI_WEB_PORT ?? 7932);
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(path.join(REPO, ".scratch/pin-menu-archive-repaint"), { recursive: true });

let bad = 0;
const ok = (cond, what) => {
  if (!cond) bad++;
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  console.log(`FAIL timeout waiting for ${what}`);
  bad++;
  return false;
};

const CWD = path.join(REPO, ".scratch/probe-work/pin-menu");
const base = (id, name) => ({
  id, name, cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: [],
});
const A = base("probe-a", "切换模型后应该能重新评审");
const B = base("probe-b", "fast-anything");
const C = base("probe-c", "codeReview");
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [A.id, B.id, C.id], order: [], archived: [] };
const strip = ({ items: _drop, ...rest }) => rest;

const frames = [];
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
  if (url.pathname === "/api/git") return json(200, { repo: CWD, branch: "main", detached: false, empty: false, dirty: 0 });
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
const live = new Set();
const broadcast = (msg) => {
  for (const w of live) w.send(JSON.stringify(msg));
};
wss.on("connection", (ws) => {
  live.add(ws);
  ws.on("close", () => live.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      const s = [A, B, C].find((x) => x.id === msg.sessionId) ?? A;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: strip(s), items: s.items, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "manage") {
      frames.push(msg);
      const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
      if (msg.action === "archive") {
        manage.archived = msg.on ? [...new Set([...manage.archived, ...ids])] : manage.archived.filter((id) => !ids.includes(id));
      }
      if (msg.action === "delete") {
        manage.pin = manage.pin.filter((id) => !ids.includes(id));
      }
      // 真桥会广播 manage 回声；前端靠它把胶囊从 ★ 行收掉。
      broadcast({ type: "manage", manage });
      return;
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A), strip(B), strip(C)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`fake bridge on ${BASE}`);

const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-CN" });
page.on("pageerror", (e) => {
  console.log("PAGEERROR", e.message);
  bad++;
});

const chips = () => count(page, ".pin-chip[data-pin-id]");
const menuOpen = async () => (await count(page, ".pin-menu")) === 1;
const actFrames = (action) => frames.filter((f) => f.action === action);

/** 打开某颗胶囊的气泡，把指针挪进气泡（模拟用户去点按钮的手势）。 */
async function openMenu(chipText) {
  await page.locator(".pin-chip", { hasText: chipText }).first().hover();
  if (!(await until(menuOpen, 1500, "pin menu"))) return false;
  const box = await page.locator(".pin-menu").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(80);
  return true;
}

/** 标记当前第一颗胶囊，返回一个"它还活着吗"的探针。 */
const markFirstChip = () =>
  page.evaluate(() => {
    const chip = document.querySelector(".pin-chip");
    window.__probeChip = chip;
    return chip?.dataset.pinId ?? null;
  });
const markedChipAlive = () =>
  page.evaluate(() => ({
    connected: Boolean(window.__probeChip?.isConnected),
    same: window.__probeChip === document.querySelector(".pin-chip"),
  }));

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  if (!(await until(async () => (await chips()) === 3, 6000, "three pinned chips"))) throw new Error("no chips");
  await sleep(500);
  ok(true, "初始：★ 行三颗置顶会话");

  // ── 1. 归档：气泡开着时来一帧别的会话的 pi.status，整条 ★ 行重建 ────────────────
  await markFirstChip();
  await openMenu(A.name);
  broadcast({ type: "pi.status", sessionId: B.id, running: true });
  await until(async () => {
    const s = await markedChipAlive();
    return !s.connected;
  }, 2000, "chip repaint");
  const alive = await markedChipAlive();
  ok(!alive.connected && !alive.same, "重画把气泡闭包住的那颗胶囊换掉了");
  ok(await menuOpen(), "重画之后气泡还开着，用户接着点按钮");

  const beforeArchive = actFrames("archive").length;
  await page.click('.pm-item[data-act="archive"]', { timeout: 2000 });
  const archiveSent = await until(() => actFrames("archive").length > beforeArchive, 3000, "archive frame");
  const archiveFrame = actFrames("archive").at(-1);
  ok(archiveSent, "点了归档 → 桥收到 manage/archive（改前这里是 0 帧）");
  ok(JSON.stringify(archiveFrame?.ids) === JSON.stringify([A.id]) && archiveFrame?.on === true, `归档帧只带这一颗：${JSON.stringify(archiveFrame?.ids)} on=${archiveFrame?.on}`);
  ok((await until(async () => (await chips()) === 2, 3000, "archive echo")) === true, "回声之后 ★ 行剩两颗");

  // ── 2. 删除：同一个重建场景，按钮是「移入垃圾箱」 ─────────────────────────────
  await page.locator(".pin-chip", { hasText: B.name }).first().hover();
  if (!(await until(menuOpen, 1500, "pin menu (B)"))) throw new Error("no menu B");
  const box = await page.locator(".pin-menu").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(80);
  await page.evaluate(() => {
    window.__probeChip = [...document.querySelectorAll(".pin-chip[data-pin-id]")].find((n) => n.dataset.pinId === "probe-b");
  });
  broadcast({ type: "pi.status", sessionId: C.id, running: true });
  await until(async () => !(await markedChipAlive()).connected, 2000, "chip repaint (delete)");
  ok(await menuOpen(), "删除场景：重画之后气泡还开着");

  const beforeDelete = actFrames("delete").length;
  await page.click('.pm-item[data-act="delete"]', { timeout: 2000 });
  const deleteSent = await until(() => actFrames("delete").length > beforeDelete, 3000, "delete frame");
  const deleteFrame = actFrames("delete").at(-1);
  ok(deleteSent, "点了删除 → 桥收到 manage/delete（同源问题一并收口）");
  ok(JSON.stringify(deleteFrame?.ids) === JSON.stringify([B.id]), `删除帧只带这一颗：${JSON.stringify(deleteFrame?.ids)}`);
  ok((await until(async () => (await chips()) === 1, 3000, "delete echo")) === true, "回声之后 ★ 行剩一颗");

  // ── 3. 对照组：没有重画时，归档仍走原来的收拢动效并落帧 ───────────────────────
  const last = await page.evaluate(() => document.querySelector(".pin-chip[data-pin-id]")?.dataset.pinId ?? "");
  const beforeControl = actFrames("archive").length;
  await openMenu(C.name);
  await page.click('.pm-item[data-act="archive"]', { timeout: 2000 });
  ok((await until(() => actFrames("archive").length > beforeControl, 3000, "control archive frame")) === true, "没有重画时归档照常发帧（动效路径没被改坏）");
  ok((await until(async () => (await chips()) === 0, 3000, "control echo")) === true, `没有重画时回声把最后一颗（${last}）收掉`);
  ok(actFrames("archive").length === beforeArchive + 2, `归档帧总数正好 2（${beforeArchive} → ${actFrames("archive").length}）`);
} finally {
  await browser.close();
  server.close();
  for (const w of live) w.terminate();
}

console.log(bad ? `\n${bad} 项失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
