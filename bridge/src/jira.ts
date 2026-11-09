/**
 * Jira 面板（#248、#249）的桥端：一个站点、一组凭据、只读。
 *
 * 三条边界，改之前先看 D202：
 * - 页面永远拿不到 API token：GET 只回掩码，错误文本与日志里也不带它；
 * - 出站只发配置里的那个站点（`/rest/api/3/*`），头像额外允许 Atlassian 头像 CDN；
 * - 隧道访客只读：保存 / 清除凭据一律 403「回本机操作」。
 *
 * 自包含：`json()` / `fail()` / body 解析都写在本地，不 import index 的私有函数（index 反过来
 * import 这里，共用会成环）。测试可以把 `handleJira` 挂到一个最小 `http.createServer` 上。
 */
import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { ensureDir, readJsonChecked, statePath } from "./paths.ts";
import {
  buildSearchJql,
  parseSearchParams,
  SEARCH_PAGE_SIZE,
  SearchQueryError,
  STATUS_CATEGORY_KEYS,
} from "./jira-search.ts";
import type { SearchParams } from "./jira-search.ts";

const TIMEOUT_MS = 15000;
const MYSELF = "/rest/api/3/myself";
// #249：新的 JQL 端点（老的 `/rest/api/3/search` 正被 Atlassian 下线）与项目列表。
const SEARCH = "/rest/api/3/search/jql";
const PROJECTS = "/rest/api/3/project/search";
// #257：搜索用的元数据与人员搜索。
const TYPES = "/rest/api/3/issuetype";
const PRIORITIES = "/rest/api/3/priority";
const USERS = "/rest/api/3/user/search";
/** #257：类型/优先级/项目状态变得很慢，5 分钟缓存够用；搜索结果本身不缓存。 */
const META_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;
/** #251：单文件上限；超了只跳过这一项，同批其它文件照常落盘。 */
const MAX_DOWNLOAD = 100 * 1024 * 1024;
/** 附件内容可能几 MB 到几十 MB，别套 15 秒的 JSON 超时（那个是给元数据用的）。 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** 页面传不了查询：JQL 与字段都在桥里写死（D203）。 */
const MY_OPEN_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const ISSUE_FIELDS = "summary,issuetype,priority,status,assignee,updated";
const LIST_MAX = 20;
/** 列表缓存 60 秒：面板反复开关时别把 Jira 的限流额度打满。只存内存，不落盘（D203）。 */
const LIST_TTL_MS = 60_000;

export interface JiraConfig {
  siteUrl: string;
  email: string;
  apiKey: string;
}

