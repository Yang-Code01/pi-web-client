/**
 * 「交给 agent」去处选择（`web/src/handoff-sheet.ts`）的预览：整段正文都要看得到。
 *
 * 用户症状（2026-11-27）：一段代码评审意见交给 agent 时，弹层里只显示到第 600 个字就断了
 * （`opts.text.slice(0, 600) + "…"`），第二条意见只剩半句；而且弹层继承设置控制台的
 * `height: min(840px, 100%)`，正文结束之后下面空出一大截。
 *
 * 这条测试把真的 `.st-console` / `.handoff-*` 样式（esbuild 打 `styles.css` + `settings-console.css`）
 * 和真 Chromium 一起用上，只做三件事：
 *   1. 预览里的文字必须和交出去的文字**一字不差**（不能截断）；
 *   2. 预览框里滚到底能看见最后一行（是滚动，不是裁掉）；
 *   3. 弹层高度贴着内容（长文不超过视口、短文不被 840px 撑开）。
 *
 *   node --experimental-strip-types web/tests/handoff-sheet-browser.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { loadPlaywright } from "../../tools/playwright.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const bundled = await build({
  entryPoints: [here("../src/handoff-sheet.ts")],
  bundle: true,
  format: "iife",
  globalName: "Handoff",
  platform: "browser",
  write: false,
  logLevel: "silent",
  loader: { ".css": "empty" },
});
const code = bundled.outputFiles[0]?.text ?? "";
assert.ok(code.includes("var Handoff"), "esbuild 没产出 handoff-sheet 的 JS bundle");

// 样式照真实顺序拼：main.ts 先 styles.css（含 theme-tokens 的 @import），app.ts 再 settings-console.css。
// `.st-console` 的 `height: min(840px, 100%)` 就写在后者里，少了它这条测试量不到「弹层被撑开」。
const cssOf = async (entry) => {
  const out = await build({
    entryPoints: [here(entry)],
    bundle: true,
    write: false,
    loader: { ".css": "css" },
    logLevel: "silent",
  });
  return out.outputFiles.map((f) => f.text).join("\n");
};
const css = `${await cssOf("../src/styles.css")}\n${await cssOf("../src/settings-console.css")}`;
assert.ok(css.includes(".st-console"), "settings-console.css 没打进来");
assert.ok(css.includes(".handoff-preview"), "styles.css 没打进来");

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
// 界面文案跟着浏览器语言走（docs/I18N.md）：不钉 zh-CN，断言中文会在别的机器上假失败。
const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, locale: "zh-CN" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
await page.route("http://handoff.test/**", (route) =>
  route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="app"></div></body></html>' }),
);
await page.goto("http://handoff.test/");
await page.addStyleTag({ content: css });
await page.addScriptTag({ content: code });

/** 把一段正文挂进弹层，返回量到的几何（视觉 px；#app 没缩放，布局 px 与视觉 px 一致）。 */
const mountSheet = (text) =>
  page.evaluate((body) => {
    const app = document.getElementById("app");
    app.replaceChildren();
    const sheet = new window.Handoff.HandoffSheet({ text: body, name: "#713", onPick: () => {} });
    sheet.mount(app);
    const root = app.querySelector(".handoff-sheet");
    const preview = app.querySelector(".handoff-preview");
    const hint = app.querySelector(".handoff-body .rv-hint");
    const r = root.getBoundingClientRect();
    const pr = preview.getBoundingClientRect();
    const hr = hint.getBoundingClientRect();
    return {
      previewText: preview.textContent ?? "",
      previewHeight: Math.round(pr.height),
      scrollHeight: Math.round(preview.scrollHeight),
      clientHeight: Math.round(preview.clientHeight),
      sheet: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) },
      // 正文里最后一行落在哪儿：滚到底之后量出来，用来证明「看得到」，不只是「没删掉」。
      gapBelowHint: Math.round(r.bottom - hr.bottom),
      viewportHeight: window.innerHeight,
    };
  }, text);

/** 预览滚到底，量最后一段文字的矩形是否落在预览框里。 */
const tailVisible = () =>
  page.evaluate(() => {
    const preview = document.querySelector(".handoff-preview");
    preview.scrollTop = preview.scrollHeight;
    const text = preview.firstChild;
    const range = document.createRange();
    range.setStart(text, Math.max(0, text.length - 12));
    range.setEnd(text, text.length);
    const rect = range.getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    return {
      text: String(text.textContent).slice(-12),
      inside: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.width > 0,
      tailTop: Math.round(rect.top),
      boxBottom: Math.round(box.bottom),
    };
  });

// ---------------------------------------------------------------- 1. 长文：一字不差 + 滚动可见 + 不撑破视口

