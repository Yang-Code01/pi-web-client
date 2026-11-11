/**
 * 随手问（#86）：顶栏那个「问一句就走」的 dialog。
 *
 * 它**不是**会话的一种展示方式——桥那边它是一个 `scratch` 会话：不进列表、有自己的休眠时间、
 * 不参与内存水位、也永远不会被自动压缩。这里只负责那个 dialog：
 *
 * - 第一次打开才发 `scratch.open`（桥那边懒建 pi，第一次要等 1–3 秒）；
 * - 关掉只是收起视图，进程和对话都还在；
 * - 「清空」= `scratch.clear`，桥在同一个 pi 进程里换一条新会话，所以不用等重启；
 * - 上下文一路累积、只提醒不自动清：提醒线按「离 pi 自动压缩还有多远」算，不用固定百分比
 *   （32k 窗口的模型上，固定 60% 已经晚了）。
 */
import { createEl as el } from "./chat.ts";
import { renderMarkdown } from "./md.ts";
import { fillUserBody } from "./skill.ts";
import { tr } from "./i18n/index.ts";
import { groupModels, modelGroupSection } from "./modelgroups.ts";
import type { Item, ModelInfo, SessionState } from "./types.ts";

export interface ScratchHost {
  send(msg: unknown): void;
  /** 可切的模型（App 手上的目录），空数组表示还没加载完。 */
  models(): ModelInfo[];
}

/** pi 在 `contextTokens > contextWindow - reserveTokens` 处自动压缩；reserve 默认 16384。 */
const RESERVE_TOKENS = 16384;
/** 模型目录还没到时的兜底档位（与 pi 的 /thinking 全集一致）。 */
const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** 弱提醒 / 强提醒：占「离自动压缩还剩多少」的比例。 */
const WARN_AT = 0.75;
const STRONG_AT = 0.92;

/** `["a","b","b","c"]` → `"a · b ×2 · c"`：连续同名折叠，不同名按顺序留着。 */
function summarizeTools(names: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < names.length; ) {
    let n = 1;
    while (i + n < names.length && names[i + n] === names[i]) n += 1;
    parts.push(n > 1 ? `${names[i]} ×${n}` : names[i]);
    i += n;
  }
  return parts.join(" · ");
}

function textOf(item: Item): string {
  if (item.kind === "user" || item.kind === "assistant") return item.text ?? "";
  return "";
}

/** One row in the transcript. Tools and notices get a one-liner; only prose is rendered as markdown. */
function row(item: Item): HTMLElement {
  const wrap = el("div", `sc-row sc-${item.kind}`);
  if (item.kind === "user") {
    // 与聊天区同一套画法：技能调用的命令是药丸，自己写的话跟在后面（skill.ts）。
    const text = el("div", "sc-text");
    fillUserBody(text, item);
    wrap.append(el("div", "sc-who", tr("我")), text);
    return wrap;
  }
  if (item.kind === "assistant") {
    const text = textOf(item);
    // pi 每调一次工具都会冒一条「文字为空、只有工具调用」的 assistant 消息：这类行不在
    // 正文里占一行，但**要留在 DOM 里**——它决定了后面工具行和正文的先后顺序。
    if (!text.trim()) wrap.classList.add("sc-step");
    const who = el("div", "sc-who", tr("随手问"));
    // 真正答这段话的模型（pi 记在这条消息上）。chip 显示的是「当前选的」，模型自己说的话
    // 不算数 —— 它只会去读 settings.json 的默认值。这里把它钉在每段开头。
    const model = (item as { model?: string }).model;
    if (model) who.append(el("span", "sc-model", ` · ${model}`));
    wrap.append(who);
    const body = el("div", "sc-text md");
    if (text.trim()) body.append(renderMarkdown(text));
    wrap.append(body);
    return wrap;
  }
  if (item.kind === "skill") {
    // 随手问里的隐式技能：一行就够（这里没有卡片的位置，也不该为它拆条），名字与“自动加载”跟聊天区同一套叫法。
    const line = el("div", "sc-twoline", "🧩 ");
    line.append(tr("技能"), " · ", item.name);
    wrap.append(line);
    return wrap;
  }
  if (item.kind === "tool") {
    wrap.dataset.tool = item.name;
    wrap.append(el("div", "sc-twoline", `🔧 ${item.name}`));
    return wrap;
  }
  if (item.kind === "notice") {
    wrap.append(el("div", "sc-twoline", String((item as { text?: string }).text ?? "")));
    return wrap;
  }
  return wrap;
}

