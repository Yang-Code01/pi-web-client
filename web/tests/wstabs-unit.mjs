/**
 * #173：标签行几何（纯函数）—— 一份 `order` + 名额 + 当前组 → 画哪几颗 + 收进 `＋N` 的组。
 *
 * 只测这一层。DOM 排布、下拉的开关、点一行切组由 `probes/workspace-tabs.mjs` 把关，那才是它
 * 的公开缝。#173 起「固定 / 补位」退役：顺序只有 `order` 一份，当前组不在前 `max` 时占最后一格。
 *
 * Run: node --experimental-transform-types web/tests/wstabs-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampMax, TABS_MAX, TABS_MIN, tabHitTest, tabModel, tabReorder } from "../src/wstabs.ts";

/** 桥下发的一份顺序（左栏与横条共用）。 */
const ORDER = ["g1", "g2", "g3", "g4", "g5"];

test("前 max 颗：名额 3、当前组在里面 → 前 3 颗，剩下的进 ＋N", () => {
  const m = tabModel({ order: ORDER, max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
});

test("当前组在圈外：占最后一格，原第 max 颗进 ＋N（横条不超 max）", () => {
  const m = tabModel({ order: ORDER, max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g5"]);
  assert.deepEqual(m.more, ["g3", "g4"]);
});

test("当前组在圈外、名额 1：唯一那颗就是当前组", () => {
  const m = tabModel({ order: ORDER, max: 1, current: "g4" });
  assert.deepEqual(m.visible, ["g4"]);
  assert.deepEqual(m.more, ["g1", "g2", "g3", "g5"], "more 保持 order 顺序，不含已画的那颗");
});

test("名额大于组数：有几个画几个，不凭空造组", () => {
  const m = tabModel({ order: ["a", "b"], max: 5, current: "b" });
  assert.deepEqual(m.visible, ["a", "b"]);
  assert.deepEqual(m.more, []);
});

test("当前组为空 / 不在 order 里：就是前 max 颗（没会话 / 旧快照）", () => {
  assert.deepEqual(tabModel({ order: ORDER, max: 3 }).visible, ["g1", "g2", "g3"]);
  assert.deepEqual(tabModel({ order: ORDER, max: 3, current: "ghost" }).visible, ["g1", "g2", "g3"]);
});

test("名额 0：什么都不画，全部进 ＋N", () => {
  const m = tabModel({ order: ORDER, max: 0, current: "g1" });
  assert.deepEqual(m.visible, []);
  assert.deepEqual(m.more, ORDER);
});

test("名额进页面先按 1–5 夹住", () => {
  assert.equal(clampMax(0), TABS_MIN);
  assert.equal(clampMax(99), TABS_MAX);
  assert.equal(clampMax(2.7), 2);
  assert.equal(TABS_MIN, 1);
  assert.equal(TABS_MAX, 5);
});

// ---------------------------------------------------------------- #124 横向落点（#173 沿用）

/** 标签行里两颗标签的横向占位（左边界含、右边界含）。 */
const RECTS = [
  { id: "a", left: 0, right: 100 },
  { id: "b", left: 104, right: 204 },
];

test("横向落点：左半 → before，右半 → after", () => {
  assert.deepEqual(tabHitTest(20, RECTS), { id: "a", side: "before" });
  assert.deepEqual(tabHitTest(80, RECTS), { id: "a", side: "after" });
  assert.deepEqual(tabHitTest(120, RECTS), { id: "b", side: "before" });
  assert.deepEqual(tabHitTest(190, RECTS), { id: "b", side: "after" });
});

test("横向落点：正中线算右半（差一像素就换边）", () => {
  assert.deepEqual(tabHitTest(49, RECTS), { id: "a", side: "before" });
  assert.deepEqual(tabHitTest(50, RECTS), { id: "a", side: "after" });
  assert.deepEqual(tabHitTest(51, RECTS), { id: "a", side: "after" });
});

test("横向落点：第一颗之前贴它的 before，最后一颗之后贴它的 after", () => {
  assert.deepEqual(tabHitTest(-30, RECTS), { id: "a", side: "before" });
  assert.deepEqual(tabHitTest(400, RECTS), { id: "b", side: "after" });
});

test("横向落点：标签间的空隙归右边那颗的 before（与上一颗的 after 是同一个插入位）", () => {
  assert.deepEqual(tabHitTest(102, RECTS), { id: "b", side: "before" });
});

test("横向落点：一颗标签都没有 → null", () => {
  assert.equal(tabHitTest(10, []), null);
});

// ---------------------------------------------------------------- #173 在整份 order 上重排

test("重排：在整份 order 上只搬一颗，其余（含折叠组）相对位置不变", () => {
  assert.deepEqual(tabReorder(ORDER, "g5", { id: "g1", side: "before" }), ["g5", "g1", "g2", "g3", "g4"]);
  assert.deepEqual(tabReorder(ORDER, "g2", { id: "g4", side: "after" }), ["g1", "g3", "g4", "g2", "g5"]);
  assert.deepEqual(tabReorder(ORDER, "g1", { id: "g3", side: "after" }), ["g2", "g3", "g1", "g4", "g5"]);
});

test("重排：拖回原位 → null（一个字都不发）", () => {
  assert.equal(tabReorder(ORDER, "g1", { id: "g2", side: "before" }), null);
  assert.equal(tabReorder(ORDER, "g3", { id: "g2", side: "after" }), null);
});

test("重排：落点是自己 / 自己不在 order 里 / 落点不在这份 order 里 → null", () => {
  assert.equal(tabReorder(ORDER, "g1", { id: "g1", side: "after" }), null);
  assert.equal(tabReorder(ORDER, "x", { id: "g2", side: "after" }), null);
  assert.equal(tabReorder(ORDER, "g1", { id: "nope", side: "after" }), null);
  assert.equal(tabReorder(ORDER, "g1", null), null);
});
