/**
 * 跨会话「上下文洞察」聚合：把所有会话的 ctxlog 折成一份小而稳定的快照。
 *
 * 为什么在桥里聚合，而不是把每个会话的 ctxlog 全发给设置页：长会话单文件能到几 MB，几十个
 * 会话一起发会把设置页拖死。这里只保留页面要画的计数、Token / 费用、按日用量和工具账本；
 * 逐请求的正文仍然只在会话内 Context 面板里读。
 *
 * 数据源就是 `bridge/ext/context-log.ts` 的 JSONL。读取时按 (mtime, size) 缓存解析结果：
 * 设置页每开一次不必重扫几万个 JSON 行；文件没变就直接用上一次的聚合。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { renumberCtxLog } from "./ctxlog-seq.ts";
import type { SessionState } from "./sessions.ts";
import type { WorkspaceState } from "./workspaces.ts";

export interface CtxInsightDay {
  tokens: number;
  cost: number;
  requests: number;
  toolCalls: number;
  toolsMs: number;
}

export interface CtxInsightTally {
  n: number;
  last: number;
}

export interface CtxInsightSession {
  id: string;
  name: string;
  cwd: string;
  ws: string;
  archived: boolean;
  running: boolean;
  updatedAt: number;
  model: string;
  lastUser: string;
  requests: number;
  turns: number;
  steps: number;
  /** provider 计费 Token（usage.totalTokens 求和）；没有 usage 行为 0。 */
  tokens: number;
  /** 最后一次请求的估算上下文；旧日志没有 usage 时用它兜底展示。 */
  context: number;
  peak: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  bill: {
    sys: number;
    tools: number;
    user: number;
    inject: number;
    skill: number;
    toolCalls: number;
    reasoning: number;
    answers: number;
  };
  days: Record<string, CtxInsightDay>;
  skills: Record<string, CtxInsightTally>;
  tools: Record<string, CtxInsightTally>;
  cmds: Record<string, CtxInsightTally>;
  files: { read: number; write: number; search: number };
  events: { inject: number; compact: number; model: number };
}

export interface CtxInsightData {
  generatedAt: number;
  sessions: CtxInsightSession[];
  workspace: WorkspaceState;
}

type Line = Record<string, any>;

interface RequestRow {
  seq: number;
  ts: number;
  turn: number;
  step: number;
  total: number;
  model: string;
  lastUser: string;
  skills: string[];
  split: { reasoning: number; answer: number; calls: number };
  cats: Record<string, number>;
}

interface UsageRow {
  atSeq: number;
  ts: number;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  out: { reasoning: number; answer: number; calls: number };
}

interface Agg {
  requests: number;
  turns: number;
  steps: number;
  tokens: number;
  context: number;
  peak: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  bill: CtxInsightSession["bill"];
  days: Record<string, CtxInsightDay>;
  skills: Record<string, CtxInsightTally>;
  tools: Record<string, CtxInsightTally>;
  cmds: Record<string, CtxInsightTally>;
  files: { read: number; write: number; search: number };
  events: { inject: number; compact: number; model: number };
  model: string;
  lastUser: string;
}

const EMPTY = (): Agg => ({
  requests: 0,
  turns: 0,
  steps: 0,
  tokens: 0,
  context: 0,
  peak: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costKnown: false,
  bill: { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, reasoning: 0, answers: 0 },
  days: {},
  skills: {},
  tools: {},
  cmds: {},
  files: { read: 0, write: 0, search: 0 },
  events: { inject: 0, compact: 0, model: 0 },
  model: "",
  lastUser: "",
});

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function dayKey(ts: number): string {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function bump(map: Record<string, CtxInsightTally>, name: string, ts: number): void {
  const key = name.trim();
  if (!key || key === "__proto__") return;
  const row = map[key] ?? { n: 0, last: 0 };
  row.n += 1;
  row.last = Math.max(row.last, ts);
  map[key] = row;
}

function addTallyOnce(map: Record<string, CtxInsightTally>, name: string, ts: number): void {
  const key = name.trim();
  if (!key || key === "__proto__") return;
  const row = map[key] ?? { n: 0, last: 0 };
  if (row.n === 0) row.n = 1;
  row.last = Math.max(row.last, ts);
  map[key] = row;
}

function parseLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object" && typeof obj.seq === "number") out.push(obj);
    } catch {
      /* 正在追加的半行：下一次读文件时再收 */
    }
  }
  return renumberCtxLog(out);
}

