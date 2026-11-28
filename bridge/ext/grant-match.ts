/**
 * 自动评审的**限时授权**（D450 第 5 条）—— 闸门侧的那一份。
 *
 * 自动循环要推分支、要让会话合并 PR，而 `approval-gate` 把这两件事都拦成审批卡，于是
 * 「无人值守」与那道闸天然打架。解法是把「人已经在设置 dialog 里点过的那一次」写进会话的
 * allow 文件（`allow:<id>.json` 的 `auto` 字段，闸门每次工具调用都会重读），并且收得极窄：
 *
 *   - 只对**这一次运行**有效：结束 / 暂停→停止 / 你按停，脑立刻删掉；另有 6 小时硬上限；
 *   - 合并只放行**一个** PR（`gh pr merge <n>`、`gh api …/pulls/<n>/merge`）；
 *   - 推送只放行**一条分支**，不许强推、不许 `--all` / `--mirror` / `--tags` / `--delete`。
 *
 * 这个文件**零依赖**（只用 node 内建）：它在 pi 子进程里以 `.ts` 直接加载，和闸门同一个
 * 加载路径，所以不能 import `../src/*`。判定逻辑是纯函数，`bridge/tests/reviewgrant-unit.mjs`
 * 直接打它；写盘那一半在 `bridge/src/reviewgrant.ts`。
 */
import fs from "node:fs";
import path from "node:path";

/** 运行期授权。落盘在会话 allow 文件的 `auto` 字段里。 */
export interface AutoGrant {
  /** 允许推的分支名（不带 `refs/heads/`）。 */
  branch: string;
  /** 允许合并的 PR 号（0 = 不授权合并）。 */
  pr: number;
  /** 评审仓库根（校验 `gh -R owner/name` 用）。 */
  repo: string;
  /** 毫秒时间戳：过期即失效（防「跑完了忘了收」）。 */
  expiresAt: number;
}

/** 一次运行最长授权多久：轮数上限 10 轮，每轮最坏几分钟，6 小时上限够宽。 */
export const GRANT_TTL_MS = 6 * 60 * 60 * 1000;

const COMPOUND = /[;&|`<>\r\n]|\$\(/;
const PUSH = /^\s*git\s+push\b/;
const PR_MERGE = /^\s*gh\s+(?:-R\s+\S+\s+)?pr\s+merge\b/;
const API_MERGE = /^\s*gh\s+api\b[^\n]*\/pulls\/(\d+)\/merge\b/;
const FORCE = /(^|\s)(--force(-with-lease)?|-f)\b/;
const BROAD = /(^|\s)(--all|--mirror|--tags|--follow-tags|--delete|-d)\b/;

/**
 * 当前分支（读 `.git/HEAD`，不 spawn git：闸门在每次工具调用里都会问一遍）。
 * worktree 的 `.git` 是一个文件（`gitdir: …`），跟着它进去读；detached HEAD 一律返回空串。
 */
export function currentBranch(cwd: string): string {
  const dir = path.resolve(cwd);
  const dotgit = path.join(dir, ".git");
  let target = dotgit;
  try {
    const st = fs.statSync(dotgit);
    if (st.isFile()) {
      const text = fs.readFileSync(dotgit, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (!m) return "";
      target = path.resolve(dir, m[1].trim());
    }
  } catch {
    return "";
  }
  try {
    const head = fs.readFileSync(path.join(target, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1].trim() : "";
  } catch {
    return "";
  }
}

/** `git push` / `git push origin` / `git push -u origin feat/x` / `git push origin HEAD:feat/x` */
function pushTargets(cmd: string): { ok: boolean; branches: string[] } {
  const rest = cmd.replace(PUSH, "").trim();
  if (FORCE.test(rest)) return { ok: false, branches: [] };
  if (BROAD.test(rest)) return { ok: false, branches: [] };
  const tokens = rest.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  // 第一个非选项 token 是远端；之后的都是 refspec
  const branches: string[] = [];
  for (const s of tokens.slice(1)) {
    // `+refspec` 就是强推（`git push origin +feat/x`）
    if (s.startsWith("+")) return { ok: false, branches: [] };
    const rhs = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
    const name = rhs.replace(/^refs\/heads\//, "");
    if (!name || name === "HEAD") continue;
    branches.push(name);
  }
  return { ok: true, branches };
}

/** `gh pr merge 12` / `gh -R owner/name pr merge 12 --merge` / `gh api -X PUT …/pulls/12/merge` */
function mergeTarget(cmd: string): { pr: number; repo: string } {
  const api = API_MERGE.exec(cmd);
  if (api) return { pr: Number(api[1]) || 0, repo: "" };
  if (!PR_MERGE.test(cmd)) return { pr: 0, repo: "" };
  const repo = /(?:^|\s)-R\s+(\S+)/.exec(cmd)?.[1] ?? "";
  const after = cmd.replace(PR_MERGE, "").split(/\s+/).filter(Boolean);
  const num = after.find((t) => /^\d+$/.test(t)) ?? "";
  return { pr: Number(num) || 0, repo };
}

/**
 * 这次授权能不能放过这条命令。`head` 是当前分支（闸门用 `currentBranch(cwd)` 算好传进来）。
 *
 * 只认**单条**命令：带 `&&` / `|` / 重定向的一律不放过 —— 前面那截被授权，不代表后面那截也是。
 */
export function grantAllows(grant: AutoGrant | null, cmd: string, head: string, now = Date.now()): boolean {
  if (!grant) return false;
  if (!grant.expiresAt || grant.expiresAt <= now) return false;
  const text = String(cmd ?? "")
    .replace(/\\\r?\n/g, " ")
    // 只吞掉「不启动第二条命令」的两种尾巴：`2>&1` 与 `2>/dev/null`。`| tee` / `&&` / `;`
    // 一律保留，交给下面的 COMPOUND 拒掉 —— 前面那截被授权，不代表后面那截也是。
    .replace(/\s*2?>&1\b/g, "")
    .replace(/\s*2>\s*\/dev\/null\b/g, "")
    .trim();
  if (!text || COMPOUND.test(text)) return false;

  if (PUSH.test(text)) {
    if (!grant.branch) return false;
    const target = pushTargets(text);
    if (!target.ok) return false;
    if (target.branches.some((b) => b !== grant.branch)) return false;
    // 没有 refspec（`git push` / `git push origin`）= 推当前分支：当前分支必须就是授权的那条。
    if (!target.branches.length && head !== grant.branch) return false;
    return true;
  }

  if (!grant.pr) return false;
  const merge = mergeTarget(text);
  if (!merge.pr || merge.pr !== grant.pr) return false;
  if (merge.repo) {
    // `-R owner/name` 与评审仓库对不上就不认（别的同名仓库里也有 12 号 PR）
    const name = grant.repo.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    if (name && merge.repo !== name && !merge.repo.endsWith(`/${name}`)) return false;
  }
  return true;
}
