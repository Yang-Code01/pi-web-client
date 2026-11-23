/**
 * 帧词表：桥与页面之间那条 WebSocket 上跑的全部消息类型，以及其中最要命的 9 个帧的载荷。
 *
 * 为什么在这里：两侧今天各有一张 128 分支的 `switch (msg.type)`（桥 `index.ts` 收上行、页面
 * `app.ts` 收下行），却没有一处写着「一共有哪些帧」。结果是拼错一个 case、桥发了一个页面不认的
 * 帧、页面认了一个桥从不发的帧，全靠人肉比对。这张表把「帧叫什么」收紧成编译期事实。
 *
 * 契约：**这个文件是叶子**。它只有类型和字符串常量，不 import 任何东西 —— 因为 `app.ts` 会
 * import 它，而 `app.ts` 头两行 import 了 CSS，桥上编不过；反过来桥的 `index.ts` 末行会调
 * `main()`，页面也不能 import 它。谁往这里加 import，两侧的编译就有一侧会炸。
 *
 * 两个方向的类型是分开的：下行（桥 → 页面）128 个、上行（页面 → 桥）128 个，名字不重样。
 * 别合成一张表 —— `manage`、`presence` 这种双向同名、含义不同的帧会立刻把联合搞成一张假合同。
 *
 * 怎么用它：两侧那两条大 switch 的**判据**写成 `msg.type as ClientFrameType` /
 * `msg.type as ServerFrameType`，于是任何 case 标签只要不在表里，当场 TS2678（"not comparable"）。
 * 128 个臂的载荷**不**逐个收窄 —— 那要几百处 `as`/断言，换来的只是「帧里字段名拼错」，可同一条
 * switch 里的 `msg.foo` 本来就是 `any`，收窄不了那个。所以这里不定义「松袋子帧」类型，也就没有
 * 一个 `any` 要解释。要收窄哪个帧，就给它一个接口（下面 9 个），再把 Arm 搬进页面的帧表。
 */

// ---------------------------------------------------------------------------
// 下行：桥 → 页面
// ---------------------------------------------------------------------------

/** 桥能发给页面的全部帧。与 `bridge/src/index.ts`、`bridge/src/sessions.ts` 的 `emitWs` 对齐。 */
export type ServerFrameType =
  | "approval.add"
  | "approval.remove"
  | "ask.add"
  | "ask.remove"
  | "attendance.reminder"
  | "auth.done"
  | "auth.event"
  | "auth.prompt"
  | "auth.prompt.cancel"
  | "auth.providers"
  | "auth.started"
  | "bash.delta"
  | "bg.list"
  | "bg.log"
  | "branch.result"
  | "bug.done"
  | "bug.progress"
  | "catalog"
  | "commands"
  | "context.policy"
  | "copilot"
  | "ctxlog"
  | "delete.result"
  | "delta"
  | "editor.set"
  | "error"
  | "exec.child.delta"
  | "exec.child.snapshot"
  | "exec.child.unavailable"
  | "ext.changed"
  | "ext.error"
  | "ext.inventory"
  | "ext.op"
  | "ext.store"
  | "ext.ui"
  | "ext.updates"
  | "failures"
  | "failures.reminded"
  | "failures.reviewed"
  | "failures.saved"
  | "filesearch.result"
  | "filesearch.status"
  | "handoff.state"
  | "hello"
  | "history"
  | "import.result"
  | "item.add"
  | "item.remove"
  | "item.replace"
  | "items"
  | "lockext"
  | "mail.confirm"
  | "manage"
  | "market.changed"
  | "market.list"
  | "market.op"
  | "market.progress"
  | "market.sources"
  | "mcp.index"
  | "mcp.store"
  | "mkdir.result"
  | "mkfile.result"
  | "need-stepup"
  | "notes"
  | "notes.saved"
  | "notes.shot"
  | "notice"
  | "notify"
  | "passphrase"
  | "passphrase.changed"
  | "passphrase.error"
  | "passphrase.suggest"
  | "permission.applied"
  | "permission.defaults"
  | "pi.status"
  | "pi.update.status"
  | "pi.version"
  | "picli.done"
  | "picli.out"
  | "picli.start"
  | "plan"
  | "preview.open"
  | "purge.result"
  | "queue"
  | "queue.restore"
  | "reminder.toast"
  | "reminders"
  | "restore.result"
  | "rules"
  | "rules.saved"
  | "runtime.sleepAll"
  | "runtime.stats"
  | "session"
  | "session.gone"
  | "session.state"
  | "sessions.list"
  | "settings"
  | "settings.error"
  | "share.done"
  | "share.progress"
  | "skill.install.done"
  | "skill.installed"
  | "skill.remove.done"
  | "skill.source"
  | "skill.store"
  | "skill.store.meta"
  | "skills"
  | "stats"
  | "stepup-ok"
  | "subagents.acp"
  | "subagents.acp.error"
  | "subagents.agents"
  | "term.data"
  | "term.error"
  | "term.exit"
  | "term.gone"
  | "term.list"
  | "term.opened"
  | "term.replay"
  | "tool"
  | "trash"
  | "tree"
  | "trust"
  | "tunnel"
  | "ui"
  | "usage"
  | "workspaces"
  | "ws.created"
  | "ws.delete.result"
  | "ws.resolved";

