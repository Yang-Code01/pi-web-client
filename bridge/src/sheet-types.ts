/** 桥 → 页面之间传的那个「表」。字段都短，因为一次窗口可能要发几千格（D116）。 */

export interface WireBorder {
  /** 每边一个完整 CSS 边框值，例如 `1px solid #BFBFBF`。 */
  t?: string;
  r?: string;
  b?: string;
  l?: string;
}

export interface WireStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  family?: string;
  /** 水平 / 垂直对齐。 */
  h?: "l" | "c" | "r";
  v?: "t" | "m" | "b";
  wrap?: boolean;
  border?: WireBorder;
  /** 文件里的数字格式代码，只给页面做提示（显示文本已经是桥端格式化好的）。 */
  fmt?: string;
}

export interface WireCell {
  r: number;
  c: number;
  /** n=数字 s=文本 b=布尔 d=日期 e=错误 f=公式 */
  k: "n" | "s" | "b" | "d" | "e" | "f";
  v: string | number | boolean | null;
  /** 按 numFmt 格式化之后要显示的文本。 */
  t: string;
  /** `styles[]` 的下标。 */
  s: number;
  /** 条件格式的样式覆盖，`cfs[]` 的下标。 */
  cf?: number;
  /** 数据条长度（0..1）。 */
  bar?: number;
  /** 图标集要画的那个符号。 */
  icon?: string;
  f?: string;
  href?: string;
}

export interface WireChart {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  kind: string;
}

export interface SheetMeta {
  name: string;
  index: number;
  hidden: boolean;
  tabColor?: string;
  rowCount: number;
  colCount: number;
  /** 默认列宽 / 行高（px），已经是 Excel 宽度换算过的值。 */
  defColW: number;
  defRowH: number;
  cols: { w: number; hidden?: boolean }[];
  /** 只有显式设过行高的行，r 是 0-based。 */
  rows: Record<string, number>;
  merges: [number, number, number, number][];
  freeze: { rows: number; cols: number };
  charts: WireChart[];
  /** 条件格式覆盖的格子数，给界面显示一句提示用。 */
  cfRanges: number;
}

export type SheetMode = "full" | "values" | "too-big";

export interface SheetDoc {
  /** 桥给这次打开会话的句柄，后续 window / find / save 都带着它。 */
  token?: string;
  path: string;
  name: string;
  mtime: number;
  size: number;
  /** full=完整渲染 values=只值轻量 too-big=不给看 */
  mode: SheetMode;
  /** 降级 / 受限的原因，直接给用户看。 */
  note?: string;
  cells: number;
  sheets: SheetMeta[];
  /** csv/tsv 才有。 */
  csv?: { encoding: string; delimiter: string; bom: boolean; eol: string };
}
