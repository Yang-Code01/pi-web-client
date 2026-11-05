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
  /** #86：随手问。它不进列表、不受通用休眠时间管，也不会被自动压缩。 */
  scratch?: boolean;
  /** pi 子进程还在启动（扩展在它内部加载：本机实测约 8 秒）。此时 composer 不许发。 */
  starting?: boolean;
  running: boolean;
  /**
   * D162: 最后一轮已完成。打开会话不再清它（卡片一直显示「完成」）；下一轮运行、发消息，或终端
   * 继续写会话文件才清。桥把它持久化，所以重启 / 换设备后仍然可见。
   */
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
  /** #94: 这个会话站在哪个工作区（组 id，见 WorkspaceState.groups；worktree 已并回主仓）。 */
  ws?: string;
  /** Another process (the pi terminal) holds the lock: read-only, and the bridge refuses to delete it. */
  locked?: boolean;
  /** Launch options chosen at creation (#28), one line. */
  launch?: string;
}

/** #94 工作区的一级分组；`id` 是稳定键（派生组 = 归一化工程根小写，手动组 = `manual:…`）。 */
export interface WsGroup {
  id: string;
  /** 手起的名字；空串 = 跟着目录名走。 */
  name: string;
  /** 工程根（`manual` 组为空）。 */
  key: string;
  manual: boolean;
}

/**
 * 桥广播的工作区快照（`{type:"workspaces", workspace}`），`sessions.list` / `manage` 的回包也带一份。
 * 前端不再自己推分组：`groups` 是已建好的组，`overrides` 是拖进组的会话，`keys` 是 cwd → 工程根缓存。
 */
export interface WorkspaceState {
  groups: WsGroup[];
  overrides: Record<string, string>;
  keys: Record<string, string>;
  /** #122 固定组 id，顺序即标签行顺序。旧桥没有这个字段。 */
  pinned?: string[];
  /** #122 标签行的固定名额（1–5）。旧桥没有这个字段。 */
  max?: number;
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

/**
 * `#89` 设置 → 口令：桥报的那一份快照。`value` 只有在 step-up 通过后才会有值（没通过直接
 * 不会收到这条消息）；`dir` 用来在页面上写出逃生门（忘了口令时去哪改）。
 */
export interface PassphraseView {
  value: string | null;
  dir: string;
}

/** Mirrors bridge/src/sessions.ts RuntimeStats: `runtime.stats` 的载荷（D120 / #77）。 */
export interface RuntimeStats {
  running: number;
  /** 采样到的总字节数；没采样（没有在跑的 pi）或采样失败时为 null。 */
  totalBytes: number | null;
  unavailable: boolean;
  /** 按空闲时长降序。 */
  sessions: RuntimeSessionRow[];
  /**
   * D120 / #78：此刻生效的两个阈值；面板上也能改（`runtime.settings`）。桥只发这两项 ——
   * `abortGraceMs` 是测试注入点，不对外暴露。
   */
  lifecycle: { idleMs: number; watermarkBytes: number };
}

/** Mirrors bridge/src/sessions.ts RuntimeStats 的兄弟：`runtime.sleepAll` 的回执（D120 / #80）。 */
export interface SleepAllReceipt {
  /** 已经请去睡觉的会话 id。 */
  slept: string[];
  /** 因为在跑而没动的会话，`why` 是固定 id，不是句子。 */
  skipped: { id: string; name: string; why: "running" }[];
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

/** 技能商店 (D126): one row of skills.sh's search results. */
export interface SkillStoreItem {
  /** `owner/repo/skill-name`, as skills.sh names it. */
  id: string;
  name: string;
  source: string;
  installs: number;
  description: string;
  /** Repo-relative folder, once the bridge resolved it; null when the repo has no match. */
  dir: string | null;
  /** The bridge has finished checking this row against its repo (second stage of the search). */
  resolved?: boolean;
  note?: string;
}

/** A skill pi would load right now, with the folder the 已安装 tab may delete. */
export interface InstalledSkill extends SkillInfo {
  /** Absolute path of the directory holding SKILL.md. */
  path: string;
  /** The discovery root (`<agentDir>/skills`, `~/.agents/skills`, `<cwd>/.pi/skills`, …). */
  root: string;
  /** A junction / symlink: uninstalling unlinks it and leaves the target alone. */
  link: boolean;
  /** User roots only — project skills belong to their repository. */
  removable: boolean;
  /** `owner/repo` or a local path, when the store wrote it. */
  from: string | null;
  installedAt: number | null;
}

/** One skill inside a repo or a local directory (按地址安装). */
export interface SkillSourceItem {
  path: string;
  name: string;
  description: string;
  local: boolean;
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
  kind: "markdown" | "html" | "image" | "text" | "sheet" | "binary";
}

/** D127 表格预览：格子只带显示串，有数字格式的按格式显示。 */
export type SheetCellKind = "n" | "s" | "b" | "e";

export interface SheetCell {
  r: number;
  c: number;
  k: SheetCellKind;
  t: string;
  /** 文件里指定的对齐（合并标题居中这类）。 */
  a?: "l" | "c" | "r";
  /** #111：公式原文（不带 `=`）。 */
  f?: string;
  /** #111：只有公式、文件里没存结果——显示为空，不猜 0。 */
  noCache?: boolean;
}

/** 合并区，0 基闭区间。 */
export interface SheetMerge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
  /** 藏起来的表：不出现在底部，只在状态条上提示个数。 */
  hidden?: boolean;
  merges?: SheetMerge[];
  /** 每列宽度（px），长度等于 cols。 */
  colWidths?: number[];
  freeze?: { rows: number; cols: number } | null;
  /** #111：这张表里「只有公式、没存结果」的格子数。 */
  noCache?: number;
}

export interface SheetMeta {
  name: string;
  rows: number;
  cols: number;
  sheets: SheetInfo[];
}

export interface SheetWindow {
  sheet: string;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  rows: { r: number; cells: SheetCell[] }[];
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
