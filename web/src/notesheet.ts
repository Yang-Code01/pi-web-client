/**
 * 记录面板（D95 / #486）：顶栏「🐞 bug」弹出的 dialog，三栏 —— 分区 / 记录列表 / 正文。
 *
 * 三条设计约束决定了这里的样子（对齐「设置 → 本机管理」那套控制台）：
 * - **随手记要零等待**：新建直接进正文，光标落在正文第一行；Enter 就存，一个 WS 往返。
 * - **截图先攒后传**：粘贴 / 拖进来的图先以 data URL 挂在 `pendingShots` 上，保存时随条目一起
 *   落盘（`notes.shot`），所以「还没保存的草稿也能贴图」不需要两段式 UI。
 * - **状态不改正文**：pending → done → dropped 只是字段，编辑器和列表都跟着重画，不锁输入框。
 *
 * 正文从「纯文本 textarea」换成了富文本（#486）：存的是净化过的 HTML，老数据在读路径上回填成
 * 段落。净化与导出在 `notes/rich.ts`，编辑行为在 `notes/editor.ts`，这一层只管布局和状态。
 */
import { createEl as el } from "./chat.ts";
import { FailPanel } from "./failpanel.ts";
import { ripeEntries, type FailLedger } from "./failures.ts";
import { RichEditor } from "./notes/editor.ts";
import { isRichEmpty, plainText, richToMarkdown, textToRich } from "./notes/rich.ts";
import type { RuleBook } from "./rules.ts";
import type { Note, NoteKind, NoteStatus, NotesLayout } from "./types.ts";
import "./notes.css";
import { tr } from "./i18n/index.ts";

export const NOTE_KINDS: { id: NoteKind; label: string; glyph: string }[] = [
  { id: "bug", label: "bug", glyph: "🐞" },
  { id: "change", label: tr("变更"), glyph: "◆" },
  { id: "idea", label: tr("想法"), glyph: "◇" },
  { id: "chore", label: tr("杂事"), glyph: "○" },
];

const STATUS_LABEL: Record<NoteStatus, string> = { pending: tr("待处理"), done: tr("已处理"), dropped: tr("已忽略") };
const STATUS_GLYPH: Record<NoteStatus, string> = { pending: "○", done: "✓", dropped: "−" };

/** 左栏在看哪一堆：在列表里 / 归档 / 垃圾箱 / AI 出错记录（只读，不算笔记）。 */
type View = "active" | "archived" | "trash" | "failures";
/** 列表头的分段筛选；`all` 以外都直接对 `Note.status`。 */
type SegFilter = "all" | NoteStatus;

const LAYOUT_KEY: Record<keyof NotesLayout, string> = { nav: "notes.nav", list: "notes.list" };

function readLayout(): NotesLayout {
  const read = (key: string, ok: string[], fallback: string): string => {
    try {
      const value = localStorage.getItem(key);
      return value && ok.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    nav: read(LAYOUT_KEY.nav, ["open", "rail"], "open") as NotesLayout["nav"],
    list: read(LAYOUT_KEY.list, ["open", "closed"], "open") as NotesLayout["list"],
  };
}

/** 保存布局；记住了就记住了，隐私模式下写不进去也不是错。 */
function writeLayout(layout: NotesLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY.nav, layout.nav);
    localStorage.setItem(LAYOUT_KEY.list, layout.list);
  } catch {
    /* 存不了就按默认来 */
  }
}

/** 面板上次的样子（#510）：分区、去向、选中的记录。 */
const MEMORY_KEY = "notes.memory";
interface NotesMemory {
  kind: NoteKind;
  view: View;
  sel: string | null;
}

function readMemory(): NotesMemory {
  const fallback: NotesMemory = { kind: "bug", view: "active", sel: null };
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<Record<keyof NotesMemory, unknown>>;
    const kind = NOTE_KINDS.some((k) => k.id === v.kind) ? (v.kind as NoteKind) : fallback.kind;
    const view = (["active", "archived", "trash", "failures"] as const).find((x) => x === v.view) ?? fallback.view;
    return { kind, view, sel: typeof v.sel === "string" ? v.sel : null };
  } catch {
    return fallback;
  }
}

/** 记住面板的样子；隐私模式下写不进去也不是错。 */
function writeMemory(memory: NotesMemory): void {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* 存不了就按默认来 */
  }
}

/** 面板跟页面之间只有这几个口子：发送、当前笔记列表、两个「交给 agent」的落点。 */
export interface NotesHost {
  send(msg: unknown): void;
  notes(): Note[];
  /** 写进当前会话的输入框（不发送）。 */
  prefill(text: string): void;
  /** 开一个新会话，等它建好后把文字填进那个会话的输入框（不发送）。 */
  newSessionWith(text: string): void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 列表里的时间：今天只看时分，旧的不带年份（跟文件浏览器一个口径）。 */
function shortTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 交给 agent / 复制出去的正文：标题、原话（Markdown）、截图绝对路径。
 *  不写记录时的会话名：交接的落点是另一个会话，写上它那段字看着就像别人的记录混进来了。 */
export function noteMarkdown(note: Note): string {
  const head = `${STATUS_LABEL[note.status]} · ${stamp(note.createdAt)}`;
  const body = note.body ? richToMarkdown(note.body) : "";
  const lines = [`## ${note.title}`, head, "", body];
  if (note.shots.length) lines.push("", ...note.shots.map((s) => `![](${s})`));
  return lines.join("\n");
}

export class NotesSheet {
  private readonly host: NotesHost;
  private root!: HTMLElement;
  private consoleEl!: HTMLElement;
  private navEl!: HTMLElement;
  private rowListEl!: HTMLElement;
  private docEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private headCountEl!: HTMLElement;

  private readonly memory = readMemory();
  private kind: NoteKind = this.memory.kind;
  private view: View = this.memory.view;
  /** 面板第一次拿到列表时把上次的记录接回来；接完就关掉。 */
  private restoring = true;
  /** AI 出错记录那份账本（D164）：跟笔记不是一回事，但共用一个面板。 */
  private ledger: FailLedger | null = null;
  private failPanel!: FailPanel;
  private failEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  /** 列表头上的分段筛选（#486：全部 / 待处理 / 已处理 / 已忽略）。 */
  private seg: SegFilter = "all";
  /** 自动保存的定时器：停手 900ms 就落盘。 */
  private saveTimer = 0;
  /** 这一堆的「还有 N 条没动」黄条被关掉了吗（按分区记，不落盘）。 */
  private readonly bannerGone = new Set<string>();
  private listCountEl!: HTMLElement;
  private segEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private headBadgeEl!: HTMLElement;
  private clearTrash!: HTMLButtonElement;
  private newBtn!: HTMLButtonElement;
  private searchEl!: HTMLInputElement;
  private query = "";
  private sel: string | null = null;
  /** 编辑器里现在是什么：null = 没在编辑。 */
  private editing: { id: string | null; note: Partial<Note> } | null = null;
  private pendingShots: string[] = [];
  private dirty = false;
  /** 这一次保存属于哪个编辑器实例：切走之后到达的 ack 不许改当前选择。 */
  private saveTicket: { editing: unknown } | null = null;
  private layout: NotesLayout = readLayout();

