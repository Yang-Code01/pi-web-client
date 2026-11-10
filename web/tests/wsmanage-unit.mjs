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
import {
  cleanDirPath,
  cleanGroupName,
  dirBaseName,
  dropBlocker,
  dropHint,
  groupAtDir,
  groupAtResolvedDir,
  hasRowMembership,
  renameIntent,
  wsCreateAction,
  wsNeighborsAfterDrop,
} from "../src/wsmanage.ts";

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

// ---------------------------------------------------------------- 能不能发起删除确认

test("空组与有会话的组都能发起删除确认", () => {
  assert.equal(dropBlocker(MANUAL, 0), null);
  assert.equal(dropBlocker(LIB, 0), null);
  assert.equal(dropBlocker(MANUAL, 3), null);
  assert.equal(dropBlocker(LIB, 3), null);
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

test("删除说明明确会移入垃圾箱、还原会恢复工作区", () => {
  const manual = dropHint(MANUAL);
  const dir = dropHint(LIB);
  assert.equal(manual, dir, "手动组和目录组删除语义一致");
  assert.match(manual, /垃圾箱/, `说明提到垃圾箱：${manual}`);
  assert.match(manual, /还原/, `说明提到还原：${manual}`);
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

// ---------------------------------------------------------------- #278 按目录建组

test("#278 路径归一化与桥同一套：反斜杠 / 重复斜杠 / 尾斜杠 / 盘符根", () => {
  assert.equal(cleanDirPath("F:\\work\\app\\"), "F:/work/app");
  assert.equal(cleanDirPath("F://work///app"), "F:/work/app");
  assert.equal(cleanDirPath("  F:/work/app/  "), "F:/work/app");
  assert.equal(cleanDirPath("F:\\"), "F:/", "盘符根保留斜杠");
  assert.equal(cleanDirPath(""), "");
  assert.equal(cleanDirPath(null), "");
});

test("#278 目录名取最后一段，空路径给空串", () => {
  assert.equal(dirBaseName("F:/work/app/"), "app");
  assert.equal(dirBaseName("F:\\work\\app"), "app");
  assert.equal(dirBaseName("/srv/repo"), "repo");
  assert.equal(dirBaseName(""), "");
});

test("#278 找已在列表里的组：忽略大小写、正反斜杠、尾斜杠", () => {
  const groups = [LIB, MANUAL, { id: "f:/work/app", name: "", key: "F:/work/app", manual: false }];
  assert.equal(groupAtDir(groups, "f:/PI-WEB-CLIENT")?.id, LIB.id);
  assert.equal(groupAtDir(groups, "f:\\pi-web-client\\")?.id, LIB.id);
  assert.equal(groupAtDir(groups, "F:/work/app")?.id, "f:/work/app");
  assert.equal(groupAtDir(groups, "F:/work/other"), undefined);
  assert.equal(groupAtDir([MANUAL], ""), undefined, "手动组没有目录，不能被「空目录」撞上");
});

test("#278 已经在列表里 → 按钮说「带你过去」，不会建第二个", () => {
  const groups = [LIB, MANUAL];
  const action = wsCreateAction(groups, "f:/PI-WEB-CLIENT/");
  assert.equal(action.dir, "f:/PI-WEB-CLIENT", "发出去的是归一化后的路径");
  assert.equal(action.existing?.id, LIB.id);
  assert.equal(action.label, "带你过去");
  assert.equal(action.create, false, "已有目录不发送创建");
});

test("#278 新目录 → 按钮说「就在这里新建」，发送归一化后的路径", () => {
  const action = wsCreateAction([LIB, MANUAL], "F:\\work\\new\\");
  assert.equal(action.dir, "F:/work/new");
  assert.equal(action.existing, undefined);
  assert.equal(action.label, "就在这里新建");
  assert.equal(action.create, true);
});

test("#278 没选目录：不建、按钮也不冒充能建", () => {
  const action = wsCreateAction([LIB], "   ");
  assert.equal(action.dir, "");
  assert.equal(action.create, false);
  assert.equal(action.existing, undefined);
});

// ---------------------------------------------------------------- #278 桥解析折回目录

// 子目录 / worktree 逐字比 `key` 比不出来，但桥的 `ws.resolve` 会折回工程根。

test("#278 子目录：桥说折回这个组 → 按钮跟着改口，不再「就在这里新建」", () => {
  const action = wsCreateAction([LIB, MANUAL], "F:/pi-web-client/web", { dir: "F:/pi-web-client/web", id: LIB.id });
  assert.equal(action.existing?.id, LIB.id);
  assert.equal(action.label, "带你过去");
  assert.equal(action.create, false);
});

test("#278 worktree：桥折回主仓那个组，按钮同样改口", () => {
  const action = wsCreateAction([LIB], "F:/pi-web-client/.worktrees/a", { dir: "F:/pi-web-client/.worktrees/a", id: LIB.id });
  assert.equal(action.existing?.id, LIB.id);
  assert.equal(action.create, false);
});

test("#278 桥说没有 / 回答的是别的目录：退回本地逐字比较（旧桥行为不变）", () => {
  const fresh = wsCreateAction([LIB], "F:/work/new", { dir: "F:/work/new", id: null });
  assert.equal(fresh.existing, undefined);
  assert.equal(fresh.create, true);

  const stale = wsCreateAction([LIB], "F:/pi-web-client/web", { dir: "F:/work/old", id: "f:/work/old" });
  assert.equal(stale.existing, undefined, "旧回答不许算到新目录头上");
  assert.equal(stale.create, true);
});

test("#278 回答指向快照里没有的组：退回逐字比较，不把按钮留在死路上", () => {
  assert.equal(groupAtResolvedDir([LIB], "F:/pi-web-client", { dir: "F:/pi-web-client", id: "f:/gone" })?.id, LIB.id);
});
