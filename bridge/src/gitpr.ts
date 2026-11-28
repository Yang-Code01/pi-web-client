/**
 * GitHub PR 的两件事（#651 扩展）：列出 open PR、把某个 PR 的提交取到本地一条 ref。
 *
 * 为什么取下来而不是只拿 `gh pr diff` 的 patch：`ocr delegate preview` 认的是**本地 ref**
 * （它自己跑 `git diff`），拿不到分片就丢掉这次评审最值钱的那一半（确定性分片 + 排除原因）。
 * 取的时候只写 `refs/pi-web/pr-N` 与 `origin/<base>`，**不动工作区、不动当前分支**。
 */
import { execFile, execFileSync } from "node:child_process";
import { ghInvocation, githubRest } from "./github.ts";
import { discoverLocalProxyCandidates, FETCH_PLAN, GH_PLAN, resolveProxyCandidates, viaRoutes, type RoutePlan } from "./netroute.ts";

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  draft: boolean;
  author: string;
}

export interface PrListResult {
  ok: boolean;
  prs: PullRequest[];
  /** `owner/name`（从 origin 的 URL 认出来的，认不出就是空串）——面板拿它比对粘贴进来的链接。 */
  repo: string;
  /** 认不出来的失败才给 message（`gh` 没装 / 没登录 / 没有 remote），面板按 code 说人话。 */
  error: string;
  /**
   * `repo_unseen`：GitHub 已经明确答「这个仓库 / PR 你看不到」—— 不是网络，是这个账号没权限
   * （或仓库改过名）。界面要据此说「换账号」，而不是让用户去查代理。
   */
  code: "" | "gh_missing" | "gh_failed" | "no_remote" | "not_github" | "repo_unseen";
  /** 这一份是谁给的：真 gh，还是没装 gh 时的 REST 兜底（界面据此说「走内置实现」）。 */
  via: "gh" | "rest";
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: PrListResult }>();

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** execFile 的 err.code 有时是字符串（`ENOENT`），统一成数字给 classify 看。 */
function exitCode(err: any): number {
  if (!err) return 0;
  return typeof err.code === "number" ? err.code : 1;
}

function run(cmd: string, args: string[], cwd: string, timeout = 20_000, env: NodeJS.ProcessEnv = process.env): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env },
      (err: any, stdout, stderr) => resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: exitCode(err) }),
    );
  });
}

/**
 * stderr 里真正说明失败的那一行。
 *
 * `git fetch` 的 stderr 开头常是 `remote: Enumerating objects…` / `Counting objects…` 这类
 * 服务端进度 —— 拿首行当原因，用户就看不到后面那句 `error: RPC failed; curl 56 …`。先挑
 * `fatal:` / `error:`（含 `remote: error: …`），一句都没有才退回第一行。
 */
