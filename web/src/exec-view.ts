import type { Item, ToolPlanSnapshot as ExecPlanSnapshot, ToolPlanStatus as ExecPlanStatus, ToolPlanTask as ExecPlanTask } from "./types.ts";
export type { ExecPlanSnapshot, ExecPlanStatus, ExecPlanTask };

export type ExecPhase = "idle" | "thinking" | "writing" | "tool" | "waiting";

export interface ExecStatsSnapshot {
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null;
  cost: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
}

export interface ExecRoundStats {
  baseline: ExecStatsSnapshot | null;
  final: ExecStatsSnapshot | null;
}

export interface ExecViewInput {
  items: Item[];
  phase: ExecPhase;
  streamChars: number;
  streamSummary?: string;
  selectedRound: string | null;
  plan?: ExecPlanSnapshot | null;
  /** Full session turn index; plan provenance is not limited to loaded transcript pages. */
  planRounds?: ExecRound[];
  now: number;
  stats?: ExecStatsSnapshot | null;
  roundStats?: Record<string, ExecRoundStats>;
  childRuns?: ExecChildRunInput[];
  childSessionsAvailable?: boolean;
  publicAccess?: boolean;
}

export interface ExecActiveTool {
  id: string;
  name: string;
  args: unknown;
  elapsedMs: number;
}

export type ExecNowView =
  | { kind: "idle"; previousDurationMs: number | null; succeeded: boolean | null; activeTools: [] }
  | { kind: "thinking" | "writing"; characters: number; summary: string; activeTools: ExecActiveTool[] }
  | { kind: "tool"; activeTools: ExecActiveTool[] }
  | { kind: "waiting"; activeTools: [] };

export interface ExecChildRunInput {
  runId: string;
  toolCallId: string;
  agent: string;
  task: string;
  state: "running" | "done" | "failed";
  items: Item[];
  plan?: ExecPlanSnapshot | null;
  stats?: ExecStatsSnapshot | null;
}

export interface ExecChildStep {
  id: string;
  kind: "tool" | "skill";
  label: string;
  args: unknown;
  status: "running" | "success" | "error" | "unknown";
  durationMs: number | null;
  result?: string;
  /** 技能行没有工具参数，但它自带 description / why / path —— 对话框里单独一块。 */
  note?: string;
  planTaskId: number | null;
}

export interface ExecSubagentRow {
  runId: string;
  agent: string;
  task: string;
  status: "running" | "done" | "failed" | "unknown";
  steps: ExecChildStep[];
  plan: ExecPlanView | null;
  stats: { cost: number | null; tokens: number | null };
  locked: boolean;
}

export interface ExecTimelineRow {
  id: string;
  kind: "tool" | "skill";
  label: string;
  args: unknown;
  status: "running" | "success" | "error" | "unknown";
  durationMs: number | null;
  subagent?: ExecSubagentRow;
  planTaskId: number | null;
}

export interface ExecRound {
  id: string;
  ordinal: number;
}

export interface ExecPlanTaskView {
  id: number;
  subject: string;
  activeForm: string | undefined;
  status: Exclude<ExecPlanStatus, "deleted">;
  waitingOn: number[];
  stepCount: number;
}

export interface ExecPlanView {
  done: number;
  total: number;
  listedRound: string | null;
  listedRoundOrdinal: number | null;
  activeTaskId: number | null;
  tasks: ExecPlanTaskView[];
  /**
   * #357：计划可能过期 —— 会话空闲、计划还有没关的项、上次 todo 之后又调用了至少
   * PLAN_STALE_TOOLS 次别的工具。值是那个次数，不过期就是 null。只对当前计划判（看历史轮不判）。
   */
  staleTools: number | null;
}

/** #357：「计划可能过期」的门槛，与 bridge/ext/plan-nudge.ts 的 NUDGE_MIN_TOOLS 一致。 */
export const PLAN_STALE_TOOLS = 5;

export interface ExecMetricsView {
  durationMs: number | null;
  toolCount: number;
  failureCount: number;
  cost: number | null;
  tokens: number | null;
  main: { cost: number | null; tokens: number | null };
  subagents: { cost: number; tokens: number };
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
}

interface ExecNowChild {
  runId: string;
  agent: string;
  step: string;
}

export interface ExecViewModel {
  now: ExecNowView;
  runningChildren: ExecNowChild[];
  timeline: ExecTimelineRow[];
  rounds: ExecRound[];
  selectedRound: string | null;
  plan: ExecPlanView | null;
  metrics: ExecMetricsView;
}

interface LoadedRound {
  id: string;
  items: Item[];
}

