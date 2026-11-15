/**
 * 设置 → 工具 → 上下文洞察的数据形状。
 *
 * 桥只送聚合后的数字（会话级 + 最近 80 天按日），不送每个会话的 ctxlog 原文；
 * 逐请求正文仍在会话自己的 Context 面板里看。字段含义见 `bridge/src/context-insight.ts`。
 */

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

export interface CtxInsightBill {
  sys: number;
  tools: number;
  user: number;
  inject: number;
  skill: number;
  toolCalls: number;
  reasoning: number;
  answers: number;
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
  tokens: number;
  context: number;
  peak: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costKnown: boolean;
  bill: CtxInsightBill;
  days: Record<string, CtxInsightDay>;
  skills: Record<string, CtxInsightTally>;
  tools: Record<string, CtxInsightTally>;
  cmds: Record<string, CtxInsightTally>;
  files: { read: number; write: number; search: number };
  events: { inject: number; compact: number; model: number };
}

export interface CtxInsightWorkspaceGroup {
  id: string;
  name: string;
  key: string;
  manual: boolean;
  inRow: boolean;
}

export interface CtxInsightWorkspace {
  groups: CtxInsightWorkspaceGroup[];
  overrides: Record<string, string>;
  keys: Record<string, string>;
}

export interface CtxInsightData {
  generatedAt: number;
  sessions: CtxInsightSession[];
  workspace: CtxInsightWorkspace;
}
