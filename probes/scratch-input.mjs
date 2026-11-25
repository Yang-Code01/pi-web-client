/**
 * Probe: 「随手问」的输入框与聊天区同一个盒子（D410）。
 *
 * 用替身桥（只 serve `web/dist` + 说足够几句 ws）驱动真 Chromium：高度、折块、拼发送、被挡时的
 * 提示、页面级粘贴归属，这几件事都只在真浏览器里量得准。
 *
 * 检查：空框一行高；打 8 行会长高且封顶在 38% 视口（不顶出 dialog）；粘 12 行折成一块且框回到一行；
 * Enter 发出的 body 是「折块原文 + 空行 + 手打的字」；回显后框清空、折块消失；running 时 Enter 不发、
 * 在 📎 那行闪原因且 3 秒内消失；dialog 开着时在框外粘贴归随手问；字号 150% 时底行仍在视口里
 *（输入框上限只乘一次 zoom）。
 *
 * Run: node probes/scratch-input.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, DIST, wsWrapper } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
import { freePort } from "./port.mjs";

const { chromium } = await loadPlaywright();
const wsMod = await import(pathToFileURL(wsWrapper()).href);
const { WebSocketServer } = wsMod;

const PORT = await freePort(Number(process.env.PI_WEB_PORT ?? 7947));
const OUT = path.join(REPO, ".scratch/scratch-input/shots");
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
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

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const SESSION = { id: "probe-chat", name: "主会话", cwd: REPO, file: null, owned: true, origin: "disk", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "输入框探针" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };

let sock = null;
/** 随手问的桥侧状态：`/__probe/running?on=1` 这类开关改它，再推一帧 `scratch` 让页面跟上。 */
const scratch = { id: "probe-scratch", running: false, paused: false };
const prompts = [];
const send = (msg) => (sock?.readyState === 1 ? sock.send(JSON.stringify(msg)) : false);
const scratchFrame = () =>
  send({
    type: "scratch",
    sessionId: scratch.id,
    state: { running: scratch.running, paused: scratch.paused, model: "pi", modelName: "pi", thinkingLevel: "off" },
    items: [],
  });

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname.startsWith("/__probe/")) {
    const on = url.searchParams.get("on") === "1";
    if (url.pathname === "/__probe/running") scratch.running = on;
    if (url.pathname === "/__probe/paused") scratch.paused = on;
    scratchFrame();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(scratch));
  }
  if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/api/login" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "pwc=probe; Path=/; HttpOnly; SameSite=Lax" });
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/api/me") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ME));
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
      ws.send(JSON.stringify({ type: "session", sessionId: SESSION.id, state: SESSION, items: [], approvals: [], asks: [], budget: null }));
    }
    if (msg.type === "scratch.open") {
      // 开一个新随手问：清掉上一轮的状态，页面上看到的是一问一答的干净起点。
      scratch.running = false;
      scratch.paused = false;
      scratchFrame();
    }
    if (msg.type === "prompt") {
      prompts.push(msg);
      ws.send(JSON.stringify({ type: "ack", sessionId: msg.sessionId, clientId: msg.clientId }));
      // 回显：客户端按 clientId 配这一条，然后清掉已发出的文字与折块。
      ws.send(
        JSON.stringify({
          type: "item.add",
          sessionId: msg.sessionId,
          clientId: msg.clientId,
          item: { kind: "user", id: `u-${prompts.length}`, ts: Date.now(), text: msg.text },
        }),
      );
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [SESSION], manage: { pin: [], order: [], archived: [] }, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("stub bridge on", BASE);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const open = async () => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  // 字号钉在 100%，后面单独测 150%。
  await page.evaluate(() => localStorage.setItem("pi.prefs", JSON.stringify({ scale: 1 })));
  await page.reload({ waitUntil: "networkidle" });
  if ((await page.locator(".session-card").count()) === 0) await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await page.locator(".icon-btn.wide", { hasText: "随手问" }).first().click();
  await until(async () => (await page.locator(".scratch-sheet textarea.sc-input").count()) === 1, 8000, "scratch input");
};

const field = page.locator(".scratch-sheet textarea.sc-input");
const layout = () =>
  page.evaluate(() => {
    const input = document.querySelector(".scratch-sheet textarea.sc-input");
    const sheet = document.querySelector(".scratch-sheet");
    const r = input.getBoundingClientRect();
    const s = sheet.getBoundingClientRect();
    return {
      rows: input.rows,
      box: r.height / (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1),
      visual: r.height,
      inputBottom: r.bottom,
      sheetBottom: s.bottom,
      viewport: innerHeight,
      cap: parseFloat(getComputedStyle(input).maxHeight),
      fade: input.classList.contains("has-hidden-top"),
    };
  });

