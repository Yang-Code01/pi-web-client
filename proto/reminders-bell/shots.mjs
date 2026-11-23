/**
 * 角标样张的截图（一次性）。跑法：
 *   node proto/reminders-bell/shots.mjs            # 五个变体各一张
 *   node proto/reminders-bell/shots.mjs A D        # 只拍指定变体
 *
 * 依赖主检出的 playwright（worktree 里没装 node_modules 也能跑）。
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../../pi-web-client/package.json"));
const { chromium } = require("playwright");

const file = pathToFileURL(path.join(here, "index.html")).href;
const which = process.argv.slice(2).length ? process.argv.slice(2) : ["A", "B", "C", "D", "E", "F", "G", "H", "I"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 420 }, locale: "zh-CN", deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

for (const v of which) {
  await page.goto(`${file}?variant=${v}`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(here, `shot-${v}.png`) });
  const shape = await page.evaluate(() => {
    const bell = document.querySelector("#bell");
    const tail = document.querySelector("#chipTail");
    const cs = bell ? getComputedStyle(bell) : null;
    return {
      variant: document.body.dataset.variant,
      bellVisible: !!bell && !bell.hidden && cs.display !== "none" && cs.visibility !== "hidden",
      bellBox: bell ? Math.round(bell.getBoundingClientRect().width) + "x" + Math.round(bell.getBoundingClientRect().height) : "",
      tailVisible: !!tail && getComputedStyle(tail).display !== "none",
      text: (bell?.textContent ?? "").trim(),
    };
  });
  console.log(`shot-${v}.png  ${JSON.stringify(shape)}`);
}

/* 0 件时各变体怎么收场 */
for (const v of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
  await page.goto(`${file}?variant=${v}`);
  await page.click("#btnCount");
  await page.waitForTimeout(80);
  const zero = await page.evaluate(() => {
    const bell = document.querySelector("#bell");
    const tail = document.querySelector("#chipTail");
    return {
      bellHidden: bell.hidden,
      tail: getComputedStyle(tail).display,
      text: (bell.textContent ?? "").trim().slice(0, 12),
    };
  });
  console.log(`0 件 · ${v}: ${JSON.stringify(zero)}`);
  if (v === "D") await page.screenshot({ path: path.join(here, "shot-D-zero.png") });
}

if (errors.length) {
  console.log("\nJS 报错：");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
} else console.log("\n没有 JS 报错。");

await browser.close();
