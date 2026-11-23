/**
 * D389 提醒中心（页面侧）：★ 行右端那颗角标、点开的清单、右上角的吐司。
 *
 * 桥是唯一真源（`bridge/src/reminders.ts` + `state/reminders.json`）：这里只负责画、以及把
 * 「静音这个会话」「这条已读」「三档开关」发回去。清单两种读法（流水 / 按会话）是**纯前端状态**，
 * 存在 `localStorage`，不发帧 —— 换个页面看同一份数据不该因为读法不同而打架。
 *
 * 角标挂在哪由 `hooks.mount()` 决定（A 壳挂在 ★ 行右端，B/C/D 与窄屏退回顶栏），见 app.ts 的
 * `placeRemindBell()`。浮层挂在 `.app` 这个 grid 容器上（`hooks.stage()`），位置按角标的
 * `offsetTop` 链算 —— 走 offset 而不是 `getBoundingClientRect()`，因为 `#app` 上挂着 `zoom`
 * 会把 rect 的体积再乘一遍（D123 那个坑）。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { markSurface, pushEscLayer } from "./modal.ts";
import { tr } from "./i18n/index.ts";
import "./reminders.css";

export type ReminderKind = "approval" | "ask" | "notice";
export type ReminderState = "waiting" | "handled" | "read" | "stale";
export type ReminderOutcome = "approved" | "rejected" | "answered" | "read" | "stale";

export interface Reminder {
  id: string;
  kind: ReminderKind;
  sessionId?: string;
  sessionName: string;
  /** 非阻塞类才有真的标题（发送方给的）；审批 / 问卷留空，标题按界面语言现拼。 */
  title: string;
  body: string;
  createdAt: number;
  state: ReminderState;
  outcome?: ReminderOutcome;
  settledAt?: number;
  /** 非阻塞类带的同源路径，点了就跳过去。 */
  url?: string;
}

export interface ReminderSettings {
  enabled: boolean;
  blocking: boolean;
  others: boolean;
}

export interface ReminderView {
  items: Reminder[];
  muted: string[];
  settings: ReminderSettings;
  badge: number;
}

export const EMPTY_REMINDERS: ReminderView = {
  items: [],
  muted: [],
  settings: { enabled: true, blocking: true, others: false },
  badge: 0,
};

const GROUP_KEY = "reminders.group"; // localStorage：流水 / 按会话

export interface ReminderHooks {
  /** 把角标按钮放进当前宿主（A 壳的 ★ 行 / 顶栏），由 app 决定。 */
  mount(button: HTMLButtonElement): void;
  /** 浮层的定位上下文（`.app`）：浮层与吐司都挂在这上面跟着字号缩放。 */
  stage(): HTMLElement | null;
  /** 切到那个会话；`reminderId` 用来滚到那张卡（D389 第 5 条）。 */
  openSession(sessionId: string, reminderId?: string): void;
  currentSessionId(): string | null;
  /** 这条提醒挂的会话还在不在（不在就灰掉不可点）。 */
  hasSession(sessionId: string): boolean;
  send(frame: unknown): void;
}

export class ReminderCenter {
  private readonly button: HTMLButtonElement;
  private readonly badgeEl: HTMLElement;
  private pop: HTMLElement | null = null;
  private toastBox: HTMLElement | null = null;
  private view: ReminderView = { ...EMPTY_REMINDERS };
  private grouped = localStorage.getItem(GROUP_KEY) === "session";
  private open = false;

  private readonly hooks: ReminderHooks;

  constructor(hooks: ReminderHooks) {
    this.hooks = hooks;
    this.button = el("button", "remind-bell") as HTMLButtonElement;
    this.button.type = "button";
    this.button.hidden = true;
    this.badgeEl = el("span", "remind-bell-count");
    /* 线描铃（不是 emoji）：与顶栏那排单色图标同一种语言，颜色走 currentColor。
       数量是叠在图标右上角的一枚小徽标 —— macOS 的 Dock / 邮箱那套（原型 F 片）。 */
    this.button.append(bellIcon(), this.badgeEl);
    this.button.onclick = (e) => {
      e.stopPropagation();
      this.toggle(!this.open);
    };
    this.hooks.mount(this.button);
  }

  /** 刷新一次（页面连上桥、或收到 `reminders` 帧）。 */
  async refresh(): Promise<void> {
    try {
      this.setView(await api.reminders());
    } catch {
      /* 桥还没起来 / 没登录：保持原样，下一次连上再取 */
    }
  }

