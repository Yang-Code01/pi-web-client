/**
 * 工作区模型单测（#94）：临时目录里真跑 `git init` + `git worktree add`，不启桥、不碰页面。
 *
 * 断言的都是「说话算数」的外部行为：某个 cwd 属于哪个工作区、某个会话进了哪个组、
 * 缓存命中还会不会去跑 git（数调用次数）、放回工程之后会不会回到 cwd 推导。
 *
 *   node --experimental-transform-types bridge/tests/workspace-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// 展开 8.3 短名：`os.tmpdir()` 在长用户名的机器上会返回 `YANGQM~1.HYR` 这种短路径，而 git 回话
// 用的是长名 —— 不展开的话 worktree 那两条用例会把同一组算成两个（与代码无关的环境差异）。
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-unit-")));
// The state file must land in this test's own directory, not the real bridge state.
process.env.PI_WEB_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });

const { Workspaces, normalizePath } = await import("../src/workspaces.ts");
const { gitRoot } = await import("../src/git.ts");

/**
 * 每条用例一个干净的状态目录：它们共享同一个状态文件就互相串味（前一条已经补过的缓存
 * 会让后一条的「第一次 resolve」变成缓存命中）。
 */
let stateSeq = 0;
function fresh(options = {}, dir = path.join(tmp, `state-${++stateSeq}`)) {
  process.env.PI_WEB_STATE = dir;
  fs.mkdirSync(process.env.PI_WEB_STATE, { recursive: true });
  return new Workspaces(options);
}

const id = (p) => normalizePath(p).toLowerCase();

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "core.fsmonitor=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A repo with one empty commit (worktree add needs a HEAD), plus a worktree off it. */
function makeRepo(name, worktrees = []) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  const trees = worktrees.map((wt, i) => {
    const dir = path.join(tmp, `${name}-${wt}`);
    git(root, "worktree", "add", "-q", "-b", `${wt}${i}`, dir);
    return dir;
  });
  return { root, trees };
}

const library = makeRepo("library", ["wt1", "wt2"]);
const other = makeRepo("other");
const plain = path.join(tmp, "plain-a");
const plain2 = path.join(tmp, "plain-b");
fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(plain2, { recursive: true });

test("worktree 与主仓落到同一个工作区，组 id 就是工程根", async () => {
  const ws = fresh();
  await ws.resolve([library.root, ...library.trees]);

  const main = ws.groupFor("s-main", library.root);
  assert.equal(main, id(library.root));
  for (const tree of library.trees) assert.equal(ws.groupFor("s-wt", tree), main, `worktree ${tree} 应与主仓同组`);
  assert.equal(ws.snapshot().groups.length, 1);
});

test("非 git 目录各自成组", async () => {
  const ws = fresh();
  await ws.resolve([plain, plain2]);

  assert.equal(ws.groupFor("s-a", plain), id(plain));
  assert.equal(ws.groupFor("s-b", plain2), id(plain2));
  assert.notEqual(ws.groupFor("s-a", plain), ws.groupFor("s-b", plain2));
});

test("盘符根与已不存在的目录都不会炸", async () => {
  const ws = fresh();
  const drive = process.platform === "win32" ? "F:\\" : "/";
  const gone = path.join(tmp, "no-such-dir", "deeper");
  await ws.resolve([drive, gone]);

  assert.equal(typeof ws.groupFor("s-drive", drive), "string");
  assert.ok(ws.groupFor("s-drive", drive).length > 0);
  assert.equal(ws.groupFor("s-gone", gone), id(gone));
  if (process.platform === "win32") assert.ok(ws.groupFor("s-drive", drive).endsWith("/"), "盘符根保留 F:/");
});

