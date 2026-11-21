/**
 * 输入框上方那一行「重讲」的三态（D358）。纯函数只有 `retellState()` 一个口 —— 什么时候灰、
 * 什么时候不画全部由它决定，`app.ts` 不另写判断。
 *
 * Run: node --experimental-strip-types web/tests/retell-state-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { retellState } from "../src/retell-state.ts";

// ---------------------------------------------------------------- 不画

test("没开会话 → 不画（不是灰）", () => {
  assert.equal(retellState(null, true), "hidden");
  assert.equal(retellState(undefined, true), "hidden");
});

// ---------------------------------------------------------------- 灰

test("还没人答过 → 灰：没有可重讲的对象", () => {
  assert.equal(retellState({ running: false }, false), "off");
});

test("这一轮还在跑 → 灰：半截回答重讲没有意义", () => {
  assert.equal(retellState({ running: true }, true), "off");
});

test("老桥不发 running 字段也照常判断（缺省=闲，看回答有没有）", () => {
  assert.equal(retellState({}, true), "ready");
  assert.equal(retellState({}, false), "off");
});

// ---------------------------------------------------------------- 亮

test("停下了、有回答 → 可点", () => {
  assert.equal(retellState({ running: false }, true), "ready");
});

test("只读预览照样可点：发消息本来就会自动接管，重讲不比手打更特殊", () => {
  assert.equal(retellState({ running: false, owned: false }, true), "ready");
});
