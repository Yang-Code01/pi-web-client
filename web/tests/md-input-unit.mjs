/**
 * #511 Markdown 输入规则：块级 / 行内的纯函数层，以及导出时语言名的往返。
 *
 * Run: node --experimental-strip-types --test web/tests/md-input-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchBlock, matchInline } from "../src/md-input.ts";
import { richToMarkdown, sanitizeRich } from "../src/notes/rich.ts";

// ---------------------------------------------------------------- 块级

test("块级：`- ` / `* ` 转无序列表，标记长度算空格", () => {
  assert.deepEqual(matchBlock("- ", 2), { kind: "ul", marker: 2, rest: "" });
  assert.deepEqual(matchBlock("* ", 2), { kind: "ul", marker: 2, rest: "" });
  assert.equal(matchBlock("-", 1), null);
  assert.equal(matchBlock("-  ", 3), null);
});

test("块级：`1. ` / `12. ` 转有序列表", () => {
  assert.deepEqual(matchBlock("1. ", 3), { kind: "ol", marker: 3, rest: "" });
  assert.deepEqual(matchBlock("12. ", 4), { kind: "ol", marker: 4, rest: "" });
  assert.equal(matchBlock("1.", 2), null);
});

test("块级：`# ` 到 `### ` 转标题，`#### ` 及以上不转", () => {
  assert.equal(matchBlock("# ", 2)?.kind, "h1");
  assert.equal(matchBlock("## ", 3)?.kind, "h2");
  assert.equal(matchBlock("### ", 4)?.kind, "h3");
  assert.equal(matchBlock("#### ", 5), null);
  assert.equal(matchBlock("####### ", 8), null);
});

test("块级：`> ` 转引用，标记必须落在行首", () => {
  assert.deepEqual(matchBlock("> ", 2), { kind: "blockquote", marker: 2, rest: "" });
  assert.equal(matchBlock(" > ", 3), null);
});

test("块级：光标不在标记末尾就不转（后面已有文字也一样）", () => {
  assert.equal(matchBlock("- 已经写了", 2), null);
  assert.equal(matchBlock("# 标题", 2), null);
  assert.equal(matchBlock("- 已写", 2), null);
});

// ---------------------------------------------------------------- 行内

test("行内：`**粗**` 闭合即转，内容已转义", () => {
  assert.deepEqual(matchInline("**粗**", 5), { from: 0, to: 5, html: "<strong>粗</strong>" });
  assert.deepEqual(matchInline("a **<b>**", 9)?.html, "<strong>&lt;b&gt;</strong>");
});

test("行内：单个 `*` 转斜体，`**` 不会被拆成两次斜体", () => {
  assert.deepEqual(matchInline("*斜*", 3), { from: 0, to: 3, html: "<em>斜</em>" });
  assert.equal(matchInline("**粗**", 5)?.html, "<strong>粗</strong>");
  assert.equal(matchInline("**", 2), null);
  assert.equal(matchInline("*a**", 4), null);
});

test("行内：`*` 内容首尾是空白不转（Markdown 的常规要求）", () => {
  assert.equal(matchInline("** a**", 6), null);
  assert.equal(matchInline("* a*", 4), null);
});

test("行内：行内代码与删除线", () => {
  assert.deepEqual(matchInline("`码`", 3), { from: 0, to: 3, html: "<code>码</code>" });
  assert.deepEqual(matchInline("~~删~~", 5), { from: 0, to: 5, html: "<s>删</s>" });
  assert.equal(matchInline("``", 2), null);
});

test("行内：链接只认 http(s) 与站内 `/`，javascript: 不转", () => {
  assert.deepEqual(matchInline("[文字](https://x.com/a)", 21), {
    from: 0,
    to: 21,
    html: '<a href="https://x.com/a">文字</a>',
  });
  assert.equal(matchInline("[站内](/notes/1)", 14)?.html, '<a href="/notes/1">站内</a>');
  assert.equal(matchInline("[坏](javascript:alert(1))", 26), null);
  assert.equal(matchInline("[空]()", 5), null);
});

test("行内：前面有文字时 from 相对段落起点", () => {
  assert.deepEqual(matchInline("前 **粗**", 7), { from: 2, to: 7, html: "<strong>粗</strong>" });
});

// ---------------------------------------------------------------- 导出 / 往返

test("净化：代码块语言 class 保留，其他 class 丢掉", () => {
  assert.equal(sanitizeRich('<pre><code class="language-ts">const a = 1</code></pre>'), '<pre><code class="language-ts">const a = 1</code></pre>');
  assert.equal(sanitizeRich('<pre><code class="evil language-py">x</code></pre>'), '<pre><code class="language-py">x</code></pre>');
});

test("净化：站内 `/` 链接保留，javascript: 只留文字", () => {
  assert.equal(sanitizeRich('<a href="/x">a</a>'), '<a href="/x">a</a>');
  assert.equal(sanitizeRich('<a href="javascript:alert(1)">a</a>'), "a");
});

test("导出 Markdown：代码块带语言", () => {
  assert.equal(richToMarkdown('<pre><code class="language-ts">const a = 1</code></pre>'), "```ts\nconst a = 1\n```");
  assert.equal(richToMarkdown("<pre><code>x</code></pre>"), "```\nx\n```");
});
