import { tr } from "./i18n/index.ts";
import { openPinList } from "./pinmenu.ts";

/**
 * #93：会话胶囊条。左栏收起时那条横栏里的三样东西抽到这里 —— 一颗会话胶囊（★ 与「打开」两个热区）、
 * 装不下时折成的那颗「＋N」、点开它的浮层列表。后面的工作区布局（A/B/C/D 四套外壳）要各摆一次，
 * 所以这里只吃数据与回调：不读 app 的全局状态、不发 RPC、不认 SessionState 里除这几项以外的字段。
 *
 * 外壳负责：什么时候显示这条（含 hidden）、尾巴上那几颗自己的按钮（`tail`）、胶囊上的悬停气泡
 * 之类外挂手势（`decorate`）。组件负责：胶囊与折叠的排布、★ 点完之后的焦点归还、浮层的开关。
 */

/** 组件眼里的一颗会话 —— SessionState 结构上是它的超集，直接传进来就行。 */
export interface PillSession {
  id: string;
  name: string;
  cwd?: string | null;
  updatedAt: number;
}

/** 状态徽标（卡片 / 管理条 / 胶囊共用的那一种）。 */
export interface PillBadge {
  text: string;
  cls: "wait" | "lock" | "run" | "done";
  title: string;
  /** 卡在用户身上（待回答 / 待确认）—— 条头的「N 个待处理」数它。 */
  pending: boolean;
}

/** 一颗胶囊最终显示成什么：纯函数，便于脱离 DOM 核对文案。 */
export interface PillChip {
  id: string;
  name: string;
  /** 名字右边那行小字：徽标文字优先，没有就相对时间。 */
  sub: string;
  /** 徽标带来的颜色类（`.wait` / `.run`…），没有徽标就是 null。 */
  cls: string | null;
  title: string;
  current: boolean;
}

export function pillChip(s: PillSession, currentId: string | null, badge: PillBadge | null, time: (ts: number) => string): PillChip {
  const name = s.name || s.id;
  const current = s.id === currentId;
  return {
    id: s.id,
    name,
    sub: badge ? badge.text : time(s.updatedAt),
    cls: badge ? badge.cls : null,
    // 悬停时这一颗要能自报家门：名字 · 目录 · 为什么带色 · 是不是当前会话。
    title: [name, s.cwd ?? "", badge?.title ?? "", current ? tr("（当前会话）") : ""].filter(Boolean).join(" · "),
    current,
  };
}

/**
 * #120 行 2 画哪些胶囊：本区里点过 ★ 的那些，当前那颗不重复画（最左的 NowChip 已经代表它）。
 * `sessions` 是外壳给的「本区会话」，顺序就按左栏那一份（★ 已经排在前面），这里只做过滤 ——
 * 于是别组的置顶不会串进本区，没 ★ 的组也就一颗都不剩。
 */
export function starredSessions<S extends PillSession>(
  sessions: readonly S[],
  stars: readonly string[],
  currentId: string | null,
): S[] {
  const starred = new Set(stars);
  return sessions.filter((s) => starred.has(s.id) && s.id !== currentId);
}

