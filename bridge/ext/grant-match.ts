/**
 * 自动评审的**限时授权**（D457 第 5 条）—— 闸门侧的那一份。
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
  /** 评审仓库根（本地路径：合并前要求进程 cwd 落在它里面）。 */
  repo: string;
  /**
   * 评审仓库的 `owner/name`（从 origin 认，认不出是空串）。
   * 命令里显式带了别的仓库（`-R owner/name` 或 `…/repos/owner/name/…`）时**必须**逐字对上；
   * 认不出（空串）时显式指了指别的仓库就**一律拒**（fail closed，别拿同名仓库当自己）。
   */
  slug: string;
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
// `--prune` 会删掉远端「本地已经没有」的分支 —— 与 `--delete` 同一类，不能放过。
const BROAD = /(^|\s)(--all|--mirror|--tags|--follow-tags|--delete|--prune|-d)\b/;

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
    // 空源 refspec（`:feat/x`）在 git 里是**删远端分支**，不是推 —— 与 `--delete` 同类，拒。
    if (s.startsWith(":")) return { ok: false, branches: [] };
    const hasColon = s.includes(":");
    const rhs = hasColon ? s.slice(s.indexOf(":") + 1) : s;
    if (hasColon && !rhs) return { ok: false, branches: [] }; // `feat/x:` 推去空目标名，也不认
    const name = rhs.replace(/^refs\/heads\//, "");
    if (!name) continue;
    if (name === "HEAD") {
      // 没有 refspec 的 `git push origin HEAD`：推的就是当前分支，交给传进来的 `head` 去对。
      // 写了 refspec 却把目标写成 `HEAD`（`main:HEAD`）就不认了 —— 说不清远端那只 `HEAD`
      // 会更新成哪条分支，也就没法确认它落在授权的那一条上。
      if (!hasColon) continue;
      return { ok: false, branches: [] };
    }
    branches.push(name);
  }
  return { ok: true, branches };
}

/** 认不出仓库时用的哨兵：`grantAllows` 见到它一律拒（宁可拒，也别退回「按 cwd 算」）。 */
const UNKNOWN_REPO = "\u0000?";

/** 会吃掉后一个 token 的选项：它们的值不是 PR 号，也不是仓库。 */
const VALUE_FLAGS = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit"]);

/**
 * 命令里显式写出来的仓库：`-R owner/name`、`--repo owner/name`、`--repo=owner/name`、`-Rowner/name`。
 *
 * **长选项也要认**：`gh pr merge 12 --repo other/x` 以前把 repo 读成空串、退回「按 cwd 算」，
 * 于是「显式点名必须逐字对上」那道闸被绕过 —— 借这张授权去合别的仓库里的同号 PR。
 */
function explicitRepo(cmd: string): string {
  const m =
    /(?:^|\s)(?:-R|--repo)(?:=|\s+)(\S+)/.exec(cmd) ??
    /(?:^|\s)(?:-R|--repo)(\S+)/.exec(cmd);
  if (!m) return "";
  return m[1].trim();
}

/**
 * `gh pr merge 12` / `gh -R owner/name pr merge 12 --merge` / `gh api -X PUT repos/o/r/pulls/12/merge`
 *
 * `repo` 是命令里**显式写出来的**仓库（没写就是空串 = 按 cwd 那个仓库算）。
 */
function mergeTarget(cmd: string): { pr: number; repo: string } {
  const api = API_MERGE.exec(cmd);
  if (api) {
    // 路径里的 `repos/<owner>/<name>/pulls/<n>/merge`：不认的话，别人的同名 PR 也能借这张授权合。
    // 认不出路径形状时给一个永远匹配不上的 sentinel（宁可拒，也别退回「按 cwd 算」）。
    const path = /(?:^|[\s/])repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/merge\b/i.exec(cmd);
    return { pr: Number(api[1]) || 0, repo: path ? `${path[1]}/${path[2]}` : UNKNOWN_REPO };
  }
  if (!PR_MERGE.test(cmd)) return { pr: 0, repo: "" };
  const repo = explicitRepo(cmd);
  // 写了 `-R` / `--repo` 却没给值（`gh pr merge 12 --repo`）：当「认不出的仓库」，别退回 cwd。
  if (/(?:^|\s)(?:-R|--repo)\s*$/.test(cmd)) return { pr: 0, repo: UNKNOWN_REPO };
  const after = cmd.replace(PR_MERGE, "").split(/\s+/).filter(Boolean);
  // 跳掉选项的值再找 PR 号：`--match-head-commit 34 12` 里的 34 不是 PR 号
  // （以前取第一个纯数字，取到的是它 → 号对不上就拒，方向安全但会把合法命令挡掉）。
  let num = "";
  for (let i = 0; i < after.length; i++) {
    const token = after[i];
    if (VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (/^\d+$/.test(token)) {
      num = token;
      break;
    }
  }
  return { pr: Number(num) || 0, repo };
}

/** cwd 落在授权仓库里（含子目录：`gh` / `git` 都是从 cwd 往上找那个仓库）。 */
function insideRepo(cwd: string, repo: string): boolean {
  if (!cwd || !repo) return false;
  const rel = path.relative(path.resolve(repo), path.resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 这次授权能不能放过这条命令。
 *
 * `cmd` 必须是**完整**命令（闸门里别把给用户看的那份 900 字截断拿来判：截断点之后藏一条
 * `; rm -rf` 就白给了）。`ctx.head` 是当前分支、`ctx.cwd` 是工具调用的工作目录。
 *
 * 只认**单条**命令：带 `&&` / `|` / 重定向的一律不放过 —— 前面那截被授权，不代表后面那截也是。
 */
export function grantAllows(
  grant: AutoGrant | null,
  cmd: string,
  ctx: { head?: string; cwd?: string },
  now = Date.now(),
): boolean {
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

  const head = ctx.head ?? "";

  if (PUSH.test(text)) {
    if (!grant.branch) return false;
    const target = pushTargets(text);
    if (!target.ok) return false;
    if (target.branches.some((b) => b !== grant.branch)) return false;
    // 没有 refspec（`git push` / `git push origin`）= 推当前分支：当前分支必须就是授权的那条。
    if (!target.branches.length && head !== grant.branch) return false;
    // cwd 必须还在这个仓库里：同一条分支名在别的检出里也能存在。
    return insideRepo(ctx.cwd ?? "", grant.repo);
  }

  if (!grant.pr) return false;
  const merge = mergeTarget(text);
  if (!merge.pr || merge.pr !== grant.pr) return false;
  if (merge.repo) {
    // 显式点了名：必须与这张授权认出来的 `owner/name` **逐字**相同（`other/pi-web-client`
    // 也是别的仓库，同号 PR 合进去就是合错东西）；认不出自己是谁时一律拒，别放宽。
    const want = (grant.slug || "").trim().toLowerCase();
    if (!want || merge.repo.trim().toLowerCase() !== want) return false;
    return true;
  }
  // 没点名 = 按 cwd 那个仓库算：cwd 必须还落在授权的仓库里（别处 `cd` 过去合同名号）。
  return insideRepo(ctx.cwd ?? "", grant.repo);
}
