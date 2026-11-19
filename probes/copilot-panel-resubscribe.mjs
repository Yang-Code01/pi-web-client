/**
 * Probe: 「执行」面板的 Copilot 积分块，在重发 `session` 帧之后还在不在？
 *
 * 症状（2026-11-19，test 会话）：刚打开面板时有 Copilot 积分块，几轮之后（页面重连 / 切会话回来 /
 * stepup 重同步都会重发 subscribe）整块消失，直到下一轮结束才回来。
 * 机制：`subscribe` 只发 `session` 帧，前端 `case "session"` 里无条件 `this.copilot = null`，
 * 而 `copilot` 帧只在 boot / agent_end / agent_settled 发 —— 订阅这条路上没人补。
 *
 * 桩桥按四种形状发帧（见 `SPECS`）。修复后 bridge 的 `session` 帧自带 copilot，所以探针主要量
 * 前端那一半：拿到会话帧就必须把块画回来；反过来，帧里什么都没给（旧桥重订阅）时不许编数据。
 *
 * Run: npm --prefix web run build && node probes/copilot-panel-resubscribe.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 7909);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const view = { hasCopilot: true, credits: 434.39, requests: 105, lastAt: null, estimated: true, otherCost: 0, account: null, reconcile: null };
/**
 * 四种会话形状，`frame` 说会话帧自带的 `copilot` 是什么：
 * - `view` —— 修复后真 bridge 的形状（`snapshot()` 带缓存视图）
 * - `null` —— 纯非 copilot 会话（对照）
 * - `omit` —— 旧 bridge：帧里压根没这个键。再分两种：`followUp` 真就是 boot / 轮末
 *   「帧后紧跟一条 copilot 帧」；不跟的那种是**重订阅**——旧桥上它什么也不补，
 *   也就是修复前的发病路径。探针锁的是「前端不编数据」，并非「旧桥变好」。
 */
const SPECS = [
  { id: "st-cop", name: "copilot 会话", frame: "view", followUp: false },
  { id: "st-plain", name: "普通会话", frame: "null", followUp: false },
  { id: "st-old-live", name: "旧桥 · 另发帧", frame: "omit", followUp: true },
  { id: "st-old-idle", name: "旧桥 · 重订阅", frame: "omit", followUp: false },
];
/** 帧里不带 `frame` / `followUp` 这两个内部字段的公开会话列表。 */
const publicState = ({ frame: _f, followUp: _u, ...rest }) => rest;
const SESSIONS = SPECS.map((s, i) => ({
  ...s,
  cwd: REPO,
  ws: `f:/pi-web-client-w${i}`,
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
}));
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const MANAGE = { pin: [], order: SESSIONS.map((s) => s.id), archived: [] };
const WORKSPACE = { groups: [], overrides: {}, keys: {} };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname === "/api/git") return json(200, { repo: null });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const wss = new WebSocketServer({ noServer: true });
const byId = (id) => SESSIONS.find((s) => s.id === id);
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const s = byId(msg.sessionId);
      if (msg.type === "subscribe" && s) {
        const { ws: _ws, frame: shape, followUp, ...state } = s;
        const frame = { type: "session", sessionId: s.id, state, items: [], approvals: [], asks: [], policy: null, queue: { steering: [], followUp: [] }, plan: null };
        if (shape === "view") frame.copilot = view;
        else if (shape === "null") frame.copilot = null;
        ws.send(JSON.stringify(frame));
        // 旧 bridge 的 boot / 轮末形状：帧里没有 copilot 时，紧接着一条 copilot 帧。重订阅那条没有。
        if (followUp) ws.send(JSON.stringify({ type: "copilot", sessionId: s.id, ...view }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS.map(publicState), manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: WORKSPACE }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

/** Copilot 块现在长什么样：在不在、会话累计写了什么。 */
const block = () =>
  page.evaluate(() => {
    const el = document.querySelector(".exec-copilot");
    if (!el || el.getClientRects().length === 0) return null;
    const cells = [...el.querySelectorAll(".exec-copilot-cell")].map((c) => ({
      label: c.querySelector(".exec-metric-label")?.textContent ?? "",
      value: c.querySelector(".exec-metric-value")?.textContent ?? "",
    }));
    return { title: el.querySelector(".exec-copilot-title")?.textContent ?? "", cells };
  });

const openExec = async () => {
  const tab = page.locator('.exec-tabs button[data-exec-tab="exec"]');
  await tab.waitFor({ timeout: 8000 });
  await tab.click();
  await sleep(250);
};
const openSession = async (id) => {
  await page.locator(`.session-card[data-id="${id}"]`).click();
  await sleep(400);
};

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator(".session-card").first().waitFor({ timeout: 10_000 });

// 1) 打开 copilot 会话：块在，数字对得上
await openSession("st-cop");
await openExec();
let b = await block();
ok(b?.title === "Copilot 积分", `打开会话就有 Copilot 块（标题「${b?.title ?? "无"}」）`);
ok(b?.cells.some((c) => c.label === "会话累计" && c.value === "434"), `会话累计 434.39 → 「${b?.cells.find((c) => c.label === "会话累计")?.value}」`);

// 2) 切走再切回：这就是「几轮之后看不到了」那条路（只重发 session 帧）
await openSession("st-plain");
await openExec();
ok((await block()) === null, "（对照）非 copilot 会话不画这一块");
await openSession("st-cop");
await openExec();
b = await block();
ok(b !== null, "切回来（session 帧重发）之后块还在");
ok(b?.cells.some((c) => c.label === "会话累计" && c.value === "434"), "切回来数字没丢");

// 3) 重连：hello → subscribe，同一条路
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator(".session-card").first().waitFor({ timeout: 10_000 });
await openSession("st-cop");
await openExec();
b = await block();
ok(b !== null && b.cells.some((c) => c.label === "会话累计" && c.value === "434"), "重连之后块还在");

// 4) 旧 bridge 的 boot 形状（帧里没有 copilot，紧跟一条 copilot 帧）也不能回归
await openSession("st-old-live");
await openExec();
b = await block();
ok(b !== null && b.cells.some((c) => c.label === "会话累计" && c.value === "434"), "旧 bridge 的 boot 形状（另有 copilot 帧）仍然画得出来");

// 5) 旧 bridge 的重订阅形状（帧里没有 copilot，**也不跟**帧）—— 这正是修复前的发病路径。
//    前端不能拿上一份去猜，块就该不画；旧桥得升级 bridge 才修得好。
await openSession("st-old-idle");
await openExec();
ok((await block()) === null, "（对照）旧 bridge 重订阅什么都不给时，块不画（不编数据）");

await page.screenshot({ path: path.join(REPO, ".scratch/copilot-panel-resubscribe.png"), clip: { x: 640, y: 0, width: 640, height: 520 } });
await browser.close();
server.close();
wss.close();
if (bad) {
  console.error(`FAIL: ${bad} 项`);
  process.exit(1);
}
console.log("OK：Copilot 积分块在重发会话帧之后仍然在");
process.exit(0);