  setView(view: ReminderView): void {
    this.view = {
      items: Array.isArray(view?.items) ? view.items : [],
      muted: Array.isArray(view?.muted) ? view.muted : [],
      settings: { ...EMPTY_REMINDERS.settings, ...(view?.settings ?? {}) },
      badge: Number(view?.badge) || 0,
    };
    this.paint();
  }

  /** 换壳 / 窄屏时重新挂角标（由 app 调）。 */
  place(): void {
    this.hooks.mount(this.button);
    if (this.open) this.position();
  }

  /** 新来一条要提示的（桥已经按 30 秒窗口与开关筛过一轮）。 */
  toast(reminder: Reminder): void {
    // 只弹**别的会话**的：当前会话的卡本来就在正文里（D389 第 3 条）。
    if (reminder.sessionId && reminder.sessionId === this.hooks.currentSessionId()) return;
    const stage = this.hooks.stage();
    if (!stage) return;
    if (!this.toastBox || this.toastBox.parentElement !== stage) {
      this.toastBox = el("div", "remind-toasts");
      stage.append(this.toastBox);
    }
    const box = markSurface(el("div", "remind-toast"), "toast");
    let timer = 0;
    const close = (): void => {
      window.clearTimeout(timer);
      box.remove();
    };
    const text = el("div", "remind-toast-text");
    text.append(el("div", "remind-toast-title", titleOf(reminder)), el("div", "remind-toast-body", reminder.body));
    const go = el("button", "remind-toast-go", tr("去看看"));
    go.type = "button";
    go.onclick = () => {
      close();
      this.go(reminder);
    };
    box.append(el("span", "remind-toast-icon", ICONS[reminder.kind]), text, go);
    timer = window.setTimeout(close, 6000);
    box.addEventListener("pointerenter", () => window.clearTimeout(timer));
    box.addEventListener("pointerleave", () => {
      timer = window.setTimeout(close, 2000);
    });
    this.toastBox.append(box);
    while (this.toastBox.children.length > 3) this.toastBox.firstElementChild?.remove();
  }

  private paint(): void {
    const waiting = this.view.items.filter((r) => r.state === "waiting");
    this.button.hidden = this.view.items.length === 0;
    this.badgeEl.textContent = String(this.view.badge);
    this.button.dataset.count = String(this.view.badge);
    this.button.classList.toggle("alert", this.view.badge > 0);
    this.button.title = waiting.length ? tr("等你的事 · {p1} 件", { p1: waiting.length }) : tr("提醒");
    this.button.setAttribute("aria-label", this.button.title);
    this.button.setAttribute("aria-expanded", this.open ? "true" : "false");
    if (this.open) this.paintPop();
    else if (this.view.items.length === 0) this.toggle(false);
  }

  private toggle(on: boolean): void {
    this.open = on;
    this.button.setAttribute("aria-expanded", on ? "true" : "false");
    if (!on) {
      this.pop?.remove();
      this.pop = null;
      this.closeEsc?.();
      this.closeEsc = null;
      return;
    }
    this.pop = markSurface(el("div", "remind-pop"), "menu");
    this.paintPop();
    this.hooks.stage()?.append(this.pop);
    this.position();
    this.closeEsc = pushEscLayer({ el: this.pop, onEsc: () => this.toggle(false) });
    window.addEventListener("pointerdown", this.onOutside, true);
  }

  private closeEsc: (() => void) | null = null;

  private readonly onOutside = (e: Event): void => {
    const t = e.target as Node;
    if (this.pop?.contains(t) || this.button.contains(t)) return;
    this.toggle(false);
  };

  /** 位置：角标下面、右端对齐。走 offsetTop 链，避开 `#app` 的 zoom 把 rect 乘两遍。 */
  private position(): void {
    const stage = this.hooks.stage();
    if (!this.pop || !stage) return;
    let top = 0;
    let right = 0;
    let node: HTMLElement | null = this.button;
    while (node && node !== stage) {
      top += node.offsetTop;
      right += stage.clientWidth - (node.offsetLeft + node.offsetWidth);
      node = node.offsetParent as HTMLElement | null;
    }
    this.pop.style.top = `${this.button.offsetTop + this.button.offsetHeight + 6}px`;
    this.pop.style.right = `${Math.max(8, right)}px`;
    void top;
  }

