/**
 * Probe: Mermaid 图（D227）。
 *
 * 只有真浏览器能回答的问题：```mermaid 围栏画出来了吗、画出来的是图还是原文、模式改了以后
 * 转录跟着重画吗、坏语法会不会把原文一起吞掉。桩桥服务 `web/dist`，只喂一段会话快照。
 *
 * 检查：
 *   1. 开启（streaming）→ `.md-mermaid` 里长出 `<svg>`，标签文字对得上，原文 `<pre>` 被换掉；
 *   2. 同一段 markdown 里的其它围栏照旧高亮（没被 mermaid 顺手吃掉）；
 *   3. 坏语法 → 图不出、原文还在、下面一句人话（`.md-mermaid-error`），页面不炸；
 *   4. 推一条 `mermaid: "off"` 的会话状态 → 转录重画成原文，svg 消失（不重建页面）；
 *   5. 再推回 `streaming` → 图回来（缓存命中，不用重新下载）。
 *
 * Run: npm run build:web && PI_WEB_PORT=7941 node probes/mermaid-render.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7941);
const OUT = path.join(REPO, ".scratch/mermaid-render/shots");
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
    await sleep(80);
  }
  log(`timeout waiting for ${what}`);
  return false;
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = { id: "probe-mermaid", name: "流程图探针", cwd: REPO, file: null, owned: false, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "mermaid", mermaid: "streaming" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

const GOOD = ["```mermaid", "graph TD", "  A[开始] --> B{要不要画}", "  B -->|要| C[画成图]", "  B -->|不要| D[留原文]", "```"].join("\n");
const BROKEN = ["```mermaid", "graph TD", "  A[没有闭合的方括号 --> B", "```"].join("\n");
const TS = ["```ts", "const x: number = 1;", "```"].join("\n");

const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "画一张流程图" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: `好，先看流程：\n\n${GOOD}\n\n代码这边没动：\n\n${TS}\n` },
  { kind: "assistant", id: "a2", ts: Date.now() - 40_000, model: "pi", text: `这段语法是坏的：\n\n${BROKEN}\n` },
];

let sock = null;
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
    if (msg.type === "subscribe") {
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
const errors = [];
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // 桩桥只服务 web/dist，页面顺手要的 /api/* 会 404 —— 那是探针的锅，不是功能的。
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg.assistant").count()) >= 2, 8000, "messages");

  // 1. 图长出来了：svg 在 .md-mermaid 里，原文 pre 让位。
  const drew = await until(async () => (await page.locator(".md-mermaid svg").count()) >= 1, 20000, "svg");
  check(drew, "mermaid 围栏画成了 <svg>");
  const label = await page.evaluate(() => document.querySelector(".md-mermaid svg")?.textContent ?? "");
  check(label.includes("开始") && label.includes("画成图"), `图里有原图的标签（${JSON.stringify(label.replace(/\s+/g, " ").trim().slice(0, 40))}）`);
  check((await page.locator(".md-mermaid:not(.failed) pre").count()) === 0, "画出来后原文 <pre> 被换掉，不留两份");
  const boxes = await page.locator(".md-mermaid svg").first().boundingBox();
  check(Boolean(boxes) && boxes.width > 100 && boxes.height > 40, `图有实际尺寸（${Math.round(boxes?.width ?? 0)}×${Math.round(boxes?.height ?? 0)}）`);
  await page.screenshot({ path: path.join(OUT, "1-rendered.png") });

  // 2. 旁边的 ts 围栏照旧是代码块（没被当成图吞掉）。
  check((await page.locator('pre[data-lang="ts"]').count()) === 1, "同一段消息里的 ts 围栏照旧是代码块");

  // 3. 坏语法：原文留着，下面一句人话。
  const broke = await until(async () => (await page.locator(".md-mermaid.failed").count()) >= 1, 20000, "failed block");
  check(broke, "画不出来的那段标成 failed");
  check((await page.locator(".md-mermaid.failed pre").count()) >= 1, "画不出来时原文还在");
  const why = await page.locator(".md-mermaid-error").first().innerText();
  check(/图画不出来/.test(why), `下面写了为什么（${JSON.stringify(why.slice(0, 40))}）`);
  await page.screenshot({ path: path.join(OUT, "2-broken.png") });

  // 4. 模式改成 off（推一条会话状态）：页面重画成原文，不用刷新。
  send({ type: "session.state", session: { ...SESSION, mermaid: "off" } });
  const offGone = await until(async () => (await page.locator(".md-mermaid").count()) === 0, 8000, "mermaid off");
  check(offGone, "mermaid 改成 off 后图上消失");
  check((await page.locator('pre[data-lang="mermaid"]').count()) >= 1, "off 时那段回到原文代码块");
  await page.screenshot({ path: path.join(OUT, "3-off.png") });

  // 5. 改回 streaming：图回来（mermaid 本体已在缓存里，没有第二次下载）。
  send({ type: "session.state", session: { ...SESSION, mermaid: "streaming" } });
  const back = await until(async () => (await page.locator(".md-mermaid svg").count()) >= 1, 8000, "mermaid back");
  check(back, "改回 streaming 后图回来了");

  check(errors.length === 0, `控制台没有报错${errors.length ? `：${errors.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser?.close().catch(() => {});
  wss.close();
  server.close();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
