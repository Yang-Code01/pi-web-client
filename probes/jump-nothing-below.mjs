/**
 * Probe: 「↓ new」只在下面真还有东西的时候才出现（D168）。
 *
 * 报障场景：一条短会话（转录整体装得下、下面空无一物），鼠标在转录上随便上滚一格，底部就长出
 * 「↓ new」——回头看什么都没有。根因是 `wheel` 上滚无条件 `stopFollowing()`，而「不跟流」这个
 * 状态本身就会画出那颗钮；随后流式输出的下一段内容又把 `unread` 点亮，于是连 new 小标也来了。
 *
 * 八项检查，正反两面都覆盖：
 *   短会话 / 24px 容差带内：滚轮与触摸都不该把钮弄出来，跟流也不该被关掉；
 *   真的溢出：上滚照常出钮、掉队期间来内容亮 new、点一下回到底；
 *   下面又没东西了（内容被折叠掉）：钮自己收起。
 *
 * 一切都在真实布局里量（`scrollHeight - clientHeight`、`.chat-jump` 的 hidden / has-new + 再喂
 * 一段内容看视口是否仍钉底），不靠读内部状态——这些判据本来就是给布局写的。
 *
 * Run: npm run build:web && node probes/jump-nothing-below.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 7940);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
let streamText = "";
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

const { WebSocketServer } = await import(pathToFileURL(wsWrapper()).href);
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

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
// locale 必须有（docs/I18N.md）：默认 en-US 下界面是英文，按钮文案与断言都对不上。
const ctx = await browser.newContext({ viewport: { width: 900, height: 844 }, hasTouch: true, locale: "zh-CN" });
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
  streamText += text;
  for (const ws of sockets) ws.send(JSON.stringify({ type: "delta", sessionId: state.id, id: streamId, field: "text", text }));
};

// A. 短会话：滚轮上滚一格都不该弄出钮，跟流也不该被关掉
const a0 = await geom();
check("短会话初始：装得下、没有「回到底部」", a0.room <= 24 && a0.jumpHidden === true, JSON.stringify(a0));
await wheelUp(3);
const a1 = await geom();
check("短会话滚轮上滚 3 格：钮仍然不出现", a1.jumpHidden === true, JSON.stringify(a1));
push("这一行是跟流有没有被关掉的物证。\n");
await sleep(300);
const a2 = await geom();
check("短会话上滚后再来内容：视口仍钉在底部", a2.jumpHidden === true && a2.gap <= 24 && a2.hasNew === false, JSON.stringify(a2));

// A2. 同一个假话在触屏上：手指往下拖 120px，什么也没得翻
{
  const cdp = await ctx.newCDPSession(page);
  let y = 300;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 450, y }] });
  for (let i = 0; i < 8; i += 1) {
    y += 15;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 450, y }] });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
  const t0 = await geom();
  push("触摸之后再来的内容，视口也应该还在底部。\n");
  await sleep(300);
  const t1 = await geom();
  check("短会话触摸下拖：钮不出现、跟流还活着", t0.jumpHidden === true && t1.jumpHidden === true && t1.gap <= 24 && t1.hasNew === false, `${JSON.stringify(t0)} → ${JSON.stringify(t1)}`);
}

// B. 同一个会话继续长，直到转录真的溢出（跟流期间一直被钉在底部）
for (let i = 0; i < 40 && (await geom()).room <= 240; i += 1) {
  push(`第 ${i + 1} 行：把这条回复喂长，直到转录溢出视口，用来验证真的有事可看时那颗钮还出得来。\n`);
  await sleep(60);
}
await sleep(400);
const b0 = await geom();
check("溢出后跟流仍生效：停在底部、钮不出现", b0.room > 240 && b0.jumpHidden === true && b0.gap <= 24, JSON.stringify(b0));

// C. 真的有东西在下面时，上滚就该亮出那颗钮（守卫不能把正常路径挡掉）
await wheelUp(3);
const c0 = await geom();
check("溢出后上滚：钮出现、还没点亮 new", c0.jumpHidden === false && c0.hasNew === false && c0.gap > 0, JSON.stringify(c0));

// D. 掉队期间来内容 → new 小标
push("掉队期间又来了新内容。\n");
await sleep(300);
const d0 = await geom();
check("掉队期间来内容：亮出 new", d0.jumpHidden === false && d0.hasNew === true, JSON.stringify(d0));

// E. 点一下回到底部，继续跟流
await page.locator(".chat-jump").click();
await sleep(400);
const e0 = await geom();
check("点「回到底部」：钮收起、视口回到底", e0.jumpHidden === true && e0.gap <= 24, JSON.stringify(e0));

/**
 * 把「视口底部与内容底之间还差多少」调到 `target` px：room 与视口高度 1:1 反向，
 * 量一次、改一次、再量一次（字体与换行会让第一次的估计差几像素）。
 */
async function tuneRoom(target) {
  let g = await geom();
  await page.setViewportSize({ width: 900, height: 844 + (g.room - target) });
  await sleep(400);
  g = await geom();
  if (Math.abs(g.room - target) > 6) {
    const box = page.viewportSize();
    await page.setViewportSize({ width: 900, height: box.height + (g.room - target) });
    await sleep(400);
  }
  return geom();
}

// F. 容差带里（0 < room ≤ 24）：差这几像素不算「下面有东西」，上滚也不该出钮
{
  const f0 = await tuneRoom(10);
  await wheelUp(3);
  const f1 = await geom();
  const inBand = f0.room > 0 && f0.room <= 24;
  check(
    "容差带内（0 < room ≤ 24）上滚：钮不出现",
    inBand && f1.jumpHidden === true,
    `room=${f0.room} → ${JSON.stringify(f1)}`,
  );
}

// G. 刚过容差（room ≈ 60）：这里就真有东西可翻了，钮必须出得来
{
  const g0 = await tuneRoom(60);
  await wheelUp(3);
  const g1 = await geom();
  const aboveBand = g0.room > 24;
  check("刚过容差（room ≈ 60）上滚：钮出现", aboveBand && g1.jumpHidden === false && g1.hasNew === false, `room=${g0.room} → ${JSON.stringify(g1)}`);
}

// H. 不跟流时内容自己缩水（把长回答折起来）：下面又没东西了，钮要自己收起
{
  // 流式期间文字长在 `.stream` 里（折叠藏的是 `.body`），先把这条回复「落定」成一个普通条目，
  // 才是用户看到的那种可折叠回答 —— `item.replace` 就是 app.ts 在真桥上接的那条路。
  for (const ws of sockets) ws.send(JSON.stringify({ type: "item.replace", sessionId: state.id, id: streamId, item: { ...items[1], text: streamText } }));
  await sleep(600);
  const h0 = await geom();
  const folds = await page.locator(".msg-fold").count();
  if (folds) await page.locator(".msg-fold").first().click();
  await sleep(600);
  const h1 = await geom();
  check(
    "不跟流时长回答被折叠：下面空了，钮跟着收起",
    folds > 0 && h0.jumpHidden === false && h1.room <= 24 && h1.jumpHidden === true,
    `${JSON.stringify(h0)} → ${JSON.stringify(h1)}`,
  );
}

await browser.close();
await new Promise((r) => server.close(r));
const passed = results.every(Boolean);
console.log(passed ? "PASS: 「↓ new」只在下面真有东西时出现" : "FAIL: 钮在空无一物时也冒出来了");
process.exitCode = passed ? 0 : 1;
