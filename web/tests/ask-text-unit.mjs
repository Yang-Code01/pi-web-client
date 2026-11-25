/**
 * 提问卡片上的文字：字面 `\n` 折行、反引号片段切出来（`web/src/ask-text.ts` 的纯函数层）。
 *
 * 这两条都来自真实卡片：一张的题干里横着 `\n\n`，另一张的选项说明原样露出
 * `` `bridge/src/rpc.ts` `` 和 Windows 路径。卡片由 `web/src/app.ts` 的 `askText()` 渲染，
 * 这里只钉住「文本怎么变」，不碰 DOM。
 *
 * Run: node --experimental-strip-types --test web/tests/ask-text-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cardPieces, splitInlineCode, unfoldNewlines } from "../src/ask-text.ts";

test("字面 \\n 折成真换行（模型把换行二次转义）", () => {
  assert.equal(unfoldNewlines("报告写好了：a.html\\n\\n四个候选，末尾是建议。"), "报告写好了：a.html\n\n四个候选，末尾是建议。");
});

test("真换行原样保留，不去碰里面的 \\n", () => {
  const s = "第一行\n正则 /a\\nb/ 里的写法";
  assert.equal(unfoldNewlines(s), s);
});

test("空串与没有反斜杠的文本原样返回", () => {
  assert.equal(unfoldNewlines(""), "");
  assert.equal(unfoldNewlines("普通一句话"), "普通一句话");
});

test("反引号片段切成 code，反引号本身不进文字", () => {
  const pieces = splitInlineCode("改 `bridge/src/rpc.ts` 里的 write，别动 `claimChild`");
  assert.deepEqual(pieces, [
    { kind: "text", text: "改 " },
    { kind: "code", text: "bridge/src/rpc.ts" },
    { kind: "text", text: " 里的 write，别动 " },
    { kind: "code", text: "claimChild" },
  ]);
  assert.equal(pieces.map((p) => p.text).join(""), "改 bridge/src/rpc.ts 里的 write，别动 claimChild");
});

test("不配对的反引号按普通字符留着，不吞掉后半段", () => {
  assert.deepEqual(splitInlineCode("只有一个 ` 反引号"), [{ kind: "text", text: "只有一个 ` 反引号" }]);
});

test("空串切出空数组，纯代码也认", () => {
  assert.deepEqual(splitInlineCode(""), []);
  assert.deepEqual(splitInlineCode("`x`"), [{ kind: "code", text: "x" }]);
});

test("cardPieces 先切反引号再折行（代码里的 `\\n` 是内容本身）", () => {
  assert.deepEqual(cardPieces("先看 `a.ts`\\n再看 `b.ts`"), [
    { kind: "text", text: "先看 " },
    { kind: "code", text: "a.ts" },
    { kind: "text", text: "\n再看 " },
    { kind: "code", text: "b.ts" },
  ]);
});

test("反引号里的 \\n 不折：文本在谈论转义本身时不能被改写", () => {
  assert.deepEqual(cardPieces("把字面的 `\\n\\n` 折成真换行"), [
    { kind: "text", text: "把字面的 " },
    { kind: "code", text: "\\n\\n" },
    { kind: "text", text: " 折成真换行" },
  ]);
});

test("真换行与字面 \\n 混在一段里：只折没分行的那几段", () => {
  assert.deepEqual(cardPieces("第一行\n第二行 `a`\\n第三行"), [
    { kind: "text", text: "第一行\n第二行 " },
    { kind: "code", text: "a" },
    { kind: "text", text: "\n第三行" },
  ]);
});
