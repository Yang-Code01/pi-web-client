/**
 * Probe: 轮次刻度带「一下点中」—— 用户报障：除了第一轮，别的轮次要连点三次才能把它顶到视口最上面。
 *
 * 原因（D265 的补充）有三条，这里各钉一条用例：
 *   1. 收起时那根短横**不是点击目标**（`.turn-row` 是 `pointer-events:none`，上面盖着空的 `.turn-hit`），
 *      第一下只能把面板"打开"，跳不了 —— 现在按下就按短横算，一击即跳；
 *   2. 面板是 `clip-path` 长出来的，左边那片前 0.2 秒还属于正文，点击穿过去落空；而且动画期间按下在
 *      正文、抬起在行上时，浏览器把 click 派发给**共同祖先**，行上的处理器根本不跑 —— 现在按下时
 *      记下几何命中的那一行、抬起就认，并挡住随后那次原生 click；
 *   3. 行原来是 26px 高、格距 28px，那 2px 缝点在 `.turn-rows` 上（没有处理器）—— 现在行高 = 格距。
 *
 * Run: npm run build:web && node probes/rail-click.mjs
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

const PORT = Number(process.env.PI_WEB_PORT ?? 7914);
const OUT = path.join(REPO, ".scratch/rail-click/shots");
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

/** 会话 A 最后一轮的回答：一屏放不下，顶对齐才看得出跳转落在哪儿（不靠手数行数，靠行数阈值）。 */
const LAST_ANSWER = Array.from(
  { length: 32 },
  (_, k) => `- 第 ${k + 1} 条：把 exam-lock.js 里的 buildModal() 换成共用的一份，缺的月份不许留空白页，其余一行不动。`,
).join("\n");

const items = (n, longLast = false) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const text = i < ASK.length ? ASK[i] : `第 ${i + 1} 轮：继续补齐第 ${i + 1} 套卷子，并检查解析是否折叠正常。`;
    out.push({ id: `u${i}`, kind: "user", text, images: [], ts: new Date(Date.now() - (n - i) * 60000).toISOString() });
    out.push({
      id: `a${i}`,
      kind: "assistant",
      text: longLast && i === n - 1
        ? LAST_ANSWER
        : `${ROUND_TEXT}\n\n- 第 ${i + 1} 轮要点一：把 exam-lock.js 里的 buildModal() 换掉\n- 第 ${i + 1} 轮要点二：.lk-foot 改成右对齐\n- 第 ${i + 1} 轮要点三：其余一行不动。`,
      thinking: "",
      model: "probe",
      ts: new Date(Date.now() - (n - i) * 59000).toISOString(),
    });
  }
  return out;
};

const base = (id, name, n, longLast = false) => ({
  id, name, cwd: path.join(REPO, ".scratch/probe-work/exam"), file: null, owned: true, origin: "web", running: false, done: false,
  updatedAt: Date.now(), approvals: 0, asks: 0, locked: false, preview: "", items: items(n, longLast),
});
// A 的最后一轮故意比一屏还高：点最后一轮才有可顶到的顶部（否则只能贴底，那是另一个分支）。
const A = base("probe-a", "考试模块 · 12 轮", 12, true);
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
/** 悬停那块透明的 .turn-hit，等面板真的展开并落定（`.open` + `.settled`）——
 *  `.turn-list` 的 isVisible() 只看元素有没有尺寸，被 clip-path 裁掉时也是 true，靠不住；
 *  已经展开时再 hover .turn-hit 会撞上 pointer-events:none —— 它被自己的面板盖住了。 */
