/**
 * Probe: 打开即置顶 + 置顶条折叠（D125）。
 *
 * 起因（用户的报障）：会话管理里打开一个会话，它不一定在置顶区，收起左栏后那条横栏里什么标记
 * 都没有 —— 用户根本不知道自己在跟哪个会话说话。D125 的规则是「从任何入口打开会话，它就得在
 * 置顶区里」，并且置顶一多就把横栏折成一颗「＋N」，点开是一张全量列表。
 *
 * 断言六件事：
 *   1. 深链 `#/s/<id>` 首屏落地（openSession 的入口之一）→ 会话置顶，横栏里带 `.cur`；
 *   2. 左栏卡片点开一个从没置顶过的会话 → 桥收到 `opened`，它排到 `pin[0]`；
 *   3. 从「已归档」点开归档会话 → 自动解除归档 + 置顶（不再是归档态）；
 *   4. 置顶多到装不下一行 → 出现「＋N」，N 等于被藏起来的胶囊数，一颗胶囊都没横向溢出；
 *   5. 当前会话排在置顶区最后（比如别的标签页把它拖到最后）也不会被折进去；
 *   6. 点「＋N」→ 列表列出全部置顶会话，点其中被藏起来的那颗能直接打开它。
 *
 * 桩桥（照真桥的 `opened` 语义实现），不碰真 pi。
 *
 * Run: npm run build:web && node probes/pin-auto-open.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.PIN_DIST ? path.resolve(process.env.PIN_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.PIN_SHOT ?? "pin-auto-open";
const PORT = 7899;
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

// 10 个会话：装满一条横栏装不下的量。st-arch 一开始是归档态，st-deep / st-8 从没置顶过。
const SESSIONS = Array.from({ length: 10 }, (_, i) => state(`st-${i + 1}`, `会话 ${String(i + 1).padStart(2, "0")} 一个不算短的名字`));
const byId = (id) => SESSIONS.find((s) => s.id === id);
const ARCH = "st-arch";
SESSIONS.push(state(ARCH, "归档里的旧会话"));
const DEEP = "st-deep";
SESSIONS.push(state(DEEP, "深链打开的会话"));
SESSIONS.push(state("st-click", "左栏点开的会话"));

const MANAGE = { pin: SESSIONS.slice(0, 10).map((s) => s.id), order: [DEEP, "st-click"], archived: [ARCH] };
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
const cast = (msg) => {
  for (const client of wss.clients) if (client.readyState === 1) client.send(JSON.stringify(msg));
};
/** 桩桥照真桥（D125）的语义实现：打开 = 解除归档 + 插到 pin 最前 + 广播新排列。 */
const opened = (id) => {
  if (!byId(id)) return;
  MANAGE.archived = MANAGE.archived.filter((x) => x !== id);
  if (!MANAGE.pin.includes(id)) MANAGE.pin = [id, ...MANAGE.pin];
  MANAGE.order = MANAGE.order.filter((x) => x !== id);
};
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
      const s = byId(msg.sessionId);
      if (msg.type === "subscribe" && s) {
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: s, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "manage" && msg.action === "opened") {
        opened(String(msg.id ?? ""));
        cast({ type: "manage", manage: MANAGE });
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await launchPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 820 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

/** 横栏里现在有什么：每颗胶囊的名字 / 是否当前 / 是否藏起来 / 容器是否横向溢出。 */
const strip = () =>
  page.evaluate(() => {
    const host = document.querySelector(".pin-strip");
    return {
      overflow: host ? host.scrollWidth > host.clientWidth + 1 : false,
      more: document.querySelector(".pin-more")?.hidden === false ? document.querySelector(".pin-more").textContent.trim() : null,
      chips: [...document.querySelectorAll(".pin-strip .pin-chip:not(.pin-new):not(.pin-expand):not(.pin-more)")].map((c) => ({
        name: c.querySelector(".pin-name")?.textContent ?? "",
        cur: c.classList.contains("cur"),
        hidden: c.hidden,
      })),
    };
  });

// 1) 深链首屏：`#/s/st-deep` 是一个从没置顶过的会话
await page.goto(`${BASE}/#/s/${DEEP}`, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(800);
ok(MANAGE.pin[0] === DEEP, `深链打开的会话进了 pin[0]（pin[0] = ${MANAGE.pin[0]}）`);
ok(MANAGE.archived.includes(ARCH), "别的会话被打开，归档集合不受影响");

// 收起左栏，横栏才是唯一入口 —— 也就是报障现场
await page.locator('.side-toggle[data-side="left"]').click();
await sleep(600);
let box = await strip();
const deep = box.chips.find((c) => c.name.includes("深链"));
ok(deep?.cur === true, "深链会话的胶囊带 .cur");
ok(Boolean(box.more), `置顶多到装不下一行时折成「${box.more}」`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-folded.png`), clip: { x: 0, y: 0, width: 1000, height: 110 } });

// 2) 左栏卡片打开一个从没置顶过的会话
await page.locator('.side-toggle[data-side="left"]').click();
await sleep(400);
await page.locator('.session-card[data-id="st-click"]').click();
await sleep(700);
ok(MANAGE.pin[0] === "st-click", `左栏点开的会话也进了 pin[0]（pin[0] = ${MANAGE.pin[0]}）`);

// 3) 从「已归档」点开 → 解除归档 + 置顶
await page.locator('.session-sec[data-sec="archived"] .label').click();
await sleep(300);
await page.locator(`.session-card[data-id="${ARCH}"]`).click();
await sleep(700);
ok(!MANAGE.archived.includes(ARCH), "打开归档会话后它离开了归档");
ok(MANAGE.pin[0] === ARCH, `并且进了 pin[0]（pin[0] = ${MANAGE.pin[0]}）`);

// 4) 折叠：一条横栏装不下 → ＋N 顶上，且没有横向溢出（不需要横向滚动）
await page.locator('.side-toggle[data-side="left"]').click();
await sleep(600);
box = await strip();
const foldedAway = box.chips.filter((c) => c.hidden).length;
ok(Boolean(box.more), `折叠态出现（${box.more}）`);
ok(Number((box.more ?? "").replace(/\D/g, "")) === foldedAway, `「${box.more}」的数和藏起来的胶囊数一致（${foldedAway}）`);
ok(box.overflow === false, "折起来之后横栏没有再横向溢出");
ok(box.chips.some((c) => c.cur && !c.hidden), "当前会话那颗没被折断");

// 5) 当前会话被排到置顶区最后（比如另一个标签页把它拖到了末尾）也不能藏
const others = SESSIONS.filter((s) => MANAGE.pin.includes(s.id) && s.id !== ARCH).map((s) => s.id);
cast({ type: "manage", manage: { ...MANAGE, pin: [...others, ARCH] } });
await sleep(600);
box = await strip();
const last = box.chips[box.chips.length - 1];
ok(last?.cur === true, "排到最后的当前会话仍在条里");
ok(last?.hidden === false, "……而且没有被折叠藏起来");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-cur-last.png`), clip: { x: 0, y: 0, width: 1000, height: 110 } });

