export interface ItemBase {
  id: string;
  ts?: string;
}
export interface UserItem extends ItemBase {
  kind: "user";
  /** Display text — a `/skill:<name> args` call is folded back from pi's expansion by the bridge. */
  text: string;
  /** Set when the message was a `/skill:<name>` call: the command gets a chip, not the SKILL.md. */
  skill?: string;
  /** The SKILL.md path pi recorded (`location`), used as the chip's tooltip. */
  skillPath?: string;
  images: { mimeType: string; size?: number }[];
  /**
   * #197 / D178: 启动期发出的消息由桥收下、替用户排队时带这个字段（`booting` → `sent` / `failed`）。
   * 正常发送的消息没有它 —— 气泡上的「处理中…」不看这里，而是从运行态推的。
   */
  pending?: "booting" | "sent" | "failed";
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
export type ToolPlanStatus = "pending" | "in_progress" | "completed" | "deleted";
export interface ToolPlanTask {
  id: number;
  subject: string;
  activeForm?: string;
  status: ToolPlanStatus;
  blockedBy?: number[];
}
export interface ToolPlanSnapshot {
  tasks: ToolPlanTask[];
  listedRound: string | null;
  /** #357：这份快照之后又调用了几次别的工具（桥算，见 bridge/src/execplan.ts）。 */
  sinceUpdate?: number;
}
export interface ToolItem extends ItemBase {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  /** Snapshot after a todo update; null explicitly records a cleared plan. */
  plan?: ToolPlanSnapshot | null;
  partialResult?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "ok" | "error" | "unknown";
}
/**
 * 模型自己加载了一个技能（隐式触发）：它在 `read` 里读了 SKILL.md —— pi 没有 Skill 工具，
 * 系统提示词只给清单，读文件就是加载。名字与描述来自 frontmatter，`why` 是它读之前说的那句。
 */
export interface SkillItem extends ItemBase {
  kind: "skill";
  name: string;
  description: string;
  why?: string;
  /** `model` = 它读之前说的那句；`user` = 退回本轮用户消息。 */
  whyFrom?: "model" | "user";
  path?: string;
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
  status: "queued" | "running" | "done";
  error?: string;
}
/** Compaction / branch summary / extension message (#31). */
export interface SummaryItem extends ItemBase {
  kind: "summary";
  variant: "compaction" | "branch" | "custom";
  title: string;
  text: string;
}
export type Item = UserItem | AssistantItem | ToolItem | SkillItem | NoticeItem | BashItem | SummaryItem;

/**
 * #218 / #220: `session` 帧里的 `items` 只有末页，历史总量与「上面还有没有」走这里。
 * 老桥没有这个字段 —— 于是按「没有更早的」处理，翻页那一行就不出现。
 */
export interface SessionHistory {
  hasMore: boolean;
  total: number;
  /**
   * 会话文件太大，`items` 不是从头开始的（桥上 `loadEntries()` 丢了前面的条目）。
   * 老桥没这个字段 —— 当作没丢。
   */
  truncated?: boolean;
  /**
   * #243: 整段会话的轮次索引（不只这一页）。`text` 已在桥上折成一行并截短。
   * 老桥没有这个字段 —— 那就只画已载入的轮次，一个 ghost 都不出现。
   */
  turns?: { id: string; text: string; images: number }[];
}

/** What pi extensions drew with ctx.ui.setStatus / setWidget / setTitle (fire-and-forget in RPC). */
export interface ExtUi {
  status: { key: string; text: string }[];
  widgets: { key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }[];
  title: string | null;
}

/**
 * D170: 后台子代理。会话自己的 `running` 已经落回 false，这是「派出去的 runner 还在跑」。
 *
 * `n` 是在跑的；`recent` 是刚跑完、还留着一阵子能点开看结果的那几条 —— 它们**不算忙**，
 * 「继续」不该被它们按住（`web/src/continue-state.ts` 的 `bgBusy`）。
 */
export interface BgView {
  n: number;
  agent?: string;
  since?: number;
  recent?: number;
  finishedAt?: number;
  lastMs?: number;
}

/** D170 详情的线上形状（桥 `bg.list` 的 `runs[]`）；路径不出桥，只说有没有可看的。 */
export interface BgRunView {
  id: string;
  toolCallId?: string;
  source: "acp" | "subagents";
  agent: string;
  task: string;
  startedAt: number;
  state: "running" | "done" | "failed";
  endedAt?: number;
  hasLog: boolean;
  hasOut: boolean;
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
  /** #367：用户主动暂停的随手问不能因打开或提问而唤醒。 */
  paused?: boolean;
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
  /**
   * D170: 派出去的后台子代理还在跑（桥的内存态，桥重启就没了）。有这个字段时「继续」灰着，
   * 并在输入框上方给一条「子代理运行中」的提示 —— pi 会在 runner 回来时自己唤醒继续。
   */
  bg?: BgView | null;
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
  /** #276：是否参加横条；旧桥不带这个字段（undefined = 所有组都在横条里）。 */
  inRow?: boolean;
}

/**
 * 桥广播的工作区快照（`{type:"workspaces", workspace}`），`sessions.list` / `manage` 的回包也带一份。
 * 前端不再自己推分组：`groups` 是已建好的组，`overrides` 是拖进组的会话，`keys` 是 cwd → 工程根缓存。
 */
export interface WorkspaceState {
  groups: WsGroup[];
  overrides: Record<string, string>;
  keys: Record<string, string>;
  /** #173 一份组序（含折叠组）：左栏与标签行共用。旧桥没有这个字段。 */
  order?: string[];
  /** 标签行名额（1–12）。旧桥没有这个字段。 */
  max?: number;
}

/** What `manage/delete` did: partial success, so both halves matter (see Q-001). */
export interface DeleteReport {
  removed: string[];
  skipped: { id: string; name: string; reason: string }[];
  /** Running sessions the bridge released before moving the file（旧桥没有这个字段）. */
  released?: string[];
  /** The subset of `removed` that really landed in the bin; empty sessions have no payload to keep. */
  binned?: string[];
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
  /** Workspace to restore with this session after a workspace-wide delete. */
  workspace?: { group: WsGroup; order: number };
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

/**
 * D208 产物弹窗：「新增 / 修改」是文件事实，不是工具事实。
 * - status 由桥比「写入前的原文」和现在的文件得出；
 * - `new` 只在这条路径在会话开始前确实不存在时出现；
 * - 拿不到原文时宁可 `unknown`，也不拿 git 冒充事实 —— 那种情况 `estimate` 为 true。
 */
export type ArtifactStatus = "new" | "modified" | "same" | "deleted" | "unknown";

export interface ArtifactRow {
  /** 模型写文件时用的路径原文（相对/绝对都可能有）。 */
  path: string;
  abs: string;
  status: ArtifactStatus;
  /** 最后一次写它用的工具。 */
  tool: string;
  /** 这个会话里被写过几次（write×2 edit×1 里的数字）。 */
  writes: number;
  added: number;
  removed: number;
  /** 基线来自 git 的 HEAD，不是会话开始前的真实内容。 */
  estimate: boolean;
  binary: boolean;
  diffable: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
  /** 为什么是 unknown / 为什么没有行数。是码不是句子，文案走 tr()。 */
  why?: ArtifactWhy;
}

/** 桥只发码，句子在页面（D208）；键与 `bridge/src/artifacts.ts` 的 ArtifactWhy 一一对应。 */
export type ArtifactWhy =
  | "no-baseline"
  | "git-head-missing"
  | "snapshot-too-big"
  | "size-only"
  | "binary-size-only"
  | "built-then-deleted"
  | "diff-too-large"
  | "diff-rewrite";

export interface ArtifactSummary {
  new: number;
  modified: number;
  same: number;
  deleted: number;
  unknown: number;
  added: number;
  removed: number;
}

export interface ArtifactList {
  items: ArtifactRow[];
  summary: ArtifactSummary;
  /** exact = 每一行都有写入前的原文；partial = 一部分；none = 一条都没有。 */
  baseline: "exact" | "partial" | "none";
}

export interface ArtifactDiffLine {
  kind: "+" | "-" | " ";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface ArtifactHunk {
  /** `@@ -12,7 +12,9 @@` 这种原始头。 */
  header: string;
  lines: ArtifactDiffLine[];
}

export interface ArtifactDiff {
  path: string;
  abs: string;
  status: ArtifactStatus;
  estimate: boolean;
  binary: boolean;
  added: number;
  removed: number;
  hunks: ArtifactHunk[];
  truncated: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
  reason?: "no-baseline" | "binary" | "too-large" | "rewrite";
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
  kind: "markdown" | "html" | "image" | "pdf" | "text" | "sheet" | "slides" | "binary";
  /** D209：只有 kind==="slides" 有 —— 数出来的页数（null = 认不出）与本机能不能转。 */
  slides?: { pages: number | null; engine: boolean };
}

/** 译文里的一节：跟着原文的 `#`/`##` 标题走，左右对照按它对位（节数两边必须一样）。 */
export interface TrSection {
  heading: string;
  /** 原文这一节：左栏直接用它，不再切一遍文件。 */
  src: string;
  /** 机器翻出来的那一版 —— 同步回原文时拿它当「人改了哪儿」的基线。 */
  gen: string;
  /** 现在这一版，可能是人改过的。 */
  out: string;
  /** 机器这一节没翻成：out 里摆的是原文，点「更新」时要重翻。 */
  failed?: boolean;
}

/** 一份文件的译文缓存，落在桥的状态目录里，不碰源文件。 */
export interface TrDoc {
  abs: string;
  lang: string;
  provider: string;
  model: string;
  /** 翻的时候源文件的 mtime / size：对不上就是「原文改过了」。 */
  mtime: number;
  size: number;
  startedAt: number;
  warnings: string[];
  sections: TrSection[];
}

export interface TrJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  lang: string;
  provider: string;
  model: string;
  done: number;
  total: number;
  note: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface TrDocResp {
  doc: TrDoc | null;
  /** 源文件在译文之后被改过：只重翻变了的节。 */
  stale: boolean;
  langs: string[];
  mtime: number;
  size: number;
  job: TrJob | null;
  /** 本机偏好（默认拿哪个模型翻）。 */
  prefs?: TrPrefs;
  /** 出厂默认模型；设置页用它做「恢复默认」。 */
  defaultModel?: string;
}

export interface TrPrefs {
  /** `provider/id`；空串 = 还没设过。 */
  model: string;
}

export interface TrPrefsResp {
  prefs: TrPrefs;
  defaultModel: string;
}

export interface TrSyncResp {
  id: string;
  edits: number;
  missing: number;
  warnings: string[];
  /** 每一处要写回去的改动（已截断）：确认框只给看这几块。 */
  preview: { before: string; after: string }[];
}

/** D166 表格预览：格子只带显示串，有数字格式的按格式显示。 */
export type SheetCellKind = "n" | "s" | "b" | "e";

/** #429 单元格字体（来自 styles.xml 的 `<fonts>`；没写的字段用默认值）。 */
export interface SheetFont {
  /** 字体族（"Calibri"、"宋体"）。 */
  n?: string;
  /** 字号，pt。 */
  s?: number;
  b?: 1;
  i?: 1;
  u?: 1;
  /** 删除线。 */
  st?: 1;
  /** 字色 `#RRGGBB`。 */
  c?: string;
}

/** 四边框，值是 CSS 简写（`1px solid #D9D9D9`）。 */
export interface SheetBorders {
  t?: string;
  r?: string;
  b?: string;
  l?: string;
}

/**
 * #429 一格样式：桥端把 styles.xml 的 cellXfs 拍平成一个数组，格子只记下标。
 * 只带跟渲染有关的字段——数字格式在桥端已经套好了。
 */
export interface SheetStyle {
  f?: SheetFont;
  /** 填充色 `#RRGGBB`。 */
  bg?: string;
  bd?: SheetBorders;
  h?: "l" | "c" | "r" | "j";
  v?: "t" | "m" | "b";
  /** 自动换行。 */
  w?: 1;
  /** 缩进级别（0-15）。 */
  ind?: number;
  /** 缩小字体填充。 */
  sh?: 1;
  /** 旋转角度（只认 90/180 的倍数）。 */
  rot?: number;
}

/** #109 条件格式算出来的样式（前端只贴样式，不理解规则）。 */
export interface SheetFx {
  bg?: string;
  fg?: string;
  b?: 1;
  bar?: [number, string];
  icon?: { s: string; g: string; c: string; l: number };
}

export interface SheetCell {
  r: number;
  c: number;
  k: SheetCellKind;
  t: string;
  /** 数值原始值（无显示格式的原数）：数字格才有，复制粘贴用它。 */
  v?: number;
  /** 文件里指定的对齐（合并标题居中这类）。 */
  a?: "l" | "c" | "r";
  /** #109 条件格式：底色 / 字色 / 加粗 / 数据条 / 图标。 */
  fx?: SheetFx;
  /** #111：公式原文（不带 `=`）。 */
  f?: string;
  /** #111：只有公式、文件里没存结果——显示为空，不猜 0。 */
  noCache?: boolean;
  /** #429：样式下标（meta.styles 的索引）。 */
  s?: number;
}

/** #432：保存时提交给桥端的一条改动；`cell` 为 null 表示清空这一格。 */
export interface SheetEditOp {
  r: number;
  c: number;
  cell: { k: "s" | "n" | "b" | "e" | "f"; t?: string; v?: number; f?: string } | null;
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
  /** #110：格子数（rows × cols）；三档阈值按它分。 */
  cells?: number;
  /** #110 显示档：full 全量；light 只值（不涂条件格式）；none 不给（只给清单 + 尺寸）。 */
  tier?: "full" | "light" | "none";
  /** 藏起来的表：不出现在底部，只在状态条上提示个数。 */
  hidden?: boolean;
  merges?: SheetMerge[];
  /** 每列宽度（px），长度等于 cols。 */
  colWidths?: number[];
  freeze?: { rows: number; cols: number } | null;
  /** #109：认不出的条件格式规则条数（状态条提示「N 条暂不支持」）。 */
  cfUnsupported?: number;
  /** #111：这张表里「只有公式、没存结果」的格子数。 */
  noCache?: number;
  /** #429：默认行高（px），文件 `<sheetFormatPr defaultRowHeight>` 换算来的。 */
  defaultRowH?: number;
  /** #429：文件里指定了高度的行（px，0 表示隐藏）。 */
  rowH?: Record<number, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
  /** #427：文件里要求不显示网格线（`showGridLines="0"`）。 */
  gridLines?: false;
  /** #427：钉在格子上的图片（两格锚点给右下坐标，一格锚点给固定宽高）。 */
  images?: SheetImage[];
}

/** #427：xlsx drawing 里的一张图，坐标是 0 基行列 + 格内偏移（px）。 */
export interface SheetImage {
  /** zip 内路径（`xl/media/image3.png`）：换字节的凭据，也是浏览器缓存键。 */
  id: string;
  c0: number;
  r0: number;
  ox: number;
  oy: number;
  c1?: number;
  r1?: number;
  ox1?: number;
  oy1?: number;
  w?: number;
  h?: number;
}

/** #110 显示档：full 全量；light 只值（不涂条件格式）；none 不给（只给清单 + 尺寸）。 */
export type SheetTier = "full" | "light" | "none";

/** #107：查找命中的格子（只回坐标，不回值）。 */
export interface SheetMatches {
  sheet: string;
  matches: { r: number; c: number }[];
  /** 超过上限只回前 N 条。 */
  truncated?: boolean;
}

export interface SheetMeta {
  name: string;
  rows: number;
  cols: number;
  sheets: SheetInfo[];
  /** 包里有图表部件（#112）：页面视图值得自动转一次。 */
  charts?: boolean;
  /** #429：去重后的样式表，格子用 `SheetCell.s` 索引它。 */
  styles?: SheetStyle[];
}

export interface SheetWindow {
  sheet: string;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  rows: { r: number; cells: SheetCell[] }[];
  /** #110：这次实际解压/扫过的表 XML 字节；扫够就停，所以通常远小于整表。 */
  bytes?: number;
  /** 这张表 XML 的未压缩总字节数。 */
  partBytes?: number;
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

/** 分支操作工作台「历史」tab 的一行：`set` 是桥算好的「你独有 / 对面独有 / 两边相同」。 */
export interface GitCommit {
  h: string;
  s: string;
  an: string;
  at: number;
  merge: boolean;
  set: "left" | "right" | "common";
}

/**
 * D235: 工作台从 `/api/git/*` 拿到的形状，和 bridge/src/gitops.ts 的同名接口一一对应。
 * 前端不 import 桥的源码，所以这里抄一份（与 DepPackageId / sysmanage-types.ts 同样做法）。
 */
export type GitPending = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | "am";
export interface GitFile { path: string; status: string; old?: string }
export interface GitWorktreeState {
  repo: string;
  head: string;
  branch: string;
  detached: boolean;
  empty: boolean;
  dirty: number;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  conflicts: string[];
  pending: GitPending | null;
}
export interface GitRefs {
  repo: string;
  head: string;
  defaultBase: string;
  groups: { name: string; refs: { name: string; at: number; current: boolean; upstream?: string; ahead?: number; behind?: number }[] }[];
}
export interface GitDiffFile {
  path: string;
  old?: string;
  status: string;
  kind: "text" | "image" | "pdf" | "sheet" | "binary" | "missing";
  binary: boolean;
  size: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  lines: { left: string; right: string; tag: "same" | "add" | "del" | "mod" }[];
  images?: { base: string | null; target: string | null };
  note: string;
}
export interface GitDiff {
  repo: string;
  base: string;
  target: string;
  files: GitDiffFile[];
  limit: { lines: number; bytes: number };
}
export interface GitOpParams { [key: string]: string | boolean | string[] | undefined }
export interface GitExecResult {
  ok: boolean;
  exitCode: number;
  argv: string[];
  stdout: string;
  stderr: string;
  state: GitWorktreeState;
  conflicts: string[];
  pending: GitPending | null;
  refresh: boolean;
  code?: string;
}

/** `/api/git/history` 的应答（只在 `repo` 非空时存在）。 */
export interface GitHistory {
  repo: string;
  head: string;
  detached: boolean;
  base: string;
  baseAuto: boolean;
  branches: { name: string; at: number }[];
  ahead: number;
  behind: number;
  mergeBase: { h: string; at: number; s: string } | null;
  left: GitCommit[];
  right: GitCommit[];
  more: { left: boolean; right: boolean };
  fetchedAt: number;
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
