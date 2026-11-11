import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Q-021: the branch name under the composer. The page cannot start a process, so the only place
 * that can answer "which branch is this" is the bridge. Everything here is read-only: `rev-parse`
 * and `status --porcelain` never write, and `core.fsmonitor=false` keeps a repo's configured
 * fsmonitor hook from being executed on our behalf.
 */

export interface GitInfo {
  /** Repository root as git reports it (`--show-toplevel`, already forward-slashed on Windows). */
  repo: string;
  /** Branch name, or the short SHA when HEAD is detached. Empty only for an unborn HEAD. */
  branch: string;
  /** HEAD is detached: `branch` is a short SHA, not a ref. */
  detached: boolean;
  /** `git init` ran but nothing was committed — there is no HEAD to name yet. */
  empty: boolean;
  /** Lines from `status --porcelain=v1 -uno`: tracked changes + staged; 0 = clean. */
  dirty: number;
}

const run = promisify(execFile);

/** git is slow enough on Windows (30-80ms per call) that a 1s poll cannot just re-run it. */
const TTL_MS = 5000;
const cache = new Map<string, { at: number; info: GitInfo | null }>();

/** One `git` invocation. `null` on any failure — including git not being installed at all. */
async function git(dir: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "-c", "core.fsmonitor=false", ...args], {
      timeout: opts.timeout ?? 4000,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

async function probe(dir: string): Promise<GitInfo | null> {
  // Doubles as the "is this a repository" test: outside a work tree this fails with exit 128.
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;

  const abbrev = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch = abbrev ?? "";
  let detached = false;
  let empty = false;
  if (abbrev === null) {
    // `git init` with no commit: rev-parse HEAD is ambiguous, the repo still exists.
    empty = true;
  } else if (branch === "HEAD") {
    const short = await git(dir, ["rev-parse", "--short", "HEAD"]);
    if (short) {
      branch = short;
      detached = true;
    } else {
      branch = "";
      empty = true;
    }
  }

  // -uno skips untracked scanning (an order of magnitude on big repos); --no-optional-locks keeps
  // us from taking index.lock while the user's own git is running in a terminal.
  const porcelain = await git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-uno"]);
  const dirty = porcelain ? porcelain.split("\n").filter((line) => line.trim() !== "").length : 0;

  return { repo: top.replace(/\\/g, "/"), branch, detached, empty, dirty };
}

/**
 * Project root of whatever repository contains `dir`, with worktrees folded onto the main repo (#72/#94).
 *
 * `--git-common-dir` is `<root>/.git` for an ordinary clone *and* for every worktree of it, so taking
 * its parent turns 主仓 + 五份 worktree into one 工作区 — that is the whole point. `separate-git-dir`
 * and bare repos have no `<root>/.git` shape, so the common dir itself is the best answer there.
 *
 * `null` when `dir` is not inside a repository, does not exist, or git is not installed: the caller
 * falls back to the directory itself, which is exactly what a non-git project deserves.
 */
export async function gitRoot(dir: string): Promise<string | null> {
  if (!dir) return null;
  const common = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  const abs = path.resolve(dir, common);
  return (path.basename(abs) === ".git" ? path.dirname(abs) : abs).replace(/\\/g, "/");
}

/**
 * D234: 写操作改了仓库之后，5s TTL 里的旧分支/dirty 数不能继续骗状态行。
 * 清掉这个 dir 的 gitInfo 条目与它名下所有 (base,n) 的历史条目；下一次读会重新 probe。
 * 定义在 historyCache 之前没关系：调用发生在写操作返回时，那时模块早已初始化完。
 */
export function invalidateGitCache(dir: string): void {
  const key = path.resolve(dir);
  cache.delete(key);
  // 写操作可能在 `dir` 子目录上跑，历史缓存的键是仓库根：两个方向都清一遍。
  for (const k of [...cache.keys(), ...historyCache.keys()]) {
    const root = k.includes("|") ? k.slice(0, k.indexOf("|")) : k;
    if (root === key || key.startsWith(`${root}${path.sep}`) || root.startsWith(`${key}${path.sep}`)) {
      cache.delete(k);
      historyCache.delete(k);
    }
  }
}

/**
 * Branch (or detached SHA) of the repository containing `dir`, or `null` when it is not in one.
 * Cached for TTL_MS per absolute path; `fresh` bypasses the cache (window focus, 一轮结束).
 */
export async function gitInfo(dir: string, fresh = false): Promise<GitInfo | null> {
  if (!dir) return null;
  const key = path.resolve(dir);
  const hit = cache.get(key);
  const now = Date.now();
  if (!fresh && hit && now - hit.at < TTL_MS) return hit.info;
  let info: GitInfo | null = null;
  try {
    info = await probe(key);
  } catch {
    info = null;
  }
  cache.set(key, { at: now, info });
  if (cache.size > 200) {
    // Bound the map: only the last few directories matter, and this runs on every 切会话.
    for (const [k, v] of cache) if (now - v.at > TTL_MS * 12) cache.delete(k);
  }
  return info;
}

/* ---------------------------------------------------------------- 分支历史弹窗 */

/**
 * 两列对照要的那一小块 git：HEAD 领先/落后对照分支多少、从哪儿分叉、两边各最近 N 条提交。
 * 全部只读；不 fetch、不 checkout。`set` 是把每行归到「你独有 / 对面独有 / 两边都有」，
 * 页面据此决定淡显还是描边 —— 界面不自己算集合，免得两边算法漂。
 */
export interface GitCommit {
  /** 短 hash（7 位，git 自己的缩写）。 */
  h: string;
  /** 提交标题（第一行）。 */
  s: string;
  /** 作者名。 */
  an: string;
  /** 作者时间，ms epoch。 */
  at: number;
  merge: boolean;
  set: "left" | "right" | "common";
}

export interface GitHistory {
  repo: string;
  /** 分支名；detached 时是短 hash。 */
  head: string;
  detached: boolean;
  /** 对照用的 ref（`origin/main` 这种短名）。 */
  base: string;
  /** true = base 来自 `origin/HEAD`，不是用户选的。 */
  baseAuto: boolean;
  /** 远程分支（新的在前），给下拉用。 */
  branches: { name: string; at: number }[];
  ahead: number;
  behind: number;
  mergeBase: { h: string; at: number; s: string } | null;
  left: GitCommit[];
  right: GitCommit[];
  /** 每边是否还有更多（总提交数 > 取回的条数）。 */
  more: { left: boolean; right: boolean };
  /** FETCH_HEAD 的 mtime（ms）：remote-tracking ref 最后一次更新的时间；0 = 不知道。 */
  fetchedAt: number;
}

/** 找不到仓库 / 没有提交 / 指定的对照分支不存在：给路由翻成 `code`，别让它变成 500。 */
export class GitHistoryError extends Error {
  constructor(
    readonly code: "not_repo" | "empty" | "base_unknown",
    message: string,
  ) {
    super(message);
  }
}

const HISTORY_TTL_MS = 5000;
const historyCache = new Map<string, { at: number; value: GitHistory | null }>();
const FIELD = "\x1f";

/**
 * History for the branch sheet. Cached per (dir, base, n) for the same 5s as `gitInfo`: opening the
 * sheet twice in a row should not re-run eight git processes.
 */
export async function gitHistory(dir: string, opts: { base?: string; n?: number; fresh?: boolean } = {}): Promise<GitHistory | null> {
  const base = (opts.base ?? "").trim() || null;
  const n = Math.min(300, Math.max(10, Math.round(opts.n ?? 80)));
  const historyKey = path.resolve(dir);
  const key = `${historyKey}|${base ?? ""}|${n}`;
  const hit = historyCache.get(key);
  const now = Date.now();
  if (!opts.fresh && hit && now - hit.at < HISTORY_TTL_MS) return hit.value;
  let value: GitHistory | null = null;
  try {
    value = await readHistory(historyKey, base, n);
  } catch (err) {
    if (err instanceof GitHistoryError) throw err;
    value = null;
  }
  historyCache.set(key, { at: now, value });
  if (historyCache.size > 60) for (const [k, v] of historyCache) if (now - v.at > HISTORY_TTL_MS * 12) historyCache.delete(k);
  return value;
}

/** 一行一条，字段用 \x1f 隔开；标题里不会有换行，所以按行切就够。 */
function parseLog(out: string | null): { full: string; h: string; an: string; at: number; merge: boolean; s: string }[] {
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.split(FIELD))
    .filter((f) => f.length >= 6 && f[0])
    .map(([full, h, an, at, parents, ...rest]) => ({
      full,
      h,
      an,
      at: Number(at) * 1000,
      merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
      s: rest.join(FIELD),
    }));
}

