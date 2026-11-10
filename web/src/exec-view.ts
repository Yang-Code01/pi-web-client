import type { Item } from "./types.ts";

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
}

export interface ExecRound {
  id: string;
  ordinal: number;
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

function timelineRows(items: Item[], now: number): ExecTimelineRow[] {
  const rows: ExecTimelineRow[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      if (item.name.toLowerCase() === "todo") continue;
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
      rows.push({ id: item.id, kind: "tool", label: item.name, args: item.args, status, durationMs });
    } else if (item.kind === "skill") {
      rows.push({ id: item.id, kind: "skill", label: item.name, args: "", status: "success", durationMs: null });
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
  const active = selectedIsCurrent ? activeTools(selectedItems, input.now) : [];
  const timeline = timelineRows(selectedItems, input.now);
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
    const rows = timelineRows(selectedItems, input.now);
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
  return { now, timeline, rounds: roundOptions, selectedRound: selected?.id ?? null, metrics };
}
