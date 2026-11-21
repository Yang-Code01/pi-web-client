/**
 * Probe: the one path chip under the composer (E).
 *
 * - repo session: `alpha/web ⎇`, one line, no separate branch chip; the full path, branch and
 *   dirty count live in the tooltip and in the window the chip opens.
 * - clicking opens the BranchSheet, whose header now owns `复制路径` (the chip no longer copies).
 * - non-repo session: `beta ›`, clicking opens 目录与仓库.
 * - narrow screens still show the entry (D263 fixed); only the sub-directory is dropped.
 *
 * Run: npm run build:web && node probes/round21-cwd-line.mjs
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
const OUT = path.join(REPO, ".scratch/round21-cwd-line/shots");
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

const REPO_ROOT = path.join(REPO, ".scratch/probe-work/alpha");
const CWD_A = path.join(REPO_ROOT, "web");
const CWD_B = path.join(REPO, ".scratch/probe-work/beta");
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
  if (url.pathname === "/api/git") {
    const dir = path.resolve(url.searchParams.get("dir") ?? "");
    const inside = dir === REPO_ROOT || dir.startsWith(REPO_ROOT + path.sep);
    return json(200, inside ? { repo: REPO_ROOT, branch: "main", detached: false, empty: false, dirty: 3 } : { repo: null });
  }
  if (url.pathname === "/api/git/probe") return json(200, { probes: {}, truncated: false });
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
  if (url.pathname.startsWith("/api/git/")) return json(500, { error: "probe: header only" });
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
    const sub = chip.querySelector(".cwd-sub");
    return {
      exists: true,
      hidden: chip.hidden,
      display: cs.display,
      visible: !chip.hidden && cs.display !== "none" && r.height > 0,
      text: chip.querySelector(".cwd-path")?.textContent ?? "",
      visibleText: chip.querySelector(".cwd-path")?.innerText ?? "",
      chipText: chip.innerText,
      subDisplay: sub ? getComputedStyle(sub).display : "none",
      title: chip.getAttribute("title") ?? "",
      inStatusRow: Boolean(status?.contains(chip)),
      firstChild: chip.parentElement?.firstElementChild === chip,
      rowTop: r.top,
      rowBottom: r.bottom,
      rowRight: r.right,
      statusLeft: sr?.left ?? null,
      gitTails: document.querySelectorAll(".git-chip").length,
      strayRows: document.querySelectorAll(".cwd-line").length,
    };
  });

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], locale: "zh-CN" });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 3, 8000, "3 user messages");
  await sleep(400);

  // 1) 左栏展开：路径入口在，仓库内是 `alpha/web ⎇`，没有第二颗分支 chip
  const opened = await shown(page);
  log("left open:", opened);
  assert(opened.exists, "the path chip is mounted in the status row");
  assert(opened.strayRows === 0, "no separate cwd row is rendered any more");
  assert(opened.visible, `with the left column open the path shows too (got visible=${opened.visible}, display=${opened.display})`);
  assert(opened.text === "alpha/web", `repo + sub-directory, not the full path (got ${JSON.stringify(opened.text)})`);
  assert(opened.title.includes(CWD_A), `tooltip carries the full path (got ${JSON.stringify(opened.title)})`);
  assert(opened.title.includes("main"), "tooltip carries the branch name");
  assert(opened.title.includes("3 个未提交改动"), "tooltip carries the dirty count");
  assert(opened.gitTails === 0, "no separate .git-chip in the line");
  assert(opened.inStatusRow && opened.firstChild, "the path is the first thing in the status row");
  await page.screenshot({ path: `${OUT}/1-open.png` });

  // 2) 收起左栏：同一颗仍在，位置不变
  const toggle = page.locator('.side-toggle[data-side="left"]');
  assert(await toggle.count() === 1, "there is a left collapse toggle");
  await toggle.click();
  await until(async () => (await shown(page)).visible, 4000, "the path chip to appear");
  const closed = await shown(page);
  log("left collapsed:", closed);
  assert(closed.text === "alpha/web", `path label survives the collapse (got ${JSON.stringify(closed.text)})`);
  assert(closed.gitTails === 0, "still no separate branch chip");
  const chipBox = await rect(page, ".cwd-chip");
  const hintBox = await rect(page, ".composer .hint");
  const rowBox = await rect(page, ".composer .row");
  const composerBox = await rect(page, ".composer");
  const paneBox = await rect(page, ".chat-pane");
  log("boxes:", { chipBox, hintBox, rowBox });
  assert(hintBox.top >= rowBox.bottom - 1, "sanity: the hint row is under the input row");
  assert(composerBox.bottom - hintBox.bottom <= 26, "the status row is still the bottom-most thing in the composer");
  assert(chipBox.left >= composerBox.left && chipBox.left < composerBox.left + 40, `path starts at the composer's left padding (${chipBox.left} vs ${composerBox.left})`);
  assert(chipBox.right <= paneBox.right, "the path does not overflow the chat pane");
  await page.screenshot({ path: `${OUT}/2-collapsed.png` });

  // 3) 点一下开分支工作台；复制路径已经搬进窗标题栏
  await page.locator(".cwd-chip").click();
  await until(async () => (await page.locator(".branch-sheet").count()) >= 1, 5000, "branch workbench");
  const labels = await page.locator(".branch-sheet .branch-tools button").allInnerTexts();
  log("branch header:", labels.map((s) => s.trim()).filter(Boolean).join(" · "));
  assert(labels.some((s) => s.includes("复制分支名")), "the branch copy button is in the header");
  assert(labels.some((s) => s.includes("复制路径")), "the path copy button is in the header");
  await page.locator('.branch-sheet [data-copy-path="1"]').click();
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  log("clipboard:", clip);
  assert(path.resolve(clip) === path.resolve(CWD_A), `the window copies the full cwd (clipboard=${JSON.stringify(clip)})`);
  await page.screenshot({ path: `${OUT}/3-workbench.png` });
  await page.locator(".branch-sheet .branch-x").click();
  await until(async () => (await page.locator(".branch-sheet").count()) === 0, 4000, "workbench closes");

  // 4) 换到非仓库会话：`beta ›`，点开目录与仓库
  await toggle.click();
  await until(async () => !(await page.evaluate(() => document.querySelector(".pane")?.hidden ?? true)), 4000, "the session list to reopen");
  await page.locator('.session-card[data-id="probe-b"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 2, 8000, "session B transcript");
  await until(async () => (await page.locator(".cwd-chip").innerText()).includes("beta"), 5000, "chip for B");
  const b = await shown(page);
  log("session B:", b);
  assert(b.visible, "the path stays visible after switching sessions with the list open");
  assert(b.text === "beta", `non-repo shows the last segment (got ${JSON.stringify(b.text)})`);
  assert(b.visibleText.includes("›") || b.chipText.includes("›"), "non-repo shows the chevron");
  assert(!b.text.includes("⎇"), "no git mark outside a repo");
  assert(b.title.includes("点一下打开目录与仓库"), "the tooltip explains the folder/repos click");
  assert(b.gitTails === 0, "no branch chip outside a repo");
  await page.screenshot({ path: `${OUT}/4-session-b.png` });
  await page.locator(".cwd-chip").click();
  await until(async () => (await page.locator(".repos-sheet").count()) >= 1, 5000, "folder + repos window");
  assert((await page.locator(".repos-sheet .repos-copy").count()) === 1, "the folder window keeps its copy-path button");
  await page.screenshot({ path: `${OUT}/5-repos.png` });
  await page.locator(".repos-sheet .repos-x").click();
  await until(async () => (await page.locator(".repos-sheet").count()) === 0, 4000, "folder window closes");

  // 5) 窄屏：入口还在，只把子目录藏掉（D263 修复）
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".cwd-chip").innerText()).includes("alpha"), 5000, "chip for A again");
  await page.setViewportSize({ width: 760, height: 900 });
  await sleep(500);
  const narrow = await shown(page);
  log("narrow:", narrow);
  assert(narrow.visible, `below 900px the entry stays visible (got visible=${narrow.visible})`);
  assert(narrow.text === "alpha/web", "the DOM still knows both parts");
  assert(narrow.subDisplay === "none", `narrow hides the sub-directory (display=${narrow.subDisplay})`);
  assert(narrow.visibleText === "alpha", `narrow shows only the repo name (got ${JSON.stringify(narrow.visibleText)})`);
  assert(narrow.gitTails === 0, "narrow still has no second branch chip");
  await page.screenshot({ path: `${OUT}/6-narrow.png` });

  // 6) 回到桌面：子目录回来，仍是一颗
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(500);
  const back = await shown(page);
  log("back to desktop:", back);
  assert(back.visible, "going back to desktop restores the entry");
  assert(back.subDisplay !== "none", "the sub-directory comes back");
  assert(back.text === "alpha/web", "the full label comes back");
  assert(back.gitTails === 0, "still one chip");

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
