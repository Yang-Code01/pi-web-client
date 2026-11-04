/**
 * Probe: #77 / D120 —— 设置 → 运行时：看得见「到底是谁在吃内存」。
 *
 * 桩桥 + 真 Chromium。断言四件事：
 *   1. 正常数字：摘要「运行中 pi：2 个 · 1.2 GB」，下面每个运行中的会话一行（名字 / 闲了多久 / 字节），
 *      闲得久的排前面，正在跑的那行带「在跑」；
 *   2. 打开这一页时页面**真的**发了 `runtime.stats` 请求；之后桥广播新数字，面板不用刷新就跟着变；
 *   3. 不可用态：摘要和行里都明确写「不可用」，不写 0、不写 0 B、也不留空；
 *   4. 三语：en / ja 下标签与摘要都翻过，控制台没有 `[i18n] missing` 警告（缺键就是缺键）。
 *
 * Run: npm --prefix web run build && node probes/runtime-panel.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, scratch, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = 7900;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = scratch("runtime-panel");
fs.mkdirSync(SHOTS, { recursive: true });

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MB = 1024 * 1024;
/** The frame the bridge would send: two running pi, 1.2 GB together, idle longest first. */
const normal = () => ({
  type: "runtime.stats",
  running: 2,
  totalBytes: 700 * MB + 500 * MB,
  unavailable: false,
  sessions: [
    { id: "stub-a", name: "重构 sessions.ts", running: false, idleMs: 12 * 60_000 + 20_000, bytes: 700 * MB },
    { id: "stub-b", name: "修 bridge 的 GC", running: true, idleMs: 45_000, bytes: 500 * MB },
  ],
});
/** The same shape with a sampler that could not read the table. */
const unavailable = () => ({
  type: "runtime.stats",
  running: 2,
  totalBytes: null,
  unavailable: true,
  sessions: [
    { id: "stub-a", name: "重构 sessions.ts", running: false, idleMs: 20 * 60_000 },
    { id: "stub-b", name: "修 bridge 的 GC", running: true, idleMs: 60_000 },
  ],
});

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };
const state = (id, name) => ({
  id,
  name,
  cwd: `E:/demo/${id}`,
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
});
const SESSIONS = [state("stub-a", "重构 sessions.ts"), state("stub-b", "修 bridge 的 GC")];
const MANAGE = { pin: [], order: [], archived: [] };

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname === "/api/login") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

/** What the stub bridge answers with next, and how many times the page asked. */
const world = { stats: normal(), requests: 0 };
const push = (msg) => {
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify(msg));
};
wss.on("connection", (ws) => {
  const send = (msg) => ws.send(JSON.stringify(msg));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const s = SESSIONS.find((x) => x.id === msg.sessionId);
    if (msg.type === "subscribe" && s) {
      send({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null });
      return;
    }
    if (msg.type === "settings.get") {
      send({ type: "settings", scope: msg.scope ?? "global", cwd: msg.cwd, path: "probe", exists: false, raw: "{}", json: null, error: null, writable: true });
      return;
    }
    if (msg.type === "runtime.stats") {
      world.requests += 1;
      send(world.stats);
    }
  });
  send({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log("fake bridge on", BASE);

const browser = await chromium.launch();

/**
 * 已知的历史缺键，不属本票：「{p1}{p2}」里没有中文字符，`i18n-check.mjs` 的键集合看不见它，
 * 而设置面板的「全局」一页会先画一次。探针只对本票新增的文案负责，所以把它列为例外 ——
 * 任何**新**的缺键仍然会让这一项失败。
 */
const KNOWN_MISSING = new Set(["{p1}{p2}"]);

/** Open the app, pick a session, then 设置 → 运行时. Returns the page and the i18n warnings it saw. */
async function openRuntime(locale, tabName) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale })).newPage();
  const missing = [];
  page.on("console", (m) => {
    const hit = /\[i18n\] missing .* for: (.*)$/.exec(m.text());
    if (hit && !KNOWN_MISSING.has(hit[1])) missing.push(m.text());
  });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await page.getByRole("button", { name: tabName === "运行时" ? "pi 设置" : /pi settings|pi 設定/i, exact: true }).click();
  await until(async () => (await page.locator(".settings-sheet").count()) === 1, 5000, "settings sheet");
  await page.getByRole("button", { name: tabName, exact: true }).click();
  await until(async () => (await page.locator(".runtime-summary").count()) === 1, 5000, "runtime summary");
  return { page, missing };
}

