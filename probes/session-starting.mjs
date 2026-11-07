/**
 * Probe: pi 正在启动的窗口期，消息照常能发 —— 气泡先带「正在启动 pi…」，交给 pi 之后变「处理中…」。
 *
 * 背景：`create` 不再等 pi 启动（D122），所以新会话会先出现、pi 还在起。D177 推翻了 D122 第 3 条
 * （「启动期输入框置灰、不让人打字」）：桥会把这段时间的消息收下、等 pi 就绪再交出去，所以界面这
 * 几秒里应当照常可用。这一页要钉住的是**气泡的两种状态**：
 *   1. 启动期：状态行仍是「pi 正在启动（加载扩展，通常几秒）…」、没有中断按钮，但输入框可用、
 *      placeholder 是平常那句；
 *   2. 发出去的这条立刻出现，带「正在启动 pi…」；每一页只有一份（乐观气泡按 clientId 认领）；
 *   3. 启动期撤回（#199）：Esc 与状态行右侧那颗「撤回」都把这批消息按发出顺序退回输入框
 *      （空行分隔）、气泡在两个标签页里同帧消失，且**不发 abort** —— pi 继续启动；
 *   4. `starting` 翻假 + 运行态为真 → 同一枚气泡变「处理中…」，本轮结束消失。
 *
 * #201 接上另外两个入口（同一个桩桥）：
 *   8. 启动期点「继续」不再是灰的，点下去发的就是「继续」两个字、气泡立刻出现；
 *   9. 磁盘上的只读会话（没有写权）：输入框照常可用，发出去的气泡不等自动接管的握手 ——
 *      页面这一侧只能验证「能打字、气泡即刻出现」，气泡先于握手广播由 `bridge/tests/boot-queue.mjs` 钉住。
 *
 * #202 的边界输入（同一套队列，不分叉）：
 *  10. 启动期贴图：`.row` 上的「+N 图」与平时同一颗，发出去的那条 prompt 带着图、气泡说「附 N 张图片」；
 *  11. 启动期贴一段代码：气泡的折叠渲染与平常一致、交出去的文字与气泡一字不差（缩进/制表符/行尾空格都在）；
 *  12. 启动期 `!命令`：不拒绝、不丢 —— 卡片先停在「等待 pi 启动…」，pi 起来后同一张卡片跑出输出；
 *  13. 只读会话自动接管的那几秒里敲 `!`：同样先排队、就绪后跑出输出（命令与草稿都不会静默消失）。
 *  14. 失败气泡的第二条路：点「退回输入框」→ `clearQueue`、文字回输入框、气泡消失（不是只能重试）。
 *
 * 桩桥照真桥的形状回 `item.add` / `item.replace`，不收 pi，所以这一秒钟级、可重复。
 *
 * Run: npm --prefix web run build && node probes/session-starting.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7915);
const OUT = path.join(REPO, ".scratch/session-starting/shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;
fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (cond, msg) => {
  if (cond) log("  ok  ", msg);
  else {
    failed += 1;
    console.error("  FAIL", msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* page not ready */
    }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const base = { id: "probe-starting", name: "启动中", cwd: CWD, file: null, owned: true, origin: "web", running: false, done: false, updatedAt: Date.now(), approvals: 0, asks: 0 };
const ITEMS = [{ kind: "user", id: "u1", ts: Date.now() - 60_000, text: "刚建好的会话" }];

/** 桥那份记录：启动期发出去的消息在这里躺着，第二个标签页 subscribe 时看到的也是它。 */
const items = [...ITEMS];

/** #201：磁盘上的只读会话（没在跑）。发消息 = 自动接管，但页面这边只关心「输入框能不能用、气泡来没来」。 */
const readonly = { ...base, id: "probe-readonly", name: "只读的", file: "probe/session.jsonl", owned: false, origin: "terminal" };
const readonlyItems = [{ kind: "user", id: "r1", ts: Date.now() - 120_000, text: "终端里聊过的" }];

