/**
 * 记录面板（D95）：顶栏「🐞 bug」弹出的 dialog，左列表 + 右编辑器。
 *
 * 三条设计约束决定了这里的样子：
 * - **随手记要零等待**：新建就是「＋ 记一条」直接进编辑器，光标落在正文；Enter 就存，跑一个 WS 往返。
 * - **截图先攒后传**：粘贴 / 拖进来的图先以 data URL 挂在 `pendingShots` 上，保存时随条目一起
 *   落盘（`notes.shot`），所以「还没保存的草稿也能贴图」不需要两段式 UI。
 * - **状态不改正文**：pending → done → dropped 只是字段，编辑器和列表都跟着重画，不锁输入框。
 */
import { createEl as el } from "./chat.ts";
import { FailPanel } from "./failpanel.ts";
import { ripeEntries, type FailLedger } from "./failures.ts";
import type { RuleBook } from "./rules.ts";
import type { Note, NoteKind, NoteMode, NoteStatus } from "./types.ts";
import { tr } from "./i18n/index.ts";

export const NOTE_KINDS: { id: NoteKind; label: string; glyph: string }[] = [
  { id: "bug", label: "bug", glyph: "🐞" },
  { id: "change", label: tr("变更"), glyph: "◆" },
  { id: "idea", label: tr("想法"), glyph: "◇" },
  { id: "chore", label: tr("杂事"), glyph: "○" },
];

const STATUS_LABEL: Record<NoteStatus, string> = { pending: tr("待处理"), done: tr("已处理"), dropped: tr("已忽略") };
const NEXT_STATUS: Record<NoteStatus, NoteStatus> = { pending: "done", done: "dropped", dropped: "pending" };
const MODE_LABEL: Record<NoteMode, string> = { quick: tr("随手记"), form: tr("表单"), long: tr("长文本") };
/** 左栏在看哪一堆：在列表里 / 归档 / 垃圾箱 / AI 出错记录（只读，不算笔记）。 */
type View = "active" | "archived" | "trash" | "failures";

/** 面板跟页面之间只有这几个口子：发送、当前笔记列表、当前会话、两个「交给 agent」的落点。 */
export interface NotesHost {
  send(msg: unknown): void;
  notes(): Note[];
  session(): { id: string; name: string } | null;
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

/** 交给 agent 的正文：标题、原话、截图绝对路径。不解释「这是什么功能」，那是页面自己的事。
 *  正文里不写记录时的会话名：交接的落点是另一个会话，写上它那段字看着就像别人的记录混进来了。 */
export function noteMarkdown(note: Note): string {
  const head = `${STATUS_LABEL[note.status]} · ${stamp(note.createdAt)}`;
  const lines = [`## ${note.title}`, head, "", note.body];
  if (note.shots.length) lines.push("", ...note.shots.map((s) => `![](${s})`));
  if (note.issue) lines.push("", `issue: ${note.issue}`);
  if (note.commit) lines.push(`commit: ${note.commit}`);
  return lines.join("\n");
}

export class NotesSheet {
  private readonly host: NotesHost;
  private root!: HTMLElement;
  private tabsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private editorEl!: HTMLElement;
  private hintEl!: HTMLElement;

  private kind: NoteKind = "bug";
  private view: View = "active";
  /** AI 出错记录那份账本（D164）：跟笔记不是一回事，但共用一个面板。 */
  private ledger: FailLedger | null = null;
  private failPanel!: FailPanel;
  private failEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private showDone = false;
  private doneWrap!: HTMLElement;
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

  constructor(host: NotesHost) {
    this.host = host;
    this.build();
  }

