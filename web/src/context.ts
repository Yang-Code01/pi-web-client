/**
 * #384 Context 面板的纯函数：ctxlog 行 → 面板要看的视图（KPI / 组成 / 趋势 / 事件 / 活动）。
 *
 * 这里不碰 DOM、不碰 WS：三类行分流、组成加法、峰值/均值、活动聚合都是可单测的纯逻辑
 * （web/tests/context-unit.mjs）。app.ts 只拿这里的产物去画。
 *
 * 数据形状见 bridge/ext/context-log.ts（扩展落盘）和 bridge/src/sessions.ts 的 `CtxLine`：
 * 一次 ctxlog 是三类行共用同一 `seq` 的 JSONL：
 *   request   `context_with_system` 的六类组成估算
 *   event     `session_compact` / `session_compact_failed` / `model_select` 的显式事件
 *   activity  `tool_execution_end` 的文件操作 / 命令执行（只有元数据，没有正文）
 * 六类 = dsh-context 的拆法，按 pi 的消息角色映射：
 *   sys    系统提示（首条 system + 中途的提示/工具补丁）
 *   tools  工具声明（toolsAdded 的 name+description+schema）
 *   user   用户消息
 *   inject 注入上下文（custom / branchSummary / compactionSummary）
 *   asst   助手回复（文本 + thinking + 工具调用）
 *   toolr  工具结果（toolResult / bashExecution / 文件结果）
 *
 * 组成是本地估算（CJK÷1.5 / 其他÷4），**不等于 provider 的计费 token**；provider 真值由
 * `stats` WS 消息单独送，面板里两者并列显示，不混算。
 */
import { tr } from "./i18n/index.ts";

export interface CtxCats {
  sys: number;
  tools: number;
  user: number;
  inject: number;
  asst: number;
  toolr: number;
}

/** 一行 ctxlog。字段按 kind 取用；旧日志没有 `kind` 但有 `cats`，按 request 兼容。 */
export interface CtxLine {
  seq: number;
  ts?: number;
  v?: number;
  kind?: "request" | "event" | "activity";
  cwd?: string | null;
  total?: number;
  cats?: CtxCats;
  messages?: number;
  perMessage?: Array<{ role: string; tokens: number; blocks: number; toolCalls: number }>;
  // event
  event?: "compact" | "compact_failed" | "model";
  reason?: string;
  before?: number;
  atSeq?: number;
  willRetry?: boolean;
  aborted?: boolean;
  model?: string;
  previous?: string;
  // activity
  activity?: "file" | "command";
  op?: "read" | "write" | "edit" | "search";
  path?: string;
  added?: number;
  removed?: number;
  program?: string;
  status?: "ok" | "failed";
  durationMs?: number;
  parent?: boolean;
}

/** 六类的稳定 id 与文案（顺序 = 图例 / 明细行的顺序，从上往下）。 */
export const CTX_CATS: ReadonlyArray<{ id: keyof CtxCats; label: string; cls: string }> = [
  { id: "sys", label: "系统提示", cls: "c-sys" },
  { id: "tools", label: "工具声明", cls: "c-tools" },
  { id: "user", label: "用户消息", cls: "c-user" },
  { id: "inject", label: "注入上下文", cls: "c-inject" },
  { id: "asst", label: "助手回复", cls: "c-asst" },
  { id: "toolr", label: "工具结果", cls: "c-toolr" },
];

export function ctxCatLabel(id: string): string {
  const hit = CTX_CATS.find((c) => c.id === id);
  // 注：CTX_CATS 标签表的语言在使用处由 tr(label) 决定（i18n-check 的既有约定）；
  // 兜底「其它」同样只有未知 id 才会走到，不进词典。
  // i18n-ignore-start 未知类别的兜底标签，仅防御性展示
  return hit ? tr(hit.label) : "其它";
  // i18n-ignore-end
}

/** 是不是一次 LLM 请求的组成行（旧日志没有 kind，用 cats 兜底）。 */
export function isCtxRequest(line: CtxLine): boolean {
  return line?.kind === "request" || (!line?.kind && !!line?.cats);
}

/** 只取请求行：KPI / 组成 / 趋势都建立在「每次 LLM 请求一行」之上。 */
export function ctxRequests(lines: CtxLine[]): CtxLine[] {
  return lines.filter(isCtxRequest);
}

/** 行的六类合计（扩展写 total，这里兜底重算，坏行不至于画歪）。 */
export function ctxTotal(line: CtxLine): number {
  let sum = 0;
  for (const c of CTX_CATS) sum += line.cats?.[c.id] ?? 0;
  return typeof line.total === "number" && line.total > 0 ? line.total : sum;
}

export interface CtxKpis {
  /** 当前上下文：provider 实测优先，否则最后一次请求的估算总量。 */
  current: number;
  /** 全程峰值（估算），落在哪次请求。 */
  peak: number;
  peakSeq: number;
  /** 请求次数与估算均值。 */
  requests: number;
  avg: number;
  /** 距自动压缩还有多少（桥的真实 contextBudget - current）；未设预算时为 null。 */
  tillCompact: number | null;
  budget: number | null;
  /** provider 报的真值（stats.contextUsage），有就优先显示。 */
  measured: number | null;
  window: number | null;
}

/**
 * budget 是桥 `setContextBudget` 写进 budget.json 的真实阈值（`used < budget` 才不压缩）。
 * 旧版的 `window * 0.92` 是前端臆造的口径，pi 侧没有这个比例，已废弃。
 */
