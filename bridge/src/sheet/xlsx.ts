/**
 * xlsx 解包与取值（D127）：fflate 解 zip，自写的最小 XML 扫描。
 *
 * 这一票只做「元数据 + 一个可视行区间」；流式 zip 与常驻 worker 留给大表那条票（#110），
 * 现在每次请求重新解包，但不缓存解压后的整表 XML，也不把整表发给前端。
 */
import { unzipSync } from "fflate";

export type CellKind = "n" | "s" | "b" | "e";

export interface WireCell {
  r: number;
  c: number;
  k: CellKind;
  /** 显示串：数字就是文件里的原样文本，不转日期、不丢小数。 */
  t: string;
}

export interface WireRow {
  r: number;
  cells: WireCell[];
}

export interface SheetInfo {
  name: string;
  rows: number;
  cols: number;
}

export interface WorkbookMeta {
  name: string;
  rows: number;
  cols: number;
  sheets: SheetInfo[];
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
    sheets.push({ name, rows: size.rows, cols: size.cols });
    parts.set(name, part);
  }
  if (!sheets.length) throw new Error("这个工作簿里没有工作表");
  const first = sheets[0];
  return { meta: { name: first.name, rows: first.rows, cols: first.cols, sheets }, parts };
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

function cellsOfRow(xml: string, rowIndex: number, c0: number, c1: number, strings: string[]): WireCell[] {
  const cells: WireCell[] = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const pos = refOf(attr(attrs, "r") ?? "");
    if (!pos || pos.r !== rowIndex || pos.c < c0 || pos.c > c1) continue;
    const kind = attr(attrs, "t") ?? "n";
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
    let cell: WireCell | null = null;
    if (kind === "s") {
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
      // 数字原样：45292 就是 45292，不猜日期；3.14159 不四舍五入。
      cell = { r: pos.r, c: pos.c, k: "n", t: unescapeXml(v.trim()) };
    }
    if (cell) cells.push(cell);
  }
  return cells;
}

/** 取一个窗口：只解析落在 [r0,r1] 里的 row，其它行连 XML 都不进前端。 */
export function readWindow(buf: Uint8Array, book: Book, sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindow {
  const part = book.parts.get(sheet) ?? book.parts.get(book.meta.name);
  if (!part) throw new Error("找不到这个工作表");
  const entries = unzipSync(buf);
  const xml = zipPart(entries, part);
  if (!xml) throw new Error("这个工作表是空的");
  const strings = sharedStrings(entries);
  const rows: WireRow[] = [];
  for (const m of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = m[1] ?? m[3] ?? "";
    const num = Number(attr(attrs, "r"));
    if (!Number.isFinite(num)) continue;
    const index = num - 1;
    if (index < r0 || index > r1) continue;
    const cells = cellsOfRow(m[2] ?? "", index, c0, c1, strings);
    if (cells.length) rows.push({ r: index, cells });
  }
  return { sheet, r0, r1, c0, c1, rows };
}
