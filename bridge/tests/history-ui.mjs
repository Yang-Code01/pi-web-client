/**
 * 「载入更早」（#220）在真界面里跑一遍 —— 自带一个丢弃式 bridge + 一份现成的会话文件，
 * 不花模型 turn，也不碰 7864 上正在用的那份。
 *
 *   node --experimental-strip-types bridge/tests/history-ui.mjs   （先 npm run build）
 *
 * 这份会话有 120 轮（240 条条目，一页 60 条），于是首页之外还要翻 3 次。验的是只有真 DOM 才知道的事：
 *   A. 一次点击多出一页，用户消息数正好加一页的轮数，翻到底等于桥侧总数（不重不漏、顺序不变）；
 *   B. 顶部 / 中部 / 底部三种位置各翻一页，锚点（视口最上沿那块内容）位移 ≤ 2px；
 *   C. 连点两下只发一个 `history.before`，加载中按钮是灰的；
 *   D. 翻到最早一页后那一行整个消失；
 *   E. 刻度带向上补轮（`.turn-row` 30 → 60 → 90 → 120），点第一根刻度能定位到最早那轮；
 *   F. 切到别的会话再切回来：回到第一页，没有残留的预置内容。
 *
 * 桥侧形状（#218 定的）：`session` 帧只带末页 + `history:{hasMore,total}`；
 * `{type:"history.before", sessionId, before, limit?}` → `{type:"history", sessionId, before, items, hasMore}`，
 * limit 夹在 [1,60]，`before` 找不到回空页 + hasMore:false。
 *
 * 端口默认 7890（continue-ui 占 7888），可用 HISTORY_UI_PORT 改。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { REPO } from "../../tools/paths.mjs";
import { loadPlaywright } from "../../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const DIST = path.join(REPO, "bridge", "dist", "index.js");
const PORT = Number(process.env.HISTORY_UI_PORT ?? 7890);
const ROOT = path.join(REPO, ".scratch", "history-ui");
const STATE = path.join(ROOT, "state");
const AGENT = path.join(ROOT, "agent");
const OUT = path.join(REPO, ".scratch", "shots");
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = "history-ui-pass";
const TURNS = 120; // 240 条条目 = 4 页 × 60
const PAGE_TURNS = 30;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });

/** Same spelling as `encodeCwd()` in bridge/src/sessions.ts:294 — the on-disk folder per cwd. */
const encodeCwd = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** A session file as pi writes it: one header line, then one line per item, oldest first. */
function seedSession(id, turns, cwd) {
  const dir = path.join(AGENT, "sessions", encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const at = (i) => new Date(Date.parse("2024-01-01T00:00:00Z") + i * 1000).toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: at(0) })];
  for (let i = 1; i <= turns; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `${id}-u${i}`,
        timestamp: at(i * 2),
        message: { role: "user", content: [{ type: "text", text: `问 ${i}` }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: `${id}-a${i}`,
        timestamp: at(i * 2 + 1),
        message: { role: "assistant", content: [{ type: "text", text: `答 ${i}` }] },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

// 文件名要像 pi 的 uuid，别的代码才肯把它当成一个正常会话。
const A = "0a0a0a0a-1111-4111-8111-0000000000aa";
const B = "0b0b0b0b-2222-4222-8222-0000000000bb";
seedSession(A, TURNS, REPO);
seedSession(B, 2, REPO);

const env = {
  ...process.env,
  PI_WEB_PORT: String(PORT),
  PI_WEB_STATE: STATE,
  PI_WEB_TUNNEL: "0",
  PI_WEB_HOST: "127.0.0.1",
  PI_WEB_ROOT: path.join(REPO, "web", "dist"),
  PI_AGENT_DIR: AGENT,
  PI_BIN: path.join(REPO, "bridge", "tests", "fixtures", "fake-pi.mjs"),
  FAKE_PI_LOG: path.join(ROOT, "fake-pi.jsonl"),
};
// First run only writes the passphrase down; the long-lived one reads it back.
execFileSync(process.execPath, [DIST, "--passphrase", PASS], { env, stdio: "ignore" });

const bridge = spawn(process.execPath, [DIST], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
let bridgeLog = "";
bridge.stdout.on("data", (b) => (bridgeLog += b.toString()));
bridge.stderr.on("data", (b) => (bridgeLog += b.toString()));

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {
    /* wait */
  }
  await sleep(200);
}

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: PASS }),
});
const [cookieName, cookieValue] = (login.headers.get("set-cookie") ?? "").split(";")[0].split("=");

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `${cookieName}=${cookieValue}` } });
const seen = [];
ws.on("message", (b) => seen.push(JSON.parse(b.toString())));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "subscribe", sessionId: A }));

