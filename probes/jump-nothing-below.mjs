/**
 * Probe: 「↓ new」只在下面真还有东西的时候才出现。
 *
 * 报障场景：一条短会话（转录整体装得下、下面空无一物），鼠标在转录上随便上滚一格，底部就长出
 * 「↓ new」——回头看什么都没有。根因是 `wheel` 上滚无条件 `stopFollowing()`，而「不跟流」这个
 * 状态本身就会画出那颗钮；随后流式输出的下一段内容又把 `unread` 点亮，于是连 new 小标也来了。
 *
 * 反过来也要成立：转录真的溢出时，上滚就该亮出那颗钮（新加的守卫不能把正常路径一起挡掉）。
 *
 * 一切都在真实布局里量：`scrollHeight - clientHeight`、`.chat-jump` 的 hidden / has-new，
 * 以及「跟流没被关掉」的物证——再喂一段内容，视口仍钉在底部。
 *
 * Run: npm run build:web && node probes/jump-nothing-below.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 7897);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      await mod.chromium.launch().then((b) => b.close());
      return mod;
    } catch {
      /* half-installed playwright: try the next one */
    }
  }
  throw new Error("找不到可用的 playwright（设 PW_PATH=<.../playwright/index.mjs>）");
}

// --- a transcript that fits on screen: one question, one short answer -----------------------------
const state = {
  id: "stub-jump",
  name: "短会话探针",
  cwd: REPO,
  file: null,
  owned: true,
  origin: "web",
  running: true,
  done: false,
  model: "stub",
  modelName: "stub",
  thinkingLevel: "medium",
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
};
const items = [
  { id: "u0", kind: "user", text: "这条会话很短：转录装得下，下面没有内容。", images: [], ts: new Date(Date.now() - 60_000).toISOString() },
  { id: "a0", kind: "assistant", text: "收到。下面确实什么都没有。", thinking: "", model: "stub", ts: new Date(Date.now() - 59_000).toISOString() },
];
const streamId = "a0";
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: REPO };
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

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set();
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "subscribe") {
        ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items, approvals: [], asks: [], budget: null }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [state], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 844 }, locale: "zh-CN" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });
await page.locator(".session-card").first().click();
await sleep(1200);

const geom = () =>
  page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    return {
      top: Math.round(root.scrollTop),
      height: Math.round(root.scrollHeight),
      client: Math.round(root.clientHeight),
      gap: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      room: Math.round(root.scrollHeight - root.clientHeight),
      jumpHidden: document.querySelector(".chat-jump")?.hidden ?? null,
      hasNew: document.querySelector(".chat-jump")?.classList.contains("has-new") ?? null,
    };
  });

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const wheelUp = async (times = 3) => {
  await page.mouse.move(450, 420);
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, -120);
    await sleep(30);
  }
  await sleep(350); // 让 D94 那 300ms 的 hold 走完
};

const push = (text) => {
  for (const ws of sockets) ws.send(JSON.stringify({ type: "delta", sessionId: state.id, id: streamId, field: "text", text }));
};

// A: 短会话里空滚一格 —— 不该长出「↓ new」，跟流也不该被关掉
const a0 = await geom();
check("初始：转录装得下、没有「回到底部」", a0.room <= 24 && a0.jumpHidden === true, JSON.stringify(a0));
await wheelUp(3);
const a1 = await geom();
check("短会话上滚 3 格后：钮仍然不出现", a1.jumpHidden === true, JSON.stringify(a1));
push("这一行是跟流有没有被关掉的物证。\n");
await sleep(300);
const a2 = await geom();
check("短会话上滚后再来内容：视口仍钉在底部", a2.jumpHidden === true && a2.gap <= 24 && a2.hasNew === false, JSON.stringify(a2));

// B: 同一个会话继续长，直到转录真的溢出（跟流期间一直被钉在底部）
for (let i = 0; i < 40 && (await geom()).room <= 240; i += 1) {
  push(`第 ${i + 1} 行：把这条回复喂长，直到转录溢出视口，用来验证真的有事可看时那颗钮还出得来。\n`);
  await sleep(60);
}
await sleep(400);
const b0 = await geom();
check("溢出后跟流仍生效：停在底部、钮不出现", b0.room > 240 && b0.jumpHidden === true && b0.gap <= 24, JSON.stringify(b0));

// C: 真的有东西在下面时，上滚就该亮出那颗钮（守卫不能把正常路径挡掉）
await wheelUp(3);
const c0 = await geom();
check("溢出后上滚：钮出现、还没点亮 new", c0.jumpHidden === false && c0.hasNew === false && c0.gap > 0, JSON.stringify(c0));

// D: 掉队期间来内容 → new 小标
push("掉队期间又来了新内容。\n");
await sleep(300);
const d0 = await geom();
check("掉队期间来内容：亮出 new", d0.jumpHidden === false && d0.hasNew === true, JSON.stringify(d0));

// E: 点一下回到底部，继续跟流
await page.locator(".chat-jump").click();
await sleep(400);
const e0 = await geom();
check("点「回到底部」：钮收起、视口回到底", e0.jumpHidden === true && e0.gap <= 24, JSON.stringify(e0));

// F: 不跟流时视口长高到装得下 —— 钮也跟着收起来（下面又没东西了）
await wheelUp(3);
const f0 = await geom();
await page.setViewportSize({ width: 900, height: 1600 });
await sleep(500);
const f1 = await geom();
check("不跟流时窗口变高到装得下：钮收起", f0.jumpHidden === false && f1.room <= 24 && f1.jumpHidden === true, `${JSON.stringify(f0)} → ${JSON.stringify(f1)}`);

await browser.close();
await new Promise((r) => server.close(r));
const passed = results.every(Boolean);
console.log(passed ? "PASS: 「↓ new」只在下面真有东西时出现" : "FAIL: 钮在空无一物时也冒出来了");
process.exitCode = passed ? 0 : 1;
