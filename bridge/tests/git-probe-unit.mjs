/**
 * #392「目录与仓库」：展开一层目录时批量探测直接子目录。
 *
 * 这里用真 git 搭树，不 mock：要盯住的边界全是 git 自己的规矩 —— 子目录是不是**自己的**仓库根
 * （父仓库里的普通目录、`node_modules` 都不能标成仓库）、空仓库 / 游离 HEAD 怎么报、非法名字
 * 不能被拼成路径、名目超额要截断、5s 缓存与 `fresh` 的先后关系。
 *
 *   node --experimental-transform-types bridge/tests/git-probe-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitInfo, probeChildren } from "../src/git.ts";

const root = mkdtempSync(join(tmpdir(), "pi-gitprobe-"));
const outer = join(root, "erp");
const api = join(outer, "api");
const ui = join(outer, "ui");
const emptyRepo = join(outer, "empty");

/** 所有 git 调用固定身份，免得依赖跑这台机器的 ~/.gitconfig。 */
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  ).trim();

const put = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `${file}: ${text}`);
};
const fwd = (p) => resolve(p).replace(/\\/g, "/");

try {
  // 伞形目录：outer 自己也是仓库，里面套两个独立仓库 + 普通目录 + node_modules + 空仓库。
  mkdirSync(outer, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", outer], { encoding: "utf8" });
  put(outer, "README.md", "umbrella");

  for (const [dir, branch] of [[api, "feat/x"], [ui, "main"]]) {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
    put(dir, "a.txt", dir);
    if (branch !== "main") git(dir, "checkout", "-q", "-b", branch);
  }
  // api 有 1 条未提交的已跟踪改动（未跟踪的 new.txt 不计）。
  writeFileSync(join(api, "a.txt"), "changed");
  writeFileSync(join(api, "new.txt"), "untracked");
  // ui 游离 HEAD：分支字段退化成短 SHA。
  git(ui, "checkout", "-q", "--detach");
  const uiSha = git(ui, "rev-parse", "--short", "HEAD");
  // 空仓库：git init 过、一条提交都没有。
  mkdirSync(emptyRepo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", emptyRepo], { encoding: "utf8" });
  // 普通目录与 node_modules：都在 outer 这个仓库里，但**不是**自己的仓库。
  for (const name of ["docs", "node_modules", "node_modules/react"]) mkdirSync(join(outer, name), { recursive: true });
  // 深一层的独立仓库：属于 api，不属于 outer。
  const nested = join(api, "nested");
  mkdirSync(nested, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", nested], { encoding: "utf8" });
  put(nested, "n.txt", "nested");

  // ---------------------------------------------------------------- 基本批量
  const batch = await probeChildren(outer, ["api", "ui", "empty", "docs", "node_modules", "nested", "missing", ".", "..", "", "api/x", "api"]);
  assert.equal(batch.truncated, false, "名字没超额就不截断");
  assert.deepEqual(
    Object.keys(batch.probes).sort(),
    ["api", "docs", "empty", "missing", "nested", "node_modules", "ui"],
    "只回合法直接子目录名，去重、丢掉 . / .. / 带分隔符 / 空名字（nested 是 api 的子目录，不在这一层）",
  );
  assert.equal(batch.probes.api.repo, fwd(api), "api 标成它自己的仓库根，不是 outer");
  assert.equal(batch.probes.api.branch, "feat/x");
  assert.equal(batch.probes.api.dirty, 1, "只数已跟踪改动，未跟踪的 new.txt 不算");
  assert.equal(batch.probes.ui.detached, true, "游离 HEAD 要标出来");
  assert.equal(batch.probes.ui.branch, uiSha, "游离 HEAD 的分支字段是短 SHA");
  assert.equal(batch.probes.empty.empty, true, "空仓库不是「不是仓库」");
  assert.equal(batch.probes.empty.branch, "", "空仓库没有分支名");
  assert.equal(batch.probes.docs, null, "父仓库里的普通目录不能标成仓库");
  assert.equal(batch.probes.node_modules, null, "node_modules 不是仓库");
  assert.equal(batch.probes.missing, null, "不存在的目录回 null 而不是报错");

  // 不套进子目录时，gitInfo 会向上找到父仓库 —— 这正是批量接口必须自己过滤的原因。
  assert.equal((await gitInfo(join(outer, "docs"))).repo, fwd(outer), "gitInfo(docs) 找到的是 outer");

  // ---------------------------------------------------------------- 缓存与 fresh
  const warm = await probeChildren(outer, ["api"], { fresh: false });
  assert.equal(warm.probes.api.branch, "feat/x", "第一次探测读到 feat/x");
  git(api, "checkout", "-q", "-b", "main2");
  const cached = await probeChildren(outer, ["api"]);
  assert.equal(cached.probes.api.branch, "feat/x", "5s 内复用缓存，不重新跑 git");
  const fresh = await probeChildren(outer, ["api"], { fresh: true });
  assert.equal(fresh.probes.api.branch, "main2", "fresh 绕过缓存，读得到刚切的分支");

  // ---------------------------------------------------------------- 上限与截断
  const many = await probeChildren(outer, Array.from({ length: 70 }, (_, i) => `d${i}`), { limit: 8 });
  assert.equal(many.truncated, true, "70 个名字、上限 8：要报告截断");
  assert.equal(Object.keys(many.probes).length, 8, "只探前 8 个");
  assert.equal(many.probes.d0, null, "截断后仍返回结构（这里是 null）");

  // 上限与名字数量相等时不算截断（边界）。
  const exact = await probeChildren(outer, Array.from({ length: 8 }, (_, i) => `d${i}`), { limit: 8 });
  assert.equal(exact.truncated, false, "正好等于上限不算截断");
  assert.equal(Object.keys(exact.probes).length, 8);
  assert.equal(exact.probes.d0, null);

  // limit 非法值兜底成默认值，不抛。
  const junk = await probeChildren(outer, ["api"], { limit: Number.NaN });
  assert.equal(junk.probes.api.branch, "main2", "limit 非法时退回默认上限");

  console.log("git-probe-unit: ok — 子仓库/普通目录/空仓/游离 HEAD/非法名/截断/缓存+fresh");
} finally {
  rmSync(root, { recursive: true, force: true });
}
