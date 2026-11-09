/**
 * Jira 搜索（#256）：页面条件 → JQL。纯函数，无网络、无状态、不碰凭据。
 *
 * 边界见 D207：页面只传白名单参数，字段名 / 操作符 / 排序方向都在这里写死；用户输入只进引号内的
 * **值**位置，且必须先过 `escJql`。校验失败抛 `SearchQueryError`（code=`jira_query`、带 `field`），
 * 由路由层映射成 400；本模块不知道 HTTP，也不读配置。
 */

export const SEARCH_RELATIONS = ["assignee", "reporter", "watcher"] as const;
export type SearchRelation = (typeof SEARCH_RELATIONS)[number];

export const SEARCH_SORTS = ["updated", "created", "priority"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const STATUS_CATEGORY_KEYS = ["new", "indeterminate", "done"] as const;
export type StatusCategoryKey = (typeof STATUS_CATEGORY_KEYS)[number];

/** 界面给的是 key，JQL 要的是英文名；只在这里映射一次。 */
export const STATUS_CATEGORIES: Record<StatusCategoryKey, string> = {
  new: "To Do",
  indeterminate: "In Progress",
  done: "Done",
};

/** 页面传的 `maxResults` 一律忽略。 */
export const SEARCH_PAGE_SIZE = 20;

const MAX_TITLE = 200;
const MAX_TEXT = 500;
const MAX_PERSON = 200;
const MAX_ACCOUNT_ID = 128;
const MAX_NAME = 64;
const MAX_TOKEN = 2048;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;

export interface SearchParams {
  title?: string;
  text?: string;
  project?: string;
  statusCategory?: StatusCategoryKey;
  status?: string;
  type?: string;
  priority?: string;
  /** 自由文本（名字 / 邮箱），`personAccountId` 优先。 */
  person?: string;
  personAccountId?: string;
  relations: SearchRelation[];
  unassigned: boolean;
  includeResolved: boolean;
  sort: SearchSort;
  order: "asc" | "desc";
  nextPageToken?: string;
}

export class SearchQueryError extends Error {
  readonly code = "jira_query";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "SearchQueryError";
    this.field = field;
  }
}

function read(query: URLSearchParams, key: string): string | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const text = raw.trim();
  return text ? text : undefined;
}

function checkLength(value: string | undefined, max: number, field: string, label: string): void {
  if (value !== undefined && value.length > max) {
    throw new SearchQueryError(field, `${label}最多 ${max} 个字符`);
  }
}

function parseRelations(query: URLSearchParams, hasPerson: boolean): SearchRelation[] {
  if (!query.has("relations")) return hasPerson ? [...SEARCH_RELATIONS] : [];
  const items = (query.get("relations") ?? "").split(",").map((item) => item.trim());
  if (items.some((item) => !item)) {
    throw new SearchQueryError("relations", "关系至少要留一项，且不能有空项");
  }
  for (const item of items) {
    if (!(SEARCH_RELATIONS as readonly string[]).includes(item)) {
      throw new SearchQueryError("relations", `不认识的关系：${item}`);
    }
  }
  // 去重但保留用户给的顺序，拼出来的 JQL 可预测。
  return [...new Set(items)] as SearchRelation[];
}

/**
 * 只认白名单键；未知参数忽略（向前兼容）。`relations` 缺省时：按人查默认三项全选，不按人查则为空。
 */
