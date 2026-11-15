/**
 * #384 Context 面板的纯函数：ctxlog 行 → 面板要看的视图（stats / token / timing / trend /
 * browser / events / 文件 / 命令）。
 *
 * 这里不碰 DOM、不碰 WS：六类行分流、组成加法、billed 拆分、趋势粒度、浏览器 delta 都是可单测的
 * 纯逻辑（web/tests/context-unit.mjs）。context-panel.ts 只拿这里的产物去画。
 *
 * 数据形状见 bridge/ext/context-log.ts（扩展落盘）和 bridge/src/sessions.ts 的 `CtxLine`：
 * 一次 ctxlog 是六类行共用同一 `seq` 的 JSONL：
 *   request   `context_with_system` 的七类组成估算 + 条目快照
 *   body      浏览器展开用的正文（按 item id 去重写）
 *   usage     `message_end` 的 provider 用量（一次请求一行）
 *   event     `session_compact` / `session_compact_failed` / `model_select` / 注入
 *   activity  `tool_execution_end` 的工具 / 文件 / 命令（只有元数据，没有正文）
 *
 * 七类 = dsh-context 的拆法，按 pi 的消息角色映射：
 *   sys    系统提示词
 *   tools  工具定义（toolsAdded 的 name+description+schema）
 *   user   用户消息
 *   inject 注入内容（rules / docs / project_context / custom / branchSummary / compactionSummary）
 *   skill  技能注入（system.sections.skills）
 *   asst   助手消息（文本 + thinking + 工具调用）
 *   toolr  工具结果（toolResult / bashExecution / 文件结果）
 *
 * 组成是本地估算（CJK÷1.5 / 其他÷4），**不等于 provider 的计费 token**；provider 真值由
 * `usage` 行与 `stats` WS 消息单独送，面板里两者并列显示，不混算。
 */
import { tr } from "./i18n/index.ts";

export interface CtxCats {
  sys: number;
  tools: number;
  user: number;
  inject: number;
  skill: number;
  asst: number;
  toolr: number;
}

export interface CtxSplit {
  reasoning: number;
  answer: number;
  calls: number;
}

export interface CtxBodyMeta {
  tool?: string;
  args?: string;
  status?: "ok" | "failed";
  path?: string;
  command?: string;
  exitCode?: number;
}

/** `kind: "body"` 行：Context Browser 展开后的正文（系统提示词 / schema / 消息 / 参数 / 结果）。 */
export interface CtxBody extends CtxBodyMeta {
  content: string;
}

export interface CtxItem {
  id: string;
  cat: string;
  label: string;
  tokens: number;
  kind?: string;
  sub?: string;
  preview?: string;
  /** 由最近的 `kind:"body"` 行补上；旧日志没有就是 undefined。 */
  content?: string;
  body?: CtxBody;
}

export interface CtxUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
}

export interface CtxUsageLine {
  seq: number;
  atSeq: number;
  ts: number;
  model: string;
  stopReason: string;
  durationMs: number;
  waitMs: number;
  usage: CtxUsage;
  out: CtxSplit;
}

/** 一行 ctxlog。字段按 kind 取用；旧日志没有 `kind` 但有 `cats`，按 request 兼容。 */
export interface CtxLine {
  seq: number;
  ts?: number;
  v?: number;
  kind?: "request" | "usage" | "event" | "activity" | "body";
  cwd?: string | null;
  turn?: number;
  step?: number;
  users?: number;
  total?: number;
  cats?: CtxCats;
  skills?: string[];
  lastUser?: string;
  split?: CtxSplit;
  messages?: number;
  roles?: Record<string, number>;
  perMessage?: Array<{ role: string; tokens: number; blocks: number; toolCalls: number }>;
  perMessageOmitted?: number;
  items?: CtxItem[];
  itemsOmitted?: number;
  header?: { system?: CtxItem[]; tools?: CtxItem[]; toolsOmitted?: number };
  // usage
  usage?: CtxUsage;
  stopReason?: string;
  out?: CtxSplit;
  waitMs?: number;
  cost?: number;
  // body
  id?: string;
  content?: string;
  args?: string;
  command?: string;
  exitCode?: number;
  // event
  event?: "compact" | "compact_failed" | "model" | "inject";
  label?: string;
  tokens?: number;
  reason?: string;
  before?: number;
  atSeq?: number;
  willRetry?: boolean;
  aborted?: boolean;
  model?: string;
  previous?: string;
  // activity
  activity?: "file" | "command" | "tool";
  tool?: string;
  op?: "read" | "write" | "edit" | "search";
  path?: string;
  added?: number;
  removed?: number;
  program?: string;
  status?: "ok" | "failed";
  durationMs?: number;
  parent?: boolean;
  skillName?: string;
}

