/**
 * xlsx 解包与取值（D127）：fflate 解 zip，自写的最小 XML 扫描。
 *
 * 这一票只做「元数据 + 一个可视行区间」；流式 zip 与常驻 worker 留给大表那条票（#110），
 * 现在每次请求重新解包，但不缓存解压后的整表 XML，也不把整表发给前端。
 */
import { unzipSync } from "fflate";
import { formatCode, formatValue } from "./numfmt.js";
import { buildCf, countCfUnsupported, readDxfs, type CellFx, type SheetCf } from "./cf.js";

export type CellKind = "n" | "s" | "b" | "e";

export interface WireCell {
  r: number;
  c: number;
  k: CellKind;
  /** 显示串：有数字格式的数按格式显示（日期、货币…），没有格式的就是文件里的原样文本。 */
  t: string;
  /** 文件里指定的对齐（合并格标题居中这类）；没写就不带。 */
  a?: "l" | "c" | "r";
  /** #109 条件格式算出来的样式：底色 / 字色 / 加粗 / 数据条 / 图标。 */
  fx?: CellFx;
  /** 公式原文（不带 `=`）。共享公式的子格只有 `si` 下标、没有正文，就不带这个。 */
  f?: string;
  /** #111：只有公式、文件里没存上次的结果。这种格子显示为空，绝不猜 0。 */
  noCache?: boolean;
}

export interface WireRow {
  r: number;
  cells: WireCell[];
}

/** 一个合并区（含左上角那格本身），0 基、闭区间。 */
export interface MergedRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface FreezePane {
  /** 冻结在顶上的行数。 */
  rows: number;
  /** 冻结在左边的列数。 */
  cols: number;
}

export interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
  /** 文件里藏起来的表：不列在底部，只在状态条上提示。 */
  hidden?: boolean;
  /** 合并区，左上角优先。 */
  merges?: MergedRange[];
  /** 每列宽度（px），长度等于 cols；文件没写就是默认宽度。 */
  colWidths?: number[];
  freeze?: FreezePane | null;
  /** #109：认不出的条件格式规则条数（状态条据此提示）。 */
  cfUnsupported?: number;
  /** #111：这张表里「只有公式、没存结果」的格子数；没这种格子就不带。 */
  noCache?: number;
}

export interface WorkbookMeta {
  name: string;
  rows: number;
  cols: number;
  sheets: SheetInfo[];
  /** 包里有图表部件（xl/charts/chartN.xml）：页面视图能把它一起印到纸上。 */
  charts: boolean;
}

export interface SheetWindow {
  sheet: string;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  rows: WireRow[];
}

/** 只缓存元数据（D127）：sheet 名 → zip 内路径；共享字符串与表 XML 不驻留。 */
export interface Book {
  meta: WorkbookMeta;
  parts: Map<string, string>;
  /** 1904 日期系统（老 Mac 文件）。 */
  date1904: boolean;
  /** #109 每张表的条件格式求值结果（含统计量），随文件版本缓存。 */
  cf: Map<string, SheetCf | null>;
}

const dec = new TextDecoder("utf-8");

function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (m, hex, num, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (num) return String.fromCodePoint(Number(num));
    switch (named) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) return null;
  return unescapeXml(m[2] ?? m[3] ?? "");
}

