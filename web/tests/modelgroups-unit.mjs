/**
 * 模型选择器的「最近使用」组：换模型时把换走的和换上的都记下，选择器里排在「当前使用」之后。
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
const { groupModels, rememberRecentModel, recentModels, RECENT_MAX } = await import("../src/modelgroups.ts");

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
