export interface ItemBase {
  id: string;
  ts?: string;
}
export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  images: { mimeType: string; size?: number }[];
}
export interface AssistantItem extends ItemBase {
  kind: "assistant";
  text: string;
  thinking: string;
  model?: string;
  modelName?: string;
  stopReason?: string;
}
export interface ToolItem extends ItemBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  partialResult?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "ok" | "error" | "unknown";
}
export interface NoticeItem extends ItemBase {
  kind: "notice";
  text: string;
  level?: "info" | "warn" | "error";
}
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem;

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  title: string;
  message: string;
  createdAt: number;
  deadline?: number;
}

export interface SessionState {
  id: string;
  name: string;
  cwd: string;
  file: string | null;
  owned: boolean;
  origin?: "web" | "disk";
  running: boolean;
  /** A turn finished since you last opened it (the card shows 完成 in its corner). */
  done: boolean;
  model?: string;
  modelName?: string;
  thinkingLevel?: string;
  updatedAt: number;
  startedAt?: string;
  truncated?: boolean;
  approvals: number;
  /** Questions waiting for an answer (see PLAN-ask.md). */
  asks?: number;
  /** First user message, for searching in the manager. */
  preview?: string;
  permission?: PermissionMode;
  /** Sidebar arrangement from the bridge (state/manage.json). */
  pinned?: boolean;
  archived?: boolean;
}

/** The part of the sidebar the user owns: pin, manual order, archive (D46). */
export interface ManageState {
  pin: string[];
  order: string[];
  archived: string[];
}

// ---------------------------------------------------------------- ask-user
export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  label?: string;
  prompt: string;
  options: AskOption[];
  allowOther?: boolean;
}

export interface AskRequest {
  id: string;
  sessionId: string;
  sessionName: string;
  questions: AskQuestion[];
  createdAt: number;
}

export interface AskAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom?: boolean;
  index?: number;
}

export interface TunnelState {
  status: "off" | "starting" | "up" | "error";
  url: string | null;
  error: string | null;
  updatedAt: number;
}

export interface Me {
  version: string;
  pi: string;
  public: boolean;
  tunnel: TunnelState;
  pushKey: string | null;
  pushCount: number;
  sessionsRoot: string;
}

export type Decision = "approve" | "reject" | "cancel" | "always";

/** Mirrors bridge/src/pi.ts ModelInfo. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  levels: string[];
  contextWindow?: number;
  supportsImages?: boolean;
}

/** A skill pi can run; picked from the palette it becomes `/skill:<name> ...` in the prompt. */
export interface SkillInfo {
  name: string;
  description: string;
  source: "user" | "project" | "other";
  uses: number;
  lastUsed: number;
}

export interface PreviewInfo {
  token: string;
  rel: string;
  name: string;
  abs: string;
  size: number;
  mtime: number;
  kind: "markdown" | "html" | "image" | "text" | "binary";
}

/** Tool permission mode the bridge's approval gate enforces per session. */
export type PermissionMode = "readonly" | "strict" | "ask" | "auto";
