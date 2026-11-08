/**
 * D188: 分支历史弹窗的数据全在 `gitHistory` 里 —— 两列的每一行是 `left` / `right` / `common` 的哪一类、
 * ahead / behind 是不是和 `rev-list --left-right --count` 一致、空仓库与非仓库会不会分得开。
 *
 * 这里用真 git 现搭一个小仓库（本地裸库当 origin），不 mock：这些边界（`origin/HEAD` 不在、只有
 * remote-tracking ref、`--count` 的左右顺序）全是 git 自己的规矩，mock 出来只能测到 mock。
 *
 *   node --experimental-transform-types bridge/tests/git-history-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHistoryError, gitFetch, gitHistory } from "../src/git.ts";

const root = mkdtempSync(join(tmpdir(), "pi-githist-"));
const bare = join(root, "origin.git");
const dir = join(root, "work");
const clone2 = join(root, "other");

/** 所有 git 调用固定身份与时间，免得依赖跑这台机器的 ~/.gitconfig。 */
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  ).trim();

const commit = (cwd, file, text, at) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-q", "-m", `${file}: ${text}`], {
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    encoding: "utf8",
  });
  return git(cwd, "rev-parse", "--short", "HEAD");
};

const expectCode = async (promise, code, why) => {
  try {
    await promise;
    assert.fail(`${why}：应该抛 ${code}`);
  } catch (err) {
    assert.ok(err instanceof GitHistoryError, `${why}：应该是 GitHistoryError，实际 ${err}`);
    assert.equal(err.code, code, why);
  }
};

execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { encoding: "utf8" });
execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
git(dir, "remote", "add", "origin", bare);

// main 上三条，推上去，再让 origin/HEAD 指向 main（clone 出来的仓库才有，init 出来的没有）。
const m1 = commit(dir, "a.txt", "one", "2026-01-01T10:00:00");
const m2 = commit(dir, "b.txt", "two", "2026-01-02T10:00:00");
const m3 = commit(dir, "c.txt", "three", "2026-01-03T10:00:00");
git(dir, "push", "-q", "-u", "origin", "main");
git(dir, "remote", "set-head", "origin", "-a");

// 分支上两条，其中一条是 merge commit（界面上要标 merge 药丸）。
git(dir, "checkout", "-q", "-b", "feat/x");
const f1 = commit(dir, "d.txt", "four", "2026-01-04T10:00:00");
const f2 = commit(dir, "e.txt", "five", "2026-01-05T10:00:00");

const first = await gitHistory(dir, { n: 20 });
assert.equal(first.repo, dir.replace(/\\/g, "/"), "repo 是 `rev-parse --show-toplevel` 归一化过的路径");
assert.equal(first.head, "feat/x");
assert.equal(first.detached, false);
assert.equal(first.base, "origin/main", "没传 base 时默认 origin/HEAD");
assert.equal(first.baseAuto, true);
assert.equal(first.ahead, 2, "feat/x 比 main 多两条");
assert.equal(first.behind, 0);
assert.equal(first.mergeBase?.h, m3, "分叉点就是 main 的头");
assert.equal(first.left.length, 5, "左列是 HEAD 的完整近史（分支 2 + 共同 3）");
assert.deepEqual(
  first.left.slice(0, 2).map((c) => c.h),
  [f2, f1],
  "新的在上",
);
assert.deepEqual(first.left.map((c) => c.set), ["left", "left", "common", "common", "common"], "独有的两条由右侧差集算出来");
assert.deepEqual(first.right.map((c) => c.h), [m3, m2, m1], "右列是对照分支的完整近史（没重复）");
assert.deepEqual(first.right.map((c) => c.set), ["common", "common", "common"], "两边都有的行算 common —— 页面靠它淡显");
assert.ok(first.branches.some((b) => b.name === "origin/main"), "下拉里要有远程分支");
assert.ok(!first.branches.some((b) => b.name.endsWith("/HEAD")), "`origin/HEAD` 是符号引用，不该出现在下拉里");
assert.equal(first.more.left, false, "5 条没到 20，不显示「再加载」");

// 显式传 base：关掉 auto，并且可以指到本地的 main。
const explicit = await gitHistory(dir, { n: 20, base: "main" });
assert.equal(explicit.base, "main");
assert.equal(explicit.baseAuto, false);
assert.equal(explicit.ahead, 2);
assert.equal(explicit.right.length, 3);

// 落后的方向：另一个 clone 往 main 推一条，本机 fetch 之后 behind 变成 1。
execFileSync("git", ["clone", "-q", bare, clone2], { encoding: "utf8" });
const m4 = commit(clone2, "f.txt", "six", "2026-01-06T10:00:00");
git(clone2, "push", "-q", "origin", "main");
assert.equal((await gitHistory(dir, { n: 20 })).behind, 0, "没 fetch 之前本地 remote-tracking ref 还是旧的");
const fetched = await gitFetch(dir);
assert.equal(fetched.remote, "origin", "fetch 走的是 origin");
assert.ok(fetched.at > 0, "fetch 回来要带上时间戳（页面底部那句「数据来自 …」）");
const after = await gitHistory(dir, { n: 20, fresh: true });
assert.equal(after.behind, 1, "fetch 之后才看得见 main 上那条");
assert.equal(after.right[0].h, m4);
assert.deepEqual(after.left.map((c) => c.set), ["left", "left", "common", "common", "common"], "main 上那条前进的不进左列");
assert.equal(after.mergeBase?.h, m3, "分叉点不会因为对照分支前进而变");

// n 的下限：再小也给 10 条，免得有人传 0 回来一个空列表。
const floor = await gitHistory(dir, { n: 0, fresh: true });
assert.ok(floor.left.length >= 5 && floor.left.length <= 10, "n 被夹到 10");

// 分页：n 只截列表，不影响 ahead / behind。
const paged = await gitHistory(dir, { n: 10, base: "origin/main", fresh: true });
assert.equal(paged.more.left, false);

// 错误分支：base 不存在 → base_unknown（不是空列表、不是 not_repo）。
await expectCode(gitHistory(dir, { base: "origin/nope" }), "base_unknown", "乱填的对照分支");

// 空仓库：有 .git、没有提交。
const emptyDir = join(root, "empty");
execFileSync("git", ["init", "-q", "-b", "main", emptyDir], { encoding: "utf8" });
await expectCode(gitHistory(emptyDir), "empty", "空仓库");

// 不是仓库：目录在，但没有 .git。
const plain = join(root, "plain");
execFileSync("git", ["init", "-q", plain], { encoding: "utf8" });
rmSync(join(plain, ".git"), { recursive: true, force: true });
assert.equal(await gitHistory(plain), null, "没有 .git 的目录返回 null（和 /api/git 一致），不是抛错");

// detached HEAD：能读，只是 head 变成短哈希。
git(dir, "checkout", "-q", "--detach", f1);
const detached = await gitHistory(dir, { fresh: true });
assert.equal(detached.detached, true);
assert.equal(detached.head, f1);
assert.ok(detached.ahead + detached.behind > 0, "detached 也照样能算差距");

rmSync(root, { recursive: true, force: true });
console.log("git-history: ok — 分类 / 计数 / 分叉点 / 分页 / fetch / 空仓库 / 非仓库 / 坏对照分支");
