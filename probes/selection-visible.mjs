/**
 * Probe: 对话里拖动选中的文字看得见（D415）。
 *
 * 量的是**画出来的像素**，不是 CSS 声明：拖选之前截一张、之后截一张，
 * 在选区矩形里取最多的那个颜色（选区底）、在气泡空白处取最多的那个颜色（气泡底），
 * 再算两者的 WCAG 对比度。挑字色（离选区底最远的那批像素）也和选区底比一次。
 *
 * 改前（main）：用户气泡是强调色实底，选区又铺 34% 强调色 → 两者同一个颜色，
 * 底对比 1.00；助手气泡 1.57–1.60，长段落里看不出边界 → 这一组全红。
 * 改后：实心强调色 + accent-ink，用户气泡里反相 → 3.65–4.35。
 *
 * 坑：programmatic `getSelection().addRange()` 在没聚焦的文档里 Chrome **不上色**，
 * 截图里一片干净 —— 扫计算样式会误判成通过。所以这里一路用真鼠标拖。
 *
 * Run: npm --prefix web run build && node probes/selection-visible.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = Number(process.env.PI_WEB_PORT ?? 7942);
const OUT = path.join(REPO, ".scratch/selection-visible");
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
  {
    id: "u0",
    kind: "user",
    images: [],
    ts: new Date(now - 90000).toISOString(),
    text: "帮我把这个会话里拖动选中的颜色调明显一点，现在在深色主题下几乎看不出来选到了哪里。",
  },
  {
    id: "a0",
    kind: "assistant",
    thinking: "",
    model: "probe",
    ts: new Date(now - 80000).toISOString(),
    text: [
      "选中的底色现在来自 `mac-base.css` 里那条 `::selection`，它把强调色铺在文字下面。",
      "",
      "```css",
      "html[data-ui=\"mac\"] ::selection { background: var(--accent); }",
      "```",
      "",
      "- 列表项一：拖动选中要看得见边界",
      "- 列表项二：行内代码块也要跟着反相",
    ].join("\n"),
  },
];
const RUN = {
  id: "s-run", name: "选中底色", cwd: path.join(REPO, ".scratch/probe-work"), file: null, owned: true,
  origin: "web", running: false, done: true, updatedAt: now, approvals: 0, asks: 0, locked: false, preview: "",
};
const TUNNEL = { status: "off", url: null, error: null, updatedAt: now };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: ["s-run"], order: [], archived: [] };

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
      ws.send(JSON.stringify({ type: "session", sessionId: RUN.id, state: RUN, items: ITEMS, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [RUN], manage, trash: [], tunnel: TUNNEL }));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const lum = ([r, g, b]) => {
  const ch = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** 视口截图 → 在页内画到 canvas，按矩形取「最多的颜色」（= 那块地方的底色）与「离它最远的字色」。 */
const sampleShot = (page, png, rects) =>
  page.evaluate(
    async ({ b64, rects }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const sample = (r) => {
        const x = Math.max(0, Math.floor(r.x));
        const y = Math.max(0, Math.floor(r.y));
        const w = Math.max(1, Math.min(Math.ceil(r.w), c.width - x));
        const h = Math.max(1, Math.min(Math.ceil(r.h), c.height - y));
        const d = g.getImageData(x, y, w, h).data;
        const counts = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        let mode = 0;
        let best = -1;
        for (const [k, n] of counts) if (n > best) [mode, best] = [k, n];
        const mc = [(mode >> 16) & 255, (mode >> 8) & 255, mode & 255];
        // 字色：离底色足够远的那批像素里最多的一个（抗锯齿的过渡色会被底色的多数票压掉）
        const inkCounts = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const dist = Math.abs(d[i] - mc[0]) + Math.abs(d[i + 1] - mc[1]) + Math.abs(d[i + 2] - mc[2]);
          if (dist < 90) continue;
          const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          inkCounts.set(k, (inkCounts.get(k) ?? 0) + 1);
        }
        let ink = null;
        let inkBest = 0;
        for (const [k, n] of inkCounts) if (n > inkBest) [ink, inkBest] = [k, n];
        return {
          bg: mc,
          bgShare: best / (w * h),
          ink: ink === null ? null : [(ink >> 16) & 255, (ink >> 8) & 255, ink & 255],
          inkShare: inkBest / (w * h),
          pixels: w * h,
        };
      };
      return rects.map(sample);
    },
    { b64: png.toString("base64"), rects },
  );