/** 桩桥收到的每条 prompt：只用来断言「点下去真的发了」。 */
const prompts = [];

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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!(req.url ?? "").startsWith("/ws")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
/** 页面就是靠这条消息知道「pi 起来了没有」、以及这一轮在不在跑。 */
const broadcast = (payload) => {
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify(payload));
};
let userSeq = 1;
/** 页面发上来的命令：撤回要证明「发的是 clearQueue，不是 abort」。 */
const cmds = [];
/** 最近一次收下的那条，模拟桥把它交出去时补的那枚 `item.replace`（pending 翻 "sent"）。 */
let lastUser = null;
/** #202：启动窗口里收下的 `!` 命令（真桥放 `bootBash`），就绪时由 `flushBash` 补上 running → done。 */
let bashSeq = 0;
let pendingBash = [];
const flushBash = (sessionId) => {
  const due = pendingBash.filter((q) => q.sessionId === sessionId);
  pendingBash = pendingBash.filter((q) => q.sessionId !== sessionId);
  const arr = sessionId === readonly.id ? readonlyItems : items;
  for (const { item } of due) {
    const at = arr.findIndex((it) => it.id === item.id);
    const running = { ...item, status: "running" };
    if (at >= 0) arr[at] = running;
    broadcast({ type: "item.replace", sessionId, id: item.id, item: running });
    const done = { ...running, status: "done", output: `ran: ${item.command}
`, exitCode: 0 };
    if (at >= 0) arr[at] = done;
    broadcast({ type: "item.replace", sessionId, id: item.id, item: done });
  }
};
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const ro = msg.sessionId === readonly.id;
    cmds.push(msg);
    if (msg.type === "subscribe") {
      const state = ro ? { ...readonly, starting: false } : { ...base, starting: true };
      ws.send(JSON.stringify({ type: "session", sessionId: state.id, state, items: ro ? readonlyItems : items, approvals: [], asks: [], budget: null }));
      return;
    }
    if (msg.type === "prompt") {
      // 真桥在启动期做的事：立刻把 user item 落地并广播，item 上带 `pending: "booting"`，
      // 广播里带回 clientId —— 那一页据此认领自己的乐观气泡，别的页照常新画一条。
      // #201：只读会话那条也一样 —— 桥在拉起 pi 之前就把气泡广播出来（测试里由 boot-queue 钉住顺序）。
      const item = { id: `user:${++userSeq}`, kind: "user", text: String(msg.text ?? ""), images: (Array.isArray(msg.images) ? msg.images : []).map((i) => ({ mimeType: String(i?.mimeType ?? "") })), pending: "booting", ts: new Date().toISOString() };
      (ro ? readonlyItems : items).push(item);
      if (!ro) lastUser = item;
      prompts.push({ sessionId: ro ? readonly.id : base.id, text: String(msg.text ?? ""), images: item.images.map((i) => i.mimeType) });
      broadcast({ type: "item.add", sessionId: ro ? readonly.id : base.id, item, clientId: msg.clientId });
      return;
    }
    if (msg.type === "bash") {
      // #202 / D182：启动窗口里 `!` 不拒绝，桥先落一张 queued 卡片；就绪后再补 running / done。
      const sid = ro ? readonly.id : base.id;
      const item = {
        id: `bash:${++bashSeq}`,
        kind: "bash",
        command: String(msg.command ?? ""),
        output: "",
        excludeFromContext: msg.excludeFromContext === true,
        status: "queued",
        ts: new Date().toISOString(),
      };
      (ro ? readonlyItems : items).push(item);
      pendingBash.push({ sessionId: sid, item });
      broadcast({ type: "item.add", sessionId: sid, item });
      return;
    }
    if (msg.type === "clearQueue") {
      // 真桥的撤回：启动期收下的整批消息按发出顺序退回输入框，气泡同一帧删掉（#199）。
      // #200 / D182：失败项也能「退回输入框」，和还在桥里的那批一起退。
      const booting = items.filter((it) => it.pending === "booting" || it.pending === "failed");
      if (!booting.length) return;
      items.splice(0, items.length, ...items.filter((it) => it.pending !== "booting"));
      broadcast({ type: "queue.restore", sessionId: base.id, texts: booting.map((it) => it.text) });
      broadcast({ type: "item.remove", sessionId: base.id, ids: booting.map((it) => it.id) });
      return;
    }
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      me: ME,
      sessions: [{ ...base, starting: true }, { ...readonly, starting: false }],
      manage: { pin: [], order: [], archived: [] },
      trash: [],
      tunnel: TUNNEL,
    }),
  );
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "session card");
  await page.locator(".session-card").first().click();
  await until(async () => (await page.locator(".msg").count()) >= 1, 8000, "messages");

  // ---- 1. 启动中：状态行照旧说清楚，但输入框照常可用、没有中断按钮
  broadcast({ type: "session.state", session: { ...base, starting: true } });
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "starting hint");
  const hint = await page.locator(".hint-status").innerText();
  const box = page.locator(".composer textarea");
  check(hint.includes("pi 正在启动"), `状态行写的是启动中（「${hint.replace(/\s+/g, " ").trim()}」）`);
  check(hint.includes("加载扩展"), "状态行顺带解释了为什么慢（加载扩展）");
  check((await page.locator('.hint-status [data-act="interrupt"]').count()) === 0, "启动期状态行没有中断按钮（没东西可中断）");
  check(await box.isEnabled(), "输入框可用（D177 推翻了「启动期置灰」）");
  const placeholder = await box.getAttribute("placeholder");
  check(!String(placeholder).includes("正在启动"), `placeholder 是平常那句，不是「pi 正在启动…」（${placeholder}）`);
  await page.screenshot({ path: path.join(OUT, "1-starting.png") });

  // ---- 2. 启动窗口里连发两条：气泡立刻出现，带「正在启动 pi…」
  const TEXT_A = "启动期第一句";
  const TEXT_B = "启动期第二句";
  for (const text of [TEXT_A, TEXT_B]) {
    await box.fill(text);
    await box.press("Enter");
  }
  const bubbleA = page.locator(".msg.user", { hasText: TEXT_A });
  const bubbleB = page.locator(".msg.user", { hasText: TEXT_B });
  await until(async () => (await bubbleA.count()) >= 1 && (await bubbleB.count()) >= 1, 8000, "user bubbles");
  await until(async () => (await bubbleB.locator(".msg-pending").innerText().catch(() => "")).includes("正在启动 pi"), 8000, "booting badge");
  check((await bubbleA.count()) === 1 && (await bubbleB.count()) === 1, "两条各一份气泡（乐观那条按 clientId 认领了桥的广播）");
  check((await box.inputValue()) === "", "回车真的发出去了（输入框被清空）");
  check(!(await bubbleA.locator(".msg-pending").getAttribute("class"))?.includes("failed"), "启动中的徽标是「进行中」样式，不是报错");
  check((await page.locator(".notice, .msg.notice").count()) === 0, "没有错误提示");
  // #199: 有排队消息时状态行右侧多一颗「撤回」，Esc 是同一个动作。
  const withdrawBtn = page.locator(".hint-status button", { hasText: "撤回" });
  await until(async () => (await withdrawBtn.count()) >= 1, 8000, "withdraw button");
  check((await withdrawBtn.innerText()).includes("撤回"), "状态行给了「撤回」（启动期也有东西可退）");
  check((await page.locator('.hint-status [data-act="interrupt"]').count()) === 0, "它不是中断按钮（没有 data-act=interrupt）");
  await page.screenshot({ path: path.join(OUT, "2-booting.png") });

  // ---- 3. 另一个标签页看到的是同一份：一样的气泡、一样的说法
  const page2 = await context.newPage();
  page2.on("pageerror", (e) => log("page2 error:", e.message));
  await page2.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page2.locator(".session-card").count()) >= 1, 8000, "page2 session card");
  await page2.locator(".session-card").first().click();
  const bubbleA2 = page2.locator(".msg.user", { hasText: TEXT_A });
  const bubbleB2 = page2.locator(".msg.user", { hasText: TEXT_B });
  await until(async () => (await bubbleA2.count()) >= 1 && (await bubbleB2.count()) >= 1, 8000, "page2 bubbles");
  check((await bubbleA2.count()) === 1 && (await bubbleB2.count()) === 1, "第二个标签页也是各一份气泡");
  check((await bubbleB2.locator(".msg-pending").innerText()).includes("正在启动 pi"), "第二个标签页的说法一样（正在启动 pi…）");

  // ---- 4. Esc：两条按发出顺序回到输入框，两个标签页的气泡同帧消失，pi 的启动不受影响
  const beforeEsc = cmds.length;
  await box.focus();
  await box.press("Escape");
  await until(async () => (await box.inputValue()) === `${TEXT_A}

${TEXT_B}`, 8000, "esc restore");
  check(true, "Esc 把两条按发出顺序放回输入框，空行分隔");
  await until(async () => (await bubbleA.count()) === 0 && (await bubbleB.count()) === 0, 8000, "esc removes bubbles");
  check(true, "气泡跟着没了（不留下一条假的「已发送」）");
  await until(async () => (await bubbleA2.count()) === 0 && (await bubbleB2.count()) === 0, 8000, "page2 bubbles gone");
  check(true, "另一个标签页的气泡同步消失");
  const escCmds = cmds.slice(beforeEsc);
  check(escCmds.some((m) => m.type === "clearQueue"), "Esc 发的是撤回（clearQueue）");
  check(!escCmds.some((m) => m.type === "abort"), "Esc 撤回没有发 abort");
  check((await page.locator(".hint-status").innerText()).includes("正在启动"), "撤回之后 pi 继续启动，状态行照旧（不用二次等待）");
  check((await withdrawBtn.count()) === 0, "没有排队消息时「撤回」自己消失");
  await page.screenshot({ path: path.join(OUT, "3-withdrawn-esc.png") });

  // ---- 5. 状态行那颗「撤回」：和 Esc 等效（触屏、键盘失灵时用）
  const TEXT_C = "用按钮撤回的这一条";
  await box.fill(TEXT_C);
  await box.press("Enter");
  const bubbleC = page.locator(".msg.user", { hasText: TEXT_C });
  await until(async () => (await bubbleC.count()) >= 1, 8000, "button-path bubble");
  await until(async () => (await withdrawBtn.count()) >= 1, 8000, "withdraw button back");
  const beforeClick = cmds.length;
  await withdrawBtn.click();
  await until(async () => (await box.inputValue()) === TEXT_C, 8000, "button restore");
  check(true, "点「撤回」把这条放回输入框");
  await until(async () => (await bubbleC.count()) === 0, 8000, "button removes bubble");
  check(true, "气泡同步删掉");
  const clickCmds = cmds.slice(beforeClick);
  check(clickCmds.some((m) => m.type === "clearQueue") && !clickCmds.some((m) => m.type === "abort"), "按钮发的也是 clearQueue，不是 abort");
  check((await page.locator(".hint-status").innerText()).includes("正在启动"), "撤回完 pi 还在启动，不需要再等一次");
  await page.screenshot({ path: path.join(OUT, "4-withdrawn-button.png") });

  // ---- 6. pi 就绪、这一轮跑起来：同一枚徽标变「处理中…」
  // 桥把这条交给 pi 的时候先补一枚 item.replace（`booting` → `sent`），运行态随后才翻上来。
  const TEXT_D = "交给 pi 的那条";
  await box.fill(TEXT_D);
  await box.press("Enter");
  const bubbleD = page.locator(".msg.user", { hasText: TEXT_D });
  await until(async () => (await bubbleD.count()) >= 1, 8000, "sent-path bubble");
  check(lastUser?.text === TEXT_D, "桩桥确实收到了这条 prompt");
  broadcast({ type: "item.replace", sessionId: base.id, id: lastUser.id, item: { ...lastUser, pending: "sent" } });
  broadcast({ type: "session.state", session: { ...base, starting: false, running: true } });
  await until(async () => (await bubbleD.locator(".msg-pending").innerText().catch(() => "")).includes("处理中"), 8000, "running badge");
  check(true, "交给 pi 之后徽标变成「处理中…」");
  check((await page.locator(".hint-status").innerText()).includes("正在启动") === false, "状态行不再是启动文案");
  await page.screenshot({ path: path.join(OUT, "5-running.png") });

  // ---- 7. 本轮结束：徽标消失
  broadcast({ type: "session.state", session: { ...base, starting: false, running: false } });
  await until(async () => (await bubbleD.locator(".msg-pending").count()) === 0, 8000, "badge gone");
  check(true, "本轮结束之后徽标消失");
  await page.screenshot({ path: path.join(OUT, "6-done.png") });

  // ---- 8. #201 启动期的「继续」不再灰：它只是把「继续」两个字当一条消息发出去，和输入框同一个队列
  broadcast({ type: "session.state", session: { ...base, starting: true, running: false } });
  const continueBtn = page.locator(".continue-btn");
  await until(async () => (await continueBtn.count()) >= 1, 8000, "continue button");
  check(await continueBtn.isVisible(), "启动期「继续」露着（不是藏起来）");
  check(await continueBtn.isEnabled(), "启动期「继续」是亮的（D180：没理由比输入框更早解锁）");
  const why = String(await continueBtn.getAttribute("title"));
  check(!why.includes("正在启动"), `悬停提示不再说「启动完再继续」（${JSON.stringify(why)}）`);
  const beforeContinue = prompts.length;
  await continueBtn.click();
  await until(() => prompts.length > beforeContinue, 8000, "continue prompt");
  check(prompts.at(-1)?.text === "继续", `点下去发的就是「继续」这两个字（${JSON.stringify(prompts.at(-1)?.text)}）`);
  const continueBubble = page.locator(".msg.user", { hasText: "继续" });
  await until(async () => (await continueBubble.count()) >= 1, 8000, "continue bubble");
  check((await continueBubble.count()) === 1, "「继续」的气泡也立刻出现（只有一份）");
  check((await continueBubble.locator(".msg-pending").innerText().catch(() => "")).includes("正在启动 pi"), "「继续」的气泡也带「正在启动 pi…」");
  await page.screenshot({ path: path.join(OUT, "7-continue.png") });

  // ---- 9. #201 只读会话（磁盘上、没在跑）：输入框照常可用，发出去的气泡不等自动接管的握手
  await page.locator(".session-card", { hasText: "只读的" }).first().click();
  await until(async () => (await page.locator(".takeover.warn").innerText().catch(() => "")).includes("发消息会自动接管"), 8000, "readonly bar");
  const roBox = page.locator(".composer textarea");
  check(await roBox.isEnabled(), "只读会话的输入框可用");
  const ROTEXT = "只读会话里发的第一句";
  await roBox.fill(ROTEXT);
  await roBox.press("Enter");
  const roBubble = page.locator(".msg.user", { hasText: ROTEXT });
  await until(async () => (await roBubble.count()) >= 1, 8000, "readonly bubble");
  check((await roBubble.count()) === 1, "只读会话的气泡立刻出现（只有一份）");
  check((await roBubble.locator(".msg-pending").innerText().catch(() => "")).includes("正在启动 pi"), "只读会话的气泡同样带待发徽标");
  check(prompts.at(-1)?.sessionId === readonly.id, "发的是这个只读会话的 prompt");
  await page.screenshot({ path: path.join(OUT, "8-readonly.png") });

  // ---- 10. #202 启动期贴图：图跟着那条 prompt 一起走，气泡说「附 N 张图片」
  await page.locator(".session-card", { hasText: "启动中" }).first().click();
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "back to booting session");
  /** 贴两张图（canvas 生成，走页面里那条真实粘贴路径 —— 和平时贴图同一个入口）。 */
  const pasteImages = (colors) =>
    page.evaluate(async (colors) => {
      const dt = new DataTransfer();
      for (const color of colors) {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 200;
        const g = canvas.getContext("2d");
        g.fillStyle = color;
        g.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        dt.items.add(new File([blob], `${color}.png`, { type: "image/png" }));
      }
      document.querySelector(".composer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.files.length;
    }, colors);
  const imageBadge = page.locator(".composer .row .image-badge");
  check((await imageBadge.count()) === 0, "发之前手上没有待发图片");
  await pasteImages(["#c0392b", "#2980b9"]);
  await until(async () => (await imageBadge.count()) >= 1, 8000, "image badge");
  check((await imageBadge.innerText()).includes("2"), `启动期贴两张图，徽标是「${(await imageBadge.innerText()).trim()}」（和平时同一颗）`);
  const IMG_TEXT = "这两张图是启动期配上去的";
  await box.fill(IMG_TEXT);
  await box.press("Enter");
  await until(async () => prompts.length > 0 && prompts.at(-1)?.text === IMG_TEXT, 8000, "image prompt");
  check(prompts.at(-1).images.length === 2 && prompts.at(-1).images.every((m) => String(m).startsWith("image/")), `交出去的那条 prompt 还带着两张图（${JSON.stringify(prompts.at(-1).images)}）`);
  const imgBubble = page.locator(".msg.user", { hasText: IMG_TEXT });
  await until(async () => (await imgBubble.count()) >= 1, 8000, "image bubble");
  // 乐观气泡先到，带图的桥 item 随后才认领它（adopt），所以「附 N 张图片」得等。
  await until(async () => (await imgBubble.innerText()).includes("附 2 张图片"), 8000, "images notice");
  check((await imgBubble.innerText()).includes("附 2 张图片"), "气泡照常标了「附 2 张图片」");
  check((await imgBubble.locator(".msg-pending").innerText().catch(() => "")).includes("正在启动 pi"), "带图的气泡也带「正在启动 pi…」");
  await until(async () => (await imageBadge.count()) === 0, 8000, "badge cleared");
  check(true, "发出去之后待发图片清空（图已经跟着消息走了）");
  await page.screenshot({ path: path.join(OUT, "9-images.png") });

  // ---- 11. #202 启动期贴一段代码：气泡的折叠渲染与平时一致，交出去的一字不差
  const PASTED = [
    "```ts",
    "export function pumpBootQueue(rpc: Rpc) {",
    "    if (!rpc.alive) return;",
    "    while (this.bootQueue.length) {",
    "\tconst next = this.bootQueue.shift()!;",
    '        if (!next) break;',
    '        const message: any = { type: "prompt", message: next.text };',
    "        if (this.state.running) message.streamingBehavior = next.behavior;",
    "        if (next.images?.length) message.images = next.images;",
    '        this.emitWs({ type: "item.replace", id: next.id, pending: "sent" });',
    "    }",
    "    // 行尾留两个空格  ",
    "    return;",
    "}",
    "```",
    "",
    "/* 下面是贴进来的第二段：",
    "   - 第一项",
    "   - 第二项",
    "   - 第三项",
    "*/",
    "const tail = '制表符\t在这里';",
    "console.log(tail);",
    "// 收尾",
  ].join("\n");
  const TYPED = "这段是接着打的";
  const PASTE_TEXT = `${PASTED}\n\n${TYPED}`;
  const pasteText = (text) =>
    page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      document.querySelector(".composer textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  await pasteText(PASTED);
  await until(async () => (await page.locator(".composer .paste-block").count()) >= 1, 8000, "paste block");
  check((await page.locator(".composer .paste-block").innerText()).includes("粘贴的内容"), "大段粘贴进了「粘贴的内容」块（和平时一样）");
  await box.fill(TYPED);
  await box.press("Enter");
  await until(async () => prompts.at(-1)?.text === PASTE_TEXT, 8000, "paste prompt");
  check(true, "交出去的是粘贴块原文 + 空行 + 打的字（一个字没动）");
  check(prompts.at(-1).text.includes("\tconst next") && prompts.at(-1).text.includes("行尾留两个空格  \n"), "缩进、制表符、行尾空格都还在");
  const pasteBubble = page.locator(".msg.user", { hasText: "这段是接着打的" });
  await until(async () => (await pasteBubble.count()) >= 1, 8000, "paste bubble");
  const bootBody = await pasteBubble.locator(".fold-body .body").first().evaluate((n) => n.textContent ?? "");
  check(bootBody === PASTE_TEXT, `气泡里的字与交出去的一致（${bootBody.length} 字 / ${PASTE_TEXT.length}）`);
  const bootFold = await pasteBubble.locator(".foldable").first().getAttribute("class");
  check(String(bootFold).includes("has-fold"), `长气泡带折叠（${bootFold}）`);
  await page.screenshot({ path: path.join(OUT, "10-paste.png") });

  // ---- 12. #202 启动期 `!命令`：不拦、不丢 —— 卡片先进「等待 pi 启动…」，就绪后同一张卡片跑出输出
  broadcast({ type: "session.state", session: { ...base, starting: true, running: false } });
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "booting again");
  const BOOT_CMD = "echo 启动期排队的命令";
  const beforeBash = cmds.length;
  await box.fill(`!${BOOT_CMD}`);
  await box.press("Enter");
  await until(() => cmds.slice(beforeBash).some((m) => m.type === "bash"), 4000, "bash frame in boot window");
  const bootBashFrame = cmds.slice(beforeBash).find((m) => m.type === "bash");
  check(bootBashFrame?.command === BOOT_CMD && bootBashFrame?.excludeFromContext === false, "`!` 照发（`!` 仍进上下文），没有在页面上被拦下");
  const bootBashCard = page.locator(".msg.bash", { hasText: BOOT_CMD });
  await until(async () => (await bootBashCard.count()) >= 1, 8000, "queued bash card");
  check((await bootBashCard.locator(".bash-state").innerText()).includes("等待 pi 启动"), `卡片说清在等谁（「${(await bootBashCard.locator(".bash-state").innerText()).trim()}」）`);
  check((await bootBashCard.locator(".act-spin").count()) === 1, "排队的卡片带那枚小转环（复用启动提示的视觉）");
  check((await box.inputValue()) === "", "命令已经被收下，草稿清空 —— 不是「清掉了却没跑」");
  check(!(await page.locator(".notice, .msg.notice").allInnerTexts()).some((t) => t.includes("还在启动")), "没有「还在启动」之类的拒绝");
  await page.screenshot({ path: path.join(OUT, "11-bash-queued.png") });

  broadcast({ type: "session.state", session: { ...base, starting: false, running: false } });
  flushBash(base.id);
  await until(async () => (await bootBashCard.locator(".bash-out").innerText()).includes(`ran: ${BOOT_CMD}`), 8000, "bash output after ready");
  check((await page.locator(".msg.bash", { hasText: BOOT_CMD }).count()) === 1, "只画了一张卡片（就绪后没有补第二张）");
  check(String(await bootBashCard.getAttribute("class")).includes("done"), "同一张卡片从 queued 走到 done");
  check((await bootBashCard.locator(".act-spin").count()) === 0, "跑完之后转环没了");
  await page.screenshot({ path: path.join(OUT, "11b-bash-done.png") });

  // 折叠渲染不分启动期/平时：同一段文字两边长成同一个样子（同一个 `foldable` 量高逻辑）。
  await box.fill(PASTE_TEXT);
  await box.press("Enter");
  await until(async () => (await page.locator(".msg.user", { hasText: TYPED }).count()) === 2, 8000, "calm bubble");
  const calmBubble = page.locator(".msg.user", { hasText: TYPED }).nth(1);
  // 折叠是量完高才挂上的（`requestAnimationFrame(measure)`），刚画出来那一帧还没有。
  await until(async () => String(await calmBubble.locator(".foldable").first().getAttribute("class")).includes("has-fold"), 8000, "calm fold");
  const calmFold = await calmBubble.locator(".foldable").first().getAttribute("class");
  check(calmFold === bootFold, `平时那条的折叠与启动期一模一样（${calmFold}）`);
  const bootFoldLabel = await pasteBubble.locator(".fold-label").first().innerText();
  const calmFoldLabel = await calmBubble.locator(".fold-label").first().innerText();
  check(bootFoldLabel === calmFoldLabel, `折叠按钮的说法也一样（「${calmFoldLabel}」）`);

  // ---- 13. #202 只读会话启动期的 `!`：拉起 pi 的窗口里卡片排队，pi 起来后跑出输出（草稿不丢）
  await page.locator(".session-card", { hasText: "只读的" }).first().click();
  broadcast({ type: "session.state", session: { ...readonly, starting: true, running: false } });
  await until(async () => (await page.locator(".hint-status").innerText().catch(() => "")).includes("正在启动"), 8000, "readonly booting");
  const roBox2 = page.locator(".composer textarea");
  const RO_CMD = "echo hi";
  const beforeRoBash = cmds.length;
  await roBox2.fill(`!${RO_CMD}`);
  await roBox2.press("Enter");
  await until(() => cmds.slice(beforeRoBash).some((m) => m.type === "bash" && m.sessionId === readonly.id), 4000, "readonly bash frame");
  check(cmds.slice(beforeRoBash).find((m) => m.type === "bash")?.command === RO_CMD, "只读会话的第一条 `!` 也照发");
  const roBashCard = page.locator(".msg.bash", { hasText: RO_CMD });
  await until(async () => (await roBashCard.count()) >= 1, 8000, "readonly queued bash card");
  check((await roBashCard.locator(".bash-state").innerText()).includes("等待 pi 启动"), "自动接管的窗口里卡片停在「等待 pi 启动…」");
  check((await roBashCard.locator(".act-spin").count()) === 1, "同样带那枚小转环");
  check((await roBox2.inputValue()) === "", "命令交出去了，草稿清空（不是被拒后丢掉）");
  check(!(await page.locator(".notice, .msg.notice").allInnerTexts()).some((t) => t.includes("还在启动")), "没有拒绝通知");
  await page.screenshot({ path: path.join(OUT, "12-readonly-bash-queued.png") });

  broadcast({ type: "session.state", session: { ...readonly, starting: false, running: false } });
  flushBash(readonly.id);
  await until(async () => (await roBashCard.locator(".bash-out").innerText()).includes(`ran: ${RO_CMD}`), 8000, "readonly bash output");
  check(true, "pi 起来之后只读会话的 `!` 也跑出了输出（没有丢草稿，也没有丢命令）");
  await page.screenshot({ path: path.join(OUT, "12b-readonly-bash-done.png") });

  // ---- 14. #200 / D182 失败气泡的第二条路：不重试，退回输入框
  await page.locator(".session-card", { hasText: "启动中" }).first().click();
  // 切会话是异步的：不等它切回来就 fill/Enter，键会落到刚刚那个只读会话里（探针偶发超时就是这么来的）。
  // 判据用占位符 —— 还在启动的会话占位符写着「pi 正在启动…」，切回来了才是平时那句。
  await until(
    async () => !String((await box.getAttribute("placeholder")) ?? "").includes("正在启动"),
    8000,
    "back to the calm session",
  );
  const FAILED_TEXT = "这条没发出去，要退回输入框";
  const beforeFailed = prompts.length;
  await box.fill(FAILED_TEXT);
  await box.press("Enter");
  await until(() => prompts.length > beforeFailed, 4000, "failed prompt landed");
  const failedItem = items.find((it) => it.text === FAILED_TEXT);
  broadcast({ type: "item.replace", sessionId: base.id, id: failedItem.id, item: { ...failedItem, pending: "failed" } });
  const failedBubble = page.locator(".msg.user", { hasText: FAILED_TEXT });
  await until(async () => (await failedBubble.locator(".msg-pending").innerText().catch(() => "")).includes("没发出去"), 8000, "failed badge");
  const backBtn = failedBubble.locator("button.msg-retry", { hasText: "退回输入框" });
  check((await backBtn.count()) === 1, "失败徽标旁有「退回输入框」这颗按钮");
  const beforeBack = cmds.length;
  await backBtn.click();
  await until(() => cmds.slice(beforeBack).some((m) => m.type === "clearQueue" && m.sessionId === base.id), 4000, "clearQueue from failed bubble");
  check(true, "点它发的是 clearQueue（和撤回同一条路，不是重试）");
  await until(async () => (await failedBubble.count()) === 0, 8000, "failed bubble gone");
  const backDraft = String(await box.inputValue());
  check(backDraft.endsWith(FAILED_TEXT), "失败那条的文字按序并入输入框（接在原有草稿后面）");
  check((await page.locator(".msg-pending").allInnerTexts()).every((t) => !t.includes("没发出去")), "失败徽标跟着气泡一起消失");
  await page.screenshot({ path: path.join(OUT, "13-failed-withdrawn.png") });
} catch (err) {
  failed += 1;
  console.error("ERROR", err?.message ?? err);
} finally {
  await browser?.close();
  server.close();
}
log(failed ? `FAILED (${failed})` : "all checks passed");
process.exit(failed ? 1 : 0);
