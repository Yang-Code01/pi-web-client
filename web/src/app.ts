import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api.ts";
import { ChatView, createEl as el } from "./chat.ts";
import { mountDirPicker, type DirPicker } from "./dirpicker.ts";
import { renderMarkdown } from "./md.ts";
import { Socket } from "./ws.ts";
import type { AskAnswer, AskRequest, ApprovalRequest, DeleteReport, GitInfo, Item, ManageState, Me, ModelInfo, PermissionMode, PreviewInfo, SessionState, SkillInfo, TrashItem, TunnelState } from "./types.ts";

type Tab = "sessions" | "chat" | "queue";

/** One place for "what is this session doing right now" — left card, manager row and pin chip all use it. */
type BadgeKind = "ask" | "approve" | "locked" | "run" | "done";

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
 * report a session stuck on the user as busy. Current session keeps its own done() treatment, same
 * as the left pane always did.
 */
function sessionBadge(s: SessionState, currentId: string | null): SessionBadge | null {
  if (s.asks && s.asks > 0) {
    return {
      kind: "ask",
      text: s.asks > 1 ? `待回答 ${s.asks}` : "待回答",
      cls: "wait",
      title: "在等你回答问卷，这个会话停在这儿了",
      pending: true,
    };
  }
  if (s.approvals > 0) {
    return {
      kind: "approve",
      text: s.approvals > 1 ? `待确认 ${s.approvals}` : "待确认",
      cls: "wait",
      title: "在等你确认这条命令",
      pending: true,
    };
  }
  if (s.locked) {
    return { kind: "locked", text: "终端占用", cls: "lock", title: "pi CLI 在终端里正用着这个会话，网页这边只能看", pending: false };
  }
  if (s.running) return { kind: "run", text: "运行中", cls: "run", title: "agent 正在推进", pending: false };
  if (s.done && s.id !== currentId) return { kind: "done", text: "完成", cls: "done", title: "", pending: false };
  return null;
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
  private models: ModelInfo[] = [];
  private sheet: HTMLElement | null = null;
  private modelChip: HTMLButtonElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  /** Skill palette state (the popover above the composer). */
  private skills: SkillInfo[] = [];
  private skillsAt = 0;
  private skillPop: HTMLElement | null = null;
  private skillQuery = "";
  private skillSel = 0;
  /** Desktop only: hide the session column / the queue column to give the chat more room. */
  private collapsed: { sessions: boolean; queue: boolean } = {
    sessions: readFlag("pi.collapse.sessions"),
    queue: readFlag("pi.collapse.queue"),
  };
  /** Appearance prefs (scale / accent / text lightness), persisted in localStorage. */
  private prefs: Prefs = readPrefs();
  private sheetKind: "model" | "display" | "new" | "manage" | "keys" | null = null;
  /** The new-session dialog stays up until the bridge answers with the started session (or an error). */
  private creating: { finish: (error?: string) => void } | null = null;
  private mkdirWaits = new Map<string, (res: { path?: string; error?: string }) => void>();
  /** Session whose claim is in flight: spawning pi takes a few seconds. */
  private claiming: string | null = null;
  private usage: { contextTokens: number | null; contextWindow: number | null } = { contextTokens: null, contextWindow: null };
  /** Context budget chosen in the model sheet (bridge enforces it); null = window size. */
  private budget: number | null = null;
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
  private keys: Record<string, string> = loadKeys();
  /** action id whose row is waiting for the next key press. */
  private capturing: string | null = null;
  /** The one shell panel (Q-007); the bridge owns the process, this is just the view. */
  private term: { id: string; term: Terminal; fit: FitAddon; dock: HTMLElement } | null = null;
  /** Outcome of the last delete, shown above the manager's footer (the transcript is behind the sheet). */
  private mgrNote = "";
  /** Tool calls seen in the current turn, for the activity popover. */
  private stepCount = 0;
  /** Q-022: which pin chip to focus once the strip repaints (the unpinned one is gone). */
  private pinFocus: number | null = null;
  /** Q-021: branch of the repo holding the session cwd; `gitCwd` keeps a stale answer off the line. */
  private git: GitInfo | null = null;
  private gitCwd = "";
  private mgrRefresh: (() => void) | null = null;
  private mgrPainting = false;
  private viewer: Viewer | null = null;
  private cardDelArm: { id: string; at: number } | null = null;
  private dragId: string | null = null;

  constructor(me: Me) {
    this.me = me;
    this.tunnel = me.tunnel;
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
    const title = el("div", "title", "pi");
    const sub = el("div", "sub", "");
    const collapseRight = el("button", "icon-btn side-toggle");
    collapseRight.dataset.side = "right";
    collapseRight.dataset.act = "queue";
    collapseRight.onclick = () => this.togglePane("queue");
    const look = el("button", "icon-btn icon-text", "Aa");
    look.title = "字号与颜色";
    look.dataset.act = "look";
    look.onclick = () => this.openDisplaySheet();
    const files = el("button", "icon-btn wide", "📂 产物");
    files.title = "本会话写过的文件（md / html / 图片…点开预览）";
    files.dataset.act = "artifacts";
    files.onclick = () => this.openArtifactsSheet();
    files.hidden = true;
    const fs = el("button", "icon-btn wide", "📁 文件管理器");
    fs.title = "文件资源管理器：浏览这台电脑的盘符与目录，打开或直接编辑文本文件";
    fs.dataset.act = "files";
    fs.onclick = () => this.openFiles();
    fs.hidden = true;
    this.els.fs = fs;
    topbar.append(collapseLeft, dot, title, sub, files, fs, look, collapseRight);
    const main = el("div", "main");

    const sessionsPane = el("section", "pane");
    const sessionsInner = el("div", "session-list");
    const create = el("div", "new-session");
    const newBtn = el("button", "btn primary", "开新会话");
    newBtn.dataset.act = "new";
    newBtn.onclick = () => this.openNewSessionSheet();
    create.append(newBtn);
    // The filter must not lose focus on every keystroke, so it lives outside the repainted list.
    const manageBar = el("div", "manage-bar");
    const sessFilter = el("input", "session-filter");
    sessFilter.placeholder = "过滤名字 / 目录";
    sessFilter.oninput = () => {
      this.filter = sessFilter.value.trim();
      this.renderSessions();
    };
    const manageBtn = el("button", "tool-btn", "管理");
    manageBtn.dataset.act = "manage";
    manageBtn.title = "管理全部会话：检索、筛选、排序、分组、批量操作";
    manageBtn.onclick = () => this.openManager();
    manageBar.append(sessFilter, manageBtn);
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
    gripL.title = "拖动调整会话列表宽度 · 双击复位";
    const gripR = el("div", "col-grip grip-r");
    gripR.title = "拖动调整右栏宽度 · 双击复位";

    main.append(sessionsPane, chatPane, queuePane, gripL, gripR);

    // Collapsing the left column takes the pinned sessions with it. This strip keeps them in reach.
    const pinStrip = el("div", "pin-strip");
    pinStrip.hidden = true;

    const tabs = el("nav", "tabs");
    const tabDefs: [Tab, string][] = [
      ["sessions", "会话"],
      ["chat", "对话"],
      ["queue", "需要你"],
    ];
    for (const [key, label] of tabDefs) {
      const btn = el("button", "", label);
      btn.dataset.tab = key;
      btn.onclick = () => this.go(key);
      tabs.append(btn);
    }

    shell.append(topbar, pinStrip, main, tabs);
    app.append(shell);

    Object.assign(this.els, { topbar, pinStrip, collapseLeft, collapseRight, look, files, fs, dot, title, sub, main, sessionsPane, sessionsInner, manageBar, sessFilter, manageBtn, sessList, chatPane, scroll, composerHost, queuePane, queueInner, tabs });
    this.chat = new ChatView(scroll);
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

  /**
   * Q-026: the terminal dock's height. A row grip behaves like the column one: drag writes the
   * height straight onto the dock (so xterm refits through its ResizeObserver), release remembers
   * it, double-click forgets it and returns to the CSS default.
   */
  private wireTermGrip(grip: HTMLElement, dock: HTMLElement): void {
    const clamp = (h: number) => Math.round(Math.max(140, Math.min(window.innerHeight - 240, h)));
    const saved = Number(localStorage.getItem("pi.termH"));
    if (Number.isFinite(saved) && saved >= 140) dock.style.height = `${clamp(saved)}px`;
    grip.onpointerdown = (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      // Anchor on the dock's bottom edge: the drag moves the top edge, the shell keeps its bottom.
      const bottom = dock.getBoundingClientRect().bottom;
      grip.setPointerCapture(ev.pointerId);
      grip.classList.add("dragging");
      document.body.classList.add("row-resizing");
      const move = (e: PointerEvent) => {
        dock.style.height = `${clamp(bottom - e.clientY)}px`;
      };
      const done = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
        grip.removeEventListener("pointercancel", done);
        grip.classList.remove("dragging");
        document.body.classList.remove("row-resizing");
        const h = parseInt(dock.style.height, 10);
        if (Number.isFinite(h) && h > 0) {
          try {
            localStorage.setItem("pi.termH", String(h));
          } catch {
            // the size still holds for this visit
          }
        }
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      grip.addEventListener("pointercancel", done);
    };
    grip.ondblclick = () => {
      dock.style.removeProperty("height");
      try {
        localStorage.removeItem("pi.termH");
      } catch {
        // nothing to forget
      }
    };
  }

  private togglePane(side: "sessions" | "queue"): void {
    this.collapsed[side] = !this.collapsed[side];
    writeFlag(`pi.collapse.${side}`, this.collapsed[side]);
    this.renderPanes();
    this.renderTop();
  }

  private leftText(deadline: number): string {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (left === 0) return "已超时，正在拒绝…";
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后自动拒绝`;
  }

  /** One timer for every visible deadline chip; renderApprovals only creates them. */
  private startClock(): void {
    setInterval(() => {
      for (const node of document.querySelectorAll<HTMLElement>(".approval .hint[data-deadline]")) {
        node.textContent = this.leftText(Number(node.dataset.deadline));
      }
      if (this.session?.running) this.fillHintStatus();
    }, 1000);
  }

  private wire(): void {
    // Q-021: 从别的窗口（或终端）切回来时，用户可能刚在里面切过分支。
    window.addEventListener("focus", () => void this.refreshGit(true));
    this.socket.on((msg) => this.onMessage(msg));
    this.socket.onStatus((s) => {
      this.connected = s === "open";
      this.renderTop();
      this.renderSessions();
      // A shell outlives the page: re-attach and replay what it printed while we were away.
      const saved = sessionStorage.getItem("pi.termId");
      if (this.connected && saved && !this.term) this.socket.send({ type: "term.attach", id: saved });
    });

    window.addEventListener("hashchange", () => this.routeFromHash());
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
        this.warn(`浏览器拖拽拿不到「${others.map((f) => f.name).join("、")}」的完整路径。请在资源管理器里复制它再 ${PASTE_KEY}，或用「文件」按钮选`);
      }
    });
    if (window.matchMedia("(min-width: 900px)").matches) this.tab = "sessions";
    // 跨过 900px 断点以前没人管：`renderPanes` 只在点按钮时跑，窗口一拖就停在旧状态 —— 收起状态的左栏
    // 在窄屏仍然是 hidden，反过来也一样。一帧一次的重排顺手把输入框下面那行工作目录对齐（D61）。
    let paneFrame = 0;
    window.addEventListener("resize", () => {
      if (paneFrame) return;
      paneFrame = requestAnimationFrame(() => {
        paneFrame = 0;
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
    if (this.session?.done) this.session.done = false;
    this.approvals = [];
    this.asks = [];
    this.usage = { contextTokens: null, contextWindow: null };
    this.rate = 0;
    this.rateAt = 0;
    this.turnAt = null;
    this.turnChars = { cjk: 0, other: 0 };
    this.activity = "";
    this.runSince = null;
    this.socket.send({ type: "subscribe", sessionId: id });
    this.renderAll();
  }

  // ---------------------------------------------------------------- ws
  private onMessage(msg: any): void {
    switch (msg.type) {
      case "catalog":
        this.models = (msg.models ?? []) as ModelInfo[];
        // The sheet may have opened before the catalog landed; show the list now.
        if (this.sheetKind === "model") this.openModelSheet();
        this.fillModelChip();
        break;
      case "skills":
        this.skills = (msg.commands ?? []) as SkillInfo[];
        this.skillsAt = Date.now();
        if (this.skillPop) this.renderSkillList();
        break;
      case "hello":
        // A new socket starts unverified on the bridge side.
        this.stepUntil = 0;
        this.sessions = msg.sessions ?? [];
        if (Array.isArray(msg.trash)) this.trash = msg.trash as TrashItem[];
        if (msg.manage) this.manage = msg.manage as ManageState;
        if (this.currentId && !this.session) this.session = this.sessions.find((x) => x.id === this.currentId) ?? null;
        this.tunnel = msg.tunnel ?? this.tunnel;
        this.renderAll();
        // Q-021: 新会话 / 首屏恢复都可能带着另一个 cwd 进来。
        void this.refreshGit(true);
        if (this.currentId) this.socket.send({ type: "subscribe", sessionId: this.currentId });
        break;
      case "session":
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
        this.chat.reset((msg.items ?? []) as Item[]);
        this.approvals = (msg.approvals ?? []) as ApprovalRequest[];
        this.asks = (msg.asks ?? []) as AskRequest[];
        this.renderAll();
        // Q-021: 切会话＝换 cwd，分支要跟着换。
        void this.refreshGit(true);
        // A takeover from the model sheet unlocks it; reopen so the list is usable right away.
        if (this.sheetKind === "model" && this.session?.owned) this.openModelSheet();
        break;
      case "items":
        if (msg.sessionId !== this.currentId) break;
        this.chat.reset((msg.items ?? []) as Item[]);
        break;
      case "item.add":
        if (msg.sessionId !== this.currentId) break;
        this.chat.add(msg.item as Item);
        break;
      case "item.replace":
        if (msg.sessionId !== this.currentId) break;
        this.chat.replace(msg.id, msg.item as Item);
        break;
      case "delta":
        if (msg.sessionId !== this.currentId) break;
        this.trackChars(msg.field, msg.text);
        this.chat.delta(msg.id, msg.field, msg.text);
        this.setActivity(msg.field === "thinking" ? "思考中" : "正在写回复");
        break;
      case "usage":
        if (msg.sessionId !== this.currentId) break;
        this.settleRate(msg.usage);
        break;
      case "stats":
        if (msg.sessionId !== this.currentId) break;
        if (typeof msg.budget === "number" || msg.budget === null) this.budget = msg.budget ?? null;
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
          this.setActivity(`正在执行 ${msg.name ?? "工具"}`);
        } else if (msg.phase === "end") this.setActivity("思考中");
        break;
      case "approval.add":
        if (msg.sessionId === this.currentId) this.approvals = [...this.approvals, msg.approval];
        else this.notifyUnread(msg.sessionId);
        this.renderApprovals();
        this.renderQueue();
        this.renderTabs();
        this.fillHintStatus();
        break;
      case "approval.remove":
        this.approvals = this.approvals.filter((a) => a.id !== msg.id);
        // notifyUnread() bumped this counter when the approval arrived for another session; undo it
        // here, otherwise a session reads as "等你批准" forever and the manager keeps it undeletable.
        if (msg.sessionId !== this.currentId) {
          const owner = this.sessions.find((x) => x.id === msg.sessionId);
          if (owner && owner.approvals > 0) owner.approvals -= 1;
        }
        this.fillHintStatus();
        this.renderApprovals();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      case "ask.add": {
        const ask = msg.ask as AskRequest;
        if (!ask) break;
        if (msg.sessionId !== this.currentId) {
          this.notifyUnread(msg.sessionId);
          break;
        }
        this.asks = [...this.asks.filter((a) => a.id !== ask.id), ask];
        this.askFolded = false;
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      }
      case "ask.remove": {
        // The bridge tells us why an ask disappeared. Dropping the id silently is how answers used
        // to vanish: the panel closed, the drafts died with it, and nothing on screen said so.
        const gone = this.asks.find((a) => a.id === msg.id);
        const mine = msg.sessionId === this.currentId;
        this.asks = this.asks.filter((a) => a.id !== msg.id);
        if (gone && mine && gone.id !== this.lastAnsweredAsk) this.keepLostAsk(gone, String(msg.reason ?? "问卷已关闭"));
        if (gone && mine) this.lastAnsweredAsk = null;
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      }
      case "pi.status":
        if (this.session && this.session.id === msg.sessionId) this.session = { ...this.session, running: msg.running };
        if (msg.sessionId === this.currentId) {
          if (msg.running) {
            this.runSince = Date.now();
            this.activity = "思考中";
            // Q-024: the hover card says "本轮第 N 次工具调用", so N is per run and starts over here.
            this.stepCount = 0;
          } else this.activity = "";
          this.fillHintStatus();
          if (this.textarea && !this.asks.length) this.textarea.placeholder = msg.running ? "跑着呢，再发会自动排队…" : "说点什么…";
        }
        if (!msg.running) this.turnAt = null;
        this.renderTop();
        this.renderSessions();
        this.fillModelChip();
        break;
      case "manage":
        if (msg.manage) this.manage = msg.manage as ManageState;
        this.renderSessions();
        break;
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
        if (removed.length) parts.push(`已移入垃圾箱 ${removed.length} 个`);
        if (skipped.length) {
          const names = skipped.slice(0, 3).map((s: DeleteReport["skipped"][number]) => `${s.name}（${s.reason}）`).join("、");
          parts.push(`${skipped.length} 个没删：${names}${skipped.length > 3 ? " 等" : ""}`);
        }
        this.mgrNote = parts.join(" · ");
        this.mgrRefresh?.();
        break;
      }
      case "trash": {
        this.trash = Array.isArray(msg.items) ? (msg.items as TrashItem[]) : this.trash;
        this.mgrRefresh?.();
        break;
      }
      case "restore.result": {
        const restored: string[] = Array.isArray(msg.restored) ? msg.restored.map(String) : [];
        const skipped: { id: string; reason: string }[] = Array.isArray(msg.skipped) ? msg.skipped : [];
        const parts: string[] = [];
        if (restored.length) parts.push(`已还原 ${restored.length} 个`);
        if (skipped.length) parts.push(`${skipped.length} 个没还原：${skipped.slice(0, 3).map((s) => s.reason).join("、")}`);
        this.mgrNote = parts.join(" · ");
        this.mgrRefresh?.();
        break;
      }
      case "purge.result": {
        const purged: string[] = Array.isArray(msg.purged) ? msg.purged.map(String) : [];
        this.mgrNote = purged.length ? `已彻底删除 ${purged.length} 个` : "垃圾箱里没有可删除的东西";
        this.mgrRefresh?.();
        break;
      }
      case "sessions.list": {
        this.sessions = Array.isArray(msg.sessions) ? msg.sessions : this.sessions;
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
          this.creating.finish(String(msg.text ?? "启动失败"));
          break;
        }
        if (this.claiming && msg.level === "error" && (!msg.sessionId || msg.sessionId === this.claiming)) this.endClaim();
        if (!msg.sessionId || msg.sessionId === this.currentId) this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text: msg.text, level: msg.level ?? "info" });
        break;
      case "term.opened": {
        this.mountTerminal(String(msg.id ?? ""), String(msg.shell ?? "shell"), String(msg.cwd ?? ""));
        break;
      }
      case "term.replay": {
        const id = String(msg.id ?? "");
        if (!this.term) this.mountTerminal(id, String(msg.shell ?? "shell"), String(msg.cwd ?? ""));
        if (this.term?.id === id) this.term.term.write(String(msg.data ?? ""));
        break;
      }
      case "term.data": {
        const id = String(msg.id ?? "");
        if (this.term?.id === id) this.term.term.write(String(msg.data ?? ""));
        break;
      }
      case "term.exit": {
        const id = String(msg.id ?? "");
        if (this.term?.id === id) this.term.term.write(`\r\n[进程已退出，exit ${Number(msg.code ?? 0)}]\r\n`);
        break;
      }
      case "term.gone": {
        if (this.term?.id === String(msg.id ?? "")) this.closeTerminal();
        break;
      }
      case "term.error": {
        sessionStorage.removeItem("pi.termId");
        this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: String(msg.message ?? "终端启动失败"), level: "error" });
        break;
      }
      case "need-stepup":
        // Our window and the bridge's disagreed (e.g. after a reconnect): that write was dropped.
        this.stepUntil = 0;
        this.stepResync = true;
        this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text: "口令验证已过期，刚才的操作没有执行，验证后请重做一次", level: "warn" });
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
      case "mkdir.result": {
        const done = this.mkdirWaits.get(String(msg.reqId ?? ""));
        this.mkdirWaits.delete(String(msg.reqId ?? ""));
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
      if (prev?.owned !== state.owned || prev?.origin !== state.origin) this.renderChat();
      else this.fillHintStatus();
    }
    this.renderTop();
    this.renderSessions();
  }

  private notifyUnread(sessionId: string): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.approvals = (s.approvals ?? 0) + 1;
  }

  // ---------------------------------------------------------------- step-up
  private askStepUp(): void {
    if (document.querySelector(".modal")) return;
    const modal = el("div", "modal");
    const form = el("form");
    const h = el("h2", "", "再验一次口令");
    h.style.margin = "0";
    h.style.fontSize = "16px";
    const p = el("p", "", "公网访问下，写入和批准前要重新验一次口令（10 分钟内免重复）。");
    p.style.color = "var(--faint)";
    p.style.fontSize = "13px";
    p.style.margin = "0";
    const input = el("input");
    input.type = "password";
    input.autocomplete = "current-password";
    input.placeholder = "口令";
    const err = el("div", "err");
    const submit = el("button", "btn primary", "继续");
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
  private sendPrompt(): void {
    if (!this.currentId) return;
    const typed = this.composerText.trim();
    const pasted = this.pastes.map((p) => p.text.trim()).filter(Boolean);
    const text = [...pasted, typed].filter(Boolean).join("\n\n");
    if (!text && !this.images.length) return;
    if (typed && !pasted.length && !this.images.length && this.answerFromComposer(typed)) return;
    const payload = { type: "prompt", sessionId: this.currentId, text, images: this.images };
    // Clear the composer only once the message really goes out: a dismissed step-up keeps the draft.
    this.act(() => {
      // The step-up modal may have sat in between: only clear the composer if we are still there.
      if (this.currentId === payload.sessionId) {
        this.composerText = "";
        this.images = [];
        this.pastes = [];
        this.chat.add({ id: `local:${Date.now()}`, kind: "user", text: text || "（图片）", images: [] });
        this.renderChat();
      }
      if (payload.sessionId) this.drafts.delete(payload.sessionId);
      this.persistDrafts();
      this.socket.send(payload);
    });
    if (navigator.storage?.persist) void navigator.storage.persist();
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
      alert("这个浏览器/地址不支持 Web Push（iOS 需要先「添加到主屏幕」）");
      return;
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    if (!this.me.pushKey) {
      alert("服务端没给 push 公钥");
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
    alert("已开启：需要你的时候会推到这个设备");
  }

  /** Overlays live inside #app so they scale with the appearance zoom. */
  private overlay(node: HTMLElement): void {
    (document.getElementById("app") ?? document.body).append(node);
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
    const label = git.branch || (git.empty ? "(无提交)" : "(未知)");
    const chip = el("button", flat ? "git-chip flat" : "git-chip") as HTMLButtonElement;
    chip.type = "button";
    chip.dataset.act = "git";
    chip.dataset.key = this.gitKey(git);
    chip.append(el("span", "git-glyph", "⎇"), el("span", "git-branch", label));
    if (git.dirty) chip.append(el("span", "git-dot", ""), el("span", "git-count", String(git.dirty)));
    if (git.detached) chip.append(el("span", "git-tag", "detached"));
    const lines = [`⎇ ${label}${git.dirty ? ` · ${git.dirty} 个未提交改动` : ""}`];
    if (git.detached) lines.push("detached HEAD：不在任何分支上");
    if (git.empty) lines.push("仓库里还没有提交");
    lines.push(git.repo, "", `Enter 发送 · Shift+Enter 换行 · ${PASTE_KEY} 粘贴截图`, "点一下复制分支名");
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
          shown.textContent = "已复制";
          setTimeout(() => {
            if (shown.isConnected && shown.textContent === "已复制") shown.textContent = back;
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
      box.replaceChildren(el("kbd", "", "Enter"), el("span", "", "发送 · Shift+Enter 换行 · "), el("kbd", "", PASTE_KEY), el("span", "", " 粘贴截图"));
      return;
    }
    if (this.runSince == null) this.runSince = Date.now();
    const waiting = this.asks.length ? "等你回答上面的问题" : this.approvals.length ? "等你批准" : "";
    const what = waiting || this.activity || "运行中";
    let spin = box.querySelector<HTMLElement>(".act-spin");
    let text = box.querySelector<HTMLElement>(".act-text");
    let time = box.querySelector<HTMLElement>(".act-time");
    if (!spin || !text || !time) {
      spin = el("span", "act-spin");
      text = el("span", "act-text");
      time = el("span", "act-time");
      const stop = el("button", "btn danger", "中断");
      stop.dataset.act = "interrupt";
      stop.title = "中断当前回复";
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
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}分${String(secs % 60).padStart(2, "0")}秒` : `${secs}秒`;
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
    if (live.name) rows.push(row("工具", [live.name, live.summary].filter(Boolean).join(" · ")));
    const args = oneLine(live.args ?? "", 220);
    if (args) rows.push(row("参数", args, "args"));
    const output = tailText(live.output ?? "", 6, 420);
    if (output) rows.push(row("输出", output, "out"));
    const thinking = tailText(live.thinking ?? "", 3, 240);
    if (thinking) rows.push(row("思考", thinking, "think"));
    rows.push(el("div", "act-pop-meta", `已运行 ${dur}${this.stepCount > 1 ? ` · 本轮第 ${this.stepCount} 次工具调用` : ""}`));
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
    const accent = ACCENTS[this.prefs.accent] ?? ACCENTS[DEFAULT_PREFS.accent];
    root.setProperty("--accent", accent.accent);
    root.setProperty("--accent-dim", accent.dim);
    const text = TEXTS[this.prefs.text] ?? TEXTS.normal;
    root.setProperty("--text", text.text);
    root.setProperty("--dim", text.dim);
    root.setProperty("--faint", text.faint);
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
    head.append(el("div", "sheet-title", "字号与颜色"));
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);

    const sizeBox = el("div", "levels");
    sizeBox.append(el("div", "levels-label", "字号"));
    const sizeChips = el("div", "chips");
    for (const [scale, label] of SIZES) {
      const chip = el("button", `chip${Math.abs(this.prefs.scale - scale) < 0.005 ? " on" : ""}`, label);
      chip.onclick = () => {
        this.prefs = { ...this.prefs, scale };
        savePrefs(this.prefs);
        this.applyPrefs();
        for (const other of sizeChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
      };
      sizeChips.append(chip);
    }
    sizeBox.append(sizeChips);
    sheet.append(sizeBox);

    const colorBox = el("div", "levels");
    colorBox.append(el("div", "levels-label", "颜色"));
    const swatches = el("div", "swatches");
    for (const name of Object.keys(ACCENTS)) {
      const sw = el("button", `swatch${this.prefs.accent === name ? " on" : ""}`);
      sw.style.setProperty("--sw", ACCENTS[name].accent);
      sw.title = name;
      sw.setAttribute("aria-label", name);
      sw.onclick = () => {
        this.prefs = { ...this.prefs, accent: name };
        savePrefs(this.prefs);
        this.applyPrefs();
        for (const other of swatches.querySelectorAll(".swatch")) other.classList.toggle("on", other === sw);
      };
      swatches.append(sw);
    }
    colorBox.append(swatches);
    sheet.append(colorBox);

    const textBox = el("div", "levels");
    textBox.append(el("div", "levels-label", "文字亮度"));
    const textChips = el("div", "chips");
    for (const [key, label] of TEXT_STEPS) {
      const chip = el("button", `chip${this.prefs.text === key ? " on" : ""}`, label);
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

    const foot = el("div", "sheet-foot");
    const reset = el("button", "btn ghost", "恢复默认");
    reset.onclick = () => {
      this.prefs = { ...DEFAULT_PREFS };
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

  // ---------------------------------------------------------------- model sheet
  private closeSheet(): void {
    // Dismissing the question drawer must not make it pop open again on the next subscribe.
    this.sheet?.remove();
    this.sheet = null;
    this.sheetKind = null;
    this.mgrRefresh = null;
    this.imageSheetPaint = null;
  }

  private openModelSheet(): void {
    if (!this.currentId) return;
    this.closeSheet();
    this.sheetKind = "model";
    const back = el("div", "sheet-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };

    const sheet = el("div", "sheet model-sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", "模型与思考"));
    const close = el("button", "btn ghost", "关闭");
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
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = () => this.closeSheet();
    const confirm = el("button", "btn primary", "确认") as HTMLButtonElement;
    foot.append(footHint, cancel, confirm);
    const refreshFoot = (): void => {
      const changes: string[] = [];
      if (draftModel !== startModel) changes.push(`模型 → ${shortModelName(this.models.find((m) => m.id === draftModel)?.name ?? draftModel ?? "")}`);
      if (draftLevel !== startLevel) changes.push(`思考 → ${draftLevel}`);
      if (draftBudget !== startBudget) changes.push(`预算 → ${draftBudget ? compactSize(draftBudget) : "不设"}`);
      confirm.disabled = !changes.length;
      footHint.textContent = changes.length ? changes.join("，") : "未改动";
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
    budgetBox.append(el("div", "levels-label", "上下文预算"));
    const budgetChips = el("div", "chips");
    for (const value of BUDGETS) {
      const on = (value ?? null) === startBudget;
      const chip = el("button", `chip${on ? " on" : ""}`, value ? compactSize(value) : "不设");
      chip.onclick = () => {
        draftBudget = value ?? null;
        for (const other of budgetChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        refreshFoot();
      };
      budgetChips.append(chip);
    }
    budgetBox.append(budgetChips);
    budgetBox.append(el("div", "budget-hint", "用量超过预算时，这轮结束后自动压缩一次。"));
    sheet.append(budgetBox);

    // Switching only works on a session this bridge owns; a terminal-owned one has no rpc child.
    if (this.session && !this.session.owned) {
      const notice = el("div", "takeover warn", "这个会话现在没有写入权，切不了模型。接管之后就正常了——终端里如果有 pi 在写同一个文件，先退出那边。");
      notice.append(this.claimButton());
      sheet.append(notice, foot);
      refreshFoot();
      back.append(sheet);
      this.overlay(back);
      this.sheet = back;
      return;
    }

    if (!this.models.length) {
      const empty = el("div", "empty", "模型列表还没加载好，稍等一下，或者点这里重试。");
      empty.onclick = () => this.socket.send({ type: "models" });
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
      if (m.id === startModel) nameEl.append(el("span", "m-cur", "当前"));
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

    levelsBox.append(el("div", "levels-label", "思考档位"), chips);
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
    search.placeholder = "搜索技能：名字或描述…";
    search.spellcheck = false;
    const list = el("div", "skill-list");
    const foot = el("div", "skill-foot", "1–9 直接选 · ↑↓ 选 · Enter 确认 · Esc 关闭");
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
  }

  private filteredSkills(): SkillInfo[] {
    const query = this.skillQuery.trim().toLowerCase();
    if (!query) return this.skills.slice(0, 6);
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
      .sort((a, b) => b.score - a.score || b.skill.uses - a.skill.uses || a.skill.name.localeCompare(b.skill.name))
      .slice(0, 12)
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
      list.append(el("div", "skill-empty", "技能列表还没到，稍等一下…"));
      return;
    }
    if (!items.length) {
      list.append(el("div", "skill-empty", `没有匹配「${this.skillQuery}」的技能`));
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

  /** Drop `/skill:<name> ` where the caret is and count the pick as usage. */
  private pickSkill(skill: SkillInfo): void {
    skill.uses += 1;
    if (this.currentId) this.socket.send({ type: "skillUsed", sessionId: this.currentId, name: skill.name });
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

  private createSession(cwd: string, name: string, onSent: () => void, pin = false): void {
    localStorage.setItem("pi.lastCwd", cwd);
    const recent = this.recentCwds().filter((c) => c !== cwd);
    localStorage.setItem("pi.recentCwds", JSON.stringify([cwd, ...recent].slice(0, 12)));
    this.act(() => {
      onSent();
      this.socket.send({ type: "create", cwd, ...(name ? { name } : {}), ...(pin ? { pin: true } : {}) });
    });
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
    head.append(el("div", "sheet-title", "开新会话"));
    const close = el("button", "btn ghost", "取消");
    close.onclick = () => this.closeSheet();
    head.append(close);

    const nameField = el("input", "ns-input") as HTMLInputElement;
    nameField.placeholder = "可留空：发第一条消息后自动用它取名";
    nameField.maxLength = 120;
    const cwdField = el("input", "ns-input mono") as HTMLInputElement;
    cwdField.placeholder = "例如 E:\\yqm\\pi-web-client";
    cwdField.value = this.defaultCwd();
    cwdField.setAttribute("list", "pi-recent-cwds");
    const browseBtn = el("button", "btn ghost", "📁 浏览");
    const cwdRow = el("div", "ns-row");
    cwdRow.append(cwdField, browseBtn);

    const browser = el("div", "ns-browser");
    browser.hidden = true;
    const mkBtn = el("button", "btn ghost dir-mk", "＋ 新建文件夹") as HTMLButtonElement;
    mkBtn.title = "在当前目录下新建一个文件夹";
    const mkRow = el("div", "dir-mkrow");
    mkRow.hidden = true;
    const mkInput = el("input", "ns-input mono") as HTMLInputElement;
    mkInput.placeholder = "新文件夹名";
    mkInput.maxLength = 255;
    const mkOk = el("button", "btn primary", "创建") as HTMLButtonElement;
    const mkCancel = el("button", "btn ghost", "取消") as HTMLButtonElement;
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
    status.append(el("span", "act-spin"), el("span", "", "正在启动会话…（拉起 pi 进程，通常要几秒）"));
    const foot = el("div", "dir-foot");
    const ok = el("button", "btn primary", "创建");
    foot.append(ok);

    sheet.append(
      head,
      el("label", "ns-label", "会话名称"),
      nameField,
      el("label", "ns-label", "工作目录"),
      cwdRow,
      this.recentCwdOptions(),
      browser,
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
      browseBtn.textContent = browser.hidden ? "📁 浏览" : "收起";
      if (!browser.hidden) void picker?.go(cwdField.value.trim());
    };
    let mkBusy = false;
    const setMkBusy = (busy: boolean): void => {
      mkBusy = busy;
      mkInput.disabled = busy;
      mkOk.disabled = busy;
      mkOk.textContent = busy ? "创建中…" : "创建";
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
        mkErr.textContent = "文件夹名里不能有 / 或 \\（一次只建一层）";
        return;
      }
      this.act(() => {
        const reqId = `mk:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        setMkBusy(true);
        mkErr.textContent = "";
        const timer = setTimeout(() => {
          if (!this.mkdirWaits.delete(reqId)) return;
          setMkBusy(false);
          mkErr.textContent = "服务端没有响应，稍后再试";
        }, 15000);
        this.mkdirWaits.set(reqId, (res) => {
          clearTimeout(timer);
          if (this.sheet !== back) return;
          setMkBusy(false);
          if (res.error || !res.path) {
            mkErr.textContent = res.error ?? "创建失败";
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
      ok.textContent = busy ? "启动中…" : "创建";
    };
    const submit = (): void => {
      if (this.creating) return;
      const cwd = cwdField.value.trim();
      if (!cwd) {
        err.textContent = "先选一个工作目录";
        cwdField.focus();
        return;
      }
      err.textContent = "";
      this.createSession(cwd, nameField.value.trim(), () => {
        setBusy(true);
        const timer = setTimeout(() => this.creating?.finish("等了 60 秒还没启动起来，看看服务端日志"), 60000);
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
      }, autoPin);
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
    if (this.me.public) bits.push("公网");
    if (this.tunnel.status === "up" && this.tunnel.url) bits.push(this.tunnel.url.replace("https://", ""));
    else if (this.tunnel.status === "starting") bits.push("隧道启动中…");
    else if (this.tunnel.status === "error") bits.push("隧道异常");

    if (!this.connected) bits.push("离线");
    sub.textContent = bits.join(" · ");

    setToggle(collapseLeft, this.collapsed.sessions, "会话列表");
    setToggle(collapseRight, this.collapsed.queue, "待办队列");
    collapseRight.classList.toggle("alert", this.collapsed.queue && (this.approvals.length > 0 || this.asks.length > 0));
    this.fillModelChip();
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
    model.textContent = name || "模型";

    const thinking = this.session?.thinkingLevel ?? "";
    levelEl.textContent = thinking || "–";
    levelEl.classList.toggle("off", !thinking || thinking === "off");

    const win = this.budget ?? this.usage.contextWindow ?? this.models.find((m) => m.id === this.session?.model)?.contextWindow ?? null;
    const used = this.usage.contextTokens;
    if (used != null && win) {
      ctx.textContent = `${compactSize(used)}/${compactSize(win)}`;
      ctx.classList.toggle("hot", used / win >= (this.budget ? 0.9 : 0.8));
      ctx.title = this.budget ? `上下文预算 ${compactSize(this.budget)}：超了就自动压缩` : "";
    } else if (win) {
      ctx.textContent = `–/${compactSize(win)}`;
      ctx.classList.remove("hot");
    } else {
      ctx.textContent = used != null ? compactSize(used) : "–";
      ctx.classList.remove("hot");
    }

    rateEl.textContent = this.rate >= 1 ? `${Math.round(this.rate)} tok/s` : "– tok/s";
    rateEl.classList.toggle("live", this.turnAt != null);

    chip.title = [this.session?.modelName ?? this.session?.model ?? "模型", ctx.textContent, rateEl.textContent, thinking ? `思考 ${thinking}` : "思考 –"]
      .filter(Boolean)
      .join(" · ");
  }

  /** Pinned / plain / archived sections. Every drag and every star click ends up in one arrange message. */
  private renderSessions(): void {
    this.renderPinStrip();
    const host = this.els.sessList;
    // A re-render mid-edit must not eat the caret: remember where it was before the DOM swap.
    const active = document.activeElement as HTMLElement | null;
    const typing = this.renameId != null && active?.classList.contains("rename-input") === true;
    this.renameCaret = typing ? (active as HTMLInputElement).selectionStart : null;
    host.replaceChildren();

    const ordered = [...this.sessions].sort((a, b) => this.arrangeCompare(a, b));
    if (this.renameId && !ordered.some((s) => s.id === this.renameId)) this.renameId = null;
    // A deleted or now-hidden session must not stay "picked".

    const visible = ordered.filter((s) => !this.manage.archived.includes(s.id) && this.matchesFilter(s));
    const archived = ordered.filter((s) => this.manage.archived.includes(s.id) && this.matchesFilter(s));
    const pinned = visible.filter((s) => this.manage.pin.includes(s.id));
    const rest = visible.filter((s) => !this.manage.pin.includes(s.id));
    if (this.sheetKind === "manage") this.mgrRefresh?.();

    if (!ordered.length) {
      host.append(el("div", "empty", "还没有会话。上面开一个，或在终端里 pi 一下。"));
      return;
    }
    if (pinned.length) host.append(this.sessionSection("pin", "置顶", pinned));
    host.append(this.sessionSection("rest", this.manage.pin.length ? "会话" : "会话 · 按创建时间", rest));
    if (!visible.length) host.append(el("div", "empty", this.filter ? "没有匹配的会话。" : "都归档了，展开下面的「已归档」看看。"));
    if (archived.length) host.append(this.sessionSection("archived", "已归档", this.archivedOpen ? archived : []));
    this.renameFocus = false;
  }

  private sessionSection(kind: "pin" | "rest" | "archived", title: string, list: SessionState[]): HTMLElement {
    const sec = el("div", "session-sec");
    sec.dataset.sec = kind;
    const head = el("div", "sess-head");
    if (kind === "archived") {
      const toggle = () => {
        this.archivedOpen = !this.archivedOpen;
        this.renderSessions();
      };
      const chev = el("span", "chev", this.archivedOpen ? "▾" : "▸");
      chev.onclick = toggle;
      const label = el("span", "label", title);
      label.onclick = toggle;
      head.append(chev, label);
    } else {
      head.append(el("span", "label", title));
    }
    head.append(el("span", "n", String(kind === "archived" ? this.archivedTotal() : list.length)));
    sec.append(head);

    const cards = el("div", "session-cards");
    for (const s of list) cards.append(this.sessionCard(s));
    if (kind !== "archived") {
      cards.ondragover = (ev) => {
        if (!this.dragId) return;
        ev.preventDefault();
      };
      cards.ondrop = (ev) => {
        if (!this.dragId) return;
        ev.preventDefault();
        const node = this.dragNode(this.dragId);
        if (node) cards.append(node);
        this.commitArrangement();
        this.dragId = null;
      };
    }
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
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.click();
      }
    };
    if (!this.filter) {
      card.draggable = true;
      card.ondragstart = (ev) => {
        this.dragId = s.id;
        card.classList.add("dragging");
        ev.dataTransfer?.setData("text/plain", s.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      };
      card.ondragend = () => {
        this.dragId = null;
        card.classList.remove("dragging");
        for (const n of this.els.sessList.querySelectorAll(".over-top,.over-bottom")) n.classList.remove("over-top", "over-bottom");
      };
      card.ondragover = (ev) => {
        if (!this.dragId || this.dragId === s.id) return;
        ev.preventDefault();
        ev.stopPropagation();
        const r = card.getBoundingClientRect();
        const after = ev.clientY > r.top + r.height / 2;
        card.classList.toggle("over-top", !after);
        card.classList.toggle("over-bottom", after);
      };
      card.ondragleave = () => card.classList.remove("over-top", "over-bottom");
      card.ondrop = (ev) => {
        if (!this.dragId || this.dragId === s.id) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = this.dragNode(this.dragId);
        if (!from) return;
        card.after(from);
        for (const n of this.els.sessList.querySelectorAll(".over-top,.over-bottom")) n.classList.remove("over-top", "over-bottom");
        this.commitArrangement();
        this.dragId = null;
      };
    }

    const row = el("div", "row");
    const bottomActs = el("span", "card-acts bottom");
    row.append(el("span", "grip", "⣿"));
    const dot = el("span", `dot ${s.running ? "busy" : s.owned ? "live" : ""}`);
    dot.title = s.running ? "运行中" : s.owned ? "网页已接管（pi 进程在本服务里）" : "未接管（只读历史；发消息会自动接管）";
    row.append(dot);
    if (editing) {
      const field = el("input", "rename-input");
      field.value = this.renameDraft;
      field.spellcheck = false;
      field.maxLength = 120;
      field.setAttribute("aria-label", "会话名称");
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
      const src = el("span", `src-tag ${web ? "web" : "cli"}`, web ? "网页" : "CLI");
      src.title = web ? "在网页里新建的会话" : "在终端 pi CLI 里创建的会话";
      row.append(src);
      {
        const acts = el("span", "card-acts");
        const pinned = this.manage.pin.includes(s.id);
        const pin = el("button", `pin-btn${pinned ? " pinned" : ""}`, pinned ? "★" : "☆");
        pin.title = pinned ? "取消置顶" : "置顶";
        pin.setAttribute("aria-label", pin.title);
        pin.onclick = (ev) => {
          ev.stopPropagation();
          this.togglePin(s.id);
        };
        const rename = el("button", "rename-btn", "✎");
        rename.title = "改个名字";
        rename.setAttribute("aria-label", "重命名会话");
        rename.onclick = (ev) => {
          ev.stopPropagation();
          this.startRename(s);
        };
        const archived = this.manage.archived.includes(s.id);
        const archive = el("button", "card-act");
        archive.append(...iconNodes(archived ? ICON_UNARCHIVE : ICON_ARCHIVE));
        archive.title = archived ? "取消归档（放回列表）" : "归档（收进「已归档」，文件不动）";
        archive.setAttribute("aria-label", archive.title);
        archive.onclick = (ev) => {
          ev.stopPropagation();
          this.act(() => this.socket.send({ type: "manage", action: "archive", ids: [s.id], on: !archived }));
        };
        const armed = this.cardDelArm?.id === s.id;
        const busy = App.busy(s);
        const del = el("button", `card-act del${armed ? " armed" : ""}`) as HTMLButtonElement;
        if (armed) del.textContent = "删除?";
        else del.append(...iconNodes(ICON_TRASH));
        del.disabled = busy;
        del.title = busy ? App.busyWhy(s) : armed ? "再点一次：移入垃圾箱" : "删除（先进垃圾箱，可在会话管理里还原）";
        del.setAttribute("aria-label", "删除会话");
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
    const badge = sessionBadge(s, this.currentId);
    if (badge) {
      const chipEl = el("span", `badge ${badge.cls}`, badge.text);
      if (badge.title) chipEl.title = badge.title;
      tail.append(chipEl);
    }
    meta.append(tail);
    card.append(meta);
    return card;
  }

  /** Mirrors bridge/src/manage.ts: pinned by hand, then manual order, then new ones newest first. */
  private arrangeCompare(a: SessionState, b: SessionState): number {
    const aa = this.manage.archived.includes(a.id);
    const ba = this.manage.archived.includes(b.id);
    if (aa !== ba) return aa ? 1 : -1;
    const ap = this.manage.pin.indexOf(a.id);
    const bp = this.manage.pin.indexOf(b.id);
    if (ap >= 0 || bp >= 0) {
      if (ap < 0) return 1;
      if (bp < 0) return -1;
      return ap - bp;
    }
    const ao = this.manage.order.indexOf(a.id);
    const bo = this.manage.order.indexOf(b.id);
    if (ao >= 0 && bo >= 0) return ao - bo;
    if (ao < 0 && bo < 0) return (Date.parse(b.startedAt ?? "") || b.updatedAt) - (Date.parse(a.startedAt ?? "") || a.updatedAt);
    return ao < 0 ? -1 : 1;
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

  /** Read pin/order straight off the DOM after a drop: the DOM is what the user just arranged. */
  private commitArrangement(): void {
    const pin: string[] = [];
    const order: string[] = [];
    for (const sec of this.els.sessList.querySelectorAll<HTMLElement>(".session-sec")) {
      const kind = sec.dataset.sec;
      if (kind === "archived") continue;
      for (const card of sec.querySelectorAll<HTMLElement>(".session-card")) {
        const id = card.dataset.id;
        if (!id) continue;
        if (kind === "pin") pin.push(id);
        else order.push(id);
      }
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
    head.append(el("div", "sheet-title", "本会话的产物"));
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(close);
    const list = el("div", "art-list");
    const items = this.chat.artifacts();
    if (!items.length) list.append(el("div", "empty", "这个会话还没写过文件。AI 回复里提到的路径也可以直接点开预览。"));
    for (const it of items) {
      const row = el("button", "art-row");
      const name = it.path.split(/[\\/]/).filter(Boolean).pop() ?? it.path;
      row.append(el("span", "art-ico", previewIcon(it.path)), el("span", "art-name", name), el("span", "art-tool", it.tool === "write" ? "写入" : "修改"), el("span", "art-path", it.path));
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
    input.placeholder = "输入路径预览（相对会话工作目录，或绝对路径）";
    const go = el("button", "btn", "预览");
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

  private async openPreview(path: string, sessionId: string | null = this.currentId): Promise<void> {
    if (!sessionId) return;
    // 编辑中直接点别的文件：先问一句未保存的改动（D50）。
    const open = this.viewer;
    if (open?.pane === "edit" && open.dirty && open.info?.abs !== path) {
      if (!(await this.leaveEditor(open))) return;
    }
    const v = this.ensureViewer();
    v.sessionId = sessionId;
    v.pane = "preview";
    v.draft = null;
    v.dirty = false;
    v.conflict = null;
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
      v.error = String(err?.message ?? err);
      this.paintViewer();
      return;
    }
    if (this.viewer !== v || v.path !== path) return;
    v.path = v.info.abs;
    await this.loadViewerText();
  }

  /** md / text / html-source need the bytes; html and images load by url. */
  private async loadViewerText(force = false): Promise<void> {
    const v = this.viewer;
    const info = v?.info;
    if (!v || !info) return;
    const needs = info.kind === "markdown" || info.kind === "text" || (info.kind === "html" && v.mode === "source");
    if (needs && v.text == null) {
      if (info.size > 3 * 1024 * 1024 && !force) {
        v.error = `文件有 ${(info.size / 1024 / 1024).toFixed(1)} MB，太大了，用「新标签页」打开看。`;
        this.paintViewer();
        return;
      }
      this.paintViewer();
      try {
        const res = await fetch(rawUrl(info));
        if (!res.ok) throw new Error(await res.text());
        v.text = await res.text();
      } catch (err: any) {
        v.error = String(err?.message ?? err);
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
    grip.title = "拖动调整宽度";
    grip.onpointerdown = (ev) => {
      ev.preventDefault();
      grip.setPointerCapture(ev.pointerId);
      root.classList.add("resizing");
      const move = (e: PointerEvent) => {
        const w = Math.max(320, Math.min(window.innerWidth - 120, window.innerWidth - e.clientX));
        root.style.setProperty("--viewer-w", `${w}px`);
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        root.classList.remove("resizing");
        const w = parseInt(root.style.getPropertyValue("--viewer-w"), 10);
        if (w) localStorage.setItem("pi.viewerW", String(w));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
    };
    const head = el("div", "viewer-head");
    const body = el("div", "viewer-body");
    root.append(grip, head, body);
    root.tabIndex = -1;
    root.onkeydown = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.closeViewer();
      }
    };
    this.overlay(root);
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
    v.root.remove();
    this.viewer = null;
  }

  private paintViewer(): void {
    const v = this.viewer;
    if (!v) return;
    const { root, head, body, info } = v;
    root.classList.toggle("full", v.full);
    head.replaceChildren();
    const title = el("div", "viewer-title");
    const browsing = v.pane === "browse";
    const name = info?.name ?? (browsing ? "浏览本机文件" : (v.path.split(/[\\/]/).filter(Boolean).pop() ?? v.path));
    title.append(el("span", "viewer-ico", browsing && !info ? "📁" : previewIcon(name)), el("span", "viewer-name", name));
    const subText = info ? `${info.abs} · ${fmtSize(info.size)}` : browsing ? v.lastDir || this.session?.cwd || "此电脑" : v.path;
    const sub = el("div", "viewer-path", subText);
    sub.title = info?.abs ?? subText;
    const left = el("div", "viewer-titles");
    left.append(title, sub);
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
      ["browse", "浏览"],
      ["preview", "预览"],
      ["edit", "编辑"],
    ] as const) {
      const b = el("button", v.pane === p ? "on" : "", label) as HTMLButtonElement;
      if (p === "edit" && !this.editable(v)) {
        b.disabled = true;
        b.title = !info
          ? "先预览一个文本文件"
          : info.kind === "binary"
            ? "二进制文件改不了"
            : info.size > MAX_EDIT_BYTES
              ? "超过 2 MB，浏览器里改不了"
              : "只有 md / text 能编辑";
      }
      if (p === "preview" && !info) b.disabled = true;
      b.onclick = () => void this.setPane(p);
      panes.append(b);
    }
    tools.append(panes);
    if (info && (info.kind === "markdown" || info.kind === "html") && v.pane === "preview") {
      const seg = el("div", "viewer-seg");
      for (const [m, label] of [["render", "渲染"], ["source", "源码"]] as const) {
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
    tbtn("⟳", "刷新（重新读取文件）", () => void this.openPreview(v.path, v.sessionId));
    if (info) {
      const open = tbtn("↗", "在新标签页打开", () => this.openRawTab(rawUrl(info)));
      open.classList.add("wide-only");
      const copy = tbtn("⧉", "复制路径", () => void navigator.clipboard?.writeText(info.abs));
      copy.classList.add("wide-only");
      tbtn("📎", "把这个路径引用到输入框", () => this.insertPaths([info.abs]));
    }
    tbtn(v.full ? "🗗" : "⛶", v.full ? "退出全屏" : "全屏", () => {
      v.full = !v.full;
      localStorage.setItem("pi.viewerFull", v.full ? "1" : "0");
      this.paintViewer();
    }, v.full);
    tbtn("✕", "关闭（Esc）", () => this.closeViewer());
    head.append(left, tools);

    // 浏览态：列表挂上就保持状态（滚动、筛选、当前位置），重绘时不要拆掉（D50）。
    if (v.pane === "browse") {
      if (!body.querySelector(":scope > .viewer-browse")) this.mountBrowser(v);
      return;
    }
    if (v.pane === "edit") {
      this.mountEditor(v);
      return;
    }
    body.removeAttribute("data-edit-path");
    // Keep an html iframe alive across header-only repaints (its own state / scroll matter).
    const frame = body.querySelector<HTMLIFrameElement>("iframe.viewer-frame");
    if (info?.kind === "html" && v.mode === "render" && !v.error && frame?.dataset.src === rawUrl(info)) return;

    body.replaceChildren();
    body.className = "viewer-body";
    if (v.error) {
      const box = el("div", "viewer-msg err");
      box.append(el("div", "", v.error));
      if (info) {
        const open = el("button", "btn", "新标签页打开");
        open.onclick = () => this.openRawTab(rawUrl(info));
        box.append(open);
      }
      body.append(box);
      return;
    }
    if (!info) {
      body.append(viewerLoading("正在打开…"));
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
      const box = el("div", "viewer-msg");
      box.append(el("div", "", `二进制文件（${fmtSize(info.size)}），这里不直接显示。`));
      const open = el("button", "btn", "新标签页打开 / 下载");
      open.onclick = () => openSameOrigin(url);
      box.append(open);
      body.append(box);
      return;
    }
    if (v.text == null) {
      body.append(viewerLoading("正在读取…"));
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
    const lines = v.text.split(/\r?\n/);
    const gutter = el("div", "ln-gutter", lines.map((_, k) => k + 1).join("\n"));
    const code = el("code", "", v.text);
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
    const node = el("button", "btn ghost dir-home", "⌂ 工作目录") as HTMLButtonElement;
    node.dataset.act = "dir-home";
    const sync = (): void => {
      const cwd = (getCwd() || "").trim();
      node.disabled = !cwd;
      node.title = cwd ? `回到会话的工作目录 ${cwd}` : "还没有会话，也就没有工作目录可回";
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

  private mountBrowser(v: Viewer): void {
    const body = v.body;
    body.replaceChildren();
    body.className = "viewer-body browse";
    const host = el("div", "viewer-browse");
    body.append(host);
    const home = this.dirHome(() => this.session?.cwd ?? "");
    const picker = mountDirPicker(host, {
      start: v.lastDir || this.session?.cwd || "",
      files: true,
      fallback: true,
      head: [home.node],
      onState: (s) => {
        if (!s.path) return;
        v.lastDir = s.path;
        localStorage.setItem("pi.fsDir", s.path);
      },
      onPick: (abs) => void this.pickFromBrowser(v, abs),
      onContext: (abs, name, ev) => this.fileMenu(v, abs, name, ev),
    });
    home.bind(picker);
  }

  /** Q-008: right-click a file — run a script with PowerShell, or elevated on the desktop. */
  private fileMenu(v: Viewer, abs: string, name: string, ev: MouseEvent): void {
    const script = /\.(ps1|psm1|cmd|bat)$/i.test(name);
    const cwd = v.lastDir || this.session?.cwd || "";
    const items: { label: string; run: () => void }[] = [];
    if (script) {
      items.push({
        label: "用 PowerShell 运行",
        run: () => this.act(() => this.socket.send({ type: "open.script", file: abs, cwd, admin: false })),
      });
      items.push({
        label: "以管理员身份运行",
        run: () => this.act(() => this.socket.send({ type: "open.script", file: abs, cwd, admin: true })),
      });
    }
    items.push({ label: "打开", run: () => void this.pickFromBrowser(v, abs) });
    items.push({ label: "复制路径", run: () => void navigator.clipboard?.writeText(abs) });
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
    const name = v.info?.name ?? "文件";
    const choice = await this.choose(`「${name}」还没保存`, [
      { id: "save", label: "保存", primary: true },
      { id: "drop", label: "放弃改动" },
      { id: "cancel", label: "取消" },
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
    const ta = el("textarea", "ed-ta") as HTMLTextAreaElement;
    ta.value = v.draft ?? v.text ?? "";
    ta.wrap = "off";
    ta.spellcheck = false;
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
    };
    ta.onscroll = () => {
      gutter.scrollTop = ta.scrollTop;
    };
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
    wrap.append(gutter, ta);

    const path = el("div", "ed-path", info.abs);
    path.title = info.abs;
    const msg = el("div", "ed-msg", "");
    const foot = el("div", "ed-foot");
    const drop = el("button", "btn ghost", "放弃");
    drop.onclick = async () => {
      if (!v.dirty) return;
      const ok = await this.choose(`放弃「${info.name}」的改动？`, [
        { id: "yes", label: "放弃", danger: true },
        { id: "cancel", label: "取消", primary: true },
      ]);
      if (ok !== "yes") return;
      v.dirty = false;
      v.draft = null;
      await this.openPreview(info.abs, v.sessionId);
    };
    const save = el("button", "btn primary", "保存");
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
    bar.append(el("div", "ed-conflict-txt", "这个文件在你编辑期间被改过了（可能是 pi 写的）"));
    const row = el("div", "ed-conflict-row");
    const overwrite = el("button", "btn ghost", "覆盖磁盘上的版本");
    overwrite.onclick = () => void this.overwriteFile(v, abs);
    const copy = el("button", "btn ghost", "另存副本");
    copy.onclick = () => void this.saveAsCopy(v, abs);
    const reload = el("button", "btn ghost", "放弃我的改动");
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
      this.toastInEditor(v, String(err?.message ?? err));
      return;
    }
    v.conflict = null;
    if (v.info.kind !== "markdown" && v.info.kind !== "text") {
      this.toastInEditor(v, "文件已经不是文本了，没法再编辑");
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
      this.warn(`已另存为 ${r.path}`);
    } catch (err: any) {
      this.toastInEditor(v, String(err?.message ?? err));
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
        msg.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
        msg.className = "ed-msg ok";
      }
      return true;
    } catch (err: any) {
      if (err?.status === 409) {
        v.conflict = String(err?.message ?? err);
        // 上一条「已保存」此刻已经过时，别让它和冲突条并排站着。
        if (msg) {
          msg.textContent = "";
          msg.className = "ed-msg";
        }
        this.paintConflict(v, v.info.abs);
        return false;
      }
      this.toastInEditor(v, String(err?.message ?? err));
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
    if (s.locked) return "终端正在使用这个会话，先在那边退出再删";
    return "网页正在运行/接管这个会话，先停止运行再删";
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
      if (g === "origin") return s.origin === "web" ? ["origin:web", "网页创建"] : ["origin:cli", "pi CLI 创建"];
      if (g === "status") {
        if (this.manage.archived.includes(s.id)) return ["status:archived", "已归档"];
        return this.manage.pin.includes(s.id) ? ["status:pin", "置顶"] : ["status:normal", "普通"];
      }
      const t = timeBucket(s.updatedAt);
      return [`time:${t}`, t === "today" ? "今天" : t === "week" ? "本周" : "更早"];
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

  private openManager(): void {
    this.closeSheet();
    this.sheetKind = "manage";
    this.mgrPicked.clear();
    this.mgrRename = null;
    this.mgrDelArm = null;
    this.mgrNote = "";
    this.mgrView = "list";
    this.mgrTrashPick.clear();
    const back = el("div", "sheet-back center");
    back.onclick = (ev) => {
      if (ev.target === back) this.closeSheet();
    };
    back.onkeydown = (ev) => {
      if (ev.key === "Escape") this.closeSheet();
    };
    const sheet = el("div", "sheet mgr-sheet");
    const head = el("div", "sheet-head");
    const titleEl = el("div", "sheet-title", "会话管理");
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
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(titleEl, close);

    // The toolbar is built once so the search box keeps focus while the body repaints.
    const tools = el("div", "mgr-tools");
    const q = el("input", "mgr-search") as HTMLInputElement;
    q.type = "search";
    q.placeholder = "搜索 名字 / 目录 / 首条消息（空格分隔多个词）";
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
    const origin = select("origin", "来源", [["all", "全部"], ["web", "网页"], ["cli", "CLI"]]);
    const status = select("status", "状态", [["all", "全部"], ["active", "未归档"], ["pin", "置顶"], ["normal", "普通"], ["archived", "已归档"]]);
    const time = select("time", "更新", [["all", "全部"], ["today", "今天"], ["week", "本周"], ["older", "更早"]]);
    const cwd = select("cwd", "目录", [["", "全部"]]);
    const group = select("group", "分组", [["none", "不分组"], ["cwd", "按目录"], ["origin", "按来源"], ["status", "按状态"], ["time", "按时间"]]);
    const sort = select("sort", "排序", [["updated", "最近更新"], ["created", "创建时间"], ["name", "名称"], ["cwd", "工作目录"]]);
    const dir = el("button", "btn ghost mgr-dir") as HTMLButtonElement;
    const syncDir = () => {
      dir.textContent = this.mgr.desc ? "↓ 降序" : "↑ 升序";
    };
    syncDir();
    dir.onclick = () => {
      this.mgr.desc = !this.mgr.desc;
      syncDir();
      this.saveMgr();
      paint();
    };
    const reset = el("button", "btn ghost", "重置");
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
    const binHint = el("span", "mgr-bin-hint", "删掉的会话在这里，可以还原或彻底删除");
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
      for (const [v, t] of [["", `全部（${counts.size} 个目录）`], ...list.map(([c, n]) => [c, `${c}（${n}）`])]) {
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
      if (!shown.length) body.append(el("div", "empty", this.sessions.length ? "没有符合条件的会话。" : "还没有会话。"));
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
          box.title = "选中本组";
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
        el("span", "", it.cwd || "未知目录"),
        el("span", "", `删除于 ${relativeTime(it.deletedAt)}`),
        el("span", "", fmtSize(it.size || 0)),
      );
      main.append(line, sub);
      const acts = el("div", "mgr-acts");
      const restore = el("button", "btn ghost mgr-open", "还原") as HTMLButtonElement;
      restore.onclick = (ev) => {
        ev.stopPropagation();
        this.act(() => this.socket.send({ type: "manage", action: "restore", ids: [it.id] }));
      };
      const armKey = `purge1:${it.id}`;
      const armed = this.mgrDelArm?.key === armKey;
      const del = el("button", `card-act del${armed ? " armed" : ""}`, armed ? "删?" : "删") as HTMLButtonElement;
      del.title = armed ? "再点一次：真的销毁这个文件" : "彻底删除（不可恢复）";
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
      allLabel.append(allBox, el("span", "", "全选"));
      const total = items.reduce((n, it) => n + (it.size || 0), 0);
      const info = el("span", "mgr-count", `已选 ${ids.length} · 共 ${items.length} 个 · 占 ${fmtSize(total)}`);
      const restoreBtn = el("button", "btn", "还原所选") as HTMLButtonElement;
      restoreBtn.disabled = !ids.length;
      restoreBtn.onclick = () => this.act(() => this.socket.send({ type: "manage", action: "restore", ids }));
      const pickedArm = `purge:${ids.join(",")}`;
      const pickedArmed = this.mgrDelArm?.key === pickedArm;
      const purgeBtn = el("button", `btn danger${pickedArmed ? " armed" : ""}`, pickedArmed ? `再点一次：销毁 ${ids.length} 个` : "彻底删除所选") as HTMLButtonElement;
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
      for (const id of [...this.mgrTrashPick]) if (!live.has(id)) this.mgrTrashPick.delete(id);
      const scrollTop = body.scrollTop;
      body.replaceChildren();
      if (!items.length) {
        body.append(el("div", "empty", "垃圾箱是空的。删掉的会话会先放到这里，清空才真的销毁。"));
      } else {
        const total = items.reduce((n, it) => n + (it.size || 0), 0);
        const bar = el("div", "trash-head");
        bar.append(
          el("span", "", `最近删除 ${items.length} 个`),
          el("span", "faint", ` · 占 ${fmtSize(total)}`),
          el("span", "spacer"),
        );
        // One button for the whole bin, so clearing never needs a select-all first.
        const allArmed = this.mgrDelArm?.key === "purge:all";
        const empty = el("button", `btn danger${allArmed ? " armed" : ""}`, allArmed ? `再点一次：清空 ${items.length} 个` : "一键清空") as HTMLButtonElement;
        empty.title = "垃圾箱里的文件会被真的删掉，无法还原";
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
      titleEl.textContent = inTrash ? "垃圾箱" : "会话管理";
      if (inTrash) bin.textContent = "← 会话列表";
      else bin.textContent = this.trash.length ? `🗑 垃圾箱 (${this.trash.length})` : "🗑 垃圾箱";
      bin.classList.toggle("on", inTrash);
      bin.title = inTrash ? "回到会话列表" : "最近删除的会话都在这里，清空才真的销毁";
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
      allLabel.append(allBox, el("span", "", "全选"));
      const info = el("span", "mgr-count", `已选 ${ids.length} · 显示 ${shown.length} / 共 ${this.sessions.length}`);
      const btn = (text: string, fn: () => void, cls = "btn") => {
        const b = el("button", cls, text) as HTMLButtonElement;
        b.disabled = !ids.length;
        b.onclick = fn;
        return b;
      };
      const deletable = picked.filter((s) => !App.busy(s)).map((s) => s.id);
      const delKey = `bulk:${deletable.join(",")}`;
      const armed = this.mgrDelArm?.key === delKey;
      const del = btn(armed ? `再点一次：移入垃圾箱 ${deletable.length} 个` : deletable.length < ids.length ? `删除（${deletable.length} 个可删）` : "删除", () => {
        if (this.mgrArm(delKey)) {
          // No optimistic clear: the bridge reports what it actually removed, and the paint() below
          // prunes picked ids against the list that is really left.
          this.act(() => this.socket.send({ type: "manage", action: "delete", ids: deletable }));
        }
        paint();
      }, `btn danger${armed ? " armed" : ""}`);
      del.disabled = !deletable.length;
      if (deletable.length < ids.length) del.title = "运行中 / 网页接管中 / 待确认的会话不能删，先停止运行";
      const spacer = el("span", "spacer");
      foot.append(
        allLabel,
        info,
        spacer,
        btn("置顶", () => this.pinIds(ids, true)),
        btn("取消置顶", () => this.pinIds(ids, false)),
        btn("归档", () => this.archiveIds(ids, true)),
        btn("恢复", () => this.archiveIds(ids, false)),
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
      const name = el("span", "mgr-name", s.name || "(未命名)");
      name.title = s.name;
      line.append(name);
    }
    const tag = (cls: string, text: string, title = "") => {
      const t = el("span", `mgr-tag ${cls}`, text);
      if (title) t.title = title;
      line.append(t);
    };
    if (pinned && !archived) tag("pin", "置顶");
    if (archived) tag("arch", "已归档");
    tag(s.origin === "web" ? "web" : "cli", s.origin === "web" ? "网页" : "CLI", s.origin === "web" ? "在网页里新建的会话" : "在终端 pi CLI 里创建的会话");
    const badge = sessionBadge(s, this.currentId);
    if (badge) tag(badge.cls, badge.text, badge.title);
    else if (s.owned) tag("live", "已接管", "这个会话由网页接管着");
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
    const up = el("span", "", `更新 ${relativeTime(s.updatedAt)}`);
    up.title = new Date(s.updatedAt).toLocaleString();
    times.append(up);
    if (created) {
      const c = el("span", "", `创建 ${new Date(created).toLocaleDateString()}`);
      c.title = new Date(created).toLocaleString();
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
    const open = el("button", "btn ghost mgr-open", "打开") as HTMLButtonElement;
    open.onclick = (ev) => {
      ev.stopPropagation();
      this.closeSheet();
      this.openFromList(s.id);
    };
    acts.append(open);
    act(pinned ? "★" : "☆", pinned ? "取消置顶" : "置顶", () => this.pinIds([s.id], !pinned), `card-act${pinned ? " pinned" : ""}`);
    act("✎", "重命名", () => {
      this.mgrRename = { id: s.id, draft: s.name || "" };
      repaint();
    });
    act(archived ? ICON_UNARCHIVE : ICON_ARCHIVE, archived ? "恢复（取消归档）" : "归档（文件不动，只是收起来）", () => this.archiveIds([s.id], !archived));
    const key = `one:${s.id}`;
    const armed = this.mgrDelArm?.key === key;
    const busy = App.busy(s);
    const del = act(
      armed ? "删除?" : ICON_TRASH,
      busy ? App.busyWhy(s) : armed ? "再点一次：移入垃圾箱" : "删除（先进垃圾箱，可还原）",
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
      claim.append(el("span", "act-spin"), el("span", "", "接管中…"));
      claim.disabled = true;
      claim.title = "正在拉起 pi 进程，通常要几秒";
    } else claim.textContent = "接管会话";
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
        this.chat.add({ id: `n:${Date.now()}`, kind: "notice", text: "等了 60 秒还没接管成功，看看服务端日志", level: "warn" });
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
    this.skillPop = null;
    this.imageBadge = null;
    if (!this.currentId) {
      const hint = el("div", "empty", "左边选一个会话，或开一个新的。");
      host.append(hint);
      return;
    }
    const s = this.session;

    if (s && !s.owned) {
      const bar = el("div", "takeover warn");
      bar.append(el("span", "", "这个会话来自磁盘（只读预览）。发消息会自动接管；终端里如果有 pi 在写同一个文件，先退出那边。"));
      bar.append(this.claimButton());
      host.append(bar);
    }

    const row = el("div", "row");
    const box = el("div", "composer-input");
    const input = el("textarea");
    input.placeholder = s?.running ? "跑着呢，再发会自动排队…（Enter 发送）" : "说点什么…（Enter 发送，Shift+Enter 换行）";
    this.textarea = input;
    input.value = this.composerText;
    const pasteHost = el("div", "paste-list");
    this.pasteHost = pasteHost;
    box.append(pasteHost, input);
    input.oninput = () => {
      this.composerText = input.value;
      this.noteDraft();
      this.fitComposer();
    };
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
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.sendPrompt();
      }
    };

    // Enter sends; the slot the send button used holds the tool-permission switch.
    row.append(box, this.permissionButton());
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
    const skillBtn = el("button", "btn ghost", "技能");
    skillBtn.dataset.act = "skills";
    skillBtn.title = "搜索并插入技能命令（/skill:name）";
    skillBtn.onclick = () => this.openSkillPalette();
    const pathBtn = el("button", "btn ghost", "文件");
    pathBtn.dataset.act = "attach";
    pathBtn.title = `选文件：图片直接附加，其他文件插入完整路径（pi 会自己去读）。截图或资源管理器里复制的文件也可以 ${PASTE_KEY}`;
    pathBtn.onclick = () => this.openFilePicker();
    const chip = el("button", "model-chip");
    chip.onclick = () => this.openModelSheet();
    chip.append(el("span", "chip-model", ""), el("span", "chip-ctx", ""), el("span", "chip-rate", ""), el("span", "chip-level", ""));
    this.modelChip = chip;
    tools.append(skillBtn, pathBtn, chip);
    if (s?.owned) {
      // The explanation lives in the tooltip so it no longer costs the composer a whole row.
      const fromWeb = s.origin === "web";
      const release = el("button", "btn ghost release-btn", fromWeb ? "释放会话" : "让回终端");
      release.title = fromWeb
        ? "网页是这个会话的写者。释放后 pi 进程退出，历史留在磁盘；再发消息会自动重新接管。"
        : "网页是这个会话的写者。要回终端接着聊，先在这里让回去。";
      release.onclick = () => this.act(() => this.socket.send({ type: "close", sessionId: this.currentId }));
      tools.append(release);
    }
    hint.append(tools);
    this.fillModelChip();

    host.append(row, hint);
    this.fitComposer();
    this.renderPastes();
    if (this.approvals.length) host.append(this.approvalNode());
    this.renderAsks();
    this.syncCwdChip();
  }

  // ---------------------------------------------------------------- permission mode
  private permissionButton(): HTMLElement {
    const mode = this.session?.permission ?? "ask";
    const meta = PERM_MODES.find((m) => m.id === mode) ?? PERM_MODES[2];
    const btn = el("button", `perm-btn perm-${mode}`) as HTMLButtonElement;
    btn.append(el("span", "perm-ico", meta.icon), el("span", "perm-label", meta.label), el("span", "perm-caret", "▾"));
    btn.title = `权限模式：${meta.label}——${meta.desc}`;
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
    menu.append(el("div", "perm-menu-title", "工具权限（只对这个会话）"));
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
        el("span", "paste-title", `粘贴的内容${this.pastes.length > 1 ? ` #${index + 1}` : ""}`),
        el("span", "paste-meta", `${lines} 行 · ${p.text.length} 字`),
        el("span", "paste-peek", p.open ? "" : p.text.replace(/\s+/g, " ").trim().slice(0, 80)),
      );
      toggle.title = p.open ? "收起" : "展开查看 / 编辑";
      toggle.onclick = () => {
        p.open = !p.open;
        this.renderPastes();
      };
      const drop = el("button", "paste-x", "×") as HTMLButtonElement;
      drop.type = "button";
      drop.title = "删掉这段粘贴的内容";
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
          if (meta) meta.textContent = `${p.text.split("\n").length} 行 · ${p.text.length} 字`;
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
        this.warn(`SVG「${file.name}」渲染失败，没有附加`);
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
    const fallback = `用「文件」按钮选，或在资源管理器里 Shift+右键 →「复制为路径」后再粘贴`;
    if (this.me.public) {
      this.warn(`通过公网访问时拿不到「${names.join("、")}」的路径。${fallback}`);
      return;
    }
    let paths: string[] = [];
    try {
      paths = (await api.clipboardFiles()).paths;
    } catch (ex: any) {
      this.warn(`${ex?.message ?? ex}。${fallback}`);
      return;
    }
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const hits = paths.filter((p) => wanted.has((p.split(/[\\/]/).pop() ?? "").toLowerCase()));
    if (!hits.length) {
      this.warn(`剪贴板里找不到「${names.join("、")}」的路径（复制的文件不在这台电脑上？）。${fallback}`);
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
    head.append(el("div", "sheet-title", "选择文件 · 图片直接附加，其他插入路径"));
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
    const device = el("button", "btn ghost", "从本设备选图片");
    device.title = "从当前浏览器所在的设备（例如手机相册）选图片附加";
    device.onclick = () => deviceInput.click();
    head.append(deviceInput, device);
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(close);
    const host = el("div", "file-picker-body");
    sheet.append(head, host);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;

    const home = this.dirHome(() => this.session?.cwd ?? "");
    const picker = mountDirPicker(host, {
      start: this.session?.cwd ?? "",
      files: true,
      fallback: true,
      head: [home.node],
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
            this.warn(`附加图片失败：${ex?.message ?? ex}`);
          });
      },
    });
    home.bind(picker);
    host.querySelector<HTMLInputElement>(".dir-filter")?.focus();
  }

  /** 待发图片的入口：点一下看缩略图、单张删。 */
  private pendingImagesBadge(): HTMLButtonElement {
    const badge = el("button", "badge image-badge", `+${this.images.length} 图`) as HTMLButtonElement;
    badge.type = "button";
    badge.title = "查看 / 删除待发图片";
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
      this.imageBadge.textContent = `+${this.images.length} 图`;
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
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(title, close);

    const grid = el("div", "image-grid");
    const foot = el("div", "sheet-foot");
    const clear = el("button", "btn danger", "全部清空");
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
      title.textContent = `待发图片 ${this.images.length} 张`;
      grid.replaceChildren();
      this.images.forEach((image, index) => {
        const tile = el("div", "image-tile");
        const thumb = el("img", "image-thumb") as HTMLImageElement;
        thumb.src = `data:${image.mimeType};base64,${image.data}`;
        thumb.alt = `待发图片 ${index + 1}`;
        // 序号常驻：删掉一张后重新编号，跟在输入框里写「第 2 张」对得上。
        const no = el("span", "image-no", String(index + 1));
        tile.append(no);
        const drop = el("button", "image-x", "×") as HTMLButtonElement;
        drop.type = "button";
        drop.title = "删掉这张";
        drop.setAttribute("aria-label", `删掉第 ${index + 1} 张图片`);
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
  private renderAsks(): void {
    const host = this.els.composerHost;
    host.querySelector(".ask-slot")?.remove();
    this.fillHintStatus();
    if (this.textarea) {
      const s = this.session;
      this.textarea.placeholder = this.asks.length
        ? "直接打字回答（Enter 提交），或点上面的选项…"
        : s?.running
          ? "跑着呢，再发会自动排队…"
          : "说点什么…";
    }
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
    const more = this.asks.length > 1 ? `（还有 ${this.asks.length - 1} 份）` : "";
    head.append(el("span", "t", `${total > 1 ? `需要你回答 · ${total} 题` : "需要你回答"}${more}`));
    if (this.askFolded) head.append(el("span", "m", q.prompt.split("\n")[0].slice(0, 80)));
    const fold = el("button", "btn ghost", this.askFolded ? "展开" : "收起");
    fold.onclick = () => {
      this.askFolded = !this.askFolded;
      this.renderAsks();
    };
    const cancel = el("button", "btn ghost danger-text", "取消提问");
    cancel.title = "告诉模型你不回答这次提问";
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
          if (chosen && !chosen.wasCustom && chosen.value === opt.value) btn.classList.add("on");
          btn.append(el("div", "l", opt.label));
          if (opt.description) btn.append(el("div", "d", opt.description));
          btn.onclick = () => this.pickAnswer(ask, { id: q.id, value: opt.value, label: opt.label, index: i + 1 });
          list.append(btn);
        });
        slot.append(list);
      }
      if (chosen?.wasCustom) slot.append(el("div", "ask-draft", `已填：${chosen.label}`));
      if (q.allowOther === false) slot.append(el("div", "ask-note", "这题只能从选项里选。"));
      if (total > 1) {
        const missing = ask.questions.filter((x) => !st.drafts.has(x.id)).length;
        const submit = el("button", "btn primary", missing ? `还差 ${missing} 题` : "提交全部回答");
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
    const title = ask.questions.length === 1 ? ask.questions[0].prompt : `${ask.questions.length} 题的问卷`;
    this.askLost = { id: ask.id, title: title.slice(0, 80), reason, lines };
  }

  private askLostBlock(): HTMLElement {
    const lost = this.askLost!;
    const box = el("div", "ask-slot ask-lost");
    box.append(el("div", "ask-lost-head", `问卷没答完就关闭了：${lost.reason}`));
    box.append(el("div", "ask-lost-sub", `你已填的 ${lost.lines.length} 题还留着，可以接着用。`));
    const actions = el("div", "ask-lost-actions");
    const put = el("button", "btn", "把已填答案放进输入框");
    put.onclick = () => {
      this.putInComposer(lost.lines.join("\n\n"));
      this.askLost = null;
      this.renderAsks();
    };
    const dismiss = el("button", "tool-btn", "忽略");
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
    card.append(el("div", "t", ask.questions.length > 1 ? `需要你回答 · ${ask.questions.length} 题` : "需要你回答"));
    card.append(el("div", "m", ask.questions.map((q, i) => `${ask.questions.length > 1 ? `${q.label ?? `Q${i + 1}`}：` : ""}${q.prompt}`).join("\n")));
    const actions = el("div", "actions");
    const go = el("button", "btn primary", "去回答");
    go.onclick = () => this.focusAsk();
    const cancel = el("button", "btn danger", "取消这次提问");
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

  private approvalCard(a: ApprovalRequest): HTMLElement {
    const card = el("div", "approval");
    const t = el("div", "t", a.title);
    const m = el("div", "m", a.message);
    const actions = el("div", "actions");

    const approve = el("button", "btn primary", "批准");
    approve.onclick = () => {
      if (!confirm("确认批准这条命令？")) return;
      this.decide(a, "approve");
    };
    const always = el("button", "btn", "本会话允许这类");
    always.onclick = () => {
      if (!confirm("批准这条命令，并在本会话内不再询问同一类命令？")) return;
      this.decide(a, "always");
    };
    const reject = el("button", "btn danger", "拒绝");
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
      host.append(el("div", "empty", "没有等你的事。"));
    } else {
      if (this.asks.length) {
        host.append(el("h2", "", "等你回答"));
        for (const a of this.asks) host.append(this.askCard(a));
      }
      if (pending.length) {
        host.append(el("h2", "", "等你批准"));
        for (const a of pending) host.append(this.approvalCard(a));
      }
    }

    const tools = el("div", "actions");
    tools.style.display = "flex";
    tools.style.gap = "8px";
    tools.style.flexWrap = "wrap";
    const push = el("button", "btn", "开启 Web Push");
    push.onclick = () => void this.enablePush();
    const test = el("button", "btn", "发测试通知");
    test.onclick = async () => {
      const res = await api.notifyTest().catch((e) => ({ push: 0, wechat: String(e.message ?? e) }));
      alert(`Web Push 送达 ${res.push} 台；微信：${res.wechat}`);
    };
    const tun = el("button", "btn", this.tunnel.status === "up" ? "关掉公网隧道" : "开公网隧道");
    tun.onclick = async () => {
      const res = await api.tunnel(this.tunnel.status === "up" ? "stop" : "start").catch(() => null);
      if (res) this.tunnel = res.tunnel;
      this.renderTop();
      this.renderQueue();
    };
    tools.append(push, test, tun);
    host.append(el("h2", "", "通道"));
    host.append(tools);
    host.append(el("div", "hint", `Web Push 订阅 ${this.me.pushCount} 台设备`));
    if (this.tunnel.url) {
      const link = el("a", "", this.tunnel.url);
      link.href = this.tunnel.url;
      link.target = "_blank";
      host.append(link);
    }
    if (this.tunnel.error) host.append(el("div", "notice warn", this.tunnel.error));
    const termTools = el("div", "tools");
    const termBtn = el("button", "btn", this.term ? "回到终端" : "打开终端");
    termBtn.dataset.act = "terminal";
    termBtn.title = "在这台电脑上开一个 PowerShell（本机 / 局域网可用，公网隧道下禁用）";
    termBtn.onclick = () => this.openTerminal();
    termTools.append(termBtn);
    host.append(el("h2", "", "终端"));
    host.append(termTools);
    host.append(el("div", "hint", "真的 PowerShell，跑在这台电脑上。本机直接可用；走公网隧道时禁用。"));

    const keysTools = el("div", "tools");
    const keysBtn = el("button", "btn", Object.keys(this.keys).length ? `快捷键（已设 ${Object.keys(this.keys).length} 个）` : "设置快捷键");
    keysBtn.onclick = () => this.openKeysSheet();
    keysTools.append(keysBtn);
    host.append(el("h2", "", "快捷键"));
    host.append(keysTools);
    host.append(el("h2", "", "关于"));
    host.append(el("div", "hint", `pi ${this.me.pi} · bridge ${this.me.version} · ${this.me.sessionsRoot}`));
  }

  // ---------------------------------------------------------------- terminal (Q-007)
  /** Ask the bridge for a shell. The passphrase gate lives on the bridge side, not here. */
  private openTerminal(): void {
    // Q-026: the dock lives in the chat column, so the right pane (运行 / 队列) is the one stealing
    // its width — fold it away before showing the shell. Only when it is actually there to fold
    // (desktop, expanded): on a narrow tab layout there is nothing to gain and the flag would be
    // remembered for the next visit.
    if (window.matchMedia("(min-width: 900px)").matches && !this.collapsed.queue) this.togglePane("queue");
    if (this.term) {
      this.term.dock.hidden = false;
      this.term.term.focus();
      return;
    }
    const cwd = this.session?.cwd ?? undefined;
    this.act(() => this.socket.send({ type: "term.open", cols: 100, rows: 26, cwd }));
  }

  private mountTerminal(id: string, shell: string, cwd: string): void {
    this.closeTerminal();
    const dock = el("section", "term-dock");
    const head = el("div", "term-head");
    const title = el("div", "term-title", cwd ? `${shell} · ${cwd}` : shell);
    title.title = "在这台电脑上运行的 PowerShell，输出直接回到这里";
    const admin = el("button", "term-btn", "管理员");
    admin.title = "开一个管理员 PowerShell 窗口（提权进程的输出浏览器接管不了，所以它在桌面上）";
    // Q-023: without admin:true the bridge never added -Verb RunAs, so this opened a plain shell
    // under an "管理员" label. The flag is the whole point of the button.
    admin.onclick = () => this.act(() => this.socket.send({ type: "term.elevate", cwd, admin: true }));
    const close = el("button", "term-btn", "关闭");
    close.title = "结束这个终端进程";
    close.onclick = () => {
      this.socket.send({ type: "term.close", id });
      this.closeTerminal();
    };
    head.append(title, el("div", "spacer"), admin, close);
    const body = el("div", "term-body");
    // Q-026: the height was a constant (`min(46vh, 420px)`); a shell you are reading deserves a drag.
    const grip = el("div", "term-grip");
    grip.title = "拖动调整终端高度（双击复位）";
    dock.append(grip, head, body);
    this.els.chatPane.append(dock);
    this.wireTermGrip(grip, dock);

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
    this.term = { id, term, fit, dock };
    sessionStorage.setItem("pi.termId", id);
    term.onData((data) => this.socket.send({ type: "term.input", id, data }));
    term.onResize(({ cols, rows }) => this.socket.send({ type: "term.resize", id, cols, rows }));
    const measure = (): void => {
      try {
        fit.fit();
      } catch {
        // the panel can be hidden mid-layout; the next resize event retries
      }
    };
    new ResizeObserver(measure).observe(body);
    requestAnimationFrame(() => {
      measure();
      term.focus();
    });
  }

  private closeTerminal(): void {
    sessionStorage.removeItem("pi.termId");
    if (!this.term) return;
    this.term.term.dispose();
    this.term.dock.remove();
    this.term = null;
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
      const hint = combo ? `　〔${keyLabel(combo)}〕` : "";
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
    head.append(el("div", "sheet-title", "快捷键"));
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);
    sheet.append(
      el(
        "div",
        "hint",
        "点右边的键钮再按下组合键。组合要带 Ctrl / Alt / Shift，F2–F10 可以单独用；浏览器自己占的键（Ctrl+W、F5…）不收。点已设好的键钮可以清除。",
      ),
    );
    const list = el("div", "keys-list");
    const paint = (): void => {
      list.replaceChildren();
      for (const act of SHORTCUTS) {
        const row = el("div", "keys-row");
        row.append(el("div", "keys-name", act.label));
        const combo = this.keys[act.id];
        const button = el("button", `keys-chip${combo ? "" : " empty"}`, this.capturing === act.id ? "按下组合键…" : combo ? keyLabel(combo) : "未设置") as HTMLButtonElement;
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
          const clear = el("button", "btn ghost small", "清除");
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
    const clearAll = el("button", "btn ghost", "全部清空");
    clearAll.onclick = () => {
      this.keys = {};
      saveKeys(this.keys);
      this.paintShortcutTitles();
      paint();
    };
    const done = el("button", "btn primary", "完成");
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
    const desktop = window.matchMedia("(min-width: 900px)").matches;
    if (desktop) {
      sessionsPane.hidden = this.collapsed.sessions;
      chatPane.hidden = false;
      queuePane.hidden = this.collapsed.queue;
      main.classList.toggle("no-left", this.collapsed.sessions);
      main.classList.toggle("no-right", this.collapsed.queue);
      this.renderPinStrip();
      this.syncCwdChip();
      return;
    }
    main.classList.remove("no-left", "no-right");
    sessionsPane.hidden = this.tab !== "sessions";
    chatPane.hidden = this.tab !== "chat";
    queuePane.hidden = this.tab !== "queue";
    this.renderPinStrip();
    this.syncCwdChip();
  }

  /**
   * 左栏收起后就没人报「现在在哪个目录」了 —— 会话卡片连同它的 cwd 一起被藏起来。这时把路径接到状态行
   * 最前面、分支 chip 旁边，并且只在这时接：左栏展开时选中的那张卡片上写着同一个路径，再摆一个是重复。
   * 窄屏不走「折叠」这条逻辑（左栏是一页 tab），也不显示。
   */
  private syncCwdChip(): void {
    if (!this.cwdChip) return;
    this.cwdChip.hidden = !(this.collapsed.sessions && window.matchMedia("(min-width: 900px)").matches);
  }

  private cwdChipNode(cwd: string): HTMLElement {
    const btn = el("button", "cwd-chip") as HTMLButtonElement;
    const path = el("span", "cwd-path", cwd);
    btn.append(path);
    btn.title = `${cwd}\n点一下复制路径`;
    btn.onclick = () => {
      // 和 git chip 一样：`navigator.clipboard` 在局域网 http 下不存在，可选链要包住调用不是属性。
      const copy = navigator.clipboard?.writeText(cwd);
      if (!copy) return;
      const back = path.textContent ?? cwd;
      void copy
        .then(() => {
          path.textContent = "已复制";
          setTimeout(() => {
            if (path.isConnected && path.textContent === "已复制") path.textContent = back;
          }, 900);
        })
        .catch(() => {});
    };
    return btn;
  }

  /**
   * With the left column collapsed there is nowhere to click a pinned session. A row of chips under
   * the topbar keeps them one click away — same order as the list's 置顶 section, newest name first.
   */
  private renderPinStrip(): void {
    const host = this.els.pinStrip;
    const seen = this.collapsed.sessions && window.matchMedia("(min-width: 900px)").matches;
    if (!seen) {
      host.hidden = true;
      return;
    }
    const pins = this.manage.pin
      .map((id) => this.sessions.find((s) => s.id === id))
      .filter((s): s is SessionState => s !== undefined && !this.manage.archived.includes(s.id));
    // Q-022: the strip is rebuilt on every session/manage echo, and those echoes land right after the
    // ★ click — remember which button held focus so the rebuild does not drop it on <body>.
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const heldKey = active?.dataset.pinKey ?? null;
    host.replaceChildren();
    host.hidden = false;
    const pending = pins.filter((s) => sessionBadge(s, this.currentId)?.pending).length;
    const label = el("span", "pin-strip-label", pending ? `置顶 · ${pending} 个待处理` : pins.length ? "置顶" : "左栏已收");
    if (pending) label.classList.add("has-pending");
    host.append(label);
    for (const s of pins) {
      const badge = sessionBadge(s, this.currentId);
      // Q-022: a button cannot nest a button, so the chip is a container with two hit areas —
      // ★ = 取消置顶, the rest = 打开会话.
      const chip = el("div", "pin-chip");
      if (badge) chip.classList.add(badge.cls);
      const star = el("button", "pin-star", "★") as HTMLButtonElement;
      star.type = "button";
      star.dataset.pinKey = `${s.id}:star`;
      star.title = `取消置顶 ${s.name || s.id}`;
      star.setAttribute("aria-label", `取消置顶 ${s.name || s.id}`);
      star.onclick = () => {
        this.pinFocus = Math.max(pins.indexOf(s), 0);
        this.togglePin(s.id);
      };
      const open = el("button", "pin-open") as HTMLButtonElement;
      open.type = "button";
      open.dataset.pinKey = `${s.id}:open`;
      open.append(el("span", "pin-name", s.name || s.id), el("small", "", badge ? badge.text : relativeTime(s.updatedAt)));
      open.title = [s.name || s.id, s.cwd ?? "", badge?.title ?? ""].filter(Boolean).join(" · ");
      open.onclick = () => this.openFromList(s.id);
      chip.append(star, open);
      host.append(chip);
    }
    if (!pins.length) host.append(el("span", "pin-empty", "在这里 ☆ 置顶一个会话，收起左栏也能点到。"));
    // Q-013: with the left pane hidden this is the only visible way to start a session.
    // Q-022: 从这颗 ＋ 建的会话自动置顶，否则建完在这条里根本看不见。
    const add = el("button", "pin-chip pin-new", "＋");
    add.title = "开新会话（自动置顶到这条里）";
    add.dataset.act = "new";
    add.dataset.pinKey = "new";
    add.onclick = () => this.openNewSessionSheet(true);
    host.append(add);
    const expand = el("button", "pin-chip pin-expand", "展开左栏 ▸");
    expand.title = "展开左侧会话栏（也可以双击分隔条位置的边）";
    expand.dataset.pinKey = "expand";
    expand.onclick = () => this.togglePane("sessions");
    host.append(expand);
    // Q-022: the ★ that was just clicked no longer exists — hand focus to the next chip, else ＋.
    const focusStar = (target: HTMLElement): void => (target.querySelector<HTMLElement>(".pin-star") ?? target).focus();
    if (this.pinFocus !== null) {
      const want = this.pinFocus;
      this.pinFocus = null;
      const chips = Array.from(host.querySelectorAll<HTMLElement>(".pin-chip:not(.pin-new):not(.pin-expand)"));
      focusStar(chips[want] ?? chips[want - 1] ?? add);
    } else if (heldKey) {
      const same = Array.from(host.querySelectorAll<HTMLElement>("[data-pin-key]")).find((n) => n.dataset.pinKey === heldKey);
      if (same) same.focus();
      else focusStar(add);
    }
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
  btn.title = collapsed ? `展开${label}` : `收起${label}`;
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

type Prefs = { scale: number; accent: string; text: "soft" | "normal" | "bright" };

/** Q-029: how long the pointer has to rest on the activity line before the detail card opens. */
/** How long the peek card must stay before it stops following the pointer (Q-029). */
const PEEK_DELAY_MS = 3000;
/** Grace after the pointer leaves, so crossing the 8px gap into the card isn't a "leave". */
const PEEK_GAP_MS = 200;

const DEFAULT_PREFS: Prefs = { scale: 1, accent: "冰蓝", text: "normal" };

/** Context-budget presets in the model sheet; null = no ceiling (use the window). */
const BUDGETS: (number | null)[] = [null, 100_000, 200_000, 500_000, 1_000_000];

const SVG = (body: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_ARCHIVE = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>');
const ICON_UNARCHIVE = SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/>');
const ICON_TRASH = SVG('<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/><path d="M9 7V4h6v3"/>');

/** Everything a shortcut can fire, in the order the 快捷键 sheet lists it. */
const SHORTCUTS: { id: string; label: string }[] = [
  { id: "new", label: "开新会话" },
  { id: "manage", label: "会话管理（含垃圾箱）" },
  { id: "sessions", label: "收起 / 展开左栏" },
  { id: "queue", label: "收起 / 展开右栏" },
  { id: "artifacts", label: "产物列表" },
  { id: "files", label: "文件管理器" },
  { id: "look", label: "字号与配色" },
  { id: "skills", label: "技能面板" },
  { id: "attach", label: "附加文件" },
  { id: "terminal", label: "打开终端" },
  { id: "interrupt", label: "中断当前回复" },
];

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

const SIZES: [number, string][] = [
  [0.9, "小"],
  [1, "标准"],
  [1.12, "大"],
  [1.25, "特大"],
];

/** Accent pairs: the bright tint plus the dark wash used for filled states. */
const ACCENTS: Record<string, { accent: string; dim: string }> = {
  冰蓝: { accent: "#7dd3fc", dim: "#0e3a4d" },
  青绿: { accent: "#5eead4", dim: "#0d3b36" },
  紫: { accent: "#c4b5fd", dim: "#2a2148" },
  琥珀: { accent: "#fcd34d", dim: "#3d2e0b" },
  玫瑰: { accent: "#fda4af", dim: "#3d1a22" },
  银灰: { accent: "#cbd5e1", dim: "#252b36" },
};

const TEXTS: Record<Prefs["text"], { text: string; dim: string; faint: string }> = {
  soft: { text: "#d2d7e1", dim: "#8a92a0", faint: "#59606d" },
  normal: { text: "#e7eaf0", dim: "#9aa2b1", faint: "#6b7280" },
  bright: { text: "#fbfcff", dim: "#b9c1d0", faint: "#8a93a3" },
};

const TEXT_STEPS: [Prefs["text"], string][] = [
  ["soft", "柔和"],
  ["normal", "标准"],
  ["bright", "明亮"],
];

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem("pi.prefs");
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw);
    const scale = Number(p?.scale);
    return {
      scale: SIZES.some(([s]) => Math.abs(s - scale) < 0.005) ? scale : DEFAULT_PREFS.scale,
      accent: ACCENTS[String(p?.accent)] ? String(p.accent) : DEFAULT_PREFS.accent,
      text: TEXT_STEPS.some(([k]) => k === p?.text) ? (p.text as Prefs["text"]) : DEFAULT_PREFS.text,
    };
  } catch {
    return { ...DEFAULT_PREFS };
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
}

const PERM_MODES: { id: PermissionMode; icon: string; label: string; desc: string }[] = [
  { id: "readonly", icon: "🔒", label: "只读", desc: "不能写文件、不能执行命令，只读取和分析（适合先出方案）" },
  { id: "strict", icon: "✋", label: "逐个确认", desc: "每次写文件、执行命令都要你批准；读文件不用" },
  { id: "ask", icon: "🛡", label: "危险时确认", desc: "只拦删除、push、装依赖、写项目外文件等危险操作（默认）" },
  { id: "auto", icon: "⚡", label: "全自动", desc: "不拦截任何操作，风险自负" },
];

type PendingImage = { data: string; mimeType: string };
type PasteBlock = { text: string; open: boolean };
type Draft = { text: string; images: PendingImage[]; pastes: PasteBlock[] };

/** A paste this long (lines or characters) becomes its own foldable block. */
const PASTE_LINES = 6;
const PASTE_CHARS = 400;

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

function previewIcon(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  if (/^(md|markdown|mdx)$/.test(ext)) return "📝";
  if (/^html?$/.test(ext)) return "🌐";
  if (/^(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/.test(ext)) return "🖼";
  return "📄";
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN");
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
