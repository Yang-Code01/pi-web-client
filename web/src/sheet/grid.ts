/**
 * 只读网格（#105 骨架 + #108 结构保真 + #107 交互）：行号列 + 列头 + 可视范围的格子。
 *
 * 取数只按可视窗口（window fetch）：滚动时带上 r0/r1/c0/c1 向桥端要这一片，
 * 不把整表拉下来。列宽、合并区、冻结窗格都取文件里的值；冻结的行列画在独立的
 * 覆盖层里，滚动时位置不动，所以标题行不会跟着内容跑掉。
 *
 * #107 的交互都在这一层：选区是个矩形（anchor + focus），方向键/Shift/拖选/双击改它；
 * Ctrl+C 出去的是 TSV 纯文本；缩放把行高与列宽同乘一个系数；查找的命中只存坐标。
 */
import { tr, errText } from "../i18n/index.ts";
import { clampNum } from "../floatwin.ts";
import type { SheetCell, SheetInfo, SheetMerge, SheetMeta, SheetWindow } from "../types.ts";

export const ROW_H = 28;
export const COL_W = 110;
export const HEAD_W = 44;
export const HEAD_H = 28;
/** #107：缩放的上下限与步长（从 100% 起，一次 ±10%）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** #110：每次取数在可见范围上下各预取几屏。 */
const PREFETCH_SCREENS = 3;
/** 桥端单次窗口上限（与 bridge/src/sheet/index.ts 的 400 行一致）。 */
const MAX_WINDOW_ROWS = 400;

