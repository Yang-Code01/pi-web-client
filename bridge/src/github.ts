/**
 * GitHub 通道：一个「兼容 `gh` 与 GitHub API」的模块。
 *
 * 三层，各管一件事：
 *  1. 壳（`bridge/src/github-shim.ts`，由 `githubBinDir()` 生成的 `gh` / `gh.cmd` 起）——AI 照旧敲
 *     `gh …`，壳先问桥「这个会话是谁」（`/api/github/shim/identity`），拿到 token 再 `exec` 真 gh；
 *     没装 gh 时壳自己用 REST 实现 PR 核心，最后把这次调用回报给桥（`/api/github/shim/report`）。
 *  2. 这个文件 —— 账号、凭据、REST、路由。**凭据只在这里**：页面只见掩码，壳一次一取（不把 token
 *     留在 pi 子进程的 env 里，否则一次 `printenv` 就会把它打进聊天记录）。
 *  3. 页面 —— 右栏面板（`web/src/github-panel.ts`）与链接卡。
 *
 * 为什么不是「给模型一套 `github_*` 工具」：仓库里 41 处文档（`AGENTS.md` 9、
 * `docs/agents/issue-tracker.md` 25、`whatsnew-write` 技能 7）写的都是 `gh …`，模型就是这么被教出来
 * 的。换工具要重写那些文档，而模型习惯性敲 `gh` 时会退回机器上的 active 账号 —— 正是要消灭的那种
 * 「悄悄用错账号」。壳让这些文档原样成立。
 *
 * 账号解析顺序（第一条命中就停）：会话临时选择 → 工作区 `.pi/settings.json` 的 `githubAccount` →
 * 全局 settings.json 的 `githubAccount` → `gh auth status` 的 active。
 */
import { execFile } from "node:child_process";
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
const FETCH_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 10_000;

export interface GithubCtx {
  /** 公网隧道进来的请求：读照常，写（存 PAT、换账号）403。 */
  publicReq: boolean;
  /** 推一帧给页面（`index.ts` 的 `broadcast`）。 */
  send: (frame: Record<string, unknown>) => void;
  /** 由 loopback token 反查会话（`SessionsManager.byLoopbackToken`）。 */
  byLoopbackToken: (token: string) => { id: string; cwd: string } | null;
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
  /** 会话级临时选择：sessionId → login。进程内存即可，但落盘以后重启还在，代价为零。 */
  session: Record<string, string>;
}

function stateFile(): string {
  return statePath("github", "accounts.json");
}

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

/** PATH 里找 `gh`，**跳过我们自己的 bin 目录**（否则桥解析出的是自己的壳，壳再去 exec 它）。 */
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
 * 真 gh 的路径。`ghPath` 三种取值见 `GithubCtx`；这里只把「跳过自己的 bin 目录」那条规则包起来。
 * 结果缓存 30 秒，跟账号状态同一个 TTL：装了 gh 之后最多半分钟就认出来。
 */
export function resolveGhBinary(ctx: Pick<GithubCtx, "ghPath"> = {}): string | null {
  if (ctx.ghPath === null) return null;
  if (typeof ctx.ghPath === "string") return ctx.ghPath;
  return findRealGh(githubBinDir());
}

