/** 粘图后的样子：桌面与手机各截一张（真 Chromium，真 paste 事件）。 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PW = "C:/Users/GG_Bond/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(PW).href);

const STATE = "F:/pi-web-client/.scratch/test-state";
const BASE = process.env.PI_WEB_BASE ?? "http://127.0.0.1:7867";
const OUT = "F:/pi-web-client/.scratch/shots";
fs.mkdirSync(OUT, { recursive: true });
const pass = fs.readFileSync(`${STATE}/passphrase.txt`, "utf8").trim();

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ passphrase: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const { sessions } = await (await fetch(`${BASE}/api/sessions`, { headers: { cookie } })).json();
const sessionId = sessions[0].id;

const browser = await chromium.launch();

for (const [tag, viewport, userAgent] of [
  ["desktop-1280", { width: 1280, height: 860 }, null],
  ["mobile-390", { width: 390, height: 844 }, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "zh-CN", ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[type="password"]', pass);
    await page.click('button:has-text("进入")');
  }
  await page.waitForSelector("textarea", { timeout: 20000 });
  await page.fill("textarea", "这个报错的截图，帮我看下原因");
  // 贴两张图：一张走 paste 事件（模拟截图复制），保持和真实使用一致
  await page.evaluate(() => {
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAHsIAAB7CAW7QdT4AAAAqSURBVGhD7cEBDQAAAMKg909tDwcFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4G1QuAAGj1k0WAAAAAElFTkSuQmCC";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot-1.png", { type: "image/png" }));
    dt.items.add(new File([bytes], "shot-2.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector("textarea").dispatchEvent(ev);
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/paste-${tag}.png` });
  console.log(tag, "→", await page.evaluate(() => document.querySelector(".row .badge")?.textContent ?? "(无)"));
  await ctx.close();
}

await browser.close();
