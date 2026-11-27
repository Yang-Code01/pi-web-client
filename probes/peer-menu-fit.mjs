/**
 * 探针：内网通里「贴着某条消息」弹出来的菜单，必须整块留在窗口里（#701 之后的回归）。
 *
 * 现场：右键自己那条贴右边的消息，客户端把菜单左边界按「窗口宽 - 180」硬夹，可它上面还多着一排
 * 快捷回应的 emoji（`.rstrip`，六个 30px 按钮 → 菜单实际宽 200px 上下），于是右边缘被窗口切掉一截；
 * 竖向同理，夹的时候只算 `items.length * 34`，没算那排 emoji 和它的内边距，贴底消息的菜单会戳出去。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-menu-fit.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口>
 * 例：node probes/peer-menu-fit.mjs 17882 17886 17887
 * 全过退出 0；任何一项红退出 1。
 */
import fs from "node:fs";
import path from "node:path";
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2).map(Number);
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-menu-fit.mjs <A bridge> <B bridge> <B peer>");
  process.exit(2);
}
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;

let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "test" }),
        signal: AbortSignal.timeout(8000),
      });
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
      if (res.ok && cookie.includes("=")) return cookie;
    } catch {
      /* 实例刚起来时第一个 login 会挂一会儿 */
    }
    await sleep(500);
  }
  throw new Error(`${base} 登录不上`);
}
const api = (base, cookie) => ({
  get: async (p) => (await fetch(base + p, { headers: { cookie } })).json(),
  post: async (p, body) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  },
});

const OUT = path.join(".scratch", "peer-menu-fit");
fs.mkdirSync(OUT, { recursive: true });

const ca = await login(A);
const cb = await login(B);
const a = api(A, ca);
const b = api(B, cb);
const aId = (await a.get("/api/peer")).status?.nodeId;
const bId = (await b.get("/api/peer")).status?.nodeId;
check("两边都登录上、拿到 nodeId", Boolean(aId && bId));

await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
let online = false;
for (let i = 0; i < 40 && !online; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  online = list.some((c) => c.nodeId === bId && c.online);
  if (!online) await sleep(500);
}
check("A 看见 B 在线", online);
await a.post("/api/peer/friend", { peer: bId, action: "quick", on: true });
await b.post("/api/peer/friend", { peer: aId, action: "quick", on: true });
await a.post("/api/peer/thread", { peer: bId, draft: "" });
const TOKEN = `落位${Date.now().toString(36)}`;
check("B 先发一条（A 那条在他左侧）", (await b.post("/api/peer/send", { peer: aId, text: `探针 ${TOKEN} 对方` })).ok);
for (let i = 0; i < 20; i++) {
  const got = ((await a.get(`/api/peer/messages?peer=${bId}&limit=20`)).entries ?? []).filter((m) => (m.text ?? "").includes(TOKEN));
  if (got.length) break;
  await sleep(300);
}
check("A 自己也发一条（贴右边的那种）", (await a.post("/api/peer/send", { peer: bId, text: `探针 ${TOKEN} 我` })).ok);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 860 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${A}/peer`);
await page.waitForSelector(`#list [data-id="${bId}"], #list .row`, { timeout: 20000 });
const row = (await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"));
await row.click();
await page.waitForSelector(".stream .msg", { timeout: 15000 });
await page.waitForFunction((t) => [...document.querySelectorAll(".stream .msg")].filter((m) => m.textContent.includes(t)).length >= 2, TOKEN, { timeout: 15000 });

/** 菜单整块在视口里（左右各留 8px 边距可以，但一像素都不许出去）。 */
async function menuBox() {
  return page.evaluate(() => {
    const m = document.querySelector("#layer .menu");
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, hasStrip: Boolean(m.querySelector(".rstrip")) };
  });
}
async function expectInside(name) {
  await page.waitForSelector("#layer .menu", { timeout: 5000 });
  // mac 主题下菜单有 260ms 的入场缩放（`mac-menu-in`），动画期间 getBoundingClientRect 带着 transform，
  // 这时量会把「差 20px」和「差 0px」量混，等它停。
  await sleep(400);
  const box = await menuBox();
  const over = [];
  if (box.left < 7.5) over.push(`左 ${box.left.toFixed(1)}`);
  if (box.top < 7.5) over.push(`上 ${box.top.toFixed(1)}`);
  if (box.right > box.vw - 7.5) over.push(`右 ${(box.right - box.vw).toFixed(1)}px 出界`);
  if (box.bottom > box.vh - 7.5) over.push(`下 ${(box.bottom - box.vh).toFixed(1)}px 出界`);
  check(name, over.length === 0, `菜单 ${box.w}x${box.h} @ ${box.left.toFixed(0)},${box.top.toFixed(0)} 视口 ${box.vw}x${box.vh}${over.length ? "  ← " + over.join(" + ") : ""}`);
  return box;
}

const mineRow = page.locator(".stream .msg.mine", { hasText: TOKEN }).last();

// ---- 1. 右键自己那条、鼠标贴窗口右边缘：菜单连着 rstrip 一起整块留在窗口里
const mineBox = await mineRow.boundingBox();
await page.mouse.click(Math.min(mineBox.x + mineBox.width - 4, 1280 - 2), mineBox.y + 10, { button: "right" });
const box1 = await expectInside("右键贴右边：菜单整块在窗口里（含 emoji 排）");
check("这条菜单确实带 rstrip（否则测的不是那条路）", Boolean(box1?.hasStrip));
await page.screenshot({ path: path.join(OUT, "right-edge-menu.png") });
await page.keyboard.press("Escape");

// ---- 2. 微笑按钮：菜单只有一排 emoji，也不能出界
await mineRow.hover();
await mineRow.locator(".msg-quick").click();
await expectInside("微笑按钮：快捷回应菜单整块在窗口里");
await page.keyboard.press("Escape");

// ---- 3. 窗口缩到 720x420：菜单比可用的竖直空间还高时不硬塞，翻到上面压边距封顶
await page.setViewportSize({ width: 720, height: 420 });
await sleep(300);
await page.evaluate(() => {
  const s = document.querySelector(".stream");
  if (s) s.scrollTop = s.scrollHeight;
});
await sleep(200);
// 滚到最底，最后一条就贴着窗口底：右键它 = 竖向最坏的那个位置。
const lastBox = await page.locator(".stream .msg").last().boundingBox();
await page.mouse.click(Math.min(lastBox.x + lastBox.width - 6, 718), Math.min(lastBox.y + lastBox.height - 6, 418), { button: "right" });
const box3 = await expectInside("矮窗口贴底右键：菜单整块在窗口里（该翻上去就翻上去）");
await page.screenshot({ path: path.join(OUT, "short-window-menu.png") });
await page.keyboard.press("Escape");
check("矮窗口里菜单高度被封顶（不靠裁掉半行遮丑）", Boolean(box3 && box3.h <= 420 - 16), box3 ? `${box3.h}px` : "");

// ---- 4. 窄窗口：rstrip 比窗口还窄没问题，但不能从右边戳出去
await page.setViewportSize({ width: 420, height: 620 });
await sleep(300);
await mineRow.scrollIntoViewIfNeeded();
const b4 = await mineRow.boundingBox();
await page.mouse.click(Math.min(b4.x + b4.width - 2, 418), b4.y + 8, { button: "right" });
await expectInside("窄窗口（420px）右键：菜单整块在窗口里");
await page.keyboard.press("Escape");

check("页面没有 JS 报错", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(bad ? `\n${bad} 项没过` : "\n全过");
process.exit(bad ? 1 : 0);
