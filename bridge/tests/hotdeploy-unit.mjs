/**
 * 热部署：桥端纯函数的单测 —— 不跑 git、不碰真进程。
 *
 *   node bridge/tests/hotdeploy-unit.mjs
 *
 * 和 sysmanage-unit 一样靠类型擦除直跑 src/*.ts，不加 --experimental-transform-types。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBranchRows, parseRefLines, parseTrack, parseWorktrees, tailLines } from "../src/hotdeploy.ts";

const TAB = String.fromCharCode(9);

// ------------------------------------------------- ① worktree 列表

const porcelain = [
  "worktree F:/repo",
  "HEAD abc1234",
  "branch refs/heads/main",
  "",
  "worktree F:/repo-wt/feat-a",
  "HEAD aaa1111",
  "branch refs/heads/feat/a",
  "",
  "worktree F:/repo-wt/detached",
  "HEAD ddd2222",
  "detached",
  "",
].join("\n");

const wts = parseWorktrees(porcelain);
assert.equal(wts.length, 3, "三块 worktree");
assert.deepEqual(wts[0], { path: "F:/repo", branch: "main", detached: false });
assert.equal(wts[1].branch, "feat/a", "refs/heads/ 前缀要去掉");
assert.equal(wts[2].branch, null);
assert.equal(wts[2].detached, true, "detached 要认出来");

// ------------------------------------------------- ② upstream track

assert.deepEqual(parseTrack("[ahead 2, behind 3]"), { ahead: 2, behind: 3, gone: false });
assert.deepEqual(parseTrack("[ahead 1]"), { ahead: 1, behind: 0, gone: false });
assert.deepEqual(parseTrack("[behind 7]"), { ahead: 0, behind: 7, gone: false });
assert.equal(parseTrack("[gone]").gone, true, "上游被删了要标 gone");
assert.deepEqual(parseTrack(""), { ahead: 0, behind: 0, gone: false });

// ------------------------------------------------- ③ for-each-ref 行

const refsOut = [
  [`refs/heads/main`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/heads/feat/a`, "aaa1111", "[ahead 2]", "2026-02-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/HEAD`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/main`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/feat/only`, "bbb2222", "", "2025-12-01T00:00:00+08:00"].join(TAB),
  "",
].join("\n");

const refs = parseRefLines(refsOut);
assert.equal(refs.length, 4, "origin/HEAD 不算一条分支");
assert.deepEqual(
  refs.map((r) => `${r.remote ? "R" : "L"}:${r.name}`),
  ["L:main", "L:feat/a", "R:main", "R:feat/only"],
  "refs/heads 与 refs/remotes/origin 都要去掉前缀",
);

// ------------------------------------------------- ④ 分支行：本地在前、占用的标出来

const rows = buildBranchRows(refs, wts, "main", "F:/repo");
assert.deepEqual(
  rows.map((r) => r.name),
  ["main", "feat/a", "feat/only"],
  "本地在前、当前分支排最前、只在远端的补在后面",
);
const main = rows[0];
assert.equal(main.current, true);
assert.equal(main.occupiedBy, null, "自己所在的 worktree 不算占用");
const featA = rows[1];
assert.equal(featA.occupiedBy, "F:/repo-wt/feat-a", "被别的 worktree 检出要带上路径");
assert.equal(featA.ahead, 2);
assert.equal(featA.remoteOnly, false);
const only = rows[2];
assert.equal(only.remoteOnly, true);
assert.equal(only.sha, "bbb2222");

// 路径大小写 / 分隔符不同也算同一份主检出
const winRows = buildBranchRows(parseRefLines(refsOut), parseWorktrees(porcelain.replace("F:/repo-wt/feat-a", "f:\\repo-wt\\feat-a")), "main", "F:/repo");
assert.equal(winRows[1].occupiedBy, "f:\\repo-wt\\feat-a");

// ------------------------------------------------- ⑤ 日志尾

const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hotdeploy-")), "worker.log");
fs.writeFileSync(log, "one\ntwo\nthree\nfour\n");
assert.deepEqual(tailLines(log, 2), ["three", "four"], "只要末尾 N 行");
assert.deepEqual(tailLines(path.join(path.dirname(log), "nope.log"), 5), [], "没有日志就是空的，不炸");

console.log("hotdeploy-unit: ok");