export interface JiraMe {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  avatarUrl: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  /** 没有优先级时 Jira 回 null，页面据此省略或显示占位。 */
  priority: string | null;
  status: string;
  /** 显示名；未分配或上游按隐私策略不给名字时为空串。 */
  assignee: string;
  updated: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

/** #257：搜索条件表单的选项。`statusCategories` 是桥内常量，页面自己上标签。 */
export interface JiraSearchMeta {
  statusCategories: readonly string[];
  types: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  statuses: { id: string; name: string }[];
  /** 项目状态没取到时为 true：类型/优先级照常给，不让整张表单失败。 */
  partial: boolean;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

/** 详情里的一条附件：大小 / 作者未知时分别是 `null` / 空串（评论 media 节点拿不到这些）。 */
export interface JiraAttachment {
  id: string;
  filename: string;
  size: number | null;
  author: string;
  created: string;
}

/** #250：`description` 是上游 ADF 原样透传，桥不解释它（D204）。 */
export interface JiraIssueDetail {
  issue: JiraIssue & { description: unknown };
  attachments: { issue: JiraAttachment[]; comments: JiraAttachment[] };
}

export interface JiraCtx {
  /** 公网隧道进来的请求：读照常，写 403。 */
  publicReq: boolean;
  /**
   * 桥内测试缝：出站请求改发这里（假 Jira 是 `http://127.0.0.1:port`，过不了站点的 https
   * 校验）。生产不传，等于「只发配置的站点」。别改成环境变量：pi 子进程那边会剥掉 `PI_WEB_*`。
   */
  upstream?: string;
}

class JiraError extends Error {
  readonly code: string;
  readonly status: number;
  /** 上游原始状态码（仅供降级判断）；桥自己产生的错误没有这个值。 */
  readonly upstreamStatus?: number;
  constructor(code: string, status: number, message: string, upstreamStatus?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

// ---------------------------------------------------------------- 站点地址

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isIpLiteral(host: string): boolean {
  return (host.startsWith("[") && host.endsWith("]")) || IPV4.test(host);
}

/**
 * 站点地址的毛病（中文原因）或 null。桥侧是权威校验，页面 `web/src/jira-shared.ts` 有一份同口径的
 * 即时提示 —— 两边都改才算改完。
 */
export function siteUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "请填 Jira 站点地址";
  let url: URL;
  try {
    url = new URL(withScheme(text));
  } catch {
    return "站点地址看不懂，检查一下有没有写错";
  }
  if (url.protocol !== "https:") return "只接受 https:// 的站点地址";
  if (url.username || url.password) return "站点地址里不要带用户名或密码";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "站点地址不能是 localhost";
  if (host.endsWith(".local") || host.endsWith(".internal")) return "站点地址不能是内网域名";
  if (isIpLiteral(host)) return "站点地址不能是 IP，请填 https://<团队>.atlassian.net";
  if (!host.includes(".")) return "站点地址要是一个完整的域名";
  if (url.pathname.replace(/\/+$/, "")) return "站点地址只填到域名，不要带路径";
  if (url.search) return "站点地址不要带查询参数";
  if (url.hash) return "站点地址不要带 #";
  return null;
}

/** 去掉结尾 `/`、补上 scheme。校验通过之后才调用。 */
export function normalizeSiteUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  try {
    const url = new URL(withScheme(text));
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return text;
  }
}

/** 页面只该看到这个：`••••` + 后 4 位（不够 4 位就全掩）。 */
export function keyMask(key: string): string {
  const k = key.trim();
  return k.length > 4 ? `••••${k.slice(-4)}` : "••••";
}

/**
 * 头像 URL 允许名单（D202）：与配置站点同 origin，或 Atlassian 自己的头像 CDN。
 * 放行 atl-paas.net 是因为 Cloud 的 `avatarUrls` 就落在那个 CDN 上；代价是这一条比
 * 「只发配置站点」宽一点，所以其余字段（https、无 userinfo、443、无 fragment）一个不放。
 */
export function avatarUrlAllowed(raw: string, siteUrl: string): boolean {
  let avatar: URL;
  let site: URL;
  try {
    avatar = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  if (avatar.protocol !== "https:") return false;
  if (avatar.username || avatar.password) return false;
  if (avatar.port && avatar.port !== "443") return false;
  if (avatar.hash) return false;
  if (avatar.origin === site.origin) return true;
  const host = avatar.hostname.toLowerCase();
  return host === "atl-paas.net" || host.endsWith(".atl-paas.net");
}

/** 测试缝下只认与假 Jira 同源的地址；生产走 `avatarUrlAllowed`。 */
function avatarAllowed(config: JiraConfig, ctx: JiraCtx, raw: string): boolean {
  if (!ctx.upstream) return avatarUrlAllowed(raw, config.siteUrl);
  try {
    return new URL(raw).origin === new URL(ctx.upstream).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 凭据文件

function configFile(): string {
  return statePath("jira", "config.json");
}

/** 坏文件（半截 / 非 JSON / 字段缺失）一律当未配置，别把面板卡在错误态。 */
export function readJiraConfig(): JiraConfig | null {
  const { ok, value } = readJsonChecked<Partial<JiraConfig> | null>(configFile(), null);
  if (!ok || !value || typeof value !== "object") return null;
  const siteUrl = typeof value.siteUrl === "string" ? value.siteUrl.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim() : "";
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  return siteUrl && email && apiKey ? { siteUrl, email, apiKey } : null;
}

export function isJiraConfigured(): boolean {
  return readJiraConfig() !== null;
}

function writeJiraConfig(config: JiraConfig): void {
  clearListCache();
  const file = configFile();
  ensureDir(statePath("jira"));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Windows 上没有 POSIX 权限位；别的平台把组/其他用户收掉。尽力而为，不因为失败拒绝保存。
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 尽力而为 */
  }
}

function clearJiraConfig(): void {
  clearListCache();
  fs.rmSync(configFile(), { force: true });
  fs.rmSync(`${configFile()}.tmp`, { force: true });
}

// ---------------------------------------------------------------- 列表缓存

/** 缓存的是整理后的列表，不是上游响应对象：页面要的字段之外的东西不留。 */
const listCache = new Map<string, { at: number; value: unknown }>();

/** 按当前配置分键：换站点 / 换账号 / 换 token 之后，旧列表不该再端上来。 */
function cacheKey(kind: string, config: JiraConfig): string {
  return `${kind}\n${config.siteUrl}\n${config.email}\n${keyMask(config.apiKey)}`;
}

function cacheGet<T>(kind: string, config: JiraConfig, ttl = LIST_TTL_MS): T | null {
  const hit = listCache.get(cacheKey(kind, config));
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    listCache.delete(cacheKey(kind, config));
    return null;
  }
  return hit.value as T;
}

function cachePut<T>(kind: string, config: JiraConfig, value: T): void {
  listCache.set(cacheKey(kind, config), { at: Date.now(), value });
}

/** 保存 / 清除凭据时清空：旧凭据名下的列表不再可信（D203）。 */
function clearListCache(): void {
  listCache.clear();
}

// ---------------------------------------------------------------- 出站请求

function basicAuth(config: JiraConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiKey}`, "utf8").toString("base64")}`;
}

function upstreamBase(config: JiraConfig, ctx: JiraCtx): string {
  return (ctx.upstream ?? config.siteUrl).replace(/\/+$/, "");
}

/**
 * 唯一出站点。`allowed` 必须在发起前把目标再查一遍 —— 这是防止这个模块变成开放代理的
 * 最后一关（站点：同 origin；头像：`avatarAllowed`）。
 */
async function requestJira(
  config: JiraConfig,
  target: URL,
  allowed: (target: URL) => boolean,
  timeoutMs = TIMEOUT_MS,
  auth = true,
): Promise<Response> {
  if (!allowed(target)) throw new JiraError("jira_site", 400, "只允许访问配置的 Jira 站点");
  const headers = new Headers();
  // 附件下载的第二跳是 Media 签名 URL，凭据已经写在签名里：不拼 Authorization（D205）。
  if (auth) headers.set("authorization", basicAuth(config));
  headers.set("accept", "application/json");
  try {
    return await fetch(target, {
      headers,
      // 不跟随重定向：3xx 直接当失败，别让一次 302 把 Basic 凭据带去第三个域名。
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    const seconds = Math.round(timeoutMs / 1000);
    throw new JiraError("jira_network", 502, timedOut ? `Jira ${seconds} 秒内没有响应` : `连不上 Jira：${e?.message ?? e}`);
  }
}

/** 只发配置站点：拼出来的 URL 再断言一次 origin。 */
async function fetchSite(config: JiraConfig, ctx: JiraCtx, path: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const base = upstreamBase(config, ctx);
  let baseUrl: URL;
  let target: URL;
  try {
    baseUrl = new URL(base);
    target = new URL(path, `${base}/`);
  } catch {
    throw new JiraError("jira_site", 400, "配置的 Jira 站点地址无效");
  }
  return requestJira(config, target, (u) => u.origin === baseUrl.origin, timeoutMs);
}

/** Jira 的错误原话（`errorMessages` / `errors`），拿不到就退回响应体前 300 字。 */
async function upstreamMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    const list = Array.isArray(body?.errorMessages)
      ? body.errorMessages.filter((x: unknown) => typeof x === "string")
      : [];
    const fields =
      body?.errors && typeof body.errors === "object"
        ? Object.values(body.errors).filter((x): x is string => typeof x === "string")
        : [];
    const words = [...list, ...fields].join("；");
    if (words) return words;
    return typeof body?.message === "string" ? body.message : "";
  } catch {
    return text.slice(0, 300);
  }
}

function meOf(raw: any): JiraMe {
  return {
    accountId: typeof raw?.accountId === "string" ? raw.accountId : "",
    displayName: typeof raw?.displayName === "string" ? raw.displayName : "",
    email: typeof raw?.emailAddress === "string" ? raw.emailAddress : "",
    timezone: typeof raw?.timeZone === "string" ? raw.timeZone : "",
    avatarUrl: typeof raw?.avatarUrls?.["48x48"] === "string" ? raw.avatarUrls["48x48"] : "",
  };
}

/**
 * 发一个 GET 并把非 2xx 翻成统一的错误码（与 `me` 同一口径）；2xx 返回解析后的 JSON。
 * `notFound` 只在按 key 取单个对象时传入：列表接口上的 404 是桥自己拼错了路由，不算「工单不存在」。
 */
async function upstreamJson(config: JiraConfig, ctx: JiraCtx, path: string, notFound?: string): Promise<any> {
  const res = await fetchSite(config, ctx, path);
  if (!res.ok) {
    const message = await upstreamMessage(res);
    const tail = message ? `：${message}` : "";
    if (res.status === 401) throw new JiraError("jira_auth", 401, `Jira 不认这组凭据（401）${tail}`);
    if (res.status === 403) throw new JiraError("jira_forbidden", 403, `这组凭据没有权限（403）${tail}`);
    if (res.status === 404 && notFound) throw new JiraError("jira_not_found", 404, notFound);
    throw new JiraError("jira_upstream", 502, `Jira 回了 ${res.status}${tail}`);
  }
  return res.json().catch(() => null);
}

/** `GET /myself`：拿不到就抛（码与状态见上）。 */
async function myself(config: JiraConfig, ctx: JiraCtx): Promise<JiraMe> {
  return meOf(await upstreamJson(config, ctx, MYSELF));
}

function issueOf(raw: any): JiraIssue {
  const fields = raw?.fields;
  const name = (x: any): string => (typeof x?.name === "string" ? x.name : "");
  return {
    key: typeof raw?.key === "string" ? raw.key : "",
    summary: typeof fields?.summary === "string" ? fields.summary : "",
    type: name(fields?.issuetype),
    priority: typeof fields?.priority?.name === "string" ? fields.priority.name : null,
    status: name(fields?.status),
    assignee: personName(fields?.assignee),
    updated: typeof fields?.updated === "string" ? fields.updated : "",
  };
}

/**
 * 人员显示名：`displayName` 优先，隐私模式下 Jira 可能只给 `accountId`（此时用邮箱/账号兜底，
 * 总比一行空白强）。未分配是 `null`，回空串。
 */
function personName(raw: any): string {
  if (!raw || typeof raw !== "object") return "";
  if (typeof raw.displayName === "string" && raw.displayName) return raw.displayName;
  if (typeof raw.emailAddress === "string" && raw.emailAddress) return raw.emailAddress;
  return typeof raw.accountId === "string" ? raw.accountId : "";
}

function projectOf(raw: any): JiraProject {
  return {
    key: typeof raw?.key === "string" ? raw.key : "",
    name: typeof raw?.name === "string" ? raw.name : "",
  };
}

/** 固定 JQL + 固定字段：页面传的 `jql` / `fields` / `startAt` 一律被忽略。 */
async function listIssues(config: JiraConfig, ctx: JiraCtx): Promise<JiraIssue[]> {
  const query = new URLSearchParams({ jql: MY_OPEN_JQL, maxResults: String(LIST_MAX), fields: ISSUE_FIELDS });
  const raw = await upstreamJson(config, ctx, `${SEARCH}?${query}`);
  const list = Array.isArray(raw?.issues) ? raw.issues : [];
  return list
    .map(issueOf)
    .filter((issue: JiraIssue) => issue.key !== "")
    .slice(0, LIST_MAX);
}

async function listProjects(config: JiraConfig, ctx: JiraCtx): Promise<JiraProject[]> {
  const query = new URLSearchParams({ maxResults: String(LIST_MAX) });
  const raw = await upstreamJson(config, ctx, `${PROJECTS}?${query}`);
  const list = Array.isArray(raw?.values) ? raw.values : [];
  return list
    .map(projectOf)
    .filter((project: JiraProject) => project.key !== "")
    .slice(0, LIST_MAX);
}

// ---------------------------------------------------------------- #257 搜索

interface SearchOutcome {
  issues: JiraIssue[];
  nextPageToken?: string;
  isLast: boolean;
  degraded?: { watchers: true };
}

/** 上游状态 → 桥的错误码；`upstreamStatus` 留给关注者降级判断。 */
function searchError(status: number, message: string): JiraError {
  const tail = message ? `：${message}` : "";
  if (status === 400) return new JiraError("jira_query", 400, `Jira 不接受这条查询（400）${tail}`, 400);
  if (status === 401) return new JiraError("jira_auth", 401, `Jira 不认这组凭据（401）${tail}`, 401);
  if (status === 403) return new JiraError("jira_forbidden", 403, `这组凭据没有权限（403）${tail}`, 403);
  return new JiraError("jira_upstream", 502, `Jira 回了 ${status}${tail}`, status);
}

async function searchOnce(config: JiraConfig, ctx: JiraCtx, params: SearchParams): Promise<SearchOutcome> {
  const query = new URLSearchParams({
    jql: buildSearchJql(params),
    maxResults: String(SEARCH_PAGE_SIZE),
    fields: ISSUE_FIELDS,
  });
  if (params.nextPageToken !== undefined) query.set("nextPageToken", params.nextPageToken);
  const res = await fetchSite(config, ctx, `${SEARCH}?${query}`);
  if (!res.ok) throw searchError(res.status, await upstreamMessage(res));
  const body = (await res.json().catch(() => null)) as any;
  const raw = Array.isArray(body?.issues) ? body.issues : [];
  const issues = raw.map(issueOf).filter((x: JiraIssue) => x.key !== "").slice(0, SEARCH_PAGE_SIZE);
  const nextPageToken =
    typeof body?.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : undefined;
  // 新版 search/jql 不返回 total；拿不到 isLast 就按「没有下一页」推断。
  const isLast = body?.isLast === true || nextPageToken === undefined;
  return { issues, nextPageToken, isLast };
}

/**
 * 关注者降级：只有 watcher 被 400/403 拒绝时才去掉重试一次；只剩 watcher 就不重试
 * （去掉会变成无条件查询，结果悄悄变宽）。重试仍失败按第二次的错误往上抛。
 */
async function searchIssues(config: JiraConfig, ctx: JiraCtx, params: SearchParams): Promise<SearchOutcome> {
  const watcher = params.person !== undefined && params.relations.includes("watcher");
  try {
    return await searchOnce(config, ctx, params);
  } catch (err) {
    if (!watcher || !(err instanceof JiraError)) throw err;
    if (err.upstreamStatus !== 400 && err.upstreamStatus !== 403) throw err;
    const relations = params.relations.filter((x) => x !== "watcher");
    if (relations.length === 0) {
      throw new JiraError("jira_forbidden", 403, "这组凭据不能按关注者查询（需要 View Voters and Watchers 权限）");
    }
    const out = await searchOnce(config, ctx, { ...params, relations });
    return { ...out, degraded: { watchers: true } };
  }
}

function optionsOf(raw: any): { id: string; name: string }[] {
  return (Array.isArray(raw) ? raw : [])
    .map((x: any) => ({
      id: typeof x?.id === "string" ? x.id : "",
      name: typeof x?.name === "string" ? x.name : "",
    }))
    .filter((x: { name: string }) => x.name !== "");
}

/** 项目状态按「状态名」压平去重（同一状态会挂到多个工单类型下）。 */
function statusOptionsOf(raw: any): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const group of Array.isArray(raw) ? raw : []) {
    for (const s of Array.isArray(group?.statuses) ? group.statuses : []) {
      const name = typeof s?.name === "string" ? s.name : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ id: typeof s?.id === "string" ? s.id : "", name });
    }
  }
  return out;
}

