import { askQuestions, parseAskResult } from "./ask-result.ts";
import { diagnose, excerpt, LEVEL_LABEL, normalize, type FailureInput } from "./diagnose.ts";
import { reviewBody, reviewDisplay } from "./failures.ts";
import { highlightFragment } from "./highlight.ts";
import { renderMarkdown } from "./md.ts";
import { fillUserBody } from "./skill.ts";
import { mountTurnRail, type TurnRail } from "./turns.ts";
import type { BashItem, Item, SessionHistory, SkillItem, ToolItem, UserItem } from "./types.ts";
import { fmtTime, tr } from "./i18n/index.ts";

/** Characters of a running `!cmd` output kept on screen (the bridge keeps the same tail). */
const BASH_SHOW = 20000;
/**
 * 离底多少像素以内算「已经在底部」（D54）。同一道容差也用来判断「下面还有没有东西」
 * （`hasRoomBelow`，D168）——两处必须是同一个数，否则会出现「钮说下面有东西、但滚不动」的缝。
 */
const BOTTOM_SLACK = 24;

/**
 * 「这一轮」在聊天区里的现场：工具模块（`details` + 标题 + 产物行 + 「AI 执行失败」那一页）。
 * #220 往前插一页时要先收起来、插完再放回去 —— 插进来的历史条目会自己开关模块、记失败，
 * 那些属于老的那一轮，不能算到用户正在看的这一轮头上。
 */
interface TurnState {
  opsBody: HTMLElement | null;
  opsTitle: HTMLElement | null;
  opsBox: HTMLDetailsElement | null;
  opsFiles: HTMLElement | null;
  turnFails: Array<{ key: string; input: FailureInput }>;
  /** 本轮已经建出来的技能组；翻页插历史时指针也得一起收走，否则老条目会被追加进来。 */
  skillGroup: SkillGroup | null;
}

/**
 * 一轮里自动加载的技能合成一个折叠组（用户要求）：不展开时永远只有一行 ——「自动加载 N 个技能 ·
 * 名字…」，点开才是每张技能卡的全文。组落在本轮第一张技能卡的位置，后续同类卡追加进来，
 * 摘要行跟着刷新；换一条用户消息就是新一轮，指针清空。
 */
interface SkillGroup {
  body: HTMLElement;
  count: HTMLElement;
  names: HTMLElement;
  skillNames: string[];
}

/**
 * 桥注入的自动提醒（`bridge/src/lessons.ts` 的 `reminderText`）开头就是这个标记。
 * 它必须是 ASCII：界面语言换掉的是抬头的字，「这是一条提醒」得靠一个不随语言变的东西认出来。
 */
const REMIND_MARK = "[pi-web:remind]";

/** 提醒正文（去掉标记）；不是提醒就返回 null。 */
function reminderBody(text: string): string | null {
  if (!text.startsWith(REMIND_MARK)) return null;
  return text.slice(REMIND_MARK.length).replace(/^\s+/, "");
}

/** 刻度带上一行的截断长度，与桥的 `TURN_TEXT_MAX`（`bridge/src/history.ts`）对齐 —— 同一轮载入前后，tooltip 得是同一句。 */
const TURN_LABEL_MAX = 80;

/** 一轮用户输入在刻度带上的文字：正文折成一行；没字就说图片 / 空消息（#242 的索引里也是这套说法）。 */
function turnLabel(text: string, images: number): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  if (one) return one.length > TURN_LABEL_MAX ? `${one.slice(0, TURN_LABEL_MAX - 1)}…` : one;
  return images ? tr("（{p1} 张图片）", { p1: images }) : tr("（空消息）");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** #375：Anthropic 拒绝被改动的 thinking 块时的报错。 */
const THINKING_MODIFIED_RE = /`?(?:redacted_)?thinking`? or `?redacted_thinking`? blocks .*cannot be modified/i;

/** Tools whose summary is a shell command — those get coloured. */
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "pwsh", "run_command", "exec", "execute", "cmd", "sh"]);

/**
 * Highlight `text` into `node` under `label` (a fence alias or a file name); false when the highlighter
 * declines (unknown language, too big) and the caller should fall back to plain text.
 */
function highlightAs(node: HTMLElement, text: string, label: string): boolean {
  const frag = highlightFragment(text, label);
  if (!frag) return false;
  node.classList.add("hl");
  node.replaceChildren(frag);
  return true;
}

/** One line of shell on a tool card: coloured when it really is a command, plain otherwise. */
function setCommand(node: HTMLElement, text: string, tool: string | undefined): void {
  if (tool && SHELL_TOOLS.has(tool.toLowerCase()) && text.length <= 4000 && highlightAs(node, text, "bash")) return;
  node.textContent = text;
}

/**
 * Tool output is arbitrary (logs, JSON, csv…), so only a unified diff earns colours — that is the
 * case where highlighting actually helps you read it. Everything else stays plain text.
 */
function setOutput(node: HTMLElement, text: string): void {
  const head = text.slice(0, 2000);
  const diff = /^(?:diff --git |@@ |\+\+\+ |--- )/m.test(head);
  if (diff && text.length <= 20_000 && highlightAs(node, text, "diff")) return;
  node.textContent = text;
}

function timeOf(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : fmtTime(d);
}

/**
 * Q-016: one fold trigger for the whole transcript. The history used to carry five shapes — a text
 * button in the top-right, a text button under the content, a bare chevron, another bare chevron and
 * a summary with no arrow at all. Same chevron, same place, same label now; each owner keeps its own
 * state machine (`this.collapsed`, the `folded` class, `<details open>`), only the trigger is shared.
 */
function foldHead(cls = ""): HTMLButtonElement & { setOpen(open: boolean): void } {
  const head = el("button", cls ? `fold-head ${cls}` : "fold-head") as HTMLButtonElement & {
    setOpen(open: boolean): void;
  };
  head.type = "button";
  const label = el("span", "fold-label", tr("展开"));
  head.append(el("span", "chev", "▸"), label);
  head.setOpen = (open: boolean) => {
    head.setAttribute("aria-expanded", String(open));
    label.textContent = open ? tr("收起") : tr("展开");
    head.title = open ? tr("收起") : tr("展开全文");
  };
  return head;
}

/** What the run is doing right now, for the hover card in the composer (Q-017). */
export interface LiveInfo {
  name?: string;
  args?: string;
  summary?: string;
  output?: string;
  thinking?: string;
  startedAt?: number;
}

