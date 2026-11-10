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

export interface ExecPlanTaskView {
  id: number;
  subject: string;
  activeForm: string | undefined;
  status: Exclude<ExecPlanStatus, "deleted">;
  waitingOn: number[];
}

export interface ExecPlanView {
  done: number;
  total: number;
  listedRound: string | null;
  listedRoundOrdinal: number | null;
  activeTaskId: number | null;
  tasks: ExecPlanTaskView[];
}

export interface ExecViewModel {
  now: ExecNowView;
  timeline: ExecTimelineRow[];
  rounds: ExecRound[];
  selectedRound: string | null;
  plan: ExecPlanView | null;
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

function planView(plan: ExecPlanSnapshot | null | undefined, rounds: ExecRound[] = []): ExecPlanView | null {
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
    })),
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

  return {
    now,
    timeline,
    rounds: roundOptions,
    selectedRound: selected?.id ?? null,
    plan: planView(input.plan, input.planRounds),
  };
}
