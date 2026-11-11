/**
 * #384 Context 面板的纯函数：ctxlog 行 → 面板要看的视图（KPI / 组成 / 趋势）。
 *
 * 这里不碰 DOM、不碰 WS：组成加法、峰值/均值、事件折算都是可单测的纯逻辑
 * （web/tests/context-unit.mjs）。app.ts 只拿这里的产物去画。
 *
 * 数据形状见 bridge/ext/context-log.ts（扩展落盘）和 bridge/src/sessions.ts 的 `CtxLine`：
 * 六类 = dsh-context 的拆法，按 pi 的消息角色映射：
 *   sys    系统提示（首条 system + 中途的提示/工具补丁）
 *   tools  工具声明（toolsAdded 的 name+description+schema）
 *   user   用户消息
 *   inject 注入上下文（custom / branchSummary / compactionSummary）
 *   asst   助手回复（文本 + thinking + 工具调用）
 *   toolr  工具结果（toolResult / bashExecution / 文件结果）
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

export interface CtxLine {
  v: number;
  seq: number;
  ts: number;
  cwd: string | null;
  total: number;
  cats: CtxCats;
  messages: number;
  perMessage: Array<{ role: string; tokens: number; blocks: number; toolCalls: number }>;
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
  // 兕底「其它」同样只有未知 id 才会走到，不进词典。
  // i18n-ignore-start 未知类别的兕底标签，仅防御性展示
  return hit ? tr(hit.label) : "其它";
  // i18n-ignore-end
}

/** 行的六类合计（扩展写 total，这里兜底重算，坏行不至于画歪）。 */
export function ctxTotal(line: CtxLine): number {
  let sum = 0;
  for (const c of CTX_CATS) sum += line.cats?.[c.id] ?? 0;
  return typeof line.total === "number" && line.total > 0 ? line.total : sum;
}

/** 序列中连续两行 total 骤降（< 60%）= 中间发生过压缩。标记画 ✂ 用。 */
export function isCompactionDrop(prev: CtxLine | undefined, line: CtxLine): boolean {
  if (!prev) return false;
  const a = ctxTotal(prev);
  const b = ctxTotal(line);
  return a > 0 && b < a * 0.6;
}

export interface CtxKpis {
  /** 当前（最后一次请求）估算总量。 */
  current: number;
  /** 全程峰值（估算），落在哪次请求。 */
  peak: number;
  peakSeq: number;
  /** 请求次数与估算均值。 */
  requests: number;
  avg: number;
  /** 距自动压缩还有多少（pi 阈值 ≈ 窗口的 92%）；窗口未知时为 null。 */
  tillCompact: number | null;
  /** provider 报的真值（stats.contextUsage），有就优先显示。 */
  measured: number | null;
  window: number | null;
}

export function ctxKpis(lines: CtxLine[], window: number | null, measured: number | null): CtxKpis {
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
    tillCompact: window ? Math.max(0, Math.round(window * 0.92 - current)) : null,
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

/** 事件流：请求之间的压缩标记（✂）折成一条事件；ts 用后一行的时间。 */
export interface CtxEvent {
  seq: number;
  ts: number;
  kind: "compact";
  before: number;
  after: number;
}

export function ctxEvents(lines: CtxLine[]): CtxEvent[] {
  const out: CtxEvent[] = [];
  let prev: CtxLine | undefined;
  for (const line of lines) {
    if (isCompactionDrop(prev, line) && prev) out.push({ seq: line.seq, ts: line.ts, kind: "compact", before: ctxTotal(prev), after: ctxTotal(line) });
    prev = line;
  }
  return out;
}

/** 展示格式：99_500 → 「99.5k」，千以下原样。 */
export function ctxFmt(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