/** 七类的稳定 id 与文案（顺序 = 图例 / 明细行的顺序，从上往下）。 */
export const CTX_CATS: ReadonlyArray<{ id: keyof CtxCats; label: string; cls: string }> = [
  { id: "sys", label: "系统提示词", cls: "c-sys" },
  { id: "tools", label: "工具定义", cls: "c-tools" },
  { id: "user", label: "用户消息", cls: "c-user" },
  { id: "inject", label: "注入内容", cls: "c-inject" },
  { id: "skill", label: "技能注入", cls: "c-skill" },
  { id: "asst", label: "助手消息", cls: "c-asst" },
  { id: "toolr", label: "工具结果", cls: "c-toolr" },
];

/** billed token 统计的八类（dsh-context Token 统计卡口径）。 */
export const CTX_BILL_CATS: ReadonlyArray<{ id: keyof CtxBill; label: string; cls: string }> = [
  { id: "sys", label: "系统提示词", cls: "c-sys" },
  { id: "tools", label: "工具定义", cls: "c-tools" },
  { id: "user", label: "用户消息", cls: "c-user" },
  { id: "inject", label: "注入内容", cls: "c-inject" },
  { id: "skill", label: "技能注入", cls: "c-skill" },
  { id: "toolCalls", label: "工具调用", cls: "c-tool" },
  { id: "reasoning", label: "模型思考", cls: "c-think" },
  { id: "answers", label: "模型回复", cls: "c-answer" },
];

export interface CtxBill {
  sys: number;
  tools: number;
  user: number;
  inject: number;
  skill: number;
  toolCalls: number;
  reasoning: number;
  answers: number;
}

/** 是不是一次 LLM 请求的组成行（旧日志没有 kind，用 cats 兜底）。 */
export function isCtxRequest(line: CtxLine): boolean {
  return line?.kind === "request" || (!line?.kind && !!line?.cats);
}

/** 只取请求行：KPI / 组成 / 趋势都建立在「每次 LLM 请求一行」之上。 */
export function ctxRequests(lines: CtxLine[]): CtxLine[] {
  return lines.filter(isCtxRequest);
}

/** 行的七类合计（扩展写 total，这里兜底重算，坏行不至于画歪）。 */
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
  const current = measured != null && measured > 0 ? measured : last ? ctxTotal(last) : 0;
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
  kind: "compact" | "compact_failed" | "model" | "inject";
  before: number | null;
  model: string;
  previous: string;
  reason: string;
  label: string;
  tokens: number;
  /** 事件发生在哪次请求之后；0 = 还没有过请求。 */
  atSeq: number;
}

