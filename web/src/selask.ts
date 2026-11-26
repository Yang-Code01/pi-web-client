/**
 * 聊天记录里拖选一段文字，松手后冒出来的那颗「问一下」（D416）：点了把它送到随手问，以 `>` 引用
 * 插进输入框（真正的打开与插入是 App / `ScratchChat.quote()` 的事，这里只管那颗胶囊）。
 *
 * 两个必须自己算的地方：
 *
 * 1. **位置**。`#app` 上挂着 `zoom: var(--ui-scale)`，`getBoundingClientRect()` 给的是视觉 px，
 *    而写进 style 的 px 是布局 px —— 所以落位一律「先按视觉 px 算、再除一次缩放」（D123 的老坑）。
 * 2. **什么时候不算数**。输入框 / 可编辑区里的选区不弹（那是用户在自己写的东西里选字），
 *    聊天区外面的也不弹（这里只管聊天记录）。
 */
import { icon } from "./icons.ts";
import { tr } from "./i18n/index.ts";
import { quoteBlock } from "./quoteblock.ts";

export interface SelAskOpts {
  /** 选区要落在这个元素里才认（聊天区 `.chat-scroll`）；返回 null 就不弹。 */
  scope: () => HTMLElement | null;
  /** 视觉 px → 布局 px 的除数（`#app` 的 zoom）。 */
  scale: () => number;
  /** 胶囊挂哪（`#app`：跟着字号缩放，别挂 body 上写死 px）。 */
  host: () => HTMLElement | null;
  /** 点了胶囊：把选中的文字（原文，未折成引用）交出去。 */
  onAsk: (text: string) => void;
}

/** 胶囊与选区之间留的缝（视觉 px）。 */
const GAP = 6;
/** 离窗口边缘至少留这么多 —— 拖到屏幕底部时不许把胶囊挤出去。 */
const EDGE = 8;

export class SelAsk {
  private btn: HTMLButtonElement | null = null;
  private label: HTMLElement | null = null;
  private readonly opts: SelAskOpts;
  /** 拖选那一刻的原文。点胶囊时选区多半已经被点没了，所以得在 mouseup 时就记下来。 */
  private text = "";
  private timer = 0;
  private started = false;

  constructor(opts: SelAskOpts) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // 捕获阶段听：聊天区自己也会在 mouseup / mousedown 上做事（跟流、折叠），别被它们的 stopPropagation 吞掉。
    document.addEventListener("mouseup", this.onUp, true);
    document.addEventListener("mousedown", this.onDown, true);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("scroll", this.hide, true);
    window.addEventListener("resize", this.hide);
  }

  /** 收起来。选区本身不动 —— 用户还能接着按 Ctrl+C。 */
  hide = (): void => {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.text = "";
    if (this.btn) this.btn.hidden = true;
  };

  private readonly onUp = (ev: MouseEvent): void => {
    if (ev.button !== 0) return;
    if (this.btn && ev.target instanceof Node && this.btn.contains(ev.target)) return;
    // 拖选的最后一个 range 在 mouseup 之后才落定，这一拍量出来可能还是上一次的位置。
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.sync();
    }, 0);
  };

  private readonly onDown = (ev: MouseEvent): void => {
    // 点胶囊自己：别让它把选区点没（选区没了就没有文字可引用了）。
    if (this.btn && ev.target instanceof Node && this.btn.contains(ev.target)) {
      ev.preventDefault();
      return;
    }
    this.hide();
  };

  /** 选区被点掉 / 折叠了（方向键、点别处）：胶囊跟着走。 */
  private readonly onSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) this.hide();
  };

  private readonly onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.hide();
  };

  /** 当前选区能不能弹；能的话把胶囊摆到选区末行的下方。 */
  private sync(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hide();
    const text = sel.toString();
    if (!text.trim() || !quoteBlock(text)) return this.hide();
    const range = sel.getRangeAt(0);
    const scope = this.opts.scope();
    if (!scope || !scope.contains(range.commonAncestorContainer)) return this.hide();
    const focus = range.commonAncestorContainer;
    const holder = focus.nodeType === Node.ELEMENT_NODE ? (focus as Element) : focus.parentElement;
    if (holder?.closest("textarea, input, [contenteditable]:not([contenteditable='false'])")) return this.hide();
    // 被拆成好几截的选区（跨气泡）只认最后一行的位置：胶囊挨着「选到哪儿」，不按整段的框走。
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    const last = rects[rects.length - 1];
    if (!last) return this.hide();

    this.text = text;
    const btn = this.ensure();
    if (this.label) this.label.textContent = tr("问一下");
    btn.title = tr("把选中的这段拿到随手问里引用");
    btn.setAttribute("aria-label", btn.title);
    btn.hidden = false;

    const s = this.opts.scale() || 1;
    const w = btn.offsetWidth * s;
    const h = btn.offsetHeight * s;
    const maxLeft = Math.max(EDGE, window.innerWidth - w - EDGE);
    const left = Math.min(Math.max(last.right - w, EDGE), maxLeft);
    let top = last.bottom + GAP * s;
    // 底下放不下就翻到选区上方 —— 拖在屏幕最底部那几行时胶囊不能跑到窗口外面。
    if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, last.top - h - GAP * s);
    btn.style.left = `${left / s}px`;
    btn.style.top = `${top / s}px`;
  }

  private ensure(): HTMLButtonElement {
    if (this.btn) return this.btn;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sel-ask";
    btn.hidden = true;
    btn.append(icon("sparkle", { size: 13 }));
    this.label = document.createElement("span");
    btn.append(this.label);
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = this.text;
      this.hide();
      if (text) this.opts.onAsk(text);
    };
    (this.opts.host() ?? document.body).append(btn);
    this.btn = btn;
    return btn;
  }
}