function runGh(gh: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    execFile(gh, args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", error: error ?? undefined });
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
 * 解析不出来就当成「登录态读不到」，不去猜——猜错的代价是把 PR 建到别人名下。
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
  const key = gh;
  if (statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  const r = await runGh(gh, ["auth", "status"]);
  // gh 在没登录时返回 1，仍然打印「You are not logged into any GitHub hosts」。
  const accounts = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
  const value: StatusRead = accounts.length > 0
    ? { state: "ok", accounts }
    : { state: "logged-out", error: (r.stderr || r.stdout || r.error?.message || "").trim() };
  statusCache = { key, at: Date.now(), value };
  return value;
}

/** 一小时内重复问同一个账号只派生一次 `gh auth token`（冷的 ~900ms，热的 ~80ms）。 */
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
  /** 这个账号是怎么选出来的：`session` / `project` / `global` / `active` / `pat-only`。 */
  source: "session" | "project" | "global" | "active" | "pat-only" | "none";
}

/**
 * 会话该用哪个账号。`cwd` 决定工作区偏好（与 pi 的 settings 一致：项目 `.pi/settings.json` 优先）。
 * 空字符串 = 一个都没有。
 */
export async function pickAccount(cwd: string, sessionId: string, ctx: Pick<GithubCtx, "ghPath"> = {}): Promise<AccountPick> {
  const gh = resolveGhBinary(ctx);
  const status = await ghStatus(gh);
  const ghLogins = new Set(status.state === "ok" ? status.accounts.map((a) => a.login) : []);
  const pats = readState().pats;
  const known = (login: string): "gh" | "pat" | null => (ghLogins.has(login) ? "gh" : pats[login] ? "pat" : null);

  const session = sessionId ? readState().session[sessionId] : undefined;
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
  const hit = repoCache.get(cwd);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo;
  const repo = await new Promise<string | null>((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : repoFromRemote(stdout ?? ""));
    });
  });
  repoCache.set(cwd, { at: Date.now(), repo });
  return repo;
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

async function request(ctx: GithubCtx, token: string | null, apiPath: string, init: RequestInit = {}): Promise<any> {
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
    throw new GithubError("network", 502, `连不上 GitHub：${String(err?.message ?? err)}。先确认这台机器能直连（curl -I https://api.github.com），要走代理就填 pi 的 httpProxy。`);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (res.status === 401) throw new GithubError("unauthorized", 401, "GitHub 不认这个令牌：可能已过期或被撤销。");
  if (res.status === 404) throw new GithubError("not-found", 404, body?.message ? String(body.message) : "GitHub 上没有这个东西。");
  if (res.status === 403 && /rate limit/i.test(String(body?.message ?? ""))) {
    throw new GithubError("rate-limit", 429, "匿名请求的额度用完了（60 次/小时）：配一个账号或等一小时。");
  }
  if (!res.ok) throw new GithubError("upstream", res.status, String(body?.message ?? `GitHub 回了 ${res.status}`));
  return body;
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

function pullRowOf(raw: any): PullRow {
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

// ---------------------------------------------------------------- 壳的 bin 目录

export function githubBinDir(): string {
  return statePath("github", "bin");
}

/**
 * 壳的入口文件与它需要的额外 node 参数：生产是 `dist/github-shim.js`，开发（`--experimental-strip-types`
 * 直接跑 src）是 `src/github-shim.ts`。两者同名同目录，只是扩展名不同。
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
  const args = [...nodeArgs, file].map((a) => `"${a}"`).join(" ");
  const posix = `#!/bin/sh\n# pi-web-client 的 gh 壳：选账号、必要时用 REST 兜底，然后把这次调用回报给桥。\nexec "${process.execPath}" ${args} "$@"\n`;
  const win = `@echo off\r\nrem pi-web-client 的 gh 壳（Windows）：选账号、必要时用 REST 兜底，然后回报给桥。\r\n"${process.execPath}" ${nodeArgs.join(" ")} "${file}" %*\r\n`;
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
        /* 无 chmod 的文件系统照样能 exec，只是要靠 exec 位碰巧对上 */
      }
    }
  }
  return dir;
}

// ---------------------------------------------------------------- 从 gh 的输出里认东西

export interface SeenLink {
  kind: "pull" | "issue" | "commit";
  repo: string;
  /** pull / issue 的号；commit 是 sha。 */
  id: string;
  url: string;
}

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
    out.push({ kind: kind === "pull" ? "pull" : kind === "issues" ? "issue" : "commit", repo: `${owner}/${repo}`, id, url });
  }
  return out;
}

// ---------------------------------------------------------------- 路由

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, code, error: message });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new GithubError("too-large", 413, "请求体太大了");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GithubError("bad_json", 400, "请求体不是 JSON");
  }
}