// 6) 点「＋N」→ 全量列表；挑一颗被藏起来的打开
const hiddenName = box.chips.find((c) => c.hidden)?.name ?? "";
await page.locator(".pin-more").click();
await sleep(400);
const rows = await page.evaluate(() => [...document.querySelectorAll(".pin-list .pm-item")].map((b) => b.querySelector(".pm-text")?.textContent ?? ""));
ok(rows.length === MANAGE.pin.length, `列表里有全部 ${MANAGE.pin.length} 颗置顶会话（实际 ${rows.length}）`);
ok(rows.some((n) => n && hiddenName.startsWith(n.slice(0, 4))), `被折起来的那颗（${hiddenName.slice(0, 6)}）在列表里`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-list.png`), clip: { x: 0, y: 0, width: 1000, height: 420 } });
const wantId = MANAGE.pin.find((id) => id !== ARCH && byId(id)?.name === hiddenName) ?? MANAGE.pin[0];
await page.locator(`.pin-list .pm-item[data-session-id="${wantId}"]`).click();
await sleep(700);
const now = await page.evaluate(() => location.hash.slice(4));
ok(now === wantId, `点列表里的一行就打开了它（hash = ${now}）`);
ok((await page.locator(".pin-list").count()) === 0, "选完之后列表收掉了");

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
