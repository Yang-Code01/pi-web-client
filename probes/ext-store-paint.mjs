/**
 * Probe: 扩展商店 / MCP 商店 的重画、滚动与输入（#308）。
 *
 * 桩桥把 `ext.store` / `mcp.store` 的回答**故意拖 700ms**，好让探针在「请求还在路上」时继续打字；
 * `ext.inventory` 按真实桥的三段协议（本地 → mcp → 版本）推送，并在第一次 `mcp.store` 之后
 * 再补推两段，用来数「一次进店到底发了几次请求」。
 *
 * 断言（每条都对应 #308 的一个症状）：
 *   T6 弹窗 · 边加载边打字：库存三段还在路上时打的字不该被重画吞掉。
 *   T1 弹窗 · 请求在途时继续打字：回包到达后的重画不该把输入框退回旧值。
 *   T7 一次防抖只发一个 ext.store（以前 run() 自己发一次、重画又发一次）。
 *   T3 进 MCP 商店一次只发一个 mcp.store（以前每段库存重画都自己发请求）。
 *   T4 装过的那个 MCP 仍显示「已安装」（对照组：精确匹配没有把已装的弄丢）。
 *   T5 设置页首帧只有一份「扩展与 MCP」（以前 checkPiUpdate 在 paint 里同步重入，叠出两份）。
 *   T2 设置页 · 回复到达后：输入值、滚动位置、光标都还在原处。
 *
 * Run: npm run build:web && node probes/ext-store-paint.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, REPO, scratch, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 7941);
const OUT = scratch("shots", "ext-store-paint");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let bad = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) bad += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "1.4.0", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-store", name: "商店", cwd: CWD, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "store" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "商店" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "商店探针。" },
];

/** 12 个包：够滚一屏，又短到能在一行里断言。 */
const PKGS = Array.from({ length: 12 }, (_, i) => ({
  name: `pi-pkg-${String(i + 1).padStart(2, "0")}`,
  version: "1.2.3",
  description: "一个测试用的 pi 扩展包，描述写长一点好占两行。",
  link: `https://example.com/pkg-${i + 1}`,
  monthly: 12000 - i * 700,
  publisher: "probe",
}));
/** 已装的那个 MCP：transport 就是 pi 记下的命令行，identifier 是 npx 跑的包名。 */
const MCP_INSTALLED = {
  name: "exa",
  scope: "global",
  source: `${CWD}/mcp.json`,
  enabled: true,
  exposure: "codemode",
  transport: "npx -y exa-mcp-server@0.9.0",
  state: "connected",
  tools: [],
  error: null,
  version: { registry: "npm", identifier: "exa-mcp-server", version: "0.9.0", latest: "0.9.0", update: false },
};
const mcpItem = (i, name, title, identifier) => ({
  name,
  title,
  description: "测试用的 MCP 服务，描述写长一点好占两行。",
  version: "1.0.0",
  repo: `https://github.com/probe/${i}`,
  stars: 4000 - i * 137,
  options: [{ kind: "npm", label: "npx（npm 包）", identifier, version: "1.0.0", transport: "stdio", env: [], headers: [], args: [] }],
});
const MCP_ITEMS = [
  mcpItem(1, "io.github.exa/exa-mcp-server", "exa", "exa-mcp-server"), // 装过的那个
  ...Array.from({ length: 9 }, (_, i) => mcpItem(i + 2, `io.github.probe/mcp-${i + 2}`, `mcp-${i + 2}`, `mcp-${i + 2}`)),
];
const localStage = { packages: [], extensions: [], mcp: [], mcpError: null, updates: 0, checkedAt: Date.now(), mcpReady: false, versionsChecked: false };
const mcpStage = { ...localStage, mcp: [MCP_INSTALLED], mcpReady: true };
const versionStage = { ...mcpStage, versionsChecked: true };

