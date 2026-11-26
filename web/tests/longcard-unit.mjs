/**
 * 超长条目摘要卡的标题数字（`web/src/longcard.ts`，D421）：`27 行 · 931 字` 里那两个数。
 *
 * 钉住三件事：`\r\n` 不算两行、空白不计入「字」、空消息是 0/0。改了数法就得改这里 ——
 * 卡片上那行小字与探针断言的字符串是同一份契约。
 *
 * Run: node --experimental-strip-types --test web/tests/longcard-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { longCardCounts } from "../src/longcard.ts";

test("单行：行数 1，字数按字符数（中文一个字一个）", () => {
  assert.deepEqual(longCardCounts("好，我先过一遍。"), { lines: 1, chars: 8 });
});

test("多行与空行：行数照换行数数，空行也算一行", () => {
  assert.deepEqual(longCardCounts("a\n\nb"), { lines: 3, chars: 2 });
});

test("Windows 换行不算两行", () => {
  assert.deepEqual(longCardCounts("第一行\r\n第二行"), { lines: 2, chars: 6 });
});

test("缩进与空白不计入字数", () => {
  assert.deepEqual(longCardCounts("  btn.onclick = 1;\n\t}\n"), { lines: 2, chars: 15 });
});

test("空消息是 0/0（卡片压根不该出现）", () => {
  assert.deepEqual(longCardCounts("   \n\t\n "), { lines: 0, chars: 0 });
});
