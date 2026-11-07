import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.ts";
import { ChatView, createEl as el } from "./chat.ts";
import { BUILD_ID } from "./build.ts";
import { filterCommands, type CommandItem } from "./commands.ts";
import { fileNameOf, hasPathToken, mountDirPicker, type DirPicker, type DirPickerState } from "./dirpicker.ts";
import { HL_MAX_BYTES, highlightFragment, langOf } from "./highlight.ts";
import { renderMarkdown } from "./md.ts";
import { diagnose, exitCodeOf, setKnownPlugins } from "./diagnose.ts";
import { classify, entryKey, normalizeSig, reviewClasses, sameFail, toCommit, type FailLedger, type SeenFail } from "./failures.ts";
import { parseRules, type RuleBook } from "./rules.ts";
import { openPinMenu, type PinMenuHandle } from "./pinmenu.ts";
import { PillBar, neighborAfterArchive, starredSessions } from "./pillbar.ts";
import { applyPending, badgeSession, syncPending, type PendingCounts, type PendingKind } from "./pending.ts";
import { NowChip, normalizeWsPath, nowChipView, wsOf, type NowChipPending } from "./nowchip.ts";
import { activeLayout, LAYOUTS, layoutPref, layoutSupported, type LayoutId } from "./layout.ts";
import { railModel, shellParts, tabsAddShown, type RailItem } from "./shells.ts";
import { bgBusy, continueState } from "./continue-state.ts";
import { ACCENTS } from "./palette.ts";
import { NotesSheet, type NotesHost } from "./notesheet.ts";
import { SheetDialog } from "./sheet/dialog.ts";
import { CSV_MAX_BYTES, csvWindow, readCsv, reparseCsv, type CsvData } from "./sheet/csv.ts";
import { ScratchChat } from "./scratch.ts";
import { skillOf } from "./skill.ts";
import { Socket } from "./ws.ts";
import { buildTree, type Tree, type TreeGroup } from "./tree.ts";
import { TABS_DEFAULT, TABS_MAX, TABS_MIN, clampMax, moveToFront, newTabFold, tabHitTest, tabModel, tabReorder, type TabHit, type TabModel, type TabRect } from "./wstabs.ts";
import { armFocus, consumeFocus, type PendingFocusState } from "./focusfollow.ts";
import { openWsMenu, type WsMenuHandle } from "./wsmenu.ts";
import { stickMenu } from "./menuplace.ts";
import { WS_NAME_MAX, dropBlocker, renameIntent } from "./wsmanage.ts";
import { hitTest, keyMovePlan, keyShiftIndex, moveTo, planDrop, type DropHit } from "./drag.ts";
import type { AskAnswer, AskQuestion, AskRequest, ApprovalRequest, DeleteReport, ExtUi, GitInfo, InstalledSkill, Item, ManageState, Me, Note, ModelInfo, PassphraseView, PermissionMode, PreviewInfo, RuntimeStats, BgRunView, SessionState, SheetMeta, SheetWindow, SkillInfo, SkillSourceItem, SkillStoreItem, SleepAllReceipt, TrashItem, TunnelState, WorkspaceState } from "./types.ts";
import { tr } from "./i18n/index.ts";
import { applyLang, detectLang, errText, fmtDate, fmtNum, fmtRelative, fmtTime, isLang, LANGS, type Lang } from "./i18n/index.ts";

type Tab = "sessions" | "chat" | "queue";

/**
 * 面板等目录的两个时间窗（D150）：过了 REASK 就当「刚问的那次没结果」，自己再问一遍；
 * 还没过 WAIT 就先说「正在读取」而不是「还没加载好」。两个数对着 bridge 那趟完整清单的预算
 * （`bridge/src/pi.ts` 的 `fetchModels` 默认 45 s）写，改那边记得改这边。
 */
const MODEL_REASK_MS = 15_000;
const MODEL_WAIT_MS = 45_000;

/**
 * 点了「继续」之后多久内不再认第二次点击（D159）。`pi.status(running)` 回到页面之前按钮还亮着，
 * 这期间连点会排上两条一模一样的消息。按会话记，不是按页面：切到别的会话再点不该被这边吞掉。
 */
const CONTINUE_GUARD_MS = 1500;

/**
 * 点「继续」时发给 pi 的**字面**文本（D159）：按钮标签走 `tr("继续")`，但这行字**不翻译** ——
 * 英文界面发 `Continue` 会让模型读到的东西跟着界面语言变，而用户要的就是「继续」这两个字。
 * （写成模块级常量也是告诉 `i18n-check`：这不是漏翻的界面文案。）
 */
const CONTINUE_TEXT = "继续";

/** One place for "what is this session doing right now" — left card, manager row and pin chip all use it. */
type BadgeKind = "ask" | "approve" | "locked" | "run" | "bg" | "done";

interface SessionBadge {
  kind: BadgeKind;
  text: string;
  cls: "wait" | "lock" | "run" | "done";
  title: string;
  /** Blocked on the user — worth calling out in the pin strip header. */
  pending: boolean;
}

/**
 * `running` only means "the pi process is alive": it stays true while an approval or a question is
 * waiting for the user. Anything that says "正在跑" has to look at asks/approvals first, or it will
 * report a session stuck on the user as busy.
 *
 * D162: 「完成」也显示在**当前打开的会话**上 —— 打开只是看，不再把完成抹掉。否则用户点开确认
 * 一眼，卡片就从「完成」退回时间，再也没法从列表判断这一轮到底结束了没有。
 */
/** D170 详情的线上形状。见 `web/src/types.ts`（与左栏那份 `SessionState` 摆在一起）。 */
type BgRunDto = BgRunView;

/** 详情里的一屏：一卡片 + 它三块会变的字。 */
interface BgRunNode {
  root: HTMLElement;
  state: HTMLElement;
  log: HTMLElement;
  out: HTMLElement;
  labOut: HTMLElement;
  /** 这个 run 有没有过程记录（桥还没接上的才 false；卡片上直说，不装成「还没有」。） */
  hasLog: boolean;
}

function sessionBadge(s: SessionState): SessionBadge | null {
  if (s.asks && s.asks > 0) {
    return {
      kind: "ask",
      text: s.asks > 1 ? tr("待回答 {p1}", { p1: s.asks }) : tr("待回答"),
      cls: "wait",
      title: tr("在等你回答问卷，这个会话停在这儿了"),
      pending: true,
    };
  }
  if (s.approvals > 0) {
    return {
      kind: "approve",
      text: s.approvals > 1 ? tr("待确认 {p1}", { p1: s.approvals }) : tr("待确认"),
      cls: "wait",
      title: tr("在等你确认这条命令"),
      pending: true,
    };
  }
  if (s.locked) {
    return { kind: "locked", text: tr("终端占用"), cls: "lock", title: tr("pi CLI 在终端里正用着这个会话，网页这边只能看"), pending: false };
  }
  if (s.running) return { kind: "run", text: tr("运行中"), cls: "run", title: tr("agent 正在推进"), pending: false };
  // D170: 会话自己 settle 了，派出去的 runner 还在跑 —— 「完成」是假的，得先把这枚亮出来。
  if (bgBusy(s)) {
    return {
      kind: "bg",
      text: s.bg?.n && s.bg.n > 1 ? tr("后台 {p1}", { p1: s.bg.n }) : tr("后台"),
      cls: "run",
      title: s.bg?.agent ? tr("子代理 {p1} 还在后台跑，pi 会在它回来时接着做", { p1: s.bg.agent }) : tr("子代理还在后台跑，pi 会在它回来时接着做"),
      pending: false,
    };
  }
  if (s.done) return { kind: "done", text: tr("完成"), cls: "done", title: "", pending: false };
  return null;
}

function bgElapsedText(since: number, until = Date.now()): string {
  const secs = Math.max(0, Math.round((until - since) / 1000));
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, "0");
  // 跑过一小时的子代理很少，但真跑到了也不能显示成 90:04。
  const clock = m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
  return tr("已跑 {p1}", { p1: clock });
}

/** 跑完之后的同一个钟：报「一共跑了多久」，而不是「结束至今」（D170 评审）。 */
function bgTookText(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, "0");
  const clock = m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
  return tr("用了 {p1}", { p1: clock });
}

export class App {
  private socket = new Socket();
  private me: Me;
  private sessions: SessionState[] = [];
  private tunnel: TunnelState;
  private currentId: string | null = null;
  private session: SessionState | null = null;
  private approvals: ApprovalRequest[] = [];
  /** Questions from the model waiting for an answer (PLAN-ask.md). */
  private asks: AskRequest[] = [];
  /**
   * 本地队列是不是这一轮订阅的快照填的（D156）。`openSession` 先清空 `approvals` / `asks` 再
   * subscribe，快照回来之前本地那两份是「过期的空」，徽标得退回列表里的计数。
   */
  private pendingFresh = false;
  /** Question ids this page has already put on screen, so a re-subscribe does not re-open them. */
  /** Per-ask progress in the composer panel (active tab + drafts), kept across re-renders. */
  private askDrafts = new Map<string, { active: number; drafts: Map<string, AskAnswer> }>();
  /**
   * A questionnaire that died before it was answered (tool call aborted, turn interrupted, session
   * released…). The panel is gone, but whatever was filled in is kept — see askLostBlock().
   */
  private askLost: { id: string; title: string; reason: string; lines: string[] } | null = null;
  /** The ask id this page submitted itself: its ask.remove is not a loss. */
  private lastAnsweredAsk: string | null = null;
  private askFolded = false;
  private connected = false;
  private tab: Tab = "sessions";
  private chat!: ChatView;
  private pending: (() => void)[] = [];
  /** Local-clock end of the step-up window; 0 = must verify before the next write (public only). */
  private stepUntil = 0;
  /** The bridge refused a write for lack of step-up: re-sync the view once the user verifies. */
  private stepResync = false;
  private composerText = "";
  private images: PendingImage[] = [];
  /** Long pastes kept apart from the typed text; joined in front of it on send. */
  private pastes: PasteBlock[] = [];
  private pasteHost: HTMLElement | null = null;
  /** Unsent composer text + images per session, so switching sessions never carries a draft over. */
  private drafts = loadDrafts();
  /** "+N 图" 徽标：点开是待发图片管理页。 */
  private imageBadge: HTMLButtonElement | null = null;
  /** 待发图片弹窗的重绘钩子（删掉/新贴一张后刷新缩略图）。 */
  private imageSheetPaint: (() => void) | null = null;

  private els: Record<string, HTMLElement> = {};
  /** #86：随手问。它的帧不走当前会话那条路，自己认领；模型目录也是现成的。 */
  private readonly scratch = new ScratchChat({ send: (msg) => this.socket.send(msg), models: () => this.models });
  private models: ModelInfo[] = [];
  /** D150：目录是两段式（快的先到、带扩展的补上），所以记住最近一次失败原因与「什么时候问过」。 */
  private modelsError = "";
  private modelsAsked = 0;
  /** D95：记录面板（🐞 bug）打开时的那一份；关掉就置 null。 */
  private notesSheet: NotesSheet | null = null;
  /** D164：AI 出错记录的账本（按工作区），以及这个会话里见过的失败（按 toolCallId 去重）。 */
  private failLedger: FailLedger | null = null;
  private failWs = "";
  private sessionFails = new Map<string, SeenFail>();
  /** 这个会话里已经叫住过的失败类别（keys）：同会话同一类只叫一次（桥那边还有一层节流）。 */
  private failReminded = new Set<string>();
  /** 已发出、还没等到桥回执的 key：回执失败就释放，否则桥丢掉一条会让这一类永久静音。 */
  private failRemindPending = new Set<string>();
  /** 右下角那颗「⚡ 总结本轮错误」；每轮结束按 pending 亮灭。 */
  private failCta: HTMLButtonElement | null = null;
  /** 点开 CTA 的那张小卡（两个举动：记进账本 / 发到会话复盘）。 */
  private failMenu: HTMLElement | null = null;
  private failMenuAway: ((ev: Event) => void) | null = null;
  private failMenuEsc: ((ev: KeyboardEvent) => void) | null = null;
  /** 账本边上的「规矩」，与 `failLedger` 一起随 ws 走。 */
  private failRules: RuleBook | null = null;
  private failRulesWs = "";
  /** 「发到会话复盘」在途：回包之前不能再点 —— 一下就是一轮 token。 */
  private failReviewPending = false;
  private failToast: HTMLElement | null = null;
  private failToastTimer = 0;
  private notes: Note[] = [];
  /** 新会话建好后要填进输入框的文字（「交给 agent → 新开会话」，不自动发送）。
   *  它只属于「我自己刚建的那个会话」：面板一关（取消 / 点背景）或建会话失败就丢掉，
   *  否则下一次打开的任何会话都会莫名其妙带上上一个会话的笔记。 */
  private prefillNext: string | null = null;
  private sheet: HTMLElement | null = null;
  private modelChip: HTMLButtonElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  /** 「继续」按钮（D159）：住在权限按钮正上方那 28.5px 里。每次重画 composer 都换一颗新的。 */
  private continueBtn: HTMLButtonElement | null = null;
  /** D170: 输入框上方那条「子代理运行中」。`syncBgBar()` 造它，重画后要重新挂。 */
  private bgBar: HTMLElement | null = null;
  /** D170 详情弹层：正在看的那一屏，和它 1.5 秒一次的轮询。关掉就 null。 */
  private bgSheet: { sessionId: string; body: HTMLElement; runs: Map<string, BgRunNode> } | null = null;
  private bgTimer: number | null = null;
  /** 上一次点「继续」的会话与时刻（D159）：`pi.status` 回来之前按钮还亮着，连点会排两条。 */
  private continueAt: { id: string; at: number } = { id: "", at: 0 };
  /** Skill palette state (the popover above the composer). */
  private skills: SkillInfo[] = [];
  private skillsAt = 0;
  private skillPop: HTMLElement | null = null;
  /** Document-level "clicked outside" listener while the palette is open (removed on close). */
  private skillAway: ((ev: Event) => void) | null = null;
  private skillQuery = "";
  private skillSel = 0;
  /** Desktop only: hide the session column / the queue column to give the chat more room. */
  private collapsed: { sessions: boolean; queue: boolean } = {
    sessions: readFlag("pi.collapse.sessions"),
    queue: readFlag("pi.collapse.queue"),
  };
  /** Appearance prefs (scale / accent / text lightness), persisted in localStorage. */
  private prefs: Prefs = readPrefs();
  private sheetKind: "model" | "display" | "new" | "manage" | "keys" | "tree" | "settings" | "share" | "ext" | "skillstore" | "peer" | "intro" | "bg" | null = null;
  /** The new-session dialog stays up until the bridge answers with the started session (or an error). */
  private creating: { finish: (error?: string) => void } | null = null;
  /** 新建文件夹 / 新建文件共用一个等待表：两条结果的形状一样（`{ path }` / `{ error }`，D167）。 */
  private mkWaits = new Map<string, (res: { path?: string; error?: string }) => void>();
  /** Session whose claim is in flight: spawning pi takes a few seconds. */
  private claiming: string | null = null;
  private usage: { contextTokens: number | null; contextWindow: number | null } = { contextTokens: null, contextWindow: null };
  /** Context budget chosen in the model sheet (bridge enforces it); null = window size. */
  private budget: number | null = null;
  /** Extension status lines / widgets / title for the current session (#18). */
  private ext: ExtUi = { status: [], widgets: [], title: null };
  private extAbove: HTMLElement | null = null;
  private extBelow: HTMLElement | null = null;
  /** #25 inline completion: `/command` at the start, `@path` anywhere. */
  private complete: {
    mode: "cmd" | "file";
    start: number;
    end: number;
    query: string;
    items: CommandItem[];
    sel: number;
    node: HTMLElement;
  } | null = null;
  /** pi's commands for the current session (get_commands), for the `/` menu. */
  private piCommands: { sessionId: string; at: number; list: { name: string; description: string; source: string }[] } | null = null;
  private fileQuerySeq = 0;
  /** A fork / clone is being done by pi (a throwaway child takes a second or two). */
  private branching = false;
  /** #21: trust state of the current session's folder (from the session snapshot). */
  private trust: TrustState | null = null;
  /** #26: last settings read per scope, and which tab the settings sheet shows. */
  private settingsView: { global?: SettingsView; project?: SettingsView } = {};
  private settingsTab: SettingsTab = "global";
  /**
   * D161: 设置面板底部那块「把现有会话也改掉」。`permDefaultsFor` 是已经问过桥的 cwd key
   * （空串 = 全局页），这样重绘不会一直重问同一个问题。
   */
  private permDefaults: { cwd: string | null; mode: string; source: string; path: string | null; total: number } | null = null;
  private permDefaultsFor: string | null = null;
  /** `#89` 口令页：桥报的那一份快照（null = 还没读到，或刚被别的页面改掉而作废）。 */
  private passphraseView: PassphraseView | null = null;
  /** 明文只写在 `••••••••` 和真值之间切，拷走值仍要过 `passphrase.get` 那道门。 */
  private passphraseShown = false;
  /** 输入框里的草稿；重画（回执、广播）不能把它抹掉。 */
  private passphraseDraft = "";
  /** 「随机生成一个」刚给的候选值（同一个字符串也在草稿里），用来让人先看清再保存。 */
  private passphraseFresh: string | null = null;
  /** D120 / #77：`runtime.stats` 的最后一帧；null = 还没问过（「读取中…」）。 */
  private runtimeStats: RuntimeStats | null = null;
  /** D120 / #80：「全部休眠」的最后一次回执（null = 这次打开面板还没按过）。 */
  private sleepAllReceipt: SleepAllReceipt | null = null;
  /** #27 the 登录 tab: providers as pi sees them, a filter, and the login running right now. */
  private authProviders: AuthProvider[] | null = null;
  /** #30: is the terminal session-lock extension in pi's global extensions? */
  private lockExt: { installed: boolean; path: string } | null = null;
  /** #33 扩展与 MCP: package rows, MCP servers, and the console of the last pi command. */
  /** D81 扩展 manager state. */
  private uiPrefs: { showExtButton: boolean } = { showExtButton: true };
  private extUpdates = 0;
  private extTab: "installed" | "ext" | "mcp" = "installed";
  private extInv: ExtInventory | null = null;
  private extInvLoading = false;
  /** D113: a 「联网检查更新」 request is in flight (drives the spinner and the 「检查中…」 tags). */
  private extCheckLoading = false;
  /** An inventory was asked for while one was still streaming; re-ask when it lands. */
  private extReloadPending = false;
  private extStore: { query: string; limit: number; items: StorePkg[] | null; error?: string } = { query: "", limit: 20, items: null };
  private mcpStore: { query: string; limit: number; items: StoreMcpItem[] | null; error?: string; building?: boolean; starsComplete?: boolean; hasToken?: boolean; truncated?: boolean } = { query: "", limit: 20, items: null };
  private extScope: "global" | "project" = "global";
  private extArm: { key: string; until: number } | null = null;
  private extDirty = false;
  private mcpForm: { name: string; option: number; values: Record<string, string>; exposure: string; description: string; local: boolean; item: string } | null = null;
  private extVars: string[] = [];
  private extButton: HTMLButtonElement | null = null;
  private cliRun: { runId: string | null; op: string; out: string; code: number | null | undefined; error?: string } | null = null;
  /**
   * D113: the writes this page started and has not seen finish, keyed by the `reqId` it sent. Each one
   * names the row it belongs to, so only that row's buttons wait — clicks on other rows queue up.
   */
  private cliOps = new Map<string, { key: string; op: string; state: "queued" | "running" }>();
  /** D126 技能商店: the search tab, the 已安装 list, the 「按地址」 box, and the ops in flight. */
  private skillTab: "store" | "installed" = "store";
  private skillStore: { query: string; limit: number; items: SkillStoreItem[] | null; error?: string; note?: string } = { query: "", limit: 20, items: null };
  private skillInv: InstalledSkill[] | null = null;
  private skillInvError: string | null = null;
  private skillScope: "global" | "project" = "global";
  private skillSource: { input: string; label: string; kind: "repo" | "local" | null; items: SkillSourceItem[] | null; loading: boolean; open: boolean; error?: string } = { input: "", label: "", kind: null, items: null, loading: false, open: false };
  private skillOps = new Map<string, { key: string; running: string }>();
  private skillArm: { key: string; until: number } | null = null;
  private skillDirty = false;
  private skillNote: { text: string; bad: boolean } | null = null;
  /** #49 pi 本体：the version check's answer, the last self-update's outcome, and whether a check is in flight. */
  private piUpd: { latest: string | null; source?: string; checkedAt: number; update: boolean; error?: string } | null = null;
  private piChecking = false;
  private piUpdRun: "running" | "ok" | "fail" | null = null;
  private authFilter = "";
  private login: { loginId: string | null; provider: string; method: string; events: AuthEventView[]; prompt: { promptId: string; prompt: AuthPromptView } | null; result: string | null; ok: boolean } | null = null;
  private afterOpen: { id: string; text: string } | null = null;
  /** Shells the bridge can open (term.list), for the ＋ menu (#23). */
  private termShells: { id: string; label: string }[] = [];
  /** pi's queue for the current session (queue_update), shown above the editor (#14). */
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  private queueBar: HTMLElement | null = null;
  /** Cumulative numbers from get_session_stats, for the 会话 section of the model sheet (#15). */
  private stats: { tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null; cost: number | null } = {
    tokens: null,
    cost: null,
  };
  private rate = 0;
  private turnAt: number | null = null;
  /** What pi is doing right now, for the status line under the composer ("" = just running). */
  private activity = "";
  private runSince: number | null = null;
  /** Q-029: the hover card opens only after a deliberate hover, then stays until a click outside. */
  private peekTimer = 0;      // 3 秒之后转成「驻留」
  private peekGrace = 0;      // 离开状态的宽限期（卡片与状态行之间有 8px 空隙）
  private peekOpen = false;
  private peekSticky = false; // 停留够 3 秒：鼠标离开也不再关
  private peekWired = false;  // document 上的点击/键盘监听只挂一次
  private hintStatus: HTMLElement | null = null;
  /** 左栏收起时补在状态行最前面的路径（和分支 chip 并排），只在那种状态下显示（见 syncCwdChip）。 */
  private cwdChip: HTMLElement | null = null;
  private turnChars = { cjk: 0, other: 0 };
  private rateAt = 0;
  /** Sidebar rename: which card is an input, its draft, and whether to select the text. */
  private renameId: string | null = null;
  private renameDraft = "";
  private renameFocus = false;
  private renameCaret: number | null = null;
  /** #100 组头就地改名：跟会话卡片的 rename 同一套手感（同一支输入框、同一个提交时机）。 */
  private wsRenameId: string | null = null;
  private wsRenameDraft = "";
  private wsRenameFocus = false;
  private wsRenameCaret: number | null = null;
  /** 组头的 ⋯ 菜单最多一张；树重画前先关掉它（锚点要被换掉）。 */
  private wsMenu: WsMenuHandle | null = null;
  /** 点了「新建工作区」：等桥把新组广播回来，就立刻进改名态（组的 id 只有桥知道）。 */
  private wsCreatePending = false;
  /** #175：这一下新建是从横条那颗 ＋ 点的（建完若落在 ＋N 里要说一声）。 */
  private wsCreateFromTabs = false;
  /** #175：刚从横条 ＋ 建出来的组，下一次画横条时核一眼它在不在 ＋N 里（画完清掉）。 */
  private wsNewNoteId: string | null = null;
  /** #123 设置面板的「标签行」那块（名额步进器）；快照回来时只重画这一个小面。 */
  private wsPane: HTMLElement | null = null;
  /** Sidebar arrangement owned by the user: pin / manual order / archive (D46). */
  private manage: ManageState = { pin: [], order: [], archived: [] };
  private archivedOpen = false;
  private filter = "";
  /** Delete is two-step: the last click arms it, the next one within 4s sends it. */
  private mgr: MgrView = loadMgrView();
  private mgrPicked = new Set<string>();
  private mgrCollapsed = new Set<string>(loadCollapsedGroups());
  private mgrRename: { id: string; draft: string } | null = null;
  private mgrDelArm: { key: string; at: number } | null = null;
  /** Which half of the manager sheet is showing: the session list or the bin. */
  private mgrView: "list" | "trash" = "list";
  private mgrTrashPick = new Set<string>();
  /** The bin, as the bridge last reported it. Nothing here is visible in the session list. */
  private trash: TrashItem[] = [];
  /** action id → key combo (“ctrl+shift+k”); only what the user set in 快捷键 lives here. */
  private keys: Record<string, string> = { ...DEFAULT_KEYS, ...loadKeys() };
  /** action id whose row is waiting for the next key press. */
  private capturing: string | null = null;
  /** D70: one shell per tab, all inside one dock; the bridge owns the processes (max 4). */
  private termDock: HTMLElement | null = null;
  /** D166: 表格浮窗与终端并列，不进 viewer 面板；同一时间只开一扇。 */
  private sheetDock: SheetDialog | null = null;
  private termTabStrip: HTMLElement | null = null;
  private termBodies: HTMLElement | null = null;
  private termTabs = new Map<string, TermTab>();
  private termActive: string | null = null;
  /** D92: the dialog is on screen (not minimized). The shells themselves live in the bridge. */
  private termOpen = false;
  /** D111: 两扇浮窗里最后被点 / 聚焦的那扇（`.front`）；同一时间只有一扇。 */
  private winFront: HTMLElement | null = null;
  /** D93: dialog 的位置 / 大小（布局 px），null = 还没读过 localStorage。 */
  private termGeom: TermGeom | null = null;
  /** D92: 什么时候发出的 `term.open`（0 = 没有在飞），shell 到了 / 报错 / 超时都会清掉它。 */
  private termWantAt = 0;
  /** Outcome of the last delete, shown above the manager's footer (the transcript is behind the sheet). */
  private mgrNote = "";
  /** Tool calls seen in the current turn, for the activity popover. */
  private stepCount = 0;
  /** #93: 横栏里那三样（胶囊 / 「＋N」 / 浮层）是共用组件，这里只留外壳 —— 它自己管焦点。 */
  private pillBar!: PillBar<SessionState>;
  /**
   * #189：上一次画出来的 ★ 行（从左到右的 id）。manage 回声到达时那颗会话已经不在行里了，
   * 「右邻」只能按归档前这一份算；窄屏与壳 B/C/D 不画这一行，顺序照样记。
   */
  private rowIds: string[] = [];
  /** #94 工作区快照：桥是唯一的推导者，前端只读。 */
  private workspaces: WorkspaceState = { groups: [], overrides: {}, keys: {} };
  /** #101 迁移预览：这张页面已经弹过 / 关过一次就不再弹（取消 = 下次打开还弹，确认才写 prefs）。 */
  private wsIntroShown = false;
  /** #96 顶栏那颗「当前在哪」：组件只认挂载点，换布局时换位置而不是换组件。 */
  private nowChip!: NowChip;
  /** #98 那颗的挂载点：A 在行 2，B/C/D 在顶栏。包一层按钮，只有后三套拿它当入口。 */
  private nowSlotRow: HTMLElement | null = null;
  private nowSlotTop: HTMLElement | null = null;
  private nowBtn: HTMLButtonElement | null = null;
  /** #98 C 的竖列 / D 收起时的色点条（两块同一份 `railModel()`，只是尺寸不同）。 */
  private rail: HTMLElement | null = null;
  private strip: HTMLElement | null = null;
  /** #98 B 的工作区浮层：一次只开一张，关掉时连监听一起摘。 */
  private wsPop: HTMLElement | null = null;
  private wsPopBody: HTMLElement | null = null;
  private wsPopCleanup: (() => void) | null = null;
  /**
   * #121 标签行 `＋N` 的下拉。浮层的开关归自己管（不借胶囊条那颗 `＋N` 的 `closeMore()`）：
   * 两处都能数「还有几个」，各开各的，关一个不该顺手关掉另一个。
   */
  private tabsMore: { close(): void } | null = null;
  /**
   * #174 刚才那一拖是否真的挪了位置。`click` 紧跟在 `pointerup` 后面，不给个标记的话松手会被
   * 当成一次点击，把组切到刚拖走的那颗上。
   */
  private tabDragMoved = false;
  /** #126：行 2 胶囊刚被拖过 —— 紧跟着的 click 不能当成「打开会话」。 */
  private pinDragMoved = false;
  /**
   * #99 / #98：拖拽的落点容器。默认是左栏那棵树；工作区浮层开着时换成浮层 —— 落点判定
   * (`hitTest`) 与落点线是同一份，换的只是「量哪一块 DOM」。
   */
  private dragScope: { el: HTMLElement; group: string; head: string; item: string } | null = null;
  /** Q-035: the hover bubble on a pin chip (归档 / 重命名 / 删除), only ever one at a time. */
  private pinMenu: { handle: PinMenuHandle; chip: HTMLElement; id: string } | null = null;
  /** Both the 180ms open delay and the 220ms close delay ride on this one timer. */
  private pinMenuTimer = 0;
  /** Id of the chip currently animating out — the strip must not repaint underneath it. */
  private pinAnim: string | null = null;
  /** Q-035: the pin chip's delete flight lands here — the same bin the manager sheet toggles. */
  private binBtn: HTMLButtonElement | null = null;
  /** Q-021: branch of the repo holding the session cwd; `gitCwd` keeps a stale answer off the line. */
  private git: GitInfo | null = null;
  private gitCwd = "";
  private mgrRefresh: (() => void) | null = null;
  private mgrPainting = false;
  private viewer: Viewer | null = null;
  /** 预览历史，按会话分开（D63）：关预览保留、刷新页面清空、切会话各自一份。 */
  private vhist = new Map<string, { steps: VStep[]; at: number }>();
  private cardDelArm: { id: string; at: number } | null = null;
  private dragId: string | null = null;
  /** #99：那条 2px 落点线 + 拖动时才出现的「放回工程」落点，以及拖动期间挂上的 Esc / blur 监听。 */
  private dropLine: HTMLElement | null = null;
  private dragPool: HTMLElement | null = null;
  private dragCleanup: (() => void) | null = null;
  /** #102 键盘等价的焦点跟随：Alt+方向键 / 折叠组之后，重画完把焦点还给那张卡 / 那个组头。
   *  pending 带消费预算（见 `focusfollow.ts`）：一次键盘动作连来的几条重画各还一次，预算见底即清，
   *  之后的普通重画（改名、收推送…）不再抢焦点。 */
  private pendingFocus: PendingFocusState = { card: null, ws: null };

  constructor(me: Me) {
    this.me = me;
    this.tunnel = me.tunnel;
    applyLang(this.prefs.lang);
    this.applyPrefs();
    this.loadAskDrafts();
    this.build();
    this.wire();
    // A pending question card in the transcript jumps to the composer panel; the card itself has
    // no reference to the app and must not gain one.
    window.addEventListener("pi-ask-open", () => this.focusAsk());
    window.addEventListener("pagehide", () => this.noteDraft());
    window.addEventListener("pi-preview", (ev) => {
      const path = (ev as CustomEvent<{ path?: string }>).detail?.path;
      if (path) void this.openPreview(path);
    });
    this.startClock();
    this.socket.connect();
    this.routeFromHash();
  }

  /**
   * 顶栏那几颗「图标 + 文字」的按钮。窄屏上六个宽按钮写不下（「📁 文件管理器」一颗就 90px，
   * 390px 的手机加上「产物」就溢出），所以图标与文字分开包：`@media (max-width: 620px)` 只把
   * `.lb` 收掉，按钮回成 28px 方块，文字还在 title / aria-label 里。
   * 切分用的是 `tr()` 之后的文案（形如「📂 产物」，第一个空格前是图标），所以不必再为窄屏添一套 key。
   */
  private wideBtn(label: string, extra = ""): HTMLButtonElement {
    const b = el("button", `icon-btn wide ${extra}`.trim()) as HTMLButtonElement;
    this.setWideLabel(b, label);
    return b;
  }

  /** 同一颗宽按钮的字会换（终端跑起来之后是「>_ 终端 2」），所以拆开这件事得能重做一遍。 */
  private setWideLabel(btn: HTMLElement, label: string): void {
    const cut = label.indexOf(" ");
    btn.replaceChildren(el("span", "ic", cut > 0 ? label.slice(0, cut) : label));
    if (cut > 0) btn.append(el("span", "lb", label.slice(cut + 1)));
  }

  // ---------------------------------------------------------------- layout
  private build(): void {
    const app = document.getElementById("app")!;
    app.replaceChildren();

    const shell = el("div", "app");
    const topbar = el("header", "topbar");
    const collapseLeft = el("button", "icon-btn side-toggle");
    collapseLeft.dataset.side = "left";
    collapseLeft.dataset.act = "sessions";
    collapseLeft.onclick = () => this.togglePane("sessions");
    const dot = el("span", "dot");
    // #98：当前会话那颗在 B/C/D 里挂在顶栏（brand 之后）。空槽 `display: contents`，A 里等于不存在。
    const nowSlotTop = el("div", "now-chip-slot now-chip-top");
    const title = el("div", "title", "pi");
    const sub = el("div", "sub", "");
    const collapseRight = el("button", "icon-btn side-toggle");
    collapseRight.dataset.side = "right";
    collapseRight.dataset.act = "queue";
    collapseRight.onclick = () => this.togglePane("queue");
    const look = el("button", "icon-btn icon-text", "Aa");
    look.title = tr("字号与颜色");
    look.dataset.act = "look";
    look.onclick = () => this.openDisplaySheet();
    const files = this.wideBtn(tr("📂 产物"));
    files.title = tr("本会话写过的文件（md / html / 图片…点开预览）");
    files.dataset.act = "artifacts";
    files.onclick = () => this.openArtifactsSheet();
    files.hidden = true;
    // D92: the shell sits next to 产物 now — it is a dialog over the page, and this button is both
    // its opener and the place it minimizes back to. Not session-scoped, so it never hides.
    const term = this.wideBtn(tr(">_ 终端"));
    term.dataset.act = "terminal";
    term.setAttribute("aria-label", tr("终端"));
    term.title = tr("在这台电脑上开一个真的 shell（本机 / 局域网可用，公网隧道下禁用）");
    term.onclick = () => this.openTerminal();
    this.els.term = term;
    const fs = this.wideBtn(tr("📁 文件管理器"));
    fs.title = tr("文件资源管理器：浏览这台电脑的盘符与目录，打开或直接编辑文本文件");
    fs.dataset.act = "files";
    fs.onclick = () => this.openFiles();
    fs.hidden = true;
    this.els.fs = fs;
    // D108：记录不跟会话绑定，所以它跟终端一样常显；计数只在 title 里。
    const notes = this.wideBtn("🐞 bug", "notes-btn");
    notes.title = tr("记录 bug / 变更 / 想法 / 杂事");
    notes.dataset.act = "notes";
    notes.onclick = () => this.openNotes();
    this.els.notes = notes;
    // #45: the peer is a dialog over the page, not a separate tab — same as 终端.
    const peer = this.wideBtn(tr("🌐 内网通"));
    peer.title = tr("内网通：发现同一内网里的人，直接对话、传文件");
    peer.dataset.act = "peer";
    peer.onclick = () => this.openPeerSheet();
    // 之前没登记进 els，`paintChrome()` 里那段 `if (peer)` 一直是死代码：切语言时这颗不动。
    this.els.peer = peer;
    // #86：随手问也不跟会话绑定（它不进列表），所以跟终端 / 记录一样常显。
    const scratch = this.wideBtn(tr("💭 随手问"));
    scratch.title = tr("随手问：不进会话列表、不带上下文、不改本机的一个 dialog");
    scratch.dataset.act = "scratch";
    scratch.onclick = () => this.scratch.open();
    this.els.scratch = scratch;
    // #96：「当前在哪」那颗自己是一个挂载点，不绑死在 topbar 的结构里（#97 / #98 换布局时
    // 只要把它挪到别处）。A 里它在行 2 的最左，B/C/D 里挪进顶栏（见 `paintShell()`）。
    topbar.append(collapseLeft, dot, nowSlotTop, title, sub, files, term, fs, notes, peer, scratch, look, collapseRight);
    const main = el("div", "main");

    const sessionsPane = el("section", "pane");
    const sessionsInner = el("div", "session-list");
    const create = el("div", "new-session");
    const newBtn = el("button", "btn primary", tr("开新会话"));
    newBtn.dataset.act = "new";
    newBtn.onclick = () => this.openNewSessionSheet();
    create.append(newBtn);
    // The filter must not lose focus on every keystroke, so it lives outside the repainted list.
    const manageBar = el("div", "manage-bar");
    const sessFilter = el("input", "session-filter");
    sessFilter.placeholder = tr("过滤名字 / 目录");
    sessFilter.oninput = () => {
      this.filter = sessFilter.value.trim();
      this.renderSessions();
    };
    const manageBtn = el("button", "tool-btn", tr("管理"));
    manageBtn.dataset.act = "manage";
    manageBtn.title = tr("管理全部会话：检索、筛选、排序、分组、批量操作");
    manageBtn.onclick = () => this.openManager();
    // Q-035: the pin chip's delete animation needs a bin on screen to fly into. Until now the trash
    // was two clicks away (管理 → 🗑); this opens the same view in one.
    const binBtn = el("button", "tool-btn bin-btn") as HTMLButtonElement;
    binBtn.dataset.act = "trash";
    // 文字而不是 🗑：这颗按钮只有 31px 高、左栏又窄，emoji 在这个尺寸下会糊成一小块，
    // 而它是删除动效的落点，得让人一眼认出那是「垃圾箱」。
    binBtn.append(el("span", "bin-label", tr("垃圾箱")));
    binBtn.onclick = () => this.openManager("trash");
    manageBar.append(sessFilter, binBtn, manageBtn);
    const sessList = el("div", "session-cards");
    sessionsInner.append(create, manageBar, sessList);
    sessionsPane.append(sessionsInner);

    const chatPane = el("section", "pane chat-pane");
    const scroll = el("div", "pane chat-scroll");
    const composerHost = el("div", "composer");
    chatPane.append(scroll, composerHost);

    const queuePane = el("section", "pane");
    const queueInner = el("div", "queue");
    queuePane.append(queueInner);

    // Dividers live in `main` (absolutely positioned), not inside the panes: those scroll.
    const gripL = el("div", "col-grip grip-l");
    gripL.title = tr("拖动调整会话列表宽度 · 双击复位");
    const gripR = el("div", "col-grip grip-r");
    gripR.title = tr("拖动调整右栏宽度 · 双击复位");

    main.append(sessionsPane, chatPane, queuePane, gripL, gripR);

    // #97 壳 A 两行制。行 1：工作区标签页（点一下切到那一组）；行 2：当前会话那颗（nowchip，
    // 固定最左）+ 本区 ★ 会话胶囊（#120：只画点过 ★ 的）+ ＋。原先「收起左栏才出现」的置顶横栏
    // 被行 2 取代 —— 不再另挂一条，两套横栏同时出现只会让人不知道该点哪一条。
    const wsTabsRow = el("div", "ws-tabs-row");
    const wsTabs = el("div", "ws-tabs");
    // #121：`＋N` 挂在标签槽**外面** —— 槽自己是 `overflow-x: auto`，摆进去会跟着横滚跑掉。
    const wsTabsMore = el("button", "ws-tabs-more") as HTMLButtonElement;
    wsTabsMore.type = "button";
    wsTabsMore.hidden = true;
    // #175：新建工作区也搬一颗到横条末尾 —— 建完就地改名，不用先滚回左栏树底。
    const wsTabsAdd = el("button", "ws-tabs-add") as HTMLButtonElement;
    wsTabsAdd.type = "button";
    wsTabsAdd.hidden = true;
    wsTabsAdd.textContent = tr("＋");
    wsTabsAdd.title = tr("新建工作区");
    wsTabsAdd.setAttribute("aria-label", tr("新建工作区"));
    wsTabsAdd.onclick = () => this.createWsFromTabs();
    wsTabsRow.append(wsTabs, wsTabsAdd, wsTabsMore);
    wsTabsRow.hidden = true;
    const sessionRow = el("div", "ws-session-row");
    const nowSlotRow = el("div", "now-chip-slot");
    const pinStrip = el("div", "pin-strip");
    sessionRow.append(nowSlotRow, pinStrip);

    // #98：竖列（C）与收起时的色点条（D）挂在 `main` 外面这条 flex 上 —— `main` 自己的三列网格
    // （连 no-left / no-right 四种组合）一格都不动，两套壳只是在这条 flex 里多一列。
    const mainWrap = el("div", "main-wrap");
    const rail = el("div", "ws-rail");
    rail.hidden = true;
    const strip = el("div", "ws-strip");
    strip.hidden = true;
    mainWrap.append(rail, strip, main);

    const tabs = el("nav", "tabs");
    const tabDefs: [Tab, string][] = [
      ["sessions", tr("会话")],
      ["chat", tr("对话")],
      ["queue", tr("需要你")],
    ];
    for (const [key, label] of tabDefs) {
      const btn = el("button", "", label);
      btn.dataset.tab = key;
      btn.onclick = () => this.go(key);
      tabs.append(btn);
    }

    shell.append(topbar, wsTabsRow, sessionRow, mainWrap, tabs);
    app.append(shell);

    Object.assign(this.els, { topbar, wsTabsRow, wsTabs, wsTabsAdd, wsTabsMore, sessionRow, pinStrip, collapseLeft, collapseRight, look, files, term, fs, dot, title, sub, main, sessionsPane, sessionsInner, manageBar, sessFilter, manageBtn, binBtn, newBtn, sessList, chatPane, scroll, composerHost, queuePane, queueInner, tabs });
    this.binBtn = binBtn;
    // #93：左栏收起时那条横栏里的三样东西（胶囊 /「＋N」/ 折起来那张列表）现在是一个共用组件：
    // 外壳只交数据与回调，组件自己管排布、★ 点完的焦点归还与浮层。
    this.pillBar = new PillBar<SessionState>(pinStrip, {
      // D170：钉条胶囊里那行小字就是徽标本身；「后台」那枚也让它点得开（胶囊其余部分仍是打开会话）。
      badge: (s) => {
        const b = this.badgeOf(s);
        return b ? { ...b, detail: b.kind === "bg" } : null;
      },
      onBadge: (id) => this.openBgSheet(id),
      time: relativeTime,
      // #97：第二行不再是「置顶区」，条头那颗字也就没有意义了 —— 最左边那颗就是当前会话。
      // 空字符串仍然会留一个空 span，CSS 里 `.pin-strip-label:empty` 把它收掉。
      heading: () => "",
      onOpen: (id) => this.openFromList(id),
      onStar: (id) => this.togglePin(id),
      tail: () => {
        // Q-013: with the left pane hidden this is the only visible way to start a session.
        // Q-022: 从这颗 ＋ 建的会话自动置顶，否则建完在这条里根本看不见。
        const add = el("button", "pin-chip pin-new", tr("＋"));
        add.title = tr("开新会话（自动置顶到这条里）");
        add.dataset.act = "new";
        add.dataset.pinKey = "new";
        add.onclick = () => this.openNewSessionSheet(true);
        // 同一动作不要两颗按钮：顶栏左上角那颗就能展开左栏，行 2 右端不再摆第二颗。
        return [add];
      },
      decorate: (chip, s) => {
        this.wirePinHover(chip, s);
        this.wirePinDrag(chip, s.id);
      },
    });
    this.nowChip = new NowChip(nowSlotRow);
    // #98：那颗在 B/C/D 里是按钮（点开工作区浮层）。包一层 `<button>` 而不是给组件加第二副身份 ——
    // `NowChip` 的 aria-label / title 原样留着，读屏听到的还是「哪个工作区里的哪个会话」。
    const nowBtn = el("button", "now-btn") as HTMLButtonElement;
    nowBtn.type = "button";
    nowBtn.dataset.act = "where";
    nowBtn.onclick = () => this.onWhereClick();
    nowBtn.append(this.nowChip.el);
    nowSlotRow.append(nowBtn);
    this.nowSlotRow = nowSlotRow;
    this.nowSlotTop = nowSlotTop;
    this.nowBtn = nowBtn;
    this.rail = rail;
    this.strip = strip;
    this.els.rail = rail;
    this.els.strip = strip;
    // 设置面板可能在 build 之前就问过布局（applyPrefs 在构造里先跑一次），这里再画一次 DOM 标记，
    // 保证首屏 `data-layout` 与真实渲染一致。
    this.paintLayout();
    // 顶栏这批按钮只构造一次，语言一切换就得靠 paintChrome() 重写文字（renderAll 碰不到它们）。
    this.paintChrome();
    this.chat = new ChatView(scroll);
    this.chat.onBashStop = () => this.act(() => this.socket.send({ type: "abortBash", sessionId: this.currentId }));
    this.chat.onFork = (item, index) => this.forkAt({ entryId: item.id, index, text: item.text });
    // 账本要的是「这次会话里所有失败」，聊天区只画本轮的红卡：两边各收各的，按 toolCallId 去重。
    this.chat.onFail = (f) => this.recordFail(f);
    // 复盘那一轮的回写（D164 延伸）：模型把规矩写在回答末尾，这里捡出来交给桥。
    this.chat.onAnswer = (text) => this.takeRules(text);
    this.wireGrip(gripL, "sessions");
    this.wireGrip(gripR, "queue");
  }

  /**
   * Drag the divider between a side column and the chat. Same shape as the viewer's grip: capture the
   * pointer, write a CSS variable live, remember the width afterwards; double-click forgets it.
   */
  private wireGrip(grip: HTMLElement, side: "sessions" | "queue"): void {
    const key = side === "sessions" ? "pi.sessionsW" : "pi.queueW";
    const cssVar = side === "sessions" ? "--sessions-w" : "--queue-w";
    const min = side === "sessions" ? 200 : 220;
    const max = side === "sessions" ? 520 : 600;
    const host = this.els.main;
    const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)));
    const width = () => {
      const v = parseInt(host.style.getPropertyValue(cssVar), 10);
      return Number.isFinite(v) && v > 0 ? v : side === "sessions" ? 280 : 300;
    };
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) host.style.setProperty(cssVar, `${clamp(saved)}px`);
    } catch {
      // private mode: just start from the default width
    }
    grip.onpointerdown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const r = host.getBoundingClientRect();
      grip.setPointerCapture(ev.pointerId);
      grip.classList.add("dragging");
      document.body.classList.add("col-resizing");
      const move = (e: PointerEvent) => {
        host.style.setProperty(cssVar, `${clamp(side === "sessions" ? e.clientX - r.left : r.right - e.clientX)}px`);
      };
      const done = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
        grip.classList.remove("dragging");
        document.body.classList.remove("col-resizing");
        try {
          localStorage.setItem(key, String(width()));
        } catch {
          // the drag still works for this visit
        }
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    };
    grip.ondblclick = () => {
      host.style.removeProperty(cssVar);
      try {
        localStorage.removeItem(key);
      } catch {
        // nothing to forget
      }
    };
  }

  // ---------------------------------------------------------------- terminal geometry (D92 · D93)
  /**
   * 视觉尺寸 ↔ 布局 px 的换算系数。`#app` 上挂着 `zoom: var(--ui-scale)`，所以在它里面写进 style 的
   * px（以及 CSS 里的 vw / vh）都是**布局 px**，渲染时会被再乘一次缩放；`clientX` / `getBoundingClientRect`
   * 拿到的才是视觉 px。终端 dialog 的几何、预览面板的拖拽都走这个换算（`100vw` 在 1.25 字号下是 1800px
   * 而不是 1440px —— 这就是「全屏」铺不满视口、左边被切掉的根因，见 D123）。
   */
  private uiScale(): number {
    return this.prefs.scale || 1;
  }

  /**
   * 有效宽度 < 900 就是窄版。媒体查询看的是**视口**宽度，而 `#app` 上有 zoom：2.0 字号下
   * 1707px 的窗口只有 853 布局 px，`@media (max-width: 899px)` 却依然不触发（D158）。
   * 所以窄版的判据在 JS 里算一次，既给 `data-compact` 用，也给这里的所有 if 用 —— 两边不许分叉。
   */
  private compact(): boolean {
    return window.innerWidth / this.uiScale() < 900;
  }

  /**
   * 把上面的判据落到 `<html data-compact>`：CSS 的 899 / 900 断点都改读这个属性。
   * 返回「这次真的翻了」—— 调用方拿它决定要不要重排（拖动中跨过 900 时）。
   */
  private syncCompact(): boolean {
    const compact = this.compact();
    const root = document.documentElement;
    // 跟 `String(compact)` 比，而不是跟 "true" 比：首次调用必须把 "false" 也写下去，
    // 否则属性一直是 undefined，CSS 那边是在碰运气。
    if (root.dataset.compact === String(compact)) return false;
    root.dataset.compact = String(compact);
    // 换壳跟窗口跨过 900px 是同一件事：那颗「当前在哪」和标签行都得挪位置（构造期还没搭 DOM）。
    this.placeNowChip();
    this.placeWsTabs();
    return true;
  }

  /** 没存过几何时 dialog 的多大：底部居中，宽高跟着窗口（布局 px，已按缩放折算）。 */
  private termDefaults(): { w: number; h: number } {
    const s = this.uiScale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const narrow = this.compact();
    return { w: narrow ? vw - 16 : Math.min(1080, vw - 32), h: narrow ? Math.min(vh * 0.42, 340) : Math.min(vh * 0.46, 420) };
  }

  /** 底边至少要留出的空：桌面上是 margin，窄屏上还要让开底部三标签（不 56px 与 CSS 里的 bottom 一致）。 */
  private termInset(): number {
    return this.compact() ? 56 : 14;
  }

  private loadTermGeom(): TermGeom {
    if (this.termGeom) return this.termGeom;
    const geom: TermGeom = {};
    try {
      const raw = JSON.parse(localStorage.getItem("pi.termGeom") ?? "null") as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const k of ["l", "t", "w", "h"] as const) if (Number.isFinite(Number(raw[k]))) geom[k] = Number(raw[k]);
      }
    } catch {
      // 存坏了就当没存过，下次拖动再写
    }
    // Q-026 的老键：只记了高度，没有位置。
    if (geom.w === undefined && geom.h === undefined) {
      const h = Number(localStorage.getItem("pi.termH"));
      if (Number.isFinite(h) && h >= 140) geom.h = h;
    }
    this.termGeom = geom;
    return geom;
  }

  private saveTermGeom(dock: HTMLElement): void {
    const s = this.uiScale();
    const r = dock.getBoundingClientRect();
    const geom: TermGeom = { l: Math.round(r.left / s), t: Math.round(r.top / s), w: Math.round(r.width / s), h: Math.round(r.height / s) };
    this.termGeom = geom;
    try {
      localStorage.setItem("pi.termGeom", JSON.stringify(geom));
      localStorage.removeItem("pi.termH");
    } catch {
      // 存不下也不影响这次访问
    }
  }

  /**
   * 把存过的位置 / 大小铺到 dialog 上。没存过位置就继续用 CSS 那套底部居中（只把宽高清成算好的
   * 默认值 —— CSS 里的 `vh`/`vw` 在 `#app` 的 zoom 下会被再乘一次，铺满会溢出屏幕）。
   */
  private applyTermGeom(dock: HTMLElement): void {
    const s = this.uiScale();
    const base = this.termDefaults();
    const geom = this.loadTermGeom();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s - this.termInset();
    const w = clampNum(geom.w ?? base.w, Math.min(280, vw), vw);
    const h = clampNum(geom.h ?? base.h, Math.min(140, vh), vh);
    dock.style.width = `${w}px`;
    dock.style.height = `${h}px`;
    if (geom.l === undefined || geom.t === undefined) return;
    this.pinTerm(dock, { l: geom.l, t: geom.t, w, h });
  }

  /** 把 dialog 从「CSS 居中」改成 left/top 钉住：传了 box 就用它，否则量当前位置。 */
  private pinTerm(dock: HTMLElement, box?: TermBox): TermBox {
    const s = this.uiScale();
    const at = box ?? (() => {
      const r = dock.getBoundingClientRect();
      return { l: r.left / s, t: r.top / s, w: r.width / s, h: r.height / s };
    })();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s - this.termInset();
    const l = clampNum(at.l, 0, Math.max(0, vw - at.w));
    const t = clampNum(at.t, 0, Math.max(0, vh - at.h));
    dock.classList.add("pinned");
    dock.style.left = `${l}px`;
    dock.style.top = `${t}px`;
    dock.style.bottom = "auto";
    dock.style.transform = "none";
    return { l, t, w: at.w, h: at.h };
  }

  private resetTermGeom(): void {
    const dock = this.termDock;
    this.termGeom = {};
    try {
      localStorage.removeItem("pi.termGeom");
      localStorage.removeItem("pi.termH");
    } catch {
      // 忘不掉也还能用这一次
    }
    if (!dock) return;
    dock.classList.remove("pinned");
    for (const prop of ["left", "top", "bottom", "transform", "width", "height"]) dock.style.removeProperty(prop);
    this.applyTermGeom(dock);
    this.fitActiveTerm();
  }

  /**
   * 三处拖拽共用的骨架：按住 → 捕获指针 → 每帧按指针位移算新几何 → 松手存盘。
   * `step` 收到的是「布局 px」的位移（已经除过缩放），所以要怎么写都跟得上指针。
   */
  private dragTerm(
    handle: HTMLElement,
    dock: HTMLElement,
    kind: "move" | "size" | "grip",
    step: (box: TermBox, dx: number, dy: number, view: { vw: number; vh: number }) => void,
  ): void {
    handle.onpointerdown = (ev) => {
      if (ev.button !== 0) return;
      // 标题栏里的标签 / ＋ / 按钮要能点，只有空白处才是「拖走」。
      if (kind === "move" && (ev.target as HTMLElement).closest("button")) return;
      ev.preventDefault();
      const s = this.uiScale();
      const box = this.pinTerm(dock);
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      // vh 已经是「能用到多低」（扣掉了底部 tab 那条）。
      const view = { vw: window.innerWidth / s, vh: window.innerHeight / s - this.termInset() };
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add("dragging");
      const cls = kind === "move" ? "win-dragging" : "win-resizing";
      document.body.classList.add(cls);
      const move = (e: PointerEvent) => step(box, (e.clientX - x0) / s, (e.clientY - y0) / s, view);
      const done = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", done);
        handle.removeEventListener("pointercancel", done);
        handle.classList.remove("dragging");
        document.body.classList.remove(cls);
        this.saveTermGeom(dock);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", done);
      handle.addEventListener("pointercancel", done);
    };
  }

  /** 标题栏空白处：拖走。双击复原（位置 + 大小一起忘掉）。 */
  private wireTermMove(head: HTMLElement, dock: HTMLElement): void {
    this.dragTerm(head, dock, "move", (box, dx, dy, view) => {
      dock.style.left = `${clampNum(box.l + dx, 0, Math.max(0, view.vw - box.w))}px`;
      dock.style.top = `${clampNum(box.t + dy, 0, Math.max(0, view.vh - box.h))}px`;
    });
    head.ondblclick = (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      this.resetTermGeom();
    };
  }

  /** 右下角：宽 + 高一起拖。 */
  private wireTermResize(handle: HTMLElement, dock: HTMLElement): void {
    this.dragTerm(handle, dock, "size", (box, dx, dy, view) => {
      dock.style.width = `${clampNum(box.w + dx, 320, Math.max(320, view.vw - box.l))}px`;
      dock.style.height = `${clampNum(box.h + dy, 140, Math.max(140, view.vh - box.t))}px`;
    });
    handle.ondblclick = () => this.resetTermGeom();
  }

  /**
   * Q-026 的老手势：顶边那条抓取带只改高度（宽不动）。底边钉住 —— 拖动改的是上边缘，双击复原。
   */
  private wireTermGrip(grip: HTMLElement, dock: HTMLElement): void {
    this.dragTerm(grip, dock, "grip", (box, _dx, dy) => {
      const bottom = box.t + box.h;
      const h = clampNum(box.h - dy, 140, bottom);
      dock.style.top = `${clampNum(bottom - h, 0, bottom)}px`;
      dock.style.height = `${h}px`;
    });
    grip.ondblclick = () => this.resetTermGeom();
  }

  /** 拖过大小之后要重算 xterm 的列数行数（ResizeObserver 也会追一次，这里是为了拖动时就对上）。 */
  private fitActiveTerm(): void {
    const view = (this.termActive && this.termTabs.get(this.termActive)) || [...this.termTabs.values()][0];
    if (view) this.fitTerm(view);
  }


  private togglePane(side: "sessions" | "queue"): void {
    this.collapsed[side] = !this.collapsed[side];
    writeFlag(`pi.collapse.${side}`, this.collapsed[side]);
    this.renderPanes();
    this.renderTop();
  }

  private leftText(deadline: number): string {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (left === 0) return tr("已超时，正在拒绝…");
    return tr("{p1}:{p2} 后自动拒绝", { p1: Math.floor(left / 60), p2: String(left % 60).padStart(2, "0") });
  }

  /** One timer for every visible deadline chip; renderApprovals only creates them. */
  private startClock(): void {
    setInterval(() => {
      for (const node of document.querySelectorAll<HTMLElement>(".approval .hint[data-deadline]")) {
        node.textContent = this.leftText(Number(node.dataset.deadline));
      }
      for (const node of document.querySelectorAll<HTMLElement>(".bg-elapsed[data-bg-since]")) {
        node.textContent = bgElapsedText(Number(node.dataset.bgSince));
      }
      if (this.session?.running) this.fillHintStatus();
      // 刻度尺也养在这个闹钟里：只改 DOM 的格子数，不重画整个列表。
      for (const node of document.querySelectorAll<HTMLElement>(".sc-ruler[data-since]")) {
        drawRuler(node, Number(node.dataset.since));
      }
    }, 1000);
  }

  private wire(): void {
    // Q-021: 从别的窗口（或终端）切回来时，用户可能刚在里面切过分支。
    window.addEventListener("focus", () => void this.refreshGit(true));
    // D91: tell the bridge whether someone is looking, so it only pings Windows / WeChat when not.
    for (const name of ["focus", "blur"]) window.addEventListener(name, () => this.reportPresence());
    // D111: 点进预览里的 iframe 时，指针事件不跨文档，父窗口只收到 blur —— 等焦点落定，只有落在
    // iframe 上才补一次置顶（切到别的窗口时不打扰当前的叠放）。
    window.addEventListener("blur", () => {
      setTimeout(() => {
        const at = document.activeElement as HTMLElement | null;
        if (at?.tagName !== "IFRAME") return;
        const win = at.closest(".viewer, .term-dock") as HTMLElement | null;
        if (win) this.raiseWindow(win);
      }, 0);
    });
    document.addEventListener("visibilitychange", () => this.reportPresence());
    this.socket.on((msg) => this.onMessage(msg));
    this.socket.onStatus((s) => {
      this.connected = s === "open";
      if (this.connected) this.reportPresence();
      this.renderTop();
      this.renderSessions();
      // A shell outlives the page: ask the bridge what is still running and rebuild a tab per shell.
      if (this.connected) this.socket.send({ type: "term.list" });
    });

    window.addEventListener("hashchange", () => this.routeFromHash());
    // 预览的返回 / 前进（D63）：Alt+← / Alt+→ 顺手，但浏览器的默认后退要挡掉。
    window.addEventListener(
      "keydown",
      (ev) => {
        if (!this.viewer || !ev.altKey || ev.ctrlKey || ev.metaKey) return;
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        this.goStep(ev.key === "ArrowLeft" ? -1 : 1);
      },
      true,
    );
    // 预览页里的链接点击（D63）：用 token 认人，不靠 ev.source（跨文档导航后指针不相等）。
    window.addEventListener("message", (ev) => {
      const d = ev.data as { t?: string; rel?: string; href?: string; y?: number; tk?: string } | null;
      if (!d || (d.t !== "pi-nav" && d.t !== "pi-y")) return;
      const v = this.viewer;
      if (!v) return;
      const expect = v.frameToken || v.info?.token || "";
      if (!expect || d.tk !== expect) return;
      if (d.t === "pi-y") {
        // html 页里的滚动位置只能靠它自己报：按钮返回/前进时没有别的渠道拿到（D63）。
        const top = this.histOf(v.sessionId).steps[this.histOf(v.sessionId).at];
        if (top) top.y = Math.max(0, Number(d.y) || 0);
        return;
      }
      void this.trackRawNav(String(d.rel ?? ""), String(d.href ?? ""), Number(d.y) || 0, String(d.tk ?? ""));
    });
    this.installShortcuts();
    // 粘贴截图：桌面端 Ctrl+V / ⌘V 无论焦点在输入框还是页面上都落到待发图片里。
    window.addEventListener("paste", (ev) => this.onPaste(ev));
    // Drop files anywhere on the chat while a session is open.
    window.addEventListener("dragover", (ev) => {
      if (this.currentId && ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
    });
    window.addEventListener("drop", (ev) => {
      if (!this.currentId || !ev.dataTransfer?.files.length || document.querySelector(".modal")) return;
      ev.preventDefault();
      const { images, others } = splitImages(Array.from(ev.dataTransfer.files));
      if (images.length) void this.addImages(images);
      if (others.length) {
        this.warn(tr("浏览器拖拽拿不到「{p1}」的完整路径。请在资源管理器里复制它再 {p2}，或用「文件」按钮选", { p1: others.map((f) => f.name).join(tr("、")), p2: PASTE_KEY }));
      }
    });
    if (!this.compact()) this.tab = "sessions";
    // 跨过 900px 断点以前没人管：`renderPanes` 只在点按钮时跑，窗口一拖就停在旧状态 —— 收起状态的左栏
    // 在窄屏仍然是 hidden，反过来也一样。一帧一次的重排顺手把输入框下面那行工作目录对齐（D61）。
    let paneFrame = 0;
    window.addEventListener("resize", () => {
      if (paneFrame) return;
      paneFrame = requestAnimationFrame(() => {
        paneFrame = 0;
        this.syncCompact();
        this.renderPanes();
      });
    });
    this.renderAll();
  }

  // ---------------------------------------------------------------- routing
  private routeFromHash(): void {
    const hash = location.hash.replace(/^#\/?/, "");
    if (hash.startsWith("s/")) {
      const id = hash.slice(2);
      this.openSession(id);
      this.go("chat", false);
    } else if (hash === "q") {
      this.go("queue", false);
    } else {
      this.go("sessions", false);
    }
  }

  private go(tab: Tab, updateHash = true): void {
    this.tab = tab;
    if (updateHash) {
      const hash = tab === "queue" ? "#/q" : tab === "chat" && this.currentId ? `#/s/${this.currentId}` : "#/";
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }
    this.renderPanes();
    this.renderTabs();
  }

  // ---------------------------------------------------------------- drafts
  /** Records the current composer as the open session's draft. */
  private noteDraft(): void {
    if (!this.currentId) return;
    if (this.composerText || this.images.length || this.pastes.length) {
      this.drafts.set(this.currentId, { text: this.composerText, images: [...this.images], pastes: this.pastes.map((p) => ({ ...p })) });
    }
    else this.drafts.delete(this.currentId);
    this.persistDrafts();
  }

  /** Stash the open session's draft and load `next`'s (empty when it has none). */
  private switchDraft(next: string | null): void {
    this.noteDraft();
    const d = next ? this.drafts.get(next) : undefined;
    this.composerText = d?.text ?? "";
    this.images = d ? [...d.images] : [];
    this.pastes = d ? d.pastes.map((p) => ({ ...p })) : [];
  }

  private persistDrafts(): void {
    this.saveAskDrafts();
    // Text + paste blocks only: pasted images are too big for localStorage and are kept in memory for this tab.
    const keep = [...this.drafts]
      .filter(([, d]) => d.text.trim() || d.pastes.length)
      .slice(-50)
      .map(([id, d]) => (d.pastes.length ? [id, d.text, d.pastes.map((p) => p.text)] : [id, d.text]));
    try {
      if (keep.length) localStorage.setItem("pi.drafts", JSON.stringify(keep));
      else localStorage.removeItem("pi.drafts");
    } catch {
      /* quota / private mode */
    }
  }

  private openSession(id: string): void {
    if (this.currentId === id) return;
    this.switchDraft(id);
    this.currentId = id;
    this.session = this.sessions.find((s) => s.id === id) ?? null;
    this.resetSessionView();
    this.socket.send({ type: "subscribe", sessionId: id });
    this.renderAll();
  }

  /**
   * 换会话 / 离开会话时清掉「上一颗的现场」：待批、待答、用量、速率、回合计时、活动行。
   * D162: 打开只是看 —— 不清完成；bridge 也一样（snapshot 不再 markSeen）。
   */
  private resetSessionView(): void {
    this.approvals = [];
    this.asks = [];
    this.pendingFresh = false;
    this.usage = { contextTokens: null, contextWindow: null };
    this.rate = 0;
    this.rateAt = 0;
    this.turnAt = null;
    this.turnChars = { cjk: 0, other: 0 };
    this.activity = "";
    this.runSince = null;
  }

  // ---------------------------------------------------------------- ws
  private onMessage(msg: any): void {
    // #86：随手问的帧先给它自己认领。它的 sessionId 永远不是当前会话，下面那些 case 本来也会忽略它。
    if (this.scratch.handle(msg)) return;
    switch (msg.type) {
      case "catalog": {
        const next = (msg.models ?? []) as ModelInfo[];
        const error = typeof msg.error === "string" ? msg.error.trim() : "";
        // 两段式目录：第二批往往就是同一份（没有扩展提供的模型），别为了它把已经展开的面板、
        // 以及用户挑了一半的选项重画掉（D150）。
        const same =
          next.length > 0 &&
          next.length === this.models.length &&
          next.every((m, i) => m.id === this.models[i]?.id && m.provider === this.models[i]?.provider);
        this.models = next;
        this.modelsError = error;
        if (this.sheetKind === "model" && !(same && !error)) this.openModelSheet();
        this.fillModelChip();
        break;
      }
      case "commands":
        if (msg.sessionId !== this.currentId) break;
        this.piCommands = { sessionId: String(msg.sessionId), at: Date.now(), list: Array.isArray(msg.commands) ? msg.commands : [] };
        if (this.complete?.mode === "cmd") this.updateComplete();
        break;
      case "skills":
        this.skills = (msg.commands ?? []) as SkillInfo[];
        this.skillsAt = Date.now();
        if (this.skillPop) this.renderSkillList();
        break;
      // ------------------------------------------------ 技能商店 (D126)
      case "skill.store":
        // A stale answer (the box moved on while this search was in flight) would flash the old list back.
        if (String(msg.query ?? "") !== this.skillStore.query) break;
        this.skillStore.items = Array.isArray(msg.items) ? (msg.items as SkillStoreItem[]) : [];
        this.skillStore.error = msg.error ? errText(msg) : undefined;
        this.skillStore.note = msg.note ? String(msg.note) : undefined;
        this.paintSkillIfOpen();
        break;
      case "skill.store.meta": {
        // Second stage of the same search (D126): dirs and descriptions, merged by id.
        if (String(msg.query ?? "") !== this.skillStore.query || !this.skillStore.items) break;
        const more = new Map((Array.isArray(msg.items) ? (msg.items as SkillStoreItem[]) : []).map((i) => [i.id, i]));
        this.skillStore.items = this.skillStore.items.map((item) => more.get(item.id) ?? item);
        this.skillStore.note = msg.note ? String(msg.note) : this.skillStore.note;
        this.paintSkillIfOpen();
        break;
      }
      case "skill.installed":
        this.skillInv = Array.isArray(msg.items) ? (msg.items as InstalledSkill[]) : [];
        this.skillInvError = msg.error ? errText(msg) : null;
        this.paintSkillIfOpen();
        break;
      case "skill.source": {
        const src = this.skillSource;
        src.loading = false;
        src.kind = msg.kind === "local" ? "local" : "repo";
        src.label = String(msg.source ?? "");
        src.items = Array.isArray(msg.items) ? (msg.items as SkillSourceItem[]) : [];
        src.error = msg.error ? errText(msg) : undefined;
        this.paintSkillIfOpen();
        break;
      }
      case "skill.install.done": {
        const reqId = String(msg.reqId ?? "");
        const mine = this.skillOps.get(reqId);
        if (mine) this.skillOps.delete(reqId);
        if (msg.ok) {
          // A new folder only shows up in the next pi process: say so, and refresh both lists now.
          this.skillDirty = true;
          this.skillNote = { text: tr("已装好 {p1}", { p1: String(msg.name ?? "") }), bad: false };
          this.loadSkillInventory();
          this.socket.send({ type: "skills", sessionId: this.currentId });
        } else {
          this.skillNote = { text: tr("没有装上：{p1}", { p1: errText(msg) }), bad: true };
        }
        this.paintSkillIfOpen();
        break;
      }
      case "skill.remove.done": {
        const reqId = String(msg.reqId ?? "");
        const mine = this.skillOps.get(reqId);
        if (mine) this.skillOps.delete(reqId);
        if (msg.ok) {
          this.skillDirty = true;
          this.skillNote = { text: tr("已卸载 {p1}", { p1: String(msg.name ?? "") }), bad: false };
          this.loadSkillInventory();
        } else {
          this.skillNote = { text: tr("没有卸载：{p1}", { p1: errText(msg) }), bad: true };
        }
        this.paintSkillIfOpen();
        break;
      }
      case "hello":
        if (msg.workspace) this.workspaces = msg.workspace as WorkspaceState;
        if (msg.ui) this.uiPrefs = { showExtButton: msg.ui.showExtButton !== false };
        // D154：桥上的 build 换了，页面里的 JS 还是旧的 —— 提示刷新，不自动 reload。
        if (typeof msg.buildId === "string") this.checkBuild(msg.buildId);
        // D113: a dropped socket mid-stream would leave the ⟳ spinning forever (the flags gate the
        // next request), so a fresh connection forgets them and asks again.
        this.extInvLoading = false;
        this.extCheckLoading = false;
        if (this.extReloadPending || this.sheetKind === "ext") {
          this.extReloadPending = false;
          this.loadExtInventory();
        }
        if (Array.isArray(msg.notes)) this.setNotes(msg.notes as Note[]);
        // #86：断线重连时桥可能重启过，随手问的对话可能已经没了——重新问一次桥，它说什么就是什么。
        this.scratch.reconnect();
        // Badge: whether anything installed has an update (bridge caches this for 6 hours).
        this.socket.send({ type: "ext.updates", ...(this.session?.cwd ? { cwd: this.session.cwd } : {}) });
        // A new socket starts unverified on the bridge side.
        this.stepUntil = 0;
        this.sessions = msg.sessions ?? [];
        // 重连后本地队列可能还是上一条连接的：清掉、等 subscribe 的快照回来，否则它盖着列表里的真值（D156）。
        this.approvals = [];
        this.asks = [];
        this.pendingFresh = false;
        if (Array.isArray(msg.trash)) this.trash = msg.trash as TrashItem[];
        if (msg.manage) this.manage = msg.manage as ManageState;
        if (msg.workspace) this.workspaces = msg.workspace as WorkspaceState;
        if (this.currentId && !this.session) this.session = this.sessions.find((x) => x.id === this.currentId) ?? null;
        this.tunnel = msg.tunnel ?? this.tunnel;
        this.renderAll();
        // Q-021: 新会话 / 首屏恢复都可能带着另一个 cwd 进来。
        void this.refreshGit(true);
        if (this.currentId) this.socket.send({ type: "subscribe", sessionId: this.currentId });
        break;
      case "session": {
        // 「交给 agent → 新开会话」那段文字，只有「这条快照是我刚建的那个会话」才认领：
        // 先取出来再 finish()，后面 closeSheet() 会把它丢掉。
        const handoff = this.creating ? this.prefillNext : null;
        this.creating?.finish();
        // bridge sends the snapshot as {sessionId, state, items, approvals, budget}
        if (msg.sessionId) {
          // A freshly created session arrives here without openSession(): give it its own (empty) draft.
          if (String(msg.sessionId) !== this.currentId) this.switchDraft(String(msg.sessionId));
          this.currentId = String(msg.sessionId);
        }
        this.usage = { contextTokens: null, contextWindow: null };
        this.rate = 0;
        this.turnAt = null;
        this.turnChars = { cjk: 0, other: 0 };
        if (msg.state) this.session = msg.state as SessionState;
        else if (msg.session) this.session = msg.session;
        this.budget = typeof msg.budget === "number" ? msg.budget : null;
        this.ext = (msg.ext as ExtUi | undefined) ?? { status: [], widgets: [], title: null };
        if ("trust" in msg) this.trust = (msg.trust as TrustState | null) ?? null;
        this.queue = msg.queue ? { steering: msg.queue.steering ?? [], followUp: msg.queue.followUp ?? [] } : { steering: [], followUp: [] };
        this.stats = { tokens: null, cost: null };
        // 换了会话：上一份「见过的失败」不能带过来，否则按钮会按别人的失败亮着。
        this.sessionFails.clear();
        this.failReminded.clear();
        this.failRemindPending.clear();
        this.failReviewPending = false;
        this.failLedger = this.failWs && this.failWs === (this.session?.ws ?? "") ? this.failLedger : null;
        this.failRules = this.failRulesWs && this.failRulesWs === (this.session?.ws ?? "") ? this.failRules : null;
        this.chat.reset((msg.items ?? []) as Item[]);
        if (this.currentWs()) {
          this.socket.send({ type: "failures.get", ws: this.currentWs() });
          this.socket.send({ type: "rules.get", ws: this.currentWs() });
        }
        if (this.afterOpen && this.afterOpen.id === msg.sessionId) {
          this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: this.afterOpen.text, level: "info" });
          this.afterOpen = null;
        }
        this.approvals = (msg.approvals ?? []) as ApprovalRequest[];
        this.asks = (msg.asks ?? []) as AskRequest[];
        // 快照里的队列是权威值：顺手把列表里那条累加值对齐，曾经算歪的会话打开一次就回到真值（D156）。
        syncPending(this.sessions, String(msg.sessionId ?? this.currentId ?? ""), this.localCounts());
        this.pendingFresh = true;
        this.renderAll();
        // 「交给 agent → 新开会话」：会话建好之后才把文字填进去。此刻 textarea 已经指向新会话。
        if (handoff) {
          this.prefillNext = null;
          this.composerText = handoff;
          if (this.textarea) {
            this.textarea.value = handoff;
            this.fitComposer();
            this.textarea.focus();
          }
          this.noteDraft();
        }
        // Q-021: 切会话＝换 cwd，分支要跟着换。
        void this.refreshGit(true);
        // A takeover from the model sheet unlocks it; reopen so the list is usable right away.
        if (this.sheetKind === "model" && this.session?.owned) this.openModelSheet();
        break;
      }
      case "items":
        if (msg.sessionId !== this.currentId) break;
        this.sessionFails.clear();
        this.failReminded.clear();
        this.failRemindPending.clear();
        this.chat.reset((msg.items ?? []) as Item[]);
        // 刷新 / 换设备回来：快照里那些失败的条目也要能被「总结」到，不然按钮永远不亮。
        // 整条记录被换掉：有没有用户消息可能变了（D159 的「灰」就是看这个）。
        this.syncContinueButton();
        break;
      case "item.add":
        if (msg.sessionId !== this.currentId) break;
        if (typeof msg.clientId === "string") this.chat.adopt(msg.clientId, msg.item as Item);
        else this.chat.add(msg.item as Item);
        break;
      case "item.remove":
        if (msg.sessionId !== this.currentId) break;
        this.chat.remove(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
        break;
      case "bash.delta":
        if (msg.sessionId !== this.currentId) break;
        this.chat.bashDelta(String(msg.id ?? ""), String(msg.text ?? ""));
        break;
      case "bg.list":
        if (!this.bgSheet || msg.sessionId !== this.bgSheet.sessionId) break;
        // 桥只发错误码（文案在这边翻了再显示），目前只有一种：公网那只手看不到后台任务。
        const why = msg.error === "public" ? tr("公网访问时看不到后台任务") : "";
        this.paintBgSheet(Array.isArray(msg.runs) ? (msg.runs as BgRunDto[]) : [], why);
        break;
      case "bg.log":
        if (msg.sessionId !== this.bgSheet?.sessionId) break;
        this.fillBgRun(String(msg.runId ?? ""), msg.log, msg.out);
        break;
      case "queue":
        if (msg.sessionId !== this.currentId) break;
        this.queue = { steering: Array.isArray(msg.steering) ? msg.steering.map(String) : [], followUp: Array.isArray(msg.followUp) ? msg.followUp.map(String) : [] };
        this.fillQueueBar();
        break;
      case "item.replace":
        if (msg.sessionId !== this.currentId) break;
        this.chat.replace(msg.id, msg.item as Item);
        break;
      case "delta":
        if (msg.sessionId !== this.currentId) break;
        this.trackChars(msg.field, msg.text);
        this.chat.delta(msg.id, msg.field, msg.text);
        this.setActivity(msg.field === "thinking" ? tr("思考中") : tr("正在写回复"));
        break;
      case "usage":
        if (msg.sessionId !== this.currentId) break;
        this.settleRate(msg.usage);
        break;
      case "stats":
        if (msg.sessionId !== this.currentId) break;
        if (typeof msg.budget === "number" || msg.budget === null) this.budget = msg.budget ?? null;
        this.stats = { tokens: msg.tokens && typeof msg.tokens === "object" ? msg.tokens : null, cost: typeof msg.cost === "number" ? msg.cost : null };
        this.usage = {
          contextTokens: typeof msg.context?.tokens === "number" ? msg.context.tokens : null,
          contextWindow: typeof msg.context?.contextWindow === "number" ? msg.context.contextWindow : this.usage.contextWindow,
        };
        this.fillModelChip();
        break;
      case "budget":
        if (msg.sessionId !== this.currentId) break;
        this.budget = typeof msg.budget === "number" ? msg.budget : null;
        this.fillModelChip();
        break;
      case "tool":
        if (msg.sessionId !== this.currentId) break;
        this.chat.toolEvent(msg.phase, msg);
        if (msg.phase === "start") {
          // Q-024: the line under the composer names the tool and stops there. A bash command used to
          // be pasted after it (up to 120 chars, usually cut mid-path) while the hover card (Q-017)
          // already carries the full summary, args, output and thinking — the line was pure noise.
          this.stepCount += 1;
          this.setActivity(tr("正在执行 {p1}", { p1: msg.name ?? "工具" }));
        } else if (msg.phase === "end") this.setActivity(tr("思考中"));
        break;
      case "approval.add":
        // D156：当前会话也照加 —— 列表里的计数和本地队列是两份账，只给「不在看的会话」加会让
        // 切过去再答的批准永远减不掉；卡片是否重画也跟着这条走。
        this.countPending(msg.sessionId, "approvals", 1);
        if (msg.sessionId === this.currentId) this.approvals = [...this.approvals, msg.approval];
        this.renderApprovals();
        this.renderQueue();
        this.renderTabs();
        this.fillHintStatus();
        this.renderSessions();
        break;
      case "approval.remove":
        this.approvals = this.approvals.filter((a) => a.id !== msg.id);
        // 和 approval.add 对称：不管这条批准是不是当前会话的，都得减回去，否则卡片上永远「待确认」。
        this.countPending(msg.sessionId, "approvals", -1);
        this.fillHintStatus();
        this.renderApprovals();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      case "ask.add": {
        const ask = msg.ask as AskRequest;
        if (!ask) break;
        // 提问记在 asks 上（不是 approvals），当前会话也记 —— 见 D156。
        this.countPending(msg.sessionId, "asks", 1);
        if (msg.sessionId !== this.currentId) {
          this.renderSessions();
          break;
        }
        this.asks = [...this.asks.filter((a) => a.id !== ask.id), ask];
        this.askFolded = false;
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        this.renderNowChip();
        break;
      }
      case "ask.remove": {
        // The bridge tells us why an ask disappeared. Dropping the id silently is how answers used
        // to vanish: the panel closed, the drafts died with it, and nothing on screen said so.
        const gone = this.asks.find((a) => a.id === msg.id);
        const mine = msg.sessionId === this.currentId;
        this.asks = this.asks.filter((a) => a.id !== msg.id);
        // 答完 / 被取消都走这条：计数必须跟着回落（D156）。
        this.countPending(msg.sessionId, "asks", -1);
        if (gone && mine && gone.id !== this.lastAnsweredAsk) this.keepLostAsk(gone, String(msg.reason ?? tr("问卷已关闭")));
        if (gone && mine) this.lastAnsweredAsk = null;
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      }
      case "ext.ui":
        if (msg.sessionId !== this.currentId) break;
        this.ext = (msg.ext as ExtUi | undefined) ?? { status: [], widgets: [], title: null };
        this.fillExt();
        break;
      case "editor.set": {
        // ctx.ui.setEditorText: the extension replaces what is in the editor, like in the terminal.
        if (msg.sessionId !== this.currentId) break;
        this.composerText = "";
        this.putInComposer(String(msg.text ?? ""));
        break;
      }
      case "settings": {
        const view = msg as SettingsView;
        this.settingsView[view.scope] = view;
        if (msg.saved) this.flashSettings(tr("已保存到 {p1}", { p1: view.path }));
        if (this.sheetKind === "settings") this.paintSettings();
        break;
      }
      // ------------------------------------------------------- 默认权限（D161）
      case "permission.defaults": {
        // Only the answer to the question this sheet asked: a slow reply for another project must
        // not repaint this one with somebody else's count.
        const cwd = typeof msg.cwd === "string" ? msg.cwd : null;
        const want = this.settingsTab === "project" ? (this.settingsView.project?.cwd ?? "") : "";
        if ((cwd ?? "") !== want) break;
        this.permDefaults = {
          cwd,
          mode: String(msg.mode ?? "ask"),
          source: String(msg.source ?? "fallback"),
          path: typeof msg.path === "string" ? msg.path : null,
          total: Number(msg.total) || 0,
        };
        if (this.sheetKind === "settings") this.paintSettings();
        break;
      }
      case "permission.applied": {
        const n = Number(msg.applied) || 0;
        this.flashSettings(tr("已经把这 {p1} 个会话的权限改成默认值", { p1: String(n) }));
        this.permDefaultsFor = null;
        if (this.sheetKind === "settings") this.paintSettings();
        break;
      }
      // ---------------------------------------------------------------- 口令（#89）
      case "passphrase":
        this.passphraseView = { value: typeof msg.value === "string" ? msg.value : null, dir: String(msg.dir ?? "") };
        this.passphraseShown = false;
        if (msg.saved === true) {
          this.passphraseDraft = "";
          this.passphraseFresh = null;
          // 已登录的设备不会被踢：cookie 用另一把 secret 签名，改口令只让旧口令进不来。
          this.flashSettings(tr("已保存：旧口令立刻失效，已经登录的浏览器不用重新登录。"));
        }
        if (this.sheetKind === "settings" && this.settingsTab === "passphrase") this.paintSettings();
        break;
      case "passphrase.suggest":
        this.passphraseFresh = String(msg.value ?? "");
        this.passphraseDraft = this.passphraseFresh;
        if (this.sheetKind === "settings" && this.settingsTab === "passphrase") this.paintSettings();
        break;
      case "passphrase.changed":
        // 只收到「变了」：明文得按各自的 step-up 门槛重新取，不能从广播里白拿。
        this.passphraseView = null;
        if (this.sheetKind === "settings" && this.settingsTab === "passphrase") {
          this.askPassphrase();
          this.paintSettings();
        }
        break;
      case "passphrase.error":
        this.flashSettings(String(msg.message ?? tr("保存失败")), true);
        break;
      case "notify":
        this.me = { ...this.me, notify: msg.on !== false };
        if (this.sheetKind === "settings" && this.settingsTab === "notify") this.paintSettings();
        break;
      case "runtime.stats":
        // D120 / #77：桥在每次 GC tick 上广播一次，所以面板不用自己轮询。
        this.runtimeStats = {
          running: Number(msg.running ?? 0),
          totalBytes: typeof msg.totalBytes === "number" ? msg.totalBytes : null,
          unavailable: msg.unavailable === true,
          sessions: Array.isArray(msg.sessions) ? (msg.sessions as RuntimeStats["sessions"]) : [],
          lifecycle: {
            idleMs: Number(msg.lifecycle?.idleMs ?? 0),
            watermarkBytes: Number(msg.lifecycle?.watermarkBytes ?? 0),
          },
        };
        // D120 / #78：`saved` 只在回答一次阈值写入时出现。
        if (msg.saved === true) this.flashSettings(tr("已保存：空闲阈值下一个 tick 就生效，不用重启桥。"));
        if (msg.saved === false) this.flashSettings(tr("没有保存：阈值必须是大于 0 的数。"), true);
        // 回答自己的写入一定要重画；每分钟一次的广播则不能把正在输入的阈值抢掉（换 DOM 就是丢光标、丢草稿）。
        if (this.sheetKind === "settings" && this.settingsTab === "runtime" && (msg.saved !== undefined || !runtimeThresholdFocused())) this.paintSettings();
        break;
      case "runtime.sleepAll": {
        // D120 / #80：回执点名没睡的那几个，比一个「完成」有用得多。
        this.sleepAllReceipt = {
          slept: Array.isArray(msg.slept) ? (msg.slept as string[]).map(String) : [],
          skipped: Array.isArray(msg.skipped) ? (msg.skipped as SleepAllReceipt["skipped"]) : [],
        };
        if (this.sheetKind === "settings" && this.settingsTab === "runtime") this.paintSettings();
        break;
      }
      case "lockext":
        this.lockExt = { installed: Boolean(msg.installed), path: String(msg.path ?? "") };
        if (msg.saved) this.flashSettings(msg.installed ? tr("已装进 pi 的全局扩展：之后启动的终端 pi 会登记自己开着的会话") : tr("已从 pi 的全局扩展里移除"));
        if (this.sheetKind === "settings" && this.settingsTab === "global") this.paintSettings();
        break;
      case "share.progress":
      case "bug.progress":
        this.flashShare(String(msg.text ?? ""));
        break;
      case "share.done": {
        if (msg.error) {
          this.flashShare(tr("没有分享成功：{p1}", { p1: errText(msg) }), true);
          break;
        }
        this.closeSheet();
        const via = msg.via === "radius" ? tr("Radius（组织内可见）") : tr("私有 GitHub gist");
        this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: tr("已分享到{p1}：{p2}{p3}", { p1: via, p2: msg.url, p3: msg.gistUrl ? `（gist：${msg.gistUrl}）` : "" }), level: "info" });
        void navigator.clipboard?.writeText(String(msg.url)).catch(() => {});
        window.open(String(msg.url), "_blank", "noopener");
        break;
      }
      case "notes":
        this.setNotes((msg.notes ?? []) as Note[]);
        break;
      case "notes.saved":
        this.notesSheet?.saved(msg);
        break;
      case "notes.shot":
        this.notesSheet?.shot(msg);
        break;
      case "failures":
        // 别的标签页在别的工作区入账时，广播会带着那本账过来；不能顶掉当前这本。
        if (msg.ledger && (!this.currentWs() || (msg.ledger as FailLedger).ws === this.currentWs())) this.setFailLedger(msg.ledger as FailLedger);
        break;
      case "failures.saved":
        if (msg.ws && this.currentWs() && msg.ws !== this.currentWs()) break;
        this.failSaved(msg);
        break;
      case "rules":
        if (msg.book && (!this.currentWs() || (msg.book as RuleBook).ws === this.currentWs())) this.setFailRules(msg.book as RuleBook);
        break;
      case "rules.saved":
        if (msg.error) this.flashToast(tr("规矩没存下：{p1}", { p1: String(msg.error) }), true, 6000);
        else if (msg.book) this.setFailRules(msg.book as RuleBook);
        break;
      case "failures.reviewed": {
        if (msg.sessionId && msg.sessionId !== this.currentId) break;
        this.failReviewPending = false;
        this.syncFailCta();
        if (!msg.ok) {
          this.flashToast(tr("没发出去：{p1}", { p1: this.reviewWhy(String(msg.reason ?? "")) }), true, 6000);
          break;
        }
        const ws = this.currentWs();
        const sid = this.currentId ?? "";
        const n = Number(msg.n ?? 0);
        // 发出去了才记「这个会话已复盘 N 条」：发失败要留着让人重试，不能先占位。
        if (ws && sid && n > 0) this.socket.send({ type: "rules.reviewed", ws, sid, n });
        this.flashToast(tr("已发到会话 · 复盘 {p1} 类失败", { p1: Number(msg.classes ?? 0) }), false, 4000);
        break;
      }
      case "failures.reminded":
        // 桥的回执：成不成都要收回「在途」标记；成了才记成「这一类已提醒过」。
        this.failRemindPending.delete(String(msg.key ?? ""));
        if (msg.ok && msg.sessionId === this.currentId) this.failReminded.add(String(msg.key ?? ""));
        break;
      case "bug.done": {
        if (msg.error) {
          this.flashShare(tr("没有提交成功：{p1}", { p1: errText(msg) }), true);
          break;
        }
        this.closeSheet();
        if (msg.download) {
          const a = document.createElement("a");
          a.href = String(msg.download);
          a.download = "";
          a.click();
        }
        this.chat.add({
          id: `n:${Date.now()}`,
          kind: "notice",
          text: msg.delivery === "upload" ? tr("bug 报告已上传给 pi 开发者，报告 ID：{p1}", { p1: msg.id }) : tr("bug 报告已导出成 zip 并开始下载，报告 ID：{p1}", { p1: msg.id }),
          level: "info",
        });
        break;
      }
      case "picli.start":
        // The two listings run in the background; only a user's command takes over the console.
        if (msg.op === "pkg.list" || msg.op === "mcp.list") break;
        if (msg.reqId) {
          const mine = this.cliOps.get(String(msg.reqId));
          if (mine) mine.state = "running";
        }
        this.cliRun = { runId: String(msg.runId), op: String(msg.op), out: "", code: undefined };
        this.paintExtIfOpen();
        break;
      case "picli.out":
        if (this.cliRun && this.cliRun.runId === msg.runId) {
          this.cliRun.out = (this.cliRun.out + String(msg.text ?? "")).slice(-60_000);
          const pre = this.sheet?.querySelector<HTMLElement>(".cli-out");
          if (pre) {
            pre.textContent = this.cliRun.out;
            pre.scrollTop = pre.scrollHeight;
          } else this.paintExtIfOpen();
        }
        break;
      case "picli.done": {
        const op = String(msg.op ?? "");
        if (op === "pkg.list" || op === "mcp.list") break;
        // D113: a fleet of queued buttons finishes one at a time; each one clears its own row.
        // 没有 reqId 的 done（老桥 / 另一个标签页起的）也要把对应行放开，否则那颗按钮永远停在
        // 「排队中…」——宁可多放一个，也不要卡死一行。
        if (msg.reqId) this.cliOps.delete(String(msg.reqId));
        else for (const [id, entry] of this.cliOps) if (entry.op === op) {
          this.cliOps.delete(id);
          break;
        }
        if (this.cliRun && (this.cliRun.runId === msg.runId || !this.cliRun.runId)) {
          this.cliRun.code = typeof msg.code === "number" ? msg.code : null;
          if (msg.error) this.cliRun.error = errText(msg);
        } else if (msg.error) this.flashSettings(errText(msg), true);
        if (Array.isArray(msg.vars) && msg.vars.length) this.extVars = msg.vars.map(String);
        if (msg.code === 0) {
          this.extDirty = true;
          if (op === "mcp.add") this.mcpForm = null;
        }
        if (op === "pkg.update" && this.piUpdRun === "running") {
          this.piUpdRun = msg.code === 0 && !msg.error ? "ok" : "fail";
          // The bridge re-read the package's version after a successful update; ask again so the row
          // compares the new version instead of the one it saw before the install.
          if (this.piUpdRun === "ok") this.checkPiUpdate();
        }
        // Re-read what changed (and whether updates are left).
        this.loadExtInventory();
        this.paintExtIfOpen();
        break;
      }
      case "ext.op": {
        // D113: the file-edit operations (启用 / 停用 / MCP 改版本) report start and end separately.
        const opName = String(msg.op ?? "");
        if (msg.reqId) {
          if (msg.state === "done") this.cliOps.delete(String(msg.reqId));
          else {
            const mine = this.cliOps.get(String(msg.reqId));
            if (mine) mine.state = "running";
          }
        } else if (msg.state === "done") {
          for (const [id, entry] of this.cliOps) if (entry.op === opName) {
            this.cliOps.delete(id);
            break;
          }
        }
        if (msg.state === "done" && msg.error) this.flashSettings(String(msg.error), true);
        this.paintExtIfOpen();
        break;
      }
      case "ui":
        if (msg.ui) this.uiPrefs = { showExtButton: msg.ui.showExtButton !== false };
        this.renderChat();
        if (this.sheetKind === "settings" && this.settingsTab === "ext") this.paintSettings();
        break;
      case "ext.updates":
        this.extUpdates = Number(msg.count) || 0;
        this.paintExtButton();
        break;
      case "pi.update.status": {
        this.piChecking = false;
        if (msg.current) this.me.pi = String(msg.current);
        this.piUpd = {
          latest: msg.latest ? String(msg.latest) : null,
          source: msg.source ? String(msg.source) : undefined,
          checkedAt: Number(msg.checkedAt) || Date.now(),
          update: msg.update === true,
          ...(msg.error ? { error: String(msg.error) } : {}),
        };
        this.paintExtIfOpen();
        this.renderQueue();
        break;
      }
      case "pi.version":
        // #49: `pi update` replaced the package on disk; the bridge re-read its version for us.
        if (msg.version) {
          this.me.pi = String(msg.version);
          this.paintExtIfOpen();
          this.renderQueue();
        }
        break;
      case "ext.inventory":
        if (msg.error) {
          this.extInvLoading = false;
          this.extCheckLoading = false;
          this.flashSettings(errText(msg), true);
          break;
        }
        // D113: the bridge pushes this in stages (local rows → MCP servers → versions). Keep the
        // version columns from the previous answer for rows whose version did not change, so a
        // re-check does not blank out the 更新 buttons it is about to confirm.
        // SAFETY: 桥端扩展清单的字段由 `bridge/src/extensions.ts` 序列化，
        // `Inventory` 与这里的 `ExtInventory` 是同一份契约，RPC 只是丢了类型。
        this.extInv = mergeInventory(this.extInv, msg as unknown as ExtInventory);
        // 失败卡片要靠「装了什么」给插件点名：pi 的 RPC 不提供 extensionId，只有文本可用。
        setKnownPlugins([
          ...this.extInv.packages.map((p) => p.name ?? ""),
          ...this.extInv.extensions.flatMap((e) => [e.id, e.label]),
        ].map((n) => n.split(/[\\/]/).pop() ?? n).map((n) => n.replace(/\.(ts|js|mjs|cjs)$/i, "")));
        if (this.extInv.mcpReady) this.extInvLoading = false;
        if (this.extInv.versionsChecked) {
          this.extCheckLoading = false;
          if (this.extReloadPending) {
            this.extReloadPending = false;
            this.loadExtInventory();
          }
        }
        if (typeof msg.updates === "number") {
          this.extUpdates = msg.updates;
          this.paintExtButton();
        }
        this.paintExtIfOpen();
        break;
      case "ext.store":
        if (String(msg.query ?? "") !== this.extStore.query) break;
        this.extStore.items = Array.isArray(msg.items) ? msg.items : [];
        this.extStore.error = msg.error ? errText(msg) : msg.error;
        this.paintExtIfOpen();
        break;
      case "mcp.index":
        // D81/D171: the ranked index finished building in the background — forget what is on screen (and
        // what the tab switch would show later) so the next paint re-asks. Unranked registry results
        // become the ranking without a retype. `paintMcpStore` sends `mcp.store` itself when `items` is null.
        this.mcpStore.items = null;
        this.mcpStore.building = false;
        // A failed first search left `error` set; `paintMcpStore` only re-asks when there is no error, so
        // keeping it would pin the page on 「没读出来」 forever and the index would never show up.
        this.mcpStore.error = undefined;
        if (this.extTab === "mcp" && (this.sheetKind === "ext" || (this.sheetKind === "settings" && this.settingsTab === "ext"))) this.paintExtIfOpen();
        break;
      case "mcp.store":
        if (String(msg.query ?? "") !== this.mcpStore.query) break;
        this.mcpStore = { ...this.mcpStore, items: Array.isArray(msg.items) ? msg.items : [], error: msg.error ? errText(msg) : msg.error, building: Boolean(msg.building), starsComplete: Boolean(msg.starsComplete), hasToken: Boolean(msg.hasToken), truncated: Boolean(msg.truncated) };
        this.paintExtIfOpen();
        break;
      case "ext.changed":
        this.extDirty = true;
        if (Array.isArray(msg.vars) && msg.vars.length) this.extVars = msg.vars.map(String);
        this.loadExtInventory();
        break;
      case "ext.error":
        this.flashSettings(String(msg.message ?? tr("操作失败")), true);
        break;
      case "auth.providers":
        this.authProviders = Array.isArray(msg.providers) ? msg.providers : [];
        if (this.sheetKind === "settings" && this.settingsTab === "login") this.paintSettings();
        break;
      case "auth.started":
        this.login = { loginId: String(msg.loginId), provider: String(msg.provider), method: String(msg.method), events: [], prompt: null, result: null, ok: false };
        this.paintLoginIfOpen();
        break;
      case "auth.event":
        if (this.login && this.login.loginId === msg.loginId && msg.event) this.login.events.push(msg.event as AuthEventView);
        this.paintLoginIfOpen();
        break;
      case "auth.prompt":
        if (this.login && this.login.loginId === msg.loginId) this.login.prompt = { promptId: String(msg.promptId), prompt: msg.prompt as AuthPromptView };
        this.paintLoginIfOpen();
        break;
      case "auth.prompt.cancel":
        if (this.login && this.login.prompt?.promptId === msg.promptId) this.login.prompt = null;
        this.paintLoginIfOpen();
        break;
      case "auth.done":
        if (this.login && (this.login.loginId === msg.loginId || msg.loginId === null)) {
          this.login.prompt = null;
          this.login.ok = Boolean(msg.ok);
          this.login.result = msg.ok ? tr("已登录 {p1}，凭据由 pi 存进 auth.json。正在运行的会话「重新加载」后用上新凭据。", { p1: msg.provider }) : tr("没有登录成功：{p1}", { p1: msg.error ?? "未知原因" });
        } else if (!msg.ok && msg.error) this.flashSettings(String(msg.error), true);
        this.paintLoginIfOpen();
        break;
      case "settings.error":
        this.flashSettings(String(msg.message ?? tr("保存失败")), true);
        break;
      case "trust": {
        if (this.session && msg.cwd === this.session.cwd) this.trust = (msg.trust as TrustState) ?? null;
        if (msg.saved) this.flashSettings(tr("信任决定已保存（写在 trust.json，终端里的 pi 也认）"));
        if (this.sheetKind === "settings") this.paintSettings();
        this.renderChat();
        break;
      }
      case "tree":
        if (msg.sessionId === this.currentId && this.sheetKind === "tree") this.fillTreeSheet(Array.isArray(msg.nodes) ? msg.nodes : [], Boolean(msg.truncated));
        break;
      case "branch.result":
      case "import.result": {
        this.branching = false;
        if (msg.error) {
          this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: tr("{p1}失败：{p2}", { p1: msg.type === "import.result" ? "导入" : "分叉 / 复制", p2: msg.error }), level: "error" });
          break;
        }
        const id = String(msg.sessionId ?? "");
        if (!id) break;
        this.closeSheet();
        this.openSession(id);
        if (typeof msg.text === "string" && msg.text.trim()) this.putInComposer(msg.text);
        // Said once the new session's snapshot is in: the snapshot resets the transcript.
        this.afterOpen = {
          id,
          text: msg.type === "import.result" ? tr("已导入，这是导入的会话。") : msg.text ? tr("已分叉成新会话，原来那条消息放回了输入框。") : tr("已复制成新会话。"),
        };
        break;
      }
      case "queue.restore": {
        // Stop cleared pi's queue (#9): like the terminal's Esc, the unsent text comes back to the editor.
        if (msg.sessionId !== this.currentId) break;
        const texts = Array.isArray(msg.texts) ? msg.texts.map(String).filter((t: string) => t.trim()) : [];
        if (texts.length) this.putInComposer(texts.join("\n\n"));
        break;
      }
      case "pi.status":
        if (this.session && this.session.id === msg.sessionId) this.session = { ...this.session, running: msg.running };
        if (msg.sessionId === this.currentId) {
          if (msg.running) {
            this.runSince = Date.now();
            this.activity = tr("思考中");
            // Q-024: the hover card says "本轮第 N 次工具调用", so N is per run and starts over here.
            this.stepCount = 0;
          } else this.activity = "";
          this.fillHintStatus();
          // 跑着 ↔ 空闲是「继续」按钮亮/灰的翻转点（D159）。
          this.syncContinueButton();
          // 任务结束才问「要不要把这一轮的错误记下来」（D164）。
          this.syncFailCta();
          if (this.textarea) this.textarea.placeholder = this.composerHintText();
        }
        if (!msg.running) this.turnAt = null;
        this.renderTop();
        this.renderSessions();
        this.fillModelChip();
        break;
      case "manage": {
        // #189：先留一份「回声之前的归档集合」—— 只有本次新变归档的那批才可能触发切邻居。
        const wasArchived = new Set(this.manage.archived);
        if (msg.manage) this.manage = msg.manage as ManageState;
        if (msg.workspace) this.workspaces = msg.workspace as WorkspaceState;
        this.switchAfterArchive(wasArchived);
        this.renderSessions();
        this.renderNowChip();
        break;
      }
      // #94：桥侧每次改名 / 拖动 / 建组都会广播一份完整快照。同名快照可能重复到，但重画很便宜。
      case "workspaces": {
        const before = new Set(this.workspaces.groups.map((g) => g.id));
        this.workspaces = (msg.workspace as WorkspaceState) ?? { groups: [], overrides: {}, keys: {} };
        // #100：刚点的「新建工作区」回来了 —— 空组已经进树，接着让人给它起个名字。
        if (this.wsCreatePending) {
          const born = this.workspaces.groups.find((g) => g.manual && !before.has(g.id));
          if (born) {
            this.wsCreatePending = false;
            this.wsRenameId = born.id;
            this.wsRenameDraft = "";
            this.wsRenameFocus = true;
            // #175：从横条 ＋ 建的组：画横条时核一眼它在不在 ＋N 里（在就说一声，免得像没建成）。
            if (this.wsCreateFromTabs) this.wsNewNoteId = born.id;
          }
          this.wsCreateFromTabs = false;
        }
        this.renderNowChip();
        this.renderSessions();
        // #123：设置面板开着时，名额也跟着桥的快照对齐（校验发生在桥，页面只是镜子）。
        if (this.sheetKind === "display") this.paintWsTabsPane();
        break;
      }
      case "session.gone": {
        const gone = new Set<string>((msg.ids ?? []) as string[]);
        this.sessions = this.sessions.filter((s) => !gone.has(s.id));
        for (const id of gone) this.mgrPicked.delete(id);
        if (this.renameId && gone.has(this.renameId)) {
          this.renameId = null;
          this.renameDraft = "";
        }
        for (const id of gone) this.drafts.delete(id);
        this.persistDrafts();
        if (this.currentId && gone.has(this.currentId)) {
          this.currentId = null;
          this.session = null;
          this.composerText = "";
          this.images = [];
          this.pastes = [];
          this.chat.reset([]);
          this.renderAll();
          this.go("sessions", true);
        } else {
          this.renderSessions();
        }
        break;
      }
      case "delete.result": {
        // The sheet covers the transcript, so a failed/skipped delete is reported inside the sheet.
        const removed: string[] = Array.isArray(msg.removed) ? msg.removed.map(String) : [];
        const skipped: DeleteReport["skipped"] = Array.isArray(msg.skipped) ? msg.skipped : [];
        const parts: string[] = [];
        if (removed.length) parts.push(tr("已移入垃圾箱 {p1} 个", { p1: removed.length }));
        if (skipped.length) {
          const names = skipped.slice(0, 3).map((s: DeleteReport["skipped"][number]) => tr("{p1}（{p2}）", { p1: s.name, p2: s.reason })).join(tr("、"));
          parts.push(tr("{p1} 个没删：{p2}{p3}", { p1: skipped.length, p2: names, p3: skipped.length > 3 ? " 等" : "" }));
        }
        this.mgrNote = parts.join(" · ");
        this.mgrRefresh?.();
        break;
      }
      case "trash": {
        this.trash = Array.isArray(msg.items) ? (msg.items as TrashItem[]) : this.trash;
        this.renderBinCount();
        this.mgrRefresh?.();
        break;
      }
      case "restore.result": {
        const restored: string[] = Array.isArray(msg.restored) ? msg.restored.map(String) : [];
        const skipped: { id: string; reason: string }[] = Array.isArray(msg.skipped) ? msg.skipped : [];
        const parts: string[] = [];
        if (restored.length) parts.push(tr("已还原 {p1} 个", { p1: restored.length }));
        if (skipped.length) parts.push(tr("{p1} 个没还原：{p2}", { p1: skipped.length, p2: skipped.slice(0, 3).map((s) => s.reason).join("、") }));
        this.mgrNote = parts.join(" · ");
        this.mgrRefresh?.();
        break;
      }
      case "purge.result": {
        const purged: string[] = Array.isArray(msg.purged) ? msg.purged.map(String) : [];
        this.mgrNote = purged.length ? tr("已彻底删除 {p1} 个", { p1: purged.length }) : tr("垃圾箱里没有可删除的东西");
        this.mgrRefresh?.();
        break;
      }
      case "sessions.list": {
        this.sessions = Array.isArray(msg.sessions) ? msg.sessions : this.sessions;
        if (msg.workspace) this.workspaces = msg.workspace as WorkspaceState;
        this.renderSessions();
        this.mgrRefresh?.();
        break;
      }
      case "session.state":
        this.mergeSession(msg.session);
        break;
      case "notice":
        // A failed create comes back as an untargeted error notice: show it in the dialog instead.
        if (this.creating && !msg.sessionId && msg.level === "error") {
          this.creating.finish(msg.code ? errText(msg) : String(msg.text ?? tr("启动失败")));
          break;
        }
        if (this.claiming && msg.level === "error" && (!msg.sessionId || msg.sessionId === this.claiming)) this.endClaim();
        // D110：`code` 存在时按语言渲染，否则显示 bridge 给的原句（多数是 pi 产出的文本）。
        if (!msg.sessionId || msg.sessionId === this.currentId) this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text: msg.code ? errText(msg) : msg.text, level: msg.level ?? "info" });
        break;
      case "term.opened": {
        this.addTermTab(String(msg.id ?? ""), String(msg.shell ?? "shell"), String(msg.cwd ?? ""));
        break;
      }
      case "term.list": {
        if (Array.isArray(msg.shells)) this.termShells = msg.shells.map((x: { id?: unknown; label?: unknown }) => ({ id: String(x.id ?? ""), label: String(x.label ?? x.id ?? "") }));
        // D70: the shells outlive the page. Adopt whatever the bridge still has, then replay each.
        const items = Array.isArray(msg.items) ? (msg.items as { id?: unknown }[]) : [];
        for (const item of items) if (item?.id) this.socket.send({ type: "term.attach", id: String(item.id) });
        break;
      }
      case "term.replay": {
        const id = String(msg.id ?? "");
        const view = this.termTabs.get(id) ?? this.addTermTab(id, String(msg.shell ?? "shell"), String(msg.cwd ?? ""));
        // Replay is the whole buffer: reset first or a reconnect appends the history twice.
        view.term.reset();
        view.term.write(String(msg.data ?? ""));
        break;
      }
      case "term.data": {
        this.termTabs.get(String(msg.id ?? ""))?.term.write(String(msg.data ?? ""));
        break;
      }
      case "term.exit": {
        this.termTabs.get(String(msg.id ?? ""))?.term.write(tr("\r\n[进程已退出，exit {p1}]\r\n", { p1: Number(msg.code ?? 0) }));
        break;
      }
      case "term.gone": {
        this.closeTermTab(String(msg.id ?? ""), false);
        break;
      }
      case "term.error": {
        // 那个 shell 没开成：把在飞的标记清掉，不然按钮会以为还有一次在启动中。
        this.termWantAt = 0;
        this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: String(msg.message ?? tr("终端启动失败")), level: "error" });
        break;
      }
      case "need-stepup":
        // Our window and the bridge's disagreed (e.g. after a reconnect): that write was dropped.
        this.stepUntil = 0;
        this.stepResync = true;
        this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text: tr("口令验证已过期，刚才的操作没有执行，验证后请重做一次"), level: "warn" });
        this.askStepUp();
        break;
      case "stepup-ok":
        // Own clock with a margin, so we re-ask a little before the bridge would refuse.
        this.stepUntil = Date.now() + 9 * 60 * 1000;
        this.closeModal();
        for (const run of this.pending.splice(0)) run();
        if (this.stepResync && this.currentId) this.socket.send({ type: "subscribe", sessionId: this.currentId });
        this.stepResync = false;
        break;
      case "mkdir.result":
      case "mkfile.result": {
        const done = this.mkWaits.get(String(msg.reqId ?? ""));
        this.mkWaits.delete(String(msg.reqId ?? ""));
        done?.({ path: msg.path, error: msg.error });
        break;
      }
      case "tunnel":
        this.tunnel = msg.tunnel;
        this.renderTop();
        this.renderQueue();
        break;
      default:
        break;
    }
  }

  private mergeSession(state: SessionState | undefined): void {
    if (!state) return;
    // #86：随手问不在会话列表里。桥已经把它从 list() 里滤掉了，这里是第二道（
    // session.state 是广播的，任何一条都不能把它塞回侧栏）。
    if (state.scratch) return;
    // Set before renderChat below, which runs when `owned` flips.
    if (state.owned && state.id === this.claiming) this.claiming = null;
    const idx = this.sessions.findIndex((s) => s.id === state.id);
    // Spread: live updates may omit list-only fields such as the preview.
    if (idx >= 0) this.sessions[idx] = { ...this.sessions[idx], ...state };
    else this.sessions.unshift(state);
    if (this.currentId === state.id) {
      const prev = this.session;
      this.session = state;
      // Q-021: 一轮结束正是模型可能刚跑完 `git checkout` 的时刻。
      if (prev?.running && !state.running) void this.refreshGit(true);
      // The writer bar (接管 / 停止运行) and the status line both hang off these two flags.
      if (prev?.owned !== state.owned || prev?.origin !== state.origin || prev?.starting !== state.starting) this.renderChat();
      else {
        this.fillHintStatus();
        // 上面那条 else 走的就是「flags 变了但不用重画」：`starting` / 闲忙都可能在这里翻，「继续」跟着刷。
        this.syncContinueButton();
        this.syncBgBar();
      }
    }
    this.renderTop();
    this.renderSessions();
  }

  /**
   * "Looking" = this tab is visible and its window has focus. Measured a tick later: during a
   * blur caused by clicking into the preview iframe, focus has not landed anywhere yet.
   */
  private reportPresence(): void {
    setTimeout(() => {
      if (!this.connected) return;
      this.socket.send({ type: "presence", active: document.visibilityState === "visible" && document.hasFocus() });
    }, 0);
  }

  /** D156：把一条待办事件记到列表里那行上（`onMessage` 的 `msg` 是 any，这里统一成字符串）。 */
  private countPending(sessionId: unknown, kind: PendingKind, delta: number): void {
    applyPending(this.sessions, String(sessionId ?? ""), kind, delta);
  }

  /** 当前会话自己的两份队列长度（`badgeSession` 用）。 */
  private localCounts(): PendingCounts {
    return { approvals: this.approvals.length, asks: this.asks.length };
  }

  /**
   * 徽标唯一的一颗元素。D170：「后台」那枚能点开详情（其它徽标还是纯提示），
   * 点它不能顺带把卡片/胶囊自己的「打开这个会话」也触发，所以一律 stopPropagation。
   */
  private badgeChip(s: SessionState): HTMLElement | null {
    const badge = this.badgeOf(s);
    if (!badge) return null;
    const chip = el("span", `badge ${badge.cls}`, badge.text);
    if (badge.title) chip.title = badge.title;
    if (badge.kind !== "bg") return chip;
    chip.classList.add("clickable");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    const open = (ev: Event) => {
      ev.stopPropagation();
      this.closeWsPop();
      this.openBgSheet(s.id);
    };
    chip.onclick = open;
    chip.onkeydown = (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      open(ev);
    };
    return chip;
  }

  /**
   * 徽标唯一入口（D156）：当前会话的待处理数以本地队列为准（`badgeSession`），别的会话读列表里
   * 那份事件累加值。左栏卡片、钉条胶囊、管理面板、顶栏那颗都走这里，省得哪一处又读到旧账。
   * 刚 `openSession`、快照还没回来时本地队列是空的（`pendingFresh` 为 false），此时退回列表里
   * 那份 —— 否则切到一个「正等着你」的会话，徽标会先闪没一拍。
   */
  private badgeOf(s: SessionState): SessionBadge | null {
    const shown = this.pendingFresh ? badgeSession(s, this.currentId, this.localCounts()) : s;
    return sessionBadge(shown);
  }

  // ---------------------------------------------------------------- step-up
  private askStepUp(): void {
    if (document.querySelector(".modal")) return;
    const modal = el("div", "modal hi");
    const form = el("form");
    const h = el("h2", "", tr("再验一次口令"));
    h.style.margin = "0";
    h.style.fontSize = "16px";
    const p = el("p", "", tr("公网访问下，写入和批准前要重新验一次口令（10 分钟内免重复）。"));
    p.style.color = "var(--faint)";
    p.style.fontSize = "13px";
    p.style.margin = "0";
    const input = el("input");
    input.type = "password";
    input.autocomplete = "current-password";
    input.placeholder = tr("口令");
    const err = el("div", "err");
    const submit = el("button", "btn primary", tr("继续"));
    submit.type = "submit";
    form.append(h, p, input, err, submit);
    modal.append(form);
    modal.onclick = (ev) => {
      if (ev.target !== modal) return;
      // Dismissed: whatever was waiting for the passphrase is abandoned, not sent later.
      this.pending = [];
      this.closeModal();
    };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      this.socket.send({ type: "stepup", passphrase: value });
    };
    this.overlay(modal);
    input.focus();
  }

  private closeModal(): void {
    document.querySelector(".modal")?.remove();
  }

  // ---------------------------------------------------------------- actions
  private sendPrompt(behavior: "steer" | "followUp" = "steer"): void {
    if (!this.currentId) return;
    // 启动中的 pi 收不了 prompt：与其发出去石沉大海，不如什么都不做（输入框本来就是禁用的）。
    if (this.session?.starting) return;
    const typed = this.composerText.trim();
    const pasted = this.pastes.map((p) => p.text.trim()).filter(Boolean);
    const text = [...pasted, typed].filter(Boolean).join("\n\n");
    if (!text && !this.images.length) return;
    if (typed && !pasted.length && !this.images.length && this.answerFromComposer(typed)) return;
    if (typed && !pasted.length && !this.images.length && this.runBuiltinCommand(typed)) return;
    // `/skill:<name>` at the head of what pi receives is exactly what pi expands (agent-session
    // `_expandSkillCommand`), no matter which entry point produced it: the palette, the `/` menu,
    // or typing it out. Counted here rather than at pick time — a command that never got sent is
    // not a use, and the palette has to rank the ones that were.
    const skill = skillOf(text);
    // The bubble below is optimistic; the bridge echoes `clientId` back so this page adopts its own
    // broadcast instead of drawing the message twice (#19).
    const clientId = `local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const payload = { type: "prompt", sessionId: this.currentId, text, images: this.images, clientId, behavior };
    // Clear the composer only once the message really goes out: a dismissed step-up keeps the draft.
    this.act(() => {
      // The step-up modal may have sat in between: only clear the composer if we are still there.
      if (this.currentId === payload.sessionId) {
        this.composerText = "";
        this.images = [];
        this.pastes = [];
        this.chat.add({ id: clientId, kind: "user", text: text || tr("（图片）"), images: [], ...(skill ? { skill } : {}), ts: new Date().toISOString() });
        this.renderChat();
      }
      if (payload.sessionId) this.drafts.delete(payload.sessionId);
      this.persistDrafts();
      if (skill && payload.sessionId) this.countSkillUse(skill, payload.sessionId);
      this.socket.send(payload);
    });
    if (navigator.storage?.persist) void navigator.storage.persist();
  }

  /**
   * Usage drives the palette's order (bridge `skill-usage.json`, plus the local copy so the next
   * open is already re-ranked). Every explicit `/skill:<name>` send counts, whichever input made it.
   */
  private countSkillUse(name: string, sessionId: string): void {
    const known = this.skills.find((s) => s.name === name);
    if (known) {
      known.uses += 1;
      known.lastUsed = Date.now();
    }
    this.socket.send({ type: "skillUsed", sessionId, name });
  }

  /**
   * pi's terminal-only commands (`/tree`, `/export`, `!cmd` …) are not commands over RPC: sent as a
   * prompt they reach the model as plain text (agent-session.js only runs extension commands and
   * expands /skill: and templates). Do what the page can, refuse the rest without sending (#22).
   * Returns true when the input was consumed here.
   */
  private runBuiltinCommand(typed: string): boolean {
    const sessionId = this.currentId;
    if (!sessionId) return false;
    const say = (text: string, level: "info" | "warn" = "info") =>
      this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text, level });
    const done = () => {
      this.composerText = "";
      if (this.textarea) this.textarea.value = "";
      this.noteDraft();
      this.fitComposer();
      return true;
    };
    if (typed.startsWith("!")) {
      // `!cmd`: output joins the context on the next message; `!!cmd`: kept out of it (#16).
      const exclude = typed.startsWith("!!");
      const command = typed.slice(exclude ? 2 : 1).trim();
      if (!command) return false;
      this.act(() => this.socket.send({ type: "bash", sessionId, command, excludeFromContext: exclude }));
      return done();
    }
    const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(typed);
    if (!m) return false;
    const [, name, rest = ""] = m;
    const arg = rest.trim();
    const owned = Boolean(this.session?.owned);
    switch (name) {
      case "new":
        this.openNewSessionSheet();
        return done();
      case "resume":
        this.go("sessions");
        if (this.collapsed.sessions) this.togglePane("sessions");
        return done();
      case "model":
        this.openModelSheet();
        return done();
      case "thinking": {
        if (!arg) {
          this.openModelSheet();
          return done();
        }
        if (!owned) {
          say(tr("先接管这个会话，再切换思考档位。"), "warn");
          return true;
        }
        this.act(() => this.socket.send({ type: "setThinking", sessionId, level: arg }));
        return done();
      }
      case "name":
        if (!arg) say(tr("当前会话名：{p1}", { p1: this.session?.name || "（未命名）" }));
        else this.applyRename(sessionId, arg);
        return done();
      case "compact":
        if (!owned) {
          say(tr("先接管这个会话，再压缩上下文。"), "warn");
          return true;
        }
        this.act(() => this.socket.send({ type: "compact", sessionId, instructions: arg || undefined }));
        return done();
      case "hotkeys":
        this.openKeysSheet();
        return done();
      case "session":
        this.openModelSheet(true);
        this.sheet?.querySelector(".session-info")?.scrollIntoView({ block: "start" });
        return done();
      case "tree":
      case "fork":
        // The terminal's /fork is a picker over the user messages; the tree sheet is that picker.
        this.openTreeSheet();
        return done();
      case "clone":
        this.cloneSession();
        return done();
      case "import":
        if (!arg) {
          say(tr("用法：/import <会话 .jsonl 文件的完整路径>"), "warn");
          return true;
        }
        this.act(() => this.socket.send({ type: "import", path: arg }));
        return done();
      case "settings":
      case "scoped-models":
        this.openSettingsSheet("global");
        return done();
      case "trust":
        this.openSettingsSheet("trust");
        return done();
      case "changelog":
        this.openSettingsSheet("changelog");
        return done();
      case "share":
        this.openShareSheet();
        return done();
      case "bug":
        this.openBugSheet(arg);
        return done();
      case "login":
      case "logout":
        this.authFilter = arg;
        this.openSettingsSheet("login");
        return done();
      case "reload":
        if (!owned) {
          say(tr("这个会话没在网页里运行：下次接管时用的就是最新设置。"), "warn");
          return true;
        }
        this.act(() => this.socket.send({ type: "reload", sessionId }));
        return done();
      case "export":
        // pi's own HTML export, in a new tab (#24). `/export jsonl` downloads the raw session file.
        window.open(`/api/export?id=${encodeURIComponent(sessionId)}&format=${/jsonl/i.test(arg) ? "jsonl" : "html"}`, "_blank", "noopener");
        return done();
      case "debug":
        window.open(`/api/log?id=${encodeURIComponent(sessionId)}`, "_blank", "noopener");
        return done();
      case "copy": {
        const text = this.chat.lastAssistantText();
        if (!text) {
          say(tr("还没有可复制的回复。"), "warn");
          return true;
        }
        const copied = navigator.clipboard?.writeText(text);
        if (!copied) say(tr("这个地址拿不到剪贴板（http 的局域网地址浏览器不给），可以用回复右上角的 ⧉。"), "warn");
        else void copied.then(() => say(tr("已复制最后一条回复。")));
        return done();
      }
      case "quit":
      case "exit":
        say(tr("网页里不需要退出。要停掉这个会话的 pi 进程，点输入框下方的「释放会话 / 让回终端」。"));
        return done();
    }
    const pending = UNSUPPORTED_BUILTINS[name];
    if (!pending) return false; // extension commands, prompt templates, /skill:… go to pi
    say(tr("「/{p1}」在网页里还没有对应功能（{p2}），没有发给模型。", { p1: name, p2: pending }), "warn");
    return true;
  }

  /** Writes from a public (tunnel) page need a fresh step-up; queue them behind the modal. */
  private act(run: () => void): void {
    if (!this.me.public || Date.now() < this.stepUntil) {
      run();
      return;
    }
    this.pending.push(run);
    this.askStepUp();
  }

  private decide(approval: ApprovalRequest, decision: "approve" | "reject" | "always"): void {
    this.act(() => {
      this.socket.send({ type: "approve", sessionId: approval.sessionId, approvalId: approval.id, decision });
      this.approvals = this.approvals.filter((a) => a.id !== approval.id);
      this.renderApprovals();
      this.renderTabs();
    });
  }

  private async enablePush(): Promise<void> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      alert(tr("这个浏览器/地址不支持 Web Push（iOS 需要先「添加到主屏幕」）"));
      return;
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (!this.me.pushKey) {
      alert(tr("服务端没给 push 公钥"));
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // SAFETY: a VAPID key is a raw byte string, not text; TS types the array as string-based.
      applicationServerKey: urlBase64ToUint8Array(this.me.pushKey) as unknown as BufferSource,
    });
    await api.subscribe(sub.toJSON());
    alert(tr("已开启：需要你的时候会推到这个设备"));
  }

  /** Overlays live inside #app so they scale with the appearance zoom. */
  private overlay(node: HTMLElement): void {
    (document.getElementById("app") ?? document.body).append(node);
  }

  /**
   * D111: 文件预览与终端是两扇平等的浮窗，谁最后被点 / 聚焦谁在上面。同一时间只有一扇带 `.front`
   * （z-index 47），另一扇回落到自己的底值（预览 46 / 终端 45），所以不存在平手；整条层带仍在
   * 口令 modal（50）与底部 sheet（60）之下 —— 能盖住窗的只有真正的模态，不是另一扇窗。
   */
  private raiseWindow(win: HTMLElement | null): void {
    if (!win || !win.isConnected || this.winFront === win) return;
    this.winFront?.classList.remove("front");
    this.winFront = win;
    win.classList.add("front");
  }

  /** 指针落进窗里 / 焦点进了窗：把它抬到另一扇窗之上（iframe 的点击走 wire() 里的 blur）。 */
  private wireWindowRaise(win: HTMLElement): void {
    win.addEventListener("pointerdown", () => this.raiseWindow(win), true);
    win.addEventListener("focusin", () => this.raiseWindow(win));
  }

  /** Live rate from streamed characters; message_end replaces it with the authoritative count. */
  private trackChars(field: string, text: string): void {
    if (field !== "text" && field !== "thinking") return;
    if (this.turnAt == null) this.startTurn();
    for (const ch of text) {
      if (ch.codePointAt(0)! > 0x2e80) this.turnChars.cjk += 1;
      else this.turnChars.other += 1;
    }
    const now = performance.now();
    if (now - this.rateAt < 400) return;
    const secs = (now - (this.turnAt ?? now)) / 1000;
    if (secs < 0.3) return;
    const est = this.turnChars.cjk / 1.5 + this.turnChars.other / 4;
    if (est < 1) return;
    this.rate = est / secs;
    this.rateAt = now;
    this.fillModelChip();
  }

  private startTurn(): void {
    this.turnAt = performance.now();
    this.turnChars = { cjk: 0, other: 0 };
  }

  private setActivity(text: string): void {
    if (this.activity === text) return;
    // Q-024: the step counter is bumped in the tool branch now. Counting here relied on the text
    // changing every call, which stopped being true once the line dropped the command summary.
    this.activity = text;
    this.fillHintStatus();
  }

  /**
   * Q-021: ask the bridge which branch this session's cwd is on. No session / empty cwd / not a
   * repository all land on `null`, which means "keep the key hints" — never an empty placeholder.
   * Called on 切会话, on 一轮结束, on window focus, and once at boot.
   */
  private async refreshGit(fresh = false): Promise<void> {
    const cwd = (this.session?.cwd ?? "").trim();
    if (!cwd) {
      this.git = null;
      this.gitCwd = "";
      this.fillHintStatus();
      return;
    }
    if (this.gitCwd !== cwd) {
      // Don't keep showing the previous session's branch while this answer is in flight.
      this.git = null;
      this.gitCwd = cwd;
      this.fillHintStatus();
    }
    let info: GitInfo | null = null;
    try {
      info = await api.git(cwd, fresh);
    } catch {
      info = null;
    }
    // Switching sessions mid-flight: a late answer for the old cwd must not land.
    if ((this.session?.cwd ?? "").trim() !== cwd) return;
    this.git = info;
    this.gitCwd = cwd;
    this.fillHintStatus();
  }

  private gitKey(git: GitInfo | null): string {
    return git ? `${git.branch}|${git.dirty}|${git.detached}|${git.empty}` : "";
  }

  /**
   * Q-021: `⎇ main` takes the slot the key hints used to hold. The hints are not gone — they move
   * into the title, because Shift+Enter is the one shortcut nobody finds by accident alone.
   */
  private gitChip(git: GitInfo, flat = false): HTMLButtonElement {
    const label = git.branch || (git.empty ? tr("(无提交)") : tr("(未知)"));
    const chip = el("button", flat ? "git-chip flat" : "git-chip") as HTMLButtonElement;
    chip.type = "button";
    chip.dataset.act = "git";
    chip.dataset.key = this.gitKey(git);
    chip.append(el("span", "git-glyph", "⎇"), el("span", "git-branch", label));
    if (git.dirty) chip.append(el("span", "git-dot", ""), el("span", "git-count", String(git.dirty)));
    if (git.detached) chip.append(el("span", "git-tag", "detached"));
    const lines = [tr("⎇ {p1}{p2}", { p1: label, p2: git.dirty ? tr(" · {p1} 个未提交改动", { p1: git.dirty }) : "" })];
    if (git.detached) lines.push(tr("detached HEAD：不在任何分支上"));
    if (git.empty) lines.push(tr("仓库里还没有提交"));
    lines.push(git.repo, "", tr("Enter 发送 · Shift+Enter 换行 · {p1} 粘贴截图", { p1: PASTE_KEY }), tr("点一下复制分支名"));
    chip.title = lines.join("\n");
    chip.onclick = () => {
      // `navigator.clipboard` is undefined over plain http:// on a LAN address — optional chaining has
      // to wrap the call, not just the property, or the reply lands as a TypeError.
      const copy = navigator.clipboard?.writeText(git.branch || label);
      if (!copy) return;
      const shown = chip.querySelector<HTMLElement>(".git-branch");
      const back = shown?.textContent ?? "";
      void copy
        .then(() => {
          if (!shown) return;
          shown.textContent = tr("已复制");
          setTimeout(() => {
            if (shown.isConnected && shown.textContent === tr("已复制")) shown.textContent = back;
          }, 900);
        })
        .catch(() => {});
    };
    return chip;
  }

  /** The line under the composer: what pi is doing and for how long, or the key hints when idle. */
  /**
   * Q-029: the card is a peek, not a panel — it opens the moment the pointer arrives, closes again
   * if the pointer leaves before you have had a chance to read it (3 seconds), and only then becomes
   * sticky: after that it survives the pointer leaving and goes away on a click outside it (or Esc).
   */
  private wireHintPeek(): void {
    // Q-029 follow-up: hovering the *words* opens the card, not the whole strip — the status row
    // spans the composer's full width, so binding the row meant the card popped up whenever the
    // pointer crossed the bottom of the chat area. The hover targets are set up by wirePeekTarget().
    if (this.peekWired) return;
    this.peekWired = true;
    // Document-level listeners are bound once: renderChat() rebuilds the composer (and this line
    // with it), and a listener per rebuild would leave detached boxes behind — every click would
    // then look like an "outside" click on some stale copy. The live element is looked up instead.
    document.addEventListener("pointerdown", (ev) => {
      if (!this.peekOpen) return;
      const live = this.hintStatus;
      const target = ev.target as Node | null;
      if (live && target && live.contains(target)) return;
      this.closeHintPeek();
    }, true);
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.closeHintPeek();
    });
  }

  /** One of the bits that count as "the thing you are pointing at": label, clock, or the card. */
  private wirePeekTarget(target: HTMLElement): void {
    if (target.dataset.peekWired) return;
    target.dataset.peekWired = "1";
    target.addEventListener("pointerenter", () => {
      if (this.runSince == null) return;
      if (this.peekGrace) { window.clearTimeout(this.peekGrace); this.peekGrace = 0; }
      if (this.peekOpen) return;
      this.peekOpen = true;
      this.peekSticky = false;
      this.fillHintStatus();
      if (this.peekTimer) window.clearTimeout(this.peekTimer);
      this.peekTimer = window.setTimeout(() => {
        this.peekTimer = 0;
        // Staying this long means the user is reading: don't yank it away when they move off.
        if (this.peekOpen) this.peekSticky = true;
      }, PEEK_DELAY_MS);
    });
    // Leaving early closes it — after a short grace, so hopping between the label, the clock and the
    // card (a few pixels apart) doesn't count as "moved away".
    target.addEventListener("pointerleave", () => {
      if (!this.peekOpen || this.peekSticky || this.peekGrace) return;
      this.peekGrace = window.setTimeout(() => {
        this.peekGrace = 0;
        if (!this.peekSticky) this.closeHintPeek();
      }, PEEK_GAP_MS);
    });
  }

  private closeHintPeek(): void {
    if (this.peekTimer) window.clearTimeout(this.peekTimer);
    if (this.peekGrace) window.clearTimeout(this.peekGrace);
    this.peekTimer = 0;
    this.peekGrace = 0;
    if (!this.peekOpen) return;
    this.peekOpen = false;
    this.peekSticky = false;
    this.fillHintStatus();
  }

  private fillHintStatus(): void {
    this.paintHintStatus();
    const box = this.hintStatus;
    if (!box || !this.cwdChip) return;
    // 状态行是整块重画的（`replaceChildren`），所以每次都要把路径接回最前面 —— 顺序就是「路径 · 分支」。
    box.prepend(this.cwdChip);
  }

  private paintHintStatus(): void {
    const box = this.hintStatus;
    if (!box) return;
    // pi 还在启动（扩展在它内部加载，本机实测约 8 秒）：这比「按 Enter 发送」有用得多，
    // 也是「新会话为什么慢」在界面上的那一半答案。
    if (this.session?.starting) {
      box.className = "hint-status starting";
      box.replaceChildren(el("span", "act-spin"), el("span", "", tr("pi 正在启动（加载扩展，通常几秒）…")));
      return;
    }
    const running = Boolean(this.session?.running);
    const git = this.gitCwd === (this.session?.cwd ?? "").trim() ? this.git : null;
    if (!running) {
      this.runSince = null;
      // Q-029: a card must not outlive the run it describes — close it and drop its timers.
      if (this.peekTimer) window.clearTimeout(this.peekTimer);
      if (this.peekGrace) window.clearTimeout(this.peekGrace);
      this.peekTimer = 0;
      this.peekGrace = 0;
      this.peekOpen = false;
      this.peekSticky = false;
      box.className = "hint-status";
      // Q-021: in a repository the branch replaces the key hints (they live in the chip's title).
      if (git) {
        box.replaceChildren(this.gitChip(git));
        return;
      }
      box.replaceChildren(el("kbd", "", "Enter"), el("span", "", tr("发送 · Shift+Enter 换行 · ")), el("kbd", "", PASTE_KEY), el("span", "", tr(" 粘贴截图")));
      return;
    }
    if (this.runSince == null) this.runSince = Date.now();
    const waiting = this.asks.length ? tr("等你回答上面的问题") : this.approvals.length ? tr("等你批准") : "";
    const what = waiting || this.activity || tr("运行中");
    let spin = box.querySelector<HTMLElement>(".act-spin");
    let text = box.querySelector<HTMLElement>(".act-text");
    let time = box.querySelector<HTMLElement>(".act-time");
    if (!spin || !text || !time) {
      spin = el("span", "act-spin");
      text = el("span", "act-text");
      time = el("span", "act-time");
      const stop = el("button", "btn danger", tr("中断"));
      stop.dataset.act = "interrupt";
      stop.title = tr("中断当前回复");
      stop.onclick = () => this.act(() => this.socket.send({ type: "abort", sessionId: this.currentId }));
      box.replaceChildren(spin, text, time, stop);
      // Q-029: only the label, the clock and the card are hover targets — not the rest of the row.
      this.wirePeekTarget(text);
      this.wirePeekTarget(time);
    }
    box.className = `hint-status busy${waiting ? " wait" : ""}${this.peekOpen ? " peek" : ""}`;
    text.textContent = what;
    text.title = "";
    const secs = Math.max(0, Math.round((Date.now() - this.runSince) / 1000));
    const dur = secs >= 60 ? tr("{p1}分{p2}秒", { p1: Math.floor(secs / 60), p2: String(secs % 60).padStart(2, "0") }) : tr("{p1}秒", { p1: secs });
    time.textContent = dur;
    // Q-021: 运行态以运行信息为主，分支只是一枚扁平尾标 —— 窄了它先被省略，撑不掉「正在执行 …」。
    const chip = box.querySelector<HTMLElement>(".git-chip");
    if (git) {
      if (chip?.dataset.key !== this.gitKey(git)) {
        const next = this.gitChip(git, true);
        if (chip) chip.replaceWith(next);
        else box.append(next);
      }
    } else chip?.remove();
    // Hover detail: the whole activity string, not the truncated one in the line itself.
    let pop = box.querySelector<HTMLElement>(".act-pop");
    if (!pop) {
      pop = el("div", "act-pop");
      box.append(pop);
      this.wirePeekTarget(pop);
    }
    // Q-017: everything the run has already handed us — the tool, its args, the output so far and
    // the thinking tail. All of it is local state; the protocol is untouched.
    const live = this.chat.liveInfo();
    // Waiting beats "thinking": the line and the card must never disagree about what is happening.
    const headline = waiting ? (this.approvals.length ? `${waiting} · ${this.approvals[0].title}` : waiting) : this.activity || what;
    const rows: HTMLElement[] = [el("div", "act-pop-main", headline)];
    const row = (label: string, value: string, cls = ""): HTMLElement => {
      const line = el("div", `act-pop-row${cls ? ` ${cls}` : ""}`);
      line.append(el("span", "act-pop-label", label), el("span", "act-pop-val", value));
      return line;
    };
    if (live.name) rows.push(row(tr("工具"), [live.name, live.summary].filter(Boolean).join(" · ")));
    const args = oneLine(live.args ?? "", 220);
    if (args) rows.push(row(tr("参数"), args, "args"));
    const output = tailText(live.output ?? "", 6, 420);
    if (output) rows.push(row(tr("输出"), output, "out"));
    const thinking = tailText(live.thinking ?? "", 3, 240);
    if (thinking) rows.push(row(tr("思考"), thinking, "think"));
    rows.push(el("div", "act-pop-meta", tr("已运行 {p1}{p2}", { p1: dur, p2: this.stepCount > 1 ? tr(" · 本轮第 {p1} 次工具调用", { p1: this.stepCount }) : "" })));
    pop.replaceChildren(...rows);
  }

  /** usage.output is the whole message's output tokens, so this is the average over the turn. */
  private settleRate(usage: any): void {
    const out = Number(usage?.output ?? 0);
    if (!out || this.turnAt == null) return;
    const secs = Math.max(0.3, (performance.now() - this.turnAt) / 1000);
    this.rate = out / secs;
    this.turnAt = null;
    this.fillModelChip();
  }

  // ---------------------------------------------------------------- appearance
  private applyPrefs(): void {
    const root = document.documentElement.style;
    root.setProperty("--ui-scale", String(this.prefs.scale));
    this.syncCompact();
    const accent = ACCENTS[this.prefs.accent] ?? ACCENTS[DEFAULT_PREFS.accent];
    root.setProperty("--accent", accent.accent);
    root.setProperty("--accent-dim", accent.dim);
    // D158：三档文字颜色（--text/--dim/--faint）只有 styles.css 里 [data-text] 那一份，这里只标档位。
    // 读回来时 readPrefs 已经按 TEXT_STEPS 校验过，不会给 CSS 一个没有对应规则的值。
    document.documentElement.dataset.text = this.prefs.text;
    // #97：布局也是外观偏好，但「哪一种壳」影响的是行与列的摆法，#98 还要在自己的 CSS 里挑壳。
    // 存的值原样留在 prefs 里，这里只标出这一版真正画出来的那一种（见 layout.ts 的 activeLayout）。
    this.paintLayout();
    // D93: 终端 dialog 的几何按缩放换算，改了字号 / 缩放后得重新夹一次（不然 pinned 的那块会溢出）。
    if (this.termDock) this.applyTermGeom(this.termDock);
  }

  /** 布局 id 落到 `<html data-layout>`：渲染 CSS 与探针都从这里读，不用去翻 prefs。 */
  private paintLayout(): void {
    document.documentElement.dataset.layout = activeLayout(this.prefs);
    this.paintShell();
  }

  /**
   * #98：四套壳共用同一套交互内核，壳与壳之间只有「哪几块拼在一起」不同（`shellParts()`）。
   * 这里只做换壳时那几件与数据无关的动作：那颗换个挂载点、浮层关掉、重摆行与列。
   * build() 之前调用（构造里先跑一次 applyPrefs）只有 `<html data-layout>` 有意义。
   */
  private paintShell(): void {
    // 换壳 = 锚点换位置：那张浮层留着只会飘在旧地方。
    this.closeWsPop();
    this.placeNowChip();
    this.placeWsTabs();
    // 构造里 `applyPrefs()` 先跑一次（那时 DOM 还没搭）：只落 `<html data-layout>`，别去碰 els。
    if (!this.nowBtn) return;
    this.renderPanes();
  }

  /**
   * 「当前在哪」那颗停在哪：A 桌面版在行 2 的左端，B/C/D 在顶栏；**窄屏一律进顶栏** ——
   * 窄屏下四套都没有第二行（会话是一页 tab），那颗不进顶栏就等于消失了。
   */
  private placeNowChip(): void {
    const parts = shellParts(activeLayout(this.prefs));
    const narrow = this.compact();
    const slot = parts.chipTop || narrow ? this.nowSlotTop : this.nowSlotRow;
    if (!this.nowBtn || !slot) return;
    if (this.nowBtn.parentElement !== slot) slot.append(this.nowBtn);
    this.nowBtn.dataset.open = parts.chipOpensOverlay && !narrow ? "1" : "0";
  }

  /**
   * 工作区标签行停在哪（#119）：A 的顶栏并成一行 —— 标签接管第一行，紧跟在折叠左栏的 `◧` 后面，
   * 会话名 / 顶栏那串小字 / 连接状态点在这一行由 CSS 藏掉。B/C/D 顶栏原样，标签行回到它自己那条
   * 网格行（`shellParts().tabsRow` 为假时它本来就不画）。和上面那颗同一个套路：换挂载点，不换组件。
   */
  private placeWsTabs(): void {
    const { wsTabsRow, topbar, sessionRow, collapseLeft } = this.els;
    if (!wsTabsRow || !topbar || !sessionRow) return;
    if (shellParts(activeLayout(this.prefs)).tabsRow) {
      if (wsTabsRow.parentElement !== topbar) topbar.insertBefore(wsTabsRow, collapseLeft?.nextSibling ?? topbar.firstChild);
      return;
    }
    const shell = sessionRow.parentElement;
    if (shell && wsTabsRow.parentElement !== shell) shell.insertBefore(wsTabsRow, sessionRow);
  }

  private openDisplaySheet(): void {
    this.closeSheet();
    this.sheetKind = "display";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };

    const sheet = el("div", "sheet display-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("外观与语言")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);

    // 语言放第一组：换语言是「整页立刻变样」的事，比字号更需要一眼找到（D110）。
    const langBox = el("div", "levels");
    langBox.append(el("div", "levels-label", tr("语言")));
    const langChips = el("div", "chips");
    for (const [code, label] of LANGS) {
      const chip = el("button", `chip${this.prefs.lang === code ? " on" : ""}`, label);
      chip.setAttribute("lang", code === "zh-Hans" ? "zh-Hans" : code);
      chip.onclick = () => this.setPrefLang(code);
      langChips.append(chip);
    }
    langBox.append(langChips);
    sheet.append(langBox);

    const sizeBox = el("div", "levels");
    const sizeRead = el("span", "size-read");
    const sizeHead = el("div", "size-head");
    sizeHead.append(el("div", "levels-label", tr("字号")), sizeRead);
    sizeBox.append(sizeHead);

    const rail = el("div", "size-rail");
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(SIZE_MIN);
    range.max = String(SIZE_MAX);
    range.step = String(SIZE_STEP);
    range.value = String(this.prefs.scale);
    range.setAttribute("aria-label", tr("字号"));

    // 标尺：每 0.1 一格，每 0.2 一格长的（和下面带数字的那七条对齐）。
    const ticks = el("div", "ticks");
    for (let i = 0; i * 0.1 <= SIZE_MAX - SIZE_MIN + 1e-9; i++) {
      const v = SIZE_MIN + i * 0.1;
      const major = i % 2 === 0;
      const tick = el("span", `tick${major ? " named" : " thin"}`);
      tick.dataset.v = v.toFixed(2);
      tick.style.left = `${sizePct(v) * 100}%`;
      ticks.append(tick);
    }
    rail.append(range, ticks);

    const marks = el("div", "size-marks");
    const markAt: number[] = [];
    for (let i = 0; i * 0.2 <= SIZE_MAX - SIZE_MIN + 1e-9; i++) markAt.push(SIZE_MIN + i * 0.2);
    markAt.forEach((v, i) => {
      const mark = el("button", `mark${i === 0 ? " first" : ""}${i === markAt.length - 1 ? " last" : ""}`, String(Math.round(v * 100)));
      mark.dataset.v = v.toFixed(2);
      mark.style.left = `${sizePct(v) * 100}%`;
      mark.title = `${Math.round(v * 100)}%`;
      mark.setAttribute("aria-label", `${Math.round(v * 100)}%`);
      mark.onclick = () => setScale(v, true);
      marks.append(mark);
    });

    const smallAa = el("span", "size-end s", "Aa");
    const bigAa = el("span", "size-end b", "Aa");
    smallAa.setAttribute("aria-hidden", "true");
    bigAa.setAttribute("aria-hidden", "true");
    const sizeCtl = el("div", "size-ctl");
    sizeCtl.append(smallAa, rail, bigAa, marks);
    sizeBox.append(sizeCtl);
    sheet.append(sizeBox);

    /** 把值抹到控件上（轨道填充 / 读数 / 刻度的「已过」状态 / 刻度字的高亮）。 */
    const paintSize = (v: number): void => {
      range.value = String(v);
      range.style.setProperty("--fill", `${sizePct(v) * 100}%`);
      range.setAttribute("aria-valuetext", `${Math.round(v * 100)}%`);
      sizeRead.textContent = `${Math.round(v * 100)}%`;
      sizeRead.classList.toggle("moved", Math.abs(v - 1) > 0.001);
      for (const t of ticks.children) {
        t.classList.toggle("past", Number((t as HTMLElement).dataset.v) < v - 0.001);
      }
      for (const m of marks.children) {
        m.classList.toggle("on", Math.abs(Number((m as HTMLElement).dataset.v) - v) < 0.001);
      }
    };

    const setScale = (v: number, save: boolean): void => {
      const next = clampScale(v);
      this.prefs = { ...this.prefs, scale: next };
      document.documentElement.style.setProperty("--ui-scale", String(next));
      // 拖动中也要判窄版：不判的话预告是假的（1.0 拖到 2.0 的路上一直是三栏，松手才突然变一栏），
      // 而抽屉的宽度不跟着窄版变（min(560px,100%)），所以冻住的轨道盒子不会在手指底下跑。
      // 跨过 900 的那一刻三栏已经换成单列，但 pane 的 hidden 是 JS 状态，必须顺手重排，
      // 否则松手前看到的是「三栏挤进一列」。
      if (this.syncCompact()) this.renderPanes();
      paintSize(next);
      if (!save) return;
      sizeDirty = false;
      savePrefs(this.prefs);
      // 整页换完再落一次（applyPrefs 顺带重夹终端几何、判窄版），只在松手/落档时跑。
      this.applyPrefs();
    };

    // 一帧只抹一次：--ui-scale 一变就是整页 zoom，input 事件比帧还密。
    let sizeFrame = 0;
    let sizeNext = this.prefs.scale;
    // 「有没有还没存盘的值」只能另记一笔：`setScale(..., false)` 自己就会把 prefs 改成新值，
    // 拿 prefs 比等于永远相等，松手那次 savePrefs 就再也走不到。
    let sizeDirty = false;
    const queueSize = (v: number): void => {
      sizeNext = v;
      sizeDirty = true;
      if (sizeFrame) return;
      sizeFrame = requestAnimationFrame(() => {
        sizeFrame = 0;
        // 抽屉中途被关掉（Esc / 点背景）时这一帧还没跑：直接丢掉，别对着已摘掉的控件改 prefs。
        if (!range.isConnected) return;
        setScale(sizeNext, false);
      });
    };

    /**
     * 拖的时候不能交给浏览器算值。`#app` 上是整棵树的 zoom，页一放大轨道跟着变宽变位，
     * 浏览器拿新几何重新除以指针坐标 —— 手指明明一直往右走，读数却越来越迟钝，2.0 拖不到。
     * 所以按下那一刻把轨道盒子冻住，之后一律按冻住盒子的百分比算；松手才写盘。
     */
    let dragBox: { x: number; w: number } | null = null;
    const valueAt = (clientX: number): number => {
      if (!dragBox || dragBox.w <= 0) return Number(range.value);
      const p = Math.min(1, Math.max(0, (clientX - dragBox.x) / dragBox.w));
      return SIZE_MIN + p * (SIZE_MAX - SIZE_MIN);
    };

    rail.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // 键盘要能接着用：preventDefault 会把焦点拦下来，鼠标拖完再按方向键就没反应了。
      // 先自己把焦点给 range，再拦浏览器那套（它算的是放大后的坐标）。
      range.focus({ preventScroll: true });
      const r = range.getBoundingClientRect();
      dragBox = { x: r.left, w: r.width };
      rail.classList.add("dragging");
      sizeRead.classList.add("dragging");
      rail.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      queueSize(snapSize(valueAt(ev.clientX)));
    });
    rail.addEventListener("pointermove", (ev) => {
      if (!dragBox) return;
      queueSize(snapSize(valueAt(ev.clientX)));
    });

    const commitSize = (): void => {
      if (sizeFrame) {
        cancelAnimationFrame(sizeFrame);
        sizeFrame = 0;
      }
      // 先把还没抹的那一帧落实。值只能从 sizeNext 拿：range.value 要 paintSize 才写，
      // 单击轨道时那一帧根本没跑，读它等于把刚才那一下丢掉（存进的是旧值）。
      if (!sizeDirty) return;
      setScale(sizeNext, false);
      sizeDirty = false;
      savePrefs(this.prefs);
      this.applyPrefs();
    };
    const endDrag = (): void => {
      if (!dragBox) return;
      dragBox = null;
      rail.classList.remove("dragging");
      sizeRead.classList.remove("dragging");
      commitSize();
    };
    rail.addEventListener("pointerup", endDrag);
    rail.addEventListener("pointercancel", endDrag);

    // 键盘：一下 1%，不吸附（吸附半径 1.2% 比步长大，吸上就再也出不来）。
    range.oninput = () => {
      if (dragBox) return;
      queueSize(Number(range.value));
    };
    range.addEventListener("keyup", () => { if (!dragBox) commitSize(); });
    range.addEventListener("blur", () => { if (!dragBox) commitSize(); });
    // 双击轨道回 100%：轨上没有「标准」这颗字了，得留一条回到原点的路。
    rail.addEventListener("dblclick", () => setScale(1, true));

    paintSize(this.prefs.scale);

    const colorBox = el("div", "levels");
    colorBox.append(el("div", "levels-label", tr("颜色")));
    const swatches = el("div", "swatches");
    for (const [id, label] of ACCENT_LABELS) {
      const sw = el("button", `swatch${this.prefs.accent === id ? " on" : ""}`);
      sw.style.setProperty("--sw", ACCENTS[id].accent);
      sw.title = tr(label);
      sw.setAttribute("aria-label", tr(label));
      sw.onclick = () => {
        this.prefs = { ...this.prefs, accent: id };
        savePrefs(this.prefs);
        this.applyPrefs();
        for (const other of swatches.querySelectorAll(".swatch")) other.classList.toggle("on", other === sw);
      };
      swatches.append(sw);
    }
    colorBox.append(swatches);
    sheet.append(colorBox);

    const textBox = el("div", "levels");
    textBox.append(el("div", "levels-label", tr("文字亮度")));
    const textChips = el("div", "chips");
    for (const [key, label] of TEXT_STEPS) {
      const chip = el("button", `chip${this.prefs.text === key ? " on" : ""}`, tr(label));
      chip.onclick = () => {
        this.prefs = { ...this.prefs, text: key };
        savePrefs(this.prefs);
        this.applyPrefs();
        for (const other of textChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
      };
      textChips.append(chip);
    }
    textBox.append(textChips);
    sheet.append(textBox);

    // #97：工作区布局。四颗 chip 各带一张 CSS 画的小示意图（不引图片：设置面板要能离线打开，
    // 一张 png 就得多一条资源路径）。这一票只点亮 A，其余三颗置灰 + 悬停说明「下一步补上」——
    // 画不出来的壳让人点进去只会看到「什么都没变」，那比置灰更让人困惑。
    const layoutBox = el("div", "levels");
    layoutBox.append(el("div", "levels-label", tr("工作区布局")));
    const layoutChips = el("div", "chips layout-chips");
    const shown = activeLayout(this.prefs);
    for (const { id, label } of LAYOUTS) {
      const supported = layoutSupported(id);
      const chip = el("button", `chip layout-chip${shown === id ? " on" : ""}${supported ? "" : " off"}`);
      chip.dataset.layout = id;
      chip.append(layoutDemo(id), el("span", "layout-chip-label", tr(label)));
      if (supported) {
        chip.title = tr(label);
        chip.onclick = () => {
          this.prefs = { ...this.prefs, layout: id };
          savePrefs(this.prefs);
          // #98：applyPrefs → paintLayout → paintShell，浮层 / 竖列 / 色点条 / 横栏一次全摆好。
          this.applyPrefs();
          for (const other of layoutChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        };
      } else {
        // 真 disabled（不只是 aria-disabled）：键盘也进不去、点了不冒事件，省得在半成品上留个洞。
        chip.disabled = true;
        chip.title = tr("{p1}：下一步补上", { p1: tr(label) });
        chip.setAttribute("aria-label", chip.title);
      }
      layoutChips.append(chip);
    }
    layoutBox.append(layoutChips);
    sheet.append(layoutBox);

    // #123：标签行的名额。名额存在桥端（`ws.tabs`），不进 `pi.prefs` ——
    // 换浏览器打开还是同一个 N。改完即发，不等「确定」。
    const wsTabsBox = el("div", "levels");
    wsTabsBox.append(el("div", "levels-label", tr("标签行")));
    this.wsPane = el("div", "ws-tabs-pane");
    wsTabsBox.append(this.wsPane);
    sheet.append(wsTabsBox);
    this.paintWsTabsPane();

    const foot = el("div", "sheet-foot");
    const reset = el("button", "btn ghost", tr("恢复默认"));
    reset.onclick = () => {
      // 恢复默认只恢复字号/颜色/亮度/布局：语言是「我是谁」，不该被配色重置带走；迁移预览也别再来一遍。
      // 布局回到 A（DEFAULT_PREFS.layout），与「新装用户看到的就是两行制」对齐。
      this.prefs = { ...DEFAULT_PREFS, lang: this.prefs.lang, wsIntroSeen: this.prefs.wsIntroSeen };
      savePrefs(this.prefs);
      this.applyPrefs();
      this.openDisplaySheet();
    };
    foot.append(reset);
    sheet.append(foot);

    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
  }

  /**
   * #123 设置面板的「标签行」：只剩「最多显示」步进器（顺序由标签行 / 左栏共用的一份 `order`
   * 说了算；#176 起范围 1–12、默认 6）。桥的每份快照都重画这一块 —— 页面
   * 不另存一份可能说错的副本。
   */
  private paintWsTabsPane(): void {
    const pane = this.wsPane;
    if (!pane) return;
    // 重画会把刚按的那颗按钮换掉：按 data-act 把焦点找回去，键盘用户不至于掉回 body。
    const active = document.activeElement;
    const key = active instanceof HTMLElement && pane.contains(active) ? active.dataset.act ?? "" : "";
    const focusable = new Map<string, HTMLElement>();
    const keep = (node: HTMLButtonElement) => {
      focusable.set(node.dataset.act ?? "", node);
      return node;
    };
    pane.replaceChildren();
    const max = this.workspaces.max ?? TABS_DEFAULT;

    const row = el("div", "ws-max-row");
    row.append(el("span", "ws-max-label", tr("最多显示")));
    const step = (act: string, text: string, title: string, delta: number, off: boolean) => {
      const btn = el("button", "ws-max-btn", text) as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.act = act;
      btn.disabled = off;
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.onclick = () => this.setTabsMax(max + delta);
      row.append(keep(btn));
    };
    // 到边界的那一颗真置灰（disabled）：点得动却没反应，比灰着更让人怀疑。
    step("ws-max-down", tr("－"), tr("最多显示减一"), -1, max <= TABS_MIN);
    const num = el("span", "ws-max-n", String(max));
    num.dataset.act = "ws-max-n";
    row.append(num);
    step("ws-max-up", tr("＋"), tr("最多显示加一"), 1, max >= TABS_MAX);
    pane.append(row);
    // 旁注随当前值变：名额只决定画几颗，装不下的仍在 ＋N 里（#176）。
    pane.append(el("div", "ws-max-hint", tr("横条最多放 {p1} 个，装不下的收进 ＋N", { p1: max })));
    if (key) focusable.get(key)?.focus();
  }

  /**
   * 名额增 / 减：数字与标签行等桥的快照回来再对齐，中间不做乐观改动。
   */
  private setTabsMax(next: number): void {
    const max = this.workspaces.max ?? TABS_DEFAULT;
    const want = clampMax(next);
    if (want === max) return;
    this.paintWsTabsPane();
    this.act(() => this.socket.send({ type: "manage", action: "ws.tabs", max: want }));
  }

  /**
   * Switch language live (D110): no reload — a reload would drop the WS connection and the
   * scroll position, which reads as "something broke". Sheet + topbar are rebuilt just below;
   * `renderAll()` handles every other view.
   */
  private setPrefLang(next: Lang): void {
    if (next === this.prefs.lang) return;
    this.prefs = { ...this.prefs, lang: next };
    savePrefs(this.prefs);
    applyLang(next);
    // 推送标题跟界面语言走：bridge 只在内存里记这一个值。
    this.socket.send({ type: "lang", lang: next });
    this.paintChrome();
    this.renderAll();
    // #86：随手问是独立 dialog，不在 renderAll 的覆盖范围里。
    this.scratch.refreshLang();
    if (this.sheetKind === "display") this.openDisplaySheet();
  }

  /**
   * Retranslate the bits that are built once and never re-rendered: the topbar's fixed four
   * buttons, the new-session button and the two filter placeholders. `renderTop()` only repaints
   * the session list, `renderSessions()` the chips — neither touches these.
   */
  private paintChrome(): void {
    const { look, files, term, fs, notes, peer, scratch, manageBtn, binBtn, tabs } = this.els;
    const newBtn = this.els.newBtn as HTMLButtonElement;
    const sessFilter = this.els.sessFilter as HTMLInputElement;
    look.title = tr("外观与语言");
    look.setAttribute("aria-label", tr("外观与语言"));
    this.setWideLabel(files, tr("📂 产物"));
    files.title = tr("本会话写过的文件（md / html / 图片…点开预览）");
    this.setWideLabel(term, tr(">_ 终端"));
    term.setAttribute("aria-label", tr("终端"));
    term.title = tr("在这台电脑上开一个真的 shell（本机 / 局域网可用，公网隧道下禁用）");
    this.setWideLabel(fs, tr("📁 文件管理器"));
    fs.title = tr("文件资源管理器：浏览这台电脑的盘符与目录，打开或直接编辑文本文件");
    // 记录与内网通是顶栏常显的两颗（#45 / D108），标题也要跟着换；
    // 记录的 title 带未处理计数，交给 paintNotesBadge() 统一写。
    if (notes) this.paintNotesBadge();
    if (peer) {
      this.setWideLabel(peer, tr("🌐 内网通"));
      peer.title = tr("内网通：发现同一内网里的人，直接对话、传文件");
    }
    if (scratch) {
      this.setWideLabel(scratch, tr("💭 随手问"));
      scratch.title = tr("随手问：不进会话列表、不带上下文、不改本机的一个 dialog");
    }
    newBtn.textContent = tr("开新会话");
    sessFilter.placeholder = tr("过滤名字 / 目录");
    manageBtn.textContent = tr("管理");
    manageBtn.title = tr("管理全部会话：检索、筛选、排序、分组、批量操作");
    const binLabel = binBtn.querySelector(".bin-label");
    if (binLabel) binLabel.textContent = tr("垃圾箱");
    // 底部 tab 的文字也是构造期写死的，renderTabs() 只切状态不碰文字。
    // 只改首个文本节点：`.pip` 徽标是 renderTabs 追加的子节点，textContent 会把它们抹掉。
    const labels: Record<string, string> = { sessions: tr("会话"), chat: tr("对话"), queue: tr("需要你") };
    for (const btn of Array.from(tabs.querySelectorAll<HTMLButtonElement>("button"))) {
      const next = labels[btn.dataset.tab ?? ""];
      if (!next) continue;
      const head = btn.firstChild;
      if (head && head.nodeType === Node.TEXT_NODE) head.textContent = next;
      else btn.prepend(next);
    }
  }

  // ---------------------------------------------------------------- peer sheet (#45)
  /**
   * The LAN page as a dialog rather than a new tab: it is one more thing you look at while the
   * session stays put. The body is an iframe of the standalone `/peer` document, so the peer page
   * keeps its own entry (openable directly) without a second implementation; the iframe is removed
   * on close, which also stops its polling.
   */
  private openPeerSheet(): void {
    this.closeSheet();
    this.sheetKind = "peer";
    const back = el("div", "sheet-back center");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };

    const sheet = el("div", "sheet peer-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("内网通")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);

    const frame = document.createElement("iframe");
    frame.className = "peer-frame";
    frame.title = tr("内网通");
    // 带一个每次打开都变的 query：`peer.html` 里引的 bundle 文件名是构建哈希，
    // 但 HTML 自己会被浏览器缓存 —— 不换 query 的话，弹框会一直加载上一次构建的页面
    // （第 2 片上线时，用户看到的「在线」里就没有「发消息」按钮）。
    frame.src = `/peer?v=${Date.now()}`;

    sheet.append(head, frame);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
  }

  /**
   * D150：目录不会自己更新到面板里（bridge 只在连接、装包、登录时推），所以面板缺列表就再问一次。
   * 两段式下第一批 1–2 s 就到，不必因为“刚才已经问过”就让它干等。
   * 默认只吃 bridge 的缓存；`force` 只给「点这里重试」用，那时才值得再起两个 pi 子进程。
   */
  private requestModels(force = false): void {
    this.modelsAsked = Date.now();
    this.socket.send({ type: "models", force });
  }

  // ---------------------------------------------------------------- model sheet
  private closeSheet(): void {
    // 开新会话的面板被关掉（取消 / 点背景）= 放弃「交给 agent → 新开会话」那段待填的文字：
    // 留着它，下一次开的会话会莫名其妙带着别的会话的笔记（见 prefillNext）。
    if (this.sheetKind === "new") this.prefillNext = null;
    // Dismissing the question drawer must not make it pop open again on the next subscribe.
    this.sheet?.remove();
    this.sheet = null;
    this.sheetKind = null;
    this.mgrRefresh = null;
    this.imageSheetPaint = null;
    this.wsPane = null;
    // D170: 详情弹层关掉就停轮询，别让一个看不见的弹层一直读盘。
    if (this.bgTimer !== null) window.clearInterval(this.bgTimer);
    this.bgTimer = null;
    this.bgSheet = null;
  }

  /** The model sheet's 会话 section: folded unless asked for (/session). */
  private sessionInfoOpen = false;

  private openModelSheet(expandSession = false): void {
    if (!this.currentId) return;
    // Re-renders (catalog arrived, takeover finished) keep what the user unfolded; a fresh open folds.
    const reopening = this.sheetKind === "model";
    this.sessionInfoOpen = expandSession || (reopening && this.sessionInfoOpen);
    this.closeSheet();
    this.sheetKind = "model";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };

    const sheet = el("div", "sheet model-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("模型与思考")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);

    // Everything below is a draft until 确认: browsing models must not switch the live session.
    const startBudget = this.budget ?? null;
    const startModel = this.session?.model;
    const startLevel = this.session?.thinkingLevel ?? "";
    let draftBudget = startBudget;
    let draftModel = startModel;
    let draftLevel = startLevel;
    const foot = el("div", "sheet-foot");
    const footHint = el("div", "sheet-foot-hint");
    const cancel = el("button", "btn ghost", tr("取消"));
    cancel.onclick = () => this.closeSheet();
    const confirm = el("button", "btn primary", tr("确认")) as HTMLButtonElement;
    foot.append(footHint, cancel, confirm);
    const refreshFoot = (): void => {
      const changes: string[] = [];
      if (draftModel !== startModel) changes.push(tr("模型 → {p1}", { p1: shortModelName(this.models.find((m) => m.id === draftModel)?.name ?? draftModel ?? "") }));
      if (draftLevel !== startLevel) changes.push(tr("思考 → {p1}", { p1: draftLevel }));
      if (draftBudget !== startBudget) changes.push(tr("预算 → {p1}", { p1: draftBudget ? compactSize(draftBudget) : tr("不设") }));
      confirm.disabled = !changes.length;
      footHint.textContent = changes.length ? changes.join(tr("，")) : tr("未改动");
      footHint.title = footHint.textContent;
    };
    confirm.onclick = () => {
      const sessionId = this.currentId;
      const model = this.models.find((m) => m.id === draftModel);
      const modelChanged = draftModel !== startModel && !!model;
      const levelChanged = draftLevel !== startLevel && !!draftLevel;
      const budgetChanged = draftBudget !== startBudget;
      if (!sessionId || (!modelChanged && !levelChanged && !budgetChanged)) return;
      const budget = draftBudget;
      const level = draftLevel;
      this.act(() => {
        if (budgetChanged) {
          this.budget = budget;
          this.socket.send({ type: "setBudget", sessionId, budget });
        }
        // The level rides along with the model switch so the bridge applies it after pi's clamp.
        if (modelChanged && model) this.socket.send({ type: "setModel", sessionId, provider: model.provider, modelId: model.id, level: level || undefined });
        else if (levelChanged) this.socket.send({ type: "setThinking", sessionId, level });
        if (this.session && this.session.id === sessionId && (modelChanged || levelChanged)) {
          this.session = { ...this.session, ...(modelChanged && model ? { model: model.id, modelName: model.name } : {}), thinkingLevel: level || this.session.thinkingLevel };
        }
        this.fillModelChip();
        this.renderTop();
      });
      this.closeSheet();
    };

    // Context budget: enforced by the bridge (one auto-compaction per turn when it is blown).
    const budgetBox = el("div", "levels");
    budgetBox.append(el("div", "levels-label", tr("上下文预算")));
    const budgetChips = el("div", "chips");
    for (const value of BUDGETS) {
      const on = (value ?? null) === startBudget;
      const chip = el("button", `chip${on ? " on" : ""}`, value ? compactSize(value) : tr("不设"));
      chip.onclick = () => {
        draftBudget = value ?? null;
        for (const other of budgetChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        refreshFoot();
      };
      budgetChips.append(chip);
    }
    budgetBox.append(budgetChips);
    budgetBox.append(el("div", "budget-hint", tr("用量超过预算时，这轮结束后自动压缩一次。")));
    // One grid row for both: the sheet's rows are fixed (the model list is the 1fr one).
    const top = el("div", "sheet-top");
    top.append(budgetBox, this.sessionInfoBox());
    sheet.append(top);

    // Switching only works on a session this bridge owns; a terminal-owned one has no rpc child.
    if (this.session && !this.session.owned) {
      const notice = el("div", "takeover warn", tr("这个会话现在没有写入权，切不了模型。接管之后就正常了——终端里如果有 pi 在写同一个文件，先退出那边。"));
      notice.append(this.claimButton());
      sheet.append(notice, foot);
      refreshFoot();
      back.append(sheet);
      this.overlay(back);
      this.sheet = back;
      return;
    }

    if (!this.models.length) {
      // 面板开得比目录早（bridge 只在连接时推一次，D150）：自己再问一次，别让这一格永远挂着「稍等」。
      if (Date.now() - this.modelsAsked > MODEL_REASK_MS) this.requestModels();
      const waiting = !this.modelsError && Date.now() - this.modelsAsked < MODEL_WAIT_MS;
      const empty = el(
        "div",
        "empty",
        this.modelsError
          ? tr("模型列表没读出来：{p1}。点这里重试。", { p1: this.modelsError })
          : waiting
            ? tr("正在读取模型列表…")
            : tr("模型列表还没加载好，稍等一下，或者点这里重试。"),
      );
      empty.onclick = () => {
        this.modelsError = "";
        this.requestModels(true);
        if (this.sheetKind === "model") this.openModelSheet();
      };
      sheet.append(empty);
    }

    const list = el("div", "model-list");
    const levelsBox = el("div", "levels");
    const chips = el("div", "chips");
    const paintLevels = (): void => {
      const picked = this.models.find((m) => m.id === draftModel);
      const levels = picked?.levels ?? ["off", "low", "medium", "high"];
      // Same rule pi applies when switching: keep the level if the new model has it.
      if (!levels.includes(draftLevel)) draftLevel = levels.includes(startLevel) ? startLevel : levels[0] ?? "";
      chips.replaceChildren();
      for (const level of levels) {
        const chip = el("button", `chip${level === draftLevel ? " on" : ""}`, level);
        chip.onclick = () => {
          draftLevel = level;
          paintLevels();
          refreshFoot();
        };
        chips.append(chip);
      }
    };
    for (const m of this.models) {
      const row = el("button", `model-row${m.id === draftModel ? " on" : ""}`);
      row.dataset.id = m.id;
      const nameEl = el("span", "m-name", shortModelName(m.name));
      if (m.id === startModel) nameEl.append(el("span", "m-cur", tr("当前")));
      row.append(nameEl);
      const meta = [compactSize(m.contextWindow), m.id].filter(Boolean).join(" · ");
      row.append(el("span", "m-meta", meta));
      const check = el("span", "m-check", m.id === draftModel ? "✓" : "");
      row.append(check);
      row.onclick = () => {
        draftModel = m.id;
        for (const other of list.querySelectorAll<HTMLElement>(".model-row")) {
          const on = other.dataset.id === m.id;
          other.classList.toggle("on", on);
          const c = other.querySelector(".m-check");
          if (c) c.textContent = on ? "✓" : "";
        }
        paintLevels();
        refreshFoot();
      };
      row.ondblclick = () => {
        if (!confirm.disabled) confirm.click();
      };
      list.append(row);
    }
    sheet.append(list);

    levelsBox.append(el("div", "levels-label", tr("思考档位")), chips);
    paintLevels();
    sheet.append(levelsBox, foot);
    refreshFoot();

    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
  }

  // ---------------------------------------------------------------- skill palette
  private closeSkillPalette(): void {
    this.skillPop?.remove();
    this.skillPop = null;
    if (this.skillAway) {
      document.removeEventListener("pointerdown", this.skillAway, true);
      this.skillAway = null;
    }
  }

  /**
   * Command-completion style popover: the six most used skills by default, live
   * filtering as you type, numbered rows so a number key picks one outright.
   */
  private openSkillPalette(): void {
    if (!this.currentId) return;
    if (this.skillPop) {
      this.closeSkillPalette();
      return;
    }
    if (Date.now() - this.skillsAt > 60_000) this.socket.send({ type: "skills", sessionId: this.currentId });

    const pop = el("div", "skill-pop");
    const panel = el("div", "skill-panel");
    const search = el("input", "skill-search") as HTMLInputElement;
    search.placeholder = tr("搜索技能：名字或描述…");
    search.spellcheck = false;
    const list = el("div", "skill-list");
    // D126: the footer carries the way into the 商店 — the palette itself stays a pure picker.
    const foot = el("div", "skill-foot");
    foot.append(el("span", "skill-foot-hint", tr("1–9 直接选 · ↑↓ 选 · Enter 确认 · Esc 关闭")));
    const storeOpen = el("button", "btn ghost skill-store-open", tr("商店")) as HTMLButtonElement;
    storeOpen.title = tr("安装 / 卸载技能");
    storeOpen.onclick = () => {
      this.closeSkillPalette();
      this.openSkillStore("store");
    };
    foot.append(storeOpen);
    panel.append(search, list, foot);
    pop.append(panel);
    this.els.composerHost.append(pop);
    this.skillPop = pop;
    this.skillQuery = "";
    this.skillSel = 0;
    this.renderSkillList();
    search.focus();

    search.oninput = () => {
      this.skillQuery = search.value;
      this.skillSel = 0;
      this.renderSkillList();
    };
    search.onkeydown = (ev) => {
      const items = this.filteredSkills();
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.closeSkillPalette();
        this.textarea?.focus();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        this.skillSel = Math.min(Math.max(0, items.length - 1), this.skillSel + 1);
        this.renderSkillList();
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        this.skillSel = Math.max(0, this.skillSel - 1);
        this.renderSkillList();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        const picked = items[this.skillSel] ?? items[0];
        if (picked) this.pickSkill(picked);
        return;
      }
      // A bare digit on an empty box means "row N", like a numbered menu.
      if (!search.value && /^[1-9]$/.test(ev.key)) {
        const picked = items[Number(ev.key) - 1];
        if (picked) {
          ev.preventDefault();
          this.pickSkill(picked);
        }
      }
    };
    pop.onclick = (ev) => {
      if (ev.target === pop) {
        this.closeSkillPalette();
        this.textarea?.focus();
      }
    };
    // D115: like every other dialog, a click outside closes it. The 技能 button itself is skipped:
    // its own click already toggles, and closing on pointerdown would make it reopen on the spot.
    const away = (ev: Event): void => {
      const target = ev.target as Node | null;
      if (!target || pop.contains(target)) return;
      if (target instanceof Element && target.closest('[data-act="skills"]')) return;
      this.closeSkillPalette();
    };
    this.skillAway = away;
    document.addEventListener("pointerdown", away, true);
  }

  /** Always ranked locally, so a use counted a moment ago reorders the list without a bridge trip. */
  private filteredSkills(): SkillInfo[] {
    const query = this.skillQuery.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const scored: { skill: SkillInfo; score: number }[] = [];
    for (const skill of this.skills) {
      const name = skill.name.toLowerCase();
      const desc = (skill.description ?? "").toLowerCase();
      let score = 0;
      let hit = true;
      for (const term of terms) {
        if (name.startsWith(term)) score += 100;
        else if (name.includes(term)) score += 60;
        else if (desc.includes(term)) score += 10;
        else {
          hit = false;
          break;
        }
      }
      if (hit) scored.push({ skill, score });
    }
    return scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.skill.uses - a.skill.uses ||
          b.skill.lastUsed - a.skill.lastUsed ||
          a.skill.name.localeCompare(b.skill.name),
      )
      .slice(0, query ? 12 : 6)
      .map((x) => x.skill);
  }

  private renderSkillList(): void {
    const pop = this.skillPop;
    if (!pop) return;
    const list = pop.querySelector<HTMLElement>(".skill-list");
    if (!list) return;
    const items = this.filteredSkills();
    list.replaceChildren();

    if (!this.skills.length) {
      list.append(el("div", "skill-empty", tr("技能列表还没到，稍等一下…")));
      return;
    }
    if (!items.length) {
      list.append(el("div", "skill-empty", tr("没有匹配「{p1}」的技能", { p1: this.skillQuery })));
      return;
    }
    this.skillSel = Math.min(this.skillSel, items.length - 1);
    items.forEach((skill, index) => {
      const row = el("button", `skill-row${index === this.skillSel ? " on" : ""}`);
      row.append(el("span", "sk-num", String(index + 1)));
      const body = el("span", "sk-body");
      body.append(el("span", "sk-name", skill.name));
      if (skill.description) body.append(el("span", "sk-desc", skill.description));
      row.append(body);
      row.onclick = () => this.pickSkill(skill);
      row.onmouseenter = () => {
        this.skillSel = index;
        this.markSkillRows();
      };
      list.append(row);
    });
  }

  private markSkillRows(): void {
    const rows = this.skillPop?.querySelectorAll<HTMLElement>(".skill-row") ?? [];
    rows.forEach((row, index) => row.classList.toggle("on", index === this.skillSel));
  }

  /** Drop `/skill:<name> ` where the caret is. A pick is not a use yet: `sendPrompt()` counts it. */
  private pickSkill(skill: SkillInfo): void {
    this.closeSkillPalette();

    const command = `/skill:${skill.name} `;
    const field = this.textarea;
    const text = this.composerText;
    if (!field) {
      this.composerText = `${text}${command}`;
      return;
    }
    const start = field.selectionStart ?? text.length;
    const end = field.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${command}${text.slice(end)}`;
    this.composerText = next;
    this.noteDraft();
    field.value = next;
    const caret = start + command.length;
    field.focus();
    field.setSelectionRange(caret, caret);
    this.fitComposer();
  }

  // ---------------------------------------------------------------- 技能商店 (D126)

  /**
   * The store dialog: skills.sh search, the skills installed on this machine, and install from an
   * address (`owner/repo`, a GitHub link, a local directory). Writes go through the bridge, which
   * asks for the passphrase again and refuses the public tunnel (same shelf as the 扩展 manager).
   */
  private openSkillStore(tab: "store" | "installed" = "store"): void {
    this.closeSkillPalette();
    this.closeSheet();
    this.sheetKind = "skillstore";
    this.skillTab = tab;
    this.skillNote = null;
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet settings-sheet ext-sheet skill-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("技能商店")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const body = el("div", "settings-body");
    const host = el("div", "ext-host skill-host");
    body.append(host);
    sheet.append(head, el("div", "settings-tabs"), el("div", "settings-note"), body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    // The installed list is a local disk scan; the store waits for a query (its API needs 2 chars).
    this.loadSkillInventory();
    this.paintSkillSheet(host);
  }

  /** 用户关掉过提示的那个 build id（D154：关了就不再弹，换 build 才弹）。 */
  private dismissedBuild = "";

  /** D154：只提示、不自动刷新 —— 页面里可能正有没发出去的输入。 */
  private checkBuild(buildId: string): void {
    // 只比短 SHA：同一个提交的两次 build（比如只重编了 web）产物代码没变，不该弹提示。
    const shaOf = (id: string) => id.split("-")[0] ?? id;
    if (
      BUILD_ID === "dev" ||
      shaOf(buildId) === shaOf(BUILD_ID) ||
      buildId === this.dismissedBuild ||
      document.querySelector(".update-bar")
    )
      return;
    const bar = el("div", "update-bar");
    const btn = el("button", "btn primary", tr("刷新"));
    btn.onclick = () => location.reload();
    const close = el("button", "update-bar-x", "×");
    close.title = tr("知道了");
    close.onclick = () => {
      // 关掉就是「我知道了这个 build」：重连再见到同一个 id 不再弹，换了 build 才重新提示。
      this.dismissedBuild = buildId;
      bar.remove();
    };
    bar.append(el("span", "update-bar-text", tr("服务已更新，刷新后生效")), btn, close);
    document.body.append(bar);
  }

  /** Repaint in place, keeping the scroll position and the focused box (as `paintExtIfOpen` does). */
  private paintSkillIfOpen(): void {
    if (this.sheetKind !== "skillstore") return;
    const host = this.sheet?.querySelector<HTMLElement>(".skill-host");
    if (!host) return;
    const body = host.parentElement;
    const top = body?.scrollTop ?? 0;
    const focused = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement) ? document.activeElement.placeholder : null;
    const caret = focused ? (document.activeElement as HTMLInputElement).selectionStart : null;
    this.paintSkillSheet(host);
    if (body) body.scrollTop = top;
    if (focused) {
      const again = [...host.querySelectorAll<HTMLInputElement>("input")].find((i) => i.placeholder === focused);
      again?.focus();
      if (again && caret !== null) again.setSelectionRange(caret, caret);
    }
  }

  private loadSkillInventory(): void {
    this.skillInvError = null;
    this.socket.send({ type: "skill.installed", ...(this.session?.cwd ? { cwd: this.session.cwd } : {}) });
  }

  /** What a row's button says while its own install / uninstall is in flight (null = clickable). */
  private skillOpLabel(key: string): string | null {
    for (const op of this.skillOps.values()) if (op.key === key) return op.running;
    return null;
  }

  private skillInstall(req: Record<string, unknown>, key: string): void {
    const reqId = `sk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.skillOps.set(reqId, { key, running: tr("安装中…") });
    this.act(() => {
      this.socket.send({ type: "skill.install", reqId, scope: this.skillScope === "project" ? "project" : "user", ...(this.session?.cwd ? { cwd: this.session.cwd } : {}), ...req });
      this.paintSkillIfOpen();
    });
  }

  /** Four seconds to change your mind, like the 扩展 manager's 卸载 (D81). */
  private skillArmed(key: string): boolean {
    if (this.skillArm && this.skillArm.key === key && Date.now() < this.skillArm.until) {
      this.skillArm = null;
      return true;
    }
    this.skillArm = { key, until: Date.now() + 4000 };
    setTimeout(() => {
      if (this.skillArm?.key === key && Date.now() >= this.skillArm.until) {
        this.skillArm = null;
        this.paintSkillIfOpen();
      }
    }, 4100);
    return false;
  }

  private skillRemove(entry: InstalledSkill): void {
    const key = `remove:${entry.path}`;
    if (!this.skillArmed(key)) {
      this.paintSkillIfOpen();
      return;
    }
    const reqId = `sk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.skillOps.set(reqId, { key, running: tr("卸载中…") });
    this.act(() => {
      this.socket.send({ type: "skill.remove", reqId, path: entry.path });
      this.paintSkillIfOpen();
    });
  }

  private paintSkillSheet(host: HTMLElement): void {
    host.replaceChildren();
    const tabs = el("div", "settings-tabs ext-tabs");
    const def: ["store" | "installed", string][] = [
      ["store", tr("商店")],
      ["installed", this.skillInv ? tr("已安装（{p1}）", { p1: this.skillInv.length }) : tr("已安装")],
    ];
    for (const [id, label] of def) {
      const b = el("button", `chip${this.skillTab === id ? " on" : ""}`, label) as HTMLButtonElement;
      b.onclick = () => {
        this.skillTab = id;
        this.skillNote = null;
        if (id === "installed") this.loadSkillInventory();
        this.paintSkillIfOpen();
      };
      tabs.append(b);
    }
    host.append(tabs);
    if (this.me.public) host.append(el("div", "takeover warn", tr("通过公网访问：这里只能查看，安装 / 卸载 / 更新 / 启停请在本机或局域网操作。")));
    if (this.skillDirty) {
      const bar = el("div", "takeover ext-reload");
      bar.append(el("span", "", tr("改动要「重新加载」后，正在运行的会话才看得到（新开的会话直接生效）。")));
      if (this.session?.owned) {
        const b = el("button", "btn", tr("重新加载当前会话")) as HTMLButtonElement;
        b.disabled = Boolean(this.session.running);
        b.title = this.session.running ? tr("这一轮结束后再重新加载") : "/reload";
        b.onclick = () => {
          const sessionId = this.currentId;
          if (!sessionId) return;
          this.act(() => this.socket.send({ type: "reload", sessionId }));
          this.skillDirty = false;
          this.paintSkillIfOpen();
        };
        bar.append(b);
      }
      host.append(bar);
    }
    if (this.skillNote) host.append(el("div", `login-result${this.skillNote.bad ? " bad" : ""}`, this.skillNote.text));
    if (this.skillTab === "store") this.paintSkillStore(host);
    else this.paintSkillInstalled(host);
  }

  /** 商店 tab: skills.sh search + 按地址安装; the scope picker decides where a click writes. */
  private paintSkillStore(host: HTMLElement): void {
    const store = this.skillStore;
    const run = (): void => {
      if (store.query.trim().length < 2) return;
      store.items = null;
      store.error = undefined;
      this.socket.send({ type: "skill.store", query: store.query, limit: store.limit });
      this.paintSkillIfOpen();
    };
    const bar = el("div", "info-compact");
    const q = el("input", "ns-input") as HTMLInputElement;
    q.placeholder = tr("搜索技能（skills.sh，至少 2 个字）");
    q.value = store.query;
    q.spellcheck = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    q.oninput = () => {
      store.query = q.value.trim();
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 350);
    };
    q.onkeydown = (ev) => {
      if (ev.key === "Enter" && store.query.trim().length >= 2) run();
    };
    bar.append(q);
    host.append(bar);
    host.append(this.skillScopeRow());
    const chips = el("div", "settings-trust-opts");
    chips.append(el("span", "settings-hint", store.query ? tr("搜索结果，按安装量排：") : tr("热度前")));
    for (const n of [10, 20, 50]) {
      const b = el("button", `chip${store.limit === n ? " on" : ""}`, String(n)) as HTMLButtonElement;
      b.onclick = () => {
        store.limit = n;
        run();
      };
      chips.append(b);
    }
    host.append(chips);
    host.append(el("div", "settings-hint", tr("来源是 skills.sh（社区技能目录，按安装次数排序）；每条技能的说明读自它仓库里的 SKILL.md。装进来的技能落在上面选的位置，pi 启动时自动发现。")));
    if (store.note) host.append(el("div", "settings-hint", store.note));
    if (!store.query) host.append(el("div", "empty", tr("输入至少 2 个字再搜。")));
    else if (store.error) host.append(el("div", "empty", store.error));
    else if (!store.items) host.append(el("div", "empty", tr("查询中…")));
    else if (!store.items.length) host.append(el("div", "empty", tr("没有找到")));

    const installedNames = new Set((this.skillInv ?? []).map((s) => s.name));
    const ro = Boolean(this.me.public);
    const list = el("div", "login-list");
    (store.items ?? []).forEach((item, i) => {
      const row = el("div", "login-row");
      const name = el("div", "login-name");
      name.append(el("span", "ext-rank", `${i + 1}`), el("span", "", item.name), el("span", "settings-hint", ` ${item.source}`));
      name.title = item.id;
      row.append(name, el("span", "login-status", item.installs ? tr("{p1} 次安装", { p1: fmtNum(item.installs) }) : ""));
      const acts = el("div", "login-acts");
      if (item.description) acts.append(el("span", "settings-hint ext-desc", item.description));
      else if (item.note) acts.append(el("span", "settings-hint", tr("说明没查到：{p1}", { p1: item.note })));
      if (installedNames.has(item.name)) acts.append(el("span", "login-status ok", tr("已安装")));
      else if (!item.resolved) {
        // Stage one has the rank already; where it lives in the repo is still being worked out.
        acts.append(el("span", "settings-hint", tr("正在确认目录和说明…")));
        const wait = el("button", "btn", this.skillInstallLabel()) as HTMLButtonElement;
        wait.disabled = true;
        acts.append(wait);
      } else if (!item.dir) acts.append(el("span", "login-status warn", tr("仓库里没找到这个技能的目录")));
      else {
        const key = `install:${item.id}`;
        const label = this.skillOpLabel(key);
        const b = el("button", "btn primary", label ?? this.skillInstallLabel()) as HTMLButtonElement;
        b.disabled = ro || Boolean(label);
        b.onclick = () => this.skillInstall({ source: item.source, dir: item.dir, skillId: item.name, name: item.name }, key);
        acts.append(b);
      }
      row.append(acts);
      list.append(row);
    });
    host.append(list);
    host.append(this.skillAddBySource(ro));
  }

  /** 「安装到全局 / 安装到当前项目」 — the label has to name where the click lands. */
  private skillInstallLabel(): string {
    return tr("安装到{p1}", { p1: this.skillScope === "project" ? tr("当前项目") : tr("全局") });
  }

  /** The scope picker: where a click in this tab writes. */
  private skillScopeRow(): HTMLElement {
    const box = el("div", "settings-foot skill-scope");
    box.append(el("span", "settings-hint", tr("装到：")));
    const scope = el("select", "ns-input") as HTMLSelectElement;
    scope.append(new Option(tr("全局（用户技能目录）"), "global"), new Option(tr("当前项目（.pi/skills）"), "project"));
    scope.value = this.skillScope;
    scope.style.width = "auto";
    scope.disabled = !this.session?.cwd;
    scope.title = this.session?.cwd ? "" : tr("没打开会话，不知道项目目录：只能装到全局");
    scope.onchange = () => {
      this.skillScope = scope.value === "project" ? "project" : "global";
      this.paintSkillIfOpen();
    };
    box.append(scope);
    return box;
  }

  /** 按地址安装: paste `owner/repo`, a GitHub link, or a folder on this machine → pick a skill. */
  private skillAddBySource(ro: boolean): HTMLElement {
    const more = el("details", "ns-advanced");
    // Repaints replace this subtree, so whether it is unfolded has to live in state, not in the DOM.
    more.open = this.skillSource.open;
    more.ontoggle = () => (this.skillSource.open = more.open);
    more.append(el("summary", "", tr("按地址安装（GitHub 仓库或本机目录）")));
    const grid = el("div", "ns-adv-grid");
    const src = el("input", "ns-input mono") as HTMLInputElement;
    src.placeholder = tr("owner/repo · https://github.com/… · 或本机目录");
    src.value = this.skillSource.input;
    src.oninput = () => (this.skillSource.input = src.value);
    const go = el("button", "btn", this.skillSource.loading ? tr("列出中…") : tr("列出技能")) as HTMLButtonElement;
    go.disabled = ro || this.skillSource.loading;
    go.onclick = () => {
      const input = src.value.trim();
      if (!input) return;
      this.skillSource = { input, label: "", kind: null, items: null, loading: true, open: true };
      this.socket.send({ type: "skill.source", source: input });
      this.paintSkillIfOpen();
    };
    const row = el("div", "info-compact");
    row.append(src, go);
    grid.append(row);
    if (this.skillSource.error) grid.append(el("div", "login-result bad", this.skillSource.error));
    const items = this.skillSource.items ?? [];
    if (items.length) {
      grid.append(el("div", "settings-hint", tr("来自 {p1}（{p2} 个技能）：", { p1: this.skillSource.label, p2: items.length })));
      const list = el("div", "login-list");
      for (const item of items) {
        const line = el("div", "login-row");
        line.append(el("div", "login-name", item.name));
        const acts = el("div", "login-acts");
        acts.append(el("span", "skill-path", item.path));
        if (item.description) acts.append(el("span", "settings-hint ext-desc", item.description));
        const key = `install:${item.local ? item.path : `${this.skillSource.label}#${item.path}`}`;
        const label = this.skillOpLabel(key);
        const b = el("button", "btn primary", label ?? this.skillInstallLabel()) as HTMLButtonElement;
        b.disabled = ro || Boolean(label);
        b.onclick = () =>
          this.skillInstall(item.local ? { local: item.path } : { source: this.skillSource.label, dir: item.path, name: item.name }, key);
        acts.append(b);
        line.append(acts);
        list.append(line);
      }
      grid.append(list);
    }
    more.append(grid);
    return more;
  }

  private paintSkillInstalled(host: HTMLElement): void {
    const top = el("div", "settings-foot");
    top.append(el("span", "settings-hint", tr("扫描的是本机技能目录（和 pi 启动时读的是同一批）。用户技能可以卸载，项目技能跟着仓库走。")));
    top.append(el("span", "spacer"));
    const refresh = el("button", "btn ghost", tr("刷新")) as HTMLButtonElement;
    refresh.onclick = () => {
      this.loadSkillInventory();
      this.paintSkillIfOpen();
    };
    top.append(refresh);
    host.append(top);
    if (this.skillInvError) {
      host.append(el("div", "empty", this.skillInvError));
      return;
    }
    if (!this.skillInv) {
      host.append(el("div", "empty", tr("读取本机技能目录…")));
      return;
    }
    if (!this.skillInv.length) {
      host.append(el("div", "empty", tr("本机还没有装任何技能，去「商店」看看。")));
      return;
    }
    const ro = Boolean(this.me.public);
    const groups: [string, InstalledSkill[]][] = [
      [tr("用户技能（可以卸载）"), this.skillInv.filter((s) => s.removable)],
      [tr("项目技能（只读，跟着仓库走）"), this.skillInv.filter((s) => !s.removable)],
    ];
    for (const [label, entries] of groups) {
      if (!entries.length) continue;
      host.append(el("div", "settings-label", label));
      const list = el("div", "login-list");
      for (const entry of entries) {
        const row = el("div", "login-row");
        const name = el("div", "login-name");
        name.append(el("span", "", entry.name));
        if (entry.link) name.append(el("span", "ext-kind", tr("链接")));
        row.append(name);
        const acts = el("div", "login-acts");
        acts.append(el("span", "skill-path", entry.path));
        if (entry.description) acts.append(el("span", "settings-hint ext-desc", entry.description));
        if (entry.from) acts.append(el("span", "settings-hint", tr("来自 {p1}", { p1: entry.from })));
        if (entry.removable) {
          const key = `remove:${entry.path}`;
          const label = this.skillOpLabel(key);
          const armed = this.skillArm?.key === key && Date.now() < this.skillArm.until;
          const b = el("button", `btn${armed ? " danger" : ""}`, label ?? (armed ? tr("确认卸载？") : tr("卸载"))) as HTMLButtonElement;
          b.disabled = ro || Boolean(label);
          b.onclick = () => this.skillRemove(entry);
          acts.append(b);
        } else {
          acts.append(el("span", "settings-hint", tr("只读：项目技能跟着仓库走，要删就直接删这个目录")));
        }
        row.append(acts);
        list.append(row);
      }
      host.append(list);
    }
  }

  /**
   * 新会话对话框的默认工作目录：**先看现在开着的会话**——在 A 会话里点 ＋ 就该默认 A 的目录，
   * 换到 B 会话点 ＋ 就默认 B 的（D59）。`pi.lastCwd` 只在上次创建时写过，切会话不会更新，
   * 放在它前面会把「当前在哪」这个更强的信号盖掉，所以顺序是 当前会话 → 上次用的 → 最近更新的会话。
   */
  private defaultCwd(): string {
    const open = (this.session?.cwd ?? "").trim();
    if (open) return open;
    const latest = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.cwd;
    return localStorage.getItem("pi.lastCwd") || latest || "";
  }

  private createSession(cwd: string, name: string, onSent: () => void, pin = false, options?: Record<string, unknown>): void {
    localStorage.setItem("pi.lastCwd", cwd);
    const recent = this.recentCwds().filter((c) => c !== cwd);
    localStorage.setItem("pi.recentCwds", JSON.stringify([cwd, ...recent].slice(0, 12)));
    this.act(() => {
      onSent();
      this.socket.send({ type: "create", cwd, ...(name ? { name } : {}), ...(pin ? { pin: true } : {}), ...(options && Object.keys(options).length ? { options } : {}) });
    });
  }

  /**
   * #28 「高级」: the pi CLI flags for one session (--model, --thinking, --tools, -e, --skill,
   * --append-system-prompt, -ne, -nc, --no-mcp, --offline). The bridge validates and remembers them,
   * so taking the session over again later starts pi with the same flags.
   */
  private launchOptionsBox(): { node: HTMLElement; read: () => Record<string, unknown> } {
    const box = el("details", "ns-advanced");
    box.append(el("summary", "", tr("高级：启动参数（相当于 pi 的命令行选项）")));
    const grid = el("div", "ns-adv-grid");
    const field = (label: string, input: HTMLElement, hint?: string) => {
      const wrap = el("label", "ns-adv-field");
      wrap.append(el("span", "ns-adv-label", label), input);
      if (hint) wrap.append(el("span", "ns-adv-hint", hint));
      grid.append(wrap);
    };
    const model = el("select", "ns-input") as HTMLSelectElement;
    model.append(new Option(tr("（用默认模型）"), ""));
    for (const m of this.models) model.append(new Option(`${shortModelName(m.name)} · ${m.provider}`, `${m.provider}/${m.id}`));
    field(tr("模型 --model"), model);
    const thinking = el("select", "ns-input") as HTMLSelectElement;
    for (const lv of ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) thinking.append(new Option(lv || tr("（默认）"), lv));
    field(tr("思考 --thinking"), thinking);
    const tools = el("input", "ns-input mono") as HTMLInputElement;
    tools.placeholder = tr("例如 read,grep,find,ls 或 +codemode,-write");
    field(tr("工具 --tools"), tools, tr("普通名字＝只用这些；+x / -x＝在默认基础上增减（两种不能混用）"));
    const ext = el("textarea", "ns-input mono") as HTMLTextAreaElement;
    ext.rows = 2;
    ext.placeholder = tr("一行一个扩展文件或目录");
    field(tr("额外扩展 -e"), ext);
    const skills = el("textarea", "ns-input mono") as HTMLTextAreaElement;
    skills.rows = 2;
    skills.placeholder = tr("一行一个技能文件或目录");
    field(tr("额外技能 --skill"), skills);
    const prompt = el("textarea", "ns-input") as HTMLTextAreaElement;
    prompt.rows = 3;
    prompt.placeholder = tr("追加到系统提示词的文字（或一个文件路径）");
    field(tr("追加系统提示词"), prompt);
    const flags = el("div", "ns-adv-flags");
    const flag = (key: string, label: string, title: string) => {
      const wrap = el("label", "ns-adv-flag");
      const box = el("input") as HTMLInputElement;
      box.type = "checkbox";
      box.dataset.key = key;
      wrap.title = title;
      wrap.append(box, el("span", "", label));
      flags.append(wrap);
    };
    flag("noBuiltinTools", tr("不要内置工具"), tr("--no-builtin-tools：关掉 read/bash/edit/write 等，只留扩展工具"));
    flag("noExtensions", tr("不加载扩展"), tr("-ne：不加载已发现 / 配置 / 内置的扩展（审批门禁照样加载）"));
    flag("noContextFiles", tr("不读 AGENTS.md"), tr("-nc：不读 AGENTS.md / CLAUDE.md"));
    flag("noMcp", tr("不连 MCP"), "--no-mcp");
    flag("offline", tr("离线"), tr("--offline：不做自动联网（例如刷新模型目录）"));
    grid.append(flags);
    box.append(grid);
    const read = () => {
      const out: Record<string, unknown> = {};
      if (model.value) out.model = model.value;
      if (thinking.value) out.thinking = thinking.value;
      if (tools.value.trim()) out.tools = tools.value.trim();
      if (ext.value.trim()) out.extensions = ext.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (skills.value.trim()) out.skills = skills.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (prompt.value.trim()) out.appendSystemPrompt = prompt.value.trim();
      for (const cb of flags.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) if (cb.checked && cb.dataset.key) out[cb.dataset.key] = true;
      return out;
    };
    return { node: box, read };
  }

  private recentCwds(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem("pi.recentCwds") ?? "[]");
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /** Dropdown = what you started from here, then every directory the listed sessions live in. */
  private recentCwdOptions(): HTMLElement {
    const list = el("datalist");
    list.id = "pi-recent-cwds";
    const seen = new Set<string>();
    const all = [...this.recentCwds(), ...[...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.cwd)];
    for (const cwd of all) {
      if (!cwd || seen.has(cwd.toLowerCase())) continue;
      seen.add(cwd.toLowerCase());
      const opt = el("option") as HTMLOptionElement;
      opt.value = cwd;
      list.append(opt);
      if (seen.size >= 20) break;
    }
    return list;
  }

  private openNewSessionSheet(autoPin = false): void {
    this.closeSheet();
    this.sheetKind = "new";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back && !this.creating) this.closeSheet();
    };
    const sheet = el("div", "sheet new-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("开新会话")));
    const close = el("button", "btn ghost", tr("取消"));
    close.onclick = () => this.closeSheet();
    head.append(close);

    const nameField = el("input", "ns-input") as HTMLInputElement;
    nameField.placeholder = tr("可留空：发第一条消息后自动用它取名");
    nameField.maxLength = 120;
    const cwdField = el("input", "ns-input mono") as HTMLInputElement;
    cwdField.placeholder = tr("例如 E:\\yqm\\pi-web-client");
    cwdField.value = this.defaultCwd();
    cwdField.setAttribute("list", "pi-recent-cwds");
    const browseBtn = el("button", "btn ghost", tr("📁 浏览"));
    const cwdRow = el("div", "ns-row");
    cwdRow.append(cwdField, browseBtn);

    const browser = el("div", "ns-browser");
    browser.hidden = true;
    const mkBtn = el("button", "btn ghost dir-mk", tr("＋ 新建文件夹")) as HTMLButtonElement;
    mkBtn.title = tr("在当前目录下新建一个文件夹");
    const mkRow = el("div", "dir-mkrow");
    mkRow.hidden = true;
    const mkInput = el("input", "ns-input mono") as HTMLInputElement;
    mkInput.placeholder = tr("新文件夹名");
    mkInput.maxLength = 255;
    const mkOk = el("button", "btn primary", tr("创建")) as HTMLButtonElement;
    const mkCancel = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    const mkErr = el("div", "ns-error dir-mkerr");
    const mkFields = el("div", "ns-row");
    mkFields.append(mkInput, mkOk, mkCancel);
    mkRow.append(mkFields, mkErr);
    let current = "";
    let picker: DirPicker | null = null;
    const home = this.dirHome(() => cwdField.value);
    // 目录浏览只有一份实现（dirpicker.ts），这里只多做三件事：定位回工作目录 + 新建文件夹 + 走目录就等于选目录。
    picker = mountDirPicker(browser, {
      start: cwdField.value.trim(),
      head: [home.node, mkBtn],
      beforeList: [mkRow],
      fallback: true,
      // Hidden until 浏览 opens it, and the field is the source of truth for where to start:
      // a listing that ran while the sheet was still opening would rewrite what the user types.
      autoStart: false,
      onState: (s) => {
        current = s.path;
        mkBtn.hidden = !s.path || !!s.error;
        closeMk();
        if (s.path) cwdField.value = s.path;
      },
    });
    home.bind(picker);

    const err = el("div", "ns-error");
    const status = el("div", "ns-status");
    status.hidden = true;
    status.append(el("span", "act-spin"), el("span", "", tr("正在启动会话…（拉起 pi 进程，通常要几秒）")));
    const foot = el("div", "dir-foot");
    const ok = el("button", "btn primary", tr("创建"));
    foot.append(ok);
    const advanced = this.launchOptionsBox();

    sheet.append(
      head,
      el("label", "ns-label", tr("会话名称")),
      nameField,
      el("label", "ns-label", tr("工作目录")),
      cwdRow,
      this.recentCwdOptions(),
      browser,
      advanced.node,
      err,
      status,
      foot,
    );
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;

    // 打开面板时才去读目录：这里只绑定开关。
    browseBtn.onclick = () => {
      browser.hidden = !browser.hidden;
      browseBtn.textContent = browser.hidden ? tr("📁 浏览") : tr("收起");
      if (!browser.hidden) void picker?.go(cwdField.value.trim());
    };
    let mkBusy = false;
    const setMkBusy = (busy: boolean): void => {
      mkBusy = busy;
      mkInput.disabled = busy;
      mkOk.disabled = busy;
      mkOk.textContent = busy ? tr("创建中…") : tr("创建");
    };
    function closeMk(): void {
      mkRow.hidden = true;
      mkErr.textContent = "";
      mkInput.value = "";
    }
    mkBtn.onclick = () => {
      if (!current) return;
      mkRow.hidden = false;
      mkErr.textContent = "";
      mkInput.focus();
    };
    mkCancel.onclick = () => {
      if (!mkBusy) closeMk();
    };
    const submitMk = (): void => {
      const name = mkInput.value.trim();
      const parent = current;
      if (!name || !parent || mkBusy) return;
      if (/[\\/]/.test(name)) {
        mkErr.textContent = tr("文件夹名里不能有 / 或 \\（一次只建一层）");
        return;
      }
      this.act(() => {
        const reqId = `mk:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        setMkBusy(true);
        mkErr.textContent = "";
        const timer = setTimeout(() => {
          if (!this.mkWaits.delete(reqId)) return;
          setMkBusy(false);
          mkErr.textContent = tr("服务端没有响应，稍后再试");
        }, 15000);
        this.mkWaits.set(reqId, (res) => {
          clearTimeout(timer);
          if (this.sheet !== back) return;
          setMkBusy(false);
          if (res.error || !res.path) {
            mkErr.textContent = res.error ? errText(res) : tr("创建失败");
            mkInput.focus();
            return;
          }
          // Step into the new folder: that also makes it the chosen working directory.
          void picker?.go(res.path);
        });
        this.socket.send({ type: "mkdir", reqId, parent, name });
      });
    };
    mkOk.onclick = submitMk;
    mkInput.onkeydown = (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitMk();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (!mkBusy) closeMk();
      }
    };

    const setBusy = (busy: boolean): void => {
      status.hidden = !busy;
      for (const node of [nameField, cwdField, browseBtn, ok, close] as (HTMLInputElement | HTMLButtonElement)[]) node.disabled = busy;
      browser.classList.toggle("disabled", busy);
      ok.textContent = busy ? tr("启动中…") : tr("创建");
    };
    const submit = (): void => {
      if (this.creating) return;
      const cwd = cwdField.value.trim();
      if (!cwd) {
        err.textContent = tr("先选一个工作目录");
        cwdField.focus();
        return;
      }
      err.textContent = "";
      this.createSession(
        cwd,
        nameField.value.trim(),
        () => {
        setBusy(true);
        const timer = setTimeout(() => this.creating?.finish(tr("等了 60 秒还没启动起来，看看服务端日志")), 60000);
        this.creating = {
          finish: (error) => {
            clearTimeout(timer);
            this.creating = null;
            if (this.sheet !== back) return;
            if (!error) {
              this.closeSheet();
              return;
            }
            setBusy(false);
            err.textContent = error;
          },
        };
        },
        autoPin,
        advanced.read(),
      );
    };
    ok.onclick = submit;
    for (const field of [nameField, cwdField]) {
      field.onkeydown = (ev) => {
        if (ev.key === "Enter" && !ev.isComposing) {
          ev.preventDefault();
          submit();
        }
      };
    }
    queueMicrotask(() => nameField.focus());
  }
  // ---------------------------------------------------------------- render
  private renderAll(): void {
    this.renderTop();
    this.renderSessions();
    this.renderChat();
    this.renderApprovals();
    this.renderAsks();
    this.renderQueue();
    this.renderPanes();
    this.renderTabs();
  }

  private renderTop(): void {
    const { dot, title, sub, collapseLeft, collapseRight } = this.els;
    const running = this.session?.running;
    dot.className = `dot ${!this.connected ? "bad" : running ? "busy" : this.session?.owned ? "live" : ""}`;
    title.textContent = this.session ? this.session.name : "pi";
    this.els.files.hidden = !this.currentId;
    this.els.fs.hidden = !this.currentId;
    const bits: string[] = [];
    if (this.me.public) bits.push(tr("公网"));
    if (this.tunnel.status === "up" && this.tunnel.url) bits.push(this.tunnel.url.replace("https://", ""));
    else if (this.tunnel.status === "starting") bits.push(tr("隧道启动中…"));
    else if (this.tunnel.status === "error") bits.push(tr("隧道异常"));

    if (!this.connected) bits.push(tr("离线"));
    sub.textContent = bits.join(" · ");

    setToggle(collapseLeft, this.collapsed.sessions, tr("会话列表"));
    setToggle(collapseRight, this.collapsed.queue, tr("待办队列"));
    collapseRight.classList.toggle("alert", this.collapsed.queue && (this.approvals.length > 0 || this.asks.length > 0));
    this.fillModelChip();
    this.renderNowChip();
  }

  /**
   * #96：顶栏那颗「当前在哪」。切会话、改工作区名、待处理数变化都从这一处重画 ——
   * 组件只吃一份 view，读的是 `session` / 工作区快照 / 本地队列，不碰别的东西。
   */
  private renderNowChip(): void {
    if (!this.nowChip) return;
    const s = this.session;
    if (!s) {
      this.nowChip.render({ hidden: true, workspace: "", name: "", accent: null, live: "", badge: null, label: "", title: "" });
      return;
    }
    const listed = this.sessions.find((x) => x.id === s.id);
    const group = wsOf(s, this.workspaces, listed?.ws);
    this.nowChip.render(
      nowChipView({
        session: s,
        group,
        connected: this.connected,
        running: Boolean(s.running),
        owned: Boolean(s.owned),
        pending: this.nowPending(s),
      }),
    );
  }

  /** 待回答 / 待确认那两档；当前会话以本地队列为准（它比列表里的计数新）。 */
  private nowPending(s: SessionState): NowChipPending | null {
    const badge = this.badgeOf(s);
    return badge?.pending ? { text: badge.text, title: badge.title } : null;
  }

  /**
   * The composer chip is the only readout: model · context used/window · output rate · thinking
   * level. It lives in the composer flow (never floating over the transcript), so it is rebuilt
   * on every renderChat and refreshed by usage/stats updates.
   */
  private fillModelChip(): void {
    const chip = this.modelChip;
    if (!chip) return;
    const model = chip.querySelector<HTMLElement>(".chip-model");
    const ctx = chip.querySelector<HTMLElement>(".chip-ctx");
    const rateEl = chip.querySelector<HTMLElement>(".chip-rate");
    const levelEl = chip.querySelector<HTMLElement>(".chip-level");
    if (!model || !ctx || !rateEl || !levelEl) return;

    const name = shortModelName(this.session?.modelName ?? this.session?.model ?? "");
    model.textContent = name || tr("模型");

    const thinking = this.session?.thinkingLevel ?? "";
    levelEl.textContent = thinking || "–";
    levelEl.classList.toggle("off", !thinking || thinking === "off");

    const win = this.budget ?? this.usage.contextWindow ?? this.models.find((m) => m.id === this.session?.model)?.contextWindow ?? null;
    const used = this.usage.contextTokens;
    if (used != null && win) {
      ctx.textContent = `${compactSize(used)}/${compactSize(win)}`;
      ctx.classList.toggle("hot", used / win >= (this.budget ? 0.9 : 0.8));
      ctx.title = this.budget ? tr("上下文预算 {p1}：超了就自动压缩", { p1: compactSize(this.budget) }) : "";
    } else if (win) {
      ctx.textContent = `–/${compactSize(win)}`;
      ctx.classList.remove("hot");
    } else {
      ctx.textContent = used != null ? compactSize(used) : "–";
      ctx.classList.remove("hot");
    }

    rateEl.textContent = this.rate >= 1 ? `${Math.round(this.rate)} tok/s` : "– tok/s";
    rateEl.classList.toggle("live", this.turnAt != null);

    chip.title = [this.session?.modelName ?? this.session?.model ?? tr("模型"), ctx.textContent, rateEl.textContent, thinking ? tr("思考 {p1}", { p1: thinking }) : tr("思考 –")]
      .filter(Boolean)
      .join(" · ");
  }

  /**
   * 左栏两级树（#95）：工作区 → 会话。分组、组内/组间顺序、过滤后的去留全在 `buildTree()` 里算，
   * 这里只负责画。「置顶」不再是一个分区 —— ★ 只剩组内排序的意思，归档仍是末尾的全局分区。
   * 每次拖动、每次点 ★ 最后都落到一条 arrange 消息上。
   */
  private renderSessions(): void {
    this.renderSessionRow();
    this.renderWorkspaceTabs();
    this.renderNowChip();
    // #98：工作区浮层开着时列表一变就得跟着重画（B 里拖完一颗，段里的位置立刻换）。
    if (this.wsPop) this.renderWsPop();
    this.renderBinCount();
    const host = this.els.sessList;
    // 重画会换掉所有子节点：旧的落点线 / 「放回工程」都是孤儿了，引用先清掉（拖动中会再挂上）。
    this.dropLine = null;
    this.dragPool = null;
    // A re-render mid-edit must not eat the caret: remember where it was before the DOM swap.
    const active = document.activeElement as HTMLElement | null;
    const wsTyping = this.wsRenameId != null && active?.classList.contains("ws-rename-input") === true;
    this.wsRenameCaret = wsTyping ? (active as HTMLInputElement).selectionStart : null;
    const typing = this.renameId != null && !wsTyping && active?.classList.contains("rename-input") === true;
    this.renameCaret = typing ? (active as HTMLInputElement).selectionStart : null;
    // 组头的 ⋯ 菜单钉在一个马上要被替换掉的节点上，先收掉。
    this.wsMenu?.close();
    this.wsMenu = null;
    host.replaceChildren();

    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    if (this.renameId && !this.sessions.some((s) => s.id === this.renameId)) this.renameId = null;
    if (this.wsRenameId && !this.workspaces.groups.some((g) => g.id === this.wsRenameId)) this.wsRenameId = null;
    // A deleted or now-hidden session must not stay "picked".
    if (this.sheetKind === "manage") this.mgrRefresh?.();

    if (!this.sessions.length) {
      host.append(el("div", "empty", tr("还没有会话。上面开一个，或在终端里 pi 一下。")));
      host.append(this.wsCreateRow());
      return;
    }
    for (const group of tree.groups) host.append(this.wsSection(group));
    if (!tree.groups.length) {
      // 有归档就提示去哪儿看；什么都没命中就直说没命中。
      let text = tr("没有匹配的会话。");
      if (!this.filter && tree.archived.length) text = tr("都归档了，展开下面的「已归档」看看。");
      host.append(el("div", "empty", text));
    }
    // #100：树底部一行「新建工作区」—— 手建的空组也能有会话被拖进来（落点见 wsSection 的 .session-cards）。
    host.append(this.wsCreateRow());
    if (tree.archived.length) host.append(this.sessionSection("archived", tr("已归档"), this.archivedOpen ? tree.archived : []));
    // 「放回工程」只在拖动时出现；socket 推送顺手重画一次也不会把它弄丢。
    if (this.dragId) this.showPool(this.dragId);
    this.wireTreeDrops(host);
    this.renameFocus = false;
    this.wsRenameFocus = false;
    // #102：键盘动作（Alt+方向键、折叠）换掉的 DOM 到此全部就位，把焦点还给该在的地方。
    this.consumePendingFocus();
    this.maybeWorkspaceIntro(tree);
  }

  /** 重画后焦点归还：卡片优先（移动 / 重排后），组头次之（折叠 / 展开后）。状态机在 `focusfollow.ts`。 */
  private consumePendingFocus(): void {
    const outcome = consumeFocus(this.pendingFocus, (kind, id) =>
      kind === "card"
        ? this.els.sessList.querySelector<HTMLElement>(`.session-card[data-id="${CSS.escape(id)}"]`)
        : this.els.sessList.querySelector<HTMLElement>(`.ws-sec[data-ws="${CSS.escape(id)}"] > .ws-head`),
    );
    this.pendingFocus = outcome.next;
    if (!outcome.focus) return;
    outcome.focus.focus({ preventScroll: true });
    if (outcome.focus.classList.contains("session-card")) outcome.focus.scrollIntoView({ block: "nearest" });
  }

  /**
   * #101 迁移预览：分组第一次出现之前，先把「会建哪些工作区、各几个会话、其中几个是你拖过的」
   * 摆出来让用户确认一次。数字直接来自 `buildTree()`（左栏画的就是它），不另算一套。
   *
   * 确认才写 `pi.prefs.wsIntroSeen`；取消什么都不写，所以下次打开还会弹。同一张页面里只弹一次
   * （`wsIntroShown`），否则每次 renderSessions 都会把它重新推上来。
   */
  private maybeWorkspaceIntro(tree: Tree<SessionState>): void {
    if (this.prefs.wsIntroSeen || this.wsIntroShown || this.sheetKind) return;
    // 没有 workspace 快照（旧桥 / 桩桥）就没有「要建的组」可预览 —— 分组本来就还没发生。
    if (!this.workspaces.groups.length || !tree.groups.length) return;
    // 自动化（Playwright / DevTools 带 navigator.webdriver）不弹：探针每次都跑在全新 profile 里，
    // 等于每次都「第一次打开」，这张模态会把别的探针全挡在下面（见 D146 的验证段）。
    if (navigator.webdriver) return;
    this.wsIntroShown = true;

    const back = el("div", "sheet-back center");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet ws-intro-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("工作区")));
    const close = el("button", "btn ghost", tr("稍后"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);

    const body = el("div", "ws-intro");
    body.append(el("p", "ws-intro-lead", tr("左栏要按工作区分组了：同一个工程根下的会话归到一组，组里 ★ 排前，归档的另放最后一区。下面是你会看到的样子。")));

    // 数字全部数自同一棵树：组 = 左栏那一排组头，会话 = 组里的卡片，「拖过的」= 桥记下的 override。
    const overrides = this.workspaces.overrides ?? {};
    const total = tree.groups.reduce((n, g) => n + g.sessions.length, 0);
    const moved = tree.groups.reduce((n, g) => n + g.sessions.filter((s) => overrides[s.id] === g.id).length, 0);
    body.append(
      el("div", "ws-intro-sum", moved ? tr("会建 {p1} 个工作区、{p2} 个会话，其中 {p3} 个是你拖过的", { p1: tree.groups.length, p2: total, p3: moved }) : tr("会建 {p1} 个工作区、{p2} 个会话", { p1: tree.groups.length, p2: total })),
    );

    const rows = el("div", "ws-intro-rows");
    for (const group of tree.groups) {
      const row = el("div", "ws-intro-row");
      row.dataset.ws = group.id;
      const dot = el("span", "ws-dot");
      dot.style.background = group.color;
      row.append(dot, el("span", "ws-intro-name", group.name), el("span", "ws-intro-n", tr("{p1} 个会话", { p1: group.sessions.length })));
      const own = group.sessions.filter((s) => overrides[s.id] === group.id).length;
      if (own) row.append(el("span", "ws-intro-moved", tr("其中 {p1} 个是你拖过的", { p1: own })));
      rows.append(row);
    }
    body.append(rows);

    const foot = el("div", "sheet-foot");
    const later = el("button", "btn ghost", tr("以后再说"));
    later.onclick = () => this.closeSheet();
    const go = el("button", "btn primary", tr("就这样开始"));
    go.onclick = () => {
      this.prefs = { ...this.prefs, wsIntroSeen: true };
      savePrefs(this.prefs);
      this.closeSheet();
    };
    foot.append(later, go);
    sheet.append(body, foot);

    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    this.sheetKind = "intro";
  }

  /** 树底部的「新建工作区」：点一下让桥造一个空的手动组，广播回来就进改名态。 */
  private wsCreateRow(): HTMLElement {
    const row = el("div", "ws-new");
    const btn = el("button", "ws-new-btn") as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.act = "ws-create";
    btn.textContent = tr("＋ 新建工作区");
    btn.title = tr("先建一个空组，再把会话拖进去");
    btn.onclick = (ev) => {
      ev.stopPropagation();
      this.createWs();
    };
    row.append(btn);
    return row;
  }

  /** 一个工作区的组头 + 组内卡片。组头可收起，收起状态记在 `pi.prefs.wsCollapsed` 里。 */
  private wsSection(group: TreeGroup<SessionState>): HTMLElement {
    const sec = el("div", "session-sec ws-sec");
    // 仍是「会话区」：既有探针按 data-sec 取卡片，归档另有一段。
    sec.dataset.sec = "rest";
    sec.dataset.ws = group.id;
    const collapsed = this.prefs.wsCollapsed.includes(group.id);
    if (collapsed) sec.classList.add("folded");

    const head = el("div", `sess-head ws-head${collapsed ? " folded" : ""}`);
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", String(!collapsed));
    head.title = collapsed ? tr("展开这个工作区") : tr("收起这个工作区");
    head.setAttribute("aria-label", tr("{p1}，{p2} 个会话，{p3}", { p1: group.name, p2: group.sessions.length, p3: collapsed ? tr("已收起") : tr("已展开") }));
    head.append(el("span", "chev", collapsed ? "▸" : "▾"));
    const dot = el("span", "ws-dot");
    dot.style.background = group.color;
    head.append(dot);
    const editing = this.wsRenameId === group.id;
    if (editing) {
      // 组头就地改名：同一支 .rename-input，Enter 提交、Esc 取消、失焦也提交（跟会话卡片一致）。
      const field = el("input", "rename-input ws-rename-input") as HTMLInputElement;
      field.value = this.wsRenameDraft;
      field.placeholder = group.name;
      field.spellcheck = false;
      field.maxLength = WS_NAME_MAX;
      field.dataset.act = "ws-rename-input";
      field.setAttribute("aria-label", tr("工作区名（留空就恢复成目录名）"));
      field.onclick = (ev) => ev.stopPropagation();
      field.oninput = () => {
        this.wsRenameDraft = field.value;
      };
      field.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.commitWsRename();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          this.cancelWsRename();
        }
      };
      field.onblur = () => {
        if (this.wsRenameId === group.id) this.commitWsRename();
      };
      if (this.wsRenameFocus || this.wsRenameCaret != null) {
        const at = this.wsRenameFocus ? null : this.wsRenameCaret;
        queueMicrotask(() => {
          field.focus();
          if (at == null) field.select();
          else field.setSelectionRange(at, at);
        });
      }
      head.append(field);
    } else {
      head.append(el("span", "label", group.name));
    }
    if (group.pending) {
      const todo = el("span", "todo", tr("待 {p1}", { p1: group.pending }));
      todo.title = tr("{p1} 个会话在等你", { p1: group.pending });
      head.append(todo);
    }
    // #173：左栏组序就是 `order`，不再需要「为什么它排在前面」的徽记。
    head.append(el("span", "n", String(group.sessions.length)));
    if (!editing) {
      const more = el("button", "ws-more", "⋯") as HTMLButtonElement;
      more.type = "button";
      more.dataset.act = "ws-more";
      more.title = tr("改名 / 移到最前 / 删除这个工作区");
      more.setAttribute("aria-label", tr("{p1} 的工作区菜单", { p1: group.name }));
      more.onclick = (ev) => {
        ev.stopPropagation();
        this.openWsMore(group, more);
      };
      more.onkeydown = (ev) => ev.stopPropagation();
      head.append(more);
    }
    const toggle = () => this.toggleWs(group.id);
    head.onclick = toggle;
    head.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    };
    sec.append(head);

    const cards = el("div", "session-cards");
    for (const s of group.sessions) cards.append(this.sessionCard(s));
    // 手建的空组：显示空态，不显示一个没有内容的组头（后端派生的组不可能为空，过滤态下整组会消失）。
    if (!group.sessions.length) cards.append(el("div", "empty ws-empty", tr("这个工作区里还没有会话。")));
    sec.append(cards);
    return sec;
  }

  private toggleWs(id: string): void {
    const has = this.prefs.wsCollapsed.includes(id);
    const wsCollapsed = has ? this.prefs.wsCollapsed.filter((x) => x !== id) : [...this.prefs.wsCollapsed, id];
    this.prefs = { ...this.prefs, wsCollapsed };
    savePrefs(this.prefs);
    // 折叠 / 展开都从组头上的 Enter（或点击）发起：重画把组头换成了新节点，焦点得跟回去，
    // 否则键盘用户按一下 Enter 就掉到 body，Tab 又得从头数。折叠只有本地一次重画，预算 1。
    this.pendingFocus = armFocus("ws", id);
    this.renderSessions();
  }

  /** 组头的 ⋯：改名 / 移到最前 / 删除。做不了的置灰并在菜单里写明原因，不把这个选择藏起来。 */
  private openWsMore(group: TreeGroup<SessionState>, anchor: HTMLElement): void {
    this.wsMenu?.close();
    const info = this.workspaces.groups.find((g) => g.id === group.id);
    const order = this.wsGroupOrder();
    this.wsMenu = openWsMenu(anchor, {
      name: group.name,
      sub: info && !info.manual ? info.key : tr("手建的工作区"),
      // #177：已经是第一时就地置灰 + 说明，而不是藏掉这颗（跟删除同一个套路）。
      // #178：旧桥没有 `order`（也不认识 ws.tabs），别给一个点下去会报「未知操作」的入口。
      frontBlocker: !this.wsOrder()
        ? tr("旧版桥不支持调整顺序")
        : order[0] === group.id
          ? tr("它已经是第一个了")
          : null,
      dropBlocker: dropBlocker(info, group.sessions.length),
      onRename: () => this.startWsRename(group.id),
      onFront: () => this.moveWsToFront(group.id),
      onDrop: () => this.dropWs(group.id),
    });
  }

  /** 桥下发的组序；旧桥没有这个字段（空数组也算新桥）。 */
  private wsOrder(): string[] | null {
    return Array.isArray(this.workspaces.order) ? this.workspaces.order : null;
  }

  /** #177：页面上那份组序 —— 优先桥下发的 `order`；旧桥没下发时退回树的组序（与标签行同一份兜底）。 */
  private wsGroupOrder(): string[] {
    const order = this.wsOrder();
    if (order?.length) return order;
    return buildTree(this.sessions, this.manage, this.workspaces, "").groups.map((group) => group.id);
  }

  /** #177：组头「移到最前」—— 用既有的 `ws.tabs { order }` 写回，不新增桥动作。 */
  private moveWsToFront(id: string): void {
    const next = moveToFront(this.wsGroupOrder(), id);
    if (!next) return;
    this.act(() => this.socket.send({ type: "manage", action: "ws.tabs", order: next }));
  }

  private startWsRename(id: string): void {
    this.wsRenameId = id;
    this.wsRenameDraft = this.workspaces.groups.find((g) => g.id === id)?.name ?? "";
    this.wsRenameFocus = true;
    // 收起的组里改不了名：先展开再画输入框。
    if (this.prefs.wsCollapsed.includes(id)) {
      const wsCollapsed = this.prefs.wsCollapsed.filter((x) => x !== id);
      this.prefs = { ...this.prefs, wsCollapsed };
      savePrefs(this.prefs);
    }
    this.renderSessions();
  }

  private cancelWsRename(): void {
    this.wsRenameId = null;
    this.wsRenameDraft = "";
    this.renderSessions();
  }

  /** 提交组名：空串 = 恢复成目录名（桥那边存空，显示时由 buildTree 回落）。名字没变就一个字都不发。 */
  private commitWsRename(): void {
    const id = this.wsRenameId;
    if (!id) return;
    const current = this.workspaces.groups.find((g) => g.id === id)?.name ?? "";
    const next = renameIntent(current, this.wsRenameDraft);
    this.wsRenameId = null;
    this.wsRenameDraft = "";
    this.renderSessions();
    if (next == null) return;
    this.act(() => this.socket.send({ type: "manage", action: "ws.rename", id, name: next }));
  }

  private dropWs(id: string): void {
    this.act(() => this.socket.send({ type: "manage", action: "ws.drop", id }));
  }

  private createWs(): void {
    // 组的 id 由桥生成，页面猜不出来：先要一个空组，等广播回来再进改名态。
    this.wsCreatePending = true;
    window.setTimeout(() => {
      this.wsCreatePending = false;
      this.wsCreateFromTabs = false;
    }, 5000);
    this.act(() => this.socket.send({ type: "manage", action: "ws.create", name: "" }));
  }

  /**
   * #175：横条末尾那颗 ＋ —— 与树底的「新建工作区」是同一条路（只发既有的 `ws.create`）。
   * 左栏收着时先把它展开：建完的组在树里进改名态，看不见输入框就没法起名。
   */
  private createWsFromTabs(): void {
    if (this.collapsed.sessions) this.togglePane("sessions");
    this.wsCreateFromTabs = true;
    this.createWs();
  }

  private sessionSection(kind: "archived", title: string, list: SessionState[]): HTMLElement {
    const sec = el("div", "session-sec");
    sec.dataset.sec = kind;
    const head = el("div", "sess-head");
    {
      const toggle = () => {
        this.archivedOpen = !this.archivedOpen;
        this.renderSessions();
      };
      const chev = el("span", "chev", this.archivedOpen ? "▾" : "▸");
      chev.onclick = toggle;
      const label = el("span", "label", title);
      label.onclick = toggle;
      head.append(chev, label);
    }
    head.append(el("span", "n", String(this.archivedTotal())));
    sec.append(head);

    const cards = el("div", "session-cards");
    for (const s of list) cards.append(this.sessionCard(s));
    sec.append(cards);
    return sec;
  }

  private sessionCard(s: SessionState): HTMLElement {
    const editing = this.renameId === s.id;
    const archived = this.manage.archived.includes(s.id);
    const cls = ["session-card"];
    if (s.id === this.currentId) cls.push("active");
    if (editing) cls.push("editing");
    if (archived) cls.push("archived");
    const card = el("div", cls.join(" "));
    card.dataset.id = s.id;
    // A button cannot host a text field, so the card is a div acting as one.
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.onclick = () => {
      if (editing) return; // clicking the editing card is not "open"
      this.openFromList(s.id);
    };
    card.onkeydown = (ev) => {
      if (ev.target !== card) return; // let the buttons and the input own their keys
      // #102：拖拽的键盘等价 —— Alt+方向键在组间搬 / 组内换位；别的修饰键组合照旧还给浏览器。
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "ArrowUp" || ev.key === "ArrowDown") {
          // 全局 Alt+←/→ 是预览的后退 / 前进（D63）：卡片上的组间搬运要拦在它前面。
          ev.preventDefault();
          ev.stopPropagation();
          this.keyNudge(card, ev);
          return;
        }
      }
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.click();
      }
    };
    // 拖拽只在树里（#99）：归档是全局分区，拖进任何工作区都说不清语义，干脆不让拖。
    if (!this.filter && !archived) {
      card.draggable = true;
      card.ondragstart = (ev) => {
        this.beginDrag(s.id);
        card.classList.add("dragging");
        ev.dataTransfer?.setData("text/plain", s.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      };
      card.ondragend = () => this.endDrag();
    }

    const row = el("div", "row");
    const bottomActs = el("span", "card-acts bottom");
    row.append(el("span", "grip", "⣿"));
    const dot = el("span", `dot ${s.running ? "busy" : s.owned ? "live" : ""}`);
    dot.title = s.running ? tr("运行中") : s.owned ? tr("网页已接管（pi 进程在本服务里）") : tr("未接管（只读历史；发消息会自动接管）");
    row.append(dot);
    if (editing) {
      const field = el("input", "rename-input");
      field.value = this.renameDraft;
      field.spellcheck = false;
      field.maxLength = 120;
      field.setAttribute("aria-label", tr("会话名称"));
      field.oninput = () => {
        this.renameDraft = field.value;
      };
      field.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.commitRename();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          this.cancelRename();
        }
      };
      field.onblur = () => {
        if (this.renameId === s.id) this.commitRename();
      };
      if (this.renameFocus || this.renameCaret != null) {
        const pos = this.renameFocus ? null : this.renameCaret ?? this.renameDraft.length;
        queueMicrotask(() => {
          field.focus();
          if (pos == null) field.select();
          else field.setSelectionRange(pos, pos);
        });
      }
      row.append(field);
    } else {
      row.append(el("span", "name", s.name || s.id.slice(0, 8)));
      const web = s.origin === "web";
      const src = el("span", `src-tag ${web ? "web" : "cli"}`, web ? tr("网页") : "CLI");
      src.title = web ? tr("在网页里新建的会话") : tr("在终端 pi CLI 里创建的会话");
      row.append(src);
      {
        const acts = el("span", "card-acts");
        const pinned = this.manage.pin.includes(s.id);
        const pin = el("button", `pin-btn${pinned ? " pinned" : ""}`, pinned ? "★" : "☆");
        pin.title = pinned ? tr("取消置顶") : tr("置顶");
        pin.setAttribute("aria-label", pin.title);
        pin.onclick = (ev) => {
          ev.stopPropagation();
          this.togglePin(s.id);
        };
        const rename = el("button", "rename-btn", "✎");
        rename.title = tr("改个名字");
        rename.setAttribute("aria-label", tr("重命名会话"));
        rename.onclick = (ev) => {
          ev.stopPropagation();
          this.startRename(s);
        };
        const archived = this.manage.archived.includes(s.id);
        const archive = el("button", "card-act");
        archive.append(...iconNodes(archived ? ICON_UNARCHIVE : ICON_ARCHIVE));
        archive.title = archived ? tr("取消归档（放回列表）") : tr("归档（收进「已归档」，文件不动）");
        archive.setAttribute("aria-label", archive.title);
        archive.onclick = (ev) => {
          ev.stopPropagation();
          // #189：归档只走这一个收口（`archiveIds`）—— 「这一批里有没有当前会话」只在那里判一次。
          this.archiveIds([s.id], !archived);
        };
        const armed = this.cardDelArm?.id === s.id;
        const busy = App.busy(s);
        const del = el("button", `card-act del${armed ? " armed" : ""}`) as HTMLButtonElement;
        if (armed) del.textContent = tr("删除?");
        else del.append(...iconNodes(ICON_TRASH));
        del.disabled = busy;
        del.title = busy ? App.busyWhy(s) : armed ? tr("再点一次：移入垃圾箱") : tr("删除（先进垃圾箱，可在会话管理里还原）");
        del.setAttribute("aria-label", tr("删除会话"));
        del.onclick = (ev) => {
          ev.stopPropagation();
          this.deleteOne(s.id);
        };
        acts.append(pin, rename);
        row.append(acts);
        bottomActs.append(archive, del);
      }
    }
    card.append(row);
    card.append(el("div", "cwd", s.cwd));
    const meta = el("div", "meta");
    meta.append(el("span", "", relativeTime(s.updatedAt)));
    const tail = el("span", "meta-tail");
    if (bottomActs.childElementCount) tail.append(bottomActs);
    // Bottom-right corner: the one thing worth interrupting for, worst first.
    const chipEl = this.badgeChip(s);
    if (chipEl) tail.append(chipEl);
    meta.append(tail);
    card.append(meta);
    // D136 的记号：跑着的会话在卡底留一把刻度尺，攒的格子就是时长。
    if (s.running) {
      const since = Date.parse(s.startedAt ?? "") || s.updatedAt;
      const ruler = el("div", "sc-ruler");
      ruler.dataset.since = String(since);
      drawRuler(ruler, since);
      card.append(ruler);
    }
    return card;
  }

  private matchesFilter(s: SessionState): boolean {
    const q = this.filter.toLowerCase();
    return !q || `${s.name} ${s.cwd}`.toLowerCase().includes(q);
  }

  private archivedTotal(): number {
    return this.sessions.filter((s) => this.manage.archived.includes(s.id) && this.matchesFilter(s)).length;
  }

  private dragNode(id: string): HTMLElement | null {
    return this.els.sessList.querySelector<HTMLElement>(`.session-card[data-id="${id}"]`);
  }

  /** #99：拖动开始 —— 挂上「放回工程」落点 + Esc / 窗口失焦的清理。 */
  private beginDrag(id: string): void {
    this.dragId = id;
    this.showPool(id);
    this.dragCleanup?.();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") this.endDrag();
    };
    const onBlur = () => this.endDrag();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    this.dragCleanup = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      this.dragCleanup = null;
    };
  }

  /** 拖完 / 取消 / 失焦：高亮、落点、监听全清掉；dragId 归零后松手不再动作。 */
  private endDrag(): void {
    this.dragId = null;
    this.clearDropLine();
    this.dragPool?.remove();
    this.dragPool = null;
    this.dragCleanup?.();
    for (const node of (this.dragScope?.el ?? this.els.sessList).querySelectorAll(".dragging")) node.classList.remove("dragging");
  }

  /** 「放回工程」：只在拖动时出现 —— 拖到它上面 = 删掉 override，回到 cwd 推导。 */
  private showPool(id: string): void {
    if (this.dragPool) return;
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    const pool = el("div", "ws-pool");
    pool.append(el("span", "label", tr("放回工程")));
    const name = this.projectNameOf(session);
    pool.append(el("span", "sub", name ? tr("按 cwd 回到「{p1}」", { p1: name }) : tr("按 cwd 回到推导出来的组")));
    const host = this.dropScope().el;
    const archived = host.querySelector<HTMLElement>('.session-sec[data-sec="archived"]');
    if (archived) host.insertBefore(pool, archived);
    else host.append(pool);
    this.dragPool = pool;
  }

  /** 会话的 cwd 本来会落在哪个组（忽略 override）：给「放回工程」落点写目标名。 */
  private projectNameOf(session: SessionState): string {
    const cwd = normalizeWsPath(session.cwd ?? "");
    if (!cwd) return "";
    const root = normalizeWsPath(this.workspaces.keys?.[cwd.toLowerCase()] ?? cwd);
    const id = root.toLowerCase();
    return (this.workspaces.groups ?? []).find((g) => g.id === id)?.name || "";
  }

  /**
   * #98：拖动落点的「量尺」。默认是左栏那棵树；B 那张浮层开着时换成浮层 —— 组 / 段头 / 行的
   * 类名不同，但量出来的 `DropHit` 与真正的落点判定（`hitTest()`）是同一份。
   */
  private dropScope(): { el: HTMLElement; group: string; head: string; item: string } {
    return this.dragScope ?? { el: this.els.sessList, group: ".ws-sec", head: ".ws-head", item: ".session-card" };
  }

  /**
   * #102：拖拽的键盘等价。卡片上 Alt+←/→ 搬到相邻组（发 `ws.move`，与指针跨组拖同一条路、
   * 同一个 `planDrop()`），Alt+↑/↓ 组内换位（重排后发 `arrange`，与指针同组拖同一条路）。
   * 到了边界（第一组的 ←、末组的 →、组顶 / 组底）就不动也不发；焦点由 renderSessions
   * 末尾的 `consumePendingFocus()` 还给移动后的那张卡。
   */
  private keyNudge(card: HTMLElement, ev: KeyboardEvent): void {
    const id = card.dataset.id ?? "";
    if (!id) return;
    const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
    const sideways = ev.key === "ArrowLeft" || ev.key === "ArrowRight";
    // 树序（buildTree 的输出序）就是组在左栏里的先后；现在开着浮层时卡片还没变，树还是那棵树。
    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    const wsIds = tree.groups.map((g) => g.id);
    if (sideways) {
      const plan = keyMovePlan(id, this.cardWs(id), wsIds, dir as -1 | 1);
      if (!plan) return;
      this.pendingFocus = armFocus("card", id);
      this.act(() => this.socket.send({ type: "manage", action: "ws.move", ids: plan.ids, wsId: plan.wsId }));
      return;
    }
    // 组内重排：先算出目标位，够不着（顶 / 底）就别折腾 DOM。
    const section = card.closest<HTMLElement>(".ws-sec");
    const cards = section?.querySelectorAll<HTMLElement>(".session-card");
    if (!section || !cards) return;
    const ids = [...cards].map((n) => n.dataset.id ?? "");
    const at = ids.indexOf(id);
    const to = keyShiftIndex(at, dir as -1 | 1, ids.length);
    if (to == null) return;
    // 与指针同组拖同一套：moveTo 重排（这段 DOM 直接摆），再 commitArrangement() 读 DOM 发 arrange。
    const after = moveTo(ids, id, to);
    for (const otherId of after) {
      const other = Array.from(cards).find((n) => n.dataset.id === otherId);
      if (other) section.querySelector(".session-cards")?.append(other);
    }
    this.pendingFocus = armFocus("card", id);
    this.commitArrangement();
  }

  /** 一整块树（或浮层）接管 dragover / drop：落点判定交给 `hitTest()`（纯函数，单测在 `web/tests/drag-unit.mjs`）。 */
  private wireTreeDrops(host: HTMLElement): void {
    host.ondragover = (ev) => {
      if (!this.dragId) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      this.paintDrop(this.hitAt(ev.clientY, host), host);
    };
    host.ondragleave = (ev) => {
      if (!this.dragId) return;
      // 在组与卡片之间移动也会冒 dragleave：只有真的离开树才清高亮。
      const to = ev.relatedTarget as Node | null;
      if (to && host.contains(to)) return;
      this.clearDropLine();
    };
    host.ondrop = (ev) => this.onTreeDrop(ev, host);
  }

  private onTreeDrop(ev: DragEvent, host: HTMLElement): void {
    const id = this.dragId;
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    const hit = this.hitAt(ev.clientY, host);
    const fromWs = this.cardWs(id);
    this.endDrag();
    if (!hit) return;
    const plan = planDrop(id, fromWs, hit);
    if (plan.action === "move" || plan.action === "restore") {
      // 跨组 / 放回工程都只发 ws.move：不重写 order，别的组的顺序一根手指都不碰。
      this.act(() => this.socket.send({ type: "manage", action: "ws.move", ids: plan.ids, wsId: plan.wsId }));
      return;
    }
    const node = this.dragNode(id);
    const cards = node?.parentElement;
    if (!node || !cards) return;
    const nodes = new Map([...cards.querySelectorAll<HTMLElement>(".session-card")].map((n) => [n.dataset.id ?? "", n]));
    // 组内重排：按落点插进去，再把这一组的新顺序读出来交给 arrange。
    for (const otherId of moveTo([...nodes.keys()], id, plan.index)) {
      const other = nodes.get(otherId);
      if (other) cards.append(other);
    }
    this.commitArrangement();
  }

  private paintDrop(hit: DropHit | null, host: HTMLElement = this.els.sessList): void {
    if (!hit) {
      this.clearDropLine();
      return;
    }
    // 落点线挂在「用户正在拖的那块」里：树的线不能画到浮层上（坐标是两套）。
    if (this.dropLine && this.dropLine.parentElement !== host) this.clearDropLine();
    let line = this.dropLine;
    if (!line) {
      line = el("div", "drop-line");
      host.append(line);
      this.dropLine = line;
    }
    line.style.top = `${Math.round(hit.line - host.getBoundingClientRect().top)}px`;
    line.dataset.ws = hit.wsId;
    line.dataset.index = String(hit.index);
    line.dataset.pool = String(hit.pool);
    line.title = hit.pool ? tr("放回工程") : "";
    this.dragPool?.classList.toggle("over", hit.pool);
  }

  private clearDropLine(): void {
    this.dropLine?.remove();
    this.dropLine = null;
    this.dragPool?.classList.remove("over");
  }

  /** 量一遍树：组、组里可见卡片（剔除拖动源自己）、「放回工程」。 */
  private hitAt(clientY: number, host: HTMLElement = this.dropScope().el): DropHit | null {
    const scope = this.dropScope();
    const groups = [...host.querySelectorAll<HTMLElement>(scope.group)].map((sec) => {
      const box = sec.getBoundingClientRect();
      const head = sec.querySelector<HTMLElement>(scope.head);
      const items = [...sec.querySelectorAll<HTMLElement>(scope.item)]
        .filter((card) => card.dataset.id !== this.dragId)
        .map((card) => {
          const r = card.getBoundingClientRect();
          return { id: card.dataset.id ?? "", top: r.top, bottom: r.bottom };
        })
        .filter((item) => item.bottom > item.top); // 收起的组：卡片量出来是 0 高，不算落点
      return {
        wsId: sec.dataset.ws ?? "",
        top: box.top,
        bottom: box.bottom,
        contentTop: head ? head.getBoundingClientRect().bottom : box.top,
        items,
      };
    });
    const poolEl = host.querySelector<HTMLElement>(".ws-pool");
    const pool = poolEl ? poolEl.getBoundingClientRect() : null;
    return hitTest(clientY, groups, pool ? { top: pool.top, bottom: pool.bottom } : null);
  }

  private cardWs(id: string): string {
    // 拖的可能是浮层里那一行：树里同名卡片与它同属一个组，先找树，再退回浮层。
    const node = this.dragNode(id) ?? this.wsPopBody?.querySelector<HTMLElement>(`.ws-pop-item[data-id="${id}"]`) ?? null;
    return node?.closest<HTMLElement>(this.dropScope().group)?.dataset.ws ?? "";
  }

  /** Read pin/order straight off the DOM after a drop: the DOM is what the user just arranged. */
  private commitArrangement(): void {
    const pin: string[] = [];
    const order: string[] = [];
    // 卡片的顺序是树里的顺序；★ 位置决定它进 pin 还是 order（★ 只在组内生效）。
    for (const card of this.els.sessList.querySelectorAll<HTMLElement>('.session-sec:not([data-sec="archived"]) .session-card')) {
      const id = card.dataset.id;
      if (!id) continue;
      if (this.manage.pin.includes(id)) pin.push(id);
      else order.push(id);
    }
    // The DOM cannot say where the cards the filter hides belong; keep their slots behind the rest.
    for (const s of this.sessions) {
      if (this.manage.archived.includes(s.id) || !this.matchesFilter(s)) continue;
      if (pin.includes(s.id) || order.includes(s.id)) continue;
      if (this.manage.pin.includes(s.id)) pin.push(s.id);
      else order.push(s.id);
    }
    this.sendArrangement(pin, order);
  }

  private sendArrangement(pin: string[], order: string[]): void {
    this.manage = { ...this.manage, pin, order };
    this.renderSessions();
    this.act(() => this.socket.send({ type: "manage", action: "arrange", pin, order }));
  }

  private togglePin(id: string): void {
    const pin = [...this.manage.pin];
    const order = this.manage.order.filter((x) => x !== id);
    const at = pin.indexOf(id);
    if (at >= 0) pin.splice(at, 1);
    else {
      pin.unshift(id);
      order.unshift(id);
    }
    this.sendArrangement(pin, order);
  }

  // ---------------------------------------------------------------- file preview
  private openArtifactsSheet(): void {
    if (!this.currentId) return;
    this.closeSheet();
    this.sheetKind = "display";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet art-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("本会话的产物")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const list = el("div", "art-list");
    const items = this.chat.artifacts();
    if (!items.length) list.append(el("div", "empty", tr("这个会话还没写过文件。AI 回复里提到的路径也可以直接点开预览。")));
    for (const it of items) {
      const row = el("button", "art-row");
      const name = it.path.split(/[\\/]/).filter(Boolean).pop() ?? it.path;
      row.append(el("span", "art-ico", previewIcon(it.path)), el("span", "art-name", name), el("span", "art-tool", it.tool === "write" ? tr("写入") : tr("修改")), el("span", "art-path", it.path));
      row.title = it.path;
      row.onclick = () => {
        this.closeSheet();
        void this.openPreview(it.path);
      };
      list.append(row);
    }
    // Free-form path: anything in the cwd or mentioned in the session.
    const foot = el("div", "art-foot");
    const input = el("input", "ns-input mono") as HTMLInputElement;
    input.placeholder = tr("输入路径预览（相对会话工作目录，或绝对路径）");
    const go = el("button", "btn", tr("预览"));
    const submit = () => {
      const p = input.value.trim();
      if (!p) return;
      this.closeSheet();
      void this.openPreview(p);
    };
    go.onclick = submit;
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") submit();
    };
    foot.append(input, go);
    sheet.append(head, list, foot);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
  }

  private async openPreview(path: string, sessionId: string | null = this.currentId, replace = false): Promise<void> {
    if (!sessionId) return;
    // 编辑中直接点别的文件：先问一句未保存的改动（D50）。
    const open = this.viewer;
    if (open?.pane === "edit" && open.dirty && open.info?.abs !== path) {
      if (!(await this.leaveEditor(open))) return;
    }
    // 打开一个新文件是历史里的一步；⟳ 刷新、返回/前进自己不算（D63）。
    if (!replace) {
      this.rememberScroll();
      this.pushStep({ path }, sessionId);
    }
    const v = this.ensureViewer();
    // 刚打开 / 换了一份文件：它该在终端上面（否则点了链接却看不见内容）。
    this.raiseWindow(v.root);
    v.sessionId = sessionId;
    v.pane = "preview";
    v.draft = null;
    v.dirty = false;
    v.conflict = null;
    v.ext = null;
    v.path = path;
    v.info = null;
    v.error = "";
    v.text = null;
    v.mode = "render";
    this.paintViewer();
    try {
      v.info = await api.preview(sessionId, path);
    } catch (err: any) {
      if (this.viewer !== v || v.path !== path) return;
      v.error = errText(err);
      this.paintViewer();
      return;
    }
    if (this.viewer !== v || v.path !== path) return;
    v.path = v.info.abs;
    // 相对路径解析成绝对路径之后，把刚记的那一步对齐，免得同一次打开留下两格。
    if (!replace) this.retargetTop(path, v.info.abs, sessionId);
    // D166: spreadsheet files leave the binary branch and open in their own dialog, not the viewer.
    if (v.info.kind === "sheet") {
      const info = v.info;
      this.closeViewer();
      this.openSheet(info);
      return;
    }
    // #113: CSV / TSV 也在浮窗里，但没有 xlsx 那种元数据——字节由页面自己解码、切格。
    if (/\.(csv|tsv)$/i.test(v.info.name)) {
      const info = v.info;
      this.closeViewer();
      void this.openCsvSheet(info, sessionId);
      return;
    }
    await this.loadViewerText();
  }

  /** #113：CSV / TSV 的浮窗——表格 / 源码两个 tab，编码嗅探在前端（D166），保存仍走文本通道。 */
  private async openCsvSheet(info: PreviewInfo, sessionId: string): Promise<void> {
    let data: CsvData;
    try {
      const res = await fetch(rawUrl(info));
      if (!res.ok) throw new Error(await res.text());
      data = readCsv(new Uint8Array(await res.arrayBuffer()));
    } catch (err: any) {
      this.warn(tr("读不了这个表格：{p1}", { p1: errText(err) }));
      return;
    }
    const metaOf = (d: CsvData): SheetMeta => ({
      name: info.name,
      rows: d.rows.length,
      cols: d.cols,
      sheets: [{ name: info.name, rows: d.rows.length, cols: d.cols }],
    });
    const windowOf = async (sheet: string, r0: number, r1: number, c0: number, c1: number): Promise<SheetWindow> =>
      csvWindow(data, sheet, r0, r1, c0, c1);
    // 只给完整的文件留保存：截断的只看到一部分，2 MB 以上桥端也不收。
    const saveable = !data.truncated && info.size <= CSV_MAX_BYTES;
    this.sheetDock?.destroy();
    this.sheetDock = null;
    const dialog = new SheetDialog({
      token: info.token,
      name: info.name,
      path: info.abs,
      raw: rawUrl(info),
      scale: () => this.uiScale(),
      loadMeta: async () => metaOf(data),
      fetchWindow: windowOf,
      // #107：CSV 的全文已经在前端内存里，但查找入口只给 .xlsx（本票范围）。
      onQuote: (text) => this.quoteInto(text),
      onOpen: () => this.openInApp(info.token),
      onReveal: () => this.reveal(info.abs),
      onReopen: () => void this.openPreview(info.abs, this.currentId, true),
      source: {
        text: data.text,
        note: data.truncated
          ? tr("只显示前 {p1} 行（共 {p2} 行），这么大的文件不能在浏览器里改", {
              p1: fmtNum(data.rows.length),
              p2: fmtNum(data.total),
            })
          : saveable
            ? undefined
            : tr("文件超过 {p1} MB，不能在浏览器里改", { p1: (info.size / 1024 / 1024).toFixed(1) }),
        onSave: saveable
          ? async (text) => {
              const res = await api.save(sessionId, { path: info.abs, text, mtime: info.mtime, size: info.size });
              info.mtime = res.mtime;
              info.size = res.size;
              data = reparseCsv(data, text);
              await dialog.setData(metaOf(data), windowOf);
            }
          : undefined,
      },
      onClose: () => {
        if (this.winFront === dialog.root) this.winFront = null;
        if (this.sheetDock === dialog) this.sheetDock = null;
      },
      onRaise: () => this.raiseWindow(dialog.root),
    });
    this.sheetDock = dialog;
    this.overlay(dialog.root);
    this.raiseWindow(dialog.root);
    dialog.open();
  }

  /** D166: 表格浮窗（无遮罩、不抢焦点）。关掉旧的那扇再开新的。 */
  private openSheet(info: PreviewInfo): void {
    this.sheetDock?.destroy();
    this.sheetDock = null;
    const dialog = new SheetDialog({
      token: info.token,
      name: info.name,
      path: info.abs,
      raw: rawUrl(info),
      scale: () => this.uiScale(),
      loadMeta: () => api.sheetMeta(info.token),
      fetchWindow: (sheet, r0, r1, c0, c1) => api.sheetWindow(info.token, sheet, r0, r1, c0, c1),
      // #107：整表查找在桥端扫（前端只拿着一个可视窗口）。
      findSheet: (sheet, q) => api.sheetFind(info.token, sheet, q),
      onQuote: (text) => this.quoteInto(text),
      // #112：有图表的文件自动转一次 PDF；没有的也能手动切过去看打印版式。
      page: { token: info.token },
      onOpen: () => this.openInApp(info.token),
      onReveal: () => this.reveal(info.abs),
      // 文件被改过：要新的 token，所以整扇重开一趟（旧的那扇由 openSheet 拆）。
      onReopen: () => void this.openPreview(info.abs, this.currentId, true),
      onClose: () => {
        if (this.winFront === dialog.root) this.winFront = null;
        if (this.sheetDock === dialog) this.sheetDock = null;
      },
      onRaise: () => this.raiseWindow(dialog.root),
    });
    this.sheetDock = dialog;
    this.overlay(dialog.root);
    this.raiseWindow(dialog.root);
    dialog.open();
  }

  /** md / text / html-source need the bytes; html and images load by url. */
  private async loadViewerText(force = false): Promise<void> {
    const v = this.viewer;
    const info = v?.info;
    if (!v || !info) return;
    const needs = info.kind === "markdown" || info.kind === "text" || (info.kind === "html" && v.mode === "source");
    if (needs && v.text == null) {
      if (info.size > 3 * 1024 * 1024 && !force) {
        v.error = tr("文件有 {p1} MB，太大了，用「新标签页」打开看。", { p1: (info.size / 1024 / 1024).toFixed(1) });
        this.paintViewer();
        return;
      }
      this.paintViewer();
      try {
        const res = await fetch(rawUrl(info));
        if (!res.ok) throw new Error(await res.text());
        v.text = await res.text();
      } catch (err: any) {
        v.error = errText(err);
      }
      if (this.viewer !== v || v.info !== info) return;
    }
    this.paintViewer();
  }

  private ensureViewer(): Viewer {
    if (this.viewer) return this.viewer;
    const root = el("aside", "viewer");
    const saved = Number(localStorage.getItem("pi.viewerW"));
    if (saved >= 320) root.style.setProperty("--viewer-w", `${saved}px`);
    const grip = el("div", "viewer-grip");
    grip.title = tr("拖动调整宽度");
    grip.onpointerdown = (ev) => {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      root.classList.add("resizing");
      // 自动全屏之后这次拖拽就结束了：别再把那个巨大宽度写进记忆（否则退出全屏前先关面板会留脏值）。
      let autoFull = false;
      const finish = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        root.classList.remove("resizing");
        try {
          if (grip.hasPointerCapture(ev.pointerId)) grip.releasePointerCapture(ev.pointerId);
        } catch {
          /* already gone */
        }
      };
      const move = (e: PointerEvent) => {
        // 一直往左拖到把聊天区盖满，就不再是「调宽度」而是一整屏：直接进全屏，拖拽随之结束。
        // 判据是聊天区自己的左缘（而不是百分比），所以侧栏宽窄、窗口大小都不影响。
        if (this.viewerCoversChat(e.clientX)) {
          autoFull = true;
          finish();
          this.viewerFull(true, false); // 拖出来的全屏不持久化：下一个预览不该一打开就满屏
          return;
        }
        // `clientX` / `innerWidth` 是**视觉** px，写进 `--viewer-w` 的是**布局** px（#app 的 zoom）——
        // 不除这个系数，1.25 字号下拖出来的面板会比鼠标宽 25%，分隔条永远跑在指针前面。
        const s = this.uiScale();
        const w = Math.max(320, Math.min((window.innerWidth - 120) / s, (window.innerWidth - e.clientX) / s));
        root.style.setProperty("--viewer-w", `${Math.round(w)}px`);
      };
      const up = () => {
        finish();
        if (autoFull) return;
        const w = parseInt(root.style.getPropertyValue("--viewer-w"), 10);
        if (w) localStorage.setItem("pi.viewerW", String(w));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
      grip.addEventListener("pointercancel", up, { once: true });
    };
    const head = el("div", "viewer-head");
    const body = el("div", "viewer-body");
    root.append(grip, head, body);
    root.tabIndex = -1;
    this.wireWindowRaise(root);
    root.onkeydown = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.closeViewer();
      }
    };
    this.overlay(root);
    this.raiseWindow(root);
    this.viewer = {
      root,
      head,
      body,
      sessionId: "",
      path: "",
      info: null,
      error: "",
      text: null,
      mode: "render",
      full: localStorage.getItem("pi.viewerFull") === "1",
      pane: "preview",
      draft: null,
      dirty: false,
      lastDir: localStorage.getItem("pi.fsDir") ?? "",
      conflict: null,
      frame: null,
      framePath: "",
      frameToken: "",
      ext: null,
      pendingScroll: 0,
    };
    return this.viewer;
  }

  /** Only our own /raw/ urls may be opened in a tab: never trust a url that came from elsewhere. */
  private openRawTab(url: string): void {
    // SAFETY: only the bridge's own /raw/… path reaches window.open, never an arbitrary URL.
    if (!url.startsWith("/raw/")) return;
    openSameOrigin(url);
  }

  private closeViewer(): void {
    const v = this.viewer;
    if (!v) return;
    // 编辑中关掉面板：先问一下未保存的改动（D50）。
    if (v.pane === "edit" && v.dirty) {
      void this.leaveEditor(v).then((ok) => {
        if (ok) this.closeViewer();
      });
      return;
    }
    if (this.winFront === v.root) this.winFront = null;
    v.root.remove();
    this.viewer = null;
  }

  /**
   * 拖到把聊天区整个盖住时，这条分隔条就没有「调宽度」的意义了，该是一整屏。
   * 判据用聊天区自己的左缘，所以侧栏宽窄、窗口大小都不影响；`clientX` 是拖的那条分隔条（= 面板左缘）。
   */
  private viewerCoversChat(clientX: number): boolean {
    const chat = this.els.chatPane;
    // 聊天区被收成 0 宽时没有「覆盖」可言（那时它本来就不在画面上）。
    if (!chat || !chat.offsetWidth) return false;
    return clientX <= chat.getBoundingClientRect().left + 1;
  }

  /**
   * 全屏只是状态，宽度记忆不跟着它走：退出全屏一律回到默认宽度（CSS 里的 `--viewer-w`，
   * `min(760px, 55vw)`）并忘掉上次拖出来的宽度，这样“退出全屏”之后每次都是同一块地方。
   * `persist: false` 是拖拽触发的自动全屏 —— 它不该让**下一个**预览也一打开就满屏。
   */
  private viewerFull(on: boolean, persist = true): void {
    const v = this.viewer;
    if (!v || v.full === on) return;
    v.full = on;
    if (persist) localStorage.setItem("pi.viewerFull", on ? "1" : "0");
    if (!on) {
      // 回到默认宽度：去掉拖拽写上的内联值，也清掉记忆（下次从默认值开始）。
      localStorage.removeItem("pi.viewerW");
      v.root.style.removeProperty("--viewer-w");
    }
    this.paintViewer();
  }

  /**
   * D69: 把文件交给这台电脑自己的文件管理器（打开所在目录、并把文件选中）。
   * 这是「浏览器里打不开这个格式」时唯一有用的退路：xlsm / pdf / docx 就该用 Excel / Acrobat 打开。
   * 只对本机 / 局域网开放 —— 桥那边对公网连接直接 403。
   */
  private revealButton(abs: string): HTMLButtonElement {
    const btn = el("button", "btn", tr("📂 在文件夹中显示")) as HTMLButtonElement;
    btn.title = tr("在这台电脑的文件管理器里打开 {p1}，文件会被选中", { p1: abs });
    btn.onclick = () => {
      btn.disabled = true;
      api
        .reveal(abs)
        .then((res) => this.warn(res.message))
        .catch((err: Error) => this.warn(tr("打不开文件管理器：{p1}", { p1: err.message })))
        .finally(() => {
          btn.disabled = false;
        });
    };
    return btn;
  }

  /** #106 出口：把预览过的那份文件交给这台电脑上的 Excel。路径由桥端从凭据里解，页只递 token。 */
  private async openInApp(token: string): Promise<void> {
    try {
      this.warn((await api.openFile(token)).message);
    } catch (err: any) {
      this.warn(tr("打不开文件：{p1}", { p1: errText(err) }));
    }
  }

  private async reveal(abs: string): Promise<void> {
    try {
      this.warn((await api.reveal(abs)).message);
    } catch (err: any) {
      this.warn(tr("打不开文件管理器：{p1}", { p1: errText(err) }));
    }
  }

  // ------------------------------------------------------- 预览历史（D63）
  /** 每个会话一条栈；第一次用到才建。 */
  private histOf(sessionId: string): { steps: VStep[]; at: number } {
    let h = this.vhist.get(sessionId);
    if (!h) {
      h = { steps: [], at: -1 };
      this.vhist.set(sessionId, h);
    }
    return h;
  }

  /** 记一步。重复打开同一份文件不会多出一格（只把位置移过去）。
   *  路径比较要归一化：同一个文件可能以 \\ 或 / 两种写法进来。 */
  private pushStep(step: VStep, sessionId: string): void {
    const h = this.histOf(sessionId);
    const cur = h.steps[h.at];
    if (cur && samePath(cur.path, step.path)) return;
    if (cur && !cur.path && !step.path && (cur.url ?? "") === (step.url ?? "")) return;
    h.steps = h.steps.slice(0, h.at + 1);
    h.steps.push(step);
    // 往前记着新的一步，说明后退分支已经作废（和浏览器的行为一致）。
    if (h.steps.length > HISTORY_MAX) h.steps.shift();
    h.at = h.steps.length - 1;
  }

  /** 相对路径解析成绝对路径之后，把刚记的那一步对齐。 */
  private retargetTop(raw: string, abs: string, sessionId: string): void {
    if (samePath(raw, abs)) return;
    const h = this.histOf(sessionId);
    const top = h.steps[h.at];
    if (top && top.path && samePath(top.path, raw)) top.path = abs;
  }

  /** 记下「当前这一步」的滚动位置：普通预览从 body 拿，html 由页面点击时上报（y 传入）。 */
  private rememberScroll(y?: number): void {
    const v = this.viewer;
    if (!v) return;
    const h = this.histOf(v.sessionId);
    const top = h.steps[h.at];
    if (!top) return;
    const pos = typeof y === "number" && y > 0 ? y : v.info?.kind === "html" ? -1 : (v.body?.scrollTop ?? -1);
    if (pos >= 0) top.y = pos;
  }

  private goStep(delta: number): void {
    const v = this.viewer;
    if (!v) return;
    const h = this.histOf(v.sessionId);
    const at = h.at + delta;
    if (at < 0 || at >= h.steps.length) return;
    this.rememberScroll();
    h.at = at;
    void this.openStep(h.steps[at]);
  }

  private async openStep(step: VStep): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    if (step.path) {
      await this.openPreview(step.path, v.sessionId, true);
      if (step.y) this.restoreScroll(step.y);
      return;
    }
    this.showExt(v, step.url ?? "", step.label ?? tr("外部链接"));
  }

  /** 切到一个「不是文件」的占位态：外站、或跳出目录树被 403 的那一跳（D63）。
   *  头部、正文、← → 都跟着换成占位，否则头部还挂着上一个文件名。 */
  private showExt(v: Viewer, url: string, label: string): void {
    v.ext = { url, label };
    v.path = url || label;
    v.info = null;
    v.error = "";
    v.text = null;
    v.mode = "render";
    v.pane = "preview";
    this.paintViewer();
  }

  private restoreScroll(y: number): void {
    const v = this.viewer;
    if (!v || !y) return;
    if (v.info?.kind === "html" && v.mode === "render" && v.frame) {
      // iframe 可能还没 load，先存着，load 里再发一次。
      v.pendingScroll = y;
      try {
        v.frame.contentWindow?.postMessage({ t: "pi-scroll", y }, "*");
      } catch {
        /* frame not ready */
      }
      return;
    }
    v.body.scrollTop = y;
  }

  /**
   * iframe 里的页面点了链接（D63）。页面自己已经跳过去了，这里只做两件事：
   * 把「现在打开的是谁」对齐，把这一跳记进返回栈。
   */
  private async trackRawNav(rel: string, href: string, y: number, tk: string): Promise<void> {
    const v = this.viewer;
    if (!v) return;
    this.rememberScroll(y);
    const cur = v.info;
    const external = safeExternalUrl(href);
    if (!rel || !cur) {
      // 外站，或者 ../ 跳出目录树（那边会 403）：记一格占位，← 依然能回来。
      this.pushStep({ path: null, url: external ?? undefined, label: external ? hostOf(external) : tr("跳出了目录树") }, v.sessionId);
      this.showExt(v, external ?? "", external ? hostOf(external) : tr("跳出了目录树"));
      return;
    }
    const abs = absFromRel(cur.root, rel);
    let next: PreviewInfo;
    try {
      next = await api.preview(v.sessionId, abs);
    } catch {
      this.pushStep({ path: null, label: tr("{p1}（打不开）", { p1: abs }) }, v.sessionId);
      this.showExt(v, "", tr("{p1}（打不开）", { p1: abs }));
      return;
    }
    if (this.viewer !== v) return;
    this.pushStep({ path: next.abs }, v.sessionId);
    if (next.kind === "html") {
      // iframe 已经在显示它了：只对齐头部，不要重挂 iframe（那会白跳一次回原文件）。
      v.path = next.abs;
      v.info = next;
      v.mode = "render";
      v.ext = null;
      v.framePath = next.abs;
      if (tk) v.frameToken = tk;
      this.paintViewer();
      return;
    }
    await this.openPreview(next.abs, v.sessionId, true);
  }

  private paintViewer(): void {
    const v = this.viewer;
    if (!v) return;
    const { root, head, body, info } = v;
    root.classList.toggle("full", v.full);
    head.replaceChildren();
    const title = el("div", "viewer-title");
    const browsing = v.pane === "browse";
    const name = info?.name ?? (v.ext ? v.ext.label : browsing ? tr("浏览本机文件") : (v.path.split(/[\\/]/).filter(Boolean).pop() ?? v.path));
    title.append(el("span", "viewer-ico", browsing && !info ? "📁" : v.ext ? "🔗" : previewIcon(name)), el("span", "viewer-name", name));
    const subText = info ? `${info.abs} · ${fmtSize(info.size)}` : v.ext ? v.ext.url : browsing ? v.lastDir || this.session?.cwd || tr("此电脑") : v.path;
    const sub = el("div", "viewer-path", subText);
    sub.title = info?.abs ?? subText;
    const left = el("div", "viewer-titles");
    left.append(title, sub);
    // 返回 / 前进：历史是「这个会话看过哪些文件」，关预览不丢（D63）。
    const h = this.histOf(v.sessionId);
    const nav = el("div", "viewer-nav");
    const back = el("button", "viewer-btn", "←") as HTMLButtonElement;
    back.title = tr("后退（Alt+←）");
    back.disabled = h.at <= 0;
    if (!back.disabled) back.onclick = () => this.goStep(-1);
    const fwd = el("button", "viewer-btn", "→") as HTMLButtonElement;
    fwd.title = tr("前进（Alt+→）");
    fwd.disabled = h.at >= h.steps.length - 1;
    if (!fwd.disabled) fwd.onclick = () => this.goStep(1);
    nav.append(back, fwd);
    const tools = el("div", "viewer-tools");
    const tbtn = (text: string, tip: string, fn: () => void, on = false) => {
      const b = el("button", `viewer-btn${on ? " on" : ""}`, text) as HTMLButtonElement;
      b.title = tip;
      b.onclick = fn;
      tools.append(b);
      return b;
    };
    // 浏览 / 预览 / 编辑：同一个面板的三种状态（D50）
    const panes = el("div", "viewer-seg pane-seg");
    for (const [p, label] of [
      ["browse", tr("浏览")],
      ["preview", tr("预览")],
      ["edit", tr("编辑")],
    ] as const) {
      const b = el("button", v.pane === p ? "on" : "", label) as HTMLButtonElement;
      if (p === "edit" && !this.editable(v)) {
        b.disabled = true;
        b.title = !info
          ? tr("先预览一个文本文件")
          : info.kind === "binary"
            ? tr("二进制文件改不了")
            : info.size > MAX_EDIT_BYTES
              ? tr("超过 2 MB，浏览器里改不了")
              : tr("只有 md / text 能编辑");
      }
      if (p === "preview" && !info) b.disabled = true;
      b.onclick = () => void this.setPane(p);
      panes.append(b);
    }
    tools.append(panes);
    if (info && (info.kind === "markdown" || info.kind === "html") && v.pane === "preview") {
      const seg = el("div", "viewer-seg");
      for (const [m, label] of [["render", tr("渲染")], ["source", tr("源码")]] as const) {
        const b = el("button", v.mode === m ? "on" : "", label);
        b.onclick = () => {
          if (v.mode === m) return;
          v.mode = m;
          void this.loadViewerText();
        };
        seg.append(b);
      }
      tools.append(seg);
    }
    tbtn("⟳", tr("刷新（重新读取文件）"), () => void this.openPreview(v.path, v.sessionId, true));
    if (info) {
      const open = tbtn("↗", tr("在新标签页打开"), () => this.openRawTab(rawUrl(info)));
      open.classList.add("wide-only");
      const copy = tbtn("⧉", tr("复制路径"), () => void navigator.clipboard?.writeText(info.abs));
      copy.classList.add("wide-only");
      tbtn("📎", tr("把这个路径引用到输入框"), () => this.insertPaths([info.abs]));
    }
    tbtn(v.full ? "🗗" : "⛶", v.full ? tr("退出全屏") : tr("全屏"), () => this.viewerFull(!v.full), v.full);
    tbtn("✕", tr("关闭（Esc）"), () => this.closeViewer());
    head.append(nav, left, tools);

    // 浏览态：列表挂上就保持状态（滚动、筛选、当前位置），重绘时不要拆掉（D50）。
    if (v.pane === "browse") {
      v.frame = null;
      if (!body.querySelector(":scope > .viewer-browse")) this.mountBrowser(v);
      return;
    }
    if (v.pane === "edit") {
      v.frame = null;
      this.mountEditor(v);
      return;
    }
    body.removeAttribute("data-edit-path");
    // Keep an html iframe alive across header-only repaints (its own state / scroll matter).
    const frame = body.querySelector<HTMLIFrameElement>("iframe.viewer-frame");
    if (info?.kind === "html" && v.mode === "render" && !v.error && frame && v.framePath === info.abs) return;

    body.replaceChildren();
    body.className = "viewer-body";
    v.frame = null;
    if (v.ext) {
      // 外链 / 越界：应用里没东西可渲染，只说清楚发生了什么并给个出口（D63）。
      const box = el("div", "viewer-msg ext");
      box.append(el("div", "", v.ext.url || v.ext.label));
      const href = safeExternalUrl(v.ext.url);
      if (href) {
        // 只开 http(s)：这个地址来自用户自己的页面，不是我们要重定向的地方。
        const url = href;
        const open = el("button", "btn", tr("在新标签打开"));
        open.onclick = () => openExternal(url);
        box.append(open);
      }
      box.append(el("div", "viewer-tip", tr("← 回到上一个文件")));
      body.append(box);
      return;
    }
    if (v.error) {
      const box = el("div", "viewer-msg err");
      box.append(el("div", "", v.error));
      if (info) {
        const open = el("button", "btn", tr("新标签页打开"));
        open.onclick = () => this.openRawTab(rawUrl(info));
        box.append(open, this.revealButton(info.abs));
      }
      body.append(box);
      return;
    }
    if (!info) {
      body.append(viewerLoading(tr("正在打开…")));
      return;
    }
    const url = rawUrl(info);
    if (info.kind === "html" && v.mode === "render") {
      const f = el("iframe", "viewer-frame") as HTMLIFrameElement;
      // No allow-same-origin: the page runs in an opaque origin and cannot reach this app.
      f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads");
      f.referrerPolicy = "no-referrer";
      f.src = url;
      f.dataset.src = url;
      v.frame = f;
      v.framePath = info.abs;
      v.frameToken = info.token;
      f.addEventListener("load", () => {
        if (!v.pendingScroll) return;
        try {
          f.contentWindow?.postMessage({ t: "pi-scroll", y: v.pendingScroll }, "*");
        } catch {
          /* frame went away */
        }
        v.pendingScroll = 0;
      });
      body.classList.add("frame");
      body.append(f);
      return;
    }
    if (info.kind === "image") {
      const img = el("img", "viewer-img") as HTMLImageElement;
      img.src = url;
      img.alt = info.name;
      body.classList.add("image");
      body.append(img);
      return;
    }
    if (info.kind === "binary") {
      // #106: .xls / .ods / 加密包 / 改了扩展名的 zip — 这里不看，交给这台电脑上的默认程序。
      const workbook = WORKBOOK.test(info.name);
      const box = el("div", workbook ? "viewer-msg workbook" : "viewer-msg");
      box.append(
        el(
          "div",
          "",
          workbook ? tr("这个格式这里不支持，用本机程序打开") : tr("二进制文件（{p1}），这里不直接显示。", { p1: fmtSize(info.size) }),
        ),
      );
      if (workbook) {
        const open = el("button", "btn", tr("用默认程序打开"));
        open.onclick = () => {
          open.disabled = true;
          void this.openInApp(info.token).finally(() => {
            open.disabled = false;
          });
        };
        box.append(open);
      }
      const dl = el("button", "btn", tr("新标签页打开 / 下载"));
      dl.onclick = () => openSameOrigin(url);
      // D69: the useful move for an xlsm / pdf / docx is the machine's own file manager, not a download.
      // 公网不泄本机路径（US 46）：桥端已把 binary 的 abs 抹空，这里就不给「在文件夹中显示」。
      box.append(dl);
      if (info.abs) box.append(this.revealButton(info.abs));
      body.append(box);
      return;
    }
    if (v.text == null) {
      body.append(viewerLoading(tr("正在读取…")));
      return;
    }
    if (info.kind === "markdown" && v.mode === "render") {
      const doc = el("article", "md-doc");
      const dir = url.slice(0, url.lastIndexOf("/") + 1);
      doc.append(
        renderMarkdown(v.text, {
          doc: true,
          openPath: (p) => void this.openPreview(resolveFrom(info.abs, p), v.sessionId),
          imageSrc: (src) => {
            if (/^[A-Za-z]:[\\/]|^\//.test(src) || /^data:/i.test(src)) return null;
            try {
              return new URL(src, location.origin + dir).pathname;
            } catch {
              return null;
            }
          },
        }),
      );
      body.append(doc);
      return;
    }
    const pre = el("pre", "viewer-src");
    // Q-031: 代码/配置类文件按扩展名上色；不认识的语言、超过 200 KB 的文件保持纯文本。
    const hl = highlightFragment(v.text, info.name);
    const lines = v.text.split(/\r?\n/);
    const gutter = el("div", "ln-gutter", lines.map((_, k) => k + 1).join("\n"));
    const code = el("code");
    if (hl === null) {
      code.textContent = v.text;
    } else {
      code.className = "hl";
      code.append(hl);
      pre.classList.add("hl");
      pre.dataset.lang = langOf(info.name) ?? "";
    }
    pre.append(gutter, code);
    body.append(pre);
  }

  // ---------------------------------------------------------------- file explorer (D50)
  /** md / text 且 ≤ 2 MB（与桥端 rememberEditable 的判定一致）。 */
  private editable(v: Viewer): boolean {
    const info = v.info;
    if (!info) return false;
    if (info.kind !== "markdown" && info.kind !== "text") return false;
    return info.size <= MAX_EDIT_BYTES;
  }

  /** 📁 文件：viewer 直接停在浏览态，接着上次的目录。 */
  // ---------------------------------------------------------------- 记录（D108）
  // ---------------------------------------------------------------- AI 出错记录（D164）

  /**
   * 账本挂在工作区上（worktree 由桥并回主仓）。判据与顶部「当前工作区」chip 同一份（`wsOf`）：
   * override → 列表 ws → 快照 ws → cwd 反查。分组还没到的极早期退回 cwd 本身，
   * 免得这一次入账丢在空 id 上；下一次 `failures.get` 会用桥的真 id 读回同一本。
   */
  private currentWs(): string {
    const hit = this.currentWsId();
    if (hit) return hit;
    const cwd = String(this.session?.cwd ?? "");
    return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  private wsName(ws: string): string {
    const named = this.workspaces.groups.find((g) => g.id === ws)?.name?.trim();
    if (named) return named;
    const cwd = String(this.session?.cwd ?? "").replace(/[\\/]+$/, "");
    return cwd.split(/[\\/]/).pop() || ws;
  }

  /** 聊天区报来一次失败。按 toolCallId 去重：同一张卡会被 live 事件、item.replace、重放各建一次。 */
  private recordFail(f: { id: string; tool: string; cmd: string; out: string; at?: string; live?: boolean }): void {
    if (!this.currentId || !f.id || this.sessionFails.has(f.id)) return;
    const seen: SeenFail = { callId: f.id, tool: f.tool, cmd: f.cmd, out: f.out, at: f.at || new Date().toISOString() };
    this.sessionFails.set(f.id, seen);
    // 只有刚跑完的那次才可能「当场叫住」：刷新页面回放历史时别再对着老失败念一遍。
    if (f.live) this.maybeRemind(seen);
    this.syncFailCta();
  }

  /**
   * 当场叫住（D164 延伸）：同一轮里同类第二次出现 —— 或账本里这一类已经栽过 3 次 —— 时，
   * 让桥往会话里补一条自动提醒。判节流在桥那边（同类每会话一次、整会话最多 3 次），
   * 这里只决定「值不值得叫」：benign（grep 没命中这类半正常）和用户中断不叫，它们不是毛病。
   */
  private maybeRemind(f: SeenFail): void {
    const sid = this.currentId;
    if (!sid) return;
    let key = "";
    let sig = "";
    let cause = "";
    try {
      const d = diagnose({ tool: f.tool, cmd: f.cmd, out: f.out });
      if (d.level !== "fail" && d.level !== "warn") return;
      cause = d.cause ?? "";
      const code = classify(f.tool, f.out, exitCodeOf(f.out));
      sig = normalizeSig(f.cmd, f.tool, f.out);
      key = entryKey(f.tool, code, sig);
    } catch {
      return; // 诊断只是锦上添花：判不出来就安静
    }
    if (this.failReminded.has(key) || this.failRemindPending.has(key)) return;
    // 同一类在这个会话里到第几次了（按同样的钥匙重算，不能拿 toolCallId 比）。
    const same = [...this.sessionFails.values()].filter((o) => sameFail(o, key)).length;
    const old = this.failLedger?.entries.find((e) => e.key === key);
    const ripe = Boolean(old && old.count >= 3 && !old.fixedAt && !old.ignoredAt);
    if (same < 2 && !ripe) return;
    this.failRemindPending.add(key);
    this.socket.send({
      type: "failures.remind",
      ws: this.currentWs() ?? "",
      sid,
      key,
      tool: f.tool,
      sig,
      why: cause,
      n: Math.max(same, old?.count ?? 0),
    });
  }

  /** 这个会话还有几次失败没进账本：见过的条数 - 上次入账时的条数（点完按钮、账本回包后归零）。 */
  private uncommittedFails(): number {
    const ws = this.currentWs();
    const sid = this.currentId ?? "";
    if (!ws || !sid || this.failWs !== ws) return 0;
    const done = this.failLedger?.sessions[sid]?.n ?? 0;
    return Math.max(0, this.sessionFails.size - done);
  }

  /** 只在「任务结束、还有没入账的失败」时亮；跑着的时候不打扰。 */
  private syncFailCta(): void {
    const btn = this.failCta;
    if (!btn) return;
    const n = this.uncommittedFails();
    const s = this.session;
    const show = Boolean(s) && !s?.running && !s?.starting && n > 0;
    btn.hidden = !show;
    btn.classList.toggle("busy", this.failReviewPending);
    if (!show) {
      this.closeFailMenu();
      return;
    }
    if (this.failReviewPending) {
      btn.replaceChildren(el("span", "fail-cta-glyph", "⚡"), el("span", "fail-cta-text", tr("复盘进行中…")), el("span", "fail-cta-n", String(n)));
      btn.title = tr("正在把这一轮失败发给 pi 复盘");
      return;
    }
    const reviewed = this.failReviewed();
    btn.replaceChildren(
      el("span", "fail-cta-glyph", "⚡"),
      el("span", "fail-cta-text", tr("总结本轮错误")),
      el("span", "fail-cta-n", String(n)),
      el("span", "fail-cta-caret", "▾"),
    );
    btn.classList.toggle("done", reviewed >= n);
    btn.title = tr("把这次会话里的 {p1} 次失败归并进「⚡ AI 出错记录」：同类只加次数", { p1: n });
    if (this.failMenu) this.paintFailMenu();
  }

  /** 这个会话已经复盘过几条（桥落盘的数，刷新 / 换设备都还在）。 */
  private failReviewed(): number {
    const sid = this.currentId ?? "";
    if (!sid || this.failRulesWs !== (this.currentWs() ?? "")) return 0;
    return this.failRules?.reviewed?.[sid]?.n ?? 0;
  }

  private failButton(): HTMLButtonElement {
    const btn = el("button", "fail-cta") as HTMLButtonElement;
    btn.type = "button";
    btn.hidden = true;
    btn.setAttribute("aria-haspopup", "menu");
    btn.onclick = (ev) => {
      ev.stopPropagation();
      if (this.failMenu) this.closeFailMenu();
      else this.openFailMenu();
    };
    return btn;
  }

  /** 单击弹小卡：两个举动各自写清代价（记进账本花 0、复盘烧一轮 token）。 */
  private openFailMenu(): void {
    const btn = this.failCta;
    const row = btn?.parentElement;
    if (!btn || !row) return;
    this.closeFailMenu();
    const box = el("div", "fail-menu");
    box.setAttribute("role", "menu");
    row.append(box);
    this.failMenu = box;
    this.paintFailMenu();
    const away = (ev: Event) => {
      if (box.contains(ev.target as Node) || btn.contains(ev.target as Node)) return;
      this.closeFailMenu();
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") this.closeFailMenu();
    };
    this.failMenuAway = away;
    this.failMenuEsc = esc;
    // 用 pointerdown 而不是 click：点在菜单外的地方时，菜单先收起，那一下才落地。
    window.setTimeout(() => {
      if (this.failMenu !== box) return;
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", esc, true);
    }, 0);
  }

  private closeFailMenu(): void {
    this.failMenu?.remove();
    this.failMenu = null;
    if (this.failMenuAway) document.removeEventListener("pointerdown", this.failMenuAway, true);
    if (this.failMenuEsc) document.removeEventListener("keydown", this.failMenuEsc, true);
    this.failMenuAway = null;
    this.failMenuEsc = null;
  }

  private paintFailMenu(): void {
    const box = this.failMenu;
    if (!box) return;
    const n = this.uncommittedFails();
    const classes = reviewClasses(this.sessionFails.values()).length;
    const reviewed = this.failReviewed();
    const head = el("div", "fail-menu-head");
    head.append(el("span", "", tr("本轮 {p1} 次失败 · 归成 {p2} 类", { p1: n, p2: classes })));
    if (reviewed > 0) head.append(el("span", `fail-menu-state${reviewed >= n ? " done" : ""}`, tr("已复盘 {p1}", { p1: reviewed })));

    const item = (glyph: string, title: string, desc: string, act: () => void): HTMLButtonElement => {
      const b = el("button", "fail-menu-item") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("role", "menuitem");
      const t = el("div", "fail-menu-t");
      t.append(el("span", "fail-menu-glyph", glyph), el("span", "", title));
      b.append(t, el("div", "fail-menu-d", desc));
      b.onclick = (ev) => {
        ev.stopPropagation();
        act();
      };
      return b;
    };

    const commit = item("🗂", tr("记进账本"), tr("同类只加次数，不花 token"), () => this.commitFails());
    const review = item(
      "⚡",
      this.failReviewPending ? tr("正在复盘…") : tr("发到会话复盘"),
      reviewed >= n && !this.failReviewPending
        ? tr("这 {p1} 次已经复盘过；再发会再烧一轮 token", { p1: reviewed })
        : tr("开一轮：{p1} 类账本视角 + 一句规矩", { p1: classes }),
      () => this.reviewFails(),
    );
    if (this.failReviewPending) review.disabled = true;
    box.replaceChildren(head, commit, review);
  }

  /**
   * 「发到会话复盘」：把这个会话的失败归并成类交给桥，由桥把**账本视角**写成一段话发进来。
   * 原文不用带:那几步就在同一个会话里，带一遍只是烧 token。
   */
  private reviewFails(): void {
    const ws = this.currentWs();
    const sid = this.currentId;
    if (!ws || !sid || this.failReviewPending) return;
    const classes = reviewClasses(this.sessionFails.values());
    const n = this.sessionFails.size;
    if (!classes.length || !n) {
      this.flashToast(tr("这一轮没有可复盘的失败"), true, 2600);
      return;
    }
    this.failReviewPending = true;
    this.closeFailMenu();
    this.syncFailCta();
    this.socket.send({ type: "failures.review", ws, sid, n, classes: classes.slice(0, 20) });
  }

  /** 桥回不回得来都要告诉人一句：这一下动的是模型，不是账本。 */
  private reviewWhy(reason: string): string {
    if (reason === "offline") return tr("这个会话没在跑，先随便说一句话把它叫起来");
    if (reason === "empty") return tr("这一轮没有可复盘的失败");
    return reason || tr("桥那边没给理由");
  }

  /**
   * 复盘回写的规矩：把 `[pi-web:rule]` 行交给桥（同键覆盖）。
   * 已经存过的同键同文就跳过 —— 重放历史、刷新页面都会再撞`onAnswer` 一次，不能每次都写文件。
   */
  private takeRules(text: string): void {
    const ws = this.currentWs();
    if (!ws) return;
    for (const r of parseRules(text)) {
      if (this.failRules?.rules.some((o) => o.key === r.key && o.rule === r.rule)) continue;
      this.socket.send({ type: "rules.set", ws, key: r.key, rule: r.rule });
    }
  }

  private setFailRules(book: RuleBook | null): void {
    this.failRules = book;
    this.failRulesWs = book?.ws ?? "";
    this.notesSheet?.setRules(book);
    this.syncFailCta();
  }

  /** 点一下：每一条失败跑一遍 diagnose（拿「为什么没成」和修法），整批交给桥去归并。 */
  private commitFails(): void {
    const ws = this.currentWs();
    const sid = this.currentId;
    if (!ws || !sid || !this.sessionFails.size) return;
    // 只送还没入账的那一段：账本按 key 累加，重发旧条目会把次数翻倍（审查发现）。
    const done = this.failLedger?.sessions?.[sid]?.n ?? 0;
    const fresh = [...this.sessionFails.values()].slice(Math.min(done, this.sessionFails.size));
    const items = [];
    for (const f of fresh) {
      let why = "";
      let fix = "";
      try {
        const d = diagnose({ tool: f.tool, cmd: f.cmd, out: f.out });
        if (d.level === "fail" || d.level === "warn") why = d.cause ?? "";
        fix = d.improve || d.needsYou || "";
      } catch {
        /* 诊断只是锦上添花：判不出来也要入账 */
      }
      items.push(toCommit(f, why, fix));
    }
    if (!items.length) return;
    if (this.failCta) this.failCta.hidden = true;
    this.socket.send({
      type: "failures.commit",
      ws,
      label: this.wsName(ws),
      sid,
      sname: this.session?.name ?? "",
      at: new Date().toISOString(),
      entries: items,
    });
  }

  private setFailLedger(ledger: FailLedger): void {
    this.failLedger = ledger;
    this.failWs = ledger.ws;
    this.notesSheet?.setFailures(ledger);
    this.syncFailCta();
  }

  private failSaved(msg: any): void {
    if (msg.error) {
      this.flashToast(tr("没记进账本：{p1}", { p1: String(msg.error) }), true, 6000);
      return;
    }
    if (msg.ledger) this.setFailLedger(msg.ledger as FailLedger);
    if (msg.undone) {
      this.flashToast(tr("已撤销这次入账"), false, 2600);
      return;
    }
    // 标已修复 / 忽略 / 删除的回包也走这条路：账本刷新就够了，别弹「没有新的失败」。
    if (!msg.token) return;
    const n = Number(msg.added ?? 0);
    if (!n) {
      this.flashToast(tr("这次没有新的失败"), false, 2600);
      return;
    }
    this.flashToast(tr("已记进账本 · {p1} 次 · 可撤销", { p1: n }), false, 10000, String(msg.token ?? ""));
  }

  /** 一条几秒后自己消失的小提示（入账可撤销 / #175 新建的组收进了 ＋N）。同一时刻只留一条。 */
  private flashToast(text: string, bad: boolean, ms: number, token = ""): void {
    this.failToast?.remove();
    window.clearTimeout(this.failToastTimer);
    const box = el("div", `fail-toast${bad ? " bad" : ""}`);
    box.append(el("span", "", text));
    if (token) {
      const undo = el("button", "fail-toast-undo", tr("撤销"));
      undo.onclick = () => {
        box.remove();
        this.socket.send({ type: "failures.undo", token });
      };
      box.append(undo);
    }
    document.body.append(box);
    this.failToast = box;
    this.failToastTimer = window.setTimeout(() => {
      box.remove();
      if (this.failToast === box) this.failToast = null;
    }, ms);
  }

  /** 顶栏 🐞：本地随手记，不跟会话走，所以没有 currentId 也能开。 */
  private openNotes(): void {
    if (!this.notesSheet) {
      const notesHost: NotesHost = {
        send: (msg) => this.socket.send(msg),
        notes: () => this.notes,
        session: () => (this.currentId ? { id: this.currentId, name: this.session?.name ?? "" } : null),
        prefill: (text) => this.prefill(text),
        newSessionWith: (text) => this.newSessionWith(text),
      };
      const sheet = new NotesSheet(notesHost);
      sheet.onClose = () => {
        this.notesSheet = null;
      };
      sheet.mount(document.getElementById("app") ?? document.body);
      this.notesSheet = sheet;
      sheet.setFailures(this.failLedger);
      sheet.setRules(this.failRules);
      this.act(() => this.socket.send({ type: "notes.list" }));
      if (this.currentWs()) {
        this.socket.send({ type: "failures.get", ws: this.currentWs() });
        this.socket.send({ type: "rules.get", ws: this.currentWs() });
      }
    }
    this.notesSheet.focusComposer();
  }

  private setNotes(notes: Note[]): void {
    this.notes = notes;
    this.notesSheet?.setNotes(notes);
    this.paintNotesBadge();
  }

  private paintNotesBadge(): void {
    const btn = this.els.notes;
    if (!btn) return;
    const count = this.notes.filter((n) => n.status === "pending").length;
    // 顶栏只要图标：小字「bug N」把这一行挤得没地方，计数放 title 里。
    btn.replaceChildren(el("span", "notes-glyph", "🐞"));
    btn.classList.toggle("has-pending", count > 0);
    btn.title = count ? tr("记录：{p1} 条待处理（Ctrl+Shift+B）", { p1: count }) : tr("记录 bug / 变更 / 想法 / 杂事（Ctrl+Shift+B）");
  }

  /** 「交给 agent → 预填到当前会话」：只填，不发送。 */
  private prefill(text: string): void {
    if (!this.textarea || !this.currentId) {
      this.newSessionWith(text);
      return;
    }
    this.textarea.value = text;
    this.composerText = text;
    this.noteDraft();
    this.fitComposer();
    this.textarea.focus();
    this.textarea.setSelectionRange(text.length, text.length);
  }

  /**
   * #107：表格里「引用给 pi」——把「文件路径 + A2:C4」插到对话框光标处。
   * 只插入、不发送，也不盖掉已经写了一半的草稿。
   */
  private quoteInto(text: string): void {
    const field = this.textarea;
    if (!field || !this.currentId) return;
    const base = field.value;
    const start = field.selectionStart ?? base.length;
    const end = field.selectionEnd ?? start;
    const lead = start > 0 && !/\s/.test(base[start - 1]) ? " " : "";
    const ins = `${lead}${text}`;
    const next = `${base.slice(0, start)}${ins}${base.slice(end)}`;
    this.composerText = next;
    this.noteDraft();
    field.value = next;
    const caret = start + ins.length;
    field.focus();
    field.setSelectionRange(caret, caret);
    this.fitComposer();
  }

  /** 「交给 agent → 新开会话」：会话建好之后才填（见 case "session"）。 */
  private newSessionWith(text: string): void {
    this.prefillNext = text;
    this.openNewSessionSheet();
  }

  private openFiles(): void {
    if (!this.currentId) return;
    const v = this.ensureViewer();
    v.sessionId = this.currentId;
    if (v.pane === "edit" && v.dirty) {
      void this.leaveEditor(v).then((ok) => {
        if (ok) this.openFiles();
      });
      return;
    }
    if (!v.lastDir) v.lastDir = localStorage.getItem("pi.fsDir") ?? this.session?.cwd ?? "";
    v.pane = "browse";
    this.paintViewer();
  }

  /**
   * Q-019: every directory browser (文件管理器 / 附件选择器 / 新会话 sheet) gets a 工作目录 button in
   * the dir-picker's `head` slot, so "迷路了" is one click back to the session cwd instead of a
   * breadcrumb crawl. `getCwd` is re-read on click, so 切会话 while the pane is open still lands right.
   */
  private dirHome(getCwd: () => string): { node: HTMLButtonElement; bind: (picker: DirPicker) => void } {
    const node = el("button", "btn ghost dir-home", tr("⌂ 工作目录")) as HTMLButtonElement;
    node.dataset.act = "dir-home";
    const sync = (): void => {
      const cwd = (getCwd() || "").trim();
      node.disabled = !cwd;
      node.title = cwd ? tr("回到会话的工作目录 {p1}", { p1: cwd }) : tr("还没有会话，也就没有工作目录可回");
    };
    sync();
    return {
      node,
      bind: (picker) => {
        sync();
        node.onclick = () => {
          const cwd = (getCwd() || "").trim();
          if (cwd) void picker.go(cwd);
        };
      },
    };
  }

  /**
   * D71: 「复制路径」——把下面正在浏览的那个目录的路径复制走（工作目录按钮只管「跳回」，不管「拿走」）。
   * 剪贴板在 http 的局域网地址上是 undefined，所以 optional chaining 必须包住调用本身。
   */
  private dirCopy(getPath: () => string): { node: HTMLButtonElement; bind: () => void } {
    const node = el("button", "btn ghost dir-copy", tr("⧉ 复制路径")) as HTMLButtonElement;
    node.dataset.act = "dir-copy";
    const sync = (): void => {
      const path = (getPath() || "").trim();
      node.disabled = !path;
      node.title = path ? tr("复制目录路径 {p1}", { p1: path }) : tr("先在下面选一个目录（盘符列表没有路径可复制）");
    };
    sync();
    return {
      node,
      bind: () => {
        sync();
        node.onclick = () => {
          const path = (getPath() || "").trim();
          if (!path) return;
          const copy = navigator.clipboard?.writeText(path);
          if (!copy) {
            this.warn(tr("这个地址不是安全上下文（http 局域网），浏览器不允许读剪贴板"));
            return;
          }
          void copy.then(() => {
            node.textContent = tr("已复制");
            setTimeout(() => {
              if (node.isConnected) node.textContent = tr("⧉ 复制路径");
            }, 1100);
          });
        };
      },
    };
  }

  /**
   * D163: 「引用当前文件夹」——把下面正在浏览的目录插进输入框。目录行点一下是「进去」、
   * 文件行才「引用」，所以「我想让 pi 看这个目录」原来没有出口。
   * 含空格才包引号：`C:\Program Files\x` 裸着会被读成两个路径；没空格的包上反而多两处要删。
   */
  private dirRef(getPath: () => string): { node: HTMLButtonElement; bind: () => void } {
    const label = tr("📎 引用当前文件夹");
    const node = el("button", "btn ghost dir-ref", label) as HTMLButtonElement;
    node.dataset.act = "dir-ref";
    const sync = (): void => {
      const path = (getPath() || "").trim();
      node.disabled = !path;
      node.title = path ? tr("把目录 {p1} 引用到输入框", { p1: path }) : tr("盘符列表没有目录可引用，先点进一个文件夹");
    };
    const flash = (text: string): void => {
      node.textContent = text;
      setTimeout(() => {
        if (node.isConnected) node.textContent = label;
      }, 1200);
    };
    sync();
    return {
      node,
      bind: () => {
        sync();
        node.onclick = () => {
          const path = (getPath() || "").trim();
          if (!path) return;
          const text = /\s/.test(path) ? `"${path}"` : path;
          if (hasPathToken(this.composerText, text)) {
            flash(tr("已在输入框"));
            return;
          }
          this.insertPaths([text]);
          flash(tr("已引用"));
        };
      },
    };
  }

  /** D163: 附件弹层给每个会话记一份「上次打开的目录」；没有会话 id 就不读不写（宁可退回 cwd）。 */
  private attachDirKey(): string {
    const id = this.session?.id ?? "";
    return id ? `pi.attachDir:${id}` : "";
  }

  private attachStart(): string {
    const key = this.attachDirKey();
    // 隐私模式 / 关了本地存储时 getItem 会抛：记忆是锦上添花，不该把弹层带塌。
    let remembered = "";
    try {
      remembered = key ? (localStorage.getItem(key) ?? "").trim() : "";
    } catch {
      remembered = "";
    }
    return remembered || this.session?.cwd || "";
  }

  /** 每换一个目录就写一次，顺手把超过 30 条的最旧会话清掉（删掉的会话不该一直占着键）。 */
  private rememberAttachDir(path: string): void {
    const key = this.attachDirKey();
    if (!key || !path) return;
    try {
      localStorage.setItem(key, path);
      const used = (localStorage.getItem(ATTACH_DIR_INDEX) ?? "").split("\n").filter(Boolean);
      const next = [...used.filter((k) => k !== key), key];
      while (next.length > ATTACH_DIR_KEEP) localStorage.removeItem(next.shift() as string);
      localStorage.setItem(ATTACH_DIR_INDEX, next.join("\n"));
    } catch {
      /* 存不下就算了：下次打开退回 cwd。 */
    }
  }

  /**
   * D167: 「＋ 文件夹」/「＋ 文件」—— 文件管理器与附件弹层共用这一份。
   * 路径行上两颗按钮，点开一行输入框（预填「新建文件夹」/「新建文件」并全选，回车就建）；
   * 建完**停在当前目录**，由调用方刷新并高亮新行 —— 不进入目录、不打开文件、不替你选中它。
   */
  private mkControls(opts: { parent: () => string; made: (abs: string) => void }): {
    dirBtn: HTMLButtonElement;
    fileBtn: HTMLButtonElement;
    row: HTMLElement;
    sync: (state: DirPickerState) => void;
  } {
    const dirBtn = el("button", "btn ghost dir-mk dir-mk-dir", tr("＋ 文件夹")) as HTMLButtonElement;
    dirBtn.title = tr("在当前目录下新建文件夹");
    const fileBtn = el("button", "btn ghost dir-mk dir-mk-file", tr("＋ 文件")) as HTMLButtonElement;
    fileBtn.title = tr("在当前目录下新建文件（0 字节；同名文件不会被覆盖）");

    const row = el("div", "dir-mkrow");
    row.hidden = true;
    const input = el("input", "ns-input mono") as HTMLInputElement;
    // 和桥端 makeFile/makeDir 的上限对齐：255 个字符。
    input.maxLength = 255;
    const ok = el("button", "btn primary", tr("创建")) as HTMLButtonElement;
    const cancel = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    const err = el("div", "ns-error dir-mkerr");
    const fields = el("div", "ns-row");
    fields.append(input, ok, cancel);
    row.append(fields, err);

    let kind: "dir" | "file" = "dir";
    let busy = false;
    /** 上一次看到的目录：换了目录就把没提交的名字收掉，免得回车建到新目录里去。 */
    let lastPath: string | null = null;
    const setBusy = (on: boolean): void => {
      busy = on;
      input.disabled = on;
      ok.disabled = on;
      ok.textContent = on ? tr("创建中…") : tr("创建");
    };
    const close = (): void => {
      row.hidden = true;
      err.textContent = "";
      input.value = "";
      kind = "dir";
    };
    const open = (next: "dir" | "file"): void => {
      if (busy || !opts.parent()) return;
      kind = next;
      row.hidden = false;
      err.textContent = "";
      input.placeholder = next === "dir" ? tr("新文件夹名") : tr("新文件名");
      input.value = next === "dir" ? tr("新建文件夹") : tr("新建文件");
      input.focus();
      input.select();
    };
    dirBtn.onclick = () => open("dir");
    fileBtn.onclick = () => open("file");
    cancel.onclick = () => {
      if (!busy) close();
    };
    const submit = (): void => {
      const name = input.value.trim();
      const parent = opts.parent();
      if (!parent || busy) return;
      if (!name) {
        // 措辞跟桥端 `${kind}名不能为空` 对齐：空名字不值得为一句「不能为空」多跑一个来回。
        err.textContent = kind === "dir" ? tr("文件夹名不能为空") : tr("文件名不能为空");
        return;
      }
      if (/[\\/]/.test(name)) {
        err.textContent = tr("名字里不能有 / 或 \\（一次只建一层）");
        return;
      }
      this.act(() => {
        const reqId = `mk:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const sent = kind;
        setBusy(true);
        err.textContent = "";
        const timer = setTimeout(() => {
          if (!this.mkWaits.delete(reqId)) return;
          setBusy(false);
          err.textContent = tr("服务端没有响应，稍后再试");
        }, 15000);
        this.mkWaits.set(reqId, (res) => {
          clearTimeout(timer);
          if (!row.isConnected) return;
          setBusy(false);
          if (res.error || !res.path) {
            err.textContent = res.error ? errText(res) : tr("创建失败");
            input.focus();
            return;
          }
          // 关掉输入行再刷新：新行高亮由调用方在列表回来后补（dirpicker 的 navigate 会清高亮）。
          close();
          opts.made(res.path);
        });
        this.socket.send({ type: sent === "dir" ? "mkdir" : "mkfile", reqId, parent, name });
      });
    };
    ok.onclick = submit;
    input.onkeydown = (ev) => {
      if (ev.isComposing) return;
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        if (!busy) close();
      }
    };

    return {
      dirBtn,
      fileBtn,
      row,
      // 盘符页 / 读不了的目录：没有「当前目录」，两颗按钮先收起来；换了目录也把没提交的那行收掉。
      sync: (state) => {
        const usable = !!state.path && !state.error;
        for (const btn of [dirBtn, fileBtn]) btn.hidden = !usable;
        const moved = state.path !== lastPath;
        lastPath = state.path;
        if ((!usable || moved) && !busy) close();
      },
    };
  }

  /** D167: 建完停在原地 —— 重列当前目录，再把新行标成 `.hit`（navigate 会先清掉上一次的高亮）。 */
  private revealMade(picker: DirPicker, abs: string): void {
    const name = fileNameOf(abs);
    const here = picker.path();
    void picker.go(here).then(() => picker.reveal(name));
  }

  private mountBrowser(v: Viewer): void {
    const body = v.body;
    body.replaceChildren();
    body.className = "viewer-body browse";
    const host = el("div", "viewer-browse");
    body.append(host);
    const home = this.dirHome(() => this.session?.cwd ?? "");
    // D71: the copy button reads the picker live, so it always copies the directory actually listed.
    let pickerPath = (): string => "";
    const copy = this.dirCopy(() => pickerPath());
    // D167: 建完停在原地 —— 重新列一遍当前目录，再把新行标出来。
    const mk = this.mkControls({
      parent: () => pickerPath(),
      made: (abs) => this.revealMade(picker, abs),
    });
    const picker = mountDirPicker(host, {
      start: v.lastDir || this.session?.cwd || "",
      files: true,
      fallback: true,
      pathBox: true,
      head: [home.node, copy.node, mk.dirBtn, mk.fileBtn],
      beforeList: [mk.row],
      onState: (s) => {
        mk.sync(s);
        copy.bind();
        if (!s.path) return;
        v.lastDir = s.path;
        localStorage.setItem("pi.fsDir", s.path);
      },
      onPick: (abs) => void this.pickFromBrowser(v, abs),
      onContext: (abs, name, ev) => this.fileMenu(v, abs, name, ev),
    });
    pickerPath = () => picker.path();
    home.bind(picker);
    copy.bind();
  }

  /** Q-008: right-click a file — run a script with PowerShell, or elevated on the desktop. */
  private fileMenu(v: Viewer, abs: string, name: string, ev: MouseEvent): void {
    const script = /\.(ps1|psm1|cmd|bat)$/i.test(name);
    const cwd = v.lastDir || this.session?.cwd || "";
    const items: { label: string; run: () => void }[] = [];
    if (script) {
      items.push({
        label: tr("用 PowerShell 运行"),
        run: () => this.act(() => this.socket.send({ type: "open.script", file: abs, cwd, admin: false })),
      });
      items.push({
        label: tr("以管理员身份运行"),
        run: () => this.act(() => this.socket.send({ type: "open.script", file: abs, cwd, admin: true })),
      });
    }
    items.push({ label: tr("打开"), run: () => void this.pickFromBrowser(v, abs) });
    items.push({ label: tr("复制路径"), run: () => void navigator.clipboard?.writeText(abs) });
    this.showMenu(ev.clientX, ev.clientY, items);
  }

  private showMenu(x: number, y: number, items: { label: string; run: () => void }[]): void {
    document.querySelector(".ctx-menu")?.remove();
    const menu = el("div", "ctx-menu");
    for (const item of items) {
      const button = el("button", "ctx-item", item.label);
      button.onclick = () => {
        menu.remove();
        item.run();
      };
      menu.append(button);
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 40 * items.length - 12)}px`;
    document.body.append(menu);
    const close = (e: Event): void => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "pointerdown" && menu.contains(e.target as Node)) return;
      menu.remove();
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
  }

  /** 浏览里点了一个文件：交给现有五种 kind 打开。 */
  private async pickFromBrowser(v: Viewer, abs: string): Promise<void> {
    if (this.viewer !== v) return;
    if (!(await this.leaveEditor(v))) return;
    await this.openPreview(abs, v.sessionId);
  }

  private async setPane(pane: ViewerPane): Promise<void> {
    const v = this.viewer;
    if (!v || v.pane === pane) return;
    if (pane === "edit" && !this.editable(v)) return;
    if (!(await this.leaveEditor(v))) return;
    if (pane === "edit") {
      v.draft = v.text;
      v.conflict = null;
      v.dirty = false;
    }
    v.pane = pane;
    if (pane === "browse" && !v.lastDir) v.lastDir = localStorage.getItem("pi.fsDir") ?? this.session?.cwd ?? "";
    this.paintViewer();
  }

  /** 离开编辑态前问一句：保存 / 放弃 / 取消。true = 可以走。 */
  private async leaveEditor(v: Viewer): Promise<boolean> {
    if (v.pane !== "edit" || !v.dirty) return true;
    const ta = v.body.querySelector<HTMLTextAreaElement>(".ed-ta");
    if (ta) v.draft = ta.value;
    const name = v.info?.name ?? tr("文件");
    const choice = await this.choose(tr("「{p1}」还没保存", { p1: name }), [
      { id: "save", label: tr("保存"), primary: true },
      { id: "drop", label: tr("放弃改动") },
      { id: "cancel", label: tr("取消") },
    ]);
    if (choice === "save") return this.saveViewer();
    if (choice === "drop") {
      v.dirty = false;
      v.draft = v.text;
      return true;
    }
    return false;
  }

  private mountEditor(v: Viewer): void {
    const info = v.info;
    if (!info) return;
    const body = v.body;
    // 重绘不重建：重建会丢光标、滚动位置与撤销栈。
    if (body.dataset.editPath === info.abs && body.querySelector(".ed-ta")) return;
    body.replaceChildren();
    body.className = "viewer-body edit";
    body.dataset.editPath = info.abs;
    const wrap = el("div", "ed");
    const gutter = el("div", "ed-gutter");
    // Q-034: 编辑态也上色 —— 底下铺一层同字体、同 padding 的 <pre><code class="hl">，
    // textarea 自己的文字保持透明，只负责光标、选区、输入法；三层（行号 / 高亮 / 输入）一起滚动。
    const code = el("div", "ed-code");
    const pre = el("pre", "ed-hl hl");
    const hl = el("code", "hl");
    pre.append(hl);
    const ta = el("textarea", "ed-ta") as HTMLTextAreaElement;
    ta.value = v.draft ?? v.text ?? "";
    ta.wrap = "off";
    ta.spellcheck = false;
    const useHl = Boolean(langOf(info.name));
    code.classList.toggle("plain", !useHl);
    let hlTimer = 0;
    const paintHl = (): void => {
      if (!useHl) return;
      // 结尾换行时 textarea 会多显示一行空行，这里补一个零宽字符让 <pre> 也占住那一行。
      const text = ta.value.endsWith("\n") ? `${ta.value}\u200b` : ta.value;
      const frag = ta.value.length > HL_MAX_BYTES ? null : highlightFragment(text, info.name);
      hl.replaceChildren();
      if (frag) hl.append(frag);
      else hl.textContent = text;
    };
    const scheduleHl = (): void => {
      if (!useHl) return;
      window.clearTimeout(hlTimer);
      hlTimer = window.setTimeout(paintHl, 60);
    };
    const sync = (): void => {
      const n = ta.value.split("\n").length;
      if (gutter.dataset.n !== String(n)) {
        gutter.dataset.n = String(n);
        let s = "";
        for (let i = 1; i <= n; i++) s += `${i}\n`;
        gutter.textContent = s;
      }
      gutter.scrollTop = ta.scrollTop;
    };
    ta.oninput = () => {
      v.draft = ta.value;
      v.dirty = true;
      v.conflict = null;
      sync();
      scheduleHl();
    };
    ta.onscroll = () => {
      gutter.scrollTop = ta.scrollTop;
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };
    // 输入法组字期间没法把透明文字和下层高亮对齐（候选框里的字只有 textarea 自己有），
    // 先把自己的字显出来、把高亮层藏起来，组完字再切回去。
    ta.addEventListener("compositionstart", () => code.classList.add("composing"));
    ta.addEventListener("compositionend", () => {
      code.classList.remove("composing");
      scheduleHl();
    });
    ta.onkeydown = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void this.saveViewer();
        return;
      }
      // Esc 只退出输入框，不该把整块面板关掉（未保存的改动会没）。
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ta.blur();
        return;
      }
      if (ev.key === "Tab") {
        ev.preventDefault();
        ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
        v.draft = ta.value;
        v.dirty = true;
        sync();
      }
    };
    sync();
    paintHl();
    code.append(pre, ta);
    wrap.append(gutter, code);

    const path = el("div", "ed-path", info.abs);
    path.title = info.abs;
    const msg = el("div", "ed-msg", "");
    const foot = el("div", "ed-foot");
    const drop = el("button", "btn ghost", tr("放弃"));
    drop.onclick = async () => {
      if (!v.dirty) return;
      const ok = await this.choose(tr("放弃「{p1}」的改动？", { p1: info.name }), [
        { id: "yes", label: tr("放弃"), danger: true },
        { id: "cancel", label: tr("取消"), primary: true },
      ]);
      if (ok !== "yes") return;
      v.dirty = false;
      v.draft = null;
      await this.openPreview(info.abs, v.sessionId);
    };
    const save = el("button", "btn primary", tr("保存"));
    save.title = "Ctrl / ⌘ + S";
    save.onclick = () => void this.saveViewer();
    foot.append(path, msg, drop, save);
    body.append(wrap, foot);
    if (v.conflict) this.paintConflict(v, info.abs);
  }

  /** 磁盘上的文件被 pi 改过了：覆盖 / 另存副本 / 放弃（重新读取）。 */
  private paintConflict(v: Viewer, abs: string): void {
    const body = v.body;
    body.querySelector(".ed-conflict")?.remove();
    const bar = el("div", "ed-conflict");
    bar.append(el("div", "ed-conflict-txt", tr("这个文件在你编辑期间被改过了（可能是 pi 写的）")));
    const row = el("div", "ed-conflict-row");
    const overwrite = el("button", "btn ghost", tr("覆盖磁盘上的版本"));
    overwrite.onclick = () => void this.overwriteFile(v, abs);
    const copy = el("button", "btn ghost", tr("另存副本"));
    copy.onclick = () => void this.saveAsCopy(v, abs);
    const reload = el("button", "btn ghost", tr("放弃我的改动"));
    reload.onclick = () => {
      v.dirty = false;
      v.draft = null;
      v.conflict = null;
      void this.openPreview(abs, v.sessionId);
    };
    row.append(overwrite, copy, reload);
    bar.append(row);
    body.append(bar);
  }

  private async overwriteFile(v: Viewer, abs: string): Promise<void> {
    const ta = v.body.querySelector<HTMLTextAreaElement>(".ed-ta");
    if (!ta) return;
    v.draft = ta.value;
    // 重新拿一份 mtime/size，保存就不会再撞 409（用户明确选了「覆盖」）。
    try {
      v.info = await api.preview(v.sessionId, abs);
    } catch (err: any) {
      this.toastInEditor(v, errText(err));
      return;
    }
    v.conflict = null;
    if (v.info.kind !== "markdown" && v.info.kind !== "text") {
      this.toastInEditor(v, tr("文件已经不是文本了，没法再编辑"));
      return;
    }
    await this.saveViewer();
  }

  private async saveAsCopy(v: Viewer, abs: string): Promise<void> {
    const ta = v.body.querySelector<HTMLTextAreaElement>(".ed-ta");
    if (!ta || !v.info) return;
    try {
      const r = await api.save(v.sessionId, { path: abs, text: ta.value, mtime: v.info.mtime, size: v.info.size, copy: true });
      v.dirty = false;
      v.draft = null;
      v.conflict = null;
      await this.openPreview(r.path, v.sessionId);
      this.warn(tr("已另存为 {p1}", { p1: r.path }));
    } catch (err: any) {
      this.toastInEditor(v, errText(err));
    }
  }

  private toastInEditor(v: Viewer, text: string): void {
    const msg = v.body.querySelector<HTMLElement>(".ed-msg");
    if (!msg) return;
    msg.textContent = text;
    msg.className = "ed-msg err";
  }

  /** 写回：带乐观锁（mtime + size），409 就换成冲突条。 */
  private async saveViewer(): Promise<boolean> {
    const v = this.viewer;
    const ta = v?.body.querySelector<HTMLTextAreaElement>(".ed-ta");
    if (!v?.info || !ta) return false;
    const text = ta.value;
    v.draft = text;
    const msg = v.body.querySelector<HTMLElement>(".ed-msg");
    try {
      const r = await api.save(v.sessionId, { path: v.info.abs, text, mtime: v.info.mtime, size: v.info.size });
      v.text = text;
      v.info = { ...v.info, mtime: r.mtime, size: r.size };
      v.dirty = false;
      v.conflict = null;
      if (msg) {
        msg.textContent = tr("已保存 · {p1}", { p1: fmtTime() });
        msg.className = "ed-msg ok";
      }
      return true;
    } catch (err: any) {
      if (err?.status === 409) {
        v.conflict = errText(err);
        // 上一条「已保存」此刻已经过时，别让它和冲突条并排站着。
        if (msg) {
          msg.textContent = "";
          msg.className = "ed-msg";
        }
        this.paintConflict(v, v.info.abs);
        return false;
      }
      this.toastInEditor(v, errText(err));
      return false;
    }
  }

  /** 两三个选项的小弹窗，返回选中的 id（背景点击 / Esc 算 cancel）。 */
  private choose(title: string, buttons: { id: string; label: string; primary?: boolean; danger?: boolean }[]): Promise<string> {
    return new Promise((resolve) => {
      const back = el("div", "choose-back");
      const box = el("div", "choose");
      box.append(el("div", "choose-title", title));
      const row = el("div", "choose-row");
      const done = (id: string): void => {
        document.removeEventListener("keydown", onKey, true);
        back.remove();
        resolve(id);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          done("cancel");
        }
      };
      for (const b of buttons) {
        const btn = el("button", `btn${b.primary ? " primary" : ""}${b.danger ? " danger" : ""}`, b.label);
        btn.onclick = () => done(b.id);
        row.append(btn);
      }
      back.onclick = (ev) => {
        if (ev.target === back) done("cancel");
      };
      document.addEventListener("keydown", onKey, true);
      box.append(row);
      back.append(box);
      this.overlay(back);
    });
  }

  private openFromList(id: string): void {
    this.go("chat", true);
    location.hash = `#/s/${id}`;
    this.openSession(id);
  }

  private pinIds(ids: string[], on: boolean): void {
    if (!ids.length) return;
    const pin = on ? [...ids, ...this.manage.pin.filter((id) => !ids.includes(id))] : this.manage.pin.filter((id) => !ids.includes(id));
    const order = on ? this.manage.order.filter((id) => !ids.includes(id)) : [...ids, ...this.manage.order.filter((id) => !ids.includes(id))];
    this.sendArrangement(pin, order);
  }

  private archiveIds(ids: string[], on: boolean): void {
    if (!ids.length) return;
    this.act(() => this.socket.send({ type: "manage", action: "archive", ids, on }));
  }

  /** Per-card delete needs a second click within 4s. */
  private deleteOne(id: string): void {
    if (this.cardDelArm?.id === id && Date.now() - this.cardDelArm.at < 4000) {
      this.cardDelArm = null;
      this.act(() => this.socket.send({ type: "manage", action: "delete", ids: [id] }));
      this.renderSessions();
      return;
    }
    this.cardDelArm = { id, at: Date.now() };
    this.renderSessions();
    setTimeout(() => {
      if (this.cardDelArm?.id === id && Date.now() - this.cardDelArm.at >= 4000) {
        this.cardDelArm = null;
        this.renderSessions();
      }
    }, 4100);
  }

  // ---------------------------------------------------------------- session manager
  private static busy(s: SessionState): boolean {
    // Mirrors the bridge's guard in sessions.ts remove(): a live writer, a pending approval, or a
    // lock held by the pi terminal. `locked` has to come from the bridge — the web cannot see locks.
    return s.running || s.owned || s.approvals > 0 || Boolean(s.locked);
  }

  private static busyWhy(s: SessionState): string {
    if (s.locked) return tr("终端正在使用这个会话，先在那边退出再删");
    return tr("网页正在运行/接管这个会话，先停止运行再删");
  }

  private mgrMatches(s: SessionState): boolean {
    const v = this.mgr;
    const archived = this.manage.archived.includes(s.id);
    const pinned = this.manage.pin.includes(s.id);
    if (v.origin !== "all" && (s.origin === "web" ? "web" : "cli") !== v.origin) return false;
    if (v.status === "pin" && !(pinned && !archived)) return false;
    if (v.status === "normal" && (pinned || archived)) return false;
    if (v.status === "archived" && !archived) return false;
    if (v.status === "active" && archived) return false;
    if (v.time !== "all" && timeBucket(s.updatedAt) !== v.time) return false;
    if (v.cwd && s.cwd !== v.cwd) return false;
    const words = v.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const hay = `${s.name}\n${s.cwd}\n${s.preview ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  private mgrCompare(a: SessionState, b: SessionState): number {
    const created = (s: SessionState) => Date.parse(s.startedAt ?? "") || s.updatedAt;
    let d = 0;
    switch (this.mgr.sort) {
      case "updated":
        d = a.updatedAt - b.updatedAt;
        break;
      case "created":
        d = created(a) - created(b);
        break;
      case "name":
        d = (a.name || "").localeCompare(b.name || "", "zh-CN");
        break;
      case "cwd":
        d = a.cwd.localeCompare(b.cwd, "zh-CN") || a.updatedAt - b.updatedAt;
        break;
    }
    return this.mgr.desc ? -d : d;
  }

  /** Groups in display order; "none" is a single headless group. */
  private mgrGroups(list: SessionState[]): { key: string; label: string; items: SessionState[] }[] {
    const g = this.mgr.group;
    if (g === "none") return [{ key: "", label: "", items: list }];
    const keyOf = (s: SessionState): [string, string] => {
      if (g === "cwd") return [`cwd:${s.cwd}`, s.cwd];
      if (g === "origin") return s.origin === "web" ? ["origin:web", tr("网页创建")] : ["origin:cli", tr("pi CLI 创建")];
      if (g === "status") {
        if (this.manage.archived.includes(s.id)) return ["status:archived", tr("已归档")];
        return this.manage.pin.includes(s.id) ? ["status:pin", tr("置顶")] : ["status:normal", tr("普通")];
      }
      const t = timeBucket(s.updatedAt);
      return [`time:${t}`, t === "today" ? tr("今天") : t === "week" ? tr("本周") : tr("更早")];
    };
    const map = new Map<string, { key: string; label: string; items: SessionState[] }>();
    for (const s of list) {
      const [key, label] = keyOf(s);
      let grp = map.get(key);
      if (!grp) map.set(key, (grp = { key, label, items: [] }));
      grp.items.push(s);
    }
    const fixed = ["status:pin", "status:normal", "status:archived", "time:today", "time:week", "time:older", "origin:web", "origin:cli"];
    const groups = [...map.values()];
    if (g === "cwd") {
      const latest = (x: { items: SessionState[] }) => Math.max(...x.items.map((s) => s.updatedAt));
      groups.sort((a, b) => latest(b) - latest(a));
    } else groups.sort((a, b) => fixed.indexOf(a.key) - fixed.indexOf(b.key));
    return groups;
  }

  private saveMgr(): void {
    try {
      localStorage.setItem("pi.mgr", JSON.stringify(this.mgr));
    } catch {
      /* private mode */
    }
  }

  /** Collapsed groups are part of the view, not of a single visit: keep them across sessions. */
  private saveMgrCollapsed(): void {
    try {
      localStorage.setItem("pi.mgrCollapsed", JSON.stringify([...this.mgrCollapsed]));
    } catch {
      /* private mode */
    }
  }

  private mgrArm(key: string): boolean {
    if (this.mgrDelArm?.key === key && Date.now() - this.mgrDelArm.at < 4000) {
      this.mgrDelArm = null;
      return true;
    }
    this.mgrDelArm = { key, at: Date.now() };
    setTimeout(() => {
      if (this.mgrDelArm?.key === key && Date.now() - this.mgrDelArm.at >= 4000) {
        this.mgrDelArm = null;
        this.mgrRefresh?.();
      }
    }, 4100);
    return false;
  }

  private applyRename(id: string, raw: string): void {
    const name = raw.trim().replace(/\s+/g, " ");
    const target = this.sessions.find((s) => s.id === id);
    if (!target || !name || name === target.name) return;
    // The bridge records the name before it answers, so showing it now is not a lie.
    target.name = name;
    if (this.session?.id === id) this.session = { ...this.session, name };
    this.act(() => this.socket.send({ type: "rename", sessionId: id, name }));
  }

  private openManager(view: "list" | "trash" = "list"): void {
    this.closeSheet();
    this.sheetKind = "manage";
    this.mgrPicked.clear();
    this.mgrRename = null;
    this.mgrDelArm = null;
    this.mgrNote = "";
    this.mgrView = view;
    this.mgrTrashPick.clear();
    // Q-035: the left column's 🗑 opens straight into the bin, so ask for the list right away.
    if (view === "trash") this.socket.send({ type: "manage", action: "trash.list" });
    const back = el("div", "sheet-back center");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    back.onkeydown = (ev) => {
      if (ev.key === "Escape") this.closeSheet();
    };
    const sheet = el("div", "sheet mgr-sheet");
    const head = el("div", "sheet-head");
    const titleEl = el("div", "sheet-title", tr("会话管理"));
    // The bin is a second view of the same sheet: same width, same footer, one click away.
    // It lives in the toolbar (right of 重置) rather than the title bar, and the row stays put
    // even in the bin view, so it doubles as the way back.
    const bin = el("button", "btn ghost mgr-bin") as HTMLButtonElement;
    bin.onclick = () => {
      this.mgrView = this.mgrView === "trash" ? "list" : "trash";
      this.mgrNote = "";
      if (this.mgrView === "trash") this.socket.send({ type: "manage", action: "trash.list" });
      paint();
    };
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(titleEl, close);

    // The toolbar is built once so the search box keeps focus while the body repaints.
    const tools = el("div", "mgr-tools");
    const q = el("input", "mgr-search") as HTMLInputElement;
    q.type = "search";
    q.placeholder = tr("搜索 名字 / 目录 / 首条消息（空格分隔多个词）");
    q.value = this.mgr.q;
    q.oninput = () => {
      this.mgr.q = q.value;
      this.saveMgr();
      paint();
    };
    const select = <K extends keyof MgrView>(key: K, label: string, opts: [string, string][]) => {
      const wrap = el("label", "mgr-field");
      wrap.append(el("span", "", label));
      const s = el("select", "") as HTMLSelectElement;
      for (const [v, t] of opts) {
        const o = el("option", "", t) as HTMLOptionElement;
        o.value = v;
        s.append(o);
      }
      s.value = String(this.mgr[key]);
      s.onchange = () => {
        (this.mgr as any)[key] = s.value;
        if (key === "sort") {
          this.mgr.desc = s.value === "updated" || s.value === "created";
          syncDir();
        }
        this.saveMgr();
        paint();
      };
      wrap.append(s);
      return { wrap, s };
    };
    const origin = select("origin", tr("来源"), [["all", tr("全部")], ["web", tr("网页")], ["cli", "CLI"]]);
    const status = select("status", tr("状态"), [["all", tr("全部")], ["active", tr("未归档")], ["pin", tr("置顶")], ["normal", tr("普通")], ["archived", tr("已归档")]]);
    const time = select("time", tr("更新"), [["all", tr("全部")], ["today", tr("今天")], ["week", tr("本周")], ["older", tr("更早")]]);
    const cwd = select("cwd", tr("目录"), [["", tr("全部")]]);
    const group = select("group", tr("分组"), [["none", tr("不分组")], ["cwd", tr("按目录")], ["origin", tr("按来源")], ["status", tr("按状态")], ["time", tr("按时间")]]);
    const sort = select("sort", tr("排序"), [["updated", tr("最近更新")], ["created", tr("创建时间")], ["name", tr("名称")], ["cwd", tr("工作目录")]]);
    const dir = el("button", "btn ghost mgr-dir") as HTMLButtonElement;
    const syncDir = () => {
      dir.textContent = this.mgr.desc ? tr("↓ 降序") : tr("↑ 升序");
    };
    syncDir();
    dir.onclick = () => {
      this.mgr.desc = !this.mgr.desc;
      syncDir();
      this.saveMgr();
      paint();
    };
    const reset = el("button", "btn ghost", tr("重置"));
    reset.onclick = () => {
      this.mgr = defaultMgrView();
      this.saveMgr();
      q.value = "";
      for (const [k, x] of [["origin", origin], ["status", status], ["time", time], ["cwd", cwd], ["group", group], ["sort", sort]] as const) {
        x.s.value = String(this.mgr[k]);
      }
      syncDir();
      paint();
    };
    const filters = el("div", "mgr-filters");
    const binHint = el("span", "mgr-bin-hint", tr("删掉的会话在这里，可以还原或彻底删除"));
    binHint.hidden = true;
    filters.append(origin.wrap, status.wrap, time.wrap, cwd.wrap, group.wrap, sort.wrap, dir, reset, binHint, bin);
    tools.append(q, filters);

    const body = el("div", "mgr-body");
    const noteBox = el("div", "mgr-note");
    noteBox.hidden = true;
    const foot = el("div", "mgr-foot");
    sheet.append(head, tools, body, noteBox, foot);
    back.append(sheet);

    let cwdKey = "";
    const fillCwds = () => {
      const counts = new Map<string, number>();
      for (const s of this.sessions) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
      const list = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
      if (this.mgr.cwd && !counts.has(this.mgr.cwd)) list.push([this.mgr.cwd, 0]);
      const key = list.map(([c, n]) => `${c}\u0000${n}`).join("\u0001");
      if (key === cwdKey) return;
      cwdKey = key;
      const keep = this.mgr.cwd;
      cwd.s.replaceChildren();
      for (const [v, t] of [["", tr("全部（{p1} 个目录）", { p1: counts.size })], ...list.map(([c, n]) => [c, tr("{p1}（{p2}）", { p1: c, p2: n })])]) {
        const o = el("option", "", t as string) as HTMLOptionElement;
        o.value = v as string;
        cwd.s.append(o);
      }
      cwd.s.value = keep;
    };

    const paintList = () => {
      fillCwds();
      const scrollTop = body.scrollTop;
      const shown = this.sessions.filter((s) => this.mgrMatches(s)).sort((a, b) => this.mgrCompare(a, b));
      const shownIds = new Set(shown.map((s) => s.id));
      for (const id of [...this.mgrPicked]) if (!shownIds.has(id)) this.mgrPicked.delete(id);
      this.mgrPainting = true;
      body.replaceChildren();
      this.mgrPainting = false;
      if (!shown.length) body.append(el("div", "empty", this.sessions.length ? tr("没有符合条件的会话。") : tr("还没有会话。")));
      for (const grp of this.mgrGroups(shown)) {
        const sec = el("div", "mgr-group");
        if (grp.key) {
          const collapsed = this.mgrCollapsed.has(grp.key);
          const gh = el("div", `mgr-group-head${collapsed ? " collapsed" : ""}`);
          const all = grp.items.every((s) => this.mgrPicked.has(s.id));
          const box = el("input", "") as HTMLInputElement;
          box.type = "checkbox";
          box.checked = all;
          box.indeterminate = !all && grp.items.some((s) => this.mgrPicked.has(s.id));
          box.title = tr("选中本组");
          box.onclick = (ev) => ev.stopPropagation();
          box.onchange = () => {
            for (const s of grp.items) {
              if (box.checked) this.mgrPicked.add(s.id);
              else this.mgrPicked.delete(s.id);
            }
            paint();
          };
          gh.append(box, el("span", "caret", collapsed ? "▸" : "▾"), el("span", "label", grp.label), el("span", "count", String(grp.items.length)));
          gh.title = grp.label;
          gh.onclick = () => {
            if (collapsed) this.mgrCollapsed.delete(grp.key);
            else this.mgrCollapsed.add(grp.key);
            this.saveMgrCollapsed();
            paint();
          };
          sec.append(gh);
          if (collapsed) {
            body.append(sec);
            continue;
          }
        }
        for (const s of grp.items) sec.append(this.mgrRow(s, paint));
        body.append(sec);
      }
      body.scrollTop = scrollTop;
      paintFoot(shown);
      const input = body.querySelector<HTMLInputElement>(".mgr-rename");
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    };

    const trashRow = (it: TrashItem, repaint: () => void): HTMLElement => {
      const picked = this.mgrTrashPick.has(it.id);
      const row = el("div", `mgr-row trash-row${picked ? " picked" : ""}`);
      const box = el("input", "") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = picked;
      box.onchange = () => {
        if (box.checked) this.mgrTrashPick.add(it.id);
        else this.mgrTrashPick.delete(it.id);
        repaint();
      };
      const main = el("div", "mgr-main");
      const line = el("div", "mgr-name-line");
      const name = el("span", "mgr-name", it.name || it.id.slice(0, 8));
      name.title = it.file;
      line.append(name);
      const sub = el("div", "mgr-sub");
      sub.append(
        el("span", "", it.cwd || tr("未知目录")),
        el("span", "", tr("删除于 {p1}", { p1: relativeTime(it.deletedAt) })),
        el("span", "", fmtSize(it.size || 0)),
      );
      main.append(line, sub);
      const acts = el("div", "mgr-acts");
      const restore = el("button", "btn ghost mgr-open", tr("还原")) as HTMLButtonElement;
      restore.onclick = (ev) => {
        ev.stopPropagation();
        this.act(() => this.socket.send({ type: "manage", action: "restore", ids: [it.id] }));
      };
      const armKey = `purge1:${it.id}`;
      const armed = this.mgrDelArm?.key === armKey;
      const del = el("button", `card-act del${armed ? " armed" : ""}`, armed ? tr("删?") : tr("删")) as HTMLButtonElement;
      del.title = armed ? tr("再点一次：真的销毁这个文件") : tr("彻底删除（不可恢复）");
      del.setAttribute("aria-label", del.title);
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (this.mgrArm(armKey)) this.act(() => this.socket.send({ type: "manage", action: "purge", ids: [it.id] }));
        repaint();
      };
      acts.append(restore, del);
      row.append(box, main, acts);
      row.onclick = (ev) => {
        const t = ev.target as HTMLElement;
        if (t.closest("button, input, a")) return;
        box.checked = !box.checked;
        box.onchange?.(new Event("change"));
      };
      return row;
    };

    const trashFoot = (items: TrashItem[]) => {
      foot.replaceChildren();
      const ids = items.filter((it) => this.mgrTrashPick.has(it.id)).map((it) => it.id);
      const allBox = el("input", "") as HTMLInputElement;
      allBox.type = "checkbox";
      allBox.checked = items.length > 0 && ids.length === items.length;
      allBox.indeterminate = ids.length > 0 && ids.length < items.length;
      allBox.disabled = !items.length;
      allBox.onchange = () => {
        if (allBox.checked) for (const it of items) this.mgrTrashPick.add(it.id);
        else this.mgrTrashPick.clear();
        paint();
      };
      const allLabel = el("label", "mgr-all");
      allLabel.append(allBox, el("span", "", tr("全选")));
      const total = items.reduce((n, it) => n + (it.size || 0), 0);
      const info = el("span", "mgr-count", tr("已选 {p1} · 共 {p2} 个 · 占 {p3}", { p1: ids.length, p2: items.length, p3: fmtSize(total) }));
      const restoreBtn = el("button", "btn", tr("还原所选")) as HTMLButtonElement;
      restoreBtn.disabled = !ids.length;
      restoreBtn.onclick = () => this.act(() => this.socket.send({ type: "manage", action: "restore", ids }));
      const pickedArm = `purge:${ids.join(",")}`;
      const pickedArmed = this.mgrDelArm?.key === pickedArm;
      const purgeBtn = el("button", `btn danger${pickedArmed ? " armed" : ""}`, pickedArmed ? tr("再点一次：销毁 {p1} 个", { p1: ids.length }) : tr("彻底删除所选")) as HTMLButtonElement;
      purgeBtn.disabled = !ids.length;
      purgeBtn.onclick = () => {
        if (this.mgrArm(pickedArm)) this.act(() => this.socket.send({ type: "manage", action: "purge", ids }));
        paint();
      };
      foot.append(allLabel, info, el("span", "spacer"), restoreBtn, purgeBtn);
    };

    const paintTrash = () => {
      const items = [...this.trash].sort((a, b) => b.deletedAt - a.deletedAt);
      const live = new Set(items.map((it) => it.id));
      for (const id of this.mgrTrashPick) if (!live.has(id)) this.mgrTrashPick.delete(id);
      const scrollTop = body.scrollTop;
      body.replaceChildren();
      if (!items.length) {
        body.append(el("div", "empty", tr("垃圾箱是空的。删掉的会话会先放到这里，清空才真的销毁。")));
      } else {
        const total = items.reduce((n, it) => n + (it.size || 0), 0);
        const bar = el("div", "trash-head");
        bar.append(
          el("span", "", tr("最近删除 {p1} 个", { p1: items.length })),
          el("span", "faint", tr(" · 占 {p1}", { p1: fmtSize(total) })),
          el("span", "spacer"),
        );
        // One button for the whole bin, so clearing never needs a select-all first.
        const allArmed = this.mgrDelArm?.key === "purge:all";
        const empty = el("button", `btn danger${allArmed ? " armed" : ""}`, allArmed ? tr("再点一次：清空 {p1} 个", { p1: items.length }) : tr("一键清空")) as HTMLButtonElement;
        empty.title = tr("垃圾箱里的文件会被真的删掉，无法还原");
        empty.onclick = () => {
          if (this.mgrArm("purge:all")) this.act(() => this.socket.send({ type: "manage", action: "purge", ids: [] }));
          paint();
        };
        bar.append(empty);
        body.append(bar);
        for (const it of items) body.append(trashRow(it, paint));
      }
      body.scrollTop = scrollTop;
      trashFoot(items);
    };

    const paint = () => {
      const inTrash = this.mgrView === "trash";
      titleEl.textContent = inTrash ? tr("垃圾箱") : tr("会话管理");
      if (inTrash) bin.textContent = tr("← 会话列表");
      else bin.textContent = this.trash.length ? tr("🗑 垃圾箱 ({p1})", { p1: this.trash.length }) : tr("🗑 垃圾箱");
      bin.classList.toggle("on", inTrash);
      bin.title = inTrash ? tr("回到会话列表") : tr("最近删除的会话都在这里，清空才真的销毁");
      // The toolbar itself stays (it carries the bin toggle); only the filters go away,
      // because filtering and sorting the bin is not a thing anyone asked for.
      for (const node of [q, origin.wrap, status.wrap, time.wrap, cwd.wrap, group.wrap, sort.wrap, dir, reset]) {
        node.style.display = inTrash ? "none" : "";
      }
      binHint.hidden = !inTrash;
      if (inTrash) paintTrash();
      else paintList();
      noteBox.textContent = this.mgrNote;
      noteBox.hidden = !this.mgrNote;
    };

    const paintFoot = (shown: SessionState[]) => {
      foot.replaceChildren();
      const ids = shown.filter((s) => this.mgrPicked.has(s.id)).map((s) => s.id);
      const picked = shown.filter((s) => this.mgrPicked.has(s.id));
      const allBox = el("input", "") as HTMLInputElement;
      allBox.type = "checkbox";
      allBox.checked = shown.length > 0 && ids.length === shown.length;
      allBox.indeterminate = ids.length > 0 && ids.length < shown.length;
      allBox.disabled = !shown.length;
      allBox.onchange = () => {
        if (allBox.checked) for (const s of shown) this.mgrPicked.add(s.id);
        else this.mgrPicked.clear();
        paint();
      };
      const allLabel = el("label", "mgr-all");
      allLabel.append(allBox, el("span", "", tr("全选")));
      const info = el("span", "mgr-count", tr("已选 {p1} · 显示 {p2} / 共 {p3}", { p1: ids.length, p2: shown.length, p3: this.sessions.length }));
      const btn = (text: string, fn: () => void, cls = "btn") => {
        const b = el("button", cls, text) as HTMLButtonElement;
        b.disabled = !ids.length;
        b.onclick = fn;
        return b;
      };
      const deletable = picked.filter((s) => !App.busy(s)).map((s) => s.id);
      const delKey = `bulk:${deletable.join(",")}`;
      const armed = this.mgrDelArm?.key === delKey;
      const del = btn(armed ? tr("再点一次：移入垃圾箱 {p1} 个", { p1: deletable.length }) : deletable.length < ids.length ? tr("删除（{p1} 个可删）", { p1: deletable.length }) : tr("删除"), () => {
        if (this.mgrArm(delKey)) {
          // No optimistic clear: the bridge reports what it actually removed, and the paint() below
          // prunes picked ids against the list that is really left.
          this.act(() => this.socket.send({ type: "manage", action: "delete", ids: deletable }));
        }
        paint();
      }, `btn danger${armed ? " armed" : ""}`);
      del.disabled = !deletable.length;
      if (deletable.length < ids.length) del.title = tr("运行中 / 网页接管中 / 待确认的会话不能删，先停止运行");
      const spacer = el("span", "spacer");
      foot.append(
        allLabel,
        info,
        spacer,
        btn(tr("置顶"), () => this.pinIds(ids, true)),
        btn(tr("取消置顶"), () => this.pinIds(ids, false)),
        btn(tr("归档"), () => this.archiveIds(ids, true)),
        btn(tr("恢复"), () => this.archiveIds(ids, false)),
        del,
      );
    };

    this.mgrRefresh = paint;
    this.overlay(back);
    this.sheet = back;
    paint();
    q.focus();
  }

  private mgrRow(s: SessionState, repaint: () => void): HTMLElement {
    const archived = this.manage.archived.includes(s.id);
    const pinned = this.manage.pin.includes(s.id);
    const picked = this.mgrPicked.has(s.id);
    const row = el("div", `mgr-row${picked ? " picked" : ""}${archived ? " archived" : ""}${s.id === this.currentId ? " current" : ""}`);
    const box = el("input", "") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = picked;
    box.onchange = () => {
      if (box.checked) this.mgrPicked.add(s.id);
      else this.mgrPicked.delete(s.id);
      repaint();
    };
    row.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest("button, input, a")) return;
      box.checked = !box.checked;
      box.onchange?.(new Event("change"));
    };

    const main = el("div", "mgr-main");
    const line = el("div", "mgr-name-line");
    if (this.mgrRename?.id === s.id) {
      const input = el("input", "mgr-rename") as HTMLInputElement;
      input.value = this.mgrRename.draft;
      input.maxLength = 120;
      input.oninput = () => {
        if (this.mgrRename) this.mgrRename.draft = input.value;
      };
      const finish = (save: boolean) => {
        const r = this.mgrRename;
        if (!r || r.id !== s.id) return;
        this.mgrRename = null;
        if (save) this.applyRename(s.id, r.draft);
        this.renderSessions();
      };
      input.onkeydown = (ev) => {
        if (ev.key === "Enter") finish(true);
        else if (ev.key === "Escape") {
          ev.stopPropagation();
          finish(false);
        }
      };
      input.onblur = () => {
        // A repaint replaces the row; that is not the user leaving the field.
        if (!this.mgrPainting) finish(true);
      };
      line.append(input);
    } else {
      const name = el("span", "mgr-name", s.name || tr("(未命名)"));
      name.title = s.name;
      line.append(name);
    }
    const tag = (cls: string, text: string, title = "") => {
      const t = el("span", `mgr-tag ${cls}`, text);
      if (title) t.title = title;
      line.append(t);
    };
    if (pinned && !archived) tag("pin", tr("置顶"));
    if (archived) tag("arch", tr("已归档"));
    tag(s.origin === "web" ? "web" : "cli", s.origin === "web" ? tr("网页") : "CLI", s.origin === "web" ? tr("在网页里新建的会话") : tr("在终端 pi CLI 里创建的会话"));
    const badge = this.badgeOf(s);
    // D170：「后台」那一枚在管理面板里也要点得开，不然同一枚徽标在左栏能点、到这里突然不能。
    if (badge?.kind === "bg") {
      const chip = this.badgeChip(s);
      if (chip) line.append(chip);
    } else if (badge) tag(badge.cls, badge.text, badge.title);
    else if (s.owned) tag("live", tr("已接管"), tr("这个会话由网页接管着"));
    main.append(line);
    const sub = el("div", "mgr-sub");
    const cwdEl = el("span", "mgr-cwd", s.cwd);
    cwdEl.title = s.cwd;
    sub.append(cwdEl);
    if (s.preview) {
      const p = el("span", "mgr-preview", s.preview);
      p.title = s.preview;
      sub.append(p);
    }
    main.append(sub);

    const times = el("div", "mgr-times");
    const created = Date.parse(s.startedAt ?? "");
    const up = el("span", "", tr("更新 {p1}", { p1: relativeTime(s.updatedAt) }));
    up.title = `${fmtDate(s.updatedAt)} ${fmtTime(s.updatedAt)}`;
    times.append(up);
    if (created) {
      const c = el("span", "", tr("创建 {p1}", { p1: fmtDate(created) }));
      c.title = `${fmtDate(created)} ${fmtTime(created)}`;
      times.append(c);
    }

    const acts = el("div", "mgr-acts");
    const act = (html: string, title: string, fn: () => void, cls = "card-act") => {
      const b = el("button", cls) as HTMLButtonElement;
      b.append(glyph(html));
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onclick = (ev) => {
        ev.stopPropagation();
        fn();
      };
      acts.append(b);
      return b;
    };
    const open = el("button", "btn ghost mgr-open", tr("打开")) as HTMLButtonElement;
    open.onclick = (ev) => {
      ev.stopPropagation();
      this.closeSheet();
      this.openFromList(s.id);
    };
    acts.append(open);
    act(pinned ? "★" : "☆", pinned ? tr("取消置顶") : tr("置顶"), () => this.pinIds([s.id], !pinned), `card-act${pinned ? " pinned" : ""}`);
    act("✎", tr("重命名"), () => {
      this.mgrRename = { id: s.id, draft: s.name || "" };
      repaint();
    });
    act(archived ? ICON_UNARCHIVE : ICON_ARCHIVE, archived ? tr("恢复（取消归档）") : tr("归档（文件不动，只是收起来）"), () => this.archiveIds([s.id], !archived));
    const key = `one:${s.id}`;
    const armed = this.mgrDelArm?.key === key;
    const busy = App.busy(s);
    const del = act(
      armed ? tr("删除?") : ICON_TRASH,
      busy ? App.busyWhy(s) : armed ? tr("再点一次：移入垃圾箱") : tr("删除（先进垃圾箱，可还原）"),
      () => {
        if (this.mgrArm(key)) this.act(() => this.socket.send({ type: "manage", action: "delete", ids: [s.id] }));
        repaint();
      },
      `card-act del${armed ? " armed" : ""}`,
    );
    del.disabled = busy;

    row.append(box, main, times, acts);
    return row;
  }

  private startRename(s: SessionState): void {
    this.renameId = s.id;
    this.renameDraft = s.name || "";
    this.renameFocus = true;
    this.renderSessions();
  }

  private cancelRename(): void {
    if (!this.renameId) return;
    this.renameId = null;
    this.renameDraft = "";
    this.renderSessions();
  }

  /** Enter, or clicking away: send the new name (no-op when it did not change). */
  private commitRename(): void {
    const id = this.renameId;
    if (!id) return;
    const name = this.renameDraft;
    this.renameId = null;
    this.renameDraft = "";
    this.applyRename(id, name);
    this.renderSessions();
  }

  private claimButton(): HTMLButtonElement {
    const claim = el("button", "btn primary claim-btn") as HTMLButtonElement;
    if (this.claiming && this.claiming === this.currentId) {
      claim.append(el("span", "act-spin"), el("span", "", tr("接管中…")));
      claim.disabled = true;
      claim.title = tr("正在拉起 pi 进程，通常要几秒");
    } else claim.textContent = tr("接管会话");
    claim.onclick = () => this.startClaim();
    return claim;
  }

  private startClaim(): void {
    const id = this.currentId;
    if (!id || this.claiming) return;
    this.act(() => {
      this.socket.send({ type: "claim", sessionId: id });
      this.claiming = id;
      this.renderChat();
      if (this.sheetKind === "model") this.openModelSheet();
      setTimeout(() => {
        if (this.claiming !== id) return;
        this.endClaim();
        this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: tr("等了 60 秒还没接管成功，看看服务端日志"), level: "warn" });
      }, 60000);
    });
  }

  private endClaim(): void {
    this.claiming = null;
    this.renderChat();
    if (this.sheetKind === "model") this.openModelSheet();
  }

  private renderChat(): void {
    const host = this.els.composerHost;
    host.replaceChildren();
    this.hintStatus = null;
    this.cwdChip = null;
    this.modelChip = null;
    this.textarea = null;
    this.continueBtn = null;
    this.bgBar = null;
    this.closeSkillPalette();
    this.imageBadge = null;
    if (!this.currentId) {
      // 没开会话时的空状态：整块居中（styles.css 用 `:has(> .composer > .chat-empty)` 把
      // 中栏从「滚动区 + 贴底输入框」改成一块空白），别让提示贴着底边像界面坏了。
      const box = el("div", "chat-empty");
      box.append(el("div", "chat-empty-title", tr("还没有打开会话")));
      box.append(el("div", "chat-empty-hint", tr("左边选一个，或者开一个新的")));
      host.append(box);
      return;
    }
    const s = this.session;

    // #21: RPC cannot show pi's trust prompt, so an undecided project silently loses its .pi config.
    const t = this.trust;
    if (t && s && t.cwd === s.cwd && t.needed && !t.saved && !t.effective) {
      const bar = el("div", "takeover warn trust-bar");
      bar.append(el("span", "", tr("这个目录有 pi 的项目配置（.pi/ 下的设置、扩展、技能或 MCP）。网页里的 pi 不能弹信任提示，所以没有加载它们。")));
      const go = el("button", "btn", tr("决定是否信任…")) as HTMLButtonElement;
      go.onclick = () => this.openSettingsSheet("trust");
      bar.append(go);
      host.append(bar);
    }

    if (s && !s.owned) {
      const bar = el("div", "takeover warn");
      bar.append(el("span", "", tr("这个会话来自磁盘（只读预览）。发消息会自动接管；终端里如果有 pi 在写同一个文件，先退出那边。")));
      bar.append(this.claimButton());
      host.append(bar);
    }

    const row = el("div", "row");
    const box = el("div", "composer-input");
    const input = el("textarea");
    input.placeholder = this.composerHintText();
    if (s?.starting) input.disabled = true;
    this.textarea = input;
    input.value = this.composerText;
    const pasteHost = el("div", "paste-list");
    this.pasteHost = pasteHost;
    box.append(pasteHost, input);
    input.oninput = () => {
      this.composerText = input.value;
      this.noteDraft();
      this.fitComposer();
      this.updateComplete();
    };
    input.onclick = () => this.updateComplete();
    // A click on a suggestion blurs the field first: give the click time to land.
    input.onblur = () => setTimeout(() => {
      if (document.activeElement !== this.textarea) this.closeComplete();
    }, 150);
    input.onpaste = (ev) => {
      // A big paste becomes its own folded block, so what you type next stays separate and visible.
      const pasted = ev.clipboardData?.getData("text/plain") ?? "";
      if (pasted.split("\n").length < PASTE_LINES && pasted.length < PASTE_CHARS) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.pastes.push({ text: pasted.replace(/\r\n/g, "\n"), open: false });
      this.noteDraft();
      this.renderPastes();
    };
    input.onkeydown = (ev) => {
      if (this.completeKey(ev)) return;
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.closeComplete();
        // Same keys as the terminal while a run is going: Enter steers it, Alt+Enter waits for it (#14).
        this.sendPrompt(ev.altKey ? "followUp" : "steer");
      }
    };

    // Enter sends; the slot the send button used holds the tool-permission switch. The empty strip
    // above that switch is where 继续 goes (D159): 28 + 4 + 44 = 76 against the textarea's 72.5,
    // so the whole button costs the transcript ~3.5px instead of a row.
    const side = el("div", "composer-side");
    side.append(this.continueButton(), this.permissionButton());
    row.append(box, side, (this.failCta = this.failButton()));
    if (this.images.length) {
      const badge = this.pendingImagesBadge();
      row.append(badge);
      this.imageBadge = badge;
    }

    const hint = el("div", "hint");
    const status = el("div", "hint-status");
    this.hintStatus = status;
    // 路径先造出来，`fillHintStatus()` 会把它接到状态行最前面（每次重画都得接一次）。
    this.cwdChip = s?.cwd ? this.cwdChipNode(s.cwd) : null;
    this.wireHintPeek();
    this.fillHintStatus();
    hint.append(status);
    const tools = el("div", "hint-tools");
    const skillBtn = el("button", "btn ghost", tr("技能"));
    skillBtn.dataset.act = "skills";
    skillBtn.title = tr("搜索并插入技能命令（/skill:name）");
    skillBtn.onclick = () => this.openSkillPalette();
    const pathBtn = el("button", "btn ghost", tr("文件"));
    pathBtn.dataset.act = "attach";
    pathBtn.title = tr("选文件：图片直接附加，其他文件插入完整路径（pi 会自己去读）。截图或资源管理器里复制的文件也可以 {p1}", { p1: PASTE_KEY });
    pathBtn.onclick = () => this.openFilePicker();
    const chip = el("button", "model-chip");
    chip.onclick = () => this.openModelSheet();
    chip.append(el("span", "chip-model", ""), el("span", "chip-ctx", ""), el("span", "chip-rate", ""), el("span", "chip-level", ""));
    this.modelChip = chip;
    tools.append(skillBtn);
    if (this.uiPrefs.showExtButton) {
      const extBtn = el("button", "btn ghost ext-btn", tr("扩展")) as HTMLButtonElement;
      extBtn.title = tr("已安装的扩展与 MCP、扩展商店、MCP 商店（可在 pi 设置 → 扩展与 MCP 里隐藏这个按钮）");
      extBtn.onclick = () => this.openExtManager();
      this.extButton = extBtn;
      tools.append(extBtn);
      this.paintExtButton();
    } else this.extButton = null;
    tools.append(pathBtn, chip);
    if (s?.owned) {
      // The explanation lives in the tooltip so it no longer costs the composer a whole row.
      const fromWeb = s.origin === "web";
      const release = el("button", "btn ghost release-btn", fromWeb ? tr("释放会话") : tr("让回终端"));
      release.title = fromWeb
        ? tr("网页是这个会话的写者。释放后 pi 进程退出，历史留在磁盘；再发消息会自动重新接管。")
        : tr("网页是这个会话的写者。要回终端接着聊，先在这里让回去。");
      release.onclick = () => this.act(() => this.socket.send({ type: "close", sessionId: this.currentId }));
      tools.append(release);
    }
    hint.append(tools);
    this.fillModelChip();

    const extAbove = el("div", "ext-widgets above");
    const extBelow = el("div", "ext-widgets below");
    this.extAbove = extAbove;
    this.extBelow = extBelow;
    const queueBar = el("div", "queue-bar");
    this.queueBar = queueBar;
    host.append(extAbove, queueBar, row, hint, extBelow);
    // D170: 提示条插在输入框上方（`row` 是锚点），重画后要重新挂回去。
    this.syncBgBar();
    this.fillExt();
    this.fillQueueBar();
    this.fitComposer();
    this.renderPastes();
    if (this.approvals.length) host.append(this.approvalNode());
    this.renderAsks();
    this.syncCwdChip();
  }

  /**
   * The model sheet's 会话 section (#15, the web side of `/session` and `/compact`): context and
   * cumulative usage, cost, the session file, and a compaction you can steer with instructions.
   */
  private sessionInfoBox(): HTMLElement {
    const s = this.session;
    const box = el("div", "levels session-info");
    // Folded by default: the model list below is what this sheet is for (/session opens it unfolded).
    const head = el("button", "session-info-head") as HTMLButtonElement;
    head.type = "button";
    const caret = el("span", "session-info-caret");
    const peek = el("span", "session-info-peek");
    head.append(caret, el("span", "levels-label", tr("会话")), peek);
    box.append(head);
    const grid = el("div", "info-grid");
    const row = (label: string, value: string, title?: string) => {
      const v = el("span", "info-v", value);
      if (title) v.title = title;
      grid.append(el("span", "info-k", label), v);
      return v;
    };
    const n = (x?: number) => (typeof x === "number" ? x.toLocaleString("en-US") : "–");
    if (s?.owned) {
      const used = this.usage.contextTokens;
      const win = this.usage.contextWindow;
      row(tr("上下文"), used == null ? tr("–（压缩后要等下一轮才有数）") : tr("{p1}{p2}", { p1: n(used), p2: win ? tr(" / {p1}（{p2}%）", { p1: n(win), p2: Math.round((used / win) * 100) }) : "" }));
      const t = this.stats.tokens;
      row(tr("累计 token"), t ? tr("输入 {p1} · 输出 {p2} · 缓存读 {p3} · 缓存写 {p4}", { p1: n(t.input), p2: n(t.output), p3: n(t.cacheRead), p4: n(t.cacheWrite) }) : "–");
      row(tr("累计费用"), this.stats.cost == null ? "–" : `$${this.stats.cost.toFixed(4)}`, tr("pi 按模型价格表算的估计值（get_session_stats）"));
    } else {
      row(tr("用量"), tr("接管后可见（数字来自正在运行的 pi）"));
    }
    if (s?.id) row(tr("会话 ID"), s.id);
    if (s?.launch) row(tr("启动参数"), s.launch);
    const t = this.trust;
    if (t && s && t.cwd === s.cwd && t.needed) {
      const v = row(tr("项目信任"), t.saved ? tr("{p1}（{p2}）", { p1: t.saved.decision ? tr("已信任") : tr("不信任"), p2: t.saved.path }) : tr("未决定 → {p1} .pi 配置", { p1: t.effective ? tr("加载") : tr("不加载") }));
      v.style.cursor = "pointer";
      v.title = tr("点这里修改（/trust）");
      v.onclick = () => this.openSettingsSheet("trust");
    }
    box.append(grid);

    if (s?.file) {
      const fileRow = el("div", "info-file");
      const path = el("code", "info-path", s.file);
      path.title = s.file;
      const copy = el("button", "btn ghost", tr("⧉ 复制路径")) as HTMLButtonElement;
      copy.onclick = () => {
        const done = navigator.clipboard?.writeText(s.file ?? "");
        if (!done) {
          this.warn(tr("这个地址拿不到剪贴板（http 的局域网地址浏览器不给）"));
          return;
        }
        void done.then(() => {
          copy.textContent = tr("已复制");
          setTimeout(() => (copy.textContent = tr("⧉ 复制路径")), 1100);
        });
      };
      fileRow.append(path, copy);
      if (!this.me.public) fileRow.append(this.revealButton(s.file));
      box.append(fileRow);
    }

    // #24: export / download / pi log — plain links, the bridge streams the files.
    if (s?.id) {
      const links = el("div", "info-links");
      const link = (label: string, href: string, title: string) => {
        const a = el("a", "btn ghost", label) as HTMLAnchorElement;
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        a.title = title;
        links.append(a);
      };
      const id = encodeURIComponent(s.id);
      if (s.file) {
        link(tr("导出 HTML"), `/api/export?id=${id}`, tr("pi 自带的单文件 HTML 导出（/export），在新标签页打开"));
        link(tr("下载 JSONL"), `/api/export?id=${id}&format=jsonl`, tr("原始会话文件"));
      }
      link(tr("pi 日志"), `/api/log?id=${id}`, tr("这个会话的 pi 进程 stderr（网页接管过才有）"));
      if (s.file) {
        const tree = el("button", "btn ghost", tr("会话树 / 分叉")) as HTMLButtonElement;
        tree.title = tr("看分支、从任意一条消息分叉、复制当前分支（/tree /fork /clone）");
        tree.onclick = () => this.openTreeSheet();
        links.append(tree);
      }
      box.append(links);
    }

    // `/compact [instructions]`: happens now, not on 确认 — it is an action, not a setting.
    const compact = el("div", "info-compact");
    const hint = el("input") as HTMLInputElement;
    hint.placeholder = tr("压缩时要特别保留什么（可选，例如：保留接口设计的决定）");
    const go = el("button", "btn", tr("立即压缩")) as HTMLButtonElement;
    go.disabled = !s?.owned || Boolean(s?.running);
    go.title = !s?.owned ? tr("接管会话后才能压缩") : s?.running ? tr("这一轮结束后再压缩") : tr("把较早的对话总结成摘要，腾出上下文");
    const run = () => {
      const sessionId = this.currentId;
      if (!sessionId || go.disabled) return;
      const instructions = hint.value.trim();
      this.act(() => this.socket.send({ type: "compact", sessionId, instructions: instructions || undefined }));
      this.closeSheet();
    };
    go.onclick = run;
    hint.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.isComposing) run();
    };
    compact.append(hint, go);
    box.append(compact);
    // Everything after the header folds into one body; the header keeps a one-line summary.
    const body = el("div", "session-info-body");
    while (head.nextSibling) body.append(head.nextSibling);
    box.append(body);
    const used = this.usage.contextTokens;
    const win = this.usage.contextWindow;
    const bits: string[] = [];
    if (s?.owned && used != null) bits.push(tr("上下文 {p1}{p2}", { p1: compactSize(used) || used, p2: win ? `/${compactSize(win)}` : "" }));
    if (s?.owned && this.stats.cost != null) bits.push(`$${this.stats.cost.toFixed(4)}`);
    bits.push(tr("导出 · 会话树 · 压缩"));
    peek.textContent = bits.join(" · ");
    const paint = () => {
      body.hidden = !this.sessionInfoOpen;
      caret.textContent = this.sessionInfoOpen ? "▾" : "▸";
      peek.hidden = this.sessionInfoOpen;
      head.setAttribute("aria-expanded", String(this.sessionInfoOpen));
      head.title = this.sessionInfoOpen ? tr("收起会话信息") : tr("展开：用量、费用、会话文件、导出、会话树、立即压缩");
    };
    head.onclick = () => {
      this.sessionInfoOpen = !this.sessionInfoOpen;
      paint();
    };
    paint();
    return box;
  }

  // ---------------------------------------------------------------- pi settings / trust (#26 #21)
  private openSettingsSheet(tab: SettingsTab): void {
    this.closeSheet();
    this.sheetKind = "settings";
    this.settingsTab = tab;
    if (tab === "login") this.authProviders = null; // re-read: someone may have logged in from the terminal
    if (tab === "runtime") {
      // 上一次按按钮的回执已经过期了：打开面板时重新问数字，也从一张白纸开始。
      this.sleepAllReceipt = null;
      this.socket.send({ type: "runtime.stats" });
    }
    if (tab === "passphrase") this.askPassphrase();
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet settings-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("pi 设置")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const tabs = el("div", "settings-tabs");
    const body = el("div", "settings-body");
    const note = el("div", "settings-note");
    sheet.append(head, tabs, note, body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    this.socket.send({ type: "settings.get", scope: "global" });
    this.socket.send({ type: "lockext.get" });
    if (this.session?.cwd) {
      this.socket.send({ type: "settings.get", scope: "project", cwd: this.session.cwd });
      this.socket.send({ type: "trust.get", cwd: this.session.cwd });
    }
    this.paintSettings();
  }

  private flashSettings(text: string, bad = false): void {
    const note = this.sheet?.querySelector<HTMLElement>(".settings-note");
    if (!note) {
      this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text, level: bad ? "error" : "info" });
      return;
    }
    note.textContent = text;
    note.classList.toggle("bad", bad);
  }

  private paintSettings(): void {
    const sheet = this.sheet?.querySelector(".settings-sheet");
    if (!sheet) return;
    const tabs = sheet.querySelector<HTMLElement>(".settings-tabs")!;
    const body = sheet.querySelector<HTMLElement>(".settings-body")!;
    const cwd = this.session?.cwd ?? "";
    tabs.replaceChildren();
    const tabDefs: [SettingsTab, string][] = [
      ["global", tr("全局")],
      ["project", cwd ? tr("项目（{p1}）", { p1: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd }) : tr("项目")],
      ["trust", tr("项目信任")],
      ["login", tr("登录 / 凭据")],
      ["passphrase", tr("口令")],
      ["ext", tr("扩展与 MCP")],
      ["notify", tr("通知")],
      ["runtime", tr("运行时")],
      ["changelog", tr("更新日志")],
    ];
    for (const [id, label] of tabDefs) {
      const b = el("button", `chip${this.settingsTab === id ? " on" : ""}`, label) as HTMLButtonElement;
      b.disabled = (id === "project" || id === "trust") && !cwd;
      b.onclick = () => {
        this.settingsTab = id;
        this.flashSettings("");
        if (id === "runtime") this.socket.send({ type: "runtime.stats" });
        if (id === "passphrase") this.askPassphrase();
        this.paintSettings();
      };
      tabs.append(b);
    }
    body.replaceChildren();
    if (this.settingsTab === "trust") return this.paintTrust(body);
    if (this.settingsTab === "login") return this.paintLogin(body);
    if (this.settingsTab === "passphrase") return this.paintPassphrase(body);
    if (this.settingsTab === "ext") return this.paintExtSettings(body);
    if (this.settingsTab === "notify") return this.paintNotify(body);
    if (this.settingsTab === "runtime") return this.paintRuntime(body);
    if (this.settingsTab === "changelog") return this.paintChangelog(body);
    const scope = this.settingsTab;
    const view = this.settingsView[scope];
    if (!view || (scope === "project" && view.cwd !== cwd)) {
      body.append(el("div", "empty", tr("读取中…")));
      return;
    }
    this.paintSettingsForm(body, view);
  }

  /**
   * `#89`：读明文和写明文都过 `act()`（前端对公网的 step-up 门，D15）—— 公网只读会话能把
   * 整个聊天看完，但不该看一眼就知道门锁的钥匙。本机 / 局域网 `act()` 直接跑，零摩擦。
   */
  private askPassphrase(): void {
    this.act(() => this.socket.send({ type: "passphrase.get" }));
  }

  /**
   * `#89` 口令页：看当前口令（默认遮住）+ 换一个。页上没有任何一条消息是「打开就自己发出去」
   * 的，全部由打开 tab / 按按钮发起 —— 所以「读取中…」只是一帧，不是等一个永远不会回来的回答。
   */
  private paintPassphrase(body: HTMLElement): void {
    const view = this.passphraseView;
    if (!view) {
      // 公网且窗口已过：写「读取中…」就是撒谎，给一颗按钮让人自己开门。
      if (this.me.public && Date.now() >= this.stepUntil) {
        body.append(el("div", "hint", tr("公网访问下，看口令明文要先验一次口令。")));
        const open = el("button", "btn", tr("再验一次口令")) as HTMLButtonElement;
        open.onclick = () => this.askPassphrase();
        const wrap = el("div", "passphrase-actions");
        wrap.append(open);
        body.append(wrap);
      } else {
        body.append(el("div", "empty", tr("读取中…")));
      }
      return;
    }

    const value = view.value;
    const row = el("div", "settings-row");
    row.append(el("span", "settings-label", tr("当前口令")));
    const holder = el("div", "passphrase-now");
    const shown = el("code", "passphrase-value mono", value === null ? tr("读不到 passphrase.txt") : this.passphraseShown ? value : "••••••••");
    holder.append(shown);
    // 读不到 passphrase.txt（比如手删了）时只给「换一个新的」这条路：没有值可显、也没有值可拷。
    if (value !== null) {
      const tools = el("div", "passphrase-tools");
      const toggle = el("button", "btn ghost", this.passphraseShown ? tr("隐藏") : tr("显示")) as HTMLButtonElement;
      toggle.onclick = () => {
        this.passphraseShown = !this.passphraseShown;
        this.paintSettings();
      };
      const copy = el("button", "btn ghost", tr("复制")) as HTMLButtonElement;
      copy.onclick = () => this.copyPassphrase(value, shown);
      tools.append(toggle, copy);
      holder.append(tools);
    }
    row.append(holder);
    body.append(row);

    const edit = el("label", "settings-row");
    edit.append(el("span", "settings-label", tr("新口令")));
    const input = el("input", "ns-input mono") as HTMLInputElement;
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = tr("至少 4 个字符");
    input.value = this.passphraseDraft;
    input.oninput = () => (this.passphraseDraft = input.value);
    edit.append(input);
    body.append(edit);

    // 随机出来的值在输入框里是遮住的；这行让人先看清再决定保不保存。
    if (this.passphraseFresh) {
      const fresh = el("div", "settings-row");
      fresh.append(el("span", "settings-label", tr("刚生成的")));
      const box = el("div", "passphrase-now");
      const code = el("code", "passphrase-value mono", this.passphraseFresh);
      const copy = el("button", "btn ghost", tr("复制")) as HTMLButtonElement;
      copy.onclick = () => this.copyPassphrase(this.passphraseFresh ?? "", code);
      const tools = el("div", "passphrase-tools");
      tools.append(copy);
      box.append(code, tools);
      fresh.append(box);
      body.append(fresh);
    }

    const actions = el("div", "passphrase-actions");
    const rnd = el("button", "btn ghost", tr("随机生成一个")) as HTMLButtonElement;
    rnd.title = tr("只填进输入框：点保存才真的换掉口令。");
    rnd.onclick = () => this.socket.send({ type: "passphrase.suggest" });
    const save = el("button", "btn primary", tr("保存")) as HTMLButtonElement;
    save.onclick = () => {
      const next = this.passphraseDraft.trim();
      // 与 `--passphrase` 同一个门槛（≥ 4），前端先卡一道，免得白跑一趟桥。
      if (next.length < 4) {
        this.flashSettings(tr("口令至少 4 个字符"), true);
        input.focus();
        return;
      }
      this.act(() => this.socket.send({ type: "passphrase.set", value: next }));
    };
    actions.append(rnd, save);
    body.append(actions);

    body.append(
      el(
        "div",
        "hint",
        tr("忘了口令：在终端里跑 {p1} --passphrase <新口令>。口令写在 {p2} 的 passphrase.txt。", {
          p1: "node bridge/dist/index.js",
          p2: view.dir,
        }),
      ),
    );
  }

  /**
   * `navigator.clipboard` 在局域网 http 地址下**不存在**，所以可选链要包住调用而不是属性；
   * 拿不到剪贴板就退化成「选中让用户自己按 Ctrl+C」，绝不假报一句「已复制」。
   */
  private copyPassphrase(text: string, node: HTMLElement): void {
    const done = navigator.clipboard?.writeText(text);
    if (!done) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      this.flashSettings(tr("这台机器是 http 打开的，浏览器不给复制：已选中，按 Ctrl+C 拿走"));
      return;
    }
    void done.then(() => this.flashSettings(tr("已复制"))).catch(() => this.flashSettings(tr("复制失败：手动选中它复制"), true));
  }

  /** D91: one switch for both channels; the page in front never gets pinged anyway. */
  private paintNotify(body: HTMLElement): void {
    const on = this.me.notify !== false;
    const row = el("label", "settings-row");
    row.append(el("span", "settings-label", tr("需要你时发通知")));
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = on;
    box.onchange = () => {
      this.socket.send({ type: "notify.set", on: box.checked });
      this.flashSettings(box.checked ? tr("已打开通知") : tr("已关闭通知：不再推 Windows 通知，也不发微信"));
    };
    row.append(box);
    body.append(row);
    body.append(
      el(
        "div",
        "hint",
        tr("等你批准或回答时，推送到 Windows 通知（Web Push）和微信。正看着这个页面时不发：只有切到别的标签页、最小化浏览器或切到别的程序时才发。一份问卷只发一条。"),
      ),
    );
    const tools = el("div", "queue-tools");
    const push = el("button", "btn", tr("在这台设备开启 Web Push"));
    push.onclick = () => void this.enablePush();
    const test = el("button", "btn", tr("发测试通知"));
    test.onclick = async () => {
      const res = await api.notifyTest().catch((e) => ({ push: 0, wechat: String(e.message ?? e) }));
      this.flashSettings(tr("测试通知：Web Push 送达 {p1} 台；微信：{p2}", { p1: res.push, p2: res.wechat }));
    };
    tools.append(push, test);
    body.append(tools);
    body.append(el("div", "hint", tr("Web Push 已订阅 {p1} 台设备。测试通知不受开关影响，页面在前也会弹。", { p1: this.me.pushCount })));
  }

  /**
   * D120 / #77：谁在吃内存。数字来自桥自己拉起的那些 pi 子进程（`tasklist` / `ps`），
   * 读不到就写「不可用」—— 不留空、不写 0，不猜。
   * D120 / #78：下面多了一个阈值区 —— 这一页上唯一能改的东西，改的就是回收判据本身。
   *
   * D120 / #80：临时要腾内存时的出口是这里那个「全部休眠」。它只收空闲的，正在跑的一轮
   * 一定不动，也一定不会出现在「已休眠」里（回执点名跳过的是谁）。
   */
  private paintRuntime(body: HTMLElement): void {
    const stats = this.runtimeStats;
    if (!stats) {
      body.append(el("div", "empty", tr("读取中…")));
      return;
    }
    const cost = stats.unavailable ? tr("不可用") : stats.totalBytes === null ? "" : fmtSize(stats.totalBytes);
    body.append(
      el(
        "div",
        "runtime-summary",
        cost ? tr("运行中 pi：{p1} 个 · {p2}", { p1: stats.running, p2: cost }) : tr("运行中 pi：{p1} 个", { p1: stats.running }),
      ),
    );
    // 一个 pi 都没起的时候按钮灰着：按下去也没东西可睡，不值得试一次才知道。
    const sleepAll = el("button", "btn ghost", tr("全部休眠")) as HTMLButtonElement;
    sleepAll.title = tr("把所有空闲的会话休眠掉：消息都在，下一条消息唤醒；正在跑的一轮不动。");
    sleepAll.disabled = stats.running === 0;
    sleepAll.onclick = () => {
      this.sleepAllReceipt = null;
      this.socket.send({ type: "runtime.sleepAll" });
      this.paintSettings();
    };
    const actions = el("div", "runtime-actions");
    actions.append(sleepAll);
    body.append(actions);
    if (this.sleepAllReceipt) body.append(el("div", "runtime-sleep-all", sleepAllText(this.sleepAllReceipt)));
    body.append(
      el(
        "div",
        "hint",
        tr("内存数字来自桥自己拉起的那些 pi 子进程（Windows 用 tasklist，macOS / Linux 用 ps），不按进程名过滤。读不到就写「不可用」，不猜、不留空。"),
      ),
    );
    if (!stats.sessions.length) {
      body.append(el("div", "empty", tr("现在没有在运行的 pi：发一条消息才会拉起一个。")));
    } else {
      const list = el("div", "runtime-list");
      for (const s of stats.sessions) {
        const row = el("div", "runtime-row");
        row.append(el("span", "runtime-name", s.name || s.id));
        row.append(el("span", "runtime-idle", tr("闲了 {p1}", { p1: idleLabel(s.idleMs) })));
        if (s.running) row.append(el("span", "runtime-tag", tr("在跑")));
        const bytes = typeof s.bytes === "number" ? fmtSize(s.bytes) : tr("不可用");
        row.append(el("span", `runtime-bytes${typeof s.bytes === "number" ? "" : " bad"}`, bytes));
        list.append(row);
      }
      body.append(list);
    }
    body.append(this.runtimeThresholds(stats));
  }

  /**
   * D120 / #78：两个阈值就地可改。写了就落 `<state>/lifecycle.json`（重启桥也还在），空闲那个
   * 下一个 tick 就按新值判定，水位等下一次采样。输入框里的值只在非注焦时才被重写成桥报的值，
   * 否则一次 tick 广播就能把输入草稿抹掉。
   */
  private runtimeThresholds(stats: RuntimeStats): HTMLElement {
    const box = el("div", "runtime-thresholds");
    const row = (cls: string, label: string, unit: string, value: number): HTMLInputElement => {
      const line = el("label", `runtime-threshold ${cls}`);
      line.append(el("span", "settings-label", label));
      const input = el("input", "ns-input mono") as HTMLInputElement;
      // 文本而不是 number：0 / 负数 / 非数字 要能被看见并被我们自己的校验拒掉（“abc”在 number 里直接变空）。
      input.type = "text";
      input.inputMode = "decimal";
      input.value = plainNumber(value);
      line.append(input, el("span", "runtime-unit", unit));
      box.append(line);
      return input;
    };
    const idle = row("idle", tr("空闲多久休眠"), tr("分钟"), stats.lifecycle.idleMs / MINUTE_MS);
    const limit = row("watermark", tr("内存水位"), "GB", stats.lifecycle.watermarkBytes / GB);
    const foot = el("div", "runtime-thresholds-foot");
    foot.append(el("div", "hint", tr("空闲阈值下一个 tick 就生效；内存水位等下一次采样（60 秒一次）。两个值都写进桥的状态目录，重启桥也还在。")));
    const save = el("button", "btn primary", tr("保存阈值")) as HTMLButtonElement;
    save.onclick = () => {
      const idleMs = thresholdOf(idle.value, MINUTE_MS);
      const watermarkBytes = thresholdOf(limit.value, GB);
      if (idleMs === null || watermarkBytes === null) {
        // 旧值就是桥报的那个：拒绝之后屏幕上也不能留一个假的「已生效」。
        this.flashSettings(tr("没有保存：阈值必须是大于 0 的数。"), true);
        idle.value = plainNumber(stats.lifecycle.idleMs / MINUTE_MS);
        limit.value = plainNumber(stats.lifecycle.watermarkBytes / GB);
        return;
      }
      this.act(() => this.socket.send({ type: "runtime.settings", idleMs, watermarkBytes }));
    };
    foot.append(save);
    box.append(foot);
    return box;
  }

  private paintSettingsForm(body: HTMLElement, view: SettingsView): void {
    const scope = view.scope;
    body.append(el("div", "settings-path", tr("{p1}{p2}", { p1: view.exists ? "" : tr("（还没有这个文件，保存时创建）"), p2: view.path })));
    if (scope === "project" && !view.writable) {
      body.append(el("div", "takeover warn", tr("这个项目没有被信任：pi 不会读它的 .pi/settings.json，也拒绝写它。先到「项目信任」里信任它。")));
    }
    if (view.error) body.append(el("div", "takeover warn", tr("{p1}。下面的表单不可用，用「编辑 JSON」修好文件。", { p1: view.error })));
    // SAFETY: settings.json 就是 JSON，六种叶子 + 嵌套，和 `SettingsCell` 一一对应；
    // 桥那边解析失败时会带 `view.error`，表单本来也不可用。
    const data = (view.json ?? {}) as SettingsCellOf;
    // One reader for both files: the row asks the same question of scope and of the layer above.
    const readPath = (source: SettingsCellOf | null, key: string): SettingsCell =>
      key.split(".").reduce<SettingsCell>((o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined), source ?? undefined);
    const get = (key: string): SettingsCell => readPath(data, key);
    const defaults = (view.defaults ?? {}) as Record<string, unknown>;
    // Project page: 「默认」 is what you actually get, so a global value wins over pi's factory one.
    const parentData = (scope === "project" ? (this.settingsView.global?.json ?? null) : null) as unknown as SettingsCellOf | null;
    const parentGet = (key: string): SettingsCell => readPath(parentData, key);
    const fmtSetting = (v: unknown): string | null => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v === "boolean") return v ? tr("开") : tr("关");
      if (Array.isArray(v)) return v.map(String).join(", ");
      return String(v);
    };
    /** 「（默认：medium）」 / 「（默认：auto，继承全局）」 / 「（默认：不设置）」 — what the empty choice means. */
    const defaultLabel = (f: SettingField): string => {
      // Lists merge with the parent (+x / -x), so "inheriting the global value" would be a lie there.
      // Model is stored as a provider/id pair, so the inherited value is the pair or nothing.
      const parentText = f.kind === "model"
        ? fmtSetting([parentGet("defaultProvider"), parentGet("defaultModel")].filter(Boolean).join("/"))
        : fmtSetting(parentGet(f.key));
      const inherited = f.kind === "list" ? null : parentText;
      if (inherited) return tr("（默认：{p1}，继承全局）", { p1: inherited });
      // pi's schema is the source of truth (D156); `defaultText` only explains what pi decides later.
      const own = fmtSetting(defaults[f.key]) ?? f.defaultText;
      // Last resort: say what "empty" means rather than leave a bare 「（默认）」 nobody can read.
      return own ? tr("（默认：{p1}）", { p1: own }) : tr("（默认：不设置）");
    };
    const patch: Record<string, unknown> = {};
    const form = el("div", "settings-form");
    // Collapsed 「高级」: rows nobody touches twice. Expanded state is remembered per browser.
    const adv = el("details", "settings-advanced") as HTMLDetailsElement;
    adv.open = localStorage.getItem("pi.settings.advanced") === "1";
    adv.addEventListener("toggle", () => localStorage.setItem("pi.settings.advanced", adv.open ? "1" : "0"));
    adv.append(el("summary", "", tr("高级")));
    const advForm = el("div", "settings-form");
    adv.append(advForm);
    const save = el("button", "btn primary", tr("保存")) as HTMLButtonElement;
    save.disabled = true;
    const mark = (key: string, value: unknown) => {
      patch[key] = value;
      save.disabled = !Object.keys(patch).length || Boolean(view.error) || (scope === "project" && !view.writable);
    };
    let group = "";
    const fields = settingFields();
    for (const f of fields) {
      if (f.globalOnly && scope !== "global") continue;
      const host = f.advanced ? advForm : form;
      if (!f.advanced && f.group && f.group !== group) {
        group = f.group;
        form.append(el("div", "settings-group", f.group));
      }
      const empty = defaultLabel(f);
      const row = el("label", "settings-row");
      const labelEl = el("span", "settings-label", f.label);
      // Rows whose input keeps its own placeholder (a pattern example, a URL) carry the default here.
      const inline = f.kind === "bool" || f.kind === "select" || f.kind === "model" || !f.placeholder;
      if (!inline) labelEl.append(el("span", `settings-default${f.label.length + empty.length > DEFAULT_LABEL_WRAP_AT ? " wrap" : ""}`, empty));
      row.append(labelEl);
      const current = f.kind === "model" ? (get("defaultProvider") && get("defaultModel") ? `${get("defaultProvider")}/${get("defaultModel")}` : "") : get(f.key);
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.kind === "bool") {
        const sel = el("select", "ns-input") as HTMLSelectElement;
        sel.append(new Option(empty, ""), new Option(tr("开"), "true"), new Option(tr("关"), "false"));
        sel.value = typeof current === "boolean" ? String(current) : "";
        sel.onchange = () => mark(f.key, sel.value === "" ? null : sel.value === "true");
        input = sel;
      } else if (f.kind === "select" || f.kind === "model") {
        const sel = el("select", "ns-input") as HTMLSelectElement;
        sel.append(new Option(empty, ""));
        const opts = f.kind === "model"
          ? this.models.map((m) => [`${m.provider}/${m.id}`, `${shortModelName(m.name)} · ${m.provider}`])
          : (f.choices ? f.choices.map((c) => [c.value, c.label]) : (f.options ?? []).map((o) => [o, o]));
        for (const [v, label] of opts) sel.append(new Option(label, v));
        const cur = typeof current === "string" ? current : "";
        if (cur && ![...sel.options].some((o) => o.value === cur)) sel.append(new Option(tr("{p1}（当前）", { p1: cur }), cur));
        sel.value = cur;
        sel.onchange = () => {
          if (f.kind === "model") {
            const at = sel.value.indexOf("/");
            mark("defaultProvider", sel.value ? sel.value.slice(0, at) : null);
            mark("defaultModel", sel.value ? sel.value.slice(at + 1) : null);
          } else mark(f.key, sel.value || null);
        };
        input = sel;
      } else {
        const inp = el("input", `ns-input${f.kind === "text" ? "" : " mono"}`) as HTMLInputElement;
        // A timeout is a number or the word "disabled", so a number field would hide the second case.
        if (f.kind === "number" && !f.allowDisabled) inp.type = "number";
        inp.placeholder = f.placeholder ?? empty;
        inp.value = f.kind === "list" ? (Array.isArray(current) ? current.join(", ") : "") : current == null ? "" : String(current);
        inp.oninput = () => {
          const v = inp.value.trim();
          if (!v) {
            inp.classList.remove("bad");
            return mark(f.key, null);
          }
          if (f.kind === "number") {
            // `disabled` is a real value in pi, not a typo: store the string, don't round it to NaN.
            if (f.allowDisabled && v === "disabled") {
              inp.classList.remove("bad");
              return mark(f.key, "disabled");
            }
            const n = Number(v);
            const ok = Number.isFinite(n);
            inp.classList.toggle("bad", !ok);
            if (!ok) return;
            return mark(f.key, Math.round(n));
          }
          if (f.kind === "list") return mark(f.key, v.split(",").map((x) => x.trim()).filter(Boolean));
          mark(f.key, v);
        };
        input = inp;
      }
      input.disabled = Boolean(view.error) || (scope === "project" && !view.writable);
      row.append(input);
      if (f.hint) row.append(el("span", "settings-hint", f.hint));
      host.append(row);
    }
    if (advForm.childElementCount) form.append(adv);
    body.append(form);
    if (scope === "global") body.append(this.lockExtBox());
    // Nested objects cannot be a row in this form, so name them here instead of hiding them.
    const jsonOnly = el("div", "settings-jsononly");
    jsonOnly.append(el("span", "settings-hint", tr("嵌套对象只能在 JSON 里改：modelThinkingLevels、thinkingBudgets、compaction.modelOverrides。")));
    const goJson = el("button", "btn ghost", tr("去改 JSON")) as HTMLButtonElement;
    goJson.onclick = () => this.paintSettingsJson(body, view);
    jsonOnly.append(goJson);
    body.append(jsonOnly);
    // D161: 默认权限只对「新会话」生效，所以这里给还停在默认上的会话一个出口。
    const permKey = scope === "project" ? (view.cwd ?? "") : "";
    if (this.permDefaultsFor !== permKey) {
      this.permDefaultsFor = permKey;
      this.permDefaults = null;
      this.socket.send({ type: "permission.defaults", ...(scope === "project" && view.cwd ? { cwd: view.cwd } : {}) });
    } else if (this.permDefaults && this.permDefaults.total > 0) {
      const pd = this.permDefaults;
      // The backend resolves each session against its own cwd, so the copy must not promise one mode.
      const box = el("div", "settings-perm-apply");
      box.append(el("div", "settings-label", tr("还在用默认权限的会话")));
      box.append(
        el(
          "div",
          "settings-hint",
          tr("{p1} 个会话是在各自创建时钉下的默认权限，不是你手动选的。要不要把它们也改成各自现在的默认值？每个会话按自己项目里的设置算。", { p1: String(pd.total) }),
        ),
      );
      let layer = tr("pi 的出厂值");
      if (pd.source === "global") layer = tr("全局设置");
      else if (pd.source === "project") layer = tr("项目设置");
      box.append(el("div", "settings-hint", tr("现在的默认值：{p1}（来自{p2}）", { p1: permMode(pd.mode).label, p2: layer })));
      if (pd.path) box.append(el("div", "settings-hint", pd.path));
      const btn = el("button", "btn ghost", tr("把这 {p1} 个会话改成各自的默认值", { p1: String(pd.total) })) as HTMLButtonElement;
      btn.onclick = () =>
        this.act(() => this.socket.send({ type: "permission.applyDefault", ...(scope === "project" && view.cwd ? { cwd: view.cwd } : {}) }));
      box.append(btn);
      body.append(box);
    }
    const foot = el("div", "settings-foot");
    const json = el("button", "btn ghost", tr("编辑 JSON")) as HTMLButtonElement;
    json.onclick = () => this.paintSettingsJson(body, view);
    foot.append(json, el("span", "spacer"), save);
    body.append(foot);
    save.onclick = () => {
      const sessionId = this.currentId;
      const changed = { ...patch };
      this.act(() => {
        // 改完默认值，「还在用默认」的那份清单要重新算一遍。
        if ("web.defaultPermission" in changed) this.permDefaultsFor = null;
        this.socket.send({ type: "settings.set", scope, ...(scope === "project" ? { cwd: view.cwd } : {}), patch: changed });
        // The four a running pi takes without a restart: apply them to the open session now.
        const runtime: Record<string, unknown> = {};
        if ("steeringMode" in changed && changed.steeringMode) runtime.steeringMode = changed.steeringMode;
        if ("followUpMode" in changed && changed.followUpMode) runtime.followUpMode = changed.followUpMode;
        if (typeof changed["compaction.enabled"] === "boolean") runtime.autoCompaction = changed["compaction.enabled"];
        if (typeof changed["retry.enabled"] === "boolean") runtime.autoRetry = changed["retry.enabled"];
        if (sessionId && this.session?.owned && Object.keys(runtime).length) this.socket.send({ type: "runtime", sessionId, ...runtime });
      });
    };
    if (this.session?.owned) {
      const reload = el("div", "settings-hint", tr("新开的会话直接用新设置；正在运行的会话里，除了队列方式、自动压缩、自动重试，其它要重新加载（重启这个会话的 pi）才生效。"));
      const btn = el("button", "btn ghost", tr("重新加载当前会话")) as HTMLButtonElement;
      btn.disabled = Boolean(this.session.running);
      btn.title = this.session.running ? tr("这一轮结束后再重新加载") : "/reload";
      btn.onclick = () => {
        const sessionId = this.currentId;
        if (!sessionId) return;
        this.act(() => this.socket.send({ type: "reload", sessionId }));
        this.closeSheet();
      };
      body.append(reload, btn);
    }
  }

  /** #30: the session lock for terminal pi — the half of D8 the bridge cannot do on its own. */
  private lockExtBox(): HTMLElement {
    const box = el("div", "settings-lockext");
    box.append(el("div", "settings-label", tr("终端联动：会话锁")));
    box.append(
      el(
        "div",
        "settings-hint",
        tr("pi 自己不锁会话文件，网页和终端同时写同一个会话会分叉。装上这个小扩展后，终端里的 pi 会登记自己开着的会话（网页就不会去接管它，列表里显示「终端占用」），打开一个网页正在写的会话时也会先提醒你。只影响之后启动的终端 pi。"),
      ),
    );
    const st = this.lockExt;
    const row = el("div", "settings-foot");
    row.append(el("span", `login-status${st?.installed ? " ok" : ""}`, st ? (st.installed ? tr("已安装（{p1}）", { p1: st.path }) : tr("未安装")) : tr("读取中…")));
    row.append(el("span", "spacer"));
    if (st) {
      const b = el("button", st.installed ? "btn ghost" : "btn", st.installed ? tr("移除") : tr("安装到 pi 的全局扩展")) as HTMLButtonElement;
      b.onclick = () => this.act(() => this.socket.send({ type: "lockext.set", on: !st.installed }));
      row.append(b);
    }
    box.append(row);
    return box;
  }

  private paintSettingsJson(body: HTMLElement, view: SettingsView): void {
    body.replaceChildren();
    body.append(el("div", "settings-path", view.path));
    const ta = el("textarea", "settings-json") as HTMLTextAreaElement;
    ta.value = view.raw || "{\n}\n";
    ta.spellcheck = false;
    const foot = el("div", "settings-foot");
    const back = el("button", "btn ghost", tr("回到表单")) as HTMLButtonElement;
    back.onclick = () => this.paintSettings();
    const save = el("button", "btn primary", tr("保存整个文件")) as HTMLButtonElement;
    save.disabled = view.scope === "project" && !view.writable;
    save.onclick = () => {
      try {
        JSON.parse(ta.value);
      } catch (err) {
        this.flashSettings(tr("不是合法的 JSON：{p1}", { p1: (err as Error).message }), true);
        return;
      }
      const raw = ta.value;
      this.act(() => this.socket.send({ type: "settings.set", scope: view.scope, ...(view.scope === "project" ? { cwd: view.cwd } : {}), raw }));
    };
    foot.append(back, el("span", "spacer"), save);
    body.append(ta, foot);
  }

  private paintTrust(body: HTMLElement): void {
    const t = this.trust;
    const cwd = this.session?.cwd ?? "";
    if (!t || t.cwd !== cwd) {
      body.append(el("div", "empty", cwd ? tr("读取中…") : tr("先打开一个会话")));
      return;
    }
    const lines = [
      t.needed ? tr("这个目录有需要信任才会加载的 pi 资源（.pi/settings.json、.pi/mcp.json、.pi/extensions|skills|prompts|themes、SYSTEM.md 等）。") : tr("这个目录没有需要信任的 pi 资源，信任与否都不影响。"),
      t.saved ? tr("已保存的决定：{p1}（{p2}）", { p1: t.saved.decision ? tr("信任") : tr("不信任"), p2: t.saved.path }) : tr("没有保存的决定。全局 defaultProjectTrust = {p1}，网页里的 pi 不能弹提示，所以{p2}。", { p1: t.fallback, p2: t.effective ? tr("会加载") : tr("不会加载") }),
      tr("决定写在 ~/.pi/agent/trust.json，和终端里的 /trust 是同一份。"),
    ];
    for (const l of lines) body.append(el("div", "settings-hint", l));
    const opts = el("div", "settings-trust-opts");
    t.options.forEach((o, i) => {
      // bridge 只给英文标签（Trust / Do not trust / Trust parent folder (…)），这里翻成人话。
      const parent = /^Trust parent folder \((.*)\)$/.exec(o.label);
      const label = o.label === "Trust" ? tr("信任这个目录") : o.label === "Do not trust" ? tr("不信任") : parent ? tr("信任上级目录 {p1}", { p1: parent[1] }) : o.label;
      const b = el("button", `btn${o.trusted ? " primary" : ""}`, label) as HTMLButtonElement;
      b.onclick = () => this.act(() => this.socket.send({ type: "trust.set", cwd, option: i }));
      opts.append(b);
    });
    body.append(opts);
    if (this.session?.owned) body.append(el("div", "settings-hint", tr("改了之后，正在运行的会话要「重新加载」（/reload）才会按新的决定加载项目资源。")));
  }

  // ---------------------------------------------------------------- /share /bug (#38)
  private flashShare(text: string, bad = false): void {
    const note = this.sheet?.querySelector<HTMLElement>(".share-note");
    if (note) {
      note.textContent = text;
      note.classList.toggle("bad", bad);
      if (bad) this.sheet?.querySelectorAll<HTMLButtonElement>(".share-go").forEach((b) => (b.disabled = false));
    } else if (text) this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text, level: bad ? "error" : "info" });
  }

  private shareSheet(title: string): { back: HTMLElement; sheet: HTMLElement; body: HTMLElement } {
    this.closeSheet();
    this.sheetKind = "share";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet settings-sheet share-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", title));
    const close = el("button", "btn ghost", tr("取消"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const body = el("div", "settings-body");
    sheet.append(head, el("div", "settings-tabs"), el("div", "settings-note share-note"), body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    return { back, sheet, body };
  }

  /** `/share`: pi's own order — Radius when logged in (or required by settings), else a private gist. */
  private openShareSheet(): void {
    const sessionId = this.currentId;
    if (!sessionId) return;
    const { body } = this.shareSheet(tr("分享会话（/share）"));
    body.append(
      el("div", "settings-hint", tr("会把这个会话（当前分支）上传出这台电脑，然后给你一个查看链接。会话里可能有你的提示词、工具参数、命令输出、读过的文件内容，以及对话里出现过的凭据——先确认里面没有不该给别人看的东西。")),
      el("div", "settings-hint", tr("去向和终端的 /share 一样：登录了 Radius 就传到 Radius（组织内可见），否则用 GitHub CLI 建一个私有 gist（要先 gh auth login）。设置里的 sessionShareDestination 可以强制其中一种。")),
    );
    const go = el("button", "btn primary share-go", tr("确认上传并生成链接")) as HTMLButtonElement;
    go.onclick = () => {
      go.disabled = true;
      this.flashShare(tr("准备中…"));
      this.act(() => this.socket.send({ type: "share", sessionId }));
    };
    const foot = el("div", "settings-foot");
    foot.append(el("span", "spacer"), go);
    body.append(foot);
  }

  /** `/bug`: what pi's report contains (settings redacted, no keys); upload or zip. */
  private openBugSheet(hint: string): void {
    const sessionId = this.currentId;
    if (!sessionId) return;
    const { body } = this.shareSheet(tr("给 pi 开发者报告 bug（/bug）"));
    body.append(el("div", "settings-hint", tr("报告会发给 pi 的开发者（Earendil），不公开。里面有 pi 版本、操作系统、这个会话用的模型和 provider 配置（不含 API key）、设置（敏感字段已去掉），以及这个会话里 provider 报过的错。")));
    const desc = el("textarea", "settings-json") as HTMLTextAreaElement;
    desc.style.minHeight = "110px";
    desc.placeholder = tr("出了什么问题？（可选）");
    desc.value = hint;
    body.append(desc);
    const wrap = el("label", "ns-adv-flag");
    const include = el("input") as HTMLInputElement;
    include.type = "checkbox";
    wrap.append(include, el("span", "", tr("附上这个会话的完整记录（你的消息、模型输出、工具调用和结果，包括读过的文件内容和命令输出）")));
    body.append(wrap);
    body.append(el("div", "settings-hint", tr("和终端相比少两样：不能让模型写摘要，报告里也不列出加载的扩展（网页这边拿不到运行中的会话对象）。")));
    const foot = el("div", "settings-foot");
    const send = (delivery: "upload" | "zip") => {
      for (const b of foot.querySelectorAll<HTMLButtonElement>("button")) b.disabled = true;
      this.flashShare(delivery === "upload" ? tr("上传中…") : tr("打包中…"));
      this.act(() => this.socket.send({ type: "bug", sessionId, hint: desc.value.trim(), includeSession: include.checked, delivery }));
    };
    const zip = el("button", "btn share-go", tr("导出 zip（自己看过再发）")) as HTMLButtonElement;
    zip.onclick = () => send("zip");
    const up = el("button", "btn primary share-go", tr("上传给 pi 开发者")) as HTMLButtonElement;
    up.onclick = () => send("upload");
    foot.append(el("span", "spacer"), zip, up);
    body.append(foot);
  }

  private paintExtIfOpen(): void {
    if (this.sheetKind === "settings" && this.settingsTab === "ext") this.paintSettings();
    else if (this.sheetKind === "ext") {
      const host = this.sheet?.querySelector<HTMLElement>(".ext-host");
      if (host) {
        // Keep the scroll position and the focused search box across repaints.
        const body = host.parentElement;
        const top = body?.scrollTop ?? 0;
        const focused = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement) ? document.activeElement.placeholder : null;
        const caret = focused ? (document.activeElement as HTMLInputElement).selectionStart : null;
        this.paintExtManager(host);
        if (body) body.scrollTop = top;
        if (focused) {
          const again = [...host.querySelectorAll<HTMLInputElement>("input")].find((i) => i.placeholder === focused);
          again?.focus();
          if (again && caret !== null) again.setSelectionRange(caret, caret);
        }
      }
    }
  }

  /**
   * Run one of pi's maintenance subcommands (bridge/src/picli.ts); the console shows its output.
   * D113: `key` names the row (or the pi row) this belongs to — it is how the repaint knows which
   * buttons are busy, and the bridge echoes the `reqId` back so a queued command can be told apart
   * from the one actually running.
   */
  private piCli(req: Record<string, unknown>, key: string): void {
    const cwd = this.session?.cwd;
    const reqId = `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const op = String(req.op ?? req.type ?? "");
    this.act(() => {
      this.cliOps.set(reqId, { key, op, state: "queued" });
      this.cliRun = { runId: null, op, out: "", code: undefined };
      // `req` may carry its own `type` (mcp.install); it wins over the default `picli` below.
      this.socket.send({ type: "picli", reqId, ...(cwd ? { cwd } : {}), ...req });
      this.paintExtIfOpen();
    });
  }

  /**
   * D113: a write that just edits a file (启用 / 停用 an extension or MCP server, bump a channel's
   * version). No console: the bridge answers with `ext.op` running / done for this `reqId`.
   */
  private extWrite(req: Record<string, unknown>, key: string): void {
    const cwd = this.session?.cwd;
    const reqId = `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.act(() => {
      this.cliOps.set(reqId, { key, op: String(req.type ?? ""), state: "queued" });
      this.socket.send({ ...req, reqId, ...(cwd ? { cwd } : {}) });
      this.paintExtIfOpen();
    });
  }

  /** The write this page started for this row, if any (only its own buttons wait for it). */
  private opFor(key: string): { key: string; op: string; state: "queued" | "running" } | undefined {
    for (const op of this.cliOps.values()) if (op.key === key) return op;
    return undefined;
  }

  /** What a row's button says while that row's own operation is queued / running (null = clickable). */
  private opLabel(key: string, running: string): string | null {
    const op = this.opFor(key);
    if (!op) return null;
    return op.state === "queued" ? tr("排队中…") : running;
  }

  /** #33: packages and MCP servers, what `pi install/list/remove/update` and `pi mcp …` do. */
  // ---------------------------------------------------------------- 扩展 manager (D81)
  /** Settings → 扩展与 MCP: the composer-button switch, then the same manager as the dialog. */
  private paintExtSettings(body: HTMLElement): void {
    // #49: pi itself sits above the inventory — it is the program doing all of the below.
    this.paintPiUpdate(body);
    const row = el("label", "ns-adv-flag ext-switch");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = this.uiPrefs.showExtButton;
    box.onchange = () => this.act(() => this.socket.send({ type: "ui.set", showExtButton: box.checked }));
    row.append(box, el("span", "", tr("在输入框下方显示「扩展」按钮（点开就是下面这套管理界面）")));
    body.append(row);
    const host = el("div", "ext-host");
    body.append(host);
    if (!this.extInv && !this.extInvLoading) this.loadExtInventory();
    this.paintExtManager(host);
  }

  /**
   * #49: one row for the CLI the bridge drives — current version, the latest release, and a single
   * 更新 button that runs `pi update` through the same console as the extension operations. The
   * check is lazy (first paint of this page, then the bridge's 30-minute cache) and 「重新检查」
   * bypasses that cache.
   */
  private paintPiUpdate(body: HTMLElement): void {
    const box = el("div", "ext-pi");
    const row = el("div", "settings-foot");
    row.append(el("span", "pi-name", tr("pi 本体")), el("span", "pi-ver", `pi ${this.me.pi}`));
    const upd = this.piUpd;
    const hint = el("span", "settings-hint");
    if (this.piChecking) hint.textContent = tr("联网检查版本中…");
    else if (!upd) hint.textContent = "";
    else if (upd.error) hint.textContent = tr("没查到最新版：{p1}", { p1: upd.error });
    else
      hint.textContent = tr("最新 {p1}（{p2}） · 检查于 {p3}", {
        p1: upd.latest ?? "",
        p2: upd.source ?? "",
        p3: new Date(upd.checkedAt).toLocaleTimeString(),
      });
    row.append(hint, el("span", "spacer"));
    const recheck = el("button", "btn ghost", tr("重新检查")) as HTMLButtonElement;
    recheck.disabled = this.piChecking;
    recheck.title = tr("绕过桥的 30 分钟缓存，重新问一次");
    recheck.onclick = () => this.checkPiUpdate(true);
    row.append(recheck);
    const busy = Boolean(this.me.public) || Boolean(this.opFor("pi")) || this.piUpdRun === "running";
    if (upd?.update || (upd && upd.error)) {
      const go = el("button", "btn primary", this.piUpdRun === "running" ? tr("更新中…") : tr("更新 pi")) as HTMLButtonElement;
      go.disabled = busy;
      go.onclick = () => this.confirmPiUpdate(false);
      row.append(go);
    } else if (upd && !upd.error) {
      row.append(el("span", "settings-hint", tr("已是最新")));
    }
    box.append(row);
    if (this.piUpdRun === "ok") {
      box.append(el("div", "login-result", tr("已更新到 {p1}。已开着的会话仍是旧版本，新开的会话自动用新版。", { p1: this.me.pi })));
      const tools = el("div", "settings-foot");
      if (this.session?.owned) {
        const again = el("button", "btn", tr("重启当前会话")) as HTMLButtonElement;
        again.disabled = Boolean(this.session.running);
        again.title = this.session.running ? tr("这一轮结束后再重启") : tr("重启这个会话的 pi，读到新版本");
        again.onclick = () => {
          const sessionId = this.currentId;
          if (!sessionId) return;
          this.act(() => this.socket.send({ type: "reload", sessionId }));
        };
        tools.append(again);
      }
      const log = el("button", "btn ghost", tr("看更新日志"));
      log.onclick = () => {
        this.settingsTab = "changelog";
        this.paintSettings();
      };
      tools.append(log);
      box.append(tools);
    } else if (this.piUpdRun === "fail") {
      box.append(el("div", "login-result bad", tr("更新失败：看下面的输出。常见原因是网络，或上一次更新只换了一半。")));
      const force = el("button", "btn", tr("强制重装（--force）")) as HTMLButtonElement;
      force.disabled = busy;
      force.title = tr("不带 --force 时，已经是最新就什么都不做；强制重装会真的再装一遍");
      force.onclick = () => this.confirmPiUpdate(true);
      box.append(force);
    }
    body.append(box);
    // Lazy: ask once per visit, and only when the answer is missing or older than the bridge's cache.
    if (!this.piChecking && (!this.piUpd || Date.now() - this.piUpd.checkedAt > 30 * 60_000)) this.checkPiUpdate();
  }

  private checkPiUpdate(force = false): void {
    if (this.piChecking) return;
    this.piChecking = true;
    this.socket.send({ type: "pi.update.check", ...(force ? { force: true } : {}) });
    this.paintExtIfOpen();
  }

  /** The update replaces the globally installed pi: say what that costs before running it. */
  private confirmPiUpdate(force: boolean): void {
    if (document.querySelector(".modal")) return;
    const modal = el("div", "modal hi");
    const form = el("form");
    const h = el("h2", "", force ? tr("强制重装 pi？") : tr("更新 pi？"));
    h.style.margin = "0";
    h.style.fontSize = "16px";
    const latest =
      this.piUpd?.latest && this.piUpd.update
        ? tr("（{p1} → {p2}）", { p1: this.me.pi, p2: this.piUpd.latest })
        : tr("（当前 {p1}）", { p1: this.me.pi });
    const p = el(
      "p",
      "",
      tr("要联网，可能几分钟；会替换全局安装的 pi{p1}。期间不要关页面；失败没有自动回滚，重装可再点一次。", { p1: latest }),
    );
    p.style.color = "var(--faint)";
    p.style.fontSize = "13px";
    p.style.margin = "0";
    const btns = el("div", "settings-foot");
    btns.append(el("span", "spacer"));
    const cancel = el("button", "btn ghost", tr("取消"));
    cancel.type = "button";
    cancel.onclick = () => this.closeModal();
    const ok = el("button", "btn primary", force ? tr("强制重装") : tr("更新"));
    ok.type = "submit";
    btns.append(cancel, ok);
    form.append(h, p, btns);
    modal.append(form);
    modal.onclick = (ev) => {
      if (ev.target === modal) this.closeModal();
    };
    form.onsubmit = (ev) => {
      ev.preventDefault();
      this.closeModal();
      this.piUpdRun = "running";
      this.piCli({ op: "pkg.update", target: "self", ...(force ? { force: true } : {}) }, "pi");
    };
    this.overlay(modal);
  }

  /** The dialog the composer's 扩展 button opens. */
  private openExtManager(tab: "installed" | "ext" | "mcp" = "installed"): void {
    this.closeSheet();
    this.sheetKind = "ext";
    this.extTab = tab;
    this.extDirty = false;
    this.extVars = [];
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet settings-sheet ext-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("扩展与 MCP")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const body = el("div", "settings-body");
    const host = el("div", "ext-host");
    body.append(host);
    sheet.append(head, el("div", "settings-tabs"), el("div", "settings-note"), body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    // D113: keep the last inventory on screen (it is the fastest thing we have); the bridge pushes a
    // fresh one in stages, so 「联网检查」 never hides the rows again.
    this.loadExtInventory();
    this.paintExtManager(host);
  }

  /**
   * Fresh inventory with online version checks. The bridge answers in stages — installed rows first,
   * then MCP servers, then versions — so this only starts the request; the spinner state lives in
   * `extInvLoading` (rows are being read) and `extCheckLoading` (the registries are being asked).
   */
  private loadExtInventory(): void {
    // One inventory at a time: a second request while the first is still streaming would run the
    // MCP connections and the registry lookups twice. Remember it and re-ask when this one lands.
    if (this.extCheckLoading) {
      this.extReloadPending = true;
      return;
    }
    this.extInvLoading = true;
    this.extCheckLoading = true;
    this.socket.send({ type: "ext.inventory", check: true, ...(this.session?.cwd ? { cwd: this.session.cwd } : {}) });
  }

  private paintExtButton(): void {
    const btn = this.extButton;
    if (!btn) return;
    btn.querySelector(".ext-badge")?.remove();
    if (this.extUpdates > 0) {
      const badge = el("span", "ext-badge", String(this.extUpdates));
      badge.title = tr("{p1} 个可以更新", { p1: this.extUpdates });
      btn.append(badge);
    }
  }

  private extArmed(key: string): boolean {
    if (this.extArm && this.extArm.key === key && Date.now() < this.extArm.until) {
      this.extArm = null;
      return true;
    }
    this.extArm = { key, until: Date.now() + 4000 };
    setTimeout(() => {
      if (this.extArm?.key === key && Date.now() >= this.extArm.until) {
        this.extArm = null;
        this.paintExtIfOpen();
      }
    }, 4100);
    return false;
  }

  private paintExtManager(host: HTMLElement): void {
    host.replaceChildren();
    const tabs = el("div", "settings-tabs ext-tabs");
    const def: ["installed" | "ext" | "mcp", string][] = [
      ["installed", this.extUpdates ? tr("已安装（{p1} 个可更新）", { p1: this.extUpdates }) : tr("已安装")],
      ["ext", tr("扩展商店")],
      ["mcp", tr("MCP 商店")],
    ];
    for (const [id, label] of def) {
      const b = el("button", `chip${this.extTab === id ? " on" : ""}`, label) as HTMLButtonElement;
      b.onclick = () => {
        this.extTab = id;
        this.paintExtIfOpen();
      };
      tabs.append(b);
    }
    host.append(tabs);
    if (this.me.public) host.append(el("div", "takeover warn", tr("通过公网访问：这里只能查看，安装 / 卸载 / 更新 / 启停请在本机或局域网操作。")));
    if (this.extDirty) {
      const bar = el("div", "takeover ext-reload");
      bar.append(el("span", "", tr("改动要「重新加载」后，正在运行的会话才看得到（新开的会话直接生效）。")));
      if (this.session?.owned) {
        const b = el("button", "btn", tr("重新加载当前会话")) as HTMLButtonElement;
        b.disabled = Boolean(this.session.running);
        b.title = this.session.running ? tr("这一轮结束后再重新加载") : "/reload";
        b.onclick = () => {
          const sessionId = this.currentId;
          if (!sessionId) return;
          this.act(() => this.socket.send({ type: "reload", sessionId }));
          this.extDirty = false;
          this.paintExtIfOpen();
        };
        bar.append(b);
      }
      host.append(bar);
    }
    if (this.extVars.length) {
      host.append(
        el("div", "takeover warn", tr("这个 MCP 服务要用到密钥，mcp.json 里只写了变量引用。请在系统环境变量里设置：{p1}，然后重启 bridge（或至少重新加载会话）。", { p1: this.extVars.join(tr("、")) })),
      );
    }
    if (this.extTab === "installed") this.paintExtInstalled(host);
    else if (this.extTab === "ext") this.paintExtStore(host);
    else this.paintMcpStore(host);
    // console of the last command
    const run = this.cliRun;
    if (run && run.op !== "pkg.list" && run.op !== "mcp.list") {
      // D113: a queued command has no run id yet — say so instead of «正在运行» for something that
      // is still waiting for the resource lock.
      const queued = run.runId === null && run.code === undefined && !run.error;
      const status = run.error
        ? tr("没跑起来：{p1}", { p1: run.error })
        : queued
          ? tr("已排队 {p1}（桥按资源一个接一个跑）", { p1: run.op })
          : run.code === undefined
            ? tr("正在运行 {p1}…", { p1: run.op })
            : run.code === 0
              ? tr("{p1} 完成", { p1: run.op })
              : tr("{p1} 退出码 {p2}", { p1: run.op, p2: run.code ?? -1 });
      host.append(el("div", `login-result${run.error || (run.code !== undefined && run.code !== 0) ? " bad" : ""}`, status));
      const pre = el("pre", "cli-out", run.out || "");
      host.append(pre);
      queueMicrotask(() => (pre.scrollTop = pre.scrollHeight));
    }
  }

  private paintExtInstalled(host: HTMLElement): void {
    const inv = this.extInv;
    // D113: no global busy flag any more — each row waits for its own operation, the rest stay live.
    const ro = Boolean(this.me.public);
    const cwd = this.session?.cwd;
    const top = el("div", "settings-foot");
    const hint = el("span", "settings-hint");
    if (!inv) {
      // The very first read (no cache): say what is happening, not that the network is slow.
      hint.append(el("span", "act-spin"), el("span", "", tr("读取已安装的包和扩展…")));
    } else if (this.extCheckLoading) hint.append(el("span", "act-spin"), el("span", "", tr("联网检查版本中…")));
    else hint.textContent = tr("检查于 {p1}", { p1: fmtTime(inv.checkedAt) });
    top.append(hint);
    top.append(el("span", "spacer"));
    const updatable = inv ? [...inv.packages.filter((p) => p.update).map((p) => ({ kind: "pkg" as const, p })), ...inv.mcp.filter((m) => m.version.update).map((m) => ({ kind: "mcp" as const, m }))] : [];
    const rowKey = (u: (typeof updatable)[number]) => (u.kind === "pkg" ? `pkg:${u.p.source}` : `mcp:${u.m.source}:${u.m.name}`);
    if (updatable.length) {
      const all = el("button", "btn primary", tr("全部更新（{p1}）", { p1: updatable.length })) as HTMLButtonElement;
      all.title = tr("一次全点下去：桥按资源排队跑，不会两个同时改同一个目录");
      all.disabled = ro || updatable.every((u) => this.opFor(rowKey(u)));
      all.onclick = () => {
        for (const u of updatable) {
          if (u.kind === "pkg") this.piCli({ op: "pkg.update", target: this.pkgRef(u.p) }, `pkg:${u.p.source}`);
          else if (u.m.version.latest) this.extWrite({ type: "mcp.bump", file: u.m.source, name: u.m.name, version: u.m.version.latest }, `mcp:${u.m.source}:${u.m.name}`);
        }
      };
      top.append(all);
    }
    const refresh = el("button", "btn ghost", tr("刷新")) as HTMLButtonElement;
    refresh.onclick = () => {
      this.loadExtInventory();
      this.paintExtIfOpen();
    };
    top.append(refresh);
    host.append(top);
    if (!inv) {
      host.append(el("div", "empty", tr("读取已安装的包和扩展…（联网查版本会并行跑，不再等它）")));
      return;
    }

    host.append(el("div", "settings-label", tr("pi 包")));
    const pkgs = el("div", "login-list");
    if (!inv.packages.length) pkgs.append(el("div", "empty", tr("还没有装任何包，去「扩展商店」看看")));
    for (const p of inv.packages) pkgs.append(this.pkgRow(p, ro));
    host.append(pkgs);

    host.append(el("div", "settings-label", tr("扩展（内置 / 单独的文件）")));
    const exts = el("div", "login-list");
    for (const x of inv.extensions) exts.append(this.extRow(x, ro, cwd));
    host.append(exts);

    host.append(el("div", "settings-label", tr("MCP 服务器")));
    const mcp = el("div", "login-list");
    if (!inv.mcpReady) {
      // pi mcp list really connects every enabled server, so this arrives after the packages did.
      const wait = el("div", "empty");
      wait.append(el("span", "act-spin"), el("span", "", tr("连接 MCP 服务器中…（pi mcp list 要挨个连一遍）")));
      mcp.append(wait);
    } else {
      if (inv.mcpError) mcp.append(el("div", "settings-hint", tr("pi mcp list 出错：{p1}", { p1: inv.mcpError })));
      // pi drops entries it cannot parse from `servers` and lists them here; silence made them vanish.
      for (const bad of inv.mcpErrors ?? []) mcp.append(el("div", "settings-hint", tr("pi 跳过了这个 MCP 条目：{p1}", { p1: bad })));
      // The project's .pi/mcp.json only counts when pi trusts the project (D171).
      if (inv.mcpNote)
        mcp.append(
          el(
            "div",
            "settings-hint",
            /not trusted/i.test(inv.mcpNote) ? tr("项目未受信任：pi 不会读这里的 .pi/mcp.json，装在本项目的 MCP 不生效（在该项目里启动一次 pi 即可信任）。") : inv.mcpNote,
          ),
        );
      if (!inv.mcp.length) mcp.append(el("div", "empty", tr("没有配置 MCP 服务器，去「MCP 商店」看看")));
    }
    for (const m of inv.mcp) mcp.append(this.mcpRow(m, ro));
    host.append(mcp);

    this.paintExtAddBySource(host, ro);
  }

  /** One pkg row: name, status, and the buttons that only wait for this row. */
  private pkgRow(p: ExtPackage, ro: boolean): HTMLElement {
    const row = el("div", "login-row");
    const key = `pkg:${p.source}`;
    const name = el("div", "login-name");
    name.append(el("span", "", p.name ?? p.source), el("span", "settings-hint", tr(" {p1}{p2}", { p1: p.version ? `v${p.version}` : "", p2: p.pinned && p.origin !== "local" ? tr(" · 固定版本") : "" })));
    name.title = `${p.source}${p.path ? `\n${p.path}` : ""}`;
    // While the registries are being asked, an unchanged row is 「检查中」 — not 「最新」, which it
    // only knows after the answer comes back.
    const tag = p.update
      ? tr("可更新到 {p1}", { p1: p.latest ?? "" })
      : p.origin === "local"
        ? tr("本地")
        : p.checkError
          ? tr("没查到最新版")
          : p.pinned
            ? ""
            : this.extCheckLoading
              ? tr("检查中…")
              : tr("最新");
    row.append(name, el("span", `login-status${p.update ? " warn" : p.origin !== "local" && !p.checkError && !p.pinned && !this.extCheckLoading ? " ok" : ""}`, tr("{p1}{p2}", { p1: p.scope === "project" ? tr("项目 · ") : "", p2: tag })));
    const acts = el("div", "login-acts");
    if (p.update) {
      const label = this.opLabel(key, tr("更新中…"));
      const up = el("button", "btn primary", label ?? tr("更新")) as HTMLButtonElement;
      up.disabled = ro || Boolean(label);
      up.onclick = () => this.piCli({ op: "pkg.update", target: this.pkgRef(p) }, key);
      acts.append(up);
    }
    const armed = this.extArm?.key === key;
    // While this row's own operation runs, its other buttons wait too — but they keep their own
    // label (a 卸载 button saying 「更新中…」 would be a lie), and no other row is affected.
    const rowBusy = ro || Boolean(this.opFor(key));
    const rm = el("button", `btn ghost${armed ? " danger" : ""}`, armed ? tr("确认卸载？") : tr("卸载")) as HTMLButtonElement;
    rm.disabled = rowBusy;
    rm.onclick = () => {
      if (this.extArmed(key)) this.piCli({ op: "pkg.remove", source: this.pkgRef(p), local: p.scope === "project" }, key);
      this.paintExtIfOpen();
    };
    acts.append(rm);
    row.append(acts);
    return row;
  }

  /** One ext row: name, status, and the buttons that only wait for this row. */
  private extRow(x: ExtLoose, ro: boolean, cwd: string | undefined): HTMLElement {
    const row = el("div", `login-row${x.enabled ? " on" : ""}`);
    const key = `ext:${x.id}`;
    const name = el("div", "login-name");
    name.append(el("span", "", x.label), el("span", "settings-hint", tr(" {p1}{p2}", { p1: x.scope === "builtin" ? tr("内置") : x.scope === "project" ? tr("项目") : tr("全局"), p2: x.how === "listed" ? tr(" · settings 里列出") : x.how === "discovered" ? tr(" · extensions 目录") : "" })));
    name.title = x.id;
    row.append(name, el("span", `login-status${x.enabled ? " ok" : ""}`, x.enabled ? tr("启用") : tr("已停用")));
    const acts = el("div", "login-acts");
    const label = this.opLabel(key, x.enabled ? tr("停用中…") : tr("启用中…"));
    const t = el("button", "btn", label ?? (x.enabled ? tr("停用") : tr("启用"))) as HTMLButtonElement;
    t.disabled = ro || Boolean(label);
    t.onclick = () => this.extWrite({ type: "ext.toggle", id: x.id, scope: x.scope, how: x.how, enable: !x.enabled, ...(cwd ? { cwd } : {}) }, key);
    acts.append(t);
    row.append(acts);
    return row;
  }

  /** One mcp row: name, status, and the buttons that only wait for this row. */
  private mcpRow(m: ExtMcp, ro: boolean): HTMLElement {
    const row = el("div", `login-row${m.state === "connected" ? " on" : ""}`);
    const key = `mcp:${m.source}:${m.name}`;
    const name = el("div", "login-name");
    const v = m.version;
    name.append(el("span", "", m.name), el("span", "settings-hint", tr(" {p1}{p2}{p3}", { p1: m.scope, p2: v.version ? ` · v${v.version}` : v.identifier ? tr(" · 始终用最新") : "", p3: m.exposure ? ` · ${m.exposure}` : "" })));
    if (m.transport) name.title = m.transport;
    const state = !m.enabled ? tr("已停用") : m.state === "connected" ? tr("已连接 · {p1} 个工具", { p1: m.tools.length }) : (m.state ?? tr("未知"));
    row.append(name, el("span", `login-status${v.update ? " warn" : m.state === "connected" ? " ok" : ""}`, v.update ? tr("可更新到 {p1} · {p2}", { p1: v.latest ?? "", p2: state }) : state));
    const acts = el("div", "login-acts");
    if (m.error) acts.append(el("span", "settings-hint", m.error.slice(0, 200)));
    if (m.tools.length) {
      const tools = el("details", "ext-tools");
      tools.append(el("summary", "", tr("工具（{p1}）", { p1: m.tools.length })), el("div", "settings-hint", m.tools.join(" · ")));
      acts.append(tools);
    }
    if (v.update && v.latest) {
      const label = this.opLabel(key, tr("更新中…"));
      const up = el("button", "btn primary", label ?? tr("更新")) as HTMLButtonElement;
      up.disabled = ro || Boolean(label);
      up.onclick = () => this.extWrite({ type: "mcp.bump", file: m.source, name: m.name, version: v.latest }, key);
      acts.append(up);
    }
    const t = el("button", "btn", m.enabled ? tr("停用") : tr("启用")) as HTMLButtonElement;
    t.disabled = ro || Boolean(this.opFor(key));
    t.onclick = () => this.extWrite({ type: "mcp.toggle", file: m.source, name: m.name, enable: !m.enabled }, key);
    const login = el("button", "btn ghost", tr("OAuth 登录")) as HTMLButtonElement;
    login.title = tr("pi mcp login：在这台电脑上打开浏览器完成授权");
    login.disabled = ro || Boolean(this.opFor(key));
    login.onclick = () => this.piCli({ op: "mcp.login", name: m.name }, key);
    const armed = this.extArm?.key === key;
    const rm = el("button", `btn ghost${armed ? " danger" : ""}`, armed ? tr("确认删除？") : tr("删除")) as HTMLButtonElement;
    rm.disabled = ro || Boolean(this.opFor(key));
    rm.onclick = () => {
      if (this.extArmed(key)) this.piCli({ op: "mcp.remove", name: m.name, local: m.scope === "project" }, key);
      this.paintExtIfOpen();
    };
    acts.append(t, login, rm);
    row.append(acts);
    return row;
  }

  /** 按来源安装 / 手动添加：商店里没有的 git、本地路径、手写 MCP 命令。 */
  private paintExtAddBySource(host: HTMLElement, ro: boolean): void {
  const more = el("details", "ns-advanced");
  more.append(el("summary", "", tr("按来源安装包 / 手动添加 MCP 服务器")));
  const grid = el("div", "ns-adv-grid");
  const src = el("input", "ns-input mono") as HTMLInputElement;
  src.placeholder = "npm:@scope/pkg · git:github.com/user/repo · ./local/path";
  const go = el("button", "btn", tr("安装包")) as HTMLButtonElement;
  go.disabled = ro;
  go.onclick = () => {
    if (src.value.trim()) this.piCli({ op: "pkg.install", source: src.value.trim(), local: this.extScope === "project" }, `install:${src.value.trim()}`);
  };
  const r1 = el("div", "info-compact");
  r1.append(src, go);
  grid.append(r1);
  const mName = el("input", "ns-input mono") as HTMLInputElement;
  mName.placeholder = tr("MCP 服务名，例如 github");
  const mUrl = el("input", "ns-input mono") as HTMLInputElement;
  mUrl.placeholder = tr("HTTP 服务器 URL（stdio 服务器留空，填下面的命令）");
  const mCmd = el("input", "ns-input mono") as HTMLInputElement;
  mCmd.placeholder = tr("启动命令 + 参数（空格分隔），例如 npx -y @modelcontextprotocol/server-everything");
  const mGo = el("button", "btn", tr("添加 MCP")) as HTMLButtonElement;
  mGo.disabled = ro;
  mGo.onclick = () => {
    const parts = mCmd.value.trim().split(/\s+/).filter(Boolean);
    const name = mName.value.trim();
    this.piCli({ op: "mcp.add", name, url: mUrl.value.trim() || undefined, command: parts[0], args: parts.slice(1), local: this.extScope === "project" }, `mcpadd:${name}`);
  };
  grid.append(mName, mUrl, mCmd, mGo);
  more.append(grid);
  host.append(more);
  }

  /** A local package is stored relative to its settings file: hand pi the resolved path. */
  private pkgRef(p: { source: string; path: string | null }): string {
    return /^(npm:|git:|https?:|ssh:)/.test(p.source) ? p.source : (p.path ?? p.source);
  }

  private storeHeader(host: HTMLElement, store: { query: string; limit: number }, placeholder: string, run: () => void): void {
    const bar = el("div", "info-compact");
    const q = el("input", "ns-input") as HTMLInputElement;
    q.placeholder = placeholder;
    q.value = store.query;
    let timer: ReturnType<typeof setTimeout> | null = null;
    q.oninput = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        store.query = q.value.trim();
        run();
      }, 350);
    };
    const scope = el("select", "ns-input") as HTMLSelectElement;
    scope.append(new Option(tr("装到全局"), "global"), new Option(tr("装到当前项目"), "project"));
    scope.value = this.extScope;
    scope.style.flex = "0 0 auto";
    scope.style.width = "auto";
    scope.disabled = !this.session?.cwd;
    scope.onchange = () => (this.extScope = scope.value === "project" ? "project" : "global");
    bar.append(q, scope);
    host.append(bar);
    const chips = el("div", "settings-trust-opts");
    chips.append(el("span", "settings-hint", store.query ? tr("搜索结果，按热度排：") : tr("热度前")));
    for (const n of [10, 20, 50]) {
      const b = el("button", `chip${store.limit === n ? " on" : ""}`, String(n)) as HTMLButtonElement;
      b.onclick = () => {
        store.limit = n;
        run();
      };
      chips.append(b);
    }
    host.append(chips);
    queueMicrotask(() => {
      if (document.activeElement === document.body) q.focus();
    });
  }

  private paintExtStore(host: HTMLElement): void {
    const store = this.extStore;
    const run = () => {
      store.items = null;
      this.socket.send({ type: "ext.store", query: store.query, limit: store.limit });
      this.paintExtIfOpen();
    };
    if (store.items === null && !store.error) this.socket.send({ type: "ext.store", query: store.query, limit: store.limit });
    this.storeHeader(host, store, tr("搜索 pi 扩展（npm 上带 pi-package 关键字的包）"), run);
    host.append(el("div", "settings-hint", tr("来源是 npm（和 pi.dev/packages 画廊同一批包），按月下载量排序。装包等于让它的代码在这台电脑上运行，只装你信得过的。")));
    const list = el("div", "login-list");
    if (store.error) list.append(el("div", "empty", store.error));
    else if (!store.items) list.append(el("div", "empty", tr("查询中…")));
    else if (!store.items.length) list.append(el("div", "empty", tr("没有找到")));
    const installed = new Set((this.extInv?.packages ?? []).map((p) => p.name).filter(Boolean));
    const ro = Boolean(this.me.public);
    (store.items ?? []).forEach((p, i) => {
      const row = el("div", "login-row");
      const name = el("div", "login-name");
      const link = el("a", "", p.name) as HTMLAnchorElement;
      link.href = p.link;
      link.target = "_blank";
      link.rel = "noopener";
      name.append(el("span", "ext-rank", `${i + 1}`), link, el("span", "settings-hint", ` v${p.version}${p.publisher ? ` · ${p.publisher}` : ""}`));
      row.append(name, el("span", "login-status", tr("月下载 {p1}", { p1: p.monthly.toLocaleString("en-US") })));
      const acts = el("div", "login-acts");
      if (p.description) acts.append(el("span", "settings-hint ext-desc", p.description));
      if (installed.has(p.name)) acts.append(el("span", "login-status ok", tr("已安装")));
      else {
        const key = `install:${p.name}`;
        const label = this.opLabel(key, tr("安装中…"));
        const b = el("button", "btn primary", label ?? tr("安装")) as HTMLButtonElement;
        b.disabled = ro || Boolean(label);
        b.onclick = () => this.piCli({ op: "pkg.install", source: `npm:${p.name}`, local: this.extScope === "project" }, key);
        acts.append(b);
      }
      row.append(acts);
      list.append(row);
    });
    host.append(list);
  }

  private paintMcpStore(host: HTMLElement): void {
    const store = this.mcpStore;
    const run = () => {
      store.items = null;
      this.mcpForm = null;
      this.socket.send({ type: "mcp.store", query: store.query, limit: store.limit });
      this.paintExtIfOpen();
    };
    if (store.items === null && !store.error) this.socket.send({ type: "mcp.store", query: store.query, limit: store.limit });
    this.storeHeader(host, store, tr("搜索 MCP 服务（官方 MCP Registry）"), run);
    const notes: string[] = [tr("来源是官方 MCP Registry，按仓库的 GitHub star 排序。")];
    if (store.building) notes.push(tr("排行数据正在后台建立（第一次要几分钟，取决于网络），现在显示的是 Registry 的直接搜索结果，没有 star；建好后这里会自动换成排行。"));
    else if (store.truncated) notes.push(tr("Registry 条目太多，排行只统计了前面的一部分。"));
    else if (store.items && !store.starsComplete) notes.push(store.hasToken ? tr("部分仓库的 star 没查到。") : tr("没登录 GitHub CLI（gh），star 只查到一部分：运行 gh auth login 后排行更准。"));
    host.append(el("div", "settings-hint", notes.join("")));
    const list = el("div", "login-list");
    if (store.error) list.append(el("div", "empty", store.error));
    else if (!store.items) list.append(el("div", "empty", tr("查询中…")));
    else if (!store.items.length) list.append(el("div", "empty", tr("没有找到")));
    const ro = Boolean(this.me.public);
    const installedText = (this.extInv?.mcp ?? []).map((m) => `${m.name} ${m.transport ?? ""}`).join("\n");
    (store.items ?? []).forEach((m, i) => {
      const row = el("div", "login-row");
      const name = el("div", "login-name");
      name.append(el("span", "ext-rank", `${i + 1}`), el("span", "", m.title));
      name.append(el("span", "settings-hint", ` ${m.name}${m.version ? ` · v${m.version}` : ""}`));
      name.title = m.name;
      const right = el("span", "login-status", m.stars ? `★ ${m.stars.toLocaleString("en-US")}` : "");
      row.append(name, right);
      const acts = el("div", "login-acts");
      if (m.description) acts.append(el("span", "settings-hint ext-desc", m.description));
      if (m.repo) {
        const a = el("a", "settings-hint", tr("仓库")) as HTMLAnchorElement;
        a.href = m.repo;
        a.target = "_blank";
        a.rel = "noopener";
        acts.append(a);
      }
      const already = m.options.some((o) => installedText.includes(o.identifier));
      for (const o of m.options) acts.append(el("span", `ext-kind${o.unavailable ? " off" : ""}`, o.label));
      if (already) acts.append(el("span", "login-status ok", tr("已安装")));
      else if (this.mcpForm?.item === m.name) acts.append(this.mcpInstallForm(m));
      else {
        const usable = m.options.some((o) => !o.unavailable);
        const label = this.opLabel(`mcpadd:${m.name}`, tr("安装中…"));
        const b = el("button", "btn primary", label ?? tr("安装")) as HTMLButtonElement;
        b.disabled = ro || Boolean(label) || !usable;
        b.title = usable ? "" : m.options.map((o) => o.unavailable).filter(Boolean).join(tr("；"));
        b.onclick = () => {
          const first = Math.max(0, m.options.findIndex((o) => !o.unavailable));
          this.mcpForm = { item: m.name, name: this.slug(m), option: first, values: {}, exposure: "", description: "", local: this.extScope === "project" };
          this.paintExtIfOpen();
        };
        acts.append(b);
        if (!usable) acts.append(el("span", "settings-hint", m.options.map((o) => o.unavailable).filter(Boolean)[0] ?? ""));
      }
      row.append(acts);
      list.append(row);
    });
    host.append(list);
  }

  private slug(m: StoreMcpItem): string {
    const base = (m.name.split("/").pop() || m.title).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return base.replace(/-mcp(-server)?$/, "").replace(/^mcp-/, "") || "mcp";
  }

  /** Name, required fields (secrets become ${VAR}), scope; advanced: exposure, description. */
  private mcpInstallForm(m: StoreMcpItem): HTMLElement {
    const f = this.mcpForm!;
    const box = el("div", "ext-form");
    if (m.options.length > 1) {
      const pick = el("select", "ns-input") as HTMLSelectElement;
      m.options.forEach((o, i) => {
        const opt = new Option(tr("{p1}{p2}", { p1: o.label, p2: o.unavailable ? tr("（{p1}）", { p1: o.unavailable.split("：")[0] }) : "" }), String(i));
        opt.disabled = Boolean(o.unavailable);
        pick.append(opt);
      });
      pick.value = String(f.option);
      pick.onchange = () => {
        f.option = Number(pick.value);
        f.values = {};
        this.paintExtIfOpen();
      };
      box.append(this.formRow(tr("运行方式"), pick));
    }
    const opt = m.options[f.option];
    const name = el("input", "ns-input mono") as HTMLInputElement;
    name.value = f.name;
    name.oninput = () => (f.name = name.value.trim());
    box.append(this.formRow(tr("服务名"), name));
    const field = (key: string, fd: McpFieldView) => {
      if (fd.secret) {
        const v = key.startsWith("env:") ? fd.name : `${f.name}_${fd.name}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
        box.append(this.formRow(`${fd.name}${fd.required ? " *" : ""}`, el("span", "settings-hint", tr("密钥：mcp.json 里写成 ${{p1}}，请在系统环境变量里设置它。{p2}", { p1: v, p2: fd.description ? ` ${fd.description}` : "" }))));
        return;
      }
      const input = el("input", "ns-input mono") as HTMLInputElement;
      input.placeholder = fd.description || (fd.required ? tr("必填") : tr("可选"));
      input.value = f.values[key] ?? fd.default ?? "";
      if (input.value) f.values[key] = input.value;
      input.oninput = () => (f.values[key] = input.value);
      box.append(this.formRow(`${fd.name}${fd.required ? " *" : ""}`, input));
    };
    for (const e of opt.env) field(`env:${e.name}`, e);
    for (const h of opt.headers) field(`header:${h.name}`, h);
    if (opt.kind === "remote") box.append(this.formRow(tr("地址"), el("code", "settings-hint", opt.url ?? "")));
    else box.append(this.formRow(tr("包"), el("code", "settings-hint", `${opt.identifier}${opt.version ? ` ${opt.version}` : ""}`)));
    const adv = el("details", "ns-advanced");
    adv.append(el("summary", "", tr("高级")));
    const exp = el("select", "ns-input") as HTMLSelectElement;
    // D161: 「codemode」跟 pi 的 codemode.mode 撞名，这里其实是 MCP 的暴露方式。
    exp.append(new Option(tr("默认（deferred：模型用 searchTools 找）"), ""), new Option("deferred", "deferred"), new Option("direct", "direct"), new Option("hidden", "hidden"));
    exp.value = f.exposure;
    exp.onchange = () => (f.exposure = exp.value);
    const desc = el("input", "ns-input") as HTMLInputElement;
    desc.placeholder = tr("描述（写进系统提示词，帮模型知道它能做什么）");
    desc.value = f.description;
    desc.oninput = () => (f.description = desc.value);
    const advGrid = el("div", "ns-adv-grid");
    advGrid.append(this.formRow(tr("MCP 暴露方式"), exp), this.formRow(tr("描述"), desc));
    adv.append(advGrid);
    box.append(adv);
    const foot = el("div", "settings-foot");
    const cancel = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    cancel.onclick = () => {
      this.mcpForm = null;
      this.paintExtIfOpen();
    };
    const go = el("button", "btn primary", this.opLabel(`mcpadd:${f.item}`, tr("安装中…")) ?? tr("安装到{p1}", { p1: this.extScope === "project" ? tr("当前项目") : tr("全局") })) as HTMLButtonElement;
    go.disabled = Boolean(this.me.public) || Boolean(this.opFor(`mcpadd:${f.item}`)) || Boolean(opt.unavailable);
    go.onclick = () => {
      this.piCli(
        { type: "mcp.install", option: opt, name: f.name, values: f.values, local: this.extScope === "project", exposure: f.exposure, description: f.description },
        `mcpadd:${f.item}`,
      );
    };
    foot.append(el("span", "spacer"), cancel, go);
    box.append(foot);
    return box;
  }

  private formRow(label: string, input: HTMLElement): HTMLElement {
    const row = el("label", "settings-row");
    row.append(el("span", "settings-label", label), input);
    return row;
  }

  private paintLoginIfOpen(): void {
    if (this.sheetKind === "settings" && this.settingsTab === "login") this.paintSettings();
  }

  /** #27: pi's providers with their login methods, and the login in progress (prompts / URLs / codes). */
  private paintLogin(body: HTMLElement): void {
    if (!this.authProviders) {
      body.append(el("div", "empty", tr("读取中…")));
      this.socket.send({ type: "auth.list" });
      return;
    }
    const run = this.login;
    if (run) {
      const box = el("div", "login-run");
      box.append(el("div", "login-title", tr("登录 {p1}（{p2}）", { p1: run.provider, p2: run.method === "oauth" ? "OAuth" : "API key" })));
      for (const ev of run.events) {
        const line = el("div", "login-event");
        if (ev.type === "auth_url") {
          const a = el("a", "", ev.url) as HTMLAnchorElement;
          a.href = ev.url;
          a.target = "_blank";
          a.rel = "noopener";
          line.append(el("span", "", tr("在浏览器里打开：")), a);
          if (ev.instructions) line.append(el("div", "settings-hint", ev.instructions));
        } else if (ev.type === "device_code") {
          const a = el("a", "", ev.verificationUri) as HTMLAnchorElement;
          a.href = ev.verificationUri;
          a.target = "_blank";
          a.rel = "noopener";
          line.append(el("span", "", tr("打开 ")), a, el("span", "", tr(" 输入：")), el("code", "login-code", ev.userCode));
        } else {
          line.append(el("span", ev.type === "progress" ? "settings-hint" : "", ev.message));
          for (const l of ev.type === "info" ? (ev.links ?? []) : []) {
            const a = el("a", "", l.label ?? l.url) as HTMLAnchorElement;
            a.href = l.url;
            a.target = "_blank";
            a.rel = "noopener";
            line.append(el("span", "", " "), a);
          }
        }
        box.append(line);
      }
      const p = run.prompt;
      if (p) {
        const form = el("div", "login-prompt");
        form.append(el("div", "", p.prompt.message));
        if (p.prompt.type === "select") {
          const opts = el("div", "settings-trust-opts");
          for (const o of p.prompt.options ?? []) {
            const b = el("button", "btn", o.label) as HTMLButtonElement;
            if (o.description) b.title = o.description;
            b.onclick = () => this.answerLogin(o.id);
            opts.append(b);
          }
          form.append(opts);
        } else {
          const input = el("input", "ns-input mono") as HTMLInputElement;
          input.type = p.prompt.type === "secret" ? "password" : "text";
          input.autocomplete = "off";
          input.placeholder = p.prompt.placeholder ?? (p.prompt.type === "manual_code" ? tr("把浏览器最后跳转到的网址（或授权码）粘贴到这里") : "");
          const go = el("button", "btn primary", tr("提交")) as HTMLButtonElement;
          const submit = () => {
            if (!input.value.trim()) return;
            this.answerLogin(input.value.trim());
          };
          go.onclick = submit;
          input.onkeydown = (ev) => {
            if (ev.key === "Enter" && !ev.isComposing) submit();
          };
          const row = el("div", "info-compact");
          row.append(input, go);
          form.append(row);
          queueMicrotask(() => input.focus());
        }
        box.append(form);
      }
      if (run.result) box.append(el("div", `login-result${run.ok ? "" : " bad"}`, run.result));
      const foot = el("div", "settings-foot");
      if (!run.result) {
        const cancel = el("button", "btn ghost", tr("取消登录")) as HTMLButtonElement;
        cancel.onclick = () => {
          if (run.loginId) this.socket.send({ type: "auth.cancel", loginId: run.loginId });
        };
        foot.append(cancel);
      } else {
        const back = el("button", "btn ghost", tr("返回列表")) as HTMLButtonElement;
        back.onclick = () => {
          this.login = null;
          this.paintSettings();
        };
        foot.append(back);
      }
      box.append(foot);
      body.append(box);
      if (!run.result) return;
    }
    body.append(
      el("div", "settings-hint", tr("和终端的 /login 一样，凭据由 pi 写进 ~/.pi/agent/auth.json，网页只转达提示、不保存也不回显密钥。OAuth 的回调落在运行 bridge 的这台电脑上；在别的设备上登录时，按提示把浏览器最后跳转到的网址粘贴回来。")),
    );
    const filter = el("input", "ns-input") as HTMLInputElement;
    filter.placeholder = tr("按名字筛选 provider…");
    filter.value = this.authFilter;
    const list = el("div", "login-list");
    const paintList = () => {
      list.replaceChildren();
      const q = filter.value.trim().toLowerCase();
      for (const p of this.authProviders ?? []) {
        if (q && !p.id.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue;
        const row = el("div", `login-row${p.configured ? " on" : ""}`);
        const name = el("div", "login-name");
        name.append(el("span", "", p.name), el("span", "settings-hint", ` ${p.id}`));
        const where = p.stored ? tr("已登录（auth.json · {p1}）", { p1: p.stored === "oauth" ? "OAuth" : "API key" }) : p.configured ? tr("已配置（{p1}）", { p1: p.label ?? p.source ?? tr("环境") }) : tr("未配置");
        row.append(name, el("span", `login-status${p.configured ? " ok" : ""}`, where));
        const acts = el("div", "login-acts");
        for (const m of p.methods) {
          const b = el("button", "btn", m.type === "oauth" ? tr("OAuth 登录") : tr("填 API key")) as HTMLButtonElement;
          b.title = m.label;
          b.disabled = Boolean(this.login && !this.login.result);
          b.onclick = () => this.act(() => this.socket.send({ type: "auth.login", provider: p.id, method: m.type }));
          acts.append(b);
        }
        if (!p.methods.length) acts.append(el("span", "settings-hint", tr("只能用环境变量等方式配置")));
        if (p.stored) {
          const out = el("button", "btn ghost", tr("登出")) as HTMLButtonElement;
          out.title = tr("从 auth.json 删掉这个 provider 的凭据（不会撤销 provider 那边的授权，也不动环境变量）");
          out.onclick = () => this.act(() => this.socket.send({ type: "auth.logout", provider: p.id }));
          acts.append(out);
        }
        row.append(acts);
        list.append(row);
      }
      if (!list.childElementCount) list.append(el("div", "empty", tr("没有匹配的 provider")));
    };
    filter.oninput = () => {
      this.authFilter = filter.value;
      paintList();
    };
    paintList();
    body.append(filter, list);
  }

  private answerLogin(value: string): void {
    const run = this.login;
    const p = run?.prompt;
    if (!run?.loginId || !p) return;
    run.prompt = null;
    this.act(() => this.socket.send({ type: "auth.answer", loginId: run.loginId, promptId: p.promptId, value }));
    this.paintLoginIfOpen();
  }

  private paintChangelog(body: HTMLElement): void {
    body.append(el("div", "empty", tr("读取中…")));
    fetch("/api/changelog", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((out: { version?: string; text?: string }) => {
        if (this.settingsTab !== "changelog") return;
        body.replaceChildren();
        body.append(el("div", "settings-path", tr("当前 pi {p1}", { p1: out.version ?? "" })));
        const md = el("div", "settings-changelog");
        md.append(renderMarkdown(out.text || tr("（这个 pi 包里没有 CHANGELOG.md）")));
        body.append(md);
      })
      .catch((err: Error) => {
        body.replaceChildren(el("div", "empty", tr("读不到更新日志：{p1}", { p1: err.message })));
      });
  }

  // ---------------------------------------------------------------- tree / fork / clone (#17)
  private forkAt(target: { entryId: string; index?: number; text?: string }): void {
    const sessionId = this.currentId;
    if (!sessionId || this.branching) return;
    this.act(() => {
      this.branching = true;
      this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: tr("正在分叉（pi 在写新的会话文件）…"), level: "info" });
      this.socket.send({ type: "fork", sessionId, ...target });
    });
  }

  private cloneSession(): void {
    const sessionId = this.currentId;
    if (!sessionId || this.branching) return;
    this.act(() => {
      this.branching = true;
      this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: tr("正在复制当前分支为新会话…"), level: "info" });
      this.socket.send({ type: "clone", sessionId });
    });
  }

  /** The session's user messages as a tree; every one is a fork point (#17). */
  private openTreeSheet(): void {
    if (!this.currentId) return;
    this.closeSheet();
    this.sheetKind = "tree";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet tree-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("会话树")));
    const clone = el("button", "btn ghost", tr("复制当前分支")) as HTMLButtonElement;
    clone.title = tr("把当前这条分支整个复制成一个新会话（/clone）");
    clone.onclick = () => this.cloneSession();
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(clone, close);
    const body = el("div", "tree-body", tr("读取中…"));
    sheet.append(head, body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    this.socket.send({ type: "tree", sessionId: this.currentId });
  }

  private fillTreeSheet(nodes: { id: string; parent: string | null; text: string; ts: string | null; current: boolean }[], truncated: boolean): void {
    const body = this.sheet?.querySelector(".tree-body");
    if (!body) return;
    body.replaceChildren();
    if (!nodes.length) {
      body.append(el("div", "empty", tr("这个会话还没有写到磁盘的消息。")));
      return;
    }
    body.append(
      el(
        "div",
        "tree-hint",
        tr("每条是你发过的一条消息，缩进表示分支。⑂ = 从这条消息之前分叉成新会话（消息放回输入框）；● = pi 会接着走的那条分支。终端里 /tree 切到的分支，要在终端里继续，或者分叉出来。"),
      ),
    );
    if (truncated) body.append(el("div", "tree-hint warn", tr("会话文件太大，只读了后半段：更早的分支没有画出来。")));
    const kids = new Map<string | null, typeof nodes>();
    for (const n of nodes) {
      const key = n.parent && nodes.some((m) => m.id === n.parent) ? n.parent : null;
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key)!.push(n);
    }
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        const row = el("div", `tree-row${n.current ? " current" : ""}`);
        row.style.paddingLeft = `${8 + Math.min(depth, 12) * 16}px`;
        row.append(el("span", "tree-dot", n.current ? "●" : "○"), el("span", "tree-text", n.text));
        const when = n.ts ? new Date(n.ts) : null;
        if (when && !Number.isNaN(when.getTime())) row.append(el("span", "tree-ts", `${fmtDate(when)} ${fmtTime(when)}`));
        const fork = el("button", "tool-btn", tr("⑂ 分叉")) as HTMLButtonElement;
        fork.title = tr("从这条消息之前分叉成新会话，消息放回输入框");
        fork.onclick = () => this.forkAt({ entryId: n.id, text: n.text });
        row.append(fork);
        row.title = n.text;
        body.append(row);
        // Indent only where the path splits: a straight chain stays flat.
        walk(n.id, (kids.get(n.id)?.length ?? 0) > 1 ? depth + 1 : depth);
      }
    };
    walk(null, 0);
  }

  // ---------------------------------------------------------------- inline completion (#25)
  /** Look at the text left of the caret and open / refresh / close the suggestion list. */
  private updateComplete(): void {
    const field = this.textarea;
    if (!field || !this.currentId) return this.closeComplete();
    const text = field.value;
    const caret = field.selectionStart ?? text.length;
    if (caret !== (field.selectionEnd ?? caret)) return this.closeComplete();
    const before = text.slice(0, caret);
    const tokenEnd = (from: number) => {
      const m = /^[^\s]*/.exec(text.slice(from));
      return from + (m ? m[0].length : 0);
    };
    const cmd = /^\/([^\s]*)$/.exec(before);
    if (cmd) {
      const query = cmd[1];
      if (!this.piCommands || this.piCommands.sessionId !== this.currentId || Date.now() - this.piCommands.at > 60_000) {
        this.piCommands = { sessionId: this.currentId, at: Date.now(), list: this.piCommands?.sessionId === this.currentId ? this.piCommands.list : [] };
        this.socket.send({ type: "commands", sessionId: this.currentId, cwd: this.session?.cwd });
      }
      this.showComplete("cmd", 0, tokenEnd(caret), query, this.commandItems(query));
      return;
    }
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const query = at[1];
      const start = caret - query.length - 1;
      const end = tokenEnd(caret);
      const seq = ++this.fileQuerySeq;
      const sessionId = this.currentId;
      // Keep the old rows while the next answer is on its way: no flicker per keystroke.
      if (!this.complete || this.complete.mode !== "file") this.showComplete("file", start, end, query, []);
      else Object.assign(this.complete, { start, end, query });
      fetch(`/api/files?id=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`, { credentials: "same-origin" })
        .then((r) => r.json())
        .then((out: { files?: string[] }) => {
          if (seq !== this.fileQuerySeq || this.complete?.mode !== "file" || this.currentId !== sessionId) return;
          const items = (out.files ?? []).map((f) => ({ insert: `@${f} `, label: f, tag: tr("文件") }));
          this.showComplete("file", start, end, query, items);
        })
        .catch(() => {
          /* no list is fine: the user keeps typing */
        });
      return;
    }
    this.closeComplete();
  }

  /** Built-in commands the page runs itself, then pi's own (extension / template / skill). */
  private commandItems(query: string): CommandItem[] {
    const all: CommandItem[] = BUILTIN_COMMANDS.map(([name, desc]) => ({ insert: `/${name} `, label: `/${name}`, desc, tag: tr("内建") }));
    const tagOf: Record<string, string> = { extension: tr("扩展"), prompt: tr("模板"), skill: tr("技能") };
    for (const c of this.piCommands?.list ?? []) {
      if (all.some((x) => x.label === `/${c.name}`)) continue;
      all.push({ insert: `/${c.name} `, label: `/${c.name}`, desc: c.description, tag: tagOf[c.source] ?? c.source });
    }
    return filterCommands(all, query);
  }

  private showComplete(mode: "cmd" | "file", start: number, end: number, query: string, items: CommandItem[]): void {
    let node = this.complete?.node;
    if (!node || !node.isConnected) {
      node = el("div", "complete-pop");
      const row = this.els.composerHost.querySelector(".row");
      if (row) this.els.composerHost.insertBefore(node, row);
      else this.els.composerHost.append(node);
    }
    const sel = this.complete && this.complete.mode === mode ? Math.min(this.complete.sel, Math.max(0, items.length - 1)) : 0;
    this.complete = { mode, start, end, query, items, sel, node };
    this.paintComplete();
  }

  private paintComplete(): void {
    const c = this.complete;
    if (!c) return;
    c.node.replaceChildren();
    if (!c.items.length) {
      c.node.append(el("div", "complete-empty", c.mode === "file" ? (c.query ? tr("找不到「{p1}」", { p1: c.query }) : tr("输入文件名的一部分…")) : tr("没有匹配的命令")));
      return;
    }
    c.items.forEach((item, i) => {
      const row = el("button", `complete-row${i === c.sel ? " on" : ""}`) as HTMLButtonElement;
      row.type = "button";
      row.append(el("span", "complete-label", item.label));
      if (item.tag) row.append(el("span", "complete-tag", item.tag));
      if (item.desc) row.append(el("span", "complete-desc", item.desc));
      row.onmousedown = (ev) => ev.preventDefault(); // keep the caret in the textarea
      row.onclick = () => this.pickComplete(i);
      c.node.append(row);
    });
    c.node.querySelector(".complete-row.on")?.scrollIntoView({ block: "nearest" });
  }

  /** Arrow keys / Enter / Tab / Esc while the list is open. Returns true when it took the key. */
  private completeKey(ev: KeyboardEvent): boolean {
    const c = this.complete;
    if (!c || ev.isComposing) return false;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      this.closeComplete();
      return true;
    }
    if (!c.items.length) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      c.sel = (c.sel + (ev.key === "ArrowDown" ? 1 : -1) + c.items.length) % c.items.length;
      this.paintComplete();
      return true;
    }
    if ((ev.key === "Enter" && !ev.shiftKey && !ev.altKey) || ev.key === "Tab") {
      // Already typed out in full: Enter sends instead of completing to the same text.
      const typed = this.textarea?.value.slice(c.start, c.end).trim() ?? "";
      if (ev.key === "Enter" && typed === c.items[c.sel]?.insert.trim()) {
        this.closeComplete();
        return false;
      }
      ev.preventDefault();
      this.pickComplete(c.sel);
      return true;
    }
    return false;
  }

  private pickComplete(index: number): void {
    const c = this.complete;
    const field = this.textarea;
    if (!c || !field) return;
    const item = c.items[index];
    if (!item) return;
    const text = field.value;
    const next = `${text.slice(0, c.start)}${item.insert}${text.slice(c.end).replace(/^ /, "")}`;
    const caret = c.start + item.insert.length;
    this.closeComplete();
    field.value = next;
    this.composerText = next;
    this.noteDraft();
    field.focus();
    field.setSelectionRange(caret, caret);
    this.fitComposer();
  }

  private closeComplete(): void {
    this.complete?.node.remove();
    this.complete = null;
  }

  /** What pi has queued for after the current step / run, with a way to take it back (#14). */
  private fillQueueBar(): void {
    const bar = this.queueBar;
    if (!bar) return;
    const rows = [
      ...this.queue.steering.map((text) => ({ text, kind: "steer" as const })),
      ...this.queue.followUp.map((text) => ({ text, kind: "followUp" as const })),
    ];
    bar.replaceChildren();
    bar.hidden = !rows.length;
    if (!rows.length) return;
    const head = el("div", "queue-head");
    head.append(el("span", "queue-title", tr("排队中 {p1} 条", { p1: rows.length })));
    const back = el("button", "tool-btn", tr("撤回到输入框")) as HTMLButtonElement;
    back.type = "button";
    back.title = tr("从 pi 的队列里拿回来，放回输入框（终端里的 Alt+↑）");
    back.onclick = () => this.act(() => this.socket.send({ type: "clearQueue", sessionId: this.currentId }));
    head.append(back);
    bar.append(head);
    for (const row of rows) {
      const line = el("div", `queue-item ${row.kind}`);
      const tag = el("span", "queue-tag", row.kind === "steer" ? tr("引导") : tr("之后"));
      tag.title = row.kind === "steer" ? tr("当前这步工具跑完、下一次调用模型前插入") : tr("整轮做完以后再处理");
      line.append(tag, el("span", "queue-text", row.text.replace(/\s+/g, " ")));
      line.title = row.text;
      bar.append(line);
    }
  }

  /** Extension widgets above / below the editor, status lines below, title on the browser tab. */
  private fillExt(): void {
    const ext = this.currentId ? this.ext : { status: [], widgets: [], title: null };
    document.title = ext.title ? `${ext.title} · pi` : "pi";
    const block = (lines: string[], cls: string, title: string) => {
      const node = el("pre", cls, lines.join("\n"));
      node.title = title;
      return node;
    };
    if (this.extAbove) {
      this.extAbove.replaceChildren(
        ...ext.widgets.filter((w) => w.placement === "aboveEditor" && w.lines.length).map((w) => block(w.lines, "ext-widget", tr("扩展小部件：{p1}", { p1: w.key }))),
      );
    }
    if (this.extBelow) {
      const nodes: HTMLElement[] = ext.widgets
        .filter((w) => w.placement === "belowEditor" && w.lines.length)
        .map((w) => block(w.lines, "ext-widget", tr("扩展小部件：{p1}", { p1: w.key })));
      if (ext.status.length) {
        const line = el("div", "ext-status");
        for (const st of ext.status) {
          const chip = el("span", "ext-status-item", st.text);
          chip.title = tr("扩展状态：{p1}", { p1: st.key });
          line.append(chip);
        }
        nodes.push(line);
      }
      this.extBelow.replaceChildren(...nodes);
    }
  }

  // ---------------------------------------------------------------- continue (D159)
  /**
   * 「继续」：把字面这两个字当成下一条用户消息发出去。pi 的 RPC 没有 continue 命令（`rpc-mode.js`
   * 的 case 表里只有 prompt / steer / follow_up / abort / compact …），所以「接着干」在协议上
   * 就是一句话。它坐在权限按钮正上方那 28.5px 里，代价是整行多 3.5px，而不是多一块。
   */
  private continueButton(): HTMLButtonElement {
    const btn = el("button", "continue-btn") as HTMLButtonElement;
    btn.type = "button";
    btn.textContent = tr("继续");
    btn.onclick = (ev) => {
      ev.stopPropagation();
      this.sendContinue();
    };
    this.continueBtn = btn;
    this.syncContinueButton();
    return btn;
  }

  /** 藏 / 灰 / 亮全部走 `continueState()`（web/src/continue-state.ts），这里只写提示。 */
  private syncContinueButton(): void {
    const btn = this.continueBtn;
    if (!btn) return;
    const s = this.session;
    const state = continueState(s, this.chat.hasUserTurns());
    // 先置灰再藏：`hidden` 一旦失效（漏了 [hidden] 那条 display 规则），按钮至少还点不动。
    btn.disabled = state !== "ready";
    btn.hidden = state === "hidden";
    if (state === "hidden") return;
    const why =
      state === "ready"
        ? ""
        : s?.starting
          ? tr("pi 正在启动，起来之后再继续")
          : s?.running
            ? tr("pi 正在跑这一轮，停下之后再继续")
            : bgBusy(s)
              ? tr("子代理还在后台跑，pi 会在它回来时接着做")
              : tr("这条会话还没有说过话，没有可继续的");
    btn.title = why || tr("把「继续」发给 pi —— 草稿留在输入框里，不会被动到");
  }

  /**
   * D170: 输入框上方那条「子代理运行中」。会话自己 settle 之后，pi 再也不会发 `running: true`，
   * 这条提示就是页面上唯一能看出「它还在后台干活」的地方（左栏同时有一枚「后台」徽标）。
   *
   * 不读 runner 的痕迹文件：桥只把「开始」与「结束」两件事折成 `state.bg` 推过来，秒数在这里滴答（
   * `startClock()`），所以不用轮询也不用整块重画。
   */
  private syncBgBar(): void {
    const bg = this.session?.bg;
    const live = bgBusy(this.session) ? bg : null;
    // 跑完的那一档还要留几分钟：不然「最终输出」只有在弹层恰好开着时才看得到（D170 评审）。
    const done = !live && bg && (bg.recent ?? 0) > 0 ? bg : null;
    if (!live && !done) {
      this.bgBar?.remove();
      this.bgBar = null;
      return;
    }
    if (!this.bgBar || !this.bgBar.isConnected) {
      const bar = el("div", "bg-bar");
      // 时间贴着文字走，不推到最右边：`总结本轮错误` 那颗浮动贴在输入框右上，推过去会被它压住。
      bar.append(el("span", "bg-dot"), el("span", "bg-text"), el("span", "bg-sep", "·"), el("span", "bg-elapsed"));
      // D170：整条都能点开详情。用 role=button 而不是 <button>：里面已经有文字与计时，语义上是一个入口。
      bar.setAttribute("role", "button");
      bar.tabIndex = 0;
      bar.onclick = () => this.openBgSheet();
      bar.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        this.openBgSheet();
      };
      const row = this.els.composerHost.querySelector(".row");
      this.els.composerHost.insertBefore(bar, row);
      this.bgBar = bar;
    }
    const bar = this.bgBar;
    bar.classList.toggle("idle", !live);
    bar.title = live
      ? tr("点开看它在干什么；pi 会在它回来时自己接着做，这时点「继续」等于插队多推一轮。")
      : tr("点开看它的过程与结果；pi 已经接着做完了。");
    const text = bar.querySelector(".bg-text") as HTMLElement | null;
    const since = bar.querySelector(".bg-elapsed") as HTMLElement | null;
    if (live && text && since) {
      text.textContent =
        live.n > 1
          ? tr("{p1} 个子代理运行中", { p1: live.n })
          : live.agent
            ? tr("子代理运行中 · {p1}", { p1: live.agent })
            : tr("子代理运行中");
      since.dataset.bgSince = String(live.since ?? Date.now());
      since.textContent = bgElapsedText(live.since ?? Date.now());
    } else if (done && text && since) {
      text.textContent = done.agent ? tr("子代理已结束 · {p1}", { p1: done.agent }) : tr("子代理已结束");
      // 不再滴答：秒数从「开始」到「结束」，由 `bgTookText` 一次性写死。
      delete since.dataset.bgSince;
      since.textContent = bgTookText(done.lastMs ?? 0);
    }
  }

  /**
   * D170 详情：这条提示条背后到底在跑什么。概览（agent / 任务 / 状态 / 用时）+ 过程（runner 自己
   * 写的活动记录尾巴，1.5 秒一刷）+ 跑完之后的最终输出。桥只读 `%TEMP%\acp-delegate\` 里的痕迹，
   * 读不到（还没写、已被删、公网只读）就少一段，不当错误报。
   */
  private openBgSheet(sessionId?: string): void {
    const sid = sessionId ?? this.currentId;
    if (!sid) return;
    this.closeSheet();
    this.sheetKind = "bg";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet bg-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("后台子代理")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const body = el("div", "bg-sheet-body");
    sheet.append(head, body);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    this.bgSheet = { sessionId: sid, body, runs: new Map() };
    const tick = () => {
      if (!this.bgSheet || this.bgSheet.sessionId !== sid) return;
      this.socket.send({ type: "bg.list", sessionId: sid });
    };
    tick();
    this.bgTimer = window.setInterval(tick, 1500);
  }

  /** `bg.list` 回来：按 runId 建/收卡片，再各自要一次日志尾（内容没变就不动 DOM）。 */
  private paintBgSheet(runs: BgRunDto[], error = ""): void {
    const sheet = this.bgSheet;
    if (!sheet) return;
    const keep = new Set(runs.map((r) => r.id));
    for (const [id, node] of sheet.runs) {
      if (keep.has(id)) continue;
      node.root.remove();
      sheet.runs.delete(id);
    }
    sheet.body.querySelector(".bg-empty")?.remove();
    if (!runs.length) {
      // `error` 只会在公网那只手上出现（桥不把任务原话发出去）；本地就是真的没有。
      sheet.body.append(el("div", "bg-empty", error || tr("这个会话没有在跑的后台子代理。")));
      return;
    }
    for (const r of runs) {
      let node = sheet.runs.get(r.id);
      if (!node) {
        const root = el("div", "bg-run");
        const line = el("div", "bg-run-head");
        line.append(el("span", "bg-run-agent", r.agent || tr("子代理")), el("span", "bg-run-state"));
        const task = el("div", "bg-run-task", r.task || tr("（任务原文没传到桥）"));
        const id = el("div", "bg-run-id", r.id);
        const labLog = el("div", "bg-run-lab", tr("过程"));
        const logEl = el("pre", "bg-run-log");
        const labOut = el("div", "bg-run-lab", tr("最终输出"));
        labOut.hidden = true;
        const outEl = el("pre", "bg-run-out");
        outEl.hidden = true;
        root.append(line, task, id, labLog, logEl, labOut, outEl);
        sheet.body.append(root);
        node = { root, state: line.lastElementChild as HTMLElement, log: logEl, out: outEl, labOut, hasLog: Boolean(r.hasLog) };
        if (!r.hasLog) logEl.textContent = tr("桥还没接上这个 runner 的过程记录。");
        sheet.runs.set(r.id, node);
      }
      const state = r.state === "running" ? tr("运行中") : r.state === "failed" ? tr("失败") : tr("已完成");
      // 跑完了报总耗时（结束 − 开始）；还在跑就报「已跑多久」，两者都是「从开始起的钟」。
      node.state.textContent =
        r.state === "running"
          ? `${state} · ${bgElapsedText(r.startedAt)}`
          : `${state} · ${bgTookText(Math.max(0, (r.endedAt ?? Date.now()) - r.startedAt))}`;
      this.socket.send({ type: "bg.log", sessionId: sheet.sessionId, runId: r.id });
    }
  }

  /** `bg.log` 回来：只换文字，不回滚用户正在读的位置（贴底时才跟到底）。 */
  private fillBgRun(runId: string, log: unknown, out: unknown): void {
    const node = this.bgSheet?.runs.get(runId);
    if (!node) return;
    const text = typeof log === "string" ? log : "";
    if (node.log.textContent !== text) {
      const stick = node.log.scrollHeight - node.log.scrollTop - node.log.clientHeight < 24;
      node.log.textContent = text || (node.hasLog ? tr("还没有活动记录。") : tr("桥还没接上这个 runner 的过程记录。"));
      if (stick) node.log.scrollTop = node.log.scrollHeight;
    }
    const done = typeof out === "string" && out.length > 0;
    node.labOut.hidden = !done;
    node.out.hidden = !done;
    if (done && node.out.textContent !== out) node.out.textContent = out;
  }

  /**
   * 发「继续」。**不清草稿**：它跟 Enter 不同 —— 这是「接着刚才那件事」，不是「把我写的发出去」。
   * 乐观气泡照 `sendPrompt()` 带 `clientId`，桥回灌时这一页认自己那条（#19）。
   */
  private sendContinue(): void {
    const id = this.currentId;
    if (!id || continueState(this.session, this.chat.hasUserTurns()) !== "ready") return;
    // 连点保护：`pi.status(running)` 回来之前按钮还亮着，按会话只认第一次。
    const now = Date.now();
    if (this.continueAt.id === id && now - this.continueAt.at < CONTINUE_GUARD_MS) return;
    this.continueAt = { id, at: now };
    // 字面「继续」就发这两个字（用户定的），不做 i18n：模型读到的东西不该跟着界面语言变。
    const text = CONTINUE_TEXT;
    const clientId = `local:${now}:${Math.random().toString(36).slice(2, 8)}`;
    // 重画会重建 textarea，草稿文字会从 `composerText` 填回去，但光标位置和焦点不会 —— 收回来。
    const caret = this.textarea?.selectionStart ?? null;
    this.act(() => {
      if (this.currentId === id) {
        this.chat.add({ id: clientId, kind: "user", text, images: [], ts: new Date().toISOString() });
        this.renderChat();
        const ta = this.textarea;
        if (ta && caret != null) {
          ta.focus();
          ta.setSelectionRange(caret, caret);
        }
      }
      this.socket.send({ type: "prompt", sessionId: id, text, images: [], clientId, behavior: "steer" });
    });
  }

  // ---------------------------------------------------------------- permission mode
  private permissionButton(): HTMLElement {
    const mode = this.session?.permission ?? "ask";
    const meta = permMode(mode);
    const btn = el("button", `perm-btn perm-${mode}`) as HTMLButtonElement;
    btn.append(el("span", "perm-ico", meta.icon), el("span", "perm-label", meta.label), el("span", "perm-caret", "▾"));
    btn.title = tr("权限模式：{p1}——{p2}", { p1: meta.label, p2: meta.desc });
    btn.onclick = (ev) => {
      ev.stopPropagation();
      this.togglePermissionMenu(btn);
    };
    return btn;
  }

  private togglePermissionMenu(anchor: HTMLElement): void {
    const open = document.querySelector(".perm-menu");
    if (open) {
      open.remove();
      return;
    }
    const sessionId = this.currentId;
    if (!sessionId) return;
    const current = this.session?.permission ?? "ask";
    const menu = el("div", "perm-menu");
    menu.append(el("div", "perm-menu-title", tr("工具权限（只对这个会话）")));
    const close = (): void => {
      menu.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const outside = (ev: Event): void => {
      if (!menu.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        close();
      }
    };
    for (const m of PERM_MODES) {
      const row = el("button", `perm-opt perm-${m.id}${m.id === current ? " on" : ""}`);
      row.append(el("span", "perm-ico", m.icon), el("span", "perm-name", m.label), el("span", "perm-check", m.id === current ? "✓" : ""), el("span", "perm-desc", m.desc));
      row.onclick = () => {
        close();
        if (m.id === current) return;
        this.act(() => {
          this.socket.send({ type: "setPermission", sessionId, mode: m.id });
          if (this.session?.id === sessionId) {
            this.session = { ...this.session, permission: m.id };
            this.renderChat();
          }
        });
      };
      menu.append(row);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    document.body.append(menu);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
  }

  private warn(text: string): void {
    this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text, level: "warn" });
  }

  /** Auto-height for the main composer textarea. */
  private fitComposer(): void {
    const input = this.textarea;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
  }

  /** Long pastes live in their own foldable box above what the user types next. */
  private renderPastes(): void {
    const host = this.pasteHost;
    if (!host) return;
    host.replaceChildren();
    host.hidden = !this.pastes.length;
    host.parentElement?.classList.toggle("has-pastes", this.pastes.length > 0);
    this.pastes.forEach((p, index) => {
      const block = el("div", `paste-block${p.open ? " open" : ""}`);
      const head = el("div", "paste-head");
      const toggle = el("button", "paste-toggle") as HTMLButtonElement;
      toggle.type = "button";
      const lines = p.text.split("\n").length;
      toggle.append(
        el("span", "chev", p.open ? "▾" : "▸"),
        el("span", "paste-title", tr("粘贴的内容{p1}", { p1: this.pastes.length > 1 ? ` #${index + 1}` : "" })),
        el("span", "paste-meta", tr("{p1} 行 · {p2} 字", { p1: lines, p2: p.text.length })),
        el("span", "paste-peek", p.open ? "" : p.text.replace(/\s+/g, " ").trim().slice(0, 80)),
      );
      toggle.title = p.open ? tr("收起") : tr("展开查看 / 编辑");
      toggle.onclick = () => {
        p.open = !p.open;
        this.renderPastes();
      };
      const drop = el("button", "paste-x", "×") as HTMLButtonElement;
      drop.type = "button";
      drop.title = tr("删掉这段粘贴的内容");
      drop.onclick = () => {
        this.pastes.splice(index, 1);
        this.noteDraft();
        this.renderPastes();
        this.textarea?.focus();
      };
      head.append(toggle, drop);
      block.append(head);
      if (p.open) {
        const body = el("textarea", "paste-body") as HTMLTextAreaElement;
        body.value = p.text;
        body.spellcheck = false;
        body.oninput = () => {
          p.text = body.value;
          this.noteDraft();
          const meta = head.querySelector(".paste-meta");
          if (meta) meta.textContent = tr("{p1} 行 · {p2} 字", { p1: p.text.split("\n").length, p2: p.text.length });
        };
        block.append(body);
      }
      host.append(block);
    });
  }

  private async addImages(files: FileList | readonly File[] | null): Promise<void> {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    for (const file of list) {
      const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
      const bitmap = isSvg ? await rasterizeSvg(file) : await createImageBitmap(file).catch(() => null);
      if (isSvg && !bitmap) {
        this.warn(tr("SVG「{p1}」渲染失败，没有附加", { p1: file.name }));
        continue;
      }
      const data = await downscale(file, bitmap);
      this.images.push(data);
    }
    this.updateImageBadge();
    this.imageSheetPaint?.();
  }

  /** Put file paths into the composer at the caret, the way a terminal paste of a copied file does. */
  private insertPaths(paths: string[]): void {
    if (!paths.length) return;
    const input = this.textarea;
    const value = input ? input.value : this.composerText;
    const start = input ? input.selectionStart : value.length;
    const end = input ? input.selectionEnd : value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    const chunk = `${pad}${paths.join(" ")}${tail}`;
    this.composerText = before + chunk + after;
    this.noteDraft();
    if (input) {
      input.value = this.composerText;
      const caret = start + chunk.length;
      input.focus();
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event("input"));
    }
  }

  /** A pasted non-image file only carries its name: ask the bridge for the real path on this machine. */
  private async pastePaths(names: string[]): Promise<void> {
    const fallback = tr("用「文件」按钮选，或在资源管理器里 Shift+右键 →「复制为路径」后再粘贴");
    if (this.me.public) {
      this.warn(tr("通过公网访问时拿不到「{p1}」的路径。{p2}", { p1: names.join(tr("、")), p2: fallback }));
      return;
    }
    let paths: string[] = [];
    try {
      paths = (await api.clipboardFiles()).paths;
    } catch (ex: any) {
      this.warn(tr("{p1}。{p2}", { p1: ex?.message ?? ex, p2: fallback }));
      return;
    }
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const hits = paths.filter((p) => wanted.has((p.split(/[\\/]/).pop() ?? "").toLowerCase()));
    if (!hits.length) {
      this.warn(tr("剪贴板里找不到「{p1}」的路径（复制的文件不在这台电脑上？）。{p2}", { p1: names.join(tr("、")), p2: fallback }));
      return;
    }
    this.insertPaths(hits);
  }

  /** Browse this machine (where pi runs) and insert the chosen file's absolute path. */
  private openFilePicker(): void {
    this.closeSheet();
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet file-picker");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("选择文件 · 图片直接附加，其他插入路径")));
    // The list browses the machine pi runs on; a phone needs its own gallery for photos.
    const deviceInput = el("input") as HTMLInputElement;
    deviceInput.type = "file";
    deviceInput.accept = "image/*";
    deviceInput.multiple = true;
    deviceInput.style.display = "none";
    deviceInput.onchange = () => {
      const files = Array.from(deviceInput.files ?? []);
      this.closeSheet();
      void this.addImages(files);
    };
    const device = el("button", "btn ghost", tr("从本设备选图片"));
    device.title = tr("从当前浏览器所在的设备（例如手机相册）选图片附加");
    device.onclick = () => deviceInput.click();
    head.append(deviceInput, device);
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    const host = el("div", "file-picker-body");
    sheet.append(head, host);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;

    const home = this.dirHome(() => this.session?.cwd ?? "");
    // D163: 这个弹层按会话记着上次浏览到哪儿；pick 走闭包，所以要等 picker 建好再接上。
    let pickerPath = (): string => "";
    const ref = this.dirRef(() => pickerPath());
    // D167: 附件弹层也能就地建 —— 建完停在原地、高亮新行，点它才算附加。
    const mk = this.mkControls({
      parent: () => pickerPath(),
      made: (abs) => this.revealMade(picker, abs),
    });
    // 第一次落到一个能读的目录才算数：之后再出错（目录被删、盘拔了）不再自动把人拽走。
    let landed = false;
    const picker = mountDirPicker(host, {
      start: this.attachStart(),
      files: true,
      fallback: true,
      head: [home.node, ref.node, mk.dirBtn, mk.fileBtn],
      beforeList: [mk.row],
      // 和文件管理器同一套「输入路径就跳」：附件也常常已经在手上了（终端里复制来的）。
      pathBox: true,
      onState: (state) => {
        mk.sync(state);
        ref.bind();
        if (state.path) {
          landed = true;
          this.rememberAttachDir(state.path);
          return;
        }
        // 盘符页：记忆的目录没了（worktree 被删、换了机器）就直接落到这里了，错过 cwd 那一级。
        // 补一次 cwd 再任由用户挑盘；cwd 也读不了时 landed 已经立住，不会再绕。
        const cwd = (this.session?.cwd ?? "").trim();
        if (!landed && !state.error && cwd) {
          landed = true;
          void picker.go(cwd);
        }
      },
      onPick: (abs, name, row) => {
        // 图片直接附加成待发图片；其他文件只把路径插进输入框（pi 自己去读）。
        if (!ATTACH_IMAGE.test(name)) {
          this.closeSheet();
          this.insertPaths([abs]);
          return;
        }
        row.disabled = true;
        row.classList.add("busy");
        void api
          .image(abs)
          .then(async (file) => {
            await this.addImages([file]);
            if (this.sheet === back) this.closeSheet();
          })
          .catch((ex: any) => {
            row.disabled = false;
            row.classList.remove("busy");
            this.warn(tr("附加图片失败：{p1}", { p1: ex?.message ?? ex }));
          });
      },
    });
    pickerPath = () => picker.path();
    home.bind(picker);
    ref.bind();
    host.querySelector<HTMLInputElement>(".dir-filter")?.focus();
  }

  /** 待发图片的入口：点一下看缩略图、单张删。 */
  private pendingImagesBadge(): HTMLButtonElement {
    const badge = el("button", "badge image-badge", tr("+{p1} 图", { p1: this.images.length })) as HTMLButtonElement;
    badge.type = "button";
    badge.title = tr("查看 / 删除待发图片");
    badge.onclick = () => this.openImageSheet();
    return badge;
  }

  /** 不改文字、不重建输入框，只换徽标文字：贴图、删图都走这里。 */
  private updateImageBadge(): void {
    if (!this.images.length) {
      this.imageBadge?.remove();
      this.imageBadge = null;
      return;
    }
    if (this.imageBadge) {
      this.imageBadge.textContent = tr("+{p1} 图", { p1: this.images.length });
      return;
    }
    const row = this.els.composerHost.querySelector(".row");
    if (!row) return;
    const badge = this.pendingImagesBadge();
    row.append(badge);
    this.imageBadge = badge;
  }

  private openImageSheet(): void {
    if (!this.images.length) return;
    this.closeSheet();
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };

    const sheet = el("div", "sheet image-sheet");
    const head = el("div", "sheet-head");
    const title = el("div", "sheet-title", "");
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(title, close);

    const grid = el("div", "image-grid");
    const foot = el("div", "sheet-foot");
    const clear = el("button", "btn danger", tr("全部清空"));
    clear.onclick = () => {
      this.images = [];
      this.updateImageBadge();
      this.closeSheet();
    };
    foot.append(clear);
    sheet.append(head, grid, foot);

    const paint = () => {
      if (!this.images.length) {
        this.closeSheet();
        return;
      }
      title.textContent = tr("待发图片 {p1} 张", { p1: this.images.length });
      grid.replaceChildren();
      this.images.forEach((image, index) => {
        const tile = el("div", "image-tile");
        const thumb = el("img", "image-thumb") as HTMLImageElement;
        thumb.src = `data:${image.mimeType};base64,${image.data}`;
        thumb.alt = tr("待发图片 {p1}", { p1: index + 1 });
        // 序号常驻：删掉一张后重新编号，跟在输入框里写「第 2 张」对得上。
        const no = el("span", "image-no", String(index + 1));
        tile.append(no);
        const drop = el("button", "image-x", "×") as HTMLButtonElement;
        drop.type = "button";
        drop.title = tr("删掉这张");
        drop.setAttribute("aria-label", tr("删掉第 {p1} 张图片", { p1: index + 1 }));
        drop.onclick = () => {
          this.images.splice(index, 1);
          this.updateImageBadge();
          paint();
        };
        tile.append(thumb, drop);
        grid.append(tile);
      });
    };
    this.imageSheetPaint = paint;

    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    paint();
  }

  /**
   * 粘贴处理（Ctrl+V / ⌘V）。只接管剪贴板里带文件（截图、复制的文件）的情况：
   * - 图片 → 和以前一样作为图片附上；
   * - 其它文件 → 像终端那样把完整路径插进输入框（路径由 bridge 读本机剪贴板得到）；
   * - 带文字时文字照常插入；纯文字完全不管，交给浏览器原样处理。
   * 焦点在别的输入框（重命名、口令框）或弹窗里时不抢。
   */
  private onPaste(ev: ClipboardEvent): void {
    if (!this.currentId || document.querySelector(".modal")) return;
    const target = ev.target as HTMLElement | null;
    const targetTag = target?.tagName ?? "";
    const editable = targetTag === "INPUT" || targetTag === "TEXTAREA" || Boolean(target?.isContentEditable);
    if (editable && target !== this.textarea) return;
    const files = pastedFilesFrom(ev.clipboardData);
    if (!files.length) return;
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) ev.preventDefault();
    const { images, others } = splitImages(files);
    if (images.length) void this.addImages(images);
    if (others.length) void this.pastePaths(others.map((f) => f.name));
  }

  private renderApprovals(): void {
    const existing = this.els.composerHost.querySelector(".approval-slot");
    existing?.remove();
    if (!this.approvals.length) return;
    const slot = el("div", "approval-slot");
    for (const a of this.approvals) slot.append(this.approvalCard(a));
    const hintIndex = this.els.composerHost.querySelector(".hint");
    if (hintIndex) this.els.composerHost.insertBefore(slot, hintIndex);
    else this.els.composerHost.append(slot);
    this.renderTop();
  }

  // ---------------------------------------------------------------- asks
  /**
   * The question lives in the composer, not in a modal: options sit right above the textarea,
   * typing in the textarea answers it, and the user can wander off to other sessions and come
   * back (the bridge re-sends pending asks on subscribe). Nothing pops up on its own.
   */
  /**
   * 输入框的占位文案：pi 还在启动的时候，「Enter 发送」是错的提示 —— 那时发送会被拦下来。
   * 所有写 placeholder 的地方都走这里，别再直接调 composerPlaceholder()。
   */
  private composerHintText(): string {
    return this.session?.starting ? tr("pi 正在启动…") : this.composerPlaceholder();
  }

  private composerPlaceholder(): string {
    if (this.asks.length) return ASK_PLACEHOLDER;
    return this.session?.running ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER;
  }

  private renderAsks(): void {
    const host = this.els.composerHost;
    host.querySelector(".ask-slot")?.remove();
    this.fillHintStatus();
    if (this.textarea) this.textarea.placeholder = this.composerHintText();
    if (this.askLost && !this.asks.length) {
      const lost = this.askLostBlock();
      const row = host.querySelector(".row");
      if (row) host.insertBefore(lost, row);
      else host.append(lost);
    }
    const ask = this.asks[0];
    if (!ask || !this.currentId) return;
    const st = this.askState(ask);
    const total = ask.questions.length;
    const q = ask.questions[st.active];

    const slot = el("div", "ask-slot");
    const head = el("div", "ask-head");
    const more = this.asks.length > 1 ? tr("（还有 {p1} 份）", { p1: this.asks.length - 1 }) : "";
    head.append(el("span", "t", tr("{p1}{p2}", { p1: total > 1 ? tr("需要你回答 · {p1} 题", { p1: total }) : tr("需要你回答"), p2: more })));
    if (this.askFolded) head.append(el("span", "m", q.prompt.split("\n")[0].slice(0, 80)));
    const fold = el("button", "btn ghost", this.askFolded ? tr("展开") : tr("收起"));
    fold.onclick = () => {
      this.askFolded = !this.askFolded;
      this.renderAsks();
    };
    const cancel = el("button", "btn ghost danger-text", tr("取消提问"));
    cancel.title = tr("告诉模型你不回答这次提问");
    cancel.onclick = () => this.answerAsk(ask, null);
    head.append(fold, cancel);
    slot.append(head);

    if (!this.askFolded) {
      if (total > 1) {
        const tabs = el("div", "ask-tabs");
        ask.questions.forEach((x, i) => {
          const tab = el("button", "ask-tab", `${x.label ?? `Q${i + 1}`}${st.drafts.has(x.id) ? " ✓" : ""}`);
          if (i === st.active) tab.classList.add("on");
          if (st.drafts.has(x.id)) tab.classList.add("done");
          tab.onclick = () => {
            st.active = i;
            this.renderAsks();
          };
          tabs.append(tab);
        });
        slot.append(tabs);
      }
      slot.append(el("div", "ask-prompt", q.prompt));
      const chosen = st.drafts.get(q.id);
      if (q.options.length) {
        const list = el("div", "ask-opts");
        q.options.forEach((opt, i) => {
          const btn = el("button", "ask-opt");
          const on = q.multiSelect ? Boolean(chosen?.picks?.includes(i + 1)) : Boolean(chosen && !chosen.wasCustom && chosen.value === opt.value);
          if (on) btn.classList.add("on");
          btn.append(el("div", "l", `${q.multiSelect ? (on ? "☑ " : "☐ ") : ""}${opt.label}`));
          if (opt.description) btn.append(el("div", "d", opt.description));
          btn.onclick = () =>
            q.multiSelect ? this.togglePick(ask, q, i + 1) : this.pickAnswer(ask, { id: q.id, value: opt.value, label: opt.label, index: i + 1 });
          list.append(btn);
        });
        slot.append(list);
      }
      if (q.multiSelect) slot.append(el("div", "ask-note", tr("可以多选；也可以在输入框里另外写几句。")));
      if (chosen?.wasCustom) slot.append(el("div", "ask-draft", tr("已填：{p1}", { p1: chosen.label })));
      if (chosen?.text) slot.append(el("div", "ask-draft", tr("另写：{p1}", { p1: chosen.text })));
      if (q.allowOther === false) slot.append(el("div", "ask-note", tr("这题只能从选项里选。")));
      if (total > 1 || q.multiSelect) {
        const missing = ask.questions.filter((x) => !st.drafts.has(x.id)).length;
        const submit = el("button", "btn primary", missing ? (total > 1 ? tr("还差 {p1} 题", { p1: missing }) : tr("先选一项或写几句")) : total > 1 ? tr("提交全部回答") : tr("提交"));
        submit.disabled = missing > 0;
        submit.onclick = () => {
          const answers = ask.questions.map((x) => st.drafts.get(x.id)).filter(Boolean) as AskAnswer[];
          if (answers.length === total) this.answerAsk(ask, answers);
        };
        const foot = el("div", "ask-foot");
        foot.append(submit);
        slot.append(foot);
      }
    }

    const row = host.querySelector(".row");
    if (row) host.insertBefore(slot, row);
    else host.append(slot);
  }

  /**
   * Remember a questionnaire that disappeared while it still had answers in it, so the user can see
   * it happened and get the text back. Filled answers are also persisted (see saveAskDrafts).
   */
  private keepLostAsk(ask: AskRequest, reason: string): void {
    const st = this.askDrafts.get(ask.id);
    const lines = ask.questions
      .map((q) => {
        const a = st?.drafts.get(q.id);
        return a ? `${q.prompt}\n→ ${a.label ?? a.value}` : null;
      })
      .filter((x): x is string => x !== null);
    if (!lines.length) return; // nothing was filled in: losing it costs the user nothing
    const title = ask.questions.length === 1 ? ask.questions[0].prompt : tr("{p1} 题的问卷", { p1: ask.questions.length });
    this.askLost = { id: ask.id, title: title.slice(0, 80), reason, lines };
  }

  private askLostBlock(): HTMLElement {
    const lost = this.askLost!;
    const box = el("div", "ask-slot ask-lost");
    box.append(el("div", "ask-lost-head", tr("问卷没答完就关闭了：{p1}", { p1: lost.reason })));
    box.append(el("div", "ask-lost-sub", tr("你已填的 {p1} 题还留着，可以接着用。", { p1: lost.lines.length })));
    const actions = el("div", "ask-lost-actions");
    const put = el("button", "btn", tr("把已填答案放进输入框"));
    put.onclick = () => {
      this.putInComposer(lost.lines.join("\n\n"));
      this.askLost = null;
      this.renderAsks();
    };
    const dismiss = el("button", "tool-btn", tr("忽略"));
    dismiss.onclick = () => {
      this.askLost = null;
      this.renderAsks();
    };
    actions.append(put, dismiss);
    box.append(actions);
    return box;
  }

  private putInComposer(text: string): void {
    const cur = this.composerText;
    const next = cur.trim() ? `${cur}${cur.endsWith("\n") ? "" : "\n\n"}${text}` : text;
    this.composerText = next;
    this.noteDraft();
    const field = this.textarea;
    if (field) {
      field.value = next;
      field.focus();
      field.setSelectionRange(next.length, next.length);
    }
    this.fitComposer();
  }

  /** Drafts outlive the panel: a reload or a re-appearing ask gets the same answers back. */
  private saveAskDrafts(): void {
    try {
      const keep: unknown[] = [];
      for (const [id, st] of [...this.askDrafts].slice(-30)) {
        if (!st.drafts.size) continue;
        keep.push({ id, active: st.active, answers: [...st.drafts.values()] });
      }
      if (keep.length) localStorage.setItem("pi.askDrafts", JSON.stringify(keep));
      else localStorage.removeItem("pi.askDrafts");
    } catch {
      /* quota / private mode */
    }
  }

  private loadAskDrafts(): void {
    try {
      const raw = JSON.parse(localStorage.getItem("pi.askDrafts") ?? "[]") as unknown;
      if (!Array.isArray(raw)) return;
      for (const row of raw) {
        const r = row as { id?: unknown; active?: unknown; answers?: unknown };
        if (typeof r?.id !== "string" || !Array.isArray(r.answers)) continue;
        const drafts = new Map<string, AskAnswer>();
        for (const a of r.answers as AskAnswer[]) if (a && typeof a.id === "string") drafts.set(a.id, a);
        if (drafts.size) this.askDrafts.set(r.id, { active: Number(r.active) || 0, drafts });
      }
    } catch {
      /* corrupt storage must not break the panel */
    }
  }

  private askState(ask: AskRequest): { active: number; drafts: Map<string, AskAnswer> } {
    let st = this.askDrafts.get(ask.id);
    if (!st) {
      st = { active: 0, drafts: new Map() };
      this.askDrafts.set(ask.id, st);
    }
    return st;
  }

  /** One question answers at once; several collect drafts and wait for 提交. */
  private pickAnswer(ask: AskRequest, answer: AskAnswer): void {
    if (ask.questions.length === 1) {
      this.answerAsk(ask, [answer]);
      return;
    }
    const st = this.askState(ask);
    st.drafts.set(answer.id, answer);
    const next = ask.questions.findIndex((x, i) => i > st.active && !st.drafts.has(x.id));
    if (next >= 0) st.active = next;
    else {
      const left = ask.questions.findIndex((x) => !st.drafts.has(x.id));
      if (left >= 0) st.active = left;
    }
    this.saveAskDrafts();
    this.renderAsks();
  }

  /** Multi-select: a click toggles one option; nothing is sent until 提交. */
  private togglePick(ask: AskRequest, q: AskQuestion, n: number): void {
    const st = this.askState(ask);
    const prev = st.drafts.get(q.id);
    const picks = new Set(prev?.picks ?? []);
    if (picks.has(n)) picks.delete(n);
    else picks.add(n);
    this.setMultiDraft(ask, q, [...picks].sort((a, b) => a - b), prev?.text ?? "");
    this.saveAskDrafts();
    this.renderAsks();
  }

  private setMultiDraft(ask: AskRequest, q: AskQuestion, picks: number[], text: string): void {
    const st = this.askState(ask);
    if (!picks.length && !text) {
      st.drafts.delete(q.id);
      return;
    }
    const label = [...picks.map((n) => q.options[n - 1]?.label ?? String(n)), ...(text ? [text] : [])].join(tr("、"));
    st.drafts.set(q.id, { id: q.id, value: label, label, picks, ...(text ? { text } : {}) });
  }

  /** Text typed in the composer while a question is open answers the active question. */
  private answerFromComposer(text: string): boolean {
    const ask = this.asks[0];
    if (!ask) return false;
    const q = ask.questions[this.askState(ask).active];
    if (!q || q.allowOther === false) return false;
    this.composerText = "";
    this.noteDraft();
    if (this.textarea) {
      this.textarea.value = "";
      this.fitComposer();
    }
    this.askFolded = false;
    if (q.multiSelect) {
      // The typed words join the ticked options; the question still waits for 提交.
      this.setMultiDraft(ask, q, this.askState(ask).drafts.get(q.id)?.picks ?? [], text);
      this.saveAskDrafts();
      this.renderAsks();
      return true;
    }
    this.pickAnswer(ask, { id: q.id, value: text, label: text, wasCustom: true });
    return true;
  }

  private focusAsk(): void {
    if (!this.asks.length) return;
    this.go("chat");
    this.askFolded = false;
    this.renderAsks();
    this.els.composerHost.querySelector(".ask-slot")?.scrollIntoView({ block: "nearest" });
    this.textarea?.focus();
  }

  private askCard(ask: AskRequest): HTMLElement {
    const card = el("div", "approval");
    const t = el("div", "t", ask.questions.length > 1 ? tr("需要你回答 · {p1} 题", { p1: ask.questions.length }) : tr("需要你回答"));
    // Q-033: 提问不设上限；发问方若给了时长，只在 tooltip 里交代一句。
    if (ask.timeoutMs) t.title = tr("发问方要求 {p1} 秒内作答，已忽略（提问不设上限）", { p1: Math.round(ask.timeoutMs / 1000) });
    card.append(t);
    card.append(el("div", "m", ask.questions.map((q, i) => tr("{p1}{p2}", { p1: ask.questions.length > 1 ? tr("{p1}：", { p1: q.label ?? `Q${i + 1}` }) : "", p2: q.prompt })).join("\n")));
    const actions = el("div", "actions");
    const go = el("button", "btn primary", tr("去回答"));
    go.onclick = () => this.focusAsk();
    const cancel = el("button", "btn danger", tr("取消这次提问"));
    cancel.onclick = () => this.answerAsk(ask, null);
    actions.append(cancel, go);
    card.append(actions);
    return card;
  }
  /** `null` answers = the user cancelled the whole questionnaire. */
  private answerAsk(ask: AskRequest, answers: AskAnswer[] | null): void {
    // Our own submit is not a loss: remember it so ask.remove does not report it as one.
    this.lastAnsweredAsk = ask.id;
    if (answers) this.askDrafts.delete(ask.id);
    this.saveAskDrafts();
    const payload = answers
      ? { type: "answer", sessionId: ask.sessionId, askId: ask.id, answers }
      : { type: "answer", sessionId: ask.sessionId, askId: ask.id, answers: [], cancelled: true };
    this.act(() => this.socket.send(payload));
    // Optimistic: `ask.remove` from the bridge has the final say for every other tab.
    this.asks = this.asks.filter((a) => a.id !== ask.id);
    this.renderAsks();
    this.renderQueue();
    this.renderTabs();
  }

  private approvalNode(): HTMLElement {
    const slot = el("div", "approval-slot");
    for (const a of this.approvals) slot.append(this.approvalCard(a));
    return slot;
  }

  /**
   * 批准单击生效（D155 推翻 D10）：不再弹原生 confirm —— 那个弹窗阻塞整页（倒计时也跟着停）、
   * 样式不由我们控制，而且「拒绝」单击、「批准」两下会让人以为两个按钮的份量不一样。
   */
  private approvalCard(a: ApprovalRequest): HTMLElement {
    const card = el("div", "approval");
    const t = el("div", "t", a.title);
    const m = el("div", "m", a.message);
    const actions = el("div", "actions");

    const approve = el("button", "btn primary", tr("批准"));
    approve.onclick = () => this.decide(a, "approve");
    const always = el("button", "btn", tr("本会话允许这类"));
    always.onclick = () => this.decide(a, "always");
    const reject = el("button", "btn danger", tr("拒绝"));
    reject.onclick = () => this.decide(a, "reject");

    actions.append(reject, always, approve);
    card.append(t, m, actions);
    if (a.deadline) {
      const hint = el("div", "hint", this.leftText(a.deadline));
      hint.dataset.deadline = String(a.deadline);
      card.append(hint);
    }
    return card;
  }

  private renderQueue(): void {
    const host = this.els.queueInner;
    host.replaceChildren();
    const pending = this.approvals;
    if (!pending.length && !this.asks.length) {
      host.append(el("div", "empty", tr("没有等你的事。")));
    } else {
      if (this.asks.length) {
        host.append(el("h2", "", tr("等你回答")));
        for (const a of this.asks) host.append(this.askCard(a));
      }
      if (pending.length) {
        host.append(el("h2", "", tr("等你批准")));
        for (const a of pending) host.append(this.approvalCard(a));
      }
    }

    const tools = el("div", "actions");
    tools.style.display = "flex";
    tools.style.gap = "8px";
    tools.style.flexWrap = "wrap";
    const push = el("button", "btn", tr("开启 Web Push"));
    push.onclick = () => void this.enablePush();
    const test = el("button", "btn", tr("发测试通知"));
    test.onclick = async () => {
      const res = await api.notifyTest().catch((e) => ({ push: 0, wechat: String(e.message ?? e) }));
      alert(tr("Web Push 送达 {p1} 台；微信：{p2}", { p1: res.push, p2: res.wechat }));
    };
    const tun = el("button", "btn", this.tunnel.status === "up" ? tr("关掉公网隧道") : tr("开公网隧道"));
    tun.onclick = async () => {
      const res = await api.tunnel(this.tunnel.status === "up" ? "stop" : "start").catch(() => null);
      if (res) this.tunnel = res.tunnel;
      this.renderTop();
      this.renderQueue();
    };
    tools.append(push, test, tun);
    host.append(el("h2", "", tr("通道")));
    host.append(tools);
    host.append(el("div", "hint", tr("Web Push 订阅 {p1} 台设备", { p1: this.me.pushCount })));
    if (this.tunnel.url) {
      const link = el("a", "", this.tunnel.url);
      link.href = this.tunnel.url;
      link.target = "_blank";
      host.append(link);
    }
    if (this.tunnel.error) host.append(el("div", "notice warn", errText(this.tunnel)));
    const keysTools = el("div", "queue-tools");
    const keysBtn = el("button", "btn", Object.keys(this.keys).length ? tr("快捷键（已设 {p1} 个）", { p1: Object.keys(this.keys).length }) : tr("设置快捷键"));
    keysBtn.onclick = () => this.openKeysSheet();
    const piSettings = el("button", "btn", tr("pi 设置")) as HTMLButtonElement;
    piSettings.title = tr("pi 的 settings.json（全局 / 项目）、项目信任、更新日志（/settings）");
    piSettings.onclick = () => this.openSettingsSheet("global");
    keysTools.append(keysBtn, piSettings);
    host.append(el("h2", "", tr("快捷键")));
    host.append(keysTools);
    host.append(el("h2", "", tr("关于")));
    host.append(el("div", "hint about", `pi ${this.me.pi} · bridge ${this.me.version} · ${this.me.sessionsRoot}`));
  }

  // ---------------------------------------------------------------- terminal (Q-007 · D70 · D92)
  /**
   * 终端是一个浮在页面上的 dialog（D92）：一个 dock、多个标签，每个标签一个真的 shell（桥里
   * `MAX_TERMS = 4`）。顶栏那颗「终端」按钮只负责把它拿出来 / 把焦点带回当前标签；它被「－」收起来
   * 之后，桥里的 shell 和这里的 xterm 都还在跑，再打开看到的还是同一个进程。
   */
  private openTerminal(): void {
    if (this.termTabs.size) {
      const active = (this.termActive && this.termTabs.get(this.termActive)) || [...this.termTabs.values()][0];
      this.showTermDock();
      if (active) this.activateTerm(active.id);
      return;
    }
    // 还没有 shell：先要一个，`term.opened` 到了再开 dialog。连点两下不该开出两个 shell——
    // 刚发出去 6 秒内算「正在开」；超时就当没开成，否则漏一个 frame 这颗按钮就永远不响应了。
    if (Date.now() - this.termWantAt < 6000) return;
    this.termWantAt = Date.now();
    this.requestTerminal();
  }

  /** 把 dialog 拿出来并重新 fit：它 display:none 的时候 xterm 量不出尺寸。 */
  private showTermDock(): void {
    const dock = this.ensureTermDock();
    const was = this.termOpen;
    dock.hidden = false;
    // 点顶栏「终端」= 激活它：盖过旁边开着的文件预览，然后才轮到预览里的下一次点击把它压回去。
    this.raiseWindow(dock);
    this.termOpen = true;
    this.paintTermButton();
    if (was) return;
    requestAnimationFrame(() => {
      const view = (this.termActive && this.termTabs.get(this.termActive)) || [...this.termTabs.values()][0];
      if (!view) return;
      this.fitTerm(view);
      view.term.focus();
    });
  }

  /** D92「－」：收起，不是结束。桥里的 shell 与这里的 xterm 都还活着，再点顶栏就回到原样。 */
  private minimizeTerm(): void {
    if (!this.termDock) return;
    this.termDock.hidden = true;
    this.termOpen = false;
    this.paintTermButton();
  }

  /** 顶栏那颗按钮的字：几个 shell 在跑就写几个，收起状态也看得到。 */
  private paintTermButton(): void {
    const btn = this.els.term;
    if (!btn) return;
    const n = this.termTabs.size;
    this.setWideLabel(btn, n > 1 ? tr(">_ 终端 {p1}", { p1: n }) : tr(">_ 终端"));
    btn.classList.toggle("term-live", n > 0);
  }

  /** Ask the bridge for one more shell, starting in the session's cwd. */
  private requestTerminal(shell?: string): void {
    const cwd = this.session?.cwd ?? undefined;
    this.socket.send({ type: "term.open", cols: 100, rows: 26, cwd, ...(shell ? { shell } : {}) });
  }

  /** #23: ＋ offers every shell the bridge found (PowerShell, Git Bash, cmd · $SHELL, zsh, bash…). */
  private openShellMenu(anchor: HTMLElement): void {
    const existing = document.querySelector(".term-menu");
    if (existing) {
      existing.remove();
      return;
    }
    if (this.termShells.length < 2) {
      this.requestTerminal();
      return;
    }
    const menu = el("div", "term-menu");
    for (const sh of this.termShells) {
      const item = el("button", "term-menu-item", sh.label) as HTMLButtonElement;
      item.type = "button";
      item.onclick = () => {
        menu.remove();
        this.requestTerminal(sh.id);
      };
      menu.append(item);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
    document.body.append(menu);
    const away = (ev: MouseEvent) => {
      if (menu.contains(ev.target as Node) || ev.target === anchor) return;
      menu.remove();
      document.removeEventListener("mousedown", away, true);
    };
    document.addEventListener("mousedown", away, true);
  }

  /** The dialog is created once and shared by every tab; `term.opened` / `term.replay` fill it. */
  private ensureTermDock(): HTMLElement {
    if (this.termDock) return this.termDock;
    const dock = el("section", "term-dock");
    // 收起态起步：有没有 shell 在跑，由顶栏那颗按钮说。
    dock.hidden = true;
    const grip = el("div", "term-grip");
    grip.title = tr("拖动调整终端高度（双击复原）");
    const head = el("div", "term-head");
    const strip = el("div", "term-tabs");
    const more = el("button", "term-new", tr("＋")) as HTMLButtonElement;
    more.title = tr("再开一个终端（最多 4 个），可选 shell");
    more.onclick = () => this.openShellMenu(more);
    const admin = el("button", "term-btn", tr("管理员")) as HTMLButtonElement;
    admin.title = tr("给当前标签开一个管理员 PowerShell 窗口（提权进程的输出浏览器接管不了，所以它在桌面上）");
    admin.onclick = () => {
      const active = this.termActive ? this.termTabs.get(this.termActive) : null;
      // Q-023: without admin:true the bridge never added -Verb RunAs, so this opened a plain shell
      // under an "管理员" label. The flag is the whole point of the button.
      this.act(() => this.socket.send({ type: "term.elevate", cwd: active?.cwd ?? this.session?.cwd ?? "", admin: true }));
    };
    // D92: 收起 ≠ 关掉。这颗把视图藏起来，shell 继续跑；要真结束，用标签上的 × 或「关闭」。
    const min = el("button", "term-btn min-btn", tr("－")) as HTMLButtonElement;
    min.title = tr("最小化：收回顶栏的「终端」按钮，shell 继续在后台跑（标签上的 × 才结束它）");
    min.onclick = () => this.minimizeTerm();
    const close = el("button", "term-btn", tr("关闭")) as HTMLButtonElement;
    close.title = tr("结束当前这个终端（其它标签不动）");
    close.onclick = () => {
      const id = this.termActive;
      if (id) this.closeTermTab(id, true);
      else this.disposeTermDock();
    };
    head.append(strip, more, el("div", "spacer"), admin, min, close);
    const bodies = el("div", "term-bodies");
    // D93: 右下角那颗抓取带拖宽 + 拖高；标题栏空白处拖走整个 dialog。
    const resize = el("div", "term-resize");
    resize.title = tr("拖动调整终端大小（双击复原）");
    dock.append(grip, head, bodies, resize);
    this.wireWindowRaise(dock);
    // 浮在页面上（overlay 进 #app，跟着外观缩放）：终端不再占对话栏的宽度，也就没有 Q-026 里
    // 「先折叠右栏」那件事了。
    this.overlay(dock);
    this.wireTermGrip(grip, dock);
    this.wireTermMove(head, dock);
    this.wireTermResize(resize, dock);
    this.applyTermGeom(dock);
    // 窗口变小了，别把 dialog 留在屏幕外面。
    window.addEventListener("resize", () => {
      if (this.termDock) this.applyTermGeom(this.termDock);
    });
    this.termDock = dock;
    this.termTabStrip = strip;
    this.termBodies = bodies;
    return dock;
  }

  /** One tab = one shell: its own xterm, its own body, its own socket id. */
  private addTermTab(id: string, shell: string, cwd: string): TermTab {
    const existing = this.termTabs.get(id);
    if (existing) return existing;
    const dock = this.ensureTermDock();
    // D92: 标签可能在 dialog 收起时到达（刷新后接管上一个页面留下的 shell）。xterm 在挂载时就量
    // 字符宽，display:none 的容器量出来是 0 —— 所以先让它可见再挂，没人在等就同一个任务里收回去。
    const keep = this.termWantAt > 0 || this.termOpen;
    dock.hidden = false;
    // The tab shows the directory (the dock is obviously a shell; the shell name lives in the title),
    // plus an ordinal — two shells in the same cwd would otherwise read identically, and "…#2" appended
    // to `powershell · …` is exactly what the ellipsis eats first.
    const base = cwd ? shortDir(cwd) : shell;
    const twins = [...this.termTabs.values()].filter((t) => (t.cwd ? shortDir(t.cwd) : t.shell) === base).length;
    const name = twins ? `${base} #${twins + 1}` : base;
    const body = el("div", "term-body");
    body.dataset.id = id;
    this.termBodies!.append(body);

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 4000,
      theme: { background: "#0b0d10", foreground: "#d6deeb", cursor: "#7dd3fc", selectionBackground: "#334155" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(body);

    const tab = el("button", "term-tab") as HTMLButtonElement;
    tab.dataset.id = id;
    tab.title = cwd ? `${shell} · ${cwd}` : shell;
    tab.append(el("span", "term-tab-label", name));
    const kill = el("span", "term-tab-x", "×");
    kill.title = tr("关掉这个终端");
    kill.onclick = (ev) => {
      ev.stopPropagation();
      this.closeTermTab(id, true);
    };
    tab.append(kill);
    tab.onclick = () => this.activateTerm(id);
    this.termTabStrip!.append(tab);

    const view: TermTab = { id, shell, cwd, term, fit, body, tab };
    this.termTabs.set(id, view);
    this.paintTermButton();
    term.onData((data) => this.socket.send({ type: "term.input", id, data }));
    term.onResize(({ cols, rows }) => this.socket.send({ type: "term.resize", id, cols, rows }));
    // A hidden body has no measurable size, so only the visible tab is worth fitting here.
    new ResizeObserver(() => {
      if (this.termOpen && this.termActive === id) this.fitTerm(view);
    }).observe(body);
    this.activateTerm(id);
    // `keep` was read before mounting: the tab may have arrived for a minimized dialog, and a
    // terminal nobody asked for must not pop up on its own.
    if (keep) {
      this.termWantAt = 0;
      this.showTermDock();
    } else {
      dock.hidden = true;
      this.termOpen = false;
    }
    return view;
  }

  private fitTerm(view: TermTab): void {
    try {
      view.fit.fit();
    } catch {
      // the panel can be hidden mid-layout; the next resize event retries
    }
  }

  private activateTerm(id: string): void {
    const view = this.termTabs.get(id);
    if (!view) return;
    this.termActive = id;
    for (const [tid, other] of this.termTabs) {
      other.body.hidden = tid !== id;
      other.tab.classList.toggle("on", tid === id);
    }
    // 收起的时候不 fit 也不抢焦点：容器是 display:none，量出来的尺寸没有意义（showTermDock 补）。
    if (!this.termOpen) return;
    requestAnimationFrame(() => {
      this.fitTerm(view);
      view.term.focus();
    });
  }

  /** `kill` = also tell the bridge to end the process (false when the bridge said it is already gone). */
  private closeTermTab(id: string, kill: boolean): void {
    const view = this.termTabs.get(id);
    if (!view) return;
    if (kill) this.socket.send({ type: "term.close", id });
    view.term.dispose();
    view.body.remove();
    view.tab.remove();
    this.termTabs.delete(id);
    this.paintTermButton();
    if (this.termActive !== id) return;
    this.termActive = null;
    const next = [...this.termTabs.keys()][0];
    if (next) this.activateTerm(next);
    else this.disposeTermDock();
  }

  private disposeTermDock(): void {
    for (const id of [...this.termTabs.keys()]) this.closeTermTab(id, false);
    if (this.termDock && this.winFront === this.termDock) this.winFront = null;
    this.termDock?.remove();
    this.termDock = null;
    this.termTabStrip = null;
    this.termBodies = null;
    this.termActive = null;
    this.termOpen = false;
    this.termWantAt = 0;
    this.paintTermButton();
  }


  // ---------------------------------------------------------------- shortcuts
  /** One global keydown; what it fires depends on what the user bound in 快捷键. */
  private installShortcuts(): void {
    this.paintShortcutTitles();
    window.addEventListener(
      "keydown",
      (ev) => {
        if (this.capturing || ev.isComposing) return;
        const combo = comboOf(ev);
        if (!combo || !shortcutAllowed(combo)) return;
        const act = Object.keys(this.keys).find((id) => this.keys[id] === combo);
        if (!act) return;
        const target = ev.target as HTMLElement | null;
        const typing = Boolean(target?.isContentEditable) || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
        // A bare F-key is fine anywhere, but a typed character must never turn into a command.
        if (typing && !/^(ctrl|alt|meta)(\+|$)/.test(combo)) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.runAction(act);
      },
      true,
    );
  }

  private runAction(id: string): void {
    switch (id) {
      case "new":
        this.openNewSessionSheet();
        break;
      case "manage":
        void this.openManager();
        break;
      case "sessions":
        this.togglePane("sessions");
        break;
      case "queue":
        this.togglePane("queue");
        break;
      case "artifacts":
        this.openArtifactsSheet();
        break;
      case "files":
        this.openFiles();
        break;
      case "notes":
        this.openNotes();
        break;
      case "look":
        this.openDisplaySheet();
        break;
      case "skills":
        this.openSkillPalette();
        break;
      case "attach":
        this.openFilePicker();
        break;
      case "terminal":
        this.openTerminal();
        break;
      case "interrupt":
        if (this.session?.running) this.act(() => this.socket.send({ type: "abort", sessionId: this.currentId }));
        break;
    }
  }

  /** Buttons carrying data-act get their combo appended to the tooltip. */
  private paintShortcutTitles(): void {
    for (const node of document.querySelectorAll<HTMLElement>("[data-act]")) {
      const id = node.dataset.act ?? "";
      const base = node.dataset.baseTitle ?? node.title;
      node.dataset.baseTitle = base;
      const combo = this.keys[id];
      const hint = combo ? tr("　〔{p1}〕", { p1: keyLabel(combo) }) : "";
      if (base) node.title = `${base}${hint}`;
      else if (combo) node.title = keyLabel(combo);
    }
  }

  private openKeysSheet(): void {
    this.closeSheet();
    this.sheetKind = "keys";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    const sheet = el("div", "sheet keys-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", tr("快捷键")));
    const close = el("button", "btn ghost", tr("关闭"));
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);
    sheet.append(
      el(
        "div",
        "hint",
        tr("点右边的键钮再按下组合键。组合要带 Ctrl / Alt / Shift，F2–F10 可以单独用；浏览器自己占的键（Ctrl+W、F5…）不收。点已设好的键钮可以清除。"),
      ),
    );
    const list = el("div", "keys-list");
    const paint = (): void => {
      list.replaceChildren();
      for (const act of SHORTCUTS) {
        const row = el("div", "keys-row");
        row.append(el("div", "keys-name", act.label));
        const combo = this.keys[act.id];
        const button = el("button", `keys-chip${combo ? "" : " empty"}`, this.capturing === act.id ? tr("按下组合键…") : combo ? keyLabel(combo) : tr("未设置")) as HTMLButtonElement;
        button.onclick = () => {
          if (combo) {
            delete this.keys[act.id];
            saveKeys(this.keys);
            this.paintShortcutTitles();
            paint();
            return;
          }
          this.startCapture(act.id, paint);
        };
        row.append(button);
        if (combo) {
          const clear = el("button", "btn ghost small", tr("清除"));
          clear.onclick = () => {
            delete this.keys[act.id];
            saveKeys(this.keys);
            this.paintShortcutTitles();
            paint();
          };
          row.append(clear);
        }
        list.append(row);
      }
    };
    paint();
    sheet.append(list);
    const foot = el("div", "sheet-foot");
    const clearAll = el("button", "btn ghost", tr("全部清空"));
    clearAll.onclick = () => {
      this.keys = {};
      saveKeys(this.keys);
      this.paintShortcutTitles();
      paint();
    };
    const done = el("button", "btn primary", tr("完成"));
    done.onclick = () => this.closeSheet();
    foot.append(clearAll, done);
    sheet.append(foot);
    back.append(sheet);
    this.sheet = back;
    document.body.append(back);
  }

  /** Waits for one key press; Escape cancels, a taken combo moves to the new action. */
  private startCapture(id: string, repaint: () => void): void {
    this.capturing = id;
    repaint();
    const stop = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.capturing = null;
        window.removeEventListener("keydown", stop, true);
        repaint();
        return;
      }
      const combo = comboOf(ev);
      // Ctrl / Shift / Alt on their own are part of the next press, not an answer by themselves.
      if (!combo) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.capturing = null;
      window.removeEventListener("keydown", stop, true);
      if (shortcutAllowed(combo)) {
        for (const other of Object.keys(this.keys)) if (this.keys[other] === combo) delete this.keys[other];
        this.keys[id] = combo;
        saveKeys(this.keys);
        this.paintShortcutTitles();
      }
      repaint();
    };
    window.addEventListener("keydown", stop, true);
  }

  private renderPanes(): void {
    const { sessionsPane, chatPane, queuePane, main } = this.els;
    const desktop = !this.compact();
    // 两行制跟着断点与 currentId 走，窗口一拖也得重摆（renderPanes 在 resize 的 rAF 里跑）。
    // #98：C 的竖列 / D 的色点条也一样 —— 断点、收起状态、当前会话任一变了都得重画。
    // 那颗的落点也跟断点走（窄屏进顶栏），所以这里顺手再摆一次（只在真的跨断点时才动 DOM）。
    this.placeNowChip();
    this.renderShellAxes();
    this.renderSessionRow();
    this.renderWorkspaceTabs();
    if (desktop) {
      sessionsPane.hidden = this.collapsed.sessions;
      chatPane.hidden = false;
      queuePane.hidden = this.collapsed.queue;
      main.classList.toggle("no-left", this.collapsed.sessions);
      main.classList.toggle("no-right", this.collapsed.queue);
      this.syncCwdChip();
      return;
    }
    main.classList.remove("no-left", "no-right");
    sessionsPane.hidden = this.tab !== "sessions";
    chatPane.hidden = this.tab !== "chat";
    queuePane.hidden = this.tab !== "queue";
    this.syncCwdChip();
  }

  /**
   * #98：C 的竖列（常驻，48px）与 D 的色点条（只在左栏收起时出现，52px）。
   * 两套用的是同一份 `railModel()` —— 一行就是「一个工作区」，只有尺寸不同，不复制一份数据逻辑。
   * 窄屏四套统一退化（一根竖列也不留），所以这里先看断点。
   */
  private renderShellAxes(): void {
    const parts = shellParts(activeLayout(this.prefs));
    const desktop = !this.compact();
    if (this.rail) {
      this.rail.hidden = !(parts.rail && desktop);
      if (!this.rail.hidden) this.paintAxis(this.rail, "rail");
    }
    if (this.strip) {
      this.strip.hidden = !(parts.strip && desktop && this.collapsed.sessions);
      if (!this.strip.hidden) this.paintAxis(this.strip, "strip");
    }
  }

  /** 竖列 / 色点条的一格：色点（与树同一个 `wsColor()`）+ 两字头 + 待处理角标。 */
  private paintAxis(host: HTMLElement, kind: "rail" | "strip"): void {
    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    const cur = this.currentWsId();
    const now = this.session;
    host.replaceChildren();
    host.dataset.kind = kind;
    for (const item of railModel(tree.groups, cur)) {
      host.append(this.axisItem(item, now?.name ?? ""));
    }
    // 竖列/色点条只负责切组，不做拖排序（#98 票面）：落到它上面的拖动一律不接。
    const foot = el("div", "ws-axis-foot");
    const add = el("button", "ws-axis-ghost", tr("＋")) as HTMLButtonElement;
    add.type = "button";
    add.dataset.act = "new";
    add.title = tr("开新会话");
    add.setAttribute("aria-label", tr("开新会话"));
    add.onclick = () => this.openNewSessionSheet(true);
    foot.append(add);
    // 色点条只在左栏收起时出现 —— 它就是那颗「展开回去」的按钮。竖列旁边有顶栏那颗，不用重复。
    if (kind === "strip") {
      // 箭头不是文案，不进词典（`i18n-check` 只认 CJK 键）。
      const expand = el("button", "ws-axis-ghost", "▸") as HTMLButtonElement;
      expand.type = "button";
      expand.dataset.act = "expand";
      expand.title = tr("展开左侧会话栏");
      expand.setAttribute("aria-label", tr("展开左侧会话栏"));
      expand.onclick = () => this.togglePane("sessions");
      foot.append(expand);
    }
    host.append(foot);
  }

  private axisItem(item: RailItem, sessionName: string): HTMLElement {
    const btn = el("button", `ws-axis-item${item.current ? " on" : ""}`) as HTMLButtonElement;
    btn.type = "button";
    btn.dataset.ws = item.id;
    btn.title = item.current && sessionName
      ? tr("{p1} · {p2}（当前）", { p1: item.name, p2: sessionName })
      : tr("{p1}，{p2} 个会话", { p1: item.name, p2: item.count });
    btn.setAttribute("aria-label", tr("{p1}，{p2} 个会话", { p1: item.name, p2: item.count }));
    if (item.current) btn.setAttribute("aria-current", "true");
    const dot = el("span", "ws-axis-dot");
    dot.style.background = item.color;
    btn.append(dot, el("span", "ws-axis-label", item.label));
    if (item.pending) {
      const todo = el("span", "ws-axis-todo", String(item.pending));
      todo.title = tr("{p1} 个会话在等你", { p1: item.pending });
      btn.append(todo);
    }
    btn.onclick = () => {
      const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
      const group = tree.groups.find((g) => g.id === item.id);
      if (group) this.gotoGroup(group);
    };
    return btn;
  }

  /**
   * 左栏收起后就没人报「现在在哪个目录」了 —— 会话卡片连同它的 cwd 一起被藏起来。这时把路径接到状态行
   * 最前面、分支 chip 旁边，并且只在这时接：左栏展开时选中的那张卡片上写着同一个路径，再摆一个是重复。
   * 窄屏不走「折叠」这条逻辑（左栏是一页 tab），也不显示。
   */
  private syncCwdChip(): void {
    if (!this.cwdChip) return;
    this.cwdChip.hidden = !(this.collapsed.sessions && !this.compact());
  }

  private cwdChipNode(cwd: string): HTMLElement {
    const btn = el("button", "cwd-chip") as HTMLButtonElement;
    const path = el("span", "cwd-path", cwd);
    btn.append(path);
    // 键里的 \n 会让 i18n 键扫描把 `{p1}` 当成键本身（既有误报），换行拼在键外。
    btn.title = cwd + "\n" + tr("点一下复制路径");
    btn.onclick = () => {
      // 和 git chip 一样：`navigator.clipboard` 在局域网 http 下不存在，可选链要包住调用不是属性。
      const copy = navigator.clipboard?.writeText(cwd);
      if (!copy) return;
      const back = path.textContent ?? cwd;
      void copy
        .then(() => {
          path.textContent = tr("已复制");
          setTimeout(() => {
            if (path.isConnected && path.textContent === tr("已复制")) path.textContent = back;
          }, 900);
        })
        .catch(() => {});
    };
    return btn;
  }

  /**
   * #97 壳 A 行 1：工作区标签页。横向一条；#121 起只画 N 颗（默认 6，桥端可调 1–12），
   * 剩下的收进槽外那颗 `＋N`。当前工作区永远在圈内（不在就占最后一格），有会话卡在
   * 用户身上时带一颗待处理点。点一下 = 切到那一组：打开组里排最上面的那颗会话（★ 优先，跟左栏
   * 同一份顺序）；#174 起画出来的每一颗都能拖，拖完写回同一种 `order`。
   */
  private renderWorkspaceTabs(): void {
    const { wsTabsRow, wsTabs, wsTabsMore, wsTabsAdd } = this.els;
    if (!wsTabsRow || !wsTabs || !wsTabsMore || !wsTabsAdd) return;
    // #98：标签行只属于 A；B/C/D 的切组入口分别是浮层 / 竖列 / 色点条 + 树。
    // #119：窄屏也照画 —— 它现在就在 A 的顶栏那一行里，收起它就等于 A 的顶栏没标签了。
    const parts = shellParts(activeLayout(this.prefs));
    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    const cur = this.currentWsId();
    // 锚点那颗不重建，但它列的是「被折叠的组」—— 组序跟着活动时间换人，开着的那张先收掉。
    this.closeTabsMore();
    wsTabs.replaceChildren();
    wsTabsMore.hidden = true;
    // #175：那颗 ＋ 跟横条同进同出（B/C/D 没有横条，也就不画它）。
    wsTabsAdd.hidden = !tabsAddShown(parts);
    wsTabsRow.hidden = !parts.tabsRow || !tree.groups.length;
    if (wsTabsRow.hidden) {
      // 横条不画时这句提示没有出口，别攒到下一次渲染。
      this.wsNewNoteId = null;
      return;
    }
    const byId = new Map(tree.groups.map((group) => [group.id, group]));
    // #173：标签行与左栏用同一份 `order`（含折叠组），不再按名字或最近活动另排一套。
    // 旧桥没下发 order 时退回树的组序（此时树自己也是按名字排的）。
    const bridgeOrder = this.wsOrder();
    const order = (bridgeOrder?.length ? bridgeOrder : tree.groups.map((group) => group.id)).filter((id) => byId.has(id));
    const model = tabModel({ order, max: this.workspaces.max ?? TABS_DEFAULT, current: cur ?? undefined });
    // #175：刚在横条 ＋ 上建的组：`order` 末尾、名额已满时它直接进 ＋N —— 说一声，
    // 否则横条看起来没变，像是没建成（新组仍按 #173 的规则留在 order 末尾）。
    const born = this.wsNewNoteId;
    if (born) {
      this.wsNewNoteId = null;
      const folded = newTabFold(order, this.workspaces.max ?? TABS_DEFAULT, born);
      if (folded != null) this.flashToast(tr("已新建，收在 ＋{p1} 里", { p1: folded }), false, 4000);
    }
    for (const id of model.visible) {
      const group = byId.get(id);
      if (!group) continue;
      const tab = el("button", `ws-tab${group.id === cur ? " on" : ""}`);
      tab.dataset.ws = group.id;
      tab.title = tr("切到这个工作区");
      tab.setAttribute("aria-label", tr("{p1}，{p2} 个会话", { p1: group.name, p2: group.sessions.length }));
      if (group.id === cur) tab.setAttribute("aria-current", "true");
      const dot = el("span", "ws-tab-dot");
      dot.style.background = group.color;
      tab.append(dot, el("span", "ws-tab-name", group.name));
      if (group.pending) {
        const todo = el("span", "ws-tab-todo");
        todo.title = tr("{p1} 个会话在等你", { p1: group.pending });
        tab.append(todo);
      }
      // #174：画出来的每一颗都能拖；拖完不误当点击。
      // #178 R34：旧桥没有 `order`，顺序只是页面按名字兜底，拖了也无处落库 —— 不绑拖动。
      // 过滤态只画命中组：此时拖出来的 order 会缺项、被桥按创建序补到末尾 —— 搜索时不绑拖。
      if (bridgeOrder?.length && !this.filter) tab.onpointerdown = (ev) => this.startTabDrag(ev, group.id, model);
      tab.onclick = () => {
        if (this.tabDragMoved) {
          this.tabDragMoved = false;
          return;
        }
        this.gotoGroup(group);
      };
      wsTabs.append(tab);
    }
    // #121：超出的组收进这颗。它在槽外面（见 createShell），槽横滚时位置不动。
    if (model.more.length) {
      const why = tr("还有 {p1} 个工作区", { p1: model.more.length });
      const folded = model.more.map((id) => byId.get(id)).filter((group): group is TreeGroup<SessionState> => Boolean(group));
      wsTabsMore.hidden = false;
      wsTabsMore.textContent = tr("＋{p1}", { p1: folded.length });
      wsTabsMore.title = why;
      wsTabsMore.setAttribute("aria-label", why);
      wsTabsMore.onclick = () => this.toggleTabsMore(folded);
    } else {
      wsTabsMore.onclick = null;
    }
    // 量宽要等布局落地：hidden 刚摘掉的那一帧 clientWidth 还是 0。
    requestAnimationFrame(() => this.paintWsTabFade());
  }

  /**
   * #174 标签行的鼠标拖拽重排。按下后移动超过 4px 才算
   * 起拖 —— 不超过就还是那次普通点击（切组），所以 pointerdown 里不能 preventDefault、也不能抢
   * pointer capture。只认鼠标：触屏 / 笔 / 键盘的排量不在这一票里（#172 Out of Scope）。
   *
   * 落点由 `tabHitTest()` 定（拖动源自己从 rects 里剔掉），指示线是一条 2px 竖线贴在落点那一侧；
   * 松手只发一条 `ws.tabs { order }`（整份 order 一次写回），由桥端落库再广播回来 —— 页面不自己
   * 改本地顺序。拖回原位 / 落点没变 → `tabReorder()` 返回 null，一个字都不发。`model` 是这一帧画
   * 出来的可见段 / 折叠段：重排只在可见段里算，折叠组既拖不动也不会被顺手拽进前几名。
   */
  private startTabDrag(ev: PointerEvent, id: string, model: TabModel): void {
    if (ev.button !== 0 || ev.pointerType !== "mouse") return;
    const tabs = this.els.wsTabs;
    const tab = ev.currentTarget as HTMLElement | null;
    if (!tabs || !tab || !model.visible.includes(id)) return;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let moved = false;
    let hit: TabHit | null = null;
    let line: HTMLElement | null = null;
    this.tabDragMoved = false;

    /** 其余标签的横向占位：拖动源自己不在里面，否则它永远吸住落点。 */
    const rects = (): TabRect[] =>
      [...tabs.querySelectorAll<HTMLElement>(".ws-tab")]
        .filter((n) => n.dataset.ws && n.dataset.ws !== id)
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { id: n.dataset.ws ?? "", left: r.left, right: r.right };
        });

    const move = (e: PointerEvent): void => {
      if (!moved) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) <= 4) return;
        moved = true;
        this.tabDragMoved = true;
        // 过 4px 时按钮里的字可能已经被选了一半：清掉，再把选中和悬浮压住（不然看不出线画在哪）。
        document.getSelection()?.removeAllRanges();
        document.body.classList.add("ws-tab-dragging");
        tab.classList.add("drag");
      }
      const box = rects();
      hit = tabHitTest(e.clientX, box);
      const at = hit ? box.find((r) => r.id === hit?.id) : undefined;
      if (!hit || !at) {
        line?.remove();
        line = null;
        return;
      }
      if (!line) {
        line = el("div", "ws-tab-line");
        tabs.append(line);
      }
      // 标签槽是 overflow-x: auto —— 竖线挂在**内容**坐标上（加 scrollLeft），槽横滚时它跟着标签走。
      const base = tabs.getBoundingClientRect();
      line.style.left = `${Math.round((hit.side === "before" ? at.left : at.right) - base.left + tabs.scrollLeft)}px`;
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      line?.remove();
      line = null;
      document.body.classList.remove("ws-tab-dragging");
      tab.classList.remove("drag");
    };

    const up = (): void => {
      cleanup();
      if (!moved) return;
      // click 紧跟在这一帧后面：留个标记让那颗标签的 onclick 认出「这是拖拽，不是切组」。
      // 用定时器兜底 —— 拖到别的标签上松手时 click 落在 .ws-tabs 上，没有哪颗标签会来消费它。
      window.setTimeout(() => {
        this.tabDragMoved = false;
      }, 0);
      const next = tabReorder(model, id, hit);
      if (next) {
        // 只交顺序：名额有自己的入口，拖一下不该顺带把上一帧的 max 回写。
        this.act(() => this.socket.send({ type: "manage", action: "ws.tabs", order: next }));
      }
    };

    const cancel = (): void => {
      this.tabDragMoved = false;
      cleanup();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  private paintWsTabFade(): void {
    const box = this.els.wsTabs;
    if (!box) return;
    box.classList.toggle("fade", box.scrollWidth > box.clientWidth + 1);
  }

  /** #121：`＋N` 点开 = 只列被折叠的组；点一行切过去并把下拉关掉。 */
  private toggleTabsMore(groups: TreeGroup<SessionState>[]): void {
    if (this.tabsMore) {
      this.closeTabsMore();
      return;
    }
    const anchor = this.els.wsTabsMore;
    if (!anchor) return;
    // 外壳复用置顶胶囊那张卡（`.pin-menu` / `.pm-item`）：同一个下拉，只是列的是工作区。
    const pop = el("div", "pin-menu ws-tabs-menu");
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", tr("被折叠的工作区"));
    pop.append(el("div", "pm-head", tr("还有 {p1} 个工作区", { p1: groups.length })));
    for (const group of groups) {
      const row = el("button", "pm-item") as HTMLButtonElement;
      row.type = "button";
      row.setAttribute("role", "menuitem");
      row.dataset.ws = group.id;
      const dot = el("span", "pm-ico", "●");
      dot.style.color = group.color;
      row.append(dot, el("span", "pm-text", group.name));
      row.title = group.name;
      row.onclick = (ev) => {
        ev.stopPropagation();
        this.closeTabsMore();
        this.gotoGroup(group);
      };
      pop.append(row);
    }
    // 贴着那颗；下方放不下就翻上去，装不下的行自己滚（这条常常贴着窗口底）。
    const place = (): void => {
      stickMenu(pop, anchor.getBoundingClientRect(), { gap: 6 });
    };
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (t && (pop.contains(t) || anchor.contains(t))) return;
      this.closeTabsMore();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.closeTabsMore();
      anchor.focus();
    };
    const remove = (): void => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      pop.remove();
    };
    document.body.append(pop);
    place();
    (pop.querySelector<HTMLElement>(".pm-item") ?? pop).focus();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    anchor.setAttribute("aria-expanded", "true");
    this.tabsMore = {
      close: () => {
        anchor.setAttribute("aria-expanded", "false");
        remove();
      },
    };
  }

  private closeTabsMore(): void {
    const cur = this.tabsMore;
    this.tabsMore = null;
    cur?.close();
  }

  /** 当前会话所在的工作区 id；没当前会话 / 旧桥没有分组时是 null。 */
  private currentWsId(): string | null {
    const s = this.session;
    if (!s || !this.workspaces?.groups?.length) return null;
    const listed = this.sessions.find((x) => x.id === s.id);
    return wsOf(s, this.workspaces, listed?.ws)?.id ?? null;
  }

  /** 标签页点击：切到那一组 = 打开它排在最上面的那颗；手建的空组没有会话可开，就把左栏展开。 */
  private gotoGroup(group: TreeGroup<SessionState>): void {
    const first = group.sessions[0];
    if (first) {
      this.openFromList(first.id);
      return;
    }
    if (this.collapsed.sessions) this.togglePane("sessions");
    if (this.prefs.wsCollapsed.includes(group.id)) this.toggleWs(group.id);
  }

  /* ------------------------------------------------- 壳 B / C / D（#98） */

  /**
   * 顶栏那颗的点击：窄屏四套统一退化 —— 点一下就是打开左栏（会话是一页 tab，没有浮层也没有竖列）；
   * 桌面只有 B/C/D 接（A 里那颗仍是指示，摆在行 2 上）。
   */
  private onWhereClick(): void {
    if (this.compact()) {
      this.go("sessions");
      return;
    }
    if (!shellParts(activeLayout(this.prefs)).chipOpensOverlay || !this.nowBtn) return;
    this.toggleWsPop(this.nowBtn);
  }

  /**
   * #98 B 那层浮层（C/D 里点那颗也开同一张）：按工作区分段列会话 —— 段头点一下切组、会话行点
   * 一下开会话、会话行可以拖（票面要求；落点判定与左栏共用 `hitTest()`，不是第二套实现）。
   * 一次只开一张，关掉时监听一起摘。
   */
  private toggleWsPop(anchor: HTMLElement): void {
    if (this.wsPop) {
      this.closeWsPop();
      return;
    }
    this.openWsPop(anchor);
  }

  private openWsPop(anchor: HTMLElement): void {
    this.closeWsPop();
    const pop = el("div", "ws-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", tr("工作区与会话"));
    const body = el("div", "ws-pop-body");
    const foot = el("div", "ws-pop-foot");
    const add = el("button", "btn ghost ws-pop-add", tr("＋ 新会话")) as HTMLButtonElement;
    add.type = "button";
    add.dataset.act = "new";
    add.onclick = () => {
      this.closeWsPop();
      this.openNewSessionSheet(true);
    };
    foot.append(add);
    pop.append(body, foot);
    document.body.append(pop);
    this.wsPop = pop;
    this.wsPopBody = body;
    // 拖动落在这张浮层里：落点线 / 落点判定还是那一份，只是换成量浮层这块 DOM。
    this.dragScope = { el: body, group: ".ws-pop-sec", head: ".ws-pop-sec-head", item: ".ws-pop-item" };
    this.renderWsPop();
    anchor.setAttribute("aria-expanded", "true");
    // 贴着那颗：右缘不出屏，下缘放不下就往上翻。它自己有 70vh 上限和体内滚动，所以不再另封顶。
    stickMenu(pop, anchor.getBoundingClientRect(), { gap: 6, cap: false });
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (t && (pop.contains(t) || anchor.contains(t))) return;
      this.closeWsPop();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.closeWsPop();
      anchor.focus();
    };
    const onAway = () => this.closeWsPop();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("hashchange", onAway);
    this.wsPopCleanup = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("hashchange", onAway);
    };
  }

  private closeWsPop(): void {
    this.wsPopCleanup?.();
    this.wsPopCleanup = null;
    this.wsPop?.remove();
    this.wsPop = null;
    this.wsPopBody = null;
    this.dragScope = null;
    this.dropLine?.remove();
    this.dropLine = null;
    this.nowBtn?.setAttribute("aria-expanded", "false");
  }

  /** 内容每次开 / 会话列表一变就重画：段序、计数、当前那颗的高亮都跟着 `buildTree()` 走。 */
  private renderWsPop(): void {
    const body = this.wsPopBody;
    if (!body) return;
    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    const curWs = this.currentWsId();
    body.replaceChildren();
    if (!tree.groups.length) {
      body.append(el("div", "ws-pop-empty", tr("还没有工作区。")));
      return;
    }
    for (const group of tree.groups) {
      const sec = el("section", "ws-pop-sec");
      sec.dataset.ws = group.id;
      const head = el("button", `ws-pop-sec-head${group.id === curWs ? " on" : ""}`) as HTMLButtonElement;
      head.type = "button";
      head.dataset.ws = group.id;
      const dot = el("span", "ws-tab-dot");
      dot.style.background = group.color;
      const name = el("span", "ws-pop-sec-name", group.name);
      head.append(dot, name);
      if (group.pending) {
        const todo = el("span", "ws-tab-todo");
        todo.title = tr("{p1} 个会话在等你", { p1: group.pending });
        head.append(todo);
      }
      head.append(el("span", "n", String(group.sessions.length)));
      head.title = tr("切到这个工作区");
      head.setAttribute("aria-label", tr("{p1}，{p2} 个会话", { p1: group.name, p2: group.sessions.length }));
      if (group.id === curWs) head.setAttribute("aria-current", "true");
      head.onclick = () => {
        this.closeWsPop();
        this.gotoGroup(group);
      };
      sec.append(head);
      for (const s of group.sessions) sec.append(this.wsPopItem(s));
      body.append(sec);
    }
    this.wireTreeDrops(body);
  }

  /** 浮层里的一行：与树里同一套视觉语言（在线点 / 待处理角标 / 当前高亮）。 */
  private wsPopItem(s: SessionState): HTMLElement {
    const curId = this.currentId;
    const item = el("div", `ws-pop-item${s.id === curId ? " on" : ""}`);
    item.dataset.id = s.id;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    if (s.id === curId) item.setAttribute("aria-current", "true");
    const dot = el("span", `dot ${s.running ? "busy" : s.owned ? "live" : ""}`);
    dot.title = s.running ? tr("运行中") : s.owned ? tr("网页已接管（pi 进程在本服务里）") : tr("未接管（只读历史；发消息会自动接管）");
    item.append(dot, el("span", "ws-pop-item-name", s.name || s.id.slice(0, 8)));
    const chip = this.badgeChip(s);
    if (chip) item.append(chip);
    item.onclick = () => {
      this.closeWsPop();
      this.openFromList(s.id);
    };
    item.onkeydown = (ev) => {
      if (ev.target !== item) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        item.click();
      }
    };
    // 浮层里也能拖（票面要求）；归档的会话不在任何组里，自然进不来。
    item.draggable = !this.filter;
    item.ondragstart = (ev) => {
      this.beginDrag(s.id);
      item.classList.add("dragging");
      ev.dataTransfer?.setData("text/plain", s.id);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    };
    item.ondragend = () => this.endDrag();
    return item;
  }

  /**
   * #97 壳 A 行 2：本区 ★ 会话胶囊 + ＋；当前会话**没点 ★**时，最左再摆那颗 `NowChip`（#127）。
   * #120：胶囊只取本区里点过 ★ 的那些（`manage.pin`），不再铺本区全部会话。
   * #126：顺序按 `manage.pin` 定，切会话不重排；当前会话在 ★ 行里时带主题色填充。
   * #127：既然填色已经能认出「我在哪」，当前会话点过 ★ 时最左那颗就是重复的 —— 它只在
   * 「本区没给当前会话点 ★」时出场，兜住「名字在界面上总得看得到」这条。
   * 没有工作区快照（旧桥 / 桩桥）时退回置顶列表：不知道「本区」时，置顶区至少是用户自己
   * 挑过的那批。
   */
  private renderSessionRow(): void {
    const host = this.els.pinStrip;
    if (!host) return;
    // 条要整个重建（锚点那颗胶囊跟着消失），折起来的那张列表不能留在屏幕上。
    this.pillBar.closeMore();
    // #189：画与不画都先算一遍 —— 回声里算「右邻」用的是归档前的这一份顺序。
    const shown = this.starredRow();
    this.rowIds = shown.map((s) => s.id);
    const desktop = !this.compact();
    // #98：行 2（本区胶囊 + ＋）只属于 A。B/C/D 里当前那颗已经搬进顶栏，整行不占地方。
    const parts = shellParts(activeLayout(this.prefs));
    const visible = desktop && parts.sessionRow;
    host.hidden = !visible;
    this.els.sessionRow.hidden = !visible;
    if (!visible) {
      // 没有 ★ 行的壳（B/C/D、窄屏）：那颗是唯一的会话指示，照旧留着。
      this.setNowChipHidden(false);
      return;
    }
    // #127：当前会话已经在 ★ 行里露脸（那颗带主题色填充），最左那颗就不再画。
    // #189：它已经归档时也不画 —— 一颗收进「已归档」的会话不该占着行首。
    this.setNowChipHidden(shown.some((s) => s.id === this.currentId) || this.currentArchived());
    this.pillBar.render(shown, this.currentId);
  }

  /** ★ 行从左到右的那一串（#120 / #127）：本区 ★ 按 `manage.pin`；不知道本区时退回置顶列表。 */
  private starredRow(): SessionState[] {
    const pins = this.manage.pin
      .map((id) => this.sessions.find((s) => s.id === id))
      .filter((s): s is SessionState => s !== undefined && !this.manage.archived.includes(s.id));
    const cur = this.session;
    if (!cur || !this.workspaces?.groups?.length) return pins;
    const listed = this.sessions.find((x) => x.id === cur.id);
    const group = wsOf(cur, this.workspaces, listed?.ws);
    const tree = buildTree(this.sessions, this.manage, this.workspaces, this.filter);
    const mine = group ? tree.groups.find((g) => g.id === group.id) : undefined;
    return mine ? starredSessions(mine.sessions, this.manage.pin) : pins;
  }

  /** #189：当前打开的会话已经在「已归档」里。 */
  private currentArchived(): boolean {
    return this.currentId !== null && this.manage.archived.includes(this.currentId);
  }

  /**
   * #189：归档当前会话 = 归档它并离开它。只看**本次回声里刚变归档**的那批，不看「它现在是不是归档」——
   * 从「已归档」段主动点开一个归档会话是允许的状态，不能被自己这一眼踢走。
   * 落点由 `neighborAfterArchive()` 一处决定（右邻 → 左邻 → 空态），切换走唯一的 `openSession()`。
   * #191：批量归档时这一帧回声会同时带走好几颗 ★，邻居按归档之后的 ★ 行算（同批的邻居跳过）。
   */
  private switchAfterArchive(before: ReadonlySet<string>): void {
    const id = this.currentId;
    if (!id || this.session?.id !== id) return;
    if (before.has(id) || !this.manage.archived.includes(id)) return;
    // 本次回声新变归档的整批（含它自己）：批量里刚被一起收起来的那几颗不再是邻居。
    const alsoArchived = this.manage.archived.filter((x) => !before.has(x));
    // 当前会话没点 ★ 时它自己就是第 1 格（#188 的口径）：补上去，右邻不因这一格而变。
    const next = neighborAfterArchive(this.rowIds.includes(id) ? this.rowIds : [id, ...this.rowIds], id, alsoArchived);
    // #190：左右都没有邻居 → 中栏回到现成的空态，不再把一颗归档会话留在中栏。
    if (!next) {
      this.closeCurrentSession();
      return;
    }
    this.openSession(next);
    // 地址栏跟着走：不另立一套规则，直接问 `go()` —— 它按页签推 hash（会话页 → `#/s/<id>`）。
    this.go(this.tab);
  }

  /**
   * #190：★ 行里左右都没有邻居时，「归档它 = 离开它」的落点就是空态 —— `renderChat()` 里现成的
   * 「还没有打开会话 / 左边选一个，或者开一个新的」，不加文案、不改样式。
   * 草稿照存（`switchDraft(null)`），归档本身不动；之后从左侧点任意会话都能正常回去。
   */
  private closeCurrentSession(): void {
    if (!this.currentId) return;
    this.switchDraft(null);
    this.currentId = null;
    this.session = null;
    // 与 `openSession()` 换会话时清的是同一批：否则上一颗的待批 / 待答会挂进空态。
    this.resetSessionView();
    this.chat.reset([]);
    this.renderAll();
    // 地址栏回到无会话的形态：`go()` 里 currentId 为空就是 `#/`。
    this.go(this.tab);
  }

  /** #127：那颗 `NowChip` 什么时候出场 —— 只在「当前会话没出现在 ★ 行里」时。 */
  private setNowChipHidden(hidden: boolean): void {
    if (!this.nowBtn) return;
    this.nowBtn.hidden = hidden;
    if (hidden) this.nowBtn.setAttribute("aria-hidden", "true");
    else this.nowBtn.removeAttribute("aria-hidden");
  }

  /** #126：行 2 的 ★ 胶囊可左右拖、自己定顺序。只认鼠标左键（与标签行同一套，D149）。 */
  private wirePinDrag(chip: HTMLElement, id: string): void {
    chip.onpointerdown = (ev) => this.startPinDrag(ev, chip, id);
    // 拖拽尾巴的 click 不能当成「打开会话」—— 捕获阶段拦掉，PillBar 里那两颗热区收不到。
    chip.addEventListener(
      "click",
      (ev) => {
        if (!this.pinDragMoved) return;
        this.pinDragMoved = false;
        ev.stopPropagation();
        ev.preventDefault();
      },
      true,
    );
  }

  private startPinDrag(ev: PointerEvent, chip: HTMLElement, id: string): void {
    // 和标签行同一套（D149）：只认鼠标左键，触屏 / 笔不进 4px 起拖判定。
    if (ev.button !== 0 || ev.pointerType !== "mouse") return;
    const strip = this.els.pinStrip;
    if (!strip) return;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let moved = false;
    let hit: TabHit | null = null;
    let line: HTMLElement | null = null;
    this.pinDragMoved = false;

    /** 这一条里按 DOM 序排的会话 id（拖完按它算新顺序）。 */
    const local = (): string[] =>
      [...strip.querySelectorAll<HTMLElement>(".pin-chip[data-pin-id]")].map((n) => n.dataset.pinId ?? "").filter(Boolean);

    /** 其余胶囊的横向占位：拖动源自己剔掉，否则它永远吸住落点。 */
    const rects = (): TabRect[] =>
      [...strip.querySelectorAll<HTMLElement>(".pin-chip[data-pin-id]")]
        .filter((n) => n.dataset.pinId && n.dataset.pinId !== id && !n.hidden)
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { id: n.dataset.pinId ?? "", left: r.left, right: r.right };
        });

    const move = (e: PointerEvent): void => {
      if (!moved) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) <= 4) return;
        moved = true;
        this.pinDragMoved = true;
        document.getSelection()?.removeAllRanges();
        document.body.classList.add("pin-dragging");
        chip.classList.add("drag");
      }
      const box = rects();
      hit = tabHitTest(e.clientX, box);
      const at = hit ? box.find((r) => r.id === hit?.id) : undefined;
      if (!hit || !at) {
        line?.remove();
        line = null;
        return;
      }
      if (!line) {
        line = el("div", "pin-line");
        strip.append(line);
      }
      const base = strip.getBoundingClientRect();
      line.style.left = `${Math.round((hit.side === "before" ? at.left : at.right) - base.left)}px`;
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      line?.remove();
      line = null;
      document.body.classList.remove("pin-dragging");
      chip.classList.remove("drag");
    };

    const up = (): void => {
      cleanup();
      if (!moved) return;
      window.setTimeout(() => {
        this.pinDragMoved = false;
      }, 0);
      this.reorderPinned(id, local(), hit);
    };

    const cancel = (): void => cleanup();

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /**
   * #126 行 2 的胶囊能左右拖、自己定顺序。`manage.pin` 是**全局**数组（别组的 ★ 也在里面），
   * 所以只拿本区这几颗占的槽位原地重填 —— 别组的槽位一个不动，本区拖完再刷新也不会冲掉。
   * 只重排、不增删，松在原处就一个字都不发。
   */
  private reorderPinned(id: string, localIds: string[], hit: TabHit | null): void {
    if (!hit || hit.id === id || localIds.length < 2) return;
    const from = localIds.indexOf(id);
    const to = localIds.indexOf(hit.id);
    if (from < 0 || to < 0) return;
    const reordered = moveTo(localIds, id, (from < to ? to - 1 : to) + (hit.side === "after" ? 1 : 0));
    const pin = this.manage.pin;
    const slots: number[] = [];
    pin.forEach((pid, i) => {
      if (localIds.includes(pid)) slots.push(i);
    });
    if (slots.length !== reordered.length) return;
    const next = [...pin];
    slots.forEach((slot, k) => {
      next[slot] = reordered[k];
    });
    if (next.every((x, i) => x === pin[i])) return;
    this.act(() => this.socket.send({ type: "manage", action: "arrange", pin: next, order: this.manage.order }));
  }

  /* ------------------------------------------------------------------ Q-035 */

  /** 180ms 后才弹（鼠标扫过不算），离开 220ms 才收（从胶囊挪进气泡也不算）。 */
  private wirePinHover(chip: HTMLElement, s: SessionState): void {
    chip.addEventListener("pointerenter", () => this.openPinMenuSoon(chip, s));
    chip.addEventListener("pointerleave", () => this.closePinMenuSoon());
  }

  private openPinMenuSoon(chip: HTMLElement, s: SessionState): void {
    window.clearTimeout(this.pinMenuTimer);
    if (this.pinAnim || this.pinMenu?.chip === chip) return;
    this.pinMenuTimer = window.setTimeout(() => this.showPinMenu(chip, s), 180);
  }

  private closePinMenuSoon(): void {
    window.clearTimeout(this.pinMenuTimer);
    if (this.pinMenu?.handle.pinned()) return;
    this.pinMenuTimer = window.setTimeout(() => this.closePinMenu(), 220);
  }

  private closePinMenu(): void {
    window.clearTimeout(this.pinMenuTimer);
    const cur = this.pinMenu;
    if (!cur) return;
    this.pinMenu = null;
    cur.handle.close();
  }

  private showPinMenu(chip: HTMLElement, s: SessionState): void {
    if (this.pinAnim || !chip.isConnected) return;
    this.closePinMenu();
    const handle = openPinMenu(chip, {
      name: s.name || s.id,
      cwd: s.cwd,
      onArchive: () => this.archiveFromPin(s.id, chip),
      onRename: (name) => {
        this.closePinMenu();
        this.applyRename(s.id, name);
        // applyRename 只改数据、不重画（管理条那边由调用方负责），这里得自己补一次，
        // 否则胶囊还挂着旧名字直到下一次列表刷新。
        this.renderSessions();
      },
      onDelete: () => this.deleteFromPin(s.id, chip),
    });
    this.pinMenu = { handle, chip, id: s.id };
    // 指针从胶囊直接挪进气泡：中间那段空隙不能把它关了。
    handle.node.addEventListener("pointerenter", () => window.clearTimeout(this.pinMenuTimer));
    handle.node.addEventListener("pointerleave", () => this.closePinMenuSoon());
  }

  /**
   * 归档动效：胶囊压扁 → 横着滑进条尾的抽屉 → 抽屉合盖计数 +1 → 塌缩让位，然后才真的发归档。
   * 先演后发：归档是幂等的，而桥的回声会重建整条置顶条，抽屉就跟着没了。
   */
  private archiveFromPin(id: string, chip: HTMLElement): void {
    if (this.pinAnim) return;
    this.closePinMenu();
    if (this.calm()) {
      this.archiveIds([id], true);
      this.pinNote(tr("已归档 1 个 · 在左栏「已归档」里"));
      return;
    }
    const host = this.els.pinStrip;
    if (!host.contains(chip)) return;
    this.pinAnim = id;
    const ease = "cubic-bezier(.22,.68,0,1)";
    const tray = el("div", "pin-tray");
    tray.append(el("div", "pin-tray-lid"), el("div", "pin-tray-body"), el("span", "pin-tray-count", "1"));
    host.insertBefore(tray, host.querySelector(".pin-new"));
    const r = chip.getBoundingClientRect();
    const t = tray.getBoundingClientRect();
    const dx = t.left + t.width / 2 - (r.left + r.width / 2);
    const dy = t.top + t.height / 2 - (r.top + r.height / 2);
    const w = r.width;
    tray.animate([{ opacity: "0", transform: "translateY(-4px)" }, { opacity: "1", transform: "none" }], { duration: 140, easing: ease });
    const lid = tray.querySelector(".pin-tray-lid");
    lid?.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(-46deg)", offset: 0.45 }, { transform: "rotate(0deg)" }],
      { duration: 460, easing: ease },
    );
    const fly = chip.animate(
      [
        { transform: "none", opacity: "1", offset: 0 },
        { transform: "scale(1.07, .66)", opacity: "1", offset: 0.34 },
        { transform: `translate(${dx}px, ${dy}px) scale(.22, .22)`, opacity: "0", offset: 0.92 },
        { transform: `translate(${dx}px, ${dy}px) scale(.22, .22)`, opacity: "0", offset: 1 },
      ],
      { duration: 520, easing: ease, fill: "forwards" },
    );
    fly.onfinish = () => {
      tray.querySelector(".pin-tray-count")?.animate(
        [{ opacity: "0", transform: "translateX(-50%) scale(.4)" }, { opacity: "1", transform: "translateX(-50%) scale(1)" }],
        { duration: 220, easing: ease, fill: "both" },
      );
      // 塌缩让位只动这一颗胶囊：chip.parentElement 就是 .pin-strip 本身，
      // 早先版本动的就是它，结果整条缩成 24px（只剩左右 padding）并横向溢出。
      chip.animate([{ width: `${w}px` }, { width: "0px" }], { duration: 240, easing: ease, fill: "forwards" });
      window.setTimeout(() => {
        this.pinAnim = null;
        this.archiveIds([id], true);
        this.pinNote(tr("已归档 1 个 · 在左栏「已归档」里"));
      }, 240);
    };
  }

  /**
   * 删除动效：胶囊先被拿起来（fixed 克隆体），左栏自动展开露出那颗🗑，再沿弧线飞进去、桶闪一下。
   * 展开后置顶条就整条消失了（它只在左栏收起时显示），所以飞行体必须是脱离文档流的克隆。
   */
  private deleteFromPin(id: string, chip: HTMLElement): void {
    if (this.pinAnim) return;
    this.closePinMenu();
    if (this.calm()) {
      this.act(() => this.socket.send({ type: "manage", action: "delete", ids: [id] }));
      this.pinNote(tr("已移入垃圾箱 · 在左栏🗑里可以还原"));
      return;
    }
    const r = chip.getBoundingClientRect();
    const clone = chip.cloneNode(true) as HTMLElement;
    clone.classList.add("pin-flyer");
    clone.removeAttribute("data-pin-key");
    Object.assign(clone.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(clone);
    this.pinAnim = id;
    if (this.collapsed.sessions) {
      this.collapsed.sessions = false;
      writeFlag("pi.collapse.sessions", false);
      this.renderPanes();
      this.renderTop();
    }
    // 等一帧让左栏真的上屏，再量垃圾桶的位置。
    window.setTimeout(() => {
      const b = this.binBtn?.getBoundingClientRect();
      const sx = r.left + r.width / 2;
      const sy = r.top + r.height / 2;
      const tx = b ? b.left + b.width / 2 : sx;
      const ty = b ? b.top + b.height / 2 : sy + 40;
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2 + 26;
      const at = (u: number) => ({
        x: (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * mx + u * u * tx,
        y: (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * my + u * u * ty,
      });
      const frames: Keyframe[] = [0, 0.3, 0.6, 0.85, 1].map((u, i) => {
        const p = at(u);
        const scale = i === 4 ? 0.18 : 1 - 0.5 * u;
        return {
          transform: `translate(${p.x - sx}px, ${p.y - sy}px) scale(${scale}) rotate(${-10 * u}deg)`,
          opacity: i === 4 ? "0" : "1",
          offset: u,
        };
      });
      clone.animate(frames, { duration: 620, easing: "cubic-bezier(.4,0,.25,1)", fill: "forwards" }).onfinish = () => {
        clone.remove();
        this.pinAnim = null;
        this.pulseBin();
        this.act(() => this.socket.send({ type: "manage", action: "delete", ids: [id] }));
        this.pinNote(tr("已移入垃圾箱 · 在左栏🗑里可以还原"));
      };
    }, 220);
  }

  /** 「少动」偏好下不演动效，直接做那一步。 */
  private calm(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private pulseBin(): void {
    const bin = this.binBtn;
    if (!bin) return;
    bin.classList.add("hit");
    bin.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: 340, easing: "cubic-bezier(.22,.68,0,1)" });
    window.setTimeout(() => bin.classList.remove("hit"), 900);
  }

  /** 删除/归档之后一句话交代去向；不占状态行，2.6s 自己走。 */
  private pinNote(text: string): void {
    document.querySelector(".pin-note")?.remove();
    const note = el("div", "pin-note", text);
    document.body.append(note);
    note.animate([{ opacity: "0", transform: "translateY(6px)" }, { opacity: "1", transform: "none" }], { duration: 160, easing: "ease-out" });
    window.setTimeout(() => {
      note.animate([{ opacity: "1" }, { opacity: "0" }], { duration: 220, easing: "ease-out", fill: "forwards" }).onfinish = () => note.remove();
    }, 2400);
  }

  /** 左栏那颗🗑上的数字：垃圾箱里有几个，点开就是那个视图。 */
  private renderBinCount(): void {
    const bin = this.binBtn;
    if (!bin) return;
    const n = this.trash.length;
    bin.title = n ? tr("垃圾箱里 {p1} 个会话（删掉的会先进这里，可以还原）", { p1: n }) : tr("垃圾箱：删掉的会话会先进这里，可以还原");
    bin.classList.toggle("has-trash", n > 0);
    const count = bin.querySelector(".bin-count") ?? bin.appendChild(el("span", "bin-count"));
    count.textContent = n ? String(n) : "";
  }

  private renderTabs(): void {
    for (const btn of Array.from(this.els.tabs.querySelectorAll<HTMLButtonElement>("button"))) {
      const key = btn.dataset.tab as Tab;
      btn.classList.toggle("on", key === this.tab);
      const old = btn.querySelector(".pip");
      old?.remove();
      if (key === "queue" && this.approvals.length + this.asks.length) btn.append(el("span", "pip", String(this.approvals.length + this.asks.length)));
    }
  }
}

function setToggle(btn: HTMLElement, collapsed: boolean, label: string): void {
  // Expanded: the chevron points at the edge it will retract to. Collapsed: it points back out.
  const right = btn.dataset.side === "right";
  btn.textContent = collapsed ? (right ? "«" : "»") : (right ? "»" : "«");
  btn.title = collapsed ? tr("展开{p1}", { p1: label }) : tr("收起{p1}", { p1: label });
  btn.setAttribute("aria-pressed", String(collapsed));
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // private mode etc: collapsing just won't be remembered.
  }
}

type Prefs = {
  scale: number;
  accent: string;
  text: "soft" | "normal" | "bright";
  lang: Lang;
  /** 收起的工作区（#95）：组 id 列表，跟 accent 一起存在 `pi.prefs` 里，不另开 storage key。 */
  wsCollapsed: string[];
  /** 工作区布局（#97）：稳定 id（a/b/c/d），标签过 `tr()`；读口在 `layout.ts`。 */
  layout: LayoutId;
  /** #101 迁移预览只弹一次：用户点了「就这样开始」才写这个标记（取消不写，下次还弹）。 */
  wsIntroSeen: boolean;
};

/** Q-029: how long the pointer has to rest on the activity line before the detail card opens. */
/** How long the peek card must stay before it stops following the pointer (Q-029). */
const PEEK_DELAY_MS = 3000;
/** Grace after the pointer leaves, so crossing the 8px gap into the card isn't a "leave". */
const PEEK_GAP_MS = 200;

const DEFAULT_PREFS: Prefs = {
  scale: 1,
  accent: "ice",
  text: "normal",
  lang: "zh-Hans",
  wsCollapsed: [],
  layout: "a",
  wsIntroSeen: false,
};

/** Context-budget presets in the model sheet; null = no ceiling (use the window). */
const BUDGETS: (number | null)[] = [null, 100_000, 200_000, 500_000, 1_000_000];

const SVG = (body: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_ARCHIVE = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>');
const ICON_UNARCHIVE = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/>');
const ICON_TRASH = SVG('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/><path d="M9 7V4h6v3"/>');

/** `/` menu entries the page runs itself (see runBuiltinCommand), with what they do. */
const BUILTIN_COMMANDS: [string, string][] = [
  ["new", tr("开新会话")],
  ["resume", tr("到会话列表里选一个")],
  ["model", tr("选模型 / 思考档位")],
  ["thinking", tr("思考档位（/thinking high）")],
  ["name", tr("会话名（/name 新名字）")],
  ["session", tr("会话信息：用量、费用、文件")],
  ["compact", tr("压缩上下文（/compact 要保留什么）")],
  ["tree", tr("会话树：看分支、从任意消息分叉")],
  ["fork", tr("从某条消息之前分叉")],
  ["clone", tr("复制当前分支为新会话")],
  ["import", tr("导入会话文件（/import 路径）")],
  ["export", tr("导出 HTML（/export jsonl 下载原文件）")],
  ["copy", tr("复制最后一条回复")],
  ["debug", tr("这个会话的 pi 日志")],
  ["hotkeys", tr("快捷键")],
  ["settings", tr("pi 设置（全局 / 项目）")],
  ["scoped-models", tr("循环切换的模型范围")],
  ["reload", tr("重启这个会话的 pi，读到最新设置 / 扩展 / 技能")],
  ["trust", tr("项目信任：要不要加载这个目录的 .pi 配置")],
  ["changelog", tr("pi 更新日志")],
  ["share", tr("上传会话、生成查看链接（Radius 或私有 gist）")],
  ["bug", tr("给 pi 开发者提交 bug 报告（/bug 描述）")],
  ["login", tr("登录模型 provider（API key / OAuth）")],
  ["logout", tr("登出某个 provider")],
];

type SettingsTab = "global" | "project" | "trust" | "login" | "passphrase" | "ext" | "notify" | "runtime" | "changelog";

interface ExtPackage {
  scope: "user" | "project";
  source: string;
  path: string | null;
  name: string | null;
  version: string | null;
  origin: "npm" | "git" | "local";
  pinned: boolean;
  latest: string | null;
  update: boolean;
  checkError?: string;
}
interface ExtLoose {
  id: string;
  label: string;
  scope: "user" | "project" | "builtin";
  how: "builtin" | "discovered" | "listed";
  enabled: boolean;
}
interface ExtMcp {
  name: string;
  scope: string;
  source: string;
  enabled: boolean;
  exposure: string | null;
  transport: string | null;
  state: string | null;
  tools: string[];
  error: string | null;
  version: { registry: string | null; identifier: string | null; version: string | null; latest: string | null; update: boolean };
}
interface ExtInventory {
  packages: ExtPackage[];
  extensions: ExtLoose[];
  mcp: ExtMcp[];
  mcpError: string | null;
  /** Server entries pi could not parse: dropped from `mcp`, explained here. */
  mcpErrors?: string[];
  /** pi's note on the run, e.g. the project's .pi/mcp.json is ignored because the project is untrusted. */
  mcpNote?: string | null;
  updates: number;
  checkedAt: number;
  /** D113: `pi mcp list` has answered (before that, `mcp` is empty because it is still connecting). */
  mcpReady: boolean;
  /** The npm / PyPI / git answers are in: `latest` and `update` are final. */
  versionsChecked: boolean;
}

/**
 * D113: the bridge pushes the inventory in stages. A stage that has not asked the registries yet
 * reports `update: false` for every row, so keep the previous answer for rows whose version did not
 * change — otherwise a re-check would blank out the 更新 buttons it is about to confirm.
 */
function mergeInventory(prev: ExtInventory | null, next: ExtInventory): ExtInventory {
  if (!prev || next.versionsChecked) return next;
  const pkgPrev = new Map(prev.packages.map((p) => [p.source, p]));
  const mcpPrev = new Map(prev.mcp.map((m) => [`${m.source}\u0000${m.name}`, m]));
  return {
    ...next,
    packages: next.packages.map((p) => {
      const old = pkgPrev.get(p.source);
      return old && old.version === p.version ? { ...p, latest: old.latest, update: old.update, checkError: old.checkError } : p;
    }),
    mcp: next.mcp.map((m) => {
      const old = mcpPrev.get(`${m.source}\u0000${m.name}`);
      return old && old.version.version === m.version.version ? { ...m, version: old.version } : m;
    }),
  };
}
interface StorePkg {
  name: string;
  version: string;
  description: string;
  monthly: number;
  weekly: number;
  link: string;
  publisher: string | null;
}
interface McpFieldView {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default: string | null;
  template?: string | null;
}
interface McpOptionView {
  kind: "npm" | "pypi" | "oci" | "remote";
  label: string;
  identifier: string;
  version: string | null;
  url?: string;
  transport: string;
  env: McpFieldView[];
  headers: McpFieldView[];
  args: string[];
  unavailable?: string;
}
interface StoreMcpItem {
  name: string;
  title: string;
  description: string;
  version: string;
  repo: string | null;
  stars: number;
  options: McpOptionView[];
}

interface AuthProvider {
  id: string;
  name: string;
  methods: { type: "api_key" | "oauth"; label: string }[];
  configured: boolean;
  source: string | null;
  label: string | null;
  stored: "api_key" | "oauth" | null;
}

type AuthEventView =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "progress"; message: string };

interface AuthPromptView {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder: string | null;
  options: { id: string; label: string; description: string | null }[] | null;
}

interface SettingsView {
  scope: "global" | "project";
  cwd: string | null;
  path: string;
  exists: boolean;
  raw: string;
  json: Record<string, unknown> | null;
  error: string | null;
  writable: boolean;
  /** pi's own defaults, dotted keys — the bridge reads them from the installed pi package. */
  defaults?: Record<string, unknown>;
}

/** 设置文件里的一格（JSON 的形状）：叶子 + 嵌套对象 / 数组，读不出来就是 undefined。 */
type SettingsCell = string | number | boolean | null | undefined | SettingsCell[] | SettingsCellOf;
type SettingsCellOf = { [key: string]: SettingsCell };

interface TrustState {
  cwd: string;
  needed: boolean;
  saved: { path: string; decision: boolean } | null;
  fallback: "ask" | "always" | "never";
  effective: boolean;
  options: { label: string; trusted: boolean }[];
}

/**
 * Past this the inline 「（默认：…）」 under a label gets its own line instead of breaking mid-word.
 */
const DEFAULT_LABEL_WRAP_AT = 15;

/**
 * One row of the 设置 form (pi docs/settings.md); everything else via 编辑 JSON.
 *
 * `group` prints a section header above the first row of each run — the form is long enough now that
 * an ungrouped list reads as a wall. `advanced` rows go into a collapsed 「高级」 <details>, closed
 * until the user opens it (the state is remembered), because they are the ones nobody touches twice.
 */
type SettingField = {
  key: string;
  label: string;
  kind: "text" | "number" | "bool" | "select" | "list" | "model";
  options?: string[];
  /** Select labels when the stored value is not the label (permission modes, transport…). */
  choices?: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  globalOnly?: boolean;
  group?: string;
  advanced?: boolean;
  /** pi decides this one at runtime (schema has no default) — what to print instead. */
  defaultText?: string;
  /** pi's timeout settings take a number or "disabled". */
  allowDisabled?: boolean;
};

/**
 * Built per repaint instead of at module load: every label goes through `tr()`, and the language can
 * change without a reload (D110) — a frozen module-level array would keep the old language's strings.
 */
function settingFields(): SettingField[] {
  return [
  { key: "defaultModel", label: tr("默认模型"), kind: "model", group: tr("模型与思考"), defaultText: tr("自动，挑一个能用的"), hint: "defaultProvider + defaultModel" },
  { key: "defaultThinkingLevel", label: tr("默认思考档位"), kind: "select", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { key: "enabledModels", label: tr("循环切换的模型范围"), kind: "list", hint: tr("逗号分隔，支持通配（终端的 /scoped-models）"), placeholder: tr("例如 claude-*, gpt-5*"), defaultText: tr("全部可用") },
  { key: "cacheWarming", label: tr("缓存预热"), kind: "select", options: ["off", "streaming", "idle"], globalOnly: true, hint: tr("off 不预热；streaming 只在跑的时候续缓存；idle 连不跑的时候也续。省下的钱不到 $0.05 不会动手") },

  { key: "sessionDir", label: tr("会话目录"), kind: "text", group: tr("会话"), defaultText: tr("pi 的会话目录"), hint: tr("会话文件放哪。相对路径从工作目录解析，项目设置会盖过全局；改完要重启 bridge 才会按新目录列会话") },
  { key: "sessionShareDestination", label: tr("/share 发到哪"), kind: "select", options: ["auto", "gist", "radius"], hint: tr("auto = 登录了 Radius 就发 Radius，否则建 GitHub gist") },
  { key: "images.autoResize", label: tr("图片自动缩"), kind: "bool", hint: tr("上传的图先压到模型能吃的大小") },
  { key: "images.blockImages", label: tr("不给模型发图片"), kind: "bool", hint: tr("整张图换成一段说明文字，省 token 但模型看不见图") },
  { key: "enableSkillCommands", label: tr("技能注册成 /skill:名字"), kind: "bool" },

  // D161: 桥自有键（web. 命名空间），存在 pi 的 settings.json 里，读写和别的设置同一条路。
  {
    key: "web.defaultPermission",
    label: tr("新会话的默认权限"),
    kind: "select",
    group: tr("工具与脚本"),
    // Literal per repaint (not `PERM_MODES`): that table is module-level, so its labels freeze the
    // first language — the same mode ids, translated now, when the language changes without a reload.
    choices: [
      { value: "readonly", label: tr("只读") },
      { value: "strict", label: tr("逐个确认") },
      { value: "ask", label: tr("危险时确认") },
      { value: "auto", label: tr("全自动") },
    ],
    defaultText: tr("危险时确认"),
    hint: tr("新会话第一次打开时用它，之后在这里改也不影响老会话；手动改过权限的会话永远不动"),
  },
  { key: "defaultTools", label: tr("默认工具"), kind: "list", group: tr("工具与脚本"), hint: tr("逗号分隔；普通名字＝只用这些，+x / -x＝在默认基础上增减"), placeholder: tr("例如 read, bash, +codemode") },
  { key: "codemode.mode", label: tr("codemode 工具模式"), kind: "select", options: ["on", "only"], hint: tr("on = 已声明的工具照常直接调；only = 只留 codemode，所有工具都从脚本里调") },
  { key: "codemode.inlineBudget", label: tr("codemode 工具清单预算"), kind: "number", hint: tr("最多花多少 token（字符数 ÷ 4）列工具；挤不下的靠 searchTools 找，0 = 只列命名空间") },
  { key: "shellPath", label: tr("shell 路径"), kind: "text", defaultText: tr("按平台自动找"), hint: tr("bash 工具用的 shell（Windows 默认找 Git Bash）") },

  { key: "steeringMode", label: tr("引导消息处理方式"), kind: "select", group: tr("消息与压缩"), options: ["one-at-a-time", "all"], hint: tr("一条一条交给模型，还是攒着一次给") },
  { key: "followUpMode", label: tr("排到之后的消息处理方式"), kind: "select", options: ["one-at-a-time", "all"] },
  { key: "compaction.enabled", label: tr("自动压缩"), kind: "bool" },
  { key: "compaction.reserveTokens", label: tr("压缩：保留的空余 token"), kind: "number" },
  { key: "compaction.keepRecentTokens", label: tr("压缩：保留最近的 token"), kind: "number" },

  { key: "transport", label: tr("流式通道"), kind: "select", group: tr("网络与重试"), options: ["auto", "sse", "websocket", "websocket-cached"], hint: tr("auto 让 pi 自己挑；provider 不支持就会退回 SSE") },
  { key: "httpProxy", label: tr("HTTP 代理"), kind: "text", globalOnly: true, placeholder: "http://127.0.0.1:7890", defaultText: tr("直连") },
  { key: "retry.enabled", label: tr("自动重试"), kind: "bool" },
  { key: "retry.maxRetries", label: tr("最多重试次数"), kind: "number" },

  { key: "enableInstallTelemetry", label: tr("安装/更新匿名上报"), kind: "bool", group: tr("隐私与信任"), hint: tr("不控制更新检查，只控制那条安装/更新记录") },
  { key: "enableAnalytics", label: tr("分析数据共享"), kind: "bool", hint: tr("目前只有实验性的首次设置会用到") },
  { key: "defaultProjectTrust", label: tr("没有决定时的项目信任"), kind: "select", options: ["ask", "always", "never"], globalOnly: true, hint: tr("网页里 ask 等于 never（不能弹提示）") },

  { key: "shellCommandPrefix", label: tr("命令前缀"), kind: "text", advanced: true, hint: tr("拼在每条 shell 命令前面，例如 source ~/.bashrc &&") },
  { key: "npmCommand", label: tr("npm 命令"), kind: "list", advanced: true, hint: tr("装扩展/查包时用的命令与参数，逗号分隔") },
  { key: "selfUpdateCommand", label: tr("自我更新命令"), kind: "list", globalOnly: true, advanced: true, hint: tr("「更新 pi」按钮跑的命令，逗号分隔，支持 {packageName} {version} {installSpec}；留空用 pi 自己的") },
  { key: "httpIdleTimeoutMs", label: tr("HTTP 空闲超时"), kind: "number", advanced: true, allowDisabled: true, hint: tr("多久没收到字节就断开（毫秒），填 disabled 关掉") },
  { key: "websocketConnectTimeoutMs", label: tr("WebSocket 连接超时"), kind: "number", advanced: true, allowDisabled: true, hint: tr("毫秒，填 disabled 关掉") },
  { key: "retry.baseDelayMs", label: tr("重试起始等待"), kind: "number", advanced: true, hint: tr("毫秒，指数退避的起点") },
  { key: "retry.maxAgentDelayMs", label: tr("重试最长等待"), kind: "number", advanced: true, hint: tr("毫秒，退避的上限") },
  { key: "retry.provider.timeoutMs", label: tr("provider 单次超时"), kind: "number", advanced: true, defaultText: tr("跟随 HTTP 空闲超时"), hint: tr("毫秒") },
  { key: "retry.provider.maxRetries", label: tr("provider 级重试次数"), kind: "number", advanced: true, hint: tr("保持默认 0，除非 provider 明确要求：它会把配额/限流错误拖慢") },
  { key: "retry.provider.maxRetryDelayMs", label: tr("provider 请求的最长等待"), kind: "number", advanced: true, hint: tr("毫秒，0 = 不限制") },
  ];
}

/**
 * The composer's placeholder is its shortcut card: these are the only keys it has (Shift+Enter
 * used to be mentioned once and then overwritten by the bare 「说点什么…」 on the next repaint).
 */
const IDLE_PLACEHOLDER = tr("Enter 发送 · Shift+Enter 换行");
const RUNNING_PLACEHOLDER = tr("跑着呢：Enter 引导当前任务 · Alt+Enter 等这轮做完再处理 · Shift+Enter 换行");
const ASK_PLACEHOLDER = tr("直接打字回答当前题（Enter 作答 · Shift+Enter 换行），或点上面的选项");

/** pi built-in commands the page cannot run yet → the issue that tracks them (#22). */
const UNSUPPORTED_BUILTINS: Record<string, string> = {};

/** Everything a shortcut can fire, in the order the 快捷键 sheet lists it. */
const SHORTCUTS: { id: string; label: string }[] = [
  { id: "new", label: tr("开新会话") },
  { id: "manage", label: tr("会话管理（含垃圾箱）") },
  { id: "sessions", label: tr("收起 / 展开左栏") },
  { id: "queue", label: tr("收起 / 展开右栏") },
  { id: "artifacts", label: tr("产物列表") },
  { id: "files", label: tr("文件管理器") },
  { id: "notes", label: tr("bug 记录") },
  { id: "look", label: tr("字号与配色") },
  { id: "skills", label: tr("技能面板") },
  { id: "attach", label: tr("附加文件") },
  { id: "terminal", label: tr("打开终端") },
  { id: "interrupt", label: tr("中断当前回复") },
];

/** 出厂就带的组合键；用户改过的以 localStorage 里的为准。 */
const DEFAULT_KEYS: Record<string, string> = { notes: "ctrl+shift+b" };

/** The browser owns these; a page must never swallow them. */
const RESERVED_KEYS = new Set([
  "ctrl+w",
  "ctrl+r",
  "ctrl+t",
  "ctrl+n",
  "ctrl+l",
  "ctrl+p",
  "ctrl+s",
  "ctrl+o",
  "ctrl+shift+i",
  "ctrl+shift+j",
  "ctrl+shift+c",
  "ctrl+shift+delete",
  "meta+w",
  "meta+r",
  "meta+t",
  "meta+n",
  "meta+l",
  "meta+q",
  "alt+f4",
  "alt+left",
  "alt+right",
  "f1",
  "f5",
  "f11",
  "f12",
]);
const MOD_KEY_NAMES = new Set(["control", "shift", "alt", "meta", "os", "altgraph"]);

/** “ctrl+shift+k” for a keydown, or null for a bare modifier press. */
function comboOf(ev: KeyboardEvent): string | null {
  const raw = ev.key;
  if (!raw || MOD_KEY_NAMES.has(raw.toLowerCase())) return null;
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push("ctrl");
  if (ev.altKey) parts.push("alt");
  if (ev.shiftKey) parts.push("shift");
  if (ev.metaKey) parts.push("meta");
  parts.push(raw === " " ? "space" : raw.toLowerCase());
  return parts.join("+");
}

/** Modifier combos, plus bare F2–F10 — the one bare-key class this page accepts. */
function shortcutAllowed(combo: string): boolean {
  if (RESERVED_KEYS.has(combo)) return false;
  const parts = combo.split("+");
  if (parts.length > 1) return true;
  return /^f([2-9]|10)$/.test(parts[0] ?? "");
}

/** “Ctrl+Shift+K” for display. */
/** 把一个数夹进 [min, max]；max 比 min 还小时取 min（窗口比 dialog 还窄时不出现负尺寸）。 */
function clampNum(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(Math.max(min, max), value)));
}

function keyLabel(combo: string): string {
  return combo
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+");
}

function loadKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem("pi.keys");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const { id } of SHORTCUTS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === "string" && shortcutAllowed(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function saveKeys(keys: Record<string, string>): void {
  try {
    localStorage.setItem("pi.keys", JSON.stringify(keys));
  } catch {
    // storage blocked or full: the bindings still work until the next reload
  }
}

/**
 * ICON_* strings become real SVG nodes here. Building them through DOMParser keeps innerHTML out of
 * the picture entirely, so an icon string can never be an injection path (the constants are nested
 * in the bundle and a stray `<script>` would otherwise be parsed as markup).
 */
function iconNodes(svg: string): Element[] {
  // The HTML fragment parser is what puts `<svg>` into the SVG namespace. DOMParser with
  // "image/svg+xml" handed back a null-namespace element here, and a null-namespace `svg` renders
  // as an unknown inline element — invisible, only an empty button was left behind.
  return [...document.createRange().createContextualFragment(svg).children];
}

/** A button's face: SVG markup becomes an icon, anything else (★ / ☆) stays text. */
function glyph(src: string): Node {
  if (src.trimStart().startsWith("<")) {
    const first = iconNodes(src)[0];
    if (first) return first;
  }
  return document.createTextNode(src);
}

/** Opens a link in a new tab, but only if it stays on this origin (previews are same-origin /raw/…). */
/** 外链只放行 http(s)，并且始终交给一个带 rel=noopener 的真链接去开（和 openSameOrigin 同一个理由）。 */
function openExternal(url: string): void {
  const safe = safeExternalUrl(url);
  if (!safe) return;
  const a = document.createElement("a");
  a.href = safe;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
}

function openSameOrigin(url: string): void {
  const target = new URL(url, location.href);
  if (target.origin !== location.origin) return;
  // A real anchor with rel=noopener does the same job as window.open without handing the URL to a
  // navigation sink: the origin check above is the gate, this is just the click.
  const a = document.createElement("a");
  a.href = target.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.click();
}

/**
 * 字号：一根连续滑杆（0.8–2.0，步长 1%），不再是四颗 chip。
 *
 * 老的四档没消失，改行「轨上的刻度」：`SIZE_STOPS` 既是刻度字的位置，也是磁吸点 ——
 * 指针拖到 ±1.2% 以内会吸上去，点刻度直接落档。键盘不吃磁吸（每按一下是 1%，吸了会永远卡在刻度上）。
 * 取舍与样张见 `.scratch/font-slider/`，D 记录见 docs/DECISIONS.md。
 */
const SIZE_MIN = 0.8;
const SIZE_MAX = 2;
const SIZE_STEP = 0.01;
const SIZE_STOPS = [0.9, 1, 1.12, 1.25];
/** 磁吸半径：0.012 = 1.2%，在 480px 的轨上大约 5px。 */
const SIZE_SNAP = 0.012;

/** 值 → 轨道位置 0..1（两端夹住，浮点误差不会把填充画到轨外）。 */
const sizePct = (v: number): number => Math.min(1, Math.max(0, (v - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)));

/** 拖到老档位附近就吸上去。只有指针拖动走这里（原因见 SIZE_STOPS 上面）。 */
const snapSize = (v: number): number => {
  for (const s of SIZE_STOPS) if (Math.abs(v - s) < SIZE_SNAP) return s;
  return v;
};

/** 夹进 0.8–2.0 并取两位小数：prefs 里只存得下这种值（滑杆的 step 就是 1%）。 */
const clampScale = (v: number): number => Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) * 100) / 100;

/**
 * 设置里每颗布局 chip 的那张小示意图（46×30，纯 CSS 画的块）。不引图片：设置面板要能离线
 * 打开，也不想为四张缩略图多一条资源路径。画的是「行 / 列怎么摆」，不追求像素级复刻。
 */
function layoutDemo(id: LayoutId): HTMLElement {
  const box = el("span", `layout-demo layout-${id}`);
  box.setAttribute("aria-hidden", "true");
  const bar = (cls: string, cells = 0): HTMLElement => {
    const node = el("span", cls);
    for (let i = 0; i < cells; i += 1) node.append(el("span", "ld-cell"));
    box.append(node);
    return node;
  };
  bar("ld-top");
  if (id === "a") {
    bar("ld-row ld-row-tabs", 3);
    bar("ld-row ld-row-chips", 4);
    bar("ld-body");
  } else if (id === "b") {
    bar("ld-row ld-row-one", 4);
    bar("ld-body");
  } else if (id === "c") {
    bar("ld-rail", 3);
    bar("ld-body-wide");
  } else {
    bar("ld-icons", 4);
    for (let i = 0; i < 3; i += 1) box.append(el("span", "ld-line"));
    bar("ld-body-wide");
  }
  return box;
}

/**
 * Accent pairs live in `palette.ts` because the workspace colour dot (#96) picks from the same six.
 * Keys are stable ids — they are persisted in `pi.prefs`, so they must not be translated; the
 * tooltip goes through `ACCENT_LABELS` + `tr()`. Older builds stored the Chinese colour names:
 * `LEGACY_ACCENTS` is the migration `readPrefs` uses, and deleting it would silently reset
 * everyone's colour.
 */

/** 色块的显示名（中文原文，交给 tr() 翻）：顺序就是面板里色块的顺序。 */
const ACCENT_LABELS: [string, string][] = [
  ["ice", tr("冰蓝")],
  ["teal", tr("青绿")],
  ["violet", tr("紫")],
  ["amber", tr("琥珀")],
  ["rose", tr("玫瑰")],
  ["slate", tr("银灰")],
];

/** D110 之前 `pi.prefs.accent` 存的是中文色名，读到就换成新 id。 */
const LEGACY_ACCENTS: Record<string, string> = {
  冰蓝: "ice",
  青绿: "teal",
  紫: "violet",
  琥珀: "amber",
  玫瑰: "rose",
  银灰: "slate",
};

const TEXT_STEPS: [Prefs["text"], string][] = [
  ["soft", tr("柔和")],
  ["normal", tr("标准")],
  ["bright", tr("明亮")],
];

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem("pi.prefs");
    if (!raw) return { ...DEFAULT_PREFS, lang: detectLang() };
    const p = JSON.parse(raw);
    const scale = Number(p?.scale);
    const accent = LEGACY_ACCENTS[String(p?.accent)] ?? String(p?.accent);
    return {
      // 滑杆是连续的：只夹范围、留两位小数（老的 0.9 / 1 / 1.12 / 1.25 原样还能读回来）。
      scale: Number.isFinite(scale) && scale > 0 ? clampScale(scale) : DEFAULT_PREFS.scale,
      accent: ACCENTS[accent] ? accent : DEFAULT_PREFS.accent,
      text: TEXT_STEPS.some(([k]) => k === p?.text) ? (p.text as Prefs["text"]) : DEFAULT_PREFS.text,
      // 没存过语言（第一次打开、或老版本升上来）就跟着浏览器走。
      lang: isLang(p?.lang) ? p.lang : detectLang(),
      wsCollapsed: Array.isArray(p?.wsCollapsed) ? p.wsCollapsed.filter((x: unknown): x is string => typeof x === "string") : [],
      // #97：布局走 layout.ts 的读口（它自己处理乱值 / 大小写），这里不再写一遍白名单。
      layout: layoutPref(p),
      wsIntroSeen: p?.wsIntroSeen === true,
    };
  } catch {
    return { ...DEFAULT_PREFS, lang: detectLang() };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem("pi.prefs", JSON.stringify(prefs));
  } catch {
    // private mode: settings just won't be remembered.
  }
}

type ViewerPane = "browse" | "preview" | "edit";

/** D70: one open shell — its xterm, its body, its tab button. */
interface TermTab {
  id: string;
  shell: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  body: HTMLElement;
  tab: HTMLButtonElement;
}

/** D93: 终端 dialog 的几何，一律用「布局 px」（`#app` 的 zoom 之前的值），存在 `pi.termGeom`。 */
interface TermGeom {
  l?: number;
  t?: number;
  w?: number;
  h?: number;
}

/** 一次拖拽开始时的快照（同上，布局 px）。 */
interface TermBox {
  l: number;
  t: number;
  w: number;
  h: number;
}

/** 浏览器里能改的上限；桥端 `preview.ts` 的 MAX_EDIT_BYTES 必须与它一致。 */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

interface Viewer {
  root: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  sessionId: string;
  path: string;
  info: PreviewInfo | null;
  error: string;
  text: string | null;
  mode: "render" | "source";
  full: boolean;
  /** 浏览（走目录）/ 预览（现有五种 kind）/ 编辑（文本写回，D50）。 */
  pane: ViewerPane;
  /** 编辑中的草稿；重绘时用它而不用磁盘上那份。 */
  draft: string | null;
  dirty: boolean;
  /** 浏览态停在哪；下次打开接着来。 */
  lastDir: string;
  /** 409 冲突说明，有值就显示冲突条。 */
  conflict: string | null;
  /** 当前挂着的 html iframe；只看它发来的 postMessage（D63）。 */
  frame: HTMLIFrameElement | null;
  /** iframe 里**实际显示**的文件与它当初用哪个 token 取的。导航后两者都会变，
   *  所以不能拿 v.info 现算（D63）。 */
  framePath: string;
  frameToken: string;
  /** 外链 / 越界占位：这一格没法在应用里预览，只给个出口。 */
  ext: { url: string; label: string } | null;
  /** 回到一步 html 预览时要回放的滚动位置，等 iframe load 再发（D63）。 */
  pendingScroll: number;
}

/** 预览历史里的一步（D63）。`path` 为空表示「外链 / 越界」这种应用里打不开的地方。 */
interface VStep {
  path: string | null;
  /** 外链占位项：记下当时的 url，前进回来时给个出口。 */
  url?: string;
  label?: string;
  /** 离开这一步时滚到哪儿，返回时回放。 */
  y?: number;
}

const PERM_MODES: { id: PermissionMode; icon: string; label: string; desc: string }[] = [
  { id: "readonly", icon: "🔒", label: tr("只读"), desc: tr("只放行读文件 / 搜索 / 列目录这类只看的工具，写文件、执行命令、MCP 与扩展工具一律拦下（适合先出方案）") },
  { id: "strict", icon: "✋", label: tr("逐个确认"), desc: tr("写文件、执行命令、调用 MCP / 扩展工具都要你批准；只看的工具不用") },
  { id: "ask", icon: "🛡", label: tr("危险时确认"), desc: tr("只拦删除、push、装依赖、写项目外文件等危险操作（默认）") },
  { id: "auto", icon: "⚡", label: tr("全自动"), desc: tr("不拦截任何操作，风险自负") },
];

type PermMode = (typeof PERM_MODES)[number];

/** One mode by id; an id a stale file names falls back to pi's default (`ask`, D161). */
function permMode(id: string): PermMode {
  for (const m of PERM_MODES) if (m.id === id) return m;
  for (const m of PERM_MODES) if (m.id === "ask") return m;
  // Unreachable: the literal above always contains `ask`.
  return { id: "ask", icon: "🛡", label: tr("危险时确认"), desc: "" };
}

type PendingImage = { data: string; mimeType: string };
type PasteBlock = { text: string; open: boolean };
type Draft = { text: string; images: PendingImage[]; pastes: PasteBlock[] };

/** A paste this long (lines or characters) becomes its own foldable block. */
const PASTE_LINES = 6;
const PASTE_CHARS = 400;

/** D163: 附件弹层按会话记目录，最多留这么多条（删掉的会话不该一直占着键）。 */
const ATTACH_DIR_INDEX = "pi.attachDir.index";
const ATTACH_DIR_KEEP = 30;

/** 预览返回栈最多记多少步（D63）。超了就丢掉最早的一步，和浏览器一样。 */
const HISTORY_MAX = 60;

function loadDrafts(): Map<string, Draft> {
  const map = new Map<string, Draft>();
  try {
    const raw = JSON.parse(localStorage.getItem("pi.drafts") ?? "[]");
    if (Array.isArray(raw)) {
      for (const [id, text, pastes] of raw) {
        if (typeof id !== "string" || typeof text !== "string") continue;
        const blocks = Array.isArray(pastes) ? pastes.filter((p): p is string => typeof p === "string").map((p) => ({ text: p, open: false })) : [];
        map.set(id, { text, images: [], pastes: blocks });
      }
    }
  } catch {
    /* corrupt: start clean */
  }
  return map;
}

function rawUrl(info: PreviewInfo): string {
  return `/raw/${info.token}/${info.rel}`;
}

/** A link inside a previewed document is relative to that document, not to the session cwd. */
function resolveFrom(docAbs: string, p: string): string {
  let target = p;
  try {
    target = decodeURIComponent(p);
  } catch {
    /* keep */
  }
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/") || target.startsWith("\\")) return target;
  const sep = docAbs.includes("\\") ? "\\" : "/";
  const dir = docAbs.slice(0, Math.max(docAbs.lastIndexOf("\\"), docAbs.lastIndexOf("/")));
  return `${dir}${sep}${target.replace(/[\\/]/g, sep)}`;
}

/** 页面里的外链只认 http(s)：`javascript:` / `file:` / 自定义协议一律当没给。 */
/** 同一个文件的两种写法（\\ 与 /）算同一份。 */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = (b ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return na !== "" && na === nb;
}

function safeExternalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.href;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host || raw.slice(0, 80);
  } catch {
    return raw.slice(0, 80);
  }
}

/** `/raw/<token>/<rel>` 里的 rel 换成绝对路径（root 来自 PreviewInfo，D63）。 */
function absFromRel(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  let out = root.replace(/[\\/]+$/, "");
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      out = out.replace(/[\\/][^\\/]+$/, "");
      continue;
    }
    out += sep + seg;
  }
  return out;
}

function previewIcon(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(md|markdown|mdx)$/.test(ext)) return "📝";
  if (/^html?$/.test(ext)) return "🌐";
  if (/^(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/.test(ext)) return "🖼";
  return "📄";
}

/** Last segment of a path, for a tab label ("pwsh · pi-web-client"). */
const shortDir = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 运行时面板里的一行「闲了多久」（D120 / #77）：秒 / 分 / 时三个粒度就够，单位走词典。 */
function idleLabel(ms: number): string {
  if (ms < 60_000) return tr("{p1} 秒", { p1: fmtNum(Math.max(0, Math.round(ms / 1000))) });
  if (ms < 3_600_000) return tr("{p1} 分钟", { p1: fmtNum(Math.round(ms / 60_000)) });
  return tr("{p1} 小时", { p1: fmtNum(Math.round(ms / 3_600_000)) });
}

/** D120 / #78：运行时阈值的两个单位。GB 与 `fmtSize` 同一套（1024 进制）。 */
const MINUTE_MS = 60_000;
const GB = 1024 ** 3;

/**
 * 面板上的一个阈值输入（单位 → 毫秒 / 字节）。空、非数字、0、负数都不算数：它们会把阈值变成
 * 「立刻回收」，比旧值糟糕得多。
 */
function thresholdOf(text: string, unit: number): number | null {
  const raw = text.trim();
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) && value > 0 ? Math.round(value * unit) : null;
}

/** 输入框里显示的当前值：没有必要的小数就不写（30 / 2.5，而不是 30.00）。 */
function plainNumber(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** 阈值输入框正在被输入时，别让 tick 广播把面板重画掉（换掉 DOM 就是丢光标、丢草稿）。 */
function runtimeThresholdFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest(".runtime-threshold"));
}

/**
 * 「全部休眠」的回执说人话（D120 / #80）：睡了几个，以及**点名**哪几个还在跑 —— 用户得能确认
 * 自己没有把任务弄丢，而不是看到一个「完成」。
 */
function sleepAllText(receipt: SleepAllReceipt): string {
  const names = receipt.skipped.map((s) => s.name || s.id).join(tr("、"));
  const slept = receipt.slept.length;
  if (!slept && !names) return tr("没有可以休眠的会话：本来就都是空的。");
  if (!names) return tr("已休眠 {p1} 个会话。", { p1: slept });
  if (!slept) return tr("一个都没睡：{p1} 还在跑，没有动。", { p1: names });
  return tr("已休眠 {p1} 个会话；{p2} 还在跑，没有动。", { p1: slept, p2: names });
}

function viewerLoading(text: string): HTMLElement {
  const box = el("div", "viewer-msg");
  box.append(el("span", "act-spin"), el("span", "", text));
  return box;
}

type TimeBucket = "today" | "week" | "older";

interface MgrView {
  q: string;
  origin: "all" | "web" | "cli";
  status: "all" | "active" | "pin" | "normal" | "archived";
  time: "all" | TimeBucket;
  cwd: string;
  group: "none" | "cwd" | "origin" | "status" | "time";
  sort: "updated" | "created" | "name" | "cwd";
  desc: boolean;
}

function defaultMgrView(): MgrView {
  return { q: "", origin: "all", status: "all", time: "all", cwd: "", group: "none", sort: "updated", desc: true };
}

function loadMgrView(): MgrView {
  try {
    const raw = JSON.parse(localStorage.getItem("pi.mgr") ?? "null");
    if (raw && typeof raw === "object") return { ...defaultMgrView(), ...raw };
  } catch {
    /* corrupt or unavailable */
  }
  return defaultMgrView();
}

function loadCollapsedGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("pi.mgrCollapsed") ?? "[]");
    if (Array.isArray(raw)) return raw.filter((k): k is string => typeof k === "string");
  } catch {
    /* corrupt or unavailable */
  }
  return [];
}

/** 本周 starts on Monday, local time. */
function timeBucket(ts: number): TimeBucket {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (ts >= day.getTime()) return "today";
  const monday = new Date(day);
  monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return ts >= monday.getTime() ? "week" : "older";
}

/** First `max` characters of a single line, with an ellipsis when it had to be cut. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The tail of a stream: what just scrolled by matters, the beginning rarely does. */
function tailText(text: string, maxLines: number, maxChars: number): string {
  const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim());
  if (!lines.length) return "";
  let tail = lines.slice(-maxLines).join("\n");
  if (tail.length > maxChars) tail = `…${tail.slice(-maxChars)}`;
  return tail;
}

/** 会话列表的时间戳：一分钟内「刚刚」，其余交给 Intl（D110）。 */
function relativeTime(ts: number): string {
  return fmtRelative(ts);
}

/** 刻度尺的步长（分钟）：挑一个让格子数落在 2–11 之间的，再长就上台阶。 */
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240];

/** 跑了多久，写成 m:ss（过一小时是 h:mm:ss）—— 只进刻度尺的 tooltip，不占版面。 */
function clockText(totalSecs: number): string {
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * 一把刻度尺：一条 1px 竖线是一格，格子攒得越多说明跑得越久，最右那条是「现在」。
 * 位置等距铺满卡片宽度、不按时间比例画 —— 那会变成一根永远不满的进度条，而进度条会被读成
 * 「快完成了」，agent 跑多久并没有完成度可言。密度本身就是读数，具体时长留在 tooltip。
 */
function drawRuler(node: HTMLElement, since: number): void {
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const mins = secs / 60;
  const step = RULER_STEPS.find((x) => mins / x <= 11) ?? 240;
  const marks = Math.floor(mins / step);
  node.title = tr("已经跑了 {p1}", { p1: clockText(secs) });
  const key = `${step}/${marks}`;
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.replaceChildren(...Array.from({ length: marks + 1 }, (_, i) => el("i", i === marks ? "now" : "")));
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** "⌘V" on Apple hardware, "Ctrl+V" everywhere else. */
const PASTE_KEY = /Mac|iPhone|iPad|iPod/.test(`${navigator.platform} ${navigator.userAgent}`) ? "⌘V" : "Ctrl+V";

/**
 * 从剪贴板里抖出文件（截图、从资源管理器复制的文件）。截图粘贴在 Chrome/Safari/Firefox 上都以
 * file item 出现，但 Safari 有时只给 files 不给 items，所以两条路都试。
 */
function pastedFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  if (!out.length) out.push(...Array.from(data.files ?? []));
  return out;
}

/** Images keep going to the model as pixels; every other file is referenced by path. */
function splitImages(files: File[]): { images: File[]; others: File[] } {
  const images: File[] = [];
  const others: File[] = [];
  for (const f of files) (f.type.startsWith("image/") ? images : others).push(f);
  return { images, others };
}

/** Picked files with these extensions get attached like a pasted image instead of inserted as a path. */
const ATTACH_IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** #106: 表格类文件即使读不了（.xls/.ods/加密包），也用「这个格式这里不支持」而不是通用二进制文案。 */
const WORKBOOK = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;

/** SVG has no pixels: render it through an <img> (scripts never run there) onto a canvas. */
async function rasterizeSvg(file: File): Promise<ImageBitmap | null> {
  const url = URL.createObjectURL(file.type ? file : new Blob([file], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      w = 1024;
      h = 1024;
    }
    const scale = Math.max(1, 1024 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // jpeg has no alpha; transparent svg strokes would vanish on black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downscale(file: File, bitmap: ImageBitmap | null): Promise<{ data: string; mimeType: string }> {
  const max = 2048;
  if (!bitmap) {
    const buf = await file.arrayBuffer();
    return { data: btoa(String.fromCharCode(...new Uint8Array(buf))), mimeType: file.type || "image/png" };
  }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  return { data: dataUrl.split(",")[1], mimeType: "image/jpeg" };
}

/** "Deepseek-V4.1-Flash · x0.11 · 1M" -> "Deepseek-V4.1-Flash": the chip has no room for pricing. */
function shortModelName(name: string): string {
  return name.split(" · ")[0] ?? name;
}

/** 192000 -> "192K", 1000000 -> "1M". */
function compactSize(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}K`;
}
