/**
 * 左栏两级树（#95）：`buildTree()` 是「会话 + 工作区快照 + 手工排列 → 画出来的那棵树」的唯一纯函数。
 *
 * 只测这一层。DOM（组头长什么样、收起怎么记、点哪儿折叠）由 `probes/workspace-tree.mjs` 的浏览器
 * 探针把关 —— 那是它的公开缝。
 *
 * Run: node --experimental-transform-types web/tests/tree-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, wsColor, WS_COLORS } from "../src/tree.ts";
import { wsAccent } from "../src/nowchip.ts";
import { ACCENTS } from "../src/palette.ts";

const ws = (id, name, key, manual = false) => ({ id, name, key, manual });
const LIB = ws("c:/ai/library/performance/library", "", "C:/ai/library/performance/library");
const PWC = ws("f:/pi-web-client", "", "F:/pi-web-client");
const MANUAL = ws("manual:abc", "客户 A", "", true);

const s = (id, group, extra = {}) => ({ id, name: id, cwd: "x", ws: group, updatedAt: 1, startedAt: "2024-01-01T00:00:00Z", ...extra });
const tree = (sessions, manage = {}, workspace = null, filter = "") =>
  buildTree(sessions, { pin: [], order: [], archived: [], ...manage }, workspace, filter);
const ids = (list) => list.map((x) => x.id);
const groups = (t) => t.groups.map((g) => [g.id, ids(g.sessions)]);

// ---------------------------------------------------------------- 分组

test("每个工作区一组，组的名字与 key 来自快照", () => {
  const t = tree([s("a", LIB.id), s("b", LIB.id), s("c", PWC.id)], {}, { groups: [LIB, PWC] });
  assert.deepEqual(groups(t), [
    [LIB.id, ["a", "b"]],
    [PWC.id, ["c"]],
  ]);
  assert.equal(t.groups[0].name, "library");
  assert.equal(t.groups[0].key, LIB.key);
  assert.equal(t.groups[1].name, "pi-web-client");
});

test("worktree 并回主仓：同组会话都落在同一个工作区里", () => {
  // 桥已经把 worktree 的 cwd 换算成主仓（#94），前端只要认 ws 字段。
  const t = tree([s("main", LIB.id), s("wt1", LIB.id), s("wt2", LIB.id)], {}, { groups: [LIB] });
  assert.equal(t.groups.length, 1);
  assert.deepEqual(ids(t.groups[0].sessions), ["main", "wt1", "wt2"]);
});

test("用户起的名字盖过目录名", () => {
  const named = { ...PWC, name: "网页客户端" };
  const t = tree([s("a", PWC.id)], {}, { groups: [named] });
  assert.equal(t.groups[0].name, "网页客户端");
});

test("手建的空组留着（渲染层显示空态），没有会话的派生组不凭空造出来", () => {
  const t = tree([s("a", LIB.id)], {}, { groups: [LIB, PWC, MANUAL] });
  const byId = new Map(t.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get(MANUAL.id)?.sessions, []);
  assert.equal(byId.get(MANUAL.id)?.name, "客户 A");
  // PWC 在快照里存在但一个会话都没有：这是手动组以外的组，同样保留（后端说要就有），
  // 但绝不凭空补一个快照里没有的组。
  assert.ok(byId.has(PWC.id));
  assert.equal(t.groups.length, 3);
});

test("会话的 ws 在快照里查不到时，按 cwd 兜底成一组（旧桥 / 桩桥）", () => {
  const legacy = [
    { id: "a", name: "a", cwd: "F:/pi-web-client", updatedAt: 1 },
    { id: "b", name: "b", cwd: "F:/pi-web-client", updatedAt: 1 },
    { id: "c", name: "c", cwd: "E:/other", updatedAt: 1 },
  ];
  const t = tree(legacy, {}, null);
  const byId = new Map(t.groups.map((g) => [g.id, g]));
  assert.deepEqual(ids(byId.get("f:/pi-web-client")?.sessions ?? []), ["a", "b"]);
  assert.deepEqual(ids(byId.get("e:/other")?.sessions ?? []), ["c"]);
  assert.equal(byId.get("f:/pi-web-client")?.name, "pi-web-client");
  assert.equal(byId.get("f:/pi-web-client")?.key, "F:/pi-web-client");
});

test("cwd 为空的脏会话不消失，落进「未分组」", () => {
  const t = tree([{ id: "dirty", name: "脏", cwd: "", updatedAt: 1 }], {}, null);
  assert.equal(t.groups.length, 1);
  assert.deepEqual(ids(t.groups[0].sessions), ["dirty"]);
  assert.equal(t.groups[0].name, "未分组");
});

// ---------------------------------------------------------------- 归档

test("归档是全局分区：不出现在任何工作区里，哪怕它还挂着 ★", () => {
  const t = tree([s("a", LIB.id), s("old", LIB.id), s("b", PWC.id)], { pin: ["old"], archived: ["old"] }, { groups: [LIB, PWC] });
  assert.deepEqual(ids(t.groups[0].sessions), ["a"]);
  assert.deepEqual(ids(t.archived), ["old"]);
});

test("#279 组里只剩归档会话：sessions 空、count 不为 0（页面据此不标「空」也不让删）", () => {
  const t = tree([s("old", LIB.id), s("old2", LIB.id)], { archived: ["old", "old2"] }, { groups: [LIB] });
  assert.deepEqual(t.groups[0].sessions, [], "归档不进组");
  assert.equal(t.groups[0].count, 2, "但数的时候算上（桥 drop 也用这个口径）");
});

test("#279 真的空组 count 是 0（手动组与目录组都算）", () => {
  const t = tree([], {}, { groups: [LIB, MANUAL] });
  for (const id of [LIB.id, MANUAL.id]) assert.equal(t.groups.find((g) => g.id === id)?.count, 0, id);
});

// ---------------------------------------------------------------- 颜色

test("组色按 id 稳定，取自既有调色板", () => {
  assert.equal(wsColor(LIB.id), wsColor(LIB.id));
  assert.ok(WS_COLORS.includes(wsColor(LIB.id)));
  assert.ok(WS_COLORS.includes(wsColor(PWC.id)));
  assert.equal(new Set([...Array(12).keys()].map((i) => wsColor(`g:${i}`))).size, WS_COLORS.length);
});

test("#102：树组色与顶栏 accent 同源（同一 FNV-1a 桶），不是两套哈希", () => {
  const ids = [LIB.id, PWC.id, "manual:demo", ...[...Array(24).keys()].map((i) => `g:${i}`)];
  for (const id of ids) {
    assert.equal(wsColor(id), ACCENTS[wsAccent(id)].accent, id);
  }
});

// ---------------------------------------------------------------- 组内顺序

const t3 = (ts) => new Date(ts).toISOString();

test("组内 ★ 在前，按 pin 的顺序；其余的排在后面", () => {
  const sessions = [
    s("a", LIB.id, { startedAt: t3("2024-03-01") }),
    s("b", LIB.id, { startedAt: t3("2024-02-01") }),
    s("c", LIB.id, { startedAt: t3("2024-01-01") }),
  ];
  const t = tree(sessions, { pin: ["c", "a"] }, { groups: [LIB] });
  assert.deepEqual(ids(t.groups[0].sessions), ["c", "a", "b"]);
});

test("★ 之后按手动顺序，没进过手动顺序的按新建时间倒序", () => {
  const sessions = [
    s("a", LIB.id, { startedAt: t3("2024-01-01") }),
    s("b", LIB.id, { startedAt: t3("2024-02-01") }),
    s("c", LIB.id, { startedAt: t3("2024-03-01") }),
    s("d", LIB.id, { startedAt: t3("2024-04-01") }),
  ];
  const t = tree(sessions, { order: ["a", "c"] }, { groups: [LIB] });
  // order 里没有位置的算「新会话」，排在手排过的上面（桥的 manage.ts 注释就是这么约定的）。
  assert.deepEqual(ids(t.groups[0].sessions), ["d", "b", "a", "c"]);
});

test("★ 不跨组：一个组的 ★ 不影响另一个组的顺序", () => {
  const sessions = [
    s("l1", LIB.id, { startedAt: t3("2024-01-01") }),
    s("l2", LIB.id, { startedAt: t3("2024-02-01") }),
    s("p1", PWC.id, { startedAt: t3("2024-01-01") }),
    s("p2", PWC.id, { startedAt: t3("2024-02-01") }),
  ];
  const t = tree(sessions, { pin: ["l1"] }, { groups: [LIB, PWC] });
  const byId = new Map(t.groups.map((g) => [g.id, ids(g.sessions)]));
  assert.deepEqual(byId.get(LIB.id), ["l1", "l2"]);
  assert.deepEqual(byId.get(PWC.id), ["p2", "p1"]);
});

// ---------------------------------------------------------------- 组之间

test("组序按一份 order（左栏与横条共用），不看待处理 / 最近活动", () => {
  const sessions = [s("l1", LIB.id, { updatedAt: 900 }), s("p1", PWC.id, { updatedAt: 100, asks: 1 })];
  const t = tree(sessions, {}, { groups: [LIB, PWC], order: [LIB.id, PWC.id] });
  assert.deepEqual(t.groups.map((g) => g.id), [LIB.id, PWC.id]);
  assert.equal(t.groups.find((g) => g.id === PWC.id).pending, 1, "待处理角标照旧");
});

test("order 里没有的组排末尾，再按名字；旧桥没 order 时就是全按名字", () => {
  const sessions = [s("l1", LIB.id, { updatedAt: 100 }), s("p1", PWC.id, { updatedAt: 900 })];
  const ranked = tree(sessions, {}, { groups: [PWC, LIB], order: [PWC.id] });
  assert.deepEqual(ranked.groups.map((g) => g.id), [PWC.id, LIB.id]);
  const legacy = tree(sessions, {}, { groups: [PWC, LIB] });
  assert.deepEqual(legacy.groups.map((g) => g.name), ["library", "pi-web-client"]);
});

test("pending 只数组里在等你的会话（待回答 / 待确认）", () => {
  const sessions = [
    s("a", LIB.id, { asks: 2 }),
    s("b", LIB.id, { approvals: 1 }),
    s("c", LIB.id, { asks: 0 }),
    s("d", PWC.id, { approvals: 0 }),
  ];
  const t = tree(sessions, {}, { groups: [LIB, PWC] });
  const byId = new Map(t.groups.map((g) => [g.id, g.pending]));
  assert.equal(byId.get(LIB.id), 2);
  assert.equal(byId.get(PWC.id), 0);
});

// ---------------------------------------------------------------- 过滤

test("打组名：整组留下（含组里所有会话），其它组消失", () => {
  const sessions = [s("l1", LIB.id), s("l2", LIB.id), s("p1", PWC.id)];
  const t = tree(sessions, {}, { groups: [LIB, PWC] }, "library");
  assert.deepEqual(groups(t), [[LIB.id, ["l1", "l2"]]]);
});

test("组名匹配不分大小写，用户起的名字也算", () => {
  const sessions = [s("a", MANUAL.id), s("b", LIB.id)];
  const t = tree(sessions, {}, { groups: [LIB, MANUAL] }, "客户");
  assert.deepEqual(groups(t), [[MANUAL.id, ["a"]]]);
});

test("打会话名：只留命中的那几条，没命中的组整个消失", () => {
  const sessions = [s("l1", LIB.id, { name: "library 重构" }), s("l2", LIB.id, { name: "另一个" }), s("p1", PWC.id, { name: "别的" })];
  const t = tree(sessions, {}, { groups: [LIB, PWC] }, "重构");
  assert.deepEqual(groups(t), [[LIB.id, ["l1"]]]);
});

test("过滤也照到「已归档」", () => {
  const sessions = [s("a", LIB.id), s("old", LIB.id, { name: "归档的" }), s("old2", LIB.id, { name: "也归档的" })];
  const t = tree(sessions, { archived: ["old", "old2"] }, { groups: [LIB] }, "归档的");
  assert.deepEqual(ids(t.archived), ["old", "old2"]);
  assert.deepEqual(groups(t), []);
});

test("空的手建组：命中组名时留下（渲染层显示空态），不命中时消失", () => {
  const t = tree([s("l1", LIB.id)], {}, { groups: [LIB, MANUAL] }, "客户");
  assert.deepEqual(groups(t), [[MANUAL.id, []]]);
  const over = tree([s("l1", LIB.id)], {}, { groups: [LIB, MANUAL] }, "library");
  assert.deepEqual(groups(over), [[LIB.id, ["l1"]]]);
});