/** One line, capped — tool args are for orientation, not for reading the whole object. */
function compactArgs(args: unknown): string {
  if (args == null) return "";
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

export class ChatView {
  private cards = new Map<string, HTMLElement>();
  private loaded: Item[] = [];
  private toolCards = new Map<string, HTMLElement>();
  /**
   * #197 / D178: 用户气泡在这张表里（节点 + 桥发来的那条 item），好给最后一枚挂「处理中…」——
   * 那一枚是推出来的，不来自协议。Map 的插入顺序就是对话顺序。
   */
  private users = new Map<string, { node: HTMLElement; item: UserItem }>();
  /**
   * 会话图片的 URL。条目里只有 mimeType，字节在会话文件里，只有 app 知道当前会话 id；返回 null
   * 就退回旧的一行「附 N 张图片」。
   */
  private imageSource: ((itemId: string, index: number) => string | null) | null = null;
  /** 会话在跑一轮？用户气泡上的「处理中…」等于「运行态 + 这条是最后一条用户消息」。 */
  private running = false;
  private draftBuffers = new Map<string, { text: string; thinking: string }>();
  /** One collapsed module per turn: every tool call lands here instead of the transcript. */
  private opsBody: HTMLElement | null = null;
  private opsTitle: HTMLElement | null = null;
  private opsBox: HTMLDetailsElement | null = null;
  /** 本轮自动加载的技能组（见 `SkillGroup`）；换轮、重置、翻页插历史时清空。 */
  private skillGroup: SkillGroup | null = null;
  /** Each failure's item on the module's 「AI 执行失败」page, keyed by toolCallId. */
  private failCards = new Map<string, HTMLElement>();
  /**
   * 本轮已经出过失败的卡片（toolCallId → 输入）。同一轮里后续只要有工具跑通，就给对应卡片补一句
   * 「后来它怎么绕过去的」——人关心的是任务最终有没有成，不是那一步本身亮不亮红。
   */
  private turnFails: Array<{ key: string; input: FailureInput }> = [];
  /**
   * 会话级失败回传（D164）：除了一张红卡，账本还要一份它。按 id 去重是 app 的事 ——
   * 同一张卡会在 live 事件、item.replace、reset 重放里各建一次，聊天区只画一张，账本也只能算一次。
   */
  onFail: ((f: { id: string; tool: string; cmd: string; out: string; at?: string; live?: boolean }) => void) | null = null;
  /** Set by the app: compact plan cards open the execution pane. */
  onTodoClick: (() => void) | null = null;
  /**
   * assistant 说完一段（D164 延伸）：复盘那一轮的结尾里可能带着「规矩」行，由 app 解析后交给桥。
   * add / replace 各会走到一次，app 那边靠同键覆盖去重，重放历史也不会多写。
   */
  onAnswer: ((text: string) => void) | null = null;
  /**
   * #200: 失败气泡旁那颗「重试」。动作是现有的接管（`claim`）：先把 pi 拉起来、钉权限、过锁检查，
   * 桥那边就绪后按原顺序补发 —— 不新增协议帧。
   */
  onRetry: (() => void) | null = null;
  /**
   * #202 / D183: 失败气泡上的第二条路 —— 不重试，把这批没发出去的消息退回输入框（`clearQueue`）。
   * 「重试」是选择，不是唯一出路。
   */
  onWithdraw: (() => void) | null = null;
  /** Following the stream: new content scrolls the view to the bottom. Cleared the moment the user says "I want to read up there". */
  private following = true;
  /** One pending frame at most — a burst of updates must cost one scroll, not one per update. */
  private pendingScroll = 0;
  /**
   * #244: 往前翻一页后的锚点会钉三次（立刻 / 下一帧 / 150ms），而自动翻页可能在同一拍里就要跳走。
   * 每发起一轮锚点就换一代，跳转把代数往前推 — 还没跑的那几次钉作废，不能把视口拽回底部。
   */
  private anchorPinRun = 0;
  /** Something arrived while the user was reading up top. */
  private unread = false;
  private jump: HTMLButtonElement;
  /** Files the agent wrote or edited in this session, latest last. */
  private written = new Map<string, { tool: string; at: number; writes: number }>();
  /** Assistant replies the user folded; kept across rebuilds and session re-renders. */
  private collapsed = new Set<string>();
  /** Set by the app: the 停止 button on a running `!cmd` card. */
  onBashStop: ((id: string) => void) | null = null;
  /** Set by the app: ⑂ on a user message (#17). `index` = its position among user messages. */
  onFork: ((item: { id: string; text: string }, index: number) => void) | null = null;
  /**
   * D190: 用户开始往上读（跟流刚被关掉）。提问面板长在输入区上方时据此收成一行 —— 只报这一个边沿，
   * 不跟着每一格滚轮走。
   */
  onScrollUp: (() => void) | null = null;
  /** 回到底部，而且是往下滚回来的 —— 收起的提问面板据此展开（往上滚回的不算，见 `resumeFollowing`）。 */
  onSettleBottom: (() => void) | null = null;
  /** Live view of the running tool call — nothing here is rendered in the transcript. */
  private live: LiveInfo = {};
  /**
   * 每条 assistant 条目自己的文本（id → 文本）。卡片上的「它当时在做」按**这条工具调用所属的消息**取，
   * 而不是「上一条」：模型一句话不说、直接再调一个工具时，上一条的独白是别的动作，拿来会误导。
   * tool item 的 id 是 `${entry.id}:${callId}`（items.ts:180），所以前缀就是它那条消息。
   */
  private assistantTexts = new Map<string, string>();
  /** Which tool call the live output belongs to; a stale update must not overwrite a newer tool. */
  private liveKey = "";
  /** This turn's written files, as chips under the ops module. */
  private opsFiles: HTMLElement | null = null;
  /** The user turns, in order — one tick on the rail each. `reset()` refills it through `add()`. */
  private turns: { id: string; node: HTMLElement; label: string }[] = [];
  /** 右缘的轮次缩略图（Q-028）。它挂在滚动视口外面，所以不会随之滚走。 */
  private turnRail: TurnRail;
  /** 缩略图里悬停/点击时在正文高亮的那条消息。 */
  private flashNode: HTMLElement | null = null;
  private flashTimer = 0;
  private railPending = 0;
  /** A finger is on the transcript right now — programmatic scrolling must stay out of its way. */
  private touching = false;
  /** Jump 时的平滑滚动还在路上 —— 这期间的 scroll 事件不能当成「用户回到底部」把跟流重新打开。 */
  private holdFollow = 0;
  /** scrollTop at the previous `scroll` event: only a viewport moving *down* may reopen the follow (D94). */
  private lastTop = 0;
  /**
   * #220: 一页更早的内容正往列表**最上面**插。这期间 `add()` 的副作用都得当成「历史」看：
   * 不跟流、不弹「有新内容」、不扰动当前这一轮的工具模块与刻度带 —— 插完再统一收尾。
   * `anchor` 是 DOM 锚点（当时的视口顶部节点，没内容时就是回底钮），**不是** `history.before`
   * 那个条目 id 游标（那个叫 `topId`）。
   */
  private staging: { anchor: HTMLElement; turns: { id: string; node: HTMLElement; label: string }[] } | null = null;
  /** 「载入更早」那一行：列表的第一块内容，没有更早的就整行收起来（#220）。 */
  private moreRow: HTMLElement;
  private moreBtn: HTMLButtonElement;
  private hasOlder = false;
  /**
   * 桥上读会话文件时丢了前面的条目（文件太大，`history.truncated`）。没有更早的可翻，
   * 这一行就变成一句说明：别让人以为开头那几句话被删了。
   */
  private headCut = false;
  private loadingOlder = false;
  /** 列表最上面那条的 id —— 往前翻的游标。`cards` 是 Map，插入序不一定是对话序，所以单独记。 */
  private topId: string | null = null;
  /** Set by the app: 用户要更早的一页，去桥那边要 `before` 之前那 60 条。 */
  onLoadOlder: ((before: string) => void) | null = null;
  /**
   * #244: 「把我带到某一轮去」的现场。翻页会把新轮次插到 `turns` 前面，所以认的是 id 而不是下标；
   * `n` 是整段历史里的第几轮，只用于失败文案。非空期间刻度带亮着 `.busy`。
   */
  private pendingJump: { id: string; n: number } | null = null;
  /** #244: 翻到尽头也没找到那一轮时，顶部那一行改说这句（3 秒后退回「载入更早」）。 */
  private moreNote: string | null = null;
  private moreNoteTimer = 0;
  /** #244: 轮次 id → 整段历史里的第几轮（1 起）；只在 reset 时按桥的索引填，翻出来的轮不走这张表。 */
  private turnOrdinal = new Map<string, number>();
  /**
   * #341: 一轮里的 `todo` 调用折成一张卡（用户要求）：主行是**最新**一次的快照，右边一枚「▾ N」
   * 展开这一轮的每次更新。`user` 消息、`reset()` 都把它切成新的一轮。
   */
  private todoGroup: TodoGroup | null = null;
  /** #341: toolCallId → 那一行所在的分组。结果帧晚到（用户已经发下一句）时也还能落回原来的卡。 */
  private todoRows = new Map<string, { group: TodoGroup; update: TodoUpdate }>();

  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.moreRow = el("div", "chat-more");
    this.moreBtn = el("button", "more-btn");
    this.moreBtn.type = "button";
    // #244: 用户自己点「载入更早」= 接管：停掉自动翻页，但这次手动翻页照发。
    this.moreBtn.onclick = () => {
      this.cancelPendingJump();
      this.loadOlder();
    };
    this.moreRow.append(this.moreBtn);
    this.moreRow.hidden = true;

    this.jump = el("button", "chat-jump") as HTMLButtonElement;
    this.jump.type = "button";
    // Q-027: one round arrow in the middle of the transcript; when something arrived while reading
    // up top, the word “new” rides next to it instead of a second, wider bar.
    this.jump.append(el("span", "jump-arrow", "↓"), el("span", "jump-new", "new"));
    this.jump.hidden = true;
    this.jump.onclick = () => this.follow();

    // 挂在 .chat-pane（滚动视口的父节点）而不是 root：缩略图要跟着视口停住，不能跟内容一起滚。
    this.turnRail = mountTurnRail(this.root.parentElement ?? this.root, {
      onPick: (index) => this.jumpToTurn(index),
      // #244: ghost 刻度的坐标会随翻页失效（id 不会），所以那条路交回 id 自己翻。
      onPickGhost: (id) => this.jumpToTurnId(id),
      onHover: (index) => this.flashTurn(index),
      viewport: this.root,
    });

    // Intent first: a wheel/touch event is what the user meant, long before the (async, frame-coalesced)
    // scroll event lands. Waiting for `scroll` let the burst that was already in flight drag the view
    // back down — that was the "一卡一卡" tug of war.
    root.addEventListener("wheel", (ev) => {
      if ((ev as WheelEvent).deltaY < 0) this.holdUp();
    }, { passive: true });
    let touchStartY: number | null = null;
    root.addEventListener("touchstart", (ev) => {
      touchStartY = (ev as TouchEvent).touches[0]?.clientY ?? null;
      this.touching = true;
    }, { passive: true });
    root.addEventListener("touchmove", (ev) => {
      const y = (ev as TouchEvent).touches[0]?.clientY ?? null;
      // Compare with where the finger *started*, not with the previous sample (D68). A real drag
      // arrives as dozens of 1–5px touchmove events, so a per-event 6px threshold never fires and the
      // stream keeps pinning the view to the bottom under the user's finger. Finger down = the content
      // is moving up = the user is reading history.
      if (touchStartY !== null && y !== null && y - touchStartY > 6) this.stopFollowing();
    }, { passive: true });
    const endTouch = (): void => {
      touchStartY = null;
      this.touching = false;
    };
    root.addEventListener("touchend", endTouch, { passive: true });
    root.addEventListener("touchcancel", endTouch, { passive: true });
    root.addEventListener("keydown", (ev) => {
      const key = (ev as KeyboardEvent).key;
      if (key === "PageUp" || key === "ArrowUp" || key === "Home") this.holdUp();
    });

    root.addEventListener("scroll", () => {
      // Mid-gesture the viewport brushes past the bottom by accident (the drag started at the bottom),
      // so "near bottom" is not an intent to follow while a finger is down.
      // D94: a wheel / smooth-scroll animation leaves the bottom a few px per frame, so its first
      // `scroll` events still read gap ≤ 24. Only a viewport that moved down (or held still) means
      // "back at the bottom"; programmatic scrolls only ever go down, so they still pass.
      const top = this.root.scrollTop;
      const movingDown = top >= this.lastTop;
      this.lastTop = top;
      if (!this.touching && movingDown && performance.now() >= this.holdFollow && this.nearBottom()) this.resumeFollowing();
      this.queueRailSync();
    });

    // The composer grows and shrinks under the transcript; while following, that must not unstick us.
    new ResizeObserver(() => {
      if (this.following) this.scheduleScroll();
      // 视口变高 / 变矮可能让「下面还有东西」这个前提变了，那颗钮要跟着重算（见 hasRoomBelow）。
      else this.renderJump();
    }).observe(root);
  }

  /** Distance left below the viewport, in px. Small enough that "at the bottom" means what it says. */
  private nearBottom(): boolean {
    const gap = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight;
    return gap <= BOTTOM_SLACK;
  }

  /**
   * 转录下面还有东西可翻（多于 `BOTTOM_SLACK`）：短会话里上面滚不出旧内容，下面也没有
   * 「回到底部」的去处，那颗钮在那儿只会骗人（D168）。两者共用同一道容差——差几像素不算。
   */
  private hasRoomBelow(): boolean {
    return this.root.scrollHeight - this.root.clientHeight > BOTTOM_SLACK;
  }

  /** Wheel / key up: stop following and keep the follow closed while the smooth-scroll animation plays out. */
  private holdUp(): void {
    // #244: 用户一动手就不再把他拽到别处去 —— 已经取回的页留着，滚动位置不动。
    this.cancelPendingJump();
    // 短会话里上滚什么也翻不出来。以前照样关掉跟流，于是一格空滚就长出「↓ new」，
    // 而下面其实空无一物——手势没有去处时，就当它没发生。
    if (!this.following || !this.hasRoomBelow()) return;
    this.holdFollow = Math.max(this.holdFollow, performance.now() + 300);
    this.stopFollowing();
  }

  /**
   * 守卫放在这里而不是各个调用点：点缩略图（`jumpToTurn`）之类的第三条路也会走到这里，
   * 而「不跟流 + 下面没东西」是个看不见也回不去的状态——钮被 `renderJump` 藏了，没有溢出就没有
   * scroll 事件，`resumeFollowing` 永远不会被叫醒（D168）。
   */
  private stopFollowing(): void {
    // #244: touch / 键盘 / 跳转都会走到这里：「我要去的那一轮」到此为止。
    this.cancelPendingJump();
    if (!this.following || !this.hasRoomBelow()) return;
    this.following = false;
    this.renderJump();
    this.onScrollUp?.();
  }

  private resumeFollowing(): void {
    if (this.following && !this.unread) return;
    this.following = true;
    this.unread = false;
    this.renderJump();
    this.onSettleBottom?.();
  }

  private renderJump(): void {
    this.jump.classList.toggle("has-new", this.unread);
    // 不跟流但下面没东西（内容缩水、窗口变高、或者本来就是空滚）：钮没有意义，别画。
    // 跟流时短路，不读布局；只有「用户已经滚上去了」这条路上才会量一次 `scrollHeight`
    // （delta 会经由 scrollToEnd 走到这里，一次文本重排的量级），换的是缩水时钮能立刻收。
    this.jump.hidden = this.following || !this.hasRoomBelow();
    // The visible text is a glyph, so the meaning has to live somewhere readable.
    const label = this.unread ? tr("有新内容，回到底部") : tr("回到底部");
    this.jump.title = label;
    this.jump.setAttribute("aria-label", label);
  }

  /**
   * D189: 右栏为提问打开 / 加宽会让会话按新宽度重排，而 `overflow-anchor: none`（D188）拿掉了浏览器
   * 自带的滚动锚定 —— 不补的话，正在读的那段会整块上移。先记下视口顶端那条，改完按差值补回来。
   * 跟流时不用管：宽度一变，root 的 ResizeObserver 会重新贴底。
   */
  pinTop(): () => void {
    if (this.following) return () => {};
    const box = this.root.getBoundingClientRect();
    let anchor: HTMLElement | null = null;
    for (const node of Array.from(this.root.children) as HTMLElement[]) {
      if (node.getBoundingClientRect().bottom > box.top + 4) {
        anchor = node;
        break;
      }
    }
    if (!anchor) return () => {};
    const before = anchor.getBoundingClientRect().top;
    return () => {
      const delta = anchor!.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 0.5) this.root.scrollTop += delta;
    };
  }

  /** Jump to the bottom and keep following — used by the button, by reset(), and by "I just sent a message". */
  follow(): void {
    this.following = true;
    this.unread = false;
    this.renderJump();
    if (this.pendingScroll) cancelAnimationFrame(this.pendingScroll);
    this.pendingScroll = 0;
    this.root.scrollTop = this.root.scrollHeight;
    this.scheduleScroll();
    this.queueRailSync();
    this.onSettleBottom?.();
  }

  /** 缩略图的那一下跳动不该每滚动一下就算一遍，一帧一次。 */
  private queueRailSync(): void {
    if (this.railPending) return;
    this.railPending = requestAnimationFrame(() => {
      this.railPending = 0;
      const last = this.turns.length - 1;
      if (last < 0) return;
      // 「你在哪一轮」= 视口顶部已经翻过去的最后一轮；已经在底部就是最后一轮。
      let at = last;
      if (this.nearBottom()) {
        at = last;
      } else {
        at = 0;
        const base = this.root.getBoundingClientRect().top + 72;
        for (let i = 0; i <= last; i++) {
          const node = this.turns[i].node;
          if (node.isConnected && node.getBoundingClientRect().top > base) break;
          at = i;
        }
      }
      this.turnRail.setCurrent(at);
    });
  }

  /**
   * 点缩略图里的一行：把那一轮滚到视口顶部 —— **最后一轮也一样**。
   *
   * D60 原本把最后一轮特判成「直接回到底部并继续跟流」，可点那一行的意思就是「回到我那句输入」：
   * 回答一长，人就被甩到几千像素外的末尾，看到的是答案的尾巴，不是自己点的那一轮（用户报的 bug）。
   * 唯一保留「回到底部」的情形是**滚不过去**：那一轮的开头本来就落在最后一屏里（`top >= maxScroll`），
   * 顶到视口顶部也只能贴到底 —— 像素一模一样，那就顺手把跟流留住（正在流的长回答不会断在半截）。
   */
  private jumpToTurn(index: number): void {
    // #244: 点已载入的轮次 = 用户自己找了去处，自动翻页让道（它自己的收尾也会走到这里，先清过再走的）。
    this.cancelPendingJump();
    // 刚插入的一页还排着锚点补偿：跳转说了算，那几次别再钉（否则会把平滑滚动按回原处）。
    this.anchorPinRun += 1;
    const turn = this.turns[index];
    if (!turn || !turn.node.isConnected) return;
    this.flashTurn(index, 1200);
    /** 那一轮的用户气泡「顶到视口顶部」要滚到的位置（留 6px 呼吸）。 */
    const startTop = (): number =>
      turn.node.getBoundingClientRect().top - this.root.getBoundingClientRect().top + this.root.scrollTop - 6;
    const maxScroll = this.root.scrollHeight - this.root.clientHeight;
    if (startTop() >= maxScroll - 1) {
      this.follow();
      return;
    }
    this.stopFollowing();
    if (this.pendingScroll) cancelAnimationFrame(this.pendingScroll);
    this.pendingScroll = 0;
    // 从底部往上跳的第一帧 scroll 事件里，视口其实还没离开底部；不挡住它就会立刻 resumeFollowing。
    this.holdFollow = performance.now() + 900;
    // 停跟流会把「回到底部」那颗钮也点亮/收起，量之前重算一次，别滚到几像素外。
    this.root.scrollTo({ top: Math.max(0, startTop()), behavior: "smooth" });
  }

  /**
   * #244: 点未载入的刻度 / 行 —— 「把我带到那一轮去」。已经在列表里就直接定位（与点已载入的同观感），
   * 否则起自动往回翻页：一页一页地要，直到那一轮被插进来。
   */
  private jumpToTurnId(id: string): void {
    const index = this.turns.findIndex((turn) => turn.id === id);
    if (index >= 0) {
      this.jumpToTurn(index);
      this.flashTurn(index, 1200);
      return;
    }
    this.pendingJump = { id, n: this.turnOrdinal.get(id) ?? 0 };
    this.turnRail.setBusy(true);
    this.loadOlder();
    // 一页都发不出去（没有游标 / 本来就没有更早的）：没有回包可等，当场收尾。
    if (!this.loadingOlder) this.failPendingJump();
  }

  /**
   * #244: 取消自动翻页（用户自己动手了）。只停「继续往前找」这件事：已经发出去的请求不回退，
   * 到货的页照常插入，滚动位置也不动 —— 不 follow()、不 jumpToTurn()。
   */
  private cancelPendingJump(): void {
    if (!this.pendingJump) return;
    this.pendingJump = null;
    this.turnRail.setBusy(false);
    this.renderMore();
  }

  /**
   * #244: 一页更早的到了（或确认没有了）：自动翻页在这里决定「继续翻 / 到了 / 放弃」。
   * `advanced` 为 false 是空页 —— 没有进展就停下，不能靠 hasMore 再要一遍同一页。
   */
  private afterOlderPage(advanced: boolean): void {
    const pending = this.pendingJump;
    if (!pending) return;
    const index = this.turns.findIndex((turn) => turn.id === pending.id);
    if (index >= 0) {
      this.pendingJump = null;
      this.turnRail.setBusy(false);
      this.renderMore();
      this.jumpToTurn(index);
      this.flashTurn(index, 1200);
      return;
    }
    // 不在这一页：还有更早就排下一轮再要（不在响应处理的调用栈里直接发），否则收尾成失败。
    if (advanced && this.hasOlder) {
      setTimeout(() => {
        if (!this.pendingJump) return;
        this.loadOlder();
        if (!this.loadingOlder) this.failPendingJump();
      }, 0);
      return;
    }
    this.failPendingJump();
  }

  /**
   * #244: 翻到尽头也没有那一轮（索引与正文不一致）：停下，并在顶部那一行说一声。
   * 那行在滚出视口的上方，所以同一句也挂在刻度带上 —— 「可见」是票面要求。
   */
  private failPendingJump(): void {
    const pending = this.pendingJump;
    if (!pending) return;
    this.pendingJump = null;
    this.turnRail.setBusy(false);
    this.moreNote = tr("没翻到第 {p1} 轮", { p1: pending.n });
    this.turnRail.setNote(this.moreNote);
    clearTimeout(this.moreNoteTimer);
    this.moreNoteTimer = window.setTimeout(() => {
      this.moreNote = null;
      this.turnRail.setNote(null);
      this.renderMore();
    }, 3000);
    this.renderMore();
  }

  /** Scroll to a loaded transcript item and briefly mark its chat card. */
  jumpToItem(itemId: string): boolean {
    const item = this.loaded.find((loaded) => loaded.id === itemId);
    const node = this.cards.get(itemId) ?? (item?.kind === "tool" ? this.toolCards.get(item.toolCallId) : undefined);
    if (!node?.isConnected) return false;
    const module = node.closest<HTMLDetailsElement>("details.ops");
    if (module) module.open = true;
    const skillGroup = node.closest<HTMLDetailsElement>("details.skillgroup");
    if (skillGroup) skillGroup.open = true;
    this.stopFollowing();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("exec-flash");
    window.setTimeout(() => node.classList.remove("exec-flash"), 1200);
    return true;
  }

  private flashTurn(index: number | null, ms = 0): void {
    clearTimeout(this.flashTimer);
    if (this.flashNode) {
      this.flashNode.classList.remove("turn-flash");
      this.flashNode = null;
    }
    const node = index === null ? null : (this.turns[index]?.node ?? null);
    if (!node) return;
    node.classList.add("turn-flash");
    this.flashNode = node;
    if (ms > 0) this.flashTimer = window.setTimeout(() => this.flashTurn(null), ms);
  }

  /** 这条会话里有没有用户说过话：没有的话「继续」按钮没有可接的东西（D159）。 */
  hasUserTurns(): boolean {
    return this.turns.length > 0;
  }

  /** 一轮用户输入 = 缩略图上的一根刻度。`reset()` 也会经由 `add()` 走到这里。 */
  private noteTurn(item: UserItem, node: HTMLElement): void {
    const label = turnLabel(item.text ?? "", item.images?.length ?? 0);
    const turn = { id: item.id, node, label };
    // 往前翻的时候，这些不是「新的」：先攒着，插完再 unshift 进 turns / 刻度带（#220）。
    if (this.staging) {
      this.staging.turns.push(turn);
      return;
    }
    this.turns.push(turn);
    this.turnRail.add(label);
    this.queueRailSync();
  }

  /**
   * #319: the composer under the transcript just grew taller. The root's own `ResizeObserver` can
   * only report *that* the band changed size — it has no direction, so it cannot tell “the composer
   * squeezed the band” from “the reader scrolled away” — and it fires after layout, one frame later,
   * when the last line has already been painted under the box. The composer knows why the band
   * shrank, so it says so and we pin in the same task.
   *
   * Growing pulls the bottom out of view: re-pin right away, before the next frame, while following.
   * A reader up in the history keeps the position they chose; nothing here touches `following`.
   * A shrink needs no pin: the band got taller and the browser's own clamp keeps the bottom at the bottom.
   */
  noteComposerGrew(): void {
    if (!this.following || this.touching) return;
    // The new height is already written to the style, so this read lays the band out at its new size.
    this.root.scrollTop = this.root.scrollHeight;
  }

  private scheduleScroll(): void {
    if (this.pendingScroll) return;
    this.pendingScroll = requestAnimationFrame(() => {
      this.pendingScroll = 0;
      // Re-checked at execution time: the user may have scrolled away while this frame was queued,
      // or may be holding the transcript right now (D68) — never fight a finger in progress.
      if (!this.following || this.touching) return;
      this.root.scrollTop = this.root.scrollHeight;
    });
  }

  /** Everything the transcript appends goes in *before* the jump button, which must stay the last child. */
  private push(node: HTMLElement): void {
    // 往前翻的时候，新内容落在「载入更早」那行下面、旧内容上面（#220）。
    this.root.insertBefore(node, this.staging?.anchor ?? this.jump);
  }

  /** Keeps the tail marker and the jump button children of the scroller no matter how it is rebuilt. */
  private mountChrome(): void {
    this.root.append(this.moreRow, this.jump);
  }

  reset(items: Item[], history?: SessionHistory): void {
    this.loaded = [];
    // #244: 换会话 / 重连换了内容 —— 那个「要去的轮次」已经不在这份记录里了。
    this.cancelPendingJump();
    clearTimeout(this.moreNoteTimer);
    this.moreNote = null;
    this.turnRail.setNote(null);
    this.root.replaceChildren();
    this.cards.clear();
    this.users.clear();
    this.toolCards.clear();
    this.draftBuffers.clear();
    this.opsBody = null;
    this.opsTitle = null;
    this.opsBox = null;
    this.skillGroup = null;
    this.todoGroup = null;
    this.todoRows.clear();
    this.failCards.clear();
    this.turnFails = [];
    this.written.clear();
    this.opsFiles = null;
    this.live = {};
    this.liveKey = "";
    this.assistantTexts.clear();
    this.turns = [];
    this.turnRail.clear();
    this.flashTurn(null);
    this.staging = null;
    this.hasOlder = history?.hasMore === true;
    this.headCut = history?.truncated === true;
    this.loadingOlder = false;
    this.topId = items[0]?.id ?? null;
    // Chrome first: `push()` inserts before the jump button, so it has to be in the DOM already.
    this.mountChrome();
    const loadedIds = new Set(items.filter((item): item is UserItem => item.kind === "user").map((item) => item.id));
    for (const item of items) this.add(item);
    // #243: 整段会话的索引里，这一页没载入的那些先以 ghost 占位在带子上沿。
    // 老桥没有 `turns` → 空数组，退回「只画已载入的轮次」。
    const index = history?.turns ?? [];
    // #244: ghost 的点击只带 id 回来，这里把「第几轮」也记下（失败文案要用）。
    this.turnOrdinal = new Map(index.map((turn, i) => [turn.id, i + 1]));
    this.turnRail.setGhosts(
      index.filter((turn) => !loadedIds.has(turn.id)).map((turn) => ({ id: turn.id, label: turnLabel(turn.text, turn.images) })),
    );
    this.renderMore();
    this.follow();
  }

  /**
   * #220: 一页更早的内容到了。`before` 是发请求时的游标（当时就等于 `topId`）；不是当前这一页
   * 就不要（换过会话、重连晚到、同一个响应到了两次），免得同一页插两遍或插到别人头上。
   * 它插在「载入更早」那行下面、现有内容上面，屏幕上那几行必须原地不动 —— 按**节点**锚定：
   * 记下视口顶部那块内容的 rect.top，插完把差值补回 scrollTop。
   * scrollHeight 差值不能用：实测偏几十像素（代码块/字体度量在下一帧才定型）。
   */
  prepend(before: string, items: Item[], hasMore: boolean): void {
    if (!this.loadingOlder || before !== this.topId) return;
    this.loadingOlder = false;
    if (!items.length) {
      // 桥说没有了（或者这一页是空的）：行收起来，别再发请求。
      this.hasOlder = hasMore;
      this.renderMore();
      this.afterOlderPage(false);
      return;
    }
    const anchor = this.contentTop();
    const topBefore = anchor?.getBoundingClientRect().top ?? 0;
    const seen = new Set(this.users.keys());
    const held = this.holdTurnState();
    const fresh: { id: string; node: HTMLElement; label: string }[] = [];
    this.staging = { anchor: anchor ?? this.jump, turns: fresh };
    // #341: 翻出来的旧轮各自成组，不许并进当前这一轮那张卡。
    const liveGroup = this.todoGroup;
    this.todoGroup = null;
    try {
      for (const item of items) this.add(item);
    } finally {
      this.staging = null;
      this.todoGroup = liveGroup;
      this.releaseTurnState(held);
    }
    const olderIds = new Set(items.map((item) => item.id));
    const olderCalls = new Set(items.flatMap((item) => item.kind === "tool" ? [item.toolCallId] : []));
    this.loaded = [...items, ...this.loaded.filter((item) => !olderIds.has(item.id) && !(item.kind === "tool" && olderCalls.has(item.toolCallId)))];
    this.topId = items[0].id;
    this.hasOlder = hasMore;
    this.renderMore();
    // 老轮补在刻度带上沿（不是尾端），且「你在哪一轮」不能因为一次翻页就换了个人。
    this.turns = [...fresh, ...this.turns];
    this.turnRail.prepend(fresh.map((turn) => turn.label));
    // `users` 的插入序就是对话顺序（`paintPending()` 认最后一枚）：新翻出来的排在前面。
    const older = [...this.users].filter(([id]) => !seen.has(id));
    const rest = [...this.users].filter(([id]) => seen.has(id));
    this.users = new Map([...older, ...rest]);
    this.paintPending();
    this.queueRailSync();
    this.restoreAnchor(anchor, topBefore);
    // #244: 自动翻页的下一步在插完、钉回锚点之后才做 —— 中间那一次不打乱用户正在看的位置。
    this.afterOlderPage(true);
  }

  /** 点「载入更早」：加载中按钮是灰的，所以连点也只会发一个请求（#220）。 */
  private loadOlder(): void {
    if (!this.hasOlder || this.loadingOlder || !this.topId) return;
    this.loadingOlder = true;
    this.renderMore();
    this.onLoadOlder?.(this.topId);
  }

  /**
   * 那一行在「还有更早的 / 正在载入 / 刚翻输了一轮」时都在。优先级：
   * 载入中 → 失败那句（此时可能已经没有更早了，也要露出来）→「载入更早」。
   * 没有更早可翻、但桥说过文件头部没载入（`headCut`）时，这一行改成一句说明（钮不可点）。
   */
  private renderMore(): void {
    const note = this.moreNote;
    const cut = this.headCut && !this.hasOlder && !this.loadingOlder && note === null;
    this.moreRow.hidden = !this.hasOlder && !this.loadingOlder && note === null && !cut;
    // 那句失败提示不是一颗能点的钮（点了也没有更早的可要），三秒后自然回到「载入更早」。
    this.moreBtn.disabled = this.loadingOlder || note !== null || cut;
    this.moreBtn.textContent = this.loadingOlder
      ? tr("载入中…")
      : (note ?? (cut ? tr("会话文件太大，只载入了最后一段") : tr("载入更早")));
  }

  /**
   * 锚点：视口顶部那块内容。跳过「载入更早」那行和回底钮 —— 它们不跟内容一起动。
   * 插第一条历史时列表还是空的，此时没有锚点（也就没有东西需要挤回原位）。
   */
  private contentTop(): HTMLElement | null {
    for (const node of this.root.children) {
      if (node === this.moreRow || node === this.jump) continue;
      return node as HTMLElement;
    }
    return null;
  }

  /**
   * 把锚点钉回它原来的屏幕位置，一共钉三次：插完立刻一次，下一帧一次，150ms 后再一次。
   * 最后一页常带代码块/字体，高度到下一帧还会动一点，只钉一次就漂。
   */
  private restoreAnchor(anchor: HTMLElement | null, topBefore: number): void {
    if (!anchor) return;
    const run = ++this.anchorPinRun;
    let expected = this.pin(anchor, topBefore, null);
    const again = (): void => {
      if (run !== this.anchorPinRun) return;
      expected = this.pin(anchor, topBefore, expected);
    };
    requestAnimationFrame(again);
    setTimeout(again, 150);
  }

  /**
   * 一次钉：把 `anchor` 挪回 `topBefore`。`expected` 是上一次写下的 scrollTop —— 现在读到的
   * 跟它对不上，说明用户自己滑了（或者浏览器把值夹到了两头），这一轮就不该再纠正，
   * 不然一只手指正在往上翻，程序又把它拽回去。
   */
  private pin(anchor: HTMLElement, topBefore: number, expected: number | null): number {
    // 换过会话了：锚点已经不在这份 DOM 里，它的 rect 全是 0，拿它算会把视口拖到顶上。
    if (!anchor.isConnected) return this.root.scrollTop;
    const max = this.root.scrollHeight - this.root.clientHeight;
    const now = this.root.scrollTop;
    if (expected !== null && Math.abs(now - Math.min(max, Math.max(0, expected))) > 1) return now;
    const want = Math.min(max, Math.max(0, now + anchor.getBoundingClientRect().top - topBefore));
    this.root.scrollTop = want;
    return want;
  }

  /** 收走当前这一轮的现场（见 `TurnState`）；`closeOps()` 会把它清空，所以先存一份。 */
  private holdTurnState(): TurnState {
    const held: TurnState = {
      opsBody: this.opsBody,
      opsTitle: this.opsTitle,
      opsBox: this.opsBox,
      opsFiles: this.opsFiles,
      turnFails: this.turnFails,
      skillGroup: this.skillGroup,
    };
    this.closeOps();
    // 插进来的历史属于更早的轮次：它的技能要另起组，不能追加到用户正在看的这一轮里。
    this.skillGroup = null;
    this.turnFails = [];
    return held;
  }

  private releaseTurnState(held: TurnState): void {
    this.opsBody = held.opsBody;
    this.opsTitle = held.opsTitle;
    this.opsBox = held.opsBox;
    this.opsFiles = held.opsFiles;
    this.turnFails = held.turnFails;
    this.skillGroup = held.skillGroup;
  }

  /**
   * Called after every append. While following it schedules one frame; while the user is reading up
   * top it only raises the "有新内容" hint and never touches scrollTop.
   */
  private scrollToEnd(force = false): void {
    if (force) {
      this.follow();
      return;
    }
    // 正在往上面插历史：这会儿的「新内容」是别人的过去式，既不该跟流也不该弹提示（#220）。
    if (this.staging) return;
    if (!this.following) {
      this.unread = true;
      this.renderJump();
      return;
    }
    this.scheduleScroll();
  }

  /** Snapshot for the composer's hover card. */
  liveInfo(): LiveInfo {
    return this.live;
  }

  /** The execution view is deliberately limited to items already present in the transcript. */
  loadedItems(): Item[] {
    return [...this.loaded];
  }

  private remember(item: Item): void {
    const index = this.loaded.findIndex((loaded) => loaded.id === item.id || (loaded.kind === "tool" && item.kind === "tool" && loaded.toolCallId === item.toolCallId));
    if (index < 0) this.loaded.push(item);
    else this.loaded[index] = item;
  }

  add(item: Item): void {
    this.remember(item);
    // a user message opens a new turn: its tool calls get their own module
    if (item.kind === "user") {
      this.closeOps();
      this.clearTurnFails();
      // 技能组按轮分：上一条用户消息之前加载的技能，不该再被收进新的组。
      this.skillGroup = null;
      // #341: 计划卡也按轮分：新的一轮从一张新卡开始。
      this.todoGroup = null;
    }
    // 隐式技能卡是「下面那张 read」的前言，不能落在它后面：收掉已有模块，让这张 read 自己开一个。
    if (item.kind === "skill") this.closeOps();
    if (item.kind === "assistant") {
      this.assistantTexts.set(item.id, item.text ?? "");
      if ((item.text ?? "").trim()) this.noteAnswered();
      this.noteAnswer(item);
    }
    if (item.kind === "tool") {
      const existing = this.toolCards.get(item.toolCallId);
      if (existing && this.isAskTool(item.name)) {
        // A question card is never merged in place: it is rebuilt and lives outside the ops module.
        const fresh = this.build(item);
        existing.remove();
        this.cards.set(item.id, fresh);
        this.toolCards.set(item.toolCallId, fresh);
        this.push(fresh);
        this.scrollToEnd();
        return;
      }
      if (existing) {
        // #341: todo 的卡是这一轮的折叠卡，结果帧就地回填到卡里那一行。
        if (this.isTodoTool(item.name) && this.updateTodo(item)) return;
        this.mergeTool(existing, item);
        return;
      }
    }
    // #341: 同一轮里的下一次 todo 调用折进现有那张卡，不再各占一行。
    if (item.kind === "tool" && this.isTodoTool(item.name) && this.todoGroup) {
      const group = this.todoGroup;
      this.addTodoUpdate(item);
      this.cards.set(item.id, group.node);
      this.toolCards.set(item.toolCallId, group.node);
      this.noteAfter(item);
      this.scrollToEnd();
      return;
    }
    const node = this.build(item);
    this.cards.set(item.id, node);
    // 本轮所有自动加载的技能只占一个折叠组（用户要求），组落在第一张卡的位置。
    if (item.kind === "skill") {
      this.groupSkill(node, item);
      this.scrollToEnd();
      return;
    }
    if (item.kind === "tool") {
      this.toolCards.set(item.toolCallId, node);
      if (this.isAskTool(item.name) || this.isTodoTool(item.name)) this.push(node);
      else {
        this.ensureOps().append(node);
        this.refreshOps();
        this.noteWrite(item.name, item.args);
      }
      if (!this.isAskTool(item.name) && (item.isError || item.status === "error")) this.failFromItem(item);
      this.noteAfter(item);
    } else {
      this.push(node);
      if (item.kind === "user") {
        this.noteTurn(item, node);
        this.users.set(item.id, { node, item });
        this.paintPending();
      }
    }
    this.scrollToEnd();
  }

  /**
   * The bridge's copy of a message this page already drew optimistically under `localId`: keep the
   * node (the turn rail points at it) and only re-key it. Pages that never drew it just add it.
   */
  adopt(localId: string, item: Item): void {
    this.remember(item);
    const node = this.cards.get(localId);
    if (!node) {
      this.add(item);
      return;
    }
    this.cards.delete(localId);
    this.cards.set(item.id, node);
    if (this.collapsed.delete(localId)) this.collapsed.add(item.id);
    // 乐观渲染过的用户消息回填时走这里（不经过 add），这里只补 assistant 原话。
    if (item.kind === "user") {
      this.clearTurnFails();
      // 桥那份才是准的：pi 可能把 `/skill:grilling` 记成别的名字，args 也可能被折得不一样。
      // 只重建 body（节点留着 —— 刻度带指着它），按钮里的闭包拿的仍是乐观那条的文本。
      const body = node.querySelector(".body");
      if (body) body.replaceWith(this.buildUserBody(item));
      // #197: 桥那份还多一枚待发状态（乐观那条不知道自己在排队），徽标按它重画。
      this.users.delete(localId);
      this.users.set(item.id, { node, item });
      // #244: ghost 点击靠 id 找轮次——乐观那条的 id 在这里换成真的，刻度带里的坐标也要换。
      const turn = this.turns.find((entry) => entry.id === localId);
      if (turn) turn.id = item.id;
      this.paintPending();
    }
    if (item.kind === "assistant") {
      this.assistantTexts.set(item.id, item.text ?? "");
      if ((item.text ?? "").trim()) this.noteAnswered();
      this.noteAnswer(item);
    }
  }

  /** 复盘回写的「规矩」行只往外交一次（外面按键覆盖去重，重放不会多写）。 */
  private noteAnswer(item: Item): void {
    if (item.kind !== "assistant") return;
    const text = String(item.text ?? "");
    if (!text.includes("[pi-web:rule]")) return;
    this.onAnswer?.(text);
  }

  replace(id: string, item: Item): void {
    this.remember(item);
    const node = this.cards.get(id);
    this.draftBuffers.delete(id);
    if (!node) {
      this.add(item);
      return;
    }
    // #197: 用户气泡的 item.replace 只改待发状态 —— 节点留着（刻度带指着它），只重画徽标。
    if (item.kind === "user" && item.id === id) {
      this.users.set(id, { node, item });
      this.paintPending();
      return;
    }
    // #341: 折叠卡里的那一行就地更新；不属于这张卡（翻出来的旧轮）才重建。
    if (item.kind === "tool" && this.isTodoTool(item.name)) {
      const group = this.updateTodo(item);
      if (group) {
        this.cards.delete(id);
        this.cards.set(item.id, group.node);
        this.toolCards.set(item.toolCallId, group.node);
        this.scrollToEnd();
        return;
      }
    }
    const rebuilt = this.build(item);
    if (item.kind === "tool" && (this.isAskTool(item.name) || this.isTodoTool(item.name))) {
      node.remove();
      this.push(rebuilt);
    } else node.replaceWith(rebuilt);
    this.cards.delete(id);
    this.cards.set(item.id, rebuilt);
    if (id !== item.id && this.collapsed.delete(id)) this.collapsed.add(item.id);
    if (item.kind === "tool") {
      this.toolCards.set(item.toolCallId, rebuilt);
      this.refreshOps();
      if (!this.isAskTool(item.name) && (item.isError || item.status === "error")) this.failFromItem(item);
      this.noteAfter(item);
    }
    // 流式那条回答是走 replace 收尾的（先 add 一张空卡、再整条换掉），add 里那一次看不到正文。
    if (item.kind === "assistant") this.noteAnswer(item);
    this.scrollToEnd();
  }

  /**
   * #197 / D178: 用户气泡上那枚状态徽标，三种说法：
   *   `booting` → 「正在启动 pi…」：桥收下了，还没交给 pi；
   *   `failed`  → 「没发出去」+ 一颗「重试」（#200）：文本还在、可复制，点重试先把 pi 拉起来再补发；
   *   最后一条 + 运行态 → 「处理中…」：这一枚是推出来的，不写进协议，多端各自算出来都一样。
   * 交给 pi 之后徽标就不见了，本轮结束同样消失。
   */
  private paintPending(): void {
    const entries = [...this.users.values()];
    const last = entries.length ? entries[entries.length - 1] : null;
    for (const entry of entries) {
      const who = entry.node.querySelector<HTMLElement>(".who");
      if (!who) continue;
      let state = "";
      if (entry.item.pending === "booting") state = "booting";
      else if (entry.item.pending === "failed") state = "failed";
      else if (entry === last && this.running) state = "running";
      let badge = who.querySelector<HTMLElement>(".msg-pending");
      if (!state) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = el("span", "msg-pending");
        who.append(badge);
      }
      badge.className = state === "failed" ? "msg-pending failed" : "msg-pending";
      if (state === "failed") {
        const retry = el("button", "msg-retry", tr("重试")) as HTMLButtonElement;
        retry.type = "button";
        retry.title = tr("先拉起 pi，再按原顺序补发没发出去的消息");
        retry.onclick = () => this.onRetry?.();
        const back = el("button", "msg-retry", tr("退回输入框")) as HTMLButtonElement;
        back.type = "button";
        back.title = tr("把这条没发出去的消息放回输入框");
        back.onclick = () => this.onWithdraw?.();
        badge.replaceChildren(el("span", "", tr("没发出去")), retry, back);
        continue;
      }
      const label = state === "booting" ? tr("正在启动 pi…") : tr("处理中…");
      badge.replaceChildren(el("span", "act-spin"), el("span", "", label));
    }
  }

  /**
   * #199: 桥还替我们拿着、没交给 pi 的用户消息条数。启动期状态行据此决定要不要给「撤回」——
   * 没有可退的东西时那颗按钮不该出现。
   */
  bootingCount(): number {
    let n = 0;
    for (const entry of this.users.values()) if (entry.item.pending === "booting") n += 1;
    return n;
  }

  /** 会话图片的 URL 由 app 注入（只有它知道当前会话 id）；null 时气泡退回旧的一行文字。 */
  setImageSource(fn: (itemId: string, index: number) => string | null): void {
    this.imageSource = fn;
  }

  /** 运行态变了：只有最后一枚用户消息会因为「处理中」而变样。 */
  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.paintPending();
  }

  delta(id: string, field: "text" | "thinking", text: string): void {
    const node = this.cards.get(id);
    if (!node) return;
    const buf = this.draftBuffers.get(id) ?? { text: "", thinking: "" };
    buf[field] += text;
    this.draftBuffers.set(id, buf);
    if (field === "thinking") this.live.thinking = buf.thinking.slice(-800);

    if (field === "text") {
      node.classList.remove("no-text");
      let stream = node.querySelector<HTMLElement>(".stream");
      if (!stream) {
        stream = el("div", "stream");
        stream.style.whiteSpace = "pre-wrap";
        node.append(stream);
      }
      stream.textContent = buf.text;
      // 实时会话里 assistant 条目到达时 `text` 还是空的，内容靠 delta 长出来；按 id 记下来，卡片才拿得到。
      // `_raw` 一起写，/copy 在实时会话里才拿得到东西。
      if (buf.text.trim()) {
        this.assistantTexts.set(id, buf.text);
        this.noteAnswered();
      }
      (node as HTMLElement & { _raw?: string })._raw = buf.text;
    }
    // reasoning is buffered but never painted: the transcript shows prose and tool calls only
    this.scrollToEnd();
  }

  toolEvent(phase: "start" | "update" | "end", data: any): void {
    const key = String(data.toolCallId ?? "");
    if (!key) return;
    const prior = this.loaded.find((item): item is ToolItem => item.kind === "tool" && item.toolCallId === key);
    if (phase === "start") {
      this.remember({
        id: `live-tool:${key}`,
        ts: new Date().toISOString(),
        kind: "tool",
        toolCallId: key,
        name: String(data.name ?? "tool"),
        args: data.args,
        status: "running",
      });
    } else if (prior) {
      this.remember({
        ...prior,
        ...(phase === "update" && data.partial ? { partialResult: String(data.partial) } : {}),
        ...(phase === "end" ? {
          result: String(data.result ?? ""),
          durationMs: Number(data.durationMs ?? 0),
          isError: Boolean(data.isError),
          status: data.isError ? "error" : "ok",
        } : {}),
      });
    }
    let card = this.toolCards.get(key);
    if (!card && phase === "start") {
      card = this.buildTool({
        id: `live-tool:${key}`,
        kind: "tool",
        toolCallId: key,
        name: String(data.name ?? "tool"),
        args: data.args,
        status: "running",
      });
      this.toolCards.set(key, card);
      this.cards.set(`live-tool:${key}`, card);
      if (this.isAskTool(data.name)) this.push(card);
      else {
        this.ensureOps().append(card);
        this.refreshOps();
        this.noteWrite(data.name, data.args);
      }
    }
    if (!card) return;

    // Live snapshot for the hover card: name/summary once, output as it streams.
    if (phase === "start" || this.liveKey !== key) {
      this.liveKey = key;
      this.live = {
        name: String(data.name ?? "tool"),
        args: compactArgs(data.args),
        summary: String(data.summary ?? ""),
        output: "",
        thinking: this.live.thinking,
        startedAt: Date.now(),
      };
    }
    if (phase === "update" && data.partial) this.live.output = String(data.partial).slice(-2000);
    if (phase === "end") this.live.output = String(data.result ?? this.live.output ?? "").slice(-2000);

    // A question card paints itself from the tool item (buildAsk): no stream, no raw output, and a
    // cancelled question is not a failure worth a red border.
    if (card.classList.contains("qa-card")) {
      if (phase === "end") card.dataset.running = "0";
      this.scrollToEnd();
      return;
    }

    if (phase === "start") {
      const cmd = card.querySelector<HTMLElement>(".cmd");
      if (cmd && data.summary) setCommand(cmd, String(data.summary), data.name ? String(data.name) : undefined);
      const status = card.querySelector<HTMLElement>(".status");
      if (status) status.textContent = tr("运行中…");
    } else if (phase === "update" && data.partial) {
      let out = card.querySelector<HTMLElement>(".out");
      if (!out) {
        out = el("div", "out");
        card.append(out);
      }
      out.textContent = String(data.partial);
    } else if (phase === "end") {
      card.classList.toggle("err", Boolean(data.isError));
      card.dataset.running = "0";
      const status = card.querySelector<HTMLElement>(".status");
      if (status) status.textContent = data.isError ? tr("失败") : `${Math.round(Number(data.durationMs ?? 0) / 100) / 10}s`;
      if (data.result) {
        let out = card.querySelector<HTMLElement>(".out");
        if (!out) {
          out = el("div", "out");
          card.append(out);
        }
        setOutput(out, String(data.result));
      }
      const details = card.querySelector<HTMLDetailsElement>("details");
      if (details) details.open = Boolean(data.isError);
      if (data.isError) {
        const name = card.querySelector(".name")?.textContent?.trim() || String(data.name ?? "tool");
        const cmd = card.querySelector(".cmd")?.textContent?.trim() || "";
        this.failureCard(key, { tool: name, cmd, out: String(data.result ?? "") }, Number(data.durationMs ?? 0));
        // `live`: 这是刚跑完的一次（不是历史回放），只有它值得「当场叫住」。
        this.onFail?.({ id: key, tool: name, cmd, out: String(data.result ?? ""), live: true });
      } else {
        this.noteAfter({
          id: `live-tool:${key}`,
          kind: "tool",
          toolCallId: key,
          name: String(data.name ?? "tool"),
          args: data.args,
          status: "ok",
          isError: false,
          result: String(data.result ?? ""),
        });
      }
      this.refreshOps();
    }
    this.scrollToEnd();
  }

  private mergeTool(card: HTMLElement, item: ToolItem): void {
    const cmd = card.querySelector<HTMLElement>(".cmd");
    if (cmd && item.args != null) {
      const args = item.args as Record<string, unknown>;
      const summary = ["command", "cmd", "file_path", "path", "pattern", "query"].map((k) => args?.[k]).find((v) => typeof v === "string");
      if (typeof summary === "string") setCommand(cmd, summary, item.name);
    }
    const status = card.querySelector<HTMLElement>(".status");
    if (status && item.status && item.status !== "unknown") status.textContent = item.status === "error" ? tr("失败") : tr("完成");
    if (item.result) {
      let out = card.querySelector<HTMLElement>(".out");
      if (!out) {
        out = el("div", "out");
        card.append(out);
      }
      setOutput(out, item.result);
    }
    if (item.isError) card.classList.add("err");
    if (item.status && item.status !== "unknown" && item.status !== "running") card.dataset.running = "0";
    this.refreshOps();
    if (item.isError || item.status === "error") this.failFromItem(item);
  }

  private failFromItem(item: ToolItem): void {
    // 按这条工具调用所属的 assistant 消息取原话（平行调用共享同一条消息，不会串到上一次）。
    const said = (this.assistantTexts.get(item.id.split(":")[0]) ?? "").trim();
    const input: FailureInput = {
      tool: item.name,
      cmd: toolSummary(item),
      out: String(item.result ?? item.partialResult ?? ""),
      // 模型这句话是它自己的意图；什么都没说时留空，交给 diagnose 按命令推——绝不拿用户的话冒充。
      intent: said,
    };
    const at = this.turnFails.findIndex((f) => f.key === item.toolCallId);
    if (at >= 0) this.turnFails[at].input = input;
    else this.turnFails.push({ key: item.toolCallId, input });
    this.failureCard(item.toolCallId, input, item.durationMs);
    this.onFail?.({ id: item.toolCallId, tool: item.name, cmd: input.cmd, out: input.out, at: item.ts });
  }

  /**
   * 同一轮里后续有工具跑通时，给前面那些失败条目补一句事实：「后来它改用 X 拿了结果」。
   * 只补第一次跑通的那一步（再往后的过程对读者是噪声），并且对同一张卡只补一次。
   */
  private noteAfter(item: ToolItem): void {
    if (item.isError || item.status === "error" || item.status === "running") return;
    for (const fail of this.turnFails) {
      if (fail.input.after) continue;
      fail.input.after =
        fail.input.tool === item.name
          ? tr("后来它把同一条重做了一遍，这次跑通了")
          : tr("随后它改用 {p1}，拿到了结果", { p1: item.name });
      this.failureCard(fail.key, fail.input);
    }
  }

  /** 新一轮开始时把本轮登记清掉（后续是给「这一轮」看的）。 */
  private clearTurnFails(): void {
    this.turnFails = [];
  }

  /** 模型这一轮开口了（正文开始出现）：已经补过后续的卡片可以再说一句「最后给出了回答」。 */
  private noteAnswered(): void {
    const tail = tr("，并在这一轮给出了回答");
    for (const fail of this.turnFails) {
      if (!fail.input.after || fail.input.after.endsWith(tail)) continue;
      fail.input.after += tail;
      this.failureCard(fail.key, fail.input);
    }
  }

  /**
   * A failure goes on the module's own second page (「AI 执行失败」) — what happened, why, what
   * next, and the few lines that prove it. Nothing is added to the transcript itself: one turn
   * stays one block. Keyed by toolCallId so a live run and a replayed session render identically;
   * a repeat call rebuilds the item in place (the store may fill in the result after the error is
   * reported) without collapsing the raw log the reader just opened.
   */
  private failureCard(key: string, input: FailureInput, ms?: number): void {
    this.ensureOps();
    const panel = this.opsPanelEl("fail");
    if (!panel) return;
    const next = buildFailureItem(input, ms);
    const prev = this.failCards.get(key);
    // A rebuild must not slam the raw log shut under the cursor: carry the user's expand over.
    if (prev?.querySelector("details.raw")?.hasAttribute("open")) {
      next.querySelector("details.raw")?.setAttribute("open", "");
    }
    if (prev && prev.parentNode) prev.replaceWith(next);
    else panel.append(next);
    this.failCards.set(key, next);
    this.refreshOps();
    this.scrollToEnd();
  }

  private build(item: Item): HTMLElement {
    if (item.kind === "notice") {
      const node = el("div", `notice ${item.level ?? ""}`, item.text);
      return node;
    }
    if (item.kind === "tool") return this.buildTool(item);
    if (item.kind === "bash") return this.buildBash(item);
    if (item.kind === "skill") return this.buildSkill(item);
    if (item.kind === "summary") {
      // Folded by default: it is context the model reads, not something the user needs to reread.
      const box = el("details", `summary-card ${item.variant}`);
      box.append(el("summary", "", `${item.title} · ${timeOf(item.ts)}`));
      const body = el("div", "body");
      body.append(renderMarkdown(item.text));
      box.append(body);
      return box;
    }

    const reminded = item.kind === "user" ? reminderBody(item.text) : null;
    const reviewed = item.kind === "user" ? reviewBody(item.text) : null;
    const wrapKind = (): string => {
      if (reminded !== null) return "remind";
      if (reviewed !== null) return "review";
      return item.kind;
    };
    const wrap = el("div", `msg ${wrapKind()}`);
    if (item.kind === "assistant") (wrap as HTMLElement & { _raw?: string })._raw = item.text;
    // 桥注入的自动提醒（D169）：它是一条真正的 user 消息（pi 只有 prompt 通道），但说这话的不是人，
    // 所以不画成气泡、不给复制/分叉，抬头用界面语言，正文才是桥写的那段（内容本身来自账本/诊断，是中文数据）。
    if (reminded !== null) {
      const head = el("div", "who");
      head.textContent = tr("自动提醒 · 老毛病重犯 · {p1}", { p1: timeOf(item.ts) });
      const body = el("div", "body");
      body.textContent = reminded;
      wrap.append(head, body);
      return wrap;
    }
    // 「⚡ 复盘」那一轮也是一条 user 消息（桥只有 prompt 通道），但它是一段写给模型的交代：
    // 原样排开（保留换行），不画气泡，免得人以为自己打过这一大段。
    if (reviewed !== null) {
      const head = el("div", "who");
      head.textContent = tr("⚡ 自动复盘 · {p1}", { p1: timeOf(item.ts) });
      const body = el("div", "body");
      body.textContent = reviewDisplay(reviewed);
      wrap.append(head, body);
      return wrap;
    }
    const who = el("div", "who");
    if (item.kind === "user") {
      who.textContent = tr("你 · {p1}", { p1: timeOf(item.ts) });
      if (item.text.trim()) who.append(copyButton(() => item.text));
      if (this.onFork && item.text.trim()) {
        // #17 `/fork`: a new session holding everything before this message, the message back in the editor.
        const fork = el("button", "msg-copy msg-fork", "⑂") as HTMLButtonElement;
        fork.type = "button";
        fork.title = tr("从这条消息之前分叉成新会话（这条消息放回输入框）");
        fork.onclick = (ev) => {
          ev.stopPropagation();
          const index = [...this.root.querySelectorAll(".msg.user")].indexOf(wrap);
          this.onFork?.({ id: item.id, text: item.text }, index);
        };
        who.append(fork);
      }
      wrap.append(who, this.foldable(this.buildUserBody(item), 240));
    } else {
      who.textContent = tr("{p1} · {p2}{p3}", { p1: item.model ?? "pi", p2: timeOf(item.ts), p3: item.stopReason === "aborted" ? tr(" · 已中断") : "" });
      if (item.text.trim()) who.append(copyButton(() => item.text));
      wrap.append(who);
      // A message that only carries thinking/tool calls has no prose to show:
      // an empty bubble there is pure noise. `delta()` appends `.stream` itself,
      // and removes `.no-text` so the header reappears with the first token.
      if ((item.text || "").trim()) {
        const body = el("div", "body");
        body.append(renderMarkdown(item.text));
        const peek = el("button", "msg-peek", previewLine(item.text));
        peek.title = tr("展开回答");
        const fold = foldHead("msg-fold");
        peek.type = "button";
        const id = item.id;
        const apply = (collapsed: boolean) => {
          wrap.classList.toggle("collapsed", collapsed);
          fold.setOpen(!collapsed);
        };
        const toggle = () => {
          const next = !wrap.classList.contains("collapsed");
          if (next) this.collapsed.add(id);
          else this.collapsed.delete(id);
          apply(next);
          // 折起来会把内容缩掉一大截：下面可能就此空了，那颗钮不能还留在那儿（D168）。
          this.renderJump();
        };
        fold.onclick = toggle;
        peek.onclick = toggle;
        apply(this.collapsed.has(id));
        who.append(fold);
        wrap.append(body, peek);
      } else if (item.stopReason !== "error") {
        wrap.classList.add("no-text");
      }
      // A failed call usually has no prose at all: without this the turn ends in an empty bubble
      // and the reason (bad key, rate limit, context overflow…) is invisible.
      if (item.stopReason === "error") {
        wrap.append(el("div", "msg-error", tr("模型调用出错：{p1}", { p1: item.errorMessage?.trim() || tr("pi 没有给出原因") })));
        // #375：这条 400 几乎都是 billion-context 压缩拆开了签名 thinking，重试不会好；说清怎么办。
        if (THINKING_MODIFIED_RE.test(item.errorMessage ?? "")) {
          wrap.append(
            el(
              "div",
              "msg-error-hint",
              tr("装了 billion-context 的话，这是它的已知问题：压缩拆开了带签名的思考块，重试不会好。换个模型就能接着聊；到「设置 → 子代理 → acp_delegate」点「应用绕法」可以避免以后再出现。"),
            ),
          );
        }
        this.onFail?.({ id: item.id, tool: "model", cmd: item.modelName ?? item.model ?? "", out: item.errorMessage ?? "", at: item.ts });
      } else if (item.stopReason === "aborted") {
        // 用户按停止也算一次「没跑完」：进账本但折叠在「已中断」里，不计待修（D164）。
        this.onFail?.({ id: item.id, tool: "model", cmd: item.modelName ?? item.model ?? "", out: "aborted", at: item.ts });
      }
    }
    return wrap;
  }

  /** Close the current turn's tool module: the next tool call starts a fresh one. */
  private closeOps(): void {
    this.opsBody = null;
    this.opsTitle = null;
    this.opsBox = null;
    this.opsFiles = null;
  }

  /** Files written or edited so far, newest first. */
  /**
   * D208: 产物弹窗要的是「这条路径在这个会话里被写过几次、最后一次用什么工具」，不是文件状态 ——
   * 状态得桥去比写入前的原文（write 覆盖已有文件同样是「修改」）。相对/绝对写法故意原样保留：
   * 桥会按 abs 去重，这里要是合并了反而看不出用户当时用的是哪种写法。
   */
  artifacts(): { path: string; tool: string; writes: number }[] {
    return [...this.written.entries()].reverse().map(([path, v]) => ({ path, tool: v.tool, writes: v.writes }));
  }

  /** A write/edit lands in the session's artifact list and as a chip under this turn's module. */
  private noteWrite(name: unknown, args: unknown): void {
    const tool = String(name ?? "").toLowerCase();
    if (!WRITE_TOOLS.has(tool)) return;
    const path = toolPath(args);
    if (!path) return;
    // 同一个路径再写一次：计数 +1，同时挪到 Map 末尾（artifacts() 反着取 = 最近写的在前）。
    const prev = this.written.get(path);
    this.written.delete(path);
    this.written.set(path, { tool, at: Date.now(), writes: (prev?.writes ?? 0) + 1 });
    const box = this.opsBox;
    if (!box || box.parentNode !== this.root) return;
    if (!this.opsFiles || !this.opsFiles.isConnected) {
      this.opsFiles = el("div", "ops-files");
      this.opsFiles.append(el("span", "ops-files-label", tr("产物")));
      box.after(this.opsFiles);
    }
    const files = this.opsFiles;
    if ([...files.querySelectorAll<HTMLElement>(".file-chip")].some((c) => c.dataset.path === path)) return;
    // #421：chip 主体不再可点，动作拆成右边两颗按钮（引用 / 打开）——套 <button> 里不能再嵌按钮，所以容器是 span。
    const chip = el("span", "file-chip");
    chip.dataset.path = path;
    chip.title = path;
    chip.append(el("span", "ico", fileIcon(path)), el("span", "nm fc-chip-name", baseName(path)));
    const quote = el("button", "fc-chip-act quote", tr("引用")) as HTMLButtonElement;
    quote.type = "button";
    quote.title = tr("把路径引用到输入框");
    quote.onclick = () => window.dispatchEvent(new CustomEvent("pi-quote", { detail: { path } }));
    const open = el("button", "fc-chip-act", tr("打开")) as HTMLButtonElement;
    open.type = "button";
    open.title = tr("在预览里打开");
    open.onclick = () => openPreview(path);
    chip.append(quote, open);
    files.append(chip);
  }

  /** Where a module page lives: 「操作」holds the tool rows, 「AI 执行失败」the diagnostics. */
  private opsPanelEl(name: "ops" | "fail"): HTMLElement | null {
    return this.opsBox?.querySelector<HTMLElement>(`.ops-panel[data-panel="${name}"]`) ?? null;
  }

  /**
   * Lazily create the `<details>` that collects this turn: one block, two pages (「操作」 /
   * 「AI 执行失败」). The tab bar only shows up once there is a second page — a turn where nothing
   * failed looks exactly like it used to. Nothing about this turn escapes the block.
   */
  private ensureOps(): HTMLElement {
    if (this.opsBody) return this.opsBody;
    const box = el("details", "ops");
    const summary = el("summary", "ops-summary");
    const title = el("span", "ops-title", tr("工具操作"));
    summary.append(el("span", "chev", "▸"), title);
    const body = el("div", "ops-body");
    const tabs = el("div", "ops-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.hidden = true;
    const tab = (id: "ops" | "fail", label: string): HTMLButtonElement => {
      const btn = el("button", "ops-tab") as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.panel = id;
      btn.setAttribute("role", "tab");
      btn.append(document.createTextNode(label));
      btn.onclick = () => this.showOpsPanel(id);
      tabs.append(btn);
      return btn;
    };
    tab("ops", tr("操作")).classList.add("is-on");
    tab("fail", tr("AI 执行失败")).append(el("b", "cnt", "0"));
    const opsPanel = el("div", "ops-panel");
    opsPanel.dataset.panel = "ops";
    const failPanel = el("div", "ops-panel");
    failPanel.dataset.panel = "fail";
    failPanel.hidden = true;
    body.append(tabs, opsPanel, failPanel);
    box.append(summary, body);
    this.push(box);
    this.opsBody = opsPanel;
    this.opsTitle = title;
    this.opsBox = box;
    return opsPanel;
  }

  /** Switch pages. The module's own open/closed state is the user's, not ours — never touched here. */
  private showOpsPanel(name: "ops" | "fail"): void {
    const box = this.opsBox;
    if (!box) return;
    for (const tab of box.querySelectorAll<HTMLElement>(".ops-tab")) {
      const on = tab.dataset.panel === name;
      tab.classList.toggle("is-on", on);
      tab.setAttribute("aria-selected", String(on));
    }
    for (const panel of box.querySelectorAll<HTMLElement>(".ops-panel")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    this.renderJump();
  }

  /**
   * The tab bar is a switch, so it only earns its row when there is something to switch to: the
   * second page exists exactly when this turn has at least one failure.
   */
  private syncOpsTabs(): void {
    const box = this.opsBox;
    const panel = this.opsPanelEl("fail");
    if (!box || !panel) return;
    const n = panel.childElementCount;
    const tabs = box.querySelector<HTMLElement>(".ops-tabs");
    const failTab = box.querySelector<HTMLElement>(".ops-tab[data-panel=\"fail\"]");
    if (!tabs || !failTab) return;
    const cnt = failTab.querySelector(".cnt");
    if (cnt) cnt.textContent = String(n);
    tabs.hidden = n === 0;
    if (!n && failTab.classList.contains("is-on")) this.showOpsPanel("ops");
  }

  /** Recount the module title from the cards actually in the DOM. */
  private refreshOps(): void {
    this.syncOpsTabs();
    const body = this.opsBody;
    const title = this.opsTitle;
    if (!body || !title) return;
    const cards = Array.from(body.children).filter(
      (n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("tool"),
    );
    const fails = this.opsPanelEl("fail")?.childElementCount ?? 0;
    if (!cards.length && !fails) return;
    const counts = new Map<string, number>();
    let running = 0;
    for (const card of cards) {
      const name = card.querySelector(".name")?.textContent?.trim() || "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (card.dataset.running === "1") running += 1;
    }
    const parts = [...counts].map(([name, n]) => `${name} ×${n}`);
    if (cards.length) {
      title.replaceChildren(document.createTextNode(tr("{p1} 个操作 · {p2}", { p1: cards.length, p2: parts.join(" · ") })));
    }
    if (fails) title.append(el("span", "ops-flag err", tr(" · {p1} 失败", { p1: fails })));
    if (running) title.append(el("span", "ops-flag live", tr(" · 运行中")));
  }

  /**
   * Q-004: only tall blocks get a fold control. The test is measured height, not a character
   * count, so a narrow pane folds sooner than a wide one — and it is re-measured when the pane
   * is resized by its grip (Q-003), which a one-shot check would miss.
   */
  private foldable(body: HTMLElement, maxPx: number): HTMLElement {
    if (!body.childNodes.length) return body;
    const box = el("div", "foldable");
    const clip = el("div", "fold-body");
    clip.append(body);
    const btn = foldHead("fold-btn");
    const apply = () => {
      btn.setOpen(!box.classList.contains("folded"));
    };
    btn.onclick = () => {
      box.classList.toggle("folded");
      apply();
      // 同 buildAssistant 里的折行：内容缩水后「下面还有东西」可能不再成立（D168）。
      this.renderJump();
    };
    let tall = false;
    const measure = () => {
      // scrollHeight is the content height, so it reads the same while folded and after a resize.
      const next = body.scrollHeight > maxPx + 8;
      if (next === tall) return;
      tall = next;
      box.classList.toggle("has-fold", tall);
      if (!tall) box.classList.remove("folded");
      apply();
    };
    new ResizeObserver(measure).observe(clip);
    box.append(clip, btn);
    apply();
    // The node is measured before it is in the document, so re-check once layout is real.
    requestAnimationFrame(measure);
    return box;
  }

  private buildUserBody(item: UserItem): HTMLElement {
    const body = el("div", "body");
    const reminded = reminderBody(item.text);
    if (reminded !== null) {
      body.textContent = reminded;
      return body;
    }
    const reviewed = reviewBody(item.text);
    if (reviewed !== null) {
      body.textContent = reviewDisplay(reviewed);
      return body;
    }
    // 命令画成药丸、用户自己写的话原样跟在后面，规则在 skill.ts（与桥端的折叠规则成对）。
    fillUserBody(body, item);
    if (item.images?.length) {
      const box = el("div", "msg-images");
      const fallback = el("div", "notice", tr("附 {p1} 张图片", { p1: item.images.length }));
      item.images.forEach((_, index) => {
        const src = this.imageSource?.(item.id, index) ?? null;
        if (!src) return;
        const thumb = el("img") as HTMLImageElement;
        thumb.src = src;
        thumb.alt = tr("消息里的图片 {p1}", { p1: index + 1 });
        thumb.loading = "lazy";
        thumb.decoding = "async";
        const btn = el("button", "msg-image") as HTMLButtonElement;
        btn.type = "button";
        btn.title = tr("点击查看大图");
        btn.append(thumb);
        btn.onclick = () => openImage(src, thumb.alt);
        // 老会话被裁过尾、条目已经不在文件里时，图会读不到：退回一行文字，至少不是一块碎图。
        thumb.addEventListener("error", () => {
          btn.remove();
          if (!box.querySelector(".msg-image")) fallback.hidden = false;
        });
        box.append(btn);
      });
      if (box.children.length) {
        fallback.hidden = true;
        body.append(box, fallback);
      } else {
        body.append(fallback);
      }
    }
    return body;
  }

  /**
   * 本轮的技能组：一行摘要（自动加载 · N 个技能 · 名字…），点开是每张卡。用 `<details>` 而不是
   * 自绘开关：折叠状态归浏览器，后面再追加技能时也不会被重画成展开。
   */
  private ensureSkillGroup(): SkillGroup {
    if (this.skillGroup) return this.skillGroup;
    const box = el("details", "skillgroup");
    const summary = el("summary");
    const count = el("span", "skillgroup-n");
    const names = el("span", "skillgroup-names");
    summary.append(el("span", "chev", "▸"), el("span", "auto", tr("自动加载")), count, names);
    const body = el("div", "skillgroup-body");
    box.append(summary, body);
    this.push(box);
    this.skillGroup = { body, count, names, skillNames: [] };
    return this.skillGroup;
  }

  /** 一张技能卡落进本轮的组里，摘要行（数量 + 名字）跟着刷新 —— 实时再来一张也只是多一行字。 */
  private groupSkill(card: HTMLElement, item: SkillItem): void {
    const group = this.ensureSkillGroup();
    group.body.append(card);
    group.skillNames.push(item.name);
    group.count.textContent = tr("{p1} 个技能", { p1: group.skillNames.length });
    const all = group.skillNames.join(" · ");
    // 名字多时摘要行省略（CSS），全文挂在 title 上。
    group.names.textContent = all;
    group.names.title = tr("自动加载：{p1}", { p1: all });
  }

  /**
   * 隐式触发的技能（D199）：模型没说过自己用了什么，只在 `read` 里读了一份 SKILL.md。
   * 卡上答两件事：这个技能是干什么的（frontmatter 那句），以及它为什么在这轮被读
   * （它读之前自己说的那句；没说话就退回你这轮的话）。
   */
  private buildSkill(item: SkillItem): HTMLElement {
    const card = el("article", "skillcard");
    const row = el("div", "row");
    row.append(el("span", "n", item.name));
    row.append(el("span", "auto", tr("自动加载")));
    if (item.path) {
      const src = el("button", "src", "SKILL.md");
      src.title = item.path;
      src.onclick = (ev) => {
        ev.stopPropagation();
        openPreview(String(item.path));
      };
      row.append(src);
    }
    card.append(row);
    const desc = el("p", "desc", item.description || tr("这个技能没写描述"));
    // 卡上只给两行（CSS clamp），全文挂在 title 上：描述往往是「干什么 + 什么时候用」一整段。
    if (item.description) desc.title = item.description;
    card.append(desc);
    if (item.why) {
      card.append(
        el(
          "p",
          "why",
          item.whyFrom === "model"
            ? tr("触发线索：它读之前说「{p1}」", { p1: item.why })
            : tr("触发线索：你这轮说「{p1}」", { p1: item.why }),
        ),
      );
    }
    return card;
  }

  /** A `!cmd` the user ran: its own card, not part of the model's tool module (#16). */
  private buildBash(item: BashItem): HTMLElement {
    const wrap = el("div", `msg bash ${item.status}`);
    wrap.append(el("div", "who", tr("你 · {p1} 命令 · {p2}", { p1: item.excludeFromContext ? "!!" : "!", p2: timeOf(item.ts) })));
    const card = el("div", "bash-card");
    const head = el("div", "bash-head");
    head.append(el("code", "bash-cmd", `$ ${item.command}`));
    const tag = el("span", `bash-tag${item.excludeFromContext ? " off" : ""}`, item.excludeFromContext ? tr("不进上下文") : tr("下一条消息时进上下文"));
    tag.title = item.excludeFromContext
      ? tr("!! 命令：输出存在会话里，但不会发给模型")
      : tr("! 命令：输出会在你发下一条消息时一起交给模型（pi 的规则）");
    head.append(tag);
    let state: string;
    let cls = "";
    if (item.status === "queued") state = tr("等待 pi 启动…");
    else if (item.status === "running") state = tr("运行中…");
    else if (item.error) {
      state = tr("失败");
      cls = " bad";
    } else if (item.cancelled) {
      state = tr("已停止");
      cls = " bad";
    } else if (item.exitCode === 0) state = "exit 0";
    else {
      state = item.exitCode == null ? tr("结束") : `exit ${item.exitCode}`;
      cls = item.exitCode == null ? "" : " bad";
    }
    const stateEl = el("span", `bash-state${cls}`, state);
    // #202 / D183: 排队的 `!` 和启动提示同一个语气：一枚小转环，不新造视觉。
    if (item.status === "queued") stateEl.prepend(el("span", "act-spin"));
    head.append(stateEl);
    if (item.status === "running") {
      const stop = el("button", "tool-btn bash-stop", tr("停止")) as HTMLButtonElement;
      stop.type = "button";
      stop.onclick = () => this.onBashStop?.(item.id);
      head.append(stop);
    }
    const out = el("pre", "bash-out", item.output || (item.status === "done" ? tr("（没有输出）") : ""));
    card.append(head, out);
    if (item.error) card.append(el("div", "bash-foot bad", item.error));
    if (item.truncated) card.append(el("div", "bash-foot", tr("输出太长，只显示末尾。完整内容：{p1}", { p1: item.fullOutputPath ?? tr("（pi 没给路径）") })));
    wrap.append(card);
    return wrap;
  }

  /** The last answer with prose, for `/copy` (#24). */
  lastAssistantText(): string | null {
    for (const node of [...this.root.querySelectorAll<HTMLElement>(".msg.assistant")].reverse()) {
      const text = (node as HTMLElement & { _raw?: string })._raw;
      if (text && text.trim()) return text;
    }
    return null;
  }

  /** Streamed output of a running `!cmd`. */
  bashDelta(id: string, text: string): void {
    const node = this.cards.get(id);
    const out = node?.querySelector<HTMLElement>(".bash-out");
    if (!out) return;
    const next = (out.textContent ?? "") + text;
    out.textContent = next.length > BASH_SHOW ? next.slice(-BASH_SHOW) : next;
    out.scrollTop = out.scrollHeight;
    this.scrollToEnd();
  }

  /** Bubbles of queued messages that were pulled back into the editor (#9, #14). */
  remove(ids: string[]): void {
    const removed = new Set(ids);
    this.loaded = this.loaded.filter((item) => !removed.has(item.id));
    let droppedUser = false;
    for (const id of ids) {
      this.cards.get(id)?.remove();
      this.cards.delete(id);
      // #199: 用户气泡被撤掉时，`users` 里那枚也要跟着走 —— 否则 bootingCount() 还在替它
      // 数数，状态行的「撤回」撤完了也不肯消失。
      if (this.users.delete(id)) droppedUser = true;
    }
    if (droppedUser) this.paintPending();
    // 抽走的可能是最后几屏内容：下面空了，钮就该收起（D168）。
    this.renderJump();
  }

  private buildTool(item: ToolItem): HTMLElement {
    if (this.isAskTool(item.name)) return this.buildAsk(item);
    if (this.isTodoTool(item.name)) return this.buildTodo(item);
    const card = el("div", "tool");
    card.dataset.running = item.status === "running" ? "1" : "0";
    if (item.isError || item.status === "error") card.classList.add("err");
    const head = el("div", "head");
    head.append(el("span", "name", item.name));
    const cmdSpan = el("span", "cmd");
    setCommand(cmdSpan, toolSummary(item), item.name);
    head.append(cmdSpan);
    let status = "";
    if (item.status === "running") status = tr("运行中…");
    else if (item.isError) status = tr("失败");
    head.append(el("span", "status", status));
    const path = toolPath(item.args);
    if (path) {
      const view = el("button", "tool-preview", tr("预览"));
      view.title = tr("预览 {p1}", { p1: path });
      view.onclick = (ev) => {
        ev.stopPropagation();
        openPreview(path);
      };
      head.append(view);
    }
    card.append(head);

    if (item.result || item.partialResult) {
      const out = el("div", "out");
      setOutput(out, String(item.result ?? item.partialResult ?? ""));
      if (item.durationMs) {
        const details = el("details");
        details.append(el("summary", "", `${Math.round(item.durationMs / 100) / 10}s`));
        card.append(details);
      }
      card.append(out);
    }
    return card;
  }

  /**
   * `question` / `questionnaire` are the one tool whose transcript entry *is* the content: show each
   * question and the answer that came back. Pending cards open the drawer when tapped.
   */
  /**
   * #341: 一轮里的 `todo` 调用折成一张卡（用户要求）：主行是最新一次的快照，右边一枚「▾ N」
   * 展开这一轮的每次更新；点主行仍然是去执行面板看计划。
   */
  private buildTodo(item: ToolItem): HTMLElement {
    const node = el("div", "tool todo-group");
    const row = el("div", "todo-row");
    const main = el("button", "todo-tool") as HTMLButtonElement;
    main.type = "button";
    main.title = tr("点击查看执行面板计划");
    const label = el("span", "todo-summary");
    main.append(el("span", "todo-icon", "📋"), label);
    main.onclick = () => this.onTodoClick?.();
    const toggle = el("button", "todo-toggle") as HTMLButtonElement;
    toggle.type = "button";
    toggle.hidden = true;
    toggle.title = tr("展开这一轮的计划更新");
    const list = el("ol", "todo-updates");
    list.hidden = true;
    toggle.onclick = () => {
      list.hidden = !list.hidden;
      toggle.setAttribute("aria-expanded", String(!list.hidden));
      toggle.textContent = list.hidden ? "▾" : "▴";
      toggle.title = list.hidden ? tr("展开这一轮的计划更新") : tr("收起计划更新");
    };
    row.append(main, toggle);
    node.append(row, list);
    this.todoGroup = { node, main, label, toggle, list, updates: [] };
    this.addTodoUpdate(item);
    return node;
  }

  /** #341: 往当前折叠卡里添一条更新；主行、次数、展开钮随之刷新。 */
  private addTodoUpdate(item: ToolItem): void {
    const group = this.todoGroup;
    if (!group) return;
    const row = el("li", "todo-update");
    row.dataset.status = todoStatus(item);
    const mark = el("span", "todo-mark", todoMark(item));
    const text = el("span", "todo-text", this.todoText(item));
    row.append(mark, text, el("span", "todo-at", timeOf(item.ts)));
    group.list.append(row);
    const update = { key: item.toolCallId, item, row, mark, text };
    group.updates.push(update);
    this.todoRows.set(item.toolCallId, { group, update });
    this.paintTodoGroup(group);
  }

  /** #341: 结果帧到达时就地改那一行（`mergeTool` 的 todo 版本）。改到了就返回它所在的分组。 */
  private updateTodo(item: ToolItem): TodoGroup | null {
    const slot = this.todoRows.get(item.toolCallId);
    const group = slot?.group ?? this.todoGroup;
    const hit = slot?.update ?? group?.updates.find((update) => update.key === item.toolCallId || update.item.id === item.id);
    if (!group || !hit) return null;
    hit.item = item;
    hit.row.dataset.status = todoStatus(item);
    hit.mark.textContent = todoMark(item);
    hit.text.textContent = this.todoText(item);
    this.paintTodoGroup(group);
    return group;
  }

  private paintTodoGroup(group = this.todoGroup): void {
    if (!group || !group.updates.length) return;
    const latest = group.updates[group.updates.length - 1].item;
    const n = group.updates.length;
    const summary = this.todoText(latest) + (n > 1 ? tr(" · {p1} 次更新", { p1: String(n) }) : "");
    group.label.textContent = summary;
    group.main.setAttribute("aria-label", summary);
    group.node.dataset.running = latest.status === "running" ? "1" : "0";
    group.node.classList.toggle("err", Boolean(latest.isError || latest.status === "error"));
    group.toggle.hidden = n < 2;
    if (!group.toggle.hidden) group.toggle.textContent = group.list.hidden ? "▾" : "▴";
  }

  /** #341: 一条 `todo` 调用在聊天里的说法（不含图标）。 */
  private todoText(item: ToolItem): string {
    const tasks = item.plan?.tasks.filter((task) => task.status !== "deleted") ?? [];
    const done = tasks.filter((task) => task.status === "completed").length;
    const args = item.args && typeof item.args === "object" ? item.args as Record<string, unknown> : {};
    const task = item.plan?.tasks.find((candidate) => candidate.id === Number(args.id));
    const subject = typeof args.subject === "string" ? args.subject : task?.subject ?? "";
    const action = String(args.action ?? "");
    const status = String(args.status ?? task?.status ?? "");
    let actionText = tr("更新计划");
    if (action === "clear") actionText = tr("清空计划");
    else if (action === "create" || action === "add") actionText = tr("新增「{p1}」", { p1: subject || tr("计划项") });
    else if (status === "in_progress") actionText = tr("开始「{p1}」", { p1: subject || tr("计划项") });
    else if (status === "completed") actionText = tr("完成「{p1}」", { p1: subject || tr("计划项") });
    return tr("计划 {p1}/{p2} · {p3}", { p1: done, p2: tasks.length, p3: actionText });
  }

  /**
   * The tools whose transcript entry is a question card, not an entry of the ops module: the two
   * extensions we used to patch (`question` / `questionnaire`, still in old session files) and the
   * one that replaced them (`ask_user_question`, `@juicesharp/rpiv-ask-user-question`).
   */
  private isAskTool(name: unknown): boolean {
    const n = String(name ?? "");
    return n === "question" || n === "questionnaire" || n === "ask_user_question";
  }

  private isTodoTool(name: unknown): boolean {
    return String(name ?? "").toLowerCase() === "todo";
  }

  private buildAsk(item: ToolItem): HTMLElement {
    const card = el("div", "tool qa-card");
    card.dataset.running = item.status === "running" ? "1" : "0";

    const questions = askQuestions(item.args);
    const single = questions.length === 1;
    const pending = item.status === "running";

    const head = el("div", "head");
    head.append(el("span", "name", single ? tr("提问") : tr("问卷 · {p1} 题", { p1: questions.length })));
    head.append(el("span", "status", pending ? tr("等你回答…") : ""));
    card.append(head);

    const answers = parseAskResult(String(item.result ?? item.partialResult ?? ""), questions);
    const body = el("div", "qa-body");
    questions.forEach((q, i) => {
      const row = el("div", "qa-q");
      if (questions.length > 1) row.append(el("div", "qa-label", String(q?.label ?? `Q${i + 1}`)));
      row.append(el("div", "qa-prompt", String(q?.prompt ?? "")));
      const hit = answers[i];
      if (hit) row.append(el("div", "qa-a", `✓ ${hit}`));
      else if (!pending) {
        const cancelled = /cancel|declined|取消/i.test(String(item.result ?? ""));
        row.append(el("div", "qa-a pending", cancelled ? tr("已取消") : tr("未回答")));
      }
      body.append(row);
    });
    card.append(this.foldable(body, 220));
    if (pending) {
      card.classList.add("clickable");
      card.title = tr("点一下打开答题");
      card.onclick = () => window.dispatchEvent(new CustomEvent("pi-ask-open"));
    }
    return card;
  }
}

/** #341: 一轮的计划折叠卡，以及卡里的一行更新。 */
type TodoUpdate = { key: string; item: ToolItem; row: HTMLElement; mark: HTMLElement; text: HTMLElement };
type TodoGroup = {
  node: HTMLElement;
  main: HTMLButtonElement;
  label: HTMLElement;
  toggle: HTMLButtonElement;
  list: HTMLElement;
  updates: TodoUpdate[];
};

/** #341: 折叠卡里一行更新的状态 —— 与执行面板计划区同一套记号。 */
function todoStatus(item: ToolItem): string {
  const args = item.args && typeof item.args === "object" ? item.args as Record<string, unknown> : {};
  if (String(args.action ?? "") === "clear") return "cleared";
  const status = String(args.status ?? "");
  if (status === "completed" || status === "in_progress") return status;
  const tasks = item.plan?.tasks.filter((task) => task.status !== "deleted") ?? [];
  return tasks.length && tasks.every((task) => task.status === "completed") ? "completed" : "pending";
}

function todoMark(item: ToolItem): string {
  if (item.isError || item.status === "error") return "!";
  const status = todoStatus(item);
  if (status === "completed") return "✓";
  if (status === "in_progress") return "◌";
  if (status === "cleared") return "—";
  return "○";
}

function durationText(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return `${Math.round(ms / 100) / 10}s`;
}

/**
 * One failure on the module's 「AI 执行失败」page: `EXIT n` + one-sentence title + which command,
 * then why / next, then only the key lines of the output (see `excerpt`), with the raw text folded
 * underneath. No box of its own — the module is the box, so a run of failures reads as one list
 * instead of a stack of cards. `benign` / `abort` failures fade to gray so a run of grep misses
 * does not look like an emergency.
 */
function buildFailureItem(input: FailureInput, ms?: number): HTMLElement {
  const d = diagnose(input);
  const calm = d.level === "benign" || d.level === "abort";
  const card = el("section", calm ? "fitem calm" : "fitem");

  const who = input.cmd ? `${input.tool} · ${input.cmd}` : input.tool;
  const top = el("div", "fhead");
  const whoSpan = el("span", "fwho", who);
  whoSpan.title = who;
  top.append(
    el("span", calm ? "badge calm" : "badge", d.exit === null ? LEVEL_LABEL[d.level] : `EXIT ${d.exit}`),
    el("span", "fttl", d.title),
    whoSpan,
  );
  const grid = el("div", "grid");
  grid.append(el("span", "k", tr("为什么没成")), el("span", "v", d.cause || "—"));
  // 「AI 想做什么」放中间：它是背景，不是一个要人处理的条目；
  // 但读者最先问的恰恰是「它为什么去调这一条」，所以不能省。
  grid.append(el("span", "k", tr("AI 想做什么")), el("span", "v", d.intent || "—"));
  // 后续：这一轮它后来怎么绕过去的（chat.ts 在同一轮后续工具跑通时回填）；没后续就没有这一行。
  if (input.after) grid.append(el("span", "k", tr("后续")), el("span", "v", input.after));
  // 影响与改进合一行：先回答「这次动了什么」，再回答「下次怎么不再犯」。
  const impact = [d.effect, d.improve].filter(Boolean).join(tr("；"));
  grid.append(el("span", "k", tr("影响 / 改进")), el("span", "v", impact || "—"));
  if (d.needsYou) grid.append(el("span", "k", tr("要你做")), el("span", "v", d.needsYou));
  card.append(top, grid);

  const { lines, keep } = excerpt(input.out);
  if (keep.length) {
    const body = el("div", "body");
    let prev = -1;
    for (const [i, hit] of keep) {
      if (prev >= 0 && i > prev + 1) body.append(el("div", "gap", tr("… 跳过 {p1} 行", { p1: i - prev - 1 })));
      const row = el("div", hit ? "ln hit" : "ln");
      row.append(el("span", "no", String(i + 1)), el("span", "tx", lines[i] || " "));
      body.append(row);
      prev = i;
    }
    const ex = el("div", "ex");
    ex.append(body);
    card.append(ex);
  }

  const raw = normalize(input.out) || tr("（没有输出）");
  const meta = [keep.length ? tr("关键行 {p1} 行", { p1: keep.length }) : tr("输出为空，只有退出码"), durationText(ms)].filter(Boolean);
  const foot = el("div", "foot");
  const rawBox = el("details", "raw");
  const rawTop = el("summary", "raw-top");
  rawTop.append(el("span", "chev", "▸"), el("span", undefined, tr("完整输出（{p1} 字符）", { p1: raw.length })));
  rawBox.append(rawTop, el("pre", undefined, raw));
  foot.append(el("span", undefined, meta.join(" · ")), rawBox);
  card.append(foot);
  return card;
}

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "create", "str_replace_editor", "apply_patch"]);

function toolPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function fileIcon(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(md|markdown|mdx)$/.test(ext)) return "📝";
  if (/^html?$/.test(ext)) return "🌐";
  if (/^(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/.test(ext)) return "🖼";
  return "📄";
}

function openPreview(path: string): void {
  window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path } }));
}

/** 点开一张会话图片：手风琴交给 app 的灯箱，聊天区只管把事件递出去。 */
export function openImage(src: string, alt: string): void {
  window.dispatchEvent(new CustomEvent("pi-image", { detail: { src, alt } }));
}

function toolSummary(item: ToolItem): string {
  const args = item.args as Record<string, unknown> | undefined;
  if (args && typeof args === "object") {
    for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url"]) {
      const v = args[key];
      if (typeof v === "string") return v;
    }
  }
  if (typeof item.args === "string") return item.args;
  return "";
}

export { el as createEl };

/** One plain-text line standing in for a folded reply. */
function previewLine(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ` ${tr("代码")} `)
    .replace(/[#>*_`|~-]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 120 ? `${plain.slice(0, 120)}…` : plain || tr("（已收起）");
}

/** ⧉ in a message header: copies the raw markdown / text, as `/copy` does in the terminal (#24). */
function copyButton(text: () => string): HTMLButtonElement {
  const btn = el("button", "msg-copy", "⧉") as HTMLButtonElement;
  btn.type = "button";
  btn.title = tr("复制原文");
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const done = navigator.clipboard?.writeText(text());
    if (!done) {
      btn.title = tr("这个地址拿不到剪贴板（http 的局域网地址浏览器不给）");
      btn.textContent = "✕";
      return;
    }
    void done.then(() => {
      btn.textContent = "✓";
      setTimeout(() => (btn.textContent = "⧉"), 1000);
    });
  };
  return btn;
}
