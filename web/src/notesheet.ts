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
import { icon, face, type IconName } from "./icons.ts";
import { FailPanel } from "./failpanel.ts";
import { ripeEntries, type FailLedger } from "./failures.ts";
import { RichEditor } from "./notes/editor.ts";
import { notePeerGuard, type PeerNoteBlock } from "./notes/peer-guard.ts";
import { isRichEmpty, plainText, richToMarkdown, textToRich } from "./notes/rich.ts";
import type { RuleBook } from "./rules.ts";
import type { Note, NoteKind, NoteStatus, NotesLayout } from "./types.ts";
import "./notes.css";
import { tr } from "./i18n/index.ts";
import { appZoom, markSurface, mountOverlay, pushEscLayer, retireOverlay } from "./modal.ts";

export const NOTE_KINDS: { id: NoteKind; label: string; glyph: IconName | string }[] = [
  { id: "bug", label: "bug", glyph: "bug" },
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

/** 内网通连动（#509）：最后一位收件人只记 nodeId，换人或换机器就在列表里重选。 */
const PEER_LAST_KEY = "notes.peerLast";

/** 「提交给好友」超限时的提示（#663）：只说第一条超的，带数值。正文按 1000 进算 KB，跟服务端的「200 KB」对得上。 */
function peerGuardHint(b: PeerNoteBlock): string {
  if (b.blocked === "title") return tr("标题 {p1} 字，上限 {p2} 字", { p1: b.actual, p2: b.limit });
  if (b.blocked === "shots") return tr("截图 {p1} 张，上限 {p2} 张", { p1: b.actual, p2: b.limit });
  return tr("正文 {p1} KB，上限 {p2} KB", { p1: Math.ceil(b.actual / 1000), p2: b.limit / 1000 });
}

interface PeerOnline {
  nodeId: string;
  nickname: string;
  hostname: string;
  port: number;
}

interface PeerView {
  enabled: boolean;
  running: boolean;
  reason?: string;
  status?: { nodeId?: string; online?: PeerOnline[] } | null;
}

interface PeerContact {
  nodeId: string;
  nickname: string;
  hostname: string;
  online?: boolean;
}

interface PeerPerson {
  nodeId: string;
  nickname: string;
  hostname: string;
  online: boolean;
}

interface ShotMeta {
  name: string;
  size: number;
  sha256: string;
}

async function peerJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function readLastPeer(): string {
  try {
    return localStorage.getItem(PEER_LAST_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastPeer(nodeId: string): void {
  try {
    localStorage.setItem(PEER_LAST_KEY, nodeId);
  } catch {
    /* 存不了就下次重选 */
  }
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  /** 列表还没到就被要求「把光标放进去」：等上次选中的那条接回来再决定聚焦哪里。 */
  private focusAfterRestore = false;
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
  /** 顶栏的全局检索（D331）：跨分区的活记录，标题 / 正文。空串 = 没在搜；不落盘（搜索词不记）。 */
  private gq = "";
  private gsearchEl!: HTMLInputElement;
  private listTitleEl!: HTMLElement;
  private gclearEl!: HTMLButtonElement;
  private sel: string | null = null;
  /** 编辑器里现在是什么：null = 没在编辑。 */
  private editing: { id: string | null; note: Partial<Note> } | null = null;
  private pendingShots: string[] = [];
  private dirty = false;
  /** 这一次保存属于哪个编辑器实例：切走之后到达的 ack 不许改当前选择。 */
  private saveTicket: { editing: unknown; edits: number } | null = null;
  /** 编辑次数：存盘 ack 回来时只有「发出去之后没再改过」才算干净，不然 ack 会把后来敲的那句标成已存。 */
  private edits = 0;
  /** 提交前等保存 ack 的回调（#509）。 */
  private saveWaiters: Array<{ resolve: (note: Note | null) => void; timer: number }> = [];
  /** 内网通请求在飞：菜单与按钮置灰，防连点。 */
  private peerBusy = false;
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
    const back = markSurface(el("div", "sheet-back notes-back"), "window", { enter: "none" });
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
    // 账本跟笔记共用左侧分区栏：只替换「列表 + 正文」两栏。整块三栏一起藏掉的话，进了出错记录就回不去了。
    this.consoleEl.append(this.failEl);

    // 包一层 `notes-main` 好让 sheet 的三行网格（头 / 身 / 脚）不变。
    const main = el("div", "notes-main");
    main.append(this.bodyEl);
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
    const headGlyph = el("span", "notes-head-glyph");
    headGlyph.append(icon("bug", { size: 15 }));
    title.append(headGlyph, el("span", "", tr("记录面板")));
    this.headBadgeEl = el("span", "notes-head-badge", "");
    this.headBadgeEl.hidden = true;
    this.headCountEl = el("span", "notes-head-sub", "");

    const nb = el("button", "btn primary notes-head-new", tr("＋ 记一条"));
    nb.onclick = () => this.newNote();
    this.newBtn = nb;

    // 全局检索（D331）：跨分区搜活记录的标题 / 正文；有词就把中栏切成结果视图。
    const gsearch = el("input", "notes-head-search") as HTMLInputElement;
    gsearch.type = "search";
    gsearch.placeholder = tr("搜全部记录");
    gsearch.setAttribute("aria-label", tr("搜全部记录"));
    gsearch.oninput = () => {
      this.gq = gsearch.value.trim().toLowerCase();
      // 列表收着时结果看不见：顺手展开，但别把焦点从这颗框抢走。
      if (this.gq && this.layout.list === "closed") this.setList("open", false);
      this.paintHead();
      this.paintNav();
      this.paintList();
    };
    this.gsearchEl = gsearch;

    head.append(title, this.headBadgeEl, this.headCountEl, el("div", "grow"), gsearch, nb, closeButton(tr("关闭"), () => this.close()));
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
    this.listTitleEl = el("span", "nc-list-title", tr("记录"));
    const collapseList = el("button", "nc-rail-tab", "«");
    collapseList.title = tr("收起列表");
    collapseList.setAttribute("aria-label", tr("收起列表"));
    collapseList.onclick = () => this.setList("closed");
    this.gclearEl = el("button", "nc-gclear") as HTMLButtonElement;
    this.gclearEl.append(icon("close", { size: 13 }));
    this.gclearEl.type = "button";
    this.gclearEl.title = tr("清除搜索");
    this.gclearEl.setAttribute("aria-label", tr("清除搜索"));
    this.gclearEl.onclick = () => this.clearSearch(true);
    top.append(this.listTitleEl, this.listCountEl, collapseList, this.gclearEl);

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

  private setList(list: NotesLayout["list"], focus = true): void {
    this.layout = { ...this.layout, list };
    writeLayout(this.layout);
    this.applyLayout();
    if (list === "open" && focus && !this.searchEl.hidden) this.searchEl.focus();
  }

  /** 窄条上的展开按钮只在列表收起时出现。 */
  private paintRails(): void {
    this.railList.hidden = this.layout.list !== "closed";
  }

  // ---------------------------------------------------------------- 第一栏

  private paintNav(): void {
    const notes = this.host.notes();
    // 搜索时导航空放：结果不分属任何一个分区（点了某个分区就退出搜索，见 setKind / setView）。
    const searching = this.searching();
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

    const item = (key: string, glyph: IconName | string, label: string, count: number, on: boolean, run: () => void): HTMLElement => {
      const b = el("button", `nc-nav-item${on ? " on" : ""}`) as HTMLButtonElement;
      b.dataset.key = key;
      b.title = label;
      const navGlyph = el("span", "nc-nav-glyph");
      navGlyph.append(face(glyph, 14));
      b.append(navGlyph, el("span", "nc-nav-label", label));
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
      nav.append(item(k.id, k.glyph, k.label, pending, !searching && this.view === "active" && this.kind === k.id, () => this.setKind(k.id)));
    }
    nav.append(el("div", "nc-nav-sep"));
    const ripe = ripeEntries(this.ledger).length;
    nav.append(item("failures", "bolt", tr("AI 出错记录"), ripe, !searching && this.view === "failures", () => this.setView("failures")));

    const viewItem = (id: "archived" | "trash", glyph: IconName | string, label: string, count: number): HTMLElement =>
      item(id, glyph, label, count, !searching && this.view === id, () => this.setView(id));
    nav.append(el("div", "nc-nav-sep"));
    nav.append(viewItem("archived", "archive", tr("归档"), notes.filter((n) => n.archivedAt && !n.deletedAt).length));
    nav.append(viewItem("trash", "trash", tr("垃圾箱"), notes.filter((n) => n.deletedAt).length));
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
    if (this.searching() || this.query) return tr("没有匹配的记录。");
    if (this.view === "trash") return tr("垃圾箱是空的。");
    if (this.view === "archived") return tr("还没有归档的记录。");
    if (this.seg === "pending") return tr("这一类里没有待处理的记录。");
    if (this.seg === "done") return tr("这一类里没有已处理的记录。");
    if (this.seg === "dropped") return tr("这一类里没有被忽略的记录。");
    return tr("这一类还是空的，点「＋ 记一条」开始。");
  }

  private paintHead(): void {
    const notes = this.host.notes();
    const searching = this.searching();
    const here = this.visible().length;
    this.headCountEl.textContent = searching
      ? tr("{p1} · {p2} 条命中", { p1: tr("全部记录"), p2: here })
      : tr("{p1} · {p2} 条在眼前", { p1: this.viewLabel(), p2: here });
    const pending = !searching && this.view === "active"
      ? notes.filter((n) => n.kind === this.kind && n.status === "pending" && !n.archivedAt && !n.deletedAt).length
      : 0;
    this.headBadgeEl.hidden = !pending;
    this.headBadgeEl.textContent = pending ? String(pending) : "";
    this.headBadgeEl.title = pending ? tr("这一类还有 {p1} 条待处理", { p1: pending }) : "";
    // 搜索结果里不摆「＋ 记一条」：它得知道建到哪个分区，而搜索时导航空放。
    this.newBtn.hidden = this.view !== "active" || searching;
    this.listTitleEl.textContent = searching ? tr("搜索结果") : tr("记录");
    this.gclearEl.hidden = !searching;
    // 两个搜索框并排会分不清哪个管什么：全局检索期间把列表内那颗收起来。
    this.searchEl.hidden = searching;
    this.clearTrash.hidden = this.view !== "trash";
    const trashed = notes.filter((n) => n.deletedAt).length;
    this.clearTrash.textContent = trashed ? tr("清空垃圾箱（{p1}）", { p1: trashed }) : tr("清空垃圾箱");
    this.paintMode();
  }

  private paintMode(): void {
    // 全局检索期间不摆 AI 出错账本：结果画在中栏列表里，账本留着会把结果盖住。
    const fail = this.view === "failures" && !this.searching();
    this.consoleEl.classList.toggle("in-fail", fail);
    this.failEl.hidden = !fail;
    this.root.firstElementChild?.classList.toggle("in-failures", fail);
  }

  // ---------------------------------------------------------------- 选 / 存

  /** 选一类：如果现在正看着归档 / 垃圾箱，先回列表。 */
  private setKind(kind: NoteKind): void {
    // 搜索中点分区 = 退出搜索：不然点了跟没反应一样（导航空放，哪一项都不亮）。
    if (!this.searching() && this.view === "active" && this.kind === kind) return;
    this.flush();
    this.kind = kind;
    this.view = "active";
    this.resetSearch();
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
    if (!this.searching() && this.view === view) return;
    this.flush();
    this.view = view;
    this.resetSearch();
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

  /** Esc 到了笔记面板这一层：交给 agent 的菜单先关；全局检索有字先清空；否则关面板。一次 Esc 只关一样东西。 */
  private onEscape(): void {
    const menu = this.root.querySelector(".note-handoff") ?? document.querySelector(".note-handoff");
    if (menu) {
      menu.remove();
      return;
    }
    if (this.searching()) {
      this.clearSearch(true);
      return;
    }
    this.close();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
    // 统一弹层栈：压在上面的小框（提示 / 确认）先接 Esc；轮到面板时才走这里的层内逻辑。
    this.escPop = pushEscLayer({ el: this.root, onEsc: () => this.onEscape() });
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

  /** 从内网通卡片「打开记录」（#508）：切到它所在的分类 / 分区并选中这一条。 */
  openNote(id: string): void {
    const note = this.host.notes().find((n) => n.id === id);
    if (!note) return;
    this.kind = note.kind;
    this.view = note.deletedAt ? "trash" : note.archivedAt ? "archived" : "active";
    this.seg = "all";
    this.resetSearch();
    this.paintNav();
    this.paintList();
    this.select(id);
  }

  /** 打开面板就把光标放进「记一条」的那一格。 */
  focusComposer(): void {
    if (this.view === "failures") {
      this.failPanel.focus();
      return;
    }
    if (this.editing) this.editor?.focus();
    // 上次选着某条、列表还在路上：别急着开新草稿——那会把记忆里的 sel 写成 null，接回来就落空了。
    else if (this.restoring && this.memory.sel) this.focusAfterRestore = true;
    else this.newNote();
  }

  close(): void {
    // 关面板前落一次盘：自动保存的定时器可能还没到点。
    this.flush();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.escPop?.();
    this.escPop = null;
    if (this.shortcut) document.removeEventListener("keydown", this.shortcut, true);
    document.querySelector(".note-handoff")?.remove();
    this.editor?.destroy();
    retireOverlay(this.root);
    this.onClose?.();
  }

  private escPop: (() => void) | null = null;
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
    // 全局检索：不看当前分区与分段，只看「活记录」（归档 / 垃圾箱另有各自主页）。
    if (this.searching()) {
      const gq = this.gq;
      return this.host.notes().filter((n) => !n.deletedAt && !n.archivedAt && this.matches(n, gq));
    }
    const q = this.query;
    return this.host.notes().filter((n) => this.inView(n) && (this.view !== "active" || n.kind === this.kind) && (!q || this.matches(n, q)));
  }

  /** 检索只看人写得出来的字段：标题、正文（按纯文本）。 */
  private matches(n: Note, q: string): boolean {
    return [n.title, this.summaryOf(n)].some((v) => String(v ?? "").toLowerCase().includes(q));
  }

  /** 顶栏全局检索有没有字；有就是「结果视图」，view / kind 原封不动（清空后原路返回）。 */
  private searching(): boolean {
    return this.gq.length > 0;
  }

  /** 两个搜索框一起清空：切分区 / 切去向 / 跳到某条时都要，别在三处各抄一遍。 */
  private resetSearch(): void {
    this.gq = "";
    this.gsearchEl.value = "";
    this.query = "";
    this.searchEl.value = "";
  }

  /** 清掉全局搜索回到原视图；focus=true 时把焦点交还给顶栏那颗框。 */
  private clearSearch(focus: boolean): void {
    if (!this.gq) {
      if (focus) this.gsearchEl.focus();
      return;
    }
    this.gq = "";
    this.gsearchEl.value = "";
    this.paintHead();
    this.paintNav();
    this.paintList();
    if (focus) this.gsearchEl.focus();
  }

  /** 搜索结果里点一条：先退出搜索，再切到它所在的分区并选中。 */
  private openHit(id: string): void {
    this.clearSearch(false);
    this.openNote(id);
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
    const show = this.view === "active" && !this.searching();
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
    const idle = this.view === "active" && this.seg === "all" && !this.searching();
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
    const close = el("button", "nc-banner-x");
    close.append(icon("close", { size: 13 }));
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
    row.onclick = () => (this.searching() ? this.openHit(n.id) : this.select(n.id));
    row.onkeydown = (ev) => {
      if (ev.target !== row) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        if (this.searching()) this.openHit(n.id);
        else this.select(n.id);
      }
    };

    const top = el("div", "nc-row-top");
    // 结果行来自不同分区：标题前挂一颗分区胶囊，否则看不出这一条原来在哪。
    if (this.searching()) {
      const k = NOTE_KINDS.find((x) => x.id === n.kind);
      top.append(el("span", "nc-row-kind", `${k?.glyph ?? ""} ${k?.label ?? n.kind}`));
    }
    const status = el("span", `nc-dot ${n.status}`, STATUS_GLYPH[n.status]);
    status.title = STATUS_LABEL[n.status];
    top.append(el("span", "nc-row-title", n.title), status);
    row.append(top);

    const summary = this.summaryOf(n).split("\n").find((line) => line.trim()) ?? "";
    if (summary) row.append(el("div", "nc-row-body", summary));

    const meta = el("div", "nc-row-meta");
    const shotBox = el("span", "nc-row-shot");
    shotBox.append(icon("image", { size: 12 }), document.createTextNode(` ${n.shots?.length ?? 0}`));
    meta.append(shotBox);
    meta.append(el("span", "nc-row-words", tr("{p1} 字", { p1: this.wordsOf(n) })));
    meta.append(el("span", "nc-row-time", shortTime(n.updatedAt)));
    // 结果行只负责「打开」：归档 / 删除两颗小按钮跟着当前这一堆的语义变，跨分区结果里容易误操作。
    if (!this.searching()) meta.append(this.rowActs(n));
    row.append(meta);
    return row;
  }

  /** 行右侧那两个小图标：按当前这堆是什么，给可用的动作。 */
  private rowActs(n: Note): HTMLElement {
    const acts = el("div", "nc-row-acts");
    const mk = (glyph: IconName | string, title: string, run: () => void, danger = false): HTMLElement => {
      const b = el("button", `nc-row-act${danger ? " danger" : ""}`);
      b.append(face(glyph, 13));
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
        mk("unarchive", tr("复原：放回列表"), () => this.setLife(n.id, "active")),
        mk("close", tr("彻底删除（不能撤销）"), () => this.purgeOne(n.id), true),
      );
    } else if (this.view === "archived") {
      acts.append(
        mk("↺", tr("复原：放回列表"), () => this.setLife(n.id, "active")),
        mk("trash", tr("删除（放垃圾箱，可复原）"), () => this.setLife(n.id, "trashed")),
      );
    } else {
      acts.append(
        mk("archive", tr("归档"), () => this.setLife(n.id, "archived")),
        mk("trash", tr("删除（放垃圾箱，可复原）"), () => this.setLife(n.id, "trashed")),
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
    this.edits += 1;
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
      const link = el("button", "btn ghost", tr("内网通连动 ▾"));
      link.onclick = () => this.peerMenu(link, note);
      const del = el("button", "btn danger", tr("删除"));
      del.title = tr("放进垃圾箱（可复原），不是彻底删");
      del.onclick = () => this.editing?.id && this.setLife(this.editing.id, "trashed");
      return [back, link, el("div", "grow"), del];
    }
    const row: HTMLElement[] = [];
    const link = el("button", "btn ghost", tr("内网通连动 ▾"));
    link.onclick = () => this.peerMenu(link, note);
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
    row.push(link, hand);
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
    const pop = markSurface(el("div", "note-handoff"), "menu");
    // 挂进 #app 才跟「外观 → 字号」的 zoom 一起缩；量到的是视觉 px，写进 style 前先除一次缩放。
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 274)) / appZoom()}px`;
    pop.style.top = `${(r.bottom + 6) / appZoom()}px`;
    const add = (label: IconName | string, hint: string, run: () => void, text?: string): void => {
      const b = el("button");
      const labelBox = el("span", "handoff-label");
      labelBox.append(face(label, 13));
      if (text) labelBox.append(document.createTextNode(` ${text}`));
      b.append(labelBox, el("span", "handoff-hint", hint));
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
      add("archive", tr("不在列表里，复原才回来"), () => this.editing?.id && this.setLife(this.editing.id, "archived"), tr("归档"));
      add("trash", tr("放进垃圾箱，可复原"), () => this.editing?.id && this.setLife(this.editing.id, "trashed"), tr("删除"));
    }
    mountOverlay(pop);
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
    const pop = markSurface(el("div", "note-handoff"), "menu");
    pop.style.position = "fixed";
    pop.style.left = `${Math.max(12, Math.min(r.right - 260, innerWidth - 274)) / appZoom()}px`;
    pop.style.top = `${(r.bottom + 6) / appZoom()}px`;
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
    mountOverlay(pop);
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

  // ---------------------------------------------------------------- 内网通连动（#509）

  /** 正文下的「内网通连动 ▾」：先问桥要内网通状态，再画「提交给好友」。 */
  private peerMenu(anchor: HTMLElement, note: Partial<Note>): void {
    const full = this.fullNote(note);
    if (!full) return;
    const blank = !String(note.title ?? "").trim() && !plainText(note.body ?? "").trim();
    const tooBig = notePeerGuard(full.title, full.body, full.shots.length);
    document.querySelector(".note-handoff")?.remove();
    const r = anchor.getBoundingClientRect();
    const pop = markSurface(el("div", "note-handoff note-peer-menu"), "menu");
    pop.style.left = `${Math.max(12, Math.min(r.right - 300, innerWidth - 314)) / appZoom()}px`;
    pop.style.top = `${(r.bottom + 6) / appZoom()}px`;
    const add = (label: string, hint: string, disabled: boolean, run: () => void): void => {
      const b = el("button") as HTMLButtonElement;
      b.append(el("span", "handoff-label", label), el("span", "handoff-hint", hint));
      b.disabled = disabled;
      b.onclick = () => {
        if (b.disabled) return;
        pop.remove();
        run();
      };
      pop.append(b);
    };
    const waiting = el("button") as HTMLButtonElement;
    waiting.disabled = true;
    waiting.append(el("span", "handoff-label", tr("正在问内网通…")), el("span", "handoff-hint", tr("只看一眼它开没开")));
    pop.append(waiting);
    mountOverlay(pop);
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
    void peerJson<PeerView>("/api/peer")
      .then((view) => {
        if (!pop.isConnected) return;
        pop.replaceChildren();
        const why = view.enabled ? "" : (view.reason || (view.running ? tr("内网通正在重启，等它起来再试") : tr("内网通没启用")));
        const empty = blank ? tr("先写点东西") : "";
        add(
          tr("提交给好友"),
          why || empty || (tooBig ? peerGuardHint(tooBig) : tr("打包标题、正文、分类、状态与 {p1} 张图", { p1: full.shots.length })),
          Boolean(why) || blank || Boolean(tooBig),
          () => void this.submitToPeer(),
        );
      })
      .catch((err: Error) => {
        if (!pop.isConnected) return;
        pop.replaceChildren();
        add(tr("提交给好友"), tr("连不上内网通：{p1}", { p1: err.message }), true, () => {});
      });
  }

  /** 提交给好友：先落盘拿 id，再选人、确认、发 note 帧，最后逐张补截图。 */
  private async submitToPeer(): Promise<void> {
    if (this.peerBusy) return;
    const expected = (this.editing?.note.shots?.length ?? 0) + this.pendingShots.length;
    const saved = await this.saveAndWait();
    if (!saved) {
      this.say(tr("没保存成功，先别提交"), true);
      return;
    }
    const latest = await this.waitShots(saved.id, expected);
    if (!latest) return;
    const person = await this.pickPeer(tr("提交给好友"));
    if (!person) return;
    let shots: ShotMeta[] = [];
    try {
      shots = (await peerJson<{ shots: ShotMeta[] }>("/api/notes/measure", { method: "POST", body: JSON.stringify({ paths: latest.shots }) })).shots;
    } catch (err) {
      this.say(tr("读不到截图：{p1}", { p1: (err as Error).message }), true);
      return;
    }
    const missing = Math.max(0, expected - latest.shots.length);
    if (!(await this.confirmSubmit(latest, person, shots, missing))) return;
    this.peerBusy = true;
    this.say(tr("提交中…"));
    try {
      await peerJson("/api/peer/sendnote", {
        method: "POST",
        body: JSON.stringify({
          peer: person.nodeId,
          note: {
            title: latest.title,
            body: latest.body,
            kind: latest.kind,
            status: latest.status,
            shots,
            noteCreatedAt: latest.createdAt,
            noteUpdatedAt: latest.updatedAt,
          },
        }),
      });
      for (let i = 0; i < latest.shots.length; i += 1) {
        try {
          await peerJson("/api/peer/sendfile", { method: "POST", body: JSON.stringify({ peer: person.nodeId, path: latest.shots[i] }) });
        } catch (err) {
          throw new Error(tr("记录包已发出，但第 {p1} 张图没发出去：{p2}", { p1: i + 1, p2: (err as Error).message }));
        }
      }
      writeLastPeer(person.nodeId);
      this.say(tr("已提交给 {p1}", { p1: person.nickname }));
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.peerBusy = false;
    }
  }

  /** 保存并等 ack：提交要的是桥发回来的真 id 与截图清单。 */
  private saveAndWait(): Promise<Note | null> {
    if (!this.editing) return Promise.resolve(null);
    const note = this.editing.note;
    const body = this.editor?.html() ?? note.body ?? "";
    const title = (note.title ?? "").trim() || plainText(body).trim().split("\n")[0].trim().slice(0, 60);
    if (isRichEmpty(body) && !title) {
      this.say(tr("先写点什么再存"), true);
      return Promise.resolve(null);
    }
    if (!this.dirty && this.editing.id) {
      const full = this.fullNote(note);
      return Promise.resolve(full ? { ...full, id: this.editing.id } : null);
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.saveWaiters = this.saveWaiters.filter((w) => w.resolve !== resolve);
        this.say(tr("保存超时，先别提交"), true);
        resolve(null);
      }, 6000);
      this.saveWaiters.push({ resolve, timer });
      this.save();
    });
  }

  /** 等新图落盘（保存后 notes.shot 是一条条回来的），超时就按现有张数提交并让确认页报缺图。 */
  private async waitShots(id: string, expected: number): Promise<Note | null> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const n = this.host.notes().find((x) => x.id === id);
      if (n && n.shots.length >= expected) return n;
      await new Promise((r) => window.setTimeout(r, 100));
    }
    return this.host.notes().find((x) => x.id === id) ?? null;
  }

  /** 选人：合并通讯录与在线名单，排除自己、在线优先、可搜昵称与主机名。 */
  private pickPeer(title: string): Promise<PeerPerson | null> {
    return new Promise((resolve) => {
      const last = readLastPeer();
      const wrap = markSurface(el("div", "peer-pick"), "window");
      const panel = el("div", "peer-pick-panel");
      const head = el("div", "peer-pick-head");
      const cancel = el("button", "btn ghost", tr("取消"));
      head.append(el("span", "peer-pick-title", title), el("div", "grow"), cancel);
      const search = el("input", "peer-pick-search") as HTMLInputElement;
      search.type = "search";
      search.placeholder = tr("搜昵称或主机名");
      const list = el("div", "peer-pick-list");
      panel.append(head, search, list);
      wrap.append(panel);
      const done = (person: PeerPerson | null): void => {
        retireOverlay(wrap);
        resolve(person);
      };
      pushEscLayer({ el: wrap, onEsc: () => done(null) });
      cancel.onclick = () => done(null);
      mountOverlay(wrap);
      search.focus();
      list.append(el("div", "peer-pick-empty", tr("正在问内网通…")));
      void this.peerPeople()
        .then((people) => {
          if (!wrap.isConnected) return;
          const paint = (): void => {
            const q = search.value.trim().toLowerCase();
            const rows = people.filter((p) => !q || p.nickname.toLowerCase().includes(q) || p.hostname.toLowerCase().includes(q));
            list.replaceChildren();
            if (!rows.length) {
              list.append(el("div", "peer-pick-empty", q ? tr("没有匹配的人") : tr("现在没有在线的人")));
              return;
            }
            for (const p of rows) {
              const row = el("button", "peer-pick-row") as HTMLButtonElement;
              row.disabled = !p.online;
              row.append(el("span", `pp-dot${p.online ? " on" : ""}`), el("span", "pp-name", p.nickname), el("span", "pp-host", p.hostname));
              if (p.nodeId === last) row.append(el("span", "pp-last", tr("上次")));
              if (!p.online) row.append(el("span", "pp-off", tr("离线")));
              row.onclick = () => done(p);
              list.append(row);
            }
          };
          search.oninput = paint;
          paint();
        })
        .catch((err: Error) => {
          if (wrap.isConnected) list.replaceChildren(el("div", "peer-pick-empty", tr("连不上内网通：{p1}", { p1: err.message })));
        });
    });
  }

  private async peerPeople(): Promise<PeerPerson[]> {
    const view = await peerJson<PeerView>("/api/peer");
    if (!view.enabled) throw new Error(view.reason || (view.running ? tr("内网通正在重启，等它起来再试") : tr("内网通没启用")));
    const contacts = await peerJson<{ contacts: PeerContact[] }>("/api/peer/contacts").catch(() => ({ contacts: [] }));
    const me = view.status?.nodeId;
    const online = new Map((view.status?.online ?? []).map((p) => [p.nodeId, p]));
    const people = new Map<string, PeerPerson>();
    for (const c of contacts.contacts ?? []) {
      if (!c.nodeId || c.nodeId === me) continue;
      people.set(c.nodeId, {
        nodeId: c.nodeId,
        nickname: c.nickname || c.hostname,
        hostname: c.hostname,
        online: Boolean(c.online) || online.has(c.nodeId),
      });
    }
    for (const [id, p] of online) {
      if (id === me) continue;
      people.set(id, { nodeId: id, nickname: p.nickname || p.hostname, hostname: p.hostname, online: true });
    }
    return [...people.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.nickname.localeCompare(b.nickname, "zh"));
  }

  /** 提交前的确认页：给的是「对方会收到什么」，不是编辑框。 */
  private confirmSubmit(note: Note, person: PeerPerson, shots: ShotMeta[], missing: number): Promise<boolean> {
    return new Promise((resolve) => {
      const total = shots.reduce((sum, s) => sum + s.size, 0);
      const wrap = markSurface(el("div", "peer-pick"), "window");
      const panel = el("div", "peer-pick-panel peer-confirm");
      const head = el("div", "peer-pick-head");
      head.append(el("span", "peer-pick-title", tr("提交给好友")));
      const body = el("div", "peer-confirm-body");
      const row = (label: string, value: string, bad = false): void => {
        const line = el("div", "pc-row");
        line.append(el("span", "pc-k", label), el("span", `pc-v${bad ? " bad" : ""}`, value));
        body.append(line);
      };
      row(tr("标题"), note.title);
      row(tr("收件人"), `${person.nickname} · ${person.hostname}`);
      row(tr("分类 / 状态"), `${NOTE_KINDS.find((k) => k.id === note.kind)?.label ?? note.kind} · ${STATUS_LABEL[note.status]}`);
      row(tr("截图"), tr("{p1} 张 · {p2}", { p1: shots.length, p2: kb(total) }));
      if (missing) row(tr("缺图"), tr("还差 {p1} 张，等图到齐再提交", { p1: missing }), true);
      const foot = el("div", "peer-confirm-foot");
      const back = el("button", "btn ghost", tr("返回"));
      const ok = el("button", "btn primary", tr("提交")) as HTMLButtonElement;
      ok.disabled = missing > 0;
      foot.append(back, el("div", "grow"), ok);
      panel.append(head, body, foot);
      wrap.append(panel);
      const done = (yes: boolean): void => {
        retireOverlay(wrap);
        resolve(yes);
      };
      pushEscLayer({ el: wrap, onEsc: () => done(false) });
      back.onclick = () => done(false);
      ok.onclick = () => done(true);
      mountOverlay(wrap);
      ok.focus();
    });
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
    this.saveTicket = { editing: this.editing, edits: this.edits };
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
      const focus = this.focusAfterRestore;
      this.focusAfterRestore = false;
      if (focus) {
        if (this.editing) this.editor?.focus();
        else this.newNote();
      }
      this.paintNav();
      this.paintList();
      // 接回来的那条可能在列表下半截：滚到眼前（只在打开时这一下，广播刷新不动滚动位置）。
      this.rowListEl.querySelector<HTMLElement>(".nc-row.on")?.scrollIntoView({ block: "nearest" });
    } else {
      this.paintNav();
      this.paintList();
    }
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
      for (const w of this.saveWaiters.splice(0)) {
        window.clearTimeout(w.timer);
        w.resolve(null);
      }
      return;
    }
    const note = msg.note as Note | undefined;
    if (!note) return;
    // 存完之后用户已经点到别处：这次 ack 只让列表刷新，不动编辑器。
    const mine = !this.saveTicket || this.saveTicket.editing === this.editing;
    const sentAt = this.saveTicket?.edits ?? this.edits;
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
    // 存盘在路上时又敲了字：保持 dirty，让停手定时器 / 关面板的 flush 把后来那句也存上。
    this.dirty = this.edits !== sentAt;
    this.remember();
    this.paintList();
    this.uploadPending(note.id);
    // 自动保存：脚注就说「已自动保存 · 时间 · 字数」。
    if (this.editing?.id === note.id) {
      this.editing.note.body = this.editor?.html() ?? this.editing.note.body;
      this.footEl.textContent = tr("已自动保存 · 改于 {p1} · {p2} 字", { p1: stamp(note.updatedAt), p2: this.wordsOf(this.editing.note) });
    }
    this.paintEditor();
    for (const w of this.saveWaiters.splice(0)) {
      window.clearTimeout(w.timer);
      w.resolve({ ...note, shots: [...note.shots] });
    }
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


