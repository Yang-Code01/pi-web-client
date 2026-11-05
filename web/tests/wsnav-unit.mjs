/**
 * #102：拖拽的键盘等价（纯函数）。
 *
 * 浏览器里「按了 Alt+方向键真的发消息、焦点真的跟过去」由 `probes/a11y-workspace.mjs` 把关；
 * 这里只测换算：卡片上的 Alt+←/→ 该发什么 manage 消息、Alt+↑/↓ 该插到哪一位。
 *
 * Run: node --experimental-transform-types web/tests/wsnav-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { keyMovePlan, keyShiftIndex, neighborWs } from "../src/drag.ts";

/** 树序（buildTree 的输出）里组的先后就是左栏的先后。 */
const WS = ["f:/proj-01", "f:/proj-02", "f:/proj-03"];

test("组间移动：→ 是下一组，发 ws.move（目标组、不带位置）", () => {
  const plan = keyMovePlan("s1", "f:/proj-01", WS, 1);
  assert.deepEqual(plan, { action: "move", ids: ["s1"], wsId: "f:/proj-02" });
});

test("组间移动：← 是上一组，同样只发 ws.move", () => {
  const plan = keyMovePlan("s1", "f:/proj-02", WS, -1);
  assert.deepEqual(plan, { action: "move", ids: ["s1"], wsId: "f:/proj-01" });
});

test("已是最后一组：→ 不动，返回 null（不发消息、焦点恢复）", () => {
  assert.equal(keyMovePlan("s1", "f:/proj-03", WS, 1), null);
});

test("已是第一组：← 不动", () => {
  assert.equal(keyMovePlan("s1", "f:/proj-01", WS, -1), null);
});

test("源组不在树里（脏数据）：两个方向都不动", () => {
  assert.equal(keyMovePlan("s1", "f:/nope", WS, 1), null);
  assert.equal(neighborWs("f:/nope", WS, 1), null);
});

test("neighborWs 自己也要独立成立（渲染层可能单独用它找相邻组）", () => {
  assert.equal(neighborWs("f:/proj-01", WS, 1), "f:/proj-02");
  assert.equal(neighborWs("f:/proj-03", WS, 1), null);
  assert.equal(neighborWs("f:/proj-02", WS, -1), "f:/proj-01");
});

test("组内重排：↓ 插到下一位，↑ 插到上一位（clamp 后）", () => {
  assert.equal(keyShiftIndex(0, 1, 5), 1);
  assert.equal(keyShiftIndex(3, -1, 5), 2);
});

test("组内重排：已到边上就不动（null），别把 clamp 误当成功", () => {
  assert.equal(keyShiftIndex(4, 1, 5), null);
  assert.equal(keyShiftIndex(0, -1, 5), null);
});

test("组内重排：单卡组两个方向都不动", () => {
  assert.equal(keyShiftIndex(0, 1, 1), null);
  assert.equal(keyShiftIndex(0, -1, 1), null);
});

test("复用 planDrop：同组 reorder 的落点与拖拽同一条路（moveTo 的输入）", () => {
  // 渲染层把 keyShiftIndex 的结果交给 planDrop，得保证两边对得上（reorder 才走 moveTo）。
  assert.deepEqual(keyMovePlan("s1", "f:/proj-01", WS, 1), { action: "move", ids: ["s1"], wsId: "f:/proj-02" });
});
