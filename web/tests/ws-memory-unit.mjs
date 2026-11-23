/**
 * 工作区记忆（#647 / D390）：切回一个工作区时打开「你上次停下的那颗」。
 *
 * 只测纯函数这一层：落点选择（记忆 → 最近活动）、`pi.ws.last` 的解析 / 写入 / 剪枝。
 * 「点标签到底开了哪颗」由 `probes/ws-memory.mjs` 的浏览器探针把关 —— 那才是它的公开缝。
 *
 * Run: npm run test:ws-memory
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickLanding, parseLast, recordLast, pruneLast, LAST_CAP } from "../src/wsmemory.ts";

const s = (id, updatedAt) => ({ id, updatedAt });
const list = (...pairs) => pairs.map(([id, at]) => s(id, at));

// ---------------------------------------------------------------- 落点：记忆 → 最近活动

test("记忆命中就开它，哪怕同组里别的会话更新", () => {
  const sessions = list(["a", 100], ["b", 900], ["c", 500]);
  assert.equal(pickLanding(sessions, "a"), "a");
});

test("记忆指向的会话已经不在这一组：落到 updatedAt 最大的那颗", () => {
  const sessions = list(["b", 900], ["c", 500]);
  assert.equal(pickLanding(sessions, "gone"), "b");
});

test("没有记忆：落到 updatedAt 最大的那颗（不是数组第一颗）", () => {
  assert.equal(pickLanding(list(["a", 100], ["b", 900], ["c", 500]), null), "b");
});

test("null / 空串 / undefined 都算「没有记忆」", () => {
  const sessions = list(["a", 100], ["b", 900]);
  for (const last of [null, undefined, ""]) assert.equal(pickLanding(sessions, last), "b");
});

test("updateAt 并列时取数组里靠前的那颗（确定性，不随机）", () => {
  assert.equal(pickLanding(list(["a", 700], ["b", 700], ["c", 700]), null), "a");
});

test("updatedAt 缺失 / NaN / 非数字都当 0，不会把落点抢走", () => {
  const sessions = [{ id: "a" }, { id: "b", updatedAt: Number.NaN }, { id: "c", updatedAt: 5 }];
  assert.equal(pickLanding(sessions, null), "c");
});

test("整组一个会话都没有：null（交回 D374 的空态路径）", () => {
  assert.equal(pickLanding([], "a"), null);
});

// ---------------------------------------------------------------- pi.ws.last 的解析

test("parseLast：正常结构原样读回来", () => {
  const raw = JSON.stringify({ "f:/a": { id: "s1", at: 1700000000000 } });
  assert.deepEqual(parseLast(raw), { "f:/a": { id: "s1", at: 1700000000000 } });
});

test("parseLast：坏 JSON / null / 空的非对象都不抛，回空表", () => {
  for (const raw of [null, undefined, "", "   ", "{oops", "[]", "42", '"x"', "null"]) {
    assert.deepEqual(parseLast(raw), {});
  }
});

test("parseLast：丢掉结构不对的条目，留下好的（坏数据不能弄坏整份记忆）", () => {
  const raw = JSON.stringify({
    good: { id: "s1", at: 2 },
    noId: { at: 3 },
    emptyId: { id: "", at: 4 },
    noAt: { id: "s2" },
    badAt: { id: "s3", at: "yesterday" },
    notObject: "s4",
    nullish: null,
  });
  assert.deepEqual(parseLast(raw), { good: { id: "s1", at: 2 }, noAt: { id: "s2", at: 0 }, badAt: { id: "s3", at: 0 } });
});

// ---------------------------------------------------------------- 写入与剪枝

test("recordLast：写一条，别的组不动", () => {
  const before = { "f:/a": { id: "s1", at: 1 } };
  const after = recordLast(before, "f:/b", "s9", 99);
  assert.deepEqual(after, { "f:/a": { id: "s1", at: 1 }, "f:/b": { id: "s9", at: 99 } });
  assert.deepEqual(before, { "f:/a": { id: "s1", at: 1 } }, "不改传进来的那份");
});

test("recordLast：同一组写第二次就覆盖（一颗组只记一颗会话）", () => {
  const once = recordLast({}, "f:/a", "s1", 1);
  assert.deepEqual(recordLast(once, "f:/a", "s2", 2), { "f:/a": { id: "s2", at: 2 } });
});

test("recordLast：超过上限就丢掉最久没写过的那些（不留在 localStorage 里长毛）", () => {
  let map = {};
  for (let i = 0; i < LAST_CAP + 5; i += 1) map = recordLast(map, `ws-${i}`, `s-${i}`, i + 1);
  assert.equal(Object.keys(map).length, LAST_CAP);
  assert.ok(!("ws-0" in map), "最旧的那条被剪掉了");
  assert.ok(`ws-${LAST_CAP + 4}` in map, "最新的那条还在");
});

test("pruneLast：组已经不在快照里、或那颗会话已经不在这组 —— 条目丢掉", () => {
  const map = {
    alive: { id: "s1", at: 1 },
    deadGroup: { id: "s2", at: 2 },
    movedSession: { id: "s3", at: 3 },
  };
  const members = { alive: ["s1", "s9"] };
  assert.deepEqual(
    pruneLast(map, (entry, wsId) => Boolean(members[wsId]) && members[wsId].includes(entry.id)),
    { alive: { id: "s1", at: 1 } },
  );
});

test("pruneLast：没东西可剪时把原表原样还回来（调用方据此决定要不要写盘）", () => {
  const map = { "f:/a": { id: "s1", at: 1 } };
  const kept = pruneLast(map, () => true);
  assert.deepEqual(kept, map);
  assert.equal(kept, map, "一份空操作不该造一份新对象");
});
