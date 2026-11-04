import { api } from "./api.ts";
import { tr } from "./i18n/index.ts";
import type { SheetCell, SheetChart, SheetDoc, SheetMeta, SheetStyle } from "./types.ts";

/**
 * 表格网格（D116）：虚拟滚动 + 冻结窗格 + 单元格编辑。
 *
 * 分工：桥端按窗口发格子（值 / 样式 / 条件格式结果都已经算好），这里只负责「画在哪儿」。
 * 所以这个文件里没有公式、没有条件格式规则、也没有 numFmt —— 那些都在桥端做完了。
 *
 * **只读（D119）**：格子内编辑已经砍掉 —— 改表走「引用选区给 pi」或直接跟 pi 说。
 * 这样这一层就只剩「画 + 选区 + 滚动」，不再有输入框 / 撤销栈 / 待保存改动 / 保存写回。
 *
 * 几何一律用「布局 px」算（列宽行高、缩放前的值）；落 DOM 时乘 `zoom`。冻结窗格不是另开层，
 * 而是给冻结区的格子加上「滚动量」当偏移，于是它们在滚动的容器里看起来是钉住的。
 */

export interface SheetHost {
  /** 把「データ!A1:C5」这类选区引用插进输入框（让 agent 改表的那条路）。 */
  insertText: (text: string) => void;
  warn: (text: string) => void;
}

