/**
 * 只读网格（#105 骨架 + #108 结构保真 + #107 交互 + #427 渲染）。
 *
 * 取数只按可视窗口（window fetch）：滚动时带上 r0/r1/c0/c1 向桥端要这一片，
 * 不把整表拉下来。列宽、行高、合并区、冻结窗格都取文件里的值；冻结的行列画在
 * 独立的覆盖层里，滚动时位置不动，所以标题行不会跟着内容跑掉。
 *
 * #427 按 WPS / Excel 的排法重写渲染：
 * - 行高来自 `<sheetFormatPr defaultRowHeight>` 与 `<row ht customHeight>`，隐藏行高度 0；
 * - 列宽来自 `<col width customWidth>`（字符数 × 7 + 5）与 `<col hidden>`；
 * - 每格贴 fonts / fills / borders / alignment（换行、缩进、缩小填充、旋转）；
 * - 边框按 Excel 的算法只画「左/上」边，右/下边留给邻居，避免同一条线叠成 2px；
 * - 数字放不下显示 `###`（Excel 行为），文本能溢出到右边的空格子里。
 *
 * #107 的交互都在这一层：选区是个矩形（anchor + focus），方向键/Shift/拖选/双击改它；
 * Ctrl+C 出去的是 TSV 纯文本；缩放把行高与列宽同乘一个系数；查找的命中只存坐标。
 */
import { tr, errText } from "../i18n/index.ts";
import { chartNode } from "./chart.ts";
import { clampNum } from "../floatwin.ts";
import type {
  SheetCell,
  SheetEdge,
  SheetEditOp,
  SheetInfo,
  SheetMerge,
  SheetMeta,
  SheetStyle,
  SheetStylePatch,
  SheetValid,
  SheetWindow,
} from "../types.ts";

/** 默认行高（px）：Excel 15pt。 */
export const ROW_H = 20;
/** 默认列宽（px）：Excel 8.43 字符 ≈ 64px。 */
export const COL_W = 64;
export const HEAD_W = 40;
export const HEAD_H = 24;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** #110：每次取数在可见范围上下各预取几屏。 */
const PREFETCH_SCREENS = 3;
/** 桥端单次窗口上限（与 bridge/src/sheet/index.ts 的 400 行一致）。 */
const MAX_WINDOW_ROWS = 400;
/** 没有列宽信息的表（CSV）：给个比 Excel 默认宽的舒服值。 */
const CSV_COL_W = 110;

const GRID_LINE = "1px solid #e6e6e6";
const SEL_COLOR = "#0f766e";
const FONT_STACK = 'Calibri, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
const MLINE = "1.15";
const MLINE_WRAP = "1.25";

