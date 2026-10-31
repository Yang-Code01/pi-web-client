import { diagnose, excerpt, LEVEL_LABEL, normalize, type FailureInput } from "./diagnose.ts";
import { renderMarkdown } from "./md.ts";
import { mountTurnRail, type TurnRail } from "./turns.ts";
import type { Item, ToolItem, UserItem } from "./types.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeOf(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
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
  const label = el("span", "fold-label", "展开");
  head.append(el("span", "chev", "▸"), label);
  head.setOpen = (open: boolean) => {
    head.setAttribute("aria-expanded", String(open));
    label.textContent = open ? "收起" : "展开";
    head.title = open ? "收起" : "展开全文";
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
  private toolCards = new Map<string, HTMLElement>();
  private draftBuffers = new Map<string, { text: string; thinking: string }>();
  /** One collapsed module per turn: every tool call lands here instead of the transcript. */
  private opsBody: HTMLElement | null = null;
  private opsTitle: HTMLElement | null = null;
  private opsBox: HTMLDetailsElement | null = null;
  /** Failures also get a card right after the module, keyed by toolCallId. */
  private failCards = new Map<string, HTMLElement>();
  private failAnchor: HTMLElement | null = null;
  /** Following the stream: new content scrolls the view to the bottom. Cleared the moment the user says "I want to read up there". */
  private following = true;
  /** One pending frame at most — a burst of updates must cost one scroll, not one per update. */
  private pendingScroll = 0;
  /** Something arrived while the user was reading up top. */
  private unread = false;
  private jump: HTMLButtonElement;
  /** Files the agent wrote or edited in this session, latest last. */
  private written = new Map<string, { tool: string; at: number }>();
  /** Assistant replies the user folded; kept across rebuilds and session re-renders. */
  private collapsed = new Set<string>();
  /** Live view of the running tool call — nothing here is rendered in the transcript. */
  private live: LiveInfo = {};
  /** Which tool call the live output belongs to; a stale update must not overwrite a newer tool. */
  private liveKey = "";
  /** This turn's written files, as chips under the ops module. */
  private opsFiles: HTMLElement | null = null;
  /** The user turns, in order — one tick on the rail each. `reset()` refills it through `add()`. */
  private turns: { node: HTMLElement; label: string }[] = [];
  /** 右缘的轮次缩略图（Q-028）。它挂在滚动视口外面，所以不会随之滚走。 */
  private turnRail: TurnRail;
  /** 缩略图里悬停/点击时在正文高亮的那条消息。 */
  private flashNode: HTMLElement | null = null;
  private flashTimer = 0;
  private railPending = 0;
  /** 跳转时的平滑滚动还在路上 —— 这期间的 scroll 事件不能当成「用户回到底部」把跟流重新打开。 */
  private holdFollow = 0;

  constructor(private root: HTMLElement) {
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
      onHover: (index) => this.flashTurn(index),
      viewport: this.root,
    });

    // Intent first: a wheel/touch event is what the user meant, long before the (async, frame-coalesced)
    // scroll event lands. Waiting for `scroll` let the burst that was already in flight drag the view
    // back down — that was the "一卡一卡" tug of war.
    root.addEventListener("wheel", (ev) => {
      if ((ev as WheelEvent).deltaY < 0) this.stopFollowing();
    }, { passive: true });
    let touchY: number | null = null;
    root.addEventListener("touchstart", (ev) => {
      touchY = (ev as TouchEvent).touches[0]?.clientY ?? null;
    }, { passive: true });
    root.addEventListener("touchmove", (ev) => {
      const y = (ev as TouchEvent).touches[0]?.clientY ?? null;
      // Finger moving down means the content is moving up: the user is reading history.
      if (touchY !== null && y !== null && y - touchY > 6) this.stopFollowing();
      touchY = y;
    }, { passive: true });
    root.addEventListener("keydown", (ev) => {
      const key = (ev as KeyboardEvent).key;
      if (key === "PageUp" || key === "ArrowUp" || key === "Home") this.stopFollowing();
    });

    root.addEventListener("scroll", () => {
      if (performance.now() >= this.holdFollow && this.nearBottom()) this.resumeFollowing();
      this.queueRailSync();
    });

    // The composer grows and shrinks under the transcript; while following, that must not unstick us.
    new ResizeObserver(() => {
      if (this.following) this.scheduleScroll();
    }).observe(root);
  }

  /** Distance left below the viewport, in px. Small enough that "at the bottom" means what it says. */
  private nearBottom(): boolean {
    const gap = this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight;
    return gap <= 24;
  }

  private stopFollowing(): void {
    if (!this.following) return;
    this.following = false;
    this.renderJump();
  }

  private resumeFollowing(): void {
    if (this.following && !this.unread) return;
    this.following = true;
    this.unread = false;
    this.renderJump();
  }

  private renderJump(): void {
    this.jump.classList.toggle("has-new", this.unread);
    this.jump.hidden = this.following;
    // The visible text is a glyph, so the meaning has to live somewhere readable.
    const label = this.unread ? "有新内容，回到底部" : "回到底部";
    this.jump.title = label;
    this.jump.setAttribute("aria-label", label);
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
  }

  /** 缩略图的那一下跳动不该每滚动一下就算一遍，一帧一次。 */
  private queueRailSync(): void {
    if (this.railPending) return;
    this.railPending = requestAnimationFrame(() => {
      this.railPending = 0;
      const last = this.turns.length - 1;
      if (last < 0) return;
      // 「你在哪一轮」= 视口顶部已经翻过去的最后一轮；已经在底部就是最后一轮。
      let at = 0;
      if (!this.nearBottom()) {
        const base = this.root.getBoundingClientRect().top + 72;
        for (let i = 0; i <= last; i++) {
          const node = this.turns[i].node;
          if (node.isConnected && node.getBoundingClientRect().top > base) break;
          at = i;
        }
      } else at = last;
      this.turnRail.setCurrent(at);
    });
  }

  /** 点缩略图里的一行：把那一轮滚到视口顶部（最后一轮则直接回到底部继续跟流）。 */
  private jumpToTurn(index: number): void {
    const turn = this.turns[index];
    if (!turn || !turn.node.isConnected) return;
    this.flashTurn(index, 1200);
    if (index === this.turns.length - 1) {
      this.follow();
      return;
    }
    this.stopFollowing();
    if (this.pendingScroll) cancelAnimationFrame(this.pendingScroll);
    this.pendingScroll = 0;
    // 从底部往上跳的第一帧 scroll 事件里，视口其实还没离开底部；不挡住它就会立刻 resumeFollowing。
    this.holdFollow = performance.now() + 900;
    const top = turn.node.getBoundingClientRect().top - this.root.getBoundingClientRect().top + this.root.scrollTop - 6;
    this.root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  /** 悬停预览：正文里给对应那条用户消息描一圈边（`ms` > 0 时自己消失，用于点击后的短暂标记）。 */
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

  /** 一轮用户输入 = 缩略图上的一根刻度。`reset()` 也会经由 `add()` 走到这里。 */
  private noteTurn(item: UserItem, node: HTMLElement): void {
    const one = (item.text ?? "").replace(/\s+/g, " ").trim();
    const images = item.images?.length ?? 0;
    const label = one || (images ? `（${images} 张图片）` : "（空消息）");
    this.turns.push({ node, label });
    this.turnRail.add(label);
    this.queueRailSync();
  }

  private scheduleScroll(): void {
    if (this.pendingScroll) return;
    this.pendingScroll = requestAnimationFrame(() => {
      this.pendingScroll = 0;
      // Re-checked at execution time: the user may have scrolled away while this frame was queued.
      if (!this.following) return;
      this.root.scrollTop = this.root.scrollHeight;
    });
  }

  /** Everything the transcript appends goes in *before* the jump button, which must stay the last child. */
  private push(node: HTMLElement): void {
    this.root.insertBefore(node, this.jump);
  }

  /** Keeps the tail marker and the jump button children of the scroller no matter how it is rebuilt. */
  private mountChrome(): void {
    this.root.append(this.jump);
  }

  reset(items: Item[]): void {
    this.root.replaceChildren();
    this.cards.clear();
    this.toolCards.clear();
    this.draftBuffers.clear();
    this.opsBody = null;
    this.opsTitle = null;
    this.opsBox = null;
    this.failCards.clear();
    this.failAnchor = null;
    this.written.clear();
    this.opsFiles = null;
    this.live = {};
    this.liveKey = "";
    this.turns = [];
    this.turnRail.clear();
    this.flashTurn(null);
    // Chrome first: `push()` inserts before the jump button, so it has to be in the DOM already.
    this.mountChrome();
    for (const item of items) this.add(item);
    this.follow();
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

  add(item: Item): void {
    // a user message opens a new turn: its tool calls get their own module
    if (item.kind === "user") this.closeOps();
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
        this.mergeTool(existing, item);
        return;
      }
    }
    const node = this.build(item);
    this.cards.set(item.id, node);
    if (item.kind === "tool") {
      this.toolCards.set(item.toolCallId, node);
      if (this.isAskTool(item.name)) this.push(node);
      else {
        this.ensureOps().append(node);
        this.refreshOps();
        this.noteWrite(item.name, item.args);
      }
      if (!this.isAskTool(item.name) && (item.isError || item.status === "error")) this.failFromItem(item);
    } else {
      this.push(node);
      if (item.kind === "user") this.noteTurn(item, node);
    }
    this.scrollToEnd();
  }

  replace(id: string, item: Item): void {
    const node = this.cards.get(id);
    this.draftBuffers.delete(id);
    if (!node) {
      this.add(item);
      return;
    }
    const rebuilt = this.build(item);
    if (item.kind === "tool" && this.isAskTool(item.name)) {
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
    }
    this.scrollToEnd();
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
    }
    // reasoning is buffered but never painted: the transcript shows prose and tool calls only
    this.scrollToEnd();
  }

  toolEvent(phase: "start" | "update" | "end", data: any): void {
    const key = String(data.toolCallId ?? "");
    if (!key) return;
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
      if (cmd && data.summary) cmd.textContent = String(data.summary);
      const status = card.querySelector<HTMLElement>(".status");
      if (status) status.textContent = "运行中…";
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
      if (status) status.textContent = data.isError ? "失败" : `${Math.round(Number(data.durationMs ?? 0) / 100) / 10}s`;
      if (data.result) {
        let out = card.querySelector<HTMLElement>(".out");
        if (!out) {
          out = el("div", "out");
          card.append(out);
        }
        out.textContent = String(data.result);
      }
      const details = card.querySelector<HTMLDetailsElement>("details");
      if (details) details.open = Boolean(data.isError);
      if (data.isError) {
        const name = card.querySelector(".name")?.textContent?.trim() || String(data.name ?? "tool");
        const cmd = card.querySelector(".cmd")?.textContent?.trim() || "";
        this.failureCard(key, { tool: name, cmd, out: String(data.result ?? "") }, Number(data.durationMs ?? 0));
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
      if (typeof summary === "string") cmd.textContent = summary;
    }
    const status = card.querySelector<HTMLElement>(".status");
    if (status && item.status && item.status !== "unknown") status.textContent = item.status === "error" ? "失败" : "完成";
    if (item.result) {
      let out = card.querySelector<HTMLElement>(".out");
      if (!out) {
        out = el("div", "out");
        card.append(out);
      }
      out.textContent = item.result;
    }
    if (item.isError) card.classList.add("err");
    if (item.status && item.status !== "unknown" && item.status !== "running") card.dataset.running = "0";
    this.refreshOps();
    if (item.isError || item.status === "error") this.failFromItem(item);
  }

  private failFromItem(item: ToolItem): void {
    this.failureCard(
      item.toolCallId,
      { tool: item.name, cmd: toolSummary(item), out: String(item.result ?? item.partialResult ?? "") },
      item.durationMs,
    );
  }

  /**
   * A failure is useless when it is buried inside a collapsed module: each one also gets its own
   * card right after the module — what happened, why, what next, and the few lines that prove it.
   * Keyed by toolCallId so a live run and a replayed session render identically; a repeat call
   * rebuilds the card in place (the store may fill in the result after the error is reported).
   */
  private failureCard(key: string, input: FailureInput, ms?: number): void {
    const next = buildFailureCard(input, ms);
    const prev = this.failCards.get(key);
    // A rebuild must not slam the card or the raw log shut under the cursor: carry the user's expand over.
    if (prev?.hasAttribute("open")) next.setAttribute("open", "");
    if (prev?.querySelector("details.raw")?.hasAttribute("open")) {
      next.querySelector("details.raw")?.setAttribute("open", "");
    }
    if (prev && prev.parentNode) {
      prev.replaceWith(next);
    } else {
      const anchor = this.failAnchor && this.failAnchor.parentNode === this.root ? this.failAnchor : null;
      const box = this.opsBox;
      if (anchor) anchor.after(next);
      else if (box && box.parentNode === this.root) box.after(next);
      else this.push(next);
    }
    this.failCards.set(key, next);
    this.failAnchor = next;
    this.scrollToEnd();
  }

  private build(item: Item): HTMLElement {
    if (item.kind === "notice") {
      const node = el("div", `notice ${item.level ?? ""}`, item.text);
      return node;
    }
    if (item.kind === "tool") return this.buildTool(item);

    const wrap = el("div", `msg ${item.kind}`);
    const who = el("div", "who");
    if (item.kind === "user") {
      who.textContent = `你 · ${timeOf(item.ts)}`;
      wrap.append(who, this.foldable(this.buildUserBody(item), 240));
    } else {
      who.textContent = `${item.model ?? "pi"} · ${timeOf(item.ts)}${item.stopReason === "aborted" ? " · 已中断" : ""}`;
      wrap.append(who);
      // A message that only carries thinking/tool calls has no prose to show:
      // an empty bubble there is pure noise. `delta()` appends `.stream` itself,
      // and removes `.no-text` so the header reappears with the first token.
      if ((item.text || "").trim()) {
        const body = el("div", "body");
        body.append(renderMarkdown(item.text));
        const peek = el("button", "msg-peek", previewLine(item.text));
        peek.title = "展开回答";
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
        };
        fold.onclick = toggle;
        peek.onclick = toggle;
        apply(this.collapsed.has(id));
        who.append(fold);
        wrap.append(body, peek);
      } else {
        wrap.classList.add("no-text");
      }
    }
    return wrap;
  }

  /** Close the current turn's tool module: the next tool call starts a fresh one. */
  private closeOps(): void {
    this.opsBody = null;
    this.opsTitle = null;
    this.opsBox = null;
    this.failAnchor = null;
    this.opsFiles = null;
  }

  /** Files written or edited so far, newest first. */
  artifacts(): { path: string; tool: string }[] {
    return [...this.written.entries()].reverse().map(([path, v]) => ({ path, tool: v.tool }));
  }

  /** A write/edit lands in the session's artifact list and as a chip under this turn's module. */
  private noteWrite(name: unknown, args: unknown): void {
    const tool = String(name ?? "").toLowerCase();
    if (!WRITE_TOOLS.has(tool)) return;
    const path = toolPath(args);
    if (!path) return;
    this.written.delete(path);
    this.written.set(path, { tool, at: Date.now() });
    const box = this.opsBox;
    if (!box || box.parentNode !== this.root) return;
    if (!this.opsFiles || !this.opsFiles.isConnected) {
      this.opsFiles = el("div", "ops-files");
      this.opsFiles.append(el("span", "ops-files-label", "产物"));
      box.after(this.opsFiles);
      if (this.failAnchor === null) this.failAnchor = this.opsFiles;
    }
    const files = this.opsFiles;
    if ([...files.querySelectorAll<HTMLElement>(".file-chip")].some((c) => c.dataset.path === path)) return;
    const chip = el("button", "file-chip");
    chip.dataset.path = path;
    chip.title = `预览 ${path}`;
    chip.append(el("span", "ico", fileIcon(path)), el("span", "nm", baseName(path)));
    chip.onclick = () => openPreview(path);
    files.append(chip);
  }

  /** Lazily create the `<details>` that collects this turn's tool calls. */
  private ensureOps(): HTMLElement {
    if (this.opsBody) return this.opsBody;
    const box = el("details", "ops");
    const summary = el("summary", "ops-summary");
    const title = el("span", "ops-title", "工具操作");
    summary.append(el("span", "chev", "▸"), title);
    const body = el("div", "ops-body");
    box.append(summary, body);
    this.push(box);
    this.opsBody = body;
    this.opsTitle = title;
    this.opsBox = box;
    return body;
  }

  /** Recount the module title from the cards actually in the DOM. */
  private refreshOps(): void {
    const body = this.opsBody;
    const title = this.opsTitle;
    if (!body || !title) return;
    const cards = Array.from(body.children).filter(
      (n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("tool"),
    );
    if (!cards.length) return;
    const counts = new Map<string, number>();
    let errors = 0;
    let running = 0;
    for (const card of cards) {
      const name = card.querySelector(".name")?.textContent?.trim() || "tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (card.classList.contains("err")) errors += 1;
      if (card.dataset.running === "1") running += 1;
    }
    const parts = [...counts].map(([name, n]) => `${name} ×${n}`);
    title.replaceChildren(document.createTextNode(`${cards.length} 个操作 · ${parts.join(" · ")}`));
    if (errors) title.append(el("span", "ops-flag err", ` · ${errors} 失败`));
    if (running) title.append(el("span", "ops-flag live", " · 运行中"));
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

  private buildUserBody(item: UserItem): HTMLElement {    const body = el("div", "body");
    body.textContent = item.text;
    if (item.images?.length) {
      const tag = el("div", "notice", `附 ${item.images.length} 张图片`);
      body.append(tag);
    }
    return body;
  }

  private buildTool(item: ToolItem): HTMLElement {
    if (this.isAskTool(item.name)) return this.buildAsk(item);
    const card = el("div", "tool");
    card.dataset.running = item.status === "running" ? "1" : "0";
    if (item.isError || item.status === "error") card.classList.add("err");
    const head = el("div", "head");
    head.append(el("span", "name", item.name));
    head.append(el("span", "cmd", toolSummary(item)));
    head.append(el("span", "status", item.status === "running" ? "运行中…" : item.isError ? "失败" : ""));
    const path = toolPath(item.args);
    if (path) {
      const view = el("button", "tool-preview", "预览");
      view.title = `预览 ${path}`;
      view.onclick = (ev) => {
        ev.stopPropagation();
        openPreview(path);
      };
      head.append(view);
    }
    card.append(head);

    if (item.result || item.partialResult) {
      const out = el("div", "out");
      out.textContent = String(item.result ?? item.partialResult ?? "");
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
  /** The two tools whose transcript entry is a question card, not an entry of the ops module. */
  private isAskTool(name: unknown): boolean {
    const n = String(name ?? "");
    return n === "question" || n === "questionnaire";
  }

  private buildAsk(item: ToolItem): HTMLElement {
    const card = el("div", "tool qa-card");
    card.dataset.running = item.status === "running" ? "1" : "0";

    const args = (item.args ?? {}) as any;
    const single = item.name === "question";
    const questions: any[] = single
      ? [{ id: "q1", label: "Q1", prompt: args.question, options: args.options, allowOther: true }]
      : Array.isArray(args.questions)
        ? args.questions
        : [];
    const pending = item.status === "running";

    const head = el("div", "head");
    head.append(el("span", "name", single ? "提问" : `问卷 · ${questions.length} 题`));
    head.append(el("span", "status", pending ? "等你回答…" : ""));
    card.append(head);

    const answers = parseAskResult(String(item.result ?? item.partialResult ?? ""), questions, single);
    const body = el("div", "qa-body");
    questions.forEach((q, i) => {
      const row = el("div", "qa-q");
      if (questions.length > 1) row.append(el("div", "qa-label", String(q?.label ?? `Q${i + 1}`)));
      row.append(el("div", "qa-prompt", String(q?.prompt ?? "")));
      const hit = answers[i];
      if (hit) row.append(el("div", "qa-a", `✓ ${hit}`));
      else if (!pending) {
        const cancelled = /cancel|取消/i.test(String(item.result ?? ""));
        row.append(el("div", "qa-a pending", cancelled ? "已取消" : "未回答"));
      }
      body.append(row);
    });
    card.append(this.foldable(body, 220));
    if (pending) {
      card.classList.add("clickable");
      card.title = "点一下打开答题";
      card.onclick = () => window.dispatchEvent(new CustomEvent("pi-ask-open"));
    }
    return card;
  }
}

function durationText(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return `${Math.round(ms / 100) / 10}s`;
}

/**
 * The failure card: `EXIT n` + one-sentence title, then why / next, then only the key lines of
 * the output (see `excerpt`), with the raw text folded underneath. Folded by default: the summary
 * row (exit code, title, command) is the conclusion, the rest is one click away — a long run of
 * failures must not push the conversation off screen. `benign` / `abort` failures fade to a gray
 * card so a run of grep misses does not read like an emergency.
 */
function buildFailureCard(input: FailureInput, ms?: number): HTMLElement {
  const d = diagnose(input);
  const calm = d.level === "benign" || d.level === "abort";
  const card = el("details", calm ? "fcard calm" : "fcard");

  const top = el("summary", "top");
  top.append(
    el("span", "chev", "▸"),
    el("span", "badge", d.exit === null ? LEVEL_LABEL[d.level] : `EXIT ${d.exit}`),
    el("span", "ttl", d.title),
    el("span", "sum-cmd", input.cmd ? `${input.tool} · ${input.cmd}` : input.tool),
  );
  const grid = el("div", "grid");
  grid.append(
    el("span", "k", "为什么"), el("span", "v", d.cause || "—"),
    el("span", "k", "下一步"), el("span", "v", d.next || "—"),
  );
  const cmdbar = el("div", "cmdbar");
  cmdbar.append(el("span", "dot", "▪"), el("span", "c", input.cmd ? `${input.tool} · ${input.cmd}` : input.tool));
  card.append(top, grid, cmdbar);

  const { lines, keep } = excerpt(input.out);
  if (keep.length) {
    const body = el("div", "body");
    let prev = -1;
    for (const [i, hit] of keep) {
      if (prev >= 0 && i > prev + 1) body.append(el("div", "gap", `… 跳过 ${i - prev - 1} 行`));
      const row = el("div", hit ? "ln hit" : "ln");
      row.append(el("span", "no", String(i + 1)), el("span", "tx", lines[i] || " "));
      body.append(row);
      prev = i;
    }
    const ex = el("div", "ex");
    ex.append(body);
    card.append(ex);
  }

  const raw = normalize(input.out) || "（没有输出）";
  const meta = [keep.length ? `关键行 ${keep.length} 行` : "输出为空，只有退出码", durationText(ms)].filter(Boolean);
  const foot = el("div", "foot");
  const rawBox = el("details", "raw");
  const rawTop = el("summary", "raw-top");
  rawTop.append(el("span", "chev", "▸"), el("span", undefined, `完整输出（${raw.length} 字符）`));
  rawBox.append(rawTop, el("pre", undefined, raw));
  foot.append(el("span", undefined, meta.join(" · ")), rawBox);
  card.append(foot);
  return card;
}

/**
 * Answers come back as text, not structured fields: `User selected: 2. Label` / `User wrote: …` for
 * `question`, `Q1: user selected: 2. Label` / `Q1: user wrote: …` for `questionnaire`.
 */
function parseAskResult(text: string, questions: any[], single: boolean): (string | null)[] {
  const out: (string | null)[] = questions.map(() => null);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (single) {
    const wrote = lines.find((l) => l.startsWith("User wrote: "));
    const selected = lines.find((l) => l.startsWith("User selected: "));
    if (wrote) out[0] = `（自己写）${wrote.slice("User wrote: ".length)}`;
    else if (selected) out[0] = selected.replace(/^User selected: \d+\.\s*/, "");
    return out;
  }
  questions.forEach((q, i) => {
    const label = String(q?.label ?? `Q${i + 1}`);
    const line = lines.find((l) => l.startsWith(`${label}: `));
    if (!line) return;
    const rest = line.slice(label.length + 2);
    const wrote = rest.match(/^user wrote:\s*(.*)$/);
    const selected = rest.match(/^user selected:\s*\d+\.\s*(.*)$/);
    if (wrote) out[i] = `（自己写）${wrote[1]}`;
    else if (selected) out[i] = selected[1];
  });
  return out;
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
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/[#>*_`|~-]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 120 ? `${plain.slice(0, 120)}…` : plain || "（已收起）";
}
