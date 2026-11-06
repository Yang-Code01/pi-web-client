/**
 * 工作区布局偏好（#97）：`layoutPref()` 是「设置里选了哪种壳」的唯一读口。渲染层用
 * `activeLayout()`（当前实现不了的 id 先按 A 画），存的值原样留着。#98 起四套都实现了，
 * `activeLayout()` 与 `layoutPref()` 因此等价 —— 但两个口子仍分开留着，别在别处直接读 prefs。
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

test("#98 四套都实现了：存什么就按什么画", () => {
  for (const id of LAYOUT_IDS) {
    assert.equal(layoutSupported(id), true);
    assert.equal(layoutPref({ layout: id }), id);
    assert.equal(activeLayout({ layout: id }), id);
  }
  assert.equal(activeLayout({}), "a");
  assert.equal(activeLayout({ layout: "z" }), "a", "脏值仍然回 A");
});

test("外壳那一层仍然认「实现不了就回 A」这条路：表里少一套时不会画出半套", () => {
  // 这不是在测一个能改的常量，而是在钉住 activeLayout 的契约 —— 哪天某套壳临时下线，
  // 存着的 id 必须原样留着（不迁数据）、渲染落到 A。
  assert.equal(typeof layoutSupported("b"), "boolean");
});

test("示意图与文案各自独立：label 是中文原文，交给调用处 tr()", () => {
  for (const l of LAYOUTS) {
    assert.equal(typeof l.label, "string");
    assert.ok(l.label.length > 0);
    assert.ok(!/^[a-d]$/i.test(l.label), "label 不能是 id 本身，否则 i18n 没得翻");
  }
});
