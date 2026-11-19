/**
 * Probe: ★ 行（.pin-strip）里归档一颗胶囊时整排不许抖。
 * 逐帧采样其余胶囊与「＋」的位置、条高：不许竖向跳、不许往右挪、条高不变，
 * 回声重建那一帧（被归档那颗消失）前后位置一致。旧动效（条尾插抽屉 + 收拢时文字折行）在这里红。
 *
 * Run: npm run build:web && node probes/pin-archive-jitter.mjs   （ARCH=<名字片段> 换被归档的那颗）
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7931);
const OUT = path.join(REPO, ".scratch/pin-archive-jitter/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const ANSWER = "好，我把这一处改完再跑一遍验证。\n\n- 先读入口\n- 只改这一处\n- 再跑探针";
const items = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `u${i}`, kind: "user", text: `第 ${i + 1} 轮：继续。`, images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    out.push({ id: `a${i}`, kind: "assistant", text: ANSWER, thinking: "", model: "probe", ts: new Date(Date.now() - (n - i) * 59000).toISOString() });
  }
  return out;
};

const CWD = path.join(REPO, ".scratch/probe-work/alpha");
const base = (id, name, n) => ({
  id, name, cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: items(n),
});
const A = base("probe-a", "考试模块", 2);
const B = base("probe-b", "pi-web-client", 2);
const C = base("probe-c", "文档站", 1);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["probe-a", "probe-b", "probe-c"], order: [], archived: [] };
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
    if (msg.type === "manage" || msg.type === "rename") {
      frames.push(msg);
      if (msg.type === "rename") {
        const s = [A, B, C].find((x) => x.id === msg.sessionId);
        if (s) s.name = String(msg.name);
        for (const w of live) w.send(JSON.stringify({ type: "sessions", sessions: [strip(A), strip(B), strip(C)] }));
        return;
      }
      if (msg.action === "archive") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        manage.archived = msg.on ? [...new Set([...manage.archived, ...ids])] : manage.archived.filter((id) => !ids.includes(id));
        for (const w of live) w.send(JSON.stringify({ type: "manage", manage }));
        return;
      }
      if (msg.action === "delete") {
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
        for (const w of live) {
          w.send(JSON.stringify({ type: "delete.result", removed: ids, skipped: [] }));
          w.send(JSON.stringify({ type: "trash", items: ids.map((id) => ({ id, name: id, cwd: CWD, file: `x/${id}.jsonl`, deletedAt: Date.now(), size: 1024 })) }));
        }
      }
      return;
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A), strip(B), strip(C)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-CN" });
page.on("pageerror", (e) => log("PAGEERROR", e.message));
const ARCH = process.env.ARCH ?? "文档站";
try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("pi.collapse.sessions", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await count(page, ".pin-chip")) >= 3, 6000, "chips");
  await sleep(600);
  const target = page.locator(".pin-chip:not(.pin-new)", { hasText: ARCH }).first();
  await target.hover();
  await until(async () => (await count(page, ".pin-menu")) === 1, 1500, "menu");
  // 每帧采样：除被归档那颗以外的胶囊、＋、条本身、整行
  await page.evaluate(() => {
    window.__tr = [];
    const t0 = performance.now();
    const tick = () => {
      const row = document.querySelector(".pin-strip");
      const chips = [...document.querySelectorAll(".pin-strip > *")].map((n) => {
        const r = n.getBoundingClientRect();
        const name = n.classList.contains("pin-new") ? "+" : n.classList.contains("pin-tray") ? "tray" : (n.textContent || "").trim().slice(0, 6);
        return { name, x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, o: +getComputedStyle(n).opacity };
      });
      const rr = row?.getBoundingClientRect();
      window.__tr.push({ t: Math.round(performance.now() - t0), rowH: rr?.height, rowY: rr?.top, chips });
      if (performance.now() - t0 < 1600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.click('.pm-item[data-act="archive"]');
  await sleep(1800);
  const tr = await page.evaluate(() => window.__tr);
  if (process.env.DUMP) for (const f of tr) console.log(f.t, f.rowH, f.chips.map((c) => `${c.name}@${c.x}/${c.w}/${c.o}`).join(" | "));
  // 判抖：被归档之外的每颗胶囊（名字作 key），x 序列的方向翻转次数 + 跳变（单帧 >8px）
  const bad = [];
  const series = new Map();
  for (const f of tr) for (const c of f.chips) {
    if (c.name.includes(ARCH.slice(0, 3)) || c.name === "tray") continue;
    if (!series.has(c.name)) series.set(c.name, []);
    series.get(c.name).push(c);
  }
  for (const [name, xs] of series) {
    let flips = 0, last = 0, jumps = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i].x - xs[i - 1].x;
      if (d > 0.5) jumps++;
      const s = Math.sign(Math.abs(d) < 0.5 ? 0 : d);
      if (s && last && s !== last) flips++;
      if (s) last = s;
      if (Math.abs(xs[i].y - xs[i - 1].y) > 0.5) bad.push(`${name} 竖向跳 ${xs[i - 1].y}→${xs[i].y}`);
    }
    if (flips) bad.push(`${name} 往返 ${flips} 次`);
    if (jumps) bad.push(`${name} 往右挪 ${jumps} 帧`);
  }
  // 回声重建那一帧：被归档那颗消失前后，其余胶囊不许再挪（收拢后的几何必须和重建后一致）
  const gone = tr.findIndex((f) => !f.chips.some((c) => c.name.includes(ARCH.slice(0, 3))));
  if (gone <= 0) bad.push('被归档的胶囊没离开');
  else for (const c of tr[gone].chips) {
    const p = tr[gone - 1].chips.find((x) => x.name === c.name);
    if (p && c.name.trim() && (Math.abs(p.x - c.x) > 1 || Math.abs(p.y - c.y) > 1)) bad.push(`${c.name} 重建时跳 ${p.x}→${c.x}`);
  }
  const hs = new Set(tr.map((f) => Math.round(f.rowH)));
  if (hs.size > 1) bad.push(`条高变化 ${[...hs].join(",")}`);
  console.log(bad.length ? "JITTER: " + bad.join("; ") : "STEADY");
  if (bad.length) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  for (const w of live) w.terminate();
}
