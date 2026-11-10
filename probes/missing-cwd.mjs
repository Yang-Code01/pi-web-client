/**
 * Probe: 会话的工作目录没了（D228）。
 *
 * 只有浏览器能回答的：那条提示卡什么时候出现、默认填的是不是原来目录的上一级、按下去发的
 * 是什么、复制完之后是不是真的打开了新会话。桩桥只喂一段会话快照 + 列表。
 *
 * 检查：
 *   1. cwdMissing 的会话打开后出现 `.cwd-fix`，里面写着那个已经没了的路径；
 *   2. 输入框默认是它的上一级目录（改名那种情况最常见）；
 *   3. 点「复制成新会话」→ 桥收到 {type:"forkCwd", sessionId, cwd}，且 cwd 是输入框里的值；
 *   4. 桥回 forkCwd.result → 页面订阅了新会话（发送 subscribe），并提示复制成功；
 *   5. 回一个 error → 卡片还在、按钮能再点、错误说得出来；
 *   6. 点「先不管」→ 卡片消失（这次打开页面不再打扰）。
 *
 * Run: npm run build:web && PI_WEB_PORT=7943 node probes/missing-cwd.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7943);
const OUT = path.join(REPO, ".scratch/missing-cwd/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(60);
  }
  log(`timeout waiting for ${what}`);
  return false;
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const GONE = "/Users/someone/work/老的工程名";
const PARENT = "/Users/someone/work";
const SESSION = { id: "probe-gone", name: "目录没了的会话", cwd: GONE, file: "/tmp/probe-gone.jsonl", owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "历史在这里", cwdMissing: true };
const NEW_ID = "probe-new-1";
const NEW = { ...SESSION, id: NEW_ID, name: "复制出来的会话", cwd: PARENT, cwdMissing: false, updatedAt: Date.now() };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "之前聊过的事" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "历史在这里。" },
];

let sock = null;
const sent = [];
const send = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

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
    sent.push(msg);
    if (msg.type === "subscribe") {
      const s = msg.sessionId === NEW_ID ? NEW : SESSION;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const sentTypes = () => sent.map((m) => m.type);
const findFork = () => sent.filter((m) => m.type === "forkCwd").at(-1);

let browser;
const errors = [];
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();

  // 1. 卡片出现，写着那个没了的路径。
  const barOk = await until(async () => (await page.locator(".cwd-fix").count()) === 1, 8000, "cwd-fix bar");
  check(barOk, "「工作目录没了」的卡片出现了");
  const text = await page.locator(".cwd-fix-text").innerText();
  check(text.includes(GONE), `卡片里写着那个路径（${text.slice(0, 40)}…）`);
  const input = page.locator(".cwd-fix-input");
  check((await input.count()) === 1, "有一个填目标目录的输入框");

  // 2. 默认填上一级目录。
  check((await input.inputValue()) === PARENT, `输入框默认是上一级（${await input.inputValue()}）`);
  await page.screenshot({ path: path.join(OUT, "1-bar.png") });

  // 3. 复制：发出去的 cwd 就是输入框里的值。
  await page.locator(".cwd-fix-row .btn.primary").click();
  const forked = await until(() => Boolean(findFork()), 5000, "forkCwd sent");
  check(forked && findFork().sessionId === SESSION.id, "按下去发了 forkCwd，带的是这个会话的 id");
  check(findFork().cwd === PARENT, `带的是输入框里的目录（${findFork().cwd}）`);

  // 5. 先回一个 error：卡片还在、错误说得出来、按钮能再点。
  send({ type: "forkCwd.result", reqId: findFork().reqId, from: SESSION.id, error: "目标目录不存在：/nope" });
  const errShown = await until(async () => (await page.locator(".notice.error").count()) >= 1, 5000, "error notice");
  check(errShown, "失败时说出来了");
  const again = page.locator(".cwd-fix-row .btn.primary");
  check((await again.count()) === 1 && !(await again.isDisabled()), "按钮回到可点");
  await page.screenshot({ path: path.join(OUT, "2-error.png") });

  // 4. 再来一次，这回成功：页面订阅新会话。
  await again.click();
  await until(() => sent.filter((m) => m.type === "forkCwd").length >= 2, 5000, "second forkCwd");
  const second = findFork();
  send({ type: "forkCwd.result", reqId: second.reqId, from: SESSION.id, sessionId: NEW_ID });
  const opened = await until(() => sent.some((m) => m.type === "subscribe" && m.sessionId === NEW_ID), 5000, "subscribe new");
  check(opened, "复制成功后页面打开了新会话（发了 subscribe）");
  check((await page.locator(".cwd-fix").count()) === 0, "新会话没有那张卡片");
  await page.screenshot({ path: path.join(OUT, "3-copied.png") });

  // 6. 回到原来的会话，「先不管」把它收起来。
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".cwd-fix").count()) === 1, 8000, "bar again");
  await page.locator(".cwd-fix-row .btn.ghost").click();
  const hidden = await until(async () => (await page.locator(".cwd-fix").count()) === 0, 5000, "bar hidden");
  check(hidden, "「先不管」把卡片收起来了");

  check(errors.length === 0, `控制台没有报错${errors.length ? `：${errors.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser?.close().catch(() => {});
  wss.close();
  server.close();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
