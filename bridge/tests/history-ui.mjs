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
 *   E. 刻度带按整段历史画（#243）：一开始就是 120 行（30 实 + 90 个 `.ghost` 占位），
 *      翻一页后实/淡边界从 90 上移到 60、总高度不变，点第一根刻度能定位到最早那轮；
 *   F. 切到别的会话再切回来：回到第一页，刻度带重新按全量索引摆好（没有残留的已载入轮）；
 *   G. 点最上面那根淡色刻度（#244）：自己连翻 3 页，最后滚到第 1 轮并高亮，中途不需要再点，
 *      按钮按手动翻页的样子变灰、刻度带 `busy`；
 *   H. 翻页途中用户上滚：跳转停下，已经取回的那一页留着，滚动位置不被拽到第 1 轮；
 *   I. 索引里有、正文里没有的那一轮：翻到头就停，顶部那一行说「没翻到第 N 轮」，不再发请求。
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
const pageErrors = [];
page.on("pageerror", (e) => {
  pageErrors.push(e.message);
  log("pageerror:", e.message);
});
await page.goto(`${BASE}/#/s/${A}`);
await page.waitForSelector(".chat-more .more-btn", { timeout: 20000 });

const users = () => page.evaluate(() => document.querySelectorAll(".chat-scroll .msg.user").length);
const rows = () => page.evaluate(() => document.querySelectorAll(".turn-row").length);
const ghostRows = () => page.evaluate(() => document.querySelectorAll(".turn-row.ghost").length);
const rail = () =>
  page.evaluate(() => {
    const el = document.querySelector(".turn-rail");
    // 窄版（这个 390px 的视口）CSS 把带子藏了；量高度时临时展开一下（高度只取决于刻度数和间距）。
    const prev = el.style.display;
    el.style.display = "flex";
    const h = Math.round(el.getBoundingClientRect().height);
    el.style.display = prev;
    return { h, ticks: document.querySelectorAll(".turn-tick").length, ghosts: document.querySelectorAll(".turn-tick.ghost").length };
  });
/** 实/淡分界线的位置：第一行已载入的轮次在整条带子里的下标（ghost 排在它前面）。 */
const boundary = () =>
  page.evaluate(() => {
    const first = document.querySelector(".turn-row:not(.ghost)");
    return first ? Number(first.dataset.i) : null;
  });
/** 等刻度带画完（paint 是一次 rAF）。 */
const settleRail = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/**
 * 等平滑滚动停下：时长跟着距离走（120 轮从底部跳顶要约 1.5s），
 * 拿动画中间的位置判「有没有跳过去」会假红。判据仍是最终落点。
 */
const settleScroll = async () => {
  let last = null;
  let moved = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    const top = await page.evaluate(() => Math.round(document.querySelector(".chat-scroll").scrollTop));
    if (top === last && moved) return top;
    if (top !== last) moved = true;
    last = top;
  }
  return last;
};
const moreLabel = () =>
  page.evaluate(() => {
    const row = document.querySelector(".chat-more");
    const btn = row?.querySelector(".more-btn");
    return { hidden: row?.hidden === true, text: btn?.textContent ?? "", disabled: btn?.disabled === true };
  });

await settleRail();
check("首页 30 条用户消息", (await users()) === PAGE_TURNS, `users=${await users()}`);
check("按钮在、写着「载入更早」", (await moreLabel()).text === "载入更早" && !(await moreLabel()).hidden, JSON.stringify(await moreLabel()));
// #243：全量索引一到手，未载入的 90 轮先占位；行的总数一开始就是 120。
check("刻度带一开始就是 120 行", (await rows()) === TURNS, `rows=${await rows()}`);
check("其中 90 行是 ghost（未载入）、30 行已载入", (await ghostRows()) === TURNS - PAGE_TURNS && (await rows()) - (await ghostRows()) === PAGE_TURNS, `ghost=${await ghostRows()}`);
check("实/淡分界线在 90", (await boundary()) === TURNS - PAGE_TURNS, `boundary=${await boundary()}`);
const rail0 = await rail();
check("刻度带里也有 ghost 刻度", rail0.ghosts > 0 && rail0.ghosts < rail0.ticks && rail0.h > 0, JSON.stringify(rail0));

