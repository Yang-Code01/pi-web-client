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
