/**
 * #102：重画后的焦点归还状态机 —— 纯函数层。
 *
 * DOM 层（焦点真落到卡 / 组头上）由 `probes/a11y-workspace.mjs` 把关；这里只测预算语义：
 * 一次键盘手势会连来几次重画，pending 就该能被消费几次；见底之后普通重画不再抢焦点。
 *
 * Run: node --experimental-transform-types web/tests/focusfollow-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { armFocus, consumeFocus, focusBudget } from "../src/focusfollow.ts";

const el = (id) => ({ fake: true, id });
const cardLookup = (ids) => (kind, id) => (kind === "card" && ids.includes(id) ? el(id) : null);

test("预算口径：卡两条回执、组头折叠本地一次", () => {
  assert.equal(focusBudget("card"), 2);
  assert.equal(focusBudget("ws"), 1);
});

test("卡：两次消费都归还焦点，第三次不再抢", () => {
  let state = armFocus("card", "s-1");
  const first = consumeFocus(state, cardLookup(["s-1"]));
  assert.equal(first.focus.id, "s-1");
  state = first.next;
  const second = consumeFocus(state, cardLookup(["s-1"]));
  assert.equal(second.focus.id, "s-1");
  state = second.next;
  assert.equal(state.card, null);
  // 预算见底：改名 / 收推送之类的重画来了也不抢。
  const third = consumeFocus(state, cardLookup(["s-1"]));
  assert.equal(third.focus, null);
  assert.deepEqual(third.next, state);
});

test("目标消失（删除 / 归档）：pending 清掉，不留给后面的重画", () => {
  let state = armFocus("card", "s-gone");
  const first = consumeFocus(state, cardLookup(["s-1"]));
  assert.equal(first.focus, null);
  assert.equal(first.next.card, null);
});

test("组头折叠：一次消费即清", () => {
  const wsLookup = (kind, id) => (kind === "ws" && id === "f:/proj" ? el(id) : null);
  let state = armFocus("ws", "f:/proj");
  const first = consumeFocus(state, wsLookup);
  assert.equal(first.focus.id, "f:/proj");
  assert.equal(first.next.ws, null);
});

test("一次手势一个目标：后按的赢，顺手清掉另一种", () => {
  let state = armFocus("card", "s-1");
  state = armFocus("ws", "f:/proj");
  assert.equal(state.card, null);
  assert.equal(state.ws.id, "f:/proj");
  state = armFocus("card", "s-2");
  assert.equal(state.ws, null);
  assert.equal(state.card.id, "s-2");
});

test("无 pending / lookup 全空：focus 为 null，状态原样", () => {
  const empty = { card: null, ws: null };
  const out = consumeFocus(empty, () => null);
  assert.equal(out.focus, null);
  assert.deepEqual(out.next, empty);
});