async function loadMeta(config: JiraConfig, ctx: JiraCtx, project?: string): Promise<JiraSearchMeta> {
  const kind = `meta\n${project ?? ""}`;
  const cached = cacheGet<JiraSearchMeta>(kind, config, META_TTL_MS);
  if (cached) return cached;
  const [types, priorities] = await Promise.all([
    upstreamJson(config, ctx, TYPES),
    upstreamJson(config, ctx, PRIORITIES),
  ]);
  let statuses: { id: string; name: string }[] = [];
  let partial = false;
  if (project) {
    try {
      statuses = statusOptionsOf(
        await upstreamJson(config, ctx, `/rest/api/3/project/${encodeURIComponent(project)}/statuses`),
      );
    } catch (err) {
      // 项目状态取不到只降级这一块：类型/优先级仍然可用。
      if (!(err instanceof JiraError)) throw err;
      partial = true;
    }
  }
  const value: JiraSearchMeta = {
    statusCategories: [...STATUS_CATEGORY_KEYS],
    types: optionsOf(types),
    priorities: optionsOf(priorities),
    statuses,
    partial,
  };
  // statuses 失败时只缓存「完整」的响应：partial 进缓存会让下一次也看不到状态。
  if (!partial) cachePut(kind, config, value);
  return value;
}

