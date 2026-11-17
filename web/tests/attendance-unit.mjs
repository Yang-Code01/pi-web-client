/**
 * 考勤页的纯函数（本机管理 → 考勤）：
 * 默认日期区间、审批状态、工时/区间/事由的显示口径。
 *
 * 这一层不碰 DOM、不 import CSS，所以直接在 Node 里跑。
 * 交互（二次确认、撤回、详情展开、错误态）不启浏览器，靠 `bridge/tests/attendance-e2e.mjs` 与肉眼。
 * 与 `bridge/src/attendance-model.ts` 的口径要对齐：那边管 90 天裁剪与退避，这边只管怎么显示。
 *
 * Run: node --experimental-strip-types web/tests/attendance-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dateKey, defaultRange, hoursText, reasonText, spanText, stepState } from "../src/attendance-shared.ts";

test("dateKey 用本地日期补零，不跟 UTC 走", () => {
  assert.equal(dateKey(new Date(2026, 10, 7)), "2026-11-07");
  assert.equal(dateKey(new Date(2026, 0, 1, 0, 5)), "2026-01-01");
  // 本地 00:30 在 UTC 还是前一天；toISOString 会给出 2026-11-06。
  const local = new Date(2026, 10, 7, 0, 30);
  assert.equal(dateKey(local), "2026-11-07");
});

test("defaultRange 是含今天的最近 14 天", () => {
  const r = defaultRange(new Date(2026, 10, 17, 9, 0));
  assert.deepEqual(r, { start: "2026-11-04", end: "2026-11-17" });
  const span = (new Date(r.end) - new Date(r.start)) / 86_400_000;
  assert.equal(span + 1, 14);
});

test("defaultRange 跨月、跨年都不出错", () => {
  assert.deepEqual(defaultRange(new Date(2026, 2, 3)), { start: "2026-02-18", end: "2026-03-03" });
  // 闰年 2 月 29 日往后数。
  assert.deepEqual(defaultRange(new Date(2028, 2, 1)), { start: "2028-02-17", end: "2028-03-01" });
  assert.deepEqual(defaultRange(new Date(2027, 0, 2)), { start: "2026-12-20", end: "2027-01-02" });
});

test("stepState：结束了就说结束，不管链上还剩什么", () => {
  assert.deepEqual(stepState([{ workflow_result: 0, workflow_role_name: "项目负责人" }], 1), { kind: "ended" });
  assert.deepEqual(stepState(undefined, 1), { kind: "ended" });
  assert.deepEqual(stepState([], 2), { kind: "ended" });
});

test("stepState：找到卡住的那一步，报它的角色名", () => {
  const chain = [
    { workflow_index: 0, workflow_role_name: "申请人", workflow_result: 1 },
    { workflow_index: 1, workflow_role_name: "项目负责人", workflow_result: 0 },
    { workflow_index: 2, workflow_role_name: "部门负责人", workflow_result: null },
  ];
  assert.deepEqual(stepState(chain, 0), { kind: "pending", role: "项目负责人" });
});

test("stepState：null 也算没轮到，早于 0 也要报出来", () => {
  const chain = [
    { workflow_role_name: "项目负责人", workflow_result: 1 },
    { workflow_role_name: "部门负责人", workflow_result: null },
  ];
  assert.deepEqual(stepState(chain, 0), { kind: "pending", role: "部门负责人" });
});

test("stepState：链是空的但申请还没结束 —— 只能说审批中，不能编一个角色", () => {
  assert.deepEqual(stepState([], 0), { kind: "running" });
  assert.deepEqual(stepState(undefined, 0), { kind: "running" });
  assert.deepEqual(stepState("不是数组", 0), { kind: "running" });
});

test("stepState：审批全批完了但申请还没标结束，也归到审批中", () => {
  const chain = [{ workflow_role_name: "项目负责人", workflow_result: 1 }];
  assert.deepEqual(stepState(chain, 0), { kind: "running" });
});

test("stepState：角色名缺省时给空串，别让 undefined 漏到界面上", () => {
  assert.deepEqual(stepState([{ workflow_result: 0 }], 0), { kind: "pending", role: "" });
});

test("hoursText 整数不拖小数，半点照抄", () => {
  assert.equal(hoursText(2), "2 h");
  assert.equal(hoursText(1.5), "1.5 h");
  assert.equal(hoursText(7.25), "7.25 h");
  assert.equal(hoursText(0), "0 h");
  assert.equal(hoursText(NaN), "—");
  assert.equal(hoursText(Infinity), "—");
});

test("spanText 只留起点的日期，终点只留时分", () => {
  assert.equal(spanText("2026-11-16T18:00:00", "2026-11-16T20:30:00"), "2026-11-16 18:00 → 20:30");
  // 跨天：OA 允许跨越午夜，起点日期照留，终点只给时分。
  assert.equal(spanText("2026-11-16T22:00:00", "2026-11-17T01:00:00"), "2026-11-16 22:00 → 01:00");
  // 缺字段时不要吐出 "undefined"。
  assert.equal(spanText("2026-11-16T18:00:00", ""), "2026-11-16 18:00");
});

test("reasonText 把事由拼成一行，缺什么就少什么", () => {
  assert.equal(reasonText({ type: "进度延迟", project: "考勤系统" }), "进度延迟 / 考勤系统");
  assert.equal(reasonText({ type: "进度延迟" }), "进度延迟");
  assert.equal(reasonText({ project: "考勤系统" }), "考勤系统");
  assert.equal(reasonText({ type: "  ", project: " 考勤系统 " }), "考勤系统");
  assert.equal(reasonText({}), "");
  assert.equal(reasonText(null), "");
  assert.equal(reasonText(undefined), "");
});