/** 一个 ctxlog 文件的全部聚合。纯函数，方便单测。 */
export function aggregateCtxLog(lines: Line[]): Agg {
  const agg = EMPTY();
  const requests: RequestRow[] = [];
  const usage = new Map<number, UsageRow>();
  const requestDay = new Map<number, string>();
  let skillEvents = false;

  for (const l of lines) {
    if (l.kind === "request" || (!l.kind && l.cats)) {
      const cats = (l.cats ?? {}) as Record<string, number>;
      const requestSkills = new Set(Array.isArray(l.skills) ? l.skills.map((s: unknown) => String(s)).filter(Boolean) : []);
      // v1 / v2 日志没有 skills 字段：`/skill:` 展开的 `<skill name="…">` 会留在 user 条目的 preview。
      for (const item of Array.isArray(l.items) ? l.items : []) {
        if (item?.cat !== "user" || typeof item?.preview !== "string") continue;
        const m = /<skill\b[^>]*\bname="([^"]+)"/.exec(item.preview);
        if (m) requestSkills.add(m[1]);
      }
      const req: RequestRow = {
        seq: n(l.seq),
        ts: n(l.ts),
        turn: Math.max(1, n(l.turn) || 1),
        step: Math.max(1, n(l.step) || 1),
        total: n(l.total) || Object.values(cats).reduce((s, v) => s + n(v), 0),
        model: String(l.model ?? ""),
        lastUser: String(l.lastUser ?? ""),
        skills: [...requestSkills],
        split: { reasoning: n(l.split?.reasoning), answer: n(l.split?.answer), calls: n(l.split?.calls) },
        cats,
      };
      requests.push(req);
      agg.requests += 1;
      agg.turns = Math.max(agg.turns, req.turn);
      agg.steps = Math.max(agg.steps, req.step);
      agg.context = req.total;
      agg.peak = Math.max(agg.peak, req.total);
      if (req.model) agg.model = req.model;
      if (req.lastUser) agg.lastUser = req.lastUser;
      const day = dayKey(req.ts);
      requestDay.set(req.seq, day);
      const d = (agg.days[day] ??= { tokens: 0, cost: 0, requests: 0, toolCalls: 0, toolsMs: 0 });
      d.requests += 1;
    } else if (l.kind === "usage" && typeof l.atSeq === "number") {
      const u = l.usage ?? {};
      const cost = l.cost;
      usage.set(l.atSeq, {
        atSeq: l.atSeq,
        ts: n(l.ts),
        totalTokens: n(u.totalTokens ?? u.total),
        input: n(u.input),
        output: n(u.output),
        cacheRead: n(u.cacheRead),
        cacheWrite: n(u.cacheWrite),
        cost: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
        costKnown: typeof cost === "number" && Number.isFinite(cost),
        out: {
          reasoning: n(l.out?.reasoning),
          answer: n(l.out?.answer),
          calls: n(l.out?.calls),
        },
      });
    } else if (l.kind === "event") {
      if (l.event === "inject") {
        agg.events.inject += 1;
        if (typeof l.label === "string" && l.label.startsWith("skill:")) {
          skillEvents = true;
          bump(agg.skills, l.label.slice(6), n(l.ts));
        }
      } else if (l.event === "compact" || l.event === "compact_failed") agg.events.compact += 1;
      else if (l.event === "model") agg.events.model += 1;
    } else if (l.kind === "activity") {
      const kind = String(l.activity ?? "");
      const tool = String(l.tool ?? (kind === "command" ? "bash" : kind === "file" ? l.op ?? "file" : kind || "tool"));
      const ts = n(l.ts);
      bump(agg.tools, tool, ts);
      if (kind === "command") bump(agg.cmds, String(l.program ?? "?"), ts);
      if (kind === "file") {
        if (l.op === "read") {
          agg.files.read += 1;
          const m = /([^/\\]+)[/\\]SKILL\.md$/i.exec(String(l.path ?? ""));
          if (m) bump(agg.skills, m[1], ts);
        } else if (l.op === "search") agg.files.search += 1;
        else agg.files.write += 1;
      }
      const day = requestDay.get(n(l.atSeq)) ?? dayKey(ts);
      const d = (agg.days[day] ??= { tokens: 0, cost: 0, requests: 0, toolCalls: 0, toolsMs: 0 });
      if (kind === "command" || kind === "file" || kind === "tool") d.toolCalls += 1;
      d.toolsMs += n(l.durationMs);
    }
  }

  for (const req of requests) {
    const c = req.cats;
    agg.bill.sys += n(c.sys);
    agg.bill.tools += n(c.tools);
    agg.bill.user += n(c.user);
    agg.bill.inject += n(c.inject);
    agg.bill.skill += n(c.skill);
    const u = usage.get(req.seq);
    if (u) {
      const splitEmpty = u.out.reasoning === 0 && u.out.answer === 0 && u.out.calls === 0;
      agg.bill.toolCalls += n(c.toolr) + (splitEmpty ? req.split.calls : u.out.calls);
      agg.bill.reasoning += splitEmpty ? req.split.reasoning : u.out.reasoning;
      agg.bill.answers += splitEmpty ? req.split.answer : u.out.answer;
      agg.tokens += u.totalTokens;
      agg.input += u.input;
      agg.output += u.output;
      agg.cacheRead += u.cacheRead;
      agg.cacheWrite += u.cacheWrite;
      if (u.costKnown) {
        agg.cost += u.cost;
        agg.costKnown = true;
      }
      const day = requestDay.get(req.seq) ?? dayKey(req.ts);
      const d = (agg.days[day] ??= { tokens: 0, cost: 0, requests: 0, toolCalls: 0, toolsMs: 0 });
      d.tokens += u.totalTokens;
      d.cost += u.cost;
    } else {
      agg.bill.toolCalls += n(c.toolr);
      agg.bill.answers += n(c.asst);
    }
  }

  // 旧日志没有 skill 事件时，请求行的 skills 至少能回答「这个会话用过哪些技能」。
  // 有事件时只补事件漏掉的技能名，避免同一次加载被事件 + request 各数一遍。
  for (const req of requests) {
    for (const name of req.skills) {
      if (skillEvents && agg.skills[name]) continue;
      addTallyOnce(agg.skills, name, req.ts);
    }
  }

  // 只保留最近 80 天，页面最多看 8 周热力图；更早的只留在会话总计里。
  const days = Object.entries(agg.days).sort(([a], [b]) => a.localeCompare(b));
  if (days.length > 80) agg.days = Object.fromEntries(days.slice(-80));
  return agg;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  agg: Agg;
}