/** 返回 null 表示上游不让我们搜人（401/403），由路由回 `unavailable`，不报错。 */
async function loadUsers(config: JiraConfig, ctx: JiraCtx, q: string): Promise<JiraUser[] | null> {
  const query = new URLSearchParams({ query: q, maxResults: String(SEARCH_PAGE_SIZE) });
  let raw: any;
  try {
    raw = await upstreamJson(config, ctx, `${USERS}?${query}`);
  } catch (err) {
    if (err instanceof JiraError && err.code === "jira_forbidden") return null;
    throw err;
  }
  return (Array.isArray(raw) ? raw : [])
    .map((x: any) => ({
      accountId: typeof x?.accountId === "string" ? x.accountId : "",
      displayName: personName(x),
      emailAddress: typeof x?.emailAddress === "string" ? x.emailAddress : "",
    }))
    .filter((x: JiraUser) => x.accountId !== "")
    .slice(0, SEARCH_PAGE_SIZE);
}

async function getSearch(res: http.ServerResponse, ctx: JiraCtx, query: URLSearchParams): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  let params: SearchParams;
  try {
    params = parseSearchParams(query);
  } catch (err) {
    if (err instanceof SearchQueryError) return fail(res, 400, err.code, err.message);
    throw err;
  }
  return json(res, 200, { ok: true, ...(await searchIssues(config, ctx, params)) });
}

async function getMeta(res: http.ServerResponse, ctx: JiraCtx, project?: string): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  const key = (project ?? "").trim() || undefined;
  return json(res, 200, { ok: true, ...(await loadMeta(config, ctx, key)) });
}

async function getUsers(res: http.ServerResponse, ctx: JiraCtx, raw?: string): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  const q = (raw ?? "").trim();
  if (!q) return json(res, 200, { ok: true, users: [] });
  if (q.length > 200) return fail(res, 400, "jira_query", "搜索词最多 200 个字符");
  const users = await loadUsers(config, ctx, q);
  if (users === null) return json(res, 200, { ok: true, users: [], unavailable: true });
  return json(res, 200, { ok: true, users });
}

// ---------------------------------------------------------------- #250 详情

/** 工单 key 的形状校验（不是权限校验：能看哪个工单由固定站点 + 用户 token 决定）。 */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
const DETAIL_FIELDS = "summary,description,issuetype,priority,status,updated,attachment";
const COMMENT_PAGE = 100;

function attachmentOf(raw: any): JiraAttachment | null {
  const id = typeof raw?.id === "string" ? raw.id : "";
  if (!id) return null;
  return {
    id,
    filename: typeof raw?.filename === "string" ? raw.filename : "",
    // 上游可能省掉 size：页面要能区分「未知」与 0 字节。
    size: typeof raw?.size === "number" && Number.isFinite(raw.size) ? raw.size : null,
    author: typeof raw?.author?.displayName === "string" ? raw.author.displayName : "",
    created: typeof raw?.created === "string" ? raw.created : "",
  };
}

