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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ws-unit-"));
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
  assert.equal(ws.drop(manual.id).ok, false, "有会话的组不许删");

  ws.move(["s9"], "");
  assert.equal(ws.drop(manual.id).ok, true);
  assert.ok(!ws.snapshot().groups.some((g) => g.id === manual.id));
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