/** 一行字 + padding + 1px 边框 ≈ 38px：一行高的盒子不该超过它太多。 */
const ONE_ROW = 44;

const lines = (n, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n");
/** 真剪贴板事件：Chromium 里 ClipboardEvent 能用 DataTransfer 构造，走的是 element 的 onpaste。 */
const pasteAt = (selector, text) =>
  page.evaluate(
    ([sel, text]) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const target = sel === "body" ? document.body : document.querySelector(sel);
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [selector, text],
  );

try {
  await open();
  await page.screenshot({ path: path.join(OUT, "1-open.png") });

  // 1. 空框一行：rows=1，高度接近一行字（不该再是 84px 的三行盒）。
  const empty = await layout();
  assert(empty.rows === 1, `空框 rows 是 1（${empty.rows}）`);
  assert(empty.box > 10 && empty.box <= ONE_ROW, `空框只有一行高（${empty.box.toFixed(1)}px）`);
  assert(empty.sheetBottom <= empty.viewport + 1, `dialog 没伸出视口（${empty.sheetBottom.toFixed(0)} ≤ ${empty.viewport}）`);

  // 2. 打 8 行：长高、封顶在 38% 视口，且 dialog 仍在屏幕里。
  await field.fill(lines(8));
  await sleep(120);
  const grown = await layout();
  assert(grown.box > empty.box + 40, `8 行比空框高（${grown.box.toFixed(1)} > ${empty.box.toFixed(1)}）`);
  assert(grown.box <= grown.cap + 2, `没越过 CSS 上限（${grown.box.toFixed(1)} ≤ ${grown.cap.toFixed(1)}）`);
  assert(grown.sheetBottom <= grown.viewport + 1, `长高后 dialog 还在视口里（${grown.sheetBottom.toFixed(0)} ≤ ${grown.viewport}）`);
  await page.screenshot({ path: path.join(OUT, "2-grown.png") });

  // 3. 粘 12 行：折成一块，框收回一行；折块摘要里有行数。
  await field.fill("");
  await sleep(80);
  const pasted = lines(12, "粘贴行");
  await pasteAt(".scratch-sheet textarea.sc-input", pasted);
  await until(async () => (await page.locator(".scratch-sheet .paste-block").count()) === 1, 4000, "folded paste block");
  const meta = (await page.locator(".scratch-sheet .paste-meta").first().textContent()) ?? "";
  assert(/12\s*行/.test(meta), `折块写着 12 行（"${meta}"）`);
  const folded = await layout();
  assert(folded.box <= ONE_ROW, `折起来后框回到一行（${folded.box.toFixed(1)}px）`);
  await page.screenshot({ path: path.join(OUT, "3-folded.png") });

  // 4. 手打一句 + Enter：发出的 body 是「折块原文 + 空行 + 手打的字」，回显后清干净。
  await field.fill("尾巴");
  await field.press("Enter");
  await until(async () => prompts.length === 1, 4000, "the prompt");
  assert(prompts[0].text === `${pasted}\n\n尾巴`, `拼起来发：${JSON.stringify(prompts[0].text.slice(0, 60))}…`);
  await until(async () => (await page.locator(".scratch-sheet .paste-block").count()) === 0, 4000, "fold cleared on echo");
  await sleep(80);
  assert((await field.inputValue()) === "", "回显后输入框清空");
  const afterEcho = await layout();
  assert(afterEcho.box <= ONE_ROW, `回显后回到一行（${afterEcho.box.toFixed(1)}px）`);
  await page.screenshot({ path: path.join(OUT, "4-sent.png") });

  // 5. 跑着时按 Enter：不发，在 📎 那一行闪原因，3 秒内自己消失。
  await fetch(`${BASE}/__probe/running?on=1`);
  await until(async () => (await field.getAttribute("placeholder"))?.includes("跑着呢") === true, 4000, "running placeholder");
  const placeholder = await field.getAttribute("placeholder");
  assert(placeholder?.includes("Shift+Enter"), `跑着时的占位也说了换行键（"${placeholder}"）`);
  await field.fill("这条应该发不出去");
  await field.press("Enter");
  await sleep(150);
  assert(prompts.length === 1, `跑着时没有新 prompt（${prompts.length}）`);
  const hint = (await page.locator(".scratch-sheet .sc-hint.blocked").textContent()) ?? "";
  assert(hint.includes("跑着呢"), `提示说了原因（"${hint}"）`);
  assert((await field.inputValue()).includes("发不出去"), "被挡的文字留在框里，没吃掉");
  await page.screenshot({ path: path.join(OUT, "5-blocked.png") });
  await until(async () => (await page.locator(".scratch-sheet .sc-hint.blocked").count()) === 0, 3500, "hint fades");
  await fetch(`${BASE}/__probe/running?on=0`);

  // 6. dialog 开着、焦点在 page body：粘贴归随手问（不再漏进背后那个看不见的会话）。
  await field.fill("");
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await page.locator(".scratch-sheet .scratch-title, .scratch-sheet .sheet-title").first().click().catch(() => {});
  await pasteAt("body", lines(9, "框外粘贴"));
  await until(async () => (await page.locator(".scratch-sheet .paste-block").count()) === 1, 4000, "outer paste lands in scratch");
  await page.screenshot({ path: path.join(OUT, "6-outer-paste.png") });

  // 7. 关掉 dialog 再粘：归主输入框（随手问的块不涨）。
  await page.locator(".scratch-sheet .scratch-close").click();
  await until(async () => (await page.locator(".scratch-sheet").isVisible()) === false, 4000, "dialog closed");
  // 纯文字的大段粘贴在聊天区是 textarea 自己的 onpaste 接的（框外的 window 监听只管文件），
  // 所以这里往它的框里派事件 —— 关掉随手问之后，折块要回到聊天区这边。
  await pasteAt(".composer textarea", lines(9, "主输入框"));
  await until(async () => (await page.locator(".composer .paste-block").count()) === 1, 4000, "main composer fold");
  // 第 6 段留在随手问里的那一个还在（对话框只是隐藏，草稿按设计保留），绝不能多出第二个。
  assert((await page.locator(".scratch-sheet .paste-block").count()) === 1, "随手问的折块没跟着涨");
  await page.screenshot({ path: path.join(OUT, "7-main-composer.png") });

  // 8. 字号 150%：底行还在视口里，输入框上限只乘一次（视觉 = layout × 1.5）。
  await open();
  await page.evaluate(() => localStorage.setItem("pi.prefs", JSON.stringify({ scale: 1.5 })));
  await page.reload({ waitUntil: "networkidle" });
  // 刷新后当前会话还在的话直接就是对话页，会话卡在侧栏里、不一定可见：有卡且可见才点。
  const card = page.locator(".session-card").first();
  if ((await card.count()) > 0 && (await card.isVisible())) await card.click();
  await until(async () => (await page.locator(".icon-btn.wide", { hasText: "随手问" }).count()) >= 1, 8000, "the scratch button at 150%");
  await page.locator(".icon-btn.wide", { hasText: "随手问" }).first().click();
  await until(async () => (await field.count()) === 1, 8000, "scratch input at 150%");
  await field.fill(lines(20));
  await sleep(150);
  const zoomed = await page.evaluate(() => {
    const input = document.querySelector(".scratch-sheet textarea.sc-input");
    const sheet = document.querySelector(".scratch-sheet");
    const r = input.getBoundingClientRect();
    return {
      scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1,
      visual: r.height,
      layout: parseFloat(getComputedStyle(input).maxHeight),
      sheetBottom: sheet.getBoundingClientRect().bottom,
      viewport: innerHeight,
    };
  });
  assert(Math.abs(zoomed.scale - 1.5) < 0.001, `字号真是 150%（${zoomed.scale}）`);
  assert(zoomed.visual <= zoomed.layout * zoomed.scale + 3, `上限只乘一次（视觉 ${zoomed.visual.toFixed(0)} ≤ ${(zoomed.layout * zoomed.scale).toFixed(0)}）`);
  assert(zoomed.visual < zoomed.layout * zoomed.scale * 1.5 - 10, `没有被乘两次（${zoomed.visual.toFixed(0)}）`);
  assert(zoomed.sheetBottom <= zoomed.viewport + 1, `150% 时底行还在视口里（${zoomed.sheetBottom.toFixed(0)} ≤ ${zoomed.viewport}）`);
  await page.screenshot({ path: path.join(OUT, "8-zoom-150.png") });

  assert(errors.length === 0, `没有页面异常（${errors.join(" | ")}）`);
  log("all checks passed; shots in", OUT);
} finally {
  await context.close();
  await browser.close();
  server.close();
  await new Promise((r) => wss.close(r));
}
