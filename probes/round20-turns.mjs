/**
 * Probe: Q-028 — the turn rail on the right edge of the transcript. One tick per user turn; hovering
 * the rail opens a list of every round's user input (single line, right aligned), the current round
 * highlighted; hovering a row highlights that round in the transcript; clicking a row jumps there.
 *
 * Stands in for the bridge with two seeded sessions: A has 12 rounds (the interaction under test),
 * B has 90 (ticks must be sampled down to what fits, and the last tick must still be the last round).
 *
 * Run: npm run build:web && node probes/round20-turns.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);
const wsMod = await import(pathToFileURL("F:/pi-web-client/bridge/node_modules/ws/wrapper.mjs").href);
const { WebSocketServer } = wsMod;

const PORT = 7914;
const DIST = "F:/pi-web-client/web/dist";
const OUT = "F:/pi-web-client/.scratch/round20-turns/shots";
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
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${what}`);
};

// --- seeded transcript -------------------------------------------------------------------------
const ASK = [
  "现在考试模块只有 n2 的两套卷子。帮我补齐其余年份和月份的真题，先看现在的结构。要求：卷子数据不要手写，" +
    "用同一个脚本从 docs/真题 里生成；年份下拉要按月份分组，缺月份的不许留空；加密入口只在 node 侧跑，" +
    "浏览器端不再加载 crypto-js；答案和解析要能折叠，键盘也能开合；计时器放右上角别挡住题干；返回年份选择要保留状态；" +
    "最后只改 exam-lock.js 一个文件，别的文件一行都不许动，改完跑 verify 和 tsc 再 commit。",
  "可以，1、但是选择答案后没有解析。需要补解析，并且每个解析要能折叠。",
  "请继续完成未完成的任务。",
  "1、真是考试里面目前没有 n2 的选项。直接按推荐来，把年份下拉补上。",
  "真实考试选择年份后，开始做题。然后返回到年份选择，状态要保留。",
  "ok、帮我补齐其他年份和月份的。先补齐 2020 年的，只补真题。",
  "全部做完之后，把改动只在 exam-lock.js 一个文件里。",
  "继续、另外把计时器放到右上角，别挡住题干。",
  "有些年份只有一个月份的，比如 2020 年只有 7 月和 12 月。",
  "@skill:grill-with-docs 1、给所有 html 右上角追加按钮，2、index 里加一个入口。",
  "我没有让你直接修改，为啥你自作主张直接就改了？回滚，只给方案。",
  "保留现状，帮我 commit、并且 push 到 main。",
];
const ROUND_TEXT =
  "这一轮的回复故意写长一点：缩略图要能滚，正文要能滚。任务列表如下 —— 先摸清现有结构，再把卷子数据补齐，" +
  "最后只改一个文件，不动数据格式、不重新加密、不重跑 verify。";
const BULLETS = [
  "把 buildModal() 换成共用的一份，年份/月份从同一张表里取，缺的月份不许再出现空白页",
  "解析区改成 <details>，默认折叠，答案与解析一起展开，键盘也能开合",
  "计时器挪到右上角，absolute 定位，别跟着题干滚动，也别挡住右上角的关闭",
  "返回年份选择时用 sessionStorage 记住上一次的选择，而不是重置到默认年份",
  "加密入口只在 node 侧跑，浏览器端不再加载 crypto-js，体积能小 40KB",
  "卷子数据统一成 {year, month, sections[]}，旧的两套做一次迁移，宁可多写一个脚本",
  "补 2020 年 7 月与 12 月的听力，题目文案沿用真题，题干里的图先用占位",
];

const items = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = i < ASK.length ? ASK[i] : `第 ${i + 1} 轮：继续补齐第 ${i + 1} 套卷子，并检查解析是否折叠正常。`;
    out.push({ id: `u${i}`, kind: "user", text, images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    out.push({
      id: `a${i}`,
      kind: "assistant",
      text: `${ROUND_TEXT}\n\n- 第 ${i + 1} 轮要点一：把 exam-lock.js 里的 buildModal() 换掉\n- 第 ${i + 1} 轮要点二：.lk-foot 改成右对齐\n- 第 ${i + 1} 轮要点三：其余一行不动。`,
      thinking: "",
      model: "probe",
      ts: new Date(Date.now() - (n - i) * 59000).toISOString(),
    });
  }
  return out;
};

const base = (id, name, n) => ({
  id, name, cwd: "F:/probe-work/exam", file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: items(n),
});
const A = base("probe-a", "考试模块 · 12 轮", 12);
const B = base("probe-b", "长会话 · 200 轮", 200);
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "probe", pi: "probe", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "probe" };
const manage = { pin: [], order: [], archived: [] };

const strip = ({ items: _drop, ...rest }) => rest;

const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
  if (url.pathname === "/api/dirs") return json(200, { path: url.searchParams.get("path") ?? "", parent: "F:", dirs: [], files: [], error: "" });
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
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "subscribe") {
      const s = [A, B].find((x) => x.id === msg.sessionId) ?? A;
      ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: strip(s), items: s.items, approvals: [], asks: [], budget: null }));
    }
  });
  ws.send(JSON.stringify({ type: "hello", me: ME, sessions: [strip(A), strip(B)], manage, trash: [], tunnel: TUNNEL }));
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
log("fake bridge on", BASE);

const rect = (page, sel, i = 0) =>
  page.evaluate(([s, k]) => {
    const node = document.querySelectorAll(s)[k];
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  }, [sel, i]);
const scrollTop = (page) => page.evaluate(() => document.querySelector(".chat-scroll").scrollTop);
const maxScroll = (page) => page.evaluate(() => {
  const s = document.querySelector(".chat-scroll");
  return s.scrollHeight - s.clientHeight;
});

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("console:", m.text()); });
  page.on("pageerror", (e) => log("page error:", e.message, (e.stack ?? "").split(String.fromCharCode(10)).slice(0, 4).join(" | ")));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 12, 8000, "12 user messages");
  await sleep(400);

  // 1) 带子出现了，一根刻度一轮；首尾那根一定是第一轮和最后一轮。
  const rail = page.locator(".turn-rail");
  assert(await rail.isVisible(), "a session with 12 rounds shows the turn rail");
  const ticks = page.locator(".turn-tick");
  assert((await ticks.count()) === 12, `12 rounds = 12 ticks (got ${await ticks.count()})`);
  const railBox = await rect(page, ".turn-rail");
  const paneBox = await rect(page, ".chat-pane");
  const scrollBox = await rect(page, ".chat-scroll");
  log("rail:", JSON.stringify(railBox), "pane w:", paneBox.width);
  assert(railBox.right <= scrollBox.right - 9, `the rail sits left of the 10px scrollbar (rail right ${railBox.right}, pane right ${scrollBox.right})`);
  assert(railBox.top >= scrollBox.top && railBox.bottom <= scrollBox.bottom - 4, `the rail stays inside the transcript viewport (rail ${railBox.top}..${railBox.bottom}, view ${scrollBox.top}..${scrollBox.bottom})`);
  await page.screenshot({ path: path.join(OUT, "1-rail.png") });

  // 2) 滚到底 = 最后一轮是当前轮（它自己那根刻度用 cur 标出来）。
  await until(async () => (await scrollTop(page)) > 100, 5000, "transcript is scrollable");
  const bottomState = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll(".turn-tick")];
    const cur = ticks.findIndex((t) => t.classList.contains("cur"));
    return { cur, last: ticks.length - 1 };
  });
  log("cur tick at bottom:", JSON.stringify(bottomState));
  assert(bottomState.cur === bottomState.last, `at the bottom the last tick is current (got ${JSON.stringify(bottomState)})`);

  // 3) 悬停带子 → 小列表展开：每行一轮，末行＝当前轮，行是单行右对齐的。
  await page.locator(".turn-rail").hover();
  await until(async () => page.locator(".turn-list").isVisible(), 4000, "turn list opens on hover");
  const rows = page.locator(".turn-row");
  assert((await rows.count()) === 12, `one row per round (got ${await rows.count()})`);
  const curIdx = await page.evaluate(() => [...document.querySelectorAll(".turn-row")].findIndex((r) => r.classList.contains("cur")));
  assert(curIdx === 11, `the last row is the highlight (got ${curIdx})`);
  const lastText = (await rows.nth(11).innerText()).replace(/\s+/g, " ").trim();
  log("last row:", JSON.stringify(lastText));
  assert(lastText.includes("commit"), `the last row is the last input (got ${JSON.stringify(lastText)})`);
  const rowBox = await rect(page, ".turn-row", 5);
  const listBox = await rect(page, ".turn-list");
  log("row h:", rowBox.height, "list:", JSON.stringify(listBox));
  assert(rowBox.height < 34, `rows are one line tall (got ${rowBox.height}px)`);
  assert(listBox.left > 0 && listBox.right <= paneBox.right, "the list stays inside the chat column");
  // 融合：弹层的右缘就是刻度那一列的右缘，刻度同时隐去 —— 一个框，不是框外挂一列刻度
  assert(Math.abs(listBox.right - railBox.right) < 1.5, `the panel's right edge lands on the tick column (panel ${listBox.right}, rail ${railBox.right})`);
  const tickOpacity = await page.locator(".turn-tick").first().evaluate((e) => getComputedStyle(e).opacity);
  assert(tickOpacity === "0", `ticks give way to the panel's own dashes (opacity ${tickOpacity})`);
  const dashes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".turn-row")];
    const dash = (r) => r.querySelector(".dash").getBoundingClientRect();
    const cur = rows.find((r) => r.classList.contains("cur"));
    return { cur: dash(cur).width, other: dash(rows[0]).width, curRight: dash(cur).right, otherRight: dash(rows[0]).right };
  });
  log("dashes:", JSON.stringify(dashes));
  assert(dashes.cur > dashes.other + 8, `the current round's dash is the long one (${dashes.cur} vs ${dashes.other})`);
  assert(Math.abs(dashes.curRight - dashes.otherRight) < 1, "all dashes end on the same column");
  const geom = await page.evaluate(() => [...document.querySelectorAll(".turn-row")].slice(0, 4).map((r) => {
    const t = r.querySelector(".txt");
    const box = t.getBoundingClientRect();
    const d = r.querySelector(".dash").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(t);
    const glyphs = range.getBoundingClientRect();
    return { txt: [Math.round(box.left), Math.round(box.right)], glyphs: [Math.round(glyphs.left), Math.round(glyphs.right)], dash: [Math.round(d.left), Math.round(d.right)] };
  }));
  log("row geometry:", JSON.stringify(geom));
  const align = await page.evaluate(() => getComputedStyle(document.querySelector(".turn-row .txt")).textAlign);
  assert(align === "right", `rows read right-aligned (got ${align})`);
  // 文字被压成一行（超宽就打点），不是换行
  const oneLine = await page.evaluate(() => {
    const ts = [...document.querySelectorAll(".turn-row .txt")];
    const longest = ts.map((t, i) => [t.scrollWidth, i]).sort((a, b) => b[0] - a[0])[0][1];
    const t = ts[longest];
    const cs = getComputedStyle(t);
    return { i: longest, h: t.getBoundingClientRect().height, over: t.scrollWidth - t.clientWidth, ellipsis: cs.textOverflow, wrap: cs.whiteSpace };
  });
  log("row text:", JSON.stringify(oneLine));
  assert(oneLine.h < 26 && oneLine.wrap.includes("no-wrap") === false, `row text is a single line (got ${oneLine.h}px, wrap ${oneLine.wrap})`);
  assert(oneLine.ellipsis === "ellipsis", `overlong input ends in an ellipsis (got ${oneLine.ellipsis})`);
  assert(oneLine.over > 0, `the longest label really does overflow (got ${oneLine.over}px)`);

  // 4) 悬停某一行：那行高亮，正文里对应的用户消息也亮一下。
  await rows.nth(4).hover();
  await sleep(200);
  const hot = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".turn-row")];
    const i = rows.findIndex((r) => r.classList.contains("hot"));
    const flash = document.querySelector(".chat-scroll .msg.user.turn-flash");
    const all = [...document.querySelectorAll(".chat-scroll .msg.user")];
    return { hot: i, flash: flash ? all.indexOf(flash) : -1, fliques: document.querySelectorAll(".turn-flash").length };
  });
  log("hover row 4:", JSON.stringify(hot));
  assert(hot.hot === 4, `the hovered row carries .hot (got ${hot.hot})`);
  assert(hot.flash === 4, `the matching user message is highlighted (got ${hot.flash})`);
  assert(hot.fliques === 1, `only one thing flashes at a time (got ${hot.fliques})`);
  // 对应那根刻度也亮
  const hotTick = await page.evaluate(() => [...document.querySelectorAll(".turn-tick")].findIndex((t) => t.classList.contains("hot")));
  assert(hotTick === 4, `the 5th tick lights up with the row (got ${hotTick})`);
  await page.screenshot({ path: path.join(OUT, "2-popover.png") });

  // 5) 点第 5 行 → 滚到那一轮，且顶部对齐；此后不再跟流（「回到底部」出现）。
  const paneTop = (await rect(page, ".chat-scroll")).top;
  await rows.nth(4).click();
  await until(async () => {
    const r = await rect(page, ".chat-scroll .msg.user", 4);
    return r && Math.abs(r.top - paneTop) < 40;
  }, 5000, "jump to round 5");
  await sleep(600);
  const afterJump = await rect(page, ".chat-scroll .msg.user", 4);
  const gapAfter = await page.evaluate(() => {
    const s = document.querySelector(".chat-scroll");
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  });
  log("round 5 top after jump:", afterJump.top.toFixed(1), "pane top:", paneTop.toFixed(1), "gap below:", gapAfter);
  assert(Math.abs(afterJump.top - paneTop) < 16, `the clicked round lands at the top of the transcript (top ${afterJump.top.toFixed(1)}, pane ${paneTop.toFixed(1)})`);
  assert(gapAfter > 200, `there is still a long way down from round 5 (gap ${gapAfter})`);
  const jumpState = await page.evaluate(() => {
    const j = document.querySelector(".chat-jump");
    const cs = getComputedStyle(j);
    const r = j.getBoundingClientRect();
    return { hidden: j.hidden, display: cs.display, vis: cs.visibility, pos: cs.position, top: r.top, left: r.left, w: r.width, h: r.height, bottom: cs.bottom, parent: j.parentElement.className };
  });
  log("jump:", JSON.stringify(jumpState));
  assert(await page.locator(".chat-jump").isVisible(), "jumping up stops following, so 回到底部 comes back");
  await page.mouse.move(40, 40);
  await until(async () => !(await page.locator(".turn-list").isVisible()), 3000, "the list closes when the pointer leaves");
  log("list closed after the pointer left");
  await page.screenshot({ path: path.join(OUT, "3-jumped.png") });

  // 5b) 键盘也能用：Tab 到刻度上，列表照样展开（:focus-visible），失焦就收起。
  await page.keyboard.press("Tab");
  await page.evaluate(() => document.querySelectorAll(".turn-tick")[2].focus());
  await until(async () => page.locator(".turn-list").isVisible(), 3000, "keyboard focus opens the list");
  assert(
    await page.locator(".turn-tick").nth(2).evaluate((e) => e.matches(":focus-visible")),
    "the focused tick takes the keyboard focus ring",
  );
  await page.evaluate(() => document.activeElement.blur());
  await until(async () => !(await page.locator(".turn-list").isVisible()), 3000, "blur closes the list");
  log("keyboard path ok");

  // 6) 点最后一行 → 直接回到底部并恢复跟流。
  await page.locator(".turn-rail").hover();
  await until(async () => page.locator(".turn-list").isVisible(), 4000, "list again");
  await page.locator(".turn-row").nth(11).click();
  await until(async () => Math.abs((await scrollTop(page)) - (await maxScroll(page))) < 4, 5000, "back at the bottom");
  assert(await page.locator(".chat-jump").isHidden(), "following resumes after jumping to the last round");

  // 7) 90 轮的会话：刻度会被抽样，但最后一根刻度仍然是最后一轮，点它还是回到底部。
  await page.locator('.session-card[data-id="probe-b"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 200, 15000, "200 user messages");
  await sleep(500);
  const ticks200 = await page.locator(".turn-tick").count();
  const railH = (await rect(page, ".turn-rail")).height;
  const railTop = (await rect(page, ".turn-rail")).top;
  log("200 rounds → ticks:", ticks200, "rail height:", railH, "top:", railTop);
  assert(ticks200 > 3 && ticks200 < 200, `ticks are sampled down (got ${ticks200})`);
  const scroll2 = await rect(page, ".chat-scroll");
  const rail2 = await rect(page, ".turn-rail");
  log("long rail:", JSON.stringify(rail2), "view:", JSON.stringify(scroll2));
  assert(rail2.top >= scroll2.top && rail2.bottom <= scroll2.bottom - 4, `200 rounds: the rail stops at the transcript, not under the composer (rail ${rail2.top}..${rail2.bottom}, view ${scroll2.top}..${scroll2.bottom})`);
  // 抽样不能把最后一轮漏掉：最后一根刻度点的就是最新那一轮
  await page.locator(".turn-tick").last().click();
  await until(async () => Math.abs((await scrollTop(page)) - (await maxScroll(page))) < 4, 6000, "last tick goes to the bottom");
  log("last tick → bottom: ok");
  await page.locator(".turn-rail").hover();
  await until(async () => page.locator(".turn-list").isVisible(), 4000, "list on the long session");
  assert((await page.locator(".turn-row").count()) === 200, "the list still holds every round");
  const listScrollable = await page.evaluate(() => {
    const l = document.querySelector(".turn-list");
    return { sh: l.scrollHeight, ch: l.clientHeight, atBottom: l.scrollHeight - l.scrollTop - l.clientHeight < 2 };
  });
  log("list scroll:", JSON.stringify(listScrollable));
  assert(listScrollable.sh > listScrollable.ch, "200 rows scroll inside the list instead of growing the popover");
  assert(listScrollable.atBottom, "the list opens at the newest round");
  const lastTickCur = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".turn-tick")];
    return tiles[tiles.length - 1].classList.contains("cur");
  });
  assert(lastTickCur, "the last tick is still the current one on a long session");
  await page.locator(".turn-row").nth(199).hover();
  await page.screenshot({ path: path.join(OUT, "4-long.png") });

  // 8) 只有一轮时不出现带子（缩略图对一个回合没有意义）。
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 12, 8000, "back to A");
  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