  private build(): void {
    const back = el("div", "sheet-back notes-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.close();
    };
    const sheet = el("div", "sheet notes-sheet");

    const head = el("div", "sheet-head notes-head");
    head.append(el("div", "sheet-title", tr("🐞 bug 记录")));
    const tabs = el("div", "notes-tabs");
    this.tabsEl = tabs;
    this.doneWrap = this.doneSwitch();
    head.append(tabs, el("div", "grow"), this.doneWrap, closeButton(tr("关闭"), () => this.close()));
    sheet.append(head);

    const body = el("div", "notes-body");
    const left = el("div", "notes-side");
    const newBtn = el("button", "btn ghost notes-new", tr("＋ 记一条"));
    newBtn.onclick = () => this.newNote();
    this.newBtn = newBtn;
    // 归档 / 垃圾箱是「管理已有记录」的两堆，不是写的地方：那里只给检索（下面这个框），不给「＋ 记一条」。
    const search = el("input", "ns-input notes-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = tr("搜标题 / 正文");
    search.oninput = () => {
      this.query = search.value.trim().toLowerCase();
      this.paintList();
    };
    this.searchEl = search;
    left.append(newBtn, search, (this.listEl = el("div", "notes-items")));
    body.append(left, (this.editorEl = el("div", "notes-editor")));
    this.bodyEl = body;
    // 出错记录是第五个 tab，长得像笔记列表但内容只读：它整块换掉 body，不跟编辑器抢位置。
    this.failEl = el("div", "fail-wrap") as HTMLElement;
    this.failEl.hidden = true;
    this.failPanel = new FailPanel({
      send: (msg) => this.host.send(msg),
      handoff: (anchor, text) => this.handoffMenu(anchor, text),
      say: (text, bad = false) => this.say(text, bad),
    });
    this.failPanel.mount(this.failEl);
    // 笔记两栏和只读账本互斥，包一层 `notes-main` 好让 sheet 的三行网格（头 / 身 / 脚）不变。
    const main = el("div", "notes-main");
    main.append(body, this.failEl);
    sheet.append(main);

    const foot = el("div", "sheet-foot notes-foot");
    this.hintEl = el("span", "notes-hint", "");
    const clear = el("button", "btn danger notes-clear", tr("清空垃圾箱"));
    clear.title = tr("把垃圾箱里的记录彻底删掉（截图一起删），不能撤销");
    clear.onclick = () => this.emptyTrash();
    this.clearTrash = clear;
    const exportAll = el("button", "btn ghost", tr("导出全部"));
    exportAll.title = tr("把当前筛选下的记录导出成一份 Markdown");
    exportAll.onclick = () => this.exportAll();
    foot.append(this.hintEl, clear, exportAll);
    sheet.append(foot);

    back.append(sheet);
    this.root = back;
    this.paintHead();
    this.paintTabs();
    this.paintList();
    this.paintEditor();
  }

  /** 选一类：如果现在正看着归档 / 垃圾箱，先回列表。 */
  private setKind(kind: NoteKind): void {
    if (this.view === "active" && this.kind === kind) return;
    this.flush();
    this.kind = kind;
    this.view = "active";
    this.resetPick();
    this.paintHead();
    this.paintTabs();
    this.paintList();
    this.paintEditor();
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
    this.paintTabs();
    this.paintList();
    this.paintEditor();
  }

  /** 换到出错记录：收起笔记的两栏，把只读面板亮出来；回来时反过来。 */
  setFailures(ledger: FailLedger | null): void {
    this.ledger = ledger;
    this.paintTabs();
    this.failPanel.setLedger(ledger);
  }

  /** 规矩整本换（D164 延伸）：与账本同一条路径进来，面板自己决定怎么画。 */
  setRules(book: RuleBook | null): void {
    this.failPanel.setRules(book);
  }

  private paintMode(): void {
    const fail = this.view === "failures";
    this.bodyEl.hidden = fail;
    this.failEl.hidden = !fail;
    // 脚注里的「导出全部 / 清空垃圾箱」是笔记的，账本有自己的导出：整条藏掉。
    (this.root?.firstElementChild as HTMLElement | null)?.classList.toggle("in-failures", fail);
  }

  /** 头部那些会变的（计数、当前在哪一堆、清空按钮只在垃圾箱出现）。 */
  private paintHead(): void {
    const trashed = this.host.notes().filter((n) => n.deletedAt).length;
    this.doneWrap.hidden = this.view !== "active";
    this.newBtn.hidden = this.view !== "active";
    this.clearTrash.hidden = this.view !== "trash";
    this.clearTrash.textContent = trashed ? tr("清空垃圾箱（{p1}）", { p1: trashed }) : tr("清空垃圾箱");
    this.paintMode();
  }

  private doneSwitch(): HTMLElement {
    const label = el("label", "notes-switch");
    const input = el("input") as HTMLInputElement;
    input.type = "checkbox";
    input.onchange = () => {
      this.showDone = input.checked;
      this.paintList();
    };
    label.append(input, el("span", "", tr("显示已处理")));
    return label;
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
  }

  /** 打开面板就把光标放进「记一条」的那一格。 */
  focusComposer(): void {
    if (this.view === "failures") {
      this.failPanel.focus();
      return;
    }
    if (!this.editing) this.newNote();
    (this.editorEl.querySelector(".note-body") as HTMLTextAreaElement | null)?.focus();
  }

  close(): void {
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    document.querySelector(".note-handoff")?.remove();
    this.root.remove();
    this.onClose?.();
  }

  private esc: ((ev: KeyboardEvent) => void) | null = null;

  onClose: (() => void) | null = null;

  private say(text: string, bad = false): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle("bad", bad);
  }