test("缓存命中后不再调用 git，重启后也不必重算", async () => {
  const dir = path.join(tmp, "counted");
  fs.mkdirSync(dir, { recursive: true });
  let calls = 0;
  const counted = (d) => {
    calls += 1;
    return gitRoot(d);
  };

  const dir0 = path.join(tmp, "state-restart");
  const first = fresh({ root: counted }, dir0);
  const changed = await first.resolve([library.root, plain]);
  const afterFirst = calls;
  assert.equal(changed, true);
  assert.ok(afterFirst > 0, "第一次必须真的跑 git");

  assert.equal(await first.resolve([library.root, plain]), false, "缓存命中就不算有改动");
  assert.equal(calls, afterFirst, "缓存命中后不许再跑 git");

  // 重启 = 新实例读同一个状态文件，缓存落在盘上所以一次 git 都不用跑。
  const restarted = fresh({ root: counted }, dir0);
  assert.equal(await restarted.resolve([library.root, plain]), false);
  assert.equal(calls, afterFirst, "重启后仍不该重算");
  assert.equal(restarted.groupFor("s-main", library.root), id(library.root));
});

test("缓存没补齐前按 cwd 先成组，补齐后临时组让位给真工程根", async () => {
  const ws = fresh();
  const provisional = ws.groupFor("s-main", plain);
  assert.equal(provisional, id(plain), "没有缓存时先站在 cwd 上，新会话立刻有组可站");

  const changed = await ws.resolve([plain]);
  assert.equal(changed, true, "补齐缓存算有改动");
  const snapshot = ws.snapshot();
  assert.equal(snapshot.keys[id(plain)], normalizePath(plain), "非 git 目录把自己当工程根写进缓存");
  assert.equal(snapshot.groups.filter((g) => g.id === provisional).length, 1, "同一目录不该出两个组");
  assert.equal(ws.groupFor("s-main", plain), id(plain));
});

test("worktree 的临时组在补齐后消失，会话落到主仓那一组", async () => {
  const ws = fresh();
  const tree = library.trees[0];
  const provisional = ws.groupFor("s-tree", tree);
  assert.equal(provisional, id(tree));

  await ws.resolve([tree]);
  const snapshot = ws.snapshot();
  assert.ok(!snapshot.groups.some((g) => g.id === provisional), "worktree 的临时组要让位");
  assert.equal(ws.groupFor("s-tree", tree), id(library.root));
});

test("override 优先于 cwd；放回工程之后回到 cwd 推导", async () => {
  const ws = fresh();
  await ws.resolve([library.root, other.root]);
  const mine = ws.groupFor("s1", library.root);
  const elsewhere = ws.groupFor("s2", other.root);
  assert.notEqual(mine, elsewhere);

  ws.move(["s1"], elsewhere);
  assert.equal(ws.groupFor("s1", library.root), elsewhere, "拖过就钉死，cwd 再变也不推回去");
  assert.equal(ws.snapshot().overrides.s1, elsewhere);

  ws.move(["s1"], "");
  assert.equal(ws.groupFor("s1", library.root), mine, "放回工程 = 删 override，重新跟着 cwd 走");
  assert.equal(ws.snapshot().overrides.s1, undefined);
});

test("手动组：建、改名、只允许删空的", async () => {
  const ws = fresh();
  const manual = ws.create("客户 A");
  assert.ok(manual.id.startsWith("manual:"), "手动组 id 形如 manual:<随机>");
  assert.equal(manual.manual, true);
  assert.equal(manual.name, "客户 A");

  ws.rename(manual.id, "客户 B");
  assert.equal(ws.snapshot().groups.find((g) => g.id === manual.id).name, "客户 B");
  ws.rename(manual.id, "");
  assert.equal(ws.snapshot().groups.find((g) => g.id === manual.id).name, "", "空名 = 显示时取目录名");

  ws.move(["s9"], manual.id);
  assert.equal(ws.groupFor("s9", plain), manual.id);
  assert.equal(ws.drop(manual.id, 1).ok, false, "有会话的组不许删");

  ws.move(["s9"], "");
  assert.equal(ws.drop(manual.id, 0).ok, true);
  assert.ok(!ws.snapshot().groups.some((g) => g.id === manual.id));
});

// ---------------------------------------------------------------- #279 空组可删（含目录组）

test("#279 目录组空了也能删：快照与 order 同时去掉它", async () => {
  const ws = fresh();
  await ws.resolve([library.root, plain]);
  const lib = ws.groupFor("s1", library.root);
  ws.forget("s1");
  assert.ok(ws.snapshot().groups.some((g) => g.id === lib), "先确认它还在、且没有会话");

  assert.equal(ws.drop(lib, 0).ok, true, "空的目录组能删");
  assert.ok(!ws.snapshot().groups.some((g) => g.id === lib), "从快照里消失");
  assert.ok(!ws.snapshot().order.includes(lib), "从 order 里消失");
});

