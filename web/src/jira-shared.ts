/**
 * Jira 面板与单测共用的纯函数（#248、#249、#250、#252）：站点地址判定、token 掩码、工单行链接与
 * 元信息、ADF → 纯文本、字节大小格式化、交给 agent 的提示词。
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
  /** 经办人显示名；未分配或上游按隐私策略不给名字时为空串。 */
  assignee: string;
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

/** `description` 是桥透传的 ADF（D204），类型只在页面端解释。 */
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

/**
 * 工单第二行：类型 · 优先级 · 状态（· 经办人）· 更新时间。优先级空显示 `—`，时间空就省略。
 * `withAssignee` 只给搜索结果用：列表是「我的未完成」，人人都是自己，不必重复。
 */
export function issueMeta(issue: JiraIssue, withAssignee = false): string {
  const assignee = withAssignee ? issue.assignee || tr("未分配") : "";
  return [issue.type, issue.priority || "—", issue.status, assignee, formatUpdated(issue.updated)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 合并下一页搜索结果：序号不是最新就整页丢弃（慢请求先到也没用），否则按 key 去重追加。
 * 返回 `null` 表示这页已过期；顺序保持「旧行在前、新行按上游顺序」。
 */
export function mergeSearchPage(
  current: readonly JiraIssue[],
  page: readonly JiraIssue[],
  seq: number,
  latestSeq: number,
): JiraIssue[] | null {
  if (seq !== latestSeq) return null;
  const seen = new Set(current.map((issue) => issue.key));
  const merged = [...current];
  for (const issue of page) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    merged.push(issue);
  }
  return merged;
}

/** 结果区脚注：全部加载完就说明「已全部加载」，否则只报已显示条数。 */
export function searchCountNote(shown: number, isLast: boolean): string {
  return isLast
    ? tr("已显示 {p1} 条 · 已全部加载", { p1: shown })
    : tr("已显示 {p1} 条", { p1: shown });
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

// ---------------------------------------------------------------- ADF → 纯文本（D204）

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
 * ADF → 纯文本（D204）：桥不解释 ADF，页面把它转成可读文本。段落 / 标题 / 列表 / 代码块 /
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

/** #251：桥回的一批下载结果。单项失败不整单失败（HTTP 仍是 200），所以状态挂在每一项上。 */
export type JiraDownloadStatus = "saved" | "skipped" | "failed";

export interface JiraDownloadItem {
  id: string;
  filename: string;
  path: string;
  status: JiraDownloadStatus;
  /** `skipped` / `failed` 的原因（桥那边写好的中文短句）。 */
  reason?: string;
}

export interface JiraDownloadResult {
  dir: string;
  items: JiraDownloadItem[];
}

/**
 * 每项前面的记号：对勾只留给真落盘的那项 —— 跳过和失败各有自己的记号，别让人把「没下」看成「下好了」。
 */
export function downloadMark(status: JiraDownloadStatus): string {
  if (status === "saved") return "✓";
  if (status === "skipped") return "·";
  return "✗";
}

// ---------------------------------------------------------------- #252 交给 agent

export interface HandoffPromptInput {
  key: string;
  summary: string;
  siteUrl: string;
  status?: string;
  /** `null` = Jira 上没设优先级（写成「未设置」）；`undefined` = 不传这一段。 */
  priority?: string | null;
  type?: string;
  /** 桥回的本机附件目录（`<root>/<KEY>`）；空 = 没下载过，提示词里不出现附件那一行。 */
  dir?: string | null;
}

/**
 * 交给 agent 的提示词（#252，D206）：工单号 / 标题 / 链接 / 状态 / 优先级 / 类型 + 固定指令。
 *
 * 它是给 agent 的指令，不是界面文案，所以不走 `tr()`；附件那一行只在确实下载过时出现，
 * 由桥端 `GET /api/jira/issues/:key/downloaded` 的事实决定，不靠页面猜。
 */
export function handoffPrompt(input: HandoffPromptInput): string {
  const key = input.key.trim();
  const summary = input.summary.trim();
  // i18n-ignore-start 给 agent 的指令，不是界面文案（D206）：不跟界面语言变，也不进词典。
  const lines: string[] = [`处理这个 Jira 工单：${key}${summary ? ` — ${summary}` : ""}`, ""];
  lines.push(`链接：${browseUrl(input.siteUrl, key)}`);
  const status = input.status?.trim() ? `状态：${input.status.trim()}` : "";
  const priority = input.priority === null ? "优先级：未设置" : input.priority?.trim() ? `优先级：${input.priority.trim()}` : "";
  const type = input.type?.trim() ? `类型：${input.type.trim()}` : "";
  const meta = [status, priority, type].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  lines.push("");
  lines.push("请用 Jira MCP 工具（如 mcp__atlassian__*）读取这个工单的详细描述和全部评论，正文我没有贴进来。");
  lines.push("- 结合代码分析问题原因；如果是 bug，给出具体、可复现的操作步骤。");
  lines.push("- 描述或评论里的附件/截图你看不到时，先问我是我自己下载，还是已经下好了、路径在哪。");
  const dir = input.dir?.trim().replace(/[\\/]+$/, "");
  // 结尾用目录自己的分隔符风格（Windows 根目录回的是 `C:\\…`，加个 `/` 会变成混搭）。
  if (dir) lines.push(`- 已经下载到本机的附件在：${dir}${dir.includes("\\") ? "\\" : "/"}`);
  lines.push("");
  lines.push("如果你的工具里没有可用的 Jira，先直接告诉我，不要猜内容。需要我确认的地方先问，不要直接改代码。");
  // i18n-ignore-end
  return lines.join("\n");
}

// ---------------------------------------------------------------- #258 搜索条件

export const SEARCH_RELATIONS = ["assignee", "reporter", "watcher"] as const;
export type SearchRelation = (typeof SEARCH_RELATIONS)[number];

export const SEARCH_SORTS = ["updated", "created", "priority"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_ORDERS = ["asc", "desc"] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];

export const STATUS_CATEGORY_KEYS = ["new", "indeterminate", "done"] as const;
export type StatusCategoryKey = (typeof STATUS_CATEGORY_KEYS)[number];

/** 和桥端 `bridge/src/jira-search.ts` 的常量同口径；改一边就要改另一边。 */
export const SEARCH_STORAGE_KEY = "pi.jira.search.last";

export interface JiraUserOption {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export interface JiraSearchMeta {
  statusCategories: string[];
  types: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  statuses: { id: string; name: string }[];
  /** 项目状态没取到（项目无权限 / 上游 4xx）：类型与优先级照常可用。 */
  partial: boolean;
}

/** 搜索表单的全部条件。空串 = 不限；人员要么是选中的 accountId，要么是自由文本。 */
export interface SearchState {
  /** 工单号：完整键、多个键（逗号/空格分隔）或半截号；形状由桥判（D241、D243）。 */
  key: string;
  title: string;
  text: string;
  project: string;
  statusCategory: "" | StatusCategoryKey;
  status: string;
  type: string;
  priority: string;
  sort: SearchSort;
  order: SearchOrder;
  person: { accountId: string; displayName: string } | null;
  personText: string;
  relations: SearchRelation[];
  unassigned: boolean;
  includeResolved: boolean;
}

export function emptySearch(): SearchState {
  return {
    key: "",
    title: "",
    text: "",
    project: "",
    statusCategory: "",
    status: "",
    type: "",
    priority: "",
    sort: "updated",
    order: "desc",
    person: null,
    personText: "",
    relations: [...SEARCH_RELATIONS],
    unassigned: false,
    includeResolved: false,
  };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickOne<T extends string>(raw: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * 把表单值收成可提交的形状：去空白、未知枚举回默认、项目没选就不带具体状态。
 *
 * 未分配**不清**已选的人与关系——取消勾选时要能恢复；提交时由 `searchQuery` 忽略。
 */
export function normalizeSearch(state: SearchState): SearchState {
  const project = state.project.trim().toUpperCase();
  const accountId = state.person?.accountId.trim() ?? "";
  const displayName = state.person?.displayName.trim() ?? "";
  const person = accountId
    ? { accountId, displayName: displayName || accountId }
    : displayName
      ? { accountId: "", displayName }
      : null;
  const relations = [...new Set(state.relations.filter((item) => (SEARCH_RELATIONS as readonly string[]).includes(item)))] as SearchRelation[];
  const personText = state.personText.trim();
  // 有人但一个关系都没勾：桥会 400，这里回到默认三项（表单也拦着取消最后一个）。
  if ((person || personText) && relations.length === 0) relations.push(...SEARCH_RELATIONS);
  const category = (STATUS_CATEGORY_KEYS as readonly string[]).includes(state.statusCategory)
    ? (state.statusCategory as StatusCategoryKey)
    : "";
  return {
    key: state.key.trim(),
    title: state.title.trim(),
    text: state.text.trim(),
    project,
    statusCategory: project ? category : "",
    status: project ? state.status.trim() : "",
    type: state.type.trim(),
    priority: state.priority.trim(),
    sort: pickOne(state.sort, SEARCH_SORTS, "updated"),
    order: pickOne(state.order, SEARCH_ORDERS, "desc"),
    person: person && person.accountId ? person : null,
    personText: person?.accountId ? "" : personText,
    relations,
    unassigned: state.unassigned === true,
    includeResolved: state.includeResolved === true,
  };
}

/**
 * 条件 → query 参数：空值不带；未分配时不带人员与关系；选了人就用 accountId，
 * 只有自由文本时才带 `person`。`nextPageToken` 由调用方自己加（它不属于条件）。
 */
export function searchQuery(state: SearchState): URLSearchParams {
  const s = normalizeSearch(state);
  const q = new URLSearchParams();
  const put = (key: string, value: string) => {
    if (value) q.set(key, value);
  };
  put("key", s.key);
  put("title", s.title);
  put("text", s.text);
  put("project", s.project);
  if (s.statusCategory) q.set("statusCategory", s.statusCategory);
  put("status", s.status);
  put("type", s.type);
  put("priority", s.priority);
  if (s.unassigned) {
    q.set("unassigned", "1");
  } else if (s.person) {
    q.set("personAccountId", s.person.accountId);
  } else {
    put("person", s.personText);
  }
  if (!s.unassigned && (s.person || s.personText)) q.set("relations", s.relations.join(","));
  if (s.includeResolved) q.set("includeResolved", "1");
  q.set("sort", s.sort);
  q.set("order", s.order);
  return q;
}

/** 只存条件与选中的人，不存 token / 结果；坏 JSON 或版本不对返回 null。 */
export function serializeSearch(state: SearchState): string {
  const s = normalizeSearch(state);
  return JSON.stringify({
    v: 1,
    key: s.key,
    title: s.title,
    text: s.text,
    project: s.project,
    statusCategory: s.statusCategory,
    status: s.status,
    type: s.type,
    priority: s.priority,
    person: s.person,
    personText: s.personText,
    relations: s.relations,
    unassigned: s.unassigned,
    includeResolved: s.includeResolved,
    sort: s.sort,
    order: s.order,
  });
}

/**
 * 读回上次的条件：坏 JSON / 非对象 / v 不是 1 → null；单个字段类型不对或枚举不认识 →
 * 丢这个字段用默认值，不抛错也不整条丢掉。
 */
export function readSavedSearch(raw: string | null | undefined): SearchState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (o.v !== 1) return null;
  const personRaw = o.person && typeof o.person === "object" ? (o.person as Record<string, unknown>) : null;
  const accountId = textOf(personRaw?.accountId).trim();
  const displayName = textOf(personRaw?.displayName).trim();
  const relations = Array.isArray(o.relations)
    ? (o.relations.filter((item) => typeof item === "string" && (SEARCH_RELATIONS as readonly string[]).includes(item)) as SearchRelation[])
    : [...SEARCH_RELATIONS];
  const state: SearchState = {
    key: textOf(o.key),
    title: textOf(o.title),
    text: textOf(o.text),
    project: textOf(o.project),
    statusCategory: textOf(o.statusCategory) as SearchState["statusCategory"],
    status: textOf(o.status),
    type: textOf(o.type),
    priority: textOf(o.priority),
    sort: textOf(o.sort) as SearchSort,
    order: textOf(o.order) as SearchOrder,
    person: accountId ? { accountId, displayName: displayName || accountId } : null,
    personText: textOf(o.personText),
    relations,
    unassigned: o.unassigned === true,
    includeResolved: o.includeResolved === true,
  };
  return normalizeSearch(state);
}
