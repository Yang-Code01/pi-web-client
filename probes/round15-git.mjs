/**
 * Probe: Q-021 — when the session's cwd is inside a git repository the composer line shows the
 * branch instead of the key hints (Enter 发送 / 粘贴截图), and the hints move into the chip's
 * tooltip so nothing is lost. Not a repository → the old hints stay untouched.
 *
 * Stands in for the bridge, so `/api/git` can answer with (and without) a repo.
 *
 * Run: node probes/round15-git.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7909;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round15-git/shots";
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

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const REPO = { repo: "F:/pi-web-client", branch: "main", detached: false, empty: false, dirty: 3 };
const A = { id: "probe-git", name: "仓库里的会话", cwd: "F:/pi-web-client", file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "分支探针" };
const B = { id: "probe-plain", name: "不在仓库里的会话", cwd: "F:/yqm/pi-cli-web-test", file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now() - 60_000, approvals: 0, asks: 0, locked: false, preview: "普通目录" };
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
  // Q-021: the bridge answers this; the repo boolean is what the composer keys off.
  if (url.pathname === "/api/git") {
    const dir = url.searchParams.get("dir") ?? "";
    const fresh = url.searchParams.get("fresh") === "1";
    gitCalls.push({ dir, fresh });
    return json(200, dir.replace(/\\/g, "/").startsWith("F:/pi-web-client") ? REPO : { repo: null });
  }
  if (url.pathname === "/api/dirs") {
    const dir = url.searchParams.get("path") ?? "";
    return json(200, { path: dir, parent: "F:", dirs: ["web", "bridge"], files: [], error: "" });
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
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 2, 8000, "session cards");

  // 1) A session inside a repo: the branch takes the line, the key hints live in the tooltip.
  await page.locator(".session-card", { hasText: A.name }).first().click();
  const hint = page.locator(".hint-status").first();
  await until(async () => (await hint.locator(".git-chip").count()) >= 1, 8000, "git chip in the composer line");
  const chip = hint.locator(".git-chip").first();
  const chipText = (await chip.innerText()).replace(/\s+/g, " ").trim();
  log("chip:", chipText);
  assert(chipText.includes("main"), `the chip names the branch (got ${JSON.stringify(chipText)})`);
  assert(chipText.includes("3"), `the chip shows the dirty count (got ${JSON.stringify(chipText)})`);
  assert((await hint.locator("kbd").count()) === 0, "the key hints are gone visually");
  const title = await chip.getAttribute("title");
  log("title:", String(title).replace(/\s+/g, " | "));
  assert(String(title).includes("Enter 发送"), "the hint text moved into the tooltip");
  assert(String(title).includes("粘贴截图"), "the paste hint moved too");
  assert(String(title).includes("F:/pi-web-client"), "the tooltip names the repo root");
  assert(String(title).includes("点一下复制分支名"), "the tooltip explains the click");
  await page.screenshot({ path: path.join(OUT, "1-repo.png") });

  // 2) Clicking the chip copies the branch name (and says so for a moment).
  await chip.click();
  await until(async () => (await chip.innerText()).includes("已复制"), 4000, "clipboard feedback");
  assert((await page.evaluate(() => navigator.clipboard.readText())) === "main", "the branch name is on the clipboard");
  log("clipboard: main ✓");
  await until(async () => (await chip.innerText()).includes("main"), 4000, "branch label comes back");

  // 3) Running: the run wins, the branch stays as a flat tail on the same line.
  send({ type: "session.state", session: { ...A, running: true, updatedAt: Date.now() } });
  await until(async () => (await page.locator(".hint-status.busy").count()) >= 1, 5000, "busy line");
  const busy = page.locator(".hint-status.busy").first();
  send({ type: "tool", sessionId: A.id, phase: "start", toolCallId: "t1", name: "bash", args: { command: "npm test" }, summary: "cd F:/pi-web-client && npm test" });
  await until(async () => (await busy.locator(".git-chip.flat").count()) >= 1, 5000, "flat branch tail");
  // `.act-pop` (the hover card) hangs off the same box and carries the command on purpose — read the
  // two visible pieces, not the whole box.
  const busyText = (await busy.locator(".act-text").innerText()).trim();
  const tail = (await busy.locator(".git-chip.flat").innerText()).trim();
  log("busy:", busyText, "| tail:", tail);
  assert(busyText === "正在执行 bash", `the tool wins the line (got ${JSON.stringify(busyText)})`);
  assert(tail.includes("main"), `the branch tail is there (got ${JSON.stringify(tail)})`);
  await page.screenshot({ path: path.join(OUT, "2-running.png") });

  // 4) The run ends → the full chip is back.
  send({ type: "session.state", session: { ...A, running: false, updatedAt: Date.now() } });
  await until(async () => (await hint.locator(".git-chip:not(.flat)").count()) >= 1, 5000, "full chip after the run");
  log("flat chip → full chip ✓");

  // 5) A directory that is not a repo keeps the old key hints.
  await page.locator(".session-card", { hasText: B.name }).first().click();
  await until(async () => (await hint.locator("kbd").count()) >= 2, 8000, "key hints back for a plain directory");
  assert((await hint.locator(".git-chip").count()) === 0, "no chip outside a repository");
  const plain = (await hint.innerText()).replace(/\s+/g, " ");
  assert(plain.includes("Enter") && plain.includes("粘贴截图"), `the hints are intact (got ${JSON.stringify(plain)})`);
  log("non-repo line:", plain);
  await page.screenshot({ path: path.join(OUT, "3-non-repo.png") });

  // Switching sessions asks the bridge again (fresh=1), so a checkout in the terminal shows up.
  assert(gitCalls.filter((c) => c.fresh && c.dir.replace(/\\/g, "/") === B.cwd).length >= 1, "switching to a session refetches with fresh=1");
  log("fresh refetch on session switch ✓");
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