/** ADF 里 `media` / `mediaSingle` 节点就是评论附件：只挖 `attrs.id`，正文一个字段都不带出去。 */
function mediaOf(node: any, out: { id: string; filename: string }[]): void {
  if (!node || typeof node !== "object") return;
  const type = typeof node.type === "string" ? node.type : "";
  if (type === "media" || type === "mediaSingle" || type === "mediaInline") {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id.trim() : "";
    if (id) {
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt.trim() : "";
      const title = typeof node.attrs?.title === "string" ? node.attrs.title.trim() : "";
      out.push({ id, filename: alt || title || "附件" });
    }
  }
  if (Array.isArray(node.content)) for (const child of node.content) mediaOf(child, out);
}

/**
 * 评论只为附件而取：遍历每条评论的 ADF body 收 media 节点，按 id 去重。
 * 评论正文 / 作者以外的字段一律不进入返回值 —— 这是 #250 的接口边界，别顺手透传。
 */
function commentAttachments(raw: any): JiraAttachment[] {
  const comments = Array.isArray(raw?.comments) ? raw.comments : [];
  const seen = new Set<string>();
  const out: JiraAttachment[] = [];
  for (const comment of comments) {
    const media: { id: string; filename: string }[] = [];
    mediaOf(comment?.body, media);
    for (const item of media) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        filename: item.filename,
        size: null,
        author: typeof comment?.author?.displayName === "string" ? comment.author.displayName : "",
        created: typeof comment?.created === "string" ? comment.created : "",
      });
    }
  }
  return out;
}

/**
 * 取单工单的详情数据：issue 字段 + 评论 media 两段附件。详情接口与 #251 的「下载全部」共用
 * 这一份取出逻辑 —— 下载要的附件清单必须与页面上看到的一致。
 */
async function loadDetail(config: JiraConfig, ctx: JiraCtx, key: string): Promise<JiraIssueDetail> {
  const rawIssue = await upstreamJson(
    config,
    ctx,
    `/rest/api/3/issue/${key}?fields=${DETAIL_FIELDS}`,
    "Jira 上没有这个工单",
  );
  const rawComments = await upstreamJson(
    config,
    ctx,
    `/rest/api/3/issue/${key}/comment?maxResults=${COMMENT_PAGE}`,
    "Jira 上没有这个工单",
  );

  const base = issueOf(rawIssue);
  const list = Array.isArray(rawIssue?.fields?.attachment) ? rawIssue.fields.attachment : [];
  return {
    issue: {
      ...base,
      key: base.key || key,
      description: rawIssue?.fields?.description ?? null,
    },
    attachments: {
      issue: list.map(attachmentOf).filter((item: JiraAttachment | null): item is JiraAttachment => item !== null),
      comments: commentAttachments(rawComments),
    },
  };
}

/**
 * `GET /api/jira/issues/:key`：单工单详情。不做缓存（D204）——点开才要，重复点开由前端记忆。
 * 评论接口失败就整个详情按该错误码失败：附件清单本来就是详情的一部分，静默吞掉会让界面
 * 假装「这条工单没有评论附件」，比报错更容易误导人。
 */
async function getIssueDetail(res: http.ServerResponse, ctx: JiraCtx, rawKey: string): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  if (!ISSUE_KEY.test(rawKey)) return fail(res, 400, "jira_key", "工单号看起来不对（应为 ACME-123 这种）");
  return json(res, 200, await loadDetail(config, ctx, rawKey.toUpperCase()));
}

// ---------------------------------------------------------------- #251 下载全部附件

interface AttachmentRootFile {
  root?: unknown;
}

function attachmentsFile(): string {
  return statePath("jira", "attachments.json");
}

/**
 * 附件根目录单独存在 `state/jira/attachments.json`，不并进含 token 的 config.json（D205）：
 * 换凭据时目录不该跟着丢，排查时导出状态文件也不该顺手把 token 带出去。
 */
export function readAttachmentRoot(): string | null {
  const { ok, value } = readJsonChecked<AttachmentRootFile | null>(attachmentsFile(), null);
  if (!ok || !value || typeof value !== "object") return null;
  const root = typeof value.root === "string" ? value.root.trim() : "";
  return root ? root : null;
}

/** 相对路径在桥里的含义是「桥进程的 cwd」，不是用户想的地方：只收绝对路径。 */
export function attachmentRootProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return "请填一个附件目录";
  if (/^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith("/")) return null;
  return "附件目录要填绝对路径（例如 D:\\jira 或 /home/me/jira）";
}

function writeAttachmentRoot(root: string): void {
  ensureDir(statePath("jira"));
  const file = attachmentsFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ root }, null, 2));
  fs.renameSync(tmp, file);
}

function getAttachmentRoot(res: http.ServerResponse): void {
  json(res, 200, { root: readAttachmentRoot() });
}

async function saveAttachmentRoot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => null);
  const root = typeof body?.root === "string" ? body.root.trim() : "";
  const problem = attachmentRootProblem(root);
  if (problem) return fail(res, 400, "jira_root", problem);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return fail(res, 400, "jira_root", `这个目录建不出来：${(err as Error)?.message ?? err}`);
  }
  writeAttachmentRoot(root);
  json(res, 200, { ok: true, root });
}

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_CHARS = 120;

/** 拆主名与扩展名；`a.` / `a.b.c` / 超长“扩展名”（其实不是扩展名）都当没扩展名。 */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return [name, ""];
  const ext = name.slice(dot);
  if (ext.length > 20) return [name, ""];
  return [name.slice(0, dot), ext];
}

function fitStem(stem: string, ext: string): string {
  const room = Math.max(1, MAX_NAME_CHARS - ext.length);
  return stem.length > room ? stem.slice(0, room) : stem;
}

/**
 * 跨平台文件名清洗（D205）：非法字符与控制字符换成 `_`，去首尾空白与结尾的点，
 * Windows 保留名前加 `_`，空名回 `attachment-<id>`，长度截到 ~120 且保留扩展名。
 */