  private paintPop(): void {
    if (!this.pop) return;
    const waiting = this.view.items.filter((r) => r.state === "waiting");
    const settled = this.view.items.filter((r) => r.state !== "waiting");
    const muted = new Set(this.view.muted);
    this.pop.replaceChildren();

    const head = el("div", "remind-pop-head");
    head.append(el("b", "", tr("等你的事")), el("span", "remind-pop-count", waiting.length ? tr("{p1} 件在等你", { p1: waiting.length }) : tr("都处理完了")));
    const modes = el("div", "remind-modes");
    for (const [key, label] of [["event", tr("按事件")], ["session", tr("按会话")]] as const) {
      const on = (key === "session") === this.grouped;
      const b = el("button", `remind-mode${on ? " on" : ""}`, label);
      b.type = "button";
      b.onclick = () => {
        this.grouped = key === "session";
        localStorage.setItem(GROUP_KEY, this.grouped ? "session" : "event");
        this.paintPop();
      };
      modes.append(b);
    }
    head.append(modes);
    this.pop.append(head);

    const body = el("div", "remind-pop-body");
    if (!this.view.items.length) body.append(el("div", "remind-empty", tr("还没有提醒")));
    else if (this.grouped) body.append(...this.groupedNodes(waiting, settled, muted));
    else {
      if (waiting.length) body.append(el("div", "remind-group-label", tr("等你 · {p1}", { p1: waiting.length })));
      for (const r of waiting) body.append(this.row(r, false, muted.has(r.sessionId ?? "")));
      let bucket = "";
      for (const r of settled.slice(0, 40)) {
        const next = dayBucket(r.settledAt ?? r.createdAt);
        if (next !== bucket) {
          bucket = next;
          body.append(el("div", "remind-group-label", BUCKET_LABEL[next]()));
        }
        body.append(this.row(r, true, false));
      }
    }
    this.pop.append(body);

    const foot = el("div", "remind-pop-foot", tr("点一条 = 切过去并滚到那张卡"));
    this.pop.append(foot);
    this.position();
  }

  /** 按会话分组：一张卡一个会话，卡里列它全部的等待（原型里赢了的那套读法）。 */
  private groupedNodes(waiting: Reminder[], settled: Reminder[], muted: Set<string>): HTMLElement[] {
    const out: HTMLElement[] = [];
    const by = new Map<string, Reminder[]>();
    for (const r of waiting) {
      const key = r.sessionId ?? "__other";
      const list = by.get(key) ?? [];
      list.push(r);
      by.set(key, list);
    }
    for (const rows of by.values()) {
      const first = rows[0];
      const card = el("div", "remind-card");
      const head = el("div", "remind-card-head");
      const approvals = rows.filter((r) => r.kind === "approval").length;
      const asks = rows.filter((r) => r.kind === "ask").length;
      const tag = [approvals ? tr("待确认 {p1}", { p1: approvals }) : "", asks ? tr("待回答 {p1}", { p1: asks }) : ""].filter(Boolean).join(" · ");
      head.append(el("span", "remind-card-name", first.sessionId ? first.sessionName : tr("其它")));
      if (tag) head.append(el("span", "remind-card-tag", tag));
      head.append(el("span", "remind-card-time", relativeTime(Math.max(...rows.map((r) => r.createdAt)))));
      card.append(head);
      for (const r of rows) {
        const line = el("button", "remind-card-line");
        line.type = "button";
        line.append(el("span", "remind-row-icon", ICONS[r.kind]), el("span", "remind-card-text", r.body || titleOf(r)));
        line.onclick = () => this.go(r);
        card.append(line);
      }
      if (first.sessionId && muted.has(first.sessionId)) card.append(el("div", "remind-card-note", tr("这个会话静音中，不计角标")));
      out.push(card);
    }
    if (settled.length) {
      out.push(el("div", "remind-group-label", tr("处理过 / 失效")));
      for (const r of settled.slice(0, 20)) out.push(this.row(r, true, false));
    }
    return out;
  }

