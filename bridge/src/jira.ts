/**
 * Jira 面板（#248）的桥端：一个站点、一组凭据、只读。
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
const MAX_BODY = 64 * 1024;

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
  fs.rmSync(configFile(), { force: true });
  fs.rmSync(`${configFile()}.tmp`, { force: true });
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

/** `GET /myself`：拿不到就抛（码与状态见上）。 */
async function myself(config: JiraConfig, ctx: JiraCtx): Promise<JiraMe> {
  const res = await fetchSite(config, ctx, MYSELF);
  if (!res.ok) {
    const message = await upstreamMessage(res);
    const tail = message ? `：${message}` : "";
    if (res.status === 401) throw new JiraError("jira_auth", 401, `Jira 不认这组凭据（401）${tail}`);
    if (res.status === 403) throw new JiraError("jira_forbidden", 403, `这组凭据没有权限（403）${tail}`);
    throw new JiraError("jira_upstream", 502, `Jira 回了 ${res.status}${tail}`);
  }
  const raw = await res.json().catch(() => null);
  return meOf(raw);
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
