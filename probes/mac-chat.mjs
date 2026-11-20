/**
 * Probe: Mac 风格下的对话与会话列表（D350）。
 *
 * 桩桥：两张会话卡（一张在跑、一张做完），当前会话在跑，最后一条用户消息是很短的「merge」。
 * 量：
 *   - 短的用户气泡不被折成「mer / ge」，长气泡贴右边，不留一截空栏；
 *   - 选中（强调色底）的会话卡上，「进行中 / 完成」等状态字和底色有对比度。
 * 截图写到 .scratch/mac-chat/。
 *
 * Run: npm --prefix web run build && node probes/mac-chat.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = Number(process.env.PI_WEB_PORT ?? 7918);
const OUT = path.join(REPO, ".scratch/mac-chat");
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Date.now();
const ITEMS = [
  { id: "u0", kind: "user", images: [], ts: new Date(now - 120000).toISOString(), text: "内网通吸纳子啊不兼容mac 主题 兼容一下" },
  { id: "a0", kind: "assistant", thinking: "", model: "probe", ts: new Date(now - 100000).toISOString(), text: "改好了。\n\n- 有一种情况这次没改：关机或睡眠错过了当天的提醒，第二天开机不会补发。" },
  { id: "u1", kind: "user", images: [], ts: new Date(now - 5000).toISOString(), text: "merge" },
];
const mk = (id, name, extra) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work"), file: null, owned: true, origin: "web",
  running: false, done: false, updatedAt: now, approvals: 0, asks: 0, locked: false, preview: "", ...extra,
});
const RUN = mk("s-run", "内网通兼容mac 主题", { running: true });
const DONE = mk("s-done", "mac主题bug", { done: true, updatedAt: now - 60000 });
const IDLE = mk("s-idle", "闲着的会话", { updatedAt: now - 120000 });
const SESSIONS = [RUN, DONE, IDLE];
const TUNNEL = { status: "off", url: null, error: null, updatedAt: now };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["s-run", "s-done", "s-idle"], order: [], archived: [] };

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
  if (url.pathname === "/api/git") return json(200, { repo: null });
  if (url.pathname === "/api/dirs") return json(200, { path: "", parent: "F:", dirs: [], files: [], error: "" });
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
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
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
      const s = SESSIONS.find((x) => x.id === msg.sessionId) ?? RUN;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: s === RUN ? ITEMS : [], approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage, trash: [], tunnel: TUNNEL }));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/** 相对亮度对比度（WCAG），背景按不透明合成到它下面那层算。 */
const contrastOf = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) {
        // color(srgb r g b / a)
        const n = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
        return n ? [n[1] * 255, n[2] * 255, n[3] * 255, n[4] === undefined ? 1 : Number(n[4])] : [0, 0, 0, 0];
      }
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    // 从元素往上把背景叠起来
    const layers = [];
    for (let n = el; n; n = n.parentElement) layers.push(parse(getComputedStyle(n).backgroundColor));
    let bg = getComputedStyle(document.documentElement).colorScheme.includes("dark") ? [20, 20, 22] : [240, 240, 242];
    for (const l of layers.reverse()) bg = bg.map((v, i) => (i < 3 ? v * (1 - l[3]) + l[i] * l[3] : 1));
    const fg = parse(getComputedStyle(el).color);
    const fgc = bg.map((v, i) => (i < 3 ? v * (1 - fg[3]) + fg[i] * fg[3] : 1));
    const lum = (c) => {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fgc), lum(bg)].sort((x, y) => y - x);
    return { ratio: (a + 0.05) / (b + 0.05), text: el.textContent.trim(), fg: getComputedStyle(el).color };
  }, sel);

/** 扫整页：凡是自己带字的可见元素，字和它叠出来的底对比度 < 2 就记下来（看不见的那种）。 */
async function scanContrast(page, label) {
  const lows = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?(([^)]+))/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const lum = (c) => {
      const ch = c.slice(0, 3).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const base = getComputedStyle(document.documentElement).colorScheme.includes("dark") ? [20, 20, 22, 1] : [240, 240, 242, 1];
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || Number(cs.opacity) < 0.3) continue;
      const chain = [];
      for (let n = el; n; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor));
      let bg = base.slice();
      for (const l of chain.reverse()) bg = bg.map((v, i) => (i < 3 ? v * (1 - l[3]) + l[i] * l[3] : 1));
      const fg = parse(cs.color);
      const fgc = bg.map((v, i) => (i < 3 ? v * (1 - fg[3]) + fg[i] * fg[3] : 1));
      const [a, b] = [lum(fgc), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < 2) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").join(".")}「${el.textContent.trim().slice(0, 12)}」${ratio.toFixed(2)}`);
    }
    return out;
  });
  check(`${label}：没有看不见的字（对比度 < 2）`, lows.length === 0, lows.slice(0, 8).join(" ; "));
}

let browser;
try {
  browser = await chromium.launch();
  for (const theme of ["mac-dark", "mac-light", "mac-midnight", "midnight"]) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, locale: "zh-CN" });
    await context.addInitScript((t) => {
      const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      p.theme = t;
      localStorage.setItem("pi.prefs", JSON.stringify(p));
    }, theme);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("page error:", e.message));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".session-card", { timeout: 8000 });
    await page.locator(".session-card", { hasText: "内网通兼容" }).first().click();
    await page.waitForSelector(".chat-scroll .msg.user", { timeout: 8000 });
    await sleep(900);

    const geo = await page.evaluate(() => {
      const users = [...document.querySelectorAll(".chat-scroll .msg.user")];
      return users.map((u) => {
        const b = u.querySelector(".body");
        const r = b.getBoundingClientRect();
        const w = u.querySelector(".who").getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(b);
        const tops = new Set([...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        return { text: b.textContent.trim().slice(0, 12), lines: tops.size, right: r.right, whoRight: w.right, msgRight: u.getBoundingClientRect().right };
      });
    });
    const short = geo.find((g) => g.text === "merge");
    check(`${theme}：「merge」一行放得下`, short && short.lines === 1, JSON.stringify(short));
    for (const g of geo) check(`${theme}：气泡「${g.text}」贴右`, Math.abs(g.right - g.msgRight) <= 8, `bubble ${g.right.toFixed(0)} / msg ${g.msgRight.toFixed(0)}`);

    await page.screenshot({ path: path.join(OUT, `${theme}.png`) });
    await scanContrast(page, `${theme} 展开`);

    // 收起左栏：钉条胶囊出来，当前会话那颗是实心强调色底
    await page.click('[data-act="sessions"]');
    await page.waitForSelector(".pin-chip.cur", { timeout: 5000 });
    await sleep(400);
    for (const sel of [".pin-chip.cur small", ".pin-chip.cur .pin-name"]) {
      const c = await contrastOf(page, sel);
      check(`${theme}：选中胶囊 ${sel}「${c?.text.slice(0, 10)}」对比度 ≥ 3`, Boolean(c) && c.ratio >= 3, c ? `${c.ratio.toFixed(2)} ${c.fg}` : "没找到");
    }
    await scanContrast(page, `${theme} 收起`);
    await page.screenshot({ path: path.join(OUT, `${theme}-collapsed.png`) });
    await context.close();
  }
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