export function safeFileName(name: string, id: string): string {
  const idText = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "") || "0";
  // 路径分隔符也在这张表里：它们是「不能出现在文件名里」的字符，不是目录，整段换成 `_`。
  let base = String(name ?? "").replace(ILLEGAL_NAME_CHARS, "_");
  base = base.replace(/^\s+/, "").replace(/[\s.]+$/, "");
  if (!base) return `attachment-${idText}`;
  const [stem, ext] = splitExt(base);
  const reserved = WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem;
  return `${fitStem(reserved, ext) || "attachment"}${ext}`;
}

/** 同批重名：`report.pdf` + id `att-2` → `report-att-2.pdf`。 */
function namedWithId(name: string, id: string): string {
  const suffix = String(id).replace(/[^A-Za-z0-9._-]/g, "") || "x";
  const [stem, ext] = splitExt(name);
  return `${fitStem(`${stem}-${suffix}`, ext)}${ext}`;
}

/** 同批重名才加 id；磁盘上已存在就覆盖 —— 重下同一附件不堆副本（D205）。 */
function uniqueName(name: string, id: string, used: Map<string, string>): string {
  const key = name.toLowerCase();
  const taken = used.get(key);
  if (taken !== undefined && taken !== id) {
    const alt = namedWithId(name, id);
    used.set(alt.toLowerCase(), id);
    return alt;
  }
  used.set(key, id);
  return name;
}

/**
 * media uuid → attachment id 的探测结果。ADF 里 `media` 节点的 `attrs.id` 是 media services 的
 * uuid，不是 attachment id（D205）；只有评论 media 且直接取 404 时才探测，结果按 attachment id 记在
 * 内存里，别每次详情都全量探测。
 */
const mediaUuidByAttachment = new Map<string, string>();

async function probeMediaUuid(config: JiraConfig, ctx: JiraCtx, attachmentId: string): Promise<string> {
  const cached = mediaUuidByAttachment.get(attachmentId);
  if (cached !== undefined) return cached;
  let uuid = "";
  try {
    const res = await fetchSite(config, ctx, `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`);
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      const found = /\/file\/([^/?#]+)\/binary/.exec(location);
      if (found) uuid = decodeURIComponent(found[1]);
    }
  } catch {
    uuid = "";
  }
  mediaUuidByAttachment.set(attachmentId, uuid);
  return uuid;
}

async function attachmentIdForMedia(
  config: JiraConfig,
  ctx: JiraCtx,
  mediaId: string,
  issueAttachments: JiraAttachment[],
): Promise<string | null> {
  for (const att of issueAttachments) {
    if (att.id === mediaId) return att.id;
    if ((await probeMediaUuid(config, ctx, att.id)) === mediaId) return att.id;
  }
  return null;
}

/**
 * 第二跳（附件内容 302 到 Media 签名 URL）：只认 https 且 host 是配置站点或 `*.atl-paas.net`，
 * 且不带 userinfo / 非 443 端口 / fragment；跟随时**不带 Authorization**（D205）。
 */
export function attachmentRedirectAllowed(raw: string, siteUrl: string): boolean {
  let target: URL;
  let site: URL;
  try {
    target = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "https:") return false;
  if (target.username || target.password) return false;
  if (target.port && target.port !== "443") return false;
  if (target.hash) return false;
  if (target.origin === site.origin) return true;
  const host = target.hostname.toLowerCase();
  return host === "atl-paas.net" || host.endsWith(".atl-paas.net");
}

function redirectAllowed(config: JiraConfig, ctx: JiraCtx, raw: string): boolean {
  // 测试缝：假 Jira 是 http://127.0.0.1，只认它自己那一跳。
  if (ctx.upstream) {
    try {
      return new URL(raw).origin === new URL(ctx.upstream).origin;
    } catch {
      return false;
    }
  }
  return attachmentRedirectAllowed(raw, config.siteUrl);
}

type ContentHit = { res: Response } | { reason: string; missing: boolean };

/** 取附件内容；第一跳手动跟随，第二跳不带 Authorization（签名 URL 自带凭据）。 */
async function fetchContent(
  config: JiraConfig,
  ctx: JiraCtx,
  id: string,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<ContentHit> {
  const path = `/rest/api/3/attachment/content/${encodeURIComponent(id)}`;
  let res: Response;
  try {
    res = await fetchSite(config, ctx, path, timeoutMs);
  } catch (err) {
    return { reason: err instanceof JiraError ? err.message : "取不到附件内容", missing: false };
  }
  if (res.ok) return { res };
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    await res.body?.cancel().catch(() => undefined);
    if (!location) return { reason: "附件跳转没有给地址", missing: false };
    let target: URL;
    try {
      target = new URL(location, `${upstreamBase(config, ctx)}/`);
    } catch {
      return { reason: "附件跳转地址看不懂", missing: false };
    }
    if (!redirectAllowed(config, ctx, target.href)) return { reason: "附件跳转到不允许的地址", missing: false };
    try {
      // 故意不带 Authorization：目标 host 不是 Jira，凭据不能跟着签名 URL 跑。
      const next = await requestJira(config, target, (u) => u.href === target.href, timeoutMs, false);
      if (!next.ok) {
        await next.body?.cancel().catch(() => undefined);
        return { reason: `取不到附件内容（${next.status}）`, missing: false };
      }
      return { res: next };
    } catch {
      return { reason: "连不上附件地址", missing: false };
    }
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404) return { reason: "找不到对应附件", missing: true };
  return { reason: `取不到附件内容（${res.status}）`, missing: false };
}

type SaveOutcome = { status: "saved" } | { status: "skipped" | "failed"; reason: string };

/** 落盘；Content-Length 超限直接跳过，没有 Content-Length 就边写边数，超了删半截文件。 */
async function saveResponse(res: Response, file: string): Promise<SaveOutcome> {
  const limit = `${MAX_DOWNLOAD / 1024 / 1024} MB`;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) {
    await res.body?.cancel().catch(() => undefined);
    return { status: "skipped", reason: `超过 ${limit}，跳过` };
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "w");
  } catch (err) {
    await res.body?.cancel().catch(() => undefined);
    return { status: "failed", reason: `写不了这个文件：${(err as Error)?.message ?? err}` };
  }
  let total = 0;
  let tooBig = false;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_DOWNLOAD) {
          tooBig = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        await handle.write(chunk);
      }
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    fs.rmSync(file, { force: true });
    return { status: "failed", reason: `下载中断：${(err as Error)?.message ?? err}` };
  }
  await handle.close().catch(() => undefined);
  if (tooBig) {
    fs.rmSync(file, { force: true });
    return { status: "skipped", reason: `超过 ${limit}，跳过` };
  }
  return { status: "saved" };
}

