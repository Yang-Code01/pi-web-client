/**
 * Microsoft OAuth2：设备码登录 + 令牌刷新（Outlook 个人账号与 Microsoft 365 的 IMAP/SMTP 都走这里）。
 *
 * 为什么是设备码（device authorization grant）而不是「浏览器回调」：回调地址必须先在 Entra 应用里
 * 登记成重定向 URI，本机端口还会变；设备码一个重定向都不要，用户点「用 Microsoft 登录」后到
 * microsoft.com/devicelogin 输 8 位码即可。公司机器上弹出的还是管理员管的那个浏览器会话 ——
 * 用户能在自己电脑上自己完成，我们不用碰他的浏览器 cookie。
 *
 * 这一层的边界：只说网络与时钟。令牌落盘在 `mailconfig.ts` 的 `saveOAuthTokens()`；判定谁能用
 * 邮箱在 `mailconfig.ts` 的 `policyDenial()`。令牌值不写日志、不出页面（`publicAccount()` 只给 hasToken）。
 *
 * `fetcher` 参数只为测试注入；生产调用不传，用全局 `fetch`。
 */
import { saveOAuthTokens, clearOAuthTokens } from "./mailconfig.ts";
import type { MailAccount, MailOAuth } from "./mailconfig.ts";
import { MailError } from "./mailtransport.ts";

/** IMAP + SMTP 的委派权限；`offline_access` 才给 refresh token，`openid profile email` 用来认「登录成了谁」。 */
export const M365_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
].join(" ");

const AUTH_HOST = "https://login.microsoftonline.com";
/** 提前这么久就换新令牌：一次读信可能要几分钟，别拿一个马上过期的去连。 */
const REFRESH_MARGIN_MS = 90_000;
/** 微软要求的轮询间隔下限（秒）；问得太快会让整个设备码失效。 */
const MIN_INTERVAL_S = 2;

type Fetcher = typeof fetch;

interface Pending {
  clientId: string;
  tenant: string;
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}

/** 一个账号同时只允许一次设备码登录；重启 bridge 就丢，页面重新点一次即可。 */
const pending = new Map<string, Pending>();

export interface OAuthLogin {
  /** 面板上给用户抄的 8 位码。 */
  userCode: string;
  verificationUri: string;
  /** 码什么时候过期（毫秒时间戳）—— 页面据此停掉轮询。 */
  expiresAt: number;
  /** 下一次可以问的时间（毫秒时间戳）。 */
  nextPollAt: number;
  intervalMs: number;
  /** 微软给的整句提示（已含「打开某网址、输入某码」）。 */
  message: string;
}

export type OAuthPoll = { status: "pending"; waitMs: number } | { status: "done"; upn: string } | { status: "expired" };

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  upn: string;
}

function endpoint(tenant: string, tail: string): string {
  return `${AUTH_HOST}/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/${tail}`;
}

async function postForm(url: string, form: Record<string, string>, fetcher: Fetcher): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    throw new MailError("net", `连不上 Microsoft 登录服务：${err?.message ?? err}`, "检查网络（或代理）后重试。");
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** 令牌端点失败的样子：`error` 是稳定短码，`error_description` 是 AADSTS 那一长串。 */
function oauthFailure(status: number, body: any): MailError {
  const err = String(body?.error ?? "");
  const desc = String(body?.error_description ?? "").split(/\r?\n/)[0];
  const detail = `${err || `HTTP ${status}`}${desc ? `：${desc.slice(0, 300)}` : ""}`;
  if (err === "invalid_client" || err === "unauthorized_client" || /AADSTS700016|AADSTS900023|AADSTS50059/.test(desc)) {
    return new MailError("oauth", detail, "客户端 ID 或租户不对。核对 Entra 应用「概览」里的『应用程序(客户端) ID』，并确认「账户类型」允许这个账号登录。");
  }
  if (/AADSTS65001|AADSTS90094|consent/i.test(desc)) {
    return new MailError("oauth", detail, "这个应用还没有得到同意。让租户管理员在 Entra 里给应用授予 IMAP.AccessAsUser.All 与 SMTP.Send（并「代表组织同意」），或改用个人账号。");
  }
  if (err === "invalid_scope" || /AADSTS70011/.test(desc)) {
    return new MailError("oauth", detail, "申请的权限被拒了。确认应用是「公共客户端」且允许 IMAP/SMTP 的两个委派权限。");
  }
  return new MailError("oauth", detail, "Microsoft 授权没走通。按提示核对应用配置后再试；详细信息见这条提示。");
}

function upnFromIdToken(jwt: string): string {
  const part = jwt.split(".")[1];
  if (!part) return "";
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json);
    return String(claims.preferred_username ?? claims.upn ?? claims.email ?? claims.unique_name ?? "");
  } catch {
    return "";
  }
}

/** 成功响应 → 令牌；不是成功响应（缺 access_token）就返回 null，交给调用方看 `error`。 */
function tokensFrom(body: any, prev?: MailOAuth | null): OAuthTokens | null {
  if (!body || typeof body !== "object") return null;
  const accessToken = String(body.access_token ?? "");
  if (!accessToken) return null;
  const lifetime = Number(body.expires_in);
  return {
    accessToken,
    // 微软不一定每次都回新的 refresh token；没回就沿用旧值（见 `saveOAuthTokens`）。
    refreshToken: String(body.refresh_token ?? "") || prev?.refreshToken || "",
    expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000,
    upn: upnFromIdToken(String(body.id_token ?? "")) || prev?.upn || "",
  };
}

