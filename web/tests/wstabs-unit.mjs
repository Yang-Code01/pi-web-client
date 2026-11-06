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
import { tabModel } from "../src/wstabs.ts";

/** 左栏组序（`buildTree()` 排好的那一份；#121 里还没有固定组）。 */
const ORDER = ["g1", "g2", "g3", "g4", "g5"];

test("正好填满：名额 3、当前组在里面 → 前 3 颗，剩下的进 ＋N", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
  assert.equal(m.extra, false);
});

test("需要补位：固定 1 个 → 按组序补到名额", () => {
  const m = tabModel({ order: ORDER, pinned: ["g2"], max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g2", "g1", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
  assert.equal(m.extra, false);
});

test("只替最后一个：当前组在圈外、还有补位 → 挤掉最后那个补位，前面不动", () => {
  const m = tabModel({ order: ORDER, pinned: ["g1"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g5"]);
  assert.deepEqual(m.more, ["g3", "g4"]);
  assert.equal(m.extra, false);
});

test("多画一颗：固定组已占满名额、当前组在圈外 → N+1，模型里标出来", () => {
  const m = tabModel({ order: ORDER, pinned: ["g1", "g2", "g3"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3", "g5"]);
  assert.deepEqual(m.more, ["g4"]);
  assert.equal(m.extra, true);
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
  assert.equal(m.extra, false);
});

test("当前组为空：就是前 N 个（没会话 / 旧桥）", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 3 });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
  assert.equal(m.extra, false);
});

test("名额 0：只留当前组，并标成破例", () => {
  const m = tabModel({ order: ORDER, pinned: [], max: 0, current: "g1" });
  assert.deepEqual(m.visible, ["g1"]);
  assert.deepEqual(m.more, ["g2", "g3", "g4", "g5"]);
  assert.equal(m.extra, true);
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
  assert.equal(m.extra, false);
});

test("当前组在圈外：挤掉最后一个补位组，固定组一个都不动", () => {
  const m = tabModel({ order: ORDER, pinned: ["g3"], max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g3", "g1", "g5"], "g3 是固定的，被挤掉的是补位的 g2");
  assert.deepEqual(m.more, ["g2", "g4"]);
  assert.equal(m.extra, false);
});