  // 正文区那几个长期存在的部件：只有换记录时才重填，避免打一个字就被广播重画（caret 会跳）。
  private titleEl!: HTMLInputElement;
  private bodyHost!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private shotsEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private footEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private statusBtn!: HTMLButtonElement;
  private docTimeEl!: HTMLElement;
  private railList!: HTMLButtonElement;
  private editor: RichEditor | null = null;
  /** 正文区现在填的是哪条：同一个 id 重画时不重置 innerHTML。 */
  private paintedId: string | null = null;
  private summaryCache = new Map<string, { at: number; text: string }>();
  /** 草稿没有 id，给它一个单调递增的键：同一条草稿不重填正文，新的一条会重填。 */
  private draftSeq = 0;

  constructor(host: NotesHost) {
    this.host = host;
    this.build();
    this.applyLayout();
  }

  private build(): void {
    const back = el("div", "sheet-back notes-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.close();
    };
    const sheet = el("div", "sheet notes-sheet");

    this.bodyEl = el("div", "notes-body");
    this.buildConsole();
    this.bodyEl.append(this.consoleEl);

    // 出错记录是第五个分区，长得像笔记列表但内容只读：同一块区域二选一。
    this.failEl = el("div", "fail-wrap") as HTMLElement;
    this.failEl.hidden = true;
    this.failPanel = new FailPanel({
      send: (msg) => this.host.send(msg),
      handoff: (anchor, text) => this.handoffMenu(anchor, text),
      say: (text, bad = false) => this.say(text, bad),
    });
    this.failPanel.mount(this.failEl);

    // 笔记三栏和只读账本互斥，包一层 `notes-main` 好让 sheet 的三行网格（头 / 身 / 脚）不变。
    const main = el("div", "notes-main");
    main.append(this.bodyEl, this.failEl);
    sheet.append(this.head(), main, this.foot());
    back.append(sheet);
    this.root = back;
    this.paintHead();
    this.paintNav();
    this.paintList();
    this.paintEditor();
  }

  /** 头部：一行说清「这是记录 + 现在几条在眼前 + 能干的三件事」。 */
  private head(): HTMLElement {
    const head = el("div", "sheet-head notes-head");
    const title = el("div", "notes-head-title");
    title.append(el("span", "notes-head-glyph", "🐞"), el("span", "", tr("记录面板")));
    this.headBadgeEl = el("span", "notes-head-badge", "");
    this.headBadgeEl.hidden = true;
    this.headCountEl = el("span", "notes-head-sub", "");

    const nb = el("button", "btn primary notes-head-new", tr("＋ 记一条"));
    nb.onclick = () => this.newNote();
    this.newBtn = nb;
    const exportAll = el("button", "btn ghost", tr("导出"));
    exportAll.title = tr("把当前这一堆记录导出成一份 Markdown");
    exportAll.onclick = () => this.exportAll();
    head.append(title, this.headBadgeEl, this.headCountEl, el("div", "grow"), nb, exportAll, closeButton(tr("关闭"), () => this.close()));
    return head;
  }

  /** 底栏：提示 + （垃圾箱时）清空。 */
  private foot(): HTMLElement {
    const foot = el("div", "sheet-foot notes-foot");
    this.hintEl = el("span", "notes-hint", "");
    const clear = el("button", "btn danger notes-clear", tr("清空垃圾箱"));
    clear.title = tr("把垃圾箱里的记录彻底删掉（截图一起删），不能撤销");
    clear.onclick = () => this.emptyTrash();
    this.clearTrash = clear;
    foot.append(this.hintEl, clear);
    return foot;
  }

  // ---------------------------------------------------------------- 三栏骨架

  private buildConsole(): void {
    this.consoleEl = el("div", "notes-console");

    // 第一栏：分区（宽版是列表，窄版只留图标）。
    this.navEl = el("aside", "nc-nav") as HTMLElement;

    // 第二栏：记录列表。
    const list = el("section", "nc-list") as HTMLElement;
    const listHead = el("div", "nc-list-head");
    const top = el("div", "nc-list-top");
    this.listCountEl = el("span", "nc-list-count", "");
    const collapseList = el("button", "nc-rail-tab", "«");
    collapseList.title = tr("收起列表");
    collapseList.setAttribute("aria-label", tr("收起列表"));
    collapseList.onclick = () => this.setList("closed");
    top.append(el("span", "nc-list-title", tr("记录")), this.listCountEl, collapseList);

    const search = el("input", "ns-input nc-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = tr("搜标题 / 正文");
    search.oninput = () => {
      this.query = search.value.trim().toLowerCase();
      this.paintList();
    };
    this.searchEl = search;
    this.segEl = el("div", "nc-seg");
    this.bannerEl = el("div", "nc-banner");
    this.bannerEl.hidden = true;
    listHead.append(top, search, this.segEl);
    this.rowListEl = el("div", "nc-items") as HTMLElement;
    list.append(listHead, this.bannerEl, this.rowListEl);

    // 第三栏：正文。
    this.docEl = el("article", "nc-doc") as HTMLElement;
    this.docEl.append(this.docHead(), this.docBody());
    this.consoleEl.append(this.navEl, list, this.docEl);
  }

  private docHead(): HTMLElement {
    const head = el("div", "nc-doc-head");
    // 分区栏收起后，展开按钮就换成它自己头行那颗箭头（见 paintNav）：不再在正文头再摆一颗，免得两个箭头挨着。
    this.railList = el("button", "nc-rail-tab", "»");
    this.railList.title = tr("展开列表");
    this.railList.setAttribute("aria-label", tr("展开列表"));
    this.railList.onclick = () => this.setList("open");
    this.statusBtn = el("button", "nc-status", STATUS_GLYPH.pending) as HTMLButtonElement;
    this.statusBtn.hidden = true;
    this.statusBtn.onclick = () => this.statusMenu(this.statusBtn);
    this.docTimeEl = el("span", "nc-doc-time", "");
    head.append(this.statusBtn, this.docTimeEl, this.railList);
    return head;
  }

  private docBody(): HTMLElement {
    const scroll = el("div", "nc-doc-scroll");

    this.emptyEl = el("div", "nc-empty");

    this.stateEl = el("div", "nc-state");
    this.stateEl.hidden = true;

    this.titleEl = el("input", "nc-title") as HTMLInputElement;
    this.titleEl.placeholder = tr("标题（留空就取正文第一行）");
    this.titleEl.oninput = () => {
      if (!this.editing) return;
      this.editing.note.title = this.titleEl.value;
      this.markDirty();
    };
    this.titleEl.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.bodyHost.focus();
      }
    };