  // ---------------------------------------------------------------- list

  /** 一条记录现在该出现在哪一堆里；「已处理」只过滤在列表里的那些，归档 / 垃圾箱里一律全显示。 */
  private inView(n: Note): boolean {
    if (n.deletedAt) return this.view === "trash";
    if (n.archivedAt) return this.view === "archived";
    if (this.view !== "active") return false;
    return this.showDone || n.status === "pending";
  }

  private visible(): Note[] {
    const q = this.query;
    return this.host.notes().filter((n) => this.inView(n) && (this.view !== "active" || n.kind === this.kind) && (!q || this.matches(n, q)));
  }

  /** 检索只看人写得出来的字段：标题、正文、issue / commit 号。 */
  private matches(n: Note, q: string): boolean {
    return [n.title, n.body, n.issue, n.commit].some((v) => String(v ?? "").toLowerCase().includes(q));
  }

  /** 一条 tab 带：四类 + 归档 / 垃圾箱。归它们同级、互斥——选了归档就不再是「bug 这一类」。 */
  private paintTabs(): void {
    const notes = this.host.notes();
    const tabs: HTMLElement[] = NOTE_KINDS.map((k) => {
      const pending = notes.filter((n) => n.kind === k.id && n.status === "pending" && !n.archivedAt && !n.deletedAt).length;
      const on = this.view === "active" && this.kind === k.id;
      const btn = el("button", `notes-tab${on ? " on" : ""}`, `${k.glyph} ${k.label}`);
      if (pending) btn.append(el("span", "n", String(pending)));
      btn.onclick = () => this.setKind(k.id);
      return btn;
    });
    tabs.push(el("span", "notes-tabs-sep"));
    // ⚡ 第五个 tab：只读账本（D164）。计数 = 还在烧的类数，不是条目总数。
    const ripe = ripeEntries(this.ledger).length;
    const fbtn = el("button", `notes-tab notes-viewtab fail-tab${this.view === "failures" ? " on" : ""}`, "⚡ " + tr("AI 出错记录"));
    if (ripe) fbtn.append(el("span", "n", String(ripe)));
    fbtn.title = tr("每次任务结束时点右下角「⚡ 总结本轮错误」，同类只加次数");
    fbtn.onclick = () => this.setView(this.view === "failures" ? "active" : "failures");
    tabs.push(fbtn);
    const view = (id: "archived" | "trash", glyph: string, label: string, count: number) => {
      const on = this.view === id;
      const btn = el("button", `notes-tab notes-viewtab${on ? " on" : ""}`, `${glyph} ${label}`);
      if (count) btn.append(el("span", "n", String(count)));
      btn.onclick = () => this.setView(on ? "active" : id);
      tabs.push(btn);
    };
    view("archived", "📦", tr("归档"), notes.filter((n) => n.archivedAt && !n.deletedAt).length);
    view("trash", "🗑️", tr("垃圾箱"), notes.filter((n) => n.deletedAt).length);
    this.tabsEl.replaceChildren(...tabs);
  }

