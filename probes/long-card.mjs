/**
 * Probe: D421 — 超长的一轮消息先收成摘要卡，点开在卡里铺开。
 *
 * 种一条会话：40 行用户消息 + 一句短消息 + 30 行助手回答 + 一张输出很长的工具卡。
 * 检查：
 *   1. 默认（只开「长用户消息」）：长的那条是 `.lm-card.has-card` 且卡在 96px，短的那条没有卡、
 *      气泡仍然一行宽、贴着右边（D423：没成卡时那层壳不许把气泡挤窄）；
 *   2. 点卡头展开到 `42vh` 内滚，点卡底「收起」回到 96px；
 *   3. 默认关着的那两档走老路：助手回答还是右上角的 `.msg-fold`，工具输出还是 `.tool .out` 260px；
 *   4. 偏好里把两档打开、刷新页面：助手与工具输出也都成卡；
 *   5. 设置抽屉「对话」一节里三行开关都在，点一下当场重画（不用重开会话）；
 *   6. 现发一条长消息：桥回填（adopt）之后它仍然是卡。
 *   7. 用户报的那一条（999 字、5 段、2K 宽屏上铺不到 240px）也要成卡：高度量不出来时靠原文长度。
 *
 * Run: node probes/long-card.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const PORT = Number(process.env.PI_WEB_PORT ?? 7896);
const ROOT = path.join(REPO, ".scratch/long-card");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const SESSIONS = path.join(AGENT, "sessions");
const OUT = path.join(ROOT, "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = REPO;

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [STATE, SESSIONS, OUT]) fs.mkdirSync(d, { recursive: true });

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
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${what}`);
};

// ---------------------------------------------------------------- 种会话
const id = "zz-longcard-0";
const dir = path.join(SESSIONS, `--${id}--`);
fs.mkdirSync(dir, { recursive: true });
const at = new Date(Date.now() - 600_000).toISOString();
const longText = Array.from(
  { length: 40 },
  (_, i) => `第 ${i + 1} 行：这是一段粘贴进来的长文，用来确认它先收成一张卡片、点开才铺满聊天区。`,
).join("\n");
const shortText = "短问题：这个不该出现卡片。";
const longAnswer = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：助手的长回答，默认还是走右上角那颗折叠钮。`).join("\n");
const toolOut = Array.from({ length: 40 }, (_, i) => `[out ${String(i + 1).padStart(2, "0")}] lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join("\n");
// 带图的消息照样可以很长（长文 + 一张图）：这一条用来确认「带图不收卡」—— 卡里只露三行正文，图会被藏到卡后面。
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
// 用户报的那一条：999 字、只分 5 段，**没有一行代码**。在 2K 屏上它铺不到 240px、
// 按高度量不进卡，可用户就是觉得「输入过多」（2026-11-26 截图）。靠原文长度那道尺子收。
const wideText = [
  "冲刺 + 提分。结合开课参数里的数学公式规范，先把这一讲的例题链摆出来：从一元二次方程的判别式一路推到抛物线与直线的交点，再到参数区间的边界讨论。学生最容易卡住的地方不是公式本身，而是「什么时候该分类、分几类」，所以例题必须一层一层递进，每一层只加一个变量。",
  "再说讲义：每一讲的目标要写成可验收的三句话，第一句是知识（能说出什么），第二句是方法（遇到什么题用什么套路），第三句是自查（做错了怎么自己发现）。这三句如果写不出来，这节课大概还没想清楚。",
  "时间安排上，前二十分钟只讲一件事，中间十五分钟给两道阶梯题，最后留十分钟做错题重做与口头复盘。不要在一节课里塞三种方法，学生会把方法记串；宁可少讲一个，也要让他在课堂上完整地做对一次。",
  "数据方面：每个学生的错题都要回到「是哪一层分类没分出来」，不要只记「这道题错了」。一个知识点记三行、一行一个错因，两周后回看就知道该补哪一层。",
  "最后是批改口径：公式对不对只是第一道，符号、单位以及「代入之前先说清楚变量是什么」这三样才是丢分大头。所以批改时先把这三样圈出来，再谈思路。整段的说法要统一，避免同一节课里换三种叫法。",
].join("\n");

// 更短的一档（4 段 ~650 字）：宽栏里只铺 ~180px，按高度绝不会收成卡 —— 只有靠原文长度才救得回来。
const wideMid = [
  "这一讲的例题链从判别式推起：先把 D 的正负与根的个数对上，再回到图像上找交点。学生最容易卡住的地方不是公式，而是「什么时候该分类、分几类」，所以每一层只加一个变量，讲完一层立刻让他自己判断一次，错在哪里当场点出来，别留到下课。",
  "讲义的目标要写成可验收的三句话：能说出什么、遇到什么题用什么套路、做错了怎么自己发现。三句写不出来，说明这节课还没想清楚，先把这三句补完再排时间，也不要急着加题量；题量是最后加的，不是先加的（先写这三句，再写讲义）。",
  "时间安排上，前二十分钟只讲一件事，中间十五分钟给两道阶梯题，最后留十分钟做错题重做与口头复盘。一节课塞三种方法学生一定会记串，宁可少讲一个，也要让他在课堂上完整地做对一次，做的过程比听的过程重要。",
  "批改口径也要统一：公式对不对只是第一道，符号、单位、有没有先把变量说清楚，才是丢分大头。先把这三样圈出来，再谈思路；同一个知识点叫法要一致，别让他在两个名字之间猜，猜两次就不敢写了 —— 这是最省事的统一办法。",
].join("\n");

const rows = [
  { type: "session", version: 3, id, timestamp: at, cwd: CWD },
  { type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: longText }] } },
  { type: "message", id: "m2", parentId: "m1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: longAnswer }] } },
  { type: "message", id: "m3", parentId: "m2", timestamp: at, message: { role: "user", content: [{ type: "text", text: shortText }] } },
  {
    type: "message",
    id: "m4",
    parentId: "m3",
    timestamp: at,
    message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "seq 1 40" } }] },
  },
  {
    type: "message",
    id: "m5",
    parentId: "m4",
    timestamp: at,
    message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: toolOut }] },
  },
  {
    type: "message",
    id: "m6",
    parentId: "m5",
    timestamp: at,
    message: {
      role: "user",
      content: [
        { type: "text", text: longText },
        { type: "image", data: PIXEL.split(",")[1], mimeType: "image/png" },
      ],
    },
  },
  { type: "message", id: "m7", parentId: "m6", timestamp: at, message: { role: "user", content: [{ type: "text", text: wideText }] } },
  { type: "message", id: "m8", parentId: "m7", timestamp: at, message: { role: "user", content: [{ type: "text", text: wideMid }] } },
  { type: "session_info", id: "n1", parentId: "m8", timestamp: at, name: "长卡片" },
];
fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------------------------------------------------------------- 起丢弃式 bridge
// 从 pi 会话里跑探针时，自己的那套 PI_* 环境变量（PI_HOST_LINK 指向正在跑的壳、
// PI_WEB_LOOPBACK_TOKEN 的令牌…）会被子进程继承，新 bridge 一启动就去敲 7864 的壳、然后超时。
// 所以先清干净，再只塞本探针要的那几个。
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PI_/i.test(k)));
// 第 7 节要真发一条消息：PI_BIN 指到 bridge 测试用的假 pi（它把原话 echo 回来），不花模型钱。
const { resolvePi } = await import(pathToFileURL(path.join(REPO, "bridge/dist/pi.js")).href);
const piPkg = path.dirname(path.dirname(path.dirname(resolvePi().cli)));
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: {
    ...cleanEnv,
    PI_WEB_PORT: String(PORT),
    PI_PEER_PORT: String(PORT + 1),
    PI_WEB_STATE: STATE,
    PI_WEB_TUNNEL: "0",
    PI_AGENT_DIR: AGENT,
    PI_BIN: path.join(REPO, "bridge/tests/fixtures/fake-pi.mjs"),
    PI_WEB_PI_PKG: piPkg,
    FAKE_PI_LOG: path.join(OUT, "fake-pi.jsonl"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
bridge.stdout.on("data", (b) => process.stdout.write(`[bridge] ${b}`));
bridge.stderr.on("data", (b) => process.stderr.write(`[bridge] ${b}`));

let browser;
try {
  await until(
    async () => {
      try {
        return (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
      } catch {
        return false;
      }
    },
    // 这台机器同时跑着正式实例、测试实例和几个 tsserver，起一个 bridge 到能应答 healthz 实测要 30s+。
    90000,
    "bridge",
  );
  const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert(res.ok && cookie.includes("="), `login worked (got ${res.status})`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: "zh-CN" });
  await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }]);
  const page = await context.newPage();
if (process.env.LC_CONSOLE) page.on("console", (m) => { const t = m.text(); if (t.includes("[probe]")) console.log("PAGE:", t); });
  page.on("pageerror", (e) => log("page error:", e.message));
  const open = async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await sleep(300);
    await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "card");
    await page.locator(".session-card").first().click();
    await until(async () => (await page.locator(".msg.user").count()) === 5, 10000, "3 user messages");
    // 这一轮的工具调用默认收在 `<details class="ops">` 里（关着时高度是 0，量不出卡片），先展开。
    const ops = page.locator("details.ops").first();
    if ((await ops.count()) === 1) {
      const summary = ops.locator("summary").first();
      if ((await summary.count()) === 1 && !(await ops.evaluate((el) => el.open))) await summary.click();
    }
    await until(async () => (await page.locator(".tool").count()) >= 1, 8000, "tool card");
    await sleep(500); // rAF 量高
  };
  await open();

  // `#app` 上有 `zoom: var(--ui-scale)`（字号偏好），Rect 是缩放后的像素。按实测 zoom 换算，
  // 别把 CSS 里的 96px 直接和屏幕像素比。
  const zoom = await page.evaluate(() => Number(getComputedStyle(document.querySelector("#app")).zoom) || 1);
  const px = (n) => n * zoom;

  // ---------------------------------------------------------------- 1. 默认：只有长用户消息成卡
  const longUser = page.locator(".msg.user").nth(0);
  const shortUser = page.locator(".msg.user").nth(1);
  const card = longUser.locator(".lm-card.lm-user");
  assert((await card.getAttribute("class"))?.includes("has-card"), "the 40-line message became a card");
  assert((await shortUser.locator(".lm-card.has-card").count()) === 0, "the one-line message has no card");
  // D423：没成卡的那层壳必须真的是「纯过路的」。`.lm-card` 是 `display: contents` 之后，若
  // `.lm-scroll` 还留成块盒子，它就顶替气泡当 flex 子项、按内容收缩，气泡自己的
  // `max-width: min(78%, 760px)` 于是量的是这个收缩盒 —— 短消息当场折成好几行、右边空一截
  // （`merge` → 「mer / ge」，D350 修过，D421 加壳之后复发）。量行数和右边缘，两条一起看。
  const shortGeom = await shortUser.evaluate((u) => {
    const b = u.querySelector(".body");
    const range = document.createRange();
    range.selectNodeContents(b);
    const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    return { lines, right: b.getBoundingClientRect().right, msgRight: u.getBoundingClientRect().right };
  });
  assert(shortGeom.lines === 1, `the short bubble keeps one line (${JSON.stringify(shortGeom)})`);
  assert(
    Math.abs(shortGeom.right - shortGeom.msgRight) <= 8,
    `the short bubble hugs the right edge (${shortGeom.right.toFixed(0)} / ${shortGeom.msgRight.toFixed(0)})`,
  );
  // 带图的消息再长也不收卡：卡里只露三行正文，图（附件）会被藏到卡后面。
  const imageUser = page.locator(".msg.user").nth(2);
  assert((await imageUser.locator(".lm-card.has-card").count()) === 0, "a message with an image is never carded");
  assert((await imageUser.locator(".msg-images img").count()) === 1, "and its image stays visible");
  const badge = (await card.locator(".lm-head .lm-badge").innerText()).trim();
  assert(badge === "长消息", `the badge says 长消息 (got ${badge})`);
  const meta = (await card.locator(".lm-head .lm-meta").innerText()).trim();
  assert(/^\d+ 行 · \d+ 字$/.test(meta), `the meta reads "N 行 · N 字" (got ${meta})`);
  const collapsedH = await card.locator(".lm-scroll").evaluate((el) => Math.round(el.getBoundingClientRect().height));
  assert(Math.abs(collapsedH - px(96)) <= 3, `folded card is clipped to 96px × zoom(${zoom}) = ${px(96)} (got ${collapsedH})`);
  assert(await card.locator(".lm-head").isVisible(), "the head is visible when folded");
  assert(!(await card.locator(".lm-bar").isVisible()), "the 收起 bar is hidden when folded");
  assert((await longUser.locator(".fold-head").count()) === 0, "the old 250px fold is not added on top");
  await longUser.scrollIntoViewIfNeeded();
  await longUser.screenshot({ path: path.join(OUT, "1-folded.png") });
  log("folded card:", collapsedH, "px,", badge, meta);

  // ---------------------------------------------------------------- 2. 展开 / 收起
  await card.locator(".lm-head").click();
  await until(async () => (await card.getAttribute("class"))?.includes("is-open"), 3000, "card open");
  const openH = await card.locator(".lm-scroll").evaluate((el) => Math.round(el.getBoundingClientRect().height));
  // 展开态是 `calc(var(--vh1) * 42)` —— 视口的 42%，820px 高＝约 344px。
  assert(openH > collapsedH * 2.5 && openH <= 820 * 0.45, `open card grows to roughly 42vh (got ${openH}, folded ${collapsedH})`);
  assert(await card.locator(".lm-bar").isVisible(), "the 收起 bar shows when open");
  const scrollable = await card.locator(".lm-scroll").evaluate(
    (el) => el.scrollHeight > el.clientHeight + 20 && el.scrollTop === 0 && getComputedStyle(el).overflowY === "auto",
  );
  assert(scrollable, "the open card scrolls inside itself");
  await longUser.scrollIntoViewIfNeeded();
  await longUser.screenshot({ path: path.join(OUT, "2-open.png") });
  await page.screenshot({
    path: path.join(OUT, "2-open-bar.png"),
    scale: "device",
    clip: await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.bottom - 34, width: r.width, height: 34 };
    }),
  });
  await card.locator(".lm-bar").click();
  await until(async () => !(await card.getAttribute("class"))?.includes("is-open"), 3000, "card closed");
  const backH = await card.locator(".lm-scroll").evaluate((el) => Math.round(el.getBoundingClientRect().height));
  assert(backH === collapsedH, `收起 returns to the same height (got ${backH} vs ${collapsedH})`);
  log("open card:", openH, "px; collapsed again:", backH);

  // ---------------------------------------------------------------- 3. 默认关着的两档走老路
  const assistant = page.locator(".msg.assistant").first();
  assert((await assistant.locator(".lm-card.lm-assistant.has-card").count()) === 0, "assistant stays unfolded by default");
  assert((await assistant.locator(".msg-fold").count()) === 1, "assistant keeps the corner fold button");
  const out = page.locator(".tool .out").first();
  const outH = await out.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  assert(outH > px(200) && outH <= px(262), `tool output keeps its 260px window (got ${outH}, want ≤ ${px(262)})`);
  assert((await page.locator(".tool .lm-card").count()) === 0, "tool output has no card by default");
  log("defaults: assistant fold kept, tool out window", outH, "px");

  // ---------------------------------------------------------------- 4. 偏好打开后成卡
  await page.evaluate(() => {
    const raw = localStorage.getItem("pi.prefs");
    const p = raw ? JSON.parse(raw) : {};
    localStorage.setItem("pi.prefs", JSON.stringify({ ...p, longCardAssistant: true, longCardTool: true }));
  });
  await open();
  assert((await page.locator(".msg.assistant .lm-card.lm-assistant.has-card").count()) === 1, "with the pref on, the answer becomes a card");
  // 行数按原文算：30 行的 markdown 回答不该数成 59 行（每段之间那个空行）。
  const answerMeta = (await page.locator(".msg.assistant .lm-head .lm-meta").innerText()).trim();
  assert(/^30 行 · \d+ 字$/.test(answerMeta), `the answer card counts source lines (got ${answerMeta})`);
  assert((await page.locator(".msg.assistant .msg-fold").count()) === 0, "and the corner fold goes away");
  assert((await page.locator(".tool .lm-card.lm-tool.has-card").count()) === 1, "with the pref on, the tool output becomes a card");
  const toolMeta = (await page.locator(".tool .lm-head .lm-badge").innerText()).trim();
  assert(toolMeta === "长输出", `the tool card says 长输出 (got ${toolMeta})`);
  await page.locator(".msg.assistant").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "3-all-cards.png") });
  await page.locator(".tool").first().scrollIntoViewIfNeeded();
  await page.locator(".tool").first().screenshot({ path: path.join(OUT, "3b-tool-card.png") });
  log("assistant + tool cards on");

  // ---------------------------------------------------------------- 5. 设置里三行开关，点了当场重画
  await page.locator(".set-btn").click();
  await until(async () => (await page.locator(".display-sheet").count()) === 1, 5000, "display sheet");
  await page.locator('[data-role="dnav"] button[data-sec="chat"]').first().click();
  const panel = page.locator('.set-sub[data-sec="chat"]');
  await until(async () => (await panel.locator(".settings-row").count()) >= 4, 4000, "chat section rows");
  const rowOf = (name) => panel.locator(".settings-row", { hasText: name }).first();
  for (const name of ["长用户消息收成卡片", "长回答收成卡片", "长的工具输出收成卡片"]) {
    assert((await rowOf(name).count()) === 1, `the 对话 section has a row for ${name}`);
  }
  assert(await rowOf("长用户消息收成卡片").locator('input[type="checkbox"]').isChecked(), "the user switch is on");
  assert(await rowOf("长回答收成卡片").locator('input[type="checkbox"]').isChecked(), "the assistant switch is on");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: path.join(OUT, "4-settings.png") });
  await rowOf("长用户消息收成卡片").locator('input[type="checkbox"]').click();
  await sleep(400);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pi.prefs") ?? "{}").longCardUser);
  assert(saved === false, `the switch writes pi.prefs (got ${saved})`);
  log("settings section has all three rows and writes prefs");

  // 关掉之后当场退回老折叠（同一个会话，没重开）
  await page.locator(".display-sheet .st-head__actions .btn.ghost", { hasText: "关闭" }).click();
  await until(async () => (await page.locator(".msg.user").count()) === 5, 4000, "chat still there");
  assert((await page.locator(".msg.user .lm-card.has-card").count()) === 0, "turning the switch off redraws without cards");
  assert((await page.locator(".msg.user .foldable.has-fold").count()) >= 1, "the old 240px fold is back on the long message");
  log("live redraw: cards gone, legacy fold back");

  // ---------------------------------------------------------------- 7. 现发一条长消息：回填之后还是卡
  // 这条走的是「乐观渲染 → item.add 带 clientId 回填」（`web/src/chat.ts:1215 adopt`）。
  // 回填现在是**就地换内容、不换节点**：卡片的 ResizeObserver 盯的就是这块 `.body`，把节点
  // `replaceWith` 掉以后量到的是那块已经离线的旧节点（0 高），卡片随时可能散架。
  // 这里钉住的是回填之后「仍然是卡、正文还在卡里、行数按原文算」这三件看得见的事。
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    prefs.longCardUser = true;
    localStorage.setItem("pi.prefs", JSON.stringify(prefs));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(async () => (await page.locator(".msg.user .lm-card.has-card").count()) >= 1, 8000, "cards back after reload");

  // 12 行短句：按渲染高度一定超过 240px（12 行 × 30px），但**碰不到** 400 字 / 16 行那道计数尺子 ——
  // 只有高度这一条路能把它收成卡，所以它才能暴露「回填时换掉被观察的节点」这个 bug。
  const SEND = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  // 先数一下 fixture 里已有几声 assistant：假 pi 的那一声 echo 要等到计数**变多**，
  // 不能写成 >= 2 —— 种进来的数据里本来就有两条，那样会当场通过、根本没等到回填。
  const asstBefore = await page.locator(".msg.assistant").count();
  const box = page.locator(".composer-input textarea");
  await box.fill(SEND);
  await box.press("Enter");
  await until(
    async () => (await page.locator(".msg.user").last().innerText()).includes("第 12 行"),
    15000,
    "the sent bubble",
  );
  // 假 pi 会把原话 echo 回来：那一声 assistant 出现，说明这轮真交出去了、回填也发生过了。
  try {
    await until(async () => (await page.locator(".msg.assistant").count()) > asstBefore, 30000, "the echo round");
  } catch (err) {
    // 没等到 echo：把当时的现场（假 pi 收到的 prompt、页面上的报错条）打出来再抛。
    const seen = fs.existsSync(path.join(OUT, "fake-pi.jsonl"))
      ? fs.readFileSync(path.join(OUT, "fake-pi.jsonl"), "utf8").trim().split(String.fromCharCode(10)).slice(-4)
      : ["(no fake-pi log)"];
    const banner = await page.evaluate(() =>
      [...document.querySelectorAll(".hint, .banner, .toast, .msg.error")]
        .map((n) => (n.textContent ?? "").trim()).filter(Boolean).slice(0, 6));
    console.log("DIAG fake-pi:", seen.join(" | "));
    console.log("DIAG page:", JSON.stringify(banner));
    console.log("DIAG counts:", await page.evaluate(() => ({
      msgs: document.querySelectorAll(".msg").length,
      assistant: document.querySelectorAll(".msg.assistant").length,
      user: document.querySelectorAll(".msg.user").length,
      last: document.querySelector(".msg:last-child")?.className ?? "",
    })));
    await page.screenshot({ path: path.join(OUT, "5-send-diag.png") });
    throw err;
  }
  await sleep(800);
  const live = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".msg.user")];
    const m = nodes[nodes.length - 1];
    const card = m.querySelector(".lm-card");
    return {
      cls: card ? card.className : null,
      h: Math.round(m.getBoundingClientRect().height),
      fold: Boolean(m.querySelector(".foldable.has-fold")),
      meta: m.querySelector(".lm-meta")?.textContent ?? "",
    };
  });
  assert(live.cls?.includes("has-card"), `回填之后仍然是卡（class=${live.cls} h=${live.h} fold=${live.fold}）`);
  assert(live.meta.startsWith("12 行"), `卡片按 12 行算（got ${live.meta}）`);
  assert(!live.fold, "回填之后没有退回老的 240px 折叠");
  await page.locator(".msg.user").last().scrollIntoViewIfNeeded();
  await page.locator(".msg.user").last().screenshot({ path: path.join(OUT, "5-live-send.png") });
  log("live send: the card survives the bridge echo (adopt)");

  // ------------------------------------------- 8. 宽欄里的中长文：高度量不出来，靠字数也收
  // 用户 2026-11-26 报的那一条：2K 屏、聊天区很宽，几百字只铺几行，按高度量不到 240，
  // 于是卡不弹、折叠也不弹，那段话就整段铺在屏幕上。这里用两档：999 字（5 段）与 650 字（4 段），
  // 后者在宽欄里只铺 ~180px，**只有原文长度那道尺子能收它**。
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.reload({ waitUntil: "domcontentloaded" });
  // 等这两条**自己**量完：卡片是 rAF / ResizeObserver 里量高的，早一帧读到的还是未成卡的样子。
  const carded = (needle) =>
    page.evaluate((text) => {
      const m = [...document.querySelectorAll(".msg.user")].find((n) => n.innerText.includes(text));
      return Boolean(m?.querySelector(".lm-card.has-card"));
    }, needle);
  await until(async () => (await carded("冲刺 + 提分")) && (await carded("从判别式推起")), 8000, "cards at 2560");
  const pick = (needle) =>
    page.evaluate((text) => {
      const m = [...document.querySelectorAll(".msg.user")].find((n) => n.innerText.includes(text));
      return {
        cls: m?.querySelector(".lm-card")?.className ?? null,
        raw: m?.querySelector(".body")?.scrollHeight ?? -1,
        meta: m?.querySelector(".lm-meta")?.textContent ?? "",
      };
    }, needle);
  const wide = await pick("冲刺 + 提分");
  assert(wide.cls?.includes("has-card"), `几百字的段落也成卡（class=${wide.cls} raw=${wide.raw}）`);
  assert(wide.meta.startsWith("5 行"), `meta 按原文数行（got ${wide.meta}）`);
  const mid = await pick("从判别式推起");
  assert(mid.cls?.includes("has-card"), `400 出头的一段也成卡（class=${mid.cls} raw=${mid.raw}）`);
  assert(mid.meta.startsWith("4 行"), `meta 按原文数行（got ${mid.meta}）`);
  const shortStill = await page.evaluate(() => {
    const m = [...document.querySelectorAll(".msg.user")].find((n) => n.innerText.includes("短问题"));
    return Boolean(m?.querySelector(".lm-card.has-card"));
  });
  assert(!shortStill, "宽欄里短的那条仍然不成卡");
  await page.screenshot({ path: path.join(OUT, "6-wide.png"), fullPage: false });
  log(`wide column: mid-length paragraphs carded too (raw ${wide.raw} / ${mid.raw}px)`);

  log("done — shots in", OUT);
} finally {
  await browser?.close();
  bridge.kill();
}
