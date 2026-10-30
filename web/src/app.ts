import { api } from "./api.ts";
import { ChatView, createEl as el } from "./chat.ts";
import { Socket } from "./ws.ts";
import type { AskAnswer, AskRequest, ApprovalRequest, Item, ManageState, Me, ModelInfo, SessionState, SkillInfo, TunnelState } from "./types.ts";

type Tab = "sessions" | "chat" | "queue";

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
  private askSeen = new Set<string>();
  private askSheetId: string | null = null;
  private connected = false;
  private tab: Tab = "sessions";
  private chat!: ChatView;
  private pending: (() => void) | null = null;
  private composerText = "";
  private images: { data: string; mimeType: string }[] = [];
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
  private sheetKind: "model" | "display" | null = null;
  private usage: { contextTokens: number | null; contextWindow: number | null } = { contextTokens: null, contextWindow: null };
  /** Context budget chosen in the model sheet (bridge enforces it); null = window size. */
  private budget: number | null = null;
  private rate = 0;
  private turnAt: number | null = null;
  private turnChars = { cjk: 0, other: 0 };
  private rateAt = 0;
  /** Sidebar rename: which card is an input, its draft, and whether to select the text. */
  private renameId: string | null = null;
  private renameDraft = "";
  private renameFocus = false;
  private renameCaret: number | null = null;
  /** Sidebar arrangement owned by the user: pin / manual order / archive (D46). */
  private manage: ManageState = { pin: [], order: [], archived: [] };
  private managing = false;
  private picked = new Set<string>();
  private archivedOpen = false;
  private filter = "";
  /** Delete is two-step: the last click arms it, the next one within 4s sends it. */
  private deleteArm: { ids: string[]; at: number } | null = null;
  private dragId: string | null = null;

  constructor(me: Me) {
    this.me = me;
    this.tunnel = me.tunnel;
    this.applyPrefs();
    this.build();
    this.wire();
    // A pending question card in the transcript re-opens the drawer; the card itself has no
    // reference to the app and must not gain one.
    window.addEventListener("pi-ask-open", () => {
      if (this.asks.length) this.openAskSheet(this.asks[0].id);
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
    collapseLeft.onclick = () => this.togglePane("sessions");
    const dot = el("span", "dot");
    const title = el("div", "title", "pi");
    const sub = el("div", "sub", "");
    const collapseRight = el("button", "icon-btn side-toggle");
    collapseRight.dataset.side = "right";
    collapseRight.onclick = () => this.togglePane("queue");
    const look = el("button", "icon-btn icon-text", "Aa");
    look.title = "字号与颜色";
    look.onclick = () => this.openDisplaySheet();
    topbar.append(collapseLeft, dot, title, sub, look, collapseRight);

    const main = el("div", "main");

    const sessionsPane = el("section", "pane");
    const sessionsInner = el("div", "session-list");
    const create = el("div", "new-session");
    const newCwd = el("input");
    newCwd.placeholder = "新会话的工作目录（如 F:/pi-web-client）";
    const newBtn = el("button", "btn primary", "开新会话");
    newBtn.onclick = () => void this.newSession();
    create.append(newCwd, newBtn);
    // The filter must not lose focus on every keystroke, so it lives outside the repainted list.
    const manageBar = el("div", "manage-bar");
    const sessFilter = el("input", "session-filter");
    sessFilter.placeholder = "过滤名字 / 目录";
    sessFilter.oninput = () => {
      this.filter = sessFilter.value.trim();
      this.renderSessions();
    };
    const manageBtn = el("button", "tool-btn", "管理");
    manageBtn.title = "多选：置顶、归档、删除";
    manageBtn.onclick = () => this.toggleManaging();
    manageBar.append(sessFilter, manageBtn);
    const sessList = el("div", "session-cards");
    const actions = el("div", "manage-actions");
    // Bulk actions sit above the list: the pane scrolls, and a bar at the bottom would clip.
    sessionsInner.append(create, manageBar, actions, sessList);
    sessionsPane.append(sessionsInner);

    const chatPane = el("section", "pane chat-pane");
    const scroll = el("div", "pane chat-scroll");
    const composerHost = el("div", "composer");
    chatPane.append(scroll, composerHost);

    const queuePane = el("section", "pane");
    const queueInner = el("div", "queue");
    queuePane.append(queueInner);

    main.append(sessionsPane, chatPane, queuePane);

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

    shell.append(topbar, main, tabs);
    app.append(shell);

    Object.assign(this.els, { topbar, collapseLeft, collapseRight, look, dot, title, sub, main, sessionsPane, sessionsInner, newCwd, manageBar, sessFilter, manageBtn, sessList, actions, chatPane, scroll, composerHost, queuePane, queueInner, tabs });
    this.chat = new ChatView(scroll);
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
    }, 1000);
  }

  private wire(): void {
    this.socket.on((msg) => this.onMessage(msg));
    this.socket.onStatus((s) => {
      this.connected = s === "open";
      this.renderTop();
      this.renderSessions();
    });

    window.addEventListener("hashchange", () => this.routeFromHash());
    // 粘贴截图：桌面端 Ctrl+V / ⌘V 无论焦点在输入框还是页面上都落到待发图片里。
    window.addEventListener("paste", (ev) => this.onPaste(ev));
    if (window.matchMedia("(min-width: 900px)").matches) this.tab = "sessions";
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

  private openSession(id: string): void {
    if (this.currentId === id) return;
    this.currentId = id;
    this.session = this.sessions.find((s) => s.id === id) ?? null;
    if (this.session?.done) this.session.done = false;
    this.approvals = [];
    this.asks = [];
    this.images = [];
    this.usage = { contextTokens: null, contextWindow: null };
    this.rate = 0;
    this.rateAt = 0;
    this.turnAt = null;
    this.turnChars = { cjk: 0, other: 0 };
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
        this.sessions = msg.sessions ?? [];
        if (msg.manage) this.manage = msg.manage as ManageState;
        if (this.currentId && !this.session) this.session = this.sessions.find((x) => x.id === this.currentId) ?? null;
        this.tunnel = msg.tunnel ?? this.tunnel;
        this.renderAll();
        if (this.currentId) this.socket.send({ type: "subscribe", sessionId: this.currentId });
        break;
      case "session":
        // bridge sends the snapshot as {sessionId, state, items, approvals, budget}
        if (msg.sessionId) this.currentId = String(msg.sessionId);
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
        // A live question this page has not shown yet opens by itself: a reload must never leave the
        // model waiting behind a bar the user has not noticed.
        const fresh = this.asks.find((a) => !this.askSeen.has(a.id));
        if (fresh && !this.sheet) this.openAskSheet(fresh.id);
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
        break;
      case "approval.add":
        if (msg.sessionId === this.currentId) this.approvals = [...this.approvals, msg.approval];
        else this.notifyUnread(msg.sessionId);
        this.renderApprovals();
        this.renderQueue();
        this.renderTabs();
        break;
      case "approval.remove":
        this.approvals = this.approvals.filter((a) => a.id !== msg.id);
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
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        // The drawer cannot be missed; the bar stays for once it is closed.
        if (!this.askSheetId && !this.sheet) this.openAskSheet(ask.id);
        break;
      }
      case "ask.remove":
        this.asks = this.asks.filter((a) => a.id !== msg.id);
        if (this.askSheetId === msg.id) this.closeSheet();
        this.renderAsks();
        this.renderQueue();
        this.renderTabs();
        this.renderSessions();
        break;
      case "pi.status":
        if (this.session && this.session.id === msg.sessionId) this.session = { ...this.session, running: msg.running };
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
        for (const id of gone) this.picked.delete(id);
        if (this.renameId && gone.has(this.renameId)) {
          this.renameId = null;
          this.renameDraft = "";
        }
        if (this.currentId && gone.has(this.currentId)) {
          this.currentId = null;
          this.session = null;
          this.chat.reset([]);
          this.renderAll();
          this.go("sessions", true);
        } else {
          this.renderSessions();
        }
        break;
      }
      case "session.state":
        this.mergeSession(msg.session);
        break;
      case "notice":
        if (!msg.sessionId || msg.sessionId === this.currentId) this.chat.add({ id: `n:${Date.now()}:${Math.random()}`, kind: "notice", text: msg.text, level: msg.level ?? "info" });
        break;
      case "need-stepup":
        this.askStepUp();
        break;
      case "stepup-ok":
        this.closeModal();
        if (this.pending) {
          const run = this.pending;
          this.pending = null;
          run();
        }
        break;
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
    const idx = this.sessions.findIndex((s) => s.id === state.id);
    if (idx >= 0) this.sessions[idx] = state;
    else this.sessions.unshift(state);
    if (this.currentId === state.id) this.session = state;
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
      if (ev.target === modal) this.closeModal();
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
    const text = this.composerText.trim();
    if (!text && !this.images.length) return;
    const payload = { type: "prompt", sessionId: this.currentId, text, images: this.images };
    this.composerText = "";
    this.images = [];
    this.chat.add({ id: `local:${Date.now()}`, kind: "user", text: text || "（图片）", images: [] });
    this.renderChat();
    this.act(() => this.socket.send(payload));
    if (navigator.storage?.persist) void navigator.storage.persist();
  }

  private act(run: () => void): void {
    if (this.me.public) {
      this.pending = run;
      this.socket.send({ type: "stepup", passphrase: "" });
      // empty passphrase fails; the modal takes over
      this.pending = run;
      this.askStepUp();
      return;
    }
    run();
  }

  private decide(approval: ApprovalRequest, decision: "approve" | "reject" | "always"): void {
    this.act(() => this.socket.send({ type: "approve", sessionId: approval.sessionId, approvalId: approval.id, decision }));
    this.approvals = this.approvals.filter((a) => a.id !== approval.id);
    this.renderApprovals();
    this.renderTabs();
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
    if (this.askSheetId) this.askSeen.add(this.askSheetId);
    this.sheet?.remove();
    this.sheet = null;
    this.sheetKind = null;
    this.askSheetId = null;
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

    const sheet = el("div", "sheet");
    const head = el("div", "sheet-head");
    head.append(el("div", "sheet-title", "模型与思考"));
    const close = el("button", "btn ghost", "关闭");
    close.onclick = () => this.closeSheet();
    head.append(close);
    sheet.append(head);

    // Context budget: enforced by the bridge (one auto-compaction per turn when it is blown).
    const budgetBox = el("div", "levels");
    budgetBox.append(el("div", "levels-label", "上下文预算"));
    const budgetChips = el("div", "chips");
    for (const value of BUDGETS) {
      const on = (value ?? null) === (this.budget ?? null);
      const chip = el("button", `chip${on ? " on" : ""}`, value ? compactSize(value) : "不设");
      chip.onclick = () => {
        this.budget = value ?? null;
        this.act(() => this.socket.send({ type: "setBudget", sessionId: this.currentId, budget: value ?? null }));
        for (const other of budgetChips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        this.fillModelChip();
      };
      budgetChips.append(chip);
    }
    budgetBox.append(budgetChips);
    budgetBox.append(el("div", "budget-hint", "用量超过预算时，这轮结束后自动压缩一次。"));
    sheet.append(budgetBox);

    // Switching only works on a session this bridge owns; a terminal-owned one has no rpc child.
    if (this.session && !this.session.owned) {
      const notice = el("div", "takeover warn", "这个会话现在没有写入权，切不了模型。接管之后就正常了——终端里如果有 pi 在写同一个文件，先退出那边。");
      const claim = el("button", "btn primary", "接管会话");
      claim.onclick = () => this.act(() => this.socket.send({ type: "claim", sessionId: this.currentId }));
      notice.append(claim);
      sheet.append(notice);
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

    const current = this.session?.model;
    const list = el("div", "model-list");
    for (const m of this.models) {
      const row = el("button", `model-row${m.id === current ? " on" : ""}`);
      row.append(el("span", "m-name", shortModelName(m.name)));
      const meta = [compactSize(m.contextWindow), m.id].filter(Boolean).join(" · ");
      row.append(el("span", "m-meta", meta));
      if (m.id === current) row.append(el("span", "m-check", "✓"));
      row.onclick = () => {
        this.socket.send({ type: "setModel", sessionId: this.currentId, provider: m.provider, modelId: m.id });
        this.session = this.session ? { ...this.session, model: m.id, modelName: m.name, thinkingLevel: m.levels.includes(this.session.thinkingLevel ?? "") ? this.session.thinkingLevel : m.levels[0] } : this.session;
        this.closeSheet();
        this.renderTop();
      };
      list.append(row);
    }
    sheet.append(list);

    const picked = this.models.find((m) => m.id === current);
    const levels = picked?.levels ?? ["off", "low", "medium", "high"];
    const levelsBox = el("div", "levels");
    levelsBox.append(el("div", "levels-label", "思考档位"));
    const chips = el("div", "chips");
    for (const level of levels) {
      const on = level === this.session?.thinkingLevel;
      const chip = el("button", `chip${on ? " on" : ""}`, level);
      chip.onclick = () => {
        this.socket.send({ type: "setThinking", sessionId: this.currentId, level });
        if (this.session) this.session = { ...this.session, thinkingLevel: level };
        for (const other of chips.querySelectorAll(".chip")) other.classList.toggle("on", other === chip);
        this.renderTop();
      };
      chips.append(chip);
    }
    levelsBox.append(chips);
    sheet.append(levelsBox);

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
    field.value = next;
    const caret = start + command.length;
    field.focus();
    field.setSelectionRange(caret, caret);
    field.style.height = "auto";
    field.style.height = `${Math.min(180, field.scrollHeight)}px`;
  }

  private async newSession(): Promise<void> {
    const cwd = (this.els.newCwd as HTMLInputElement).value.trim() || this.sessions[0]?.cwd || "";
    if (!cwd) {
      alert("先填一个工作目录，例如 F:/pi-web-client");
      return;
    }
    this.act(() => this.socket.send({ type: "create", cwd }));
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
    const host = this.els.sessList;
    // A re-render mid-edit must not eat the caret: remember where it was before the DOM swap.
    const active = document.activeElement as HTMLElement | null;
    const typing = this.renameId != null && active?.classList.contains("rename-input") === true;
    this.renameCaret = typing ? (active as HTMLInputElement).selectionStart : null;
    host.replaceChildren();

    const ordered = [...this.sessions].sort((a, b) => this.arrangeCompare(a, b));
    if (this.renameId && !ordered.some((s) => s.id === this.renameId)) this.renameId = null;
    // A deleted or now-hidden session must not stay "picked".
    for (const id of [...this.picked]) if (!ordered.some((s) => s.id === id)) this.picked.delete(id);

    const visible = ordered.filter((s) => !this.manage.archived.includes(s.id) && this.matchesFilter(s));
    const archived = ordered.filter((s) => this.manage.archived.includes(s.id) && this.matchesFilter(s));
    const pinned = visible.filter((s) => this.manage.pin.includes(s.id));
    const rest = visible.filter((s) => !this.manage.pin.includes(s.id));

    this.els.manageBtn.textContent = this.managing ? "完成" : "管理";
    this.els.manageBtn.classList.toggle("on", this.managing);
    this.els.actions.classList.toggle("managing", this.managing);

    if (!ordered.length) {
      host.append(el("div", "empty", "还没有会话。上面开一个，或在终端里 pi 一下。"));
      this.renderManageActions();
      return;
    }
    if (pinned.length) host.append(this.sessionSection("pin", "置顶", pinned));
    host.append(this.sessionSection("rest", this.manage.pin.length ? "会话" : "会话 · 按创建时间", rest));
    if (!visible.length) host.append(el("div", "empty", this.filter ? "没有匹配的会话。" : "都归档了，展开下面的「已归档」看看。"));
    if (archived.length) host.append(this.sessionSection("archived", "已归档", this.archivedOpen ? archived : []));
    this.renameFocus = false;
    this.renderManageActions();
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
    const picked = this.picked.has(s.id);
    const cls = ["session-card"];
    if (s.id === this.currentId) cls.push("active");
    if (editing) cls.push("editing");
    if (archived) cls.push("archived");
    if (picked) cls.push("picked");
    const card = el("div", cls.join(" "));
    card.dataset.id = s.id;
    // A button cannot host a text field, so the card is a div acting as one.
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const open = () => {
      this.go("chat", true);
      location.hash = `#/s/${s.id}`;
      this.openSession(s.id);
    };
    card.onclick = () => {
      if (editing) return; // clicking the editing card is not "open"
      if (this.managing) {
        if (picked) this.picked.delete(s.id);
        else this.picked.add(s.id);
        this.renderSessions();
        return;
      }
      open();
    };
    card.onkeydown = (ev) => {
      if (ev.target !== card) return; // let the buttons and the input own their keys
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.click();
      }
    };
    if (!this.managing && !this.filter) {
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
    if (this.managing) row.append(el("span", `check${picked ? " on" : ""}`, picked ? "✓" : ""));
    else row.append(el("span", "grip", "⣿"));
    row.append(el("span", `dot ${s.running ? "busy" : s.owned ? "live" : ""}`));
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
      if (!this.managing) {
        const pinned = this.manage.pin.includes(s.id);
        const pin = el("button", `pin-btn${pinned ? " pinned" : ""}`, pinned ? "★" : "☆");
        pin.title = pinned ? "取消置顶" : "置顶";
        pin.setAttribute("aria-label", pin.title);
        pin.onclick = (ev) => {
          ev.stopPropagation();
          this.togglePin(s.id);
        };
        row.append(pin);
        const rename = el("button", "rename-btn", "✎");
        rename.title = "改个名字";
        rename.setAttribute("aria-label", "重命名会话");
        rename.onclick = (ev) => {
          ev.stopPropagation();
          this.startRename(s);
        };
        row.append(rename);
      }
    }
    card.append(row);
    card.append(el("div", "cwd", s.cwd));
    const meta = el("div", "meta");
    meta.append(el("span", "", relativeTime(s.updatedAt)));
    // Bottom-right corner: the one thing worth interrupting for, worst first.
    if (s.asks && s.asks > 0) meta.append(el("span", "badge wait", s.asks > 1 ? `待回答 ${s.asks}` : "待回答"));
    else if (s.approvals > 0) meta.append(el("span", "badge wait", s.approvals > 1 ? `待确认 ${s.approvals}` : "待确认"));
    else if (s.done && s.id !== this.currentId) meta.append(el("span", "badge done", "完成"));
    else if (s.running) meta.append(el("span", "badge run", "运行中"));
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

  private toggleManaging(on?: boolean): void {
    this.managing = on ?? !this.managing;
    if (!this.managing) {
      this.picked.clear();
      this.deleteArm = null;
    }
    this.renderSessions();
  }

  private pickedInOrder(): string[] {
    return this.sessions
      .filter((s) => this.picked.has(s.id))
      .sort((a, b) => this.arrangeCompare(a, b))
      .map((s) => s.id);
  }

  private pinPicked(on: boolean): void {
    const ids = this.pickedInOrder();
    if (!ids.length) return;
    const pin = on ? [...ids, ...this.manage.pin.filter((id) => !ids.includes(id))] : this.manage.pin.filter((id) => !ids.includes(id));
    const order = on ? this.manage.order.filter((id) => !ids.includes(id)) : [...ids, ...this.manage.order.filter((id) => !ids.includes(id))];
    this.sendArrangement(pin, order);
  }

  private archivePicked(): void {
    const ids = this.pickedInOrder();
    if (!ids.length) return;
    const allArchived = ids.every((id) => this.manage.archived.includes(id));
    this.act(() => this.socket.send({ type: "manage", action: "archive", ids, on: !allArchived }));
    this.picked.clear();
    this.deleteArm = null;
    this.renderSessions();
  }

  private deletePicked(): void {
    const ids = this.pickedInOrder();
    if (!ids.length) return;
    const armed = this.deleteArm != null && Date.now() - this.deleteArm.at < 4000 && this.deleteArm.ids.join() === ids.join();
    if (!armed) {
      this.deleteArm = { ids, at: Date.now() };
      this.renderManageActions();
      setTimeout(() => {
        if (this.deleteArm && Date.now() - this.deleteArm.at >= 4000) {
          this.deleteArm = null;
          this.renderManageActions();
        }
      }, 4100);
      return;
    }
    this.deleteArm = null;
    this.act(() => this.socket.send({ type: "manage", action: "delete", ids }));
    this.renderManageActions();
  }

  private renderManageActions(): void {
    const bar = this.els.actions;
    bar.replaceChildren();
    if (!this.managing) return;
    const ids = this.pickedInOrder();
    const what = el("span", "what", ids.length ? `选 ${ids.length} 个` : "点卡片多选");
    const pin = el("button", "btn", "置顶");
    pin.disabled = !ids.length;
    pin.onclick = () => this.pinPicked(true);
    const unpin = el("button", "btn", "取消置顶");
    unpin.disabled = !ids.length;
    unpin.onclick = () => this.pinPicked(false);
    const allArchived = ids.length > 0 && ids.every((id) => this.manage.archived.includes(id));
    const archive = el("button", "btn", allArchived ? "恢复" : "归档");
    archive.disabled = !ids.length;
    archive.onclick = () => this.archivePicked();
    const del = el("button", "btn danger", this.deleteArm ? "再点一次删除" : "删除");
    del.disabled = !ids.length;
    del.onclick = () => this.deletePicked();
    bar.append(what, pin, unpin, archive, del);
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
    const name = this.renameDraft.trim().replace(/\s+/g, " ");
    const before = this.sessions.find((s) => s.id === id)?.name ?? "";
    this.renameId = null;
    this.renameDraft = "";
    // The bridge records the name before it answers, so showing it now is not a lie.
    if (name && name !== before) {
      const target = this.sessions.find((s) => s.id === id);
      if (target) target.name = name;
      if (this.session?.id === id) this.session = { ...this.session, name };
    }
    this.renderSessions();
    if (!name || name === before) return;
    this.act(() => this.socket.send({ type: "rename", sessionId: id, name }));
  }

  private renderChat(): void {
    const host = this.els.composerHost;
    host.replaceChildren();
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
      const claim = el("button", "btn primary", "接管会话");
      claim.onclick = () => this.act(() => this.socket.send({ type: "claim", sessionId: this.currentId }));
      bar.append(claim);
      host.append(bar);
    } else if (s?.owned) {
      const fromWeb = s.origin === "web";
      const bar = el("div", "takeover");
      bar.append(
        el(
          "span",
          "",
          fromWeb
            ? "网页是这个会话的写者。停止后 pi 进程退出，历史留在磁盘，随时能再接管。"
            : "网页是这个会话的写者。要回终端接着聊，先在这里让回去。",
        ),
      );
      const giveBack = el("button", "btn ghost", fromWeb ? "停止运行" : "让回终端");
      giveBack.onclick = () => this.act(() => this.socket.send({ type: "close", sessionId: this.currentId }));
      bar.append(giveBack);
      host.append(bar);
    }

    const row = el("div", "row");
    const input = el("textarea");
    input.placeholder = s?.running ? "跑着呢，再发会自动排队…" : "说点什么…";
    this.textarea = input;
    input.value = this.composerText;
    input.oninput = () => {
      this.composerText = input.value;
      input.style.height = "auto";
      input.style.height = `${Math.min(180, input.scrollHeight)}px`;
    };
    input.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.sendPrompt();
      }
    };

    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.onchange = () => void this.addImages(fileInput.files);

    const attach = el("button", "btn ghost", "图片");
    attach.title = `添加图片（也可以直接 ${PASTE_KEY} 粘贴截图）`;
    attach.onclick = () => fileInput.click();

    const sendBtn = el("button", "btn primary", "发送");
    sendBtn.onclick = () => this.sendPrompt();

    row.append(input, attach, sendBtn);
    if (this.images.length) {
      const badge = this.pendingImagesBadge();
      row.append(badge);
      this.imageBadge = badge;
    }

    const hint = el("div", "hint");
    if (s?.running) {
      hint.append(el("span", "", "pi 正在干活"));
      const stop = el("button", "btn danger", "中断");
      stop.onclick = () => this.act(() => this.socket.send({ type: "abort", sessionId: this.currentId }));
      hint.append(stop);
    } else {
      hint.append(el("kbd", "", "Enter"));
      hint.append(el("span", "", "发送 · Shift+Enter 换行 · "));
      hint.append(el("kbd", "", PASTE_KEY));
      hint.append(el("span", "", " 粘贴截图"));
    }
    const tools = el("div", "hint-tools");
    const skillBtn = el("button", "btn ghost", "技能");
    skillBtn.title = "搜索并插入技能命令（/skill:name）";
    skillBtn.onclick = () => this.openSkillPalette();
    const chip = el("button", "model-chip");
    chip.onclick = () => this.openModelSheet();
    chip.append(el("span", "chip-model", ""), el("span", "chip-ctx", ""), el("span", "chip-rate", ""), el("span", "chip-level", ""));
    this.modelChip = chip;
    tools.append(skillBtn, chip);
    hint.append(tools);
    this.fillModelChip();

    host.append(row, fileInput, hint);
    if (this.approvals.length) host.append(this.approvalNode());

    scrollChat(this.els.scroll);
  }

  private async addImages(files: FileList | readonly File[] | null): Promise<void> {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    for (const file of list) {
      const bitmap = await createImageBitmap(file).catch(() => null);
      const data = await downscale(file, bitmap);
      this.images.push(data);
    }
    this.updateImageBadge();
    this.imageSheetPaint?.();
  }

  /** 待发图片的入口：点一下看缩略图、单张删。 */
  private pendingImagesBadge(): HTMLButtonElement {
    const badge = el("button", "badge image-badge", `+${this.images.length} 图`) as HTMLButtonElement;
    badge.type = "button";
    badge.title = "查看 / 删除待发图片";
    badge.onclick = () => this.openImageSheet();
    return badge;
  }

  /** 不改文字、不重建输入框，只换徽标文字：贴图、删图都走这里。 */  private updateImageBadge(): void {
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
   * 粘贴处理（Ctrl+V / ⌘V）。只接管剪贴板里带图片的情况：
   * - 纯图片（截图/复制的图片）→ 吃掉默认行为，只加图片；
   * - 图片 + 文字（从网页/Office 复制）→ 文字照常插入输入框，图片另存；
   * - 纯文字/文件 → 完全不管，交给浏览器原样处理。
   * 焦点在别的输入框（重命名、口令框）或弹窗里时不抢。
   */
  private onPaste(ev: ClipboardEvent): void {
    if (!this.currentId || document.querySelector(".modal")) return;
    const target = ev.target as HTMLElement | null;
    const targetTag = target?.tagName ?? "";
    const editable = targetTag === "INPUT" || targetTag === "TEXTAREA" || Boolean(target?.isContentEditable);
    if (editable && target !== this.textarea) return;
    const files = imageFilesFrom(ev.clipboardData);
    if (!files.length) return;
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text.trim()) ev.preventDefault();
    void this.addImages(files);
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
  /** The pinned bar above the composer: proof that something is waiting even with the drawer shut. */
  private renderAsks(): void {
    const existing = this.els.composerHost.querySelector(".ask-slot");
    existing?.remove();
    if (!this.asks.length) return;
    const slot = el("div", "ask-slot");
    const first = this.asks[0].questions[0]?.prompt ?? "";
    const more = this.asks.length > 1 ? `（还有 ${this.asks.length - 1} 份）` : "";
    slot.append(el("span", "t", `待你回答${more}`));
    slot.append(el("span", "m", first.slice(0, 60)));
    const go = el("button", "btn primary", "回答");
    go.onclick = () => this.openAskSheet(this.asks[0].id);
    slot.append(go);
    const hintIndex = this.els.composerHost.querySelector(".hint");
    if (hintIndex) this.els.composerHost.insertBefore(slot, hintIndex);
    else this.els.composerHost.append(slot);
  }

  private askCard(ask: AskRequest): HTMLElement {
    const card = el("div", "approval");
    card.append(el("div", "t", ask.questions.length > 1 ? `需要你回答 · ${ask.questions.length} 题` : "需要你回答"));
    card.append(el("div", "m", ask.questions.map((q, i) => `${ask.questions.length > 1 ? `${q.label ?? `Q${i + 1}`}：` : ""}${q.prompt}`).join("\n")));
    const actions = el("div", "actions");
    const go = el("button", "btn primary", "回答");
    go.onclick = () => this.openAskSheet(ask.id);
    const cancel = el("button", "btn danger", "取消这次提问");
    cancel.onclick = () => this.answerAsk(ask, null);
    actions.append(cancel, go);
    card.append(actions);
    return card;
  }

  /** Single question answers on click; several use tabs + an explicit 提交, exactly like the TUI. */
  private openAskSheet(askId: string): void {
    const ask = this.asks.find((a) => a.id === askId);
    if (!ask) return;
    this.closeSheet();
    this.askSheetId = askId;

    const back = el("div", "sheet-back");
    const sheet = el("div", "sheet ask-sheet");
    const head = el("div", "sheet-head");
    const total = ask.questions.length;
    head.append(el("div", "sheet-title", total > 1 ? `需要你回答 · ${total} 题` : "需要你回答"));
    const hide = el("button", "btn ghost", "收起");
    hide.onclick = () => this.closeSheet();
    head.append(hide);
    sheet.append(head);

    const tabsRow = el("div", "ask-tabs");
    const panel = el("div", "ask-panel");
    const foot = el("div", "sheet-foot");
    const drafts = new Map<string, AskAnswer>();
    let active = 0;

    const paint = () => {
      tabsRow.replaceChildren();
      if (total > 1) {
        ask.questions.forEach((q, i) => {
          const label = q.label ?? `Q${i + 1}`;
          const tab = el("button", "ask-tab", `${label}${drafts.has(q.id) ? " ✓" : ""}`);
          if (i === active) tab.classList.add("on");
          if (drafts.has(q.id)) tab.classList.add("done");
          tab.onclick = () => {
            active = i;
            paint();
          };
          tabsRow.append(tab);
        });
      }

      const q = ask.questions[active];
      panel.replaceChildren(el("div", "ask-prompt", q.prompt));
      const chosen = drafts.get(q.id);
      const list = el("div", "ask-opts");
      for (const opt of q.options) {
        const btn = el("button", "ask-opt");
        if (chosen && !chosen.wasCustom && chosen.value === opt.value) btn.classList.add("on");
        btn.append(el("div", "l", opt.label));
        if (opt.description) btn.append(el("div", "d", opt.description));
        btn.onclick = () => {
          const answer: AskAnswer = { id: q.id, value: opt.value, label: opt.label, index: q.options.indexOf(opt) + 1 };
          if (total === 1) {
            this.answerAsk(ask, [answer]);
            return;
          }
          drafts.set(q.id, answer);
          const next = ask.questions.findIndex((x, i) => i > active && !drafts.has(x.id));
          if (next >= 0) active = next;
          paint();
        };
        list.append(btn);
      }
      if (q.allowOther !== false) {
        const other = el("button", "ask-opt other", "自己写…");
        other.onclick = () => {
          const wrap = el("div", "ask-other");
          const input = el("input");
          input.placeholder = "写下你的答案";
          const ok = el("button", "btn primary", "确定");
          const send = () => {
            const text = input.value.trim();
            if (!text) return;
            const answer: AskAnswer = { id: q.id, value: text, label: text, wasCustom: true };
            if (total === 1) {
              this.answerAsk(ask, [answer]);
              return;
            }
            drafts.set(q.id, answer);
            if (active < total - 1) active += 1;
            paint();
          };
          ok.onclick = send;
          input.addEventListener("keydown", (e) => {
            if ((e as KeyboardEvent).key === "Enter") send();
          });
          wrap.append(input, ok);
          other.replaceWith(wrap);
          input.focus();
        };
        list.append(other);
      }
      panel.append(list);

      foot.replaceChildren();
      const cancel = el("button", "btn danger", "取消这次提问");
      cancel.onclick = () => this.answerAsk(ask, null);
      foot.append(cancel);
      if (total > 1) {
        const missing = ask.questions.filter((x) => !drafts.has(x.id)).length;
        const submit = el("button", "btn primary", missing ? `还差 ${missing} 题` : "提交");
        submit.disabled = missing > 0;
        submit.onclick = () => {
          const answers = ask.questions.map((x) => drafts.get(x.id)).filter(Boolean) as AskAnswer[];
          if (answers.length !== total) return;
          this.answerAsk(ask, answers);
        };
        foot.append(submit);
      }
    };

    sheet.append(tabsRow, panel, foot);
    back.append(sheet);
    this.overlay(back);
    this.sheet = back;
    paint();
  }

  /** `null` answers = the user cancelled the whole questionnaire. */
  private answerAsk(ask: AskRequest, answers: AskAnswer[] | null): void {
    const payload = answers
      ? { type: "answer", sessionId: ask.sessionId, askId: ask.id, answers }
      : { type: "answer", sessionId: ask.sessionId, askId: ask.id, answers: [], cancelled: true };
    this.act(() => this.socket.send(payload));
    // Optimistic: `ask.remove` from the bridge has the final say for every other tab.
    this.asks = this.asks.filter((a) => a.id !== ask.id);
    if (this.askSheetId === ask.id) this.closeSheet();
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
    always.onclick = () => this.decide(a, "always");
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
    host.append(el("h2", "", "关于"));
    host.append(el("div", "hint", `pi ${this.me.pi} · bridge ${this.me.version} · ${this.me.sessionsRoot}`));
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
      return;
    }
    main.classList.remove("no-left", "no-right");
    sessionsPane.hidden = this.tab !== "sessions";
    chatPane.hidden = this.tab !== "chat";
    queuePane.hidden = this.tab !== "queue";
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

const DEFAULT_PREFS: Prefs = { scale: 1, accent: "冰蓝", text: "normal" };

/** Context-budget presets in the model sheet; null = no ceiling (use the window). */
const BUDGETS: (number | null)[] = [null, 100_000, 200_000, 500_000, 1_000_000];

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

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

function scrollChat(scrollEl: HTMLElement): void {
  requestAnimationFrame(() => {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });
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
 * 从剪贴板里抖出图片 File。截图粘贴在 Chrome/Safari/Firefox 上都以 file item 出现，
 * 但 Safari 有时只给 files 不给 items，所以两条路都试。
 */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  if (!out.length) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith("image/")) out.push(file);
    }
  }
  return out;
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
