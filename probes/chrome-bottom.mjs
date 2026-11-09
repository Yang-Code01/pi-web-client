/**
 * Probe: #290 — 输入框下沿四颗（技能 / 扩展 / 文件 / 模型）按 `chrome` 三态显隐，扩展开关只有一个真源。
 *
 * 桩桥只讲 `chrome`，**故意不发**派生值 `showExtButton`：页面若还在读旧字段就会露馅。
 *   1. 默认全画；`hello.ui.chrome = {}` 和带 `showExtButton:false` 但 chrome 为空的 hello 都不该藏扩展；
 *   2. 设置面板 → 扩展与 MCP：勾选框是「开」；点掉 → 页面发 `ui.set { chrome: { ext: false } }`（不带旧字段），
 *      回执后下沿那颗消失、面板里的勾也跟着变；
 *   3. 桥广播 `chrome.ext = true`（另一个客户端用 ui.set 改回）→ 面板里的勾变回「开」，下沿那颗回来；
 *   4. 逐颗关技能 / 文件 / 模型：每关一颗只少那一颗；
 *   5. 四颗全关 → `.hint-tools` 整行不占位（不是留一条空行），开回一颗 → 整行回来；
 *   6. 刷新后 hello 带回同一份 chrome，四颗仍然全关。
 *
 * Run: npm run build:web && node probes/chrome-bottom.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "./port.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7941));
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(REPO, "web/dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "1.4.0", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-290", name: "下沿四颗", cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "chrome" };
// 只读会话：owned:false 时 composer 里没有 `release-btn`，四颗全关后 `.hint-tools` 应该真是空的。
const SES_RO = { ...SES, id: "probe-290-ro", name: "下沿四颗（只读）", owned: false, origin: "disk", preview: "chrome" };
const ITEMS = [{ kind: "user", id: "u1", ts: Date.now() - 60_000, text: "下沿" }];
const MANAGE = { pin: [], order: [SES.id, SES_RO.id], archived: [] };

/** 桩桥状态：`chrome` 就是 `ui.json` 里那一份；`sets` 记下页面发来的 ui.set。 */
const world = { chrome: {}, sets: [], helloLegacy: false, sockets: new Set() };
const uiNow = () => ({ type: "ui", ui: { chrome: { ...world.chrome } } });
const pushUi = () => {
  for (const ws of world.sockets) if (ws.readyState === 1) ws.send(JSON.stringify(uiNow()));
};
/** 与桥端 `writeUiPrefs` 同一套合并规则：true/false 写入，null 删键；旧 `showExtButton` 映射进 ext。 */
const applyUiSet = (msg) => {
  world.sets.push(msg);
  if (typeof msg.showExtButton === "boolean") world.chrome.ext = msg.showExtButton;
  for (const [id, choice] of Object.entries(msg.chrome ?? {})) {
    if (choice === null || choice === undefined) delete world.chrome[id];
    else if (typeof choice === "boolean") world.chrome[id] = choice;
  }
};

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
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    world.sockets.add(ws);
    ws.on("close", () => world.sockets.delete(ws));
    const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        const one = msg.sessionId === SES_RO.id ? SES_RO : SES;
        const { ws: _ws, ...plain } = one;
        send({ type: "session", sessionId: one.id, state: plain, items: one === SES ? ITEMS : [], approvals: [], asks: [], budget: null });
        return;
      }
      if (msg.type === "ui.set") {
        applyUiSet(msg);
        pushUi();
        return;
      }
      if (msg.type === "settings.get") {
        send({ type: "settings", scope: msg.scope ?? "global", cwd: msg.cwd, path: "probe", exists: false, values: {}, raw: "{}" });
        return;
      }
      if (msg.type === "lockext.get") {
        send({ type: "lockext", installed: false, path: "probe" });
        return;
      }
      if (msg.type === "ext.inventory") {
        send({ type: "ext.inventory", cwd: msg.cwd ?? REPO, packages: [], extensions: [], mcp: [], mcpError: null, updates: 0, checkedAt: Date.now(), mcpReady: true, versionsChecked: true });
        return;
      }
    });
    send({
      type: "hello",
      me: ME,
      sessions: [SES, SES_RO],
      manage: MANAGE,
      trash: [],
      tunnel: TUNNEL,
      // 刻意只带 chrome；`helloLegacy` 那一轮再单独塞旧布尔，验证页面不拿它当第二真源。
      ui: world.helloLegacy ? { showExtButton: false, chrome: {} } : { chrome: { ...world.chrome } },
    });
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

const SEL = {
  skills: '.hint-tools [data-act="skills"]',
  ext: ".hint-tools .ext-btn",
  attach: '.hint-tools [data-act="attach"]',
  model: ".hint-tools .model-chip",
};
/** 「真的画出来了」：不是只看节点在不在，而是有盒子、没被 [hidden] 收掉。 */
const shown = (page, sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    return Boolean(n) && n.getClientRects().length > 0 && getComputedStyle(n).display !== "none";
  }, sel);
const toolsShown = (page) =>
  page.evaluate(() => {
    const n = document.querySelector(".hint-tools");
    return Boolean(n) && n.getClientRects().length > 0;
  });
const quartet = async (page) => ({
  skills: await shown(page, SEL.skills),
  ext: await shown(page, SEL.ext),
  attach: await shown(page, SEL.attach),
  model: await shown(page, SEL.model),
});
const openSession = async (page, id = SES.id) => {
  await page.locator(`.session-card[data-id="${id}"]`).click();
  await until(() => page.locator(".hint-tools").count().then((n) => n === 1), 8000, "composer");
};
const openExtSettings = async (page) => {
  // `/settings` 是内置命令：走输入框，和用户路径一致（顶栏没有常驻的设置入口）。
  const input = page.locator(".composer textarea");
  await input.fill("/settings");
  await input.press("Enter");
  await until(() => page.locator(".settings-sheet").count().then((n) => n === 1), 5000, "settings sheet");
  await page.getByRole("button", { name: "扩展与 MCP", exact: true }).click();
  await until(() => page.locator(".ext-switch input").count().then((n) => n === 1), 5000, "ext switch");
};
const extChecked = (page) => page.locator(".ext-switch input").isChecked();