export interface PillBarOpts<S extends PillSession = PillSession> {
  /** 「什么状态」由外壳算（它才知道当前会话、锁、待办）。 */
  badge(s: S, currentId: string | null): PillBadge | null;
  /** 小字里的时间。 */
  time(ts: number): string;
  /** 条头那颗字：`pending` 是待处理会话数，`total` 是这一条的会话数。 */
  heading(pending: number, total: number): string;
  /** 一颗都没有时的提示（不给就什么都不摆）。 */
  empty?: string;
  /** ★ 的 title / aria-label（默认「取消置顶 ×」）。 */
  starTitle?(name: string): string;
  onOpen(id: string): void;
  onStar(id: string): void;
  /** 条尾属于外壳自己的按钮：折叠时要跟胶囊一起占位置，所以由组件摆进去。`chips` 是这一次真画出来的胶囊（一颗 ★ 都没有时是空数组）。 */
  tail?(chips: readonly PillChip[]): HTMLElement[];
  /** 外壳自己的手势（例如悬停气泡）。 */
  decorate?(chip: HTMLElement, s: S): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PillBar<S extends PillSession = PillSession> {
  private readonly host: HTMLElement;
  private readonly opts: PillBarOpts<S>;
  /** 点开着的「＋N」浮层（挂在 body 上，只有一张）。 */
  private more: { close(): void } | null = null;
  /** ★ 刚点过的那颗的下标：重画之后那颗星已经没了，焦点不能掉到 <body>。 */
  private focusAt: number | null = null;
  /** 上一次画出来的胶囊 —— 「＋N」的浮层列的就是这一份。 */
  private chips: PillChip[] = [];

  constructor(host: HTMLElement, opts: PillBarOpts<S>) {
    this.host = host;
    this.opts = opts;
  }

  /** 收起浮层（整条重画之前必须调：锚点那颗胶囊要跟着消失）。 */
  closeMore(): void {
    const cur = this.more;
    this.more = null;
    cur?.close();
  }

  render(sessions: S[], currentId: string | null): void {
    const host = this.host;
    this.closeMore();
    // Q-022: 条会在每次会话 / manage 回声里整条重建，而那些回声就落在 ★ 点完之后 ——
    // 记住是哪颗按钮握着焦点，重建完还给它。
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const heldKey = active?.dataset.pinKey ?? null;
    host.replaceChildren();

    const badges = sessions.map((s) => this.opts.badge(s, currentId));
    const chips = sessions.map((s, i) => pillChip(s, currentId, badges[i], this.opts.time));
    this.chips = chips;

    const pending = badges.filter((b) => b?.pending).length;
    const label = el("span", "pin-strip-label", this.opts.heading(pending, chips.length));
    if (pending) label.classList.add("has-pending");
    host.append(label);

    const nodes: HTMLElement[] = [];
    chips.forEach((c, i) => {
      // Q-022: 一个 button 不能套 button，所以胶囊是个容器 + 两个热区 —— ★ = 取消置顶，其余 = 打开。
      const chip = el("div", "pin-chip");
      if (c.cls) chip.classList.add(c.cls);
      // 当前会话：整颗填色（aria-current 给读屏器，title 里也补一句），否则这一排长得一模一样。
      if (c.current) {
        chip.classList.add("cur");
        chip.setAttribute("aria-current", "true");
      }
      const star = el("button", "pin-star", "★") as HTMLButtonElement;
      star.type = "button";
      star.dataset.pinKey = `${c.id}:star`;
      const starLabel = this.opts.starTitle ? this.opts.starTitle(c.name) : tr("取消置顶 {p1}", { p1: c.name });
      star.title = starLabel;
      star.setAttribute("aria-label", starLabel);
      star.onclick = () => {
        this.focusAt = i;
        this.opts.onStar(c.id);
      };
      const open = el("button", "pin-open") as HTMLButtonElement;
      open.type = "button";
      open.dataset.pinKey = `${c.id}:open`;
      open.append(el("span", "pin-name", c.name), el("small", "", c.sub));
      open.title = c.title;
      open.onclick = () => this.opts.onOpen(c.id);
      chip.append(star, open);
      this.opts.decorate?.(chip, sessions[i]);
      nodes.push(chip);
      host.append(chip);
    });
    if (!chips.length && this.opts.empty) host.append(el("span", "pin-empty", this.opts.empty));

    // D125: 一多就装不下一行，超出的折进这颗（点开是一张全量列表）。
    // 先摆上去再量：宽度要用真实布局算，折叠态自己也要占位置。
    const more = el("button", "pin-more") as HTMLButtonElement;
    more.type = "button";
    more.dataset.pinKey = "more";
    more.hidden = true;
    more.onclick = () => this.toggleMore(more);
    host.append(more);

    const tail = this.opts.tail?.(chips) ?? [];
    for (const node of tail) host.append(node);

    this.fold(nodes, more);
    this.restoreFocus(nodes, tail[0] ?? more, heldKey);
  }

  /**
   * 只许占一行：胶囊多到装不下时从尾部往前收，收掉几颗就在「＋N」里报几颗。
   * 当前会话那颗不藏 —— 藏了等于回到「不知道自己在跟哪个会话说话」，而那正是 D125 要治的病。
   * 量的是布局本身（scrollWidth vs clientWidth），建完就在同一次同步流程里定下来，不会先闪一帧。
   */
  private fold(nodes: HTMLElement[], more: HTMLElement): void {
    // 先收着量一次：**不摆折叠钮**就装得下，就根本不需要它 —— 摆上去再量会把「刚好装满」挤成溢出。
    // 文字先按最多的颗数占位，轮到它出场时宽度不会再变。
    more.textContent = tr("＋{p1}", { p1: nodes.length });
    more.hidden = true;
    if (!nodes.length || this.host.scrollWidth <= this.host.clientWidth) return;
    more.hidden = false;
    let folded = 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (this.host.scrollWidth <= this.host.clientWidth) break;
      const chip = nodes[i];
      if (chip.classList.contains("cur")) continue;
      chip.hidden = true;
      folded += 1;
    }
    if (!folded) {
      more.hidden = true;
      return;
    }
    const why = tr("还有 {p1} 个置顶会话", { p1: folded });
    more.textContent = tr("＋{p1}", { p1: folded });
    more.title = why;
    more.setAttribute("aria-label", why);
  }

  /**
   * Q-022: ★ 点过之后那颗胶囊已经换了位置 —— 焦点交给「同一位置还看得见的那颗」，
   * 缩到没有就交给外壳的第一颗尾巴按钮（＋开新会话）。
   */
  private restoreFocus(nodes: HTMLElement[], fallback: HTMLElement, heldKey: string | null): void {
    const focusStar = (target: HTMLElement): void => (target.querySelector<HTMLElement>(".pin-star") ?? target).focus();
    if (this.focusAt !== null) {
      const want = this.focusAt;
      this.focusAt = null;
      // D125：折起来的那几颗也是真节点，只是藏着 —— 焦点交给看不见的东西等于交给 <body>。
      const live = nodes.filter((n) => !n.hidden);
      focusStar(live[Math.min(want, live.length - 1)] ?? fallback);
      return;
    }
    if (!heldKey) return;
    const same = Array.from(this.host.querySelectorAll<HTMLElement>("[data-pin-key]")).find((n) => !n.hidden && n.dataset.pinKey === heldKey);
    if (same) same.focus();
    else focusStar(fallback);
  }

  /** 折起来的那几颗：点「＋N」列出全部，挑一个直接打开。 */
  private toggleMore(anchor: HTMLElement): void {
    if (this.more) {
      this.closeMore();
      return;
    }
    this.more = openPinList(
      anchor,
      this.chips.map((c) => ({ id: c.id, name: c.name, sub: c.sub, current: c.current })),
      (id) => {
        this.closeMore();
        this.opts.onOpen(id);
      },
      () => {
        this.more = null;
      },
    );
  }
}
