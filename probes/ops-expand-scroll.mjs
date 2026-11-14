/**
 * Probe: 点开「31 个操作」那一刻，视口会不会自己跳到转录最底部（用户报障 2026-11-14，D251）。
 *
 * 报障口径（原话）：「我点击展开操作记录时，会自动展开，并且展开后自动移动到最底部。但是有时候又不会。」
 *
 * 机制：`.chat-scroll` 的滚动条是 `::-webkit-scrollbar` 画的，**占 10px 布局宽度**
 * （web/src/styles.css 里 `::-webkit-scrollbar { width: 10px }`）。转录从「装得下」变成「溢出」
 * 那一刻内容盒窄 10px → `web/src/chat.ts` 里 root 的 ResizeObserver 被叫醒 → 跟流中它去
 * `scrollTop = scrollHeight` → 视口翻到那 31 条的最末尾。装得下的短会话里 `following` 一直是
 * true（D168 的 holdUp/stopFollowing 在没有可滚余量时提前 return），所以短会话必跳；
 * 已经溢出、又用滚轮上滚过（following=false）就只走 renderJump()，不跳 —— 这就是「有时候又不会」。
 *
 * 修法（D251）：`.chat-scroll { scrollbar-gutter: stable }` —— 槽位常驻，滚动条进场不再重排，
 * ResizeObserver 也就没被叫醒过（A 里「滚动日志」为空就是这条证据）。
 *
 * 六件事：
 *  A 装得下的短会话里点开 ops（第一次撑出滚动条）→ 视口不许动 + 槽宽不许变（这是报障本身）
 *  A2 同一个会话里点开**小**一块（增量不到一屏）→ 视口同样不许动（只在 RO 里按 gap 放宽的
 *     那种修法会漏掉这一条：增量 ≤ 一屏时它还认为「贴着底」）
 *  B 已溢出 + 上滚过 + 点开 → 视口不许动（别为了修 A 把跟流一起关掉）
 *  C 跟流中视口被顶矮（输入框长高）→ 必须仍然贴底（A 的修法不许伤到这条）
 *  D 跟流中真重排（右栏拉开）→ 必须仍然贴底（槽位常驻不许把「真重排也贴底」一起废掉）
 *
 * Run: npm run build:web && node probes/ops-expand-scroll.mjs
 *      PI_PROBE_BROWSER=msedge node probes/ops-expand-scroll.mjs   # 真 Edge，滚动条真占位
 *
 * headless 的 Chromium 用的是 overlay 滚动条（量过：动画/自定义 width 都不占布局），`gutter` 恒为 0，
 * 所以 A 的机制证据（槽宽 10→10）只有 `PI_PROBE_BROWSER=msedge`（真 Edge，headed）才量得到；
 * headless 那边 A 只剩「点开不滚」这条弱断言，两种跑法都留着。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const PORT = Number(process.env.PI_WEB_PORT ?? 7942);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.env.PI_PROBE_BROWSER === "msedge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (sec) => new Date(Date.now() - sec * 1000).toISOString();

const state = {
  id: "stub-ops", name: "操作折叠探针", cwd: REPO, file: null, owned: true, origin: "web",
  running: false, done: true, model: "stub", modelName: "stub", thinkingLevel: "medium",
  updatedAt: Date.now(), approvals: 0, asks: 0, preview: "", locked: false,
};

// 31 个操作（bash ×25 · read ×6），每条几行输出：展开后能长到四五千像素。
const tools = [];
for (let i = 0; i < 31; i += 1) {
  const bash = i % 31 < 25;
  tools.push({
    id: `t${i}`, kind: "tool", toolCallId: `call_${i}`,
    name: bash ? "bash" : "read",
    args: bash ? { command: `cd /f/pi-web-client && echo step-${i} && git status --short | head -5` } : { file_path: `web/src/file-${i}.ts` },
    result: Array.from({ length: 9 }, (_, k) => `line ${k + 1} of tool ${i}: 0123456789 abcdefghij ${"x".repeat(20)}`).join("\n"),
    status: "ok", durationMs: 200 + i * 10, ts: at(600 - i),
  });
}
// 会话本体刻意短：折叠着装得下一屏（用户的场景 —— 长正文多半已经手动「收起」了）。
const items = [
  { id: "u0", kind: "user", text: "先查一下 bridge 上次更新的记录。", images: [], ts: at(900) },
  ...tools,
  { id: "a1", kind: "assistant", text: "看完了，31 个操作都在上面那个折叠块里。", thinking: "", model: "stub", ts: at(20) },
];

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
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
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
const browser = HEADED
  ? await chromium.launch({ channel: "msedge", headless: false, args: ["--window-size=1240,900", "--window-position=-2400,-2400"] })
  : await chromium.launch();
// locale 必须有（docs/I18N.md）；视口按真 Edge 常见尺寸给。
const ctx = await browser.newContext({ viewport: { width: 1240, height: 860 }, locale: "zh-CN" });
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

// 谁动了滚动位置：拦 scrollTop 的赋值 / scrollTo / scrollIntoView，记调用栈，失败时好定位。
await page.evaluate(() => {
  window.__scrollLog = [];
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() {
      return d.get.call(this);
    },
    set(v) {
      window.__scrollLog.push({ how: "scrollTop=", v: Math.round(Number(v)), cls: this.className || this.tagName, stack: String(new Error().stack).split("\n").slice(1, 6).join(" | ") });
      d.set.call(this, v);
    },
  });
  const st = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...a) {
    window.__scrollLog.push({ how: "scrollTo", arg: JSON.stringify(a[0]), cls: this.className || this.tagName, stack: String(new Error().stack).split("\n").slice(1, 6).join(" | ") });
    return st.apply(this, a);
  };
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    window.__scrollLog.push({ how: "scrollIntoView", cls: this.className || this.tagName, stack: String(new Error().stack).split("\n").slice(1, 6).join(" | ") });
    return siv.apply(this, a);
  };
});

const geom = () =>
  page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    return {
      top: Math.round(root.scrollTop),
      sh: Math.round(root.scrollHeight),
      client: Math.round(root.clientHeight),
      gap: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
      room: Math.round(root.scrollHeight - root.clientHeight),
      // 滚动条（含自定义 width）实际占掉的宽度：溢出前后差 10px 就是 A 的触发条件。
      gutter: Math.round(root.offsetWidth - root.clientWidth),
      jumpHidden: document.querySelector(".chat-jump")?.hidden ?? null,
      opsOpen: document.querySelector("details.ops")?.open ?? null,
    };
  });
const takeLog = () => page.evaluate(() => window.__scrollLog.splice(0, window.__scrollLog.length));
const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `\n        ${extra}` : ""}`);
};

await takeLog();

// ── A. 短会话、装得下，点开 ops（这一下把转录第一次撑出滚动条）───────────────
{
  const a0 = await geom();
  if (a0.room > 0) console.log(`(!) 前置条件不对：折叠时已经溢出 room=${a0.room}，A 测不到报障本身`);
  await page.evaluate(() => document.querySelector("details.ops > summary")?.click());
  await sleep(800);
  const a1 = await geom();
  const log = await takeLog();
  check(
    `A 装得下的短会话里点开 ops（${HEADED ? "真 Edge" : "headless"}）：视口不许动、滚动条槽宽不许变`,
    Math.abs(a1.top - a0.top) < 8 && a1.room > 0 && a1.gutter === a0.gutter,
    `before=${JSON.stringify(a0)} after=${JSON.stringify(a1)} 滚动日志=${JSON.stringify(log)}`,
  );
}

// ── A2. 同一会话里点开**小**一块：增量不到一屏，也不许跳 ──────────────────────
// 只在 ResizeObserver 里按「gap ≤ 一屏」放宽的修法会漏掉它；槽位常驻则根本没触发源。
{
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    const ops = document.querySelector("details.ops");
    ops.open = false;
    root.scrollTop = 0;
    // 只留 3 张卡：展开后大约三四百像素，仍在一屏以内。
    [...ops.querySelectorAll(".tool")].forEach((card, i) => {
      card.style.display = i >= 3 ? "none" : "";
    });
  });
  await sleep(500);
  const a20 = await geom();
  await page.evaluate(() => document.querySelector("details.ops > summary")?.click());
  await sleep(800);
  const a21 = await geom();
  const log = await takeLog();
  check(
    "A2 装得下的短会话里点开一小块（增量不到一屏）：视口同样不许动",
    Math.abs(a21.top - a20.top) < 8 && a21.room > 0,
    `before=${JSON.stringify(a20)} after=${JSON.stringify(a21)} 滚动日志=${JSON.stringify(log)}`,
  );
  // 复原：后面的 case 要那 31 张卡。
  await page.evaluate(() => {
    document.querySelector("details.ops").open = false;
    document.querySelectorAll("details.ops .tool").forEach((card) => { card.style.display = ""; });
  });
  await sleep(400);
}

// ── B. 已经溢出、用滚轮上滚过（following=false），再点开 ops ─────────────────
{
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    document.querySelector("details.ops").open = false; // 收回，露出滚动条常驻的状态
    root.scrollTop = Math.round(root.scrollHeight / 2);
  });
  await sleep(400);
  await page.mouse.move(620, 420);
  await page.mouse.wheel(0, -120); // 真滚轮手势：D94/D168 认它，关掉跟流
  await sleep(450);
  const b0 = await geom();
  await takeLog();
  await page.evaluate(() => document.querySelector("details.ops > summary")?.click());
  await sleep(800);
  const b1 = await geom();
  const log = await takeLog();
  check(
    "B 已溢出 + 上滚过再点开：视口不许动",
    Math.abs(b1.top - b0.top) < 8,
    `before=${JSON.stringify(b0)} after=${JSON.stringify(b1)} 滚动日志=${JSON.stringify(log)}`,
  );
}

// ── C. 跟流中视口被顶矮（输入框长高）：必须仍然贴底 ─────────────────────────
{
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    root.scrollTop = root.scrollHeight; // 滚到底 → D94 的 scroll 监听恢复跟流
  });
  await sleep(500);
  const c0 = await geom();
  await takeLog();
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    root.style.height = `${root.clientHeight - 60}px`; // 等价于输入框长高 60px
  });
  await sleep(800);
  const c1 = await geom();
  const log = await takeLog();
  check(
    "C 跟流中视口变矮：仍然贴底",
    c1.gap <= 24 && c1.top > c0.top - 8,
    `before=${JSON.stringify(c0)} after=${JSON.stringify(c1)} 滚动日志=${JSON.stringify(log)}`,
  );
}

// ── D. 跟流中被重排（右栏拉开 → 图文换行变窄）：小幅位移仍要贴底 ───────────────
{
  await page.evaluate(() => {
    const root = document.querySelector(".chat-scroll");
    root.style.height = "";
    root.style.paddingRight = "";
    root.scrollTop = root.scrollHeight;
  });
  await sleep(500);
  const d0 = await geom();
  await takeLog();
  // 宽度收窄 120px，等于把右栏拉开：重排让内容变高，底边被顶下去。
  await page.evaluate(() => {
    document.querySelector(".chat-scroll").style.paddingRight = "136px";
  });
  await sleep(800);
  const d1 = await geom();
  const log = await takeLog();
  check(
    "D 跟流中宽度重排（右栏开合）：仍然贴底",
    d1.gap <= 24 && d1.top >= d0.top,
    `before=${JSON.stringify(d0)} after=${JSON.stringify(d1)} 滚动日志=${JSON.stringify(log)}`,
  );
}

await browser.close();
await new Promise((r) => server.close(r));
const passed = results.every(Boolean);
console.log(`${passed ? "PASS" : "FAIL"}: 展开操作记录${passed ? "不" : "会"}动视口（${HEADED ? "真 Edge" : "headless"}）`);
process.exitCode = passed ? 0 : 1;
