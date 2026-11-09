/**
 * Jira 面板与单测共用的纯函数（#248、#249、#250）：站点地址判定、token 掩码、工单行链接与
 * 元信息、ADF → 纯文本、字节大小格式化。
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

/** #250 详情里的一条附件；大小 / 作者未知时分别是 `null` / 空串。 */
export interface JiraAttachment {
  id: string;
  filename: string;
  size: number | null;
  author: string;
  created: string;
}

/** `description` 是桥透传的 ADF（D203），类型只在页面端解释。 */
export interface JiraIssueDetail {
  issue: JiraIssue & { description: unknown };
  attachments: { issue: JiraAttachment[]; comments: JiraAttachment[] };
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

/** 未知大小显示 `—`，其余按 1024 进位；`1.0 KB` 写成 `1 KB`。 */
export function formatBytes(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

// ---------------------------------------------------------------- ADF → 纯文本（D203）

interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

function attrText(node: AdfNode, key: string): string {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 图片 / 附件统一成占位文本：`mediaSingle` 的 type 在子 `media` 上，往里看一眼。 */
function mediaText(node: AdfNode): string {
  const kind =
    attrText(node, "type") || (node.content ?? []).map((child) => attrText(child, "type")).find(Boolean) || "";
  return kind.startsWith("image") ? tr("[图片]") : tr("[附件]");
}

/** 一个块内部的流式内容：段落、标题、列表项、单元格都用它。 */
function inlineText(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      const text = typeof node.text === "string" ? node.text : "";
      const link = (node.marks ?? []).find((mark) => mark.type === "link" && typeof mark.attrs?.href === "string");
      const href = typeof link?.attrs?.href === "string" ? link.attrs.href : "";
      return href ? `${text} (${href})` : text;
    }
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = attrText(node, "text") || attrText(node, "displayName");
      return name ? `@${name}` : "";
    }
    case "emoji":
      return attrText(node, "text") || attrText(node, "shortName");
    case "inlineCard":
      return attrText(node, "url");
    case "media":
    case "mediaInline":
    case "mediaSingle":
      return mediaText(node);
    default:
      return (node.content ?? []).map(inlineText).join("");
  }
}

function listLines(list: AdfNode, depth: number, ordered: boolean): string[] {
  const pad = "  ".repeat(depth);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${index + 1}.` : "•";
    const inner = item.content ?? [];
    const first = inner[0];
    if (first?.type === "paragraph" || first?.type === "text") {
      lines.push(`${pad}${marker} ${inlineText(first)}`);
      for (const rest of inner.slice(1)) lines.push(...blockLines(rest, depth + 1));
    } else if (first) {
      lines.push(`${pad}${marker}`);
      for (const child of inner) lines.push(...blockLines(child, depth + 1));
    } else {
      lines.push(`${pad}${marker}`);
    }
  });
  return lines;
}

function cellText(cell: AdfNode): string {
  const parts: string[] = [];
  for (const child of cell.content ?? []) {
    if (child.type === "paragraph") parts.push(inlineText(child));
    else if (child.content) parts.push(...blockLines(child, 0).map((line) => line.trim()).filter(Boolean));
    else if (typeof child.text === "string") parts.push(child.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function blockLines(node: AdfNode, depth: number): string[] {
  const pad = "  ".repeat(depth);
  switch (node.type) {
    case "paragraph":
      return [pad + inlineText(node)];
    case "heading": {
      const level = Math.min(6, Math.max(1, Math.round(Number(node.attrs?.level) || 1)));
      return [`${pad}${"#".repeat(level)} ${inlineText(node)}`];
    }
    case "bulletList":
      return listLines(node, depth, false);
    case "orderedList":
      return listLines(node, depth, true);
    case "codeBlock": {
      const code = (node.content ?? []).map((child) => (typeof child.text === "string" ? child.text : "")).join("");
      const fence = "```";
      return [`${pad}${fence}`, ...code.split("\n").map((line) => `${pad}${line}`), `${pad}${fence}`];
    }
    case "blockquote":
      return (node.content ?? []).flatMap((child) => blockLines(child, depth)).map((line) => `> ${line}`);
    case "rule":
      return [`${pad}——`];
    case "media":
    case "mediaSingle":
    case "mediaInline":
      return [pad + mediaText(node)];
    case "table":
      return (node.content ?? []).flatMap((row) => {
        if (row.type !== "tableRow") return blockLines(row, depth);
        return [`${pad}${(row.content ?? []).map(cellText).join(" | ")}`];
      });
    default: {
      if (node.content) return node.content.flatMap((child) => blockLines(child, depth));
      return typeof node.text === "string" ? [pad + node.text] : [];
    }
  }
}

/**
 * ADF → 纯文本（D203）：桥不解释 ADF，页面把它转成可读文本。段落 / 标题 / 列表 / 代码块 /
 * 表格 / 引用 / 分隔线都保留阅读顺序，media 节点变成 `[图片]` / `[附件]` 占位。
 * 不是 ADF（null、字符串、形状不对）时退回能拿到的文字或空串。
 */
export function adfToText(adf: unknown): string {
  if (typeof adf === "string") return adf.trim();
  if (!adf || typeof adf !== "object") return "";
  const doc = adf as AdfNode;
  const blocks = doc.type === "doc" && Array.isArray(doc.content) ? doc.content : [doc];
  return blocks
    .flatMap((node) => blockLines(node, 0))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