interface Range {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface SheetGridHost {
  meta: SheetMeta;
  sheet: string;
  fetchWindow: (sheet: string, r0: number, r1: number, c0: number, c1: number) => Promise<SheetWindow>;
  /** #106：文件在预览之后被改过，桥端不认旧凭据了。 */
  onStale?: () => void;
  /** #111：选中格变了（公式栏跟着走）：`ref` 是 A1 式坐标，`text` 是公式原文或显示值。 */
  onSelect?: (sel: { ref: string; text: string } | null) => void;
}

/** 四个绘制层：主体、冻结行、冻结列、冻结角。 */
const L_MAIN = 0;
const L_TOP = 1;
const L_LEFT = 2;

function colName(c: number): string {
  let out = "";
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class SheetGrid {
  readonly root: HTMLElement;
  private readonly host: SheetGridHost;
  private readonly view: HTMLElement;
  private readonly space: HTMLElement;
  private readonly cells: HTMLElement;
  private readonly colheadIn: HTMLElement;
  private readonly rowheadIn: HTMLElement;
  private readonly colheadFrz: HTMLElement;
  private readonly rowheadFrz: HTMLElement;
  private readonly frzTop: HTMLElement;
  private readonly frzTopIn: HTMLElement;
  private readonly frzLeft: HTMLElement;
  private readonly frzLeftIn: HTMLElement;
  private readonly frzV: HTMLElement;
  private readonly frzH: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly cellsByKey = new Map<string, SheetCell>();
  private spans = new Map<string, SheetMerge>();
  /** 每列的左边界（px），长度 cols+1。 */
  private offsets: number[] = [0];
  /** 文件里的列宽（未缩放）。 */
  private base: number[] = [];
  /** 缩放之后的列宽（px）。 */
  private widths: number[] = [];
  private sheet: string;
  /** #110：已经拿到的窗口段（可能有多段，滚动时逐段补）。 */
  private chunks: Range[] = [];
  /** #110：换表/销毁时 +1，旧请求回来就对不上号，不再往新表里写。 */
  private epoch = 0;
  private loading = false;
  private again = false;
  private destroyed = false;
  private frame = 0;
  private error = "";
  private stale = false;
  /**
   * #111/#107：选区是个矩形。`anchor` 是起点（按 Shift 时它不动），`focus` 是活动格
   * （公式栏显示它，复制不用它——复制拿整个矩形）。打开时落在 A1，跟 Excel 一样。
   */
  private anchor: { r: number; c: number } = { r: 0, c: 0 };
  private focus: { r: number; c: number } = { r: 0, c: 0 };
  /** #107：缩放系数（1 = 100%）。行高与列宽同乘它，字体大小靠 CSS 变量 `--sd-z`。 */
  private zoomLevel = 1;
  /** #107：正在拖选（pointerdown 之后、pointerup 之前）。 */
  private dragging = false;
  /** #107：查找命中（只存坐标）与当前那一处；-1 表示只高亮不指。 */
  private hits: { r: number; c: number }[] = [];
  private hitAt = -1;
  /** 上一次按下的格子（毫秒），用来自己认双击。 */
  private lastTap = { t: 0, r: -1, c: -1 };

  constructor(host: SheetGridHost) {
    this.host = host;
    this.sheet = host.sheet;
    this.root = el("div", "sd-grid");
    this.root.append(el("div", "sd-corner"));

    const colhead = el("div", "sd-colhead");
    this.colheadIn = el("div", "sd-colhead-in");
    this.colheadFrz = el("div", "sd-colhead-frz");
    colhead.append(this.colheadIn, this.colheadFrz);

    const rowhead = el("div", "sd-rowhead");
    this.rowheadIn = el("div", "sd-rowhead-in");
    this.rowheadFrz = el("div", "sd-rowhead-frz");
    rowhead.append(this.rowheadIn, this.rowheadFrz);

    const wrap = el("div", "sd-viewwrap");
    this.view = el("div", "sd-view");
    this.space = el("div", "sd-space");
    this.cells = el("div", "sd-cells");
    this.space.append(this.cells);

    const frz = el("div", "sd-frz");
    this.frzTop = el("div", "sd-frz-t");
    this.frzTopIn = el("div", "sd-frz-in");
    this.frzTop.append(this.frzTopIn);
    this.frzLeft = el("div", "sd-frz-l");
    this.frzLeftIn = el("div", "sd-frz-in");
    this.frzLeft.append(this.frzLeftIn);
    this.frzV = el("div", "sd-frz-v");
    this.frzH = el("div", "sd-frz-h");
    // 顺序即层级：冻结行那条带子压住冻结列，横跨两者的合并标题才不会被裁掉。
    frz.append(this.frzLeft, this.frzTop, this.frzV, this.frzH);

    this.view.append(this.space);
    this.msg = el("div", "sd-msg");
    wrap.append(this.view, frz, this.msg);

    this.root.append(colhead, rowhead, wrap);
    this.measure();
    this.root.style.setProperty("--sd-z", "1");
    this.view.addEventListener("scroll", this.onScroll, { passive: true });
    // #107：网格自己能接键盘，所以点一下就能用方向键，不用先找输入框。
    this.view.tabIndex = 0;
    this.view.setAttribute("role", "grid");
    this.view.setAttribute("aria-label", tr("表格"));
    this.view.addEventListener("pointerdown", this.onPointerDown);
    this.view.addEventListener("pointermove", this.onPointerMove);
    this.view.addEventListener("pointerup", this.onPointerUp);
    this.view.addEventListener("pointercancel", this.onPointerUp);
    this.view.addEventListener("keydown", this.onKeyDown);
    this.view.addEventListener("copy", this.onCopy);
  }

  /** 首次取数；解析失败把话显示在网格中央。 */
  async start(): Promise<void> {
    const info = this.info();
    if (!info.rows || !info.cols) {
      this.show(tr("这张表是空的"));
      return;
    }
    await this.ensure();
  }

  /** 切到另一张表：位置归零、缓存清掉，文件里的结构按那张表重算。 */
  setSheet(name: string): void {
    if (name === this.sheet) return;
    this.sheet = name;
    this.host.sheet = name;
    this.epoch++;
    this.cellsByKey.clear();
    this.chunks = [];
    this.error = "";
    this.hits = [];
    this.hitAt = -1;
    this.anchor = { r: 0, c: 0 };
    this.focus = { r: 0, c: 0 };
    this.view.scrollTop = 0;
    this.view.scrollLeft = 0;
    this.measure();
    this.show("");
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  }

  get activeSheet(): string {
    return this.sheet;
  }

  destroy(): void {
    this.destroyed = true;
    this.epoch++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.view.removeEventListener("scroll", this.onScroll);
    this.view.removeEventListener("pointerdown", this.onPointerDown);
    this.view.removeEventListener("pointermove", this.onPointerMove);
    this.view.removeEventListener("pointerup", this.onPointerUp);
    this.view.removeEventListener("pointercancel", this.onPointerUp);
    this.view.removeEventListener("keydown", this.onKeyDown);
    this.view.removeEventListener("copy", this.onCopy);
    this.root.remove();
  }

  /** 浮窗宽度/高度变了：重算可视范围，必要时补一次窗口取数。 */
  refresh(): void {
    if (this.destroyed || this.stale) return;
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  }

  private info(): SheetInfo {
    return this.host.meta.sheets.find((s) => s.name === this.sheet) ?? {
      name: this.sheet,
      rows: this.host.meta.rows,
      cols: this.host.meta.cols,
    };
  }

  /** 列宽 / 合并区 / 冻结窗格按当前表重算。列宽先取文件值，再乘缩放。 */
  private measure(): void {
    const info = this.info();
    const cols = Math.max(0, info.cols);
    const fileWidths = info.colWidths ?? [];
    this.base = Array.from({ length: cols }, (_, c) => fileWidths[c] ?? COL_W);
    const offsets = [0];
    this.widths = [];
    for (let c = 0; c < cols; c++) {
      // 缩放之后仍留得住格子：再窄也要放得下一两个字符。
      const w = Math.max(28, Math.round(this.base[c] * this.zoomLevel));
      this.widths.push(w);
      offsets.push(offsets[c] + w);
    }
    this.offsets = offsets;
    this.space.style.width = `${offsets[cols] ?? 0}px`;
    this.space.style.height = `${(info.rows || 0) * this.rowH()}px`;

    this.spans = new Map();
    for (const m of info.merges ?? []) {
      const area = (m.r1 - m.r0 + 1) * (m.c1 - m.c0 + 1);
      if (area <= 1 || area > 20000) continue;
      for (let r = m.r0; r <= m.r1; r++) {
        for (let c = m.c0; c <= m.c1; c++) this.spans.set(`${r}:${c}`, m);
      }
    }
  }

  private freeze(): { rows: number; cols: number } {
    return this.info().freeze ?? { rows: 0, cols: 0 };
  }

  private leftOf(c: number): number {
    return this.offsets[c] ?? 0;
  }

  private widthOf(c: number): number {
    return this.widths[c] ?? COL_W;
  }

  /** 内容 x 落在第几列。 */
  private colAt(x: number): number {
    const info = this.info();
    let lo = 0;
    let hi = Math.max(0, info.cols - 1);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.leftOf(mid) <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * 一个块该画在哪一层。合并区按「整块」判定：标题 A1:H1 只有一行冻结，
   * 但横跨到非冻结列，整块都进冻结行那条带子，否则字会被裁掉。
   */
  private layerOf(r1: number, c1: number): number {
    const f = this.freeze();
    if (r1 < f.rows) return L_TOP;
    if (c1 < f.cols) return L_LEFT;
    return L_MAIN;
  }

  private onScroll = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.syncHeads();
      this.render();
      void this.ensure();
    });
  };