// ---------------------------------------------------------------------------
// 上行：页面 → 桥
// ---------------------------------------------------------------------------

/** 页面能发给桥的全部帧。与 `bridge/src/index.ts` 的 `switch (msg.type)` 对齐。 */
export type ClientFrameType =
  | "abort"
  | "abortBash"
  | "answer"
  | "approve"
  | "auth.answer"
  | "auth.cancel"
  | "auth.list"
  | "auth.login"
  | "auth.logout"
  | "bash"
  | "bg.list"
  | "bg.log"
  | "bug"
  | "claim"
  | "clearQueue"
  | "clone"
  | "close"
  | "commands"
  | "compact"
  | "context.policy.get"
  | "context.policy.set"
  | "create"
  | "exec.child.subscribe"
  | "exec.child.unsubscribe"
  | "ext.inventory"
  | "ext.store"
  | "ext.toggle"
  | "ext.updates"
  | "failures.act"
  | "failures.commit"
  | "failures.get"
  | "failures.remind"
  | "failures.review"
  | "failures.undo"
  | "filesearch.pause"
  | "filesearch.query"
  | "filesearch.resume"
  | "filesearch.scan"
  | "filesearch.status"
  | "filesearch.volumes"
  | "fork"
  | "handoff.start"
  | "history.before"
  | "import"
  | "lang"
  | "lockext.get"
  | "lockext.set"
  | "mail.confirm.done"
  | "manage"
  | "market.delete"
  | "market.install"
  | "market.list"
  | "market.publish"
  | "market.sources"
  | "market.uninstall"
  | "mcp.bump"
  | "mcp.install"
  | "mcp.store"
  | "mcp.toggle"
  | "mkdir"
  | "mkfile"
  | "models"
  | "notes.delete"
  | "notes.life"
  | "notes.list"
  | "notes.purge"
  | "notes.save"
  | "notes.shot"
  | "notes.shot.remove"
  | "notes.status"
  | "notify.set"
  | "open.script"
  | "passphrase.get"
  | "passphrase.set"
  | "passphrase.suggest"
  | "permission.applyDefault"
  | "permission.defaults"
  | "pi.update.check"
  | "picli"
  | "pkg.toggle"
  | "presence"
  | "preview.open.done"
  | "prompt"
  | "reload"
  | "reminder.mute"
  | "reminder.read"
  | "reminder.set"
  | "rename"
  | "rules.delete"
  | "rules.get"
  | "rules.reviewed"
  | "rules.set"
  | "runtime"
  | "runtime.settings"
  | "runtime.sleepAll"
  | "runtime.stats"
  | "scratch.clear"
  | "scratch.open"
  | "scratch.pause"
  | "scratch.resume"
  | "setModel"
  | "setPermission"
  | "setThinking"
  | "settings.get"
  | "settings.set"
  | "share"
  | "skill.install"
  | "skill.installed"
  | "skill.remove"
  | "skill.source"
  | "skill.store"
  | "skillUsed"
  | "skills"
  | "stepup"
  | "subagents.acp.get"
  | "subagents.acp.set"
  | "subagents.acp.thinkingFix"
  | "subagents.agents"
  | "subscribe"
  | "term.attach"
  | "term.close"
  | "term.elevate"
  | "term.input"
  | "term.list"
  | "term.open"
  | "term.resize"
  | "tree"
  | "trust.get"
  | "trust.set"
  | "ui.set"
  | "unsubscribe";

// ---------------------------------------------------------------------------
// 载荷：先给最要命的 9 个帧（审批 / 问卷 / 用量 / 上下文 / 运行状态）
// ---------------------------------------------------------------------------

/** 已经收窄载荷的 9 个帧。剩下的 119 个帧先只收名字，载荷仍是 `any`（见文件头「怎么用它」）。 */
export type TypedServerFrameType =
  | "approval.add"
  | "approval.remove"
  | "ask.add"
  | "ask.remove"
  | "usage"
  | "stats"
  | "copilot"
  | "ctxlog"
  | "pi.status";

/** `usage`：这一轮的 token 用量，页面拿 `output` 算每秒速率。 */
export interface UsageFrame {
  type: "usage";
  sessionId: string;
  usage: { output?: number; [k: string]: unknown } | null;
}

/** `stats`：会话累计的 token / cost / 上下文占用（页面只读这几个字段，其余原样透传）。 */
export interface StatsFrame {
  type: "stats";
  sessionId: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null;
  cost?: number | null;
  context?: { tokens?: number; contextWindow?: number; [k: string]: unknown } | null;
  /** `context.policy` 的当前值；`undefined` 表示这一帧没带（页面保留原值）。 */
  policy?: unknown;
}

