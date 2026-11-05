/**
 * Probe: 置顶横向栏里「当前会话」要看得出来（D76）。
 *
 * 这条横栏只在**左栏收起**时出现（`renderPinStrip()` 里 `collapsed.sessions && min-width:900px`），
 * 而收起之后它就是唯一的会话入口 —— 没有标记时每颗胶囊长得一模一样，不知道自己在跟哪个会话说话。
 *
 * 断言四件事：
 *   1. 打开 A 再收起左栏 → A 的胶囊带 `.cur`、带 `aria-current`，而且**真的算出了填充色**；
 *   2. 点胶囊打开 B → `.cur` 搬过去，A 恢复普通底色；
 *   3. 切到未置顶的 C（D128 之后不再自动置顶）→ 横栏里没有 C，也没有任何一颗带 `.cur` ——
 *      当前会话不在横栏里这件事由顶栏那颗 NowChip（#96）负责说明；
 *   4. 展开左栏 → 整条横栏藏起来（回到左栏自己的 `.session-card.active`）。
 *
 * 桩桥，不碰真 pi；一秒级、可重复。
 *
 * Run: npm run build:web && node probes/pin-current.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PIN_DIST 指向另一份产物（比如 main 的 web/dist）时，这个探针就变成「改之前」的对照：
// 断言应当失败，但截图仍然是同一条横栏，方便把 before/after 摆在一起看。
const DIST = process.env.PIN_DIST ? path.resolve(process.env.PIN_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.PIN_SHOT ?? "pin-current";
const PORT = 7898;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

async function launchPlaywright() {
  const cache = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx");
  const candidates = [process.env.PW_PATH, path.join(REPO, "node_modules/playwright/index.mjs")].filter(Boolean);
  try {
    for (const dir of fs.readdirSync(cache)) candidates.push(path.join(cache, dir, "node_modules/playwright/index.mjs"));
  } catch {
    /* no npx cache */
  }
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      await mod.chromium.launch().then((b) => b.close());
      return mod;
    } catch {
      /* half-installed playwright: try the next one */
    }
  }
  throw new Error("找不到可用的 playwright（设 PW_PATH=<.../playwright/index.mjs>）");
}

const state = (id, name) => ({
  id,
  name,
  cwd: `E:/demo/${id}`,
  file: null,
  owned: false,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});
const A = state("stub-a", "会话 A");
const B = state("stub-b", "会话 B");
const C = state("stub-c", "会话 C");
const SESSIONS = [A, B, C];
const MANAGE = { pin: [A.id, B.id], order: [], archived: [] };
const TUNNEL = { status: "off", url: null, error: null, updatedAt: Date.now() };
const ME = { version: "stub", pi: "stub", public: false, tunnel: TUNNEL, pushKey: null, pushCount: 0, sessionsRoot: "stub" };

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

const { WebSocketServer } = await import(pathToFileURL(path.join(REPO, "bridge/node_modules/ws/wrapper.mjs")).href);
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
      const s = SESSIONS.find((x) => x.id === msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      // D128：打开不改排列。桩桥只回快照，不写 pin —— 真桥也是这么做的。
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(BASE, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });

const toggleLeft = async () => {
  await page.locator('.side-toggle[data-side="left"]').click();
  await sleep(500);
};
/** 每颗胶囊：名字 + 是否 .cur + 算出来的底色 + aria-current。 */
const chips = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".pin-strip .pin-chip")].map((c) => {
      const cs = getComputedStyle(c);
      return {
        name: c.querySelector(".pin-name")?.textContent ?? "",
        cur: c.classList.contains("cur"),
        aria: c.getAttribute("aria-current"),
        bg: cs.backgroundColor,
        border: cs.borderTopColor,
        weight: c.querySelector(".pin-name") ? getComputedStyle(c.querySelector(".pin-name")).fontWeight : "",
      };
    }),
  );

const pick = (list, name) => list.find((c) => c.name.includes(name));

// 1) 打开 A，收起左栏 → 横栏出现，A 是当前
await page.locator('.session-card[data-id="stub-a"]').click();
await sleep(500);
await toggleLeft();
await page.waitForSelector(".pin-chip", { timeout: 10000 });
let list = await chips();
ok(list.length >= 2, `置顶条里有 ${list.length} 颗会话胶囊`);
const a = pick(list, "会话 A");
const b = pick(list, "会话 B");
ok(a?.cur === true, "打开 A 后，A 的胶囊被标成当前");
ok(a?.aria === "true", "当前胶囊带 aria-current=true");
ok(a.bg !== b.bg && a.border !== b.border, `当前胶囊与普通胶囊外观不同（底色 ${a.bg} vs ${b.bg}）`);
ok(a.weight === "600" && b.weight !== "600", `当前胶囊的名字加粗（${a.weight} vs ${b.weight}）`);
ok(b.cur === false && b.aria === null, "B 的胶囊没有任何当前标记");

// 给报告用的证据：这一刻 A 是当前会话，横栏里应当只有它填色。
const shotDir = path.join(REPO, ".scratch");
fs.mkdirSync(shotDir, { recursive: true });
await page.screenshot({ path: path.join(shotDir, `${SHOT}-on.png`), clip: { x: 0, y: 0, width: 1440, height: 120 } });

// 2) 点 B 的胶囊 → 标记搬过去，A 复原
await page.locator('.pin-chip .pin-open[data-pin-key="stub-b:open"]').click();
await sleep(700);
list = await chips();
const a2 = pick(list, "会话 A");
const b2 = pick(list, "会话 B");
ok(b2?.cur === true && a2?.cur === false, "点了 B 的胶囊后，.cur 只在 B 上");
ok(b2.bg !== a2.bg && b2.border !== a2.border && b2.weight === "600", "外观跟着搬过去，A 恢复普通底色与字重");

// 3) 打开未置顶的 C → D128：它不会自己进横栏，横栏里也就不该有 .cur
await toggleLeft(); // 展开左栏
await page.locator('.session-card[data-id="stub-c"]').click();
await sleep(700);
await toggleLeft(); // 再收起
await page.waitForSelector(".pin-chip", { timeout: 10000 });
list = await chips();
const c = pick(list, "会话 C");
ok(c === undefined, "没置顶的 C 不会出现在置顶条里（D128 废止了打开即置顶）");
ok(list.filter((x) => x.cur).length === 0, "于是整条里没有一颗「当前」（当前会话由顶栏那颗说明）");

// 4) 展开左栏 → 横栏藏起来
await toggleLeft();
ok(await page.locator(".pin-strip").isHidden(), "展开左栏后，置顶条重新隐藏（交还给左栏的 .active）");

await page.locator('.side-toggle[data-side="left"]').click(); // 收起来再拍一张：当前会话未置顶时这条里空着
await sleep(500);
await page.screenshot({ path: path.join(REPO, ".scratch/pin-current-off.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
