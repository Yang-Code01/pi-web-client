/**
 * CSV / TSV 的字节 → 文本 → 格子（D164 的 #113 那半）。
 *
 * 字节仍从 `/raw` 拿，编码嗅探与切格都在前端：先看 BOM，再试严格 UTF-8，失败就当 GBK。
 * 保存不在这里——表格只读，源码 tab 改完走既有文本通道，桥端按打开时的编码写回。
 */
import type { SheetCell, SheetWindow } from "../types.ts";

export type CsvEncoding = "utf8" | "gbk";

/** 超过这个行数只显示前一段（#113 的截断口径）。 */
export const CSV_MAX_ROWS = 50000;
/** 桥端 canEdit 的上限，超了就不给保存。 */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

export interface CsvData {
  /** 解码后的全文，源码 tab 的初始内容。 */
  text: string;
  encoding: CsvEncoding;
  delimiter: string;
  rows: string[][];
  cols: number;
  /** 文件里实际有多少行：截断时比 rows.length 大。 */
  total: number;
  truncated: boolean;
}

/** BOM 剥掉、按嗅探到的编码解码。 */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf8" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { text: new TextDecoder("gbk").decode(bytes), encoding: "gbk" };
  }
}

/** 表头那一行里谁出现得多谁是分隔符（逗号 / 制表符 / 分号）。 */
export function sniffDelimiter(text: string): string {
  const line = text.slice(0, Math.max(0, text.search(/[\r\n]/)));
  let best = ",";
  let most = 0;
  for (const cand of [",", "\t", ";"]) {
    let n = 0;
    for (const ch of line) if (ch === cand) n++;
    if (n > most) {
      most = n;
      best = cand;
    }
  }
  return best;
}

/** 切格：认双引号包裹、`""` 转义、CRLF / LF / CR 换行；超过 maxRows 只留前面，但继续数总数。 */
export function parseCsv(text: string, delimiter: string, maxRows = CSV_MAX_ROWS): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let total = 0;
  const endRow = (): void => {
    total++;
    if (rows.length < maxRows) rows.push([...row, cell]);
    row = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, total };
}

/** 一口气读出一张 CSV：解码、嗅探、切格，行数超限就截断。 */
export function readCsv(bytes: Uint8Array, maxRows = CSV_MAX_ROWS): CsvData {
  const { text, encoding } = decodeCsv(bytes);
  const delimiter = sniffDelimiter(text);
  const { rows, total } = parseCsv(text, delimiter, maxRows);
  let cols = 0;
  for (const row of rows) if (row.length > cols) cols = row.length;
  return { text, encoding, delimiter, rows, cols, total, truncated: total > rows.length };
}

/** 源码改过之后按原来的分隔符重新切格（不重新嗅探，免得改一个字就把列拆坏）。 */
export function reparseCsv(data: CsvData, text: string): CsvData {
  const { rows, total } = parseCsv(text, data.delimiter);
  let cols = 0;
  for (const row of rows) if (row.length > cols) cols = row.length;
  return { ...data, text, rows, cols, total, truncated: total > rows.length };
}

/** 给只读网格喂一片窗口（和桥端 `/api/sheet/window` 同形状，格子全是字符串）。 */
export function csvWindow(data: CsvData, sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindow {
  const rows: { r: number; cells: SheetCell[] }[] = [];
  const last = Math.min(r1, data.rows.length - 1);
  for (let r = Math.max(0, r0); r <= last; r++) {
    const cells: SheetCell[] = [];
    const row = data.rows[r] ?? [];
    const end = Math.min(c1, row.length - 1);
    for (let c = Math.max(0, c0); c <= end; c++) {
      const t = row[c];
      if (t === "") continue;
      cells.push({ r, c, k: "s", t });
    }
    rows.push({ r, cells });
  }
  return { sheet, r0: Math.max(0, r0), r1: last, c0, c1, rows };
}
