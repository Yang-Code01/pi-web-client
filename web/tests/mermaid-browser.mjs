/**
 * Browser-level tests for Mermaid rendering in `web/src/md.ts` (doc mode) / `web/src/mermaid-view.ts`.
 *
 * Mermaid needs a real DOM (layout, SVG text measuring), so this bundles md.ts with esbuild and runs it
 * in Chromium, same pattern as mailhtml-browser.mjs.
 *
 *   node web/tests/mermaid-browser.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadPlaywright } from "../../tools/playwright.mjs";

const bundled = await build({
  stdin: {
    contents: `export { renderMarkdown } from "./src/md.ts"; export { mermaidTheme } from "./src/mermaid-view.ts";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "Md",
  platform: "browser",
  write: false,
  logLevel: "silent",
});
const code = bundled.outputFiles[0].text;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const src = [
  "# 设计",
  "",
  "```mermaid",
  "classDiagram",
  "  class Foo { +bar() void }",
  "  Foo --> Baz",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  A->>B: <img src=x onerror=alert(1)>hi",
  "```",
  "",
  "```mermaid",
  "this is not a diagram",
  "```",
  "",
  "```js",
  "const a = 1;",
  "```",
].join("\n");

// try/finally：evaluate 里最长等 20 秒，中途抛错也要关掉 Chromium，否则 node 不退出、CI 上表现为挂住。
let out;
try {
  const page = await browser.newPage({ locale: "zh-CN" });
  await page.setContent('<!doctype html><html data-theme="mac-light"><body></body></html>');
  await page.addScriptTag({ content: code });

  out = await page.evaluate(async (src) => {
    const doc = document.createElement("article");
    doc.append(Md.renderMarkdown(src, { doc: true }));
    document.body.append(doc);
    const chat = document.createElement("div");
    chat.append(Md.renderMarkdown("```mermaid\ngraph TD\n A-->B\n```"));
    document.body.append(chat);
    const end = Date.now() + 20000;
    while (Date.now() < end && doc.querySelector('.md-mermaid[data-state="pending"]')) await new Promise((r) => setTimeout(r, 100));
    const boxes = [...doc.querySelectorAll(".md-mermaid")];
    return {
      states: boxes.map((b) => b.dataset.state),
      svgs: boxes.map((b) => b.querySelectorAll("svg").length),
      classText: boxes[0]?.textContent ?? "",
      svgWidth: boxes[0]?.querySelector("svg")?.getAttribute("width") ?? null,
      svgViewBox: boxes[0]?.querySelector("svg")?.viewBox?.baseVal?.width ?? null,
      seqHasImg: boxes[1]?.querySelectorAll("img").length ?? -1,
      seqHasOnerror: boxes[1]?.querySelectorAll("[onerror]").length ?? -1,
      seqText: boxes[1]?.textContent ?? "",
      errPre: boxes[2]?.querySelector("pre")?.textContent ?? "",
      errMsg: boxes[2]?.querySelector(".md-mermaid-err")?.textContent ?? "",
      jsPre: doc.querySelectorAll(":scope > pre").length,
      chatMermaid: chat.querySelectorAll(".md-mermaid").length,
      chatPre: chat.querySelectorAll("pre").length,
      strayTemp: document.querySelectorAll('body > [id^="dmd-mermaid-"]').length,
      themes: [Md.mermaidTheme("mac-light"), Md.mermaidTheme("mac-dark"), Md.mermaidTheme(undefined)],
    };
  }, src);
} finally {
  await browser.close();
}

assert.deepEqual(out.states, ["ok", "ok", "error"], "两张合法图渲染成功、坏图标成 error");
assert.deepEqual(out.svgs, [1, 1, 0], "成功的块里是一张 svg，失败的块里没有");
assert.ok(out.classText.includes("Foo") && out.classText.includes("bar()"), "类图里有类名和方法名");
assert.ok(out.svgViewBox > 0 && Number(out.svgWidth) === Math.ceil(out.svgViewBox), "svg 按 viewBox 原始宽铺开（不是 width=100%，宽图靠横向滚动）");
assert.equal(out.seqHasImg, 0, "strict 模式下标签里的 <img> 被清掉");
assert.equal(out.seqHasOnerror, 0, "没有带 onerror 属性的元素进入页面");
assert.ok(out.seqText.includes("hi"), "清掉标签后正文还在");
assert.equal(out.errPre, "this is not a diagram", "坏图保留源码");
assert.match(out.errMsg, /^Mermaid 图渲染失败：/, "坏图下面写失败原因");
assert.equal(out.jsPre, 1, "普通代码块不受影响");
assert.equal(out.chatMermaid, 0, "聊天模式不画图");
assert.equal(out.chatPre, 1, "聊天模式照旧是代码块");
assert.equal(out.strayTemp, 0, "mermaid 的临时节点没有留在 body 里");
assert.deepEqual(out.themes, ["default", "dark", "dark"], "浅色主题用 default，其余用 dark");
console.log("mermaid-browser: ok", out.states);
