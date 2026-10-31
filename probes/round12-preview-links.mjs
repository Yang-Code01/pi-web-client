/**
 * Probe: Q-020（定案）— 纯文件名不再是链接。
 *
 * 规则：只有带目录的路径才渲染成可点的链接（`docs/DECISIONS.md`、`F:\dir\a.md`）；
 * 裸名字（`问题记录.md`）不携带位置，既不加链接、也不做任何"按会话目录猜"的重试。
 *
 * 断言：
 *   1. 正文里裸名字（普通文本与反引号两种写法）都不是链接，反引号那处仍然是 <code>
 *   2. `docs/DECISIONS.md` 与绝对路径是链接，且 title 就是原样路径
 *   3. 点相对路径 → 只发一次 /api/preview（没有兜底第二跳），失败就照直说
 *
 * Run: node probes/round12-preview-links.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7911;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round12-links/shots";
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = "F:/pi-web-client";
const ABS = "F:\\yqm\\pi-cli-web-test\\问题记录.md";
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
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SESSIONS = [
  { id: "probe-a", name: "会话甲", cwd: CWD, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "文档" },
];
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "链接规则" },
  {
    kind: "assistant",
    id: "a1",
    ts: Date.now() - 50_000,
    model: "pi",
    text: [
      "普通文本里的 问题记录.md 不该是链接。",
      "反引号里的 `问题记录.md` 也不该是链接。",
      "相对路径 `docs/DECISIONS.md` 该是链接。",
      `绝对路径 \`${ABS}\` 该是链接。`,
    ].join("\n\n"),
  },
];

const asked = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ME));
  if (url.pathname === "/api/preview" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* ignore */
      }
      const want = String(body.path ?? "");
      asked.push(want);
      if (want === ABS) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ token: "tok", rel: "问题记录.md", name: "问题记录.md", abs: ABS, size: 40, mtime: Date.now(), kind: "markdown" }));
      }
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `文件不存在：${CWD}\\${want}` }));
    });
    return;
  }
  if (url.pathname.startsWith("/raw/")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("# 打开成功\n\n这是绝对路径指向的文件。");
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
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: "probe-a", state: SESSIONS[0], items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session cards");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) 裸名字无论怎么写都不该有链接
  const links = await page.locator(".msg a").evaluateAll((els) =>
    els.map((el) => ({ text: (el.textContent ?? "").trim(), title: el.getAttribute("title") ?? "" })),
  );
  log("正文里的链接:", JSON.stringify(links));
  const bare = links.filter((l) => l.text === "问题记录.md" || l.title === "预览 问题记录.md");
  assert(bare.length === 0, `纯文件名不该变成链接（找到 ${bare.length} 个）`);
  const bareCode = await page.locator(".msg p", { hasText: "反引号里的" }).locator("code").first().textContent();
  assert(bareCode?.trim() === "问题记录.md", `反引号里仍是普通代码（拿到 ${JSON.stringify(bareCode)}）`);

  // 2) 带目录的两种写法都该是链接，title 就是原样路径
  const rel = page.locator(".msg a", { hasText: "docs/DECISIONS.md" }).first();
  const abs = page.locator(".msg a", { hasText: "问题记录.md" }).first();
  assert((await rel.count()) === 1, "相对路径该是链接");
  assert((await abs.count()) === 1, "绝对路径该是链接");
  const relTitle = await rel.getAttribute("title");
  const absTitle = await abs.getAttribute("title");
  assert(relTitle === "预览 docs/DECISIONS.md", `相对链接的 title 原样保留（拿到 ${JSON.stringify(relTitle)}）`);
  assert(absTitle === `预览 ${ABS}`, `绝对链接的 title 原样保留（拿到 ${JSON.stringify(absTitle)}）`);
  await page.screenshot({ path: path.join(OUT, "1-links.png") });

  // 3) 点相对路径：只发一次请求，失败就照直说，不再按其它目录猜
  await rel.click();
  await until(async () => (await page.locator(".viewer-msg.err").count()) === 1, 8000, "error box");
  const err = await page.locator(".viewer-msg").innerText();
  log("dead end:", err.replace(/\s+/g, " ").slice(0, 120));
  assert(asked.length === 1, `只发一次 /api/preview（发了 ${asked.length} 次：${JSON.stringify(asked)}）`);
  assert(asked[0] === "docs/DECISIONS.md", `请求体就是链接里的路径（拿到 ${JSON.stringify(asked[0])}）`);
  assert(err.includes("文件不存在"), "保留 bridge 的原话");
  assert((await page.locator(".viewer-msg").innerText()).includes("docs/DECISIONS.md"), "报错里带上了实际解析出的路径");
  await page.screenshot({ path: path.join(OUT, "2-deadend.png") });

  // 4) 绝对路径照旧能打开
  await abs.click();
  await until(async () => (await page.locator(".viewer-body").innerText()).includes("打开成功"), 8000, "abs preview");
  assert(asked.length === 2 && asked[1] === ABS, `绝对路径只发一次请求（${JSON.stringify(asked)}）`);

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
