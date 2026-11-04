/**
 * Probe: D113 — 扩展弹窗「直接先显示已装的，联网检查并行跑」，以及「点一个不把别的按钮全灰掉」。
 *
 * 桩桥按真实桥的分段协议回答 `ext.inventory`（local → mcp → versions），并把 `picli` / `ext.op`
 * 按页面给的 `reqId` 回执。断言量的是页面上的字、`.act-spin` 在不在、按钮能不能点，
 * 以及网络里真的发了哪些 `reqId`——不是只看元素存在。
 *   1. 打开弹窗：先出「读取已安装的包和扩展…」，然后本地阶段到达 → 包/扩展行出现，MCP 区写「连接 MCP 服务器中…」；
 *   2. 版本还没回来时：顶部有 ⟳ 与「联网检查版本中…」，包行写「检查中…」而不是「最新」；
 *   3. versions 阶段到达：行变「可更新到 2.0.0」+ 更新按钮，⟳ 消失；
 *   4. 关掉再开：上一次的行立刻在（没有「读取…」空态），同时 ⟳ 在转 —— 缓存直显 + 并行检查；
 *   5. 同一个包里点「更新」→ 立刻变「排队中…」，`picli.start` 到达变「更新中…」，别的行的按钮
 *      （另一个包的卸载、扩展的停用）仍然可点；
 *   6. 两个包同时点更新 → 桥收到两个不同 reqId，一个在跑一个在排队，互不阻塞；
 *   7. 跑完后两行各自回到可点的「更新」，同一行可以反复点；
 *   8. 启停扩展走 ext.op：点「停用」先「排队中…」，running 后「停用中…」，done 后回到可点。
 *
 * Run: npm run build:web && node probes/ext-manager-stages.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7931;
const DIST = path.join(REPO, "web", "dist");
const OUT = path.join(REPO, ".scratch", "ext-manager-stages", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
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
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what}`);
};

async function launchPlaywright() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache */
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      const b = await mod.chromium.launch();
      await b.close();
      return mod;
    } catch {
      /* half-installed */
    }
  }
  throw new Error("找不到可用的 playwright（装一个，或设 PW_PATH）");
}

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "1.4.0", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const SES = { id: "probe-ext", name: "扩展", cwd: CWD, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "ext" };
const ITEMS = [
  { kind: "user", id: "u1", ts: Date.now() - 60_000, text: "扩展" },
  { kind: "assistant", id: "a1", ts: Date.now() - 50_000, model: "pi", text: "扩展管理。" },
];

/** 两包一扩展一 MCP；版本要到 versions 阶段才有答案。 */
const PKG_A = { kind: "package", scope: "user", source: "npm:pkg-a", path: null, name: "pkg-a", version: "1.0.0", origin: "npm", pinned: false, latest: null, update: false };
const PKG_B = { kind: "package", scope: "user", source: "npm:pkg-b", path: null, name: "pkg-b", version: "1.0.0", origin: "npm", pinned: false, latest: null, update: false };
const EXT = { kind: "extension", id: "builtin:mcp", label: "MCP 支持", scope: "builtin", how: "builtin", enabled: true };
const MCP = {
  name: "rea",
  scope: "global",
  source: `${CWD}/mcp.json`,
  enabled: true,
  exposure: "codemode",
  transport: "node rea.mjs mcp",
  state: "connected",
  tools: ["inspect_native_load_image"],
  error: null,
  version: { registry: null, identifier: null, version: null, latest: null, update: false },
};
const checked = (p) => ({ ...p, latest: "2.0.0", update: true });
const localStage = { packages: [PKG_A, PKG_B], extensions: [EXT], mcp: [], mcpError: null, updates: 0, checkedAt: Date.now(), mcpReady: false, versionsChecked: false };
const mcpStage = { ...localStage, mcp: [MCP], mcpReady: true };
const versionStage = { ...mcpStage, packages: [checked(PKG_A), checked(PKG_B)], updates: 2, versionsChecked: true };

