/**
 * 探针：贴图之后那一下「图从输入框飞进徽标」（D446）。
 *
 * 真 Chromium + 真 paste 事件 + 真几何。不能靠 jsdom：这条动效的全部内容就是「坐标」与
 * 「谁在什么时候消失」，而 `#app` 上还挂着 `zoom: var(--ui-scale)` —— 视觉 px 与布局 px 是两套，
 * 只有在真浏览器里量才有意义（D123 的老坑）。
 *
 * 检查：
 *   1. 贴两张 → `#app` 里冒出一层 `.paste-fly`、正好两片幽灵，`<img>` 拿的是 data URL；
 *   2. 起点在输入框上方、终点落在徽标中心 —— 把动画暂停、把 currentTime 推到首尾帧上量，
 *      不靠等时间（这样 700ms 的飞行也不会让断言随机翻车）；
 *   3. 落地之后：整层拆掉（`#app` 里不留常驻浮层）、徽标弹了一下（WAAPI 动画在跑）、
 *      实底闪那一下的 `.flash` 类挂上了；
 *   4. 一次贴六张只飞四片（剩下的靠徽标上的数字）；
 *   5. `prefers-reduced-motion: reduce`：一片都不飞、徽标也不弹，但张数照常更新；
 *   6. 字号 125%：幽灵渲染出来是 76 × 1.25 = 95px，终点仍在徽标中心（缩放补偿没算错才成立）。
 *
 * 需要：隔离桥（`.pi/skills/pi-web-client-test-dev`）。
 * 跑：PI_WEB_BASE=http://127.0.0.1:17864 node probes/paste-fly-in.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";

const { chromium } = await loadPlaywright();

const STATE = process.env.PI_WEB_STATE ?? path.join(REPO, ".scratch/test-state");
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:17864";
const OUT = path.join(REPO, ".scratch/shots");
fs.mkdirSync(OUT, { recursive: true });
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
const sessionId = sessions[0].id;

const browser = await chromium.launch();
const errors = [];

/** 打开页面并贴一组同色不同的图（canvas 生成，像真截图一样大）。 */
async function open({ reducedMotion = "no-preference", scale = 1, width = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2, locale: "zh-CN", reducedMotion });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector("textarea", { timeout: 20000 });
  // 字号（`#app` 的 zoom）存在 `pi.prefs` 里：要先写进去再重载，才有 1.25 的 `--ui-scale`。
  if (scale !== 1) {
    await page.evaluate((s) => {
      const prefs = JSON.parse(localStorage.getItem("pi.prefs") || "{}");
      localStorage.setItem("pi.prefs", JSON.stringify({ ...prefs, scale: s }));
    }, scale);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea", { timeout: 20000 });
  }
  return page;
}

const pasteColors = (page, colors) =>
  page.evaluate(async (colors) => {
    const dt = new DataTransfer();
    for (const color of colors) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext("2d");
      g.fillStyle = color;
      g.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      dt.items.add(new File([blob], `${color}.png`, { type: "image/png" }));
    }
    document.querySelector("textarea").dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, colors);

/** 首帧 / 末帧都量一遍：把动画暂停、把 currentTime 推过去，别等墙上的钟。 */
const flyGeometry = (page) =>
  page.evaluate(() => {
    const layer = document.getElementById("app")?.querySelector(":scope > .paste-fly");
    if (!layer) return null;
    const ghosts = [...layer.querySelectorAll(".ghost")];
    const anims = ghosts.map((g) => g.getAnimations()[0]).filter(Boolean);
    const box = document.querySelector(".composer-input")?.getBoundingClientRect();
    const badge = document.querySelector(".row .image-badge")?.getBoundingClientRect();
    const rectAt = (time) => {
      const at = { start: 0, hold: 700 * 0.22, end: 690 }[time] ?? 0;
      anims.forEach((a) => {
        a.pause();
        a.currentTime = (a.effect.getTiming().delay || 0) + at;
      });
      return ghosts.map((g) => {
        const r = g.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, layout: g.offsetWidth, src: g.querySelector("img")?.src.slice(0, 10) };
      });
    };
    const start = rectAt(0);
    const hold = rectAt("hold");
    const end = rectAt("end");
    anims.forEach((a) => a.play());
    return {
      count: ghosts.length,
      start,
      hold,
      end,
      box: box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
      badge: badge ? { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 } : null,
    };
  });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- 1) 贴两张：两片幽灵
{
  const page = await open({ width: 900 });
  await pasteColors(page, ["#c0392b", "#2980b9"]);
  await page.waitForSelector("#app .paste-fly .ghost", { timeout: 4000 });
  const geo = await flyGeometry(page);
  check("贴两张：`#app` 里冒出一层 .paste-fly", Boolean(geo));
  check("贴两张：两片幽灵", geo?.count === 2, String(geo?.count));
  check("幽灵里是 data URL 的图", geo?.start.every((g) => g.src.startsWith("data:image")), JSON.stringify(geo?.start.map((g) => g.src)));
  check(
    "起点落在输入框上方（视觉 px，缩放已换算）",
    Boolean(geo?.box) && geo.start.every((g) => Math.abs(g.x - geo.box.x) < 60 && g.y < geo.box.y),
    JSON.stringify({ start: geo?.start, box: geo?.box }),
  );
  check(
    "终点落在徽标中心（±8px）",
    Boolean(geo?.badge) && geo.end.every((g) => dist(g, geo.badge) < 8),
    JSON.stringify({ end: geo?.end, badge: geo?.badge }),
  );
  await page.screenshot({ path: `${OUT}/paste-fly-mid.png` });
  await page.close();
}

