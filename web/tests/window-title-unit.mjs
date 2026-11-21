/**
 * D358：浏览器 tab 标题只有一个算法 —— 注入前缀（测试实例）→ 会话标题 → `pi`。
 * 正式实例没有前缀，必须还是原来的「会话 · pi」/「pi」。
 *
 *   node --experimental-strip-types --test web/tests/window-title-unit.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { documentTitle, windowTitlePrefix } from "../src/window-title.ts";

test("正式实例：没有前缀时照旧", () => {
  assert.equal(documentTitle(null, ""), "pi");
  assert.equal(documentTitle(undefined, ""), "pi");
  assert.equal(documentTitle("会话甲", ""), "会话甲 · pi");
});

test("测试实例：前缀顶在最前，会话标题跟在后面", () => {
  assert.equal(documentTitle(null, "测试 t1"), "测试 t1");
  assert.equal(documentTitle("会话甲", "测试 t1"), "测试 t1 · 会话甲");
});

test("空白的会话标题不算标题", () => {
  assert.equal(documentTitle("   ", "测试 t1"), "测试 t1");
  assert.equal(documentTitle("   ", ""), "pi");
});

test("前缀从注入的全局读，非字符串一律当没有", () => {
  assert.equal(windowTitlePrefix({ __piWindowTitle: "测试 t3" }), "测试 t3");
  assert.equal(windowTitlePrefix({ __piWindowTitle: "  测试 t3  " }), "测试 t3");
  assert.equal(windowTitlePrefix({ __piWindowTitle: "" }), "");
  assert.equal(windowTitlePrefix({ __piWindowTitle: 42 }), "");
  assert.equal(windowTitlePrefix({}), "");
  assert.equal(windowTitlePrefix(), "", "真浏览器里没注入时不该报错");
});