test("#279 有会话的目录组仍然拒绝，原因还是「跟着目录走」", async () => {
  const ws = fresh();
  await ws.resolve([library.root, plain]);
  const lib = ws.groupFor("s1", library.root);

  const refused = ws.drop(lib, 2);
  assert.equal(refused.ok, false);
  assert.ok(refused.reason.includes("目录"), `派生组的拒绝原因要说明它跟着目录走：${refused.reason}`);
  assert.ok(ws.snapshot().groups.some((g) => g.id === lib), "拒绝时一个字都不动");
});

test("#279 删组顺手清掉指向它的 override（会话已经没了的那种）", () => {
  const ws = fresh();
  const a = ws.create("客户 A").id;
  ws.move(["ghost"], a);
  assert.equal(ws.snapshot().overrides.ghost, a);

  assert.equal(ws.drop(a, 0).ok, true);
  assert.equal(ws.snapshot().overrides.ghost, undefined, "别留悬空指向");
});

test("forget 清掉 override，不留悬空指向", async () => {
  const ws = fresh();
  await ws.resolve([library.root, plain]);
  const target = ws.groupFor("s1", plain);
  ws.move(["s1"], target);
  assert.equal(ws.snapshot().overrides.s1, target);

  ws.forget("s1");
  assert.equal(ws.snapshot().overrides.s1, undefined);
  assert.equal(ws.groupFor("s1", library.root), id(library.root));
});

// ---------------------------------------------------------------- #173 一份 order 接管顺序

/** 直接把一份状态文件塞进目录里（模拟「存量文件 / 上一版桥写的文件」）。 */
function seed(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(value));
}

const ALPHA = id("A:/work/alpha");
const BETA = id("B:/work/beta");
const GAMMA = id("G:/work/gamma");

/** 三组的存量文件：两组只有目录名，一组有名字（显示名 = 目录名 / 组名）。 */
function legacy(dir, extra) {
  seed(dir, {
    groups: [
      { id: BETA, name: "", key: normalizePath("B:/work/beta"), manual: false },
      { id: ALPHA, name: "", key: normalizePath("A:/work/alpha"), manual: false },
      { id: GAMMA, name: "Gamma", key: normalizePath("G:/work/gamma"), manual: false },
    ],
    overrides: {},
    keys: {},
    ...extra,
  });
}

test("#173 旧 pinned 升级：pinned 顺序打头，其余按显示名字母序", () => {
  const dir = path.join(tmp, "state-173-pinned");
  legacy(dir, { pinned: [GAMMA, "nope", GAMMA, ALPHA] });
  const snap = fresh({}, dir).snapshot();
  // 显示名：Alpha / Beta / Gamma，大小写不敏感；pinned 的脏 id / 重复在这里洗掉。
  assert.deepEqual(snap.order, [GAMMA, ALPHA, BETA]);
  assert.equal("pinned" in snap, false, "快照里不再有 pinned");
});

test("#173 旧文件没有 pinned：全部按显示名字母序", () => {
  const dir = path.join(tmp, "state-173-legacy");
  legacy(dir, {});
  assert.deepEqual(fresh({}, dir).snapshot().order, [ALPHA, BETA, GAMMA]);
});

test("#173 迁移在第一次写入时落盘：文件里只有 order、没有 pinned", () => {
  const dir = path.join(tmp, "state-173-save");
  legacy(dir, { pinned: [GAMMA] });
  const ws = fresh({}, dir);
  ws.rename(GAMMA, "Gamma 工程"); // 任意一次写
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "workspaces.json"), "utf8"));
  assert.deepEqual(onDisk.order, [GAMMA, ALPHA, BETA]);
  assert.ok(!("pinned" in onDisk), "落盘不再带 pinned");
});

test("#173 order 落盘之后 order 说了算，旧 pinned 不再参与", () => {
  const dir = path.join(tmp, "state-173-order-wins");
  legacy(dir, { order: [BETA, "nope", BETA, GAMMA], pinned: [ALPHA] });
  assert.deepEqual(fresh({}, dir).snapshot().order, [BETA, GAMMA, ALPHA], "order 去重剔脏，缺的组补到末尾");
});

