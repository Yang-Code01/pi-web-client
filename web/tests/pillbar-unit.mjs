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
import { pillChip } from "../src/pillbar.ts";

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
