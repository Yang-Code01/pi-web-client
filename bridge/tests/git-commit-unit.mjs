/**
 * D289: 提交详情小窗的两个只读接口（`gitCommitDetail` / `gitCommitFile`）。
 *
 * 和 gitops-unit.mjs 一样用真 git 现搭仓库，不 mock —— 这几件事 mock 证明不了：
 * `%B` 的标题/正文切分、根提交的空树、merge 对照第一父、rename 的旧路径、
 * 「已推送」靠 remote-tracking ref 的包含关系而不是 `HEAD` 距离。
 *
 *   node --experimental-strip-types bridge/tests/git-commit-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommitDetail, gitCommitFile } from "../src/gitops.ts";

const root = mkdtempSync(join(tmpdir(), "pi-gitcommit-"));
const dir = join(root, "work");

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();

const put = (file, text) => {
  const p = join(dir, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const commit = (file, text, msg) => {
  put(file, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};
const rejects = async (promise, code, why) => {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `${why}：期望 ${code}，实际 ${err.code}`);
    return;
  }
  assert.fail(`${why}：应该抛 ${code}`);
};

try {
  execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });

  const c1 = commit("a.txt", "one\n", "a: one");
  const c2 = commit("b.txt", "two\n", "b: two");
  const c2b = (() => {
    put("a.txt", "one\none-and-half\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "a: 两行");
    return git(dir, "rev-parse", "HEAD");
  })();
  // rename：git mv b.txt c.txt
  git(dir, "mv", "b.txt", "c.txt");
  git(dir, "commit", "-q", "-m", "rename b → c");
  const c4 = git(dir, "rev-parse", "HEAD");
  // merge：从 c1 拉 side 分支加一个文件，再 no-ff 合回 main
  git(dir, "checkout", "-q", "-b", "side", c1);
  put("side.txt", "from side\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "side: 一个文件");
  const side = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  const merge = git(dir, "rev-parse", "HEAD");
  // 长正文：标题 + 500 行
  writeFileSync(join(dir, "msg.txt"), `docs: 长说明\n\n${Array.from({ length: 500 }, (_, i) => `第 ${i + 1} 行`).join("\n")}\n`);
  put("long.txt", "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-F", "msg.txt");
  const longMsg = git(dir, "rev-parse", "HEAD");

  // ---------------------------------------------------------------- 元信息
  const d2 = await gitCommitDetail(dir, c2);
  assert.equal(d2.sha, c2, "全长哈希原样返回");
  assert.equal(d2.short, c2.slice(0, 7), "short 就是 rev-parse --short 的长度");
  assert.equal(d2.subject, "b: two", "标题取 %B 第一行");
  assert.equal(d2.body, "", "只有标题时正文是空串（第一行不重复）");
  assert.equal(d2.bodyTruncated, false);
  assert.equal(d2.author, "Test");
  assert.ok(d2.at > 1_000_000_000_000, "at 是毫秒（与 GitCommit.at 同单位）");
  assert.deepEqual(d2.parents, [c1], "父提交是全长");
  assert.equal(d2.merge, false);
  assert.equal(d2.onHead, true, "当前分支的祖先 → onHead");
  assert.equal(d2.pushed, false, "没有 remote-tracking ref 时不算已推送");
  assert.deepEqual(d2.files.map((f) => f.path), ["b.txt"], "numstat 只列这条提交动过的文件");
  assert.equal(d2.files.find((f) => f.path === "b.txt").additions, 1);
  assert.equal(d2.total, 1);
  assert.equal(d2.more, false);
  assert.equal(d2.limit.files, 300, "文件列表封顶 300");

  // ---------------------------------------------------------------- 已推送
  git(dir, "update-ref", "refs/remotes/origin/main", c2b);
  const [dPush, dBefore] = await Promise.all([gitCommitDetail(dir, c2), gitCommitDetail(dir, c1)]);
  assert.equal(dPush.pushed, true, "被 origin/main 包含 → 已推送");
  assert.equal(dBefore.pushed, true, "更早的提交也在 origin/main 里");

  // ---------------------------------------------------------------- 根提交与正文
  const d1 = await gitCommitDetail(dir, c1);
  assert.deepEqual(d1.parents, [], "根提交没有父");
  assert.deepEqual(d1.files.map((f) => f.path), ["a.txt"]);
  assert.equal(d1.files[0].additions, 1, "根提交对着空树算增行");
  const f1 = await gitCommitFile(dir, c1, "a.txt");
  assert.equal(f1.kind, "text");
  assert.equal(f1.lines[0].right, "one", "根提交左侧是空树 → 全算新增");

  const dLong = await gitCommitDetail(dir, longMsg);
  assert.equal(dLong.subject, "docs: 长说明");
  assert.ok(dLong.body.startsWith("第 1 行"), "正文从第二行起");
  assert.equal(dLong.bodyTruncated, true, "500 行正文按 400 行封顶");
  assert.equal(dLong.body.split("\n").length, 400);
  assert.equal(dLong.limit.bodyLines, 400);

  // ---------------------------------------------------------------- rename 与 merge
  const d4 = await gitCommitDetail(dir, c4);
  const renamed = d4.files[0];
  assert.equal(renamed.path, "c.txt");
  assert.equal(renamed.old, "b.txt", "rename 带旧路径，读左侧要用它");
  assert.equal(renamed.status, "R");
  const fr = await gitCommitFile(dir, c4, "c.txt", "b.txt");
  assert.equal(fr.status, "R");
  assert.ok(fr.lines.some((l) => l.left === "two"), "左侧读的是旧路径 b.txt");

  const dm = await gitCommitDetail(dir, merge);
  assert.equal(dm.merge, true);
  assert.equal(dm.parents.length, 2);
  assert.equal(dm.parents[0], c4, "第一父是合进来的那一侧之前的分支尖");
  assert.ok(dm.parents.includes(side));
  assert.deepEqual(dm.files.map((f) => f.path), ["side.txt"], "merge 对照第一父：只多出 side 的文件");

  // ---------------------------------------------------------------- 两个文件的并排内容
  const f2 = await gitCommitFile(dir, c2, "b.txt");
  assert.equal(f2.path, "b.txt");
  assert.equal(f2.additions, 1);
  assert.ok(f2.lines.some((l) => l.right === "two" && l.tag === "add"), "新增文件右侧有内容");

  // ---------------------------------------------------------------- 参数清洗
  await rejects(gitCommitDetail(dir, "--evil"), "invalid_params", "`-` 开头的哈希不进 argv");
  await rejects(gitCommitDetail(dir, "deadbeef"), "commit_unknown", "不存在的提交");
  await rejects(gitCommitFile(dir, c2, "../outside"), "invalid_params", "`..` 路径不许进 argv");
  await rejects(gitCommitFile(dir, c2, "--output"), "invalid_params", "`-` 开头的路径不许进 argv");
  const missing = await gitCommitFile(dir, c2, "nope.txt");
  assert.equal(missing.path, "nope.txt", "清单里没有的文件也不炸，只是空内容");

  console.log("git-commit-unit: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
