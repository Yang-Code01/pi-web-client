import iconv from "iconv-lite";
import type { CellEdit } from "./xlsx-write.ts";

/**
 * csv / tsv 的方言探测与重写（D116）。
 *
 * 交来的 csv 什么样都有：Excel 日文环境存出来的是 **GBK + 分号**，Excel 中文环境是 GBK + 逗号，
 * 工具链写的是 UTF-8 + 逗号，还有带 BOM 的。这里把「读」和「写」都按测出来的方言走，
 * 只在用户真的改了格子时才重排一次文本 —— 不改就一个字节都不动。
 */

export interface Dialect {
  encoding: "utf8" | "gbk";
  bom: boolean;
  delimiter: string;
  eol: "\r\n" | "\n";
}

export interface CsvDoc {
  dialect: Dialect;
  rows: string[][];
  /** 原始文本，用来判断「这次保存是不是真的改了东西」。 */
  text: string;
}

function decode(buffer: Buffer): { text: string; dialect: Pick<Dialect, "encoding" | "bom"> } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), dialect: { encoding: "utf8", bom: true } };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, dialect: { encoding: "utf8", bom: false } };
  } catch {
    // 不是合法 UTF-8：Excel 日文/中文环境存出来的多是 GBK（cp936）。
    return { text: iconv.decode(buffer, "gbk"), dialect: { encoding: "gbk", bom: false } };
  }
}

/** 数一数每种候选分隔符在头几行里的出现次数，取最稳的那个。 */
function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 20).filter((l) => l.trim() !== "");
  if (!sample.length) return ",";
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = sample.map((line) => countOutsideQuotes(line, d));
    const nonZero = counts.filter((n) => n > 0);
    if (!nonZero.length) continue;
    // 一致（每行同样个数的分隔符）比「总数最多」更能说明问题。
    const mode = nonZero.sort((a, b) => a - b)[Math.floor(nonZero.length / 2)];
    const agree = counts.filter((n) => n === mode).length / counts.length;
    const score = mode > 0 ? agree * 100 + mode : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) n++;
  }
  return n;
}

export function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(buffer: Buffer): CsvDoc {
  const { text, dialect: enc } = decode(buffer);
  const delimiter = sniffDelimiter(text);
  return {
    text,
    dialect: { ...enc, delimiter, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    rows: parseCsvText(text, delimiter),
  };
}

const needsQuote = (value: string, delimiter: string): boolean => value.includes('"') || value.includes(delimiter) || /[\r\n]/.test(value) || value !== value.trim();

function serializeField(value: string, delimiter: string): string {
  return needsQuote(value, delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(doc: CsvDoc, rows: string[][]): Buffer {
  const { delimiter, eol } = doc.dialect;
  const body = rows.map((row) => row.map((cell) => serializeField(cell ?? "", delimiter)).join(delimiter)).join(eol);
  const text = body.endsWith(eol) || body === "" ? body : `${body}${eol}`;
  const bytes = doc.dialect.encoding === "gbk" ? iconv.encode(text, "gbk") : Buffer.from(text, "utf8");
  if (!doc.dialect.bom) return bytes;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
}

/** 把网格里改过的格子写回行数组。csv 没有公式，`f` / `b` / `n` 一律按文本落。 */
export function applyCsvEdits(rows: string[][], edits: CellEdit[]): string[][] {
  const out = rows.map((row) => [...row]);
  for (const edit of edits) {
    while (out.length <= edit.r) out.push([]);
    const row = out[edit.r];
    while (row.length <= edit.c) row.push("");
    if (edit.t === "clear") row[edit.c] = "";
    else row[edit.c] = String(edit.v ?? "");
  }
  return out;
}
