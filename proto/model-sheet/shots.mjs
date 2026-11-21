// 原型自查：把四个方案各截一张图，看有没有布局崩掉（不进 main，纯本地核对用）。
// 跑：node .scratch/proto-model-dialog/shots.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(here, "model-dialog.html")).href;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, locale: "zh-CN" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

for (const v of ["A", "B", "C", "D"]) {
  await page.goto(`${url}?variant=${v}`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(here, `shot-${v}.png`) });
}
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
else console.log("ok, 4 shots");
await browser.close();
