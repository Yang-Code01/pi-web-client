/**
 * Jira 面板（#248、#249）的桥端：一个站点、一组凭据、只读。
 *
 * 三条边界，改之前先看 D201：
 * - 页面永远拿不到 API token：GET 只回掩码，错误文本与日志里也不带它；
 * - 出站只发配置里的那个站点（`/rest/api/3/*`），头像额外允许 Atlassian 头像 CDN；
 * - 隧道访客只读：保存 / 清除凭据一律 403「回本机操作」。
 *
 * 自包含：`json()` / `fail()` / body 解析都写在本地，不 import index 的私有函数（index 反过来
 * import 这里，共用会成环）。测试可以把 `handleJira` 挂到一个最小 `http.createServer` 上。
 */
import fs from "node:fs";
import http from "node:http";
import { ensureDir, readJsonChecked, statePath } from "./paths.ts";

const TIMEOUT_MS = 15000;
const MYSELF = "/rest/api/3/myself";
// #249：新的 JQL 端点（老的 `/rest/api/3/search` 正被 Atlassian 下线）与项目列表。
const SEARCH = "/rest/api/3/search/jql";
const PROJECTS = "/rest/api/3/project/search";
const MAX_BODY = 64 * 1024;

/** 页面传不了查询：JQL 与字段都在桥里写死（D202）。 */
const MY_OPEN_JQL = "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const ISSUE_FIELDS = "summary,issuetype,priority,status,updated";
const LIST_MAX = 20;
/** 列表缓存 60 秒：面板反复开关时别把 Jira 的限流额度打满。只存内存，不落盘（D202）。 */
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
  updated: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

/** 详情里的一条附件：大小 / 作者未知时分别是 `null` / 空串（评论 media 节点拿不到这些）。 */
export interface JiraAttachment {
  id: string;
  filename: string;
  size: number | null;
  author: string;
  created: string;
}

/** #250：`description` 是上游 ADF 原样透传，桥不解释它（D203）。 */
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
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
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
 * 站点地址的毛病（中文原因）或 null。桥侧是权威校验，页面 `web/src/jira.ts` 有一份同口径的
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
 * 头像 URL 允许名单（D201）：与配置站点同 origin，或 Atlassian 自己的头像 CDN。
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

function cacheGet<T>(kind: string, config: JiraConfig): T | null {
  const hit = listCache.get(cacheKey(kind, config));
  if (!hit) return null;
  if (Date.now() - hit.at > LIST_TTL_MS) {
    listCache.delete(cacheKey(kind, config));
    return null;
  }
  return hit.value as T;
}

function cachePut<T>(kind: string, config: JiraConfig, value: T): void {
  listCache.set(cacheKey(kind, config), { at: Date.now(), value });
}

/** 保存 / 清除凭据时清空：旧凭据名下的列表不再可信（D202）。 */
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
): Promise<Response> {
  if (!allowed(target)) throw new JiraError("jira_site", 400, "只允许访问配置的 Jira 站点");
  const headers = new Headers();
  headers.set("authorization", basicAuth(config));
  headers.set("accept", "application/json");
  try {
    return await fetch(target, {
      headers,
      // 不跟随重定向：3xx 直接当失败，别让一次 302 把 Basic 凭据带去第三个域名。
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new JiraError("jira_network", 502, timedOut ? "Jira 15 秒内没有响应" : `连不上 Jira：${e?.message ?? e}`);
  }
}

/** 只发配置站点：拼出来的 URL 再断言一次 origin。 */
async function fetchSite(config: JiraConfig, ctx: JiraCtx, path: string): Promise<Response> {
  const base = upstreamBase(config, ctx);
  let baseUrl: URL;
  let target: URL;
  try {
    baseUrl = new URL(base);
    target = new URL(path, `${base}/`);
  } catch {
    throw new JiraError("jira_site", 400, "配置的 Jira 站点地址无效");
  }
  return requestJira(config, target, (u) => u.origin === baseUrl.origin);
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
    updated: typeof fields?.updated === "string" ? fields.updated : "",
  };
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
 * `GET /api/jira/issues/:key`：单工单详情。不做缓存（D203）——点开才要，重复点开由前端记忆。
 * 评论接口失败就整个详情按该错误码失败：附件清单本来就是详情的一部分，静默吞掉会让界面
 * 假装「这条工单没有评论附件」，比报错更容易误导人。
 */
async function getIssueDetail(res: http.ServerResponse, ctx: JiraCtx, rawKey: string): Promise<void> {
  const config = listConfig(res);
  if (!config) return;
  if (!ISSUE_KEY.test(rawKey)) return fail(res, 400, "jira_key", "工单号看起来不对（应为 ACME-123 这种）");
  const key = rawKey.toUpperCase();

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
  const detail: JiraIssueDetail = {
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
  return json(res, 200, detail);
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
  const config = readJiraConfig();
  if (!config) return fail(res, 400, "jira_not_configured", "还没连接 Jira");
  return json(res, 200, await myself(config, ctx));
}

async function getAvatar(res: http.ServerResponse, ctx: JiraCtx): Promise<void> {
  const config = readJiraConfig();
  if (!config) return fail(res, 400, "jira_not_configured", "还没连接 Jira");
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
    if (url.pathname === "/api/jira/issues" || url.pathname === "/api/jira/projects") {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      // 只认 `refresh`；`jql` / `fields` / `startAt` 这类参数一律不读（D202）。
      const refresh = url.searchParams.get("refresh") === "1";
      if (url.pathname === "/api/jira/issues") await getIssues(res, ctx, refresh);
      else await getProjects(res, ctx, refresh);
      return true;
    }
    // #250：`/api/jira/issues/<KEY>`。key 不在 URL 里解码：形状校验只认 `[A-Za-z0-9_-]`。
    if (url.pathname.startsWith("/api/jira/issues/")) {
      if (method !== "GET") {
        fail(res, 405, "bad_method", "不支持这个请求方法");
        return true;
      }
      await getIssueDetail(res, ctx, url.pathname.slice("/api/jira/issues/".length));
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
