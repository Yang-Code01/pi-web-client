/**
 * Queue-tab attention memory for incoming questionnaires.
 *
 * Run: node --experimental-strip-types web/tests/ask-tab-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { badgeText, createTabMemory, reduce } from "../src/ask-tab.ts";

const wide = { compact: false };
const event = (type, count) => ({ type, count });

test("角标数字隐藏零值并截断到 9+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(9), "9");
  assert.equal(badgeText(10), "9+");
});

test("问卷到达时从执行切到需要你，并记住原标签", () => {
  const next = reduce(createTabMemory("exec"), event("asks", 1), wide);
  assert.deepEqual(next, { tab: "needs", recall: "exec", auto: true, asksCount: 1, approvalsCount: 0 });
});

test("已经在需要你时问卷到达不产生自动切换记忆", () => {
  const next = reduce(createTabMemory("needs"), event("asks", 1), wide);
  assert.deepEqual(next, { tab: "needs", recall: null, auto: false, asksCount: 1, approvalsCount: 0 });
});

test("用户手动切走后不会被现有问卷拉回，下一份问卷才重新自动切", () => {
  let memory = reduce(createTabMemory("exec"), event("asks", 1), wide);
  memory = reduce(memory, { type: "user-tab", tab: "exec" }, wide);
  assert.deepEqual(memory, { tab: "exec", recall: null, auto: false, asksCount: 1, approvalsCount: 0 });
  memory = reduce(memory, event("asks", 2), wide);
  assert.deepEqual(memory, { tab: "needs", recall: "exec", auto: true, asksCount: 2, approvalsCount: 0 });
});

test("最后一份问卷清空且没有批准时还原原标签", () => {
  let memory = reduce(createTabMemory("exec"), event("asks", 2), wide);
  memory = reduce(memory, event("asks", 0), wide);
  assert.deepEqual(memory, { tab: "exec", recall: null, auto: false, asksCount: 0, approvalsCount: 0 });
});

test("问卷先清空时等最后一张批准卡结束后才还原", () => {
  let memory = reduce(createTabMemory("exec"), event("asks", 1), wide);
  memory = reduce(memory, event("approvals", 1), wide);
  memory = reduce(memory, event("asks", 0), wide);
  assert.deepEqual(memory, { tab: "needs", recall: "exec", auto: true, asksCount: 0, approvalsCount: 1 });
  memory = reduce(memory, event("approvals", 0), wide);
  assert.deepEqual(memory, { tab: "exec", recall: null, auto: false, asksCount: 0, approvalsCount: 0 });
});

test("批准变化不触发自动切换", () => {
  const next = reduce(createTabMemory("exec"), event("approvals", 1), wide);
  assert.deepEqual(next, { tab: "exec", recall: null, auto: false, asksCount: 0, approvalsCount: 1 });
});

test("窄屏既不自动切换，也不自动还原", () => {
  const narrow = { compact: true };
  let memory = reduce(createTabMemory("exec"), event("asks", 1), narrow);
  assert.deepEqual(memory, { tab: "exec", recall: null, auto: false, asksCount: 1, approvalsCount: 0 });

  memory = reduce(createTabMemory("exec"), event("asks", 1), wide);
  memory = reduce(memory, event("asks", 0), narrow);
  assert.deepEqual(memory, { tab: "needs", recall: "exec", auto: true, asksCount: 0, approvalsCount: 0 });
  memory = reduce(memory, event("asks", 0), wide);
  assert.deepEqual(memory, { tab: "exec", recall: null, auto: false, asksCount: 0, approvalsCount: 0 });
});

test("刷新后快照里的待答问卷同样会自动切换", () => {
  const next = reduce(createTabMemory("exec"), event("asks", 3), wide);
  assert.equal(next.tab, "needs");
  assert.equal(next.recall, "exec");
});

test("多份问卷只记住第一次自动切换前的标签", () => {
  let memory = reduce(createTabMemory("exec"), event("asks", 1), wide);
  memory = reduce(memory, event("asks", 3), wide);
  assert.equal(memory.recall, "exec");
  assert.equal(memory.asksCount, 3);
});
