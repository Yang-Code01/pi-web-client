/**
 * 考勤页的纯函数：日期区间、审批状态、时间与工时的显示口径。
 *
 * 放在单独文件里（不像 `attendance.ts` 那样 import CSS / 动 DOM），
 * 是为了 `web/tests/attendance-unit.mjs` 能在 Node 里直接 import 着测。
 * 桥端有一份同样思路的 `bridge/src/attendance-model.ts`；两边口径要一致：
 *   - 一次查询最多 90 天（桥端裁，页面只负责给出默认 14 天）
 *   - 审批链里 `workflow_result` 0 = 待批、1 = 已批、null = 还没轮到
 */

const DAY = 86_400_000;

/** 本地日期 `2026-11-07`。**不能用 toISOString**，那是 UTC，早上 8 点前会差一天。 */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 默认看「最近 14 天（含今天）」。 */
export function defaultRange(now: Date = new Date()): { start: string; end: string } {
  return { start: dateKey(new Date(now.getTime() - 13 * DAY)), end: dateKey(now) };
}

export type StepState =
  | { kind: "ended" }
  | { kind: "pending"; role: string }
  | { kind: "running" };

/**
 * 一张申请现在走到哪了。
 * `result` 是申请本身的 `workflow_result`（0 = 还没结束）；`chain` 是它的审批链数组。
 */
export function stepState(chain: unknown, result: number): StepState {
  if (result !== 0) return { kind: "ended" };
  const steps = Array.isArray(chain) ? (chain as Record<string, unknown>[]) : [];
  // 0 和 null 都算「卡在这一步」：0 是轮到但没批，null 是还没轮到。
  const pending = steps.find((s) => s.workflow_result === 0 || s.workflow_result === null);
  if (!pending) return { kind: "running" };
  return { kind: "pending", role: String(pending.workflow_role_name ?? "") };
}

/** `2` → `2 h`、`1.5` → `1.5 h`。整数不拖 `.0`。 */
export function hoursText(hours: number): string {
  if (!Number.isFinite(hours)) return "—";
  const s = String(Math.round(hours * 100) / 100);
  return `${s} h`;
}

/** `2026-11-16T18:00:00` + `2026-11-16T20:30:00` → `2026-11-16 18:00 → 20:30`。 */
export function spanText(startIso: string, endIso: string): string {
  const day = String(startIso ?? "").replace("T", " ").slice(0, 16);
  const tail = String(endIso ?? "").replace("T", " ").slice(11, 16);
  return tail ? `${day} → ${tail}` : day;
}

/** 事由是 OA 塞在字符串里的 JSON，解不开就当没有，不要拿原文糊到页面上。 */
export function reasonText(reason: { type?: string; project?: string } | null | undefined): string {
  if (!reason) return "";
  const type = String(reason.type ?? "").trim();
  const project = String(reason.project ?? "").trim();
  if (!type) return project;
  return project ? `${type} / ${project}` : type;
}

/** 小时数只留一位小数：0.30000000000000004 这种浮点尾巴不要出现在界面上。 */
/**
 * 加班申请的时间窗默认值：工作日 `18:00–22:00`，周末 `09:00–18:00`。
 * 参数是 `YYYY-MM-DD`（不是 Date，免得调用方各自处理时区）；日期不合法时按工作日给。
 */
export function defaultWindow(dateKey: string): { start: string; end: string } {
  const day = new Date(`${dateKey.slice(0, 10)}T00:00:00`);
  const weekday = Number.isFinite(day.getTime()) ? day.getDay() : 1;
  // 0 = 周日，6 = 周六：这两天在 OA 里算「周末加班」，白天来。
  return weekday === 0 || weekday === 6 ? { start: "09:00", end: "18:00" } : { start: "18:00", end: "22:00" };
}


export function round1(n: number): number {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/**
 * 加班拆成「平时 / 周末」两笔。
 * OA 只给总时长和周末时长，平时是减出来的；两天里的 0.30000000000000004 都是这么来的。
 */
export function overtimeSplit(
  summary: { overtime?: number; weekendOvertime?: number } | null | undefined,
): { workday: number; weekend: number } {
  const total = round1(Math.max(0, Number(summary?.overtime) || 0));
  const weekend = round1(Math.max(0, Number(summary?.weekendOvertime) || 0));
  return { workday: round1(Math.max(0, total - weekend)), weekend };
}

/** 一天里的请假分项，顺序定死（`l_hours` 语义没坐实，不进这张表）。 */
export type LeaveKind = "compensatory" | "personal" | "sick" | "other" | "trip";

export interface LeaveHoursLike {
  compensatory?: number;
  personal?: number;
  sick?: number;
  other?: number;
  trip?: number;
}

/** 当天有小时数的假别，按固定顺序列出来；0 的不列，老缓存缺字段也当 0。 */
export function leaveKinds(hours: LeaveHoursLike | null | undefined): { kind: LeaveKind; hours: number }[] {
  const order: LeaveKind[] = ["compensatory", "personal", "sick", "other", "trip"];
  const out: { kind: LeaveKind; hours: number }[] = [];
  for (const kind of order) {
    const h = round1(Math.max(0, Number(hours?.[kind]) || 0));
    if (h > 0) out.push({ kind, hours: h });
  }
  return out;
}

/** 某一类假在一段记录里的合计（页面从行里算，不另要一份可能对不上的汇总）。 */
export function leaveTotal(rows: { leaveHours?: LeaveHoursLike | null }[], kind: LeaveKind): number {
  return round1(rows.reduce((n, r) => n + (Number(r.leaveHours?.[kind]) || 0), 0));
}
