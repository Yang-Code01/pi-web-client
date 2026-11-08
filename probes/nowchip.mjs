/**
 * Probe: 顶栏那颗「当前在哪」（#96）。
 *
 * 票面要的是：左栏收起、展开时这颗都在；切会话 / 改工作区名 / 待处理数变化，它同一次渲染里
 * 跟着变；点它不做动作（所以这里也断言它不是按钮）；窄屏只剩这一颗。桩桥照 #94 的协议发
 * `workspace` 快照（groups / overrides / keys），会话条目带 `ws`；`subscribe` 回来的 state
 * 故意**不带** ws —— 真桥也只由 `sessions.list` 给出，前端得自己回落到列表 / cwd 缓存。
 *
 * Run: npm run build:web && PI_WEB_PORT=7908 node probes/nowchip.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tools/playwright.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.NOWCHIP_DIST ? path.resolve(process.env.NOWCHIP_DIST) : path.join(REPO, "web/dist");
const SHOT = process.env.NOWCHIP_SHOT ?? "nowchip";
const PORT = Number(process.env.PI_WEB_PORT ?? 7908);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) bad += 1;
};

const state = (id, name, cwd, ws, owned = false) => ({
  id,
  name,
  cwd,
  ws,
  file: null,
  owned,
  origin: "disk",
  running: false,
  done: false,
  updatedAt: Date.now(),
  approvals: 0,
  asks: 0,
  preview: "",
  locked: false,
});

const A1 = "st-a1";
const A2 = "st-a2";
const B1 = "st-b1";
const SESSIONS = [
  state(A1, "追加开发", "F:/pi-web-client", "f:/pi-web-client", true),
  state(A2, "修桥的日志", "F:/pi-web-client/bridge", "f:/pi-web-client"),
  state(B1, "客户甲的后台", "D:/work/client-a", "d:/work/client-a"),
];
const byId = (id) => SESSIONS.find((s) => s.id === id);

const workspace = () => ({
  groups: [
    { id: "f:/pi-web-client", name: "pi-web-client", key: "F:/pi-web-client", manual: false },
    { id: "d:/work/client-a", name: "客户甲", key: "D:/work/client-a", manual: false },
  ],
  overrides: {},
  keys: {
    "f:/pi-web-client": "F:/pi-web-client",
    "f:/pi-web-client/bridge": "F:/pi-web-client",
    "d:/work/client-a": "D:/work/client-a",
  },
});
const MANAGE = { pin: [], order: [A1, A2, B1], archived: [] };
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
        // 真桥的 state 不带 ws（它只挂在 sessions.list 的条目上）。
        const { ws: _ws, ...plain } = s;
        ws.send(JSON.stringify({ type: "session", sessionId: s.id, state: plain, items: [], approvals: [], asks: [], budget: null }));
      }
      if (msg.type === "manage" && msg.action === "opened") {
        const id = String(msg.id ?? "");
        MANAGE.order = [id, ...MANAGE.order.filter((x) => x !== id)];
        ws.send(JSON.stringify({ type: "manage", manage: MANAGE, workspace: workspace() }));
      }
    });
    ws.send(JSON.stringify({ type: "hello", me: ME, sessions: SESSIONS, manage: MANAGE, trash: [], tunnel: TUNNEL, workspace: workspace() }));
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 820 }, locale: "zh-CN" })).newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

/** 那颗现在长什么样：藏没藏、写了什么、色点是什么颜色、角标是不是同一套。 */
const chip = () =>
  page.evaluate(() => {
    const el = document.querySelector(".now-chip");
    if (!el) return null;
    const dot = el.querySelector(".now-dot");
    const live = el.querySelector(".now-live");
    const badge = el.querySelector(".badge");
    return {
      hidden: el.hidden || getComputedStyle(el).display === "none",
      name: el.querySelector(".now-name")?.textContent ?? "",
      label: el.getAttribute("aria-label"),
      accent: dot && !dot.hidden ? getComputedStyle(dot).backgroundColor : "",
      live: live && !live.hidden ? live.className : "",
      badge: badge && !badge.hidden ? badge.textContent : "",
      badgeCls: badge ? badge.className : "",
      buttons: el.querySelectorAll("button").length,
      count: [...document.querySelectorAll(".now-chip")].filter((x) => x.getClientRects().length).length,
    };
  });

/** 那颗上写的是会话名（#126）：四套壳的顶栏标题都被 CSS 藏了，这名字只在这一颗上看得见。 */
const barTitle = () => page.evaluate(() => document.querySelector(".topbar .title")?.textContent ?? "");