// ghost 的说明文字：能看出是哪一轮，并且标着「未载入」
const ghostText = await page.evaluate(() => {
  const tick = document.querySelector(".turn-tick.ghost");
  const row = document.querySelector(".turn-row.ghost");
  return { tickTitle: tick?.title ?? "", tickAria: tick?.getAttribute("aria-label") ?? "", rowTitle: row?.title ?? "" };
});
check(
  "未载入刻度的 title / aria-label 写着哪一轮 + 「未载入」",
  ghostText.tickTitle.includes("未载入") && ghostText.tickTitle.includes("问 1") && ghostText.tickAria.includes("未载入"),
  JSON.stringify(ghostText),
);
check("未载入的行也标着「未载入」", ghostText.rowTitle.includes("未载入") && ghostText.rowTitle.includes("问 1"), ghostText.rowTitle);

// 颜色：ghost 行用 --faint 那一档，比已载入的那一行淡；刻度同理
const tones = await page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--faint)";
  document.body.append(probe);
  const faint = getComputedStyle(probe).color;
  probe.remove();
  const ghostRow = document.querySelector(".turn-row.ghost");
  const solidRow = document.querySelector(".turn-row:not(.ghost)");
  const ghostTick = document.querySelector(".turn-tick.ghost");
  const solidTick = document.querySelector(".turn-tick:not(.ghost)");
  return {
    faint,
    row: ghostRow ? getComputedStyle(ghostRow).color : null,
    solidRow: solidRow ? getComputedStyle(solidRow).color : null,
    tick: ghostTick ? getComputedStyle(ghostTick).backgroundColor : null,
    solidTick: solidTick ? getComputedStyle(solidTick).backgroundColor : null,
  };
});
check("未载入的行用 --faint 那一档（比已载入的淡）", tones.row === tones.faint && tones.row !== tones.solidRow, JSON.stringify(tones));
check("未载入的刻度颜色比已载入的淡一档", tones.tick !== null && tones.tick !== tones.solidTick, JSON.stringify(tones));
check(
  "未载入的行可及名里也写着「未载入」（读屏听得出它还没载入）",
  (await page.evaluate(() => document.querySelector(".turn-row.ghost")?.getAttribute("aria-label") ?? "")).includes("未载入"),
);
check("「当前」不会落在 ghost 刻度上", (await page.evaluate(() => document.querySelectorAll(".turn-tick.ghost.cur").length)) === 0);

