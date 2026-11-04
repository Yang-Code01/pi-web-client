// 截图：只读会话的「接管会话」bar（手机 390×844 + 桌面 1440×900）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO } from "../tools/paths.mjs";
import { loadPlaywright } from "../tools/playwright.mjs";
const { chromium } = await loadPlaywright();
const STATE = path.join(process.env.LOCALAPPDATA || "", "pi-web-client");
const pass = fs.readFileSync(path.join(STATE, "passphrase.txt"), "utf8").trim();
const OUT = path.join(REPO, ".scratch/shots");
fs.mkdirSync(OUT, { recursive: true });
const id = process.argv[2];

const browser = await chromium.launch();
for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto("http://127.0.0.1:7864/");
  await page.fill("input[type=password], input[type=text]", pass).catch(() => {});
  await page.keyboard.press("Enter");
  await page.waitForSelector(".session-card", { timeout: 15000 });
  await page.goto(`http://127.0.0.1:7864/#/s/${id}`);
  await page.waitForSelector(".takeover", { timeout: 15000 });
  await page.waitForTimeout(900);
  const box = await page.locator(".composer, .composer-inner, .chat-foot").first().boundingBox().catch(() => null);
  await page.screenshot({ path: `${OUT}/takeover-${name}.png`, fullPage: false, ...(box ? { clip: box } : {}) });
  console.log(name, "ok", JSON.stringify(box));
  await page.close();
}
await browser.close();