function texts(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

/** A1 → {r,c}，0 基。 */
export function refOf(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

function normalizePart(target: string): string {
  const clean = target.replace(/^\/+/, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

function zipPart(entries: Record<string, Uint8Array>, name: string): string | null {
  const hit = entries[name];
  return hit ? dec.decode(hit) : null;
}

function dimension(xml: string): { rows: number; cols: number } {
  const ref = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(xml)?.[1] ?? "";
  const [a, b] = ref.split(":");
  const first = refOf(a ?? "");
  const last = refOf(b ?? a ?? "");
  if (!first || !last) return { rows: 0, cols: 0 };
  return { rows: Math.max(0, last.r + 1), cols: Math.max(0, last.c + 1) };
}

/** 一个单元格样式（按 cellXfs 下标）：数字格式代码 + 对齐。 */
interface Xf {
  code: string | null;
  align: "l" | "c" | "r" | null;
}

function readStyles(entries: Record<string, Uint8Array>): Xf[] {
  const xml = zipPart(entries, "xl/styles.xml");
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code) custom.set(id, code);
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const xfs: Xf[] = [];
  for (const m of block.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const id = Number(attr(attrs, "numFmtId") ?? "0");
    const horiz = /<alignment\b[^>]*>/.exec(inner)?.[0];
    const h = horiz ? attr(horiz, "horizontal") : null;
    const align = h === "left" || h === "center" || h === "right" ? (h[0] as "l" | "c" | "r") : null;
    xfs.push({ code: Number.isFinite(id) ? formatCode(id, custom) : null, align });
  }
  return xfs;
}

/** 字符宽度 → 像素：Excel 的默认字宽 7px + 5px 边距。 */
function widthPx(chars: number): number {
  return Math.max(24, Math.min(600, Math.round(chars * 7) + 5));
}

/** 表级结构：合并区、列宽、冻结窗格。 */
function sheetExtras(xml: string): { merges: MergedRange[]; widths: Map<number, number>; defaultW: number; freeze: FreezePane | null } {
  const merges: MergedRange[] = [];
  for (const m of xml.matchAll(/<mergeCell\b[^>]*\bref\s*=\s*"([^"]*)"/g)) {
    const [a, b] = (m[1] ?? "").split(":");
    const first = refOf(a ?? "");
    const last = refOf(b ?? a ?? "");
    if (!first || !last) continue;
    merges.push({
      r0: Math.min(first.r, last.r),
      c0: Math.min(first.c, last.c),
      r1: Math.max(first.r, last.r),
      c1: Math.max(first.c, last.c),
    });
  }

  const def = Number(attr(/<sheetFormatPr\b[^>]*>/.exec(xml)?.[0] ?? "", "defaultColWidth") ?? "8.43");
  const defaultW = widthPx(Number.isFinite(def) && def > 0 ? def : 8.43);
  const colWidths = new Map<number, number>();
  for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
    const min = Number(attr(m[0], "min") ?? "0");
    const max = Number(attr(m[0], "max") ?? "0");
    const w = Number(attr(m[0], "width") ?? attr(m[0], "customWidth") ?? "");
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) continue;
    const px = Number.isFinite(w) && w > 0 ? widthPx(w) : defaultW;
    for (let c = min - 1; c <= Math.min(max - 1, 999); c++) colWidths.set(c, px);
  }

  const pane = /<pane\b[^>]*>/.exec(xml)?.[0];
  let freeze: FreezePane | null = null;
  if (pane && /\bstate\s*=\s*"frozen/.test(pane)) {
    const rows = Number(attr(pane, "ySplit") ?? "0");
    const cols = Number(attr(pane, "xSplit") ?? "0");
    if (rows > 0 || cols > 0) freeze = { rows: Math.max(0, rows), cols: Math.max(0, cols) };
  }

  return { merges, widths: colWidths, defaultW, freeze };
}

/** Reject a package we cannot show, with a code the page can turn into its own sentence. */
function unsupported(what: string): never {
  throw Object.assign(new Error(what), { code: "sheet_unsupported" });
}