const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".runtime-row")].map((r) => ({
      name: r.querySelector(".runtime-name")?.textContent ?? "",
      idle: r.querySelector(".runtime-idle")?.textContent ?? "",
      tag: r.querySelector(".runtime-tag")?.textContent ?? "",
      bytes: r.querySelector(".runtime-bytes")?.textContent ?? "",
    })),
  );

try {
  // 1) 正常数字 -------------------------------------------------------------
  world.stats = normal();
  const zh = await openRuntime("zh-CN", "运行时");
  const summary = (await zh.page.locator(".runtime-summary").innerText()).trim();
  ok(/运行中 pi：2 个 · 1\.2 GB/.test(summary), `摘要写明几个、共多少（${summary}）`);
  ok(world.requests >= 1, `打开这一页时页面真的问了桥（${world.requests} 次 runtime.stats）`);

  let list = await rows(zh.page);
  ok(list.length === 2, `每个运行中的会话一行（${list.length}）`);
  ok(list[0].name === "重构 sessions.ts", `第一行是闲得最久的那个（${list[0].name}）`);
  ok(/闲了 12 分钟/.test(list[0].idle), `行了写上闲了多久（${list[0].idle}）`);
  ok(/700\.0 MB/.test(list[0].bytes), `行了写上自己占多少（${list[0].bytes}）`);
  ok(list[0].tag === "", "settled 的会话没有「在跑」标记");
  ok(list[1].tag === "在跑", `正在跑的那行标出来（${list[1].tag}）`);
  ok(/闲了 45 秒/.test(list[1].idle), `秒级也写清楚（${list[1].idle}）`);
  ok(!(await zh.page.locator(".runtime-row").first().innerText()).includes("不可用"), "有读数时不写「不可用」");
  await zh.page.screenshot({ path: path.join(SHOTS, "runtime-zh.png") });

  // 2) 桥广播新数字 → 面板自己跟着变（不刷新、不重开）
  world.stats = { ...normal(), totalBytes: 300 * MB, sessions: [{ id: "stub-a", name: "重构 sessions.ts", running: true, idleMs: 60_000, bytes: 300 * MB }] };
  push(world.stats);
  await until(async () => /300\.0 MB/.test(await zh.page.locator(".runtime-summary").innerText()), 5000, "pushed summary");
  list = await rows(zh.page);
  ok(list.length === 1, `广播后行数跟着变（${list.length}）`);

  // 3) 不可用态 -------------------------------------------------------------
  world.stats = unavailable();
  push(world.stats);
  await until(async () => /不可用/.test(await zh.page.locator(".runtime-summary").innerText()), 5000, "unavailable summary");
  const bad = (await zh.page.locator(".runtime-summary").innerText()).trim();
  ok(/运行中 pi：2 个 · 不可用/.test(bad), `摘要写「不可用」（${bad}）`);
  const badRows = await rows(zh.page);
  ok(badRows.every((r) => r.bytes === "不可用"), `每一行也写「不可用」（${JSON.stringify(badRows.map((r) => r.bytes))}）`);
  const panelText = await zh.page.locator(".settings-body").innerText();
  ok(!/\b0 B\b/.test(panelText), "不可用时不留 0 B");
  ok(badRows.every((r) => r.idle !== ""), "字节读不到，闲了多久照样有");
  await zh.page.screenshot({ path: path.join(SHOTS, "runtime-unavailable.png") });

  // 4) 三语 ---------------------------------------------------------------
  ok(zh.missing.length === 0, `zh 没有缺键警告（${JSON.stringify(zh.missing)}）`);
  world.stats = normal();
  const en = await openRuntime("en-US", "Runtime");
  const enSummary = (await en.page.locator(".runtime-summary").innerText()).trim();
  ok(/Running pi: 2 · 1\.2 GB/.test(enSummary), `英文摘要是英文（${enSummary}）`);
  ok(en.missing.length === 0, `en 没有缺键警告（${JSON.stringify(en.missing)}）`);
  const enRows = await rows(en.page);
  ok(/idle 12 min/.test(enRows[0].idle), `英文的「闲了」也翻了（${enRows[0].idle}）`);
  await en.page.screenshot({ path: path.join(SHOTS, "runtime-en.png") });

  const ja = await openRuntime("ja-JP", "ランタイム");
  const jaSummary = (await ja.page.locator(".runtime-summary").innerText()).trim();
  ok(/実行中の pi：2 個 · 1\.2 GB/.test(jaSummary), `日文摘要是日文（${jaSummary}）`);
  ok(ja.missing.length === 0, `ja 没有缺键警告（${JSON.stringify(ja.missing)}）`);
  await ja.page.screenshot({ path: path.join(SHOTS, "runtime-ja.png") });
} catch (err) {
  bad += 1;
  console.error("ERROR", err.message);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