const FAILURE_LINE = /(?:^|\s)(?:fatal|error):/i;
function failureLine(text: string): string {
  const lines = `${text}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => FAILURE_LINE.test(l)) ?? lines[0] ?? "";
}

/**
 * 一次出网命令怎么选路。默认就是产品行为（设置 / 系统 / env 取候选，再不行就现探本机）；
 * 测试用 `proxies` / `discover` 把两条都钉死，不去探本机的系统代理与在听端口 —— 否则测试
 * 结果会跟着机器上装了什么代理跑。
 */
export interface RouteOptions {
  proxies?: () => string[];
  discover?: () => Promise<string[]>;
  plan?: Partial<RoutePlan>;
  /**
   * 额外环境变量（会盖在每条路的 env 上）。评审靠它把**这个会话选的 GitHub 账号**传下去：
   * `GH_TOKEN` 一进子进程，`gh` 与 `git`（`gh auth git-credential`）用的就是同一个账号。
   * 不传就沿用进程自己的环境 —— 也就是 gh 的机器 active 账号。
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * 查 PR 的入参：`login` 只用来把缓存按账号分开（换了账号不能拿上一个账号的 PR 列表），
 * `env` 才是真正决定子进程用哪个令牌的那一份。
 */
export interface PrQueryOptions extends RouteOptions {
  fresh?: boolean;
  login?: string;
  /** 令牌本体：`gh` 没装时 REST 兜底用它。与 `env.GH_TOKEN` 同源（`sessionGhAccount`）。 */
  token?: string | null;
  /** 测试缝：REST 打哪里（默认 api.github.com）。 */
  apiBase?: string;
}

/**
 * 对端已经明确回答了的失败（仓库看不到 / 令牌没权限 / 号不存在）—— 跟走不走代理无关。
 *
 * 这类 stderr 换每条路都一模一样（实测「直连：GraphQL: …；代理 http://…：GraphQL: …」），
 * 一律当成「网络问题」重试只会把 7 秒变成更久、还把用户往错方向推。
 */
const ANSWERED_FAILURE =
  /could not resolve to a (repository|pullrequest|issue)|repository not found|not found \(HTTP 404\)|HTTP 40[13]|Bad credentials|Resource not accessible/i;

/**
 * 要出网的那几条命令（`gh` 问 GitHub、`git fetch` 取 refs）：直连 → 代理候选 → 现探 → 整轮重试。
 *
 * 全失败时把**每一次尝试**的原因拼成 stderr 交给 `classify()`：界面看到的就不再只是第一句
 * `error: RPC failed; … Connection was reset`，而是「直连怎么挂的、每个代理又怎么挂的」，
 * 用户才知道下一步该填代理还是该查网络。
 */
async function routed(
  cmd: string,
  args: string[],
  cwd: string,
  plan: Partial<RoutePlan> = GH_PLAN,
  onLog?: (line: string) => void,
  opts: RouteOptions = {},
): Promise<CmdResult> {
  const extra = opts.env ?? {};
  const res = await viaRoutes<CmdResult>(
    async (env, timeoutMs) => {
      const out = await run(cmd, args, cwd, timeoutMs, { ...env, ...extra });
      if (out.code === 0) return { ok: true, value: out };
      const reason = failureLine(out.stderr) || `${cmd} 退出码 ${out.code}`;
      // 仓库看不到 / 没权限：答案已经拿到了，换代理只会再拿一次同一句话。
      return { ok: false, err: reason, stop: ANSWERED_FAILURE.test(out.stderr) };
    },
    {
      proxies: opts.proxies ?? resolveProxyCandidates,
      discover: opts.discover ?? discoverLocalProxyCandidates,
      plan: { ...plan, ...(opts.plan ?? {}) },
      onLog,
    },
  );
  if (res.ok) return res.value;
  return { stdout: "", stderr: res.reason, code: 1 };
}

/**
 * `gh` 该怎么起：先问 `github.ts` 的 `ghInvocation()` —— 测试缝 `PI_WEB_GH_JS`、以及 PATH
 * 上被别的 gh 抢先的情况都收在那一处，评审不该另走一套解析。解析不出来时它退回裸命令，
 * `classify()` 照旧报 `gh_missing`。
 */
function ghRun(args: string[]): { cmd: string; args: string[] } {
  const { cmd, prefix } = ghInvocation();
  return { cmd, args: [...prefix, ...args] };
}

// ---------------------------------------------------------------------------
// 核对「这个 PR 现在到哪个提交了」（#741 的「有新提交」）
// ---------------------------------------------------------------------------

const TIP_CACHE_MS = 60_000;

/** 面板等着画：5 秒一次、不重试（失败就当「不知道」，下次打开再问）。 */
const TIP_PLAN: RoutePlan = { directMs: 5_000, proxyMs: 5_000, attempts: 1, retryMs: 0, budgetMs: 6_000 };

/** key = 仓库 + 那一批号：不同批各存各的（「只查近 3 条」让 key 天然稳定）。 */
const tipCache = new Map<string, { at: number; value: Record<number, string> }>();

/**
 * 一批 PR 现在各自的 head sha（只问远端，**不写本地 ref**）。
 *
 * 为什么不用 `git fetch`：那会把 `refs/pi-web/pr-N` 挪到新提交上，而旧记录靠它已经说不出
 * 「当时评的是哪个提交」了。`ls-remote` 只读、不下载对象，fork 来的 PR 也认。
 * 失败 / 超时 → 空对象（缺 key = 不知道），不用空串冒充「没变」。
 */
export async function remotePrHeads(dir: string, prs: number[], opts: PrQueryOptions = {}): Promise<Record<number, string>> {
  const wanted = [...new Set(prs.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  if (!wanted.length) return {};
  const key = `${dir}|${wanted.join(",")}`;
  const hit = tipCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TIP_CACHE_MS) return hit.value;
  const args = ["-C", dir, "ls-remote", "origin", ...wanted.map((n) => `refs/pull/${n}/head`)];
  const out = await routed("git", args, dir, TIP_PLAN, undefined, { env: opts.env });
  const value: Record<number, string> = {};
  if (out.code === 0) {
    for (const line of out.stdout.split(/\r?\n/)) {
      const [sha, ref] = line.trim().split(/\s+/);
      const num = Number(/^refs\/pull\/(\d+)\/head$/.exec(ref ?? "")?.[1] ?? 0);
      if (num > 0 && /^[0-9a-f]{7,40}$/i.test(sha ?? "")) value[num] = sha;
    }
  }
  // **只缓存问成功的那次**：网络抖一下就把空结果钉 60 秒的话，用户点刷新（`fresh=false`）
  // 只会再拿到那一份空的 —— 与「失败就当不知道，下次再问」正好相反。
  if (out.code === 0) {
    const now = Date.now();
    // 先清过期条目再说上限：key 是「仓库 + 这一批号」的组合，长期开着会攒成一张大表；
    // 它只是 60 秒的省事缓存，丢了最多多问一次远端。
    if (tipCache.size > 32) {
      for (const [k, v] of tipCache) if (now - v.at >= TIP_CACHE_MS) tipCache.delete(k);
    }
    if (tipCache.size > 64) tipCache.clear();
    tipCache.set(key, { at: now, value });
  }
  return value;
}

/**
 * 上一次问到的远端 head（**只读缓存，不发请求**）：给「先画后补」的第一帧用。
 *
 * 不这么做的话，重开面板 / 切回来的第一帧只有本地那半，已亮着的「有新提交」会先灭一下、
 * 等 `ls-remote` 回来再亮 —— 正是「已显示的内容不许先清空」那条铁律要避免的闪烁。
 * 60 秒内（`TIP_CACHE_MS`）的首帧都能直接带上远端结果，等于没有网络这一跳。
 */
export function cachedPrHeads(dir: string, prs: number[]): Record<number, string> {
  const wanted = [...new Set(prs.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  if (!wanted.length) return {};
  const hit = tipCache.get(`${dir}|${wanted.join(",")}`);
  return hit && Date.now() - hit.at < TIP_CACHE_MS ? hit.value : {};
}

function classify(stderr: string, cmd: string, code: number | null): { code: PrListResult["code"]; error: string } {
  const text = `${stderr}`.trim();
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (code === 127 || /ENOENT|not found|is not recognized/i.test(text)) return { code: "gh_missing", error: first };
  if (/not a git repository/i.test(text)) return { code: "no_remote", error: first };
  if (/no remotes?/i.test(text) || /does not have any remotes/i.test(text)) return { code: "no_remote", error: first };
  if (/not a github/i.test(text) || /No GitHub/i.test(text)) return { code: "not_github", error: first };
  // 对端答「这个仓库/PR 我看不到」：不是网络，是这个账号没权限（或仓库改过名）。
  if (ANSWERED_FAILURE.test(text)) return { code: "repo_unseen", error: first };
  return { code: "gh_failed", error: first || `${cmd} 退出码 ${code}` };
}

// ---------------------------------------------------------------------------
// REST 兜底：没装 gh 时评审仍能跑（D428）
// ---------------------------------------------------------------------------

/**
 * REST 失败 → 面板认识的那几个 code（`gh_missing` 不会从这里出来）。
 * 注意看的是 `GithubError.status`，不是 HTTP 状态：`requestRaw` 把 403 + rate-limit
 * 改写成了 429，所以「403」在这里是权限不够（缺 scope / SAML 没授权），语义同 repo_unseen。
 */
function restFailure(err: any): { code: PrListResult["code"]; error: string } {
  const status = Number(err?.status) || 0;
  const message = String(err?.message ?? err ?? "").trim() || `GitHub 回了 ${status || "?"}`;
  // 401/403/404 都是「这个令牌看不到这个东西」：与 gh 那侧的 repo_unseen 同一个语义。
  if (status === 401 || status === 403 || status === 404) return { code: "repo_unseen", error: message };
  return { code: "gh_failed", error: message };
}

async function restGet(opts: PrQueryOptions, apiPath: string): Promise<any> {
  return githubRest(opts.apiBase ? { upstreamApi: opts.apiBase } : {}, opts.token ?? null, apiPath);
}

/** 草稿杆后面：它们多数还没准备好，但也不是不能评。 */
function sortPulls(prs: PullRequest[]): PullRequest[] {
  return prs.sort((a, b) => Number(a.draft) - Number(b.draft) || b.number - a.number);
}

async function restList(repo: string, opts: PrQueryOptions): Promise<PrListResult> {
  try {
    const rows = await restGet(opts, `/repos/${repo}/pulls?state=open&per_page=30&sort=created&direction=desc`);
    const prs = sortPulls(
      (Array.isArray(rows) ? rows : [])
        .map((r: any) => ({
          number: Number(r?.number) || 0,
          title: String(r?.title ?? ""),
          headRefName: String(r?.head?.ref ?? ""),
          baseRefName: String(r?.base?.ref ?? ""),
          draft: Boolean(r?.draft),
          author: String(r?.user?.login ?? ""),
        }))
        .filter((r) => r.number > 0),
    );
    return { ok: true, prs, repo, error: "", code: "", via: "rest" };
  } catch (err: any) {
    const why = restFailure(err);
    return { ok: false, prs: [], repo, error: why.error, code: why.code, via: "rest" };
  }
}

/** PR 的标题与两条 ref：`gh pr view --json …` 那一步的替身。 */
async function restPullMeta(dir: string, number: number, opts: PrQueryOptions): Promise<{ title: string; baseRefName: string; headRefName: string }> {
  const repo = localRepoName(dir);
  if (!repo) throw Object.assign(new Error("这个仓库没有 GitHub 远端"), { code: "not_github" as const });
  try {
    const raw = await restGet(opts, `/repos/${repo}/pulls/${number}`);
    return { title: String(raw?.title ?? ""), baseRefName: String(raw?.base?.ref ?? ""), headRefName: String(raw?.head?.ref ?? "") };
  } catch (err: any) {
    const why = restFailure(err);
    throw Object.assign(new Error(why.error), { code: why.code });
  }
}

/** `git@github.com:o/r.git` / `https://github.com/o/r(.git)` → `o/r`。 */
export function repoFromRemote(url: string): string {
  const text = (url ?? "").trim();
  const scp = /^[^@]+@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/i.exec(text);
  if (scp) return `${scp[1]}/${scp[2].replace(/\.git$/i, "")}`.toLowerCase();
  const http = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(text);
  if (http) return `${http[1]}/${http[2].replace(/\.git$/i, "")}`.toLowerCase();
  return "";
}

/**
 * 本地仓库名（`owner/repo`，从 origin 认）。认不出（没远端 / 不是 GitHub / 没装 git）给空串。
 * 写成同步：评审**开始之前**就要拿它把别仓的号拒掉，没道理为一次比对跑一轮 await。
 */
export function localRepoName(dir: string): string {
  try {
    const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return out ? repoFromRemote(out) : "";
  } catch {
    return "";
  }
}

/** 打开过 PR 列表的仓库记住一分钟：切页签、重画面板都不该再打一次 `gh`。 */
export async function listPullRequests(dir: string, opts: PrQueryOptions = {}): Promise<PrListResult> {
  // 缓存按「仓库 + 账号」分：同一个工作区换了账号，看到的就是另一批 PR。
  const cacheKey = `${dir}|${opts.login ?? ""}`;
  const hit = cache.get(cacheKey);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const remote = await run("git", ["-C", dir, "remote", "get-url", "origin"], dir, 8000);
  if (remote.code !== 0 || !remote.stdout.trim()) {
    const value: PrListResult = { ok: false, prs: [], repo: "", error: "这个仓库没有 origin 远程", code: "no_remote", via: "gh" };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  const repoName = repoFromRemote(remote.stdout);
  const gh = ghRun(["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName,isDraft,author"]);
  const out = await routed(gh.cmd, gh.args, dir, GH_PLAN, undefined, opts);
  if (out.code !== 0) {
    const why = classify(out.stderr, "gh pr list", out.code);
    // 没装 gh（或壳解析不到）→ 走 REST：评审不该因为「不想装一个 CLI」就整块用不了。
    if (why.code === "gh_missing") {
      const value = await restList(repoName, opts);
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    const value: PrListResult = { ok: false, prs: [], repo: repoName, error: why.error, code: why.code, via: "gh" };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  let rows: any[] = [];
  try {
    rows = JSON.parse(out.stdout || "[]");
  } catch {
    const value: PrListResult = { ok: false, prs: [], repo: repoName, error: "读不懂 gh 的输出", code: "gh_failed", via: "gh" };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  const prs: PullRequest[] = sortPulls(
    rows
      .map((r) => ({
        number: Number(r?.number) || 0,
        title: String(r?.title ?? ""),
        headRefName: String(r?.headRefName ?? ""),
        baseRefName: String(r?.baseRefName ?? ""),
        draft: Boolean(r?.isDraft),
        author: String(r?.author?.login ?? ""),
      }))
      .filter((r) => r.number > 0),
  );
  const value: PrListResult = { ok: true, prs, repo: repoName, error: "", code: "", via: "gh" };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export interface ResolvedPr {
  pr: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  /** `origin/<base>` —— 对照侧（fetch 过，是新的）。 */
  from: string;
  /** `refs/pi-web/pr-N` —— 被评的那条提交。 */
  to: string;
}

/**
 * 把 PR 的 head 取到 `refs/pi-web/pr-N` 上（评审最先倒下的那一步）。
 *
 * 先前这里只有一条直连：直连被重置就整次评审失败，界面只看到 git 的 stderr 首行。现在走
 * `routed()`（直连 → 代理候选 → 整轮重试），失败时把每一条路的原因都带出来。
 */
export async function fetchPullRequestRef(dir: string, number: number, onLog?: (line: string) => void, opts: RouteOptions = {}): Promise<string> {
  const to = `refs/pi-web/pr-${number}`;
  onLog?.(`git fetch origin refs/pull/${number}/head → ${to}`);
  const head = await routed("git", ["-C", dir, "fetch", "origin", `refs/pull/${number}/head:${to}`, "--no-tags", "--force"], dir, FETCH_PLAN, onLog, opts);
  if (head.code !== 0) {
    // 走到这里的 stderr 已经是「每一次尝试」的汇总（直连：…；代理 http://…：…），原样给人看。
    throw Object.assign(new Error(`取不到 PR #${number} 的提交：${head.stderr}`), { code: "pr_fetch_failed" });
  }
  return to;
}

/**
 * 取一个 PR：先把 base 分支与 `refs/pull/N/head` 都 fetch 下来，再返回两侧 ref。
 *
 * `refs/pull/N/head` 对 fork 来的 PR 同样存在，所以不需要知道 fork 的仓库地址。
 */
export async function resolvePullRequest(
  dir: string,
  number: number,
  onLog?: (line: string) => void,
  opts: PrQueryOptions = {},
): Promise<ResolvedPr> {
  if (!Number.isFinite(number) || number <= 0) throw Object.assign(new Error("PR 号不对"), { code: "pr_invalid" });
  // `opts.env`（会话选的那个账号的 GH_TOKEN）要跟着每一条出网命令走：`gh pr view`、两处 `git fetch`。
  const gh = ghRun(["pr", "view", String(number), "--json", "number,title,baseRefName,headRefName"]);
  const view = await routed(gh.cmd, gh.args, dir, GH_PLAN, onLog, opts);
  let meta: { title: string; baseRefName: string; headRefName: string } = { title: "", baseRefName: "", headRefName: "" };
  if (view.code !== 0) {
    const why = classify(view.stderr, `gh pr view ${number}`, view.code);
    // 没装 gh：标题与两条 ref 改从 REST 拿，后面的 `git fetch` 完全不变。
    if (why.code === "gh_missing") meta = await restPullMeta(dir, number, opts);
    else throw Object.assign(new Error(why.error || `读不到 PR #${number}`), { code: why.code || "gh_failed" });
  } else {
    let raw: any = {};
    try {
      raw = JSON.parse(view.stdout || "{}");
    } catch {
      throw Object.assign(new Error(`读不懂 PR #${number} 的信息`), { code: "gh_failed" });
    }
    meta = { title: String(raw?.title ?? ""), baseRefName: String(raw?.baseRefName ?? ""), headRefName: String(raw?.headRefName ?? "") };
  }
  const base = String(meta.baseRefName ?? "").trim();
  if (!base) throw Object.assign(new Error(`PR #${number} 没说对照分支`), { code: "gh_failed" });
  const to = await fetchPullRequestRef(dir, number, onLog, opts);
  onLog?.(`git fetch origin ${base}`);
  const baseFetch = await routed("git", ["-C", dir, "fetch", "origin", base, "--no-tags"], dir, { ...FETCH_PLAN, attempts: 1 }, onLog, opts);
  // base 已经在本地的仓库（常见）不该因为一次 fetch 失败就整票挂掉。
  if (baseFetch.code !== 0) onLog?.(`对照分支 fetch 失败，用本地的一版：${classify(baseFetch.stderr, "git fetch", baseFetch.code).error}`);
  return {
    pr: number,
    title: String(meta?.title ?? ""),
    headRefName: String(meta?.headRefName ?? ""),
    baseRefName: base,
    from: `origin/${base}`,
    to,
  };
}

/** 测试里要能清掉缓存。 */
export function resetPrCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// PR 详情（点「已选 #N」那扇窗）
// ---------------------------------------------------------------------------

export interface PrFileInfo {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface PrCommitInfo {
  oid: string;
  headline: string;
  date: string;
  author: string;
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  files: PrFileInfo[];
  /** 文件太多时只列了前 N 个。 */
  filesMore: number;
  commits: PrCommitInfo[];
  commitsMore: number;
}

export interface PrInfoResult {
  ok: boolean;
  info: PrInfo | null;
  error: string;
  code: PrListResult["code"];
  /** 同上：真 gh 还是 REST 兜底。 */
  via: "gh" | "rest";
}

const infoCache = new Map<string, { at: number; value: PrInfoResult }>();
const FILE_CAP = 100;
const COMMIT_CAP = 50;

/** REST 的 `status` 与 gh 的 `changeType` 对照：只有 removed/deleted 叫法不同。 */
function restChangeType(status: string): string {
  const s = status.toLowerCase();
  return s === "removed" ? "deleted" : s;
}

/** `gh pr view --json …`（含 files / commits 三块）的替身。 */
async function restInfo(dir: string, number: number, opts: PrQueryOptions): Promise<PrInfoResult> {
  const repo = localRepoName(dir);
  if (!repo) {
    return { ok: false, info: null, error: "这个仓库没有 GitHub 远端", code: "not_github", via: "rest" };
  }
  try {
    const [raw, filesRaw, commitsRaw] = await Promise.all([
      restGet(opts, `/repos/${repo}/pulls/${number}`),
      restGet(opts, `/repos/${repo}/pulls/${number}/files?per_page=${FILE_CAP}`),
      restGet(opts, `/repos/${repo}/pulls/${number}/commits?per_page=${COMMIT_CAP}`),
    ]);
    const files = (Array.isArray(filesRaw) ? filesRaw : []).slice(0, FILE_CAP);
    const commits = (Array.isArray(commitsRaw) ? commitsRaw : []).slice(0, COMMIT_CAP);
    const changedFiles = Number(raw?.changed_files) || files.length;
    const info: PrInfo = {
      number: Number(raw?.number) || number,
      title: String(raw?.title ?? ""),
      body: String(raw?.body ?? "").slice(0, 20_000),
      state: String(raw?.state ?? ""),
      draft: Boolean(raw?.draft),
      url: String(raw?.html_url ?? ""),
      author: String(raw?.user?.login ?? ""),
      createdAt: String(raw?.created_at ?? ""),
      updatedAt: String(raw?.updated_at ?? ""),
      additions: Number(raw?.additions) || 0,
      deletions: Number(raw?.deletions) || 0,
      changedFiles,
      headRefName: String(raw?.head?.ref ?? ""),
      baseRefName: String(raw?.base?.ref ?? ""),
      files: files.map((f: any) => ({
        path: String(f?.filename ?? ""),
        additions: Number(f?.additions) || 0,
        deletions: Number(f?.deletions) || 0,
        changeType: restChangeType(String(f?.status ?? "")),
      })),
      filesMore: Math.max(0, changedFiles - files.length),
      commits: commits.map((c: any) => ({
        oid: String(c?.sha ?? ""),
        headline: String(c?.commit?.message ?? "").split(/\r?\n/)[0] ?? "",
        date: String(c?.commit?.author?.date ?? ""),
        author: String(c?.author?.login ?? c?.commit?.author?.name ?? ""),
      })),
      commitsMore: Math.max(0, (Number(raw?.commits) || commits.length) - commits.length),
    };
    return { ok: true, info, error: "", code: "", via: "rest" };
  } catch (err: any) {
    const why = restFailure(err);
    return { ok: false, info: null, error: why.error, code: why.code, via: "rest" };
  }
}

export async function pullRequestInfo(dir: string, number: number, opts: PrQueryOptions = {}): Promise<PrInfoResult> {
  const key = `${dir}|${number}|${opts.login ?? ""}`;
  const hit = infoCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (!Number.isFinite(number) || number <= 0) {
    return { ok: false, info: null, error: "PR 号不对", code: "gh_failed", via: "gh" };
  }
  const gh = ghRun([
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,body,state,isDraft,url,author,createdAt,updatedAt,additions,deletions,changedFiles,baseRefName,headRefName,commits,files",
  ]);
  const out = await routed(gh.cmd, gh.args, dir, GH_PLAN, undefined, opts);
  if (out.code !== 0) {
    const why = classify(out.stderr, `gh pr view ${number}`, out.code);
    if (why.code === "gh_missing") {
      const value = await restInfo(dir, number, opts);
      infoCache.set(key, { at: Date.now(), value });
      return value;
    }
    const value: PrInfoResult = { ok: false, info: null, error: why.error || `读不到 PR #${number}`, code: why.code, via: "gh" };
    infoCache.set(key, { at: Date.now(), value });
    return value;
  }
  let raw: any = null;
  try {
    raw = JSON.parse(out.stdout || "null");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") {
    const value: PrInfoResult = { ok: false, info: null, error: "读不懂 gh 的输出", code: "gh_failed", via: "gh" };
    infoCache.set(key, { at: Date.now(), value });
    return value;
  }
  const files = Array.isArray(raw.files) ? raw.files : [];
  const commits = Array.isArray(raw.commits) ? raw.commits : [];
  const info: PrInfo = {
    number: Number(raw.number) || number,
    title: String(raw.title ?? ""),
    body: String(raw.body ?? "").slice(0, 20_000),
    state: String(raw.state ?? ""),
    draft: Boolean(raw.isDraft),
    url: String(raw.url ?? ""),
    author: String(raw.author?.login ?? ""),
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    additions: Number(raw.additions) || 0,
    deletions: Number(raw.deletions) || 0,
    changedFiles: Number(raw.changedFiles) || files.length,
    headRefName: String(raw.headRefName ?? ""),
    baseRefName: String(raw.baseRefName ?? ""),
    files: files.slice(0, FILE_CAP).map((f: any) => ({
      path: String(f?.path ?? ""),
      additions: Number(f?.additions) || 0,
      deletions: Number(f?.deletions) || 0,
      changeType: String(f?.changeType ?? ""),
    })),
    filesMore: Math.max(0, files.length - FILE_CAP),
    commits: commits.slice(0, COMMIT_CAP).map((c: any) => ({
      oid: String(c?.oid ?? ""),
      headline: String(c?.messageHeadline ?? ""),
      date: String(c?.committedDate ?? ""),
      author: String(c?.authors?.[0]?.name ?? ""),
    })),
    commitsMore: Math.max(0, commits.length - COMMIT_CAP),
  };
  const value: PrInfoResult = { ok: true, info, error: "", code: "", via: "gh" };
  infoCache.set(key, { at: Date.now(), value });
  return value;
}

export function resetPrInfoCache(): void {
  infoCache.clear();
}