interface Range {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** #432：一次改动（一批粘贴算一条撤销记录里的多条）。 */
interface EditEntry {
  key: string;
  before: SheetCell | null;
  after: SheetCell | null;
}

export interface SheetGridHost {
  meta: SheetMeta;
  sheet: string;
  fetchWindow: (sheet: string, r0: number, r1: number, c0: number, c1: number) => Promise<SheetWindow>;
  /** #106：文件在预览之后被改过，桥端不认旧凭据了。 */
  onStale?: () => void;
  /** #427：表里的图片（`/api/sheet/media` 的地址由浮窗拼，网格只负责摆位置）。 */
  mediaUrl?: (sheet: string, id: string) => string;
  /** #111：选中格变了（公式栏跟着走）：`ref` 是 A1 式坐标，`text` 是公式原文或显示值。 */
  onSelect?: (sel: { ref: string; text: string } | null) => void;
  /** #432：有未保存的改动时通知浮窗（保存按钮 / 脏标记）。 */
  onDirty?: (count: number) => void;
  /** #432：开始在格子里敲字 / 结束编辑（公式栏跟着切）。 */
  onEditing?: (state: { ref: string; text: string } | null) => void;
  /** #435 拖列宽 / 行高松手后回调：col 的 size 是字符数，row 是磅。 */
  onResize?: (kind: "col" | "row", index: number, size: number) => void;
  /** #436 表头筛选：value 为 null 表示清掉这一列的筛选。 */
  onFilter?: (c: number, value: string | null) => void;
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

/** pt → CSS px（96dpi）。 */
function pt2px(pt: number): number {
  return (pt * 4) / 3;
}

function fontCss(st: SheetStyle | undefined, zoom: number): string {
  const f = st?.f;
  const size = pt2px(f?.s ?? 11) * zoom;
  const fam = f?.n ? `"${f.n}", ${FONT_STACK}` : FONT_STACK;
  return `${f?.i ? "italic " : ""}${f?.b ? "700" : "400"} ${size.toFixed(2)}px ${fam}`;
}

/** 该格用什么字体大小（px，已乘缩放）。 */
function fontPx(st: SheetStyle | undefined, zoom: number): number {
  return pt2px(st?.f?.s ?? 11) * zoom;
}

/**
 * #433：把一条补丁叠到原样式上（不修改原对象——原对象是 meta.styles 里的共享值）。
 * 只处理补丁里出现的键，其余原样带过来，所以「只加粗」不会把底色冲掉。
 */
/** #434：补丁里的边框档位 → CSS（和桥端 style-write 的档位一一对应）。 */
const EDGE_CSS: Record<SheetEdge, string> = {
  thin: "1px solid #000000",
  medium: "2px solid #000000",
  thick: "3px solid #000000",
  double: "3px double #000000",
  dashed: "1px dashed #000000",
  dotted: "1px dotted #000000",
  none: "none",
};

function mergeStyle(base: SheetStyle | undefined, patch: SheetStylePatch): SheetStyle {
  const out: SheetStyle = { ...base };
  if (
    patch.b !== undefined ||
    patch.i !== undefined ||
    patch.u !== undefined ||
    patch.fs !== undefined ||
    patch.fc !== undefined ||
    patch.fn !== undefined
  ) {
    const f = { ...out.f };
    if (patch.b !== undefined) f.b = patch.b ? 1 : undefined;
    if (patch.i !== undefined) f.i = patch.i ? 1 : undefined;
    if (patch.u !== undefined) f.u = patch.u ? 1 : undefined;
    if (patch.fs !== undefined) f.s = patch.fs;
    if (patch.fc !== undefined) f.c = patch.fc;
    if (patch.fn !== undefined) f.n = patch.fn;
    out.f = f;
  }
  if (patch.bd) {
    const bd = { ...out.bd };
    for (const side of ["t", "r", "b", "l"] as const) {
      const edge = patch.bd[side];
      if (edge !== undefined) bd[side] = EDGE_CSS[edge];
    }
    out.bd = bd;
  }
  if (patch.bg !== undefined) {
    if (patch.bg === null) delete out.bg;
    else out.bg = patch.bg;
  }
  if (patch.h !== undefined) {
    if (patch.h === null) delete out.h;
    else out.h = patch.h;
  }
  if (patch.v !== undefined) {
    if (patch.v === null) delete out.v;
    else out.v = patch.v;
  }
  if (patch.w !== undefined) {
    if (patch.w) out.w = 1;
    else delete out.w;
  }
  return out;
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

  /** 列：每列宽度（已乘缩放）与左边界表（长度 cols + 1）。 */
  private offsets: number[] = [0];
  private base: number[] = [];
  private widths: number[] = [];

  /** #435 拖出来的列宽 / 行高：先盖在文件值上，保存成功后由 meta 接管。 */
  private colOver = new Map<number, number>();
  private rowOver = new Map<number, number>();

  /** 行：默认行高 + 文件指定行高 + 换行量出来的行高（都是未缩放的 px）。 */
  private defH = ROW_H;
  private fileH = new Map<number, number>();
  private autoH = new Map<number, number>();
  private keys: number[] = [];
  private dsum: number[] = [];
  private grow = new Map<number, number>();
  private showGrid = true;
  private growPass = 0;

  private sheet: string;

  private chunks: Range[] = [];

  private epoch = 0;
  private loading = false;
  private again = false;
  private destroyed = false;
  private frame = 0;
  private error = "";
  private stale = false;

  private anchor: { r: number; c: number } = { r: 0, c: 0 };
  private focus: { r: number; c: number } = { r: 0, c: 0 };

  private zoomLevel = 1;

  private dragging = false;

  private hits: { r: number; c: number }[] = [];
  private hitAt = -1;

  private lastTap = { t: 0, r: -1, c: -1 };

  /** #432：改过但还没保存的格子（key = "r:c"）。null 表示「清空」，跟「没这格」区分开。 */
  private edits = new Map<string, SheetCell | null>();
  /** #433：只改样式、没改内容的格子（保存时并进 editOps）。 */
  private styleOver = new Map<string, SheetStylePatch>();
  /** #433：功能区「冻结窗格」改的冻结位置，优先于文件里的。 */
  private freezeOver: { rows: number; cols: number } | null = null;
  /** #433：公式视图——格子里显示 `=SUM(...)` 而不是结果。 */
  private showFormulas = false;
  private undoStack: EditEntry[][] = [];
  private redoStack: EditEntry[][] = [];
  private editor: { r: number; c: number; node: HTMLTextAreaElement; original: string } | null = null;
  /** 编辑模式：双击进编辑（只读预览里双击还是「选一片连续区」）。 */
  private editMode = false;

  /** 量文字宽用的画布（建一次，量上千格也不抖）。 */
  private mctx: CanvasRenderingContext2D | null = null;
  private readonly tw = new Map<string, number>();

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
    this.root.addEventListener("pointerdown", this.onHeadDown);
    this.view.addEventListener("pointermove", this.onPointerMove);
    this.view.addEventListener("pointerup", this.onPointerUp);
    this.view.addEventListener("pointercancel", this.onPointerUp);
    this.view.addEventListener("keydown", this.onKeyDown);
    this.view.addEventListener("copy", this.onCopy);
    this.view.addEventListener("paste", this.onPaste);
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
    this.autoH = new Map();
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
    this.root.removeEventListener("pointerdown", this.onHeadDown);
    this.view.removeEventListener("pointermove", this.onPointerMove);
    this.view.removeEventListener("pointerup", this.onPointerUp);
    this.view.removeEventListener("pointercancel", this.onPointerUp);
    this.view.removeEventListener("keydown", this.onKeyDown);
    this.view.removeEventListener("copy", this.onCopy);
    this.view.removeEventListener("paste", this.onPaste);
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

  /** 当前表的元数据（对话框等外部需要读 filter/valid 时用）。 */
  info(): SheetInfo {
    return this.host.meta.sheets.find((s) => s.name === this.sheet) ?? {
      name: this.sheet,
      rows: this.host.meta.rows,
      cols: this.host.meta.cols,
    };
  }

  /** 列宽 / 行高 / 合并区 / 冻结窗格按当前表重算。宽度先取文件值，再乘缩放。 */
  private measure(): void {
    const info = this.info();
    const cols = Math.max(0, info.cols);
    const fileWidths = info.colWidths;
    // 没有 colWidths 的是 CSV：文件本身没有列宽可言，给宽一点更好读。
    this.base = Array.from({ length: cols }, (_, c) => fileWidths?.[c] ?? COL_W);
    if (!fileWidths) this.base = this.base.map(() => CSV_COL_W);
    for (const [k, v] of this.colOver) if (k < cols) this.base[k] = v;
    const offsets = [0];
    this.widths = [];
    for (let c = 0; c < cols; c++) {
      const w = Math.max(0, Math.round(this.base[c] * this.zoomLevel));
      this.widths.push(w);
      offsets.push(offsets[c] + w);
    }
    this.offsets = offsets;

    this.defH = info.defaultRowH && info.defaultRowH > 0 ? info.defaultRowH : ROW_H;
    this.showGrid = info.gridLines !== false;
    this.fileH = new Map();
    for (const [k, v] of Object.entries(info.rowH ?? {})) this.fileH.set(Number(k), v);
    // 桥端已经把 hidden 折成高度 0，这里再兜一层：老数据只给 hiddenRows 也能显示对。
    for (const r of info.hiddenRows ?? []) if (!this.fileH.has(r)) this.fileH.set(r, 0);
    for (const [k, v] of this.rowOver) this.fileH.set(k, v);
    this.rebuildH();

    this.spans = new Map();
    for (const m of info.merges ?? []) {
      const area = (m.r1 - m.r0 + 1) * (m.c1 - m.c0 + 1);
      if (area <= 1 || area > 20000) continue;
      for (let r = m.r0; r <= m.r1; r++) {
        for (let c = m.c0; c <= m.c1; c++) this.spans.set(`${r}:${c}`, m);
      }
    }
    this.syncSize();
  }

  private syncSize(): void {
    const info = this.info();
    this.space.style.width = `${this.offsets[info.cols] ?? 0}px`;
    this.space.style.height = `${this.topOf(info.rows || 0)}px`;
  }

  /** 合并「文件行高」与「换行量出来的行高」，做成排序键 + 前缀和（不建整表数组）。 */
  private rebuildH(): void {
    const set = new Set<number>(this.fileH.keys());
    for (const r of this.autoH.keys()) if (!this.fileH.has(r)) set.add(r);
    this.keys = [...set].sort((a, b) => a - b);
    this.dsum = [];
    let acc = 0;
    for (let i = 0; i < this.keys.length; i++) {
      acc += this.heightBase(this.keys[i]) - this.defH;
      this.dsum.push(acc);
    }
  }

  private heightBase(r: number): number {
    const file = this.fileH.get(r);
    if (file !== undefined) return file;
    return this.autoH.get(r) ?? this.defH;
  }

  private rawTop(r: number): number {
    if (!this.keys.length) return r * this.defH;
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return r * this.defH + (lo ? this.dsum[lo - 1] : 0);
  }

  /** 第 r 行的顶边（px，已乘缩放）。 */
  private topOf(r: number): number {
    return Math.round(this.rawTop(r) * this.zoomLevel);
  }

  /** 第 r 行的高度（px，已乘缩放）；0 = 隐藏。 */
  private heightOf(r: number): number {
    return this.topOf(r + 1) - this.topOf(r);
  }

  private freeze(): { rows: number; cols: number } {
    return this.freezeOver ?? this.info().freeze ?? { rows: 0, cols: 0 };
  }

  /** #433：照当前焦点冻结（从焦点格往上、往左都冻住）；`null` = 取消，回到文件里的设置。 */
  setFreeze(at: { rows: number; cols: number } | null): void {
    this.freezeOver = at;
    this.render();
    this.notify();
  }

  get frozen(): { rows: number; cols: number } {
    return this.freeze();
  }

  private leftOf(c: number): number {
    return this.offsets[c] ?? 0;
  }

  private widthOf(c: number): number {
    return this.widths[c] ?? COL_W;
  }

  /** 内容 y 落在第几行；落在隐藏行上就往后找到下一个可见行。 */
  private rowAt(y: number): number {
    const rows = this.info().rows || 0;
    if (rows <= 0) return 0;
    let lo = 0;
    let hi = rows - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.topOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    while (lo < rows - 1 && this.heightOf(lo) <= 0) lo++;
    return lo;
  }

  /** 内容 x 落在第几列；落在隐藏列上就往后找到下一个可见列。 */
  private colAt(x: number): number {
    const info = this.info();
    const cols = Math.max(0, info.cols);
    if (cols <= 0) return 0;
    let lo = 0;
    let hi = cols - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.leftOf(mid) <= x) lo = mid;
      else hi = mid - 1;
    }
    while (lo < cols - 1 && this.widthOf(lo) <= 0) lo++;
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
    v.scrollLeft = cx * k - v.clientWidth / 2;
    v.scrollTop = cy * k - v.clientHeight / 2;
    this.syncHeads();
    this.render();
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
        const cell = this.cellAt(r, c);
        // 数字格复制原始值（粘回去还是数，不是「￥1,234」），其余复制显示串。
        row.push(cell?.v != null ? String(cell.v) : (cell?.t ?? ""));
      }
      lines.push(row.join("\t"));
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ 编辑（#432）

