/**
 * 会话胶囊的「数据 → 屏幕上那颗字」的映射（#93 prefactor）。
 *
 * 只测纯函数那一层：胶囊组件（DOM 排布、折叠、焦点、浮层）由 `probes/pin-auto-open.mjs` 的
 * 浏览器探针把关，那才是它的公开缝。
 *
 * Run: node --experimental-transform-types web/tests/pillbar-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { neighborAfterArchive, pillChip, starredSessions } from "../src/pillbar.ts";

const time = (ts) => `t${ts}`;
const session = { id: "st-1", name: "会话 01", cwd: "E:/demo", updatedAt: 7 };

test("小字：有状态徽标就用徽标文字，没有才用时间", () => {
  const badge = { text: "待回答", cls: "wait", title: "在等你回答问卷", pending: true };
  assert.equal(pillChip(session, null, badge, time).sub, "待回答");
  assert.equal(pillChip(session, null, null, time).sub, "t7");
});

test("胶囊的颜色只跟着徽标走，没徽标就不带类", () => {
  assert.equal(pillChip(session, null, { text: "运行中", cls: "run", title: "", pending: false }, time).cls, "run");
  assert.equal(pillChip(session, null, null, time).cls, null);
});

test("名字为空时退回会话 id", () => {
  assert.equal(pillChip({ ...session, name: "" }, null, null, time).name, "st-1");
});

test("当前会话单独标出来（类、无障碍属性、title 都认这个）", () => {
  const cur = pillChip(session, "st-1", null, time);
  assert.equal(cur.current, true);
  assert.ok(cur.title.includes("（当前会话）"));
  assert.equal(pillChip(session, "st-2", null, time).current, false);
});

test("title 串起名字、cwd、徽标说明，空的那些不留下多余分隔", () => {
  const badge = { text: "待回答", cls: "wait", title: "在等你回答问卷", pending: true };
  assert.equal(pillChip(session, null, badge, time).title, "会话 01 · E:/demo · 在等你回答问卷");
  assert.equal(pillChip({ ...session, cwd: null }, null, null, time).title, "会话 01");
});

// #120 行 2 画的是「本区里点过 ★ 的会话」，不是本区全部会话。
const rowIds = (ids, stars) =>
  starredSessions(ids.map((id) => ({ ...session, id })), stars).map((s) => s.id);

test("行 2 的胶囊按 ★ 的顺序排，与会话列表自己的顺序无关", () => {
  assert.deepEqual(rowIds(["a", "b", "c"], ["c", "a"]), ["c", "a"]);
});

test("当前会话也在 ★ 里：切到它不挪位，靠主题色填充认出来", () => {
  assert.deepEqual(rowIds(["a", "b"], ["b", "a"]), ["b", "a"]);
});

test("一组里没有 ★ 时行 2 一颗胶囊都没有（只剩 NowChip 和 ＋）", () => {
  assert.deepEqual(rowIds(["a", "b"], []), []);
});

test("在别组置顶的会话不串进来：本区列表里没有的 ★ id 一律忽略", () => {
  assert.deepEqual(rowIds(["a"], ["x", "y"]), []);
});

// #189：归档当前会话之后该切到哪一颗 —— ★ 行从左到右的 id 序列 + 被归档的 id，规则只有这一个纯函数。
const row = ["a", "b", "c", "d"];

test("归档当前会话：右邻存在就切右邻", () => {
  assert.equal(neighborAfterArchive(row, "b"), "c");
});

test("归档的不是 ★ 行里的会话 → 不动作", () => {
  assert.equal(neighborAfterArchive(row, "x"), null);
});

test("序列里没有右邻 → #189 先不动作（左邻留给 #190）", () => {
  assert.equal(neighborAfterArchive(row, "d"), null);
});

test("当前会话没 ★、自己占第 1 格时，右邻就是右边第一颗 ★", () => {
  assert.equal(neighborAfterArchive(["cur", ...row], "cur"), "a");
});

test("★ 行里只剩它一颗 → 不动作（空态留给 #190）", () => {
  assert.equal(neighborAfterArchive(["only"], "only"), null);
});