export function ctxEvents(lines: CtxLine[]): CtxEvent[] {
  const out: CtxEvent[] = [];
  for (const l of lines) {
    if (l.kind !== "event" || !l.event) continue;
    if (l.event !== "compact" && l.event !== "compact_failed" && l.event !== "model" && l.event !== "inject") continue;
    out.push({
      seq: l.seq,
      ts: l.ts ?? 0,
      kind: l.event,
      before: typeof l.before === "number" ? l.before : null,
      model: l.model ?? "",
      previous: l.previous ?? "",
      reason: l.reason ?? "",
      label: l.label ?? "",
      tokens: typeof l.tokens === "number" ? l.tokens : 0,
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
    if (e.kind !== "compact" && e.kind !== "compact_failed") continue;
    const next = reqs.find((r) => r.seq > e.atSeq);
    if (next) out.add(next.seq);
  }
  return out;
}

/** usage 行按 `atSeq` 归到请求上；旧日志没有 usage 行时返回空 Map。 */
export function ctxUsageMap(lines: CtxLine[]): Map<number, CtxUsageLine> {
  const out = new Map<number, CtxUsageLine>();
  for (const l of lines) {
    if (l.kind !== "usage" || typeof l.atSeq !== "number") continue;
    const u = l.usage;
    if (!u) continue;
    out.set(l.atSeq, {
      seq: l.seq,
      atSeq: l.atSeq,
      ts: l.ts ?? 0,
      model: l.model ?? "",
      stopReason: l.stopReason ?? "",
      durationMs: typeof l.durationMs === "number" ? l.durationMs : 0,
      waitMs: typeof l.waitMs === "number" ? l.waitMs : 0,
      usage: u,
      out: l.out ?? { reasoning: 0, answer: 0, calls: 0 },
    });
  }
  return out;
}

export interface CtxTokenStats {
  bill: CtxBill;
  total: number;
  /** provider 实际计费合计；没有 usage 行为 0。 */
  actual: number;
  cacheHit: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Token 统计：把每次请求的七类估算按 billed 口径重新分组。
 * 「工具调用」= 工具结果 + 助手工具调用参数；「模型思考 / 模型回复」来自 usage 行的 assistant
 * 分块估算；旧日志没有 usage 时把整块 asst 记进「模型回复」。
 */
export function ctxTokenStats(lines: CtxLine[]): CtxTokenStats {
  const bill: CtxBill = { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, reasoning: 0, answers: 0 };
  const usage = ctxUsageMap(lines);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let actual = 0;
  for (const req of ctxRequests(lines)) {
    const c = req.cats;
    if (c) {
      bill.sys += c.sys ?? 0;
      bill.tools += c.tools ?? 0;
      bill.user += c.user ?? 0;
      bill.inject += c.inject ?? 0;
      bill.skill += c.skill ?? 0;
    }
    const u = usage.get(req.seq);
    if (u) {
      const split = req.split;
      const splitEmpty = !u.out.reasoning && !u.out.answer && !u.out.calls;
      bill.toolCalls += (c?.toolr ?? 0) + (splitEmpty ? split?.calls ?? 0 : u.out.calls || 0);
      bill.reasoning += splitEmpty ? split?.reasoning ?? 0 : u.out.reasoning || 0;
      bill.answers += splitEmpty ? split?.answer ?? 0 : u.out.answer || 0;
      // Provider usage is the truth for the totals; the split above is local estimate.
      input += u.usage.input;
      output += u.usage.output;
      cacheRead += u.usage.cacheRead;
      cacheWrite += u.usage.cacheWrite;
      actual += u.usage.totalTokens || u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cacheWrite;
    } else {
      bill.toolCalls += c?.toolr ?? 0;
      bill.answers += c?.asst ?? 0;
    }
  }
  const total = bill.sys + bill.tools + bill.user + bill.inject + bill.skill + bill.toolCalls + bill.reasoning + bill.answers;
  const billedInput = input + cacheRead + cacheWrite;
  return {
    bill,
    total,
    actual,
    cacheHit: billedInput > 0 ? (cacheRead / billedInput) * 100 : null,
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

export function ctxBillRows(stats: CtxTokenStats): Array<{ id: keyof CtxBill; label: string; cls: string; tokens: number; pct: number }> {
  const total = stats.total || 1;
  return CTX_BILL_CATS.map((c) => ({
    id: c.id,
    label: tr(c.label),
    cls: c.cls,
    tokens: stats.bill[c.id],
    pct: (stats.bill[c.id] / total) * 100,
  }));
}

/** 耗时统计：等待 / 生成（思考、回复、工具参数按输出块比例拆） / 工具执行 / 其他。 */
export interface CtxTimingRow {
  id: "wait" | "think" | "answer" | "args" | "tool" | "other";
  label: string;
  cls: string;
  ms: number;
  pct: number;
  count: number;
}

/** 耗时卡的固定行（模块级标签表：语言在使用处由 tr(label) 决定）。 */
const TIMING_DEFS: ReadonlyArray<{ id: CtxTimingRow["id"]; label: string; cls: string }> = [
  { id: "wait", label: "模型等待", cls: "c-wait" },
  { id: "think", label: "模型思考", cls: "c-think" },
  { id: "answer", label: "模型回复", cls: "c-answer" },
  { id: "args", label: "工具参数", cls: "c-args" },
  { id: "tool", label: "工具执行", cls: "c-tool" },
  { id: "other", label: "其他开销", cls: "c-other" },
];

export interface CtxTiming {
  total: number;
  rows: CtxTimingRow[];
  tps: number | null;
  calls: number;
  tools: number;
  output: number;
}

export function ctxTiming(lines: CtxLine[]): CtxTiming {
  const usage = ctxUsageMap(lines);
  let wait = 0;
  let gen = 0;
  let output = 0;
  let reasoning = 0;
  let answer = 0;
  let calls = 0;
  let modelCalls = 0;
  for (const u of usage.values()) {
    wait += u.waitMs;
    gen += u.durationMs;
    output += u.usage.output;
    reasoning += u.out.reasoning;
    answer += u.out.answer;
    calls += u.out.calls || 0;
    modelCalls++;
  }
  let toolMs = 0;
  let toolRuns = 0;
  for (const l of lines) {
    if (l.kind !== "activity") continue;
    if (typeof l.durationMs === "number") toolMs += l.durationMs;
    if (l.activity === "command" || l.activity === "file" || l.activity === "tool") toolRuns++;
  }
  const blockTotal = reasoning + answer + calls;
  const thinkMs = blockTotal > 0 ? (gen * reasoning) / blockTotal : gen * 0.5;
  const answerMs = blockTotal > 0 ? (gen * answer) / blockTotal : gen * 0.25;
  const argsMs = blockTotal > 0 ? (gen * calls) / blockTotal : gen * 0.25;
  const total = wait + gen + toolMs;
  const msById: Record<CtxTimingRow["id"], number> = { wait, think: thinkMs, answer: answerMs, args: argsMs, tool: toolMs, other: 0 };
  const countById: Record<CtxTimingRow["id"], number> = { wait: modelCalls, think: 0, answer: 0, args: 0, tool: toolRuns, other: 0 };
  const rows: CtxTimingRow[] = TIMING_DEFS.map((d) => ({ ...d, ms: msById[d.id], pct: 0, count: countById[d.id] }));
  for (const r of rows) r.pct = total > 0 ? (r.ms / total) * 100 : 0;
  return {
    total,
    rows,
    tps: gen > 0 ? output / (gen / 1000) : null,
    calls: modelCalls,
    tools: toolRuns,
    output,
  };
}

export function ctxDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return rest ? `${m}m${rest}s` : `${m}m`;
}

export function ctxPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "–";
  if (n > 0 && n < 0.1) return "<0.1%";
  return `${n.toFixed(digits)}%`;
}

/** 趋势柱：step = 每次请求一根；turn = 每轮取最后一次请求。 */
export interface CtxTrendRow {
  seq: number;
  turn: number;
  step: number;
  ts: number;
  cats: CtxCats;
  total: number;
  actual: number | null;
  durationMs: number | null;
  request: CtxLine;
}

function emptyCats(): CtxCats {
  return { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 };
}

export function ctxTrendRows(lines: CtxLine[], gran: "step" | "turn", mode: "full" | "delta"): CtxTrendRow[] {
  const reqs = ctxRequests(lines);
  const usage = ctxUsageMap(lines);
  const out: CtxTrendRow[] = [];
  let prev = emptyCats();
  if (gran === "step") {
    reqs.forEach((req, i) => {
      const raw = req.cats ?? emptyCats();
      const cats = emptyCats();
      for (const c of CTX_CATS) cats[c.id] = mode === "delta" ? Math.max(0, (raw[c.id] ?? 0) - (prev[c.id] ?? 0)) : raw[c.id] ?? 0;
      prev = raw;
      const u = usage.get(req.seq);
      out.push({
        seq: req.seq,
        turn: req.turn ?? 1,
        step: req.step ?? i + 1,
        ts: req.ts ?? 0,
        cats,
        total: CTX_CATS.reduce((s, c) => s + cats[c.id], 0),
        actual: u ? u.usage.totalTokens || u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cacheWrite : null,
        durationMs: u?.durationMs ?? null,
        request: req,
      });
    });
    return out;
  }
  // turn: group by turn, keep the last request's full shape (or sum positive deltas in the turn).
  let group: CtxLine[] = [];
  const flush = () => {
    if (!group.length) return;
    const last = group[group.length - 1]!;
    const raw = emptyCats();
    if (mode === "delta") {
      let base = prev;
      for (const r of group) {
        const c = r.cats ?? emptyCats();
        for (const cat of CTX_CATS) raw[cat.id] += Math.max(0, (c[cat.id] ?? 0) - (base[cat.id] ?? 0));
        base = c;
      }
    } else {
      for (const cat of CTX_CATS) raw[cat.id] = last.cats?.[cat.id] ?? 0;
    }
    prev = last.cats ?? emptyCats();
    let actual = 0;
    let duration = 0;
    let hasUsage = false;
    for (const r of group) {
      const u = usage.get(r.seq);
      if (u) {
        hasUsage = true;
        actual += u.usage.totalTokens || u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cacheWrite;
        duration += u.durationMs;
      }
    }
    out.push({
      seq: last.seq,
      turn: last.turn ?? out.length + 1,
      step: last.step ?? group.length,
      ts: last.ts ?? 0,
      cats: raw,
      total: CTX_CATS.reduce((s, c) => s + raw[c.id], 0),
      actual: hasUsage ? actual : null,
      durationMs: hasUsage ? duration : null,
      request: last,
    });
    group = [];
  };
  for (const req of reqs) {
    if (group.length && (req.turn ?? 1) !== (group[0]!.turn ?? 1)) flush();
    group.push(req);
  }
  flush();
  return out;
}

/** 正文行按 item id 合并；同一 id 后面的行覆盖前面的（插件只在内容变化时写）。 */
export function ctxBodyMap(lines: CtxLine[], before?: number): Map<string, CtxBody> {
  const out = new Map<string, CtxBody>();
  for (const l of lines) {
    if (l.kind !== "body" || typeof l.id !== "string" || typeof l.content !== "string") continue;
    // 同 id 的系统段 / 工具定义可能在后续请求里改过；看第 N 步时只能用第 N 步之前写下的正文。
    if (typeof before === "number" && typeof l.ts === "number" && l.ts > before) continue;
    out.set(l.id, {
      content: l.content,
      ...(typeof l.tool === "string" ? { tool: l.tool } : {}),
      ...(typeof l.args === "string" ? { args: l.args } : {}),
      ...(l.status === "ok" || l.status === "failed" ? { status: l.status } : {}),
      ...(typeof l.path === "string" ? { path: l.path } : {}),
      ...(typeof l.command === "string" ? { command: l.command } : {}),
      ...(typeof l.exitCode === "number" ? { exitCode: l.exitCode } : {}),
    });
  }
  return out;
}

/** 浏览器条目：七类分组、token、占比；delta 模式只保留相较基线新增/变大的条目。 */
export interface CtxBrowserCat {
  id: string;
  label: string;
  cls: string;
  items: CtxItem[];
  count: number;
  tokens: number;
  pct: number;
}

export interface CtxBrowserView {
  selected: CtxLine | null;
  baseline: CtxLine | null;
  items: CtxItem[];
  cats: CtxBrowserCat[];
  total: number;
  actual: number | null;
  omitted: number;
  mode: "full" | "delta";
}

function synthItems(req: CtxLine): CtxItem[] {
  const items: CtxItem[] = [];
  const c = req.cats ?? emptyCats();
  const systemRow = (req.perMessage ?? []).find((m) => m.role === "system");
  if (c.sys || req.header?.system?.length) {
    const header = req.header?.system ?? [];
    if (header.length) items.push(...header.map((it) => ({ ...it })));
    else {
      // v1 wrote the system prompt twice (cats.sys and a perMessage row). Use one row, never both.
      items.push({ id: "fallback:sys", cat: "sys", label: tr("系统提示词"), tokens: systemRow?.tokens || c.sys, kind: "section" });
    }
  }
  if (c.tools || req.header?.tools?.length) {
    const tools = req.header?.tools ?? [];
    if (tools.length) items.push(...tools.map((it) => ({ ...it })));
    else items.push({ id: "fallback:tools", cat: "tools", label: tr("工具定义"), tokens: c.tools, kind: "tool" });
  }
  if (c.inject) items.push({ id: "fallback:inject", cat: "inject", label: tr("注入内容"), tokens: c.inject, kind: "section" });
  if (c.skill) items.push({ id: "fallback:skill", cat: "skill", label: tr("技能注入"), tokens: c.skill, kind: "section" });
  for (let i = 0; i < (req.perMessage?.length ?? 0); i++) {
    const m = req.perMessage![i]!;
    if (m.role === "system") continue; // already represented by c.sys (or header), never inject
    const cat = m.role === "user" ? "user" : m.role === "assistant" ? "asst" : m.role === "toolResult" || m.role === "bashExecution" ? "toolr" : "inject";
    items.push({
      id: `fallback:${i}`,
      cat,
      label: m.role,
      tokens: m.tokens,
      kind: m.role === "assistant" ? "answer" : m.role === "toolResult" ? "result" : m.role,
    });
  }
  return items;
}

export function ctxBrowserView(
  lines: CtxLine[],
  seq: number | null,
  base: "step" | "turn",
  mode: "full" | "delta",
): CtxBrowserView {
  const reqs = ctxRequests(lines);
  const selected = reqs.find((r) => r.seq === seq) ?? reqs[reqs.length - 1] ?? null;
  if (!selected) return { selected: null, baseline: null, items: [], cats: [], total: 0, actual: null, omitted: 0, mode };
  const idx = reqs.indexOf(selected);
  let baseline: CtxLine | null = null;
  if (base === "step") baseline = idx > 0 ? reqs[idx - 1]! : null;
  else {
    const turn = selected.turn ?? 1;
    for (let i = idx - 1; i >= 0; i--) {
      if ((reqs[i]!.turn ?? 1) < turn) {
        baseline = reqs[i]!;
        break;
      }
    }
  }
  let items = (selected.items?.length ? selected.items : synthItems(selected)).map((it) => ({ ...it }));
  // `items` is capped at 400 from the end; the header is stable and may have fallen out of that
  // window. Put it back by id so the browser never loses the system prompt / tool definitions.
  const headerItems = [...(selected.header?.system ?? []), ...(selected.header?.tools ?? [])];
  if (headerItems.length) {
    const have = new Set(items.map((it) => it.id));
    items = [...headerItems.filter((it) => !have.has(it.id)).map((it) => ({ ...it })), ...items];
  }
  const bodies = ctxBodyMap(lines, selected.ts);
  if (bodies.size) {
    items = items.map((it) => {
      const body = bodies.get(it.id);
      return body ? { ...it, content: body.content, body } : it;
    });
  }
  if (mode === "delta" && baseline) {
    const baseMap = new Map<string, number>();
    for (const it of baseline.items?.length ? baseline.items : synthItems(baseline)) baseMap.set(it.id, it.tokens);
    items = items
      .map((it) => ({ ...it, tokens: Math.max(0, it.tokens - (baseMap.get(it.id) ?? 0)) }))
      .filter((it) => it.tokens > 0);
  }
  const total = items.reduce((s, it) => s + it.tokens, 0);
  const denom = total || 1;
  const cats: CtxBrowserCat[] = CTX_CATS.map((c) => {
    const list = items.filter((it) => it.cat === c.id);
    const tokens = list.reduce((s, it) => s + it.tokens, 0);
    return { id: c.id, label: tr(c.label), cls: c.cls, items: list, count: list.length, tokens, pct: (tokens / denom) * 100 };
  });
  const u = ctxUsageMap(lines).get(selected.seq);
  return {
    selected,
    baseline,
    items,
    cats,
    total,
    actual: u ? u.usage.totalTokens || u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cacheWrite : null,
    omitted: selected.itemsOmitted ?? 0,
    mode,
  };
}

/** 文件活动按路径聚合：读 / 写 / 检索次数、+新增 / −删除行、失败次数、最近时间。 */
export interface CtxFileRow {
  path: string;
  ops: number;
  reads: number;
  writes: number;
  searches: number;
  added: number;
  removed: number;
  failed: number;
  lastTs: number;
}

export function ctxFileRows(lines: CtxLine[]): CtxFileRow[] {
  const map = new Map<string, CtxFileRow>();
  for (const l of lines) {
    if (l.kind !== "activity" || l.activity !== "file") continue;
    const p = l.path || "?";
    const row = map.get(p) ?? { path: p, ops: 0, reads: 0, writes: 0, searches: 0, added: 0, removed: 0, failed: 0, lastTs: 0 };
    row.ops++;
    if (l.op === "read") row.reads++;
    else if (l.op === "search") row.searches++;
    else row.writes++; // write / edit
    row.added += typeof l.added === "number" ? l.added : 0;
    row.removed += typeof l.removed === "number" ? l.removed : 0;
    if (l.status === "failed") row.failed++;
    row.lastTs = Math.max(row.lastTs, l.ts ?? 0);
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
  totalMs: number;
  lastTs: number;
}

export function ctxCommandRows(lines: CtxLine[]): CtxCommandRow[] {
  const map = new Map<string, { program: string; runs: number; failed: number; totalMs: number; timed: number; lastTs: number }>();
  for (const l of lines) {
    if (l.kind !== "activity" || l.activity !== "command") continue;
    const p = l.program || "?";
    const row = map.get(p) ?? { program: p, runs: 0, failed: 0, totalMs: 0, timed: 0, lastTs: 0 };
    row.runs++;
    if (l.status === "failed") row.failed++;
    if (typeof l.durationMs === "number") {
      row.totalMs += l.durationMs;
      row.timed++;
    }
    row.lastTs = Math.max(row.lastTs, l.ts ?? 0);
    map.set(p, row);
  }
  return [...map.values()]
    .map((r) => ({
      program: r.program,
      runs: r.runs,
      failed: r.failed,
      avgMs: r.timed ? Math.round(r.totalMs / r.timed) : null,
      totalMs: r.totalMs,
      lastTs: r.lastTs,
    }))
    .sort((a, b) => b.runs - a.runs || a.program.localeCompare(b.program));
}

/** 工具调用按工具名聚合（命令算 bash、文件按 op 映射、其它工具用 activity.tool）。 */
export interface CtxToolRow {
  tool: string;
  runs: number;
  failed: number;
  avgMs: number | null;
}

export function ctxToolRows(lines: CtxLine[]): CtxToolRow[] {
  const map = new Map<string, { tool: string; runs: number; failed: number; totalMs: number; timed: number }>();
  for (const l of lines) {
    if (l.kind !== "activity") continue;
    let name = l.tool;
    if (!name) {
      if (l.activity === "command") name = "bash";
      else if (l.activity === "file") name = l.op === "search" ? "search" : l.op ?? "file";
      else name = "tool";
    }
    const row = map.get(name) ?? { tool: name, runs: 0, failed: 0, totalMs: 0, timed: 0 };
    row.runs++;
    if (l.status === "failed") row.failed++;
    if (typeof l.durationMs === "number") {
      row.totalMs += l.durationMs;
      row.timed++;
    }
    map.set(name, row);
  }
  return [...map.values()]
    .map((r) => ({ tool: r.tool, runs: r.runs, failed: r.failed, avgMs: r.timed ? Math.round(r.totalMs / r.timed) : null }))
    .sort((a, b) => b.runs - a.runs || a.tool.localeCompare(b.tool));
}

export interface CtxSummary {
  turns: number;
  steps: number;
  /** 去重后的技能名数量（dsh-context 的 Skill Loads 口径）。 */
  skills: number;
  skillNames: string[];
  answers: number;
  users: number;
  toolRows: CtxToolRow[];
  commandRows: CtxCommandRow[];
  fileRows: CtxFileRow[];
  events: { inject: number; compact: number; prune: number; model: number };
}

export function ctxSummary(lines: CtxLine[]): CtxSummary {
  const reqs = ctxRequests(lines);
  const usage = ctxUsageMap(lines);
  const events = ctxEvents(lines);
  const last = reqs[reqs.length - 1];
  let turns = 0;
  for (const r of reqs) turns = Math.max(turns, r.turn ?? 0);
  let answers = 0;
  for (const r of reqs) {
    const u = usage.get(r.seq);
    if ((u?.out.answer ?? 0) > 0 || (r.split?.answer ?? 0) > 0) answers++;
  }
  if (!usage.size && !reqs.some((r) => (r.split?.answer ?? 0) > 0)) answers = reqs.length;
  const toolRows = ctxToolRows(lines);
  const skillNames = new Set<string>();
  for (const r of reqs) for (const name of r.skills ?? []) if (name) skillNames.add(name);
  for (const e of events) if (e.kind === "inject" && e.label.startsWith("skill:")) skillNames.add(e.label.slice(6));
  // 旧日志没有 `skills` 字段：`/skill:` 展开的正文会把 `<skill name="…">` 写进 user 条目的 preview。
  for (const r of reqs) {
    for (const it of r.items ?? []) {
      const m = /<skill\b[^>]*\bname="([^"]+)"/.exec(it.preview ?? "");
      if (m) skillNames.add(m[1]);
    }
  }
  for (const l of lines) {
    if (l.kind !== "activity") continue;
    if (typeof l.skillName === "string" && l.skillName) skillNames.add(l.skillName);
    else if (l.tool === "skill") skillNames.add("skill");
    if (l.activity === "file" && l.op === "read") {
      const m = /([^/\\]+)[/\\]SKILL\.md$/i.exec(l.path ?? "");
      if (m) skillNames.add(m[1]);
    }
  }
  // 旧日志只有 `skill` 工具活动、没有名字：至少显示 1，不要把用过的技能画成 0。
  if (!skillNames.size && (toolRows.find((t) => t.tool === "skill")?.runs ?? 0) > 0) skillNames.add("skill");
  const userIds = new Set<string>();
  for (const r of reqs) for (const it of r.items ?? []) if (it.cat === "user") userIds.add(it.id);
  return {
    turns: turns || (reqs.length ? 1 : 0),
    steps: reqs.length,
    skills: skillNames.size,
    skillNames: [...skillNames],
    answers,
    users: Math.max(userIds.size, last?.users ?? 0),
    toolRows,
    commandRows: ctxCommandRows(lines),
    fileRows: ctxFileRows(lines),
    events: {
      inject: events.filter((e) => e.kind === "inject").length,
      compact: events.filter((e) => e.kind === "compact").length,
      prune: 0,
      model: events.filter((e) => e.kind === "model").length,
    },
  };
}

/** 展示格式：99_500 → 「99.5k」，千以下原样。 */
export function ctxFmt(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

