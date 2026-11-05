/**
 * 工作区布局偏好（#97）：`layoutPref()` 是「设置里选了哪种壳」的唯一读口，#98 点亮 B/C/D 时
 * 只加壳、不改这里。渲染层用 `activeLayout()`（当前实现不了的 id 先按 A 画），存的值原样留着。
 *
 * 只测纯函数。设置面板四颗 chip、切完立刻生效、刷新保留、恢复默认回 A 由
 * `probes/workspace-layout.mjs` 的浏览器探针把关。
 *
 * Run: node --experimental-transform-types web/tests/layout-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { activeLayout, layoutPref, layoutSupported, LAYOUTS, LAYOUT_IDS } from "../src/layout.ts";

// ---------------------------------------------------------------- 读口

test("没存过 / 没这一项 → 默认 A", () => {
  assert.equal(layoutPref(undefined), "a");
  assert.equal(layoutPref(null), "a");
  assert.equal(layoutPref({}), "a");
  assert.equal(layoutPref({ layout: undefined }), "a");
});

test("四种 id 都认，且只有这四个", () => {
  assert.deepEqual([...LAYOUT_IDS], ["a", "b", "c", "d"]);
  for (const id of LAYOUT_IDS) assert.equal(layoutPref({ layout: id }), id);
  assert.deepEqual(
    LAYOUTS.map((l) => l.id),
    [...LAYOUT_IDS],
  );
});

test("大小写 / 空白会被规范掉：localStorage 里的人手改动不该把界面弄成默认", () => {
  assert.equal(layoutPref({ layout: " B " }), "b");
  assert.equal(layoutPref({ layout: "C" }), "c");
});

test("乱值一律回 A：刷新不会因为一条脏记录就打不开界面", () => {
  assert.equal(layoutPref({ layout: "e" }), "a");
  assert.equal(layoutPref({ layout: "" }), "a");
  assert.equal(layoutPref({ layout: 3 }), "a");
  assert.equal(layoutPref({ layout: ["a"] }), "a");
  assert.equal(layoutPref({ layout: { id: "a" } }), "a");
  assert.equal(layoutPref("b"), "a");
});

// ---------------------------------------------------------------- 渲染口

test("#97 只实现 A：其余三种存得下、但先按 A 画", () => {
  assert.equal(layoutSupported("a"), true);
  for (const id of ["b", "c", "d"]) {
    assert.equal(layoutSupported(id), false);
    assert.equal(layoutPref({ layout: id }), id);
    assert.equal(activeLayout({ layout: id }), "a");
  }
  assert.equal(activeLayout({ layout: "a" }), "a");
  assert.equal(activeLayout({}), "a");
});

test("示意图与文案各自独立：label 是中文原文，交给调用处 tr()", () => {
  for (const l of LAYOUTS) {
    assert.equal(typeof l.label, "string");
    assert.ok(l.label.length > 0);
    assert.ok(!/^[a-d]$/i.test(l.label), "label 不能是 id 本身，否则 i18n 没得翻");
  }
});