    this.toolbarEl = el("div", "nc-toolbar") as HTMLElement;
    this.bodyHost = el("div", "nc-body") as HTMLElement;
    this.bodyHost.setAttribute("aria-label", tr("正文"));
    this.bodyHost.dataset.ph = tr("正文：写清复现步骤；敲 ``` 变代码块，截图直接粘进来");
    this.editor = new RichEditor({
      body: this.bodyHost,
      toolbar: this.toolbarEl,
      onChange: () => {
        if (!this.editing) return;
        this.editing.note.body = this.editor?.html() ?? "";
        this.markDirty();
      },
      say: (text, bad) => this.say(text, bad),
      onFiles: (files) => void this.addFiles(files),
    });

    this.shotsEl = el("div", "nc-shots") as HTMLElement;
    this.metaEl = el("div", "nc-meta") as HTMLElement;
    this.actionsEl = el("div", "nc-actions") as HTMLElement;
    this.footEl = el("div", "nc-foot", "");

    scroll.append(this.emptyEl, this.stateEl, this.titleEl, this.toolbarEl, this.bodyHost, this.shotsEl, this.metaEl, this.actionsEl, this.footEl);
    return scroll;
  }

  // ---------------------------------------------------------------- 布局

  private applyLayout(): void {
    const rail = this.layout.nav === "rail";
    this.consoleEl.classList.toggle("nav-rail", rail);
    this.consoleEl.classList.toggle("list-off", this.layout.list === "closed");
    this.paintRails();
  }

  private setNav(nav: NotesLayout["nav"]): void {
    this.layout = { ...this.layout, nav };
    writeLayout(this.layout);
    this.applyLayout();
    // 收起 / 展开时头行那颗箭头的方向与点击行为都变了，重画一遍。
    this.paintNav();
  }

  private setList(list: NotesLayout["list"]): void {
    this.layout = { ...this.layout, list };
    writeLayout(this.layout);
    this.applyLayout();
    if (list === "open") this.searchEl.focus();
  }

  /** 窄条上的展开按钮只在列表收起时出现。 */
  private paintRails(): void {
    this.railList.hidden = this.layout.list !== "closed";
  }

  // ---------------------------------------------------------------- 第一栏

  private paintNav(): void {
    const notes = this.host.notes();
    const nav = el("div", "nc-nav-inner");
    const head = el("div", "nc-nav-head");
    // 收起来以后这颗箭头反过来当展开钮（不再在正文头另摆一颗，免得两个箭头挨着）。
    const rail = this.layout.nav === "rail";
    const fold = el("button", "nc-nav-fold", rail ? "»" : "«");
    fold.title = rail ? tr("展开分区") : tr("收成图标条");
    fold.setAttribute("aria-label", fold.title);
    fold.onclick = () => this.setNav(rail ? "open" : "rail");
    head.append(el("span", "nc-nav-title", tr("分区")), fold);
    nav.append(head);

    const item = (key: string, glyph: string, label: string, count: number, on: boolean, run: () => void): HTMLElement => {
      const b = el("button", `nc-nav-item${on ? " on" : ""}`) as HTMLButtonElement;
      b.dataset.key = key;
      b.title = label;
      b.append(el("span", "nc-nav-glyph", glyph), el("span", "nc-nav-label", label));
      if (count) b.append(el("span", "nc-nav-n", String(count)));
      b.onclick = () => {
        run();
        // 窄条上点一下 = 展开到宽版（不然点了跟没反应一样）。
        if (this.layout.nav === "rail") this.setNav("open");
      };
      return b;
    };

    for (const k of NOTE_KINDS) {
      const pending = notes.filter((n) => n.kind === k.id && n.status === "pending" && !n.archivedAt && !n.deletedAt).length;
      nav.append(item(k.id, k.glyph, k.label, pending, this.view === "active" && this.kind === k.id, () => this.setKind(k.id)));
    }
    nav.append(el("div", "nc-nav-sep"));
    const ripe = ripeEntries(this.ledger).length;
    nav.append(item("failures", "⚡", tr("AI 出错记录"), ripe, this.view === "failures", () => this.setView("failures")));

    const viewItem = (id: "archived" | "trash", glyph: string, label: string, count: number): HTMLElement =>
      item(id, glyph, label, count, this.view === id, () => this.setView(id));
    nav.append(el("div", "nc-nav-sep"));
    nav.append(viewItem("archived", "📦", tr("归档"), notes.filter((n) => n.archivedAt && !n.deletedAt).length));
    nav.append(viewItem("trash", "🗑️", tr("垃圾箱"), notes.filter((n) => n.deletedAt).length));
    this.navEl.replaceChildren(nav);
  }

  /** 当前视图的名字（头部那一句统计用）。 */
  private viewLabel(): string {
    if (this.view === "failures") return tr("AI 出错记录");
    if (this.view === "archived") return tr("归档");
    if (this.view === "trash") return tr("垃圾箱");
    return NOTE_KINDS.find((k) => k.id === this.kind)?.label ?? this.kind;
  }

  /** 列表空着时那句提示，按视图 / 搜索 / 分段分。 */
  private emptyListText(): string {
    if (this.query) return tr("没有匹配的记录。");
    if (this.view === "trash") return tr("垃圾箱是空的。");
    if (this.view === "archived") return tr("还没有归档的记录。");
    if (this.seg === "pending") return tr("这一类里没有待处理的记录。");
    if (this.seg === "done") return tr("这一类里没有已处理的记录。");
    if (this.seg === "dropped") return tr("这一类里没有被忽略的记录。");
    return tr("这一类还是空的，点「＋ 记一条」开始。");
  }

  private paintHead(): void {
    const notes = this.host.notes();
    const here = this.visible().length;
    this.headCountEl.textContent = tr("{p1} · {p2} 条在眼前", { p1: this.viewLabel(), p2: here });
    const pending = this.view === "active"
      ? notes.filter((n) => n.kind === this.kind && n.status === "pending" && !n.archivedAt && !n.deletedAt).length
      : 0;
    this.headBadgeEl.hidden = !pending;
    this.headBadgeEl.textContent = pending ? String(pending) : "";
    this.headBadgeEl.title = pending ? tr("这一类还有 {p1} 条待处理", { p1: pending }) : "";
    this.newBtn.hidden = this.view !== "active";
    this.clearTrash.hidden = this.view !== "trash";
    const trashed = notes.filter((n) => n.deletedAt).length;
    this.clearTrash.textContent = trashed ? tr("清空垃圾箱（{p1}）", { p1: trashed }) : tr("清空垃圾箱");
    this.paintMode();
  }

  private paintMode(): void {
    const fail = this.view === "failures";
    this.consoleEl.hidden = fail;
    this.failEl.hidden = !fail;
    this.root.firstElementChild?.classList.toggle("in-failures", fail);
  }

