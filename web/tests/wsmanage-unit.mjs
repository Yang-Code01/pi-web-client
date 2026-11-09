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
import { cleanGroupName, dropBlocker, dropHint, hasRowMembership, renameIntent, wsNeighborsAfterDrop } from "../src/wsmanage.ts";

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

// #279 边界改成「有会话才拦」：空的手动组与空的目录组都能删。

 test("空组能删，手动组与目录组一样", () => {
  assert.equal(dropBlocker(MANUAL, 0), null);
  assert.equal(dropBlocker(LIB, 0), null);
});

test("手动组有会话：删不掉，原因里带上会话数", () => {
  const blocker = dropBlocker(MANUAL, 3);
  assert.ok(blocker && blocker.includes("3"), `原因要说清还有几个会话：${blocker}`);
});

test("目录组有会话：删不掉，原因还是「跟着目录走」", () => {
  const blocker = dropBlocker(LIB, 3);
  assert.ok(blocker && blocker.includes("目录"), `派生组的拒绝原因要说明它跟着目录走：${blocker}`);
});

test("组没了也删不掉（快照过期时的兜底）", () => {
  assert.ok(dropBlocker(undefined, 0));
  assert.ok(dropBlocker(undefined, 3));
});

// ---------------------------------------------------------------- 删掉当前组之后落到哪

test("删掉中间的组：先右邻、再左邻", () => {
  assert.deepEqual(wsNeighborsAfterDrop(["a", "b", "c"], "b"), ["c", "a"]);
});

test("删掉最后一组：没有右邻就退到左邻，近的在前", () => {
  assert.deepEqual(wsNeighborsAfterDrop(["a", "b", "c"], "c"), ["b", "a"]);
});

test("删掉第一个组：只剩右邻", () => {
  assert.deepEqual(wsNeighborsAfterDrop(["a", "b", "c"], "a"), ["b", "c"]);
});

test("要删的组不在组序里（快照已经变了）：没有落点", () => {
  assert.deepEqual(wsNeighborsAfterDrop(["a", "b"], "z"), []);
});

test("能删时，删除项底下那句说明分得清手动组与目录组", () => {
  const manual = dropHint(MANUAL);
  const dir = dropHint(LIB);
  assert.match(manual, /组/, `手动组要说清删的是组：${manual}`);
  assert.match(dir, /目录/, `目录组要说清删的是列表里的这一项：${dir}`);
  assert.notEqual(manual, dir);
});

// ---------------------------------------------------------------- #276 桥是否支持横条成员


test("#276 每组都带布尔 inRow 才算支持横条成员（新桥）", () => {
  assert.equal(hasRowMembership([{ ...LIB, inRow: true }, { ...MANUAL, inRow: false }]), true);
});

test("#276 旧桥的快照没有 inRow 字段：整份按「都在横条里」处理，不画成员入口", () => {
  assert.equal(hasRowMembership([LIB, MANUAL]), false);
  assert.equal(hasRowMembership([{ ...LIB, inRow: true }, MANUAL]), false, "缺一颗也不冒充新桥");
});

test("#276 空快照没有可判断的组：不当作支持", () => {
  assert.equal(hasRowMembership([]), false);
});