test("#173 新组追加到末尾（创建序），不按名字插队；删组从 order 里移除", () => {
  const ws = fresh();
  const b = ws.groupFor("s1", plain2); // plain-b
  const a = ws.groupFor("s2", plain); // plain-a，字母序在前
  assert.deepEqual(ws.snapshot().order, [b, a], "ensure 出来的新组排在末尾");
  const manual = ws.create("客户 A").id;
  assert.deepEqual(ws.snapshot().order, [b, a, manual], "create 也是追加");
  assert.equal(ws.drop(manual, 0).ok, true);
  assert.deepEqual(ws.snapshot().order, [b, a], "drop 从 order 里移除");
});

test("#173 setTabs({ order })：去重、剔未知 id、缺的组按创建序补末尾，不按名额截断", () => {
  const ws = fresh();
  const a = ws.groupFor("s1", plain);
  const b = ws.groupFor("s2", plain2);
  const c = ws.create("CC").id;
  const d = ws.create("DD").id;
  assert.equal(ws.setTabs({ order: [d, "nope", d, a], max: 2 }).ok, true);
  const snap = ws.snapshot();
  assert.deepEqual(snap.order, [d, a, b, c], "缺的 b / c 按创建序补到末尾");
  assert.equal(snap.max, 2);
  assert.equal(snap.order.length, 4, "order 是全量顺序，名额只决定画几颗");
});

test("#173 只传 max：顺序一个字不动", () => {
  const ws = fresh();
  const a = ws.groupFor("s1", plain);
  const b = ws.groupFor("s2", plain2);
  ws.setTabs({ order: [b, a] });
  assert.equal(ws.setTabs({ max: 8 }).ok, true);
  assert.deepEqual(ws.snapshot().order, [b, a]);
  assert.equal(ws.snapshot().max, 8);
});

test("#173 旧页面只传 pinned：不报错，也不改顺序", () => {
  const ws = fresh();
  const a = ws.groupFor("s1", plain);
  const b = ws.groupFor("s2", plain2);
  ws.setTabs({ order: [b, a] });
  assert.equal(ws.setTabs({ pinned: [a] }).ok, true);
  assert.deepEqual(ws.snapshot().order, [b, a], "旧页面发来的 pinned 不参与排序");
});

test("#173 非法 order：回原因且状态一个字不变", () => {
  const ws = fresh();
  ws.groupFor("s1", plain);
  const before = ws.snapshot();
  for (const bad of ["g1", null, 3, {}, true]) {
    const result = ws.setTabs({ order: bad });
    assert.equal(result.ok, false, `order=${JSON.stringify(bad)} 该被拒（空数组是合法的，见下一条）`);
    assert.ok(result.reason, "拒绝要带一句原因（桥据此回 notice）");
  }
  assert.deepEqual(ws.snapshot(), before, "非法值不许改任何东西");
});

test("#173 空数组是合法 order：组按创建序补到末尾", () => {
  const ws = fresh();
  const b = ws.groupFor("s1", plain2);
  const a = ws.groupFor("s2", plain);
  assert.equal(ws.setTabs({ order: [] }).ok, true);
  // 自愈补齐按创建序（不是字母序）：先建的 b 在前。
  assert.deepEqual(ws.snapshot().order, [b, a]);
});

test("#176 名额只接受 1–12 的整数，越界 / 小数 / 非数字都回原因且不改状态", () => {
  const ws = fresh();
  const before = ws.snapshot();
  for (const bad of [0, 13, 99, 2.7, -4]) {
    const result = ws.setTabs({ max: bad });
    assert.equal(result.ok, false, `max=${bad} 该被拒`);
    assert.ok(result.reason, "拒绝要带一句原因（桥据此回 notice）");
  }
  assert.deepEqual(ws.snapshot(), before, "非法值不许改任何东西");
  for (const [given, want] of [[1, 1], [8, 8], [12, 12]]) {
    assert.equal(ws.setTabs({ max: given }).ok, true, `max=${given} 该被接受`);
    assert.equal(ws.snapshot().max, want, `max=${given} 应落成 ${want}`);
  }
});