export class ScratchChat {
  private readonly host: ScratchHost;
  private root: HTMLElement | null = null;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private hintEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private staticHintEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private modelEl!: HTMLButtonElement;
  private modelMenu!: HTMLElement;
  private remindEl!: HTMLElement;
  private reclaimEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private pauseBtn!: HTMLButtonElement;
  private closeBtn!: HTMLButtonElement;

  private id: string | null = null;
  private state: SessionState | null = null;
  private items: Item[] = [];
  private rows = new Map<string, HTMLElement>();
  private running = false;
  private starting = false;
  private error = "";
  private pendingText: string | null = null;
  private pendingSessionId: string | null = null;
  private recovering = false;
  private dismissedReclaimId: string | null = null;
  private tokens: number | null = null;
  private window: number | null = null;
  private remindDismissed = false;
  /** 已经发过 open：关掉 dialog 再打开不该再问一遍桥。 */
  private asked = false;

  constructor(host: ScratchHost) {
    this.host = host;
  }

  /** The scratch session id, if it has been opened in this page's lifetime. */
  get sessionId(): string | null {
    return this.id;
  }

  open(): void {
    if (!this.root) this.build();
    this.root!.hidden = false;
    if (!this.asked) {
      this.asked = true;
      this.starting = true;
      this.host.send({ type: "scratch.open" });
    }
    this.paintState();
    this.inputEl.focus();
  }

  close(): void {
    if (this.root) this.root.hidden = true;
  }

  get isOpen(): boolean {
    return Boolean(this.root && !this.root.hidden);
  }

  /**
   * 断线重连（或桥重启）：本地状态一律作废，重新问桥一次。桥还在的话它会原样把快照发回来
   * （对话接上）；桥重启过的话，那边已经是空的——这也正是「重启即清空」在页面上的样子。
   */
  reconnect(): void {
    this.asked = false;
    this.id = null;
    this.items = [];
    this.rows.clear();
    this.tokens = null;
    this.window = null;
    this.running = false;
    this.starting = true;
    this.error = "";
    this.remindDismissed = false;
    if (this.root) {
      this.repaint();
      this.paintState();
    }
    if (this.isOpen) this.open();
  }