/** 桩桥的状态：收到的请求。 */
const world = { picli: [], extOp: [], inventories: 0 };

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
      world.inventories += 1;
      const n = world.inventories;
      // D113: three stages, deliberately slow, so the probe can watch the paint in between.
      const cwd = msg.cwd ?? CWD;
      setTimeout(() => n === world.inventories && send({ type: "ext.inventory", cwd, ...localStage }), 120);
      setTimeout(() => n === world.inventories && send({ type: "ext.inventory", cwd, ...mcpStage }), 1500);
      if (msg.check !== false) setTimeout(() => n === world.inventories && send({ type: "ext.inventory", cwd, ...versionStage }), 2600);
      return;
    }
    if (msg.type === "picli") {
      const runId = `cli_${world.picli.length + 1}`;
      // 「排队中 → 更新中」：start 晚 200ms（够页面画一排排队态），done 由探针控制，时序才稳。
      const entry = {
        msg,
        runId,
        start: () => {
          send({ type: "picli.start", reqId: msg.reqId, runId, op: msg.op });
          send({ type: "picli.out", reqId: msg.reqId, runId, text: `$ pi ${msg.op}\n` });
        },
        /** 探针控制它什么时候结束：退出码 + 可选错误，再推一份最新库存。 */
        finish: (code = 0, error) => {
          send({ type: "picli.done", reqId: msg.reqId, runId, op: msg.op, code, ...(error ? { error } : {}) });
          send({ type: "ext.inventory", cwd: CWD, ...versionStage });
        },
      };
      world.picli.push(entry);
      setTimeout(entry.start, 200);
      return;
    }
    if (msg.type === "ext.toggle" || msg.type === "mcp.toggle" || msg.type === "mcp.bump") {
      const entry = {
        msg,
        start: () => send({ type: "ext.op", reqId: msg.reqId, op: msg.type, state: "running" }),
        finish: () => {
          send({ type: "ext.changed", what: msg.type === "ext.toggle" ? "extension" : "mcp", id: msg.id ?? msg.name });
          send({ type: "ext.op", reqId: msg.reqId, op: msg.type, state: "done", code: 0 });
        },
      };
      world.extOp.push(entry);
      setTimeout(entry.start, 200);
      return;
    }
  });
  send({ type: "hello", me: ME, sessions: [SES], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL });
});

const { chromium } = await launchPlaywright();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

