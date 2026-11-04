/**
 * 工作区模型（D116）的单元测试 —— 不碰真实 state：PI_WEB_STATE 指到临时目录。
 *
 * 覆盖 issue #72 验收里那三条最容易回退的语义：
 *   A 老文件 {pin, order} 迁移成 members[""]，顺序 = 旧 pin → 旧 order
 *   B 拖拽后的整组重排：{wsId: [ids]} 才是归属 + 顺序的真相，被藏起来的会话保留槽位
 *   C 删工作区只退会话（按原相对顺序退回未分组），一个也不删
 *
 * Run: node --experimental-strip-types bridge/tests/workspace-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-unit-"));
process.env.PI_WEB_STATE = dir;
const { Manage, UNGROUPED } = await import("../src/manage.ts");

const file = path.join(dir, "manage.json");
const write = (data) => fs.writeFileSync(file, JSON.stringify(data), "utf8");
const sid = (n) => ({ id: n, updatedAt: n.charCodeAt(0) });

let checks = 0;
function ok(name, fn) {
  fn();
  checks++;
  console.log("ok  ", name);
}

ok("A: 老 {pin, order} 折进 members[未分组]，顺序 pin → order", () => {
  write({ pin: ["a", "b"], order: ["c", "d"], archived: ["z"] });
  const m = new Manage();
  const snap = m.snapshot();
  assert.deepEqual(snap.members[UNGROUPED], ["a", "b", "c", "d"]);
  assert.deepEqual(snap.pin, ["a", "b"]);
  assert.deepEqual(snap.archived, ["z"]);
  assert.deepEqual(snap.workspaces, []);
});

ok("A2: 老文件里的 pin 顺序 == 迁移后的显示顺序（不被重排）", () => {
  write({ pin: ["q", "p"], order: [], archived: [] });
  const m = new Manage();
  const list = ["q", "p"].map(sid).sort((x, y) => m.compare(x, y));
  assert.deepEqual(list.map((s) => s.id), ["q", "p"]);
});

ok("B: 落地一个工作区后 assign 把人搬过去，members 顺序就是组内顺序", () => {
  write({ pin: [], order: ["a", "b", "c"], archived: [] });
  const m = new Manage();
  const ws = m.addWorkspace("pi-web-client", "ice");
  m.assign(["c", "a"], ws.id);
  const snap = m.snapshot();
  assert.deepEqual(snap.members[ws.id], ["c", "a"]);
  assert.deepEqual(snap.members[UNGROUPED], ["b"]);
});

ok("B2: arrangeGroups 整组重排，跨组移动靠它一次落定", () => {
  write({ pin: [], order: ["a", "b"], archived: [] });
  const m = new Manage();
  const ws = m.addWorkspace("bugs", "rose");
  m.arrangeGroups({ [ws.id]: ["b"], [UNGROUPED]: ["a"] });
  const snap = m.snapshot();
  assert.deepEqual(snap.members[ws.id], ["b"]);
  assert.deepEqual(snap.members[UNGROUPED], ["a"]);
});

ok("B3: DOM 里没有的会话（归档 / 被筛选藏起来）保留原归属、缀在组尾", () => {
  write({ pin: [], order: ["a", "b", "c"], archived: ["c"] });
  const m = new Manage();
  const ws = m.addWorkspace("x", "ice");
  m.assign(["b"], ws.id);
  // 前端只会把画出来的卡片送上来：c 是归档的，不在 groups 里
  m.arrangeGroups({ [ws.id]: ["b"], [UNGROUPED]: ["a"] });
  const snap = m.snapshot();
  assert.deepEqual(snap.members[UNGROUPED], ["a", "c"], "归档的那颗槽位没丢");
  assert.ok(m.isArchived("c"));
});

ok("C: 删工作区 → 里面的会话按相对顺序退回未分组，文件一个不删", () => {
  write({ pin: [], order: [], archived: [] });
  const m = new Manage();
  const ws = m.addWorkspace("gone", "amber");
  m.assign(["a", "b"], ws.id);
  m.assign(["k"], UNGROUPED);
  m.removeWorkspace(ws.id);
  const snap = m.snapshot();
  assert.deepEqual(snap.workspaces, []);
  assert.deepEqual(snap.members[UNGROUPED], ["k", "a", "b"]);
});

ok("D: compare 先按工作区、再按组内槽位；没归属的算未分组，排该组最前", () => {
  write({ pin: [], order: [], archived: [] });
  const m = new Manage();
  const s1 = m.addWorkspace("one", "ice");
  const s2 = m.addWorkspace("two", "teal");
  m.arrangeGroups({ [s1.id]: ["a", "b"], [s2.id]: ["c"], [UNGROUPED]: ["d"] });
  // "new" 不在任何桶里 → 归到未分组、排该组最前（新建会话在创建时就带 ws，所以这只是过渡态）
  const order = ["d", "c", "b", "a", "new"].map(sid).sort((x, y) => m.compare(x, y)).map((s) => s.id);
  assert.deepEqual(order, ["a", "b", "c", "new", "d"]);
});

ok("E: ★ 是集合，不影响组内顺序；归档会顺带摘星", () => {
  write({ pin: [], order: ["a", "b"], archived: [] });
  const m = new Manage();
  m.setPinned("b", true);
  assert.deepEqual(m.snapshot().pin, ["b"]);
  assert.deepEqual(m.snapshot().members[UNGROUPED], ["a", "b"], "钉一下不该改槽位");
  m.setArchived(["b"], true);
  assert.deepEqual(m.snapshot().pin, []);
});

ok("F: 工作区顺序可重排，删掉的工作区桶不会留下孤儿", () => {
  write({ pin: [], order: [], archived: [] });
  const m = new Manage();
  const a = m.addWorkspace("a", "ice");
  const b = m.addWorkspace("b", "teal");
  m.orderWorkspaces([b.id, a.id]);
  assert.deepEqual(m.snapshot().workspaces.map((w) => w.id), [b.id, a.id]);
  m.removeWorkspace(a.id);
  assert.deepEqual(m.snapshot().workspaces.map((w) => w.id), [b.id]);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nworkspace-unit: ${checks} 组断言 ALL OK`);
