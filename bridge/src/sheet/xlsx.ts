/**
 * xlsx 解包与取值（D127/#110）：手写 zip 目录 + 流式扫行，自写的最小 XML 扫描。
 *
 * 元数据只读 workbook 与每张表的前缀（`<dimension>`）；取窗口时按行增量解压，
 * 扫过 r1 就停——不把整张表 XML 解出来，更不把整表发给前端。
 */
import { entryBytes, entryStream, zipIndex, type ZipEntry } from "./zip.ts";
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
  /** 这张表的格子数（rows × cols）。三档阈值按它分（#110）。 */
  cells?: number;
  /** #110 显示档：full 全量；light 只值（不涂条件格式）；none 不给（只给清单 + 尺寸）。 */
  tier?: SheetTier;
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
  /** #110：这次实际解压/扫过的表 XML 字节数（扫够就停，所以通常小于 partBytes）。 */
  bytes?: number;
  /** 这张表 XML 的未压缩总字节数。 */
  partBytes?: number;
}

/** #107：查找命中。只回坐标——高亮和跳转用不上值，别顺手把整表内容带出去。 */
export interface SheetMatches {
  sheet: string;
  matches: { r: number; c: number }[];
  /** 超过上限只回前 N 条。 */
  truncated?: boolean;
}

/** #110 三档：全量 / 只值轻量 / 不给。 */
export type SheetTier = "full" | "light" | "none";

/**
 * 三档阈值（格数）。数字来自 2026-11 在五档 fixture 上的实测，见 D127 补记：
 * 峰值 RSS / 首屏 / 解压字节。
 */
export const FULL_MAX_CELLS = 100_000;
export const LIGHT_MAX_CELLS = 1_000_000;

export function tierOf(cells: number): SheetTier {
  if (cells <= FULL_MAX_CELLS) return "full";
  if (cells <= LIGHT_MAX_CELLS) return "light";
  return "none";
}

/** 只缓存元数据与结构（D127）：sheet 名 → zip 内路径；表 XML 不驻留。 */
export interface Book {
  meta: WorkbookMeta;
  parts: Map<string, string>;
  /** zip 中央目录：取窗口时按偏移解单张表，不用再解整包。 */
  dir: Map<string, ZipEntry>;
  /** 1904 日期系统（老 Mac 文件）。 */
  date1904: boolean;
  /** #109 每张表的条件格式求值结果（含统计量），随文件版本缓存。 */
  cf: Map<string, SheetCf | null>;
  /** #110 每张表的档位；none 的表没有 cf / 结构，只有尺寸。 */
  tiers: Map<string, SheetTier>;
  /** 共享字符串与样式按需加载（只有取窗口 / 建 CF 时才需要）。 */
  strings?: string[];
  xfs?: Xf[];
}

import { attr, refOf, texts, unescapeXml } from "./xml.ts";

const dec = new TextDecoder("utf-8");

function normalizePart(target: string): string {
  const clean = target.replace(/^\/+/, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

function partText(buf: Uint8Array, dir: Map<string, ZipEntry>, name: string): string | null {
  const entry = dir.get(name);
  return entry ? dec.decode(entryBytes(buf, entry)) : null;
}

function dimension(xml: string): { rows: number; cols: number } {
  const ref = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(xml)?.[1] ?? "";
  const [a, b] = ref.split(":");
  const first = refOf(a ?? "");
  const last = refOf(b ?? a ?? "");
  if (!first || !last) return { rows: 0, cols: 0 };
  return { rows: Math.max(0, last.r + 1), cols: Math.max(0, last.c + 1) };
}

/** 没有 `<dimension>`（或写坏了）时，退回扫一遍格子引用求最大行列。 */
function extentOf(xml: string): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const m of xml.matchAll(/<c\b[^>]*\br="([A-Za-z]{1,3}\d+)"/g)) {
    const p = refOf(m[1] ?? "");
    if (!p) continue;
    rows = Math.max(rows, p.r + 1);
    cols = Math.max(cols, p.c + 1);
  }
  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) rows = Math.max(rows, Number(m[1]));
  return { rows, cols };
}

/** 表 XML 的前缀：够读到 `<dimension>` 就行，不为一格元数据解完整张表。 */
function sheetPrefix(buf: Uint8Array, entry: ZipEntry, limit = 256 * 1024): string {
  let out = "";
  let bytes = 0;
  const decoder = new TextDecoder("utf-8");
  entryStream(buf, entry, (chunk) => {
    bytes += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
    return !(/<dimension\b[^>]*\/?>/.test(out) || bytes >= limit);
  });
  return out;
}

/** 一个单元格样式（按 cellXfs 下标）：数字格式代码 + 对齐。 */
interface Xf {
  code: string | null;
  align: "l" | "c" | "r" | null;
}