  private paintList(): void {
    const rows = this.visible();
    if (!rows.length) {
      const empty = this.query
        ? tr("没有匹配的记录。")
        : this.view === "trash"
          ? tr("垃圾箱是空的。")
          : this.view === "archived"
            ? tr("还没有归档的记录。")
            : tr("这一类里没有{p1}记录。", { p1: this.showDone ? "" : tr("待处理的") });
      this.listEl.replaceChildren(el("div", "notes-empty", empty));
      return;
    }
    this.listEl.replaceChildren(
      ...rows.map((n) => {
        // 行本身是 div 而不是 <button>：里面还要放「归档 / 删除」两个小按钮，button 套 button 点不动。
        const row = el("div", `note-row${n.id === this.sel ? " on" : ""}`) as HTMLElement;
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
        const top = el("div", "note-row-top");
        top.append(el("span", "note-row-title", n.title), el("span", `note-pill ${n.status}`, STATUS_LABEL[n.status]));
        row.append(top);
        row.append(el("div", "note-row-body", n.body.split("\n")[0] ?? ""));
        if (n.shots.length) {
          const img = el("img", "note-row-shot") as HTMLImageElement;
          img.src = `/api/image?path=${encodeURIComponent(n.shots[0])}`;
          img.alt = "";
          row.append(img);
        }
        const meta = el("div", "note-row-meta");
        meta.append(el("span", "", shortTime(n.updatedAt)), el("span", "", n.sessionName ?? ""), this.rowActs(n));
        row.append(meta);
        return row;
      }),
    );
  }

  /** 行右侧那两个小图标：按当前这堆是什么，给可用的动作。 */
  private rowActs(n: Note): HTMLElement {
    const acts = el("div", "note-row-acts");
    const mk = (glyph: string, title: string, run: () => void, danger = false): HTMLElement => {
      const b = el("button", `note-row-act${danger ? " danger" : ""}`, glyph);
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
  }

  // ---------------------------------------------------------------- editor

  private newNote(): void {
    this.flush();
    this.sel = null;
    this.pendingShots = [];
    this.dirty = false;
    this.paintList();
    this.load(null);
    (this.editorEl.querySelector(".note-body") as HTMLTextAreaElement | null)?.focus();
  }

  private paintEditor(): void {
    if (!this.editing) {
      const empty = el("div", "notes-editor-empty");
      if (this.view === "active") {
        empty.append(
          el("div", "notes-editor-empty-title", tr("左栏点一条来改，或者")),
          (() => {
            const b = el("button", "btn primary", tr("＋ 记一条"));
            b.onclick = () => this.newNote();
            return b;
          })(),
        );
      } else {
        // 归档 / 垃圾箱只能看和复原：这里不摆「记一条」，不然存下去的新记录不在这堆里，看起来像没存上。
        empty.append(
          el("div", "notes-editor-empty-title", this.view === "trash" ? tr("垃圾箱里的记录不能改。") : tr("归档里的记录不能直接改。")),
          el("div", "notes-editor-empty-hint", tr("左栏点一条看一眼；要改先「复原」放回列表。")),
        );
      }
      this.editorEl.replaceChildren(empty);
      return;
    }

    const note = this.editing.note;
    const box = el("div", "note-ed");
    // 垃圾箱里的只读：能看清是什么、能复原或彻底删掉，但不给编辑（改一个已经删掉的东西没意义）。
    if (note.deletedAt) {
      this.paintTrashed(box, note);
      const top = this.editorEl.scrollTop;
      this.editorEl.replaceChildren(box);
      this.editorEl.scrollTop = top;
      return;
    }
    if (note.archivedAt) box.append(this.lifeBar(note));

    const modes = el("div", "chips note-modes");
    for (const mode of ["quick", "form", "long"] as NoteMode[]) {
      const chip = el("button", `chip${(note.mode ?? "quick") === mode ? " on" : ""}`, MODE_LABEL[mode]);
      chip.onclick = () => {
        if (!this.editing) return;
        this.editing.note.mode = mode;
        this.dirty = true;
        for (const other of modes.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        titleField.hidden = mode === "quick";
        bodyField.rows = mode === "long" ? 14 : mode === "form" ? 8 : 3;
        bodyField.classList.toggle("mono", mode === "long");
        bodyField.placeholder = mode === "long" ? tr("粘贴日志、堆栈、复现命令……") : mode === "form" ? tr("复现步骤 / 期望 vs 实际 / 环境……") : tr("记一句就行，Enter 保存 · Shift+Enter 换行");
        if (mode !== "quick") titleField.focus();
        else bodyField.focus();
      };
      modes.append(chip);
    }

    const titleField = el("input", "ns-input note-title") as HTMLInputElement;
    titleField.placeholder = tr("标题（留空就取正文第一行）");
    titleField.value = note.title ?? "";
    titleField.hidden = (note.mode ?? "quick") === "quick";
    titleField.oninput = () => {
      if (!this.editing) return;
      this.editing.note.title = titleField.value;
      this.dirty = true;
    };
    titleField.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.save();
      }
    };

    const bodyField = el("textarea", `ns-input note-body${(note.mode ?? "quick") === "long" ? " mono" : ""}`) as HTMLTextAreaElement;
    bodyField.rows = note.mode === "long" ? 14 : note.mode === "form" ? 8 : 3;
    bodyField.placeholder = note.mode === "long" ? tr("粘贴日志、堆栈、复现命令……") : note.mode === "form" ? tr("复现步骤 / 期望 vs 实际 / 环境……") : tr("记一句就行，Enter 保存 · Shift+Enter 换行");
    bodyField.value = note.body ?? "";
    bodyField.oninput = () => {
      if (!this.editing) return;
      this.editing.note.body = bodyField.value;
      this.dirty = true;
      count.textContent = tr("{p1} 字", { p1: bodyField.value.length });
    };
    bodyField.onkeydown = (ev) => {
      if (ev.key !== "Enter") return;
      const quick = (note.mode ?? "quick") === "quick";
      if (quick ? !ev.shiftKey : ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        this.save();
      }
    };
    bodyField.onpaste = (ev) => this.pasteShots(ev);
    bodyField.ondragover = (ev) => {
      ev.preventDefault();
      box.classList.add("drop");
    };
    bodyField.ondragleave = () => box.classList.remove("drop");
    bodyField.ondrop = (ev) => {
      box.classList.remove("drop");
      const files = [...(ev.dataTransfer?.files ?? [])];
      if (!files.length) return;
      ev.preventDefault();
      void this.addFiles(files);
    };

    const count = el("span", "notes-hint");
    count.textContent = tr("{p1} 字", { p1: (note.body ?? "").length });
    box.append(modes, titleField, bodyField, this.shotsStrip(note), this.metaRow(note), this.actionRow(note), count);
    // 编辑器比内容高的时候，底下这块不是白留的：说清楚这条落哪儿了，以及交给 agent 时给的是什么。
    const where = el("div", "note-foot-hint");
    where.textContent = this.editing.id
      ? tr("这条存于状态目录 notes/bug-notes.json；图在 notes/assets/{p1}/，交给 agent 时给的是绝对路径。", { p1: this.editing.id })
      : tr("还没存：Enter 存一条（Shift+Enter 换行），或点上面的「保存」。");
    box.append(where);

    const scrollTop = this.editorEl.scrollTop;
    this.editorEl.replaceChildren(box);
    this.editorEl.scrollTop = scrollTop;
  }

