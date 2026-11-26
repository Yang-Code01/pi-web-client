/**
 * GitHub 通道（#661）：一个「兼容 `gh` 与 GitHub API」的模块。
 *
 * 三层，各管一件事：
 *  1. 壳（`bridge/src/github-shim.ts`，由 `githubBinDir()` 写出的 `gh` / `gh.cmd` 起）——AI 照旧敲
 *     `gh …`，壳先问桥「这个会话是谁」（`/api/github/shim/identity`），拿到令牌再 `exec` 真 gh；
 *     没装 gh 时壳自己用 REST 实现 PR 核心，最后把这次调用回报给桥。
 *  2. 这个文件 —— 账号、凭据、REST、路由。**凭据只在这里**：页面只见掩码，壳一次一取（不把令牌
 *     留在 pi 子进程的 env 里，否则一次 `printenv` 就把它打进聊天记录）。
 *  3. 页面 —— 右栏面板（`web/src/github-panel.ts`）与链接卡。
 *
 * 账号解析顺序（第一条命中就停）：会话临时选定 → 工作区 `.pi/settings.json` 的 `githubAccount` →
 * 全局 settings.json 的 `githubAccount` → `gh auth status` 的 active。
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { readSecret, writeSecret } from "./dpapi.ts";
import { agentDir, readJson, statePath, writeJson } from "./paths.ts";

const API = "https://api.github.com";
/** `gh auth status` / `gh auth token` 都是进程派生，结果各缓存一阵，别每次调用都付一次冷启动。 */
const STATUS_TTL_MS = 30_000;
const TOKEN_TTL_MS = 10 * 60_000;
const REPO_TTL_MS = 60_000;
/**
 * 两张以请求参数为键的缓存的上限。键来自**请求**（隧道访客、历史消息里几十个不同的 PR），
 * 只靠 TTL 不管大小的话，长时间跑的桥会慢慢吃内存。
 */
const CACHE_MAX = 200;
const FETCH_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 10_000;

/** 塞进有上限的缓存：超过上限丢最早进去的那个（Map 保持插入序，等于 FIFO）。 */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

export interface GithubCtx {
  /** 公网隧道进来的请求：读照常，写（存 PAT、换账号）403。 */
  publicReq: boolean;
  /** 推一帧给页面（`index.ts` 的 `broadcast`）。 */
  send: (frame: Record<string, unknown>) => void;
  /** 由 loopback token 反查会话（`SessionsManager.byLoopbackToken`）。 */
  byLoopbackToken: (token: string) => { id: string; cwd: string } | null;
  /**
   * 按会话 id 取**这个会话自己的** cwd（`SessionsManager.get`）。有值就以它为准：URL 里的 `cwd`
   * 只是页面/测试带过来的参数，不该成为「指定读哪个目录」的把手（读接口对隧道访客也开着）。
   */
  sessionCwd?: (id: string) => string | null;
  /** 桥内测试缝：出站请求改发这里（假 GitHub 是 `http://127.0.0.1:port`）。生产不传。 */
  upstreamApi?: string;
  /**
   * 桥内测试缝：`undefined` = 按 PATH 找真 gh；`null` = 假装这台机器没装 gh（用来验内置实现）；
   * 字符串 = 就用它。别改成环境变量：pi 子进程那边会把 `PI_WEB_*` 剥掉。
   */
  ghPath?: string | null;
}

export interface GhAccount {
  login: string;
  /** `gh` = 令牌来自 gh 的登录态；`pat` = 用户在本工程里存的一枚 fine-grained PAT。 */
  kind: "gh" | "pat";
  active: boolean;
}

// ---------------------------------------------------------------- 落盘（账号偏好 + PAT）

interface GithubState {
  /** 存过 PAT 的账号（令牌本体在 `<state>/github/pat/<login>.secret`，dpapi 加密）。 */
  pats: Record<string, { addedAt: number }>;
  /** 会话级临时选择：sessionId → login。落盘以后重启还在，代价为零。 */
  session: Record<string, string>;
}

function stateFile(): string {
  return statePath("github", "accounts.json");
}

/** 令牌本体落在 `<state>/github/pat/<login>.secret`，走 `dpapi.ts` 那套封装（非 Windows 是明文 + 0600）。 */
function patFile(login: string): string {
  return statePath("github", "pat", `${login.replace(/[^\w.-]/g, "_")}.secret`);
}

function readState(): GithubState {
  const raw = readJson<Partial<GithubState>>(stateFile(), {});
  return {
    pats: raw.pats && typeof raw.pats === "object" ? raw.pats : {},
    session: raw.session && typeof raw.session === "object" ? raw.session : {},
  };
}

function writeState(state: GithubState): void {
  writeJson(stateFile(), state);
}

// ---------------------------------------------------------------- gh 的登录态（异步，绝不 spawnSync）

/** gh 没装 / 没登录 / 正常，三种情况都要能说出来，不能都塌成 null。 */
type StatusRead =
  | { state: "no-gh" }
  | { state: "logged-out"; error: string }
  | { state: "ok"; accounts: { login: string; active: boolean }[] };

let statusCache: { key: string; at: number; value: StatusRead } | null = null;
const tokenCache = new Map<string, { at: number; token: string | null }>();

