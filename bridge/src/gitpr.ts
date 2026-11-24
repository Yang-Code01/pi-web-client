/**
 * GitHub PR 的两件事（#651 扩展）：列出 open PR、把某个 PR 的提交取到本地一条 ref。
 *
 * 为什么取下来而不是只拿 `gh pr diff` 的 patch：`ocr delegate preview` 认的是**本地 ref**
 * （它自己跑 `git diff`），拿不到分片就丢掉这次评审最值钱的那一半（确定性分片 + 排除原因）。
 * 取的时候只写 `refs/pi-web/pr-N` 与 `origin/<base>`，**不动工作区、不动当前分支**。
 */
import { execFile } from "node:child_process";

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
  code: "" | "gh_missing" | "gh_failed" | "no_remote" | "not_github";
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: PrListResult }>();

function run(cmd: string, args: string[], cwd: string, timeout = 20_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err: any, stdout, stderr) => resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }),
    );
  });
}

/** `gh` 在 Windows 上是 `gh.exe`，POSIX 直接 PATH —— 两种平台都能直接 execFile。 */
function ghBin(): string {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

function classify(stderr: string, cmd: string, code: number | null): { code: PrListResult["code"]; error: string } {
  const text = `${stderr}`.trim();
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (code === 127 || /ENOENT|not found|is not recognized/i.test(text)) return { code: "gh_missing", error: first };
  if (/not a git repository/i.test(text)) return { code: "no_remote", error: first };
  if (/no remotes?/i.test(text) || /does not have any remotes/i.test(text)) return { code: "no_remote", error: first };
  if (/not a github/i.test(text) || /No GitHub/i.test(text)) return { code: "not_github", error: first };
  return { code: "gh_failed", error: first || `${cmd} 退出码 ${code}` };
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

/** 打开过 PR 列表的仓库记住一分钟：切页签、重画面板都不该再打一次 `gh`。 */
export async function listPullRequests(dir: string, opts: { fresh?: boolean } = {}): Promise<PrListResult> {
  const hit = cache.get(dir);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const remote = await run("git", ["-C", dir, "remote", "get-url", "origin"], dir, 8000);
  if (remote.code !== 0 || !remote.stdout.trim()) {
    const value: PrListResult = { ok: false, prs: [], repo: "", error: "这个仓库没有 origin 远程", code: "no_remote" };
    cache.set(dir, { at: Date.now(), value });
    return value;
  }
  const repoName = repoFromRemote(remote.stdout);
  const out = await run(
    ghBin(),
    ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName,isDraft,author"],
    dir,
  );
  if (out.code !== 0) {
    const why = classify(out.stderr, "gh pr list", out.code);
    const value: PrListResult = { ok: false, prs: [], repo: repoName, error: why.error, code: why.code };
    cache.set(dir, { at: Date.now(), value });
    return value;
  }
  let rows: any[] = [];
  try {
    rows = JSON.parse(out.stdout || "[]");
  } catch {
    const value: PrListResult = { ok: false, prs: [], repo: repoName, error: "读不懂 gh 的输出", code: "gh_failed" };
    cache.set(dir, { at: Date.now(), value });
    return value;
  }
  const prs: PullRequest[] = rows
    .map((r) => ({
      number: Number(r?.number) || 0,
      title: String(r?.title ?? ""),
      headRefName: String(r?.headRefName ?? ""),
      baseRefName: String(r?.baseRefName ?? ""),
      draft: Boolean(r?.isDraft),
      author: String(r?.author?.login ?? ""),
    }))
    .filter((r) => r.number > 0)
    // 草稿排后面：它们多数还没准备好，但也不是不能评。
    .sort((a, b) => Number(a.draft) - Number(b.draft) || b.number - a.number);
  const value: PrListResult = { ok: true, prs, repo: repoName, error: "", code: "" };
  cache.set(dir, { at: Date.now(), value });
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
 * 取一个 PR：先把 base 分支与 `refs/pull/N/head` 都 fetch 下来，再返回两侧 ref。
 *
 * `refs/pull/N/head` 对 fork 来的 PR 同样存在，所以不需要知道 fork 的仓库地址。
 */
export async function resolvePullRequest(dir: string, number: number, onLog?: (line: string) => void): Promise<ResolvedPr> {
  if (!Number.isFinite(number) || number <= 0) throw Object.assign(new Error("PR 号不对"), { code: "pr_invalid" });
  const view = await run(ghBin(), ["pr", "view", String(number), "--json", "number,title,baseRefName,headRefName"], dir, 25_000);
  if (view.code !== 0) {
    const why = classify(view.stderr, `gh pr view ${number}`, view.code);
    throw Object.assign(new Error(why.error || `读不到 PR #${number}`), { code: why.code || "gh_failed" });
  }
  let meta: any = {};
  try {
    meta = JSON.parse(view.stdout || "{}");
  } catch {
    throw Object.assign(new Error(`读不懂 PR #${number} 的信息`), { code: "gh_failed" });
  }
  const base = String(meta?.baseRefName ?? "").trim();
  if (!base) throw Object.assign(new Error(`PR #${number} 没说对照分支`), { code: "gh_failed" });
  const to = `refs/pi-web/pr-${number}`;
  onLog?.(`git fetch origin refs/pull/${number}/head → ${to}`);
  const head = await run("git", ["-C", dir, "fetch", "origin", `refs/pull/${number}/head:${to}`, "--no-tags", "--force"], dir, 120_000);
  if (head.code !== 0) {
    const why = classify(head.stderr, "git fetch", head.code);
    throw Object.assign(new Error(why.error || `取不到 PR #${number}`), { code: "pr_fetch_failed" });
  }
  onLog?.(`git fetch origin ${base}`);
  const baseFetch = await run("git", ["-C", dir, "fetch", "origin", base, "--no-tags"], dir, 120_000);
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
}

const infoCache = new Map<string, { at: number; value: PrInfoResult }>();
const FILE_CAP = 100;
const COMMIT_CAP = 50;

export async function pullRequestInfo(dir: string, number: number, opts: { fresh?: boolean } = {}): Promise<PrInfoResult> {
  const key = `${dir}|${number}`;
  const hit = infoCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (!Number.isFinite(number) || number <= 0) {
    return { ok: false, info: null, error: "PR 号不对", code: "gh_failed" };
  }
  const out = await run(
    ghBin(),
    [
      "pr",
      "view",
      String(number),
      "--json",
      "number,title,body,state,isDraft,url,author,createdAt,updatedAt,additions,deletions,changedFiles,baseRefName,headRefName,commits,files",
    ],
    dir,
    30_000,
  );
  if (out.code !== 0) {
    const why = classify(out.stderr, `gh pr view ${number}`, out.code);
    const value: PrInfoResult = { ok: false, info: null, error: why.error || `读不到 PR #${number}`, code: why.code };
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
    const value: PrInfoResult = { ok: false, info: null, error: "读不懂 gh 的输出", code: "gh_failed" };
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
  const value: PrInfoResult = { ok: true, info, error: "", code: "" };
  infoCache.set(key, { at: Date.now(), value });
  return value;
}

export function resetPrInfoCache(): void {
  infoCache.clear();
}
