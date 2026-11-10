import type { Item } from "./types.ts";

export type ExecPhase = "idle" | "thinking" | "writing" | "tool" | "waiting";

export type ExecPlanStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface ExecPlanTask {
  id: number;
  subject: string;
  activeForm?: string;
  status: ExecPlanStatus;
  blockedBy?: number[];
}

export interface ExecPlanSnapshot {
  tasks: ExecPlanTask[];
  listedRound: string | null;
}

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

export interface ExecTimelineRow {
  id: string;
  kind: "tool" | "skill";
  label: string;
  args: unknown;
  status: "running" | "success" | "error" | "unknown";
  durationMs: number | null;
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
}

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

export interface ExecViewModel {
  now: ExecNowView;
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

function timelineRows(items: Item[], now: number, startingPlan: ExecPlanSnapshot | null): ExecTimelineRow[] {
  const rows: ExecTimelineRow[] = [];
  let plan = startingPlan;
  for (const item of items) {
    if (item.kind === "tool" && item.name.toLowerCase() === "todo") {
      if ("plan" in item) plan = item.plan ?? null;
      continue;
    }
    const planTaskId = plan?.tasks.find((task) => task.status === "in_progress")?.id ?? null;
    if (item.kind === "tool") {
      const status = item.isError || item.status === "error"
        ? "error"
        : item.status === "running"
          ? "running"
          : item.status === "ok"
            ? "success"
            : "unknown";
      const started = timeOf(item);
      const durationMs = typeof item.durationMs === "number"
        ? item.durationMs
        : status === "running" && started !== null
          ? Math.max(0, now - started)
          : null;
      rows.push({ id: item.id, kind: "tool", label: item.name, args: item.args, status, durationMs, planTaskId });
    } else if (item.kind === "skill") {
      rows.push({ id: item.id, kind: "skill", label: item.name, args: "", status: "success", durationMs: null, planTaskId });
    }
  }
  return rows.reverse();
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
): ExecPlanView | null {
  if (!plan || !Array.isArray(plan.tasks)) return null;
  const tasks = plan.tasks.filter((task) => task && task.status !== "deleted");
  if (!tasks.length) return null;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = tasks.find((task) => task.status === "in_progress");
  return {
    done: tasks.filter((task) => task.status === "completed").length,
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
): ExecMetricsView {
  const first = items.find((item) => item.kind === "user");
  const start = first ? timeOf(first) : null;
  const end = selectedIsCurrent && phase !== "idle"
    ? now
    : [...items].reverse().map(timeOf).find((at) => at !== null) ?? null;
  const timeMs = start === null || end === null ? null : Math.max(0, end - start);
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

  return {
    durationMs: timeMs,
    toolCount: tools.length,
    failureCount,
    cost,
    tokens,
    main: { cost, tokens },
    subagents: { cost: 0, tokens: 0 },
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
    return [{
      id: item.id,
      name: item.name,
      args: item.args,
      elapsedMs: typeof item.durationMs === "number"
        ? item.durationMs
        : started === null
          ? 0
          : Math.max(0, now - started),
    }];
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
  const timeline = timelineRows(selectedItems, input.now, attributionStart);
  const stepCounts = new Map<number, number>();
  for (const row of timeline) {
    if (row.planTaskId !== null) stepCounts.set(row.planTaskId, (stepCounts.get(row.planTaskId) ?? 0) + 1);
  }
  let now: ExecNowView;

  if (selectedIsCurrent && input.phase === "thinking") {
    now = { kind: "thinking", characters: input.streamChars, summary: input.streamSummary ?? "", activeTools: active };
  } else if (selectedIsCurrent && input.phase === "writing") {
    now = { kind: "writing", characters: input.streamChars, summary: input.streamSummary ?? "", activeTools: active };
  } else if (selectedIsCurrent && input.phase === "tool" && active.length) {
    now = { kind: "tool", activeTools: active };
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
  );
  return {
    now,
    timeline,
    rounds: roundOptions,
    selectedRound: selected?.id ?? null,
    plan: planView(selectedPlan, input.planRounds, stepCounts),
    metrics,
  };
}
