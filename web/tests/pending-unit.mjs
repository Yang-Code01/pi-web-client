/**
 * 会话卡「待确认」清不掉的那条账（D156）：`applyPending` / `badgeSession` 的纯函数层。
 *
 * Run: node --experimental-transform-types web/tests/pending-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyPending, badgeSession, syncPending } from "../src/pending.ts";

const s = (id, over = {}) => ({ id, name: id, cwd: "f:/x", file: null, owned: false, running: false, done: false, updatedAt: 0, approvals: 0, asks: 0, ...over });

test("提问只加在 asks 上，答完能减回去（别把 ask 记成 approvals）", () => {
  const list = [s("a")];
  applyPending(list, "a", "asks", 1);
  assert.deepEqual([list[0].asks, list[0].approvals], [1, 0]);
  applyPending(list, "a", "asks", -1);
  assert.deepEqual([list[0].asks, list[0].approvals], [0, 0]);
});

test("当前会话也照加照减：切过去再答不会留下一个减不掉的批准", () => {
  const list = [s("a")];
  applyPending(list, "a", "approvals", 1);
  assert.equal(list[0].approvals, 1);
  applyPending(list, "a", "approvals", -1);
  assert.equal(list[0].approvals, 0);
});

test("缺字段按 0 算（磁盘会话老数据没有 asks），计数不会变 NaN 或负数", () => {
  const list = [{ id: "a", approvals: 0 }];
  applyPending(list, "a", "asks", 1);
  assert.equal(list[0].asks, 1);
  applyPending(list, "a", "approvals", -3);
  assert.equal(list[0].approvals, 0);
});

test("不认识的会话：什么都不动，也不报错", () => {
  const list = [s("a")];
  applyPending(list, "gone", "asks", 1);
  assert.deepEqual(list, [s("a")]);
});

test("订阅快照到了：列表里那条换成快照的长度（累加值只是影子）", () => {
  const list = [s("a", { approvals: 3, asks: 9 }), s("b", { approvals: 1 })];
  syncPending(list, "a", { approvals: 0, asks: 0 });
  assert.deepEqual([list[0].approvals, list[0].asks], [0, 0]);
  assert.equal(list[1].approvals, 1, "别的会话不动");
  syncPending(list, "gone", { approvals: 5, asks: 5 });
  assert.equal(list.length, 2);
});

test("画当前会话用本地队列，别的会话读列表里的累加值", () => {
  const row = s("a", { approvals: 1, asks: 0 });
  assert.deepEqual(pick(badgeSession(row, "a", { approvals: 0, asks: 2 })), { approvals: 0, asks: 2 });
  assert.deepEqual(pick(badgeSession(row, "b", { approvals: 0, asks: 2 })), { approvals: 1, asks: 0 });
  assert.deepEqual(pick(badgeSession(row, null, { approvals: 7, asks: 7 })), { approvals: 1, asks: 0 });
  assert.equal(row.approvals, 1, "原对象不许被就地改");
});

function pick(v) {
  return { approvals: v.approvals, asks: v.asks };
}
