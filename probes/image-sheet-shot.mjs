/** 桌面宽度下待发图片弹窗长什么样（1280 宽，sheet 变成居中卡片）。 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = "F:/pi-web-client/.scratch/shots";
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, locale: "zh-CN" });
const page = await ctx.newPage();
await page.goto(`${BASE}/#/s/${sessions[0].id}`, { waitUntil: "domcontentloaded" });
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="password"]', pass);
  await page.click('button:has-text("进入")');
}
await page.waitForSelector("textarea", { timeout: 20000 });
await page.fill("textarea", "四张截图的报错，帮我看看是哪一步挂了");

await page.evaluate(async () => {
  const shades = ["#c0392b", "#27ae60", "#2980b9", "#f1c40f"];
  const dt = new DataTransfer();
  for (const color of shades) {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
    const g = canvas.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#0b0e12";
    g.fillRect(0, 0, 640, 46);
    g.fillStyle = "#ffffff";
    g.font = "bold 24px monospace";
    g.fillText(`bash — 捕获 ${color}`, 16, 32);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    dt.items.add(new File([blob], `${color}.png`, { type: "image/png" }));
  }
  document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/image-sheet-composer-1280.png` });
await page.locator(".row .image-badge").click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/image-sheet-1280.png` });
console.log("shots ok");
await browser.close();
