/**
 * 只读网格（#105 骨架）：行号列 + 列头 + 可视范围的格子。
 *
 * 取数只按可视窗口（window fetch）：滚动时带上 r0/r1/c0/c1 向桥端要这一片，
 * 不把整表拉下来。列的宽高暂用常量，文件里的列宽那条票（#108）再换。
 */
import { tr, errText } from "../i18n/index.ts";
import type { SheetCell, SheetMeta, SheetWindow } from "../types.ts";

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
}

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
  private readonly msg: HTMLElement;
  private readonly cellsByKey = new Map<string, SheetCell>();
  private loaded: Range | null = null;
  private loading = false;
  private again = false;
  private destroyed = false;
  private frame = 0;
  private error = "";

  constructor(host: SheetGridHost) {
    this.host = host;
    this.root = el("div", "sd-grid");
    this.root.append(el("div", "sd-corner"));

    const colhead = el("div", "sd-colhead");
    this.colheadIn = el("div", "sd-colhead-in");
    colhead.append(this.colheadIn);

    const rowhead = el("div", "sd-rowhead");
    this.rowheadIn = el("div", "sd-rowhead-in");
    rowhead.append(this.rowheadIn);

    const wrap = el("div", "sd-viewwrap");
    this.view = el("div", "sd-view");
    this.space = el("div", "sd-space");
    this.cells = el("div", "sd-cells");
    this.space.append(this.cells);
    this.view.append(this.space);
    this.msg = el("div", "sd-msg");
    wrap.append(this.view, this.msg);

    this.root.append(colhead, rowhead, wrap);
    this.space.style.width = `${host.meta.cols * COL_W}px`;
    this.space.style.height = `${host.meta.rows * ROW_H}px`;
    this.view.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /** 首次取数；解析失败把话显示在网格中央。 */
  async start(): Promise<void> {
    if (!this.host.meta.rows || !this.host.meta.cols) {
      this.show(tr("这张表是空的"));
      return;
    }
    await this.ensure();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.view.removeEventListener("scroll", this.onScroll);
    this.root.remove();
  }

  /** 浮窗宽度/高度变了：重算可视范围，必要时补一次窗口取数。 */
  refresh(): void {
    if (this.destroyed) return;
    this.syncHeads();
    this.render();
    void this.ensure();
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
    const { rows, cols } = this.host.meta;
    if (!rows || !cols) return null;
    const top = this.view.scrollTop;
    const left = this.view.scrollLeft;
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(top / ROW_H)));
    const r1 = Math.max(r0, Math.min(rows - 1, Math.ceil((top + this.view.clientHeight) / ROW_H) - 1));
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(left / COL_W)));
    const c1 = Math.max(c0, Math.min(cols - 1, Math.ceil((left + this.view.clientWidth) / COL_W) - 1));
    return { r0, r1, c0, c1 };
  }

  private covers(want: Range): boolean {
    const got = this.loaded;
    return !!got && got.r0 <= want.r0 && got.r1 >= want.r1 && got.c0 <= want.c0 && got.c1 >= want.c1;
  }

  private async ensure(): Promise<void> {
    const want = this.visible();
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
      const win = await this.host.fetchWindow(this.host.sheet, want.r0, want.r1, want.c0, want.c1);
      if (this.destroyed) return;
      for (const row of win.rows) {
        for (const cell of row.cells) this.cellsByKey.set(`${row.r}:${cell.c}`, cell);
      }
      this.loaded = want;
      this.error = "";
      this.show("");
    } catch (err) {
      if (this.destroyed) return;
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
    this.colheadIn.style.transform = `translateX(${-this.view.scrollLeft}px)`;
    this.rowheadIn.style.transform = `translateY(${-this.view.scrollTop}px)`;
  }

  private render(): void {
    if (this.destroyed) return;
    const want = this.visible();
    if (!want) return;
    this.syncHeads();

    const cols: HTMLElement[] = [];
    for (let c = want.c0; c <= want.c1; c++) {
      const node = el("div", "sd-col", colName(c));
      node.dataset.c = String(c);
      node.style.left = `${c * COL_W}px`;
      node.style.width = `${COL_W}px`;
      cols.push(node);
    }
    this.colheadIn.replaceChildren(...cols);

    const rowheads: HTMLElement[] = [];
    for (let r = want.r0; r <= want.r1; r++) {
      const node = el("div", "sd-rowno", String(r + 1));
      node.dataset.r = String(r);
      node.style.top = `${r * ROW_H}px`;
      node.style.height = `${ROW_H}px`;
      rowheads.push(node);
    }
    this.rowheadIn.replaceChildren(...rowheads);

    const nodes: HTMLElement[] = [];
    for (let r = want.r0; r <= want.r1; r++) {
      for (let c = want.c0; c <= want.c1; c++) {
        const cell = this.cellsByKey.get(`${r}:${c}`);
        if (!cell) continue;
        const node = el("div", `sd-cell k-${cell.k}`, cell.t);
        node.dataset.r = String(r);
        node.dataset.c = String(c);
        node.style.left = `${c * COL_W}px`;
        node.style.top = `${r * ROW_H}px`;
        node.style.width = `${COL_W}px`;
        node.style.height = `${ROW_H}px`;
        if (cell.k === "n") node.classList.add("is-n");
        nodes.push(node);
      }
    }
    this.cells.replaceChildren(...nodes);
  }
}