/** 壳的请求只认 loopback token；拿到它就知道是哪个会话（也就知道 cwd 与账号）。 */
function sessionOf(req: http.IncomingMessage, ctx: GithubCtx): { id: string; cwd: string } | null {
  const token = String(req.headers["x-pi-loopback"] ?? "");
  return token ? ctx.byLoopbackToken(token) : null;
}

async function getState(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = url.searchParams.get("cwd") ?? "";
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
    session: pick.login ? { login: pick.login, kind: pick.kind, source: pick.source } : null,
    repo: cwd ? await repoOf(cwd) : null,
    readonly: ctx.publicReq,
  });
}

async function getPulls(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = url.searchParams.get("cwd") ?? "";
  const repo = url.searchParams.get("repo") || (await repoOf(cwd));
  if (!repo) throw new GithubError("no-repo", 409, "这个会话的目录没有 GitHub 远端（git remote get-url origin 是空的）。");
  const pick = await pickAccount(cwd, sessionId, ctx);
  const token = await tokenOf(pick, ctx);
  const raw = await request(ctx, token, `/repos/${repo}/pulls?state=open&per_page=20&sort=updated&direction=desc`);
  const list = Array.isArray(raw) ? raw.map(pullRowOf) : [];
  json(res, 200, { ok: true, repo, login: pick.login || null, anonymous: !token, pulls: list });
}

/**
 * PR 详情。正文、文件、差异是**真**的（两次 REST）。`checks` 与 `comments` 是**示例样本** ——
 * 这一版的原型只验「机制真跑 + 面板长什么样」，不为原型做完整的 checks / 评论归一。
 * 页面拿到 `sample: true` 就在标题旁标一句「示例数据」，不假装是真的。
 */
async function getPull(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = url.searchParams.get("cwd") ?? "";
  const repo = url.searchParams.get("repo") || (await repoOf(cwd));
  const number = Number(url.searchParams.get("number") ?? "");
  if (!repo || !Number.isFinite(number) || number <= 0) throw new GithubError("bad_args", 400, "缺 repo 或 number");
  const pick = await pickAccount(cwd, sessionId, ctx);
  const token = await tokenOf(pick, ctx);
  const [raw, files] = await Promise.all([
    request(ctx, token, `/repos/${repo}/pulls/${number}`),
    request(ctx, token, `/repos/${repo}/pulls/${number}/files?per_page=100`),
  ]);
  json(res, 200, {
    ok: true,
    pull: pullRowOf(raw),
    body: String(raw?.body ?? ""),
    state: String(raw?.state ?? "open"),
    mergeable: raw?.mergeable ?? null,
    files: (Array.isArray(files) ? files : []).map((f: any) => ({
      path: String(f?.filename ?? ""),
      status: String(f?.status ?? ""),
      additions: Number(f?.additions ?? 0),
      deletions: Number(f?.deletions ?? 0),
      patch: String(f?.patch ?? ""),
    })),
    sample: { checks: SAMPLE_CHECKS, comments: SAMPLE_COMMENTS },
  });
}

const SAMPLE_CHECKS = [
  { name: "typecheck", state: "success" },
  { name: "unit / bridge", state: "success" },
  { name: "ui / chrome", state: "success" },
  { name: "e2e", state: "success" },
];

const SAMPLE_COMMENTS = [
  { author: "Yang-Code01", body: "「已显示的内容不许变暗」这条守卫要不要顺手补进 probes？", at: "2 小时前" },
  { author: "qingmin-new", body: "补了：第 10 段逐帧采样，任何一帧 opacity < 0.99 就红。", at: "1 小时前" },
];

/**
 * 聊天里的链接卡只要一行（一次 REST）。缓存 60 秒：历史消息里同一个 PR 可能出现在十几条输出里。
 * 这里**不**按会话算仓库 —— 卡片属于那条链接，不属于当前会话的 cwd。
 */
const cardCache = new Map<string, { at: number; pull: PullRow }>();