/** 桩桥记下的请求。 */
const world = { extStore: [], mcpStore: [] };

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
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const file = path.join(DIST, rel);
  if (!path.resolve(file).startsWith(path.resolve(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wsMod = await import(pathToFileURL(wsWrapper()).href);
const wss = new wsMod.WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
const STORE_DELAY = 700;
const sockets = new Set();
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      send({ type: "session", sessionId: SES.id, state: SES, items: ITEMS, approvals: [], asks: [], budget: null });
      return;
    }
    if (msg.type === "settings.get") {
      send({ type: "settings", scope: msg.scope ?? "global", cwd: msg.cwd, path: "probe", exists: false, values: {}, raw: "{}" });
      return;
    }
    if (msg.type === "pi.update.check") {
      // 真桥会答；延迟 400ms 是故意的：先让首帧渲染出来
      setTimeout(() => send({ type: "pi.update.status", current: ME.pi, latest: ME.pi, source: "npm", checkedAt: Date.now(), update: false }), 400);
      return;
    }
    if (msg.type === "lockext.get") {
      send({ type: "lockext", installed: false, path: "probe" });
      return;
    }
    if (msg.type === "ext.inventory") {
      const cwd = msg.cwd ?? CWD;
      setTimeout(() => send({ type: "ext.inventory", cwd, ...localStage }), 300);
      setTimeout(() => send({ type: "ext.inventory", cwd, ...mcpStage }), 600);
      setTimeout(() => send({ type: "ext.inventory", cwd, ...versionStage }), 900);
      return;
    }
    if (msg.type === "ext.store") {
      world.extStore.push({ query: msg.query, at: Date.now() });
      setTimeout(() => send({ type: "ext.store", query: msg.query, items: PKGS }), STORE_DELAY);
      return;
    }
    if (msg.type === "mcp.store") {
      world.mcpStore.push({ query: msg.query, at: Date.now() });
      setTimeout(
        () =>
          send({
            type: "mcp.store",
            query: msg.query,
            items: MCP_ITEMS,
            at: Date.now(),
            starsComplete: true,
            building: false,
            hasToken: true,
            truncated: false,
          }),
        STORE_DELAY,
      );
      // 第一次问商店之后补推两段库存：真桥在检查版本时也会接着推。
      // 页面若在渲染里发请求，这两次重画就会再各发一个 mcp.store。
      if (world.mcpStore.length === 1) {
        setTimeout(() => sockets.forEach((s) => s.readyState === 1 && s.send(JSON.stringify({ type: "ext.inventory", cwd: CWD, ...mcpStage }))), 150);
        setTimeout(() => sockets.forEach((s) => s.readyState === 1 && s.send(JSON.stringify({ type: "ext.inventory", cwd: CWD, ...versionStage }))), 300);
      }
      return;
    }
    if (msg.type === "picli" || msg.type === "ext.toggle" || msg.type === "mcp.toggle" || msg.type === "mcp.bump") {
      // 本探针用不到，但别让页面等在那儿。
      send({ type: "picli.done", reqId: msg.reqId, runId: "cli_probe", op: msg.op, code: 0 });
      return;
    }
  });
  send({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL });
});

