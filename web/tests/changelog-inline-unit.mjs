/**
 * 行内 markdown 的纯单测（`node --experimental-strip-types --test web/tests/changelog-inline-unit.mjs`）。
 *
 * 重点不是排版（排版靠 probes/changelog-page.mjs），而是**转义与链接协议**：条目正文会进
 * `innerHTML`，而 `href` 是页面自己的执行上下文。`[点我](javascript:…)` 这种必须只留文字。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { inlineHtml, safeHref } from "../src/md-inline.ts";

test("HTML 一律转义，标签不会真的生效", () => {
  assert.equal(inlineHtml("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(inlineHtml('引号"与&符'), "引号&quot;与&amp;符");
});

test("行内代码与粗体", () => {
  assert.equal(inlineHtml("跑 `pi --mode rpc` 看看"), "跑 <code>pi --mode rpc</code> 看看");
  assert.equal(inlineHtml("**桥端**解析"), "<strong>桥端</strong>解析");
});

test("http(s) 与 mailto 链接照常可点", () => {
  assert.equal(
    inlineHtml("[PR](https://github.com/o/r/pull/671)"),
    '<a href="https://github.com/o/r/pull/671" target="_blank" rel="noreferrer">PR</a>',
  );
  assert.match(inlineHtml("[信](mailto:a@b.c)"), /^<a href="mailto:a@b\.c"/);
});

test("相对地址照旧当普通链接（同源导航）", () => {
  assert.match(inlineHtml("[决定](docs/DECISIONS.md)"), /^<a href="docs\/DECISIONS\.md"/);
  assert.match(inlineHtml("[这段](#d405)"), /^<a href="#d405"/);
});

test("危险协议只留文字，不造 <a>", () => {
  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html;base64,PHN2Zz4=", "vbscript:msgbox(1)"]) {
    const html = inlineHtml(`[点我](${href})`);
    assert.ok(!html.includes("<a "), `${href} 不许变成链接：${html}`);
    assert.ok(!html.includes("href"), `${href} 不许带 href：${html}`);
    // 链接语法本身只认到第一个 `)`，剩下那个落成普通文字 —— 无害，只保证不造 `<a>`。
    assert.ok(html.startsWith("点我"), `${href} 应只留文字：${html}`);
  }
});

test("safeHref 的判据", () => {
  assert.equal(safeHref("https://a.b/c"), true);
  assert.equal(safeHref("HTTPS://a.b/c"), true);
  assert.equal(safeHref("mailto:x@y.z"), true);
  assert.equal(safeHref("docs/DECISIONS.md"), true);
  assert.equal(safeHref("#d405"), true);
  assert.equal(safeHref("javascript:1"), false);
  assert.equal(safeHref(" javascript:1"), false, "前导空格不算相对地址（浏览器会 trim 掉再当 scheme 用）");
  assert.equal(safeHref("java\tscript:1"), false, "夹 tab 的写法浏览器也认，这里同样拒");
  assert.equal(safeHref("file:///C:/Windows"), false);
});

test("地址里的 & 已转义，不会把属性截断", () => {
  assert.equal(
    inlineHtml("[搜](https://a.b/?q=1&r=2)"),
    '<a href="https://a.b/?q=1&amp;r=2" target="_blank" rel="noreferrer">搜</a>',
  );
});

test("粗体在链接文字里也成立", () => {
  assert.equal(
    inlineHtml("[**重**](https://a.b)"),
    '<a href="https://a.b" target="_blank" rel="noreferrer"><strong>重</strong></a>',
  );
});
