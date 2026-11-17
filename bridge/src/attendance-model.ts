/**
 * 考勤模块的纯逻辑：日期区间、退避、回执去重、行映射、申请校验。
 *
 * 这一层不碰网络、不碰磁盘、不读环境，桥与页面各用一半（页面只用日期与格式化那几个）。
 * 之所以单独成文件：`bridge/src/attendance.ts` 里的东西都要真连一台 OA 才能验，而这里
 * 全部可以用 `node --test` 直接钉住（`bridge/tests/attendance-unit.mjs`）。
 */

/** 本地日期 `YYYY-MM-DD`。**不要用 toISOString**：那是 UTC，东八区会差一天。 */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayKey(now: Date = new Date()): string {
  return dateKey(now);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(raw: unknown): raw is string {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00`);
  return !Number.isNaN(d.getTime()) && dateKey(d) === raw;
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** `b - a` 的天数（按日历日，不是毫秒除法）。 */
export function diffDays(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/** 缓存留多久（决策：90 天）。超过就裁掉最早的。 */
export const MAX_RANGE_DAYS = 90;

export interface RangeResult {
  start: string;
  end: string;
  /** 区间被裁过（起点后移或终点前移）。 */
  clamped: boolean;
  /** 入参本身不合法时的原因，中文；合法时为 null。 */
  problem: string | null;
}

/**
 * 把用户要的区间收进「今天往前 maxDays 天」。返回值永远可用（不合法时退化成最近 7 天），
 * 由 `problem` 说明原因 —— 路由层据此回 400，但缓存层照样能拿到东西。
 */
export function clampRange(
  rawStart: string,
  rawEnd: string,
  today: string,
  maxDays: number = MAX_RANGE_DAYS,
): RangeResult {
  const fallbackEnd = today;
  const fallbackStart = addDays(today, -6);
  if (!isDateKey(rawStart) || !isDateKey(rawEnd)) {
    return {
      start: fallbackStart,
      end: fallbackEnd,
      clamped: true,
      problem: "日期要写成 YYYY-MM-DD",
    };
  }
  let start = rawStart;
  let end = rawEnd;
  let problem: string | null = null;
  if (start > end) {
    [start, end] = [end, start];
    problem = "起止日期反了，已自动对调";
  }
  // 上限按「本次请求的跨度」算，不是按「离今天多远」算：
  // 回看一段历史时 end 常常早于今天，按今天算会白白少给几天。
  const floor = addDays(end, -(maxDays - 1));
  let clamped = false;
  if (end > today) {
    end = today;
    clamped = true;
  }
  if (start < floor) {
    start = floor;
    clamped = true;
    if (!problem) problem = `一次最多看 ${maxDays} 天`;
  }
  if (start > end) {
    start = end;
    clamped = true;
  }
  return { start, end, clamped, problem };
}

// ---------------------------------------------------------------- 登录退避

/** 十分钟内最多试三次，之后再试要等窗口滑过去。 */
export const LOGIN_WINDOW_MS = 10 * 60_000;
export const LOGIN_MAX_FAILURES = 3;
/** 第一次失败等 1s，然后翻倍；封顶 60s（窗口本身才是硬上限）。 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface LoginGate {
  allowed: boolean;
  /** 还要等多久才允许再试；allowed 为 true 时是 0。 */
  waitMs: number;
  /** 窗口内已有的失败次数（含马上要记的这一次之前）。 */
  failures: number;
  /** 拒绝原因，中文；允许时 null。 */
  reason: string | null;
}

/**
 * 登录闸门。`failures` 是历史失败的时间戳（毫秒），乱序也行，窗口外的自动丢弃。
 * 「失败即停」是这个模块唯一的刹车：OA 有账号锁定，试错等于把人锁在外面。
 */
export function loginGate(failures: number[], now: number): LoginGate {
  const inWindow = failures.filter((t) => Number.isFinite(t) && now - t < LOGIN_WINDOW_MS && t <= now);
  if (inWindow.length >= LOGIN_MAX_FAILURES) {
    const oldest = Math.min(...inWindow);
    const waitMs = Math.max(0, oldest + LOGIN_WINDOW_MS - now);
    return {
      allowed: false,
      waitMs,
      failures: inWindow.length,
      reason: `连续失败 ${inWindow.length} 次，${Math.ceil(waitMs / 1000)} 秒后再试`,
    };
  }
  if (inWindow.length > 0) {
    const last = Math.max(...inWindow);
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (inWindow.length - 1), BACKOFF_CAP_MS);
    const waitMs = Math.max(0, last + wait - now);
    if (waitMs > 0) {
      return {
        allowed: false,
        waitMs,
        failures: inWindow.length,
        reason: `上次没登进去，${Math.ceil(waitMs / 1000)} 秒后再试`,
      };
    }
  }
  return { allowed: true, waitMs: 0, failures: inWindow.length, reason: null };
}

/** 记完一次失败后，下一次至少要等多久（用于「页面告诉我几秒后重试」）。 */
export function loginRetryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------- 回执去重

/**
 * 一次提交的指纹：账号不变、内容一模一样，就是同一次提交（手抖点两下、页面重连重发）。
 * 用 FNV-1a 而不是 crypto：纯函数、同步、跨平台一致，单测不用比对的其实是「稳定性」。
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface ReceiptKeyInput {
  account: string;
  startTime: string;
  endTime: string;
  hours: number;
  reason: string;
}

/** 提交指纹（决策：防重复提交）。只由内容决定，与时间、页面、请求 id 无关。 */
export function receiptKey(input: ReceiptKeyInput): string {
  const norm = [
    input.account.trim().toLowerCase(),
    input.startTime.trim(),
    input.endTime.trim(),
    String(input.hours),
    input.reason.trim(),
  ].join("\u0001");
  return fnv1a(norm);
}

export interface ReceiptRecord {
  key: string;
  at: number;
  ok: boolean;
  code?: string;
  message?: string;
}

/** 最近 `windowMs` 内有没有同指纹的成功回执。只有成功的才挡重复；失败的重试是应该的。 */
export function findReceipt(
  records: ReceiptRecord[],
  key: string,
  now: number,
  windowMs = 10 * 60_000,
): ReceiptRecord | null {
  let hit: ReceiptRecord | null = null;
  for (const r of records) {
    if (r.key !== key || !r.ok) continue;
    if (now - r.at > windowMs) continue;
    if (!hit || r.at > hit.at) hit = r;
  }
  return hit;
}

// ---------------------------------------------------------------- 掩码

/** 账号掩码：够长就留头两位和末一位，短的一律只剩首位。 */
export function maskAccount(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.length <= 4) return `${s[0]}***`;
  return `${s.slice(0, 2)}***${s.slice(-1)}`;
}

// ---------------------------------------------------------------- 行映射

/**
 * OA 的 `day`（`2026-10-08(四)`）拆成日期 + 星期。拆不出来就原样当日期，星期留空。
 */
export function splitDay(raw: unknown): { date: string; weekday: string } {
  const s = typeof raw === "string" ? raw : "";
  const m = /^(\d{4}-\d{2}-\d{2})\s*(?:[(（]([^)）]+)[)）])?/.exec(s);
  if (!m) return { date: s, weekday: "" };
  return { date: m[1]!, weekday: m[2] ?? "" };
}

/** 时间字段可能是 `HH:mm`、`HH:mm:ss`、null 或空串。空的一律归 null。 */
export function clockOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return s;
  return `${m[1]!.padStart(2, "0")}:${m[2]!}`;
}

export function numOf(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

export interface AttendanceRow {
  date: string;
  weekday: string;
  /** 0=平日 1=周末（OA 的 day_type）。认不出来时按 false 处理。 */
  weekend: boolean;
  clockIn: string | null;
  clockOut: string | null;
  /** 加班小时（OA 的 `ov`）。 */
  overtime: number;
  /** 加班时长被人工改过（OA 的 `overtime_rewrite_enable`），页面据此加「已修改」标记。 */
  overtimeEdited: boolean;
  editedBy: string;
  /** OA 原样一行。语义没坐实的字段（c_hours / t_hours 等）只在这里出现，页面的「详情」展开它。 */
  raw: Record<string, unknown>;
}

export interface RowMapOptions {
  /** 字段名映射，换系统只改这里（默认对齐本项目的 OA）。 */
  day?: string;
  dayType?: string;
  clockIn?: string;
  clockOut?: string;
  overtime?: string;
  overtimeEdited?: string;
  editedBy?: string;
}

export function mapRow(raw: Record<string, unknown>, opts: RowMapOptions = {}): AttendanceRow {
  const day = splitDay(raw[opts.day ?? "day"]);
  return {
    date: day.date,
    weekday: day.weekday,
    weekend: numOf(raw[opts.dayType ?? "day_type"]) === 1,
    clockIn: clockOf(raw[opts.clockIn ?? "start"]),
    clockOut: clockOf(raw[opts.clockOut ?? "end"]),
    overtime: numOf(raw[opts.overtime ?? "ov"]),
    overtimeEdited: numOf(raw[opts.overtimeEdited ?? "overtime_rewrite_enable"]) === 1,
    editedBy: typeof raw[opts.editedBy ?? "update_name"] === "string" ? String(raw[opts.editedBy ?? "update_name"]) : "",
    raw,
  };
}

export interface AttendanceSummary {
  days: number;
  attended: number;
  missing: number;
  overtime: number;
  weekendOvertime: number;
  /** 有打卡记录的最后一天（OA 的 `max_day` 优先）。 */
  lastDay: string;
}

/** 缺卡 = 平日、有日期、但上班或下班时间缺一个。周末没打卡不算缺。 */
/**
 * 统计口径。`today` 传了的话，今天这一行整行不计缺卡 —— 一天还没过完，
 * 「缺下班卡」在上午十点也是真的，把它算成缺卡会让人每天都看到一条假的。
 */
export function summarize(rows: AttendanceRow[], maxDay = "", today = ""): AttendanceSummary {
  let attended = 0;
  let missing = 0;
  let overtime = 0;
  let weekendOvertime = 0;
  let last = maxDay;
  for (const r of rows) {
    if (r.clockIn || r.clockOut) attended++;
    if (!r.weekend && r.date !== today && (!r.clockIn || !r.clockOut)) missing++;
    overtime += r.overtime;
    if (r.weekend) weekendOvertime += r.overtime;
    if (r.date > last) last = r.date;
  }
  return {
    days: rows.length,
    attended,
    missing,
    overtime: round1(overtime),
    weekendOvertime: round1(weekendOvertime),
    lastDay: last,
  };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------- 加班申请

/** OA 把申请类型存成整数；语义没坐实前只有一个已知值，其余原样透传。 */
export const OVERTIME_USE_TYPE_DEFAULT = 0;

export interface OvertimeReason {
  type: string;
  project: string;
  detail: string;
}

/** OA 的 `reason` 是一段 JSON 字符串。坏的、空的、非对象的都退化成空理由，不抛。 */
export function parseOvertimeReason(raw: unknown): OvertimeReason {
  if (typeof raw !== "string" || !raw.trim()) return { type: "", project: "", detail: "" };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object") return { type: "", project: "", detail: "" };
    const pick = (k: string) => (typeof v[k] === "string" ? String(v[k]) : "");
    return { type: pick("type"), project: pick("project"), detail: pick("detail") };
  } catch {
    return { type: "", project: "", detail: "" };
  }
}

export function formatOvertimeReason(r: OvertimeReason): string {
  return JSON.stringify({ type: r.type, project: r.project, detail: r.detail });
}

/**
 * 审批链字符串：一级 `a,b`、二级 `c`，中间 `&` 分开（OA 的 `workflow_list` 就是这个形状）。
 * 空级留空位，保持 `&` 的位置。
 */
export function formatWorkflow(l1: number[], l2: number[]): string {
  return `${l1.filter((n) => n > 0).join(",")}&${l2.filter((n) => n > 0).join(",")}`;
}

export function parseWorkflow(raw: string): { l1: number[]; l2: number[] } {
  const [a = "", b = ""] = String(raw ?? "").split("&");
  const ids = (s: string) =>
    s
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  return { l1: ids(a), l2: ids(b) };
}

/** `2026-11-16T18:00:00` ⇄ `<input type="datetime-local">` 的 `2026-11-16T18:00`。 */
export function toLocalInput(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[1]}T${m[2]}` : "";
}

export function fromLocalInput(raw: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(String(raw ?? ""));
  if (!m) return "";
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}`;
}

export interface OvertimeDraft {
  startTime: string;
  endTime: string;
  hours: number;
  reason: OvertimeReason;
  workflow: string;
}

export type OvertimeProblemCode =
  | "time_missing"
  | "time_order"
  | "hours_zero"
  | "hours_mismatch"
  | "reason_type_missing"
  | "approver_missing";

export interface OvertimeProblem {
  code: OvertimeProblemCode;
  message: string;
}

/**
 * 提交前的本地校验。返回第一条毛病（中文），没问题就是 null。
 *
 * `hours` 与区间不一致只算「提醒」不拦：OA 允许按半天/整天取整，业务上真这么填。
 * 但差了整整一小时以上基本是手滑，让页面提示一句。
 */
export function checkDraft(d: OvertimeDraft): OvertimeProblem | null {
  const s = fromLocalInput(d.startTime) || d.startTime;
  const e = fromLocalInput(d.endTime) || d.endTime;
  if (!s || !e) return { code: "time_missing", message: "开始和结束时间都要填" };
  const ds = new Date(s);
  const de = new Date(e);
  if (Number.isNaN(ds.getTime()) || Number.isNaN(de.getTime())) {
    return { code: "time_missing", message: "时间格式不对" };
  }
  if (de <= ds) return { code: "time_order", message: "结束时间要晚于开始时间" };
  if (!(d.hours > 0)) return { code: "hours_zero", message: "时长要大于 0" };
  const span = (de.getTime() - ds.getTime()) / 3_600_000;
  if (Math.abs(span - d.hours) >= 1) {
    return {
      code: "hours_mismatch",
      message: `时间区间是 ${round1(span)} 小时，填的时长是 ${round1(d.hours)} 小时`,
    };
  }
  if (!d.reason.type.trim()) return { code: "reason_type_missing", message: "选一个加班事由" };
  const wf = parseWorkflow(d.workflow);
  if (wf.l1.length === 0 && wf.l2.length === 0) {
    return { code: "approver_missing", message: "至少要选一个审批人" };
  }
  return null;
}

/** 加班时长口径：只收 0.5 小时的倍数（半天起）。返回规范化后的值。 */
export function normalizeHours(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return round1(Math.round(raw * 2) / 2);
}
