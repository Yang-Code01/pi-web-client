/**
 * 「那条分支的检出在哪」（`bridge/src/worktrees.ts`）。
 *
 * 自动评审的修复轮必须在一份检出了 PR head 的目录里做，否则 agent 在 worktree 里提交、桥在主
 * 检出里找 commit —— 闸门 / 记账 / 推送三处一起错位（D462 补记）。这里钉住三件事：
 * 已有检出就复用、没有就按约定建、分支在本地不存在时**不要**凭空空造一条。
 *
 *   node --experimental-strip-types bridge/tests/worktrees-unit.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseWorktreeList, findCheckout, ensureCheckout, checkoutPathFor } = await import("../src/worktrees.ts");

function check(name, fn) {
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.then(
        () => console.log("ok   " + name),
        (err) => {
          console.error("FAIL " + name + "\n     " + (err?.message ?? err));
          process.exitCode = 1;
        },
      );
    }
    console.log("ok   " + name);
  } catch (err) {
    console.error("FAIL " + name + "\n     " + (err?.message ?? err));
    process.exitCode = 1;
  }
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// ------------------------------------------------------------------ 解析

check("porcelain：主检出、worktree、detached 三种都认", () => {
  const text = [
    "worktree /repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /repo-wt/feat/x",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feat/x",
    "",
    "worktree /repo-detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(text), [
    { path: "/repo", branch: "main" },
    { path: "/repo-wt/feat/x", branch: "feat/x" },
    { path: "/repo-detached", branch: "" },
  ]);
});

check("porcelain：末尾没有空行也收得下最后一条", () => {
  assert.deepEqual(parseWorktreeList("worktree /a\nbranch refs/heads/main"), [{ path: "/a", branch: "main" }]);
});

// ------------------------------------------------------------------ 真仓库

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-wt-"));
const repo = path.join(root, "widgets");
fs.mkdirSync(repo);
git(repo, ["init", "-q", "-b", "main"]);
git(repo, ["config", "user.email", "t@example.com"]);
git(repo, ["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-qm", "init"]);
git(repo, ["branch", "feat/one"]);

await check("findCheckout：还没建就是空串", () => {
  assert.equal(findCheckout(repo, "feat/one"), "");
});

await check("checkoutPathFor：按 AGENTS 的约定放在 ../<主仓名>-wt/<分支>", () => {
  // 比 realpath：macOS 的 /var 是 /private/var 的软链，git 报的是后者。
  assert.equal(checkoutPathFor(repo, "feat/one"), path.join(fs.realpathSync(root), "widgets-wt", "feat/one"));
});

let made = "";
await check("ensureCheckout：没有就建一份（建在约定位置，主检出不动）", () => {
  const out = ensureCheckout(repo, "feat/one");
  made = out.path;
  assert.equal(out.created, true);
  assert.equal(out.path, path.join(fs.realpathSync(root), "widgets-wt", "feat/one"));
  assert.equal(git(out.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/one");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main", "主检出还在 main 上");
});

await check("ensureCheckout：第二次直接复用同一个目录", () => {
  const out = ensureCheckout(repo, "feat/one");
  assert.equal(out.created, false);
  assert.equal(out.path, made);
});

await check("ensureCheckout：本地没有这条分支时说清楚，不凭空造", () => {
  assert.throws(() => ensureCheckout(repo, "feat/nope"), /拉不下来|fetch/);
});

await check("listCheckouts：非 git 目录说明白", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-wt-plain-"));
  assert.throws(() => findCheckout(plain, "main"), /不是 git 仓库/);
});

console.log(process.exitCode ? "\n有失败" : "\n全部通过");
