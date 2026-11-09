/**
 * #173：标签行几何（纯函数）—— 一份 `order` + 名额 + 当前组 → 画哪几颗 + 收进 `＋N` 的组。
 *
 * 只测这一层。DOM 排布、下拉的开关、点一行切组由 `probes/workspace-tabs.mjs` 把关，那才是它
 * 的公开缝。#173 起「固定 / 补位」退役：顺序只有 `order` 一份，当前组不在前 `max` 时占最后一格。
 *
 * Run: node --experimental-transform-types web/tests/wstabs-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampMax, moveToFront, newTabFold, rowModel, TABS_DEFAULT, TABS_MAX, TABS_MIN, tabHitTest, tabModel, tabRenameBox, tabReorder } from "../src/wstabs.ts";

/** 桥下发的一份顺序（左栏与横条共用）。 */
const ORDER = ["g1", "g2", "g3", "g4", "g5"];

test("前 max 颗：名额 3、当前组在里面 → 前 3 颗，剩下的进 ＋N", () => {
  const m = tabModel({ order: ORDER, max: 3, current: "g2" });
  assert.deepEqual(m.visible, ["g1", "g2", "g3"]);
  assert.deepEqual(m.more, ["g4", "g5"]);
});

test("当前组在圈外：占最后一格，原第 max 颗进 ＋N（横条不超 max）", () => {
  const m = tabModel({ order: ORDER, max: 3, current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g5"]);
  assert.deepEqual(m.more, ["g3", "g4"]);
});

test("当前组在圈外、名额 1：唯一那颗就是当前组", () => {
  const m = tabModel({ order: ORDER, max: 1, current: "g4" });
  assert.deepEqual(m.visible, ["g4"]);
  assert.deepEqual(m.more, ["g1", "g2", "g3", "g5"], "more 保持 order 顺序，不含已画的那颗");
});

test("名额大于组数：有几个画几个，不凭空造组", () => {
  const m = tabModel({ order: ["a", "b"], max: 5, current: "b" });
  assert.deepEqual(m.visible, ["a", "b"]);
  assert.deepEqual(m.more, []);
});

test("当前组为空 / 不在 order 里：就是前 max 颗（没会话 / 旧快照）", () => {
  assert.deepEqual(tabModel({ order: ORDER, max: 3 }).visible, ["g1", "g2", "g3"]);
  assert.deepEqual(tabModel({ order: ORDER, max: 3, current: "ghost" }).visible, ["g1", "g2", "g3"]);
});

test("名额 0：什么都不画，全部进 ＋N", () => {
  const m = tabModel({ order: ORDER, max: 0, current: "g1" });
  assert.deepEqual(m.visible, []);
  assert.deepEqual(m.more, ORDER);
});

test("#176 名额进页面先按 1–12 夹住，默认 6", () => {
  assert.equal(clampMax(0), TABS_MIN);
  assert.equal(clampMax(-4), TABS_MIN);
  assert.equal(clampMax(99), TABS_MAX);
  assert.equal(clampMax(2.7), 2);
  assert.equal(clampMax(TABS_MIN), 1);
  assert.equal(clampMax(TABS_MAX), 12);
  assert.equal(TABS_DEFAULT, 6, "桥端没下发 max 时按 6 画");
  assert.equal(TABS_MIN, 1);
  assert.equal(TABS_MAX, 12);
});

// ---------------------------------------------------------------- #175 横条 ＋ 新建

// 桥把新组追加到 order 末尾，`order` 已是建完之后的快照：末尾还放得下才画在横条上，
// 否则它就在 ＋N 里 —— 页面据此说一句「已新建，收在 ＋N 里」。
test("新建的组在不在横条上：末尾坐满最后一格算在，多出名额就算收进 ＋N", () => {
  assert.equal(newTabFold(["a", "b", "c"], 3, "c"), null, "名额 3、刚好 3 组：新组就是最后一颗，不用吭声");
  assert.equal(newTabFold(["a", "b", "c", "d"], 3, "d"), 1, "名额 3、4 组：新组收进 ＋N（里面 1 颗）");
  assert.equal(newTabFold(["a", "b", "c", "d"], 4, "d"), null, "名额 4、4 组：画得下");
  const nine = Array.from({ length: 9 }, (_, i) => `g${i + 1}`);
  assert.equal(newTabFold([...nine, "manual:x"], 3, "manual:x"), 7, "9 组 + 新组、名额 3：提示里的 N 是 7");
  assert.equal(newTabFold(["a"], 0, "a"), 1, "名额 0：它只能在 ＋N 里（1 颗）");
});

test("新建的组：不在 order 里 / order 有重复 id，都不许把一颗看不见的组说成在横条上", () => {
  assert.equal(newTabFold(["a", "b"], 6, "ghost"), null, "快照里没有这颗：不提示");
  assert.equal(newTabFold(["a", "a", "b"], 2, "b"), null, "重复 id 只算一颗，b 是第 2 颗、画得下");
});

// ---------------------------------------------------------------- #124 横向落点（#173 沿用）

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

// ---------------------------------------------------------------- #174 每一颗可见标签都能拖

/** 一份标签行视图（#173）：`order` + 名额 + 当前组 → 可见段 / 折叠段。 */
const view = (max = 3, current) => tabModel({ order: ORDER, max, current });
/** 松手后的整份 order：可见段重排完，接上原封不动的折叠段。 */
const reorder = (max, current, id, hit) => tabReorder(view(max, current), id, hit);

test("重排：只在可见段里搬一颗，折叠组原序接在后面", () => {
  assert.deepEqual(reorder(3, undefined, "g3", { id: "g1", side: "before" }), ["g3", "g1", "g2", "g4", "g5"]);
  assert.deepEqual(reorder(3, undefined, "g3", { id: "g2", side: "before" }), ["g1", "g3", "g2", "g4", "g5"]);
  assert.deepEqual(reorder(3, undefined, "g1", { id: "g3", side: "after" }), ["g2", "g3", "g1", "g4", "g5"]);
});

test("重排：拖到最左端排第一，拖到最右端排在可见段最后", () => {
  const first = reorder(3, undefined, "g3", { id: "g1", side: "before" });
  assert.deepEqual(first, ["g3", "g1", "g2", "g4", "g5"]);
  const last = reorder(3, undefined, "g1", { id: "g3", side: "after" });
  assert.deepEqual(last, ["g2", "g3", "g1", "g4", "g5"]);
  assert.equal(tabModel({ order: last, max: 3 }).visible[2], "g1", "拖到最右 = 排在可见段最后");
});

test("重排：相邻两颗对调，从左拖到右和从右拖到左得到同一份 order", () => {
  const fromLeft = reorder(3, undefined, "g1", { id: "g2", side: "after" });
  const fromRight = reorder(3, undefined, "g2", { id: "g1", side: "before" });
  assert.deepEqual(fromLeft, ["g2", "g1", "g3", "g4", "g5"]);
  assert.deepEqual(fromRight, fromLeft, "同一个插位，两侧各拖一次是同一份结果");
});

test("重排：拖回原位 → null（一个字都不发）", () => {
  assert.equal(reorder(3, undefined, "g1", { id: "g2", side: "before" }), null);
  assert.equal(reorder(3, undefined, "g2", { id: "g1", side: "after" }), null);
  assert.equal(reorder(3, undefined, "g3", { id: "g2", side: "after" }), null);
  assert.equal(reorder(3, undefined, "g2", { id: "g3", side: "before" }), null);
});

test("重排：落点是自己 / 折叠组 / 没有落点 → null（拖不进折叠组）", () => {
  assert.equal(reorder(3, undefined, "g1", { id: "g1", side: "after" }), null);
  assert.equal(reorder(3, undefined, "g1", { id: "g4", side: "before" }), null);
  assert.equal(reorder(3, undefined, "g4", { id: "g1", side: "before" }), null, "折叠组没有 DOM，拖不动");
  assert.equal(reorder(3, undefined, "g1", null), null);
});

test("重排：替位组可拖 —— 按可见段排，它从临时占位变成顺序里的一员", () => {
  const v = view(3, "g5");
  assert.deepEqual(v.visible, ["g1", "g2", "g5"]);
  assert.deepEqual(v.more, ["g3", "g4"]);
  // 替位组拖到最前：它排第一，折叠组原序跟在后面。
  assert.deepEqual(tabReorder(v, "g5", { id: "g1", side: "before" }), ["g5", "g1", "g2", "g3", "g4"]);
  // 第一颗拖到替位组右边：可见段变成 [g2, g5, g1]，被它顶下去的组留在 ＋N（横条不涨颗）。
  const next = tabReorder(v, "g1", { id: "g5", side: "after" });
  assert.deepEqual(next, ["g2", "g5", "g1", "g3", "g4"]);
  assert.equal(next.length, ORDER.length, "不增删组");
  const after = tabModel({ order: next, max: 3, current: "g5" });
  assert.deepEqual(after.visible, ["g2", "g5", "g1"], "落点 clamp 在可见段里，折叠组没被拽进前 3");
  assert.deepEqual(after.more, ["g3", "g4"], "被顶下去的组回 ＋N");
});

test("重排：替位组拖回自己那一格 → null（不偷偷重排折叠组）", () => {
  assert.equal(reorder(3, "g5", "g5", { id: "g2", side: "after" }), null);
  assert.equal(reorder(3, "g5", "g1", { id: "g2", side: "before" }), null);
});

test("#276 重排：不在横条里的组留在原格，不被拖丢", () => {
  const m = rowModel({ order: ORDER, max: 3, members: ["g1", "g3", "g5"] });
  assert.deepEqual(m.visible, ["g1", "g3", "g5"]);
  assert.deepEqual(m.offRow, ["g2", "g4"]);
  const next = tabReorder(m, "g5", { id: "g1", side: "before" }, ORDER);
  assert.deepEqual(next, ["g5", "g2", "g1", "g4", "g3"], "成员按可见段重排，非成员各回原格");
  assert.equal(next.length, ORDER.length, "不增删组");
});

test("重排：名额 1 时没有别的落点 → null", () => {
  const v = view(1, "g5");
  assert.deepEqual(v.visible, ["g5"]);
  assert.equal(tabReorder(v, "g5", { id: "g5", side: "after" }), null);
});

// ---------------------------------------------------------------- #177 组头「移到最前」

test("移到最前：中间的组搬到第一，其余相对位置不变", () => {
  assert.deepEqual(moveToFront(ORDER, "g3"), ["g3", "g1", "g2", "g4", "g5"]);
});

test("移到最前：末尾的组搬到第一", () => {
  assert.deepEqual(moveToFront(ORDER, "g5"), ["g5", "g1", "g2", "g3", "g4"]);
});

test("移到最前：已经是最前 → null（一个字都不发）", () => {
  assert.equal(moveToFront(ORDER, "g1"), null);
  assert.equal(moveToFront(["only"], "only"), null);
});

test("移到最前：id 不在这份 order 里 / 空 order → null", () => {
  assert.equal(moveToFront(ORDER, "ghost"), null);
  assert.equal(moveToFront([], "g1"), null);
});

test("移到最前：不改入参", () => {
  const input = [...ORDER];
  moveToFront(input, "g4");
  assert.deepEqual(input, ORDER);
});

// ---------------------------------------------------------------- #276 横条成员（在 / 不在横条里）


test("#276 成员过滤：可见段只取在横条里的组，剩下的进「装不下」，不在的进「不在横条里」", () => {
  const m = rowModel({ order: ORDER, max: 3, members: ["g1", "g3", "g5"], current: "g1" });
  assert.deepEqual(m.visible, ["g1", "g3", "g5"]);
  assert.deepEqual(m.more, [], "三个成员都画得下");
  assert.deepEqual(m.offRow, ["g2", "g4"]);
  assert.equal(m.currentOffRow, false);
});

test("#276 成员超出名额：当前组不在可见段时替最后一格，原末位进「装不下」", () => {
  const m = rowModel({ order: ORDER, max: 3, members: ["g1", "g2", "g3", "g4"], current: "g4" });
  assert.deepEqual(m.visible, ["g1", "g2", "g4"]);
  assert.deepEqual(m.more, ["g3"]);
  assert.deepEqual(m.offRow, ["g5"]);
  assert.equal(m.currentOffRow, false, "g4 仍是成员，只是被名额挤出来");
});

test("#276 当前组不在成员里：仍占最后一格，总数不超名额，且标成 currentOffRow", () => {
  const m = rowModel({ order: ORDER, max: 3, members: ["g1", "g2", "g3", "g4"], current: "g5" });
  assert.deepEqual(m.visible, ["g1", "g2", "g5"], "最后一格留给当前组，g3 退进装不下");
  assert.deepEqual(m.more, ["g3", "g4"]);
  assert.deepEqual(m.offRow, [], "当前组仍占最后一格，不进「不在横条里」那一段（避免 ＋N 重复数）");
  assert.equal(m.currentOffRow, true);
  assert.ok(m.visible.length <= 3, "横条颗数永远不超过名额");
});

test("#276 当前组被移出、名额 1：唯一那格是当前组，成员全进装不下", () => {
  const m = rowModel({ order: ORDER, max: 1, members: ["g1", "g2"], current: "g5" });
  assert.deepEqual(m.visible, ["g5"]);
  assert.deepEqual(m.more, ["g1", "g2"]);
  assert.deepEqual(m.offRow, ["g3", "g4"], "当前组仍占最后一格，不在右段里");
  assert.equal(m.currentOffRow, true);
});

test("#276 成员为空：当前组临时独占最后一格，其余全在「不在横条里」", () => {
  const m = rowModel({ order: ORDER, max: 3, members: [], current: "g3" });
  assert.deepEqual(m.visible, ["g3"]);
  assert.deepEqual(m.more, []);
  assert.deepEqual(m.offRow, ["g1", "g2", "g4", "g5"], "当前组仍占最后一格，不在右段里");
  assert.equal(m.currentOffRow, true);
});

test("#276 members 缺省 / null = 旧桥：所有组都在横条里，不新增第四份输出", () => {
  for (const members of [undefined, null]) {
    const m = rowModel({ order: ORDER, max: 3, current: "g5", members });
    assert.deepEqual(m.visible, ["g1", "g2", "g5"]);
    assert.deepEqual(m.more, ["g3", "g4"]);
    assert.deepEqual(m.offRow, []);
    assert.equal(m.currentOffRow, false);
  }
});

test("#276 未知成员 id 忽略；重复 order 只认第一次", () => {
  const m = rowModel({ order: ["g1", "g1", "g2"], max: 3, members: ["g1", "ghost", "g2"], current: "ghost" });
  assert.deepEqual(m.visible, ["g1", "g2"], "ghost 不在 order 里，既不画也不当当前组");
  assert.deepEqual(m.more, []);
  assert.deepEqual(m.offRow, []);
  assert.equal(m.currentOffRow, false);
});

test("#276 名额 0：照样不画，当前组也不能突破 0", () => {
  const m = rowModel({ order: ORDER, max: 0, members: ["g1", "g2"], current: "g5" });
  assert.deepEqual(m.visible, []);
  assert.deepEqual(m.more, ["g1", "g2"]);
  assert.deepEqual(m.offRow, ["g3", "g4", "g5"], "非成员全在右段；成员 g1/g2 在装不下那一段");
  assert.equal(m.currentOffRow, true);
});

// ---------------------------------------------------------------- #277 标签改名浮层的落点

test("#277 浮层贴着标签：宽度至少 160，落在标签下沿 4px", () => {
  const box = tabRenameBox({ left: 100, top: 20, bottom: 50, width: 80 }, { width: 1000, height: 800 });
  assert.deepEqual(box, { left: 100, top: 54, width: 160 });
});

test("#277 浮层靠右：右边留 8px，宁可往左挪也不出视口", () => {
  const box = tabRenameBox({ left: 940, top: 20, bottom: 50, width: 80 }, { width: 1000, height: 800 });
  assert.deepEqual(box, { left: 832, top: 54, width: 160 });
});

test("#277 窄窗口：浮层缩到视口内（左右各留 8px）", () => {
  const box = tabRenameBox({ left: 300, top: 20, bottom: 50, width: 180 }, { width: 150, height: 800 });
  assert.deepEqual(box, { left: 8, top: 54, width: 134 });
});

test("#277 标签贴底：下面放不下就翻到标签上方", () => {
  const box = tabRenameBox({ left: 100, top: 760, bottom: 790, width: 80 }, { width: 1000, height: 800 });
  assert.deepEqual(box, { left: 100, top: 726, width: 160 });
});

test("#277 极矮窗口：上下都放不下时仍从上边 8px 开始（不出视口）", () => {
  const box = tabRenameBox({ left: 100, top: 10, bottom: 40, width: 80 }, { width: 1000, height: 34 });
  assert.equal(box.top, 8);
  assert.equal(box.left, 100);
});