/** `copilot`：copilot 用量视图。字段与 `bridge/src/copilot-credits.ts` / `web/src/copilot.ts` 的 `CopilotView` 同名，两处对象形状原样过去。 */
export interface CopilotFrame {
  type: "copilot";
  sessionId: string;
  hasCopilot: boolean;
  credits: number | null;
  requests: number;
  lastAt: string | null;
  estimated?: boolean;
  otherCost: number;
  /** 账号额度快照；形状由桥的 `CopilotAccountView` 定，页面自己断言。 */
  account: unknown;
  /** 对账结果；同上。 */
  reconcile: unknown;
}

/** `ctxlog`：上下文面板的行。`full` 表示整份替换（否则按 `seq` 去重后追加）。 */
export interface CtxlogFrame {
  type: "ctxlog";
  sessionId: string;
  full?: boolean;
  total?: number;
  lines?: readonly unknown[];
}

/** `pi.status`：这一帧只说明「跑着没跑」，不看 `session.state`。 */
export interface PiStatusFrame {
  type: "pi.status";
  sessionId: string;
  running: boolean;
}

/** `approval.add`：一个新的工具审批请求。 */
export interface ApprovalAddFrame {
  type: "approval.add";
  sessionId: string;
  approval: unknown;
}

/** `approval.remove`：审批结束了。`decision` 是 `allow` / `deny` / 其它桥自己认的值。 */
export interface ApprovalRemoveFrame {
  type: "approval.remove";
  sessionId: string;
  id: string;
  decision?: unknown;
}

/** `ask.add`：一道新问卷。`ask` 是打码后的那份（`publicAsk`），`tool` 是发起它的工具名。 */
export interface AskAddFrame {
  type: "ask.add";
  sessionId: string;
  ask: unknown;
  tool?: unknown;
}

/** `ask.remove`：问卷结束。`status` 只有两种，页面据此决定要不要留一块「已答但没提交」的残影。 */
export interface AskRemoveFrame {
  type: "ask.remove";
  sessionId: string;
  id: string;
  status: "answered" | "cancelled";
  answers?: unknown;
  reason?: string;
}

/** 桥发给页面、且载荷已经收窄的那 9 帧。页面 `applyFrame()` 吃的就是这一个联合。 */
export type TypedServerFrame =
  | UsageFrame
  | StatsFrame
  | CopilotFrame
  | CtxlogFrame
  | PiStatusFrame
  | ApprovalAddFrame
  | ApprovalRemoveFrame
  | AskAddFrame
  | AskRemoveFrame;

// ---------------------------------------------------------------------------
// 构造器：桥侧只从这里拼帧，别各拼一份
// ---------------------------------------------------------------------------

/**
 * `hello.caps` 里的一条：桥认得这张词表。页面看到它就知道对面不会发自己不认识的新帧；
 * 看不到就按「老桥」处理（新帧相关的 UI 先不显示）。
 */
export const FRAMES_CAP = "frames.v1";

export function usageFrame(sessionId: string, usage: UsageFrame["usage"]): UsageFrame {
  return { type: "usage", sessionId, usage };
}

export function statsFrame(sessionId: string, p: Omit<StatsFrame, "type" | "sessionId">): StatsFrame {
  return { type: "stats", sessionId, ...p };
}

export function copilotFrame(sessionId: string, view: Omit<CopilotFrame, "type" | "sessionId">): CopilotFrame {
  return { ...view, type: "copilot", sessionId };
}

export function ctxlogFrame(sessionId: string, p: { full: boolean; total: number; lines: readonly unknown[] }): CtxlogFrame {
  return { type: "ctxlog", sessionId, ...p };
}

export function piStatusFrame(sessionId: string, running: boolean): PiStatusFrame {
  return { type: "pi.status", sessionId, running };
}

export function approvalAddFrame(sessionId: string, approval: unknown): ApprovalAddFrame {
  return { type: "approval.add", sessionId, approval };
}

export function approvalRemoveFrame(sessionId: string, id: string, decision: unknown): ApprovalRemoveFrame {
  return { type: "approval.remove", sessionId, id, decision };
}

export function askAddFrame(sessionId: string, ask: unknown, tool: unknown): AskAddFrame {
  return { type: "ask.add", sessionId, ask, tool };
}

export function askRemoveFrame(
  sessionId: string,
  id: string,
  r: { status: "answered"; answers: unknown } | { status: "cancelled"; reason: unknown },
): AskRemoveFrame {
  return r.status === "answered"
    ? { type: "ask.remove", sessionId, id, status: "answered", answers: r.answers }
    : { type: "ask.remove", sessionId, id, status: "cancelled", reason: String(r.reason ?? "") };
}