  /** 行高（px）：缩放之后格子、行号、冻结带都用这个。 */
  private rowH(): number {
    return Math.max(16, Math.round(ROW_H * this.zoomLevel));
  }

  /** #107：缩放系数（1 = 100%）。 */
  get zoom(): number {
    return this.zoomLevel;
  }

  /**
   * #107：缩放。行高与列宽同乘一个系数，滚动位置按同样比例挪——
   * 看着是「同一个格子留在原地变大」，不是跳回左上角。
   */
  setZoom(z: number): void {
    const next = Math.round(clampNum(z, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
    if (next === this.zoomLevel) return;
    const v = this.view;
    const cx = v.scrollLeft + v.clientWidth / 2;
    const cy = v.scrollTop + v.clientHeight / 2;
    const k = next / this.zoomLevel;
    this.zoomLevel = next;
    this.root.style.setProperty("--sd-z", String(next));
    this.measure();
    v.scrollLeft = Math.max(0, cx * k - v.clientWidth / 2);
    v.scrollTop = Math.max(0, cy * k - v.clientHeight / 2);
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  }

  /** #107：选区矩形（0 基闭区间）。 */
  private rect(): Range {
    return {
      r0: Math.min(this.anchor.r, this.focus.r),
      r1: Math.max(this.anchor.r, this.focus.r),
      c0: Math.min(this.anchor.c, this.focus.c),
      c1: Math.max(this.anchor.c, this.focus.c),
    };
  }

  /** 合并区归到左上角那一格：选它就等于选整块。 */
  private snap(pos: { r: number; c: number }): { r: number; c: number } {
    const span = this.spans.get(`${pos.r}:${pos.c}`);
    return span ? { r: span.r0, c: span.c0 } : pos;
  }

  /** #107：选区写成 A1 或 A2:C4——「引用给 pi」就是把这段插进对话框。 */
  get selectionRef(): string {
    const s = this.rect();
    const a = `${colName(s.c0)}${s.r0 + 1}`;
    const b = `${colName(s.c1)}${s.r1 + 1}`;
    return a === b ? a : `${a}:${b}`;
  }

  /** #107：选区的纯文本：制表符分列、换行分行，空格子留空位（行列才对得上）。 */
  get selectionText(): string {
    const s = this.rect();
    const lines: string[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const row: string[] = [];
      for (let c = s.c0; c <= s.c1; c++) {
        const cell = this.cellsByKey.get(`${r}:${c}`);
        // 数字格复制原始值（粘回去还是数，不是「￥1,234」），其余复制显示串。
        row.push(cell?.v != null ? String(cell.v) : cell?.t ?? "");
      }
      lines.push(row.join("\t"));
    }
    return lines.join("\n");
  }

  /** 把键盘焦点给网格（查找框收起之后回到格子上）。 */
  focusView(): void {
    this.view.focus({ preventScroll: true });
  }

  /** #107：鼠标按下定起点；拖动改活动格，Shift 时保留原起点。双击（400ms 内再按同一格）选一片连续区。 */
  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const pos = this.pointCell(ev.clientX, ev.clientY);
    if (!pos) return;
    const anchor = this.snap(pos);
    const now = Date.now();
    // 自己认双击：pointer capture 下浏览器不派 dblclick（踩过）。
    const again = now - this.lastTap.t < 400 && this.lastTap.r === pos.r && this.lastTap.c === pos.c;
    this.lastTap = { t: again ? 0 : now, r: pos.r, c: pos.c };
    if (again) {
      this.dragging = false;
      this.selectBlock(pos);
      this.focusView();
      this.afterSelect();
      return;
    }
    if (ev.shiftKey) this.focus = pos;
    else {
      this.anchor = anchor;
      this.focus = pos;
    }
    this.dragging = true;
    try {
      this.view.setPointerCapture(ev.pointerId);
    } catch {
      /* 不支持的浏览器就靠抬起事件自己收尾 */
    }
    this.focusView();
    this.afterSelect(false);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.dragging) return;
    const pos = this.pointCell(ev.clientX, ev.clientY);
    if (!pos || (pos.r === this.focus.r && pos.c === this.focus.c)) return;
    this.focus = pos;
    this.afterSelect(false);
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.view.releasePointerCapture(ev.pointerId);
    } catch {
      /* 已经松开 */
    }
  };

  /**
   * 选区改完的统一尾巴：重画、告诉公式栏、补数据。
   * 只改选中态时用 `paintSelection`，不重建格子——否则第二次点击会落到新节点上，
   * 浏览器就凑不出 `dblclick`（踩过的坑）。
   */
  private afterSelect(repaint = true): void {
    this.hitAt = -1;
    if (repaint) this.render();
    else this.paintSelection();
    this.notify();
    void this.ensure();
  }

  /** 就地换 `.sel` / `.in-sel`，不动 DOM 结构。 */
  private paintSelection(): void {
    const sel = this.rect();
    for (const node of this.root.querySelectorAll<HTMLElement>(".sd-cell[data-r]")) {
      const r = Number(node.dataset.r);
      const c = Number(node.dataset.c);
      const cur = r === this.focus.r && c === this.focus.c;
      const inside = !cur && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
      node.classList.toggle("sel", cur);
      node.classList.toggle("in-sel", inside);
    }
  }

  /** #107：从一格往四个方向扩一块连续区（碰空格就停，和 Excel 一个意思）。 */
  private selectBlock(at: { r: number; c: number }): void {
    const info = this.info();
    const filled = (r: number, c: number): boolean => this.cellsByKey.has(`${r}:${c}`);
    let { r0, r1, c0, c1 } = { r0: at.r, r1: at.r, c0: at.c, c1: at.c };
    if (filled(at.r, at.c)) {
      while (r0 > 0 && filled(r0 - 1, at.c)) r0--;
      while (r1 < info.rows - 1 && filled(r1 + 1, at.c)) r1++;
      while (c0 > 0 && filled(at.r, c0 - 1)) c0--;
      while (c1 < info.cols - 1 && filled(at.r, c1 + 1)) c1++;
    }
    this.anchor = { r: r0, c: c0 };
    this.focus = { r: r1, c: c1 };
  }

  /** #107：方向键 / Home / End / PageUp / PageDown；按住 Shift 是扩，不按是换格。 */
  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const info = this.info();
    if (!info.rows || !info.cols) return;
    const page = Math.max(1, Math.floor(this.view.clientHeight / this.rowH()) - 1);
    let r = this.focus.r;
    let c = this.focus.c;
    switch (ev.key) {
      case "ArrowUp":
        r -= 1;
        break;
      case "ArrowDown":
        r += 1;
        break;
      case "ArrowLeft":
        c -= 1;
        break;
      case "ArrowRight":
        c += 1;
        break;
      case "Home":
        c = 0;
        break;
      case "End":
        c = info.cols - 1;
        break;
      case "PageUp":
        r -= page;
        break;
      case "PageDown":
        r += page;
        break;
      default:
        return;
    }
    ev.preventDefault();
    const next = { r: clampNum(r, 0, info.rows - 1), c: clampNum(c, 0, info.cols - 1) };
    if (ev.shiftKey) this.focus = next;
    else {
      this.anchor = next;
      this.focus = next;
    }
    this.reveal(next.r, next.c);
    this.hitAt = -1;
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  };

  /** #107：Ctrl/Cmd+C 出去的是纯文本 TSV（只有选区里的显示值）。 */
  private onCopy = (ev: ClipboardEvent): void => {
    const text = this.selectionText;
    if (!text) return;
    ev.clipboardData?.setData("text/plain", text);
    ev.preventDefault();
  };

  /** 把某格挪进可视区（冻结带让出的位置算进去）；键盘走位和查找跳转都用它。 */
  private reveal(r: number, c: number): void {
    const v = this.view;
    const f = this.freeze();
    const h = this.rowH();
    const top = r * h;
    const frzH = f.rows * h;
    if (r >= f.rows) {
      if (top < v.scrollTop + frzH) v.scrollTop = Math.max(0, top - frzH);
      else if (top + h > v.scrollTop + v.clientHeight) v.scrollTop = top + h - v.clientHeight;
    }
    const left = this.leftOf(c);
    const frzW = this.leftOf(f.cols);
    if (c >= f.cols) {
      if (left < v.scrollLeft + frzW) v.scrollLeft = Math.max(0, left - frzW);
      else if (left + this.widthOf(c) > v.scrollLeft + v.clientWidth) v.scrollLeft = left + this.widthOf(c) - v.clientWidth;
    }
  }

  /** 让命中格落在可视区中间，跳转时眼睛不用自己找。 */
  private centre(r: number, c: number): void {
    const v = this.view;
    const f = this.freeze();
    const h = this.rowH();
    const frzH = f.rows * h;
    const frzW = this.leftOf(f.cols);
    const viewH = Math.max(1, v.clientHeight - frzH);
    const viewW = Math.max(1, v.clientWidth - frzW);
    if (r >= f.rows) v.scrollTop = Math.max(0, r * h - frzH - viewH / 2 + h / 2);
    if (c >= f.cols) v.scrollLeft = Math.max(0, this.leftOf(c) - frzW - viewW / 2 + this.widthOf(c) / 2);
  }

  /** #107：把查找的命中交给网格；`at` 是当前那一处（-1 表示只高亮、不挪选区）。 */
  setHits(hits: { r: number; c: number }[], at = 0): void {
    this.hits = hits;
    this.hitAt = hits.length ? Math.max(0, Math.min(hits.length - 1, at)) : -1;
    if (this.hitAt >= 0) {
      const hit = this.hits[this.hitAt];
      this.anchor = hit;
      this.focus = hit;
      this.centre(hit.r, hit.c);
    }
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  }

  /** 跳到第 `at` 处命中（超界会绕回来，跟查找框的 ‹ › 一个意思）。 */
  setHitAt(at: number): void {
    const n = this.hits.length;
    if (!n) {
      this.hitAt = -1;
      return;
    }
    this.hitAt = ((at % n) + n) % n;
    const hit = this.hits[this.hitAt];
    this.anchor = hit;
    this.focus = hit;
    this.centre(hit.r, hit.c);
    this.syncHeads();
    this.render();
    this.notify();
    void this.ensure();
  }

  /** 屏幕坐标落在哪一格：冻结带里的格子滚动时不动，其余按滚动偏移加回去。 */
  private pointCell(clientX: number, clientY: number): { r: number; c: number } | null {
    const info = this.info();
    if (!info.rows || !info.cols) return null;
    const rect = this.view.getBoundingClientRect();
    // 用 clientWidth/Height 判界：滚动条那条缝不该被当成格子。
    const left = rect.left + this.view.clientLeft;
    const top = rect.top + this.view.clientTop;
    if (clientX < left || clientY < top || clientX > left + this.view.clientWidth || clientY > top + this.view.clientHeight) return null;
    const f = this.freeze();
    let x = clientX - left;
    let y = clientY - top;
    if (x >= this.leftOf(f.cols)) x += this.view.scrollLeft;
    if (y >= f.rows * this.rowH()) y += this.view.scrollTop;
    const r = Math.floor(y / this.rowH());
    const c = this.colAt(Math.max(0, x));
    if (r < 0 || r >= info.rows || c < 0 || c >= info.cols) return null;
    return { r, c };
  }

  /** 把选中格报给外面：公式给原文（带 `=`），普通格给显示值；坐标是选区（`A2:C4`）。 */
  private notify(): void {
    if (this.destroyed) return;
    const sel = this.focus;
    const cell = this.cellsByKey.get(`${sel.r}:${sel.c}`);
    const text = cell?.f ? `=${cell.f}` : cell?.t ?? "";
    this.host.onSelect?.({ ref: this.selectionRef, text });
  }

  private visible(): Range | null {
    const info = this.info();
    const rows = info.rows || 0;
    const cols = info.cols || 0;
    if (!rows || !cols) return null;
    const top = this.view.scrollTop;
    const left = this.view.scrollLeft;
    const h = this.rowH();
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(top / h)));
    const r1 = Math.max(r0, Math.min(rows - 1, Math.ceil((top + this.view.clientHeight) / h) - 1));
    const c0 = Math.max(0, Math.min(cols - 1, this.colAt(left)));
    const c1 = Math.max(c0, Math.min(cols - 1, this.colAt(left + this.view.clientWidth)));
    return { r0, r1, c0, c1 };
  }

  /** 要取的范围：可见行上下各 3 屏（#110），列只要可见的那一段（冻结列带动从 0 起）。 */
  private wantRange(visible: Range): Range {
    const info = this.info();
    const rows = info.rows || 0;
    const f = this.freeze();
    const screen = Math.max(1, Math.ceil(this.view.clientHeight / ROW_H));
    const pad = screen * PREFETCH_SCREENS;
    let r0 = Math.max(0, visible.r0 - pad);
    let r1 = Math.min(rows - 1, visible.r1 + pad);
    // 桥端单次最多 400 行：保可见段，超了就把预取往前缩。
    if (r1 - r0 > MAX_WINDOW_ROWS - 1) {
      r0 = Math.max(0, visible.r1 - (MAX_WINDOW_ROWS - 1));
      if (visible.r0 < r0) r0 = Math.max(0, visible.r0 - (MAX_WINDOW_ROWS - 1 - (visible.r1 - visible.r0)));
      r1 = Math.min(rows - 1, r0 + MAX_WINDOW_ROWS - 1);
    }
    return { r0, r1, c0: f.cols > 0 ? 0 : visible.c0, c1: visible.c1 };
  }

  /** 冻结带单独要一小段：主窗口从当前滚动位置开始，不必每次都从第 0 行解起。 */
  private frozenRange(visible: Range): Range | null {
    const f = this.freeze();
    if (f.rows <= 0) return null;
    return { r0: 0, r1: Math.max(0, f.rows - 1), c0: 0, c1: Math.max(visible.c1, f.cols - 1) };
  }

  private covers(want: Range): boolean {
    return this.chunks.some((got) => got.r0 <= want.r0 && got.r1 >= want.r1 && got.c0 <= want.c0 && got.c1 >= want.c1);
  }

  /** 收下一段数据；被它完全盖住的旧段合并掉，离当前视口太远的段清出去。 */
  private addChunk(range: Range): void {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const ch = this.chunks[i];
      if (ch.r0 >= range.r0 && ch.r1 <= range.r1 && ch.c0 >= range.c0 && ch.c1 <= range.c1) this.chunks.splice(i, 1);
    }
    this.chunks.push(range);
    this.prune();
  }

  /** 只留当前视口上下 12 屏内的段（外加冻结行）：拖很远也不让格子缓存无限长。 */
  private prune(): void {
    const visible = this.visible();
    if (!visible) return;
    const screen = Math.max(1, Math.ceil(this.view.clientHeight / ROW_H));
    const lo = Math.max(0, visible.r0 - 12 * screen);
    const hi = visible.r1 + 12 * screen;
    const f = this.freeze();
    const kept: Range[] = [];
    const dropped: Range[] = [];
    for (const ch of this.chunks) {
      const frozen = f.rows > 0 && ch.r0 === 0 && ch.r1 < f.rows;
      (frozen || (ch.r1 >= lo && ch.r0 <= hi) ? kept : dropped).push(ch);
    }
    this.chunks = kept;
    if (!dropped.length) return;
    for (const ch of dropped) {
      for (let r = ch.r0; r <= ch.r1; r++) {
        for (let c = ch.c0; c <= ch.c1; c++) {
          if (kept.some((k) => k.r0 <= r && k.r1 >= r && k.c0 <= c && k.c1 >= c)) continue;
          this.cellsByKey.delete(`${r}:${c}`);
        }
      }
    }
  }

  private async ensure(): Promise<void> {
    if (this.stale) return;
    const visible = this.visible();
    if (!visible) {
      this.render();
      return;
    }
    const wants: Range[] = [];
    const main = this.wantRange(visible);
    if (!this.covers(main)) wants.push(main);
    const frozen = this.frozenRange(visible);
    if (frozen && !this.covers(frozen)) wants.push(frozen);
    if (!wants.length) {
      this.render();
      return;
    }
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    const epoch = this.epoch;
    if (!this.cellsByKey.size) this.show(tr("正在读取…"));
    try {
      for (const want of wants) {
        if (this.destroyed || epoch !== this.epoch) return;
        if (this.covers(want)) continue;
        const win = await this.host.fetchWindow(this.sheet, want.r0, want.r1, want.c0, want.c1);
        if (this.destroyed || epoch !== this.epoch) return;
        for (const row of win.rows) {
          for (const cell of row.cells) this.cellsByKey.set(`${row.r}:${cell.c}`, cell);
        }
        // 用桥端实际返回的范围记账（可能被 400 行/100 列上限夹过），不是请求范围。
        this.addChunk({ r0: win.r0, r1: win.r1, c0: win.c0, c1: win.c1 });
        this.error = "";
        this.show("");
      }
    } catch (err) {
      if (this.destroyed || epoch !== this.epoch) return;
      // 文件被改过（Excel 另存、脚本重写）：停下来交给浮窗说清楚，不继续摆旧数据（#106）。
      if ((err as { code?: string } | null)?.code === "sheet_stale") {
        this.stale = true;
        this.host.onStale?.();
        return;
      }
      this.error = errText(err);
      if (!this.cellsByKey.size) this.show(tr("读不了这张表：{p1}", { p1: this.error }));
    } finally {
      this.loading = false;
      if (this.destroyed) return;
      if (epoch !== this.epoch) {
        void this.ensure();
        return;
      }
      this.render();
      this.notify();
      if (this.again) {
        this.again = false;
        void this.ensure();
      }
    }
  }

  private show(text: string): void {
    this.msg.textContent = text;
    this.msg.hidden = !text;
  }

  private syncHeads(): void {
    const dx = -this.view.scrollLeft;
    const dy = -this.view.scrollTop;
    this.colheadIn.style.transform = `translateX(${dx}px)`;
    this.rowheadIn.style.transform = `translateY(${dy}px)`;
    this.frzTopIn.style.transform = `translateX(${dx}px)`;
    this.frzLeftIn.style.transform = `translateY(${dy}px)`;
  }

  private render(): void {
    if (this.destroyed) return;
    const want = this.visible();
    if (!want) return;
    this.syncHeads();
    const f = this.freeze();
    const frzW = this.leftOf(f.cols);
    const rowH = this.rowH();
    const frzH = f.rows * rowH;

    const cols: HTMLElement[] = [];
    const frzCols: HTMLElement[] = [];
    for (let c = want.c0; c <= want.c1; c++) {
      const node = el("div", "sd-col", colName(c));
      node.dataset.c = String(c);
      node.style.left = `${this.leftOf(c)}px`;
      node.style.width = `${this.widthOf(c)}px`;
      (c < f.cols ? frzCols : cols).push(node);
    }
    this.colheadIn.replaceChildren(...cols);
    this.colheadFrz.replaceChildren(...frzCols);
    this.colheadFrz.hidden = !f.cols;
    this.colheadFrz.style.width = `${frzW}px`;

    const rowheads: HTMLElement[] = [];
    const frzRows: HTMLElement[] = [];
    for (let r = want.r0; r <= want.r1; r++) {
      const node = el("div", "sd-rowno", String(r + 1));
      node.dataset.r = String(r);
      node.style.top = `${r * rowH}px`;
      node.style.height = `${rowH}px`;
      (r < f.rows ? frzRows : rowheads).push(node);
    }
    this.rowheadIn.replaceChildren(...rowheads);
    this.rowheadFrz.replaceChildren(...frzRows);
    this.rowheadFrz.hidden = !f.rows;
    this.rowheadFrz.style.height = `${frzH}px`;

    // 冻结层要画「整条冻结带」，不只是可视范围：滚到第 15 行时第 1 行仍然得在。
    this.paint(this.cells, L_MAIN, want);
    this.paint(this.frzTopIn, L_TOP, { r0: 0, r1: Math.max(0, f.rows - 1), c0: 0, c1: Math.max(want.c1, f.cols) });
    this.paint(this.frzLeftIn, L_LEFT, { r0: want.r0, r1: want.r1, c0: 0, c1: Math.max(0, f.cols - 1) });

    // 冻结层里的格子仍用整表坐标，所以两条带子的内层原点就是整表原点。
    this.frzTopIn.style.left = "0px";
    this.frzLeftIn.style.top = "0px";
    this.frzTop.style.height = `${frzH}px`;
    this.frzTop.hidden = !f.rows;
    this.frzLeft.style.width = `${frzW}px`;
    this.frzLeft.hidden = !f.cols;
    this.frzV.style.left = `${frzW}px`;
    this.frzV.hidden = !f.cols;
    this.frzH.style.top = `${frzH}px`;
    this.frzH.hidden = !f.rows;
  }

  /** 往某一层里画格子：被合并区盖住的格子不单独画，合并区只画左上角那一个。 */
  private paint(target: HTMLElement, layer: number, want: Range): void {
    const nodes: HTMLElement[] = [];
    // #107：选区是高亮垫在字下面；查找命中另用一种颜色，当前那一处再加一圈描边。
    const sel = this.rect();
    const hitKeys = new Set(this.hits.map((h) => `${h.r}:${h.c}`));
    const curKey = this.hitAt >= 0 ? `${this.hits[this.hitAt].r}:${this.hits[this.hitAt].c}` : "";
    const rowH = this.rowH();
    for (let r = want.r0; r <= want.r1; r++) {
      for (let c = want.c0; c <= want.c1; c++) {
        const cell = this.cellsByKey.get(`${r}:${c}`);
        const span = this.spans.get(`${r}:${c}`);
        if (span && (span.r0 !== r || span.c0 !== c)) continue;
        const r0 = span ? span.r0 : r;
        const c0 = span ? span.c0 : c;
        const r1 = span ? span.r1 : r;
        const c1 = span ? span.c1 : c;
        if (this.layerOf(r1, c1) !== layer) continue;
        // 空格子也画一层底：不然整列空着会露出底下的白，网格线断成一段一段。
        const node = el("div", cell ? `sd-cell k-${cell.k}` : "sd-cell is-void", cell?.t);
        // #109 条件格式：只能贴服务端算好的结果，不在前端重算规则。
        if (cell?.fx) {
          const fx = cell.fx;
          if (fx.bg) node.style.backgroundColor = fx.bg;
          if (fx.fg) node.style.color = fx.fg;
          if (fx.b) node.style.fontWeight = "600";
          if (fx.bar) {
            node.textContent = "";
            const bar = el("span", "sd-bar");
            bar.style.width = `${Math.round(fx.bar[0] * 1000) / 10}%`;
            bar.style.backgroundColor = fx.bar[1];
            node.append(bar, el("span", "sd-txt", cell.t));
          } else if (fx.icon) {
            node.textContent = "";
            const icon = el("span", "sd-icon", fx.icon.g);
            icon.dataset.set = fx.icon.s;
            icon.dataset.level = String(fx.icon.l);
            icon.style.color = fx.icon.c;
            node.style.justifyContent = "flex-start";
            node.append(icon, el("span", "sd-txt", cell.t));
          }
        }
        node.dataset.r = String(r0);
        node.dataset.c = String(c0);
        if (c1 > c0) node.dataset.span = `${c0}-${c1}`;
        node.style.left = `${this.leftOf(c0)}px`;
        node.style.top = `${r0 * rowH}px`;
        node.style.width = `${this.leftOf(c1 + 1) - this.leftOf(c0)}px`;
        node.style.height = `${(r1 - r0 + 1) * rowH}px`;
        if (cell?.k === "n") node.classList.add("is-n");
        // #111：只有公式、没存结果的格子：显空 + 红虚线；原文和「去 Excel 重算」放在悬停里。
        if (cell?.noCache) {
          node.classList.add("is-nc");
          node.title = [cell.f ? `=${cell.f}` : "", tr("需用表格软件重算")].filter(Boolean).join("\n");
        }
        if (this.focus.r === r0 && this.focus.c === c0) node.classList.add("sel");
        // 合并区按左上角算：选到块里任何一格，整块都该亮。
        if (r0 >= sel.r0 && r0 <= sel.r1 && c0 >= sel.c0 && c0 <= sel.c1) node.classList.add("in-sel");
        const key = `${r0}:${c0}`;
        if (hitKeys.has(key)) {
          node.classList.add("hit");
          if (key === curKey) node.classList.add("hit-on");
        }
        if (cell?.a) {
          node.style.justifyContent = cell.a === "c" ? "center" : cell.a === "r" ? "flex-end" : "flex-start";
          if (cell.a !== "r") node.classList.remove("is-n");
        }
        nodes.push(node);
      }
    }
    target.replaceChildren(...nodes);
  }
}
