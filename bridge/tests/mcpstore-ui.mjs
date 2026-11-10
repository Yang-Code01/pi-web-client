/**
 * MCP 商店的「已安装」与「默认名」（#299 / #300），从页面这一层验：
 * 已装服务器的命令行里有包名、或者 URL 相同（多一个尾斜杠也算），商店行就必须写「已安装」；
 * 点安装后表单里的默认名不能是别人的名字（撞名要加序号），手输撞名要说「替换」。
 *
 * 桩桥只回答页面要的那几个帧（hello / settings.get / lockext.get / ext.inventory / mcp.store），
 * 断言的量是页面上的字与按钮，不是元素存不存在。
 *
 * Run: npm run build:web && node bridge/tests/mcpstore-ui.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadPlaywright } from "../../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 7932;
const DIST = path.join(REPO, "web", "dist");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;

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
    if (await fn()) return true;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "1.4.0", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-mcpstore", name: "MCP 商店", cwd: CWD, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "mcp" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "MCP 商店" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "看商店。" },
];

const ver = { registry: null, identifier: null, version: null, latest: null, update: false };
/** 已装的三台：命令里带包名、URL 带尾斜杠、名字与别人撞。 */
const mcpRow = (name, extra) => ({
  name,
  scope: "global",
  source: `${CWD}/mcp.json`,
  enabled: true,
  exposure: "codemode",
  transport: extra.url ? `remote ${extra.url}` : `${extra.command} ${extra.args.join(" ")}`,
  command: extra.command ?? null,
  args: extra.args ?? [],
  url: extra.url ?? null,
  state: "connected",
  tools: [],
  error: null,
  version: ver,
});
const INSTALLED = [
  mcpRow("browser-use", { command: "uvx", args: ["browser-use", "--cli-mcp"] }),
  mcpRow("worldmonitor", { url: "https://worldmonitor.app/mcp/" }),
  mcpRow("builderio", { command: "npx", args: ["-y", "@somebody/other-mcp"] }),
];

const opt = (o) => ({ version: null, transport: "", env: [], headers: [], args: [], unavailable: undefined, ...o });
const STORE = [
  {
    name: "com.browser-use/browser-use",
    title: "Browser Use",
    description: "浏览器自动化",
    version: "1.0.0",
    repo: "browser-use/browser-use",
    stars: 68_000,
    options: [
      opt({ kind: "pypi", label: "PyPI · browser-use", identifier: "browser-use" }),
      opt({ kind: "remote", label: "远程 · api.browser-use.com", identifier: "https://api.browser-use.com/v3/mcp", url: "https://api.browser-use.com/v3/mcp", transport: "http" }),
    ],
  },
  {
    name: "app.worldmonitor/mcp",
    title: "World Monitor",
    description: "世界动态",
    version: "2.0.0",
    repo: "koala73/worldmonitor",
    stars: 1_200,
    options: [opt({ kind: "remote", label: "远程 · worldmonitor.app", identifier: "https://worldmonitor.app/mcp", url: "https://worldmonitor.app/mcp", transport: "http" })],
  },
  {
    name: "com.puter/mcp-server",
    title: "Puter",
    description: "云桌面",
    version: "0.3.0",
    repo: "HeyPuter/puter",
    stars: 30_000,
    options: [opt({ kind: "npm", label: "npm · @wonderwhy-er/desktop-commander", identifier: "@wonderwhy-er/desktop-commander" })],
  },
  {
    name: "io.github.BuilderIO/mcp",
    title: "Builder.io",
    description: "设计到代码",
    version: "1.1.0",
    repo: "BuilderIO/builder",
    stars: 7_400,
    options: [opt({ kind: "npm", label: "npm · @builder.io/mcp", identifier: "@builder.io/mcp" })],
  },
];
const INVENTORY = { packages: [], extensions: [], mcp: INSTALLED, mcpError: null, updates: 0, checkedAt: Date.now(), mcpReady: true, versionsChecked: true, mcpNote: null };
const world = { storeQueries: [] };

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

