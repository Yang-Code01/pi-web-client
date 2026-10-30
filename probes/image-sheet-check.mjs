/**
 * 待发图片弹窗的浏览器验证：点「+N 图」看缩略图、单张 × 删掉、全部清空。
 * 真 Chromium + 真 paste 事件；三张图用不同颜色生成，删掉哪张靠采样像素确认。
 *
 * 需要：隔离桥在 7867（PI_WEB_STATE=F:/pi-web-client/.scratch/test-state）
 * 跑：node probes/image-sheet-check.mjs
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = process.env.PI_WEB_STATE ?? "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = "F:/pi-web-client/.scratch/shots";
fs.mkdirSync(OUT, { recursive: true });
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector("textarea", { timeout: 20000 });

/** 贴若干张同色不同的图（canvas 生成，像真截图一样大）。 */
const pasteColors = (colors) =>
  page.evaluate(async (colors) => {
    const dt = new DataTransfer();
    for (const color of colors) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext("2d");
      g.fillStyle = color;
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#ffffff";
      g.font = "bold 28px sans-serif";
      g.fillText(color, 18, 46);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      dt.items.add(new File([blob], `${color}.png`, { type: "image/png" }));
    }
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector("textarea").dispatchEvent(ev);
    return dt.files.length;
  }, colors);

/** 每张缩略图左上角偏内的像素颜色 → 判断留下的到底是哪几张。 */
const tileColors = () =>
  page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll(".image-grid img")) {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const [r, gg, b] = g.getImageData(4, 4, 1, 1).data;
      out.push(`#${[r, gg, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    }
    return out;
  });

/** 缩略图左上角的序号：留几张就该是 1..N。 */
const numbers = () =>
  page.evaluate(() => [...document.querySelectorAll(".image-grid .image-no")].map((n) => n.textContent));

const badgeText = () => page.evaluate(() => document.querySelector(".row .image-badge")?.textContent ?? "");
const sheetOpen = () => page.locator(".sheet.image-sheet").count();

// ---------------------------------------------------------------- 1) 贴三张 → 打开弹窗
await pasteColors(["#c0392b", "#27ae60", "#2980b9"]);
await page.waitForTimeout(500);
check("三张图贴进来：徽标 +3 图", (await badgeText()) === "+3 图", await badgeText());
check("徽标是按钮（可点）", (await page.locator(".row button.image-badge").count()) === 1);

await page.locator(".row .image-badge").click();
await page.waitForTimeout(300);
check("点徽标：弹出待发图片页", (await sheetOpen()) === 1);
check(
  "标题写张数",
  (await page.locator(".image-sheet .sheet-title").innerText()) === "待发图片 3 张",
  await page.locator(".image-sheet .sheet-title").innerText(),
);
check("三张缩略图", (await page.locator(".image-grid .image-tile").count()) === 3);
/** JPEG 压缩会把颜色挪几个色阶，所以只认「最近的那张」，不比精确值。 */
const nearest = (hex) => {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const palette = { "#c0392b": "red", "#27ae60": "green", "#2980b9": "blue", "#f1c40f": "yellow", "#8e44ad": "purple" };
  let best = "";
  let bestDist = Infinity;
  for (const [k, name] of Object.entries(palette)) {
    const other = [1, 3, 5].map((i) => parseInt(k.slice(i, i + 2), 16));
    const d = rgb.reduce((sum, v, i) => sum + (v - other[i]) ** 2, 0);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
};
const names = async () => (await tileColors()).map(nearest);
check("缩略图带序号 1 2 3", JSON.stringify(await numbers()) === JSON.stringify(["1", "2", "3"]), (await numbers()).join(" "));
check("缩略图顺序 = 贴入顺序", JSON.stringify(await names()) === JSON.stringify(["red", "green", "blue"]), (await names()).join(" "));
await page.screenshot({ path: `${OUT}/image-sheet-390.png` });

// ---------------------------------------------------------------- 2) 删中间那张
await page.locator(".image-grid .image-tile").nth(1).locator(".image-x").click();
await page.waitForTimeout(250);
check("删掉第 2 张：剩两张", (await page.locator(".image-grid .image-tile").count()) === 2);
check("删完重新编号 1 2", JSON.stringify(await numbers()) === JSON.stringify(["1", "2"]), (await numbers()).join(" "));
check("删掉的是中间那张（红 + 蓝留下）", JSON.stringify(await names()) === JSON.stringify(["red", "blue"]), (await names()).join(" "));
check("徽标同步成 +2 图", (await badgeText()) === "+2 图", await badgeText());
check("弹窗没关", (await sheetOpen()) === 1);

// ---------------------------------------------------------------- 3) 关掉弹窗，输入框文字还在
await page.fill("textarea", "这段文字不能被删图影响");
await page.locator(".sheet-foot .btn").first().click(); // 全部清空
await page.waitForTimeout(250);
check("全部清空：弹窗关闭", (await sheetOpen()) === 0);
check("全部清空：徽标消失", (await badgeText()) === "", await badgeText());
check("全部清空：输入框文字没动", (await page.locator("textarea").inputValue()) === "这段文字不能被删图影响");

// ---------------------------------------------------------------- 4) 再贴两张 → 关弹窗 → 徽标仍在
await pasteColors(["#f1c40f", "#8e44ad"]);
await page.waitForTimeout(400);
check("再贴两张：徽标 +2 图", (await badgeText()) === "+2 图", await badgeText());
await page.locator(".row .image-badge").click();
await page.waitForTimeout(250);
await page.locator(".image-grid .image-tile").first().locator(".image-x").click();
await page.waitForTimeout(200);
check("删到只剩一张：徽标 +1 图", (await badgeText()) === "+1 图", await badgeText());
await page.locator(".image-grid .image-tile").first().locator(".image-x").click();
await page.waitForTimeout(300);
check("删掉最后一张：弹窗自动关掉", (await sheetOpen()) === 0);
check("删掉最后一张：徽标消失", (await badgeText()) === "", await badgeText());
check("删掉最后一张：输入框文字仍然在", (await page.locator("textarea").inputValue()) === "这段文字不能被删图影响");

check("没有页面报错", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