/** 读 workbook：sheet 清单 + 尺寸，不碰单元格。 */
export function readBook(buf: Uint8Array): Book {
  // 加密的包（CFB）和改名的旧格式都不是 zip：先认出来，别把解压错误当「表格坏了」端出去。
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) unsupported("这个格式这里不支持，用 Excel 打开");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch {
    unsupported("这个格式这里不支持，用 Excel 打开");
  }
  const workbook = zipPart(entries, "xl/workbook.xml");
  if (!workbook) unsupported("这个格式这里不支持，用 Excel 打开");
  const relsXml = zipPart(entries, "xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) rels.set(id, normalizePart(target));
  }
  const sheets: SheetInfo[] = [];
  const parts = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    if (!name || !rid) continue;
    const part = rels.get(rid);
    if (!part) continue;
    const xml = zipPart(entries, part) ?? "";
    const size = dimension(xml);
    const extras = sheetExtras(xml);
    const cfUnsupported = countCfUnsupported(xml);
    const noCache = countNoCache(xml);
    const state = attr(m[0], "state");
    sheets.push({
      name,
      rows: size.rows,
      cols: size.cols,
      ...(state === "hidden" || state === "veryHidden" ? { hidden: true } : {}),
      ...(extras.merges.length ? { merges: extras.merges } : {}),
      ...(extras.widths.size
        ? { colWidths: Array.from({ length: Math.max(size.cols, ...[...extras.widths.keys()].map((c) => c + 1)) }, (_, c) => extras.widths.get(c) ?? extras.defaultW) }
        : {}),
      ...(extras.freeze ? { freeze: extras.freeze } : {}),
      ...(cfUnsupported > 0 ? { cfUnsupported } : {}),
      ...(noCache ? { noCache } : {}),
    });
    parts.set(name, part);
  }
  if (!sheets.length) throw new Error("这个工作簿里没有工作表");
  const first = sheets[0];
  const pr = /<workbookPr\b[^>]*>/.exec(workbook)?.[0] ?? "";
  const date1904 = /^(1|true)$/i.test(attr(pr, "date1904") ?? "");
  return { meta: { name: first.name, rows: first.rows, cols: first.cols, sheets, charts: hasChartParts(buf) }, parts, date1904, cf: new Map() };

}

/** 只看 zip 目录里有没有图表部件，不解压表 XML（页面视图的开关，D127）。 */
function hasChartParts(buf: Uint8Array): boolean {
  try {
    const found = unzipSync(buf, { filter: (f) => /^xl\/charts\/chart\d+\.xml$/i.test(f.name) });
    return Object.keys(found).length > 0;
  } catch {
    return false;
  }
}

function sharedStrings(entries: Record<string, Uint8Array>): string[] {
  const xml = zipPart(entries, "xl/sharedStrings.xml");
  if (!xml) return [];
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // 日文注音（rPh）不是单元格里的字。
    out.push(texts((m[1] ?? "").replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, "")));
  }
  return out;
}

/**
 * 格子里 `<f>` 的正文。共享公式只有第一个格子存正文，子格只有 `si` 下标（
 * `<f t="shared" si="0"/>`），那张表里退化成只显结果，不猜引用。
 */
function formulaOf(inner: string): string {
  const f = /<f\b[^>]*>([\s\S]*?)<\/f>|<f\b[^>]*\/>/.exec(inner);
  return unescapeXml(f?.[1] ?? "").trim();
}

/**
 * 整张表的「只有公式、没存结果」格子数（#111），状态条上的「N 格无缓存值」。
 * 读元数据时顺带扫一遍：这里不建共享字符串、不查样式，只数 `<c>` 里有没有 `<f>`。
 */
function countNoCache(xml: string): number {
  let n = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const inner = m[2] ?? "";
    if (!/<f\b/.test(inner)) continue;
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
    if (v.trim() === "") n++;
  }
  return n;
}

