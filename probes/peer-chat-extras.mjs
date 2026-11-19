/**
 * 内网通聊天增强的端到端探针：弹框最大化、表情面板、我的表情、表情回应、聊天记录搜索、
 * 看图、多选转发。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-chat-extras.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口>
 * 例：node probes/peer-chat-extras.mjs 17870 17876 17877
 * 全过退出 0；任何一项红退出 1。
 */
import zlib from "node:zlib";
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2).map(Number);
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-chat-extras.mjs <A bridge> <B bridge> <B peer>");
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
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "test" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
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
  raw: async (p, buf) => {
    const res = await fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: buf });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  },
});

/** 一张纯色 PNG（不依赖图像库）。 */
function png(w, h, rgb) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat([...Array(w)].map(() => Buffer.from(rgb)))]);
  const raw = Buffer.concat([...Array(h)].map(() => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ca = await login(A);
const cb = await login(B);
check("两边都登录上", ca.includes("=") && cb.includes("="));
const a = api(A, ca);
const b = api(B, cb);
const aId = (await a.get("/api/peer")).status?.nodeId;
const bId = (await b.get("/api/peer")).status?.nodeId;
check("拿到两边的 nodeId", Boolean(aId && bId));

// 配对：A 手动加 B 的地址，等互相在线；再互相「快捷添加」才能聊天。
await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
let online = false;
for (let i = 0; i < 30 && !online; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  online = list.some((c) => c.nodeId === bId && c.online);
  if (!online) await sleep(500);
}
check("A 看见 B 在线", online);
await a.post("/api/peer/friend", { peer: bId, action: "quick", on: true });
await b.post("/api/peer/friend", { peer: aId, action: "quick", on: true });
// 重跑时别被上一轮留下的草稿干扰。
await a.post("/api/peer/thread", { peer: bId, draft: "" });
// 每轮一个新记号：重跑时只看这一轮发的那条，不被上一轮的回应 / 命中干扰。
const TOKEN = `搜索目标${Date.now().toString(36)}`;
const s1 = await a.post("/api/peer/send", { peer: bId, text: `探针 ${TOKEN} 第一条` });
check("A 发一条文字", s1.ok, JSON.stringify(s1.data));
await a.raw(`/api/peer/upload?peer=${bId}&name=${encodeURIComponent("大图.png")}`, png(640, 400, [40, 120, 200]));
await a.raw(`/api/peer/upload?peer=${bId}&name=${encodeURIComponent("第二张.png")}`, png(500, 500, [200, 80, 40]));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 860 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// ---- 1. 弹框最大化（主页面里的内网通弹框）
await page.goto(`${A}/`);
await page.waitForSelector('[data-act="peer"]', { timeout: 15000 });
await page.evaluate(() => localStorage.removeItem("pi-web.peer.max"));
await page.click('[data-act="peer"]');
await page.waitForSelector(".peer-sheet .peer-max", { timeout: 10000 });
const small = await page.$eval(".peer-sheet", (el) => el.getBoundingClientRect().width);
await page.click(".peer-sheet .peer-max");
await sleep(250);
const big = await page.$eval(".peer-sheet", (el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
check("最大化后铺满窗口", big[0] >= 1270 && big[1] >= 850 && big[0] > small, `${small} → ${big.join("x")}`);
check("最大化记进 localStorage", (await page.evaluate(() => localStorage.getItem("pi-web.peer.max"))) === "1");
await page.click(".peer-sheet .peer-max");
await sleep(250);
const back = await page.$eval(".peer-sheet", (el) => el.getBoundingClientRect().width);
check("再点一下还原", back < 1270, String(back));

// ---- 后面直接在 /peer 页面上测
await page.goto(`${A}/peer`);
await page.waitForSelector(`#list [data-id="${bId}"], #list .row`, { timeout: 15000 });
const row = (await page.$(`#list [data-id="${bId}"]`)) ?? (await page.$("#list .row"));
await row.click();
await page.waitForSelector(".stream .msg", { timeout: 10000 });

// ---- 2. 表情面板：插进输入框、Esc 关
await page.click(".peer-rich");
await page.keyboard.type("你好");
await page.click(".emoji-btn");
await page.waitForSelector(".emoji-panel .ep-e");
const firstEmoji = await page.$eval(".emoji-panel .ep-e", (el) => el.textContent);
await page.click(".emoji-panel .ep-e");
const typed = await page.$eval(".peer-rich", (el) => el.textContent);
check("点表情插进输入框（光标处）", typed === `你好${firstEmoji}`, typed);
check("插完面板还开着（可连点）", Boolean(await page.$(".emoji-panel")));
await page.keyboard.press("Escape");
check("Esc 关表情面板", !(await page.$(".emoji-panel")));
await page.keyboard.press("Enter");
await page.waitForFunction((e) => [...document.querySelectorAll(".stream .msg .bub")].some((b) => b.textContent.includes(e)), firstEmoji, { timeout: 8000 });
check("带表情的消息发出去了", true);

// ---- 3. 我的表情：API 加一张 → 面板里出现 → 点了直接发
const add = await a.raw(`/api/peer/stickers/add?name=${encodeURIComponent("猫.png")}`, png(96, 96, [250, 200, 60]));
check("收藏一张表情", add.ok, JSON.stringify(add.data));
await page.click(".emoji-btn");
await page.click(".emoji-panel .ep-tab:nth-child(2)");
await page.waitForSelector(".emoji-panel .ep-s img", { timeout: 5000 });
const before = await page.$$eval(".stream .msg", (n) => n.length);
await page.click(".emoji-panel .ep-s:not(.ep-add)");
await page.waitForFunction((n) => document.querySelectorAll(".stream .msg").length > n, before, { timeout: 8000 });
check("点收藏表情 = 发出去，且按表情画（.pic.sticker）", Boolean(await page.$(".stream .msg:last-child .pic.sticker")));
check("发完面板收起", !(await page.$(".emoji-panel")));

// ---- 4. 表情回应：右键菜单最上面一排，点 👍；对方那边也能看到
const target = page.locator(".stream .msg", { hasText: TOKEN }).first();
await target.click({ button: "right" });
await page.waitForSelector(".menu .rstrip button");
await page.click(".menu .rstrip button");
await target.locator(".reacts .react.on").waitFor({ timeout: 8000 });
check("自己这边出现回应 chip", true);
let seen = false;
for (let i = 0; i < 20 && !seen; i++) {
  const msgs = (await b.get(`/api/peer/messages?peer=${aId}&limit=50`)).entries ?? [];
  seen = msgs.some((m) => (m.text ?? "").includes(TOKEN) && (m.reactions ?? []).some((r) => r.who.includes(aId)));
  if (!seen) await sleep(400);
}
check("对方那边也收到了回应", seen);
await target.locator(".reacts .react.on").click();
await target.locator(".reacts .react").waitFor({ state: "detached", timeout: 8000 });
check("再点 chip = 取消回应", true);

// ---- 5. 聊天记录内搜索
await page.keyboard.press("Control+f");
await page.waitForSelector(".searchbar input");
await page.fill(".searchbar input", TOKEN);
await page.waitForFunction(() => document.querySelectorAll(".stream .msg.hit").length > 0, null, { timeout: 5000 });
const cnt = await page.$eval(".searchbar .cnt", (el) => el.textContent);
check("搜到并计数", cnt === "1 / 1", cnt);
check("当前命中高亮", Boolean(await page.$(".stream .msg.hit.cur")));
await page.fill(".searchbar input", "不存在的字串xyz");
await page.waitForFunction(() => document.querySelector(".searchbar .cnt")?.textContent === "没有结果", null, { timeout: 5000 });
check("搜不到显示「没有结果」", true);
await page.press(".searchbar input", "Escape");
check("Esc 关搜索条", !(await page.$(".searchbar")));

// ---- 6. 看图：点图打开，左右翻，Esc 关
await page.click(".stream .pic:not(.sticker) img");
await page.waitForSelector(".iv .iv-img");
const c1 = await page.$eval(".iv-count", (el) => el.textContent);
check("看图器打开，能看到「几 / 几」", /\d+ \/ \d+/.test(c1), c1);
await page.keyboard.press("ArrowRight");
const c2 = await page.$eval(".iv-count", (el) => el.textContent);
check("→ 翻到下一张", c1 !== c2, `${c1} → ${c2}`);
const pct1 = await page.$eval(".iv-pct", (el) => el.textContent);
await page.keyboard.press("+");
const pct2 = await page.$eval(".iv-pct", (el) => el.textContent);
check("+ 放大", pct1 !== pct2, `${pct1} → ${pct2}`);
await page.keyboard.press("Escape");
check("Esc 关看图器", !(await page.$(".iv")));

// ---- 7. 多选 + 转发
await target.click({ button: "right" });
await page.locator(".menu button", { hasText: "多选" }).click();
await page.waitForSelector(".pickbar");
const picked = await page.$eval(".pickbar .cnt", (el) => el.textContent);
check("多选从右键那条开始勾", picked === "已选 1 条", picked);
check("多选时输入框换成操作条", !(await page.$(".compose .peer-rich")));
const bBefore = ((await b.get(`/api/peer/messages?peer=${aId}&limit=200`)).entries ?? []).length;
await page.locator(".pickbar .btn.pri").click();
await page.waitForSelector(".modal.fwd .fwd-row");
await page.click(`.modal.fwd .fwd-row`);
await page.locator(".modal.fwd footer .btn.pri").click();
await page.waitForFunction(() => !document.querySelector(".modal.fwd"), null, { timeout: 8000 });
await page.waitForFunction(() => !document.querySelector(".pickbar"), null, { timeout: 8000 }).catch(() => {});
check("转发完退出多选", !(await page.$(".pickbar")));
let grew = false;
for (let i = 0; i < 20 && !grew; i++) {
  grew = ((await b.get(`/api/peer/messages?peer=${aId}&limit=200`)).entries ?? []).length > bBefore;
  if (!grew) await sleep(400);
}
check("对方收到转发的那条", grew);

// ---- 8. 图片「添加到表情」
await page.locator(".stream .msg", { has: page.locator(".pic:not(.sticker)") }).first().click({ button: "right" });
await page.evaluate(() => (document.querySelector("#toast").textContent = ""));
await page.locator(".menu button", { hasText: "添加到表情" }).click();
await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.trim(), null, { timeout: 8000 });
const tip = await page.$eval("#toast", (el) => el.textContent);
check("添加到表情给出提示", tip.includes("已添加到我的表情"), tip);
const stickers = (await a.get("/api/peer/stickers")).stickers ?? [];
check("聊天图片进了我的表情", stickers.length >= 2, String(stickers.length));

check("页面没有未捕获异常", !errors.length, errors.join(" | "));
await browser.close();
console.log(bad ? `\n${bad} 项失败` : "\n全部通过");
process.exit(bad ? 1 : 0);
