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
// 工具栏的 title / aria-label 都是 tr() 出来的中文：locale 必须钉成 zh-CN（docs/I18N.md）。
const context = await browser.newContext({ locale: "zh-CN" });
const page = await context.newPage();
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
// contenteditable 的行尾空格是 &nbsp;，断言里换成普通空格再比。
const docHtml = async () => (await html()).replaceAll(String.fromCharCode(160), " ");

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
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
assert.equal(await count("pre code"), 1, "整行三个反引号应该换成代码块");
assert.equal(await page.evaluate(() => document.querySelector("#doc pre code").textContent.trim()), "", "反引号要清掉");
assert.ok(!(await html()).includes("```"), "存下来的正文里不该再有反引号");

await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("```ts");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);
assert.equal(
  await page.evaluate(() => document.querySelector("#doc pre code").className),
  "language-ts",
  "带上语言名时要挂到 code.language-*",
);

// ---------------------------------------------------------------- Markdown 输入规则（#511）

// 块级：`- ` + 空格立即转无序列表，标记本身不留在正文里。
await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("- ");
await page.waitForTimeout(60);
assert.equal(await count("ul li"), 1, "`- ` 应转成无序列表");
assert.ok(!(await docHtml()).includes("- "), "列表标记要清掉");

// 块级转换后 Ctrl+Z：一步回到打标记前的段落（replaceWith 不进原生撤销栈）。
await page.keyboard.press("Control+z");
await page.waitForTimeout(60);
assert.equal(await count("ul"), 0, "Ctrl+Z 应撤销列表转换");
assert.match(await docHtml(), /- /, "撤销后标记要回来");

// 标题：# + 空格；#### 及以上不转。
await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("## ");
await page.waitForTimeout(60);
assert.equal(await count("h2"), 1, "`## ` 应转二级标题");

await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("#### ");
await page.waitForTimeout(60);
assert.equal(await count("h4"), 0, "`#### ` 不该转标题");
assert.match(await docHtml(), /#### /, "`#### ` 要原样留着");

// 行内：闭符号一敲完就转。
await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("**粗**");
await page.waitForTimeout(60);
assert.equal(await count("strong"), 1, "`**粗**` 应转粗体");
assert.ok(!(await html()).includes("**"), "粗体标记要清掉");

await page.evaluate(() => window.ed.setHtml("<p><br></p>"));
await page.click("#doc");
await page.keyboard.type("`码`");
await page.waitForTimeout(60);
assert.equal(await count("code"), 1, "反引号应转行内代码");

// 代码块里不转行内规则。
await page.evaluate(() => window.ed.setHtml("<pre><code>\n</code></pre>"));
await page.evaluate(() => {
  const code = document.querySelector("#doc pre code");
  const range = document.createRange();
  range.selectNodeContents(code);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.type("**x**");
await page.waitForTimeout(60);
assert.equal(await count("pre strong"), 0, "代码块里不该转粗体");
assert.match(await html(), /\*\*x\*\*/, "代码块里的星号要原样留着");

// tools 过滤：只画列出来的按钮，也不画「更多」。
await page.evaluate(() => {
  const bar = document.createElement("div");
  bar.id = "tb2";
  const doc = document.createElement("div");
  doc.id = "doc2";
  document.body.append(bar, doc);
  window.ed2 = new window.NotesEditor.RichEditor({
    body: doc,
    toolbar: bar,
    onChange: () => {},
    tools: ["b", "i", "code"],
  });
});
const slim = await page.evaluate(() => [...document.querySelectorAll("#tb2 .tb-btn")].map((b) => b.title));
assert.deepEqual(slim, ["粗体（Ctrl+B）", "斜体", "代码块（整行输入 ``` 也行）"], `精简工具栏不对：${slim}`);

// onEnter：普通段落回车交给调用方；列表里仍续块。
await page.evaluate(() => {
  window.entered = 0;
  const bar = document.createElement("div");
  bar.id = "tb3";
  const doc = document.createElement("div");
  doc.id = "doc3";
  document.body.append(bar, doc);
  window.ed3 = new window.NotesEditor.RichEditor({
    body: doc,
    toolbar: bar,
    onChange: () => {},
    tools: [],
    onEnter: () => {
      window.entered += 1;
    },
  });
});
await page.evaluate(() => {
  window.ed3.setHtml("<p>发送</p><ul><li>项</li></ul>");
  window.ed3.focus();
});
await page.keyboard.press("Control+Home");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
assert.equal(await page.evaluate(() => window.entered), 1, "普通段落回车应交给 onEnter");

await page.evaluate(() => {
  const doc = document.getElementById("doc3");
  window.ed3.setHtml("<ul><li>x</li></ul>");
  doc.focus();
  const li = doc.querySelector("li");
  const range = document.createRange();
  range.selectNodeContents(li);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.keyboard.press("Enter");
assert.equal(await page.evaluate(() => window.entered), 1, "列表里回车不该触发 onEnter");
assert.equal(await page.evaluate(() => document.querySelectorAll("#doc3 li").length), 2, "列表里回车应继续加一项");

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

// 浏览器里 Ctrl+C 网页正文：clipboard 的 html 带 <html><head>…</head><body>，不能整次吞掉。
await page.evaluate(() => {
  window.ed.setHtml("<p>网页粘贴</p>");
  window.ed.focus();
  const dt = new DataTransfer();
  dt.setData(
    "text/html",
    '<html><head><meta charset="utf-8"><style>p{color:red}</style></head><body><div><strong>Error:</strong> cannot read properties of null</div></body></html>',
  );
  dt.setData("text/plain", "Error: cannot read properties of null");
  document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
out = await html();
assert.match(out, /cannot read properties of null/, `网页复制来的 HTML 粘不进来：${out}`);
assert.match(out, /<strong>Error:<\/strong>/, `网页复制来的粗体丢了：${out}`);
assert.doesNotMatch(out, /<html|<head|<meta|<style/i, `网页外冗的标签漏出来了：${out}`);

// 浏览器复制的多行文本是 `<div>一行</div>`：必须各占一段，不能拼成一行。
await page.evaluate(() => {
  window.ed.setHtml("<p>多行</p>");
  window.ed.focus();
  const dt = new DataTransfer();
  dt.setData("text/html", "<div>line one</div><div>line two</div>");
  dt.setData("text/plain", "line one\nline two");
  document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
out = await html();
assert.match(out, /line one/, `第一行丢了：${out}`);
assert.match(out, /<\/p><p>line two<\/p>/, `第二行没单独成段（被拼成一行？）：${out}`);
assert.doesNotMatch(out, /line oneline two/, `两行被拼成一行：${out}`);

// html 净化后为空（只剩被丢弃的容器）时退回纯文本：发出 preventDefault 之后不能静默吞掉这次粘贴。
await page.evaluate(() => {
  window.ed.setHtml("<p>退路</p>");
  window.ed.focus();
  const dt = new DataTransfer();
  dt.setData("text/html", "<style>p{}</style><div></div>");
  dt.setData("text/plain", "纯文本退路");
  document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
out = await html();
assert.match(out, /纯文本退路/, `净化后为空时没退回纯文本：${out}`);

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