function cellsOfRow(
  xml: string,
  rowIndex: number,
  c0: number,
  c1: number,
  strings: string[],
  xfs: Xf[],
  date1904: boolean,
  cf: SheetCf | null,
): WireCell[] {
  const cells: WireCell[] = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const pos = refOf(attr(attrs, "r") ?? "");
    if (!pos || pos.r !== rowIndex || pos.c < c0 || pos.c > c1) continue;
    const kind = attr(attrs, "t") ?? "n";
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
    const cached = v.trim() !== "";
    const formula = formulaOf(inner);
    const sIdx = Number(attr(attrs, "s") ?? "");
    const xf = Number.isFinite(sIdx) ? xfs[sIdx] : undefined;
    const align = xf?.align ?? undefined;
    let cell: WireCell | null = null;
    if (kind === "s" && cached) {
      const text = strings[Number(v)];
      if (text !== undefined) cell = { r: pos.r, c: pos.c, k: "s", t: text };
    } else if (kind === "inlineStr") {
      const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "";
      cell = { r: pos.r, c: pos.c, k: "s", t: texts(is) };
    } else if (kind === "str") {
      cell = { r: pos.r, c: pos.c, k: "s", t: unescapeXml(v) };
    } else if (kind === "b") {
      cell = { r: pos.r, c: pos.c, k: "b", t: v.trim() === "1" ? "TRUE" : "FALSE" };
    } else if (kind === "e") {
      cell = { r: pos.r, c: pos.c, k: "e", t: unescapeXml(v) };
    } else if (kind === "d") {
      cell = { r: pos.r, c: pos.c, k: "s", t: unescapeXml(v) };
    } else if (v.trim() !== "") {
      // 有格式就按格式显示（日期/货币/百分比…），没有格式才是文件里的原样数字。
      const raw = unescapeXml(v.trim());
      const num = Number(raw);
      let shown = raw;
      if (xf?.code && Number.isFinite(num)) shown = formatValue(num, xf.code, date1904);
      cell = { r: pos.r, c: pos.c, k: "n", t: shown };
    }
    // 公式格可以带着上次算出的值（就是上面那个 cell），也可以什么都没有（#111）。
    if (formula && !cell) cell = { r: pos.r, c: pos.c, k: "n", t: "" };
    if (cell && formula) cell.f = formula;
    // 只有 `<f>`、没 `<v>`（或 `<v></v>`）：Excel 没存结果。显空，等用户去 Excel 重算。
    if (cell && formula && !cached) cell.noCache = true;
    if (cell && align) cell.a = align;
    if (cell) {
      const fx = cf?.at(pos.r, pos.c);
      if (fx) cell.fx = fx;
      cells.push(cell);
    }
  }
  return cells;
}

/** 每张表的条件格式只算一次，挂在 Book 上（同一文件版本内复用）。 */
function cfOf(book: Book, sheet: string, xml: string, strings: string[], entries: Record<string, Uint8Array>): SheetCf | null {
  const hit = book.cf.get(sheet);
  if (hit !== undefined) return hit;
  const plan = /<conditionalFormatting\b/.test(xml) ? buildCf(xml, strings, readDxfs(zipPart(entries, "xl/styles.xml"))) : null;
  book.cf.set(sheet, plan);
  return plan;
}

/** 取一个窗口：只解析落在 [r0,r1] 里的 row，其它行连 XML 都不进前端。 */
export function readWindow(buf: Uint8Array, book: Book, sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindow {
  const part = book.parts.get(sheet) ?? book.parts.get(book.meta.name);
  if (!part) throw new Error("找不到这个工作表");
  const entries = unzipSync(buf);
  const xml = zipPart(entries, part);
  if (!xml) throw new Error("这个工作表是空的");
  const strings = sharedStrings(entries);
  const xfs = readStyles(entries);
  const cf = cfOf(book, sheet, xml, strings, entries);
  const rows: WireRow[] = [];
  for (const m of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = m[1] ?? m[3] ?? "";
    const num = Number(attr(attrs, "r"));
    if (!Number.isFinite(num)) continue;
    const index = num - 1;
    if (index < r0 || index > r1) continue;
    const cells = cellsOfRow(m[2] ?? "", index, c0, c1, strings, xfs, book.date1904, cf);
    if (cells.length) rows.push({ r: index, cells });
  }
  return { sheet, r0, r1, c0, c1, rows };
}