// ---------------------------------------------------------------- 2) 落地之后：层拆掉、徽标弹并闪
{
  const page = await open({ width: 900 });
  await pasteColors(page, ["#27ae60"]);
  await page.waitForSelector("#app .paste-fly .ghost", { timeout: 4000 });
  await page.waitForFunction(() => !document.getElementById("app")?.querySelector(":scope > .paste-fly"), null, { timeout: 4000 });
  const after = await page.evaluate(() => {
    const badge = document.querySelector(".row .image-badge");
    return {
      layer: Boolean(document.getElementById("app")?.querySelector(":scope > .paste-fly")),
      layerCount: document.querySelectorAll(".paste-fly").length,
      pops: badge?.getAnimations().length ?? 0,
      flash: badge?.classList.contains("flash") ?? false,
      text: badge?.textContent ?? "",
      ghosts: document.querySelectorAll(".paste-fly .ghost").length,
    };
  });
  check("落地后整层从 DOM 里拆掉（不留常驻浮层）", !after.layer && after.layerCount === 0);
  check("落地后没有残留幽灵", after.ghosts === 0, String(after.ghosts));
  check("徽标弹了一下（落地动画在跑）", after.pops > 0, String(after.pops));
  check("徽标实底闪了一下（.flash）", after.flash);
  check("徽标写的是 +1 图", after.text === "+1 图", after.text);
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => document.querySelector(".row .image-badge")?.classList.contains("flash"));
  check("260ms 后 .flash 自己摘掉", settled === false);
  check("输入框文字/焦点没被动过（动效不碰输入框）", (await page.locator("textarea").inputValue()) === "");
  await page.close();
}

// ---------------------------------------------------------------- 3) 六张只飞四片
{
  const page = await open({ width: 900 });
  await pasteColors(page, ["#c0392b", "#27ae60", "#2980b9", "#f1c40f", "#8e44ad", "#16a085"]);
  await page.waitForSelector("#app .paste-fly .ghost", { timeout: 4000 });
  const geo = await flyGeometry(page);
  check("六张只飞四片", geo?.count === 4, String(geo?.count));
  const text = await page.evaluate(() => document.querySelector(".row .image-badge")?.textContent ?? "");
  check("六张全记账（徽标 +6 图）", text === "+6 图", text);
  await page.close();
}

// ---------------------------------------------------------------- 4) reduced motion：什么都不飞
{
  const page = await open({ width: 900, reducedMotion: "reduce" });
  await pasteColors(page, ["#8e44ad"]);
  await page.waitForTimeout(120);
  const state = await page.evaluate(() => ({
    layers: document.querySelectorAll(".paste-fly").length,
    pops: document.querySelector(".row .image-badge")?.getAnimations().length ?? 0,
    text: document.querySelector(".row .image-badge")?.textContent ?? "",
  }));
  check("reduced motion：一片都不飞", state.layers === 0, String(state.layers));
  check("reduced motion：徽标也不弹", state.pops === 0, String(state.pops));
  check("reduced motion：张数照常更新", state.text === "+1 图", state.text);
  await page.close();
}

// ---------------------------------------------------------------- 5) 字号 125%：缩放只乘一次
{
  const page = await open({ width: 900, scale: 1.25 });
  await pasteColors(page, ["#f1c40f"]);
  await page.waitForSelector("#app .paste-fly .ghost", { timeout: 4000 });
  const geo = await flyGeometry(page);
  const size = geo?.hold[0]?.w ?? 0;
  check("125% 字号：幽灵布局尺寸仍是 76px（不写死视觉 px）", geo?.hold[0]?.layout === 76, String(geo?.hold[0]?.layout));
  // 那一帧上还带着 rotate(-2deg)，外接矩形会比边长宽 2%，所以留 6px 余量（没除缩放的话会是 118px，一眼就红）。
  check("125% 字号：渲染出来是 76 × 1.25 ≈ 95px（缩放只乘一次）", Math.abs(size - 95) < 6, `${size.toFixed(1)}px`);
  check(
    "125% 字号：终点仍在徽标中心（±8px）",
    Boolean(geo?.badge) && geo.end.every((g) => dist(g, geo.badge) < 8),
    JSON.stringify({ end: geo?.end, badge: geo?.badge }),
  );
  await page.close();
}

check("没有页面报错", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