let page;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(() => page.locator(".session-card").count().then((n) => n > 0), 8000, "session card");
  await openSession(page);
  await until(() => toolsShown(page), 5000, "hint tools");

  // 1) 默认：四颗都在，整行也在
  ok(JSON.stringify(await quartet(page)) === JSON.stringify({ skills: true, ext: true, attach: true, model: true }), `默认四颗全画（${JSON.stringify(await quartet(page))}）`);

  // 2) 设置面板往返：勾 → 取消勾 → 下沿消失 → 勾回来
  await openExtSettings(page);
  ok(await extChecked(page), "面板里扩展开关默认是勾上的");
  await page.locator(".ext-switch input").uncheck();
  await until(async () => !(await shown(page, SEL.ext)), 5000, "ext button hidden after uncheck");
  ok(!(await shown(page, SEL.ext)), "面板里关掉 → 下沿那颗扩展消失");
  ok((await quartet(page)).skills && (await quartet(page)).attach && (await quartet(page)).model, "只少扩展，另外三颗不动");
  await until(async () => (await extChecked(page)) === false, 5000, "switch stays off after repaint");
  const first = world.sets.at(-1);
  ok(first?.chrome?.ext === false && !("showExtButton" in first), `页面发的是 chrome.ext=false，不带旧字段（${JSON.stringify(first)}）`);

  // 另一个客户端 / 同一份偏好被 ui.set 改回 true：面板里的勾跟着变，下沿那颗回来
  world.chrome.ext = true;
  pushUi();
  await until(async () => (await extChecked(page)) === true, 5000, "switch follows broadcast");
  await until(async () => shown(page, SEL.ext), 5000, "ext button back");
  ok((await extChecked(page)) && (await shown(page, SEL.ext)), "ui.set 改回 → 面板勾选与下沿那颗一起回来");

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await until(() => page.locator(".settings-sheet").count().then((n) => n === 0), 5000, "settings closed");

  // 3) 逐颗关：每关一颗只少那一颗
  const off = new Set();
  for (const id of ["skills", "attach", "model"]) {
    world.chrome[id] = false;
    off.add(id);
    pushUi();
    await until(async () => !(await shown(page, SEL[id])), 5000, `${id} hidden`);
    const q = await quartet(page);
    ok(q[id] === false && Object.entries(q).every(([k, v]) => v === !off.has(k)), `关掉 ${id} 只少这一颗（${JSON.stringify(q)}）`);
  }

  // 4) 四颗全关：整行不占位（换到只读会话，避开 `release-btn` 这颗不归 chrome 管的按钮）
  world.chrome.ext = false;
  pushUi();
  await until(async () => !(await shown(page, SEL.ext)), 5000, "ext hidden before switching");
  await openSession(page, SES_RO.id);
  await until(async () => !(await toolsShown(page)), 5000, "hint tools collapsed");
  ok(!(await toolsShown(page)), "四颗全关 → 下沿那一行收起来，不留空行");
  const gap = await page.evaluate(() => {
    const hint = document.querySelector(".composer .hint");
    const status = document.querySelector(".composer .hint-status");
    return { hint: hint?.getBoundingClientRect().height ?? 0, status: status?.getBoundingClientRect().height ?? 0 };
  });
  ok(gap.hint > 0 && Math.abs(gap.hint - gap.status) < 2, `整行高度回到只剩状态行（hint ${gap.hint} / status ${gap.status}）`);

  // 开回一颗：整行跟着回来
  world.chrome.model = true;
  pushUi();
  await until(() => toolsShown(page), 5000, "hint tools back");
  ok((await toolsShown(page)) && (await shown(page, SEL.model)) && !(await shown(page, SEL.skills)), "开回模型 → 整行回来，其余仍是关的");

  // 5) 刷新：hello 带回同一份 chrome，四颗照旧
  world.chrome = { skills: false, ext: false, attach: false, model: false };
  await page.reload({ waitUntil: "networkidle" });
  await until(() => page.locator(".session-card").count().then((n) => n > 0), 8000, "session card after reload");
  await openSession(page, SES_RO.id);
  await until(() => page.locator(".hint-tools").count().then((n) => n === 1), 5000, "composer after reload");
  await until(async () => !(await toolsShown(page)), 5000, "collapsed after reload");
  ok(!(await toolsShown(page)) && Object.values(await quartet(page)).every((v) => !v), "刷新后 hello 的 chrome 生效，四颗仍然全关");

  // 6) 老客户端只发 showExtButton、chrome 里没有 ext：页面不拿它当第二真源
  world.chrome = {};
  world.helloLegacy = true;
  await page.reload({ waitUntil: "networkidle" });
  await until(() => page.locator(".session-card").count().then((n) => n > 0), 8000, "session card legacy");
  await openSession(page, SES_RO.id);
  await until(() => page.locator(".hint-tools").count().then((n) => n === 1), 5000, "composer legacy");
  await until(() => toolsShown(page), 5000, "hint tools legacy");
  ok(await shown(page, SEL.ext), "hello 只有旧 showExtButton:false、chrome 为空 → 扩展仍按默认画（旧字段不是数据源）");
} catch (e) {
  bad += 1;
  console.error("ERROR", e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(bad ? `FAILED (${bad})` : "PASS");
process.exit(bad ? 1 : 0);