  /** Consume one bridge frame; false means "not mine". */
  handle(msg: any): boolean {
    const mine = typeof msg?.sessionId === "string" && msg.sessionId === this.id;
    switch (msg?.type) {
      case "scratch": {
        const wasPaused = this.state?.paused === true;
        this.id = String(msg.sessionId ?? "") || null;
        this.starting = false;
        this.error = "";
        const state = msg.state as SessionState | undefined;
        const hadPauseNotice = this.items.some((item) => item.id === `scratch-paused-${this.id}`);
        this.state = state ?? null;
        this.running = Boolean(state?.running);
        this.items = Array.isArray(msg.items) ? (msg.items as Item[]) : [];
        if (state?.paused && (state.file || this.items.length) && (hadPauseNotice || !wasPaused)) this.addPauseNotice();
        if (this.recovering) {
          this.recovering = false;
          this.upsert({ id: `scratch-reopened-${this.id}`, kind: "notice", text: tr("会话没了，已开新的，接着问"), level: "info" });
        }
        this.repaint();
        this.paintState();
        if (this.pendingText && !state?.paused && this.pendingSessionId !== this.id) {
          this.pendingSessionId = this.id;
          this.host.send({ type: "prompt", sessionId: this.id, text: this.pendingText });
        }
        return true;
      }
      case "items":
        if (!mine) return false;
        this.items = Array.isArray(msg.items) ? (msg.items as Item[]) : [];
        this.repaint();
        return true;
      case "item.add":
        if (!mine) return false;
        this.upsert(msg.item as Item);
        if (msg.item?.kind === "user" && this.pendingText && String(msg.item.text ?? "").trim() === this.pendingText) {
          if (this.inputEl.value.trim() === this.pendingText) this.inputEl.value = "";
          this.pendingText = null;
          this.pendingSessionId = null;
          this.paintState();
        }
        this.scroll();
        return true;
      case "item.replace":
        if (!mine) return false;
        // 桥的语义是「旧的 id 换成这个 item」：新 item 自己的 id 与 msg.id 不同（draft:N → live:N）。
        // 按 msg.id 删旧的，再加上新的，否则同一条回答会出现两遍。
        this.drop(String(msg.id ?? ""));
        this.upsert(msg.item as Item);
        return true;
      case "item.remove":
        if (!mine) return false;
        this.drop(String(msg.id ?? ""));
        return true;
      case "delta":
        if (!mine) return false;
        this.delta(String(msg.id ?? ""), String(msg.field ?? "text"), String(msg.text ?? ""));
        return true;
      case "stats":
        if (!mine) return false;
        this.tokens = typeof msg.context?.tokens === "number" ? msg.context.tokens : null;
        this.window = typeof msg.context?.contextWindow === "number" ? msg.context.contextWindow : this.window;
        this.paintState();
        return true;
      case "session.state": {
        // 这一帧没有 sessionId，只有 session.id —— 按 sessionId 比就永远匹配不上，
        // 结果切了模型名字不变、状态行也不动。
        const st = msg.session as SessionState | undefined;
        if (!st || st.id !== this.id) return false;
        const wasPaused = this.state?.paused === true;
        this.state = { ...(this.state ?? ({} as SessionState)), ...st };
        if (st.paused && !wasPaused) this.addPauseNotice();
        if (st.running !== undefined) this.running = Boolean(st.running);
        if (st.starting !== undefined) this.starting = Boolean(st.starting);
        this.paintState();
        return true;
      }
      case "notice":
        if (!mine) return false;
        this.upsert({
          id: msg.code === "scratch_paused" ? `scratch-paused-${this.id}` : `n:${Date.now()}:${Math.random()}`,
          kind: "notice",
          text: msg.code === "scratch_paused" ? tr("已暂停") : String(msg.text ?? ""),
        } as Item);
        return true;
      case "error":
        if (msg.code === "session_not_found" && mine) {
          if (this.dismissedReclaimId !== this.id) this.reclaimEl.hidden = false;
          if (this.state?.paused) {
            this.error = tr("随手问已暂停，恢复后可以接着问");
            this.releasePending();
          } else {
            this.recovering = true;
            this.pendingSessionId = null;
            this.id = null;
            this.state = null;
            this.items = [];
            this.rows.clear();
            this.running = false;
            this.starting = false;
            this.asked = false;
            this.error = "";
            this.open();
          }
          this.paintState();
          return true;
        }
        // 与当前会话无关的错误也可能是随手问的启动失败（桥那边 target 不到会话时没有 sessionId）。
        if (mine || (this.asked && !msg.sessionId)) {
          this.starting = false;
          this.error = String(msg.message ?? tr("启动失败"));
          this.releasePending();
          this.paintState();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- internals

  private build(): void {
    const back = el("div", "sheet-back scratch-back");
    back.onclick = (ev) => {
      if (ev.target === back) this.close();
    };
    const sheet = el("div", "sheet scratch-sheet");
    sheet.onkeydown = (ev) => {
      if (ev.key !== "Escape") return;
      // 模型菜单开着时，Esc 先关菜单（不然一下关掉整个 dialog 很意外）。
      if (this.modelMenu && !this.modelMenu.hidden) this.modelMenu.hidden = true;
      else this.close();
    };

    const head = el("div", "sheet-head scratch-head");
    this.titleEl = el("div", "sheet-title", tr("随手问"));
    this.stateEl = el("span", "scratch-state", "");
    // 模型是会话的属性：dialog 里不给切换，就变成「只能问、不能挑」。
    this.modelEl = el("button", "btn ghost scratch-model-chip", "") as HTMLButtonElement;
    this.modelEl.title = tr("切模型");
    this.modelEl.onclick = (ev) => {
      ev.stopPropagation();
      this.toggleModels();
    };
    head.append(this.titleEl, this.stateEl, el("div", "grow"), this.modelEl);
    this.clearBtn = el("button", "btn ghost scratch-clear", tr("清空")) as HTMLButtonElement;
    this.clearBtn.title = tr("在同一个进程里换一条新会话：上下文和 token 归零，不等重启");
    this.clearBtn.onclick = () => this.clear();
    this.pauseBtn = el("button", "btn ghost scratch-pause", tr("暂停")) as HTMLButtonElement;
    this.pauseBtn.onclick = () => this.togglePause();
    this.closeBtn = el("button", "btn ghost scratch-close", "×") as HTMLButtonElement;
    this.closeBtn.title = tr("关闭");
    this.closeBtn.onclick = () => this.close();
    head.append(this.clearBtn, this.pauseBtn, this.closeBtn);
    sheet.append(head);

    this.modelMenu = el("div", "scratch-models");
    this.modelMenu.hidden = true;
    sheet.append(this.modelMenu);

    // 它是干什么的、不是什么，写在最上面：不然它看起来就像一个普通会话。
    this.staticHintEl = el("div", "scratch-hint", this.staticHintText());
    sheet.append(this.staticHintEl);

    this.reclaimEl = el("div", "scratch-reclaim");
    this.reclaimEl.hidden = true;
    const reclaimText = el("span", "scratch-reclaim-text", tr("随手问的会话已失效，已重新打开。"));
    const reclaimAction = el("button", "btn ghost", tr("重新接管"));
    reclaimAction.onclick = () => {
      if (this.id) this.host.send({ type: "scratch.open" });
      else {
        this.asked = false;
        this.open();
      }
    };
    const reclaimClose = el("button", "btn ghost scratch-reclaim-close", "×") as HTMLButtonElement;
    reclaimClose.title = tr("关闭提示");
    reclaimClose.setAttribute("aria-label", reclaimClose.title);
    reclaimClose.onclick = () => {
      this.dismissedReclaimId = this.id;
      this.reclaimEl.hidden = true;
    };
    this.reclaimEl.append(reclaimText, reclaimAction, reclaimClose);
    sheet.append(this.reclaimEl);

    this.remindEl = el("div", "scratch-remind");
    this.remindEl.hidden = true;
    sheet.append(this.remindEl);

    this.listEl = el("div", "scratch-list");
    sheet.append(this.listEl);

    const foot = el("div", "scratch-foot");
    this.inputEl = el("textarea", "sc-input") as HTMLTextAreaElement;
    this.inputEl.rows = 3;
    this.inputEl.placeholder = tr("想到什么就问什么（Enter 发送，Shift+Enter 换行）");
    this.inputEl.onkeydown = (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      }
    };
    this.sendBtn = el("button", "btn primary", tr("发送")) as HTMLButtonElement;
    this.sendBtn.onclick = () => this.submit();
    this.hintEl = el("div", "sc-hint", "");
    foot.append(this.inputEl, this.sendBtn, this.hintEl);
    sheet.append(foot);

    back.append(sheet);
    // 挂 `#app` 里，不挂 `document.body`：外观「字号」是 `#app { zoom: var(--ui-scale) }`，
    // 挂在 body 上的弹层不跟它缩（D36 实测：抽屉还是 100%，与背景不同步）。
    (document.getElementById("app") ?? document.body).append(back);
    this.root = back;
    this.refreshLang();
  }

  /**
   * 语言切了：静态文案重写、消息行重绘（它们本来每次渲染都调 tr）。
   *
   * 由 App 在 `setPrefLang` 里显式调用 —— 那个方法用的是 `applyLang`（只改状态、不通知），
   * `onLang` 的订阅者在这种切换下收不到消息。dialog 不在 `renderAll()` 的覆盖范围里，
   * 所以必须点名画它一次。
   */
  refreshLang(): void {
    if (!this.root) return;
    this.titleEl.textContent = tr("随手问");
    this.staticHintEl.textContent = this.staticHintText();
    const reclaimAction = this.reclaimEl.querySelector("button:not(.scratch-reclaim-close)");
    if (reclaimAction) reclaimAction.textContent = tr("重新接管");
    const reclaimClose = this.reclaimEl.querySelector<HTMLButtonElement>(".scratch-reclaim-close");
    if (reclaimClose) {
      reclaimClose.title = tr("关闭提示");
      reclaimClose.setAttribute("aria-label", reclaimClose.title);
    }
    this.reclaimEl.querySelector(".scratch-reclaim-text")!.textContent = tr("随手问的会话已失效，已重新打开。");
    this.clearBtn.textContent = tr("清空");
    this.clearBtn.title = tr("在同一个进程里换一条新会话：上下文和 token 归零，不等重启");
    this.closeBtn.title = tr("关闭");
    this.modelEl.title = tr("切模型");
    this.sendBtn.textContent = tr("发送");
    this.inputEl.placeholder = tr("想到什么就问什么（Enter 发送，Shift+Enter 换行）");
    this.paintState();
    this.repaint();
  }

  private staticHintText(): string {
    return [tr("不进会话列表 · 不带上下文 · 不改本机（能读文件、能联网查）"), tr("桥重启会清空随手问")].join(" · ");
  }

  private toggleModels(): void {
    this.modelMenu.hidden = !this.modelMenu.hidden;
    if (!this.modelMenu.hidden) this.fillModels();
  }

  /** 当前模型支持的思考档位；模型目录还没到时给 pi 的全集。 */
  private levels(): string[] {
    const model = this.host.models().find((m) => m.id === this.state?.model);
    return model?.levels?.length ? model.levels : DEFAULT_LEVELS;
  }

  private fillModels(): void {
    this.modelMenu.textContent = "";
    if (!this.id) return;
    // 档位放在模型前面：换完模型档位可能被 pi clamp，先调档位再换模型更符合直觉。
    const levelBox = el("div", "scratch-levels");
    levelBox.append(el("div", "levels-label", tr("思考档位")));
    const chips = el("div", "chips");
    for (const lv of this.levels()) {
      const chip = el("button", `chip${lv === this.state?.thinkingLevel ? " on" : ""}`, lv);
      chip.onclick = () => {
        this.modelMenu.hidden = true;
        this.host.send({ type: "setThinking", sessionId: this.id, level: lv });
      };
      chips.append(chip);
    }
    levelBox.append(chips);
    this.modelMenu.append(levelBox);

    const list = this.host.models();
    if (!list.length) {
      this.modelMenu.append(el("div", "scratch-model none", tr("模型列表还没加载完")));
      return;
    }
    const current = this.state?.model;
    const { pinned, groups } = groupModels(list, { id: current });
    const sections = [...(pinned ? [{ title: tr("当前使用"), models: [pinned] }] : []), ...groups.map((g) => ({ title: g.provider, models: g.models }))];
    for (const section of sections) {
      const group = modelGroupSection(section.title, section.models.length, { pinned: !!pinned && section.models[0] === pinned });
      this.modelMenu.append(group.node);
      for (const m of section.models) {
      const row = el("button", `scratch-model${m.id === current ? " on" : ""}`);
      row.append(el("span", "m-name", m.name || m.id), el("span", "m-prov", m.provider));
      row.onclick = () => {
        this.modelMenu.hidden = true;
        // 档位跟着一起发：pi 换模型时会把它 clamp 到新模型的默认档（实测 off → max），
        // 不带 level 的话，用户刚调好的档位会被悄悄改掉。
        this.host.send({
          type: "setModel",
          sessionId: this.id,
          provider: m.provider,
          modelId: m.id,
          level: this.state?.thinkingLevel || undefined,
        });
      };
      group.body.append(row);
      }
    }
  }

  private submit(): void {
    const text = this.inputEl.value.trim();
    if (!text || this.pendingText || this.running || this.state?.paused) return;
    this.pendingText = text;
    // No id yet (a fresh page, or the 404 reopen has not answered): ask once more; the snapshot
    // handler sends the queued sentence as soon as it knows which session to send it to.
    if (!this.id) {
      this.pendingSessionId = null;
      this.asked = false;
      this.open();
      return;
    }
    this.pendingSessionId = this.id;
    this.host.send({ type: "prompt", sessionId: this.id, text });
  }

  /** Give the sentence back to the composer: a terminal failure must not leave it un-sendable. */
  private releasePending(): void {
    this.pendingText = null;
    this.pendingSessionId = null;
  }

  private togglePause(): void {
    if (!this.id || this.running || this.starting) return;
    this.host.send({ type: this.state?.paused ? "scratch.resume" : "scratch.pause" });
  }

  private addPauseNotice(): void {
    if (!this.id) return;
    this.upsert({ id: `scratch-paused-${this.id}`, kind: "notice", text: tr("随手问已暂停，恢复后可以接着问"), level: "info" });
  }

  private clear(): void {
    if (!this.id) return;
    this.host.send({ type: "scratch.clear" });
  }

  /**
   * 标签与空步骤的收尾：一轮里 pi 会发好几条 assistant 消息（工具调用之间各一条），
   * 每条都打「随手问」就成了刷屏。规则是——标签只在一段的开头出现（上一行是用户或没有），
   * 文字为空的步骤整行不显示。
   */
  private paintLabels(): void {
    const nodes = Array.from(this.listEl.children).filter((n): n is HTMLElement => n instanceof HTMLElement);
    let prev = "";
    for (let i = 0; i < nodes.length; ) {
      const node = nodes[i];
      if (node.classList.contains("sc-step")) {
        node.hidden = true;
        i += 1;
        continue;
      }
      node.hidden = false;
      if (node.classList.contains("sc-tool")) {
        // 连续的工具调用收成一行（空步骤夹在中间也算同一段）：`web_search · fetch_content ×2`
        const run: string[] = [];
        let j = i;
        while (j < nodes.length && (nodes[j].classList.contains("sc-tool") || nodes[j].classList.contains("sc-step"))) {
          if (nodes[j].classList.contains("sc-step")) nodes[j].hidden = true;
          else {
            run.push(nodes[j].dataset.tool ?? "tool");
            if (j !== i) nodes[j].hidden = true;
          }
          j += 1;
        }
        const line = node.querySelector(".sc-twoline");
        if (line) line.textContent = `🔧 ${summarizeTools(run)}`;
        prev = "tool";
        i = j;
        continue;
      }
      const who = node.querySelector<HTMLElement>(".sc-who");
      if (who && node.classList.contains("sc-assistant")) who.hidden = !(prev === "" || prev === "user");
      prev = node.classList.contains("sc-assistant") ? "assistant" : node.classList.contains("sc-user") ? "user" : "other";
      i += 1;
    }
  }

  private upsert(item: Item): void {
    if (!item?.id) return;
    const at = this.items.findIndex((it) => it.id === item.id);
    if (at >= 0) this.items[at] = item;
    else this.items.push(item);
    this.rows.get(item.id)?.remove();
    const node = row(item);
    this.rows.set(item.id, node);
    this.listEl.append(node);
    this.paintLabels();
  }

  private drop(id: string): void {
    this.items = this.items.filter((it) => it.id !== id);
    this.rows.get(id)?.remove();
    this.rows.delete(id);
  }

  private delta(id: string, field: string, text: string): void {
    const item = this.items.find((it) => it.id === id) as { text?: string; thinking?: string } | undefined;
    if (!item) return;
    if (field === "thinking") item.thinking = (item.thinking ?? "") + text;
    else item.text = (item.text ?? "") + text;
    const node = this.rows.get(id);
    if (node) {
      const body = node.querySelector(".sc-text");
      if (body) {
        body.textContent = "";
        if ((item as { text?: string }).text?.trim()) {
          // 之前是「空步骤」（只有工具调用）：有文字了就不再是空步骤。
          node.classList.remove("sc-step");
          body.append(renderMarkdown((item as { text: string }).text));
        }
      }
      this.paintLabels();
    }
    this.scroll();
  }

  private repaint(): void {
    if (!this.root) return;
    this.listEl.textContent = "";
    this.rows.clear();
    if (!this.items.length) {
      this.listEl.append(el("div", "sc-empty", tr("问一句就行。它不进会话列表，也不记得上一次的上下文——除非你没点「清空」。")));
      return;
    }
    for (const item of this.items) {
      const node = row(item);
      this.rows.set(item.id, node);
      this.listEl.append(node);
    }
    this.paintLabels();
    this.scroll();
  }

  private scroll(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  /** 状态行：启动中 / 回答中 / 就绪 / 还没打开时不写。 */
  private stateLabel(): string {
    if (this.state?.paused) return tr("已暂停");
    if (this.starting) return tr("pi 正在启动…");
    if (this.running) return tr("正在回答…");
    return this.id ? tr("就绪") : "";
  }

  private paintState(): void {
    if (!this.root) return;
    const busy = this.running || this.starting;
    const paused = Boolean(this.state?.paused);
    this.sendBtn.disabled = busy || paused || !this.id;
    this.clearBtn.disabled = !this.id || this.running;
    const pauseLabel = paused ? tr("开始") : tr("暂停");
    this.pauseBtn.textContent = pauseLabel;
    this.pauseBtn.disabled = busy || !this.id;
    this.pauseBtn.title = this.running ? tr("这一轮跑完才能暂停") : pauseLabel;
    this.inputEl.disabled = this.starting || paused;
    this.stateEl.textContent = this.stateLabel();
    // 模板串里带中文会被 i18n 检查器当成「没走 tr()」：先算好名字再拼。
    const modelName = this.state?.modelName || this.state?.model || tr("模型");
    const level = this.state?.thinkingLevel;
    this.modelEl.textContent = level ? `${modelName} · ${level} ▾` : `${modelName} ▾`;
    this.modelEl.disabled = !this.id || paused;
    this.hintEl.textContent = this.error;
    this.hintEl.hidden = !this.error;
    this.paintReminder();
  }

  /**
   * 提醒线 = 「离 pi 自动压缩还有多远」× 比例，而不是固定百分比：32k 窗口的模型上，
   * 自动压缩发生在 50%，固定 60% 的提醒永远看不到。
   */
  private paintReminder(): void {
    const tokens = this.tokens;
    const win = this.window;
    if (!tokens || !win || this.remindDismissed) {
      this.remindEl.hidden = true;
      return;
    }
    const autoAt = Math.max(1, win - RESERVE_TOKENS);
    const used = tokens / autoAt;
    if (used < WARN_AT) {
      this.remindEl.hidden = true;
      return;
    }
    const strong = used >= STRONG_AT;
    const pct = Math.min(100, Math.round(used * 100));
    this.remindEl.hidden = false;
    this.remindEl.className = `scratch-remind${strong ? " strong" : ""}`;
    this.remindEl.textContent = "";
    this.remindEl.append(
      el(
        "span",
        "scratch-remind-text",
        strong
          ? tr("上下文快满了（离 pi 自动压缩只剩一点），建议清空")
          : tr("上下文已用到 {p1}%，离 pi 自动压缩不远了", { p1: String(pct) }),
      ),
    );
    const dismiss = el("button", "btn ghost scratch-dismiss", tr("知道了"));
    dismiss.onclick = () => {
      this.remindDismissed = true;
      this.remindEl.hidden = true;
    };
    this.remindEl.append(dismiss);
  }
}
