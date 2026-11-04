/**
 * Probe: #78 / D120 —— 设置 → 运行时：两个阈值能改，而且改了不会丢。
 *
 * 桩桥 + 真 Chromium。断言五件事：
 *   1. 两个输入框带当前值与单位（30 分钟 / 2.5 GB）；
 *   2. 改值 → 点保存 → 页面真的发出 `runtime.settings`，没改的那个原样带回去（可只传其一）；
 *   3. 桥回 `runtime.stats` + `saved: true` → 输入框跟着变成新值，并有一条「已保存」提示；
 *   4. 非法值（0 / 负数 / 非数字 / 空）被界面拦下：一条消息都不发，写红提示，输入框回到旧值；
 *   5. 三语：en / ja 下新文案都翻过，控制台没有 `[i18n] missing` 警告。
 *
 * Run: npm --prefix web run build && node probes/runtime-settings.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, scratch, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);

const PORT = 7911;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = scratch("runtime-settings");
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

const MIN = 60_000;
const GB = 1024 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30 * MIN;
const DEFAULT_WATERMARK_BYTES = 2.5 * GB;

/** The frame the bridge would send: `runtime.stats` with the thresholds in force (#78). */
const statsFrame = ({ idleMs = DEFAULT_IDLE_MS, watermarkBytes = DEFAULT_WATERMARK_BYTES, saved } = {}) => ({
  type: "runtime.stats",
  running: 0,
  totalBytes: null,
  unavailable: false,
  sessions: [],
  lifecycle: { idleMs, watermarkBytes },
  ...(saved === undefined ? {} : { saved }),
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
const SESSIONS = [state("stub-a", "重构 sessions.ts")];
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

/** What the stub bridge holds, and every `runtime.settings` the page sent it. */
const world = { idleMs: DEFAULT_IDLE_MS, watermarkBytes: DEFAULT_WATERMARK_BYTES, writes: [] };
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
      send(statsFrame({ idleMs: world.idleMs, watermarkBytes: world.watermarkBytes }));
      return;
    }
    if (msg.type === "runtime.settings") {
      world.writes.push(msg);
      if (typeof msg.idleMs === "number" && msg.idleMs > 0) world.idleMs = msg.idleMs;
      if (typeof msg.watermarkBytes === "number" && msg.watermarkBytes > 0) world.watermarkBytes = msg.watermarkBytes;
      send(statsFrame({ idleMs: world.idleMs, watermarkBytes: world.watermarkBytes, saved: true }));
    }
  });
  send({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log("fake bridge on", BASE);

const browser = await chromium.launch();

/** 已知的历史缺键，不属本票（见 probes/runtime-panel.mjs）。 */
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
  await until(async () => (await page.locator(".runtime-thresholds").count()) === 1, 5000, "thresholds");
  return { page, missing };
}

const idleInput = (page) => page.locator(".runtime-threshold.idle input");
const watermarkInput = (page) => page.locator(".runtime-threshold.watermark input");
const saveButton = (page) => page.locator(".runtime-thresholds button", { hasText: /保存阈值|Save thresholds|しきい値を保存/ });
const rowText = (page, cls) => page.locator(`.runtime-threshold.${cls}`).innerText();

const write = async (page, cls, value) => {
  const box = page.locator(`.runtime-threshold.${cls} input`);
  await box.fill(value);
  await saveButton(page).click();
  await new Promise((r) => setTimeout(r, 300));
};

try {
  const zh = await openRuntime("zh-CN", "运行时");

  // 1) 当前值 + 单位 --------------------------------------------------------
  ok((await idleInput(zh.page).inputValue()) === "30", `空闲阈值输入框带当前值（${await idleInput(zh.page).inputValue()}）`);
  ok((await watermarkInput(zh.page).inputValue()) === "2.5", `水位输入框带当前值（${await watermarkInput(zh.page).inputValue()}）`);
  const idleRow = await rowText(zh.page, "idle");
  const watermarkRow = await rowText(zh.page, "watermark");
  ok(/分钟/.test(idleRow), `空闲那一行带单位「分钟」（${idleRow.replace(/\n/g, " ")}）`);
  ok(/GB/.test(watermarkRow), `水位那一行带单位「GB」（${watermarkRow.replace(/\n/g, " ")}）`);
  await zh.page.screenshot({ path: path.join(SHOTS, "runtime-settings-zh.png") });

  // 2) 改值 → 发出设置消息（没改的那个原样带回去）---------------------------
  world.writes.length = 0;
  await write(zh.page, "idle", "5");
  ok(world.writes.length === 1, `点保存发了一条 runtime.settings（${world.writes.length}）`);
  const sent = world.writes[0] ?? {};
  ok(sent.type === "runtime.settings" && sent.idleMs === 5 * MIN, `空闲阈值按分钟换成毫秒（${sent.idleMs}）`);
  ok(sent.watermarkBytes === DEFAULT_WATERMARK_BYTES, `没改的水位原样带回去（${sent.watermarkBytes}）`);

  // 3) 桥回 saved: true → 面板跟着变成新值 + 提示 --------------------------
  await until(async () => (await idleInput(zh.page).inputValue()) === "5", 5000, "idle box repainted");
  ok(true, "桥回了新值之后输入框就是新值");
  const note = await zh.page.locator(".settings-note").innerText();
  ok(/已保存/.test(note) && !(await zh.page.locator(".settings-note.bad").count()), `提示写「已保存」，不是红的（${note}）`);

  world.writes.length = 0;
  await write(zh.page, "watermark", "1.5");
  ok(world.writes[0]?.watermarkBytes === 1.5 * GB, `水位按 GB 换成字节（${world.writes[0]?.watermarkBytes}）`);
  ok(world.writes[0]?.idleMs === 5 * MIN, `只改了水位，空闲阈值照旧带回去（${world.writes[0]?.idleMs}）`);

  // 4) 非法值被界面拦下：一条消息都不发，写红提示，回到旧值 -----------------
  for (const [what, cls, value, expect] of [
    ["0", "idle", "0", "5"],
    ["负数", "idle", "-3", "5"],
    ["非数字", "watermark", "abc", "1.5"],
    ["空", "watermark", "", "1.5"],
  ]) {
    world.writes.length = 0;
    await write(zh.page, cls, value);
    ok(world.writes.length === 0, `${what} 被界面拦下：一条消息都没发（${world.writes.length}）`);
    const shown = await zh.page.locator(`.runtime-threshold.${cls} input`).inputValue();
    ok(shown === expect, `${what} 被拒后输入框回到旧值（${shown}）`);
    const badNote = await zh.page.locator(".settings-note.bad").innerText().catch(() => "");
    ok(/大于 0|正数/.test(badNote), `${what} 被拒时有红提示（${badNote}）`);
  }
  await zh.page.screenshot({ path: path.join(SHOTS, "runtime-settings-bad.png") });
  ok(zh.missing.length === 0, `zh 没有缺键警告（${JSON.stringify(zh.missing)}）`);

  // 5) 三语 ---------------------------------------------------------------
  for (const [locale, tab, label] of [
    ["en-US", "Runtime", /Sleep after idling/],
    ["ja-JP", "ランタイム", /アイドルで休止するまで/],
  ]) {
    const view = await openRuntime(locale, tab);
    const text = await view.page.locator(".runtime-thresholds").innerText();
    ok(label.test(text), `${locale} 的标签翻过（${text.replace(/\n/g, " ").slice(0, 60)}）`);
    ok(view.missing.length === 0, `${locale} 没有缺键警告（${JSON.stringify(view.missing)}）`);
    await view.page.screenshot({ path: path.join(SHOTS, `runtime-settings-${locale.split("-")[0]}.png`) });
    await view.page.context().close();
  }
  await zh.page.context().close();
} catch (err) {
  bad += 1;
  console.error("ERROR", err.message);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