type Sel = {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

interface Rect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const colName = (c: number): string => {
  let n = c + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

export class SheetView {
  readonly root: HTMLElement;
  doc: SheetDoc;

  private host: SheetHost;
  private meta: SheetMeta;
  private colhead: HTMLElement;
  private colheadIn: HTMLElement;
  private rowhead: HTMLElement;
  private rowheadIn: HTMLElement;
  private view: HTMLElement;
  private space: HTMLElement;
  private cellsLayer: HTMLElement;
  private chartLayer: HTMLElement;
  private frozenLayer!: HTMLElement;
  private paneTop!: HTMLElement;
  private paneLeft!: HTMLElement;
  private paneCorner!: HTMLElement;
  private selBox: HTMLElement;
  private fx: HTMLInputElement;
  private nameBox: HTMLElement;
  private tabs: HTMLElement;
  private status: HTMLElement;
  private findBox: HTMLElement;
  private findInput: HTMLInputElement;

  private zoom = 1;
  /** 布局 px 的行列边界：colOff[c] 是第 c 列的左边缘。 */
  private colOff: Float64Array = new Float64Array(1);
  private rowOff: Float64Array = new Float64Array(1);
  private cells = new Map<string, SheetCell>();
  private styles: SheetStyle[] = [];
  private cfs: SheetStyle[] = [];
  private fetched: Rect[] = [];
  private inflight = 0;
  private els = new Map<string, HTMLElement>();
  private chartEls: HTMLElement[] = [];
  private sel: Sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
  private anchor = { r: 0, c: 0 };
  private covers = new Map<string, [number, number, number, number]>();
  private frame = 0;

  constructor(doc: SheetDoc, host: SheetHost) {
    this.doc = doc;
    this.host = host;
    this.meta = doc.sheets.find((s) => !s.hidden) ?? doc.sheets[0];
    this.root = document.createElement("div");
    this.root.className = "sh";
    this.root.tabIndex = 0;

    // ---- 公式栏
    const bar = document.createElement("div");
    bar.className = "sh-fx";
    this.nameBox = document.createElement("div");
    this.nameBox.className = "sh-name";
    this.nameBox.textContent = "A1";
    const fxLabel = document.createElement("div");
    fxLabel.className = "sh-fxlabel";
    fxLabel.textContent = "fx";
    this.fx = document.createElement("input");
    this.fx.className = "sh-fxinput";
    this.fx.spellcheck = false;
    this.fx.readOnly = true;
    this.fx.title = tr("只读：要改这张表，选中区域后点「引用给 pi」让它改");
    this.findBox = document.createElement("div");
    this.findBox.className = "sh-findbox";
    this.findInput = document.createElement("input");
    this.findInput.className = "sh-findinput";
    this.findInput.placeholder = tr("表内查找");
    const findGo = document.createElement("button");
    findGo.className = "sh-mini";
    findGo.textContent = "↵";
    findGo.onclick = () => void this.findNext();
    const findClose = document.createElement("button");
    findClose.className = "sh-mini";
    findClose.textContent = "✕";
    findClose.onclick = () => {
      this.findBox.classList.remove("on");
      this.root.focus();
    };
    this.findBox.append(this.findInput, findGo, findClose);
    this.findInput.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.findNext();
      }
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.findBox.classList.remove("on");
        this.root.focus();
      }
    };
    bar.append(this.nameBox, fxLabel, this.fx, this.findBox);

    // ---- 表体
    const mid = document.createElement("div");
    mid.className = "sh-mid";
    const corner = document.createElement("div");
    corner.className = "sh-corner";
    this.colhead = document.createElement("div");
    this.colhead.className = "sh-colhead";
    this.colheadIn = document.createElement("div");
    this.colheadIn.className = "sh-headin";
    this.colhead.append(this.colheadIn);
    this.rowhead = document.createElement("div");
    this.rowhead.className = "sh-rowhead";
    this.rowheadIn = document.createElement("div");
    this.rowheadIn.className = "sh-headin";
    this.rowhead.append(this.rowheadIn);
    this.view = document.createElement("div");
    this.view.className = "sh-view";
    this.space = document.createElement("div");
    this.space.className = "sh-space";
    this.cellsLayer = document.createElement("div");
    this.cellsLayer.className = "sh-cells";
    this.chartLayer = document.createElement("div");
    this.chartLayer.className = "sh-charts";
    this.selBox = document.createElement("div");
    this.selBox.className = "sh-sel";
    this.space.append(this.cellsLayer, this.chartLayer);
    this.view.append(this.space);
    // 冻结区画在滚动容器**外面**（D118）：放在里面靠每帧 JS 补 top 会滞后 ——
    // 合成器先滚、scroll 事件后到，实测快速滚动时表头抖 120px。
    this.frozenLayer = document.createElement("div");
    this.frozenLayer.className = "sh-frozen";
    this.paneTop = document.createElement("div");
    this.paneTop.className = "sh-pane pt";
    this.paneLeft = document.createElement("div");
    this.paneLeft.className = "sh-pane pl";
    this.paneCorner = document.createElement("div");
    this.paneCorner.className = "sh-pane pc";
    for (const pane of [this.paneTop, this.paneLeft, this.paneCorner]) {
      pane.addEventListener("pointerdown", (ev) => this.onPointerDown(ev));
      pane.addEventListener(
        "wheel",
        (ev) => {
          ev.preventDefault();
          this.view.scrollTop += ev.deltaY;
          this.view.scrollLeft += ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX;
        },
        { passive: false },
      );
    }
    this.frozenLayer.append(this.paneTop, this.paneLeft, this.paneCorner, this.selBox);
    mid.append(corner, this.colhead, this.rowhead, this.view, this.frozenLayer);

    // ---- 底部：sheet 标签 + 状态 + 缩放
    const foot = document.createElement("div");
    foot.className = "sh-foot";
    this.tabs = document.createElement("div");
    this.tabs.className = "sh-tabs";
    this.status = document.createElement("div");
    this.status.className = "sh-status";
    const zoomOut = document.createElement("button");
    zoomOut.className = "sh-mini";
    zoomOut.textContent = "−";
    zoomOut.title = tr("缩小");
    zoomOut.onclick = () => this.setZoom(this.zoom - 0.1);
    const zoomIn = document.createElement("button");
    zoomIn.className = "sh-mini";
    zoomIn.textContent = "+";
    zoomIn.title = tr("放大");
    zoomIn.onclick = () => this.setZoom(this.zoom + 0.1);
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "sh-zoomlabel";
    const quote = document.createElement("button");
    quote.className = "sh-quote";
    quote.textContent = tr("引用给 pi");
    quote.title = tr("把当前选区写成「文件 的 工作表!A1:C5」插进输入框，然后跟 pi 说怎么改");
    quote.onclick = () => this.host.insertText(this.selectionRef());
    foot.append(this.tabs, this.status, zoomOut, this.zoomLabel, zoomIn, quote);
    this.root.append(bar, mid, foot);

    this.view.onscroll = () => this.schedule();
    this.root.addEventListener("keydown", (ev) => this.onKey(ev));
    this.fx.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.syncFx();
        this.root.focus();
      }
    };
    this.view.addEventListener("pointerdown", (ev) => this.onPointerDown(ev));
    window.addEventListener("resize", this.onResize);
    // 浮窗被拖动改大小时 window 不 trigger resize，得盯着自己的盒子（D117）。
    this.boxWatcher = new ResizeObserver(() => this.schedule());
    this.boxWatcher.observe(this.root);
    this.buildSheet();
    this.syncFx();
  }

  private zoomLabel!: HTMLElement;
  private boxWatcher: ResizeObserver | null = null;
  private onResize = (): void => this.schedule();

  // ---------------------------------------------------------------- 布局

  private buildSheet(): void {
    const meta = this.meta;
    // 图表锚点常常超出一张表的「已用区域」（放在 A1:D20 的表里画到 H 列），
    // 所以网格要按锚点撑开，否则 colX 会被夹到最后一列、图表占位挤成一条。
    const chartCols = meta.charts.reduce((m, ch) => Math.max(m, ch.c2 + 1), 0);
    const chartRows = meta.charts.reduce((m, ch) => Math.max(m, ch.r2 + 1), 0);
    const cols = Math.max(1, meta.colCount, chartCols);
    const rows = Math.max(1, meta.rowCount, chartRows);
    this.colOff = new Float64Array(cols + 1);
    this.rowOff = new Float64Array(rows + 1);
    for (let c = 0; c < cols; c++) {
      const def = meta.cols[c];
      const w = def ? (def.hidden ? 0 : def.w) : meta.defColW;
      this.colOff[c + 1] = this.colOff[c] + w;
    }
    for (let r = 0; r < rows; r++) {
      this.rowOff[r + 1] = this.rowOff[r] + (meta.rows[String(r)] ?? meta.defRowH);
    }
    this.covers.clear();
    for (const [r1, c1, r2, c2] of meta.merges) {
      this.covers.set(`${r1}:${c1}`, [r1, c1, r2, c2]);
      // 合并区里除了左上角，其余格子都不画。
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) this.covers.set(`${r}:${c}`, [-1, -1, -1, -1]);
    }
    this.space.style.width = `${this.colOff[cols] * this.zoom}px`;
    this.space.style.height = `${this.rowOff[rows] * this.zoom}px`;
    this.paintHeads();
    this.paintTabs();
  }

  private colX(c: number): number {
    return (this.colOff[clamp(c, 0, this.colOff.length - 1)] ?? 0) * this.zoom;
  }

  private rowY(r: number): number {
    return (this.rowOff[clamp(r, 0, this.rowOff.length - 1)] ?? 0) * this.zoom;
  }

  /** 第 c 列横向占多少（合并时是几列之和）。 */
  private spanW(c: number, c2 = c): number {
    return this.colX(c2 + 1) - this.colX(c);
  }

  private spanH(r: number, r2 = r): number {
    return this.rowY(r2 + 1) - this.rowY(r);
  }

  /** 二分查：偏移 → 第一个覆盖它的行/列。 */
  private indexAt(off: Float64Array, px: number, zoom: number): number {
    let lo = 0;
    let hi = off.length - 2;
    if (hi < 0) return 0;
    const target = px / zoom;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (off[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  private visible(): Rect {
    const z = this.zoom;
    const r0 = this.indexAt(this.rowOff, this.view.scrollTop, z);
    const c0 = this.indexAt(this.colOff, this.view.scrollLeft, z);
    const rows = this.rowOff.length - 1;
    const cols = this.colOff.length - 1;
    // 视口右下角换算成「可见到哪一格」。
    let r1 = r0;
    while (r1 + 1 < rows && this.rowY(r1 + 1) - this.view.scrollTop < this.view.clientHeight) r1++;
    let c1 = c0;
    while (c1 + 1 < cols && this.colX(c1 + 1) - this.view.scrollLeft < this.view.clientWidth) c1++;
    return { r0, r1, c0, c1 };
  }

  // ---------------------------------------------------------------- 表头

  private paintHeads(): void {
    const vis = this.visible();
    const z = this.zoom;
    const fzH = this.freezeRows ? this.rowY(this.freezeRows) : 0;
    const fzW = this.freezeCols ? this.colX(this.freezeCols) : 0;
    // 列头
    const colFrag = document.createDocumentFragment();
    const firstCol = this.freezeCols ? 0 : vis.c0;
    for (let c = firstCol; c <= vis.c1; c++) {
      const d = document.createElement("div");
      d.className = `sh-colcell${this.inSelCol(c) ? " on" : ""}`;
      d.textContent = colName(c);
      const x = this.colX(c) + (this.freezeCols && c < this.freezeCols ? this.view.scrollLeft : 0);
      // 冻结列盖住的那一段不再画：否则滚过来的 C 会压在钉住的 A 上，看起来像 "AC"。
      // 判据要用「屏幕位置」（x 减去横向滚动量），不是内容位置。
      if (fzW > 0 && c >= this.freezeCols && x - this.view.scrollLeft < fzW - 1) continue;
      d.style.left = `${x}px`;
      d.style.width = `${this.spanW(c)}px`;
      if (this.meta.cols[c]?.hidden) d.style.display = "none";
      colFrag.append(d);
    }
    this.colheadIn.replaceChildren(colFrag);
    this.colheadIn.style.width = `${this.colOff[this.colOff.length - 1] * z}px`;
    this.colheadIn.style.transform = `translateX(${-this.view.scrollLeft}px)`;
    void fzW;

    // 行头
    const rowFrag = document.createDocumentFragment();
    const firstRow = this.freezeRows ? 0 : vis.r0;
    for (let r = firstRow; r <= vis.r1; r++) {
      const d = document.createElement("div");
      d.className = `sh-rowcell${this.inSelRow(r) ? " on" : ""}`;
      d.textContent = String(r + 1);
      const y = this.rowY(r) + (this.freezeRows && r < this.freezeRows ? this.view.scrollTop : 0);
      // 同上：冻结行遮住的行号不画，免得「1」和滚上来的「11」叠在一起。
      if (fzH > 0 && r >= this.freezeRows && y - this.view.scrollTop < fzH - 1) continue;
      d.style.top = `${y}px`;
      d.style.height = `${this.spanH(r)}px`;
      d.style.display = this.meta.rows[String(r)] === 0 ? "none" : "";
      rowFrag.append(d);
    }
    this.rowheadIn.replaceChildren(rowFrag);
    this.rowheadIn.style.height = `${this.rowOff[this.rowOff.length - 1] * z}px`;
    this.rowheadIn.style.transform = `translateY(${-this.view.scrollTop}px)`;
    void fzH;
  }

  private get freezeRows(): number {
    return this.meta.freeze.rows;
  }

  private get freezeCols(): number {
    return this.meta.freeze.cols;
  }

  private inSelCol(c: number): boolean {
    return c >= Math.min(this.sel.c1, this.sel.c2) && c <= Math.max(this.sel.c1, this.sel.c2);
  }

  private inSelRow(r: number): boolean {
    return r >= Math.min(this.sel.r1, this.sel.r2) && r <= Math.max(this.sel.r1, this.sel.r2);
  }

  private paintTabs(): void {
    this.tabs.replaceChildren();
    for (const sheet of this.doc.sheets) {
      if (sheet.hidden) continue;
      const b = document.createElement("button");
      b.className = `sh-tab${sheet.name === this.meta.name ? " on" : ""}`;
      b.textContent = sheet.name;
      if (sheet.tabColor) b.style.borderBottom = `2px solid ${sheet.tabColor}`;
      b.onclick = () => void this.selectSheet(sheet.name);
      this.tabs.append(b);
    }
  }

  // ---------------------------------------------------------------- 取数

  private covered(rect: Rect): boolean {
    return this.fetched.some((r) => r.r0 <= rect.r0 && r.r1 >= rect.r1 && r.c0 <= rect.c0 && r.c1 >= rect.c1);
  }

  private async ensure(rect: Rect): Promise<void> {
    if (!this.doc.token) return;
    if (this.covered(rect)) return;
    // 一次多取一点，免得滚两行就发一个请求。
    const r1 = Math.min(rect.r1 + 30, this.rowOff.length - 2);
    const c1 = Math.min(rect.c1 + 8, this.colOff.length - 2);
    const want: Rect = { r0: rect.r0, r1, c0: rect.c0, c1 };
    this.fetched.push(want);
    this.inflight++;
    try {
      const res = await api.sheetWindow(this.doc.token, this.meta.name, want.r0, want.r1, want.c0, want.c1);
      if (!res) return;
      const base = this.styles.length;
      const cfBase = this.cfs.length;
      this.styles.push(...res.styles);
      this.cfs.push(...res.cfs);
      for (const cell of res.cells) {
        const next: SheetCell = { ...cell };
        next.s = cell.s >= 0 ? cell.s + base : -1;
        if (cell.cf != null) next.cf = cell.cf + cfBase;
        this.cells.set(`${cell.r}:${cell.c}`, next);
      }
      this.schedule();
    } catch (err: any) {
      this.host.warn(String(err?.message ?? err));
      this.fetched = this.fetched.filter((r) => r !== want);
    } finally {
      this.inflight--;
    }
  }

  // ---------------------------------------------------------------- 绘制

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint(): void {
    const vis = this.visible();
    void this.ensure({
      r0: Math.max(0, vis.r0 - 2),
      r1: Math.min(vis.r1 + 2, this.rowOff.length - 2),
      c0: Math.max(0, vis.c0 - 1),
      c1: Math.min(vis.c1 + 1, this.colOff.length - 2),
    });
    this.paintHeads();
    const fzR = this.freezeRows;
    const fzC = this.freezeCols;
    this.layoutFrozen(fzR, fzC);
    const seen = new Set<string>();
    for (let r = vis.r0; r <= vis.r1; r++) for (let c = vis.c0; c <= vis.c1; c++) this.paintCell(r, c, seen);
    if (fzR) for (let r = 0; r < fzR; r++) for (let c = Math.max(vis.c0, fzC); c <= vis.c1; c++) this.paintCell(r, c, seen);
    if (fzC) for (let c = 0; c < fzC; c++) for (let r = Math.max(vis.r0, fzR); r <= vis.r1; r++) this.paintCell(r, c, seen);
    if (fzR && fzC) for (let r = 0; r < fzR; r++) for (let c = 0; c < fzC; c++) this.paintCell(r, c, seen);
    // 滚出窗口的格子直接回收：留着不会错，但滚一圈回来就堆了几千个没人看的 DOM。
    for (const [key, el] of this.els) {
      if (seen.has(key)) continue;
      el.remove();
      this.els.delete(key);
    }
    this.paintSelection();
    this.paintCharts();
    this.paintStatus();
  }

  /** 三块冻结浮层的几何（视口 px）：上带 / 左带 / 左上角。 */
  private layoutFrozen(fzR: number, fzC: number): void {
    const w = fzC ? this.colX(fzC) : 0;
    const h = fzR ? this.rowY(fzR) : 0;
    this.frozenLayer.style.display = fzR || fzC ? "" : "none";
    this.paneTop.style.cssText = `left:${w}px;top:0;right:0;height:${h}px`;
    this.paneLeft.style.cssText = `left:0;top:${h}px;width:${w}px;bottom:0`;
    this.paneCorner.style.cssText = `left:0;top:0;width:${w}px;height:${h}px`;
  }

  /**
   * 画一格。四种宿主各有坐标系：滚动区用内容坐标；冻结区用视口坐标（另一边减掉滚动量）。
   * 冻结区因此是「真的钉住」的，不靠 JS 追帧。
   */
  private paintCell(r: number, c: number, seen: Set<string>): void {
    const key = `${r}:${c}`;
    const cover = this.covers.get(key);
    if (cover && cover[1] < 0) return;
    const cell = this.cells.get(key);
    if (!cell) return;
    const rowFrozen = this.freezeRows > 0 && r < this.freezeRows;
    const colFrozen = this.freezeCols > 0 && c < this.freezeCols;
    const mode = rowFrozen ? (colFrozen ? "pc" : "pt") : colFrozen ? "pl" : "main";
    seen.add(key);
    const layer = mode === "main" ? this.cellsLayer : mode === "pt" ? this.paneTop : mode === "pl" ? this.paneLeft : this.paneCorner;
    const dx = mode === "pt" ? this.view.scrollLeft : 0;
    const dy = mode === "pl" ? this.view.scrollTop : 0;
    const r2 = cover ? cover[2] : r;
    const c2 = cover ? cover[3] : c;
    const x = this.colX(c) - dx;
    const y = this.rowY(r) - dy;
    const w = Math.max(0, this.spanW(c, c2) - (cover ? 0 : 1));
    const h = Math.max(0, this.spanH(r, r2) - (cover ? 0 : 1));
    let el = this.els.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = "sh-cell";
      this.els.set(key, el);
    }
    if (el.parentElement !== layer) layer.append(el);
    el.classList.toggle("frozen", mode !== "main");
    const sig = `${mode}|${x}|${y}|${w}|${h}|${cell.t}|${cell.s}|${cell.cf}|${cell.bar}|${cell.icon}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.style.cssText = "";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    const style = cell.s >= 0 ? this.styles[cell.s] : undefined;
    const cf = cell.cf != null ? this.cfs[cell.cf] : undefined;
    const bg = cf?.fill ?? style?.fill;
    el.style.background = bg ?? "#fff";
    if (cell.bar != null && !cf?.fill) {
      const color = "rgba(99,142,198,0.35)";
      el.style.background = `linear-gradient(90deg, ${color} ${(cell.bar * 100).toFixed(1)}%, #fff ${(cell.bar * 100).toFixed(1)}%)`;
    }
    if (style?.size) el.style.fontSize = `${style.size}px`;
    if (style?.family) el.style.fontFamily = `"${style.family}", var(--ui-font, sans-serif)`;
    el.style.color = cf?.color ?? style?.color ?? "#1f2328";
    el.style.fontWeight = (cf?.bold ?? style?.bold) ? "600" : "400";
    el.style.fontStyle = (cf?.italic ?? style?.italic) ? "italic" : "normal";
    const deco = [style?.underline ? "underline" : "", style?.strike ? "line-through" : ""].filter(Boolean).join(" ");
    el.style.textDecoration = deco || "none";
    const hAlign = style?.h === "c" ? "center" : style?.h === "r" ? "right" : "left";
    el.style.textAlign = hAlign;
    el.style.justifyContent = hAlign === "center" ? "center" : hAlign === "right" ? "flex-end" : "flex-start";
    el.style.alignItems = style?.v === "t" ? "flex-start" : style?.v === "m" ? "center" : style?.v === "b" ? "flex-end" : "flex-start";
    el.style.whiteSpace = style?.wrap ? "pre-wrap" : "nowrap";
    if (style?.border) {
      el.style.borderTop = style.border.t ?? "";
      el.style.borderRight = style.border.r ?? "";
      el.style.borderBottom = style.border.b ?? "";
      el.style.borderLeft = style.border.l ?? "";
    } else {
      el.style.borderRight = "1px solid #EDEDF0";
      el.style.borderBottom = "1px solid #EDEDF0";
    }
    const glyph = cell.icon ? `${cell.icon} ` : "";
    el.textContent = `${glyph}${cell.t}`;
    el.classList.toggle("link", Boolean(cell.href));
    el.classList.toggle("err", cell.k === "e");
    el.title = cell.href ? `${cell.href}` : style?.fmt ? `${style.fmt}` : cell.f ? `=${cell.f}` : "";
    el.onclick = cell.href
      ? (ev) => {
          if (ev.ctrlKey || ev.metaKey) window.open(cell.href, "_blank", "noreferrer");
        }
      : null;
  }

  private paintSelection(): void {
    const { r1, c1, r2, c2 } = this.sel;
    const top = Math.min(r1, r2);
    const left = Math.min(c1, c2);
    const bottom = Math.max(r1, r2);
    const right = Math.max(c1, c2);
    const x = this.colX(left) - this.view.scrollLeft;
    const y = this.rowY(top) - this.view.scrollTop;
    this.selBox.style.left = `${x}px`;
    this.selBox.style.top = `${y}px`;
    this.selBox.style.width = `${this.spanW(left, right)}px`;
    this.selBox.style.height = `${this.spanH(top, bottom)}px`;
    this.selBox.style.display = "";
    this.nameBox.textContent = this.rangeA1();
  }

  private paintCharts(): void {
    if (this.meta.charts.length === 0) {
      for (const el of this.chartEls) el.remove();
      this.chartEls = [];
      return;
    }
    if (this.chartEls.length === this.meta.charts.length) return;
    for (const el of this.chartEls) el.remove();
    this.chartEls = [];
    for (const chart of this.meta.charts) {
      const el = this.chartBox(chart);
      this.chartLayer.append(el);
      this.chartEls.push(el);
    }
  }

  private chartBox(chart: SheetChart): HTMLElement {
    const el = document.createElement("div");
    el.className = "sh-chart";
    el.style.left = `${this.colX(chart.c1)}px`;
    el.style.top = `${this.rowY(chart.r1)}px`;
    el.style.width = `${Math.max(60, this.spanW(chart.c1, chart.c2) - 4)}px`;
    el.style.height = `${Math.max(40, this.spanH(chart.r1, chart.r2) - 4)}px`;
    const label = document.createElement("div");
    label.className = "sh-chart-t";
    label.textContent = tr("图表：{p1}", { p1: chartKindName(chart.kind) });
    const tip = document.createElement("div");
    tip.className = "sh-chart-s";
    tip.textContent = tr("这里不画图表，用 Excel 打开看");
    el.append(label, tip);
    return el;
  }

  private paintStatus(): void {
    let count = 0;
    let sum = 0;
    const top = Math.min(this.sel.r1, this.sel.r2);
    const bottom = Math.max(this.sel.r1, this.sel.r2);
    const left = Math.min(this.sel.c1, this.sel.c2);
    const right = Math.max(this.sel.c1, this.sel.c2);
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const cell = this.cells.get(`${r}:${c}`);
        if (!cell) continue;
        count++;
        const n = typeof cell.v === "number" ? cell.v : Number(cell.v);
        if (Number.isFinite(n) && cell.k !== "s") sum += n;
      }
    }
    const bits = [`${this.meta.name} · ${this.meta.rowCount} × ${this.meta.colCount}`];
    if (count > 1) bits.push(tr("选区 {p1} 格，合计 {p2}", { p1: count, p2: Math.round(sum * 100) / 100 }));
    this.status.textContent = bits.join(" · ");
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private setZoom(z: number): void {
    this.zoom = Math.round(clamp(z, 0.4, 2) * 10) / 10;
    this.buildSheet();
    this.paint();
  }

  // ---------------------------------------------------------------- 选区与键盘

  /**
   * 指针落在哪一格。滚动区和冻结浮层共用一个换算：冻结格在视口里的位置就是
   * 「内容坐标 − 滚动量」，所以「视口坐标 + 滚动量 = 内容坐标」两边都对得上。
   */
  private cellAt(ev: PointerEvent): { r: number; c: number } | null {
    const rect = this.view.getBoundingClientRect();
    if (ev.clientX < rect.left || ev.clientY < rect.top || ev.clientX > rect.right || ev.clientY > rect.bottom) return null;
    const vx = ev.clientX - rect.left;
    const vy = ev.clientY - rect.top;
    const fzW = this.freezeCols ? this.colX(this.freezeCols) : 0;
    const fzH = this.freezeRows ? this.rowY(this.freezeRows) : 0;
    // 冻结区里的格子是钉住的：它到视口左/上边缘的距离就是内容坐标本身；只有落在可滚动的
    // 那一侧才要加回滚动量。之前一律加 scrollTop/Left，点冻结行会落到下面几十行去。
    const cx = vx < fzW ? vx : vx + this.view.scrollLeft;
    const cy = vy < fzH ? vy : vy + this.view.scrollTop;
    return { r: this.indexAt(this.rowOff, cy, this.zoom), c: this.indexAt(this.colOff, cx, this.zoom) };
  }

  private onPointerDown(ev: PointerEvent): void {
    const at = this.cellAt(ev);
    if (!at) return;
    if (ev.button === 2) {
      this.sel = { r1: at.r, c1: at.c, r2: at.r, c2: at.c };
      this.anchor = at;
      this.paint();
      return;
    }
    this.root.focus();
    this.sel = { r1: at.r, c1: at.c, r2: at.r, c2: at.c };
    this.anchor = at;
    this.syncFx();
    this.paint();
    const startAt = at;
    const move = (e: PointerEvent): void => {
      const next = this.cellAt(e);
      if (!next) return;
      this.sel = { r1: startAt.r, c1: startAt.c, r2: next.r, c2: next.c };
      this.paint();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.syncFx();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  private onKey(ev: KeyboardEvent): void {
    const meta = ev.ctrlKey || ev.metaKey;
    if (meta && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      this.findBox.classList.add("on");
      this.findInput.focus();
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, ev.shiftKey ? -1 : 1],
    };
    const move = moves[ev.key];
    if (move) {
      ev.preventDefault();
      const r = clamp(this.anchor.r + move[0], 0, this.rowOff.length - 2);
      const c = clamp(this.anchor.c + move[1], 0, this.colOff.length - 2);
      this.anchor = { r, c };
      this.sel = { r1: r, c1: c, r2: r, c2: c };
      this.scrollIntoView(r, c);
      this.syncFx();
      this.paint();
      return;
    }
  }

  private scrollIntoView(r: number, c: number): void {
    const x = this.colX(c);
    const y = this.rowY(r);
    const w = this.spanW(c);
    const h = this.spanH(r);
    const fzW = this.freezeCols ? this.colX(this.freezeCols) : 0;
    const fzH = this.freezeRows ? this.rowY(this.freezeRows) : 0;
    if (x < this.view.scrollLeft + fzW) this.view.scrollLeft = Math.max(0, x - fzW);
    if (x + w > this.view.scrollLeft + this.view.clientWidth) this.view.scrollLeft = x + w - this.view.clientWidth;
    if (y < this.view.scrollTop + fzH) this.view.scrollTop = Math.max(0, y - fzH);
    if (y + h > this.view.scrollTop + this.view.clientHeight) this.view.scrollTop = y + h - this.view.clientHeight;
  }

  private rawText(cell: SheetCell | undefined): string {
    if (!cell) return "";
    if (cell.f) return `=${cell.f}`;
    if (cell.k === "d") return cell.t;
    return String(cell.v ?? "");
  }

  private syncFx(): void {
    const cell = this.cells.get(`${this.anchor.r}:${this.anchor.c}`);
    this.fx.value = this.rawText(cell);
    this.nameBox.textContent = this.rangeA1();
  }

  /** 名字框里只写 A1:C5（Excel 的样子）；带 sheet 名的那种是给 pi 的引用。 */
  private rangeA1(): string {
    const top = Math.min(this.sel.r1, this.sel.r2);
    const left = Math.min(this.sel.c1, this.sel.c2);
    const bottom = Math.max(this.sel.r1, this.sel.r2);
    const right = Math.max(this.sel.c1, this.sel.c2);
    return top === bottom && left === right ? `${colName(left)}${top + 1}` : `${colName(left)}${top + 1}:${colName(right)}${bottom + 1}`;
  }

  // ---------------------------------------------------------------- 查找

  private async findNext(): Promise<void> {
    const q = this.findInput.value.trim();
    if (!q || !this.doc.token) return;
    try {
      const res = await api.sheetFind(this.doc.token, this.meta.name, q, this.anchor.r, this.anchor.c);
      if (!res.hits.length) {
        this.host.warn(tr("这张表里没找到「{p1}」", { p1: q }));
        return;
      }
      const hit = res.hits[0];
      this.anchor = { r: hit.r, c: hit.c };
      this.sel = { r1: hit.r, c1: hit.c, r2: hit.r, c2: hit.c };
      this.scrollIntoView(hit.r, hit.c);
      this.syncFx();
      this.schedule();
      this.host.warn(res.more ? tr("找到 {p1} 处以上，先跳到第一处", { p1: res.hits.length }) : tr("找到 {p1} 处", { p1: res.hits.length }));
    } catch (err: any) {
      this.host.warn(String(err?.message ?? err));
    }
  }

  // ---------------------------------------------------------------- 对外

  selectionRef(withFile = false): string {
    const top = Math.min(this.sel.r1, this.sel.r2);
    const left = Math.min(this.sel.c1, this.sel.c2);
    const bottom = Math.max(this.sel.r1, this.sel.r2);
    const right = Math.max(this.sel.c1, this.sel.c2);
    const range = top === bottom && left === right ? `${colName(left)}${top + 1}` : `${colName(left)}${top + 1}:${colName(right)}${bottom + 1}`;
    const where = `${this.meta.name}!${range}`;
    return withFile || !this.doc.path ? where : tr("{p1} 的 {p2}", { p1: this.doc.path, p2: where });
  }

  /** 把所有已渲染的格子丢掉：换 sheet / 重新读盘的时候用（冻结浮层里也有格子，别漏）。 */
  private clearRendered(): void {
    this.els.clear();
    this.cellsLayer.replaceChildren();
    this.paneTop.replaceChildren();
    this.paneLeft.replaceChildren();
    this.paneCorner.replaceChildren();
    this.chartEls = [];
    this.chartLayer.replaceChildren();
  }

  async selectSheet(name: string): Promise<void> {
    if (name === this.meta.name) return;
    const next = this.doc.sheets.find((s) => s.name === name);
    if (!next) return;
    this.meta = next;
    this.cells.clear();
    this.styles = [];
    this.cfs = [];
    this.fetched = [];
    this.clearRendered();
    this.anchor = { r: 0, c: 0 };
    this.sel = { r1: 0, c1: 0, r2: 0, c2: 0 };
    this.view.scrollTop = 0;
    this.view.scrollLeft = 0;
    this.buildSheet();
    this.paint();
  }

  /** 外面的文件变了：重新 open 一次（token 变了），保留停在哪张表、滚到哪儿。 */
  async reload(next?: SheetDoc): Promise<void> {
    const name = this.meta.name;
    const top = this.view.scrollTop;
    const left = this.view.scrollLeft;
    if (next) this.doc = next;
    const target = this.doc.sheets.find((s) => s.name === name) ?? this.doc.sheets.find((s) => !s.hidden) ?? this.doc.sheets[0];
    this.meta = target;
    this.cells.clear();
    this.styles = [];
    this.cfs = [];
    this.fetched = [];
    this.clearRendered();
    this.buildSheet();
    this.view.scrollTop = top;
    this.view.scrollLeft = left;
    this.syncFx();
    this.paint();
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.boxWatcher?.disconnect();
    this.boxWatcher = null;
    this.clearRendered();
  }
}

function chartKindName(kind: string): string {
  const map: Record<string, string> = {
    bar: tr("柱形图"),
    line: tr("折线图"),
    pie: tr("饼图"),
    doughnut: tr("圆环图"),
    area: tr("面积图"),
    scatter: tr("散点图"),
    bubble: tr("气泡图"),
    radar: tr("雷达图"),
    stock: tr("股价图"),
    surface: tr("曲面图"),
    ofPie: tr("复合饼图"),
  };
  return map[kind] ?? tr("图表");
}


