/**
 * 模型选择器的「最近使用」组：换模型时把换走的和换上的都记下，选择器里排在「当前使用」之后。
 * D423 之后分两条清单：对话（`pi.models.recent`）与评审（`pi.models.reviewRecent`），
 * 评审弹层按 `t` 取并集，对话侧只读自己那条。
 *
 * Run: node --experimental-strip-types web/tests/modelgroups-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { groupModels, mergedRecentModels, rememberRecentModel, rememberReviewModel, recentModels, RECENT_MAX } = await import("../src/modelgroups.ts");

const M = (provider, id) => ({ provider, id, name: id });
const catalog = [M("a", "a1"), M("a", "a2"), M("b", "b1"), M("b", "b2"), M("c", "c1"), M("c", "c2"), M("c", "c3")];

test("最近使用：新的在前、去重、封顶", () => {
  store.clear();
  rememberRecentModel("a", "a1");
  rememberRecentModel("b", "b1");
  rememberRecentModel("a", "a1");
  assert.deepEqual(recentModels(catalog).map((m) => m.id), ["a1", "b1"]);
  for (const m of catalog) rememberRecentModel(m.provider, m.id);
  assert.equal(recentModels(catalog).length, RECENT_MAX);
  assert.equal(recentModels(catalog)[0].id, "c3");
});

test("groupModels：最近使用里不重复当前模型，目录里没有的跳过，来源组照常完整", () => {
  store.clear();
  rememberRecentModel("x", "gone");
  rememberRecentModel("b", "b2");
  rememberRecentModel("a", "a1");
  const { pinned, recent, groups } = groupModels(catalog, { id: "a1" });
  assert.equal(pinned?.id, "a1");
  assert.deepEqual(recent.map((m) => m.id), ["b2"]);
  assert.deepEqual(groups.find((g) => g.provider === "b").models.map((m) => m.id), ["b1", "b2"]);
});

test("坏数据不抛：localStorage 里不是数组就当空", () => {
  store.set("pi.models.recent", "{oops");
  assert.deepEqual(recentModels(catalog), []);
  rememberRecentModel("a", "a2");
  assert.deepEqual(recentModels(catalog).map((m) => m.id), ["a2"]);
});

/** 冻结 `Date.now`，让两条清单的 `t` 可断言（合并顺序全靠它）。 */
function withClock(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("评审清单单独一份：写评审不动对话那条，对话侧也不显示评审挑过的（D423）", () => {
  store.clear();
  withClock(1000, () => rememberReviewModel("b", "b1"));
  assert.deepEqual(recentModels(catalog), [], "对话侧不吃评审的选择");
  assert.deepEqual(mergedRecentModels(catalog).map((m) => m.id), ["b1"], "评审弹层看到两者并集");
  assert.ok(store.get("pi.models.reviewRecent"), "评审清单落在自己的键上");
});

test("合并：按最近一次使用时间排，同一个模型跨两条清单只出现一次", () => {
  store.clear();
  withClock(1000, () => rememberRecentModel("a", "a1"));
  withClock(2000, () => rememberRecentModel("b", "b1"));
  withClock(3000, () => rememberReviewModel("a", "a1")); // 同一模型，评审这次更新
  withClock(1500, () => rememberReviewModel("c", "c1"));
  assert.deepEqual(mergedRecentModels(catalog).map((m) => m.id), ["a1", "b1", "c1"]);
  // 对话那条自己没变：a1 仍是 1000 那次的旧位置。
  assert.deepEqual(recentModels(catalog).map((m) => m.id), ["b1", "a1"]);
});

test("合并后不按 RECENT_MAX 再裁：两条各满 5 条时给出 10 条", () => {
  store.clear();
  const big = Array.from({ length: 12 }, (_, i) => M("p", `m${i}`));
  for (let i = 0; i < 6; i++) withClock(1000 + i, () => rememberRecentModel("p", `m${i}`));
  for (let i = 6; i < 12; i++) withClock(2000 + i, () => rememberReviewModel("p", `m${i}`));
  assert.equal(recentModels(big).length, RECENT_MAX);
  assert.equal(mergedRecentModels(big).length, RECENT_MAX * 2, "合并是并集，不再裁到 5");
  assert.equal(mergedRecentModels(big)[0].id, "m11", "最新用过的排第一");
});

test("旧条目没有 t：当成更旧的，排在带 t 的后面（不迁移也能用）", () => {
  store.clear();
  store.set("pi.models.recent", JSON.stringify([{ provider: "a", id: "a1" }]));
  withClock(5000, () => rememberReviewModel("b", "b1"));
  assert.deepEqual(mergedRecentModels(catalog).map((m) => m.id), ["b1", "a1"]);
});

test("groupModels 的 mergedRecent 开关：只有评审弹层用合并口径，且不重复当前模型", () => {
  store.clear();
  withClock(1000, () => rememberRecentModel("b", "b2"));
  withClock(2000, () => rememberReviewModel("a", "a1"));
  assert.deepEqual(groupModels(catalog, { id: "a1" }).recent.map((m) => m.id), ["b2"], "默认仍是对话口径");
  assert.deepEqual(groupModels(catalog, { id: "a1" }, { mergedRecent: true }).recent.map((m) => m.id), ["b2"], "合并后 a1 是 pinned，不重复");
  assert.deepEqual(groupModels(catalog, {}, { mergedRecent: true }).recent.map((m) => m.id), ["a1", "b2"]);
});