function loadedRounds(items: Item[]): LoadedRound[] {
  const rounds: LoadedRound[] = [];
  for (const item of items) {
    if (item.kind === "user") rounds.push({ id: item.id, items: [item] });
    else rounds.at(-1)?.items.push(item);
  }
  return rounds;
}

function timeOf(item: Item): number | null {
  if (!item.ts) return null;
  const at = Date.parse(item.ts);
  return Number.isFinite(at) ? at : null;
}

function dispatchRunId(item: Extract<Item, { kind: "tool" }>): string | null {
  if (!/^(acp_delegate|subagent)$/.test(item.name)) return null;
  const result = item.result ?? "";
  const match = /runId\s*[`"']?([A-Za-z0-9_-]+)/.exec(result) ?? /Async:\s*[\w.-]+\s*\[([A-Za-z0-9_-]+)\]/.exec(result);
  return match?.[1] ?? null;
}

function childPlanAndSteps(run: ExecChildRunInput, now: number): { plan: ExecPlanView | null; steps: ExecChildStep[] } {
  const todoSnapshots = run.items.filter((item) => item.kind === "tool" && item.name.toLowerCase() === "todo" && "plan" in item);
  const latestItemPlan = todoSnapshots.at(-1);
  let sourcePlan: ExecPlanSnapshot | null = null;
  if (run.plan !== undefined) sourcePlan = run.plan;
  else if (latestItemPlan?.kind === "tool") sourcePlan = latestItemPlan.plan ?? null;
  const steps = childTimelineRows(run.items, now, todoSnapshots.length ? null : sourcePlan);
  const stepCounts = new Map<number, number>();
  for (const step of steps) {
    if (step.planTaskId !== null) stepCounts.set(step.planTaskId, (stepCounts.get(step.planTaskId) ?? 0) + 1);
  }
  return { plan: planView(sourcePlan, [], stepCounts), steps };
}

function activeChildLines(childRuns: ExecChildRunInput[], now: number): ExecNowChild[] {
  return childRuns.flatMap((run) => {
    if (run.state !== "running") return [];
    const child = childPlanAndSteps(run, now);
    const activeTask = child.plan?.tasks.find((task) => task.id === child.plan?.activeTaskId);
    const activeStep = child.steps.find((step) => step.status === "running" || step.status === "unknown");
    return [{
      runId: run.runId,
      agent: run.agent || run.task,
      step: activeTask?.activeForm || activeTask?.subject || activeStep?.label || run.task,
    }];
  });
}

function timelineRows(
  items: Item[],
  now: number,
  startingPlan: ExecPlanSnapshot | null = null,
  childRuns: ExecChildRunInput[] = [],
  childSessionsAvailable = false,
  publicAccess = false,
): ExecTimelineRow[] {
  const childrenByTool = new Map(childRuns.map((run) => [run.toolCallId, run]));
  const rows: ExecTimelineRow[] = [];
  let plan = startingPlan;
  for (const item of items) {
    if (item.kind === "tool" && item.name.toLowerCase() === "todo") {
      if ("plan" in item) plan = item.plan ?? null;
      continue;
    }
    const planTaskId = plan?.tasks.find((task) => task.status === "in_progress")?.id ?? null;
    if (item.kind === "tool") {
      let status: ExecTimelineRow["status"] = "unknown";
      if (item.isError || item.status === "error") status = "error";
      else if (item.status === "running") status = "running";
      else if (item.status === "ok") status = "success";
      const started = timeOf(item);
      let durationMs = typeof item.durationMs === "number" ? item.durationMs : null;
      if (durationMs === null && status === "running" && started !== null) durationMs = Math.max(0, now - started);
      const run = childrenByTool.get(item.toolCallId);
      const runId = run?.runId ?? dispatchRunId(item);
      const task = run?.task ?? (item.args && typeof item.args === "object" && typeof (item.args as Record<string, unknown>).task === "string"
        ? String((item.args as Record<string, unknown>).task)
        : "");
      let subagent: ExecSubagentRow | undefined;
      if (runId) {
        const child = run ? childPlanAndSteps(run, now) : { plan: null, steps: [] };
        subagent = {
          runId,
          agent: run?.agent ?? "",
          task,
          status: run?.state ?? (item.status === "running" ? "running" : "unknown"),
          steps: child.steps,
          plan: child.plan,
          stats: { cost: run?.stats?.cost ?? null, tokens: totalTokens(run?.stats ?? null) },
          locked: publicAccess || !childSessionsAvailable,
        };
      }
      rows.push({ id: item.id, kind: "tool", label: item.name, args: item.args, status, durationMs, planTaskId, ...(subagent ? { subagent } : {}) });
    } else if (item.kind === "skill") {
      rows.push({ id: item.id, kind: "skill", label: item.name, args: "", status: "success", durationMs: null, planTaskId });
    }
  }
  return rows.reverse();
}

/** Child timelines deliberately stop at one level: child tool rows never receive subagent children. */
function childTimelineRows(items: Item[], now: number, startingPlan: ExecPlanSnapshot | null = null): ExecChildStep[] {
  return timelineRows(items, now, startingPlan).map((row) => {
    const item = items.find((candidate) => candidate.id === row.id);
    const note = item?.kind === "skill" ? [item.description, item.why, item.path].filter(Boolean).join("\n") : "";
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      args: row.args,
      status: row.status,
      durationMs: row.durationMs,
      ...(item?.kind === "tool" && typeof item.result === "string" ? { result: item.result } : {}),
      ...(note ? { note } : {}),
      planTaskId: row.planTaskId,
    };
  });
}

function previousDuration(items: Item[]): number | null {
  const first = items.find((item) => item.kind === "user");
  const start = first ? timeOf(first) : null;
  const end = [...items].reverse().map(timeOf).find((at) => at !== null) ?? null;
  return start === null || end === null ? null : Math.max(0, end - start);
}

function planView(
  plan: ExecPlanSnapshot | null | undefined,
  rounds: ExecRound[] = [],
  stepCounts: Map<number, number> = new Map(),
  judgeStale = false,
): ExecPlanView | null {
  if (!plan || !Array.isArray(plan.tasks)) return null;
  const tasks = plan.tasks.filter((task) => task && task.status !== "deleted");
  if (!tasks.length) return null;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = tasks.find((task) => task.status === "in_progress");
  const done = tasks.filter((task) => task.status === "completed").length;
  const since = typeof plan.sinceUpdate === "number" ? plan.sinceUpdate : 0;
  return {
    staleTools: judgeStale && done < tasks.length && since >= PLAN_STALE_TOOLS ? since : null,
    done,
    total: tasks.length,
    listedRound: typeof plan.listedRound === "string" ? plan.listedRound : null,
    listedRoundOrdinal: rounds.find((round) => round.id === plan.listedRound)?.ordinal ?? null,
    activeTaskId: active?.id ?? null,
    tasks: tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      activeForm: task.activeForm,
      status: task.status as Exclude<ExecPlanStatus, "deleted">,
      waitingOn: task.status === "pending"
        ? (task.blockedBy ?? []).filter((id) => {
            const dependency = byId.get(id);
            return dependency !== undefined && dependency.status !== "completed";
          })
        : [],
      stepCount: stepCounts.get(task.id) ?? 0,
    })),
  };
}

function totalTokens(snapshot: ExecStatsSnapshot | null): number | null {
  const tokens = snapshot?.tokens;
  if (!tokens) return null;
  if (typeof tokens.total === "number" && Number.isFinite(tokens.total)) return tokens.total;
  const counters = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return counters.length ? counters.reduce((sum, value) => sum + value, 0) : null;
}

function delta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) return null;
  return Math.max(0, current - baseline);
}

function roundMetrics(
  items: Item[],
  selectedIsCurrent: boolean,
  phase: ExecPhase,
  now: number,
  stats: ExecStatsSnapshot | null,
  roundStats: ExecRoundStats | undefined,
  childRuns: ExecChildRunInput[],
): ExecMetricsView {
  const first = items.find((item) => item.kind === "user");
  const start = first ? timeOf(first) : null;
  const end = selectedIsCurrent && phase !== "idle"
    ? now
    : [...items].reverse().map(timeOf).find((at) => at !== null) ?? null;
  let timeMs: number | null = null;
  if (start !== null && end !== null) timeMs = Math.max(0, end - start);
  const tools = items.filter((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool" && item.name.toLowerCase() !== "todo");
  const failureCount = tools.filter((item) => item.isError || item.status === "error").length;
  const snapshot = selectedIsCurrent || !first ? stats ?? roundStats?.final ?? null : roundStats?.final ?? null;
  const baseline = roundStats?.baseline ?? null;
  const cost = delta(snapshot?.cost ?? null, baseline?.cost ?? null);
  const tokens = delta(totalTokens(snapshot), totalTokens(baseline));
  const contextTokens = snapshot?.contextTokens ?? null;
  const contextWindow = snapshot?.contextWindow ?? null;
  const contextPercent = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : null;
  const childRunIds = new Set(tools.map((item) => item.toolCallId));
  const childTotals = childRuns.filter((run) => childRunIds.has(run.toolCallId)).reduce(
    (sum, run) => ({
      cost: sum.cost + (typeof run.stats?.cost === "number" && Number.isFinite(run.stats.cost) ? run.stats.cost : 0),
      tokens: sum.tokens + (totalTokens(run.stats ?? null) ?? 0),
    }),
    { cost: 0, tokens: 0 },
  );

  return {
    durationMs: timeMs,
    toolCount: tools.length,
    failureCount,
    cost,
    tokens,
    main: { cost, tokens },
    subagents: childTotals,
    contextTokens,
    contextWindow,
    contextPercent,
  };
}

function planAtRoundStart(rounds: LoadedRound[], selectedRound: LoadedRound | null): ExecPlanSnapshot | null {
  let plan: ExecPlanSnapshot | null = null;
  for (const round of rounds) {
    if (round === selectedRound) return plan;
    for (const item of round.items) {
      if (item.kind === "tool" && item.name.toLowerCase() === "todo" && "plan" in item) plan = item.plan ?? null;
    }
  }
  return null;
}

function planThroughRound(round: LoadedRound | null, startingPlan: ExecPlanSnapshot | null): ExecPlanSnapshot | null {
  let plan = startingPlan;
  for (const item of round?.items ?? []) {
    if (item.kind === "tool" && item.name.toLowerCase() === "todo" && "plan" in item) plan = item.plan ?? null;
  }
  return plan;
}

function activeTools(items: Item[], now: number): ExecActiveTool[] {
  return items.flatMap((item) => {
    if (item.kind !== "tool" || item.status !== "running") return [];
    const started = timeOf(item);
    let elapsedMs = typeof item.durationMs === "number" ? item.durationMs : 0;
    if (typeof item.durationMs !== "number" && started !== null) elapsedMs = Math.max(0, now - started);
    return [{ id: item.id, name: item.name, args: item.args, elapsedMs }];
  });
}

/** Derive the now card and reverse-chronological steps from loaded transcript items only. */
export function execView(input: ExecViewInput): ExecViewModel {
  const rounds = loadedRounds(input.items);
  const roundOptions = rounds.map((round, index) => ({ id: round.id, ordinal: index + 1 }));
  const currentRound = rounds.at(-1) ?? null;
  const selected = rounds.find((round) => round.id === input.selectedRound) ?? currentRound;
  const selectedIsCurrent = selected !== null && selected.id === currentRound?.id;
  const selectedItems = selected?.items ?? [];
  const planAtStart = planAtRoundStart(rounds, selected);
  const sawTodoSnapshot = rounds.some((round) => round.items.some((item) => item.kind === "tool" && item.name.toLowerCase() === "todo" && "plan" in item));
  const attributionStart = !sawTodoSnapshot && selectedIsCurrent ? input.plan ?? null : planAtStart;
  const historicalPlan = planThroughRound(selected, planAtStart);
  const selectedPlan = selectedIsCurrent && input.plan !== undefined ? input.plan : historicalPlan;
  const active = selectedIsCurrent ? activeTools(selectedItems, input.now) : [];
  const timeline = timelineRows(
    selectedItems,
    input.now,
    attributionStart,
    input.childRuns ?? [],
    input.childSessionsAvailable ?? false,
    input.publicAccess ?? false,
  );
  const stepCounts = new Map<number, number>();
  for (const row of timeline) {
    if (row.planTaskId !== null) stepCounts.set(row.planTaskId, (stepCounts.get(row.planTaskId) ?? 0) + 1);
  }
  let now: ExecNowView;

  if (selectedIsCurrent && active.length) {
    now = { kind: "tool", activeTools: active };
  } else if (selectedIsCurrent && input.phase === "thinking") {
    now = { kind: "thinking", characters: input.streamChars, summary: input.streamSummary ?? "", activeTools: active };
  } else if (selectedIsCurrent && input.phase === "writing") {
    now = { kind: "writing", characters: input.streamChars, summary: input.streamSummary ?? "", activeTools: active };
  } else if (selectedIsCurrent && input.phase === "waiting") {
    now = { kind: "waiting", activeTools: [] };
  } else {
    const rows = timeline;
    const failed = rows.some((row) => row.status === "error");
    now = {
      kind: "idle",
      previousDurationMs: previousDuration(selectedItems),
      succeeded: selectedItems.length ? !failed : null,
      activeTools: [],
    };
  }

  const metrics = roundMetrics(
    selectedItems,
    selectedIsCurrent,
    input.phase,
    input.now,
    input.stats ?? null,
    selected ? input.roundStats?.[selected.id] : undefined,
    input.childRuns ?? [],
  );
  return {
    now,
    runningChildren: activeChildLines(input.childRuns ?? [], input.now),
    timeline,
    rounds: roundOptions,
    selectedRound: selected?.id ?? null,
    // #357：只在会话真空闲、看的又是当前计划时判过期；跑着的时候一步很长是正常的。
    plan: planView(selectedPlan, input.planRounds, stepCounts, input.phase === "idle" && selectedIsCurrent && input.plan !== undefined),
    metrics,
  };
}
