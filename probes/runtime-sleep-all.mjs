/**
 * Probe: #80 / D120 —— 设置 → 运行时的「全部休眠」：临时要腾内存时的那个出口。
 *
 * 桩桥 + 真 Chromium。断言五件事：
 *   1. 有运行中的 pi 时按钮可点；点下去页面**真的**发了 `runtime.sleepAll`；
 *   2. 回执把跳过的那些点名写出来（会话名 + 「还在跑」），睡掉的算个数；
 *   3. 回执之后桥广播的新 `runtime.stats` 让摘要当场变小（不刷新、不重开面板）；
 *   4. 一个 pi 都没有时按钮不可点（不会按出一个「什么也没发生」）；
 *   5. 三语：en / ja 下按钮与回执都翻过，控制台没有 `[i18n] missing` 警告。
 *
 * Run: npm --prefix web run build && node probes/runtime-sleep-all.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, scratch, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = 7912;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = scratch("runtime-sleep-all");
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
/** 两个运行中的 pi：一个空闲、一个在跑。 */
const twoLive = () => ({
  type: "runtime.stats",
  running: 2,
  totalBytes: 700 * MB + 500 * MB,
  unavailable: false,
  sessions: [
    { id: "stub-a", name: "重构 sessions.ts", running: false, idleMs: 12 * 60_000 + 20_000, bytes: 700 * MB },
    { id: "stub-b", name: "修 bridge 的 GC", running: true, idleMs: 45_000, bytes: 500 * MB },
  ],
});
/** 睡掉一个之后的同一份数字。 */
const oneLive = () => ({
  type: "runtime.stats",
  running: 1,
  totalBytes: 500 * MB,
  unavailable: false,
  sessions: [{ id: "stub-b", name: "修 bridge 的 GC", running: true, idleMs: 60_000, bytes: 500 * MB }],
});
/** 一个 pi 都没有。 */
const noneLive = () => ({ type: "runtime.stats", running: 0, totalBytes: null, unavailable: false, sessions: [] });

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