// 点 ghost：见下面的 G（#244）—— 那张票让它不再只是看得见的占位。

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
// 先像往上读的人那样滚一格：把跟流关掉。否则翻页之后输入区再定一次高度（实测 3px）时，
// 那颗 ResizeObserver 会在「跟流」时把视口贴回底部，量到的就不是翻页的位移了。
await page.evaluate(() => document.querySelector(".chat-scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true })));
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
check("翻一页后还是 120 行", (await rows()) === TURNS, `rows=${await rows()}`);
check("那 30 个 ghost 变成实线：实 60 / 淡 60", (await rows()) - (await ghostRows()) === PAGE_TURNS * 2 && (await ghostRows()) === TURNS - PAGE_TURNS * 2, `ghost=${await ghostRows()}`);
check("实/淡分界线上移到 60", (await boundary()) === TURNS - PAGE_TURNS * 2, `boundary=${await boundary()}`);
const rail1 = await rail();
check("翻页前后刻度带总高度不变、刻度数不变", rail1.h === rail0.h && rail1.ticks === rail0.ticks, `${JSON.stringify(rail0)} → ${JSON.stringify(rail1)}`);
check("ghost 刻度变少", rail1.ghosts < rail0.ghosts, `${rail0.ghosts} → ${rail1.ghosts}`);

const mid = await pageFrom("mid");
check("中部翻页锚点位移 ≤ 2px", mid.shift !== null && mid.shift <= 2, `shift=${mid.shift?.toFixed(2)}px`);
check("中部翻页只发一个请求", mid.requests === 1, `requests=${mid.requests}`);
check("再翻一页 → 90 条", (await users()) === PAGE_TURNS * 3, `users=${await users()}`);
check("实/淡分界线上移到 30", (await boundary()) === TURNS - PAGE_TURNS * 3, `boundary=${await boundary()}`);
check("刻度带总高度仍然不变", (await rail()).h === rail0.h && (await rail()).ticks === rail0.ticks, JSON.stringify(await rail()));

const bottom = await pageFrom("bottom");
check("底部翻页锚点位移 ≤ 2px", bottom.shift !== null && bottom.shift <= 2, `shift=${bottom.shift?.toFixed(2)}px`);
check("底部翻页只发一个请求", bottom.requests === 1, `requests=${bottom.requests}`);
check("翻到底 → 120 条用户消息", (await users()) === TURNS, `users=${await users()}`);
check("翻到底那一行消失", (await moreLabel()).hidden, JSON.stringify(await moreLabel()));
check("翻到底：120 行全是实线，没有 ghost", (await rows()) === TURNS && (await ghostRows()) === 0, `rows=${await rows()} ghost=${await ghostRows()}`);
check("刻度带总高度从头到尾不变", (await rail()).h === rail0.h && (await rail()).ticks === rail0.ticks, JSON.stringify(await rail()));
check("ghost 刻度全部消失", (await rail()).ghosts === 0, JSON.stringify(await rail()));
check("三次翻页一共只发了 3 个请求", (await page.evaluate(() => window.__before)) === 3, `requests=${await page.evaluate(() => window.__before)}`);

// 不重不漏：120 条、文本各不相同、顺序是 1..120
const texts = await page.evaluate(() =>
  [...document.querySelectorAll(".chat-scroll .msg.user .body")].map((n) => n.textContent.trim()),
);
check("用户消息不重不漏（120 条、无重复）", texts.length === TURNS && new Set(texts).size === TURNS, `len=${texts.length} uniq=${new Set(texts).size}`);
check("顺序仍是 1..120", texts[0] === "问 1" && texts.at(-1) === `问 ${TURNS}`, `${texts[0]} … ${texts.at(-1)}`);

// E. 刻度带点第一根 → 定位到最早那轮
await page.evaluate(() => document.querySelector('.turn-tick[data-i="0"]').click());
await settleScroll();
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
check("切走再回来：120 行重新按全量索引摆好（30 实 + 90 淡）", (await rows()) === TURNS && (await ghostRows()) === TURNS - PAGE_TURNS, `rows=${await rows()} ghost=${await ghostRows()}`);

// ---- G. #244：点最上面那根淡色刻度 → 自己连翻 3 页，最后滚到第 1 轮并高亮 --------------------
await settleRail();
const jumpBase = await page.evaluate(() => window.__before);
const jumpStart = await page.evaluate(() => {
  document.querySelector(".turn-tick.ghost").click();
  const btn = document.querySelector(".chat-more .more-btn");
  return {
    disabled: btn.disabled,
    text: btn.textContent ?? "",
    busy: document.querySelector(".turn-rail").classList.contains("busy"),
  };
});
check(
  "自动翻页起手：按钮灰了、写「载入中…」，刻度带在忙",
  jumpStart.disabled && jumpStart.text === "载入中…" && jumpStart.busy,
  JSON.stringify(jumpStart),
);
// 三页都是一瞬间的事，等「那一轮到了并高亮」比等条数稳（高亮是自己消失的）。
await page.waitForFunction(() => document.querySelector(".chat-scroll .msg.user")?.classList.contains("turn-flash") === true, null, { timeout: 20000 });
const jumped = await page.evaluate(() => {
  const node = document.querySelector(".chat-scroll .msg.user");
  return { text: node?.querySelector(".body")?.textContent?.trim() ?? "", users: document.querySelectorAll(".chat-scroll .msg.user").length };
});
check("自动翻页翻到第 1 轮并高亮它", jumped.text === "问 1" && jumped.users === TURNS, JSON.stringify(jumped));
check(
  "自动翻页正好发了 3 个请求（每页一次，中间不需要再点）",
  (await page.evaluate(() => window.__before)) - jumpBase === 3,
  `requests=${(await page.evaluate(() => window.__before)) - jumpBase}`,
);
const jumpSettled = {
  more: await moreLabel(),
  busy: await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("busy")),
};
check("翻完按钮收起、刻度带不忙了", jumpSettled.more.hidden && !jumpSettled.busy, JSON.stringify(jumpSettled));
await settleScroll();
const jumpLanded = await page.evaluate(() => {
  const sc = document.querySelector(".chat-scroll");
  const node = document.querySelector(".chat-scroll .msg.user");
  return { delta: node.getBoundingClientRect().top - sc.getBoundingClientRect().top, text: node.querySelector(".body")?.textContent?.trim() };
});
check("自动翻完滚到第 1 轮（对齐视口顶）", jumpLanded.text === "问 1" && Math.abs(jumpLanded.delta) < 120, JSON.stringify(jumpLanded));

// ---- H. #244：翻页途中用户上滚 → 跳转停下，已取回的页留着，位置不被拽走 --------------------
// 回到第一页（切走再切回来），上一段已经把 120 轮全载入了。
await page.evaluate((id) => (location.hash = `#/s/${id}`), B);
await page.waitForFunction(() => document.querySelectorAll(".chat-scroll .msg.user").length === 2, null, { timeout: 15000 });
await page.evaluate((id) => (location.hash = `#/s/${id}`), A);
await page.waitForFunction((n) => document.querySelectorAll(".chat-scroll .msg.user").length === n, PAGE_TURNS, { timeout: 15000 });
await settleRail();
await scrollTo("mid");
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const cancelBase = await page.evaluate(() => window.__before);
// 点完同一个 tick 里就上滚：请求已在飞，取消得跟上「用户自己动手」。
await page.evaluate(() => {
  document.querySelector(".turn-tick.ghost").click();
  document.querySelector(".chat-scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true }));
});
await page.waitForFunction((n) => document.querySelectorAll(".chat-scroll .msg.user").length > n, PAGE_TURNS, { timeout: 15000 });
await sleep(700); // 再等一会儿：不该有第二页、第三页跟上来
const cancelled = {
  users: await users(),
  requests: (await page.evaluate(() => window.__before)) - cancelBase,
  flashing: await page.evaluate(() => document.querySelectorAll(".msg.user.turn-flash").length),
  firstAway: await page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    // 第 1 轮该在视口上方很远的地方（没被拽过去）；负得不够就是跳了。
    return Math.round(document.querySelector(".chat-scroll .msg.user").getBoundingClientRect().top - sc.getBoundingClientRect().top);
  }),
  more: await moreLabel(),
};
check(
  "上滚取消：只取回已经发出的那一页，不再接着翻",
  cancelled.users === PAGE_TURNS * 2 && cancelled.requests === 1,
  JSON.stringify(cancelled),
);
check(
  "上滚取消：不跳、不高亮，滚动没被拽到第 1 轮",
  cancelled.flashing === 0 && cancelled.firstAway < -200,
  JSON.stringify(cancelled),
);
check(
  "上滚取消：按钮回到「载入更早」、刻度带不忙了",
  !cancelled.more.hidden && cancelled.more.text === "载入更早" && !cancelled.more.disabled && !(await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("busy"))),
  JSON.stringify(cancelled.more),
);