async function getCard(res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
  const repo = url.searchParams.get("repo") ?? "";
  const number = Number(url.searchParams.get("number") ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isFinite(number) || number <= 0) throw new GithubError("bad_args", 400, "缺 repo 或 number");
  const key = `${repo}#${number}`;
  const hit = cardCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) {
    json(res, 200, { ok: true, pull: hit.pull });
    return;
  }
  // 卡片没有会话：用全局设置里的账号（有就带上，没有就匿名读公开仓库）。
  const pick = await pickAccount("", "", ctx);
  const token = await tokenOf(pick, ctx);
  const raw = await request(ctx, token, `/repos/${repo}/pulls/${number}`);
  const pull = pullRowOf(raw);
  cardCache.set(key, { at: Date.now(), pull });
  json(res, 200, { ok: true, pull });
}

async function putPat(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {  if (ctx.publicReq) {
    fail(res, 403, "tunnel_readonly", "带凭据的操作只能在本机做");
    return;
  }
  const body = await readBody(req);
  const token = String(body?.token ?? "").trim();
  if (!token) {
    fail(res, 400, "bad_args", "令牌是空的");
    return;
  }
  // 先问一次 GitHub 这枚令牌是谁的：存一个「认不出是谁」的令牌只会让后面每个按钮都失败。
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
  tokenCache.clear();
  json(res, 200, { ok: true, login, encrypted: written.encrypted });
}

async function deletePat(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<void> {
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

async function shimIdentity(req: http.IncomingMessage, res: http.ServerResponse, ctx: GithubCtx): Promise<void> {
  const session = sessionOf(req, ctx);
  if (!session) {
    fail(res, 401, "bad_token", "不是桥自己起的 pi 子进程");
    return;
  }
  const pick = await pickAccount(session.cwd, session.id, ctx);
  const token = await tokenOf(pick, ctx);
  const gh = resolveGhBinary(ctx);
  json(res, 200, {
    ok: true,
    login: pick.login || null,
    source: pick.source,
    token,
    realGh: gh,
    sessionId: session.id,
    cwd: session.cwd,
    // 壳的 REST 兜底也走这里：生产是 api.github.com，桥内测试缝是假站点。
    api: ctx.upstreamApi ?? null,
  });
}

/**
 * 壳把一次 `gh …` 的收尾交回来。这里只做两件事：认出输出里的链接（→ 帧），以及把「PR 建好了」这件事
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
    const number = Number(pr.id);
    ctx.send({ type: "github.pr", sessionId: session.id, repo: pr.repo, number, url: pr.url, login });
    json(res, 200, { ok: true, opened: true });
    return;
  }
  if (links.length > 0) ctx.send({ type: "github.seen", sessionId: session.id, links, login });
  json(res, 200, { ok: true, opened: false });
}

/**
 * `/api/github/*`。返回 true 表示这个请求归它管。
 * 读（面板数据）对隧道访客照常；写（存 PAT、换账号）403 —— 模式与 Jira 面板一致。
 */
export async function handleGithub(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: GithubCtx): Promise<boolean> {
  if (!url.pathname.startsWith("/api/github/")) return false;
  const method = req.method ?? "GET";
  try {
    switch (url.pathname) {
      case "/api/github/state":
        if (method !== "GET") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await getState(res, url, ctx);
        return true;
      case "/api/github/pulls":
        if (method !== "GET") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await getPulls(res, url, ctx);
        return true;
      case "/api/github/pr":
        if (method !== "GET") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await getPull(res, url, ctx);
        return true;
      case "/api/github/card":
        if (method !== "GET") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
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
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      case "/api/github/account":
        if (method !== "POST") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await setSessionAccount(req, res, ctx);
        return true;
      case "/api/github/shim/identity":
        if (method !== "POST") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await shimIdentity(req, res, ctx);
        return true;
      case "/api/github/shim/report":
        if (method !== "POST") return fail(res, 405, "bad_method", "不支持这个请求方法"), true;
        await shimReport(req, res, ctx);
        return true;
      default:
        fail(res, 404, "not_found", "没有这个 GitHub 接口");
        return true;
    }
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
}