  /** 改过的格子优先于窗口缓存：保存前不重取，重取也不会把本地改动冲掉。 */
  private cellAt(r: number, c: number): SheetCell | undefined {
    const key = `${r}:${c}`;
    const mine = this.edits.get(key);
    if (mine !== undefined) return mine ?? undefined;
    return this.cellsByKey.get(key);
  }

  /** 开关编辑模式（浮窗的「编辑」按钮）；关掉时把正在编辑的那格收尾。 */
  get editing(): boolean {
    return this.editMode;
  }

  setEditMode(on: boolean): void {
    if (this.editMode === on) return;
    this.editMode = on;
    if (!on) this.commitEdit(null);
    this.root.classList.toggle("is-editing", on);
    // 列宽/行高的握把只在编辑态出现，切模式要立刻重画表头。
    this.render();
  }

  /** 元数据（功能区要拿它列字体名）。 */
  get meta(): SheetMeta {
    return this.host.meta;
  }

  /** #434：光标格（排序按这一列排，筛选按这一列的值筛）。 */
  get cursor(): { r: number; c: number } {
    return { r: this.focus.r, c: this.focus.c };
  }

  /** #433：选区矩形（给功能区做「当前这格是什么状态」）。 */
  get selectionBox(): { r0: number; c0: number; r1: number; c1: number } {
    return this.rect();
  }

  /** #433：把样式补丁刷到选中的每一格（只记在本地，保存时才写文件）。 */
  applyStyleToSelection(patch: SheetStylePatch): void {
    if (!this.editMode) return;
    const s = this.rect();
    const cells = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    if (cells > 20000) return;
    for (let r = s.r0; r <= s.r1; r++) {
      for (let c = s.c0; c <= s.c1; c++) {
        const key = `${r}:${c}`;
        this.styleOver.set(key, { ...this.styleOver.get(key), ...patch });
      }
    }
    this.notifyDirty();
    this.render();
  }

  /** #433：焦点格的样式（功能区按它亮按钮）。 */
  get activeStyle(): SheetStyle | undefined {
    return this.styleOf(this.cellAt(this.focus.r, this.focus.c));
  }

  /** #433：网格线开关（和文件里的 `showGridLines` 是两回事，临时视图用）。 */
  setGrid(on: boolean): void {
    if (this.showGrid === on) return;
    this.showGrid = on;
    this.render();
  }

  get gridShown(): boolean {
    return this.showGrid;
  }

  /** #436：点表头箭头弹候选值；第一条是「全部」。 */
  private openFilter(anchor: HTMLElement, c: number): void {
    const flt = this.info().filter;
    if (!flt) return;
    const values = flt.values[c] ?? [];
    const all = tr("（全部）");
    this.openList(anchor, [all, ...values], -1, c, (picked) => {
      this.host.onFilter?.(c, picked === all ? null : picked);
    });
  }

  /** #436：这格有没有数据验证（合并区取左上角那块）。 */
  private validAt(r: number, c: number): SheetValid | undefined {
    for (const v of this.info().valid ?? []) {
      if (r >= v.r0 && r <= v.r1 && c >= v.c0 && c <= v.c1) return v;
    }
    return undefined;
  }

