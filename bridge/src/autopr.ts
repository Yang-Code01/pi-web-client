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
 * `/repos//Users/…/pulls/7`，GitHub 回 404；再被外面那层 `catch { return null }` 吞掉，
 * 就变成了「先确认 gh 登录了这个仓库」——一次口径错误被翻译成一条误导人的建议（#765）。
 * 目录 → slug 的转换放在这里，由 `bridge/tests/autopr-unit.mjs` 断言真实请求路径。
 */
import { checksOf, githubRest } from "./github.ts";
import { localRepoName } from "./gitpr.ts";
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
   * 仓库**目录**（不是 `owner/name`）。slug 从它的 origin 远端认：会话可能开在子目录、
   * 钉了别的仓库时就换一份检出，两种都由调用方先把根算好。
   */
  dir: string;
  pr: number;
  /** 会话那个账号的令牌；`null` = 匿名请求（私有仓库会 404）。 */
  token: string | null;
  /** 测试缝：默认打 `api.github.com`。 */
  apiBase?: string;
}

/**
 * 读一个 PR 的判定字段。
 *
 * 读不到会**抛**（`GithubError` 带 `code` / `status`）：要不要把它变成一句人话由调用方决定，
 * 这里不吞 —— 吞掉一次 404，换来的就是一句猜出来的「gh 没登录」。
 */
export async function readAutoPr(opts: AutoPrQuery): Promise<AutoPrView> {
  // REST 要 `owner/name`，而 `dir` 是目录。这一步以前漏了，别把两件事再合成一个参数。
  const slug = localRepoName(opts.dir);
  if (!slug) {
    throw Object.assign(new Error(`这个目录的 origin 不是 GitHub 仓库，认不出 owner/name：${opts.dir}`), { code: "not_github" });
  }
  const ctx = { upstreamApi: opts.apiBase };
  const raw = await githubRest(ctx, opts.token, `/repos/${slug}/pulls/${opts.pr}`);
  const headSha = String(raw?.head?.sha ?? "");
  const found = headSha ? await checksOf(ctx, opts.token, slug, headSha) : { checks: [], truncated: false };
  return {
    headRefName: String(raw?.head?.ref ?? ""),
    state: String(raw?.state ?? ""),
    merged: raw?.merged === true,
    mergeable: raw?.mergeable === null || raw?.mergeable === undefined ? null : raw?.mergeable === true,
    checks: found.checks,
    checksTruncated: found.truncated,
  };
}

/**
 * 读不到 PR 时给用户的那句话。
 *
 * 以前三个调用方各自拍一句「先确认 gh 登录了这个仓库」/「gh 没登录 / 断网 / 号不对」——
 * 真正的失败却常常是 404（号没权限、仓库私有）或令牌过期，按那句话去查只会白折腾。
 * 把 `code` 翻成人话，并带上「按谁查的」：多账号机器上这一格最关键。
 */
export function autoPrFailure(err: unknown, login: string): string {
  const code = String((err as { code?: unknown })?.code ?? "");
  const who = login ? `按 ${login} 查的` : "当前没有可用的账号";
  if (code === "not-found") return `GitHub 看不到这个 PR（404，${who}）：仓库不归这个号、PR 号不对，或者它已经被删了`;
  if (code === "unauthorized") return `GitHub 不认这个令牌（401，${who}）：重新登录一次 gh`;
  return String((err as { message?: unknown })?.message ?? err);
}
