/**
 * 内网通页面跟主题走（D350）：/peer 是独立文档，以前写死「午夜」配色，换主题它不跟，Mac 风格也没有。
 *
 * 要两份测试实例（pi-web-client-test-dev 技能起的，口令 test）：
 *   node probes/peer-theme.mjs <A 的 bridge 端口> <B 的 bridge 端口> <B 的 peer 端口> [截图目录]
 * 例：node probes/peer-theme.mjs 17864 17870 17871 .scratch/peer-theme
 * 全过退出 0；任何一项红退出 1。给了截图目录就把每套主题拍一张（独立页 + 弹框里各一张）。
 */
import fs from "node:fs";
import path from "node:path";
import { loadPlaywright } from "../tools/playwright.mjs";

const [A_PORT, B_PORT, B_PEER] = process.argv.slice(2, 5).map(Number);
const SHOTS = process.argv[5] ?? "";
if (!A_PORT || !B_PORT || !B_PEER) {
  console.log("用法：node probes/peer-theme.mjs <A bridge> <B bridge> <B peer> [截图目录]");
  process.exit(2);
}
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

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

// ---- 准备：A 加 B 为联系人，两边各说几句，好让截图里有自己的、对方的气泡。
const ca = await login(A);
const cb = await login(B);
const a = api(A, ca);
const b = api(B, cb);
const aId = (await a.get("/api/peer")).status?.nodeId;
const bId = (await b.get("/api/peer")).status?.nodeId;
check("两边 peer 都在", Boolean(aId && bId));
await a.post("/api/peer/add", { addr: `127.0.0.1:${B_PEER}` });
for (let i = 0; i < 20; i++) {
  const list = (await a.get("/api/peer/contacts")).contacts ?? [];
  if (list.some((c) => c.nodeId === bId)) break;
  await sleep(300);
}
await a.post("/api/peer/send", { peer: bId, text: "下午三点的评审还开吗？" });
await b.post("/api/peer/send", { peer: aId, text: "开的，**会议室 B**，记得带上 `peer-theme` 的截图。" });
await a.post("/api/peer/send", { peer: bId, text: "好，马上到 👍" });
await sleep(800);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 820 } });
await ctx.addCookies([{ name: ca.split("=")[0], value: ca.split("=").slice(1).join("="), url: A }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const setTheme = (p, theme) =>
  p.evaluate((t) => {
    const prefs = JSON.parse(localStorage.getItem("pi.prefs") ?? "{}");
    prefs.theme = t;
    localStorage.setItem("pi.prefs", JSON.stringify(prefs));
  }, theme);

const openChat = async (p) => {
  await p.waitForSelector("#list .row", { timeout: 15000 });
  // 列表在轮询里会整块重画，拿到的行可能刚好被换掉：点不上就重新找一次。
  for (let i = 0; i < 5; i++) {
    try {
      const row = (await p.$(`#list [data-id="${bId}"]`)) ?? (await p.$("#list .row"));
      await row.click({ timeout: 3000 });
      break;
    } catch {
      await sleep(300);
    }
  }
  await p.waitForSelector(".msg.mine .bub", { timeout: 10000 });
  await sleep(700); // 气泡的入场动画放完再量、再拍
};

const look = (p) =>
  p.evaluate(() => {
    const html = document.documentElement;
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    return {
      theme: html.dataset.theme ?? null,
      ui: html.dataset.ui ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyImg: getComputedStyle(document.body).backgroundImage,
      text: getComputedStyle(document.body).color,
      barBlur: cs(".bar", "backdropFilter"),
      mineBg: cs(".msg.mine .bub", "backgroundColor"),
      accent: getComputedStyle(html).getPropertyValue("--accent").trim(),
    };
  });

// ---- 1. 独立页：每套主题都真的换了底；Mac 三套挂上 data-ui 和玻璃
await page.goto(`${A}/`);
const seen = new Map();
for (const theme of ["mac-light", "mac-dark", "mac-midnight"]) {
  await setTheme(page, theme);
  await page.goto(`${A}/peer`);
  await openChat(page);
  const l = await look(page);
  check(`${theme}：<html data-theme> 跟偏好走`, l.theme === theme, String(l.theme));
  check(`${theme}：data-ui 是 mac`, l.ui === "mac", String(l.ui));
  check(`${theme}：顶栏是毛玻璃`, Boolean(l.barBlur && l.barBlur !== "none"), String(l.barBlur));
  check(`${theme}：底是壁纸渐变`, l.bodyImg.includes("gradient"), l.bodyImg.slice(0, 40));
  seen.set(theme, `${l.bodyBg}|${l.bodyImg.slice(0, 60)}|${l.text}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `standalone-${theme}.png`) });
}
check("三套主题画出来三种底 / 字", new Set(seen.values()).size === seen.size, [...seen.values()].join(" ; "));

// ---- 2. 主界面里改了主题，开着的 /peer 当场跟（storage 事件），不用关了重开
const other = await ctx.newPage();
await other.goto(`${A}/`);
await setTheme(page, "mac-midnight");
await page.reload();
await openChat(page);
await setTheme(other, "mac-light");
await sleep(400);
const live = await look(page);
check("别的标签页换成 Mac 浅色，开着的内网通当场跟", live.theme === "mac-light" && live.ui === "mac", `${live.theme}/${live.ui}`);
await other.close();

// ---- 3. 弹框（iframe）里：Mac 下 iframe 透明，外层玻璃透上来
for (const theme of ["mac-light", "mac-dark"]) {
  await setTheme(page, theme);
  await page.goto(`${A}/`);
  await page.waitForSelector('[data-act="peer"]', { timeout: 15000 });
  await page.click('[data-act="peer"]');
  await page.waitForSelector(".peer-sheet iframe.peer-frame", { timeout: 10000 });
  const frame = await (await page.$(".peer-sheet iframe.peer-frame")).contentFrame();
  await openChat(frame);
  const l = await look(frame);
  check(`弹框 ${theme}：iframe 里同一套主题`, l.theme === theme && l.ui === "mac", `${l.theme}/${l.ui}`);
  check(`弹框 ${theme}：页面底透明`, l.bodyBg === "rgba(0, 0, 0, 0)" && l.bodyImg === "none", `${l.bodyBg} ${l.bodyImg.slice(0, 30)}`);
  const frameBg = await page.$eval(".peer-frame", (el) => getComputedStyle(el).backgroundColor);
  check(`弹框 ${theme}：iframe 元素也透明`, frameBg === "rgba(0, 0, 0, 0)", frameBg);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `embedded-${theme}.png`) });
}

// ---- 4. 发一条消息：只有新那条放入场动画，别的气泡不许跟着弹（D351）
await setTheme(page, "mac-light");
await page.goto(`${A}/peer`);
await openChat(page);
const before = await page.$$eval(".msg .bub", (n) => n.length);
await page.evaluate(() => {
  window.__bounced = new Set();
  document.addEventListener("animationstart", (ev) => {
    const m = ev.target.closest?.(".msg");
    if (m && ev.target.classList.contains("bub")) window.__bounced.add(m.dataset.id);
  }, true);
});
await page.click(".box [contenteditable], .box textarea");
await page.keyboard.type("抖不抖");
await page.keyboard.press("Enter");
await page.waitForFunction((n) => document.querySelectorAll(".msg .bub").length > n, before, { timeout: 10000 });
await sleep(3500); // 再等一两轮轮询重画
const bounced = await page.evaluate(() => window.__bounced.size);
check("发一条消息后只有新气泡放动画", bounced <= 1, `放了动画的气泡 ${bounced} 个（屏上原有 ${before} 个）`);

check("页面没有报错", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(bad ? `\n${bad} 项失败` : "\n全过");
process.exit(bad ? 1 : 0);