  // ---------------------------------------------------------------- 选 / 存

  /** 选一类：如果现在正看着归档 / 垃圾箱，先回列表。 */
  private setKind(kind: NoteKind): void {
    if (this.view === "active" && this.kind === kind) return;
    this.flush();
    this.kind = kind;
    this.view = "active";
    this.query = "";
    this.searchEl.value = "";
    this.resetPick();
    this.paintHead();
    this.paintNav();
    this.paintList();
    this.paintEditor();
    this.remember();
  }

  private resetPick(): void {
    this.sel = null;
    this.editing = null;
    this.pendingShots = [];
    this.dirty = false;
  }

  private setView(view: View): void {
    if (this.view === view) return;
    this.flush();
    this.view = view;
    this.resetPick();
    this.paintHead();
    this.paintNav();
    this.paintList();
    this.paintEditor();
    this.remember();
  }

  /** 记住这一屏（分区 / 去向 / 选中）；写的时机是每次真的切了。 */
  private remember(): void {
    this.memory.kind = this.kind;
    this.memory.view = this.view;
    this.memory.sel = this.sel;
    writeMemory(this.memory);
  }

  /** 换到出错记录：收起笔记三栏，把只读面板亮出来；回来时反过来。 */
  setFailures(ledger: FailLedger | null): void {
    this.ledger = ledger;
    this.paintNav();
    this.failPanel.setLedger(ledger);
  }

  /** 规矩整本换（D164 延伸）：与账本同一条路径进来，面板自己决定怎么画。 */
  setRules(book: RuleBook | null): void {
    this.failPanel.setRules(book);
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
    this.esc = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      // 交给 agent 的菜单先关，再往上一层：一次 Escape 只关一样东西。
      const menu = this.root.querySelector(".note-handoff") ?? document.querySelector(".note-handoff");
      if (menu) {
        menu.remove();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    // Ctrl/⌘ + \ ：收起 / 展开列表（和编辑器里的「专注写」是一套手势）；Ctrl/⌘ + S：立刻存。
    this.shortcut = (ev: KeyboardEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key === "s") {
        // 浏览器自己的「保存网页」不要了：面板里这一下就是存这一条。
        ev.preventDefault();
        if (this.dirty && (this.editing?.id || this.hasContent())) this.save();
        return;
      }
      if (ev.key !== "\\") return;
      ev.preventDefault();
      this.setList(this.layout.list === "open" ? "closed" : "open");
    };
    document.addEventListener("keydown", this.shortcut, true);
  }

  /** 打开面板就把光标放进「记一条」的那一格。 */
  focusComposer(): void {
    if (this.view === "failures") {
      this.failPanel.focus();
      return;
    }
    if (this.editing) this.editor?.focus();
    else this.newNote();
  }

  close(): void {
    // 关面板前落一次盘：自动保存的定时器可能还没到点。
    this.flush();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    if (this.shortcut) document.removeEventListener("keydown", this.shortcut, true);
    document.querySelector(".note-handoff")?.remove();
    this.editor?.destroy();
    this.root.remove();
    this.onClose?.();
  }

  private esc: ((ev: KeyboardEvent) => void) | null = null;
  private shortcut: ((ev: KeyboardEvent) => void) | null = null;

  onClose: (() => void) | null = null;