await page.goto(`${BASE}/#/s/${A1}`, { waitUntil: "networkidle" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', "probe");
  await page.click('button:has-text("进入")');
}
await page.waitForSelector(".session-card", { timeout: 15000 });
await sleep(800);

// 1) 左栏展开：这颗在，内容 = 会话名（工作区名只留在 aria-label 上）
let c = await chip();
ok(c !== null, "左栏展开时这颗在顶栏");
ok(c?.hidden === false && c?.count === 1, "只渲染一颗，且是可见的");
ok(c?.name === "追加开发", `展开态写着会话「${c?.name}」`);
ok((await barTitle()) === "追加开发", `顶栏标题那颗也在（${await barTitle()}）`);
ok(c?.label === "pi-web-client，追加开发，当前会话", `aria-label = ${c?.label}`);
ok(Boolean(c?.accent) && c?.accent !== "rgba(0, 0, 0, 0)", `工作区色点有颜色（${c?.accent}）`);
ok((c?.live ?? "").includes("live"), "本地会话的在线点是绿的");
ok(c?.buttons === 0, "它不是按钮（票面：指示，不做动作）");
const a1Accent = c?.accent;
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-expanded.png`), clip: { x: 0, y: 0, width: 1000, height: 110 } });

// 2) 左栏收起：还在（横栏不是它的替代品）
await page.locator('.side-toggle[data-side="left"]').click();
await sleep(500);
c = await chip();
ok(c?.hidden === false && c?.count === 1, "左栏收起后这颗仍在");
ok((await barTitle()) === "追加开发", "收起后名字没丢（那颗上还在）");
ok((await page.locator(".pin-strip").isVisible()) === true, "（对照）收起时横栏也在，但那是另一条东西");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-collapsed.png`), clip: { x: 0, y: 0, width: 1000, height: 140 } });
await page.locator('.side-toggle[data-side="left"]').click();
await sleep(400);

// 3) 切会话：名字 / 工作区 / 颜色 / 读屏文案立刻换
await page.locator(`.session-card[data-id="${B1}"]`).click();
await sleep(600);
c = await chip();
ok(c?.name === "客户甲的后台" && (await barTitle()) === "客户甲的后台", `切会话后这颗写着「${c?.name}」`);
ok(c?.label === "客户甲，客户甲的后台，当前会话", `读屏跟着换（${c?.label}）`);
ok(Boolean(c?.accent) && c?.accent !== a1Accent, `色点换成另一个工作区的颜色（${c?.accent} ≠ ${a1Accent}）`);
const b1Accent = c?.accent;

// 4) 待处理：角标与本地队列一致，消掉就消失（树里用的也是 .badge.wait 这一套）
cast({ type: "approval.add", sessionId: B1, approval: { id: "ap-1", sessionId: B1, title: "rm -rf", message: "x", createdAt: Date.now() } });
await sleep(300);
c = await chip();
ok(c?.badge === "待确认" && c?.badgeCls.includes("wait"), `1 个待确认 → 角标「${c?.badge}」(${c?.badgeCls})`);
cast({ type: "approval.add", sessionId: B1, approval: { id: "ap-2", sessionId: B1, title: "git push", message: "y", createdAt: Date.now() } });
await sleep(300);
c = await chip();
ok(c?.badge === "待确认 2", `2 个待确认 → 角标「${c?.badge}」`);
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-pending.png`), clip: { x: 0, y: 0, width: 1000, height: 110 } });
cast({ type: "approval.remove", sessionId: B1, id: "ap-1" });
cast({ type: "approval.remove", sessionId: B1, id: "ap-2" });
await sleep(400);
c = await chip();
ok(c?.badge === "", "待确认清空后角标不占位置");

cast({
  type: "ask.add",
  sessionId: B1,
  ask: { id: "ask-1", sessionId: B1, sessionName: "客户甲的后台", createdAt: Date.now(), questions: [{ id: "q1", prompt: "继续吗？", options: [{ value: "y", label: "继续" }] }] },
});
await sleep(300);
c = await chip();
ok(c?.badge === "待回答", `待回答也走同一颗角标（${c?.badge}）`);
cast({ type: "ask.remove", sessionId: B1, id: "ask-1", reason: "测试" });
await sleep(300);
ok((await chip())?.badge === "", "问卷关掉后角标也收掉");

// 5) 改工作区名：同一份快照重画，颜色不跟着名字变
const renamed = workspace();
renamed.groups[1].name = "客户甲 · 二期";
cast({ type: "workspaces", workspace: renamed });
await sleep(300);
c = await chip();
ok(c?.name === "客户甲的后台", `改工作区名不动这颗（${c?.name}）`);
ok((c?.label ?? "").includes("客户甲 · 二期"), `新名字进了读屏文案（${c?.label}）`);
ok(c?.accent === b1Accent, `改名不动色点（${c?.accent}）`);

// 6) 800px：只剩这一颗（窄屏不提前做 #102 的四套）
await page.setViewportSize({ width: 800, height: 820 });
await sleep(500);
c = await chip();
ok(c?.hidden === false && c?.count === 1, "800px 宽下这颗仍在，而且只有一颗");
ok((await page.locator(".pin-strip").isVisible()) === false, "800px 下横栏不再出现");
await page.screenshot({ path: path.join(REPO, `.scratch/${SHOT}-narrow.png`), fullPage: false });

await browser.close();
await new Promise((r) => server.close(r));
console.log(bad ? `\n${bad} FAILURE(S)` : "\nall checks passed");
process.exitCode = bad ? 1 : 0;
