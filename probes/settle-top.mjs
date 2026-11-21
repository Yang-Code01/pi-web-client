/**
 * Probe: 一轮结束时，长回答把视口送回它的第一行（A）。
 *
 * 用户报的是：回答流式长出来时视口一直贴底，结束以后人停在末尾，得自己往上滚好几屏。
 * 现在的修法是「收尾回开头」：最后一条回答长过一屏、人还在跟流 → 平滑滚到它的第一行；
 * 人已经自己往上读了、回答很短、或者后面还跟着别的内容 → 一动不动。
 *
 * 用 stub 桥（不碰 pi、不碰模型）造三段会话：
 *   长回答   → 收尾应停在回答首行，↓ 可见且没有「new」；点 ↓ 回到底部。
 *   短回答   → 收尾仍贴底（不足一屏不动）。
 *   上滚中   → 收尾时人已经在上面的位置，不能被拽回开头。
 *
 * Run: npm run build:web && node probes/settle-top.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web/dist");
const PORT = Number(process.env.PI_WEB_PORT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PARAS = [
  "先说结论：这次改动落在 `web/src/chat.ts` 的三处，桥、协议、样式都不用动。收尾只认一个信号——`running` 从 true 翻成 false，而且这一刻用户还在跟流。",
  "为什么不在流式过程中改：回答一边长一边把第一行钉在顶部，会让人看不到最新输出；工具尾巴、正在跑的命令也一起被顶到视口外。用户要的是「写完了从开头读」，不是「永远读开头」。",
  "落点一：`setRunning()` 里记下 `wasRunning`，true → false 时等两帧再量。`message_end` 的 `replace()` 会把流式节点换成最终节点，高度要等排版；一帧不够，两帧刚好。",
  "落点二：新增 `settleScroll()`。它先确认最后一块内容是 `.msg.assistant`、没有手动折叠、高度超过视口 90%，再算首行的位置；算不出来（开头就在最后一屏里）就留在底部。",
  "落点三：`reset()` 静默清 `running` 并取消待跑的帧。换会话时旧会话的 true 会让新会话的 false 被当成「刚结束」，不取消就会把新会话滚到别人的回答上。",
  "边界一：用户手指还按在屏幕上（`touching`）不动。收尾是自动行为，不能跟手指抢滚动；等手指松开，用户要读哪里由他自己决定。",
  "边界二：用户已经往上读了（`following === false`）不动。这时候他正读的那段才是重点，任何自动跳转都是打扰；新内容照旧只点亮「new」。",
  "边界三：最后一轮后面还跟着工具卡、用户气泡（下一轮已经开了）不动。`jump.previousElementSibling` 不是 assistant 就直接返回，避免把视口从更新的内容上挪走。",
  "验证方式：`npm run build:web && node probes/settle-top.mjs`。探针用三段假会话分别覆盖长回答、短回答、上滚中；断言收尾后的 scrollTop，而不是只看「有没有滚动」——滚错地方和没滚一样糟。",
];

const LONG = PARAS.map((p, i) => `## ${i + 1}. ${["结论", "为什么不改流式", "收尾信号", "定位首行", "换会话", "手指在屏幕上", "已经往上读", "后面还有内容", "怎么验证"][i]}\n\n${p}`).join("\n\n") +
  "\n\n```ts\nconst startTop = node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 6;\nif (startTop < maxScroll - 1) root.scrollTo({ top: startTop, behavior: \"smooth\" });\n```\n";
const SHORT = "短回答：这一条只有两行，整段都在最后一屏里。收尾时不该动视口，也不该冒出「回到底部」的钮。";

const mkUser = (n, text) => ({ id: `u${n}`, kind: "user", text, images: [], ts: new Date(Date.now() - (30 - n) * 60_000).toISOString() });
const mkAssistant = (n, text) => ({
  id: `a${n}`,
  kind: "assistant",
  text,
  thinking: "",
  model: "stub",
  ts: new Date(Date.now() - (30 - n) * 59_000).toISOString(),
});

const history = [];
for (let i = 1; i <= 6; i += 1) {
  history.push(mkUser(i, `第 ${i} 轮：把滚动那块再看一遍，顺便确认 D68 / D94 / D168 的守卫没有被绕过。`));
  history.push(mkAssistant(i, `第 ${i} 轮的结论：守卫都还在，改动只在新加的收尾路径上。下面是一条足够长的历史，让转录有得滚。\n\n${"这一行只是为了把历史撑长，重复三次。\n".repeat(3)}`));
}

const longItems = [
  ...history,
  mkUser(7, "长回答收尾时，能不能直接把我送回它的第一行？"),
  { id: "draft:long", kind: "assistant", text: "", thinking: "", model: "stub", ts: new Date().toISOString() },
];
const shortItems = [
  ...history,
  mkUser(7, "短回答也试一下。"),
  { id: "draft:short", kind: "assistant", text: "", thinking: "", model: "stub", ts: new Date().toISOString() },
];
const upItems = [
  ...history,
  mkUser(7, "我在流式的时候先往上读，收尾别把我拽走。"),
  { id: "draft:up", kind: "assistant", text: "", thinking: "", model: "stub", ts: new Date().toISOString() },
];

const makeSession = (id, name, items, running) => ({
  session: {
    id,
    name,
    cwd: REPO,
    file: null,
    owned: true,
    origin: "web",
    running,
    done: !running,
    model: "stub",
    modelName: "stub",
    thinkingLevel: "medium",
    updatedAt: Date.now(),
    approvals: 0,
    asks: 0,
    preview: "",
    locked: false,
    items,
  },
  items,
});

const sessions = new Map([
  ["s-long", makeSession("s-long", "长回答收尾", longItems, true)],
  ["s-short", makeSession("s-short", "短回答对照", shortItems, true)],
  ["s-up", makeSession("s-up", "长回答·上滚中", upItems, true)],
]);

const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: REPO };
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
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
      if (msg.type !== "subscribe") return;
      const entry = sessions.get(String(msg.sessionId ?? ""));
      if (!entry) return;
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: entry.session.id,
          state: entry.session,
          items: entry.items,
          approvals: [],
          asks: [],
          budget: null,
        }),
      );
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        me: ME,
        sessions: [...sessions.values()].map(({ session, items: _i }) => session),
        manage: { pin: [], order: [], archived: [] },
        trash: [],
        tunnel: TUNNEL,
      }),
    );
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const send = (body) => {
  for (const ws of sockets) ws.send(JSON.stringify(body));
};

const result = {};
const record = (name, ok, detail) => {
  result[name] = ok;
  console.log(`${name.padEnd(14)} ${ok ? "PASS" : "FAIL"}  ${detail}`);
};

let browser = null;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', "probe");
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector(".session-card", { timeout: 15000 });

  const geom = () =>
    page.evaluate(() => {
      const root = document.querySelector(".chat-scroll");
      const nodes = [...root.querySelectorAll(":scope > .msg.assistant")];
      const node = nodes[nodes.length - 1];
      const jump = document.querySelector(".chat-jump");
      const raw = Number.parseFloat(getComputedStyle(root).getPropertyValue("--ui-scale"));
      const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
      return {
        top: Math.round(root.scrollTop),
        max: Math.round(root.scrollHeight - root.clientHeight),
        answerTop: node ? Math.round((node.getBoundingClientRect().top - root.getBoundingClientRect().top) / scale + root.scrollTop - 6) : null,
        answerHeight: node ? Math.round(node.offsetHeight) : 0,
        scale,
        viewport: root.clientHeight,
        jumpHidden: jump?.hidden ?? null,
        hasNew: jump?.classList.contains("has-new") ?? null,
      };
    });

  /** Wait until the transcript's scrollTop has been unchanged for three samples. */
  async function waitScrollSettled(timeout = 5000) {
    let last = Number.NaN;
    let stable = 0;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const top = await page.evaluate(() => Math.round(document.querySelector(".chat-scroll")?.scrollTop ?? 0));
      if (top === last) stable += 1;
      else {
        stable = 0;
        last = top;
      }
      if (stable >= 3) return;
      await sleep(50);
    }
  }

  async function open(name) {
    await page.locator(".session-card", { hasText: name }).first().click();
    await sleep(900);
  }

  /** Stream `text` into one draft in small chunks; returns the stop function. */
  function stream(sessionId, itemId, text) {
    const step = Math.max(24, Math.ceil(text.length / 90));
    let at = 0;
    const timer = setInterval(() => {
      if (at >= text.length) return;
      const chunk = text.slice(at, at + step);
      at += step;
      send({ type: "delta", sessionId, id: itemId, field: "text", text: chunk });
    }, 35);
    return async () => {
      clearInterval(timer);
      await sleep(120);
    };
  }

  /** Finish the draft the way the bridge does: replace the streaming node, then flip running off. */
  async function finish(sessionId, itemId, text) {
    send({
      type: "item.replace",
      sessionId,
      id: itemId,
      item: { id: itemId, kind: "assistant", text, thinking: "", model: "stub", ts: new Date().toISOString() },
    });
    const entry = sessions.get(sessionId);
    entry.session = { ...entry.session, running: false, done: true };
    entry.items = entry.items.map((it) => (it.id === itemId ? { ...it, text } : it));
    send({ type: "session.state", session: entry.session });
  }

  // --- 1. long answer: settle at its first line ---------------------------------------------------
  await open("长回答收尾");
  let g = await geom();
  console.log("long before:", JSON.stringify(g));
  record("scale-not-1", g.scale > 1.01, `scale=${g.scale} (default 1.25)`);
  const stopLong = stream("s-long", "draft:long", LONG);
  for (let i = 0; i < 80; i += 1) {
    await sleep(100);
    g = await geom();
    if (g.answerHeight > g.viewport * 2.5 && g.top >= g.max - 2) break;
  }
  await stopLong();
  await finish("s-long", "draft:long", LONG);
  await waitScrollSettled();
  g = await geom();
  console.log("long after: ", JSON.stringify(g));
  record(
    "long-settle",
    g.answerTop !== null && Math.abs(g.top - g.answerTop) <= 16 && g.jumpHidden === false && g.hasNew === false,
    `top=${g.top} answerTop=${g.answerTop} max=${g.max} jumpHidden=${g.jumpHidden} hasNew=${g.hasNew}`,
  );
  record("long-scrolled", g.top < g.max - 200, `top=${g.top} max=${g.max} (should leave the bottom)`);

  // A late delta must not drag the viewport back (following is off after settle), and the jump
  // button must advertise it, then take us back to the bottom.
  send({ type: "delta", sessionId: "s-long", id: "draft:long", field: "text", text: "\n\n（收尾之后又补了一句。）\n" });
  await sleep(350);
  const afterLate = await geom();
  record("late-no-pull", Math.abs(afterLate.top - g.top) <= 2 && afterLate.hasNew === true, `top=${afterLate.top} was=${g.top} hasNew=${afterLate.hasNew}`);
  await page.locator(".chat-jump").click();
  await waitScrollSettled(3000);
  const back = await geom();
  record("jump-back", back.top >= back.max - 2 && back.jumpHidden === true, `top=${back.top} max=${back.max} hidden=${back.jumpHidden}`);

  // --- 2. short answer: no movement --------------------------------------------------------------
  await open("短回答对照");
  const stopShort = stream("s-short", "draft:short", SHORT);
  await sleep(700);
  await stopShort();
  await finish("s-short", "draft:short", SHORT);
  await waitScrollSettled(2000);
  g = await geom();
  console.log("short:      ", JSON.stringify(g));
  record(
    "short-stays",
    g.answerHeight < g.viewport && Math.abs(g.top - g.max) <= 2 && g.jumpHidden === true,
    `top=${g.top} max=${g.max} answerHeight=${g.answerHeight} view=${g.viewport} hidden=${g.jumpHidden}`,
  );

  // --- 3. already reading up: settle must not yank ----------------------------------------------
  await open("长回答·上滚中");
  const stopUp = stream("s-up", "draft:up", LONG);
  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    g = await geom();
    if (g.answerHeight > g.viewport * 2.5) break;
  }
  await page.mouse.move(640, 420);
  await page.mouse.wheel(0, -900);
  await sleep(250);
  const upBefore = await geom();
  await stopUp();
  await finish("s-up", "draft:up", LONG);
  await waitScrollSettled();
  const upAfter = await geom();
  console.log("up before:  ", JSON.stringify(upBefore));
  console.log("up after:   ", JSON.stringify(upAfter));
  record(
    "up-held",
    upBefore.top < upBefore.max - 100 && Math.abs(upAfter.top - upBefore.top) <= 2 && upAfter.jumpHidden === false,
    `before=${upBefore.top} after=${upAfter.top} max=${upAfter.max} hidden=${upAfter.jumpHidden}`,
  );

  fs.mkdirSync(path.join(REPO, ".scratch/settle-top"), { recursive: true });
  await page.screenshot({ path: path.join(REPO, ".scratch/settle-top/long-settle.png") });
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

const passed = Object.values(result).every(Boolean);
console.log(passed ? "PASS: 长回答收尾回到开头，短回答 / 上滚中都不动" : "FAIL: 收尾滚动不符合预期");
process.exitCode = passed ? 0 : 1;