export interface JiraDownloadItem {
  id: string;
  filename: string;
  path: string;
  status: "saved" | "skipped" | "failed";
  reason?: string;
}

export interface JiraDownloadResult {
  dir: string;
  items: JiraDownloadItem[];
}

async function saveOne(
  config: JiraConfig,
  ctx: JiraCtx,
  dir: string,
  att: JiraAttachment,
  fromComments: boolean,
  issueAttachments: JiraAttachment[],
  used: Map<string, string>,
): Promise<JiraDownloadItem> {
  const name = uniqueName(safeFileName(att.filename, att.id), att.id, used);
  const file = join(dir, name);
  const item = (status: JiraDownloadItem["status"], reason?: string): JiraDownloadItem =>
    reason
      ? { id: att.id, filename: name, path: file, status, reason }
      : { id: att.id, filename: name, path: file, status };
  if (typeof att.size === "number" && att.size > MAX_DOWNLOAD) {
    return item("skipped", `超过 ${MAX_DOWNLOAD / 1024 / 1024} MB，跳过`);
  }
  let hit = await fetchContent(config, ctx, att.id);
  if (!("res" in hit) && fromComments && hit.missing) {
    // 评论里贴的图是 media uuid，不是 attachment id：对上了就重试。
    const mapped = await attachmentIdForMedia(config, ctx, att.id, issueAttachments);
    if (mapped) hit = await fetchContent(config, ctx, mapped);
  }
  if (!("res" in hit)) return item(fromComments && hit.missing ? "skipped" : "failed", hit.reason);
  const saved = await saveResponse(hit.res, file);
  return saved.status === "saved" ? item("saved") : item(saved.status, saved.reason);
}

/**
 * `POST /api/jira/issues/:key/download`：串行落盘到 `<root>/<KEY>/`。没设根目录就直接 400，
 * 一个字节都不写；批量里单项失败不影响整单 200（D205）。
 */
async function downloadIssueAttachments(res: http.ServerResponse, ctx: JiraCtx, rawKey: string): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  if (!ISSUE_KEY.test(rawKey)) return fail(res, 400, "jira_key", "工单号看起来不对（应为 ACME-123 这种）");
  const key = rawKey.toUpperCase();
  const root = readAttachmentRoot();
  if (!root) return fail(res, 400, "need_root", "还没设置附件目录");
  const detail = await loadDetail(config, ctx, key);
  const dir = join(root, key);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return fail(res, 400, "jira_root", `附件目录建不出来：${(err as Error)?.message ?? err}`);
  }
  const used = new Map<string, string>();
  const queue = [
    ...detail.attachments.issue.map((att) => ({ att, fromComments: false })),
    ...detail.attachments.comments.map((att) => ({ att, fromComments: true })),
  ];
  const items: JiraDownloadItem[] = [];
  // 串行：一次一个文件，别把桥与 Jira 的连接池打满。
  for (const { att, fromComments } of queue) {
    items.push(await saveOne(config, ctx, dir, att, fromComments, detail.attachments.issue, used));
  }
  json(res, 200, { dir, items });
}

/**
 * `GET /api/jira/issues/:key/downloaded`：这单在本机已经下过几个文件（D206）。只读磁盘，
 * 不建目录、不拉 Jira；没设根目录 / 目录不存在 / 空目录都回 `{ dir: null, count: 0 }`。
 * 隧道访客也能读：这只是「有没有下过」的事实，不含凭据。
 */
function getDownloaded(res: http.ServerResponse, rawKey: string): void {
  if (!ISSUE_KEY.test(rawKey)) return fail(res, 400, "jira_key", "工单号看起来不对（应为 ACME-123 这种）");
  const key = rawKey.toUpperCase();
  const root = readAttachmentRoot();
  if (!root) return json(res, 200, { dir: null, count: 0 });
  const dir = join(root, key);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return json(res, 200, { dir: null, count: 0 });
  }
  // 只数普通文件：子目录（用户自己整理的）不算下载结果。
  const count = entries.filter((entry) => entry.isFile()).length;
  return json(res, 200, count > 0 ? { dir, count } : { dir: null, count: 0 });
}

/** 列表接口的公共前半段：读配置，没配就说 `jira_not_configured`。 */
function listConfig(res: http.ServerResponse): JiraConfig | null {
  const config = readJiraConfig();
  if (!config) {
    fail(res, 400, "jira_not_configured", "还没连接 Jira");
    return null;
  }
  return config;
}

async function getIssues(res: http.ServerResponse, ctx: JiraCtx, refresh: boolean): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  const cached = refresh ? null : cacheGet<JiraIssue[]>("issues", config);
  if (cached) return json(res, 200, { issues: cached });
  const issues = await listIssues(config, ctx);
  cachePut("issues", config, issues);
  return json(res, 200, { issues });
}

async function getProjects(res: http.ServerResponse, ctx: JiraCtx, refresh: boolean): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  const cached = refresh ? null : cacheGet<JiraProject[]>("projects", config);
  if (cached) return json(res, 200, { projects: cached });
  const projects = await listProjects(config, ctx);
  cachePut("projects", config, projects);
  return json(res, 200, { projects });
}

