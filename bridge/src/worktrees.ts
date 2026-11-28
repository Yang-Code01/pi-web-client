/**
 * 「这条分支的检出在哪」—— 自动评审的修复轮要在一份**真实的检出**里做（D462 第 16 / 20 条的补记）。
 *
 * 为什么需要它：D462 一开始把 `config.cwd` 当「会话 cwd」，隐含假设「会话就开在被修的那份检出里」。
 * 而本仓库的规矩是所有改动都在 worktree 里做（`AGENTS.md`），于是 agent 把提交落在 worktree、
 * 桥却在会话 cwd（主检出）上找 commit —— 闸门、轮次记账、推送三处一起错位。
 *
 * 这里的口径只有一句话：**要改哪条分支，就在检出了那条分支的目录里改**。已有那个检出就复用
 * （同一个分支不可能有两份检出，`git worktree` 自己也不允许），没有就按 AGENTS 的约定建一个
 * `../<主仓名>-wt/<分支>` —— 绝不碰主检出。
 *
 * 只认 `git worktree list --porcelain` 的输出（纯文本、没有本地化字段），解析单独留成纯函数
 * 给单测打：`bridge/tests/worktrees-unit.mjs`。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface WorktreeEntry {
  /** 检出目录的绝对路径。 */
  path: string;
  /** 检出的是哪条分支；detached（`refs/pi-web/pr-N` 那种）是空串。 */
  branch: string;
}

/** `git worktree list --porcelain` 的一段一段 → 条目。 */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      // 空行 = 一条记录结束（porcelain 就是这么分的）。
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: "" };
      continue;
    }
    if (current && line.startsWith("branch ")) {
      // `branch refs/heads/feat/x` → `feat/x`
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "");
    }
  }
  if (current) out.push(current);
  return out;
}

/** 路径归一：macOS 的 /var → /private/var 这种软链会让「同一个目录」比成两个。 */
function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function git(dir: string, args: string[], timeout = 20_000): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  }).trim();
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** 这个目录所在仓库的全部检出（主检出在前）。跑不动 git 抛 `not_git`。 */
export function listCheckouts(dir: string): WorktreeEntry[] {
  let text = "";
  try {
    text = git(dir, ["worktree", "list", "--porcelain"]);
  } catch {
    fail("not_git", `这个目录不是 git 仓库，没法找检出：${dir}`);
  }
  return parseWorktreeList(text);
}

/** 已经检出了 `branch` 的那个目录；没有返回空串。 */
export function findCheckout(dir: string, branch: string): string {
  const want = String(branch ?? "").trim();
  if (!want) return "";
  const hit = listCheckouts(dir).find((w) => w.branch === want);
  return hit ? realOr(hit.path) : "";
}

/**
 * 主检出的路径：从 `--git-common-dir` 反推（worktree 的 common dir 也指回它）。
 * 认不出就退回传入的目录本身。
 */
function mainCheckoutOf(dir: string): string {
  try {
    const common = git(dir, ["rev-parse", "--git-common-dir"]);
    const abs = path.resolve(dir, common);
    return realOr(path.basename(abs) === ".git" ? path.dirname(abs) : abs);
  } catch {
    return path.resolve(dir);
  }
}

/** 新建检出放哪：与 AGENTS 的约定一致（`../<主仓名>-wt/<分支>`）。 */
export function checkoutPathFor(dir: string, branch: string): string {
  const root = mainCheckoutOf(dir);
  return path.join(path.dirname(root), `${path.basename(root)}-wt`, String(branch ?? "").trim());
}

function hasLocalBranch(dir: string, branch: string): boolean {
  try {
    git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export interface Checkout {
  /** 那条分支的检出目录（绝对路径）。 */
  path: string;
  /** 这次是不是新建的（页面/日志要说清「我建了一份 worktree」）。 */
  created: boolean;
}

/**
 * 保证「检出了 `branch` 的目录」存在：已有就复用，没有就建一份。
 *
 * 建之前先确认分支在本地：`git worktree add` 只认本地 ref，而 PR 的 head 分支不一定在这台机器上
 * 检过（别人推的、或刚 fetch 过没建 ref 的）。拉不到就抛 `branch_missing`，别在本地凭空造一条。
 */
export function ensureCheckout(dir: string, branch: string): Checkout {
  const want = String(branch ?? "").trim();
  if (!want) fail("bad_branch", "没有分支名：不知道该在哪份检出里改");
  const existing = findCheckout(dir, want);
  if (existing) return { path: existing, created: false };

  if (!hasLocalBranch(dir, want)) {
    try {
      git(dir, ["fetch", "origin", `refs/heads/${want}:refs/heads/${want}`], 120_000);
    } catch {
      fail("branch_missing", `本地没有分支 ${want}，也拉不下来：先 \`git fetch origin ${want}\` 再试`);
    }
  }

  const target = checkoutPathFor(dir, want);
  if (fs.existsSync(target)) {
    fail("checkout_busy", `${target} 已经有东西了，但它检出的不是 ${want}；先把它挪走或用 \`git worktree list\` 看看`);
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 建不出来就让 git 报那句更具体的 */
  }
  try {
    git(dir, ["worktree", "add", target, want], 120_000);
  } catch (err) {
    fail("worktree_failed", `建不出 ${want} 的检出（${target}）：${String((err as Error)?.message ?? err).slice(0, 300)}`);
  }
  return { path: realOr(target), created: true };
}