export function parseSearchParams(query: URLSearchParams): SearchParams {
  const title = read(query, "title");
  const text = read(query, "text");
  const project = read(query, "project");
  const status = read(query, "status");
  const type = read(query, "type");
  const priority = read(query, "priority");
  const person = read(query, "person");
  const personAccountId = read(query, "personAccountId");
  const nextPageToken = read(query, "nextPageToken");
  const rawCategory = read(query, "statusCategory");
  const rawSort = read(query, "sort");
  const rawOrder = read(query, "order");
  const unassigned = query.get("unassigned") === "1";
  const includeResolved = query.get("includeResolved") === "1";

  checkLength(title, MAX_TITLE, "title", "标题关键字");
  checkLength(text, MAX_TEXT, "text", "全文本关键字");
  checkLength(person, MAX_PERSON, "person", "人员");
  checkLength(personAccountId, MAX_ACCOUNT_ID, "personAccountId", "账号 ID");
  checkLength(status, MAX_NAME, "status", "状态名");
  checkLength(type, MAX_NAME, "type", "类型名");
  checkLength(priority, MAX_NAME, "priority", "优先级名");
  checkLength(nextPageToken, MAX_TOKEN, "nextPageToken", "分页 token");

  if (project !== undefined && !PROJECT_KEY.test(project)) {
    throw new SearchQueryError("project", "项目 key 只能是大写字母开头的 1–10 位大写字母、数字或下划线");
  }
  if (rawCategory !== undefined && !(STATUS_CATEGORY_KEYS as readonly string[]).includes(rawCategory)) {
    throw new SearchQueryError("statusCategory", `状态类别只能是 ${STATUS_CATEGORY_KEYS.join(" / ")}`);
  }
  if (status !== undefined && project === undefined) {
    throw new SearchQueryError("status", "选具体状态前先选项目");
  }
  if (rawSort !== undefined && !(SEARCH_SORTS as readonly string[]).includes(rawSort)) {
    throw new SearchQueryError("sort", `排序只能是 ${SEARCH_SORTS.join(" / ")}`);
  }
  if (rawOrder !== undefined && rawOrder !== "asc" && rawOrder !== "desc") {
    throw new SearchQueryError("order", "方向只能是 asc / desc");
  }

  const hasPerson = person !== undefined || personAccountId !== undefined;
  const relations = parseRelations(query, hasPerson);
  if (hasPerson && relations.length === 0) {
    throw new SearchQueryError("relations", "按人查时至少选一种关系");
  }
  if (unassigned && hasPerson) {
    throw new SearchQueryError("unassigned", "已勾选未分配，不能再按人员筛选");
  }

  return {
    title,
    text,
    project,
    statusCategory: rawCategory as StatusCategoryKey | undefined,
    status,
    type,
    priority,
    person,
    personAccountId,
    relations,
    unassigned,
    includeResolved,
    sort: (rawSort as SearchSort | undefined) ?? "updated",
    order: (rawOrder as "asc" | "desc" | undefined) ?? "desc",
    nextPageToken,
  };
}

/** 用户字符串唯一允许进入 JQL 的方式：反斜杠与引号转义，控制字符压成空格。 */
export function escJql(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
}

/**
 * 固定顺序：默认未解决 → 项目 → 状态类别 → 具体状态 → 类型 → 优先级 → 人员 OR 组 → 未分配 → ORDER BY。
 * 简单条件不套括号；人员组必须括号，否则 OR 会把整条查询拆开。
 */
export function buildSearchJql(params: SearchParams): string {
  const clauses: string[] = [];
  if (!params.includeResolved) clauses.push("resolution = Unresolved");
  if (params.title) clauses.push(`summary ~ "${escJql(params.title)}"`);
  if (params.text) clauses.push(`text ~ "${escJql(params.text)}"`);
  if (params.project) clauses.push(`project = "${escJql(params.project)}"`);
  if (params.statusCategory) clauses.push(`statusCategory = "${STATUS_CATEGORIES[params.statusCategory]}"`);
  if (params.status) clauses.push(`status = "${escJql(params.status)}"`);
  if (params.type) clauses.push(`issuetype = "${escJql(params.type)}"`);
  if (params.priority) clauses.push(`priority = "${escJql(params.priority)}"`);

  const person = params.personAccountId ?? params.person;
  if (person) {
    if (params.relations.length === 0) {
      throw new SearchQueryError("relations", "按人查时至少选一种关系");
    }
    const who = `"${escJql(person)}"`;
    clauses.push(`(${params.relations.map((relation) => `${relation} = ${who}`).join(" OR ")})`);
  }
  if (params.unassigned) clauses.push("assignee IS EMPTY");

  const direction = params.order === "asc" ? "ASC" : "DESC";
  // priority 的次序不稳定，补一个更新时间；updated 自己不重复。
  const orderBy =
    params.sort === "priority" ? `priority ${direction}, updated DESC` : `${params.sort} ${direction}`;
  const where = clauses.join(" AND ");
  return `${where ? `${where} ` : ""}ORDER BY ${orderBy}`;
}
