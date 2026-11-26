/**
 * Probe: D418 — 超长的一轮消息先收成摘要卡，点开在卡里铺开。
 *
 * 种一条会话：40 行用户消息 + 一句短消息 + 30 行助手回答 + 一张输出很长的工具卡。
 * 检查：
 *   1. 默认（只开「长用户消息」）：长的那条是 `.lm-card.has-card` 且卡在 96px，短的那条没有卡；
 *   2. 点卡头展开到 `42vh` 内滚，点卡底「收起」回到 96px；
 *   3. 默认关着的那两档走老路：助手回答还是右上角的 `.msg-fold`，工具输出还是 `.tool .out` 260px；
 *   4. 偏好里把两档打开、刷新页面：助手与工具输出也都成卡；
 *   5. 设置抽屉「对话」一节里三行开关都在，点一下当场重画（不用重开会话）。
 *
 * Run: node probes/long-card.mjs   (needs `npm run build:web` first)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
  { type: "session_info", id: "n1", parentId: "m6", timestamp: at, name: "长卡片" },
];
fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ---------------------------------------------------------------- 起丢弃式 bridge
// 从 pi 会话里跑探针时，自己的那套 PI_* 环境变量（PI_HOST_LINK 指向正在跑的壳、
// PI_WEB_LOOPBACK_TOKEN 的令牌…）会被子进程继承，新 bridge 一启动就去敲 7864 的壳、然后超时。
// 所以先清干净，再只塞本探针要的那几个。
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PI_/i.test(k)));
const bridge = spawn(process.execPath, ["bridge/dist/index.js"], {
  cwd: REPO,
  env: { ...cleanEnv, PI_WEB_PORT: String(PORT), PI_PEER_PORT: String(PORT + 1), PI_WEB_STATE: STATE, PI_WEB_TUNNEL: "0", PI_AGENT_DIR: AGENT },
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
  page.on("pageerror", (e) => log("page error:", e.message));
  const open = async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await sleep(300);
    await until(async () => (await page.locator(".session-card").count()) >= 1, 8000, "card");
    await page.locator(".session-card").first().click();
    await until(async () => (await page.locator(".msg.user").count()) === 3, 10000, "3 user messages");
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
  await until(async () => (await page.locator(".msg.user").count()) === 3, 4000, "chat still there");
  assert((await page.locator(".msg.user .lm-card.has-card").count()) === 0, "turning the switch off redraws without cards");
  assert((await page.locator(".msg.user .foldable.has-fold").count()) >= 1, "the old 240px fold is back on the long message");
  log("live redraw: cards gone, legacy fold back");

  log("done — shots in", OUT);
} finally {
  await browser?.close();
  bridge.kill();
}
