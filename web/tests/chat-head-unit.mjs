/**
 * 消息抬头那行「名字 · 时间」：网页端的可见文字，不启浏览器。
 *
 * 两件用户能直接看到的规矩：
 *   1. 时间缺了就**连分隔符一起省掉** —— 老桥发来的实时 assistant 条目没有 ts，以前抬头是「pi · 」；
 *   2. 非今天的那条带日期 —— 翻回上周，「15:32」是哪个 15:32 读不出来。
 *
 * Run: node --experimental-strip-types web/tests/chat-head-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { headLine, stampOf } from "../src/chat.ts";

const today = () => new Date().toISOString();
const longAgo = new Date(2020, 0, 2, 9, 5).toISOString();

test("没有 ts（老桥的实时条目）：只留名字，不留悬空的「 · 」", () => {
  assert.equal(headLine("pi"), "pi");
  assert.equal(headLine("你"), "你");
  assert.equal(stampOf(undefined), "");
});

test("ts 是坏字符串：当作没有，不画一个 NaN", () => {
  assert.equal(stampOf("not-a-date"), "");
  assert.equal(headLine("pi", "not-a-date"), "pi");
});

test("今天的那条只给时分（和用户消息同一个样子）", () => {
  assert.match(stampOf(today()), /^\d{2}:\d{2}$/);
  assert.match(headLine("pi", today()), /^pi · \d{2}:\d{2}$/);
});

test("不是今天的带上日期：年份和时分都在", () => {
  const stamp = stampOf(longAgo);
  assert.match(stamp, /2020/);
  assert.match(stamp, /\d{2}:\d{2}$/);
  assert.match(headLine("pi", longAgo), /^pi · .*2020.*\d{2}:\d{2}$/);
});

test("后缀（「 · 已中断」）接在时间后面；没有时间时直接接名字", () => {
  assert.match(headLine("pi", longAgo, " · 已中断"), / · 已中断$/);
  assert.equal(headLine("pi", undefined, " · 已中断"), "pi · 已中断");
});
