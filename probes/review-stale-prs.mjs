/**
 * Probe：评审面板「评审仓库 / PR 列表 / 账号」被上一个会话迟到的 `review.prs` 顶掉（会话 17556 实报）。
 *
 * 现场：会话 A 在 pi-web-client 里、会话 B 的评审钉在 cas3-onecas-api。从 A 切到 B 后，
 * A 那次 `review.prs.get` 的回帧（gh 慢）晚于 B 的到达，面板就把「评审仓库」画成 pi-web-client、
 * PR 列表成了 pi-web-client 的 24 个、账号写成 Yang-Code01 —— 历史记录却还是 B 的。
 *
 * 假桥：A 的 PR 列表回帧故意拖 1.2 秒，B 的立刻回。断言切到 B 并等迟到帧落地后，
 * 面板仍是 B 的仓库名、B 的 PR 数、B 的账号。
 *
 * Run: npm run build:web && node probes/review-stale-prs.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
let BASE = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

// ---- 两个会话：A 跟随自己的仓库，B 在大文件夹下、评审钉到子仓库 -------------------------
const A_DIR = "E:\\fake\\pi-web-client";
const B_CWD = "C:\\fake-api";
const B_PIN = "C:\\fake-api\\cas3-onecas-api";
const session = (id, name, cwd) => ({
  id,
  name,
  cwd,
  ws: "",
  file: null,
  owned: true,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});
const SA = session("zz-stale-a", "会话A", A_DIR);
const SB = session("zz-stale-b", "会话B", B_CWD);
const SESSIONS = { [SA.id]: SA, [SB.id]: SB };
const PIN = { [SA.id]: "", [SB.id]: B_PIN };
const PRS = {
  [SA.id]: { dir: A_DIR, login: "Yang-Code01", n: 24, base: 700 },
  [SB.id]: { dir: B_PIN, login: "xyang-qingmin", n: 3, base: 18131 },
};
const DELAY = { [SA.id]: 1200, [SB.id]: 0 };

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const WORKSPACE = { groups: [], overrides: {}, keys: {} };
const MANAGE = { pin: [SA.id, SB.id], order: [SA.id, SB.id], archived: [] };
const OCR = { installed: true, version: "1.14.2", tooOld: false };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/me") return json(200, ME);
  if (url.pathname.startsWith("/api/")) return json(404, { error: "stub" });
  let rel = "/";
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("bad path");
    return;
  }
  const file = path.join(DIST, rel === "/" ? "index.html" : rel.replace(/^[/]+/, ""));
  const inside = path.relative(DIST, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const sid = String(msg.sessionId ?? "");
      if (msg.type === "subscribe" && SESSIONS[sid]) {
        send({ type: "session", sessionId: sid, state: SESSIONS[sid], items: [], approvals: [], asks: [], budget: null });
      }
      if (msg.type === "review.get" && SESSIONS[sid]) {
        const repo = PIN[sid] || String(msg.dir);
        send({ type: "review.state", dir: repo, pinned: PIN[sid], sessionId: sid, state: { repo, runs: [], marks: {}, pick: { mode: "pr", pr: PRS[sid].base, base: "main", target: "HEAD", commit: "" } }, progresses: [], cap: 2 });
        send({ type: "review.ocr", dir: repo, ocr: OCR });
      }
      if (msg.type === "review.prs.get" && SESSIONS[sid]) {
        // 与真桥同形：回帧带 dir（实际评的仓库）、login，以及请求时的 sessionId / asked。
        const p = PRS[sid];
        const prs = Array.from({ length: p.n }, (_, i) => ({ number: p.base + i, title: `PR ${p.base + i}`, headRefName: `b${i}`, baseRefName: "main", author: "x", isDraft: false, updatedAt: new Date().toISOString(), url: "" }));
        setTimeout(() => send({ type: "review.prs", dir: p.dir, sessionId: sid, asked: String(msg.dir ?? ""), ok: true, prs, repo: "", login: p.login }), DELAY[sid]);
      }
    });
    send({ type: "hello", me: ME, sessions: [SA, SB], manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: WORKSPACE });
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
BASE = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  await page.addInitScript(() => localStorage.setItem("pi.queueTab", "review"));
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const card = (name) => page.locator(".session-card", { hasText: name }).first();
  await card("会话A").click();
  await page.locator(".rv-repo-chip").waitFor({ timeout: 15000 });
  // A 的 PR 请求还在路上（1.2 秒后才回）就切到 B。
  await sleep(200);
  await card("会话B").click();
  await page.waitForFunction(() => document.querySelector(".rv-repo-chip")?.textContent?.includes("cas3"), null, { timeout: 5000 }).catch(() => {});
  await sleep(1800); // 等 A 的迟到帧落地
  const shown = await page.evaluate(() => ({
    chip: document.querySelector(".rv-repo-chip")?.textContent ?? "",
    text: document.querySelector(".review")?.textContent ?? "",
  }));
  console.log("chip =", JSON.stringify(shown.chip));
  ok(shown.chip.includes("cas3-onecas-api"), "切到 B 后「评审仓库」仍是 B 钉的 cas3-onecas-api");
  ok(!shown.text.includes("24 个 open PR"), "PR 列表没有被 A 的 24 个顶掉");
  ok(!shown.text.includes("Yang-Code01"), "账号没有被写成 A 的 Yang-Code01");
} finally {
  await browser.close();
  server.close();
}
console.log(bad ? `\n${bad} FAIL` : "\nall ok");
process.exit(bad ? 1 : 0);