/** Send one frame and resolve with the first reply of `want` type received after it. */
async function ask(frame, want) {
  const from = seen.length;
  ws.send(JSON.stringify(frame));
  for (let i = 0; i < 100; i++) {
    const hit = seen.slice(from).find((m) => m.type === want);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`no ${want} for ${JSON.stringify(frame)}: ${bridgeLog.slice(-800)}`);
}

let firstSession = null;
for (let i = 0; i < 300 && !firstSession; i++) {
  firstSession = seen.find((m) => m.type === "session" && m.state?.id === A) ?? null;
  if (!firstSession) await sleep(100);
}
if (!firstSession) {
  console.error("no session frame:", bridgeLog.slice(-2000));
  process.exit(1);
}

// A. 首帧只带一页 + 历史元数据
const frameBytes = Buffer.byteLength(JSON.stringify(firstSession));
check(
  "首帧只有一页（60 条）",
  firstSession.items?.length === 60,
  `items=${firstSession.items?.length}`,
);
check(
  "首帧带 history:{hasMore,total}",
  firstSession.history?.hasMore === true && firstSession.history?.total === TURNS * 2,
  JSON.stringify(firstSession.history),
);
log("session 帧大小", frameBytes, "bytes");

// 桥侧翻页协议：limit 夹在 [1,60]，before 找不到回空页
const pageDefault = await ask({ type: "history.before", sessionId: A, before: firstSession.items[0].id }, "history");
check(
  "history.before 默认一页（60 条）+ hasMore",
  pageDefault.items?.length === 60 && pageDefault.hasMore === true && pageDefault.before === firstSession.items[0].id,
  `items=${pageDefault.items?.length} hasMore=${pageDefault.hasMore}`,
);
check(
  "这一页正好停在首页前面一条（不重不漏）",
  pageDefault.items.at(-1)?.id === `${A}-a90`,
  `last=${pageDefault.items.at(-1)?.id} want=${A}-a90`,
);
const pageAll = await ask({ type: "history.before", sessionId: A, before: pageDefault.items[0].id, limit: 999 }, "history");
check("limit 超界夹到 60", pageAll.items?.length === 60, `items=${pageAll.items?.length}`);
const pageOne = await ask({ type: "history.before", sessionId: A, before: pageDefault.items[0].id, limit: 0 }, "history");
check(
  "limit 0 夹到 1 条窗口（页首落 user，于是回带上那句用户消息）",
  pageOne.items?.length === 2 && pageOne.items[0].kind === "user",
  `items=${pageOne.items?.length} first=${pageOne.items[0]?.kind}`,
);
const pageNone = await ask({ type: "history.before", sessionId: A, before: "no-such-item" }, "history");
check(
  "before 找不到 → 空页 + hasMore:false",
  pageNone.items?.length === 0 && pageNone.hasMore === false,
  `items=${pageNone.items?.length} hasMore=${pageNone.hasMore}`,
);

