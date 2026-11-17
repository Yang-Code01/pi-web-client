/**
 * 考勤模块：把一台 OA 的「考勤记录 + 加班申请」搬进本机管理。
 *
 * 三条边界，跟 `bridge/src/jira.ts` 一个口径：
 *   1. **凭据不出桥**。密码和 token 落 `<状态目录>/attendance/credentials.bin`（DPAPI 加密），
 *      进内存只在出站请求的头发一次；页面永远只拿掩码。
 *   2. **出站只发配置的站点**。`apiBase` 是唯一出口，改它要回本机；隧道访客整页不存在（见下）。
 *   3. **隧道整页隐身**：`publicReq` 时直接 `return false`，让 index.ts 的兜底回标准 404 ——
 *      不写成 403，403 等于告诉外面「这里有东西，只是不给你」。
 *
 * 公司相关的部分全部在 `config.json` 里（地址、端点路径、字段名），代码里一个都没有；
 * 默认值是通用的占位，配好之前面板只显示「还没配置」。
 */
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonChecked, statePath } from "./paths.ts";
import {
  clampRange,
  checkDraft,
  findReceipt,
  formatOvertimeReason,
  formatWorkflow,
  fromLocalInput,
  loginGate,
  loginRetryDelay,
  maskAccount,
  mapRow,
  normalizeHours,
  parseOvertimeReason,
  parseWorkflow,
  receiptKey,
  summarize,
  todayKey,
  type AttendanceRow,
  type OvertimeProblem,
  type OvertimeReason,
  type ReceiptRecord,
  type RowMapOptions,
} from "./attendance-model.ts";
import { SecretError, readSecret, removeSecret, writeSecret } from "./dpapi.ts";
import {
  REMINDER_TITLE,
  normalizeRule,
  readReminder,
  reminderBody,
  ruleProblem,
  writeReminder,
  type ReminderSink,
} from "./attendance-reminder.ts";

// ---------------------------------------------------------------- 配置

/** 端点路径的默认值。换系统时改 `config.json`，别改这里。 */
export interface AttendanceEndpoints {
  login: string;
  records: string;
  overtimeInit: string;
  overtimeAdd: string;
  overtimeCancel: string;
  leaders: string;
  /** 部门负责人名单（二级审批人就是这张表里的「我的那两条」）。 */
  roles: string;
}

export const DEFAULT_ENDPOINTS: AttendanceEndpoints = {
  login: "/in/login/check",
  records: "/in/record/query",
  overtimeInit: "/in/apply/overtime/get",
  overtimeAdd: "/in/apply/overtime/add",
  overtimeCancel: "/in/apply/overtime/cancel",
  leaders: "/in/common/leaders",
  roles: "/in/roles/depart_leader_data",
};

export interface AttendanceConfig {
  /** OA 接口根，形如 `https://attendance.example.com:8085`。 */
  apiBase: string;
  /** 网页端根，只用于「去网页看」的跳转。 */
  pageBase: string;
  /** 登录账号（工号或邮箱）。不是密码。 */
  account: string;
  endpoints: AttendanceEndpoints;
  fields: RowMapOptions;
}

const EMPTY_CONFIG: AttendanceConfig = {
  apiBase: "",
  pageBase: "",
  account: "",
  endpoints: { ...DEFAULT_ENDPOINTS },
  fields: {},
};

function dir(): string {
  return statePath("attendance");
}

function configFile(): string {
  return path.join(dir(), "config.json");
}

function credFile(): string {
  return path.join(dir(), "credentials.bin");
}

function cacheFile(): string {
  return path.join(dir(), "cache.json");
}

function auditFile(): string {
  return path.join(dir(), "audit.jsonl");
}

/** 读配置。坏文件当没配过（`problem` 交给调用方提示）。 */
export function readConfig(): { config: AttendanceConfig; problem: string | null } {
  const raw = readJsonChecked<Partial<AttendanceConfig>>(configFile(), {});
  if (!raw.ok) return { config: { ...EMPTY_CONFIG }, problem: `配置文件读不出来：${raw.error}` };
  const v = raw.value ?? {};
  return {
    config: {
      apiBase: typeof v.apiBase === "string" ? v.apiBase.trim() : "",
      pageBase: typeof v.pageBase === "string" ? v.pageBase.trim() : "",
      account: typeof v.account === "string" ? v.account.trim() : "",
      endpoints: { ...DEFAULT_ENDPOINTS, ...(v.endpoints ?? {}) },
      fields: { ...(v.fields ?? {}) },
    },
    problem: null,
  };
}

