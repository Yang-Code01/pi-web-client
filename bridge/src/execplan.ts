import { currentBranch } from "./items.ts";
import type { SessionEntry } from "./sessionfile.ts";

export type PlanTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface PlanTask {
  id: number;
  subject: string;
  activeForm?: string;
  status: PlanTaskStatus;
  blockedBy?: number[];
}

export interface PlanSnapshot {
  tasks: PlanTask[];
  listedRound: string | null;
  /**
   * #357：这份快照之后又调用了几次**别的**工具（todo 自己不算）。页面拿它判断「计划可能过期」——
   * 模型干了一大堆活却没 update，面板就不该再说「现在 · 第 2 步」。缺省 = 0（刚写下的快照）。
   */
  sinceUpdate?: number;
}

const STATUSES = new Set<PlanTaskStatus>(["pending", "in_progress", "completed", "deleted"]);

function tasksFrom(value: unknown): PlanTask[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: PlanTask[] = [];
  for (const valueTask of value) {
    if (!valueTask || typeof valueTask !== "object") return null;
    const task = valueTask as Record<string, unknown>;
    if (!Number.isSafeInteger(task.id) || typeof task.subject !== "string" || !STATUSES.has(task.status as PlanTaskStatus)) return null;
    if (task.activeForm !== undefined && typeof task.activeForm !== "string") return null;
    if (task.blockedBy !== undefined && (!Array.isArray(task.blockedBy) || !task.blockedBy.every(Number.isSafeInteger))) return null;
    tasks.push({
      id: task.id as number,
      subject: task.subject,
      status: task.status as PlanTaskStatus,
      ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
      ...(Array.isArray(task.blockedBy) ? { blockedBy: [...task.blockedBy] as number[] } : {}),
    });
  }
  return tasks;
}

function isOpen(plan: PlanSnapshot | null): boolean {
  return Boolean(plan?.tasks.some((task) => task.status !== "completed" && task.status !== "deleted"));
}

function applyDetails(
  previous: PlanSnapshot | null,
  details: unknown,
  roundId: string | null,
): PlanSnapshot | null {
  if (!details || typeof details !== "object") return previous;
  const envelope = details as Record<string, unknown>;
  const tasks = tasksFrom(envelope.tasks);
  if (!tasks) return previous;
  if (!tasks.length || envelope.action === "clear") return null;
  const action = envelope.action;
  const startsNewPlan = action === "create" && !isOpen(previous);
  const listedRound = previous && !startsNewPlan ? previous.listedRound : roundId;
  return { tasks, listedRound };
}

/** Replay todo snapshots on pi's active branch; custom entries cover nested tool calls. */
export function planReplayFromEntries(entries: SessionEntry[]): {
  plan: PlanSnapshot | null;
  toolResults: Map<string, PlanSnapshot | null>;
} {
  let plan: PlanSnapshot | null = null;
  let roundId: string | null = null;
  const toolResults = new Map<string, PlanSnapshot | null>();
  for (const entry of currentBranch(entries)) {
    if (entry.type === "message" && entry.message?.role === "user") roundId = entry.id;
    if (entry.type === "custom" && entry.customType === "rpiv-todo-state") {
      plan = applyDetails(plan, entry.data, roundId);
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    if (entry.message?.toolName !== "todo") {
      plan = afterOtherTool(plan);
      continue;
    }
    plan = applyDetails(plan, entry.message.details, roundId);
    const toolCallId = entry.message.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) toolResults.set(toolCallId, plan);
  }
  return { plan, toolResults };
}

/** #357：计划之后又跑了一个别的工具 —— 计数加一（没有计划就什么都不记）。 */
export function afterOtherTool(plan: PlanSnapshot | null): PlanSnapshot | null {
  return plan ? { ...plan, sinceUpdate: (plan.sinceUpdate ?? 0) + 1 } : plan;
}

export function planFromToolResult(
  previous: PlanSnapshot | null,
  toolName: unknown,
  details: unknown,
  roundId: string | null,
): PlanSnapshot | null {
  if (toolName !== "todo") return afterOtherTool(previous);
  return applyDetails(previous, details, roundId);
}