/** 开始一次设备码登录。返回给页面：抄码、打开网址、按 `intervalMs` 轮询。 */
export async function startDeviceLogin(accountId: string, oauth: MailOAuth, fetcher: Fetcher = fetch): Promise<OAuthLogin> {
  if (!oauth.clientId) throw new MailError("bad-input", "没有客户端 ID", "先在表单里填 Microsoft 应用的客户端 ID。");
  const { status, body } = await postForm(endpoint(oauth.tenant, "devicecode"), { client_id: oauth.clientId, scope: M365_SCOPES }, fetcher);
  if (status !== 200 || !body?.device_code) throw oauthFailure(status, body);
  const now = Date.now();
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 900;
  const intervalMs = Math.max(MIN_INTERVAL_S, Number(body.interval) || 5) * 1000;
  const state: Pending = {
    clientId: oauth.clientId,
    tenant: oauth.tenant || "common",
    deviceCode: String(body.device_code),
    expiresAt: now + expiresIn * 1000,
    intervalMs,
    nextPollAt: now + intervalMs,
  };
  pending.set(accountId, state);
  return {
    userCode: String(body.user_code ?? ""),
    verificationUri: String(body.verification_uri ?? "https://microsoft.com/devicelogin"),
    expiresAt: state.expiresAt,
    nextPollAt: state.nextPollAt,
    intervalMs,
    message: String(body.message ?? ""),
  };
}

/**
 * 问一次「用户授权完了吗」。成功就把令牌落盘并返回 `done`。
 * 页面按返回的 `waitMs` 决定下一次什么时候问（微软要求，问快了会让码失效）。
 */
export async function pollDeviceLogin(accountId: string, fetcher: Fetcher = fetch): Promise<OAuthPoll> {
  const state = pending.get(accountId);
  if (!state) return { status: "expired" };
  const now = Date.now();
  if (now > state.expiresAt) {
    pending.delete(accountId);
    return { status: "expired" };
  }
  if (now < state.nextPollAt) return { status: "pending", waitMs: state.nextPollAt - now };

  const { status, body } = await postForm(
    endpoint(state.tenant, "token"),
    { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: state.clientId, device_code: state.deviceCode },
    fetcher,
  );
  const tokens = tokensFrom(body);
  if (tokens) {
    saveOAuthTokens(accountId, tokens);
    pending.delete(accountId);
    return { status: "done", upn: tokens.upn };
  }
  const err = String(body?.error ?? "");
  if (err === "authorization_pending") {
    state.nextPollAt = now + state.intervalMs;
    return { status: "pending", waitMs: state.intervalMs };
  }
  if (err === "slow_down") {
    state.intervalMs += 5_000;
    state.nextPollAt = now + state.intervalMs;
    return { status: "pending", waitMs: state.intervalMs };
  }
  pending.delete(accountId);
  if (err === "expired_token") return { status: "expired" };
  throw oauthFailure(status, body);
}

/** 页面关掉对话框 / 换账号：停掉这次登录，别让它继续占着。 */
export function cancelDeviceLogin(accountId: string): void {
  pending.delete(accountId);
}

/**
 * 拿一个能用的 access token：没过期直接用，过期了用 refresh token 换一个新的（顺手落盘）。
 *
 * 「没有 refresh token」与「refresh token 失效」都翻成 `oauth-needed` —— 页面对这两种情况的下一步
 * 是同一个（重新点「用 Microsoft 登录」），没必要让人分辨 AADSTS 编号。
 */
export async function accessTokenFor(account: MailAccount, fetcher: Fetcher = fetch): Promise<string> {
  const oauth = account.oauth;
  if (account.auth !== "oauth" || !oauth) throw new MailError("bad-input", "这个账号用授权码，不需要 OAuth 令牌");
  if (!oauth.refreshToken && !oauth.accessToken) {
    throw new MailError("oauth-needed", "还没用 Microsoft 登录过", "在邮箱面板里点「用 Microsoft 登录」，按提示到 microsoft.com/devicelogin 输入设备码。");
  }
  if (oauth.accessToken && oauth.expiresAt - REFRESH_MARGIN_MS > Date.now()) return oauth.accessToken;
  if (!oauth.refreshToken) {
    throw new MailError("oauth-needed", "登录没完成", "在邮箱面板里重新点「用 Microsoft 登录」完成一次授权。");
  }

  const { status, body } = await postForm(
    endpoint(oauth.tenant, "token"),
    { grant_type: "refresh_token", client_id: oauth.clientId, refresh_token: oauth.refreshToken, scope: M365_SCOPES },
    fetcher,
  );
  const tokens = tokensFrom(body, oauth);
  if (tokens) {
    saveOAuthTokens(account.id, tokens);
    return tokens.accessToken;
  }
  const err = String(body?.error ?? "");
  const desc = String(body?.error_description ?? "");
  if (err === "invalid_grant" || /AADSTS70008|AADSTS50173|AADSTS50196|AADSTS7000215/.test(desc)) {
    throw new MailError(
      "oauth-needed",
      "Microsoft 登录已失效",
      "刷新令牌过期或被撤销了（改了密码、管理员撤了授权、或长期没用）。在邮箱面板里重新点「用 Microsoft 登录」。",
    );
  }
  throw oauthFailure(status, body);
}

/** 退出登录：清掉令牌（账号与服务器配置留着）。 */
export function logoutOAuth(accountId: string): boolean {
  pending.delete(accountId);
  return clearOAuthTokens(accountId);
}
