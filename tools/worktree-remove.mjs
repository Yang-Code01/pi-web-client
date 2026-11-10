#!/usr/bin/env node
/**
 * 安全删除一个 worktree：先拆掉指向它外面的链接（Windows junction / 符号链接），再 `git worktree remove`。
 *
 *   node tools/worktree-remove.mjs <worktree 目录> [--force] [--dry-run]
 *
 * 为什么要有它：worktree 里常把 `node_modules` 用 junction 连回主检出省一次安装。`git worktree remove`
 * 删目录时会顺着 junction 进去，把**主检出**的 `node_modules` 一起删掉（2026-11 实际发生过，bridge
 * 依赖被删到只剩 7 个包）。先只拆链接本身、不碰链接指向的内容，再交给 git，就不会越界。
 *
 * 适用条件：任何平台都能跑；没有链接时等于直接 `git worktree remove`。
 * - 只拆**目标在 worktree 外面**的链接；worktree 内部互指的链接留给 git 正常处理。
 * - 不进入真实的 node_modules 目录找链接（那是 worktree 自己装的依赖，删了无妨）。
 * - 不传 `--force` 时，worktree 有未提交改动 git 会拒绝，脚本照原样报错退出，不替你强删。
 * - 删完核对一遍被拆链接原来指向的目录还在；不在就报 `TARGET MISSING` 并以 2 退出。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const dirArg = args.find((a) => !a.startsWith("--"));
if (!dirArg) {
  console.error("用法: node tools/worktree-remove.mjs <worktree 目录> [--force] [--dry-run]");
  process.exit(64);
}

const wt = path.resolve(dirArg);
if (!fs.existsSync(wt)) {
  console.error(`不存在: ${wt}`);
  process.exit(1);
}

// 必须是登记过的 worktree，而且不能是主检出（主检出删不得）。
const list = execFileSync("git", ["-C", wt, "worktree", "list", "--porcelain"], { encoding: "utf8" });
const trees = list.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => path.resolve(l.slice(9)));
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (!trees.some((t) => same(t, wt))) {
  console.error(`不是登记过的 worktree: ${wt}`);
  process.exit(1);
}
if (same(trees[0], wt)) {
  console.error(`这是主检出，拒绝删除: ${wt}`);
  process.exit(1);
}

const inside = (p) => {
  const rel = path.relative(wt, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** 走一遍目录树，收集指向 worktree 外面的链接；不跟进链接，也不进 .git 和真实 node_modules。 */
function findOutboundLinks(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      // Node 把 Windows junction 也报成 symbolic link；readlink 拿到目标。
      let target;
      try {
        target = path.resolve(path.dirname(p), fs.readlinkSync(p));
      } catch {
        continue;
      }
      if (!inside(target)) out.push({ link: p, target });
      continue;
    }
    if (st.isDirectory() && ent.name !== ".git" && ent.name !== "node_modules") findOutboundLinks(p, out);
  }
  return out;
}

const links = findOutboundLinks(wt);
for (const { link, target } of links) {
  console.log(`${dryRun ? "将拆" : "拆链接"} ${link} -> ${target}`);
  if (!dryRun) fs.unlinkSync(link); // 只删链接本身，不碰目标
}

if (dryRun) {
  console.log(`dry-run：共 ${links.length} 个外链；未执行 git worktree remove`);
  process.exit(0);
}

try {
  execFileSync("git", ["-C", trees[0], "worktree", "remove", ...(force ? ["--force"] : []), wt], { stdio: "inherit" });
} catch {
  console.error("git worktree remove 失败（外链已拆，主检出不受影响）；看上面 git 的报错，确认后可加 --force 重跑");
  process.exit(1);
}
execFileSync("git", ["-C", trees[0], "worktree", "prune"]);

let missing = 0;
for (const { target } of links) {
  if (!fs.existsSync(target)) {
    console.error(`TARGET MISSING ${target}`);
    missing++;
  }
}
console.log(`已删除 ${wt}；拆了 ${links.length} 个外链，目标全部完好: ${missing === 0}`);
process.exit(missing ? 2 : 0);
