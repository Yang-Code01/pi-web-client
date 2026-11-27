/**
 * 内网通头像：默认随机一张、随 announce 同步、页面上真的画出来、「我」页能换。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-avatars.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口> [截图目录]
 * 例：node probes/peer-avatars.mjs 17880 17892 17893 .scratch/peer-avatars/shots
 * 全过退出 0；任何一项红退出 1。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2, 5).map(Number);
const SHOTS = process.argv[5] ?? "";
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-avatars.mjs <A bridge> <B bridge> <B peer> [截图目录]");
  process.exit(2);
}
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const IDS = ["cat", "bear", "rabbit", "penguin", "dog", "frog", "chick", "whale", "owl", "octopus", "pig", "dino"];
let bad = 0;
const check = (name, ok, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 画一张纯色 PNG：上传链路要的是浏览器真能解码的图，不能拿文本冒充。 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, [r, g, b, a]) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
  post: async (p, body) =>
    (await fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json().catch(() => ({})),
});

const ca = await login(A);
const cb = await login(B);
const a = api(A, ca);
const b = api(B, cb);

// ---- 1. 两边各有一张名单内的默认头像（12 张里随机挑的；可能撞车，所以不断言两边不同）
const aSt = (await a.get("/api/peer")).status;
const bSt = (await b.get("/api/peer")).status;
check("A 有默认头像", IDS.includes(aSt?.avatar), String(aSt?.avatar));
check("B 有默认头像", IDS.includes(bSt?.avatar), String(bSt?.avatar));
if (SHOTS) fs.writeFileSync(path.join(SHOTS, "avatars.txt"), `A=${aSt?.avatar} B=${bSt?.avatar}\n`);

// ---- 2. 加好友 + 说话，对方的头像要跟着 announce 过来
await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
for (let i = 0; i < 30; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  if (list.some((c) => c.nodeId === bSt.nodeId && c.avatar)) break;
  await sleep(300);
}
const aContacts = (await a.get("/api/peer/contacts")).contacts ?? [];
const rowB = aContacts.find((c) => c.nodeId === bSt.nodeId);
check("A 的通讯录里 B 带着头像", rowB?.avatar === bSt.avatar, `${rowB?.avatar} vs ${bSt.avatar}`);

await a.post("/api/peer/send", { peer: bSt.nodeId, text: "头像是自己挑的还是随机的？" });
await b.post("/api/peer/send", { peer: aSt.nodeId, text: "随机的，能换。" });
const aThreads = (await a.get("/api/peer/threads")).threads ?? [];
const tB = aThreads.find((t) => t.nodeId === bSt.nodeId);
check("A 的会话行里 B 带着头像", tB?.avatar === bSt.avatar, `${tB?.avatar} vs ${bSt.avatar}`);

// ---- 3. 页面上真画出来（SVG 能解码、尺寸 34px、没退回字母）
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 820 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${A}/peer`);
await page.waitForSelector("#list .row", { timeout: 15000 });
await sleep(800);

const rowShot = await page.evaluate((bId) => {
  const row = document.querySelector(`#list [data-id="${bId}"]`) ?? document.querySelector("#list .row");
  const av = row?.querySelector(".av");
  const img = row?.querySelector(".av-img");
  const box = av?.getBoundingClientRect();
  return {
    pic: Boolean(av?.classList.contains("pic")),
    letter: (av?.textContent ?? "").trim(),
    loaded: Boolean(img && img.complete && img.naturalWidth > 0),
    w: Math.round(box?.width ?? 0),
    h: Math.round(box?.height ?? 0),
  };
}, bSt.nodeId);
check("会话行里画的是图，不是首字母", rowShot.pic && !rowShot.letter, JSON.stringify(rowShot));
check("SVG 真的解码了（naturalWidth > 0）", rowShot.loaded);
check("头像还是 34px 那格", rowShot.w === 34 && rowShot.h === 34, `${rowShot.w}×${rowShot.h}`);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "list.png") });

// 气泡里的头像
await page.evaluate((bId) => document.querySelector(`#list [data-id="${bId}"]`)?.click(), bSt.nodeId);
await page.waitForSelector(".msg .bub", { timeout: 10000 });
await sleep(600);
const msgPics = await page.evaluate(() => [...document.querySelectorAll(".msg .av-img")].filter((i) => i.naturalWidth > 0).length);
check("气泡里的头像也画出来了", msgPics > 0, String(msgPics));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "chat.png") });

// ---- 3b. 对方换脸之后，列表里不能还显示「他换之前发消息时那张」：历史消息里的
//          `from.avatar` 是最旧的来源，不许覆盖在线表 / 通讯录。
const oldSrc = await page.evaluate((bId) => {
  const row = document.querySelector(`#list [data-id="${bId}"]`) ?? document.querySelector("#list .row");
  return row?.querySelector(".av-img")?.getAttribute("src") ?? "";
}, bSt.nodeId);
const freshB = IDS.find((id) => id !== bSt.avatar) ?? IDS[0];
await b.post("/api/peer/config", { avatar: freshB });
// 桥的 poll 是 5 秒一轮：固定 sleep 会跟它赛跑（偶尔 1.5 秒时缓存还是旧脸）。
// 等到 A 的桥真的看见新头像再刷新，断言才有意义。
for (let i = 0; i < 40; i++) {
  const st = await a.get("/api/peer");
  if (st.status?.online?.find((p) => p.nodeId === bSt.nodeId)?.avatar === freshB) break;
  await sleep(250);
}
await page.reload();
await page.waitForSelector("#list .row", { timeout: 15000 });
await sleep(1200);
const newSrc = await page.evaluate((bId) => {
  const row = document.querySelector(`#list [data-id="${bId}"]`) ?? document.querySelector("#list .row");
  return row?.querySelector(".av-img")?.getAttribute("src") ?? "";
}, bSt.nodeId);
check("B 换脸后 A 的列表跟着换（历史消息不反盖）", Boolean(newSrc) && newSrc !== oldSrc && Boolean(oldSrc));

// ---- 4. 「我」页：默认落在个人资料（hero 是图）；头像分区 12 张、当前那张被选中、点一张就换
await page.click('#rail button[title="我"]');
await page.waitForSelector(".me-nav", { timeout: 10000 });
await sleep(300);
const heroOnLoad = await page.evaluate(() => Boolean(document.querySelector(".me-hero .me-ava .av.pic .av-img")));
check("「我」页 hero 上是我自己的头像图", heroOnLoad);
await page.click('.me-nav .me-tab:has-text("头像")');
await page.waitForSelector(".me-avgrid .avpick", { timeout: 10000 });
await sleep(500);
const grid = await page.evaluate(() => ({
  count: document.querySelectorAll(".me-avgrid .avpick:not(.me-custom)").length,
  loaded: [...document.querySelectorAll(".me-avgrid .avpick:not(.me-custom) img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  on: document.querySelectorAll(".me-avgrid .avpick.on").length,
}));
check("「头像」分区有 12 张内置可选", grid.count === IDS.length, String(grid.count));
check("12 张图都解码成功", grid.loaded === IDS.length, String(grid.loaded));
check("当前那张被标出来（恰好一处）", grid.on === 1, String(grid.on));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "me.png") });

// 点一张不是当前那张的
await page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".me-avgrid .avpick:not(.me-custom)")];
  tiles[tiles.findIndex((t) => !t.classList.contains("on"))].click();
});
await sleep(1200);
const afterA = (await a.get("/api/peer")).status;
check("点了就换（配置里也换了）", afterA.avatar !== aSt.avatar && IDS.includes(afterA.avatar), `${aSt.avatar} → ${afterA.avatar}`);
// 成功提示：它靠 setConfig() 的返回值判定，改成无条件弹的话失败了也说「换好了」。
const toasted = await page.evaluate(() => [...document.querySelectorAll(".toast, .toasts > *")].some((n) => /头像换好了/.test(n.textContent ?? "")));
check("换完弹了「头像换好了」", toasted);
// 换完停在头像分区；回个人资料看 hero 是不是也换了。
await page.click('.me-nav .me-tab:has-text("个人资料")');
await page.waitForSelector(".me-hero .me-ava .av-img", { timeout: 5000 });
const heroAfter = await page.evaluate(() => Boolean(document.querySelector(".me-hero .me-ava .av.pic .av-img")));
check("换完 hero 还是图", heroAfter);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "me-after.png") });

// ---- 5. B 那边刷新就看见 A 的新头像
await b.post("/api/peer/refresh", {});
for (let i = 0; i < 30; i++) {
  const list = (await b.get("/api/peer/contacts")).contacts ?? [];
  if (list.find((c) => c.nodeId === aSt.nodeId)?.avatar === afterA.avatar) break;
  await b.post("/api/peer/refresh", {});
  await sleep(300);
}
const bRow = ((await b.get("/api/peer/contacts")).contacts ?? []).find((c) => c.nodeId === aSt.nodeId);
check("B 那边看到 A 的新头像", bRow?.avatar === afterA.avatar, `${bRow?.avatar} vs ${afterA.avatar}`);

// ---- 6. 自定义头像：上传两张 → 历史可切换 → 点头像看大图 → 删除（含删当前那张）
await page.click('.me-nav .me-tab:has-text("头像")');
await page.waitForSelector(".me-avrow input[type=file]", { state: "attached" });
const upload = async (name, buf, prev = "") => {
  await page.setInputFiles(".me-avrow input[type=file]", { name, mimeType: "image/png", buffer: buf });
  for (let i = 0; i < 40; i++) {
    const id = String((await a.get("/api/peer")).status?.avatar ?? "");
    if (id.startsWith("custom:") && id !== prev) return id;
    await sleep(250);
  }
  return "";
};
const firstId = await upload("red.png", makePng(140, 140, [230, 90, 70, 255]));
check("上传第一张自定义头像", /^custom:[0-9a-f]{16}$/.test(firstId), firstId);
await page.waitForSelector(".me-histpick", { timeout: 8000 });
const hist1 = await page.evaluate(() => ({
  n: document.querySelectorAll(".me-histpick").length,
  on: document.querySelectorAll(".me-histitem.on").length,
  imgs: [...document.querySelectorAll(".me-histpick img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  customOn: Boolean(document.querySelector(".me-custom.on img")),
}));
check("「上传过的」出现 1 张且解码成功", hist1.n === 1 && hist1.imgs === 1, JSON.stringify(hist1));
check("当前那张在历史里被标出来", hist1.on === 1);
check("自定义格显示的是当前这张图", hist1.customOn);

const secondId = await upload("blue.png", makePng(140, 140, [60, 130, 220, 255]), firstId);
check("上传第二张（换了新颜色）", secondId.startsWith("custom:") && secondId !== firstId, `${firstId} → ${secondId}`);
await page.waitForSelector(".me-histpick", { timeout: 8000 });
const hist2 = await page.evaluate(() => document.querySelectorAll(".me-histpick").length);
check("历史变成 2 张（最近在前）", hist2 === 2, String(hist2));
// 两张缩略图必须各自是自己那张字节：peer 的 `/avatar/<自己>` 以前无视 hash，一排图全回当前那张。
const digests = await page.evaluate(async () => {
  const out = [];
  for (const img of document.querySelectorAll(".me-histpick img")) {
    const buf = await (await fetch(img.src)).arrayBuffer();
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    out.push([...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return out;
});
check("两张历史缩略图内容不同", digests.length === 2 && digests[0] !== digests[1], digests.join(" / "));

// 切回第一张：点历史缩略图
await page.evaluate(() => document.querySelectorAll(".me-histpick")[1].click());
await sleep(1200);
const backTo = (await a.get("/api/peer")).status?.avatar;
check("点历史缩略图能切回上一张", backTo === firstId, `${backTo}`);

// 点头像看大图：大预览、聊天里的头像都该开灯箱，Esc 关掉
await page.click(".me-big");
await page.waitForSelector(".iv .iv-img", { timeout: 5000 });
await sleep(400);
const viewer = await page.evaluate(() => {
  const img = document.querySelector(".iv .iv-img");
  return { open: Boolean(document.querySelector(".iv")), loaded: Boolean(img && img.complete && img.naturalWidth > 0) };
});
check("点大预览打开看图灯箱", viewer.open && viewer.loaded, JSON.stringify(viewer));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "avatar-viewer.png") });
await page.keyboard.press("Escape");
await sleep(300);
check("Esc 关掉灯箱", !(await page.evaluate(() => Boolean(document.querySelector(".iv")))));

await page.click('#rail button[title="消息"]');
await page.waitForSelector("#list .row", { timeout: 10000 });
await page.evaluate((bId) => document.querySelector(`#list [data-id="${bId}"]`)?.click(), bSt.nodeId);
await page.waitForSelector(".msg .av.pic", { timeout: 10000 });
await page.click(".msg .av.pic");
await page.waitForSelector(".iv .iv-img", { timeout: 5000 });
check("聊天里的头像也能点开", true);
await page.keyboard.press("Escape");
await sleep(200);

// 回「我」页继续删
await page.click('#rail button[title="我"]');
await page.waitForSelector('.me-nav .me-tab:has-text("头像")', { timeout: 10000 });
await page.click('.me-nav .me-tab:has-text("头像")');
await page.waitForSelector(".me-histitem.on .me-histdel", { timeout: 8000 });

// 删当前那张：应该自动换到历史里剩下的那张，而不是掉回首字母
await page.evaluate(() => document.querySelector(".me-histitem.on .me-histdel").click());
await sleep(1200);
const afterDel = (await a.get("/api/peer")).status?.avatar;
check("删掉当前那张会换到剩下的一张", afterDel === secondId, `${afterDel}`);
const hist3 = (await a.get("/api/peer/custom-avatars")).uploads?.length;
check("历史里只剩 1 张", hist3 === 1, String(hist3));

// 再删掉最后一张：退回内置，历史清空
await page.evaluate(() => document.querySelector(".me-histdel").click());
await sleep(1200);
const finalSt = (await a.get("/api/peer")).status;
const hist4 = (await a.get("/api/peer/custom-avatars")).uploads?.length;
check("删完退回内置头像", IDS.includes(finalSt?.avatar), String(finalSt?.avatar));
check("历史清空", hist4 === 0, String(hist4));

check("页面没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(bad ? `\n${bad} 项红` : "\n全过");
process.exit(bad ? 1 : 0);
