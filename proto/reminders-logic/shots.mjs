/**
 * 逻辑原型的读数脚本（一次性）。跑法：
 *   node proto/reminders-logic/shots.mjs
 *
 * 它不做「测试」，只把原型自己声称的三条不变量按一遍，把读数打出来 ——
 * 图 + 数字就是这份原型的证据。断言顺手带着，红一下也不影响看图。
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../../pi-web-client/package.json"));
const { chromium } = require("playwright");

const file = pathToFileURL(path.join(here, "index.html")).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1240, height: 940 }, locale: "zh-CN", deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

const read = () =>
  page.evaluate(() => ({
    badge: Number(document.querySelector("#badge").textContent),
    toasts: Number(document.querySelector("#toastCount").textContent),
    wait: document.querySelectorAll("#listWait .it").length,
    done: document.querySelectorAll("#listDone .it").length,
    clock: document.querySelector("#clock").textContent,
    last: document.querySelector("#lastact").textContent.trim().slice(0, 70),
  }));

const step = (i) => page.click(`#steps [data-step="${i}"]`);
const tab = (i) => page.click(`#tabs [data-s="${i}"]`);
const shot = async (name) => { await page.waitForTimeout(120); await page.screenshot({ path: path.join(here, name) }); console.log("  " + name); };

await page.goto(file);
await page.waitForTimeout(150);

console.log("场景 2 · 同一会话刷屏");
await tab(1);
await step(0);
console.log("  连来 5 条 →", await read());
await step(1);
console.log("  再来一条（30 秒内）→", await read());
await step(2);
await step(3);
console.log("  等 30 秒再来一条 →", await read());
await shot("shot-flood.png");

console.log("场景 1 · 一晚上没人管");
await tab(0);
await step(0);
await step(1);
console.log("  两条都在等 →", await read());
await step(3);
const afterRestart = await read();
console.log("  桥重启 →", afterRestart);
await shot("shot-restart.png");

console.log("场景 3 · 静音之后");
await tab(2);
await step(0);
await step(1);
await step(2);
const muted = await read();
console.log("  静音 go-svc 后又来两条 →", muted);
await shot("shot-muted.png");

console.log("场景 4 · 非阻塞怎么消");
await tab(3);
await step(0);
await step(1);
console.log("  两条构建失败 →", await read());
await step(2);
console.log("  点开一条 →", await read());
await shot("shot-notice.png");

console.log("场景 5 · 塞满");
await tab(4);
await step(0);
const flood = await read();
console.log("  520 条之后 →", flood);
await shot("shot-cap.png");

/* 三条不变量：红了说明原型的说法自己不自洽 */
const complaints = [];
if (muted.badge !== 0) complaints.push("静音之后角标应当为 0");
if (muted.wait === 0) complaints.push("静音之后清单里应当还留着条目");
if (afterRestart.wait !== 0) complaints.push("桥重启之后不应还有「在等」的");
if (afterRestart.done < 2) complaints.push("桥重启之后应当看到两条「已失效」");
if (flood.wait !== 120 || flood.badge !== 120) complaints.push("cap 不该把「在等」的丢掉（应当剩 120 条在等）");
if (complaints.length) {
  console.log("\n不变量没对上：");
  for (const c of complaints) console.log("  ✗ " + c);
  process.exitCode = 1;
} else {
  console.log("\n三条不变量都对上了（静音不计角标但留在清单、重启即失效、cap 不丢在等的）。");
}
if (errors.length) {
  console.log("\nJS 报错：");
  for (const e of errors) console.log("  " + e);
  process.exitCode = 1;
}

await browser.close();