// ---------------------------------------------------------------- HTTP 小件

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, error: string): void {
  json(res, status, { error, code });
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- 路由

async function saveConfig(req: http.IncomingMessage, res: http.ServerResponse, ctx: JiraCtx): Promise<void> {
  const body = await readJsonBody(req).catch(() => null);
  const rawSite = typeof body?.siteUrl === "string" ? body.siteUrl : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const problem = siteUrlProblem(rawSite);
  if (problem) return fail(res, 400, "jira_site", problem);
  if (!email) return fail(res, 400, "jira_input", "请填 Jira 账号邮箱");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, "jira_input", "邮箱看起来不对");
  if (!apiKey) return fail(res, 400, "jira_input", "请填 API token");

  const config: JiraConfig = { siteUrl: normalizeSiteUrl(rawSite), email, apiKey };
  // 先拿真凭据问一次 `/myself`：失败就到此为止，磁盘上不留半套配置。
  const me = await myself(config, ctx);
  writeJiraConfig(config);
  return json(res, 200, { ok: true, me });
}

async function getMe(res: http.ServerResponse, ctx: JiraCtx): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  return json(res, 200, await myself(config, ctx));
}

async function getAvatar(res: http.ServerResponse, ctx: JiraCtx): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  try {
    const me = await myself(config, ctx);
    if (!me.avatarUrl || !avatarAllowed(config, ctx, me.avatarUrl)) {
      return fail(res, 502, "jira_avatar", "这个头像地址不在允许范围");
    }
    const upstream = await requestJira(config, new URL(me.avatarUrl), (u) => avatarAllowed(config, ctx, u.href));
    if (!upstream.ok) return fail(res, 502, "jira_avatar", `取头像失败（${upstream.status}）`);
    const type = upstream.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("image/")) return fail(res, 502, "jira_avatar", "Jira 回的不是图片");
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": bytes.length });
    res.end(bytes);
  } catch {
    // 页面在头像失败时静默退回首字母；这边不把上游的 401/403 透出去，免得头像请求看起来像登录失败。
    return fail(res, 502, "jira_avatar", "取不到 Jira 头像");
  }
}

/**
 * 处理 `/api/jira/*`；返回 true 表示这个请求归它管（调用方直接 return）。
 * 只读的 GET 对隧道访客照常，写操作 403 —— 凭据只能在本机改。
 */
export async function handleJira(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: JiraCtx,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/jira/")) return false;
  const method = req.method ?? "GET";
  try {
    if (url.pathname === "/api/jira/config") {
      if (method === "GET") {
        const config = readJiraConfig();
        json(res, 200, {
          configured: config !== null,
          siteUrl: config?.siteUrl ?? "",
          email: config?.email ?? "",
          keyMask: config ? keyMask(config.apiKey) : "",
        });
        return true;
      }
      if (method === "PUT" || method === "DELETE") {
        if (ctx.publicReq) {
          fail(res, 403, "tunnel_readonly", "回本机操作");
          return true;
        }
        if (method === "PUT") {
          await saveConfig(req, res, ctx);
        } else {
          clearJiraConfig();
          json(res, 200, { ok: true });
        }
        return true;
      }
      fail(res, 405, "bad_method", "不支持这个请求方法");
      return true;
    }
    if (url.pathname === "/api/jira/me" || url.pathname === "/api/jira/me/avatar") {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      if (url.pathname === "/api/jira/me") await getMe(res, ctx);
      else await getAvatar(res, ctx);
      return true;
    }
    if (url.pathname === "/api/jira/search" || url.pathname === "/api/jira/meta" || url.pathname === "/api/jira/users") {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      // #257：搜索 / 表单元数据 / 人员搜索。只读，隧道访客照常。
      if (url.pathname === "/api/jira/search") await getSearch(res, ctx, url.searchParams);
      else if (url.pathname === "/api/jira/meta") await getMeta(res, ctx, url.searchParams.get("project") ?? undefined);
      else await getUsers(res, ctx, url.searchParams.get("q") ?? undefined);
      return true;
    }
    if (url.pathname === "/api/jira/issues" || url.pathname === "/api/jira/projects") {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      // 只认 `refresh`；`jql` / `fields` / `startAt` 这类参数一律不读（D203）。
      const refresh = url.searchParams.get("refresh") === "1";
      if (url.pathname === "/api/jira/issues") await getIssues(res, ctx, refresh);
      else await getProjects(res, ctx, refresh);
      return true;
    }
    // #251：附件根目录。读不限制，写（含建目录）只在桥本机做，隧道访客一律 403。
    if (url.pathname === "/api/jira/attachments/root") {
      if (method === "GET") {
        getAttachmentRoot(res);
        return true;
      }
      if (method === "PUT") {
        if (ctx.publicReq) {
          fail(res, 403, "tunnel_readonly", "回本机操作");
          return true;
        }
        await saveAttachmentRoot(req, res);
        return true;
      }
      fail(res, 405, "bad_method", "不支持这个请求方法");
      return true;
    }
    // #250：`/api/jira/issues/<KEY>`。key 不在 URL 里解码：形状校验只认 `[A-Za-z0-9_-]`。
    if (url.pathname.startsWith("/api/jira/issues/")) {
      const rest = url.pathname.slice("/api/jira/issues/".length);
      // #252：`GET /api/jira/issues/<KEY>/downloaded`。只读磁盘，隧道访客也能问。
      if (rest.endsWith("/downloaded")) {
        if (method !== "GET") {
          fail(res, 405, "bad_method", "不支持这个请求方法");
          return true;
        }
        getDownloaded(res, rest.slice(0, -"/downloaded".length));
        return true;
      }
      // #251：`POST /api/jira/issues/<KEY>/download`。写磁盘，隧道访客同样 403。
      if (rest.endsWith("/download")) {
        if (method !== "POST") {
          fail(res, 405, "bad_method", "不支持这个请求方法");
          return true;
        }
        if (ctx.publicReq) {
          fail(res, 403, "tunnel_readonly", "回本机操作");
          return true;
        }
        await downloadIssueAttachments(res, ctx, rest.slice(0, -"/download".length));
        return true;
      }
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      await getIssueDetail(res, ctx, rest);
      return true;
    }
    fail(res, 404, "not_found", "没有这个接口");
    return true;
  } catch (err) {
    if (err instanceof JiraError) {
      // PUT 的失败一律 400（页面只关心「保存没成功」，401/403 的语义留给 GET me）。
      fail(res, req.method === "PUT" ? 400 : err.status, err.code, err.message);
    } else {
      fail(res, 500, "jira_internal", "Jira 面板处理失败");
    }
    return true;
  }
}