// ---- 界面 ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
// 数一数页面真的发出去了几个 history.before（Playwright 的 click() 会先自动滚，所以一律在页面里点）。
await ctx.addInitScript(() => {
  window.__before = 0;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (JSON.parse(data)?.type === "history.before") window.__before += 1;
    } catch {
      /* 非 JSON 帧 */
    }
    return send.call(this, data);
  };
});
const page = await ctx.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message));
await page.goto(`${BASE}/#/s/${A}`);
await page.waitForSelector(".chat-more .more-btn", { timeout: 20000 });

const users = () => page.evaluate(() => document.querySelectorAll(".chat-scroll .msg.user").length);
const rows = () => page.evaluate(() => document.querySelectorAll(".turn-row").length);
const moreLabel = () =>
  page.evaluate(() => {
    const row = document.querySelector(".chat-more");
    const btn = row?.querySelector(".more-btn");
    return { hidden: row?.hidden === true, text: btn?.textContent ?? "", disabled: btn?.disabled === true };
  });

check("首页 30 条用户消息", (await users()) === PAGE_TURNS, `users=${await users()}`);
check("按钮在、写着「载入更早」", (await moreLabel()).text === "载入更早" && !(await moreLabel()).hidden, JSON.stringify(await moreLabel()));
check("刻度带 30 行", (await rows()) === PAGE_TURNS, `rows=${await rows()}`);

/** Viewport-top content node: the one the eye uses as an anchor. Skips the more row and the jump button. */
const setAnchor = () =>
  page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    const top = sc.getBoundingClientRect().top;
    for (const node of sc.children) {
      if (node.classList.contains("chat-more") || node.classList.contains("chat-jump")) continue;
      if (node.getBoundingClientRect().bottom > top + 2) {
        window.__anchor = node;
        return node.getBoundingClientRect().top;
      }
    }
    window.__anchor = null;
    return null;
  });
const anchorTop = () => page.evaluate(() => window.__anchor?.getBoundingClientRect().top ?? null);
const scrollTo = (where) =>
  page.evaluate((w) => {
    const sc = document.querySelector(".chat-scroll");
    const max = sc.scrollHeight - sc.clientHeight;
    if (w === "top") sc.scrollTop = 0;
    else if (w === "mid") sc.scrollTop = Math.round(max / 2);
    else sc.scrollTop = max;
  }, where);

