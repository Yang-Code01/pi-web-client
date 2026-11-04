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
  /** Set by pi when stopReason is "error": the provider's own message (401, rate limit, overflow…). */
  errorMessage?: string;
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
/** `!cmd` / `!!cmd` run through pi's RPC bash (#16). */
export interface BashItem extends ItemBase {
  kind: "bash";
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  status: "running" | "done";
  error?: string;
}
/** Compaction / branch summary / extension message (#31). */
export interface SummaryItem extends ItemBase {
  kind: "summary";
  variant: "compaction" | "branch" | "custom";
  title: string;
  text: string;
}
export type Item = UserItem | AssistantItem | ToolItem | NoticeItem | BashItem | SummaryItem;

/** What pi extensions drew with ctx.ui.setStatus / setWidget / setTitle (fire-and-forget in RPC). */
export interface ExtUi {
  status: { key: string; text: string }[];
  widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
  title: string | null;
}

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
  /** Another process (the pi terminal) holds the lock: read-only, and the bridge refuses to delete it. */
  locked?: boolean;
  /** Launch options chosen at creation (#28), one line. */
  launch?: string;
}

/** What `manage/delete` did: partial success, so both halves matter (see Q-001). */
export interface DeleteReport {
  removed: string[];
  skipped: { id: string; name: string; reason: string }[];
}

/** A deleted session parked in the bridge's bin: gone from the list, not gone from disk. */
export interface TrashItem {
  id: string;
  name: string;
  /** Where the file lived; restore puts it back here. */
  file: string;
  cwd?: string;
  deletedAt: number;
  size: number;
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
  /** 多选：答案带 `picks`（1 起的序号）和可选的 `text`。 */
  multiSelect?: boolean;
}

export interface AskRequest {
  id: string;
  sessionId: string;
  sessionName: string;
  questions: AskQuestion[];
  createdAt: number;
  /** Q-033：发问方给的超时（毫秒）。只用来写 tooltip，卡片不会因此消失。 */
  timeoutMs?: number;
}

export interface AskAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom?: boolean;
  index?: number;
  /** 多选题选中的选项序号（1 起）。 */
  picks?: number[];
  /** 多选题另外写的话。 */
  text?: string;
}

export interface TunnelState {
  status: "off" | "starting" | "up" | "error";
  url: string | null;
  error: string | null;
  /** D110：bridge 侧带回来的错误码与参数（翻成当前语言用，见 i18n 的 errText）。 */
  errCode?: string;
  errParams?: Record<string, string | number>;
  updatedAt: number;
}

export interface Me {
  version: string;
  pi: string;
  public: boolean;
  tunnel: TunnelState;
  pushKey: string | null;
  pushCount: number;
  /** 「pi 设置 → 通知」总开关（D91）。 */
  notify?: boolean;
  sessionsRoot: string;
}

export type Decision = "approve" | "reject" | "cancel" | "always";

/** Mirrors bridge/src/sessions.ts RuntimeStats: `runtime.stats` 的载荷（D120 / #77）。 */
export interface RuntimeStats {
  running: number;
  /** 采样到的总字节数；没采样（没有在跑的 pi）或采样失败时为 null。 */
  totalBytes: number | null;
  unavailable: boolean;
  /** 按空闲时长降序。 */
  sessions: RuntimeSessionRow[];
}

export interface RuntimeSessionRow {
  id: string;
  name: string;
  running: boolean;
  idleMs: number;
  /** 只有读数可信、而且进程表里确实有这个 pid 时才有。 */
  bytes?: number;
}

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
  /** Root the token is scoped to: `rel` is relative to this (D63). */
  root: string;
  size: number;
  mtime: number;
  kind: "markdown" | "html" | "image" | "text" | "binary";
}

/** Tool permission mode the bridge's approval gate enforces per session. */
export type PermissionMode = "readonly" | "strict" | "ask" | "auto";

/** Q-021: what the bridge knows about the repo holding a directory. Present = it is a repository. */
export interface GitInfo {
  repo: string;
  branch: string;
  detached: boolean;
  empty: boolean;
  dirty: number;
}

/** 记录（D95）：bridge/src/notes.ts 的 Note 镜像，落在状态目录，不属于任何会话。 */
export type NoteKind = "bug" | "change" | "idea" | "chore";
export type NoteStatus = "pending" | "done" | "dropped";
export type NoteMode = "quick" | "form" | "long";
export interface Note {
  id: string;
  kind: NoteKind;
  status: NoteStatus;
  mode: NoteMode;
  title: string;
  body: string;
  /** 桥那台机器上的绝对路径（`/api/image?path=` 直接读）。 */
  shots: string[];
  sessionId: string | null;
  sessionName: string | null;
  issue: string;
  commit: string;
  createdAt: number;
  updatedAt: number;
  /** 归档 / 丢进垃圾箱的时间；都没有就是正常在列表里。 */
  archivedAt: number | null;
  deletedAt: number | null;
}
