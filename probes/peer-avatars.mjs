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

// ---- 4. 「我」页：12 张、当前那张被选中、点一张就换
await page.click('#rail button[title="我"]');
await page.waitForSelector(".avgrid .avpick", { timeout: 10000 });
await sleep(500);
const grid = await page.evaluate(() => ({
  count: document.querySelectorAll(".avgrid .avpick").length,
  loaded: [...document.querySelectorAll(".avgrid .avpick img")].filter((i) => i.complete && i.naturalWidth > 0).length,
  on: document.querySelectorAll(".avgrid .avpick.on").length,
  hero: Boolean(document.querySelector(".hero .av.pic .av-img")),
}));
check("「我」页有 12 张可选", grid.count === IDS.length, String(grid.count));
check("12 张图都解码成功", grid.loaded === IDS.length, String(grid.loaded));
check("当前那张被标出来（恰好一处）", grid.on === 1, String(grid.on));
check("hero 上是我自己的头像图", grid.hero);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "me.png") });

// 点一张不是当前那张的
await page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".avgrid .avpick")];
  tiles[tiles.findIndex((t) => !t.classList.contains("on"))].click();
});
await sleep(1200);
const afterA = (await a.get("/api/peer")).status;
check("点了就换（配置里也换了）", afterA.avatar !== aSt.avatar && IDS.includes(afterA.avatar), `${aSt.avatar} → ${afterA.avatar}`);
// 成功提示：它靠 setConfig() 的返回值判定，改成无条件弹的话失败了也说「换好了」。
const toasted = await page.evaluate(() => [...document.querySelectorAll(".toast, .toasts > *")].some((n) => /头像换好了/.test(n.textContent ?? "")));
check("换完弹了「头像换好了」", toasted);
const heroAfter = await page.evaluate(() => Boolean(document.querySelector(".hero .av.pic .av-img")));
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

check("页面没有 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(bad ? `\n${bad} 项红` : "\n全过");
process.exit(bad ? 1 : 0);
