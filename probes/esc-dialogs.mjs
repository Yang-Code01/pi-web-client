/**
 * 统一 Esc 关弹层（modal.ts 的 Esc 栈）：每个会弹出来的 dialog，焦点在里面、或者点了标题把焦点
 * 落到 body 上，按 Esc 都要能关。打开的顺序：上下文 / 模型 / 开新会话 / 技能面板 / 技能商店。
 *
 * 桩桥 + 真 Chromium，起的是 `web/dist` 的静态文件，不需要 pi，也不花模型调用。
 *
 * 跑：npm --prefix web run build && node probes/esc-dialogs.mjs
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
const OUT = path.join(REPO, ".scratch", "esc-dialogs", "shots");
fs.rmSync(path.join(REPO, ".scratch", "esc-dialogs"), { recursive: true, force: true });
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
  id: "probe-esc",
  name: "Esc 探针",
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
  preview: "Esc",
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
  const rel = url.pathname === "/" ? "index.html" : url.pathname === "/peer" ? "peer.html" : url.pathname.replace(/^\//, "");
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
  const sheets = page.locator(".sheet-back");
  const palette = page.locator(".skill-pop");
  await until(async () => (await composer.locator('[data-act="skills"]').count()) === 1, 8000, "composer ready");

  // 两种焦点：A 刚打开（焦点通常在弹层里）；B 点一下标题（不可聚焦区域 → 焦点落到 body），再按 Esc。
  const cases = [
    { name: "上下文面板", open: () => composer.locator('[data-act="context"]').click(), box: sheets },
    { name: "模型面板", open: () => composer.locator(".model-chip").click(), box: page.locator(".sheet-back, .st-back") },
    { name: "开新会话面板", open: () => page.locator('[data-act="new"]').first().click(), box: sheets },
    { name: "技能面板", open: () => composer.locator('[data-act="skills"]').click(), box: palette },
  ];
  for (const c of cases) {
    for (const variant of ["焦点在内", "焦点在 body"]) {
      await c.open();
      await until(async () => (await c.box.count()) === 1, 4000, `${c.name} open`);
      await sleep(150);
      if (variant === "焦点在 body") {
        const title = c.box.first().locator(".sheet-head, .skill-foot-hint").first();
        if (await title.count()) await title.click({ position: { x: 4, y: 4 } }).catch(() => {});
        await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
      }
      await page.keyboard.press("Escape");
      await until(async () => (await c.box.count()) === 0, 2000, `${c.name} closed by Esc (${variant})`).catch(() => {});
      check(`${c.name}：${variant} 时 Esc 关闭`, (await c.box.count()) === 0);
      await page.screenshot({ path: path.join(OUT, `${c.name}-${variant}.png`) }).catch(() => {});
    }
  }

  // 内网通（iframe 里的 peer 页）：焦点在 iframe 里、没有页内弹层时，Esc 交给父页关掉这个面板。
  const peerBtn = page.locator('[data-act="peer"]').first();
  if (await peerBtn.isVisible().catch(() => false)) {
    await peerBtn.click();
    await until(async () => (await page.locator(".peer-frame").count()) === 1, 4000, "peer sheet open");
    await sleep(800);
    await page.frameLocator(".peer-frame").locator("body").click({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.keyboard.press("Escape");
    await until(async () => (await sheets.count()) === 0, 3000, "peer closed by Esc").catch(() => {});
    check("内网通（iframe 内焦点）：Esc 关闭", (await sheets.count()) === 0, `sheets=${await sheets.count()}`);
  } else {
    console.log("skip 内网通：顶栏按钮不可见（窗口太窄）");
  }

  // 技能商店：从技能面板的「商店」进去，Esc 只关商店（面板已被替换掉），再按一次不再有东西可关。
  await composer.locator('[data-act="skills"]').click();
  await until(async () => (await palette.count()) === 1, 4000, "palette for store");
  await palette.locator(".skill-store-open").click();
  await until(async () => (await sheets.count()) === 1, 4000, "store open");
  await sleep(150);
  await page.keyboard.press("Escape");
  await until(async () => (await sheets.count()) === 0, 2000, "store closed by Esc").catch(() => {});
  check("技能商店：Esc 关闭", (await sheets.count()) === 0);

  // 没有弹层时 Esc 不出错、也不会把聊天输入框清掉。
  const textarea = composer.locator("textarea");
  await textarea.click();
  await textarea.fill("保留的草稿");
  await page.keyboard.press("Escape");
  check("无弹层时 Esc 不动输入框", (await textarea.inputValue()) === "保留的草稿");

  check("页面没有 JS 异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser?.close();
  wss.close();
  server.close();
}

console.log(failures ? failures + " FAILED" : "ALL OK");
process.exitCode = failures ? 1 : 0;
