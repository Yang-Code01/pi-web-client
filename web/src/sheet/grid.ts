/**
 * 只读网格（#105 骨架 + #108 结构保真）：行号列 + 列头 + 可视范围的格子。
 *
 * 取数只按可视窗口（window fetch）：滚动时带上 r0/r1/c0/c1 向桥端要这一片，
 * 不把整表拉下来。列宽、合并区、冻结窗格都取文件里的值；冻结的行列画在独立的
 * 覆盖层里，滚动时位置不动，所以标题行不会跟着内容跑掉。
 */
import { tr, errText } from "../i18n/index.ts";
import type { SheetCell, SheetInfo, SheetMerge, SheetMeta, SheetWindow } from "../types.ts";

export const ROW_H = 28;
export const COL_W = 110;
export const HEAD_W = 44;
export const HEAD_H = 28;

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
  private widths: number[] = [];
  private sheet: string;
  private loaded: Range | null = null;
  private loading = false;
  private again = false;
  private destroyed = false;
  private frame = 0;
  private error = "";
  private stale = false;

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
    this.view.addEventListener("scroll", this.onScroll, { passive: true });
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
    this.cellsByKey.clear();
    this.loaded = null;
    this.error = "";
    this.view.scrollTop = 0;
    this.view.scrollLeft = 0;
    this.measure();
    this.show("");
    this.syncHeads();
    this.render();
    void this.ensure();
  }

  get activeSheet(): string {
    return this.sheet;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.view.removeEventListener("scroll", this.onScroll);
    this.root.remove();
  }

  /** 浮窗宽度/高度变了：重算可视范围，必要时补一次窗口取数。 */
  refresh(): void {
    if (this.destroyed || this.stale) return;
    this.syncHeads();
    this.render();
    void this.ensure();
  }

  private info(): SheetInfo {
    return this.host.meta.sheets.find((s) => s.name === this.sheet) ?? {
      name: this.sheet,
      rows: this.host.meta.rows,
      cols: this.host.meta.cols,
    };
  }

  /** 列宽 / 合并区 / 冻结窗格按当前表重算。 */
  private measure(): void {
    const info = this.info();
    const cols = Math.max(0, info.cols);
    const fileWidths = info.colWidths ?? [];
    this.widths = Array.from({ length: cols }, (_, c) => fileWidths[c] ?? COL_W);
    const offsets = [0];
    for (let c = 0; c < cols; c++) offsets.push(offsets[c] + this.widths[c]);
    this.offsets = offsets;
    this.space.style.width = `${offsets[cols] ?? 0}px`;
    this.space.style.height = `${(info.rows || 0) * ROW_H}px`;

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

  private visible(): Range | null {
    const info = this.info();
    const rows = info.rows || 0;
    const cols = info.cols || 0;
    if (!rows || !cols) return null;
    const top = this.view.scrollTop;
    const left = this.view.scrollLeft;
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(top / ROW_H)));
    const r1 = Math.max(r0, Math.min(rows - 1, Math.ceil((top + this.view.clientHeight) / ROW_H) - 1));
    const c0 = Math.max(0, Math.min(cols - 1, this.colAt(left)));
    const c1 = Math.max(c0, Math.min(cols - 1, this.colAt(left + this.view.clientWidth)));
    return { r0, r1, c0, c1 };
  }

  /** 要取的范围：冻结的行列永远带上，否则滚远了冻结带就没有格子可画。 */
  private fetchRange(want: Range): Range {
    const f = this.freeze();
    return {
      r0: f.rows > 0 ? 0 : want.r0,
      r1: want.r1,
      c0: f.cols > 0 ? 0 : want.c0,
      c1: want.c1,
    };
  }

  private covers(want: Range): boolean {
    const got = this.loaded;
    return !!got && got.r0 <= want.r0 && got.r1 >= want.r1 && got.c0 <= want.c0 && got.c1 >= want.c1;
  }

  private async ensure(): Promise<void> {
    if (this.stale) return;
    const visible = this.visible();
    // 冻结的行/列永远带上，否则滚远了冻结带就没有格子可画。
    const want = visible ? this.fetchRange(visible) : null;
    if (!want || this.covers(want)) {
      this.render();
      return;
    }
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    if (!this.cellsByKey.size) this.show(tr("正在读取…"));
    try {
      const win = await this.host.fetchWindow(this.sheet, want.r0, want.r1, want.c0, want.c1);
      if (this.destroyed) return;
      for (const row of win.rows) {
        for (const cell of row.cells) this.cellsByKey.set(`${row.r}:${cell.c}`, cell);
      }
      this.loaded = want;
      this.error = "";
      this.show("");
    } catch (err) {
      if (this.destroyed) return;
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
      this.render();
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
    const frzH = f.rows * ROW_H;

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
      node.style.top = `${r * ROW_H}px`;
      node.style.height = `${ROW_H}px`;
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
        node.style.top = `${r0 * ROW_H}px`;
        node.style.width = `${this.leftOf(c1 + 1) - this.leftOf(c0)}px`;
        node.style.height = `${(r1 - r0 + 1) * ROW_H}px`;
        if (cell?.k === "n") node.classList.add("is-n");
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