  /** #436：点小箭头弹出的选项列表；选一条就写进格子。 */
  private openList(anchor: HTMLElement, options: string[], r: number, c: number, onPick?: (value: string) => void): void {
    document.querySelector(".sd-list")?.remove();
    const box = anchor.getBoundingClientRect();
    const menu = el("div", "sd-list");
    menu.style.left = `${Math.round(box.left)}px`;
    menu.style.top = `${Math.round(box.bottom + 2)}px`;
    for (const opt of options) {
      const item = el("button", "sd-list-i", opt);
      item.type = "button";
      item.addEventListener("click", () => {
        if (onPick) onPick(opt);
        else this.writeAtCell(r, c, opt);
        menu.remove();
      });
      menu.append(item);
    }
    document.body.append(menu);
    const off = (ev: Event): void => {
      if (menu.contains(ev.target as Node)) return;
      menu.remove();
      document.removeEventListener("pointerdown", off, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
  }

  /** #436：往指定格写（下拉选值用，不弹编辑框）。 */
  writeAtCell(r: number, c: number, text: string): void {
    if (!this.editMode) return;
    this.commitBatch([this.setEdit(r, c, this.parseInput(text, r, c))]);
  }

  /** #435：名称框里输 `A1` / `A1:C5` 就跳过去，顺便选中。 */
  jumpTo(text: string): void {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(text.trim());
    if (!m) return;
    const idx = (name: string): number => {
      let n = 0;
      for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n - 1;
    };
    const info = this.info();
    const c0 = Math.max(0, Math.min(info.cols - 1, idx(m[1] ?? "A")));
    const r0 = Math.max(0, Math.min(info.rows - 1, Number(m[2]) - 1));
    const c1 = m[3] ? Math.max(c0, Math.min(info.cols - 1, idx(m[3]))) : c0;
    const r1 = m[4] ? Math.max(r0, Math.min(info.rows - 1, Number(m[4]) - 1)) : r0;
    this.anchor = { r: r0, c: c0 };
    this.focus = { r: r1, c: c1 };
    this.afterSelect();
    this.reveal(r0, c0);
  }

  /** #433：往焦点格写一段文本或公式（功能区按钮用，不弹编辑框）。 */
  writeAt(text: string): void {
    if (!this.editMode) return;
    const { r, c } = this.focus;
    const cell = this.parseInput(text, r, c);
    this.commitBatch([this.setEdit(r, c, cell)]);
  }

  /**
   * #433：自动求和——把焦点上方连续的数字框进来；上面没有就往左边找。
   * 这是 WPS / Excel 的「Σ」默认行为，找不到就落一个空的 `=SUM()`。
   */
  autoSum(fn: "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN"): void {
    const { r, c } = this.focus;
    const num = (rr: number, cc: number) => this.cellAt(rr, cc)?.k === "n";
    let r0 = r;
    while (r0 > 0 && num(r0 - 1, c)) r0--;
    let c0 = c;
    let c1 = c;
    if (r0 === r) {
      while (c0 > 0 && num(r, c0 - 1)) c0--;
      while (c1 < this.info().cols - 1 && num(r, c1 + 1)) c1++;
    }
    const empty = r0 === r && c0 === c;
    const ref = empty ? "" : `${colName(c0)}${r0 + 1}:${colName(c1)}${r + 1}`;
    this.writeAt(`=${fn}(${ref})`);
  }

  /** #433：功能区「剪切」用——清空选中内容（和 Delete 走同一套撤销栈）。 */
  clearSelectionForRibbon(): void {
    this.clearSelection();
  }

  /** #433：公式视图开关。 */
  setShowFormulas(on: boolean): void {
    if (this.showFormulas === on) return;
    this.showFormulas = on;
    this.render();
  }

  get formulasShown(): boolean {
    return this.showFormulas;
  }

  /** 有没保存的改动。 */
  get dirty(): boolean {
    return this.edits.size > 0 || this.styleOver.size > 0;
  }

  get editCount(): number {
    return this.dirtyKeys().length;
  }

  /** 改过内容或只改过样式的格子，去重。 */
  private dirtyKeys(): string[] {
    return [...new Set([...this.edits.keys(), ...this.styleOver.keys()])];
  }

  /** 把改动整理成桥端要的形状。公式只发正文，别的按格子的实际类型发。 */
  editOps(): SheetEditOp[] {
    const out: SheetEditOp[] = [];
    for (const key of this.dirtyKeys()) {
      const [r, c] = key.split(":").map(Number);
      const cell = this.cellAt(r, c);
      const style = this.styleOver.get(key);
      let write: SheetEditOp["cell"] = null;
      if (cell) {
        if (cell.f) write = { k: "f", f: cell.f };
        else if (cell.k === "n") write = { k: "n", v: Number(cell.v ?? cell.t) };
        else if (cell.k === "b") write = { k: "b", v: cell.t.toUpperCase() === "TRUE" ? 1 : 0 };
        else if (cell.k === "e") write = { k: "e", t: cell.t };
        else write = { k: "s", t: cell.t };
      }
      // 只改样式、格子本来是空的：发个空串，桥端会写成「带样式的空格」。
      if (!write && style) write = { k: "s", t: "" };
      if (write && style) write.style = style;
      out.push({ r, c, cell: write });
    }
    return out;
  }

  /** 保存成功后清账：改动已经落盘，接着从文件里重新取。 */
  clearEdits(): void {
    this.edits.clear();
    this.styleOver.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.notifyDirty();
    this.render();
  }

  private notifyDirty(): void {
    this.host.onDirty?.(this.editCount);
  }

  private setEdit(r: number, c: number, cell: SheetCell | null): EditEntry {
    const key = `${r}:${c}`;
    const before = this.cellAt(r, c) ?? null;
    this.edits.set(key, cell);
    return { key, before, after: cell };
  }

  /** 一批改动落账：只留一条撤销记录，重做栈按 Excel 的规矩清空。 */
  private commitBatch(batch: EditEntry[]): void {
    if (!batch.length) return;
    this.undoStack.push(batch);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.notifyDirty();
    this.render();
  }

  /** Ctrl+Z：按批回退（一次粘贴算一步，不是一格一步）。 */
  undo(): void {
    const batch = this.undoStack.pop();
    if (!batch) return;
    for (let i = batch.length - 1; i >= 0; i--) {
      const e = batch[i];
      if (e.before) this.edits.set(e.key, e.before);
      else this.edits.delete(e.key);
    }
    this.redoStack.push(batch);
    this.notifyDirty();
    this.render();
  }

  /** Ctrl+Y / Ctrl+Shift+Z。 */
  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    for (const e of batch) {
      if (e.after) this.edits.set(e.key, e.after);
      else this.edits.delete(e.key);
    }
    this.undoStack.push(batch);
    this.notifyDirty();
    this.render();
  }

  /** 开始编辑当前格：`initial` 是用户直接敲的那个字符（Excel 的「盖掉原文」）。 */
  beginEdit(initial?: string): void {
    if (this.editor) this.commitEdit(null);
    const info = this.info();
    if (!info.rows || !info.cols) return;
    const { r, c } = this.focus;
    const span = this.spans.get(`${r}:${c}`);
    const r0 = span ? span.r0 : r;
    const c0 = span ? span.c0 : c;
    const r1 = span ? span.r1 : r;
    const c1 = span ? span.c1 : c;
    const cell = this.cellAt(r0, c0);
    const st = this.styleOf(cell);
    const node = el("textarea", "sd-edit");
    node.value = initial ?? (cell?.f ? `=${cell.f}` : (cell?.t ?? ""));
    node.spellcheck = false;
    node.style.left = `${this.leftOf(c0)}px`;
    node.style.top = `${this.topOf(r0)}px`;
    node.style.width = `${this.leftOf(c1 + 1) - this.leftOf(c0)}px`;
    node.style.minHeight = `${Math.max(this.topOf(r1 + 1) - this.topOf(r0), 18)}px`;
    node.style.font = fontCss(st, this.zoomLevel);
    node.style.lineHeight = String(MLINE);
    const auto = cell?.k === "n" ? "r" : cell?.k === "b" || cell?.k === "e" ? "c" : "l";
    const align = st?.h ?? cell?.a ?? auto;
    node.style.textAlign = align === "c" ? "center" : align === "r" ? "right" : "left";
    node.style.paddingLeft = `${Math.round((4 + (st?.ind ?? 0) * 12) * this.zoomLevel)}px`;
    node.addEventListener("keydown", (ev) => this.onEditorKey(ev));
    node.addEventListener("blur", () => {
      // 点别处 = 提交（Excel 行为）；已经结束的编辑不能再提一次。
      if (this.editor?.node === node) this.commitEdit(null);
    });
    this.cells.append(node);
    const before = cell?.f ? `=${cell.f}` : (cell?.t ?? "");
    this.editor = { r: r0, c: c0, node, original: before };
    this.host.onEditing?.({ ref: `${colName(c0)}${r0 + 1}`, text: node.value });
    node.focus({ preventScroll: true });
    // 光标放末尾（replace 模式下第一个字符已经盖掉原文了，再全选会把刚敲的字也盖掉）。
    node.setSelectionRange(node.value.length, node.value.length);
  }

  /** 编辑框里的键：Enter/Shift+Enter/Tab/Esc 都按 Excel 的意思收尾，别的键留给输入。 */
  private onEditorKey(ev: KeyboardEvent): void {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.cancelEdit();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.commitEdit(ev.shiftKey ? "up" : "down");
      return;
    }
    if (ev.key === "Tab") {
      ev.preventDefault();
      this.commitEdit(ev.shiftKey ? "left" : "right");
    }
  }