function writeConfig(config: AttendanceConfig): void {
  ensureDir(dir());
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** HTTP(S) 地址的毛病（中文）或 null。不接受带账号密码的 URL。 */
export function baseUrlProblem(raw: string, label: string): string | null {
  if (!raw) return `请填${label}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${label}要是完整地址，形如 https://example.com`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${label}只支持 http / https`;
  if (u.username || u.password) return `${label}里不要带账号密码，登录在面板里做`;
  return null;
}

// ---------------------------------------------------------------- 凭据

interface Credentials {
  account: string;
  password: string;
  token: string;
  /** token 过期时间（毫秒时间戳），从 JWT 的 exp 读；读不到就是 0（当没过期处理）。 */
  tokenExp: number;
  userId: number;
  name: string;
  workNo: string;
}

let credMemo: Credentials | null = null;
/** 登录失败的时间戳，用于退避。只活在这个进程里：桥重启等于人工介入过。 */
let loginFailures: number[] = [];
/** 最近的回执，用于防重复提交。 */
let receipts: ReceiptRecord[] = [];

async function readCredentials(): Promise<Credentials | null> {
  if (credMemo) return credMemo;
  let file;
  try {
    file = await readSecret(credFile());
  } catch (err) {
    if (err instanceof SecretError) {
      // 解不开就丢，逼着重新登录；否则面板会一直卡在「读不出凭据」。
      removeSecret(credFile());
      return null;
    }
    throw err;
  }
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.secret) as Partial<Credentials>;
    credMemo = {
      account: String(parsed.account ?? ""),
      password: String(parsed.password ?? ""),
      token: String(parsed.token ?? ""),
      tokenExp: Number(parsed.tokenExp ?? 0) || 0,
      userId: Number(parsed.userId ?? 0) || 0,
      name: String(parsed.name ?? ""),
      workNo: String(parsed.workNo ?? ""),
    };
    return credMemo;
  } catch {
    removeSecret(credFile());
    return null;
  }
}

async function writeCredentials(cred: Credentials): Promise<void> {
  ensureDir(dir());
  await writeSecret(credFile(), JSON.stringify(cred));
  credMemo = cred;
}

async function clearCredentials(): Promise<void> {
  credMemo = null;
  removeSecret(credFile());
}

/** token 是不是还能用：没有 exp 的一律当能用（由上游 401 兜底）。 */
function tokenFresh(cred: Credentials, now = Date.now()): boolean {
  if (!cred.token) return false;
  if (!cred.tokenExp) return true;
  return cred.tokenExp - now > 60_000;
}

function jwtExp(token: string): number {
  const part = token.split(".")[1];
  if (!part) return 0;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp ?? 0);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 出站

export interface OaCtx {
  /** 桥内测试缝：出站请求改发这里（假服务器是 `http://127.0.0.1:port`）。生产不传。 */
  upstream?: string;
}

class OaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamStatus?: number;
  constructor(code: string, status: number, message: string, upstreamStatus?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * 发一次请求。**错误消息里绝不带完整 URL**：登录接口把密码放在 query string 里，
 * 而错误会被记进日志、回给页面、进模型上下文。
 */
async function oaFetch(
  cfg: AttendanceConfig,
  ctx: OaCtx,
  opts: {
    method: "GET" | "POST";
    endpoint: string;
    token?: string;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<unknown> {
  const base = ctx.upstream ?? cfg.apiBase;
  if (!base) throw new OaError("not_configured", 400, "还没配置 OA 地址");
  let url: URL;
  try {
    url = new URL(base.replace(/\/+$/, "") + opts.endpoint);
  } catch {
    throw new OaError("bad_base", 400, "OA 地址不对");
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.token = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const msg = (err as Error)?.name === "TimeoutError" ? "OA 超时，没响应" : "连不上 OA";
    throw new OaError("network", 502, msg);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new OaError("login_expired", 401, "登录过期了，重新登录一次", res.status);
  }
  if (!res.ok) throw new OaError("upstream", 502, `OA 返回 HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 最常踩的：把网页地址（登录页那些）填进了「接口地址」，拿回来一堆 HTML。
    const kind = (res.headers.get("content-type") ?? "").toLowerCase();
    const looksHtml = kind.includes("html") || /^\s*</.test(text);
    throw new OaError(
      "bad_json",
      502,
      looksHtml
        ? "接口地址指到了网页，不是 OA 的后端（返回的是 HTML）"
        : "OA 返回的不是 JSON",
    );
  }
}

function okStatus(data: unknown): boolean {
  const s = (data as { status?: unknown } | null)?.status;
  return typeof s !== "string" || s.toUpperCase() === "OK";
}

/** 上游 NG 的中文原因（OA 的 `error` / `message` 字段，坏的就退回一句通用话）。 */
function ngReason(data: unknown, fallback: string): string {
  const v = data as { error?: unknown; message?: unknown } | null;
  for (const key of ["message", "error"] as const) {
    const raw = v?.[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 200);
  }
  return fallback;
}

// ---------------------------------------------------------------- 登录

interface LoginResult {
  token: string;
  userId: number;
  name: string;
  workNo: string;
}

async function login(cfg: AttendanceConfig, ctx: OaCtx, account: string, password: string): Promise<LoginResult> {
  const now = Date.now();
  const gate = loginGate(loginFailures, now);
  if (!gate.allowed) throw new OaError("too_many", 429, gate.reason ?? "稍后再试");
  const data = await oaFetch(cfg, ctx, {
    method: "GET",
    endpoint: cfg.endpoints.login,
    query: { user_account: account, user_password: password },
  });
  if (!okStatus(data)) {
    loginFailures = [...loginFailures.filter((t) => now - t < 10 * 60_000), Date.now()];
    const reason = ngReason(data, "账号或密码不对");
    const wait = Math.ceil(loginRetryDelay(loginFailures.length) / 1000);
    throw new OaError("login_failed", 401, wait > 1 ? `${reason}（${wait} 秒后再试）` : reason);
  }
  const v = data as Record<string, unknown>;
  const token = typeof v.token === "string" ? v.token : "";
  if (!token) throw new OaError("login_failed", 401, "登录成功但没拿到 token");
  loginFailures = [];
  return {
    token,
    userId: Number(v.user_id ?? 0) || 0,
    name: typeof v.name === "string" ? v.name : "",
    workNo: typeof v.work_no === "string" ? v.work_no : "",
  };
}

/** 拿一份能用的登录态：token 没过期就直接用，过期了就重新登（失败会被退避挡住）。 */
async function session(cfg: AttendanceConfig, ctx: OaCtx): Promise<Credentials> {
  const cred = await readCredentials();
  if (!cred) throw new OaError("not_logged_in", 401, "还没登录");
  if (tokenFresh(cred)) return cred;
  if (!cred.password) throw new OaError("not_logged_in", 401, "登录过期了，重新登录一次");
  const fresh = await login(cfg, ctx, cred.account, cred.password);
  const next: Credentials = {
    ...cred,
    token: fresh.token,
    tokenExp: jwtExp(fresh.token),
    userId: fresh.userId || cred.userId,
    name: fresh.name || cred.name,
    workNo: fresh.workNo || cred.workNo,
  };
  await writeCredentials(next);
  return next;
}

/**
 * 跑一次要登录态的操作。上游说 token 无效时偷偷用存着的密码重登一次再重试：
 * 同一个账号在 OA 网页上又登一次，OA 会把旧 token 踢掉（exp 明明还没到），
 * 不重试的话用户就会看到「登录过期了」+ 一屏旧缓存，而他什么都没做错。
 */
async function withSession<T>(
  cfg: AttendanceConfig,
  ctx: OaCtx,
  run: (cred: Credentials) => Promise<T>,
): Promise<T> {
  const cred = await session(cfg, ctx);
  try {
    return await run(cred);
  } catch (err) {
    if (!(err instanceof OaError) || err.code !== "login_expired") throw err;
    if (!cred.password) throw err;
    // token 自己没过期（exp 还没到），只是被上游踢了：清掉逼 session 重登。
    await writeCredentials({ ...cred, token: "", tokenExp: 0 });
    const fresh = await session(cfg, ctx);
    audit({ kind: "relogin", account: maskAccount(fresh.account) });
    return await run(fresh);
  }
}

// ---------------------------------------------------------------- 缓存

interface CacheFile {
  account: string;
  fetchedAt: number;
  maxDay: string;
  days: Record<string, AttendanceRow>;
}

const CACHE_KEEP_DAYS = 90;

function readCache(): CacheFile {
  const raw = readJsonChecked<CacheFile>(cacheFile(), { account: "", fetchedAt: 0, maxDay: "", days: {} });
  const v = raw.value;
  if (!v || typeof v !== "object" || !v.days || typeof v.days !== "object") {
    return { account: "", fetchedAt: 0, maxDay: "", days: {} };
  }
  return v;
}

function writeCache(cache: CacheFile): void {  ensureDir(dir());
  const floor = todayKey(new Date(Date.now() - (CACHE_KEEP_DAYS - 1) * 86_400_000));
  for (const key of Object.keys(cache.days)) {
    if (key < floor) delete cache.days[key];
  }
  fs.writeFileSync(cacheFile(), JSON.stringify(cache), { mode: 0o600 });
}

/** 缓存是跟着账号的：账号换了，旧人的行一条都不许再露出来。 */
function readCacheFor(account: string): CacheFile {
  const cache = readCache();
  if (account && cache.account && cache.account !== account) {
    return { account, fetchedAt: 0, maxDay: "", days: {} };
  }
  return cache;
}

function mergeRows(cache: CacheFile, rows: AttendanceRow[], maxDay: string, account: string): CacheFile {
  const next: CacheFile = { account, fetchedAt: Date.now(), maxDay: maxDay || cache.maxDay, days: { ...cache.days } };
  for (const row of rows) if (row.date) next.days[row.date] = row;
  return next;
}

function rowsInRange(cache: CacheFile, start: string, end: string): AttendanceRow[] {
  return Object.values(cache.days)
    .filter((r) => r.date >= start && r.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- 审计

function audit(entry: Record<string, unknown>): void {
  try {
    ensureDir(dir());
    fs.appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* 审计写不进去不该让申请失败 */
  }
}

// ---------------------------------------------------------------- 业务

async function fetchRecords(
  cfg: AttendanceConfig,
  ctx: OaCtx,
  cred: Credentials,
  start: string,
  end: string,
): Promise<{ rows: AttendanceRow[]; maxDay: string }> {
  if (!cred.userId) throw new OaError("no_user", 400, "登录信息里没有 user_id，重新登录一次");
  // 上游这个 keyword 是「模糊找个人」，不是精确匹配：拿 user_id 当关键字会被工号里
  // 恰好含这几个数字的同事命中（实测 640 命中了 JS1640，拉回一整页别人的考勤）。
  // 工号是唯一的，优先发工号；上面回来的行再按 user_id / work_no 过一道。
  const keyword = cred.workNo || String(cred.userId);
  const data = await oaFetch(cfg, ctx, {
    method: "POST",
    endpoint: cfg.endpoints.records,
    token: cred.token,
    body: {
      // 只查自己：keyword 来自登录态，页面传什么都不参与。
      keyword,
      query_type: 3, // 3 = 认 start_dt/end_dt；0/1 会被上游忽略成固定窗口
      start_dt: start,
      end_dt: end,
    },
  });
  if (!okStatus(data)) throw new OaError("records_ng", 502, ngReason(data, "考勤记录取不到"));
  const v = data as { data_list?: unknown; max_day?: unknown };
  const list = Array.isArray(v.data_list) ? (v.data_list as Record<string, unknown>[]) : [];
  const mine = list.filter((item) => {
    const id = Number(item.user_id ?? 0) || 0;
    const no = typeof item.work_no === "string" ? item.work_no : "";
    return (Boolean(cred.workNo) && no === cred.workNo) || (id > 0 && id === cred.userId);
  });
  // 一条都不是自己的：宁可报错，也不能把别人的考勤当自己的显示。
  if (list.length > 0 && mine.length === 0) {
    throw new OaError("wrong_user", 502, "OA 返回的不是本人的考勤（工号对不上），这份数据不要用");
  }
  return {
    rows: mine.map((item) => mapRow(item, cfg.fields)),
    maxDay: typeof v.max_day === "string" ? v.max_day.slice(0, 10) : "",
  };
}

interface LeaderItem {
  userId: number;
  name: string;
  workNo: string;
}

function readLeaders(data: unknown): { l1: LeaderItem[]; l2: LeaderItem[] } {
  const list = (data as { list?: { team_leaders?: unknown; depart_leaders?: unknown } } | null)?.list;
  const pick = (raw: unknown): LeaderItem[] =>
    (Array.isArray(raw) ? raw : [])
      .map((x) => {
        const o = x as Record<string, unknown>;
        return {
          userId: Number(o.user_id ?? 0) || 0,
          name: typeof o.name === "string" ? o.name : "",
          workNo: typeof o.work_no === "string" ? o.work_no : "",
        };
      })
      .filter((x) => x.userId > 0);
  return { l1: pick(list?.team_leaders), l2: pick(list?.depart_leaders) };
}

/** OA 里的「姓名-工号」。两段都可能缺，别假设一定有两个。 */
export function parsePerson(text: unknown): { name: string; workNo: string } {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return { name: "", workNo: "" };
  const cut = raw.lastIndexOf("-");
  if (cut <= 0) return { name: raw, workNo: "" };
  return { name: raw.slice(0, cut).trim(), workNo: raw.slice(cut + 1).trim() };
}

/** 把「姓名-工号」对到候选表里的人；对不上就丢（宁可空着也不瞎猜 id）。 */
export function resolvePeople(keys: unknown[], pool: LeaderItem[]): LeaderItem[] {
  const out: LeaderItem[] = [];
  const seen = new Set<number>();
  for (const raw of Array.isArray(keys) ? keys : []) {
    const { name, workNo } = parsePerson(raw);
    if (!name && !workNo) continue;
    const hit = pool.find((p) => (workNo ? p.workNo === workNo : p.name === name));
    if (!hit || seen.has(hit.userId)) continue;
    seen.add(hit.userId);
    out.push(hit);
  }
  return out;
}

/** `depart_leader_data` 里的 `last.depart_manager`：这个人自己的二级审批人。 */
export function readDepartManagers(data: unknown): string[] {
  const last = (data as { last?: { depart_manager?: unknown } } | null)?.last;
  const raw = last?.depart_manager;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/** 最近一次加班申请里某一级（`workflow_index`）的审批人，统一成「姓名-工号」列表。 */
export function lastStepPeople(applyList: unknown[], workflow: Record<string, unknown>, index: number): string[] {
  const rows = (Array.isArray(applyList) ? applyList : [])
    .map((x) => x as Record<string, unknown>)
    .filter((x) => x && (x.code !== undefined || x.start_time !== undefined));
  if (rows.length === 0) return [];
  const newest = rows.reduce((best, cur) => (String(cur.start_time ?? "") > String(best.start_time ?? "") ? cur : best));
  const chain = workflow[String(newest.code ?? "")];
  if (!Array.isArray(chain)) return [];
  const step = (chain as Record<string, unknown>[]).find((x) => Number(x?.workflow_index) === index);
  if (!step) return [];
  // 「这一级应该是谁」写的是 workflow_user_name，可能是一串逗号分隔的人；
  // handle_user_name 只记录真正点过的那个人，所以多级/多人时不能拿它当名单。
  const planned = typeof step.workflow_user_name === "string" ? step.workflow_user_name : "";
  const handled = typeof step.handle_user_name === "string" ? step.handle_user_name : "";
  const text = planned || handled;
  if (!text) return [];
  return text
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** 一级审批人的默认值：上一次申请的那个项目负责人（OA 新建单据时也是拿这个当前值）。 */
/** 页面发 `{l1,l2}` 对象，也接受 `"l1&l2"` 字符串；两种都归成数字 id。 */
export function readWorkflow(raw: unknown): { l1: number[]; l2: number[] } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const box = raw as { l1?: unknown; l2?: unknown };
    const ids = (v: unknown): number[] =>
      Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) : [];
    return { l1: ids(box.l1), l2: ids(box.l2) };
  }
  return parseWorkflow(String(raw ?? ""));
}

export function lastLeadApprover(applyList: unknown[], workflow: Record<string, unknown>): string {
  return lastStepPeople(applyList, workflow, 1)[0] ?? "";
}

interface OvertimeInit {
  applyList: unknown[];
  workflow: Record<string, unknown>;
  reasons: string[];
  admitTime: string;
  rule: string;
  leaders: { l1: LeaderItem[]; l2: LeaderItem[] };
  /** 二级审批人的固定名单（从 roles 端点解析出来的人）。 */
  fixedL2: LeaderItem[];
  /** 一级审批人的默认值（上一次申请的那个人）。 */
  defaultL1: LeaderItem[];
}

async function fetchOvertimeInit(cfg: AttendanceConfig, ctx: OaCtx, cred: Credentials): Promise<OvertimeInit> {
  // roles 端点不是所有部署都有：取不到就当没有固定名单，别把整个申请页拖挂。
  const [initRaw, leadersRaw, rolesRaw] = await Promise.all([
    oaFetch(cfg, ctx, { method: "GET", endpoint: cfg.endpoints.overtimeInit, token: cred.token }),
    oaFetch(cfg, ctx, { method: "GET", endpoint: cfg.endpoints.leaders, token: cred.token }).catch(() => null),
    oaFetch(cfg, ctx, { method: "GET", endpoint: cfg.endpoints.roles, token: cred.token }).catch(() => null),
  ]);
  if (!okStatus(initRaw)) throw new OaError("overtime_ng", 502, ngReason(initRaw, "加班申请取不到"));
  const v = initRaw as Record<string, unknown>;
  const leaders = readLeaders(leadersRaw);
  const workflow = v.workflow_list && typeof v.workflow_list === "object" ? (v.workflow_list as Record<string, unknown>) : {};
  const applyList = Array.isArray(v.apply_list) ? (v.apply_list as unknown[]) : [];
  // 固定名单可能落在两个候选表里（部门负责人表优先），按工号对 id。
  const pool = [...leaders.l2, ...leaders.l1];
  // 二级审批人：优先「我上一次申请的第二级是谁」——它跟 OA 表单里那两条只读框逐字一致；
  // `depart_leader_data.last` 只是兜底，实测它会随部门/时间给出另一批人，不可全信。
  const fixedKeys = lastStepPeople(applyList, workflow, 2);
  const fixedL2 = fixedKeys.length > 0 ? resolvePeople(fixedKeys, pool) : resolvePeople(readDepartManagers(rolesRaw), pool);
  return {
    applyList,
    workflow,
    reasons: Array.isArray(v.overtime_reason) ? (v.overtime_reason as unknown[]).filter((x): x is string => typeof x === "string") : [],
    admitTime: typeof v.overtime_admit_time === "string" ? v.overtime_admit_time : "",
    rule: typeof v.overtime_rule === "string" ? v.overtime_rule : "",
    leaders,
    fixedL2,
    defaultL1: resolvePeople([lastLeadApprover(applyList, workflow)], leaders.l1),
  };
}

// ---------------------------------------------------------------- HTTP

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function fail(res: http.ServerResponse, status: number, code: string, error: string): void {
  json(res, status, { error, code });
}

/** 回一句错误并结束这个请求：handler 统一 `return true`，这里省掉二十来处 `return true`。 */
function stop(res: http.ServerResponse, status: number, code: string, error: string): true {
  fail(res, status, code, error);
  return true;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 64 * 1024) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(b);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export interface AttendanceHttpCtx {
  /** 公网隧道进来的请求：整个模块不存在。 */
  publicReq: boolean;
  /** 桥内测试缝，生产不传。 */
  upstream?: string;
  /** 发系统通知用的通道；单测里塞假的。 */
  notifier?: ReminderSink;
  /** 点开系统通知时打开的地址。 */
  pageUrl?: string;
}

/** 提醒面板要的东西：规则、上一次实际发送、推送通道还通不通。 */
function reminderPayload(ctx: AttendanceHttpCtx) {
  const rec = readReminder();
  return {
    rule: rec.rule,
    lastFiredDate: rec.lastFiredDate,
    lastFiredAt: rec.lastFiredAt,
    lastSent: rec.lastSent,
    title: REMINDER_TITLE,
    pushEnabled: ctx.notifier?.enabled ?? false,
    pushSubscriptions: ctx.notifier?.subscriptionCount() ?? 0,
  };
}

/** 页面用的状态摘要。密码、token 一律不出现，账号只给掩码。 */
async function statePayload(cfg: AttendanceConfig | null, problem: string | null) {
  const cred = await readCredentials();
  const cache = readCache();
  return {
    configured: Boolean(cfg?.apiBase),
    problem,
    apiBase: cfg?.apiBase ?? "",
    pageBase: cfg?.pageBase ?? "",
    account: maskAccount(cfg?.account ?? cred?.account ?? ""),
    loggedIn: Boolean(cred?.token && tokenFresh(cred)),
    expiresAt: cred?.tokenExp ?? 0,
    userName: cred?.name ?? "",
    workNoMask: cred?.workNo ? maskAccount(cred.workNo) : "",
    cacheDays: Object.keys(cache.days).length,
    cacheFetchedAt: cache.fetchedAt,
    maxDay: cache.maxDay,
  };
}

export async function handleAttendance(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AttendanceHttpCtx,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/attendance/")) return false;
  // 决策：隧道访客整页隐身 —— 不接这个请求，落到 index.ts 的兜底 404。
  if (ctx.publicReq) return false;
  const method = req.method ?? "GET";
  const oaCtx: OaCtx = { upstream: ctx.upstream };

  try {
    const { config, problem } = readConfig();

    // ---- 加班提醒
    if (url.pathname === "/api/attendance/reminder") {
      if (method === "GET") {
        json(res, 200, reminderPayload(ctx));
        return true;
      }
      if (method !== "PUT") return stop(res, 405, "bad_method", "不支持这个请求方法");
      const body = await readJsonBody(req);
      const current = readReminder();
      const rule = normalizeRule(body, current.rule);
      const problem2 = ruleProblem(rule);
      if (problem2) return stop(res, 400, "bad_reminder", problem2);
      // 改了规则就把「今天发过了」清掉：不然用户把时间往前挪，当天就再也收不到。
      const shifted = rule.time !== current.rule.time || String(rule.days) !== String(current.rule.days);
      writeReminder({ ...current, rule, ...(shifted ? { lastFiredDate: "" } : {}) });
      json(res, 200, reminderPayload(ctx));
      return true;
    }

    if (url.pathname === "/api/attendance/reminder/test") {
      if (method !== "POST") return stop(res, 405, "bad_method", "不支持这个请求方法");
      const sink = ctx.notifier;
      if (!sink) return stop(res, 500, "no_notifier", "这条桥没有通知通道");
      if (!sink.enabled) return stop(res, 409, "notify_off", "通知总开关是关的：去 pi 设置 → 通知里打开");
      if (sink.subscriptionCount() === 0) {
        return stop(res, 409, "no_subscription", "还没有设备订阅推送：去 pi 设置 → 通知里打开推送并允许浏览器通知");
      }
      const rec = readReminder();
      const result = await sink.push(REMINDER_TITLE, reminderBody(rec.rule, false), ctx.pageUrl ?? "/", true);
      json(res, 200, { sent: result.sent, failed: result.failed });
      return true;
    }

    // ---- 状态 / 配置
    if (url.pathname === "/api/attendance/state") {
      if (method !== "GET") return stop(res, 405, "bad_method", "不支持这个请求方法");
      json(res, 200, await statePayload(config.apiBase ? config : null, problem));
      return true;
    }

    if (url.pathname === "/api/attendance/config") {
      if (method === "GET") {
        json(res, 200, {
          apiBase: config.apiBase,
          pageBase: config.pageBase,
          account: config.account,
          resolvedApiBase: config.apiBase,
        });
        return true;
      }
      if (method === "PUT") {
        const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
        const apiBase = typeof body.apiBase === "string" ? body.apiBase.trim() : "";
        const pageBase = typeof body.pageBase === "string" ? body.pageBase.trim() : "";
        const account = typeof body.account === "string" ? body.account.trim() : "";
        const p1 = baseUrlProblem(apiBase, "接口地址");
        if (p1) return stop(res, 400, "bad_api_base", p1);
        if (pageBase) {
          const p2 = baseUrlProblem(pageBase, "网页地址");
          if (p2) return stop(res, 400, "bad_page_base", p2);
        }
        // 页面只知道掩码（TS***1）：空着就沿用已经存着的账号，别把掩码存成账号。
        const kept = account || config.account;
        if (!kept) return stop(res, 400, "no_account", "请填登录账号");
        if (kept.includes("*")) return stop(res, 400, "bad_account", "账号不能带掩码，请重新填一遍");
        const next: AttendanceConfig = { ...config, apiBase: apiBase.replace(/\/+$/, ""), pageBase, account: kept };
        writeConfig(next);
        audit({ kind: "config", account: maskAccount(kept), apiBase });
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "DELETE") {
        // 清除本地数据：配置 + 凭据 + 缓存。审计留着（那是「做过什么」的记录，不含密码）。
        await clearCredentials();
        fs.rmSync(cacheFile(), { force: true });
        fs.rmSync(configFile(), { force: true });
        audit({ kind: "purge" });
        json(res, 200, { ok: true });
        return true;
      }
      fail(res, 405, "bad_method", "不支持这个请求方法");
      return true;
    }

    // ---- 登录
    if (url.pathname === "/api/attendance/login") {
      if (method !== "POST") return stop(res, 405, "bad_method", "不支持这个请求方法");
      const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
      // 空串和缺字段一个意思：沿用已经存着的账号。写成三元会让 `account: ""` 跳过回退。
      const given = typeof body.account === "string" ? body.account.trim() : "";
      const account = given || config.account;
      const password = typeof body.password === "string" ? body.password : "";
      if (!account) return stop(res, 400, "no_account", "请填账号");
      if (account.includes("*")) return stop(res, 400, "bad_account", "账号不能带掩码，请重新填一遍");
      if (!password) return stop(res, 400, "no_password", "请填密码");
      if (!config.apiBase) return stop(res, 400, "not_configured", "先配好 OA 地址");
      const result = await login(config, oaCtx, account, password);
      await writeCredentials({
        account,
        password,
        token: result.token,
        tokenExp: jwtExp(result.token),
        userId: result.userId,
        name: result.name,
        workNo: result.workNo,
      });
      if (config.account !== account) writeConfig({ ...config, account });
      audit({ kind: "login", account: maskAccount(account), ok: true });
      json(res, 200, { ok: true, userName: result.name, workNoMask: maskAccount(result.workNo) });
      return true;
    }

    if (url.pathname === "/api/attendance/logout") {
      if (method !== "POST") return stop(res, 405, "bad_method", "不支持这个请求方法");
      await clearCredentials();
      audit({ kind: "logout" });
      json(res, 200, { ok: true });
      return true;
    }

    // ---- 考勤记录
    if (url.pathname === "/api/attendance/records") {
      if (method !== "GET") return stop(res, 405, "bad_method", "不支持这个请求方法");
      if (!config.apiBase) return stop(res, 400, "not_configured", "先配好 OA 地址");
      const range = clampRange(
        url.searchParams.get("start") ?? "",
        url.searchParams.get("end") ?? "",
        todayKey(),
      );
      if (range.problem && !url.searchParams.get("start")) {
        return stop(res, 400, "bad_range", range.problem);
      }
      // 用盒子装：在回调里赋值的 let 会被 TS 收窄成 null（回调不算赋值路径）。
      const box: { cred: Credentials | null } = { cred: null };
      let live: { rows: AttendanceRow[]; maxDay: string } | null = null;
      let failure: unknown = null;
      try {
        live = await withSession(config, oaCtx, (cred) => {
          box.cred = cred;
          return fetchRecords(config, oaCtx, cred, range.start, range.end);
        });
      } catch (err) {
        if (!(err instanceof OaError) && !(err instanceof SecretError)) throw err;
        failure = err;
      }
      if (live) {
        const account = box.cred?.account ?? "";
        const cache = mergeRows(readCacheFor(account), live.rows, live.maxDay, account);
        writeCache(cache);
        json(res, 200, {
          rows: live.rows,
          summary: summarize(live.rows, live.maxDay),
          range,
          source: "live",
          fetchedAt: cache.fetchedAt,
          stale: false,
          problem: null,
        });
        return true;
      }
      // 没登录态：拿缓存顶（面板至少能看历史）；有登录态但取数失败：
      // 这个区间没缓存可顶就把真话抛出去，别拿旧数据充数。
      const used = box.cred;
      const cache = used ? readCacheFor(used.account) : readCache();
      const rows = rowsInRange(cache, range.start, range.end);
      if (used && rows.length === 0) throw failure;
      json(res, 200, {
        rows,
        summary: summarize(rows, cache.maxDay),
        range,
        source: "cache",
        fetchedAt: cache.fetchedAt,
        stale: true,
        problem: (failure as Error | null)?.message || "没登录",
      });
      return true;
    }

    // ---- 加班申请
    if (url.pathname === "/api/attendance/overtime") {
      if (!config.apiBase) return stop(res, 400, "not_configured", "先配好 OA 地址");
      const cred = await session(config, oaCtx);
      if (method === "GET") {
        const init = await withSession(config, oaCtx, (fresh) => fetchOvertimeInit(config, oaCtx, fresh));
        json(res, 200, {
          // reason 在 OA 里是一段 JSON 字符串，解析好一起给页面，省得两边各写一份。
          applyList: init.applyList.map((item) => {
            const row = item as Record<string, unknown>;
            return { ...row, reasonParsed: parseOvertimeReason(row.reason) };
          }),
          workflow: init.workflow,
          reasons: init.reasons,
          admitTime: init.admitTime,
          rule: init.rule,
          candidates: init.leaders,
          // 二级审批人在 OA 里就是「部门负责人」那两条，页面只读；一级默认上一次的那个人，可以改。
          fixedL2: init.fixedL2,
          defaultL1: init.defaultL1,
          userId: cred.userId,
        });
        return true;
      }
      if (method !== "POST") return stop(res, 405, "bad_method", "不支持这个请求方法");

      const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
      const startTime = fromLocalInput(String(body.startTime ?? ""));
      const endTime = fromLocalInput(String(body.endTime ?? ""));
      const hours = normalizeHours(Number(body.hours ?? 0));
      const rawReason = body.reason;
      const reason: OvertimeReason = {
        type: String((rawReason as Record<string, unknown>)?.type ?? ""),
        project: String((rawReason as Record<string, unknown>)?.project ?? ""),
        detail: String((rawReason as Record<string, unknown>)?.detail ?? ""),
      };
      const wf = readWorkflow(body.workflow);
      const workflow = formatWorkflow(wf.l1, wf.l2);

      const problem: OvertimeProblem | null = checkDraft({ startTime, endTime, hours, reason, workflow });
      if (problem) return stop(res, 400, problem.code, problem.message);

      const key = receiptKey({ account: cred.account, startTime, endTime, hours, reason: formatOvertimeReason(reason) });
      const dup = findReceipt(receipts, key, Date.now());
      if (dup) {
        json(res, 409, {
          code: "duplicate",
          error: `十分钟内已经提交过一次同样的申请（单号 ${dup.code ?? "未知"}），要再提交一次请先确认它没进系统`,
          receiptCode: dup.code ?? "",
        });
        return true;
      }
      // 二次确认：不带 confirm 的这一发只算「你确认一下」，不写任何东西。
      if (body.confirm !== true) {
        json(res, 200, {
          needConfirm: true,
          preview: { startTime, endTime, hours, reason, workflow, userId: cred.userId },
        });
        return true;
      }

      const data = await withSession(config, oaCtx, (fresh) =>
        oaFetch(config, oaCtx, {
          method: "POST",
          endpoint: config.endpoints.overtimeAdd,
          token: fresh.token,
          body: {
            use_type: Number(body.useType ?? 0) || 0,
            user_id: fresh.userId,
            agent_user_id: 0,
            reason: formatOvertimeReason(reason),
            start_time: startTime,
            end_time: endTime,
            workflow_list: workflow,
          },
        }),
      );
      const ok = okStatus(data);
      const message = ok ? "" : ngReason(data, "提交被拒了");
      receipts = [
        ...receipts.filter((r) => Date.now() - r.at < 30 * 60_000),
        { key, at: Date.now(), ok, code: ok ? "" : undefined, message: message || undefined },
      ];
      audit({ kind: "overtime_add", ok, startTime, endTime, hours, message });
      if (!ok) return stop(res, 502, "rejected", message);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- 撤回：POST /api/attendance/overtime/cancel?code=<单号>
    if (url.pathname === "/api/attendance/overtime/cancel") {
      if (method !== "POST") return stop(res, 405, "bad_method", "不支持这个请求方法");
      if (!config.apiBase) return stop(res, 400, "not_configured", "先配好 OA 地址");
      const code = (url.searchParams.get("code") ?? "").trim();
      if (!/^\d{1,12}$/.test(code)) return stop(res, 400, "bad_code", "单号不对");
      if (url.searchParams.get("confirm") !== "1") {
        json(res, 200, { needConfirm: true, code });
        return true;
      }
      const data = await withSession(config, oaCtx, (fresh) =>
        oaFetch(config, oaCtx, {
          method: "POST",
          endpoint: config.endpoints.overtimeCancel,
          token: fresh.token,
          query: { code },
        }),
      );
      const ok = okStatus(data);
      audit({ kind: "overtime_cancel", ok, code });
      if (!ok) return stop(res, 502, "rejected", ngReason(data, "撤回被拒了"));
      json(res, 200, { ok: true });
      return true;
    }

    fail(res, 404, "not_found", "没有这个接口");
    return true;
  } catch (err) {
    if (err instanceof OaError) {
      fail(res, err.status, err.code, err.message);
      return true;
    }
    if (err instanceof SecretError) {
      fail(res, 401, err.problem, err.message);
      return true;
    }
    fail(res, 500, "attendance_internal", "考勤面板处理失败");
    return true;
  }
}