/** Click the real button from inside the page, then wait for the page to settle (it re-pins at 150ms). */
async function clickMore({ settle = true } = {}) {
  const had = await users();
  await page.evaluate(() => document.querySelector(".chat-more .more-btn").click());
  if (settle) {
    await page.waitForFunction((n) => document.querySelectorAll(".chat-scroll .msg.user").length > n, had, { timeout: 15000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await sleep(320);
  }
}

/** One page from `where`; returns the anchor shift in px. */
async function pageFrom(where) {
  await scrollTo(where);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const before = await setAnchor();
  const sent = await page.evaluate(() => window.__before);
  await clickMore();
  const after = await anchorTop();
  const sentAfter = await page.evaluate(() => window.__before);
  return { shift: before === null || after === null ? null : Math.abs(after - before), requests: sentAfter - sent };
}

// B（顶部）+ C（连点只发一次）—— 两下同步点击
await scrollTo("top");
await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
const topAnchor = await setAnchor();
const sentBefore = await page.evaluate(() => window.__before);
// 两下同步点击：加载中的禁用状态得在同一个 tick 里就能看出来（等回复到了就已经不是加载中了）。
const during = await page.evaluate(() => {
  const btn = document.querySelector(".chat-more .more-btn");
  btn.click();
  btn.click();
  return { disabled: btn.disabled, text: btn.textContent ?? "" };
});
await page.waitForFunction((n) => document.querySelectorAll(".chat-scroll .msg.user").length > n, PAGE_TURNS, { timeout: 15000 });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
await sleep(320);
check("加载中按钮是灰的、写「载入中…」", during.disabled && during.text === "载入中…", JSON.stringify(during));
check(
  "连点两下只发一个 history.before",
  (await page.evaluate(() => window.__before)) - sentBefore === 1,
  `sent=${(await page.evaluate(() => window.__before)) - sentBefore}`,
);
check("一页 = +30 条用户消息", (await users()) === PAGE_TURNS * 2, `users=${await users()}`);
const topShift = Math.abs((await anchorTop()) - topAnchor);
check("顶部翻页锚点位移 ≤ 2px", topShift <= 2, `shift=${topShift.toFixed(2)}px`);
check("刻度带 60 行", (await rows()) === PAGE_TURNS * 2, `rows=${await rows()}`);

const mid = await pageFrom("mid");
check("中部翻页锚点位移 ≤ 2px", mid.shift !== null && mid.shift <= 2, `shift=${mid.shift?.toFixed(2)}px`);
check("中部翻页只发一个请求", mid.requests === 1, `requests=${mid.requests}`);
check("再翻一页 → 90 条", (await users()) === PAGE_TURNS * 3, `users=${await users()}`);

const bottom = await pageFrom("bottom");
check("底部翻页锚点位移 ≤ 2px", bottom.shift !== null && bottom.shift <= 2, `shift=${bottom.shift?.toFixed(2)}px`);
check("底部翻页只发一个请求", bottom.requests === 1, `requests=${bottom.requests}`);
check("翻到底 → 120 条用户消息", (await users()) === TURNS, `users=${await users()}`);
check("翻到底那一行消失", (await moreLabel()).hidden, JSON.stringify(await moreLabel()));
check("刻度带 120 行（向上补轮）", (await rows()) === TURNS, `rows=${await rows()}`);
check("三次翻页一共只发了 3 个请求", (await page.evaluate(() => window.__before)) === 3, `requests=${await page.evaluate(() => window.__before)}`);

// 不重不漏：120 条、文本各不相同、顺序是 1..120
const texts = await page.evaluate(() =>
  [...document.querySelectorAll(".chat-scroll .msg.user .body")].map((n) => n.textContent.trim()),
);
check("用户消息不重不漏（120 条、无重复）", texts.length === TURNS && new Set(texts).size === TURNS, `len=${texts.length} uniq=${new Set(texts).size}`);
check("顺序仍是 1..120", texts[0] === "问 1" && texts.at(-1) === `问 ${TURNS}`, `${texts[0]} … ${texts.at(-1)}`);

// E. 刻度带点第一根 → 定位到最早那轮
await page.evaluate(() => document.querySelector('.turn-tick[data-i="0"]').click());
await sleep(900);
const firstTurnTop = await page.evaluate(() => {
  const sc = document.querySelector(".chat-scroll");
  const node = document.querySelector(".chat-scroll .msg.user");
  return { delta: node.getBoundingClientRect().top - sc.getBoundingClientRect().top, text: node.querySelector(".body")?.textContent?.trim() };
});
check("点第一根刻度定位到最早那轮", firstTurnTop.text === "问 1" && Math.abs(firstTurnTop.delta) < 120, JSON.stringify(firstTurnTop));

await page.screenshot({ path: path.join(OUT, "history-top.png") });

// F. 换会话再回来：回到第一页，没有残留
await page.evaluate((id) => (location.hash = `#/s/${id}`), B);
await page.waitForFunction(() => document.querySelectorAll(".chat-scroll .msg.user").length === 2, null, { timeout: 15000 });
await page.evaluate((id) => (location.hash = `#/s/${id}`), A);
await page.waitForFunction((n) => document.querySelectorAll(".chat-scroll .msg.user").length === n, PAGE_TURNS, { timeout: 15000 });
await sleep(200);
check("切走再回来回到第一页", (await users()) === PAGE_TURNS, `users=${await users()}`);
check("切走再回来按钮又出现", !(await moreLabel()).hidden, JSON.stringify(await moreLabel()));
check("切走再回来刻度带也是 30 行（没残留预置轮）", (await rows()) === PAGE_TURNS, `rows=${await rows()}`);

await browser.close();
bridge.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.log("failed:", failed.map((r) => r.name).join("; "));
  process.exit(1);
}
