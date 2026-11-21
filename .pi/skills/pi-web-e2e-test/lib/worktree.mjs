import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function gitRun(dir, args, options = {}) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout == null ? 60000 : options.timeout,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw new Error(`git 执行失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败（退出码 ${result.status}）\n${String(result.stderr || "").trim()}`
    );
  }
  return String(result.stdout || "").trim();
}

export function mainRoot(dir) {
  const common = gitRun(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.dirname(common);
}

export function resolveCommit(dir, ref) {
  return gitRun(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function shortHead(dir) {
  return gitRun(dir, ["rev-parse", "--short", "HEAD"]);
}

export function currentBranch(dir) {
  try {
    return gitRun(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return "";
  }
}

export function isDirty(dir) {
  return gitRun(dir, ["status", "--porcelain"]).length > 0;
}

export function mergeBase(dir, base = "main") {
  const errors = [];
  for (const candidate of [base, `origin/${base}`]) {
    try {
      return gitRun(dir, ["merge-base", "HEAD", candidate]);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(
    `算不出与 ${base} 的 merge-base。请确认本地有 ${base} / origin/${base}，或用 --before <ref> 指定。\n${errors.join("\n")}`
  );
}

export function gitInfo(dir) {
  const head = resolveCommit(dir, "HEAD");
  return {
    dir,
    branch: currentBranch(dir),
    head: head.slice(0, 9),
    headFull: head,
    dirty: isDirty(dir)
  };
}

function linkDeps(main, worktree) {
  const linked = [];
  for (const rel of ["node_modules", "web/node_modules", "bridge/node_modules", "peer/node_modules"]) {
    const target = path.join(main, rel);
    const link = path.join(worktree, rel);
    if (!fs.existsSync(target)) continue;
    if (fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "junction");
    linked.push({ rel, target, link });
  }
  return linked;
}

/**
 * Create a detached worktree at the before ref, with dependencies junctioned
 * back to the main checkout (the before build is otherwise very slow).
 */
export function createBeforeWorktree(options) {
  const repoDir = path.resolve(options.repoDir);
  const main = mainRoot(repoDir);
  const runId = options.runId;
  if (!/^[a-zA-Z0-9._-]+$/.test(runId || "")) {
    throw new Error(`非法的 runId：${runId}`);
  }
  const parent = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, `e2e-${runId}-before`);
  if (fs.existsSync(dir)) {
    throw new Error(`before worktree 已存在：${dir}`);
  }
  const ref = resolveCommit(main, options.ref);
  gitRun(main, ["worktree", "add", "--detach", dir, ref], { timeout: 120000 });
  let linked = [];
  try {
    linked = linkDeps(main, dir);
  } catch (error) {
    // Don't leave a half-created worktree behind.
    const cleanup = spawnSync(
      process.execPath,
      [path.join(main, "tools", "worktree-remove.mjs"), dir, "--force"],
      { encoding: "utf8", windowsHide: true }
    );
    if (cleanup.status !== 0) {
      const detail = String(cleanup.stderr || cleanup.stdout || cleanup.error?.message || "").trim().slice(0, 1000);
      throw new Error(`${error.message}
清理半成品 worktree 失败（退出码 ${cleanup.status ?? "?"}）：${detail}`);
    }
    throw error;
  }
  return { dir, main, ref, linked };
}

export function assertBeforeWorktree(dir, main) {
  const resolved = path.resolve(dir);
  const expectedParent = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  const base = path.basename(resolved);
  if (path.dirname(resolved) !== path.resolve(expectedParent) || !/^e2e-.+-before$/.test(base)) {
    throw new Error(`拒绝删除不是本技能创建的 before worktree：${resolved}`);
  }
}

/** Remove through the junction-safe project script; never plain `git worktree remove`. */
export function removeBeforeWorktree(options) {
  const dir = path.resolve(options.dir);
  const main = options.main ? path.resolve(options.main) : mainRoot(dir);
  assertBeforeWorktree(dir, main);
  const script = path.join(main, "tools", "worktree-remove.mjs");
  if (!fs.existsSync(script)) {
    throw new Error(`找不到 junction 安全的删除脚本：${script}`);
  }
  const result = spawnSync(process.execPath, [script, dir, "--force"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000
  });
  gitRun(main, ["worktree", "prune"], { timeout: 60000 });
  return {
    dir,
    status: result.status == null ? -1 : result.status,
    output: `${String(result.stdout || "")}${String(result.stderr || "")}`.trim(),
    removed: !fs.existsSync(dir)
  };
}