/** 真鼠标拖选：从气泡第一行左侧拖到第二行中间。返回选区矩形与拖到的字符数。 */
const dragSelect = async (page, sel) => {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const geo = await page.evaluate((sel) => {
    const body = document.querySelector(sel);
    const b = body.getBoundingClientRect();
    // 第一段文字的行盒：撑起来比 fontSize 高，取它的中线往下挪一行
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let first = null;
    let n;
    while ((n = walker.nextNode())) if (n.textContent.trim()) { first = n; break; }
    const r = document.createRange();
    r.selectNodeContents(first);
    const line = r.getBoundingClientRect();
    return { left: b.left + 4, lineTop: line.top, lineH: line.height, w: b.width };
  }, sel);
  await page.mouse.move(geo.left, geo.lineTop + geo.lineH * 0.5);
  await page.mouse.down();
  await page.mouse.move(geo.left + geo.w * 0.5, geo.lineTop + geo.lineH * 1.5, { steps: 16 });
  await page.mouse.up();
  const got = await page.evaluate(() => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0).getBoundingClientRect();
    return { chars: String(s).length, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  });
  return got;
};

/** 气泡底部那圈内边距是纯底色，拿它当「未选中」的参照。 */
const padRect = async (page, sel) =>
  page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.left + b.width * 0.25, y: b.bottom - 7, w: Math.max(8, b.width * 0.4), h: 4 };
  }, sel);

let browser;
try {
  browser = await chromium.launch();
  for (const theme of ["mac-light", "mac-dark", "mac-midnight"]) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
    await context.addInitScript((t) => {
      const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
      p.theme = t;
      localStorage.setItem("pi.prefs", JSON.stringify(p));
    }, theme);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("page error:", e.message));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".session-card", { timeout: 8000 });
    await page.locator(".session-card").first().click();
    await page.waitForSelector(".chat-scroll .msg.assistant", { timeout: 8000 });
    await sleep(700);
    await page.bringToFront();

    for (const [label, sel] of [
      ["用户气泡（强调色实底）", ".chat-scroll .msg.user .body"],
      ["助手气泡（玻璃面板）", ".chat-scroll .msg.assistant .body"],
    ]) {
      const pad = await padRect(page, sel);
      const shot0 = await page.screenshot();
      const got = await dragSelect(page, sel);
      if (!got || got.chars < 4) {
        check(`${theme} · ${label}：鼠标拖得出选区`, false, got ? `只选中 ${got.chars} 个字` : "没有选区");
        continue;
      }
      const shot1 = await page.screenshot();
      // 选区矩形只取第一行：跨行的 union 矩形里有大片气泡底色，多数票会把选区底盖过去
      const firstLine = { x: got.rect.x + 2, y: got.rect.y + 1, w: Math.min(got.rect.w - 4, 240), h: Math.max(6, got.rect.h / (got.rect.w > 700 ? 3 : 2) - 2) };
      const [selPx, bgPx] = await sampleShot(page, shot1, [firstLine, pad]);
      const bgRatio = ratio(selPx.bg, bgPx.bg);
      const inkRatio = selPx.ink ? ratio(selPx.ink, selPx.bg) : 0;
      fs.writeFileSync(path.join(OUT, `${theme}-${label.startsWith("用户") ? "user" : "assistant"}.png`), shot1);
      check(`${theme} · ${label}：选区底色和气泡底色分得开（≥ 2.5）`, bgRatio >= 2.5, `${bgRatio.toFixed(2)}:1  选区 ${hex(selPx.bg)} / 气泡 ${hex(bgPx.bg)}`);
      check(`${theme} · ${label}：选中的字读得出（字对选区底 ≥ 3）`, inkRatio >= 3, `${inkRatio.toFixed(2)}:1  字 ${selPx.ink ? hex(selPx.ink) : "取不到"}`);
      check(`${theme} · ${label}：选区底色不是只占零星的杂色`, selPx.bgShare > 0.25, `最多颜色的占比 ${(selPx.bgShare * 100).toFixed(0)}%`);
      // 拖选前后像素得真的变了 —— 变都没变就说明 Chrome 根本没画（programmatic range 的老坑）
      const before2 = await sampleShot(page, shot0, [firstLine]);
      check(`${theme} · ${label}：拖选把那一块重画了`, before2[0].bg.join() !== selPx.bg.join(), `拖前 ${hex(before2[0].bg)} → 拖后 ${hex(selPx.bg)}`);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
    await context.close();
  }
} finally {
  await browser?.close();
  server.close();
  wss.close();
}

console.log(bad ? `\n${bad} 项失败` : "\n全绿");
process.exit(bad ? 1 : 0);
