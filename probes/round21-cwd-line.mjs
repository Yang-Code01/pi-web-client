/**
 * Probe: D61 — with the left column collapsed the current working directory comes back as one faint
 * line under the composer. With the list open it must stay out of the way (the selected card already
 * carries the same path), and on narrow screens the pane is a tab, not a collapse, so it stays hidden.
 *
 * Run: npm run build:web && node probes/round21-cwd-line.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7915;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round21-cwd-line/shots";
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

const ANSWER = "收到。先把现状摸清楚，再动一个文件。\n\n- 第一步：读现有的入口\n- 第二步：只改这一处\n- 第三步：跑 verify";
const items = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, kind: "user", text: `第 ${i + 1} 轮：把这一轮的任务推进一下。`, images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    out.push({ id: `a${i}`, kind: "assistant", text: ANSWER, thinking: "", model: "probe", ts: new Date(Date.now() - (n - i) * 59000).toISOString() });
  }
  return out;
};

const CWD_A = "F:/probe-work/alpha";
const CWD_B = "F:/probe-work/beta";
const base = (id, name, cwd, n) => ({
  id, name, cwd, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: items(n),
});
const A = base("probe-a", "会话 A", CWD_A, 3);
const B = base("probe-b", "会话 B", CWD_B, 2);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };
const strip = ({ items: _drop, ...rest }) => rest;

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
  if (url.pathname === "/api/git") return json(200, { repo: "F:/probe-work/alpha", branch: "main", detached: false, empty: false, dirty: 3 });
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
      const s = [A, B].find((x) => x.id === msg.sessionId) ?? A;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: strip(s), items: s.items, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A), strip(B)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rect = (page, sel) =>
  page.evaluate((s) => {
    const node = document.querySelector(s);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  }, sel);
const shown = (page) =>
  page.evaluate(() => {
    const chip = document.querySelector(".cwd-chip");
    const status = document.querySelector(".composer .hint-status");
    if (!chip) return { exists: false };
    const cs = getComputedStyle(chip);
    const r = chip.getBoundingClientRect();
    const sr = status?.getBoundingClientRect();
    return {
      exists: true,
      hidden: chip.hidden,
      display: cs.display,
      visible: !chip.hidden && cs.display !== "none" && r.height > 0,
      text: chip.querySelector(".cwd-path")?.textContent ?? "",
      title: chip.getAttribute("title") ?? "",
      inStatusRow: Boolean(status?.contains(chip)),
      firstChild: chip.parentElement?.firstElementChild === chip,
      // 和分支 chip 的关系：同一个状态行里，路径在它左边一格
      rowTop: r.top,
      rowBottom: r.bottom,
      rowRight: r.right,
      statusLeft: sr?.left ?? null,
      gitLeft: document.querySelector(".git-chip")?.getBoundingClientRect().left ?? null,
      strayRows: document.querySelectorAll(".cwd-line").length,
    };
  });

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 3, 8000, "3 user messages");
  await sleep(400);

  // 1) 左栏展开：路径必须藏着（选中的卡片上写着同一个 cwd），也不能另起一行
  const opened = await shown(page);
  log("left open:", opened);
  assert(opened.exists, "the path chip is mounted in the status row");
  assert(opened.strayRows === 0, "no separate cwd row is rendered any more");
  assert(!opened.visible, `with the left column open the path must stay hidden (got visible=${opened.visible}, display=${opened.display})`);
  await page.screenshot({ path: `${OUT}/1-open.png` });

  // 2) 收起左栏：出现，且写的正是当前会话的目录
  const toggle = page.locator('.side-toggle[data-side="left"]');
  assert(await toggle.count() === 1, "there is a left collapse toggle");
  await toggle.click();
  await until(async () => (await shown(page)).visible, 4000, "the path chip to appear");
  const closed = await shown(page);
  log("left collapsed:", closed);
  assert(closed.text === CWD_A, `path is the open session's cwd ${CWD_A} (got ${JSON.stringify(closed.text)})`);
  assert(closed.title.includes(CWD_A), `tooltip carries the full path (got ${JSON.stringify(closed.title)})`);
  assert(closed.inStatusRow && closed.firstChild, "the path sits at the head of the branch/status row, not on its own line");

  // 位置：同一行、紧挨分支 chip 左边（不另起一行，也不掉到右边那堆按钮里）
  const chipBox = await rect(page, ".cwd-chip");
  const hintBox = await rect(page, ".composer .hint");
  const rowBox = await rect(page, ".composer .row");
  const composerBox = await rect(page, ".composer");
  const paneBox = await rect(page, ".chat-pane");
  const gitBox = await rect(page, ".git-chip");
  log("boxes:", { chipBox, hintBox, gitBox, rowBox });
  assert(hintBox.top >= rowBox.bottom - 1, "sanity: the hint row is under the input row");
  assert(gitBox !== null, "the fake repo gives us a branch chip to sit next to");
  assert(Math.abs(chipBox.top - gitBox.top) <= 4 && Math.abs(chipBox.bottom - gitBox.bottom) <= 4, `path and branch share a line (chip ${chipBox.top}-${chipBox.bottom} vs branch ${gitBox.top}-${gitBox.bottom})`);
  assert(chipBox.right <= gitBox.left && gitBox.left - chipBox.right <= 14, `path sits right before the branch chip (gap ${gitBox.left - chipBox.right})`);
  assert(composerBox.bottom - hintBox.bottom <= 26, "the status row is still the bottom-most thing in the composer");
  assert(chipBox.left >= composerBox.left && chipBox.left < composerBox.left + 40, `path starts at the composer's left padding (${chipBox.left} vs ${composerBox.left})`);
  assert(chipBox.right <= paneBox.right, "the path does not overflow the chat pane");
  await page.screenshot({ path: `${OUT}/2-collapsed.png` });

  // 3) 点一下复制路径
  await page.locator(".cwd-chip").click();
  await until(async () => (await page.evaluate(() => document.querySelector(".cwd-path")?.textContent)) === "已复制", 3000, "the 已复制 flash");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  log("clipboard:", clip);
  assert(clip === CWD_A, `clicking copies the path (clipboard=${JSON.stringify(clip)})`);
  await sleep(1000);
  assert((await page.evaluate(() => document.querySelector(".cwd-path")?.textContent)) === CWD_A, "the label comes back after the flash");

  // 4) 换一个会话：左栏得先展开才能点卡片，再收起来 → 那一行换成 B 的目录
  await toggle.click();
  await until(async () => !(await shown(page)).visible, 4000, "the path to hide again when the list opens");
  await page.locator('.session-card[data-id="probe-b"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 2, 8000, "session B transcript");
  await toggle.click();
  await until(async () => (await shown(page)).visible, 4000, "the path to come back with B open");
  const afterSwitch = await shown(page);
  log("after switch:", afterSwitch);
  assert(afterSwitch.text === CWD_B, `switching sessions swaps the path to ${CWD_B} (got ${JSON.stringify(afterSwitch.text)})`);
  await page.screenshot({ path: `${OUT}/3-session-b.png` });

  // 5) 窄屏：左栏是 tab 不是折叠，这一行不该占地方
  await page.setViewportSize({ width: 760, height: 900 });
  await sleep(500);
  const narrow = await shown(page);
  log("narrow:", narrow);
  assert(!narrow.visible, `below 900px the path stays hidden (got visible=${narrow.visible})`);

  // 6) 回到桌面宽度：折叠状态还在，那一行也回来
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(500);
  const back = await shown(page);
  log("back to desktop:", back);
  assert(back.visible, "going back to desktop restores the path");

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