async function openPanel(page) {
  if (await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open"))) return;
  await page.locator(".turn-hit").hover();
  await until(async () => page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open")), 4000, "the list opens");
  await until(async () => page.evaluate(() => document.querySelector(".turn-rail").classList.contains("settled")), 4000, "the expansion settles");
}
const scrollTop = (page) => page.evaluate(() => document.querySelector(".chat-scroll").scrollTop);
const maxScroll = (page) => page.evaluate(() => {
  const s = document.querySelector(".chat-scroll");
  return s.scrollHeight - s.clientHeight;
});

// ---------------------------------------------------------------------------------------------
const S = (page) => page.evaluate(() => {
  const sc = document.querySelector(".chat-scroll");
  const top = sc.getBoundingClientRect().top;
  const users = [...document.querySelectorAll(".chat-scroll .msg.user")];
  const hit = users.filter((n) => n.getBoundingClientRect().top <= top + 8).pop();
  return {
    topTurn: hit ? users.indexOf(hit) : null,
    top: hit ? Math.round((hit.getBoundingClientRect().top - top) * 10) / 10 : null,
    rail: document.querySelector(".turn-rail").className,
  };
});
const isOpenSettled = (page) => page.evaluate(() => {
  const c = document.querySelector(".turn-rail").classList;
  return c.contains("open") && c.contains("settled");
});
const backToBottom = async (page) => {
  await page.mouse.move(20, 20);
  await until(async () => !(await page.evaluate(() => document.querySelector(".turn-rail").classList.contains("open"))), 3000, "rail closed");
  await page.evaluate(() => { const s = document.querySelector(".chat-scroll"); s.scrollTop = s.scrollHeight; });
  await sleep(400);
};
/** 收起态某根短横此刻的屏幕位置。 */
const dashBox = (page, i) => page.evaluate((k) => {
  const r = document.querySelector(`.turn-row[data-i="${k}"]`).getBoundingClientRect();
  return { x: r.right - 4, y: r.top + r.height / 2 };
}, i);
/** 一次人手点击：移过去停 pause 毫秒，按下停 80ms，抬起。 */
async function clickAt(page, x, y, pause) {
  await page.mouse.move(x, y);
  await sleep(pause);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
}

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await until(async () => (await page.locator(".session-card").count()) === 2, 8000, "two session cards");
  await page.locator('.session-card[data-id="probe-a"]').click();
  await until(async () => (await page.locator(".chat-scroll .msg.user").count()) === 12, 8000, "12 rounds");
  await sleep(500);

  const paneTop = await page.evaluate(() => document.querySelector(".chat-scroll").getBoundingClientRect().top);

  // 1) 收起态：只在短横上点一下（120ms 后就点，模拟人手），要一击跳到那一轮并把面板摊开
  for (const target of [8, 3]) {
    await backToBottom(page);
    const box = await dashBox(page, target);
    const before = await S(page);
    await clickAt(page, box.x, box.y, 120);
    await sleep(900);
    const after = await S(page);
    log(`收起态点短横 data-i=${target}: topTurn ${before.topTurn}→${after.topTurn} 距顶 ${after.top} 面板=${after.rail}`);
    assert(after.topTurn === target, `one click on a dash jumps to that turn (got ${after.topTurn}, want ${target})`);
    assert(Math.abs(after.top - 6) < 16, `the clicked turn lands at the top of the transcript (top ${after.top}, pane ${paneTop})`);
    assert(await isOpenSettled(page), "the panel opens after the click, so you can see where you landed");
  }

  // 2) 展开态：点一行（已经是常态），同样一击到位
  const rowBox = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".turn-row")]
      .map((r) => ({ i: Number(r.dataset.i), r: r.getBoundingClientRect() }))
      .filter((x) => x.r.top > 240 && x.r.bottom < 520)
      .sort((a, b) => a.r.top - b.r.top);
    // 挑离「当前」最远的那一行，免得点到已经是当前轮的上面、跳不跳都看不出来。
    const row = rows[rows.length - 1];
    return { i: row.i, x: row.r.x + row.r.width / 2, y: row.r.top + row.r.height / 2 };
  });
  await clickAt(page, rowBox.x, rowBox.y, 120);
  await sleep(900);
  const openCase = await S(page);
  log(`展开态点行 data-i=${rowBox.i}: topTurn=${openCase.topTurn} 距顶 ${openCase.top}`);
  assert(openCase.topTurn === rowBox.i, `one click on a row jumps to that turn (got ${openCase.topTurn}, want ${rowBox.i})`);

  // 3) 展开动画进行中，在「文字区」按下 —— 以前这里打在正文上、或被共同祖先吃掉
  await backToBottom(page);
  const rail = await rect(page, ".turn-rail");
  const band = await page.evaluate(() => {
    const r = document.querySelector(".turn-hit").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(band.x, band.y);          // 指针进带子 → 面板开始长
  await sleep(60);
  const spot = { x: rail.right - 160, y: rail.top + 150 };   // 面板左侧那片「还没长出来」的区域
  const before3 = await S(page);
  await clickAt(page, spot.x, spot.y, 20);
  await sleep(900);
  const after3 = await S(page);
  log(`动画中在文字区点：topTurn ${before3.topTurn}→${after3.topTurn}（以前是纹丝不动）`);
  assert(after3.topTurn !== before3.topTurn || before3.topTurn === null, `a click during the expansion is not swallowed (topTurn stayed ${before3.topTurn})`);

  // 4) 行的边界（原来那 2px 缝）：点在行底边那一像素上，也要跳到这一行
  const edge = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".turn-row")]
      .map((r) => ({ i: Number(r.dataset.i), r: r.getBoundingClientRect() }))
      .filter((x) => x.r.top > 240 && x.r.bottom < 520)
      .sort((a, b) => a.r.top - b.r.top);
    const row = rows[1];
    return { i: row.i, x: row.r.x + row.r.width / 2, y: row.r.bottom - 1 };
  });
  await clickAt(page, edge.x, edge.y, 120);
  await sleep(900);
  const edgeCase = await S(page);
  log(`点行底边（data-i=${edge.i}）：topTurn=${edgeCase.topTurn}`);
  assert(edgeCase.topTurn === edge.i, `clicking the last pixel of a row still picks that row (got ${edgeCase.topTurn}, want ${edge.i})`);

  log("ALL OK");
} finally {
  await browser?.close();
  server.close();
  wss.close();
}
