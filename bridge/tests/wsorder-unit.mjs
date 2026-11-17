/**
 * #478：新工作区「按天插位」的纯函数。
 *
 * 这里只测排序规则本身（一份 order + 各组的天 + 新组的天 → 新 order），不碰会话、不碰磁盘 ——
 * 会话怎么算「组的天」由 `workspace-unit.mjs` 从会话列表那一层把关。
 *
 *   node --experimental-transform-types bridge/tests/wsorder-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, insertByDay } from "../src/wsorder.ts";

/** 本地某一天的某个时刻（按本机时区构造，避免用 UTC 字符串跨时区漂）。 */
const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();
const TODAY = 20261117;
const YESTERDAY = 20261116;

test("dayKey：同一天的凌晨与深夜是同一个键", () => {
  assert.equal(dayKey(at(2026, 11, 17, 0)), dayKey(at(2026, 11, 17, 23)));
});

test("dayKey：相邻两天不同，且后一天更大（跨月也算）", () => {
  assert.ok(dayKey(at(2026, 11, 18)) > dayKey(at(2026, 11, 17)));
  assert.equal(dayKey(at(2026, 11, 30)), 20261130);
  assert.equal(dayKey(at(2026, 12, 1)), 20261201);
});

test("dayKey：按本地日历日切，不是 UTC 日（23:30 那一下仍算当天）", () => {
  assert.equal(dayKey(at(2026, 3, 8, 23)), 20260308);
  assert.equal(dayKey(at(2026, 3, 9, 0)), 20260309);
});

const days = (map) => (id) => map[id] ?? -Infinity;

test("今天这一档的末尾：前两个今天、后两个旧 → 新组排第 3", () => {
  const order = ["a", "b", "c", "d"];
  const dayOf = days({ a: TODAY, b: TODAY, c: YESTERDAY, d: YESTERDAY - 1 });
  assert.deepEqual(insertByDay(order, "new", TODAY, dayOf), ["a", "b", "new", "c", "d"]);
});

test("全都不比新组旧：追加末尾", () => {
  const order = ["a", "b"];
  const dayOf = days({ a: TODAY, b: TODAY });
  assert.deepEqual(insertByDay(order, "new", TODAY, dayOf), ["a", "b", "new"]);
});

test("空组算最旧：新组排在它们上面", () => {
  const order = ["empty1", "a", "empty2"];
  const dayOf = days({ a: TODAY });
  assert.deepEqual(insertByDay(order, "new", TODAY, dayOf), ["new", "empty1", "a", "empty2"]);
});

test("order 里已经有这颗：原样返回，不动位置", () => {
  const order = ["a", "new", "b"];
  assert.deepEqual(insertByDay(order, "new", TODAY, days({ a: YESTERDAY })), ["a", "new", "b"]);
});

test("手动拖乱后仍插在「第一个旧组」之前，不跟着被拖上去的旧组跑", () => {
  const order = ["stale", "today1", "today2"];
  const dayOf = days({ stale: YESTERDAY, today1: TODAY, today2: TODAY });
  assert.deepEqual(insertByDay(order, "new", TODAY, dayOf), ["new", "stale", "today1", "today2"]);
});

test("原有组的相对顺序一个都不动（稳定插入）", () => {
  const order = ["x", "y", "z", "w"];
  const dayOf = days({ x: TODAY, y: YESTERDAY, z: TODAY, w: YESTERDAY });
  const next = insertByDay(order, "new", TODAY, dayOf);
  assert.deepEqual(next, ["x", "new", "y", "z", "w"]);
  assert.deepEqual(next.filter((id) => id !== "new"), order);
});

test("空 order：只有新组", () => {
  assert.deepEqual(insertByDay([], "new", TODAY, days({})), ["new"]);
});

test("锚点是最旧（自动建组的旧会话）：落到末尾", () => {
  const order = ["a", "b"];
  assert.deepEqual(insertByDay(order, "new", YESTERDAY, days({ a: TODAY, b: TODAY })), ["a", "b", "new"]);
});