  private say(text: string, bad = false): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle("bad", bad);
  }

  // ---------------------------------------------------------------- 列表

  /** 一条记录现在该出现在哪一堆里；「已处理」只过滤在列表里的那些，归档 / 垃圾箱里一律全显示。 */
  private inView(n: Note): boolean {
    if (n.deletedAt) return this.view === "trash";
    if (n.archivedAt) return this.view === "archived";
    if (this.view !== "active") return false;
    if (this.seg === "all") return true;
    return n.status === this.seg;
  }

  private visible(): Note[] {
    const q = this.query;
    return this.host.notes().filter((n) => this.inView(n) && (this.view !== "active" || n.kind === this.kind) && (!q || this.matches(n, q)));
  }

  /** 检索只看人写得出来的字段：标题、正文（按纯文本）。 */
  private matches(n: Note, q: string): boolean {
    return [n.title, this.summaryOf(n)].some((v) => String(v ?? "").toLowerCase().includes(q));
  }

  /** 列表里那一行摘要 / 搜索用的纯文本；同一条正文只解析一次（按 updatedAt 失效）。 */
  private summaryOf(n: Note): string {
    const hit = this.summaryCache.get(n.id);
    if (hit && hit.at === n.updatedAt) return hit.text;
    const text = plainText(n.body ?? "");
    this.summaryCache.set(n.id, { at: n.updatedAt, text });
    return text;
  }

  private paintList(): void {
    const rows = this.visible();
    this.paintHead();
    this.paintSeg();
    this.paintBanner();
    this.listCountEl.textContent = String(rows.length);
    if (!rows.length) {
      this.rowListEl.replaceChildren(el("div", "nc-empty-list", this.emptyListText()));
      return;
    }
    this.rowListEl.replaceChildren(...rows.map((n) => this.row(n)));
  }

  /** 分段控件：全部 / 待处理 / 已处理 / 已忽略（归档、垃圾箱里不显示）。 */
  private paintSeg(): void {
    const show = this.view === "active";
    this.segEl.hidden = !show;
    if (!show) return;
    const notes = this.host.notes().filter((n) => !n.deletedAt && !n.archivedAt && n.kind === this.kind);
    const defs: { id: SegFilter; label: string; n: number }[] = [
      { id: "all", label: tr("全部"), n: notes.length },
      { id: "pending", label: tr("待处理"), n: notes.filter((n) => n.status === "pending").length },
      { id: "done", label: tr("已处理"), n: notes.filter((n) => n.status === "done").length },
      { id: "dropped", label: tr("已忽略"), n: notes.filter((n) => n.status === "dropped").length },
    ];
    this.segEl.replaceChildren(
      ...defs.map((d) => {
        const b = el("button", `nc-seg-item${d.id === this.seg ? " on" : ""}`) as HTMLButtonElement;
        b.type = "button";
        b.dataset.seg = d.id;
        b.append(el("span", "", d.label), el("span", "nc-seg-n", String(d.n)));
        b.onclick = () => {
          this.seg = d.id;
          this.paintList();
        };
        return b;
      }),
    );
  }

  /** 黄条：「这一类有 N 条待处理还没动，最老的一条停在 X 天前」。 */
  private paintBanner(): void {
    const idle = this.view === "active" && this.seg === "all";
    const key = this.kind;
    if (!idle || this.bannerGone.has(key)) {
      this.bannerEl.hidden = true;
      return;
    }
    const pending = this.host.notes().filter((n) => n.kind === this.kind && n.status === "pending" && !n.archivedAt && !n.deletedAt);
    if (!pending.length) {
      this.bannerEl.hidden = true;
      return;
    }
    const oldest = Math.min(...pending.map((n) => n.createdAt || n.updatedAt || Date.now()));
    const days = Math.max(0, Math.floor((Date.now() - oldest) / 86_400_000));
    const text = days >= 1
      ? tr("这一类还有 {p1} 条待处理没动，最老的一条停在 {p2} 天前。", { p1: pending.length, p2: days })
      : tr("这一类还有 {p1} 条待处理没动。", { p1: pending.length });
    const close = el("button", "nc-banner-x", "✕");
    close.title = tr("今天先不看这条");
    close.setAttribute("aria-label", close.title);
    close.onclick = () => {
      this.bannerGone.add(key);
      this.bannerEl.hidden = true;
    };
    this.bannerEl.replaceChildren(el("span", "nc-banner-text", text), close);
    this.bannerEl.hidden = false;
  }

  /** 字数：按纯文本数非空白字符（中文一个字算一个）。 */
  private wordsOf(n: Partial<Note>): number {
    return plainText(n.body ?? "").replace(/\s+/g, "").length;
  }

  private row(n: Note): HTMLElement {
    // 行本身是 div 而不是 <button>：里面还要放「归档 / 删除」两个小按钮，button 套 button 点不动。
    const row = el("div", `nc-row${n.id === this.sel ? " on" : ""}`) as HTMLElement;
    row.dataset.id = n.id;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.onclick = () => this.select(n.id);
    row.onkeydown = (ev) => {
      if (ev.target !== row) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        this.select(n.id);
      }
    };

    const top = el("div", "nc-row-top");
    const status = el("span", `nc-dot ${n.status}`, STATUS_GLYPH[n.status]);
    status.title = STATUS_LABEL[n.status];
    top.append(el("span", "nc-row-title", n.title), status);
    row.append(top);

    const summary = this.summaryOf(n).split("\n").find((line) => line.trim()) ?? "";
    if (summary) row.append(el("div", "nc-row-body", summary));

    const meta = el("div", "nc-row-meta");
    meta.append(el("span", "nc-row-shot", `🖼 ${n.shots?.length ?? 0}`));
    meta.append(el("span", "nc-row-words", tr("{p1} 字", { p1: this.wordsOf(n) })));
    meta.append(el("span", "nc-row-time", shortTime(n.updatedAt)));
    meta.append(this.rowActs(n));
    row.append(meta);
    return row;
  }

  /** 行右侧那两个小图标：按当前这堆是什么，给可用的动作。 */
  private rowActs(n: Note): HTMLElement {
    const acts = el("div", "nc-row-acts");
    const mk = (glyph: string, title: string, run: () => void, danger = false): HTMLElement => {
      const b = el("button", `nc-row-act${danger ? " danger" : ""}`, glyph);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onclick = (ev) => {
        ev.stopPropagation();
        run();
      };
      return b;
    };
    if (this.view === "trash") {
      acts.append(
        mk("↺", tr("复原：放回列表"), () => this.setLife(n.id, "active")),
        mk("✕", tr("彻底删除（不能撤销）"), () => this.purgeOne(n.id), true),
      );
    } else if (this.view === "archived") {
      acts.append(
        mk("↺", tr("复原：放回列表"), () => this.setLife(n.id, "active")),
        mk("🗑️", tr("删除（放垃圾箱，可复原）"), () => this.setLife(n.id, "trashed")),
      );
    } else {
      acts.append(
        mk("📦", tr("归档"), () => this.setLife(n.id, "archived")),
        mk("🗑️", tr("删除（放垃圾箱，可复原）"), () => this.setLife(n.id, "trashed")),
      );
    }
    return acts;
  }

  private setLife(id: string, life: "active" | "archived" | "trashed"): void {
    if (id === this.editing?.id) this.flush();
    this.host.send({ type: "notes.life", id, life });
    if (this.sel === id) {
      this.sel = null;
      this.editing = null;
      this.pendingShots = [];
      this.dirty = false;
      this.paintEditor();
      this.paintList();
    }
  }

  private purgeOne(id: string): void {
    const note = this.host.notes().find((n) => n.id === id);
    if (!confirm(tr("彻底删掉「{p1}」？截图一起删，不能撤销。", { p1: note?.title ?? tr("这条记录") }))) return;
    this.host.send({ type: "notes.purge", id });
    if (this.sel === id) {
      this.sel = null;
      this.editing = null;
      this.paintEditor();
      this.paintList();
    }
  }

  private emptyTrash(): void {
    const doomed = this.host.notes().filter((n) => n.deletedAt);
    if (!doomed.length) return;
    if (!confirm(tr("垃圾箱里的 {p1} 条全部彻底删掉？截图一起删，不能撤销。", { p1: doomed.length }))) return;
    this.host.send({ type: "notes.purge" });
    this.sel = null;
    this.editing = null;
    this.paintEditor();
    this.remember();
  }

  /** 切条目时先把手上的改动存掉：不留「切走就丢」这种坑。 */
  private select(id: string): void {
    if (this.sel === id && this.editing) return;
    this.flush();
    this.sel = id;
    const note = this.host.notes().find((n) => n.id === id) ?? null;
    this.pendingShots = [];
    this.dirty = false;
    this.paintList();
    this.load(note);
    this.remember();
  }

  // ---------------------------------------------------------------- 正文

  private newNote(): void {
    this.flush();
    this.sel = null;
    this.pendingShots = [];
    this.dirty = false;
    this.seg = "all";
    this.draftSeq += 1;
    this.paintList();
    this.load(null);
    // 新建一条就先落在标题上：先把「是什么」写清，正文随后（#486 使用场景第 1 条）。
    this.titleEl.focus();
    this.remember();
  }

  private paintEditor(): void {
    const note = this.editing?.note;
    const editing = !!this.editing;
    const trashed = !!note?.deletedAt;
    const archived = !!note?.archivedAt;
    // 归档 / 垃圾箱都是只读：「复原」之后才该能改（不然改完也存不进列表那一堆）。
    const frozen = trashed || archived;
    this.docEl.dataset.readonly = String(frozen);

    this.emptyEl.hidden = editing;
    this.stateEl.hidden = !(editing && frozen);
    this.titleEl.hidden = !editing;
    this.toolbarEl.hidden = !editing || frozen;
    this.bodyHost.hidden = !editing;
    this.statusBtn.hidden = !editing || !this.editing?.id;
    this.docTimeEl.textContent = "";

    if (!editing) {
      this.paintedId = null;
      this.docTimeEl.textContent = "";
      const empty = this.emptyEl;
      empty.replaceChildren();
      if (this.view === "active") {
        empty.append(el("div", "nc-empty-title", tr("左边点一条来改，或者")), (() => {
          const b = el("button", "btn primary", tr("＋ 记一条"));
          b.onclick = () => this.newNote();
          return b;
        })());
      } else {
        // 归档 / 垃圾箱只能看和复原：这里不摆「记一条」，不然存下去的新记录不在这堆里，看起来像没存上。
        empty.append(
          el("div", "nc-empty-title", this.view === "trash" ? tr("垃圾箱里的记录不能改。") : tr("归档里的记录不能直接改。")),
          el("div", "nc-empty-hint", tr("左边点一条看一眼；要改先「复原」放回列表。")),
        );
      }
      this.shotsEl.replaceChildren();
      this.metaEl.replaceChildren();
      this.actionsEl.replaceChildren();
      this.footEl.textContent = "";
      return;
    }

    const status = note?.status ?? "pending";
    this.statusBtn.textContent = STATUS_GLYPH[status];
    this.statusBtn.className = `nc-status ${status}`;
    this.statusBtn.title = tr("状态：{p1}（点一下改）", { p1: STATUS_LABEL[status] });
    this.statusBtn.setAttribute("aria-label", this.statusBtn.title);
    if (note?.updatedAt) this.docTimeEl.textContent = tr("改于 {p1}", { p1: stamp(note.updatedAt) });

    this.stateEl.replaceChildren();
    if (trashed) {
      const bar = el("div", "nc-state-bar trash");
      bar.append(el("span", "", tr("在垃圾箱里 · 不能编辑，复原后才会回到列表")));
      const back = el("button", "btn ghost", tr("复原"));
      back.onclick = () => this.editing?.id && this.setLife(this.editing.id, "active");
      const kill = el("button", "btn danger", tr("彻底删除"));
      kill.onclick = () => this.editing?.id && this.purgeOne(this.editing.id);
      bar.append(el("div", "grow"), back, kill);
      this.stateEl.append(bar);
    } else if (archived) {
      const bar = el("div", "nc-state-bar");
      bar.append(el("span", "", tr("已归档 · 不在列表里，复原才回来")));
      const back = el("button", "btn ghost", tr("复原"));
      back.onclick = () => this.editing?.id && this.setLife(this.editing.id, "active");
      bar.append(el("div", "grow"), back);
      this.stateEl.append(bar);
    }

    if (this.titleEl.value !== (note?.title ?? "")) this.titleEl.value = note?.title ?? "";
    this.titleEl.readOnly = frozen;
    this.bodyHost.setAttribute("contenteditable", frozen ? "false" : "true");
    this.bodyHost.classList.toggle("readonly", frozen);

    // 只换记录时重填正文：同一个 id 的广播（保存回执）不该把光标顶走。
    const key = this.editing?.id ?? `draft-${this.draftSeq}`;
    if (this.paintedId !== key) {
      this.editor?.setHtml(textToRich(note?.body ?? ""));
      this.paintedId = key;
    }

    this.shotsEl.replaceChildren(...this.shotTiles(note ?? {}));
    this.metaEl.replaceChildren(...this.metaCells(note ?? {}));
    this.actionsEl.replaceChildren(...this.actionButtons(note ?? {}));
    this.footEl.textContent = this.editing?.id
      ? tr("已自动保存 · 改于 {p1} · {p2} 字", { p1: stamp(this.editing.note.updatedAt ?? Date.now()), p2: this.wordsOf(this.editing.note) })
      : tr("停手一下就自动存；Ctrl+S 立刻存。正文支持 Markdown 那套：``` 换行变代码块。");
  }

  private markDirty(): void {
    this.dirty = true;
    // 自动保存：停手 900ms 就落盘（#486「标题和正文都自动保存」，不再要用户按保存）。
    this.say(tr("正在写…"));
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      if (this.dirty && (this.editing?.id || this.hasContent())) this.save();
    }, 900);
  }

  /** 草稿是不是已经有东西可存了（标题或正文非空）。 */
  private hasContent(): boolean {
    const note = this.editing?.note;
    return !!(note?.title ?? "").trim() || !isRichEmpty(this.editor?.html() ?? note?.body ?? "");
  }

  private shotTiles(note: Partial<Note>): HTMLElement[] {
    const readOnly = !!note.deletedAt || !!note.archivedAt;
    const tiles: HTMLElement[] = [];
    const add = (src: string, alt: string, remove?: () => void): void => {
      const tile = el("div", "nc-shot");
      const img = el("img") as HTMLImageElement;
      img.src = src;
      img.alt = alt;
      img.onclick = () => window.open(src, "_blank");
      tile.append(img);
      if (remove) {
        const x = el("button", "nc-shot-x", "×");
        x.title = tr("移除这张图");
        x.onclick = remove;
        tile.append(x);
      }
      tiles.push(tile);
    };
    for (const path of note.shots ?? []) {
      add(`/api/image?path=${encodeURIComponent(path)}`, path.split(/[\\/]/).pop() ?? "", readOnly ? undefined : () => this.removeShot(path));
    }
    this.pendingShots.forEach((dataUrl, i) => {
      add(dataUrl, tr("新图 {p1}", { p1: i + 1 }), () => {
        this.pendingShots.splice(i, 1);
        this.markDirty();
        this.paintEditor();
      });
    });
    if (!readOnly && (note.shots?.length ?? 0) + this.pendingShots.length < 24) {
      const pick = el("label", "nc-add-shot");
      pick.append(el("span", "", tr("＋ 图")));
      const input = el("input") as HTMLInputElement;
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => {
        const files = [...(input.files ?? [])];
        if (files.length) void this.addFiles(files);
        input.value = "";
      };
      pick.append(input);
      pick.ondragover = (ev) => {
        ev.preventDefault();
        pick.classList.add("drop");
      };
      pick.ondragleave = () => pick.classList.remove("drop");
      pick.ondrop = (ev) => {
        pick.classList.remove("drop");
        const files = [...(ev.dataTransfer?.files ?? [])];
        if (!files.length) return;
        ev.preventDefault();
        void this.addFiles(files);
      };
      tiles.push(pick);
      tiles.push(el("span", "nc-shots-hint", tr("Ctrl+V 粘贴截图 / 拖文件进来 · 保存时一起落盘")));
    }
    if (readOnly && note.deletedAt) tiles.push(el("span", "nc-shots-hint", tr("删于 {p1}", { p1: stamp(note.deletedAt) })));
    return tiles;
  }

  private metaCells(note: Partial<Note>): HTMLElement[] {
    const cells: HTMLElement[] = [];
    const cell = (label: string, value: string): void => {
      const box = el("div", "nc-cell");
      box.append(el("span", "nc-cell-k", label), el("span", "nc-cell-v", value || "—"));
      cells.push(box);
    };
    cell(tr("状态"), STATUS_LABEL[note.status ?? "pending"]);
    cell(tr("分类"), NOTE_KINDS.find((k) => k.id === (note.kind ?? this.kind))?.label ?? "");
    cell(tr("创建"), note.createdAt ? stamp(note.createdAt) : "");
    cell(tr("改动"), note.updatedAt ? stamp(note.updatedAt) : "");
    return cells;
  }

  private actionButtons(note: Partial<Note>): HTMLElement[] {
    if (note.deletedAt) {
      const back = el("button", "btn ghost", tr("复原"));
      back.onclick = () => this.editing?.id && this.setLife(this.editing.id, "active");
      const kill = el("button", "btn danger", tr("彻底删除"));
      kill.onclick = () => this.editing?.id && this.purgeOne(this.editing.id);
      return [back, kill];
    }
    // 归档：只给「复原 / 丢垃圾箱 / 复制」，不摆「保存」（正文在归档里是只读的）。
    if (note.archivedAt) {
      const back = el("button", "btn primary", tr("复原：放回列表"));
      back.onclick = () => this.editing?.id && this.setLife(this.editing.id, "active");
      const copy = el("button", "btn ghost", tr("复制 Markdown"));
      copy.onclick = () => {
        const full = this.fullNote(note);
        if (!full) return;
        void copyText(noteMarkdown(full)).then((ok) => this.say(ok ? tr("已复制到剪贴板") : tr("复制失败：浏览器不给剪贴板权限"), !ok));
      };
      const del = el("button", "btn danger", tr("删除"));
      del.title = tr("放进垃圾箱（可复原），不是彻底删");
      del.onclick = () => this.editing?.id && this.setLife(this.editing.id, "trashed");
      return [back, copy, el("div", "grow"), del];
    }
    const row: HTMLElement[] = [];
    const copy = el("button", "btn ghost", tr("复制 Markdown"));
    copy.onclick = () => {
      const full = this.fullNote(note);
      if (!full) return;
      void copyText(noteMarkdown(full)).then((ok) => this.say(ok ? tr("已复制到剪贴板") : tr("复制失败：浏览器不给剪贴板权限"), !ok));
    };
    const hand = el("button", "btn ghost", tr("交给 agent ▾"));
    hand.onclick = () => {
      const full = this.fullNote(note);
      if (!full) return;
      if (this.dirty) {
        this.say(tr("先把改动按「保存」存一下，交给 agent 的是存下的内容"), true);
        return;
      }
      this.handoffMenu(hand, noteMarkdown(full));
    };
    row.push(copy, hand);
    if (this.editing?.id) {
      const archive = el("button", "btn ghost", tr("归档"));
      archive.onclick = () => this.editing?.id && this.setLife(this.editing.id, "archived");
      const del = el("button", "btn danger", tr("删除"));
      del.title = tr("放进垃圾箱（可复原），不是彻底删");
      del.onclick = () => {
        const id = this.editing?.id;
        if (!id) return;
        this.host.send({ type: "notes.life", id, life: "trashed" });
        this.editing = null;
        this.sel = null;
        this.pendingShots = [];
        this.dirty = false;
        this.paintEditor();
        this.remember();
      };
      row.push(el("div", "grow"), archive, del);
    }
    return row;
  }

  /** 状态按钮 → 三个状态 + 归档 / 删除（跟列表行上那两个图标同一个落点）。 */
  private statusMenu(anchor: HTMLElement): void {
    document.querySelector(".note-handoff")?.remove();
    const r = anchor.getBoundingClientRect();
    const pop = el("div", "note-handoff");
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 274))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    const add = (label: string, hint: string, run: () => void): void => {
      const b = el("button");
      b.append(el("span", "handoff-label", label), el("span", "handoff-hint", hint));
      b.onclick = () => {
        pop.remove();
        run();
      };
      pop.append(b);
    };
    for (const status of ["pending", "done", "dropped"] as NoteStatus[]) {
      add(`${STATUS_GLYPH[status]} ${STATUS_LABEL[status]}`, tr("点一下就落盘"), () => this.setStatus(status));
    }
    if (this.editing?.id) {
      add(tr("📦 归档"), tr("不在列表里，复原才回来"), () => this.editing?.id && this.setLife(this.editing.id, "archived"));
      add(tr("🗑️ 删除"), tr("放进垃圾箱，可复原"), () => this.editing?.id && this.setLife(this.editing.id, "trashed"));
    }
    document.body.append(pop);
    setTimeout(
      () =>
        document.addEventListener(
          "click",
          (ev) => {
            if (!pop.contains(ev.target as Node)) pop.remove();
          },
          { once: true },
        ),
      0,
    );
  }

  handoffMenu(anchor: HTMLElement, text: string): void {
    document.querySelector(".note-handoff")?.remove();
    const r = anchor.getBoundingClientRect();
    const pop = el("div", "note-handoff");
    pop.style.position = "fixed";
    pop.style.left = `${Math.max(12, Math.min(r.right - 260, innerWidth - 274))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    const add = (label: string, hint: string, run: () => void) => {
      const b = el("button");
      b.append(el("span", "handoff-label", label), el("span", "handoff-hint", hint));
      b.onclick = () => {
        pop.remove();
        run();
      };
      pop.append(b);
    };
    add(tr("预填到当前会话"), tr("写进输入框，Enter 才发"), () => {
      this.host.prefill(text);
      this.close();
    });
    add(tr("新开一个会话"), tr("建好后填进那个会话的输入框，不自动发送"), () => {
      this.host.newSessionWith(text);
      this.close();
    });
    document.body.append(pop);
    setTimeout(
      () =>
        document.addEventListener(
          "click",
          (ev) => {
            if (!pop.contains(ev.target as Node)) pop.remove();
          },
          { once: true },
        ),
      0,
    );
  }

  // ---------------------------------------------------------------- 数据

  private load(note: Note | null): void {
    this.sel = note?.id ?? null;
    this.editing = {
      id: note?.id ?? null,
      note: note ? { ...note, shots: [...note.shots] } : { kind: this.kind, status: "pending", title: "", body: "" },
    };
    this.paintEditor();
    this.say("");
  }

  /** 编辑器里的完整条目（用于复制 / 交给 agent：草稿也能用，只是没有 id）。 */
  private fullNote(note: Partial<Note>): Note | null {
    const now = Date.now();
    const body = note.body ?? "";
    const text = plainText(body);
    const title = (note.title ?? "").trim() || (text.split("\n").find((line) => line.trim()) ?? "").slice(0, 60) || tr("未命名");
    if (isRichEmpty(body) && !title.trim()) {
      this.say(tr("先写点什么"), true);
      return null;
    }
    return {
      id: note.id ?? "draft",
      kind: note.kind ?? this.kind,
      status: note.status ?? "pending",
      title,
      body,
      shots: [...(note.shots ?? [])],
      archivedAt: note.archivedAt ?? null,
      deletedAt: note.deletedAt ?? null,
      createdAt: note.createdAt ?? now,
      updatedAt: note.updatedAt ?? now,
    };
  }

  /** 保存（新建或更新）。保存成功前不动选择状态，避免广播先到把光标位置搅乱。 */
  private save(): void {
    if (!this.editing) return;
    // 归档 / 垃圾箱里存出来的新记录属于列表：先切回列表，不然 ack 一到就被「这条不该待在这堆里」关掉编辑器。
    if (this.view !== "active") this.setView("active");
    const note = this.editing.note;
    const body = this.editor?.html() ?? note.body ?? "";
    // 标题空着就从正文首行推：桥那边的兜底只会切纯文本，正文是 HTML 时会切出 `<p>`。
    const title = (note.title ?? "").trim() || plainText(body).trim().split("\n")[0].trim().slice(0, 60);
    if (isRichEmpty(body) && !title) {
      this.say(tr("先写点什么再存"), true);
      return;
    }
    this.saveTicket = { editing: this.editing };
    this.host.send({
      type: "notes.save",
      ...(this.editing.id ? { id: this.editing.id } : {}),
      kind: note.kind ?? this.kind,
      title,
      body,
    });
    this.say(tr("保存中…"));
  }

  /** 切走之前把改动存掉；草稿不存（用户可能只是点开看看又去别处）。 */
  private flush(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.dirty || !this.editing) return;
    if (this.editing.id) this.save();
    else if (!isRichEmpty(this.editing.note.body ?? "") || (this.editing.note.title ?? "").trim()) this.save();
  }

  private setStatus(status: NoteStatus): void {
    if (!this.editing) return;
    this.editing.note.status = status;
    this.pushStatus();
    this.paintEditor();
    this.paintNav();
    this.paintList();
  }

  private pushStatus(): void {
    if (!this.editing?.id) return;
    this.host.send({
      type: "notes.status",
      id: this.editing.id,
      status: this.editing.note.status ?? "pending",
    });
    // 状态是「立刻落盘」的，不属于等「保存」那一批：别让 dirty 拦住「交给 agent」。
    this.dirty = false;
  }

  private removeShot(path: string): void {
    if (!this.editing?.id) return;
    this.editing.note.shots = (this.editing.note.shots ?? []).filter((s) => s !== path);
    this.host.send({ type: "notes.shot.remove", id: this.editing.id, path });
    this.paintEditor();
  }

  private async addFiles(files: File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) {
      this.say(tr("只收图片（截图 / png / jpg / webp / gif）"), true);
      return;
    }
    const room = Math.max(0, 24 - (this.editing?.note.shots?.length ?? 0) - this.pendingShots.length);
    for (const file of images.slice(0, room)) {
      const url = await readDataUrl(file).catch(() => "");
      if (url) this.pendingShots.push(url);
    }
    this.markDirty();
    this.paintEditor();
    this.say(tr("{p1} 张待保存", { p1: this.pendingShots.length }));
  }

  private uploadPending(id: string): void {
    for (const dataUrl of this.pendingShots) this.host.send({ type: "notes.shot", id, dataUrl });
    this.pendingShots = [];
  }

  // ---------------------------------------------------------------- 从 app.ts 进来的广播

  /** 广播（任何人保存了任何东西）→ 列表 / 分区计数。 */
  setNotes(notes: Note[]): void {
    if (this.restoring) {
      this.restoring = false;
      this.restorePick(notes);
    }
    this.paintNav();
    this.paintList();
    if (!this.sel) return;
    const n = notes.find((x) => x.id === this.sel);
    // 只在「这条不该待在这堆里了」时关编辑器；只是被「显示已处理」过滤掉的不算，不然点个状态就把编辑器关了。
    if (!n || this.goneFromView(n)) {
      this.sel = null;
      this.editing = null;
      this.remember();
      this.paintEditor();
    }
  }

  /** 打开面板的第一次广播：把上次选中的那条接回来；它已经不在这一堆里就只保留分区。 */
  private restorePick(notes: Note[]): void {
    if (!this.memory.sel || this.view === "failures") return;
    const n = notes.find((x) => x.id === this.memory.sel);
    if (!n || !this.inView(n) || (this.view === "active" && n.kind !== this.kind)) {
      this.remember();
      return;
    }
    this.load(n);
    this.remember();
  }

  /** 广播来的这条，按它自己的归档 / 删除状态，判断是不是已经不该出现在当前视图里。 */
  private goneFromView(n: Note): boolean {
    if (n.deletedAt) return this.view !== "trash";
    if (n.archivedAt) return this.view !== "archived";
    return this.view !== "active";
  }

  saved(msg: any): void {
    if (msg.error) {
      this.say(String(msg.error), true);
      return;
    }
    const note = msg.note as Note | undefined;
    if (!note) return;
    // 存完之后用户已经点到别处：这次 ack 只让列表刷新，不动编辑器。
    const mine = !this.saveTicket || this.saveTicket.editing === this.editing;
    this.saveTicket = null;
    if (!mine) return;
    if (this.editing && !this.editing.id) this.editing.id = note.id;
    if (this.editing && this.editing.id === note.id) {
      // 桥那边截过长度、刷过 updatedAt：以它为准，但别覆盖用户正在敲的正文。
      this.editing.note.updatedAt = note.updatedAt;
      this.editing.note.shots = [...note.shots];
    }
    this.sel = note.id;
    if (this.editing?.id === note.id) this.paintedId = note.id;
    this.dirty = false;
    this.remember();
    this.paintList();
    this.uploadPending(note.id);
    // 自动保存：脚注就说「已自动保存 · 时间 · 字数」。
    if (this.editing?.id === note.id) {
      this.editing.note.body = this.editor?.html() ?? this.editing.note.body;
      this.footEl.textContent = tr("已自动保存 · 改于 {p1} · {p2} 字", { p1: stamp(note.updatedAt), p2: this.wordsOf(this.editing.note) });
    }
    this.paintEditor();
  }

  shot(msg: any): void {
    if (msg.error) {
      this.say(tr("附图失败：{p1}", { p1: msg.error }), true);
      return;
    }
    if (this.editing && msg.shots) {
      this.editing.note.shots = [...msg.shots];
      if (!this.pendingShots.length) this.paintEditor();
    }
  }

  exportAll(): void {
    const rows = this.visible();
    if (!rows.length) {
      this.say(tr("这一堆里没有可导出的记录"), true);
      return;
    }
    const label = NOTE_KINDS.find((k) => k.id === this.kind)?.label ?? this.kind;
    const md = [tr("# {p1} 记录 · {p2}", { p1: label, p2: stamp(Date.now()) }), ""].concat(rows.map((n) => `${noteMarkdown(n)}\n---`)).join("\n\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${label}-notes-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    this.say(tr("已导出 {p1} 条", { p1: rows.length }));
  }
}

function closeButton(text: string, run: () => void): HTMLElement {
  const b = el("button", "btn ghost", text);
  b.onclick = run;
  return b;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(tr("读不出这张图")));
    reader.readAsDataURL(file);
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