test("#176 旧状态没设过名额按 6；显式设过 3 的保留 3，非法值回默认 6", () => {
  const seed = (body) => {
    const dir = path.join(tmp, `state-${++stateSeq}`);
    process.env.PI_WEB_STATE = dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(body));
    return new Workspaces();
  };
  const base = { groups: [], overrides: {}, keys: {}, order: [] };
  assert.equal(seed(base).snapshot().max, 6, "从没设置过 → 默认 6");
  assert.equal(seed({ ...base, max: 3 }).snapshot().max, 3, "显式设过 3 → 还是 3（不被悄悄改掉）");
  assert.equal(seed({ ...base, max: 8 }).snapshot().max, 8, "范围内原样保留");
  assert.equal(seed({ ...base, max: 99 }).snapshot().max, 6, "非法读入回默认 6");
  assert.equal(seed({ ...base, max: 0 }).snapshot().max, 6, "非法读入回默认 6（下界）");
  assert.equal(seed({ ...base, max: 2.7 }).snapshot().max, 6, "小数也非法，回默认 6");
});

test("#173 非法名额：回原因且状态一个字不变", () => {
  const ws = fresh();
  const a = ws.groupFor("s1", plain);
  ws.setTabs({ order: [a], max: 9 });
  const before = ws.snapshot();
  for (const bad of ["3", null, Number.NaN, {}, [], true]) {
    const result = ws.setTabs({ max: bad });
    assert.equal(result.ok, false, `max=${JSON.stringify(bad)} 该被拒`);
    assert.ok(result.reason, "拒绝要带一句原因（桥据此回 notice）");
  }
  assert.deepEqual(ws.snapshot(), before, "非法值不许改任何东西");
});

test("#173 临时组被回收时从 order 里消失，真工程根成为新组追加进来", async () => {
  const ws = fresh();
  const tree = library.trees[1];
  const provisional = ws.groupFor("s-tree", tree);
  assert.deepEqual(ws.snapshot().order, [provisional]);

  await ws.resolve([tree]);
  assert.deepEqual(ws.snapshot().order, [], "被回收的组不许留在 order 里");

  const real = ws.groupFor("s-tree", tree);
  assert.deepEqual(ws.snapshot().order, [real], "真工程根成为新组，追加进 order");
});

// ---------------------------------------------------------------- #276 横条成员

test("#276 旧状态文件没有 inRow：读成在横条里（true），快照一定带上这个字段", () => {
  const dir = path.join(tmp, "state-276-legacy");
  legacy(dir, { order: [ALPHA, BETA, GAMMA] });
  const snap = fresh({}, dir).snapshot();
  assert.deepEqual(snap.groups.map((g) => g.inRow), [true, true, true]);
});

test("#276 新组默认在横条里；setRow 落盘、跨重启保留，且不改 order / max", () => {
  const dir = path.join(tmp, "state-276-row");
  const ws = fresh({}, dir);
  const a = ws.groupFor("s1", plain);
  const manual = ws.create("客户 A").id;
  assert.equal(ws.snapshot().groups.find((g) => g.id === a)?.inRow, true);
  assert.equal(ws.snapshot().groups.find((g) => g.id === manual)?.inRow, true);

  ws.setTabs({ order: [manual, a], max: 2 });
  const order = [...ws.snapshot().order];
  assert.equal(ws.setRow(a, false), true, "改成不在横条里算有改动");
  const snap = ws.snapshot();
  assert.equal(snap.groups.find((g) => g.id === a)?.inRow, false);
  assert.deepEqual(snap.order, order, "成员只是过滤条件，不动组序");
  assert.equal(snap.max, 2, "成员不动名额");

  const restarted = fresh({}, dir);
  assert.equal(restarted.snapshot().groups.find((g) => g.id === a)?.inRow, false, "重启后仍记得");
  assert.equal(restarted.setRow(a, false), false, "已经是这个值：不算改动");
  assert.equal(restarted.setRow("nope", true), false, "找不到的组：不算改动");
  assert.equal(restarted.setRow(a, true), true);
  assert.equal(restarted.snapshot().groups.find((g) => g.id === a)?.inRow, true);
});