export function ctxKpis(lines: CtxLine[], window: number | null, measured: number | null, budget: number | null): CtxKpis {
  const last = lines[lines.length - 1];
  let peak = 0;
  let peakSeq = 0;
  let sum = 0;
  for (const line of lines) {
    const t = ctxTotal(line);
    sum += t;
    if (t > peak) {
      peak = t;
      peakSeq = line.seq;
    }
  }
  const requests = lines.length;
  const current = measured ?? (last ? ctxTotal(last) : 0);
  return {
    current,
    peak,
    peakSeq,
    requests,
    avg: requests ? Math.round(sum / requests) : 0,
    tillCompact: budget ? Math.max(0, Math.round(budget - current)) : null,
    budget,
    measured,
    window,
  };
}

/**
 * 选轮视图：组成明细行（类别 · token · 占比）。`line` 为 null 时给空表，面板画「还没有数据」。
 */
export interface CtxCompRow {
  id: string;
  label: string;
  cls: string;
  tokens: number;
  pct: number;
}

export function ctxCompRows(line: CtxLine | null): CtxCompRow[] {
  if (!line) return [];
  const t = ctxTotal(line) || 1;
  return CTX_CATS.map((c) => ({
    id: c.id,
    label: tr(c.label),
    cls: c.cls,
    tokens: line.cats?.[c.id] ?? 0,
    pct: ((line.cats?.[c.id] ?? 0) / t) * 100,
  }));
}

/** 事件流：只认扩展写的显式事件行，不再从 token 总量骤降猜压缩。 */
export interface CtxEvent {
  seq: number;
  ts: number;
  kind: "compact" | "compact_failed" | "model";
  before: number | null;
  model: string;
  previous: string;
  reason: string;
  /** 事件发生在哪次请求之后；0 = 还没有过请求。 */
  atSeq: number;
}

export function ctxEvents(lines: CtxLine[]): CtxEvent[] {
  const out: CtxEvent[] = [];
  for (const l of lines) {
    if (l.kind !== "event" || !l.event) continue;
    if (l.event !== "compact" && l.event !== "compact_failed" && l.event !== "model") continue;
    out.push({
      seq: l.seq,
      ts: l.ts ?? 0,
      kind: l.event,
      before: typeof l.before === "number" ? l.before : null,
      model: l.model ?? "",
      previous: l.previous ?? "",
      reason: l.reason ?? "",
      atSeq: typeof l.atSeq === "number" ? l.atSeq : 0,
    });
  }
  return out;
}

/** 哪些请求的柱状图该挂 ✂：压缩事件之后的下一次请求（而不是「总量掉了 40%」）。 */
export function ctxCompactAfterSeq(lines: CtxLine[]): Set<number> {
  const reqs = ctxRequests(lines);
  const out = new Set<number>();
  for (const e of ctxEvents(lines)) {
    if (e.kind === "model") continue;
    const next = reqs.find((r) => r.seq > e.atSeq);
    if (next) out.add(next.seq);
  }
  return out;
}

/** 文件活动按路径聚合：读 / 写 / 检索次数、+新增 / −删除行、失败次数。 */
export interface CtxFileRow {
  path: string;
  ops: number;
  reads: number;
  writes: number;
  searches: number;
  added: number;
  removed: number;
  failed: number;
}

export function ctxFileRows(lines: CtxLine[]): CtxFileRow[] {
  const map = new Map<string, CtxFileRow>();
  for (const l of lines) {
    if (l.kind !== "activity" || l.activity !== "file") continue;
    const p = l.path || "?";
    const row = map.get(p) ?? { path: p, ops: 0, reads: 0, writes: 0, searches: 0, added: 0, removed: 0, failed: 0 };
    row.ops++;
    if (l.op === "read") row.reads++;
    else if (l.op === "search") row.searches++;
    else row.writes++; // write / edit
    row.added += typeof l.added === "number" ? l.added : 0;
    row.removed += typeof l.removed === "number" ? l.removed : 0;
    if (l.status === "failed") row.failed++;
    map.set(p, row);
  }
  return [...map.values()].sort((a, b) => b.ops - a.ops || a.path.localeCompare(b.path));
}

/** 命令执行按程序名聚合（扩展只落 program，不落命令行正文）。 */
export interface CtxCommandRow {
  program: string;
  runs: number;
  failed: number;
  avgMs: number | null;
}

export function ctxCommandRows(lines: CtxLine[]): CtxCommandRow[] {
  const map = new Map<string, { program: string; runs: number; failed: number; totalMs: number; timed: number }>();
  for (const l of lines) {
    if (l.kind !== "activity" || l.activity !== "command") continue;
    const p = l.program || "?";
    const row = map.get(p) ?? { program: p, runs: 0, failed: 0, totalMs: 0, timed: 0 };
    row.runs++;
    if (l.status === "failed") row.failed++;
    if (typeof l.durationMs === "number") {
      row.totalMs += l.durationMs;
      row.timed++;
    }
    map.set(p, row);
  }
  return [...map.values()]
    .map((r) => ({ program: r.program, runs: r.runs, failed: r.failed, avgMs: r.timed ? Math.round(r.totalMs / r.timed) : null }))
    .sort((a, b) => b.runs - a.runs || a.program.localeCompare(b.program));
}

/** 展示格式：99_500 → 「99.5k」，千以下原样。 */
export function ctxFmt(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