/** PATH 里找 `gh`，**跳过我们自己的 bin 目录**（否则解析出的是自己的壳，壳再去 exec 它）。 */
function findRealGh(skipDir?: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const skip = skipDir ? path.resolve(skipDir) : "";
  for (const dir of dirs) {
    if (skip && path.resolve(dir) === skip) continue;
    for (const ext of exts) {
      const file = path.join(dir, `gh${ext}`);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/**
 * 真 gh 怎么起：`PI_WEB_GH_JS` 是桥里已有的测试缝（`pishare.ts` 用它顶替 gh），
 * 有它就用 node 跑那个脚本；否则用路径/名字直接 exec。
 */
function ghCommand(gh: string): { cmd: string; prefix: string[] } {
  const js = process.env.PI_WEB_GH_JS;
  if (js) return { cmd: process.execPath, prefix: [js] };
  return { cmd: gh, prefix: [] };
}

export function resolveGhBinary(ctx: Pick<GithubCtx, "ghPath"> = {}): string | null {
  if (ctx.ghPath === null) return null;
  if (typeof ctx.ghPath === "string") return ctx.ghPath;
  if (process.env.PI_WEB_GH_JS) return "fake-gh";
  return findRealGh(githubBinDir());
}

/**
 * 「跑 gh」到底该起什么进程。
 *
 * `resolveGhBinary()` 返回的可以是 `fake-gh` 这种假名字（测试缝 `PI_WEB_GH_JS`），拿它去
 * `execFile` 只会 ENOENT —— 假 gh 得用 `node <脚本>` 跑。评审（`gitpr.ts`）现在也走这个函数，
 * 与面板 / 壳用同一套解析，不用在两处各写一遍。
 */
export function ghInvocation(ctx: Pick<GithubCtx, "ghPath"> = {}): { cmd: string; prefix: string[] } {
  return ghCommand(resolveGhBinary(ctx) ?? (process.platform === "win32" ? "gh.exe" : "gh"));
}

function runGh(gh: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {  const { cmd, prefix } = ghCommand(gh);
  return new Promise((resolve) => {
    execFile(cmd, [...prefix, ...args], { encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * `gh auth status` 没有稳定的 `--json`（新版才有），所以这里解析人读的文本。格式（gh 2.x）：
 * ```
 * github.com
 *   ✓ Logged in to github.com account Yang-Code01 (keyring)
 *   - Active account: true
 * ```
 * 解析不出来就当成「登录态读不到」，不去猜 —— 猜错的代价是把 PR 建到别人名下。
 */
export function parseAuthStatus(text: string): { login: string; active: boolean }[] {
  const out: { login: string; active: boolean }[] = [];
  let current: { login: string; active: boolean } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const login = /Logged in to \S+ account (\S+)/.exec(line);
    if (login) {
      current = { login: login[1], active: false };
      out.push(current);
      continue;
    }
    const active = /Active account:\s*(true|false)/i.exec(line);
    if (active && current) current.active = active[1].toLowerCase() === "true";
  }
  return out;
}

async function ghStatus(gh: string | null): Promise<StatusRead> {
  if (!gh) return { state: "no-gh" };
  if (statusCache && statusCache.key === gh && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const r = await runGh(gh, ["auth", "status"]);
  // gh 在没登录时返回 1，仍然打印「You are not logged into any GitHub hosts」。
  const accounts = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
  const value: StatusRead =
    accounts.length > 0 ? { state: "ok", accounts } : { state: "logged-out", error: (r.stderr || r.stdout).trim() };
  statusCache = { key: gh, at: Date.now(), value };
  return value;
}

/** 重复问同一个账号只派生一次 `gh auth token`（冷的 ~900ms，热的 ~80ms）。 */
async function ghToken(gh: string, login: string): Promise<string | null> {
  const key = `${gh}\u0000${login}`;
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const r = await runGh(gh, ["auth", "token", "--user", login]);
  const token = r.code === 0 ? r.stdout.trim() || null : null;
  tokenCache.set(key, { at: Date.now(), token });
  return token;
}

// ---------------------------------------------------------------- 账号解析

function settingAccount(file: string): string | null {
  const raw = readJson<Record<string, unknown>>(file, {});
  const v = raw.githubAccount;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface AccountPick {
  login: string;
  kind: "gh" | "pat";
  /** 这个账号是怎么选出来的：`session` / `project` / `global` / `active` / `pat-only` / `none`。 */
  source: "session" | "project" | "global" | "active" | "pat-only" | "none";
}

/**
 * 会话该用哪个账号。`cwd` 决定工作区偏好（与 pi 的 settings 一致：项目 `.pi/settings.json` 优先）。
 * 空 login = 一个都没有。
 */
export async function pickAccount(cwd: string, sessionId: string, ctx: Pick<GithubCtx, "ghPath"> = {}): Promise<AccountPick> {
  const gh = resolveGhBinary(ctx);
  const status = await ghStatus(gh);
  const ghLogins = new Set(status.state === "ok" ? status.accounts.map((a) => a.login) : []);
  const pats = readState().pats;
  const known = (login: string): "gh" | "pat" | null => (ghLogins.has(login) ? "gh" : pats[login] ? "pat" : null);

  const state = readState();
  const session = sessionId ? state.session[sessionId] : undefined;
  if (session && known(session)) return { login: session, kind: known(session)!, source: "session" };

  const project = cwd ? settingAccount(path.join(cwd, ".pi", "settings.json")) : null;
  if (project && known(project)) return { login: project, kind: known(project)!, source: "project" };

  const global = settingAccount(path.join(agentDir(), "settings.json"));
  if (global && known(global)) return { login: global, kind: known(global)!, source: "global" };

  if (status.state === "ok") {
    const active = status.accounts.find((a) => a.active) ?? status.accounts[0];
    if (active) return { login: active.login, kind: "gh", source: "active" };
  }
  const patLogin = Object.keys(pats)[0];
  if (patLogin) return { login: patLogin, kind: "pat", source: "pat-only" };
  return { login: "", kind: "pat", source: "none" };
}

/** 令牌本体。只在桥内流转：发给壳一次、给 REST 用一次，页面拿不到。 */
export async function tokenOf(pick: AccountPick, ctx: Pick<GithubCtx, "ghPath"> = {}): Promise<string | null> {
  if (!pick.login) return null;
  if (pick.kind === "pat") {
    try {
      return (await readSecret(patFile(pick.login)))?.secret ?? null;
    } catch {
      return null;
    }
  }
  const gh = resolveGhBinary(ctx);
  return gh ? ghToken(gh, pick.login) : null;
}

export interface SessionGhAccount {
  /** 这个会话该用的登录名（空串 = 一个账号都没有）。 */
  login: string;
  /** 交给子进程的环境（`GH_TOKEN`）；没令牌时不给，子进程就沿用桥自己的环境。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 一个会话该用哪个 GitHub 账号的令牌 —— 给**不经页面**的那些调用方用。
 *
 * GitHub 面板与链接卡走 REST，请求里带着会话，`pickAccount()` 在那里天然拿得到。
 * 评审不一样：它由桥自己 spawn `gh` / `git`（`review.ts` → `gitpr.ts`），子进程里没有会话，
 * 以前就直接用了 gh 的**机器 active 账号**。多账号机器上那经常不是同一个（实测：面板里选的
 * `xyang-qingmin` 能看 `ISID/cas3-onecas-api`，机器 active 的 `Yang-Code01` 看到的是 404，
 * 评审报 `GraphQL: Could not resolve to a Repository…`）。所以把令牌算在这里、注入 `GH_TOKEN`。
 *
 * `GH_TOKEN` 一并给 `git` 用：`gh auth git-credential` 读的就是它，fetch 才会跟 `gh` 同账号。
 */
export async function sessionGhAccount(cwd: string, sessionId: string, ctx: Pick<GithubCtx, "ghPath"> = {}): Promise<SessionGhAccount> {
  const pick = await pickAccount(cwd, sessionId, ctx);
  const token = await tokenOf(pick, ctx);
  return { login: pick.login, env: token ? { GH_TOKEN: token } : undefined };
}

// ---------------------------------------------------------------- 仓库

/** `git@github.com:a/b.git` / `https://github.com/a/b` / `ssh://git@github.com/a/b.git` → `a/b`。 */
export function repoFromRemote(raw: string): string | null {
  const s = raw.trim();
  const ssh = /^git@[\w.-]+:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) return ssh[1];
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (url) return url[1];
  return null;
}

const repoCache = new Map<string, { at: number; repo: string | null }>();

async function repoOf(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  const hit = repoCache.get(cwd);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo;
  const repo = await new Promise<string | null>((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : repoFromRemote(stdout ?? ""));
    });
  });
  remember(repoCache, cwd, { at: Date.now(), repo });
  return repo;
}

// ---------------------------------------------------------------- 从 gh 的输出里认东西

export interface SeenLink {
  kind: "pull" | "issue" | "commit";
  repo: string;
  /** pull / issue 的号；commit 是 sha。 */
  id: string;
  url: string;
}

/** URL 里的路名 → kind（`issues` 要单数化）。与前端 `web/src/github-shared.ts` 的 `LINK_KIND` 是同一张表。 */
const LINK_KIND: Record<string, SeenLink["kind"]> = { pull: "pull", issues: "issue", commit: "commit" };

/** 从一段输出里认出 GitHub 链接。一行里可能有好几个（gh 的表格输出），按出现顺序去重。 */
export function seenLinks(text: string): SeenLink[] {
  const out: SeenLink[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/([\w-]+)/g;
  for (const m of text.matchAll(re)) {
    const [, owner, repo, kind, id] = m;
    const url = `https://github.com/${owner}/${repo}/${kind}/${id}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ kind: LINK_KIND[kind] ?? "commit", repo: `${owner}/${repo}`, id, url });
  }
  return out;
}

// ---------------------------------------------------------------- REST

class GithubError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 一次上游请求的完整结果：解析后的 body + 翻页要用的下一页页码。 */
interface GithubPage {
  body: any;
  /** 下一页的页码（取自响应 `Link` 头里 `rel="next"` 的那一项）；没有就是 null。 */
  nextPage: number | null;
}

async function requestRaw(ctx: GithubCtx, token: string | null, apiPath: string, init: RequestInit = {}): Promise<GithubPage> {
  const base = ctx.upstreamApi ?? API;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "pi-web-client",
    "x-github-api-version": "2022-11-28",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${base}${apiPath}`, { ...init, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err: any) {
    throw new GithubError(
      "network",
      502,
      `连不上 GitHub：${String(err?.message ?? err)}。先确认这台机器能直连（gh api /repos 试一下），要走代理就填 pi 的 httpProxy。`,
    );
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (res.status === 401) throw new GithubError("unauthorized", 401, "GitHub 不认这个令牌：可能已过期或被撤销。");
  if (res.status === 404) throw new GithubError("not-found", 404, String(body?.message ?? "GitHub 上没有这个东西。"));
  if (res.status === 403 && /rate limit/i.test(String(body?.message ?? ""))) {
    throw new GithubError("rate-limit", 429, "匿名请求的额度用完了（60 次/小时）：配一个账号或等一小时。");
  }
  if (!res.ok) throw new GithubError("upstream", res.status, String(body?.message ?? `GitHub 回了 ${res.status}`));
  return { body, nextPage: linkPage(res.headers.get("link")) };
}

async function request(ctx: GithubCtx, token: string | null, apiPath: string, init: RequestInit = {}): Promise<any> {
  return (await requestRaw(ctx, token, apiPath, init)).body;
}
/** 一个列表读到底的结果：`rows` 是拿到的行；`complete` 为假就是没读全（翻页中途出错，或翻到 `MAX_PAGES` 上游还说有下一页）。 */
interface FetchedList {
  rows: any[];
  complete: boolean;
}

/** 一个列表最多翻几页：再多的（PR 的 check、评论过两千条）当异常上游处理，不让一次详情请求打穿。 */
const MAX_PAGES = 20;
const linkNextRe = /<([^>]+)>\s*;\s*rel="?next"?/i;

/**
 * `Link: <…>; rel="next", <…>; rel="last"` 里 `rel="next"` 那一项的页码；没有、或那一项不可信就是 null。
 *
 * **只取页码，不取地址**：下一页仍然拼回我们自己认得的 `API` 主机 + 同一条路径。真 GitHub 会把
 * `/repos/owner/name/…` 改写成 `/repositories/<id>/…`，中间件 / 代理也可能换成别的主机 —— 照着走
 * 等于让桥去请求一个调用方没指定的地址。
 */
function linkPage(link: string | null): number | null {
  if (!link) return null;
  const m = linkNextRe.exec(link);
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[1], "https://api.github.com");
  } catch {
    return null;
  }
  const page = Number(u.searchParams.get("page"));
  return Number.isInteger(page) && page >= 1 ? page : null;
}

/**
 * 把一个列表端点读到底：跟着 `Link` 头翻页；上游不带 `Link` 时按「满页就再问一页、短页即末页」。
 *
 * - `perPage` 是我们自己定的页长（调用方的路径里不用带 `per_page`）；每页都显式带上，GitHub 的默认值是 30。
 * - 下一页只认**页码**（见 `linkPage`），已读过的页码不再读第二次（防绕圈）；最多 `MAX_PAGES` 页。
 * - 翻到一半出错（匿名额度用完、细粒度令牌没权限）就停下：**已拿到的行照样返回**，不整路丢掉 ——
 *   但 `complete` 标成假，调用方要让用户知道这份列表缺了后半。
 */
async function fetchAll(ctx: GithubCtx, token: string | null, apiPath: string, perPage = 100, pick: (body: any) => any[] = (body) => (Array.isArray(body) ? body : [])): Promise<FetchedList> {
  const path = apiPath.split("?")[0];
  const seen = new Set<number>();
  const out: any[] = [];
  let page: number | null = 1;
  while (page !== null && seen.size < MAX_PAGES) {
    seen.add(page);
    let res: GithubPage;
    try {
      res = await requestRaw(ctx, token, `${path}?per_page=${perPage}&page=${page}`);
    } catch (err: any) {
      if (seen.size === 1) throw err;
      return { rows: out, complete: false };
    }
    const rows: any[] = pick(res.body);
    // `Link` 说还有下一页、这一页却是空的：到底了（上游的 Link 不可靠时就这样），不算没读全。
    if (rows.length === 0 && seen.size > 1) return { rows: out, complete: true };
    out.push(...rows);
    // 下一页优先听 `Link` 头的（上游可能把 `per_page` 压小，行数靠不住）；没有 `Link` 才看行数：
    // 短页就是末页，满页再问一页（问出来是空页自然停）。
    const next = res.nextPage;
    if (next !== null) {
      page = seen.has(next) ? null : next;
      continue;
    }
    if (rows.length < perPage) return { rows: out, complete: true };
    page += 1;
  }
  // 走到这儿只有一种可能：翻满了 `MAX_PAGES` 页。上游若真有这么多，就当异常上游停下，并说没读全。
  return { rows: out, complete: false };
}

/** 面板要用的一行 PR。字段直接落成页面认识的名字，别让前端再猜一次 GitHub 的形状。 */
export interface PullRow {
  number: number;
  title: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export function pullRowOf(raw: any): PullRow {
  return {
    number: Number(raw?.number ?? 0),
    title: String(raw?.title ?? ""),
    draft: Boolean(raw?.draft),
    author: String(raw?.user?.login ?? ""),
    head: String(raw?.head?.ref ?? ""),
    base: String(raw?.base?.ref ?? ""),
    updatedAt: String(raw?.updated_at ?? ""),
    url: String(raw?.html_url ?? ""),
    additions: Number(raw?.additions ?? 0),
    deletions: Number(raw?.deletions ?? 0),
    changedFiles: Number(raw?.changed_files ?? 0),
  };
}

/** 一条检查。来源有两处：check-runs（GitHub Actions 等）与老的 commit status；`state` 统一成 success / failure / pending，其余原样小写。 */
export interface PullCheck {
  name: string;
  state: string;
}

/** 一条讨论。`kind` 说它从哪来：会话评论（issue）、行内回复与评审意见正文（review）。 */
export interface PullComment {
  kind: "issue" | "review";
  author: string;
  body: string;
  at: string;
  /** 行内评论才有：挂在哪个文件哪一行。 */
  path?: string;
  line?: number | null;
}

/**
 * check-run 的 status + conclusion → 页面认识的值。没跑完（queued / in_progress）是 pending；
 * 跑完了看 conclusion：success 是 success，其余（failure / timed_out / cancelled / neutral / skipped…）
 * **原样小写透传** —— 页面上「不是 success 就算没过」，多一种没见过的状态总比把它错归成通过好。
 */
function checkRunState(status: unknown, conclusion: unknown): string {
  if (String(status ?? "").toLowerCase() !== "completed") return "pending";
  return String(conclusion ?? "").toLowerCase() || "pending";
}

/** 老 commit status 的 state：success / failure / error / pending，小写原样。 */
function commitStatusState(state: unknown): string {
  return String(state ?? "").toLowerCase() || "pending";
}

/**
 * PR 详情的 checks：真去问 GitHub —— check-runs 与 commit status，都按 PR 的 **head sha** 取。
 * 这是 GitHub 页面那一条 checks 栏的口径：它看的也是 head 提交，不看合并之后的 main。
 *
 * 两个端点各要一次请求。拿不到不拖整个详情（没开 Actions 的仓库回 404、细粒度令牌没权限读都是常事）：
 * 那一路就当空的。两路都空就是「这个 PR 没有检查」，页面不画 checks 那一行。
 */
async function checksOf(ctx: GithubCtx, token: string | null, repo: string, headSha: string): Promise<{ checks: PullCheck[]; truncated: boolean }> {
  if (!headSha) return { checks: [], truncated: false };
  // check-runs 的行在 `check_runs` 里、combined status 的行在 `statuses` 里：告诉 `fetchAll` 去哪个字段取行。
  const [runs, status] = await Promise.all([
    fetchAll(ctx, token, `/repos/${repo}/commits/${headSha}/check-runs`, 100, (b) => (Array.isArray(b?.check_runs) ? b.check_runs : [])).catch(() => null),
    fetchAll(ctx, token, `/repos/${repo}/commits/${headSha}/status`, 100, (b) => (Array.isArray(b?.statuses) ? b.statuses : [])).catch(() => null),
  ]);
  const out: PullCheck[] = [];
  // 两路里有一路没读全（翻页中途出错、或翻到页数上限），面板上的 checks 就不是全貌。
  const truncated = [runs, status].some((part) => part !== null && !part.complete);
  for (const r of runs?.rows ?? []) {
    out.push({ name: String(r?.name ?? ""), state: checkRunState(r?.status, r?.conclusion) });
  }
  for (const s of status?.rows ?? []) {
    out.push({ name: String(s?.context ?? ""), state: commitStatusState(s?.state) });
  }
  return { checks: out, truncated };
}

/**
 * 详情里的讨论：issue 评论、行内 review 评论、评审意见正文，三种合成一条按时间排的流。
 *
 * **不在这里渲染 markdown**：评论正文原样给页面，由页面自己走 `renderMarkdown`。行内评论带上了
 * `path` / `line`，页面画成「文件:行」的小标。
 *
 * 跟 checks 一样：拿不到不拖整个详情。没有 review 权限的令牌读 `pulls/N/reviews` 会 403 ——
 * 那就只少一类评论，不能让整个 PR 详情打不开。
 */
async function commentsOf(ctx: GithubCtx, token: string | null, repo: string, number: number): Promise<{ comments: PullComment[]; truncated: boolean }> {
  const list: PullComment[] = [];
  const rows = (v: unknown): any[] => (Array.isArray(v) ? (v as any[]) : []);
  const [issue, inline, reviews] = await Promise.all([
    fetchAll(ctx, token, `/repos/${repo}/issues/${number}/comments`).catch(() => null),
    fetchAll(ctx, token, `/repos/${repo}/pulls/${number}/comments`).catch(() => null),
    fetchAll(ctx, token, `/repos/${repo}/pulls/${number}/reviews`).catch(() => null),
  ]);
  for (const c of rows(issue?.rows)) {
    list.push({ kind: "issue", author: String(c?.user?.login ?? ""), body: String(c?.body ?? ""), at: String(c?.created_at ?? "") });
  }
  for (const c of rows(inline?.rows)) {
    list.push({
      kind: "review",
      author: String(c?.user?.login ?? ""),
      body: String(c?.body ?? ""),
      at: String(c?.created_at ?? ""),
      path: String(c?.path ?? "") || undefined,
      line: c?.line ?? c?.original_line ?? null,
    });
  }
  for (const r of rows(reviews?.rows)) {
    // 空正文的评审（只点了批准、只留了 emoji）不占一格。
    if (!String(r?.body ?? "").trim()) continue;
    list.push({ kind: "review", author: String(r?.user?.login ?? ""), body: String(r?.body ?? ""), at: String(r?.submitted_at ?? "") });
  }
  list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // 三路里有一路没读全（翻页中途出错、或翻到页数上限），这条流就是缺了内容的。
  const truncated = [issue, inline, reviews].some((part) => part !== null && !part.complete);
  return { comments: list, truncated };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * URL 里的 `repo`：只认 `owner/name`。它会被原样拼进 `/repos/<repo>/…`，
 * 放任 `..` 或 `?` 就是「用会话令牌去请求任意 GitHub 端点」。
 * `cwd` 同理：面板把 `cwd` 原样给 `git -C` 用，而隧道访客也能打这两个读接口。
 */
function repoParam(url: URL): string {
  const repo = url.searchParams.get("repo") ?? "";
  if (repo && !REPO_RE.test(repo)) throw new GithubError("bad_args", 400, "repo 要写成 owner/name");
  return repo;
}

/** 会话目录：必须是本机上真实存在的绝对路径，且不带 `..`（不许把它当任意目录的把手）。 */
function cwdParam(url: URL): string {
  const cwd = url.searchParams.get("cwd") ?? "";
  if (!cwd) return "";
  if (!path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes("..")) throw new GithubError("bad_args", 400, "cwd 要是本机上一个真实存在的绝对目录");
  let dir = false;
  try {
    dir = fs.statSync(cwd).isDirectory();
  } catch {
    /* 不存在：下面统一报 */
  }
  if (!dir) throw new GithubError("bad_args", 400, "cwd 要是本机上一个真实存在的绝对目录");
  return cwd;
}

/**
 * 这次请求该用哪个目录：会话自己的 cwd 优先，其次才是 URL 里那个（过 `cwdParam`）。
 * 会话存在时 URL 里的 `cwd` 直接被无视 —— 那才是「AI 面板读的目录」的唯一权威。
 */
function cwdOf(url: URL, ctx: GithubCtx): string {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  return (sessionId ? ctx.sessionCwd?.(sessionId) : null) || cwdParam(url);
}

async function getPulls(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = cwdOf(url, ctx);
  const repo = repoParam(url) || (await repoOf(cwd));
  if (!repo) throw new GithubError("no-repo", 409, "这个会话的目录没有 GitHub 远端（git remote get-url origin 是空的）。");
  const pick = await pickAccount(cwd, sessionId, ctx);
  const token = await tokenOf(pick, ctx);
  const raw = await request(ctx, token, `/repos/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`);
  json(res, 200, { ok: true, repo, login: pick.login || null, anonymous: !token, pulls: Array.isArray(raw) ? raw.map(pullRowOf) : [] });
}

async function getPull(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = cwdOf(url, ctx);
  const repo = repoParam(url) || (await repoOf(cwd));
  const number = Number(url.searchParams.get("number") ?? "");
  if (!repo || !Number.isFinite(number) || number <= 0) throw new GithubError("bad_args", 400, "缺 repo 或 number");
  const pick = await pickAccount(cwd, sessionId, ctx);
  const token = await tokenOf(pick, ctx);
  const [raw, files] = await Promise.all([
    request(ctx, token, `/repos/${repo}/pulls/${number}`),
    request(ctx, token, `/repos/${repo}/pulls/${number}/files?per_page=100`),
  ]);
  // checks 与评论按同一个 PR 并行去拿（checks 看 head sha）。它们各自容错，拿不到就是空，不拖详情。
  const [checks, comments] = await Promise.all([
    checksOf(ctx, token, repo, String(raw?.head?.sha ?? "")),
    commentsOf(ctx, token, repo, number),
  ]);
  json(res, 200, {
    ok: true,
    pull: pullRowOf(raw),
    body: String(raw?.body ?? ""),
    state: String(raw?.state ?? "open"),
    // GitHub 上合并之后 `state` 仍是 closed，靠 `merged` 才分得开「已合并」与「关掉没合」。
    merged: Boolean(raw?.merged),
    mergedAt: raw?.merged_at ? String(raw.merged_at) : null,
    mergeable: raw?.mergeable ?? null,
    files: (Array.isArray(files) ? files : []).map((f: any) => ({
      path: String(f?.filename ?? ""),
      status: String(f?.status ?? ""),
      additions: Number(f?.additions ?? 0),
      deletions: Number(f?.deletions ?? 0),
      patch: String(f?.patch ?? ""),
      // GitHub 的单文件 diff 锚点就是 `#diff-<sha256(路径)>`。算在这里是为了让前端直接拼 URL；
      // 万一 GitHub 换了算法，最坏结果也只是落到「Files changed」顶部，不是打开错页。
      anchor: `diff-${crypto.createHash("sha256").update(String(f?.filename ?? "")).digest("hex")}`,
    })),
    checks: checks.checks,
    // 没读全（翻页中途出错、或翻到页数上限）时页面要说出来，别让一份缺了内容的列表冒充全貌。
    checksTruncated: checks.truncated,
    comments: comments.comments,
    commentsTruncated: comments.truncated,
  });
}

/**
 * 聊天里的链接卡只要一行（一次 REST）。缓存 60 秒：历史消息里同一个 PR 可能出现在十几条输出里。
 * 这里**不**按会话算仓库 —— 卡片属于那条链接，不属于当前会话的 cwd。
 */
const cardCache = new Map<string, { at: number; pull: PullRow }>();

async function getCard(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const repo = repoParam(url);
  const number = Number(url.searchParams.get("number") ?? "");
  if (!repo || !Number.isFinite(number) || number <= 0) throw new GithubError("bad_args", 400, "缺 repo 或 number");
  const key = `${repo}#${number}`;
  const hit = cardCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) {
    json(res, 200, { ok: true, pull: hit.pull });
    return;
  }
  // 卡片没有会话：用全局设置里的账号（有就带上，没有就匿名读公开仓库）。
  const pick = await pickAccount("", "", ctx);
  const token = await tokenOf(pick, ctx);
  const pull = pullRowOf(await request(ctx, token, `/repos/${repo}/pulls/${number}`));
  remember(cardCache, key, { at: Date.now(), pull });
  json(res, 200, { ok: true, pull });
}

// ---------------------------------------------------------------- 壳的 bin 目录

export function githubBinDir(): string {
  return statePath("github", "bin");
}

/**
 * 壳的入口文件与它需要的额外 node 参数：生产是 `dist/github-shim.js`，开发（直接跑 src）是
 * `src/github-shim.ts`。两者同名同目录，只是扩展名不同。
 */
export function shimEntry(): { file: string; nodeArgs: string[] } {
  const file = path.join(import.meta.dirname, `github-shim${path.extname(import.meta.filename)}`);
  return { file, nodeArgs: file.endsWith(".ts") ? ["--experimental-strip-types"] : [] };
}

/**
 * 把那两个包装脚本写到 `<state>/github/bin/`：POSIX 的 `gh`，Windows 的 `gh.cmd`。
 * 只在内容变了时重写（每次启动都写一遍会让 EDR / 杀软不高兴，也会白刷 mtime）。
 */
export function ensureGithubBin(): string {
  const dir = githubBinDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const { file, nodeArgs } = shimEntry();
  const quoted = [...nodeArgs, file].map((a) => `"${a}"`).join(" ");
  const posix =
    `#!/bin/sh\n# pi-web-client 的 gh 壳：选账号、必要时用 REST 兜底，然后把这次调用回报给桥。\n` +
    `exec "${process.execPath}" ${quoted} "$@"\n`;
  const win =
    `@echo off\r\nrem pi-web-client 的 gh 壳（Windows）：选账号、必要时用 REST 兜底，然后回报给桥。\r\n` +
    `"${process.execPath}" ${nodeArgs.join(" ")} "${file}" %*\r\n`;
  for (const [name, content, mode] of [["gh", posix, 0o755], ["gh.cmd", win, 0o644]] as const) {
    const target = path.join(dir, name);
    let cur = "";
    try {
      cur = fs.readFileSync(target, "utf8");
    } catch {
      /* 第一次 */
    }
    if (cur !== content) fs.writeFileSync(target, content, { mode });
    if (name === "gh" && process.platform !== "win32") {
      try {
        fs.chmodSync(target, mode);
      } catch {
        /* 无 chmod 的文件系统照样能 exec */
      }
    }
  }
  return dir;
}

// ---------------------------------------------------------------- 路由

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, code, error: message });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("请求体太大了");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function getState(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = cwdOf(url, ctx);
  const gh = resolveGhBinary(ctx);
  const status = await ghStatus(gh);
  const pats = readState().pats;
  const accounts: GhAccount[] = [];
  if (status.state === "ok") for (const a of status.accounts) accounts.push({ login: a.login, kind: "gh", active: a.active });
  for (const login of Object.keys(pats)) if (!accounts.some((a) => a.login === login)) accounts.push({ login, kind: "pat", active: false });
  const pick = await pickAccount(cwd, sessionId, ctx);
  json(res, 200, {
    ok: true,
    gh: gh !== null,
    ghState: status.state,
    ghError: status.state === "logged-out" ? status.error : "",
    accounts,
    // 同一个登录名既是 gh 账号又存了 PAT 时，账号表里只留一行（kind 取 gh），
    // 另给这份名单让界面打「也存了 PAT」的标 —— 两行同名会让人以为能选两次。
    pats: Object.keys(pats),
    session: pick.login ? { login: pick.login, kind: pick.kind, source: pick.source } : null,
    repo: cwd ? await repoOf(cwd) : null,
    readonly: ctx.publicReq,
  });
}

async function putPat(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "带凭据的操作只能在本机做");
    return;
  }
  const body = await readBody(req);
  const token = String(body?.token ?? "").trim();
  if (!token) {
    fail(res, 400, "bad_args", "令牌是空的");
    return;
  }
  // 先问一次 GitHub 这枚令牌是谁的：存一个「认不出是谁」的令牌，只会让后面每个按钮都失败。
  const me = await request(ctx, token, "/user");
  const login = String(me?.login ?? "");
  if (!login) {
    fail(res, 400, "unauthorized", "这枚令牌拿不到 GitHub 用户信息");
    return;
  }
  const written = await writeSecret(patFile(login), token);
  const state = readState();
  state.pats[login] = { addedAt: Date.now() };
  writeState(state);
  json(res, 200, { ok: true, login, encrypted: written.encrypted });
}

async function deletePat(_req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "带凭据的操作只能在本机做");
    return;
  }
  const login = url.searchParams.get("login") ?? "";
  if (!login) {
    fail(res, 400, "bad_args", "缺 login");
    return;
  }
  const state = readState();
  delete state.pats[login];
  writeState(state);
  try {
    fs.rmSync(patFile(login));
  } catch {
    /* 文件不在就算了，accounts.json 里已经没了 */
  }
  json(res, 200, { ok: true });
}

/** 壳的请求只认 loopback token；拿到它就知道是哪个会话（也就知道 cwd 与账号）。 */
function sessionOf(req: http.IncomingMessage, ctx: GithubCtx): { id: string; cwd: string } | null {
  const token = String(req.headers["x-pi-loopback"] ?? "");
  return token ? ctx.byLoopbackToken(token) : null;
}

async function shimIdentity(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  const session = sessionOf(req, ctx);
  if (!session) {
    fail(res, 401, "bad_token", "不是桥自己起的 pi 子进程");
    return;
  }
  const pick = await pickAccount(session.cwd, session.id, ctx);
  json(res, 200, {
    ok: true,
    login: pick.login || null,
    source: pick.source,
    token: await tokenOf(pick, ctx),
    realGh: resolveGhBinary(ctx),
    // 测试缝：有它就 `node <它>` 顶替真 gh。**只能走这条响应**，不能用环境变量 ——
    // 壳跑在 pi 子进程底下，而 `piChildEnv()` 会把所有 `PI_WEB_*` 剥掉（bridge/src/paths.ts）。
    realGhJs: process.env.PI_WEB_GH_JS ?? null,
    sessionId: session.id,
    cwd: session.cwd,
    // 壳的 REST 兜底也走这里：生产是 api.github.com，桥内测试缝是假站点。
    api: ctx.upstreamApi ?? null,
  });
}

/**
 * 壳把一次 `gh …` 的收尾交回来。只做两件事：认出输出里的链接（→ 帧），以及把「PR 建好了」这件事
 * 告诉页面（→ 自动推开面板）。**不认识就什么也不做** —— 这是记账，不是解析器。
 */
async function shimReport(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  const session = sessionOf(req, ctx);
  if (!session) {
    fail(res, 401, "bad_token", "不是桥自己起的 pi 子进程");
    return;
  }
  const body = await readBody(req);
  const argv = Array.isArray(body?.argv) ? body.argv.map(String) : [];
  const code = Number(body?.exit ?? 0);
  const output = `${String(body?.stdout ?? "")}\n${String(body?.stderr ?? "")}`;
  const login = body?.login ? String(body.login) : null;
  const links = code === 0 ? seenLinks(output) : [];
  const created = code === 0 && /^pr$/.test(argv[0] ?? "") && /create|new/.test(argv[1] ?? "");
  const pr = created ? links.find((l) => l.kind === "pull") : undefined;
  if (pr) {
    ctx.send({ type: "github.pr", sessionId: session.id, repo: pr.repo, number: Number(pr.id), url: pr.url, login });
    json(res, 200, { ok: true, opened: true });
    return;
  }
  if (links.length > 0) ctx.send({ type: "github.seen", sessionId: session.id, links, login });
  json(res, 200, { ok: true, opened: false });
}

/**
 * 把某个账号记成**这个工作区**的默认（写 `<cwd>/.pi/settings.json` 的 `githubAccount`）。
 * 与 `POST /api/github/account` 分开：那个只影响一个会话、只落桥的状态目录；这个写的是项目文件，
 * 会跟着仓库走，所以要单独一条、单独问一次。
 */
async function setProjectAccount(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "改工作区设置只能在本机做");
    return;
  }
  const body = await readBody(req);
  const cwd = String(body?.cwd ?? "");
  const login = String(body?.login ?? "");
  if (!cwd || !fs.existsSync(cwd)) {
    fail(res, 400, "bad_args", "缺一个存在的 cwd");
    return;
  }
  const file = path.join(cwd, ".pi", "settings.json");
  const raw = readJson<Record<string, unknown>>(file, {});
  if (login) raw.githubAccount = login;
  else delete raw.githubAccount;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, raw);
  json(res, 200, { ok: true, file });
}