/** 打开扩展弹窗（从输入框下那颗按钮）。有可更新时会多一个角标，按钮名会变，所以按 class 找。 */
const openDialog = async (page) => {
  await page.locator(".ext-btn").click();
  await until(async () => (await page.locator(".ext-host").count()) === 1, 5000, "ext dialog");
};
const rowOf = (page, name) => page.locator(".login-row").filter({ hasText: name }).first();
const btnIn = (page, rowName, label) => rowOf(page, rowName).getByRole("button", { name: label, exact: true });
const hintText = async (page) => (await page.locator(".ext-host .settings-hint").first().innerText()).replace(/\s+/g, " ").trim();
const spinning = async (page) => (await page.locator(".ext-host .act-spin").count()) > 0;

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 2, 8000, "messages");

  // 1) 冷启动：空态说的是「读取已安装的…」，不是「联网检查版本中」当主角
  await openDialog(page);
  await until(async () => (await page.locator(".ext-host .empty").first().innerText().catch(() => "")).includes("读取已安装"), 2000, "cold empty state");
  log("cold:", (await page.locator(".ext-host .empty").first().innerText()).trim());
  check(!(await rowOf(page, "pkg-a").count()), "冷启动时还没有行");
  check(await spinning(page), "顶部已经有 ⟳（联网检查在跑）");
  await page.screenshot({ path: path.join(OUT, "1-cold.png") });

  // 2) 本地阶段到达：行出现，MCP 区还在连接
  await until(async () => (await rowOf(page, "pkg-a").count()) === 1, 4000, "local stage rows");
  check(true, "本地阶段一到，包行就出现了（不等联网）");
  check((await page.locator(".ext-host").innerText()).includes("连接 MCP 服务器中"), "MCP 区写「连接 MCP 服务器中…」");
  check((await rowOf(page, "pkg-a").innerText()).includes("检查中"), `版本还没回来时写「检查中…」（拿到 ${(await rowOf(page, "pkg-a").innerText()).replace(/\s+/g, " ")}）`);
  check(!(await btnIn(page, "pkg-a", "更新").count()), "还没有「更新」按钮（版本未知）");
  await page.screenshot({ path: path.join(OUT, "2-local.png") });

  // 3) versions 到达：可更新 + 更新按钮，⟳ 消失
  await until(async () => (await rowOf(page, "pkg-a").innerText()).includes("可更新到 2.0.0"), 5000, "versions stage");
  check(await btnIn(page, "pkg-a", "更新").isEnabled(), "版本回来后「更新」可点");
  await until(async () => !(await spinning(page)), 3000, "spinner gone");
  check((await hintText(page)).includes("检查于"), `检查完了顶部改写成「检查于 …」（拿到 ${await hintText(page)}）`);
  check((await page.locator(".ext-host").innerText()).includes("已连接 · 1 个工具"), "MCP 行带着连接状态");
  await page.screenshot({ path: path.join(OUT, "3-versions.png") });

  // 4) 关掉再开：上一次的行立刻在，同时又在检查
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await until(async () => (await page.locator(".ext-host").count()) === 0, 3000, "dialog closed");
  const before = world.inventories;
  await openDialog(page);
  check((await rowOf(page, "pkg-a").count()) === 1, "重开时上一次的行直接就在（没有空态）");
  check((await hintText(page)).includes("联网检查版本中"), `重开时顶部是「联网检查版本中…」（拿到 ${await hintText(page)}）`);
  check(await spinning(page), "重开时 ⟳ 在转");
  await until(async () => world.inventories > before, 3000, "second inventory request");
  await until(async () => !(await spinning(page)), 6000, "second check finished");
  await page.screenshot({ path: path.join(OUT, "4-reopen.png") });

  // 5) 点一个，别的行照旧可点（start 晚 200ms，先看到「排队中…」再变成「更新中…」）
  const firstPicli = world.picli.length;
  await btnIn(page, "pkg-a", "更新").click();
  await until(async () => world.picli.length === firstPicli + 1, 3000, "picli request");
  const reqA = world.picli[firstPicli].msg;
  check(typeof reqA.reqId === "string", `请求带 reqId（拿到 ${reqA.reqId}）`);
  await until(async () => (await rowOf(page, "pkg-a").innerText()).includes("排队中"), 2000, "queued label");
  check(true, "点下去立刻是「排队中…」");
  check(await btnIn(page, "pkg-b", "更新").isEnabled(), "另一个包的「更新」仍然可点");
  check(await btnIn(page, "MCP 支持", "停用").isEnabled(), "扩展的「停用」仍然可点");
  check(!(await btnIn(page, "pkg-a", "卸载").isEnabled()), "同一行的「卸载」在这行忙时禁用（不同行才互不影响）");
  await page.screenshot({ path: path.join(OUT, "5-queued.png") });
  await until(async () => (await rowOf(page, "pkg-a").innerText()).includes("更新中"), 3000, "running label");
  check(true, "picli.start 到了之后是「更新中…」");

  // 6) 第二个包也在跑：两个 reqId 各归各行，A 跑着 B 也能点
  await btnIn(page, "pkg-b", "更新").click();
  await until(async () => world.picli.length >= firstPicli + 2, 3000, "second picli request");
  const reqB = world.picli[firstPicli + 1].msg;
  check(reqA.reqId !== reqB.reqId, `两个请求各有自己的 reqId（${reqA.reqId} / ${reqB.reqId}）`);
  await until(async () => (await rowOf(page, "pkg-b").innerText()).match(/排队中|更新中/) !== null, 3000, "row b busy");
  check((await rowOf(page, "pkg-a").innerText()).includes("更新中"), "A 还在跑，没有被 B 抢掉状态");
  await page.screenshot({ path: path.join(OUT, "6-both.png") });

  // 7) 只结束 A：A 恢复，B 保持自己的状态
  world.picli[firstPicli].finish(0);
  await until(async () => (await rowOf(page, "pkg-a").getByRole("button", { name: "更新", exact: true }).count()) === 1, 5000, "row a back to 更新");
  check((await rowOf(page, "pkg-b").innerText()).match(/排队中|更新中/) !== null, "A 结束后 B 还在忙（没有被一起清掉）");
  world.picli[firstPicli + 1].finish(0);
  await until(async () => (await rowOf(page, "pkg-b").getByRole("button", { name: "更新", exact: true }).count()) === 1, 5000, "row b back to 更新");
  check(true, "两个都结束后各自回到可点的「更新」");

  // 8) 失败也把行放开：code 1 + 错误文字进控制台
  const failIdx = world.picli.length;
  await btnIn(page, "pkg-a", "更新").click();
  await until(async () => world.picli.length === failIdx + 1, 3000, "failing request");
  world.picli[failIdx].finish(1, "npm ERR! network");
  await until(async () => (await rowOf(page, "pkg-a").getByRole("button", { name: "更新", exact: true }).count()) === 1, 5000, "row a after failure");
  check((await page.locator(".ext-host").innerText()).includes("npm ERR! network"), `失败原因写到控制台（拿到 ${(await page.locator(".ext-host .login-result").first().innerText()).replace(/\s+/g, " ")}）`);
  await page.screenshot({ path: path.join(OUT, "7-failed.png") });

  // 9) 启停扩展走 ext.op：排队中 → 停用中 → 可点
  const toggleIdx = world.extOp.length;
  await btnIn(page, "MCP 支持", "停用").click();
  await until(async () => world.extOp.length === toggleIdx + 1, 3000, "ext.toggle request");
  const reqT = world.extOp[toggleIdx].msg;
  check(typeof reqT.reqId === "string", `ext.toggle 也带 reqId（拿到 ${reqT.reqId}）`);
  await until(async () => (await rowOf(page, "MCP 支持").innerText()).includes("停用中"), 3000, "disabling label");
  check(await btnIn(page, "pkg-b", "更新").isEnabled(), "启停扩展时包行照旧可点");
  world.extOp[toggleIdx].finish();
  await until(async () => (await rowOf(page, "MCP 支持").getByRole("button", { name: "停用", exact: true }).count()) === 1, 5000, "toggle back");
  check(true, "ext.op done 之后那一行回到可点");
  await page.screenshot({ path: path.join(OUT, "8-toggled.png") });

  log(bad ? `${bad} FAILED` : "ALL OK");
} finally {
  await browser?.close();
  wss.close();
  server.close();
}
process.exit(bad ? 1 : 0);
