/**
 * 一次性原型的截图脚本（不在 main）。跑法：
 *   node proto/reminders-ui/shots.mjs            # 五个变体各一张
 *   node proto/reminders-ui/shots.mjs A E        # 只拍指定变体
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
const which = process.argv.slice(2).length ? process.argv.slice(2) : ["A", "B", "C", "D", "E"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN", deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

for (const v of which) {
  /* toast=0：截图里不要那条 6 秒后消失的吐司，免得两张图差在一个计时器上 */
  await page.goto(`${file}?variant=${v}&toast=0`);
  await page.waitForTimeout(200);
  /* 把清单打开，否则截图里只有一个角标 —— 变体的差别全在清单上。
     D 没有角标（它用底部那条状态带），所以点的是 strip。 */
  await page.click(v === "D" ? "#remindStrip" : "#remindBtn");
  await page.waitForTimeout(150);
  const out = path.join(here, `shot-${v}.png`);
  await page.screenshot({ path: out });
  console.log(`shot-${v}.png`);

  /* 顺手断言：清单确实开了、角标是 2、没有 JS 报错 */
  const bad = await page.evaluate(() => {
    const pop = document.querySelector("#remindPop");
    const badge = document.querySelector("#remindBadge")?.textContent;
    return {
      open: pop?.classList.contains("open"),
      rows: pop?.querySelectorAll(".row, .grpcard").length ?? 0,
      visible: pop ? getComputedStyle(pop).display !== "none" : false,
      badge,
      variant: document.body.dataset.variant,
    };
  });
  console.log(`  ${JSON.stringify(bad)}`);
  if (!bad.open || !bad.visible || bad.badge !== "2" || bad.rows < 4) console.log("  ⚠ 形状不对");
}

/* 吐司一张（只拍 A） */
await page.goto(`${file}?variant=A&toast=0`);
await page.click("#btnToast");
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(here, "shot-toast.png") });
console.log("shot-toast.png");

/* 窄版一张（A 的清单在窄屏里长什么样） */
await page.setViewportSize({ width: 620, height: 760 });
await page.goto(`${file}?variant=A&toast=0`);
await page.click("#remindBtn");
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(here, "shot-narrow.png") });
console.log("shot-narrow.png");

if (errors.length) {
  console.log("\nJS 报错：");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
} else {
  console.log("\n没有 JS 报错。");
}

await browser.close();