  /** 「已归档」提示条（垃圾箱在 paintTrashed 里另画，那个连按钮都不一样）。 */
  private lifeBar(note: Partial<Note>): HTMLElement {
    const bar = el("div", "note-life-bar");
    bar.append(el("span", "life-text", tr("已归档 · 不在列表里，复原才回来")));
    const back = el("button", "btn ghost", tr("复原"));
    back.onclick = () => {
      if (this.editing?.id) this.setLife(this.editing.id, "active");
    };
    bar.append(el("div", "grow"), back);
    return bar;
  }

  private paintTrashed(box: HTMLElement, note: Partial<Note>): void {
    const bar = el("div", "note-life-bar trash");
    bar.append(el("span", "life-text", tr("在垃圾箱里 · 不能编辑，复原后才会回到列表")));
    const back = el("button", "btn ghost", tr("复原"));
    back.onclick = () => {
      if (this.editing?.id) this.setLife(this.editing.id, "active");
    };
    const kill = el("button", "btn danger", tr("彻底删除"));
    kill.onclick = () => {
      if (this.editing?.id) this.purgeOne(this.editing.id);
    };
    bar.append(el("div", "grow"), back, kill);
    box.append(bar);
    box.append(el("div", "note-title-view", note.title ?? tr("未命名")));
    box.append(el("pre", "note-body-view", note.body ?? ""));
    if (note.shots?.length) {
      const strip = el("div", "note-shots");
      for (const path of note.shots) {
        const tile = el("div", "note-shot");
        const img = el("img") as HTMLImageElement;
        img.src = `/api/image?path=${encodeURIComponent(path)}`;
        img.alt = path.split(/[\/]/).pop() ?? "";
        img.onclick = () => window.open(img.src, "_blank");
        tile.append(img);
        strip.append(tile);
      }
      box.append(strip);
    }
    const meta = el("div", "note-meta");
    meta.append(el("span", "note-meta-time", tr("删于 {p1}", { p1: stamp(note.deletedAt ?? Date.now()) })));
    box.append(meta);
  }