async function setSessionAccount(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "换账号只能在本机做");
    return;
  }
  const body = await readBody(req);
  const sessionId = String(body?.sessionId ?? "");
  const login = String(body?.login ?? "");
  if (!sessionId) {
    fail(res, 400, "bad_args", "缺 sessionId");
    return;
  }
  const state = readState();
  if (login) state.session[sessionId] = login;
  else delete state.session[sessionId];
  writeState(state);
  json(res, 200, { ok: true });
}

/**
 * `/api/github/*`。返回 true 表示这个请求归它管。
 * 读（面板数据）对隧道访客照常；写（存 PAT、换账号）403 —— 与 Jira 面板同一套模式。
 */
export async function handleGithub(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<boolean> {
  if (!url.pathname.startsWith("/api/github/")) return false;
  const method = req.method ?? "GET";
  try {
    switch (url.pathname) {
      case "/api/github/state":
        if (method !== "GET") break;
        await getState(res, url, ctx);
        return true;
      case "/api/github/pulls":
        if (method !== "GET") break;
        await getPulls(res, url, ctx);
        return true;
      case "/api/github/pr":
        if (method !== "GET") break;
        await getPull(res, url, ctx);
        return true;
      case "/api/github/card":
        if (method !== "GET") break;
        await getCard(res, url, ctx);
        return true;
      case "/api/github/pat":
        if (method === "PUT") {
          await putPat(req, res, ctx);
          return true;
        }
        if (method === "DELETE") {
          await deletePat(req, res, url, ctx);
          return true;
        }
        break;
      case "/api/github/shim/identity":
        if (method !== "POST") break;
        await shimIdentity(req, res, ctx);
        return true;
      case "/api/github/shim/report":
        if (method !== "POST") break;
        await shimReport(req, res, ctx);
        return true;
      case "/api/github/project-account":
        if (method !== "POST") break;
        await setProjectAccount(req, res, ctx);
        return true;
      case "/api/github/account":
        if (method !== "POST") break;
        await setSessionAccount(req, res, ctx);
        return true;
      default:
        fail(res, 404, "not_found", "没有这个 GitHub 接口");
        return true;
    }
    fail(res, 405, "bad_method", "不支持这个请求方法");
    return true;
  } catch (err) {
    if (err instanceof GithubError) {
      fail(res, err.status, err.code, err.message);
      return true;
    }
    fail(res, 500, "unknown", String((err as Error)?.message ?? err));
    return true;
  }
}

/** 测试用：把缓存清掉（假 gh / 假 GitHub 换了一套之后不能让上一轮的结果留着）。 */
export function resetGithubCaches(): void {
  statusCache = null;
  tokenCache.clear();
  repoCache.clear();
  cardCache.clear();
}
