// Shared wire types between bridge and web client.
// Kept dependency-free so both sides can import it directly.

export type ItemKind = "user" | "assistant" | "tool" | "error" | "meta";

export interface ToolView {
  name: string;
  args: Record<string, unknown>;
  /** Rendered result text (already trimmed by the bridge). */
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "done";
}

export interface Item {
  /** Stable for file-derived items (entry id); ephemeral ("live:…") while streaming. */
  id: string;
  kind: ItemKind;
  text?: string;
  thinking?: string;
  tool?: ToolView;
  images?: { mimeType: string; data: string }[];
  ts?: string;
  live?: boolean;
}

export interface SessionSummary {
  /** Session header id (uuid). For not-yet-started sessions the bridge makes up a temp id. */
  id: string;
  filePath: string | null;
  cwd: string;
  name: string;
  mtime: number;
  size: number;
  owner: "web" | "tty";
  /** True when a bridge-owned pi process is attached and alive. */
  live: boolean;
  streaming: boolean;
  pending: number;
  messageCount: number;
}

export interface LiveState {
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  streaming: boolean;
  pending: number;
  contextTokens?: number;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  sessionName: string;
  cwd: string;
  title: string;
  message: string;
  toolName: string;
  command?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
}

export type ServerMsg =
  | { t: "hello"; sessions: SessionSummary[]; models: ModelOption[]; version: string; piVersion: string; passphraseSet: boolean }
  | { t: "sessions"; sessions: SessionSummary[] }
  | { t: "snapshot"; sessionId: string; items: Item[]; live: LiveState; truncated: boolean }
  | { t: "item"; sessionId: string; item: Item }
  | { t: "patch"; sessionId: string; id: string; patch: Partial<Item> }
  | { t: "live"; sessionId: string; live: LiveState }
  | { t: "approval"; req: ApprovalRequest }
  | { t: "approval-resolved"; id: string; approved: boolean; by: string }
  | { t: "log"; level: "info" | "warn" | "error"; message: string; sessionId?: string }
  | { t: "error"; message: string }
  | { t: "pong" };

export type ClientMsg =
  | { t: "sub"; sessionId: string }
  | { t: "open"; sessionId: string }
  | { t: "new"; cwd: string; name?: string }
  | { t: "prompt"; text: string; streamingBehavior?: "steer" | "followUp" }
  | { t: "abort" }
  | { t: "approve"; id: string; approve: boolean }
  | { t: "list" }
  | { t: "setModel"; provider: string; modelId: string }
  | { t: "setThinking"; level: string }
  | { t: "ping" };