async function readHistory(dir: string, asked: string | null, n: number): Promise<GitHistory | null> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const repo = top.replace(/\\/g, "/");

  const hasHead = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!hasHead) throw new GitHistoryError("empty", "仓库里还没有提交");

  const abbrev = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detached = abbrev === "HEAD";
  const head = detached ? ((await git(dir, ["rev-parse", "--short", "HEAD"])) ?? "") : (abbrev ?? "");

  // 注意：`for-each-ref --format` 不认 `%x1f`（那是 pretty format 的写法），会原样吐出来。refname 里
  // 不允许空格，所以空格是安全的分隔符。
  const branchRows = await git(dir, ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "--sort=-committerdate", "refs/remotes"]);
  const branches = (branchRows ?? "")
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([name]) => name && !name.endsWith("/HEAD"))
    .map(([name, at]) => ({ name, at: Number(at) * 1000 }));

  let base = asked;
  let baseAuto = false;
  if (base && !(await git(dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]))) {
    throw new GitHistoryError("base_unknown", `找不到对照分支 ${base}`);
  }
  if (!base) {
    baseAuto = true;
    const sym = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (sym) base = sym;
    else if (await git(dir, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"])) base = "origin/main";
    else base = branches[0]?.name ?? "";
    if (!base) throw new GitHistoryError("base_unknown", "这个仓库没有远程分支可以对照");
  }

  const counts = ((await git(dir, ["rev-list", "--left-right", "--count", `HEAD...${base}`])) ?? "0\t0").split(/\s+/).map(Number);
  const ahead = counts[0] || 0;
  const behind = counts[1] || 0;

  const mb = await git(dir, ["merge-base", "HEAD", base]);
  let mergeBase: GitHistory["mergeBase"] = null;
  if (mb) {
    const row = (await git(dir, ["show", "-s", "--format=%h%x1f%at%x1f%s", mb]))?.split(FIELD) ?? [];
    if (row.length >= 3) mergeBase = { h: row[0], at: Number(row[1]) * 1000, s: row.slice(2).join(FIELD) };
  }

  // 两侧「独有」集合：只取到 n 条够用 —— 更深的行页面还没显示。
  const set = async (args: string[]): Promise<Set<string>> =>
    new Set(((await git(dir, args)) ?? "").split("\n").filter(Boolean));
  const onlyLeft = await set(["rev-list", "-n", String(n), "HEAD", `^${base}`]);
  const onlyRight = await set(["rev-list", "-n", String(n), base, `^HEAD`]);

  const format = `%H${FIELD}%h${FIELD}%an${FIELD}%at${FIELD}%p${FIELD}%s`;
  const [leftOut, rightOut] = await Promise.all([
    git(dir, ["log", "-n", String(n), `--format=${format}`, "HEAD"], { timeout: 8000 }),
    git(dir, ["log", "-n", String(n), `--format=${format}`, base], { timeout: 8000 }),
  ]);
  const tag = (row: { full: string }): GitCommit["set"] => {
    if (onlyLeft.has(row.full)) return "left";
    if (onlyRight.has(row.full)) return "right";
    return "common";
  };
  const shape = (rows: ReturnType<typeof parseLog>): GitCommit[] =>
    rows.map(({ h, s, an, at, merge, full }) => ({ h, s, an, at, merge, set: tag({ full }) }));
  const left = shape(parseLog(leftOut));
  const right = shape(parseLog(rightOut));

  const [leftTotal, rightTotal] = await Promise.all([
    git(dir, ["rev-list", "--count", "HEAD"]),
    git(dir, ["rev-list", "--count", base]),
  ]);

  return {
    repo,
    head,
    detached,
    base,
    baseAuto,
    branches,
    ahead,
    behind,
    mergeBase,
    left,
    right,
    more: { left: Number(leftTotal ?? 0) > left.length, right: Number(rightTotal ?? 0) > right.length },
    fetchedAt: await fetchHeadAt(dir),
  };
}

/** `.git/FETCH_HEAD` 的 mtime —— 只用来告诉用户「数据来自几分钟前」，读不到就是 0。 */
async function fetchHeadAt(dir: string): Promise<number> {
  // 用 --git-path 而不是 --git-common-dir：链接 worktree 的 FETCH_HEAD 在自己的 git-dir 里，
  // 读 common-dir 会读到主检出那份的时间（本机踩过：刚 fetch 完还显示「5 分钟前」）。
  const p = await git(dir, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (!p) return 0;
  try {
    const { statSync } = await import("node:fs");
    return Math.round(statSync(path.resolve(dir, p)).mtimeMs);
  } catch {
    return 0;
  }
}

export interface GitFetchResult {
  at: number;
  remote: string;
}

/**
 * `⟳ Fetch origin`：唯一一个会出网的 git 调用。非交互三件套（TERMINAL_PROMPT / ASKPASS / credential
 * .interactive）缺一不可 —— 没有它们，缺凭据的仓库会挂在等下一个人输密码，而桥在等它退出。
 */
export async function gitFetch(dir: string, timeout = 45_000): Promise<GitFetchResult> {
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new GitHistoryError("not_repo", "这个目录不在 git 仓库里");
  const remotes = ((await git(dir, ["remote"])) ?? "").split("\n").filter(Boolean);
  if (!remotes.length) throw new GitHistoryError("base_unknown", "这个仓库没有配置远程");
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  try {
    await run("git", ["-C", dir, "-c", "core.fsmonitor=false", "-c", "credential.interactive=never", "fetch", "--prune", "--no-tags", remote], {
      timeout,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" },
    });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "").trim();
    const line = stderr.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).slice(-1)[0] ?? "";
    throw Object.assign(new Error(line || "git fetch 失败"), { code: "fetch_failed" });
  }
  return { at: Date.now(), remote };
}
