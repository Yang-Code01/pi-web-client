/**
 * 「自动评审眼里的一个 PR」：合并闸门要用的那几格。
 *
 * 走 REST 的 `/repos/<owner/name>/pulls/<n>` + `checksOf` —— 与右栏 PR 详情**同一条通道、
 * 同一个口径**（checks 按 head sha 取 check-runs 与 commit status）。别改成 `pullRequestInfo`：
 * 那份是列表卡用的，结构里没有 `checks` / `mergeable` / `merged`，读出来恒 `undefined`，
 * 会让「CI 没过」与「已经合了」都静默判反。
 *
 * 为什么单独成一个模块：这里最容易错的是**输入口径**。调用方手上拿的是仓库的**目录**
 * （`effectiveReviewDir()` / `config.repo` 都是 `gitRoot()`），而 GitHub REST 要的是
 * `owner/name`。两件事混成同一个 `repo` 参数时，拼出来的路径是
 * `/repos//Users/…/pulls/7`，GitHub 回 404；以前外面那层 `catch { return null }` 把它吞成
 * 「读不到 PR」，页面只好猜「gh 没登录这个仓库」。目录 → slug 的转换放在这里，并由
 * `bridge/tests/autopr-unit.mjs` 断言真实请求路径。
 */
import { checksOf, githubRest } from "./github.ts";
import type { AutoCheck } from "./reviewauto.ts";

export interface AutoPrView {
  headRefName: string;
  state: string;
  merged: boolean;
  /** `null` = GitHub 还在算（第一次问常常是 null），不是「不能合」。 */
  mergeable: boolean | null;
  checks: AutoCheck[];
  checksTruncated: boolean;
}

export interface AutoPrQuery {
  /**
   * 仓库**目录**（不是 `owner/name`）。认的是这个目录的 origin 远端：
   * 会话可能开在子目录、钉了别的仓库时就换一份检出，两种都由调用方先把根算好。
   */
  dir: string;
  pr: number;
  /** 会话那个账号的令牌；`null` = 匿名请求（私有仓库会 404）。 */
  token: string | null;
  /** 测试缝：默认打 `api.github.com`。 */
  apiBase?: string;
}

/**
 * 读一个 PR 的判定字段。读不到会**抛**（`GithubError`，带 `code` / `status`）——
 * 要不要把它变成一句人话，由调用方决定；这里不吞。
 */
export async function readAutoPr(opts: AutoPrQuery): Promise<AutoPrView> {
  const ctx = { upstreamApi: opts.apiBase };
  const raw = await githubRest(ctx, opts.token, `/repos/${opts.dir}/pulls/${opts.pr}`);
  const headSha = String(raw?.head?.sha ?? "");
  const found = headSha ? await checksOf(ctx, opts.token, opts.dir, headSha) : { checks: [], truncated: false };
  return {
    headRefName: String(raw?.head?.ref ?? ""),
    state: String(raw?.state ?? ""),
    merged: raw?.merged === true,
    mergeable: raw?.mergeable === null || raw?.mergeable === undefined ? null : raw?.mergeable === true,
    checks: found.checks,
    checksTruncated: found.truncated,
  };
}