  private row(r: Reminder, settled: boolean, isMuted: boolean): HTMLElement {
    /* 会话已经不在（删了 / 换了机器）→ 那一条灰掉不可点：点过去只会开一个空会话。 */
    const gone = !!r.sessionId && !this.hooks.hasSession(r.sessionId);
    const row = el("button", `remind-row${settled ? " settled" : ""}${isMuted ? " muted" : ""}${gone ? " missing" : ""}`);
    row.type = "button";
    row.dataset.reminderId = r.id;
    if (gone) row.disabled = true;
    const main = el("span", "remind-row-main");
    main.append(el("span", "remind-row-title", titleOf(r)));
    if (r.body) main.append(el("span", "remind-row-body", r.body));
    const meta = el("span", "remind-row-meta");
    if (settled) meta.append(el("span", "remind-outcome", outcomeLabel(r)));
    meta.append(el("span", "remind-row-time", relativeTime(r.settledAt ?? r.createdAt)));
    row.append(el("span", "remind-row-icon", ICONS[r.kind]), main, meta);
    row.onclick = () => this.go(r);
    if (!settled && r.sessionId) {
      const mute = el("button", `remind-mute${isMuted ? " on" : ""}`, isMuted ? tr("取消静音") : tr("静音"));
      mute.type = "button";
      mute.onclick = (e) => {
        e.stopPropagation();
        this.hooks.send({ type: "reminder.mute", sessionId: r.sessionId, on: !isMuted });
      };
      row.append(mute);
    }
    return row;
  }

  private go(r: Reminder): void {
    /* 非阻塞那条点一下就消（= 已读），但**不关清单**：你还在看，只是把它标成看过了。 */
    if (r.kind === "notice") {
      if (r.state === "waiting") this.hooks.send({ type: "reminder.read", id: r.id });
      /* 脚本可以带一条同源路径（`url`）：有就顺手把人带过去，没有就只是「看过了」。 */
      if (r.url && r.url.startsWith("/")) location.assign(r.url);
      return;
    }
    this.toggle(false);
    if (r.sessionId) this.hooks.openSession(r.sessionId, r.state === "waiting" ? r.id : undefined);
  }
}

const ICONS: Record<ReminderKind, string> = { approval: "⚠", ask: "❓", notice: "•" };

/** 铃铛图标：一段两笔的线描，`currentColor` 让它在 hover / 有事情时跟着文字色变。 */
function bellIcon(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("remind-bell-icon");
  for (const d of [
    "M8 2.2c-2 0-3.2 1.5-3.2 3.4 0 2.4-.7 3.3-1.3 3.9h9c-.6-.6-1.3-1.5-1.3-3.9 0-1.9-1.2-3.4-3.2-3.4Z",
    "M6.6 11.6a1.5 1.5 0 0 0 2.8 0",
  ]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
  }
  return svg;
}

/** 已处理的按天分组（D389 第 8 条）：今天 / 昨天 / 更早。 */
type Bucket = "today" | "yesterday" | "earlier";

function dayBucket(at: number): Bucket {
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const when = new Date(at);
  const now = new Date();
  if (same(when, now)) return "today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return same(when, y) ? "yesterday" : "earlier";
}

const BUCKET_LABEL: Record<Bucket, () => string> = {
  today: () => tr("今天"),
  yesterday: () => tr("昨天"),
  earlier: () => tr("更早"),
};

/** 标题：审批 / 问卷按界面语言现拼；非阻塞类用发送方给的标题。 */
export function titleOf(r: Reminder): string {
  if (r.title) return r.title;
  const kind = r.kind === "ask" ? tr("需要你回答 · {p1}") : tr("需要你批准 · {p1}");
  return tr(kind, { p1: r.sessionName || tr("会话") });
}

export function outcomeLabel(r: Reminder): string {
  switch (r.outcome) {
    case "approved":
      return tr("已批准");
    case "rejected":
      return tr("已拒绝");
    case "answered":
      return tr("已回答");
    case "read":
      return tr("已读");
    case "stale":
      return tr("已失效");
    default:
      return "";
  }
}

/** 相对时间：只给清单用（秒 / 分 / 小时 / 天），够近就行，不引日期库。 */
export function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (!Number.isFinite(diff) || diff < 30_000) return tr("刚刚");
  const min = Math.round(diff / 60_000);
  if (min < 60) return tr("{p1} 分钟前", { p1: min });
  const h = Math.round(min / 60);
  if (h < 24) return tr("{p1} 小时前", { p1: h });
  const d = Math.round(h / 24);
  if (d === 1) return tr("昨天");
  return tr("{p1} 天前", { p1: d });
}
