/**
 * 预览里的翻译对照（D241）：只测不需要 DOM 的那几个纯函数 —— 默认目标语言怎么猜、语言名怎么显示、
 * 整篇译文怎么按节拼回去。按钮、选择器、同步确认卡的形状由浏览器探针把关。
 *
 * Run: node --experimental-strip-types web/tests/translateview-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { guessTrLang, trLangLabel, trText, TR_LANGS } from "../src/translateview.ts";

// ---------------------------------------------------------------- 默认翻成什么

test("日文源（有假名）默认翻中文", () => {
  assert.equal(guessTrLang("## 対象ツール\n\n対象：注文の変更ができるかどうかを確認する。"), "zh");
});

test("中文源默认翻英文", () => {
  assert.equal(guessTrLang("# 变更一览\n\n对象：检查能否修改订单。"), "en");
});

test("英文源、代码、空文本都兜底翻中文", () => {
  assert.equal(guessTrLang("# Message changes\n\nCheck whether the order can be updated."), "zh");
  assert.equal(guessTrLang(""), "zh");
  assert.equal(guessTrLang("```ts\nconst a = 1;\n```"), "zh");
});

test("只看开头两万字：长长的代码块不会把语言判断冲掉", () => {
  const jp = "メッセージ変更一覧\n".repeat(500);
  assert.equal(guessTrLang(`${jp}\n${"x".repeat(40000)}`), "zh");
});

// ---------------------------------------------------------------- 语言名

test("语言 id 显示成自称，不认识的 id 原样返回", () => {
  assert.deepEqual(
    TR_LANGS.map((l) => [l.id, l.label]),
    [
      ["zh", "中文"],
      ["en", "English"],
      ["ja", "日本語"],
      ["ko", "한국어"],
    ],
  );
  assert.equal(trLangLabel("ja"), "日本語");
  assert.equal(trLangLabel("fr"), "fr");
});

// ---------------------------------------------------------------- 整篇译文

test("译文按节用一个空行拼回去，没有 doc 时是空串", () => {
  assert.equal(trText({ sections: [{ heading: "", out: "A" }, { heading: "## x", out: "B" }] }), "A\n\nB");
  assert.equal(trText(null), "");
});