  private shotsStrip(note: Partial<Note>): HTMLElement {
    const strip = el("div", "note-shots");
    const add = (src: string, alt: string, remove: () => void) => {
      const tile = el("div", "note-shot");
      const img = el("img") as HTMLImageElement;
      img.src = src;
      img.alt = alt;
      img.onclick = () => window.open(src, "_blank");
      const x = el("button", "note-shot-x", "×");
      x.title = tr("移除这张图");
      x.onclick = remove;
      tile.append(img, x);
      strip.append(tile);
    };
    for (const path of note.shots ?? []) add(`/api/image?path=${encodeURIComponent(path)}`, path.split(/[\\/]/).pop() ?? "", () => this.removeShot(path));
    this.pendingShots.forEach((dataUrl, i) => add(dataUrl, tr("新图 {p1}", { p1: i + 1 }), () => {
      this.pendingShots.splice(i, 1);
      this.dirty = true;
      this.paintEditor();
    }));
    const pick = el("label", "note-add-shot");
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
    if ((note.shots?.length ?? 0) + this.pendingShots.length < 24) strip.append(pick);
    strip.append(el("span", "note-shots-hint", tr("Ctrl+V 粘贴截图 / 拖文件进来 · 保存时一起落盘")));
    return strip;
  }

  private metaRow(note: Partial<Note>): HTMLElement {
    const row = el("div", "note-meta");
    const status = note.status ?? "pending";
    const pill = el("button", `note-pill ${status}`, STATUS_LABEL[status]);
    pill.title = tr("点一下改状态：待处理 → 已处理 → 已忽略");
    pill.onclick = () => this.cycleStatus();
    row.append(pill);

    const issue = el("input", "ns-input note-meta-input") as HTMLInputElement;
    issue.placeholder = "issue #";
    issue.value = note.issue ?? "";
    issue.oninput = () => {
      if (!this.editing) return;
      this.editing.note.issue = issue.value;
      this.dirty = true;
    };
    issue.onblur = () => this.pushStatus();
    const commit = el("input", "ns-input note-meta-input") as HTMLInputElement;
    commit.placeholder = "commit";
    commit.value = note.commit ?? "";
    commit.oninput = () => {
      if (!this.editing) return;
      this.editing.note.commit = commit.value;
      this.dirty = true;
    };
    commit.onblur = () => this.pushStatus();
    row.append(issue, commit);

    const session = note.sessionName ?? note.sessionId;
    if (session) row.append(el("span", "note-meta-session", session));
    if (note.updatedAt) row.append(el("span", "note-meta-time", tr("改于 {p1}", { p1: stamp(note.updatedAt) })));
    return row;
  }

  private actionRow(note: Partial<Note>): HTMLElement {
    const row = el("div", "note-actions");
    const save = el("button", "btn primary", tr("保存"));
    save.onclick = () => this.save();
    row.append(save);
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
    row.append(copy, hand);
    if (this.editing?.id) {
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
      };
      row.append(del);
    }
    return row;
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

  // ---------------------------------------------------------------- data

  private load(note: Note | null): void {
    this.sel = note?.id ?? null;
    this.editing = {
      id: note?.id ?? null,
      note: note ? { ...note, shots: [...note.shots] } : { kind: this.kind, status: "pending", mode: "quick", title: "", body: "", issue: "", commit: "" },
    };
    this.paintEditor();
    this.say("");
  }

