/**
 * 选中文字 → Markdown 引用块（`web/src/quoteblock.ts`，D417）：聊天区那颗「问一下」把它塞进随手问。
 *
 * 钉住的是「引用的形状」：逐行 `> `、空行写成光秃秃的 `>`、首尾空行去掉、超长截断加省略号。
 * 改了形状就得改这里 —— 输入框里看到的样子与探针断言的字符串是同一份契约。
 *
 * Run: node --experimental-strip-types --test web/tests/quoteblock-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { QUOTE_MAX, quoteBlock } from "../src/quoteblock.ts";

test("单行：加一个 > 前缀", () => {
  assert.equal(quoteBlock("拖动选中不明显"), "> 拖动选中不明显");
});

test("多行：每一行都带 > ", () => {
  assert.equal(quoteBlock("第一行\n第二行"), "> 第一行\n> 第二行");
});

test("空行写成光秃秃的 >（拖选经常把段落之间的空行一起带上）", () => {
  assert.equal(quoteBlock("a\n\nb"), "> a\n>\n> b");
});

test("首尾空行去掉：拖选以换行开始 / 结束时不留下空心引用", () => {
  assert.equal(quoteBlock("\n\na\nb\n\n\n"), "> a\n> b");
  assert.equal(quoteBlock("   \n"), "");
  assert.equal(quoteBlock(""), "");
});

test("缩进保留（代码块靠它），行尾空白去掉", () => {
  assert.equal(quoteBlock("    const a = 1;   \n\ttab"), ">     const a = 1;\n> \ttab");
});

test("CRLF 归一：行首不会多出半个 \\r", () => {
  assert.equal(quoteBlock("a\r\nb\r\n"), "> a\n> b");
});

test("超长截断：只留 QUOTE_MAX 个字符并加省略号", () => {
  const out = quoteBlock("字".repeat(QUOTE_MAX + 500));
  assert.equal(out.startsWith("> "), true);
  assert.equal(out.endsWith("…"), true);
  assert.equal(out.length, 2 + QUOTE_MAX + 1);
});

test("max 传 0 表示不截断", () => {
  const text = "字".repeat(QUOTE_MAX + 500);
  assert.equal(quoteBlock(text, 0).length, 2 + text.length);
});
