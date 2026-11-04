/**
 * 技能面板（D115）：点面板以外的地方也能关；「用了几次」按真正发出去的 `/skill:` 算，
 * 不管它是从面板里挑的、从 `/` 补全里选的，还是直接在输入框里敲的。只挑不发不算。
 *
 * 桩桥 + 真 Chromium，起的是 `web/dist` 的静态文件，不需要 pi，也不花模型调用。
 * 桩桥的 `skills` 回答里 alpha 已经是 5 次；后面在输入框里发两次，面板下次打开就该重排。
 *
 * 跑：npm --prefix web run build && node probes/skill-palette.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7924);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(REPO, ".scratch", "skill-palette", "shots");
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

const SESSION = {
  id: "probe-skill",
  name: "技能面板探针",
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
  preview: "技能面板",
  permission: "ask",
};

// Already ranked the way the bridge's rankSkills() would hand it over: uses desc, lastUsed desc, name.
const SKILLS = [
  { name: "alpha", description: "最常用的那个", source: "user", uses: 5, lastUsed: 5_000 },
  { name: "beta", description: "第二常用", source: "user", uses: 3, lastUsed: 4_000 },
  { name: "gamma", description: "第三", source: "user", uses: 2, lastUsed: 3_000 },
  { name: "delta", description: "只用过一次", source: "user", uses: 1, lastUsed: 300 },
  { name: "epsilon", description: "只用过一次（更早）", source: "user", uses: 1, lastUsed: 200 },
  { name: "zeta", description: "只用过一次（最早）", source: "user", uses: 1, lastUsed: 100 },
  { name: "eta", description: "从来没用过", source: "project", uses: 0, lastUsed: 0 },
  { name: "theta", description: "从来没用过，这次在输入框里敲", source: "project", uses: 0, lastUsed: 0 },
];

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const seen = { skills: [], skillUsed: [], prompts: [] };
let sock = null;
const reply = (msg) => sock?.readyState === 1 && sock.send(JSON.stringify(msg));

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
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("close", () => {
    if (sock === ws) sock = null;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: SESSION.id,
          state: { ...SESSION },
          items: [{ kind: "user", id: "u1", text: "这里是一条历史消息。" }],
          approvals: [],
          asks: [],
          budget: null,
        }),
      );
    } else if (msg.type === "skills") {
      seen.skills.push(msg.sessionId ?? null);
      reply({ type: "skills", sessionId: SESSION.id, commands: SKILLS.map((s) => ({ ...s })) });
    } else if (msg.type === "commands") {
      reply({
        type: "commands",
        sessionId: SESSION.id,
        commands: SKILLS.map((s) => ({ name: `skill:${s.name}`, description: s.description, source: "skill" })),
      });
    } else if (msg.type === "skillUsed") {
      seen.skillUsed.push({ name: msg.name, sessionId: msg.sessionId });
    } else if (msg.type === "prompt") {
      seen.prompts.push({ text: msg.text, sessionId: msg.sessionId });
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" },
      sessions: [SESSION],
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
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/s/${SESSION.id}`, { waitUntil: "networkidle" });

  const composer = page.locator(".composer");
  const textarea = composer.locator("textarea");
  const skillsBtn = composer.locator('[data-act="skills"]');
  await until(async () => (await skillsBtn.count()) === 1, 8000, "技能 button");
  const palette = page.locator(".skill-pop");
  const rowNames = async () => page.locator(".skill-row .sk-name").allInnerTexts();

  // ---- 1. 初始顺序就是桥给的顺序（uses 多的在前）
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 4000, "palette open");
  await until(async () => (await rowNames()).length === 6, 4000, "six skill rows");
  check("默认只列前六个（按次数）", JSON.stringify(await rowNames()) === JSON.stringify(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]), JSON.stringify(await rowNames()));
  await page.screenshot({ path: path.join(OUT, "1-open.png") });

  // ---- 2. 点面板以外的地方也能关
  await page.locator(".chat-scroll").click({ position: { x: 30, y: 30 } });
  await until(async () => (await palette.count()) === 0, 2000, "palette closed by outside click");
  check("点对话区关闭面板", (await palette.count()) === 0);

  // ---- 3. 技能按钮本身仍是「开 / 关」的切换，不会被外部点击逻辑抢掉
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 2000, "palette reopened");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 0, 2000, "palette toggled closed");
  check("技能按钮仍是切换", (await palette.count()) === 0);

  // ---- 4. 点面板内部不关；Esc 照旧关
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 2000, "palette open again");
  await page.locator(".skill-search").click();
  await page.keyboard.type("the");
  await until(async () => JSON.stringify(await rowNames()) === JSON.stringify(["theta"]), 2000, "filtered rows");
  check("点搜索框不关面板", (await palette.count()) === 1);
  await page.keyboard.press("Escape");
  await until(async () => (await palette.count()) === 0, 2000, "palette closed by Esc");
  check("Esc 仍能关", (await palette.count()) === 0);

  // ---- 5. 直接在输入框里敲 /skill: 并发出：算一次使用
  check("挑技能之前没有使用记录", seen.skillUsed.length === 0, JSON.stringify(seen.skillUsed));
  await textarea.click();
  await page.keyboard.type("/skill:theta");
  // 等 `/` 补全把这条技能列出来：文本已经完整，Enter 走「已完整输入 → 直接发送」。
  await until(async () => (await page.locator(".complete-row .complete-label").allInnerTexts()).includes("/skill:theta"), 3000, "command completion for theta");
  await page.keyboard.press("Enter");
  await until(async () => seen.prompts.some((p) => p.text === "/skill:theta"), 3000, "prompt sent");
  await until(async () => seen.skillUsed.some((u) => u.name === "theta"), 2000, "theta counted");
  check("输入框里敲的 /skill: 被计数", JSON.stringify(seen.skillUsed.filter((u) => u.name === "theta")) === JSON.stringify([{ name: "theta", sessionId: SESSION.id }]), JSON.stringify(seen.skillUsed));
  check("计数跟着 prompt 的会话走", seen.skillUsed[0]?.sessionId === SESSION.id);

  // ---- 6. 从面板里挑一个但不发：不算；发出去才算
  await until(async () => (await textarea.inputValue()) === "", 2000, "composer cleared");
  await skillsBtn.click();
  await until(async () => (await palette.count()) === 1, 2000, "palette for pick");
  await page.locator(".skill-row").filter({ hasText: "alpha" }).click();
  await until(async () => (await page.locator(".skill-pop").count()) === 0, 2000, "palette closed by pick");
  check("挑选后插入的是 /skill:alpha", (await textarea.inputValue()) === "/skill:alpha ", JSON.stringify(await textarea.inputValue()));
  await sleep(400);
  check("只挑不发不算使用", !seen.skillUsed.some((u) => u.name === "alpha"), JSON.stringify(seen.skillUsed));
  await page.keyboard.press("Enter");
  await until(async () => seen.skillUsed.some((u) => u.name === "alpha"), 3000, "alpha counted");
  check("面板挑的、发出去了才算", JSON.stringify(seen.skillUsed.filter((u) => u.name === "alpha")) === JSON.stringify([{ name: "alpha", sessionId: SESSION.id }]), JSON.stringify(seen.skillUsed));

  // ---- 7. 下次打开：刚用过的 theta 进了前六，alpha 的次数涨到 6 排第一
  await until(async () => (await textarea.inputValue()) === "", 2000, "composer cleared 2");
  await skillsBtn.click();
  await until(async () => (await rowNames()).length === 6, 2000, "palette rows after use");
  const ranked = await rowNames();
  check("用过的 theta 挤进前六", ranked.includes("theta"), JSON.stringify(ranked));
  check("刚用过的 alpha 回到第一", ranked[0] === "alpha", JSON.stringify(ranked));
  check("重排顺序 = 次数 → 最近 → 名字", JSON.stringify(ranked) === JSON.stringify(["alpha", "beta", "gamma", "theta", "delta", "epsilon"]), JSON.stringify(ranked));
  await page.screenshot({ path: path.join(OUT, "2-ranked.png") });

  // ---- 8. /skill: 不在开头就不是 pi 要展开的命令，不计数
  await page.keyboard.press("Escape");
  await until(async () => (await palette.count()) === 0, 2000, "palette closed before negative test");
  await textarea.click();
  await page.keyboard.type("use /skill:eta now");
  await page.keyboard.press("Enter");
  await until(async () => seen.prompts.some((p) => p.text === "use /skill:eta now"), 3000, "negative prompt sent");
  await sleep(400);
  check("不在开头的 /skill: 不计数", !seen.skillUsed.some((u) => u.name === "eta"), JSON.stringify(seen.skillUsed));

  check("页面没有 JS 异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser?.close();
  wss.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exitCode = failures ? 1 : 0;