  /** 编辑器里的完整条目（用于复制 / 交给 agent：草稿也能用，只是没有 id）。 */
  private fullNote(note: Partial<Note>): Note | null {
    const session = this.host.session();
    const now = Date.now();
    const body = note.body ?? "";
    const title = (note.title ?? "").trim() || body.trim().split("\n")[0]?.slice(0, 60) || tr("未命名");
    if (!body.trim() && !title.trim()) {
      this.say(tr("先写点什么"), true);
      return null;
    }
    return {
      id: note.id ?? "draft",
      kind: note.kind ?? this.kind,
      status: note.status ?? "pending",
      mode: note.mode ?? "quick",
      title,
      body,
      shots: [...(note.shots ?? [])],
      sessionId: note.sessionId ?? session?.id ?? null,
      sessionName: note.sessionName ?? session?.name ?? null,
      archivedAt: note.archivedAt ?? null,
      deletedAt: note.deletedAt ?? null,
      issue: note.issue ?? "",
      commit: note.commit ?? "",
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
    if (!(note.body ?? "").trim() && !(note.title ?? "").trim()) {
      this.say(tr("先写点什么再存"), true);
      return;
    }
    const session = this.host.session();
    this.saveTicket = { editing: this.editing };
    this.host.send({
      type: "notes.save",
      ...(this.editing.id ? { id: this.editing.id } : {}),
      kind: note.kind ?? this.kind,
      mode: note.mode ?? "quick",
      title: note.title ?? "",
      body: note.body ?? "",
      issue: note.issue ?? "",
      commit: note.commit ?? "",
      sessionId: note.sessionId ?? session?.id ?? null,
      sessionName: note.sessionName ?? session?.name ?? null,
      archivedAt: note.archivedAt ?? null,
      deletedAt: note.deletedAt ?? null,
    });
    this.say(tr("保存中…"));
  }

  /** 切走之前把改动存掉；草稿不存（用户可能只是点开看看又去别处）。 */
  private flush(): void {
    if (!this.dirty || !this.editing) return;
    if (this.editing.id) this.save();
    else if (this.editing.note.body?.trim() || this.editing.note.title?.trim()) this.save();
  }

  private cycleStatus(): void {
    if (!this.editing) return;
    const note = this.editing.note;
    note.status = NEXT_STATUS[note.status ?? "pending"];
    this.pushStatus();
    this.paintEditor();
  }

  private pushStatus(): void {
    if (!this.editing?.id) return;
    this.host.send({ type: "notes.status", id: this.editing.id, status: this.editing.note.status ?? "pending", issue: this.editing.note.issue ?? "", commit: this.editing.note.commit ?? "" });
    // 状态 / issue / commit 是「立刻落盘」的，不属于等「保存」那一批：别让 dirty 拦住「交给 agent」。
    this.dirty = false;
  }

  private removeShot(path: string): void {
    if (!this.editing?.id) return;
    this.editing.note.shots = (this.editing.note.shots ?? []).filter((s) => s !== path);
    this.host.send({ type: "notes.shot.remove", id: this.editing.id, path });
    this.paintEditor();
  }

  private pasteShots(ev: ClipboardEvent): void {
    const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    ev.preventDefault();
    void this.addFiles(files);
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
    this.dirty = true;
    this.paintEditor();
    this.say(tr("{p1} 张待保存", { p1: this.pendingShots.length }));
  }

  private uploadPending(id: string): void {
    for (const dataUrl of this.pendingShots) this.host.send({ type: "notes.shot", id, dataUrl });
    this.pendingShots = [];
  }

  // ---------------------------------------------------------------- wires from app.ts

  /** 广播（任何人保存了任何东西）→ 列表 / tab 计数。 */
  setNotes(notes: Note[]): void {
    this.paintHead();
    this.paintTabs();
    this.paintList();
    if (!this.sel) return;
    const n = notes.find((x) => x.id === this.sel);
    // 只在「这条不该待在这堆里了」时关编辑器；只是被「显示已处理」过滤掉的不算，不然点个状态就把编辑器关了。
    const gone =
      !n ||
      (n.deletedAt ? this.view !== "trash" : n.archivedAt ? this.view !== "archived" : this.view !== "active");
    if (gone) {
      this.sel = null;
      this.editing = null;
      this.paintEditor();
    }
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
    this.dirty = false;
    this.paintList();
    this.uploadPending(note.id);
    this.say(tr("已保存"));
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
      this.say(tr("这一类里没有可导出的记录"), true);
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