/** 桩桥的下一步：面板的当前数字、按下按钮后的回执。 */
const world = { stats: twoLive(), sleepAllCalls: 0, receipt: null };
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
      send(world.stats);
      return;
    }
    if (msg.type === "runtime.sleepAll") {
      world.sleepAllCalls += 1;
      if (world.receipt) {
        send(world.receipt);
        // 桥在回执之后立刻广播新数字（D120 / #80）。
        push(oneLive());
      }
      return;
    }
  });
  send({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log("fake bridge on", BASE);

const browser = await chromium.launch();

/** 已知的历史缺键，不属本票（同 probes/runtime-panel.mjs 的理由）。 */
const KNOWN_MISSING = new Set(["{p1}{p2}"]);

/** 打开 app → 选一个会话 → pi 设置 → 运行时。返回页面与它看到的缺键警告。 */
async function openRuntime(locale, tabName, settingsName) {
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
  await page.getByRole("button", { name: settingsName, exact: true }).click();
  await until(async () => (await page.locator(".settings-sheet").count()) === 1, 5000, "settings sheet");
  await page.getByRole("button", { name: tabName, exact: true }).click();
  await until(async () => (await page.locator(".runtime-summary").count()) === 1, 5000, "runtime summary");
  return { page, missing };
}

try {
  // 1) 按钮在、能点、点下去真发消息 -----------------------------------------
  world.stats = twoLive();
  world.receipt = null;
  const zh = await openRuntime("zh-CN", "运行时", "pi 设置");
  const button = zh.page.getByRole("button", { name: "全部休眠", exact: true });
  ok((await button.count()) === 1, "运行时那一节里有一个「全部休眠」按钮");
  ok(!(await button.isDisabled()), "有运行中的 pi 时按钮可点");
  const summaryBefore = (await zh.page.locator(".runtime-summary").innerText()).trim();
  ok(/运行中 pi：2 个/.test(summaryBefore), `按下之前是 2 个（${summaryBefore}）`);

  // 2) 回执把跳过的点名 + 数字当场变小 --------------------------------------
  world.receipt = { type: "runtime.sleepAll", slept: ["stub-a"], skipped: [{ id: "stub-b", name: "修 bridge 的 GC", why: "running" }] };
  await button.click();
  await until(async () => world.sleepAllCalls >= 1, 5000, "runtime.sleepAll 请求");
  ok(world.sleepAllCalls >= 1, `点一次就发了一条 runtime.sleepAll（${world.sleepAllCalls}）`);
  await until(async () => (await zh.page.locator(".runtime-sleep-all").count()) === 1, 5000, "回执那一行");
  const said = (await zh.page.locator(".runtime-sleep-all").innerText()).trim();
  ok(/已休眠 1 个/.test(said), `回执写睡了几个（${said}）`);
  ok(said.includes("修 bridge 的 GC"), `回执点名还在跑的那个会话（${said}）`);
  ok(said.includes("还在跑"), `并且说明它是「还在跑」（${said}）`);
  await until(async () => /运行中 pi：1 个/.test(await zh.page.locator(".runtime-summary").innerText()), 5000, "摘要变小");
  const summaryAfter = (await zh.page.locator(".runtime-summary").innerText()).trim();
  ok(/运行中 pi：1 个/.test(summaryAfter), `回执之后的数字是 1 个（${summaryAfter}）`);
  await zh.page.screenshot({ path: path.join(SHOTS, "sleep-all-zh.png") });

  // 3) 一个 pi 都没有 → 按钮不可点 -----------------------------------------
  world.stats = noneLive();
  push(world.stats);
  await until(async () => /运行中 pi：0 个/.test(await zh.page.locator(".runtime-summary").innerText()), 5000, "0 个");
  ok(await button.isDisabled(), "没有运行中的 pi 时按钮不可点");
  await zh.page.screenshot({ path: path.join(SHOTS, "sleep-all-empty.png") });
  ok(zh.missing.length === 0, `zh 没有缺键警告（${JSON.stringify(zh.missing)}）`);

  // 4) 三语 ---------------------------------------------------------------
  world.stats = twoLive();
  world.receipt = null;
  const en = await openRuntime("en-US", "Runtime", "pi settings");
  const enButton = en.page.getByRole("button", { name: "Sleep all", exact: true });
  ok((await enButton.count()) === 1, "英文里按钮也翻了（Sleep all）");
  world.receipt = { type: "runtime.sleepAll", slept: [], skipped: [{ id: "stub-b", name: "修 bridge 的 GC", why: "running" }] };
  await enButton.click();
  await until(async () => (await en.page.locator(".runtime-sleep-all").count()) === 1, 5000, "en 回执");
  const enSaid = (await en.page.locator(".runtime-sleep-all").innerText()).trim();
  ok(/still running/i.test(enSaid), `英文回执说明「还在跑」（${enSaid}）`);
  ok(enSaid.includes("修 bridge 的 GC"), `英文回执照样点名（${enSaid}）`);
  ok(en.missing.length === 0, `en 没有缺键警告（${JSON.stringify(en.missing)}）`);
  await en.page.screenshot({ path: path.join(SHOTS, "sleep-all-en.png") });

  world.stats = twoLive();
  world.receipt = null;
  const ja = await openRuntime("ja-JP", "ランタイム", "pi 設定");
  ok((await ja.page.getByRole("button", { name: "すべて休止", exact: true }).count()) === 1, "日文里按钮也翻了（すべて休止）");
  ok(ja.missing.length === 0, `ja 没有缺键警告（${JSON.stringify(ja.missing)}）`);
  await ja.page.screenshot({ path: path.join(SHOTS, "sleep-all-ja.png") });
} catch (err) {
  bad += 1;
  console.error("ERROR", err.message);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
