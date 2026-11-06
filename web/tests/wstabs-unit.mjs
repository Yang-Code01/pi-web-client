/**
 * #121：标签行只画 N 个 + `＋N` 的几何（纯函数）。
 *
 * 只测「组序 / 固定组 / 名额 / 当前组 → 可见标签 + 被折叠的组」这一层。DOM 排布、下拉的开关、
 * 点一行切组由 `probes/workspace-tabs.mjs` 把关，那才是它的公开缝。
 *
 * Run: node --experimental-transform-types web/tests/wstabs-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveFixed, tabHitTest, tabModel, tabReorder } from "../src/wstabs.ts";

/** 左栏组序（`buildTree()` 排好的那一份；#121 里还没有固定组）。 */
const ORDER = ["g1", "g2", "g3", "g4", "g5"];

test("正好填满：名额 3、当前组在里面 → 前 3 颗，剩下的进 ＋N", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
});

test("需要补位：固定 1 个 → 按组序补到名额", () => {
  const m = tabModel({ order: ORDER, pinned: ["g2"], max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g2", "g1", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
});

test("只替最后一个：当前组在圈外、还有补位 → 挤掉最后那个补位，前面不动", () => {
  const m = tabModel({ order: ORDER, pinned: ["g1"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g5"]);
  assert.deepEqual(m.more, ["g3", "g4"]);
});

test("多画一颗：固定组已占满名额、当前组在圈外 → N+1", () => {
  const m = tabModel({ order: ORDER, pinned: ["g1", "g2", "g3"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3", "g5"]);
  assert.deepEqual(m.more, ["g4"]);
});

test("重复与脏 id：pinned 去重、不在组序里的剔掉（当前组照旧进圈）", () => {
  const m = tabModel({ order: ORDER, pinned: ["g2", "g2", "nope", "g1"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g2", "g1", "g5"]);
  assert.deepEqual(m.more, ["g3", "g4"]);
});

test("名额大于组数：有几个画几个，不凭空造组", () => {
  const m = tabModel({ order: ["a", "b"], pinned: [], max: 5, current: "b" });
  assert.deepEqual(m.visible, ["a", "b"]);
  assert.deepEqual(m.more, []);
});

test("当前组为空：就是前 N 个（没会话 / 旧桥）", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 3 });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
});

test("名额 0：只剩当前组", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 0, current: "g1" });
  assert.deepEqual(m.visible, ["g1"]);
  assert.deepEqual(m.more, ["g2", "g3", "g4", "g5"]);
});

// ---------------------------------------------------------------- #121/#123 共用尺子（去重 / 剔脏 / 截断）

test("共用尺子：去重、剔脏、截到名额；顺序就是传进来的顺序", () => {
  const known = new Set(["g1", "g2", "g3"]);
  assert.deepEqual(effectiveFixed(["g2", "g2", "nope", "g1", "g3"], known, 2), ["g2", "g1"]);
  assert.deepEqual(effectiveFixed(["g1", "g2"], known, 0), []);
  assert.deepEqual(effectiveFixed([], known, 3), []);
});

// ---------------------------------------------------------------- #122 固定组落到标签行

test("固定组排在最前，顺序就是固定顺序（不按左栏组序重排）", () => {
  const m = tabModel({ order: ORDER, pinned: ["g4", "g2"], max: 3, current: "g4" });
  assert.deepEqual(m.visible, ["g4", "g2", "g1"]);
  assert.deepEqual(m.more, ["g3", "g5"]);
});

test("固定组超出名额：截到名额，多出来的回到 ＋N（按组序）", () => {
  const m = tabModel({ order: ORDER, pinned: ["g4", "g5", "g2", "g1"], max: 3, current: "g4" });
  assert.deepEqual(m.visible, ["g4", "g5", "g2"]);
  assert.deepEqual(m.more, ["g1", "g3"]);
});

test("当前组在圈外：挤掉最后一个补位组，固定组一个都不动", () => {
  const m = tabModel({ order: ORDER, pinned: ["g3"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g3", "g1", "g5"], "g3 是固定的，被挤掉的是补位的 g2");
  assert.deepEqual(m.more, ["g2", "g4"]);
});

// ---------------------------------------------------------------- #124 固定组拖拽重排

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

test("重排：拖到另一颗右半边 → 插到它后面（两颗对调）", () => {
  assert.deepEqual(tabReorder(["a", "b"], "a", { id: "b", side: "after" }), ["b", "a"]);
});

test("重排：拖到另一颗左半边 → 插到它前面", () => {
  assert.deepEqual(tabReorder(["a", "b", "c"], "c", { id: "a", side: "before" }), ["c", "a", "b"]);
});

test("重排：拖回原位 → null（一个字都不发）", () => {
  assert.equal(tabReorder(["a", "b", "c"], "a", { id: "b", side: "before" }), null);
  assert.equal(tabReorder(["a", "b", "c"], "c", { id: "b", side: "after" }), null);
});

test("重排：落点是自己 / 自己不在列表里 / 落点不在这几颗里 → null", () => {
  assert.equal(tabReorder(["a", "b"], "a", { id: "a", side: "after" }), null);
  assert.equal(tabReorder(["a", "b"], "x", { id: "b", side: "after" }), null);
  assert.equal(tabReorder(["a", "b"], "a", { id: "nope", side: "after" }), null);
  assert.equal(tabReorder(["a", "b"], "a", null), null);
});

test("哪些能拖：visible 前面的固定组才是 fixed，补位与当前挤进来的都不算", () => {
  assert.deepEqual(tabModel({ order: ORDER, pinned: ["g4", "g2"], max: 3, current: "g4" }).fixed, ["g4", "g2"]);
  assert.deepEqual(tabModel({ order: ORDER, pinned: ["g3"], max: 3, current: "g5" }).fixed, ["g3"]);
  assert.deepEqual(tabModel({ order: ORDER, pinned: [], max: 3, current: "g1" }).fixed, []);
  assert.deepEqual(tabModel({ order: ORDER, pinned: ["g1", "g2", "g3"], max: 3, current: "g5" }).fixed, ["g1", "g2", "g3"]);
});