// 比 600 个字长得多，而且尾巴上有唯一标记：截断就找不到它。
const long = [
  "代码评审意见（仓库：yang-code01/pi-web-client；PR #713）",
  "一共 2 条，逐条核实并处理：",
  ...Array.from({ length: 24 }, (_, i) => `${i + 1}. probes/github-panel-no-origin.mjs:139 · 低 · test — 读 state 响应时把非 JSON 也吞成 {}，探针可能假绿。`),
  "",
  "TAIL-713-最后一行必须看得见",
].join("\n");
assert.ok(long.length > 2000, `样本不够长：${long.length}`);

let m = await mountSheet(long);
assert.equal(m.previewText, long, `预览被截断了：预览 ${m.previewText.length} 字 / 正文 ${long.length} 字`);
const tail = await tailVisible();
assert.equal(tail.text, "TAIL-713-最后一行必须看得见".slice(-12), `尾巴不是最后一行：${tail.text}`);
assert.ok(tail.inside, `滚到底仍看不见最后一行（文字 top=${tail.tailTop}，预览底=${tail.boxBottom}）`);
assert.ok(m.scrollHeight > m.clientHeight + 20, `长文没进滚动区：scrollHeight=${m.scrollHeight} clientHeight=${m.clientHeight}`);
assert.ok(m.sheet.height <= m.viewportHeight - 32, `弹层高出视口：${m.sheet.height} > ${m.viewportHeight - 32}`);
// 宽也一样：单类 `.handoff-sheet` 的 560px 会被 `.st-console { width: min(1080px, 100%) }` 盖掉。
assert.ok(m.sheet.width <= 600, `弹层被拉成控制台的宽度：${m.sheet.width}px（该是 560）`);
assert.ok(m.sheet.top >= 0 && m.sheet.bottom <= m.viewportHeight, `弹层出界：${JSON.stringify(m.sheet)}`);
// 正文结束之后不该再空出一大截：弹层底边离提示行只差自己的内边距（约 16px）。
assert.ok(m.gapBelowHint <= 40, `弹层正文下面空了一大块：提示行往下还空 ${m.gapBelowHint}px`);

// ---------------------------------------------------------------- 2. 短文：弹层贴内容，不继承 840px

const short = "代码评审意见（仓库：yang-code01/pi-web-client；PR #713）\n一共 1 条，逐条核实并处理：";
m = await mountSheet(short);
assert.equal(m.previewText, short);
assert.ok(m.sheet.height < 320, `短文弹层被撑开：${m.sheet.height}px（内容只需要 ~200）`);

// ---------------------------------------------------------------- 3. 字号 150%：弹层仍在窗口里

// 外观「字号」= `#app { zoom: var(--ui-scale) }`，所以尺寸只能写 `--vh1` / `--vw1`（D123 / D263）。
// 写裸 `vh` 时这一档会把弹层顶出屏幕，内容又从下面被切掉。
await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
m = await mountSheet(long);
assert.ok(m.sheet.height <= m.viewportHeight - 32, `字号 150% 时弹层高出窗口：${m.sheet.height} > ${m.viewportHeight - 32}`);
assert.ok(m.sheet.width <= 600 * 1.5, `字号 150% 时弹层宽度不对：${m.sheet.width}px`);
assert.ok(m.sheet.top >= 0 && m.sheet.bottom <= m.viewportHeight, `字号 150% 时弹层出界：${JSON.stringify(m.sheet)}`);
assert.ok(m.gapBelowHint <= 40, `字号 150% 时正文下面空了一大块：${m.gapBelowHint}px`);
await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1"));

// ---------------------------------------------------------------- 4. 两个出口都在、点得动

const picked = await page.evaluate(() => {
  const app = document.getElementById("app");
  const click = (index) => {
    app.replaceChildren();
    const got = [];
    const sheet = new window.Handoff.HandoffSheet({ text: "x", name: "#713", onPick: (t, text, name) => got.push([t, text, name]) });
    sheet.mount(app);
    const btns = [...app.querySelectorAll(".handoff-actions .btn")];
    btns[index].click();
    return { labels: btns.map((b) => b.textContent), got, left: app.querySelectorAll(".handoff-sheet").length };
  };
  return [click(0), click(1)];
});
assert.deepEqual(picked[0].labels, ["插到当前会话", "新开会话"]);
for (const [i, target] of [[0, "current"], [1, "new"]]) {
  assert.deepEqual(picked[i].got, [[target, "x", "#713"]], `第 ${i + 1} 颗按钮的出口不对`);
  assert.equal(picked[i].left, 0, "选完要关掉弹层");
}

await page.evaluate((body) => {
  const app = document.getElementById("app");
  app.replaceChildren();
  new window.Handoff.HandoffSheet({ text: body, name: "#713", onPick: () => {} }).mount(app);
}, long);
await page.screenshot({ path: here("../../.scratch/handoff-sheet-full-text/long.png") });

assert.deepEqual(errors, [], `页面报错：${errors.join(" / ")}`);
console.log("handoff-sheet：预览完整、可滚动、弹层贴内容 —— 全部通过");
await context.close();
await browser.close();