// ---- I. #244：索引里有、正文里没有的那一轮 → 翻到头就停，并说「没翻到第 N 轮」 --------------------
// 这一段的假桥在页面侧：把 session 帧的 history.turns 前面塞一个正文里永远翻不到的轮次。
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
await ctx2.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
await ctx2.addInitScript(() => {
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
  // 改 `onmessage` 这一路就够了（ws.ts 用的是 ws.onmessage），没必要接管整个 socket。
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(fn) {
      desc.set.call(this, function (ev) {
        let out = ev;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "session" && Array.isArray(msg.history?.turns)) {
            msg.history.turns = [{ id: "phantom-turn", text: "问 0", images: [] }, ...msg.history.turns];
            out = new MessageEvent("message", { data: JSON.stringify(msg) });
          }
        } catch {
          /* 非 JSON / 结构不对：原样交给页面 */
        }
        fn.call(this, out);
      });
    },
  });
});
const page2 = await ctx2.newPage();
page2.on("pageerror", (e) => log("pageerror(ctx2):", e.message));
await page2.goto(`${BASE}/#/s/${A}`);
await page2.waitForSelector(".chat-more .more-btn", { timeout: 20000 });
await page2.waitForFunction(() => document.querySelectorAll(".chat-scroll .msg.user").length === 30, null, { timeout: 15000 });
// 这一段的「可见」得有带子：窄版（`<html data-compact>`, <900px）下 `.turn-rail` 整个 display:none，
// 量出来全是 0 的 rect。把窗口拉到桌面宽度再点。
await page2.setViewportSize({ width: 1200, height: 844 });
await page2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const phantomRows = await page2.evaluate(() => document.querySelectorAll(".turn-row").length);
check("索引里多了那条不存在的轮次（121 行，91 淡）", phantomRows === TURNS + 1, `rows=${phantomRows}`);
// 这里点的是**行**（不是刻度）：两种形状共用一个回调，行这条腿由这一段覆盖。
const phantomStart = await page2.evaluate(() => {
  const row = document.querySelector(".turn-row.ghost");
  row.click();
  return { ghost: row.title, busy: document.querySelector(".turn-rail").classList.contains("busy") };
});
check("点的就是那条不存在的第 1 轮（点的是行）", phantomStart.ghost.includes("问 0") && phantomStart.busy, JSON.stringify(phantomStart));
await page2.waitForFunction(() => document.querySelector(".chat-more .more-btn")?.textContent === "没翻到第 1 轮", null, { timeout: 20000 });
const stuck = await page2.evaluate(() => {
  const row = document.querySelector(".chat-more");
  const btn = row.querySelector(".more-btn");
  return {
    users: document.querySelectorAll(".chat-scroll .msg.user").length,
    noteHidden: row.hidden === true,
    noteDisabled: btn.disabled === true,
    requests: window.__before,
    ghostRows: document.querySelectorAll(".turn-row.ghost").length,
    busy: document.querySelector(".turn-rail").classList.contains("busy"),
    flashing: document.querySelectorAll(".msg.user.turn-flash").length,
  };
});
check(
  "翻到尽头也没有那一轮：停下、不跳、不忙了",
  stuck.users === TURNS && stuck.flashing === 0 && !stuck.busy && stuck.ghostRows === 1,
  JSON.stringify(stuck),
);
check("失败那行是可见的（没更早的了也要露出来）", !stuck.noteHidden && stuck.noteDisabled, JSON.stringify(stuck));
// 正文顶部那行这时在视口上方几千像素外；带子固定在右缘，同一句话得真落在视口里（#244 的「可见」）。
const noteBox = await page2.evaluate(() => {
  const note = document.querySelector(".turn-note");
  if (!note || note.hidden) return null;
  const box = note.getBoundingClientRect();
  return {
    text: note.textContent ?? "",
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    right: Math.round(box.right),
    width: Math.round(box.width),
    height: Math.round(box.height),
    h: window.innerHeight,
    w: window.innerWidth,
  };
});
check(
  "失败那句挂在刻度带上、真在视口里",
  noteBox !== null &&
    noteBox.text === "没翻到第 1 轮" &&
    noteBox.width > 0 &&
    noteBox.height > 0 &&
    noteBox.top >= 0 &&
    noteBox.bottom <= noteBox.h &&
    noteBox.right <= noteBox.w,
  JSON.stringify(noteBox),
);
check("翻到头一共 3 个请求（每页一次）", stuck.requests === 3, `requests=${stuck.requests}`);
await sleep(800);
check(
  "失败之后不再继续发请求",
  (await page2.evaluate(() => window.__before)) === 3 && (await page2.evaluate(() => document.querySelectorAll(".chat-scroll .msg.user").length)) === TURNS,
  `requests=${await page2.evaluate(() => window.__before)}`,
);
await sleep(2400);
const cleared = await page2.evaluate(() => ({
  note: document.querySelector(".turn-note")?.hidden === true,
  more: document.querySelector(".chat-more")?.hidden === true,
}));
check("三秒后失败提示自己收了（带子上和正文那行都收）", cleared.note && cleared.more, JSON.stringify(cleared));
await ctx2.close();

await browser.close();
bridge.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ok`);
if (failed.length) {
  console.log("failed:", failed.map((r) => r.name).join("; "));
  process.exit(1);
}