const wsMod = await import(pathToFileURL(path.join(REPO, "bridge", "node_modules", "ws", "wrapper.mjs")).href);
const wss = new wsMod.WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
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
    if (msg.type === "lockext.get") {
      send({ type: "lockext", installed: false, path: "probe" });
      return;
    }
    if (msg.type === "ext.inventory") {
      send({ type: "ext.inventory", cwd: msg.cwd ?? CWD, ...INVENTORY });
      return;
    }
    if (msg.type === "mcp.store") {
      world.storeQueries.push(String(msg.query ?? ""));
      send({ type: "mcp.store", query: msg.query, items: STORE, building: false, truncated: false, starsComplete: true, hasToken: true });
      return;
    }
  });
  send({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL });
});

const { chromium } = await loadPlaywright();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const rowOf = (page, name) => page.locator(".login-row").filter({ hasText: name }).first();
const installedChip = (page, name) => rowOf(page, name).locator(".login-status.ok");

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    log("page error:", e.message);
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 打开扩展弹窗 → MCP 商店
  await page.locator(".ext-btn").click();
  await until(async () => (await page.locator(".ext-host").count()) === 1, 5000, "ext dialog");
  await page.locator(".settings-tabs button", { hasText: "MCP 商店" }).click();
  await until(async () => (await page.locator(".login-row").count()) === STORE.length, 6000, "store rows");
  check(true, `商店列出 ${STORE.length} 条`);

  // #300 A：PyPI 包名在已装服务器的命令行里 → 已安装
  check(await installedChip(page, "Browser Use").count() === 1, "命令行里有 browser-use → 已安装");
  check((await installedChip(page, "Browser Use").getAttribute("title")) === "已安装为 browser-use", "已安装的 title 说清是哪台服务器");

  // #300 B：URL 相同、只差一个尾斜杠 → 仍算已安装
  check(await installedChip(page, "World Monitor").count() === 1, "URL 只差尾斜杠也认已安装");

  // #300 C/D：没装的仍然给安装按钮（别把没装的说成装了）
  check((await rowOf(page, "Puter").getByRole("button", { name: "安装", exact: true }).count()) === 1, "没装的 Puter 仍是「安装」");
  check(await installedChip(page, "Puter").count() === 0, "Puter 没有已安装标记");

  // #299：默认名撞上已装的 builderio → 自动加序号
  await rowOf(page, "Builder.io").getByRole("button", { name: "安装", exact: true }).click();
  const nameInput = page.locator(".ext-sheet input.ns-input.mono").first();
  await until(async () => (await nameInput.count()) === 1, 4000, "install form");
  check((await nameInput.inputValue()) === "builderio-2", `默认名避开已装的名字（${await nameInput.inputValue()}）`);
  const hint = page.locator(".ext-sheet .settings-hint").filter({ hasText: "同名" });
  check(await hint.isVisible() === false || await hint.textContent() === "", "默认名不撞时不出红字");

  // #299：手输一个已有的名字 → 说清楚会被替换，按钮也改口
  await nameInput.fill("browser-use");
  await until(async () => (await page.locator(".ext-sheet .settings-hint").filter({ hasText: "已有同名服务器" }).count()) === 1, 3000, "collision hint");
  check(true, "撞名时红字出现");
  const go = rowOf(page, "Builder.io").locator("button.btn.primary").first(); // 行的「安装」换成表单的提交键，都在这一行里
  check((await go.textContent())?.includes("替换安装"), `按钮改口（${(await go.textContent())?.trim()}）`);

  // 清空 → 禁用 + 另一句提示
  await nameInput.fill("");
  await until(async () => await page.locator(".ext-sheet .settings-hint").filter({ hasText: "名字不能为空" }).count() === 1, 3000, "empty hint");
  check(await go.isDisabled(), "空名字时不能点安装");
  check(await nameInput.evaluate((el) => el.classList.contains("bad")), "空名字时输入框标红");

  await nameInput.fill("builderio-2");
  check(await go.isEnabled() && !(await go.textContent())?.includes("替换"), "改回不撞的名字后恢复「安装」并可点");

  check(errors.length === 0, `没有 pageerror（${errors.length}）`);
} finally {
  await browser?.close();
  wss.close();
  server.close();
}

console.log(bad === 0 ? "PASS" : `FAILED ${bad}`);
process.exit(bad === 0 ? 0 : 1);
