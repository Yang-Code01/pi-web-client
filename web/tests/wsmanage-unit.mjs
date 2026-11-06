/**
 * 工作区管理（#100）的纯逻辑：改名输入怎么洗、要不要发请求、这个组能不能删。
 *
 * 只测这一层。「⋯ 菜单长什么样、点完树变不变」由 `probes/workspace-manage.mjs` 的浏览器探针把关
 * —— 那是它的公开缝。
 *
 * Run: node --experimental-transform-types web/tests/wsmanage-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanGroupName, dropBlocker, fixedBlocker, fixedDropped, fixedRows, renameIntent, toggleFixed } from "../src/wsmanage.ts";
import { PIN_MAX, PIN_MIN } from "../src/wstabs.ts";

const LIB = { id: "f:/pi-web-client", name: "", key: "F:/pi-web-client", manual: false };
const MANUAL = { id: "manual:abc", name: "客户 A", key: "", manual: true };

// ---------------------------------------------------------------- 名字

test("名字洗掉首尾空白与多余空格", () => {
  assert.equal(cleanGroupName("  客户 A  "), "客户 A");
  assert.equal(cleanGroupName("客户   A"), "客户 A");
  assert.equal(cleanGroupName("客户\tA\n仓库"), "客户 A 仓库");
});

test("空输入就是空串 —— 它表示「恢复成目录名」，不是「名字叫空」", () => {
  assert.equal(cleanGroupName(""), "");
  assert.equal(cleanGroupName("   "), "");
  assert.equal(cleanGroupName(null), "");
  assert.equal(cleanGroupName(undefined), "");
});

test("名字截到 80 个字符（与桥侧 slice(0, 80) 同一套规矩，别在页面里发出一个必被截断的名字）", () => {
  assert.equal(cleanGroupName("x".repeat(120)).length, 80);
});

// ---------------------------------------------------------------- 要不要发

test("名字没变就不发请求", () => {
  assert.equal(renameIntent("客户 A", " 客户 A "), null);
  assert.equal(renameIntent("", "   "), null);
});

test("清空名字要发一条空名字：桥那边 = 恢复目录名", () => {
  assert.equal(renameIntent("客户 A", ""), "");
  assert.equal(renameIntent("客户 A", "   "), "");
});

test("改了名字就发洗过的那个", () => {
  assert.equal(renameIntent("客户 A", "  客户  B "), "客户 B");
  assert.equal(renameIntent("", "新名字"), "新名字");
});

// ---------------------------------------------------------------- 能不能删

test("手建的空组可以删", () => {
  assert.equal(dropBlocker(MANUAL, 0), null);
});

test("有会话的组删不掉，原因里带上会话数", () => {
  const blocker = dropBlocker(MANUAL, 3);
  assert.ok(blocker && blocker.includes("3"), `原因要说清还有几个会话：${blocker}`);
});

test("跟着目录走的组删不掉：删了下次又回来", () => {
  const blocker = dropBlocker(LIB, 0);
  assert.ok(blocker && blocker.includes("目录"), `派生组的拒绝原因要说明它跟着目录走：${blocker}`);
});

test("组没了也删不掉（快照过期时的兜底）", () => {
  assert.ok(dropBlocker(undefined, 0));
});

test("派生组即使空了也不给删 —— 拒绝先于「空不空」判断", () => {
  assert.ok(dropBlocker(LIB, 0));
  assert.equal(dropBlocker({ ...LIB, manual: true }, 0), null);
});

// ---------------------------------------------------------------- 能不能固定（#122）

test("固定一个组：追加到末尾，已有的位置不动（顺序就是标签行顺序）", () => {
  assert.deepEqual(toggleFixed(["g1"], "g2"), ["g1", "g2"]);
  assert.deepEqual(toggleFixed([], "g1"), ["g1"]);
});

test("已固定的再点一次就是取消：别的位置不动", () => {
  assert.deepEqual(toggleFixed(["g1", "g2", "g3"], "g2"), ["g1", "g3"]);
});

test("重复点不会把同一个组塞两次", () => {
  assert.deepEqual(toggleFixed(["g1"], "g1"), []);
  assert.deepEqual(toggleFixed([], "g1"), ["g1"]);
});

test("名额还有空位就能固定", () => {
  assert.equal(fixedBlocker(LIB, [], 3), null);
  assert.equal(fixedBlocker(LIB, ["a", "b"], 3), null);
});

test("名额满了再固定要拒绝，原因里带上名额数（不能静默失败）", () => {
  const blocker = fixedBlocker(LIB, ["a", "b", "c"], 3);
  assert.ok(blocker && blocker.includes("3"), `拒绝原因要说清名额是几个：${blocker}`);
});

test("已经固定的组永远能取消 —— 名额满了也不拦", () => {
  assert.equal(fixedBlocker(LIB, ["f:/pi-web-client", "a", "b"], 3), null);
});

test("组没了就不给固定（快照过期时的兜底）", () => {
  assert.ok(fixedBlocker(undefined, [], 3));
});

// ---------------------------------------------------------------- 设置面板的勾选列表（#123）

const A = { id: "a", name: "甲", key: "A", manual: false };
const B = { id: "b", name: "乙", key: "B", manual: false };
const C = { id: "c", name: "丙", key: "C", manual: false };
const D = { id: "d", name: "丁", key: "D", manual: false };
const GROUPS = [A, B, C, D];

test("勾选列表的顺序就是传进来的组序（左栏序），不按固定顺序重排", () => {
  const rows = fixedRows(GROUPS, ["d", "b"], 3);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.id), ["b", "d"]);
});

test("固定的组勾着，且永远能取消（名额满了也不拦）", () => {
  const rows = fixedRows(GROUPS, ["a", "b", "c"], 3);
  assert.equal(rows[0].checked, true);
  assert.equal(rows[0].blocker, null);
});

test("名额满了：没勾的那几行给出不能勾的原因，并说清名额是几个", () => {
  const rows = fixedRows(GROUPS, ["a", "b", "c"], 3);
  const d = rows.find((r) => r.id === "d");
  assert.equal(d?.checked, false);
  assert.ok(d?.blocker && d.blocker.includes("3"), `置灰原因要说清名额：${d?.blocker}`);
});

test("名额还有空位：没勾的行不给原因（能点就是能点）", () => {
  const rows = fixedRows(GROUPS, ["a"], 3);
  assert.deepEqual(rows.map((r) => r.blocker), [null, null, null, null]);
});

test("列表里混进不存在的组 / 重复 id 不会多出一行，也不会多占名额", () => {
  const rows = fixedRows(GROUPS, ["b", "ghost", "b"], 3);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d"]);
  assert.equal(rows.filter((r) => r.checked).length, 1);
  assert.equal(rows.find((r) => r.id === "c")?.blocker, null);
});

test("快照里固定组比名额多（旧文件 / 别处刚写）时，只看得到前 N 个勾着", () => {
  const rows = fixedRows(GROUPS, ["a", "b", "c", "d"], 2);
  assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.id), ["a", "b"]);
  assert.ok(rows.find((r) => r.id === "c")?.blocker);
});

test("名额调小：报出因此被取消的固定组数（提示用）", () => {
  assert.equal(fixedDropped(["a", "b", "c"], 2), 1);
  assert.equal(fixedDropped(["a", "b"], 5), 0);
  assert.equal(fixedDropped([], 1), 0);
});

test("名额本身先按 1–5 夹住再算被取消几个", () => {
  assert.equal(fixedDropped(["a", "b", "c", "d", "e", "f"], 9), 1);
  assert.equal(fixedDropped(["a"], 0), 0);
  assert.equal(PIN_MIN, 1);
  assert.equal(PIN_MAX, 5);
});