  /** 收尾：写回改动、挪焦点（`move` 为空就只收尾，比如失焦）。 */
  commitEdit(move: "up" | "down" | "left" | "right" | null): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const text = ed.node.value;
    ed.node.remove();
    this.host.onEditing?.(null);
    if (text !== ed.original) this.commitBatch([this.setEdit(ed.r, ed.c, this.parseInput(text, ed.r, ed.c))]);
    if (move) this.moveFocus(move);
    // 编辑框没了，焦点要回到网格：否则接着敲字 / Ctrl+Z 都落在 body 上。
    this.focusView();
  }

  /** Esc：什么都不改，回到网格。 */
  cancelEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.node.remove();
    this.host.onEditing?.(null);
    this.focusView();
  }

  /** 敲进去的文本 → 格子：= 开头是公式，纯数字是数，TRUE/FALSE 是布尔，其余是文本。 */
  private parseInput(text: string, r: number, c: number): SheetCell | null {
    if (text === "") return null;
    if (text.startsWith("=")) {
      const f = text.slice(1).trim();
      return f ? { r, c, k: "s", t: text, f } : null;
    }
    const raw = text.trim();
    if (/^(true|false)$/i.test(raw)) return { r, c, k: "b", t: raw.toUpperCase(), v: raw.toUpperCase() === "TRUE" ? 1 : 0 };
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return { r, c, k: "n", t: raw, v: Number(raw) };
    return { r, c, k: "s", t: text };
  }

  private moveFocus(dir: "up" | "down" | "left" | "right"): void {
    const info = this.info();
    let { r, c } = this.focus;
    if (dir === "up") r = Math.max(0, r - 1);
    else if (dir === "down") r = Math.min(info.rows - 1, r + 1);
    else if (dir === "left") c = Math.max(0, c - 1);
    else c = Math.min(info.cols - 1, c + 1);
    this.anchor = { r, c };
    this.focus = { r, c };
    this.afterSelect();
    this.reveal(r, c);
  }

  /** Delete / Backspace：清掉选区里的内容（样式也跟着没，跟 Excel 的 Delete 一致）。 */
  private clearSelection(): void {
    const sel = this.rect();
    const batch: EditEntry[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      for (let c = sel.c0; c <= sel.c1; c++) {
        const cur = this.cellAt(r, c);
        if (!cur || (cur.t === "" && !cur.f)) continue;
        batch.push(this.setEdit(r, c, null));
      }
    }
    this.commitBatch(batch);
  }

  /** Ctrl+V：TSV 从锚点铺开，数字转成数、别的原样。 */
  private onPaste = (ev: ClipboardEvent): void => {
    if (this.editor) return;
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    ev.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const info = this.info();
    const batch: EditEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split("\t");
      for (let j = 0; j < cells.length; j++) {
        const r = this.anchor.r + i;
        const c = this.anchor.c + j;
        if (r >= info.rows || c >= info.cols) continue;
        batch.push(this.setEdit(r, c, this.parseInput(cells[j], r, c)));
      }
    }
    this.commitBatch(batch);
  };

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
    // #435 Ctrl/Cmd + 点超链接：只开外链；页内 `#表!A1` 不跳（跨表要重载，留给下一步）。
    if (ev.ctrlKey || ev.metaKey) {
      const cell = this.cellAt(pos.r, pos.c);
      if (cell?.lnk && !cell.lnk.startsWith("#")) {
        ev.preventDefault();
        window.open(cell.lnk, "_blank", "noopener");
        return;
      }
    }
    const now = Date.now();
    // 自己认双击：pointer capture 下浏览器不派 dblclick（踩过）。
    const again = now - this.lastTap.t < 400 && this.lastTap.r === pos.r && this.lastTap.c === pos.c;
    this.lastTap = { t: again ? 0 : now, r: pos.r, c: pos.c };
    if (again) {
      this.dragging = false;
      if (this.editMode) {
        // 双击进编辑：这一下的默认聚焦先走完，下一帧再开编辑框，否则刚出来就被 blur 掉。
        this.anchor = anchor;
        this.focus = pos;
        this.afterSelect();
        requestAnimationFrame(() => this.beginEdit());
        return;
      }
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

  /** 就地换 `.sel` / `.in-sel` / 选区四边的描边，不动 DOM 结构。 */
  private paintSelection(): void {
    const sel = this.rect();
    for (const node of this.root.querySelectorAll<HTMLElement>(".sd-cell[data-r]")) {
      const r = Number(node.dataset.r);
      const c = Number(node.dataset.c);
      const inside = r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
      node.classList.toggle("sel", r === this.focus.r && c === this.focus.c);
      node.classList.toggle("in-sel", inside && !(r === this.focus.r && c === this.focus.c));
      node.style.boxShadow = inside ? this.ring(r, c) : "";
    }
  }

  /** 选区四边的描边（用 inset 阴影，跟边框正交，不会互相顶掉）。 */
  private ring(r: number, c: number): string {
    const sel = this.rect();
    const out: string[] = [];
    if (r === sel.r0) out.push(`inset 0 2px 0 ${SEL_COLOR}`);
    if (r === sel.r1) out.push(`inset 0 -2px 0 ${SEL_COLOR}`);
    if (c === sel.c0) out.push(`inset 2px 0 0 ${SEL_COLOR}`);
    if (c === sel.c1) out.push(`inset -2px 0 0 ${SEL_COLOR}`);
    return out.join(", ");
  }

  /** #107：从一格往四个方向扩一块连续区（碰空格就停，和 Excel 一个意思）。 */
  private selectBlock(at: { r: number; c: number }): void {
    const info = this.info();
    const filled = (r: number, c: number): boolean => {
      const cell = this.cellAt(r, c);
      return !!cell && (cell.t !== "" || cell.v != null);
    };
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
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === "z" || ev.key === "Z")) {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && (ev.key === "y" || ev.key === "Y")) {
      ev.preventDefault();
      this.redo();
      return;
    }
    if (ev.altKey || mod) return;
    if (ev.key === "F2") {
      ev.preventDefault();
      this.beginEdit();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      this.clearSelection();
      return;
    }
    // 直接敲字就是「盖掉原文开始编辑」（Excel/WPS 一样）。
    if (ev.key.length === 1) {
      ev.preventDefault();
      this.beginEdit(ev.key);
      return;
    }
    const info = this.info();
    if (!info.rows || !info.cols) return;
    const rowH = Math.max(12, this.heightOf(this.focus.r) || ROW_H);
    const page = Math.max(1, Math.floor(this.view.clientHeight / rowH) - 1);
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
    const h = this.heightOf(r) || ROW_H;
    const top = this.topOf(r);
    const frzH = this.topOf(f.rows);
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
    const h = this.heightOf(r) || ROW_H;
    const frzH = this.topOf(f.rows);
    const frzW = this.leftOf(f.cols);
    const viewH = Math.max(1, v.clientHeight - frzH);
    const viewW = Math.max(1, v.clientWidth - frzW);
    if (r >= f.rows) v.scrollTop = Math.max(0, this.topOf(r) - frzH - viewH / 2 + h / 2);
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
    if (clientX < left || clientY < top || clientX > left + this.view.clientWidth || clientY > top + this.view.clientHeight) {
      return null;
    }
    const f = this.freeze();
    let x = clientX - left;
    let y = clientY - top;
    if (x >= this.leftOf(f.cols)) x += this.view.scrollLeft;
    if (y >= this.topOf(f.rows)) y += this.view.scrollTop;
    const r = this.rowAt(Math.max(0, y));
    const c = this.colAt(Math.max(0, x));
    if (r < 0 || r >= info.rows || c < 0 || c >= info.cols) return null;
    return { r, c };
  }

  /** 把选中格报给外面：公式给原文（带 `=`），普通格给显示值；坐标是选区（`A2:C4`）。 */
  private notify(): void {
    if (this.destroyed) return;
    const sel = this.focus;
    const cell = this.cellAt(sel.r, sel.c);
    const text = cell?.f ? `=${cell.f}` : (cell?.t ?? "");
    this.host.onSelect?.({ ref: this.selectionRef, text });
  }

  private visible(): Range | null {
    const info = this.info();
    const rows = info.rows || 0;
    const cols = info.cols || 0;
    if (!rows || !cols) return null;
    const top = this.view.scrollTop;
    const left = this.view.scrollLeft;
    const r0 = Math.max(0, Math.min(rows - 1, this.rowAt(top)));
    const r1 = Math.max(r0, Math.min(rows - 1, this.rowAt(top + this.view.clientHeight)));
    const c0 = Math.max(0, Math.min(cols - 1, this.colAt(left)));
    const c1 = Math.max(c0, Math.min(cols - 1, this.colAt(left + this.view.clientWidth)));
    return { r0, r1, c0, c1 };
  }

  /** 要取的范围：可见行上下各 3 屏（#110），列只要可见的那一段（冻结列带动从 0 起）。 */
  private wantRange(visible: Range): Range {
    const info = this.info();
    const rows = info.rows || 0;
    const f = this.freeze();
    const avg = Math.max(10, Math.round(this.defH * this.zoomLevel));
    const screen = Math.max(1, Math.ceil(this.view.clientHeight / avg));
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
    const avg = Math.max(10, Math.round(this.defH * this.zoomLevel));
    const screen = Math.max(1, Math.ceil(this.view.clientHeight / avg));
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
      // finally 里别用 return：会把上面 catch 的「停下别画」盖掉。
      if (!this.destroyed) {
        if (epoch !== this.epoch) {
          void this.ensure();
        } else {
          this.render();
          this.notify();
          if (this.again) {
            this.again = false;
            void this.ensure();
          }
        }
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
    const info = this.info();
    const frzW = this.leftOf(f.cols);
    const frzH = this.topOf(f.rows);
    const sel = this.rect();

    const cols: HTMLElement[] = [];
    const frzCols: HTMLElement[] = [];
    for (let c = want.c0; c <= want.c1 && c < info.cols; c++) {
      if (this.widthOf(c) <= 0) continue;
      const node = el("div", "sd-col", colName(c));
      node.dataset.c = String(c);
      node.style.left = `${this.leftOf(c)}px`;
      node.style.width = `${this.widthOf(c)}px`;
      if (c >= sel.c0 && c <= sel.c1) node.classList.add("sel");
      if (this.editMode) {
        const grip = el("div", "sd-grip-v");
        grip.dataset.c = String(c);
        node.append(grip);
      }
      // #436 自动筛选的列头箭头：有筛选区就把这列的候选值列出来。
      const flt = this.info().filter;
      if (this.editMode && flt && c >= flt.c0 && c <= flt.c1) {
        const fbtn = el("div", "sd-fbtn", "▾");
        fbtn.dataset.c = String(c);
        fbtn.title = flt.active[c] ? tr("按 {p1} 筛选", { p1: flt.active[c] }) : tr("筛选");
        fbtn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        fbtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openFilter(fbtn, c);
        });
        node.append(fbtn);
      }
      (c < f.cols ? frzCols : cols).push(node);
    }
    this.colheadIn.replaceChildren(...cols);
    this.colheadFrz.replaceChildren(...frzCols);
    this.colheadFrz.hidden = !f.cols;
    this.colheadFrz.style.width = `${frzW}px`;

    const rowheads: HTMLElement[] = [];
    const frzRows: HTMLElement[] = [];
    for (let r = want.r0; r <= want.r1 && r < info.rows; r++) {
      const h = this.heightOf(r);
      if (h <= 0) continue;
      const node = el("div", "sd-rowno", String(r + 1));
      node.dataset.r = String(r);
      node.style.top = `${this.topOf(r)}px`;
      node.style.height = `${h}px`;
      if (r >= sel.r0 && r <= sel.r1) node.classList.add("sel");
      if (this.editMode) {
        const grip = el("div", "sd-grip-h");
        grip.dataset.r = String(r);
        node.append(grip);
      }
      (r < f.rows ? frzRows : rowheads).push(node);
    }
    this.rowheadIn.replaceChildren(...rowheads);
    this.rowheadFrz.replaceChildren(...frzRows);
    this.rowheadFrz.hidden = !f.rows;
    this.rowheadFrz.style.height = `${frzH}px`;

    // 冻结层要画「整条冻结带」，不只是可视范围：滚到第 15 行时第 1 行仍然得在。
    this.grow.clear();
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

    // 编辑框是 cells 的子节点，重建时会被 replaceChildren 冲掉：放回原处继续用。
    if (this.editor) this.cells.append(this.editor.node);
    this.drawImages();
    this.drawCharts();
    this.drawHandle();

    // 换行量出来的行高要在这一帧末尾回填：一次 rebuild，别每格重排一遍。
    if (this.applyGrow()) this.render();
  }

  /**
   * 文件里的图片：按锚点算出 px 位置，只挂与视口（含一屏余量）相交的那几张。
   * 图片压在格子背景之上、选区框之下（CSS 的 z-index），所以点选/拖选照旧靠下面的格子。
   */
  /**
   * #435 拖列宽 / 行高：只在编辑态挂握把；拖动时就地重排（松手才写回文件）。
   * 用未缩放的 base 算，100% 和 150% 拖出来的宽度一致。
   */
  private onHeadDown = (ev: PointerEvent): void => {
    const t = ev.target as HTMLElement | null;
    const gv = t?.closest<HTMLElement>(".sd-grip-v") ?? null;
    const gh = t?.closest<HTMLElement>(".sd-grip-h") ?? null;
    if (!gv && !gh) return;
    ev.preventDefault();
    ev.stopPropagation();
    const z = this.zoomLevel;
    const c = gv ? Number(gv.dataset.c) : -1;
    const r = gh ? Number(gh.dataset.r) : -1;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const w0 = gv ? (this.base[c] ?? COL_W) * z : 0;
    const h0 = gh ? this.heightOf(r) : 0;
    let moved = false;
    const move = (e: PointerEvent): void => {
      moved = true;
      if (gv) this.dragCol(c, (w0 + e.clientX - x0) / z);
      else this.dragRow(r, h0 + e.clientY - y0);
    };
    // 拖动过程中会重画表头（握把节点被换掉），所以监听挂在 window 上，别挂在握把上。
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!moved) return;
      if (gv) this.host.onResize?.("col", c, Math.max(0, ((this.colOver.get(c) ?? 0) - 5) / 7));
      else this.host.onResize?.("row", r, (this.rowOver.get(r) ?? 0) * 0.75);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** 拖动中的临时尺寸（px，未缩放）；不改文件，松手由 onResize 决定写不写。 */
  private dragCol(c: number, px: number): void {
    this.colOver.set(c, Math.max(8, Math.round(px)));
    this.measure();
    this.render();
  }

  private dragRow(r: number, px: number): void {
    this.rowOver.set(r, Math.max(4, Math.round(px)));
    this.measure();
    this.render();
  }

  private drawImages(): void {
    const imgs = this.info().images;
    const url = this.host.mediaUrl;
    if (!imgs?.length || !url) return;
    const z = this.zoomLevel;
    const info = this.info();
    const vx0 = this.view.scrollLeft - this.view.clientWidth;
    const vx1 = this.view.scrollLeft + this.view.clientWidth * 2;
    const vy0 = this.view.scrollTop - this.view.clientHeight;
    const vy1 = this.view.scrollTop + this.view.clientHeight * 2;
    const nodes: HTMLElement[] = [];
    for (const im of imgs) {
      if (im.c0 >= info.cols || im.r0 >= info.rows) continue;
      const left = this.leftOf(im.c0) + im.ox * z;
      const top = this.topOf(im.r0) + im.oy * z;
      let w: number;
      let h: number;
      if (im.c1 !== undefined && im.r1 !== undefined) {
        w = this.leftOf(Math.min(im.c1, info.cols)) + (im.ox1 ?? 0) * z - left;
        h = this.topOf(Math.min(im.r1, info.rows)) + (im.oy1 ?? 0) * z - top;
      } else {
        w = (im.w ?? 0) * z;
        h = (im.h ?? 0) * z;
      }
      if (!(w > 1 && h > 1)) continue;
      if (left + w < vx0 || left > vx1 || top + h < vy0 || top > vy1) continue;
      const img = el("img", "sd-img");
      img.src = url(this.sheet, im.id);
      img.alt = "";
      img.draggable = false;
      img.decoding = "async";
      img.loading = "lazy";
      img.style.left = left + "px";
      img.style.top = top + "px";
      img.style.width = w + "px";
      img.style.height = h + "px";
      nodes.push(img);
    }
    if (nodes.length) this.cells.append(...nodes);
  }

  /**
   * #434 图表：锚点和图片一样（`from` + `to`），只是内容换成按值画的 SVG。
   * 不给纸张视图当背景图用——图表是数据，不是像素。
   */
  private drawCharts(): void {
    const charts = this.info().charts;
    if (!charts?.length) return;
    const z = this.zoomLevel;
    const info = this.info();
    const vx0 = this.view.scrollLeft - this.view.clientWidth;
    const vx1 = this.view.scrollLeft + this.view.clientWidth * 2;
    const vy0 = this.view.scrollTop - this.view.clientHeight;
    const vy1 = this.view.scrollTop + this.view.clientHeight * 2;
    const nodes: HTMLElement[] = [];
    for (const ch of charts) {
      if (ch.c0 >= info.cols || ch.r0 >= info.rows) continue;
      const left = this.leftOf(ch.c0) + ch.ox * z;
      const top = this.topOf(ch.r0) + ch.oy * z;
      let w: number;
      let h: number;
      if (ch.c1 !== undefined && ch.r1 !== undefined) {
        w = this.leftOf(Math.min(ch.c1, info.cols)) + (ch.ox1 ?? 0) * z - left;
        h = this.topOf(Math.min(ch.r1, info.rows)) + (ch.oy1 ?? 0) * z - top;
      } else {
        w = 480 * z;
        h = 300 * z;
      }
      if (!(w > 24 && h > 24)) continue;
      if (left + w < vx0 || left > vx1 || top + h < vy0 || top > vy1) continue;
      const node = chartNode(ch, Math.round(w), Math.round(h));
      node.style.left = left + "px";
      node.style.top = top + "px";
      nodes.push(node);
    }
    if (nodes.length) this.cells.append(...nodes);
  }

  /** 选区右下角那个小方块（Excel 的填充柄）。 */
  private drawHandle(): void {
    const sel = this.rect();
    if (sel.r1 >= this.info().rows || sel.c1 >= this.info().cols) return;
    const handle = el("div", "sd-fill");
    handle.style.left = `${this.leftOf(sel.c1 + 1) - 3}px`;
    handle.style.top = `${this.topOf(sel.r1 + 1) - 3}px`;
    this.cells.append(handle);
  }

  private applyGrow(): boolean {
    if (!this.grow.size || this.growPass >= 2) return false;
    let changed = false;
    for (const [r, h] of this.grow) {
      if (this.fileH.has(r)) continue;
      if ((this.autoH.get(r) ?? 0) >= h) continue;
      this.autoH.set(r, h);
      changed = true;
    }
    this.growPass++;
    if (!changed) return false;
    this.rebuildH();
    this.syncSize();
    return true;
  }

  /** 往某一层里画格子：被合并区盖住的格子不单独画，合并区只画左上角那一个。 */
  private paint(target: HTMLElement, layer: number, want: Range): void {
    const nodes: HTMLElement[] = [];
    // #107：选区是高亮垫在字下面；查找命中另用一种颜色，当前那一处再加一圈描边。
    const sel = this.rect();
    const hitKeys = new Set(this.hits.map((h) => `${h.r}:${h.c}`));
    const curKey = this.hitAt >= 0 ? `${this.hits[this.hitAt].r}:${this.hits[this.hitAt].c}` : "";
    const info = this.info();

    for (let r = want.r0; r <= want.r1 && r < info.rows; r++) {
      if (this.heightOf(r) <= 0) continue;
      for (let c = want.c0; c <= want.c1 && c < info.cols; c++) {
        if (this.widthOf(c) <= 0) continue;
        const span = this.spans.get(`${r}:${c}`);
        if (span && (span.r0 !== r || span.c0 !== c)) continue;
        const r0 = span ? span.r0 : r;
        const c0 = span ? span.c0 : c;
        const r1 = span ? span.r1 : r;
        const c1 = span ? span.c1 : c;
        if (this.layerOf(r1, c1) !== layer) continue;

        const cell = this.cellAt(r0, c0);
        const st = this.styleOf(cell);
        const width = this.leftOf(c1 + 1) - this.leftOf(c0);
        const height = this.topOf(r1 + 1) - this.topOf(r0);

        // 空格子也画一层底：不然整列空着会露出底下的白，网格线断成一段一段。
        const node = el("div", cell ? `sd-cell k-${cell.k}` : "sd-cell is-void");
        node.dataset.r = String(r0);
        node.dataset.c = String(c0);
        if (c1 > c0) node.dataset.span = `${c0}-${c1}`;

        const openR = c1 === info.cols - 1 || c1 + 1 > want.c1;
        const openB = r1 === info.rows - 1 || r1 + 1 > want.r1;
        node.style.left = `${this.leftOf(c0)}px`;
        node.style.top = `${this.topOf(r0)}px`;
        node.style.height = `${height}px`;
        this.paintBox(node, st, cell, r0, c0, r1, c1, openR, openB);

        // 文本溢出到右边的空格子里（Excel 行为）：数字不溢出，换行的不管。
        node.style.width = `${width}px`;

        const need = this.paintContent(node, cell, st, width, r0, c0, c1);
        if (need > 0 && !span && !this.fileH.has(r0)) {
          const prev = this.grow.get(r0) ?? 0;
          if (need > prev) this.grow.set(r0, need);
        }

        // #436 数据验证：有下拉选项的格子在右边挂一个小箭头（只在编辑态）。
        const vd = this.editMode ? this.validAt(r0, c0) : undefined;
        if (vd?.options?.length) {
          const dd = el("div", "sd-dd", "▾");
          dd.title = tr("从列表里选");
          dd.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          dd.addEventListener("click", (e) => {
            e.stopPropagation();
            this.openList(dd, vd.options ?? [], r0, c0);
          });
          node.append(dd);
        }
        // #435 超链接与批注：链接画成蓝色下划线（Ctrl/Cmd 点开），批注画右上角小红角。
        if (cell?.lnk) {
          node.classList.add("is-lnk");
          node.title = cell.lnk;
        }
        if (cell?.note) {
          node.classList.add("is-note");
          node.title = cell.note;
        }
        // #111：只有公式、没存结果的格子：显空 + 红虚线；原文和「去 Excel 重算」放在悬停里。
        if (cell?.noCache) {
          node.classList.add("is-nc");
          node.title = [cell.f ? `=${cell.f}` : "", tr("需用表格软件重算")].filter(Boolean).join("\n");
        }
        const inside = r0 >= sel.r0 && r0 <= sel.r1 && c0 >= sel.c0 && c0 <= sel.c1;
        if (this.focus.r === r0 && this.focus.c === c0) node.classList.add("sel");
        if (inside) node.classList.add("in-sel");
        if (inside) node.style.boxShadow = this.ring(r0, c0);
        const key = `${r0}:${c0}`;
        if (hitKeys.has(key)) {
          node.classList.add("hit");
          if (key === curKey) node.classList.add("hit-on");
        }
        nodes.push(node);
      }
    }
    target.replaceChildren(...nodes);
    // 换行格的行高：用真实渲染高度量（字体、行高、可用宽度都跟画面一致），比离屏量尺准。
    for (const node of nodes) {
      if (node.dataset.wrap !== "1") continue;
      const span = node.querySelector(".sd-txt");
      if (!span) continue;
      const need = Math.ceil(span.getBoundingClientRect().height) + Math.round(5 * this.zoomLevel);
      const r = Number(node.dataset.r);
      if (this.fileH.has(r)) continue;
      if (need > (this.grow.get(r) ?? 0)) this.grow.set(r, need);
    }
  }

  private styleOf(cell: SheetCell | undefined): SheetStyle | undefined {
    if (!cell) return undefined;
    const base = cell.s == null ? undefined : this.host.meta.styles?.[cell.s];
    const over = this.styleOver.get(`${cell.r}:${cell.c}`);
    if (!over) return base;
    return mergeStyle(base, over);
  }

  /** 某格（合并区按左上角算）的样式。 */
  private styleAt(r: number, c: number): SheetStyle | undefined {
    const span = this.spans.get(`${r}:${c}`);
    return this.styleOf(this.cellAt(span ? span.r0 : r, span ? span.c0 : c));
  }

  /**
   * 一条边的 CSS。Excel 的排法：每格只负责左/上边，右/下边由邻居的左/上边来画，
   * 这样相邻两格不会把同一条线叠成 2px；窗口边缘那一条没邻居，才自己补上。
   */
  private edge(st: SheetStyle | undefined, side: "t" | "r" | "b" | "l", r0: number, c0: number, r1: number, c1: number): string {
    const own = st?.bd?.[side];
    if (own) return own;
    let near: string | undefined;
    if (side === "l") near = c0 > 0 ? this.styleAt(r0, c0 - 1)?.bd?.r : undefined;
    else if (side === "t") near = r0 > 0 ? this.styleAt(r0 - 1, c0)?.bd?.b : undefined;
    else if (side === "r") near = this.styleAt(r0, c1 + 1)?.bd?.l;
    else near = this.styleAt(r1 + 1, c0)?.bd?.t;
    if (near) return near;
    return this.showGrid ? GRID_LINE : "none";
  }

  /** 底色、边框、对齐（不含文字）。 */
  private paintBox(
    node: HTMLElement,
    st: SheetStyle | undefined,
    cell: SheetCell | undefined,
    r0: number,
    c0: number,
    r1: number,
    c1: number,
    openR: boolean,
    openB: boolean,
  ): void {
    if (st?.bg) node.style.backgroundColor = st.bg;
    node.style.borderTop = this.edge(st, "t", r0, c0, r1, c1);
    node.style.borderLeft = this.edge(st, "l", r0, c0, r1, c1);
    node.style.borderRight = openR ? this.edge(st, "r", r0, c0, r1, c1) : "none";
    node.style.borderBottom = openB ? this.edge(st, "b", r0, c0, r1, c1) : "none";
    // #109 条件格式只能贴服务端算好的结果，不在前端重算规则。
    const fx = cell?.fx;
    if (fx?.bg) node.style.backgroundColor = fx.bg;
  }

  /** 画文字/数据条/图标；返回这一格至少要多少高度（换行时用来撑行）。 */
  private paintContent(
    node: HTMLElement,
    cell: SheetCell | undefined,
    st: SheetStyle | undefined,
    width: number,
    r0 = 0,
    c0 = 0,
    c1 = 0,
  ): number {
    const z = this.zoomLevel;
    const fx = cell?.fx;
    const f = st?.f;
    const size = fontPx(st, z);

    node.style.fontSize = `${size.toFixed(2)}px`;
    node.style.fontFamily = f?.n ? `"${f.n}", ${FONT_STACK}` : FONT_STACK;
    if (f?.b || fx?.b) node.style.fontWeight = "700";
    if (f?.i) node.style.fontStyle = "italic";
    if (f?.u) node.style.textDecoration = "underline";
    else if (f?.st) node.style.textDecoration = "line-through";
    const color = fx?.fg ?? f?.c;
    if (color) node.style.color = color;

    const auto = cell?.k === "n" ? "r" : cell?.k === "b" || cell?.k === "e" ? "c" : "l";
    const h = st?.h ?? cell?.a ?? auto;
    node.style.justifyContent = h === "c" ? "center" : h === "r" ? "flex-end" : "flex-start";
    node.style.alignItems = st?.v === "t" ? "flex-start" : st?.v === "m" ? "center" : "flex-end";
    node.style.lineHeight = st?.w ? MLINE_WRAP : MLINE;

    const padX = Math.round(4 * z);
    const ind = Math.round((st?.ind ?? 0) * 7 * z);
    node.style.paddingLeft = `${padX + ind}px`;
    node.style.paddingRight = `${padX}px`;
    node.style.paddingBottom = `${Math.round(1.5 * z)}px`;

    const text = this.showFormulas && cell?.f ? `=${cell.f}` : (cell?.t ?? "");
    if (fx?.bar) {
      const bar = el("span", "sd-bar");
      bar.style.width = `${Math.round(fx.bar[0] * 1000) / 10}%`;
      bar.style.backgroundColor = fx.bar[1];
      node.append(bar);
    }
    if (fx?.icon) {
      const icon = el("span", "sd-icon", fx.icon.g);
      icon.dataset.set = fx.icon.s;
      icon.dataset.level = String(fx.icon.l);
      icon.style.color = fx.icon.c;
      node.append(icon);
    }
    if (!text) return 0;

    const body = el("span", "sd-txt", text);
    // #436 一格多字体：把整串换成按段画的 span，复制与查找用的仍是拼好的整串。
    if (cell?.rt?.length && !(this.showFormulas && cell.f)) {
      body.textContent = "";
      for (const run of cell.rt) {
        const seg = el("span", "sd-run", run.t);
        if (run.f?.b) seg.style.fontWeight = "700";
        if (run.f?.i) seg.style.fontStyle = "italic";
        if (run.f?.u) seg.style.textDecoration = "underline";
        if (run.f?.st) seg.style.textDecoration = "line-through";
        if (run.f?.c) seg.style.color = run.f.c;
        if (run.f?.s) seg.style.fontSize = `${((run.f.s * 4) / 3 * z).toFixed(2)}px`;
        if (run.f?.n) seg.style.fontFamily = `"${run.f.n}", ${FONT_STACK}`;
        body.append(seg);
      }
    }
    node.style.whiteSpace = st?.w ? "pre-wrap" : "nowrap";
    body.style.whiteSpace = st?.w ? "pre-wrap" : "nowrap";
    if (st?.w) body.style.wordBreak = "break-word";
    node.append(body);

    const font = fontCss(st, z);
    const avail = Math.max(4, width - padX * 2 - ind - 2);
    const need = cell?.rt?.length
      ? cell.rt.reduce((sum, run) => sum + this.textW(run.t, fontCss(run.f ? { f: run.f } : undefined, z)), 0)
      : this.textW(text, font);

    // 缩小字体填充：字小了不换行也不裁（Excel 的 shrink to fit）。
    if (st?.sh && need > avail) {
      const k = Math.max(0.5, avail / need);
      node.style.fontSize = `${(size * k).toFixed(2)}px`;
      return 0;
    }
    // 换行：高度等节点上树之后再量（见 paint() 末尾），这里只做个记号。
    if (st?.w) {
      node.dataset.wrap = "1";
      return 0;
    }
    // 数字放不下显示 ###：不裁、不溢出（Excel / WPS 都这样）。
    if (cell?.k === "n" && need > avail) {
      const hash = Math.max(1, this.textW("#", font));
      body.textContent = "#".repeat(Math.max(1, Math.floor(avail / hash)));
      node.classList.add("is-hash");
      return 0;
    }
    // 文本比本格宽：旁边空格子借得到就溢出（居中双向、靠右往左、靠左往右），借不到就裁。
    if (need > avail && this.roomFor(r0, c0, c1, h) > need - avail) node.classList.add("sd-ovf");
    return 0;
  }

  /** 本格左右还空着多少像素（遇到有内容的格就停），最多看 8 列。 */
  private roomFor(r0: number, c0: number, c1: number, align: "l" | "c" | "r" | "j"): number {
    const info = this.info();
    let room = 0;
    if (align !== "l") {
      for (let c = c0 - 1; c >= 0 && c0 - c <= 8; c--) {
        if (this.occupied(r0, c)) break;
        room += this.widthOf(c);
      }
    }
    if (align !== "r") {
      for (let c = c1 + 1; c < info.cols && c - c1 <= 8; c++) {
        if (this.occupied(r0, c)) break;
        room += this.widthOf(c);
      }
    }
    return room;
  }

  private occupied(r: number, c: number): boolean {
    const key = `${r}:${c}`;
    // 只有格式化、没内容的格子在 Excel 里照样让文字穿过去，所以看 t 不看键是否存在。
    if (this.cellAt(r, c)?.t) return true;
    return this.spans.has(key);
  }

  /** 文字宽度（canvas 量，带缓存）。 */
  private textW(text: string, font: string): number {
    const key = `${font}\n${text}`;
    const hit = this.tw.get(key);
    if (hit !== undefined) return hit;
    if (!this.mctx) this.mctx = document.createElement("canvas").getContext("2d");
    let w: number;
    if (this.mctx) {
      this.mctx.font = font;
      w = this.mctx.measureText(text).width;
    } else {
      // 没有 canvas（极老的浏览器）：按字号粗估，宁可宽一点。
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14);
      w = text.length * size * 0.55;
    }
    if (this.tw.size > 5000) this.tw.clear();
    this.tw.set(key, w);
    return w;
  }

}
