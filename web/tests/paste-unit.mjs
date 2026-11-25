/**
 * 大段粘贴的折块阈值（`web/src/paste.ts`）：聊天区与随手问共用这一份判据。
 *
 * 钉住的是「什么时候折」这条契约，不是具体数字的实现细节 —— 改阈值就得改这里，
 * 两边同时变，不会再出现「聊天区折了、随手问糊一整屏」。
 *
 * Run: node --experimental-strip-types --test web/tests/paste-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PASTE_CHARS, PASTE_LINES, shouldFoldPaste } from "../src/paste.ts";

// 这个文件是 .mjs（不走 strip-types 的类型剥离），辅助函数就别带类型注解。
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("短粘贴原样进框：5 行、399 字符都不折", () => {
  assert.equal(shouldFoldPaste(lines(PASTE_LINES - 1)), false);
  assert.equal(shouldFoldPaste("a".repeat(PASTE_CHARS - 1)), false);
});

test("到阈值就折：正好 6 行、正好 400 字符", () => {
  assert.equal(shouldFoldPaste(lines(PASTE_LINES)), true);
  assert.equal(shouldFoldPaste("a".repeat(PASTE_CHARS)), true);
});

test("行数按 \\n 数：CRLF 与末尾换行不会少算一行", () => {
  assert.equal(shouldFoldPaste(`${lines(PASTE_LINES - 1)}\r\n`), true);
  assert.equal(shouldFoldPaste(`x\r\ny`), false);
});

test("空串与单行不折", () => {
  assert.equal(shouldFoldPaste(""), false);
  assert.equal(shouldFoldPaste("想到什么就问什么"), false);
});