const cache = new Map<string, CacheEntry>();

async function readAgg(file: string): Promise<Agg> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return EMPTY();
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.agg;
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return hit?.agg ?? EMPTY();
  }
  const agg = aggregateCtxLog(parseLines(text));
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, agg });
  return agg;
}

function logFile(root: string, id: string): string | null {
  if (!/^[0-9a-f-]{6,}$/i.test(id)) return null;
  return path.join(root, id.slice(0, 8), `${id}.ctx.jsonl`);
}

/** 给设置页的「上下文洞察」：会话列表 + 每个会话的 ctxlog 聚合。 */
export async function collectContextInsight(input: {
  sessions: SessionState[];
  workspace: WorkspaceState;
  root: string;
}): Promise<CtxInsightData> {
  const out: CtxInsightSession[] = [];
  for (const s of input.sessions) {
    if (s.scratch) continue;
    const file = logFile(input.root, s.id);
    const agg = file ? await readAgg(file) : EMPTY();
    out.push({
      id: s.id,
      name: s.name || s.id.slice(0, 8),
      cwd: s.cwd ?? "",
      ws: s.ws ?? "",
      archived: s.archived === true,
      running: s.running === true,
      updatedAt: s.updatedAt ?? 0,
      model: agg.model || s.model || "",
      lastUser: agg.lastUser || s.preview || "",
      requests: agg.requests,
      turns: agg.turns,
      steps: agg.steps,
      tokens: agg.tokens,
      context: agg.context,
      peak: agg.peak,
      input: agg.input,
      output: agg.output,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      cost: agg.cost,
      costKnown: agg.costKnown,
      bill: agg.bill,
      days: agg.days,
      skills: agg.skills,
      tools: agg.tools,
      cmds: agg.cmds,
      files: agg.files,
      events: agg.events,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  return { generatedAt: Date.now(), sessions: out, workspace: input.workspace };
}
