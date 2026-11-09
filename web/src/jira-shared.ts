/**
 * Jira 面板与单测共用的纯函数（#248、#249）：站点地址判定、token 掩码、工单行链接与元信息。
 *
 * 单独一个文件是为了让 `web/tests/jira-unit.mjs` 能直接跑：`jira.ts` 为了 `el()` 要 import
 * `chat.ts`，而 `chat.ts` 的构造器参数属性过不了 Node 26 的 strip-only（`--experimental-transform-types`
 * 在 26 里已被移除）。这一层只依赖 i18n，`node web/tests/jira-unit.mjs` 即可。
 *
 * `bridge/src/jira.ts` 里有一份同口径的权威校验，两边都改才算改完。
 */
import { tr } from "./i18n/index.ts";

export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  /** Jira 没有优先级时回 null。 */
  priority: string | null;
  status: string;
  updated: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isIpLiteral(host: string): boolean {
  return (host.startsWith("[") && host.endsWith("]")) || IPV4.test(host);
}

/**
 * 站点地址的毛病（中文原因）或 null。桥侧 `bridge/src/jira.ts` 的 `siteUrlProblem` 是权威，
 * 这里只是边填边提示 —— 两边都改才算改完。
 */
export function siteUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return tr("请填 Jira 站点地址");
  let url: URL;
  try {
    url = new URL(withScheme(text));
  } catch {
    return tr("站点地址看不懂，检查一下有没有写错");
  }
  if (url.protocol !== "https:") return tr("只接受 https:// 的站点地址");
  if (url.username || url.password) return tr("站点地址里不要带用户名或密码");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return tr("站点地址不能是 localhost");
  if (host.endsWith(".local") || host.endsWith(".internal")) return tr("站点地址不能是内网域名");
  if (isIpLiteral(host)) return tr("站点地址不能是 IP，请填 https://<团队>.atlassian.net");
  if (!host.includes(".")) return tr("站点地址要是一个完整的域名");
  if (url.pathname.replace(/\/+$/, "")) return tr("站点地址只填到域名，不要带路径");
  if (url.search) return tr("站点地址不要带查询参数");
  if (url.hash) return tr("站点地址不要带 #");
  return null;
}

/** 与桥同一口径的掩码：`••••` + 后 4 位。 */
export function keyMask(key: string): string {
  const k = key.trim();
  return k.length > 4 ? `••••${k.slice(-4)}` : "••••";
}

/** 工单 / 项目的 Jira 页面：站点去掉结尾 `/` 再拼 `/browse/<KEY>`。 */
export function browseUrl(siteUrl: string, key: string): string {
  return `${siteUrl.trim().replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** ISO 时间 → 本地 `2026-11-08 14:03`；解不出时间就给空串，页面据此省略这一段。 */
export function formatUpdated(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 工单第二行：类型 · 优先级 · 状态 · 更新时间。优先级空显示 `—`，时间空就省略。 */
export function issueMeta(issue: JiraIssue): string {
  return [issue.type, issue.priority || "—", issue.status, formatUpdated(issue.updated)].filter(Boolean).join(" · ");
}
