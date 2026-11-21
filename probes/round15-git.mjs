/**
 * Probe: the one path chip under the composer also carries the git mark (E).
 *
 * - repo cwd: `<repo> ⎇` (+ dot when dirty) — no branch name and no dirty count in the line;
 *   both live in the chip's title and in the window it opens.
 * - clicking it opens the BranchSheet; both copy buttons sit in that window's header.
 * - while a run is going the same chip stays first — there is no second flat branch tail.
 * - a non-repo cwd: `<last segment> ›`, clicking opens 目录与仓库.
 *
 * Stands in for the bridge, so `/api/git` can answer with (and without) a repo.
 *
 * Run: npm run build:web && node probes/round15-git.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7909);
const OUT = path.join(REPO, ".scratch/round15-git/shots");
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
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const REPO_INFO = { repo: REPO, branch: "main", detached: false, empty: false, dirty: 3 };
const A = { id: "probe-git", name: "仓库里的会话", cwd: REPO, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "分支探针" };
const B = { id: "probe-plain", name: "不在仓库里的会话", cwd: path.resolve(REPO, "..", "not-a-repo"), file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now() - 60_000, approvals: 0, asks: 0, locked: false, preview: "普通目录" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let sock = null;
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));
const gitCalls = [];

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
    const dir = url.searchParams.get("dir") ?? "";
    const fresh = url.searchParams.get("fresh") === "1";
    gitCalls.push({ dir, fresh });
    return json(200, norm(dir) === norm(REPO) ? REPO_INFO : { repo: null });
  }
  if (url.pathname === "/api/git/probe") return json(200, { probes: {}, truncated: false });
  if (url.pathname === "/api/dirs") {
    const dir = url.searchParams.get("path") ?? "";
    return json(200, { path: dir, parent: "F:", dirs: ["web", "bridge"], files: [], error: "" });
  }
  // The BranchSheet header is built synchronously; these reads can fail without hiding it.
  if (url.pathname.startsWith("/api/git/")) return json(500, { error: "probe: not needed for the header" });
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
      const state = msg.sessionId === B.id ? B : A;
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: [], approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [A, B], manage: { pin: [], order: [], archive: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "session cards");

  // 1) A session inside a repo: the path chip carries the mark, not the branch name.
  await page.locator(".session-card", { hasText: A.name }).first().click();
  const hint = page.locator(".hint-status").first();
  const chip = hint.locator(".cwd-chip").first();
  await until(async () => (await hint.locator(".cwd-chip").count()) >= 1, 8000, "path chip in the composer line");
  const chipText = (await chip.innerText()).replace(/\s+/g, " ").trim();
  log("chip:", chipText);
  assert(chipText.includes(path.basename(REPO)), `the chip names the repo (got ${JSON.stringify(chipText)})`);
  assert(chipText.includes("⎇"), `the chip has the git mark (got ${JSON.stringify(chipText)})`);
  assert(!chipText.includes("main"), `the branch name is not in the line (got ${JSON.stringify(chipText)})`);
  assert(!/\b3\b/.test(chipText), `the dirty count is not in the line (got ${JSON.stringify(chipText)})`);
  assert((await hint.locator(".git-chip").count()) === 0, "there is no second branch chip");
  assert((await hint.locator("kbd").count()) === 0, "the key hints are gone visually");
  const title = await chip.getAttribute("title");
  log("title:", String(title).replace(/\s+/g, " | "));
  assert(String(title).includes(REPO), "the tooltip carries the full path");
  assert(String(title).includes("main"), "the tooltip carries the branch name");
  assert(String(title).includes("3 个未提交改动"), "the tooltip carries the dirty count");
  assert(String(title).includes("Enter 发送"), "the hint text moved into the tooltip");
  assert(String(title).includes("粘贴截图"), "the paste hint moved too");
  assert(String(title).includes("点一下打开分支操作工作台"), "the tooltip explains the click");
  await page.screenshot({ path: path.join(OUT, "1-repo.png") });

  // 2) Clicking opens the branch workbench; both copy buttons are in its header.
  await chip.click();
  await until(async () => (await page.locator(".branch-sheet").count()) >= 1, 5000, "branch workbench");
  const branchButtons = page.locator(".branch-sheet .branch-tools button");
  const labels = await branchButtons.allInnerTexts();
  log("branch header:", labels.map((s) => s.trim()).filter(Boolean).join(" · "));
  assert(labels.some((s) => s.includes("复制分支名")), "the branch copy button is in the header");
  assert(labels.some((s) => s.includes("复制路径")), "the path copy button is in the header");
  assert((await page.locator('.branch-sheet [data-copy-path="1"]').count()) === 1, "the path copy button is marked for tests");
  await page.screenshot({ path: path.join(OUT, "2-workbench.png") });
  await page.locator(".branch-sheet .branch-x").click();
  await until(async () => (await page.locator(".branch-sheet").count()) === 0, 4000, "workbench closes");

  // 3) Running: the same chip stays first; no second flat branch tail.
  send({ type: "session.state", session: { ...A, running: true, updatedAt: Date.now() } });
  await until(async () => (await page.locator(".hint-status.busy").count()) >= 1, 5000, "busy line");
  const busy = page.locator(".hint-status.busy").first();
  send({ type: "tool", sessionId: A.id, phase: "start", toolCallId: "t1", name: "bash", args: { command: "npm test" }, summary: `cd ${REPO} && npm test` });
  await until(async () => (await busy.locator(".act-text").innerText()).includes("bash"), 5000, "tool activity");
  const busyText = (await busy.locator(".act-text").innerText()).trim();
  log("busy:", busyText);
  assert(busyText.includes("bash"), `the tool wins the line (got ${JSON.stringify(busyText)})`);
  assert((await busy.locator(".cwd-chip").count()) === 1, "the path chip is still there while running");
  assert((await busy.locator(".cwd-chip").first().evaluate((n) => n.parentElement?.firstElementChild === n)) === true, "the path chip stays first in the busy line");
  assert((await busy.locator(".git-chip").count()) === 0, "no flat branch tail while running");
  await page.screenshot({ path: path.join(OUT, "3-running.png") });

  // 4) The run ends → the same chip stays.
  send({ type: "session.state", session: { ...A, running: false, updatedAt: Date.now() } });
  await until(async () => (await page.locator(".hint-status.busy").count()) === 0, 5000, "busy line ends");
  assert((await hint.locator(".cwd-chip").count()) === 1, "the path chip survives the run");
  log("busy → idle keeps one chip ✓");

  // 5) A directory that is not a repo: last segment + chevron; clicking opens 目录与仓库.
  await page.locator(".session-card", { hasText: B.name }).first().click();
  await until(async () => (await page.locator(".cwd-chip").innerText()).includes("not-a-repo"), 8000, "chip for the plain directory");
  const plainChip = page.locator(".cwd-chip").first();
  const plainText = (await plainChip.innerText()).replace(/\s+/g, " ").trim();
  const plainTitle = await plainChip.getAttribute("title");
  log("non-repo chip:", plainText, "|", String(plainTitle).replace(/\s+/g, " | "));
  assert(plainText.includes("not-a-repo") && plainText.includes("›"), `non-repo chip is the last segment + chevron (got ${JSON.stringify(plainText)})`);
  assert(!plainText.includes("⎇"), "no git mark outside a repo");
  assert((await hint.locator("kbd").count()) === 0, "the key hints stay in the tooltip here too");
  assert(String(plainTitle).includes("点一下打开目录与仓库"), "the tooltip says the click opens folder + repos");
  await page.screenshot({ path: path.join(OUT, "4-non-repo.png") });
  await plainChip.click();
  await until(async () => (await page.locator(".repos-sheet").count()) >= 1, 5000, "folder + repos window");
  assert((await page.locator(".repos-sheet .repos-copy").count()) === 1, "the folder window keeps its copy-path button");
  await page.screenshot({ path: path.join(OUT, "5-repos.png") });
  await page.locator(".repos-sheet .repos-x").click();

  // Switching sessions asks the bridge again (fresh=1), so a checkout in the terminal shows up.
  assert(gitCalls.some((c) => c.fresh && norm(c.dir) === norm(B.cwd)), "switching to a session refetches with fresh=1");
  log("fresh refetch on session switch ✓");
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
