/**
 * 拖拽落点（#99）：`hitTest()` 决定「这条 2px 线画在哪、目标组是谁、插到第几位」，
 * `planDrop()` 决定「这一下松手该发什么消息」。都是纯函数，脱离页面单测。
 *
 * 探针（`probes/workspace-drag.mjs`）再把它们接到真的鼠标拖拽上。
 *
 * Run: node --experimental-transform-types web/tests/drag-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hitTest, planDrop, moveTo } from "../src/drag.ts";

/** 一行卡片的纵向占位（含 8px 间隙），便于把期望值写成独立于实现的字面量。 */
const item = (id, top, bottom) => ({ id, top, bottom });
const group = (wsId, top, bottom, items, contentTop = top + 24) => ({ wsId, top, bottom, contentTop, items });

const LIB = group("f:/lib", 0, 420, [item("a", 100, 180), item("b", 200, 280), item("c", 300, 380)]);
const BLOG = group("f:/blog", 430, 600, [item("x", 500, 580)]);
const EMPTY = group("manual:1", 610, 700, []);

// ---------------------------------------------------------------- 组内位置

test("第一张卡上半：插到最前，线画在第一张的上沿", () => {
  const hit = hitTest(120, [LIB, BLOG]);
  assert.equal(hit.wsId, "f:/lib");
  assert.equal(hit.index, 0);
  assert.equal(hit.line, 100);
  assert.equal(hit.pool, false);
});

test("越过第一张中线：插到第二张之前，线画在第二张的上沿", () => {
  const hit = hitTest(190, [LIB, BLOG]);
  assert.equal(hit.index, 1);
  assert.equal(hit.line, 200);
});

test("越过末张中线：插到最后，线画在末张的下沿", () => {
  const hit = hitTest(400, [LIB, BLOG]);
  assert.equal(hit.index, 3);
  assert.equal(hit.line, 380);
});

test("空组也是落点：插到第 0 位，线画在组头下面", () => {
  const hit = hitTest(650, [LIB, EMPTY]);
  assert.equal(hit.wsId, "manual:1");
  assert.equal(hit.index, 0);
  assert.equal(hit.line, EMPTY.contentTop);
});

test("落在组与组之间的空隙：归最近的一组，不会掉成「没有落点」", () => {
  // 425 恰在正中间（5 / 5），427 离 blog 更近（7 / 3）。
  const hit = hitTest(427, [LIB, BLOG]);
  assert.ok(hit, "空隙里有落点");
  assert.equal(hit.wsId, "f:/blog");
  assert.equal(hit.index, 0);
});

test("指针离整棵树很远：没有落点（渲染层清掉高亮）", () => {
  assert.equal(hitTest(2000, [LIB, BLOG]), null);
  assert.equal(hitTest(50, []), null);
});

// ---------------------------------------------------------------- 放回工程

test("「放回工程」优先于组：指针在它上面就是放回，不猜组与位置", () => {
  const hit = hitTest(650, [LIB, BLOG, EMPTY], { top: 620, bottom: 690 });
  assert.equal(hit.pool, true);
  assert.equal(hit.wsId, "");
  assert.equal(hit.index, -1);
});

test("指针不在「放回工程」上时不误判", () => {
  const hit = hitTest(150, [LIB, BLOG], { top: 620, bottom: 690 });
  assert.equal(hit.pool, false);
  assert.equal(hit.wsId, "f:/lib");
});

// ---------------------------------------------------------------- 该发什么

test("同组落点 → arrange（组内重排），带上插入位置", () => {
  const plan = planDrop("a", "f:/lib", { wsId: "f:/lib", index: 2, line: 300, pool: false });
  assert.deepEqual(plan, { action: "reorder", ids: ["a"], wsId: "f:/lib", index: 2 });
});

test("跨组落点 → ws.move，且不带位置（顺序交给桥与既有 order，别重写别的组）", () => {
  const plan = planDrop("a", "f:/lib", { wsId: "f:/blog", index: 1, line: 500, pool: false });
  assert.deepEqual(plan, { action: "move", ids: ["a"], wsId: "f:/blog" });
  assert.equal("index" in plan, false, "跨组消息里没有位置字段");
});

test("落到「放回工程」→ ws.move 且 wsId 为空串（= 删掉 override）", () => {
  const plan = planDrop("a", "f:/blog", { wsId: "", index: -1, line: 650, pool: true });
  assert.deepEqual(plan, { action: "restore", ids: ["a"], wsId: "" });
});

// ---------------------------------------------------------------- 结果顺序

test("moveTo：把 id 挪到「不含它」的列表里的第 index 位", () => {
  assert.deepEqual(moveTo(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
  assert.deepEqual(moveTo(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(moveTo(["a", "b", "c"], "b", 1), ["a", "b", "c"], "原地不动");
  assert.deepEqual(moveTo(["a"], "a", 0), ["a"]);
});
