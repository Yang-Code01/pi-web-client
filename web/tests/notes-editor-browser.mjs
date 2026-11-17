/**
 * #486 富文本编辑器（`web/src/notes/editor.ts`）的浏览器测试。
 *
 * 纯函数那一半在 `notes-rich-unit.mjs`；这里验的是只有真浏览器才有的东西：选区、execCommand、
 * 粘贴事件、``` 触发、工具栏点下去会不会把选区弄丢。
 *
 *   node --experimental-strip-types web/tests/notes-editor-browser.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../../tools/playwright.mjs";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/notes/editor.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  globalName: "NotesEditor",
  platform: "browser",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body><div id=tb></div><div id=doc></div></body></html>");
await page.addScriptTag({ content: code });
await page.evaluate(() => {
  const w = window;
  w.changes = 0;
  w.ed = new w.NotesEditor.RichEditor({
    body: document.getElementById("doc"),
    toolbar: document.getElementById("tb"),
    onChange: () => {
      w.changes += 1;
    },
  });
});

const html = () => page.evaluate(() => window.ed.html());
const count = (sel) => page.evaluate((s) => document.querySelectorAll(`#doc ${s}`).length, sel);

// ---------------------------------------------------------------- 渲染

await page.evaluate(() => window.ed.setHtml('<h1>标题</h1><p>正文 <strong>粗</strong></p><pre><code>x()</code></pre>'));
assert.equal(await count("h1"), 1);
assert.equal(await count("pre code"), 1);

await page.evaluate(() => window.ed.setHtml('<p>a</p><script>alert(1)</script>'));
assert.equal(await count("script"), 0, "setHtml 也要挡掉脚本");

// ---------------------------------------------------------------- 选区 + 粗体

await page.evaluate(() => {
  window.ed.setHtml("<p>选中我</p>");
  window.ed.focus();
  const p = document.querySelector("#doc p");
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.click(".tb-b");
let out = await html();
assert.match(out, /<(b|strong)>选中我<\/(b|strong)>/, `粗体没生效：${out}`);

// 点工具栏不该把选区弄没：接着点斜体还应该作用在同一段文字上。
await page.click(".tb-i");
out = await html();
assert.match(out, /<i>/, `斜体没生效（选区丢了）：${out}`);

// ---------------------------------------------------------------- ``` 触发代码块

await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("```");
await page.waitForTimeout(80);
assert.equal(await count("pre code"), 1, "整行三个反引号应该换成代码块");

// ---------------------------------------------------------------- Alt+P

await page.evaluate(() => window.ed.setHtml("<p>一段</p>"));
await page.click("#doc");
await page.keyboard.press("Control+End");
await page.keyboard.press("Alt+p");
out = await html();
assert.match(out, /<p>/, "Alt+P 之后还得是段落");

// ---------------------------------------------------------------- 插入表格 / 分隔线

await page.evaluate(() => window.ed.setHtml("<p>x</p>"));
await page.click("#tb .tb-btn[title='插入表格']");
assert.equal(await count("table th"), 2);
await page.click("#tb .tb-btn[title='分隔线']");
assert.equal(await count("hr"), 1);

// ---------------------------------------------------------------- 粘贴净化

await page.evaluate(() => {
  window.ed.setHtml("<p>粘贴目标</p>");
  window.ed.focus();
  const dt = new DataTransfer();
  dt.setData("text/html", '<p onclick="x()">粘进来的 <b>粗</b></p><img src=x onerror=alert(1)>');
  dt.setData("text/plain", "粘进来的 粗");
  document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
out = await html();
assert.match(out, /粘进来的/, "粘贴的正文该留下");
assert.doesNotMatch(out, /onclick|onerror|<img/, `粘贴没净化：${out}`);

// 纯文本粘贴：换行要变成段落，而不是一坨。
await page.evaluate(() => {
  window.ed.setHtml("<p>纯文本</p>");
  window.ed.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", "第一行\n第二行");
  document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
out = await html();
assert.match(out, /第一行/, `纯文本粘贴丢了：${out}`);
assert.match(out, /第二行/, `纯文本粘贴只留了一行：${out}`);

// ---------------------------------------------------------------- 颜色 / 字号（span[style]）

await page.evaluate(() => {
  window.ed.setHtml("<p>上色</p>");
  window.ed.focus();
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("#doc p"));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.click("#tb .tb-btn[title='文字颜色 / 底色']");
await page.click(".tb-pop .tb-swatch");
out = await html();
assert.match(out, /<span style="color: (rgb|#)/, `文字色没包上：${out}`);

// 没选文字的时候点颜色：给提示，不许硬套到整个段落上。
await page.evaluate(() => {
  window.ed.setHtml("<p>没选</p>");
  window.ed.focus();
  window.ed.closePop();
});
await page.click("#tb .tb-btn[title='文字颜色 / 底色']");
await page.click(".tb-pop .tb-swatch");
out = await html();
assert.equal(out, "<p>没选</p>", "没选区时不该改到正文");

// ---------------------------------------------------------------- 保存读回

await page.evaluate(() => window.ed.setHtml('<p style="position:fixed">坏样式</p><p onclick="x()">好</p>'));
assert.equal(await html(), "<p>坏样式</p><p>好</p>");

const changes = await page.evaluate(() => window.changes);
assert.ok(changes > 3, `onChange 没被叫：${changes}`);

await browser.close();
console.log("notes-editor browser: ok");