const { chromium } = await loadPlaywright();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const searchBox = (scope) => scope.locator('input[placeholder^="搜索"]').first();

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 880 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // ---------------------------------------------------------------- 弹窗 · 扩展商店
  await page.locator(".ext-btn").click();
  await until(async () => (await page.locator(".ext-host").count()) === 1, 5000, "ext dialog");
  const host = page.locator(".ext-host");
  await page.locator(".ext-host .chip", { hasText: "扩展商店" }).click();
  // T6 边加载边打字：点开商店时库存三段还在路上（300/600/900ms），每段都会重画
  const box6 = searchBox(host);
  await box6.click();
  await box6.type("abcdefgh", { delay: 60 });
  await until(async () => (await host.locator(".login-row").count()) >= 12, 8000, "ext rows");
  const typed6 = await searchBox(host).inputValue();
  check(typed6 === "abcdefgh", `T6 弹窗：重画到达时不该吞掉正在打的字（打 abcdefgh，拿到「${typed6}」）`);
  await sleep(1200); // 让进店那两次空 ext.store 的回包先落地，免得干扰 T1 的时序

  // T1 请求在途时继续打字：回包到达重画，输入框不该退回旧值
  const box1 = searchBox(host);
  await box1.click();
  await box1.fill("");
  await sleep(60);
  world.extStore.length = 0;
  await box1.type("abc", { delay: 20 });
  await until(async () => world.extStore.some((r) => r.query === "abc"), 3000, "ext.store abc");
  await box1.type("def", { delay: 20 });
  const typed1 = await searchBox(host).inputValue();
  await until(async () => world.extStore.some((r) => r.query === "abcdef"), 3000, "ext.store abcdef");
  const seen1 = new Set();
  const t1 = Date.now();
  while (Date.now() - t1 < 2500) {
    seen1.add(await searchBox(host).inputValue());
    await sleep(20);
  }
  check(typed1 === "abcdef" && !seen1.has("abc"), `T1 弹窗：请求在途时打的字不能被回包回滚（打的是「${typed1}」，期间输入框出现 ${JSON.stringify([...seen1])}）`);

  // T7 一次防抖只该发一个请求
  world.extStore.length = 0;
  const box7 = searchBox(host);
  await box7.click();
  await box7.fill("");
  await sleep(500);
  world.extStore.length = 0;
  await box7.type("pi", { delay: 10 });
  await until(async () => world.extStore.some((r) => r.query === "pi"), 3000, "ext.store pi");
  await sleep(300);
  const n7 = world.extStore.filter((r) => r.query === "pi").length;
  check(n7 === 1, `T7 一次搜索只该发一个 ext.store（拿到 ${n7} 个）`);
  await page.screenshot({ path: path.join(OUT, "1-dialog-store.png") });

  // ---------------------------------------------------------------- T3 / T4 MCP 商店
  await page.locator(".ext-host .chip", { hasText: "MCP 商店" }).click();
  await until(async () => (await host.locator(".login-row").count()) >= 10, 6000, "mcp rows");
  await sleep(400);
  const n3 = world.mcpStore.length;
  check(n3 === 1, `T3 进 MCP 商店一次，桥收到 ${n3} 个 mcp.store（期望 1：重画不该自己发请求）`);
  const already = await host.locator(".login-row").first().innerText();
  check(already.includes("已安装"), `T4 装过的 exa 那条显示「已安装」（拿到「${already.replace(/\s+/g, " ")}」）`);
  // T8 弹窗滚动：库存再推一段（= 重画一次），滚到哪儿就该还在哪儿
  const sheetBody = page.locator(".ext-sheet .settings-body");
  await sheetBody.evaluate((b) => (b.scrollTop = Math.min(40, b.scrollHeight - b.clientHeight)));
  const before8 = await sheetBody.evaluate((b) => b.scrollTop);
  sockets.forEach((s) => s.readyState === 1 && s.send(JSON.stringify({ type: "ext.inventory", cwd: CWD, ...versionStage })));
  await sleep(300);
  const after8 = await sheetBody.evaluate((b) => b.scrollTop);
  check(after8 === before8, `T8 弹窗：重画后滚动位置不跳（推前 ${before8}，推后 ${after8}）`);
  await page.screenshot({ path: path.join(OUT, "2-dialog-mcp.png") });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await until(async () => (await page.locator(".ext-host").count()) === 0, 3000, "dialog closed");

  // ---------------------------------------------------------------- T5 / T2 设置页
  await page.locator(".composer-input textarea").fill("/settings");
  await page.locator(".composer-input textarea").press("Enter");
  await until(async () => (await page.locator('.st-nav__item[data-tab="ext"]').count()) === 1, 8000, "settings nav ext");
  await page.locator('.st-nav__item[data-tab="ext"]').click();
  await sleep(80); // 重入发生在 click 的同步栈里，这里只看首帧
  const nHost = await page.locator(".st-pane .ext-host").count();
  const nBox = await page.locator('.st-pane .ext-host input[placeholder^="搜索"]').count();
  check(nHost === 1, `T5 设置页只该有一份「扩展与 MCP」，首帧拿到 ${nHost} 份、${nBox} 个搜索框（paintExtSettings → paintPiUpdate 末尾 checkPiUpdate → paintExtIfOpen 同步重入 paintSettings）`);
  await until(async () => (await page.locator(".st-pane .ext-host").count()) === 1, 5000, "settings ext page");
  const sHost = page.locator(".st-pane .ext-host").last();
  await page.locator(".st-pane .ext-host .chip", { hasText: "MCP 商店" }).last().click();
  await until(async () => (await sHost.locator(".login-row").count()) >= 10, 8000, "settings mcp rows");
  const pane = page.locator(".st-pane");
  await pane.evaluate((b) => (b.scrollTop = Math.min(60, b.scrollHeight - b.clientHeight)));
  const before2 = await pane.evaluate((b) => b.scrollTop);
  const box2 = searchBox(sHost);
  await box2.click();
  await box2.type("abc", { delay: 30 });
  const reqsBefore2 = world.mcpStore.length;
  await until(async () => world.mcpStore.some((r, i) => i >= reqsBefore2 && r.query === "abc"), 3000, "mcp.store abc");
  await box2.type("def", { delay: 20 });
  const typed2 = await box2.inputValue();
  await sleep(1200); // 回复到了 + 重画
  const after2 = await searchBox(sHost).inputValue();
  const scroll2 = await pane.evaluate((b) => b.scrollTop);
  const focus2 = await page.evaluate(() => {
    const a = document.activeElement;
    return a instanceof HTMLInputElement ? { ph: a.placeholder.slice(0, 6), caret: a.selectionStart } : { ph: String(a?.tagName), caret: null };
  });
  check(typed2 === "abcdef", `设置页打字时是「abcdef」（拿到 ${typed2}）`);
  check(after2 === "abcdef", `T2 设置页：回复到达后仍是我打的「abcdef」（拿到「${after2}」）`);
  check(scroll2 === before2, `T2 设置页：滚动位置不跳（打前 ${before2}，打后 ${scroll2}）`);
  check(focus2.caret === 6, `T2 设置页：光标还在末尾（拿到 ${JSON.stringify(focus2)}）`);
  await page.screenshot({ path: path.join(OUT, "3-settings-store.png") });

  log(bad ? `${bad} FAILED` : "ext-store-paint: ok");
} finally {
  await browser?.close();
  wss.close();
  server.close();
}
process.exit(bad ? 1 : 0);