function readStyles(buf: Uint8Array, dir: Map<string, ZipEntry>): Xf[] {
  const xml = partText(buf, dir, "xl/styles.xml");
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

/** 读 workbook：sheet 清单 + 尺寸 + 档位。none 的表不读正文，light 不建条件格式。 */
export function readBook(buf: Uint8Array): Book {
  // 加密的包（CFB）和改名的旧格式都不是 zip：先认出来，别把解压错误当「表格坏了」端出去。
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) unsupported("这个格式这里不支持，用本机程序打开");
  const dir = zipIndex(buf);
  if (!dir) unsupported("这个格式这里不支持，用本机程序打开");
  const workbook = partText(buf, dir, "xl/workbook.xml");
  if (!workbook) unsupported("这个格式这里不支持，用本机程序打开");
  const relsXml = partText(buf, dir, "xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) rels.set(id, normalizePart(target));
  }
  const sheets: SheetInfo[] = [];
  const parts = new Map<string, string>();
  const tiers = new Map<string, SheetTier>();
  const book = { cf: new Map<string, SheetCf | null>() } as Book;
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    const rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    if (!name || !rid) continue;
    const part = rels.get(rid);
    if (!part) continue;
    const entry = dir.get(part);
    if (!entry) continue;
    // 尺寸从表前缀里的 <dimension> 拿；没有才解整张表退而求其次。
    let size = dimension(sheetPrefix(buf, entry));
    if (!size.rows && !size.cols) size = extentOf(partText(buf, dir, part) ?? "");
    const cells = Math.max(0, size.rows) * Math.max(0, size.cols);
    const tier = tierOf(cells);
    tiers.set(name, tier);
    let extras: ReturnType<typeof sheetExtras> = { merges: [], widths: new Map(), defaultW: 96, freeze: null };
    let cfUnsupported = 0;
    let noCache = 0;
    if (tier !== "none") {
      const xml = partText(buf, dir, part) ?? "";
      extras = sheetExtras(xml);
      noCache = countNoCache(xml);
      if (tier === "full") {
        cfUnsupported = countCfUnsupported(xml);
        book.strings ??= sharedStrings(buf, dir);
        const dxfs = readDxfs(partText(buf, dir, "xl/styles.xml"));
        book.cf.set(name, /<conditionalFormatting\b/.test(xml) ? buildCf(xml, book.strings, dxfs) : null);
      } else {
        // 只值轻量：不建条件格式（统计量要把整表数值塞进 Map，正是大表最贵的一步）。
        book.cf.set(name, null);
      }
    }
    const state = attr(m[0], "state");
    sheets.push({
      name,
      rows: size.rows,
      cols: size.cols,
      cells,
      tier,
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
  book.meta = { name: first.name, rows: first.rows, cols: first.cols, sheets, charts: hasChartParts(dir) };
  book.parts = parts;
  book.dir = dir;
  book.tiers = tiers;
  book.date1904 = date1904;
  return book;
}

/** 只看 zip 目录里有没有图表部件，不解压表 XML（页面视图的开关，D127）。 */
function hasChartParts(dir: Map<string, ZipEntry>): boolean {
  for (const name of dir.keys()) if (/^xl\/charts\/chart\d+\.xml$/i.test(name)) return true;
  return false;
}

function sharedStrings(buf: Uint8Array, dir: Map<string, ZipEntry>): string[] {
  const xml = partText(buf, dir, "xl/sharedStrings.xml");
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

/**
 * 取一个窗口：边解压边扫 `<row>`，过 r1 立即停。
 *
 * 只解析 [r0,r1] 的行；深表也不用先把整张表 XML 解成字符串。`bytes` 是这次
 * 实际解出来的表 XML 字节，用来验收「解压字节远小于整表」。
 */
export function readWindow(buf: Uint8Array, book: Book, sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindow {
  const info = book.meta.sheets.find((s) => s.name === sheet);
  const tier = info?.tier ?? book.tiers.get(sheet) ?? "full";
  if (tier === "none") throw Object.assign(new Error("这张表太大，不在这里滚"), { code: "sheet_too_big" });
  const part = book.parts.get(sheet) ?? book.parts.get(book.meta.name);
  if (!part) throw new Error("找不到这个工作表");
  const entry = book.dir.get(part);
  if (!entry) throw new Error("这个工作表是空的");
  const strings = (book.strings ??= sharedStrings(buf, book.dir));
  const xfs = (book.xfs ??= readStyles(buf, book.dir));
  const cf = tier === "full" ? book.cf.get(sheet) ?? null : null;
  const { rows, bytes } = scanRows(buf, entry, r0, r1, c0, c1, strings, xfs, book.date1904, cf);
  return { sheet, r0, r1, c0, c1, rows, bytes, partBytes: entry.size };
}

/** 扫表 XML：按 `<row>` 切块，只解析落在 [r0,r1] 的行；看到更大的行号就停。 */
function scanRows(
  buf: Uint8Array,
  entry: ZipEntry,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
  strings: string[],
  xfs: Xf[],
  date1904: boolean,
  cf: SheetCf | null,
): { rows: WireRow[]; bytes: number } {
  const rows: WireRow[] = [];
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let bytes = 0;
  let stop = false;

  const eat = (text: string): void => {
    pending += text;
    while (!stop) {
      const start = pending.indexOf("<row");
      if (start < 0) {
        // 留一点尾巴：`<row` 可能被切在下一个 chunk 的边界上。
        if (pending.length > 16) {
          bytes += Buffer.byteLength(pending.slice(0, -16));
          pending = pending.slice(-16);
        }
        return;
      }
      if (start > 0) {
        bytes += Buffer.byteLength(pending.slice(0, start));
        pending = pending.slice(start);
      }
      const gt = pending.indexOf(">");
      if (gt < 0) return;
      const head = pending.slice(0, gt + 1);
      const selfClose = head.endsWith("/>");
      let end = gt + 1;
      let body = "";
      if (!selfClose) {
        const close = pending.indexOf("</row>", gt);
        if (close < 0) return;
        body = pending.slice(gt + 1, close);
        end = close + 6;
      }
      const attrs = head.slice(4, selfClose ? -2 : -1);
      const num = Number(attr(attrs, "r"));
      // 过 r1 立即停：这一行不算进「解压字节」，也不解析。
      if (Number.isFinite(num) && num - 1 > r1) {
        stop = true;
        return;
      }
      bytes += Buffer.byteLength(pending.slice(0, end));
      pending = pending.slice(end);
      if (!Number.isFinite(num)) continue;
      const index = num - 1;
      if (index < r0) continue;
      const cells = cellsOfRow(body, index, c0, c1, strings, xfs, date1904, cf);
      if (cells.length) rows.push({ r: index, cells });
    }
  };

  entryStream(buf, entry, (chunk) => {
    eat(decoder.decode(chunk, { stream: true }));
    return !stop;
  });
  if (!stop) {
    eat(decoder.decode());
    bytes += Buffer.byteLength(pending);
  }
  return { rows, bytes };
}

/**
 * #107：在一张表里找字，大小写不敏感，按「显示串」比对（看到什么就能搜什么）。
 * 前端手里只有可视窗口，所以整表扫描只能在服务端做；只回坐标，命中到 `limit` 就停。
 */
export function findInSheet(buf: Uint8Array, book: Book, sheet: string, query: string, limit = 1000): SheetMatches {
  const info = book.meta.sheets.find((s) => s.name === sheet);
  const tier = info?.tier ?? book.tiers.get(sheet) ?? "full";
  if (tier === "none") throw Object.assign(new Error("这张表太大，不在这里搜"), { code: "sheet_too_big" });
  if (!info) throw new Error("找不到这个工作表");
  const part = book.parts.get(sheet) ?? book.parts.get(book.meta.name);
  if (!part) throw new Error("找不到这个工作表");
  const entry = book.dir.get(part);
  if (!entry) throw new Error("这个工作表是空的");
  const matches: { r: number; c: number }[] = [];
  const q = query.trim().toLowerCase();
  if (!q) return { sheet, matches, truncated: false };
  const strings = (book.strings ??= sharedStrings(buf, book.dir));
  const xfs = (book.xfs ??= readStyles(buf, book.dir));
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let stop = false;

  const eat = (text: string): void => {
    pending += text;
    while (!stop) {
      const start = pending.indexOf("<row");
      if (start < 0) {
        // 留一点尾巴：`<row` 可能被切在下一个 chunk 的边界上。
        if (pending.length > 16) pending = pending.slice(-16);
        return;
      }
      if (start > 0) pending = pending.slice(start);
      const gt = pending.indexOf(">");
      if (gt < 0) return;
      const head = pending.slice(0, gt + 1);
      const selfClose = head.endsWith("/>");
      let end = gt + 1;
      let body = "";
      if (!selfClose) {
        const close = pending.indexOf("</row>", gt);
        if (close < 0) return;
        body = pending.slice(gt + 1, close);
        end = close + 6;
      }
      const attrs = head.slice(4, selfClose ? -2 : -1);
      const num = Number(attr(attrs, "r"));
      pending = pending.slice(end);
      if (!Number.isFinite(num)) continue;
      const index = num - 1;
      for (const cell of cellsOfRow(body, index, 0, info.cols - 1, strings, xfs, book.date1904, null)) {
        if (!cell.t || !cell.t.toLowerCase().includes(q)) continue;
        matches.push({ r: cell.r, c: cell.c });
        if (matches.length >= limit) {
          stop = true;
          return;
        }
      }
    }
  };

  entryStream(buf, entry, (chunk) => {
    eat(decoder.decode(chunk, { stream: true }));
    return !stop;
  });
  if (!stop) eat(decoder.decode());
  return { sheet, matches, truncated: stop && matches.length >= limit };
}
