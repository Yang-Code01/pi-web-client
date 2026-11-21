/**
 * D356：pi 还在启动时，`/` 补全和技能面板不能说「没有」—— 清单只是还没到（扩展命令、提示词模板、
 * 扩展自带的技能都在 pi 手里，它冷启要几秒才答得出 `get_commands`）。
 *
 * 桩桥 + 真 Chromium：同一个「空回答」，两个会话只有 `starting` 不同，断言文字不一样 ——
 *   - starting：`/` 补全说「pi 正在启动…命令表随后到」，技能面板说「…技能表随后到」；
 *   - 不是 starting：照旧「没有匹配的命令」/「技能列表还没到，稍等一下…」。
 * 再验桥端 D356 的推送：桩桥主动推 `commands` / `skills` 帧，页面不重新问也要当场换成真清单。
 *
 * 跑：npm --prefix web run build && node probes/skill-boot-hint.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = Number(process.env.PI_WEB_PORT ?? 7925);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch", "skill-boot-hint", "shots");
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error(`超时：${what}`);
};

const base = (id, name, starting) => ({
  id,
  name,
  cwd: REPO,
  file: null,
  owned: true,
  origin: "web",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  locked: false,
  preview: name,
  permission: "ask",
  starting,
});
const SESSIONS = {
  "probe-boot": base("probe-boot", "还在启动", true),
  "probe-ready": base("probe-ready", "已经起来", false),
};

const BOOT_CMD_EMPTY = "pi 正在启动（加载扩展，通常几秒）…命令表随后到";
const BOOT_SKILL_EMPTY = "pi 正在启动（加载扩展，通常几秒）…技能表随后到";
const READY_CMD_EMPTY = "没有匹配的命令";
const READY_SKILL_EMPTY = "技能列表还没到，稍等一下…";

const PUSHED_COMMANDS = [
  { name: "skill:alpha", description: "pi 报的技能", source: "skill" },
  { name: "mcp", description: "扩展命令", source: "extension" },
];
const PUSHED_SKILLS = [{ name: "alpha", description: "pi 报的技能", source: "user", uses: 0, lastUsed: 0, viewable: true }];

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" }));
  }
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
const socks = new Set();
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
const push = (msg) => {
  for (const ws of socks) if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};
wss.on("connection", (ws) => {
  socks.add(ws);
  ws.on("close", () => socks.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const state = SESSIONS[msg.sessionId];
    if (msg.type === "subscribe" && state) {
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state: { ...state }, items: [], approvals: [], asks: [], budget: null }));
    } else if (msg.type === "commands") {
      // 空回答：启动窗口里磁盘上一个技能都没有，正是用户看到的那个空列表。
      ws.send(JSON.stringify({ type: "commands", sessionId: msg.sessionId, commands: [] }));
    } else if (msg.type === "skills") {
      ws.send(JSON.stringify({ type: "skills", sessionId: msg.sessionId, commands: [] }));
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: Object.values(SESSIONS),
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`fake bridge on ${BASE}`);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "zh-CN" });
  const errors = [];

  const open = async (id) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/#/s/${id}`, { waitUntil: "networkidle" });
    return page;
  };

  // ---- 1. pi 还在启动：补全与面板都说「还在启动」，不说「没有」
  const page = await open("probe-boot");
  const composer = page.locator(".composer");
  const textarea = composer.locator("textarea");
  await textarea.click();
  await page.keyboard.type("/skill");
  const empty = page.locator(".complete-empty");
  await until(async () => (await empty.count()) === 1, 4000, "补全的空态");
  const cmdEmpty = (await empty.innerText()).trim();
  check("启动中：补全说「还在启动」", cmdEmpty === BOOT_CMD_EMPTY, cmdEmpty);
  check("启动中：没有说「没有匹配的命令」", !cmdEmpty.includes(READY_CMD_EMPTY), cmdEmpty);
  await page.screenshot({ path: path.join(OUT, "1-complete-boot.png") });

  await page.locator('[data-act="skills"]').click();
  const skillEmpty = page.locator(".skill-empty");
  await until(async () => (await skillEmpty.count()) === 1, 4000, "技能面板的空态");
  const skEmpty = (await skillEmpty.innerText()).trim();
  check("启动中：技能面板说「还在启动」", skEmpty === BOOT_SKILL_EMPTY, skEmpty);
  check("启动中：没有说「技能列表还没到」", !skEmpty.includes(READY_SKILL_EMPTY), skEmpty);
  await page.screenshot({ path: path.join(OUT, "2-palette-boot.png") });

  // ---- 2. 桥端启动完成后主动推一帧：不重新问也要换成真清单
  push({ type: "commands", sessionId: "probe-boot", commands: PUSHED_COMMANDS });
  push({ type: "skills", sessionId: "probe-boot", commands: PUSHED_SKILLS });
  await until(async () => (await page.locator(".skill-row").count()) === 1, 4000, "面板换上推送的技能");
  check("推送一到，技能面板当场换人", (await page.locator(".skill-row .sk-name").allInnerTexts()).join(",") === "alpha");
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".skill-pop").count()) === 0, 2000, "面板关掉");
  await textarea.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("/skill");
  await until(async () => (await page.locator(".complete-row .complete-label").allInnerTexts()).includes("/skill:alpha"), 4000, "补全换上推送的清单");
  check("推送一到，补全当场换人", (await page.locator(".complete-row .complete-label").allInnerTexts()).includes("/skill:alpha"));
  await page.screenshot({ path: path.join(OUT, "3-complete-pushed.png") });

  // ---- 3. 对照：pi 已经起来了（starting 假），同样的空回答照旧说「没有」
  const ready = await open("probe-ready");
  const rComposer = ready.locator(".composer");
  await rComposer.locator("textarea").click();
  await ready.keyboard.type("/skill");
  const rEmpty = ready.locator(".complete-empty");
  await until(async () => (await rEmpty.count()) === 1, 4000, "对照：补全的空态");
  check("已启动：补全照旧说「没有匹配的命令」", (await rEmpty.innerText()).trim() === READY_CMD_EMPTY, (await rEmpty.innerText()).trim());
  await rComposer.locator('[data-act="skills"]').click();
  const rSkillEmpty = ready.locator(".skill-empty");
  await until(async () => (await rSkillEmpty.count()) === 1, 4000, "对照：技能面板的空态");
  check("已启动：面板照旧说「技能列表还没到」", (await rSkillEmpty.innerText()).trim() === READY_SKILL_EMPTY, (await rSkillEmpty.innerText()).trim());
  await ready.screenshot({ path: path.join(OUT, "4-ready.png") });

  check("页面没有 JS 异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser?.close();
  wss.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exitCode = failures ? 1 : 0;
