import fs from "node:fs";
import { parentPort, isMainThread, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import { bindSheetSize, evaluate, readRules, type Rule } from "./xlsx-cf.ts";
import { chartBoxes, readPalette, readZipParts, resolveColor, sheetParts, type Palette } from "./xlsx-read.ts";
import { countCells, readValueSheets, type ValueSheet } from "./xlsx-values.ts";
import { formatCell } from "./xlsx-format.ts";
import type { SheetDoc, SheetMeta, SheetMode, WireCell, WireChart, WireStyle } from "./sheet-types.ts";

/**
 * 表格解析 worker（D116）。
 *
 * 为什么单开一支线程：exceljs 读一张 40 万格的表要 ~1 秒、700 MB；放在桥的主线程里，那 1 秒
 * 里所有会话的 ws 消息、RPC 事件全部卡住。worker 里读崩了也只是这条线断掉，桥还活着。
 *
 * 这个文件同时被 worker（`parentPort` 在）和主线程（fallback）使用，所以真正干活的都是
 * `run*` 函数，`onmessage` 只是薄薄一层。
 */

const FULL_LIMIT = 300000;
const VALUES_LIMIT = 1000000;

export interface SheetOpenResult {
  doc: Omit<SheetDoc, "path" | "name" | "mtime" | "size">;
}

export interface SheetWindowResult {
  cells: WireCell[];
  styles: WireStyle[];
  cfs: WireStyle[];
}

/** 一个工作簿的读侧后端：full 用 exceljs，values 用自己那支最小解析器。 */
interface Backend {
  meta(): SheetMeta[];
  window(sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindowResult;
  find(sheet: string, q: string, row: number, col: number): { hits: { r: number; c: number }[]; more: boolean };
}

// ---------------------------------------------------------------- 样式

const px = (pt: number): number => Math.round(pt * 1.333);

function borderOf(side: any, pal: Palette): string | undefined {
  if (!side || !side.style || side.style === "none") return undefined;
  const color = resolveColor(side.color, pal) ?? "#BFBFBF";
  switch (side.style) {
    case "medium":
      return `2px solid ${color}`;
    case "thick":
      return `3px solid ${color}`;
    case "double":
      return `3px double ${color}`;
    case "dashed":
    case "mediumDashed":
      return `1px dashed ${color}`;
    case "dotted":
    case "hair":
      return `1px dotted ${color}`;
    default:
      return `1px solid ${color}`;
  }
}

function styleOf(cell: any, pal: Palette): WireStyle | null {
  const out: WireStyle = {};
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern && fill.pattern !== "none" && fill.pattern !== "gray125") {
    const hex = resolveColor(fill.fgColor, pal) ?? resolveColor(fill.bgColor, pal);
    if (hex) out.fill = hex;
  }
  const font = cell.font ?? {};
  const color = resolveColor(font.color, pal);
  if (color) out.color = color;
  if (font.bold) out.bold = true;
  if (font.italic) out.italic = true;
  if (font.underline && font.underline !== "none") out.underline = true;
  if (font.strike) out.strike = true;
  if (typeof font.size === "number" && Math.abs(font.size - 11) > 0.01) out.size = px(font.size);
  if (font.name && font.name !== "Calibri" && font.name !== "等线" && font.name !== "宋体") out.family = font.name;
  const a = cell.alignment ?? {};
  if (a.horizontal === "center" || a.horizontal === "centerContinuous") out.h = "c";
  else if (a.horizontal === "right") out.h = "r";
  else if (a.horizontal === "left") out.h = "l";
  else if (a.horizontal === "justify" || a.horizontal === "distributed") out.h = "l";
  if (a.vertical === "top") out.v = "t";
  else if (a.vertical === "middle") out.v = "m";
  else if (a.vertical === "bottom") out.v = "b";
  if (a.wrapText) out.wrap = true;
  const b = cell.border;
  if (b) {
    const border: WireStyle["border"] = {};
    const t = borderOf(b.top, pal);
    const r = borderOf(b.right, pal);
    const bt = borderOf(b.bottom, pal);
    const l = borderOf(b.left, pal);
    if (t) border.t = t;
    if (r) border.r = r;
    if (bt) border.b = bt;
    if (l) border.l = l;
    if (Object.keys(border).length) out.border = border;
  }
  if (cell.numFmt && cell.numFmt !== "General") out.fmt = String(cell.numFmt);
  return Object.keys(out).length ? out : null;
}

function cellOf(r: number, c: number, cell: any, pal: Palette, styleIndex: (s: WireStyle | null) => number): WireCell | null {
  const value = cell.value;
  if (value == null) return null;
  const s = styleIndex(styleOf(cell, pal));
  let text = "";
  try {
    text = formatCell(value, cell.numFmt);
  } catch {
    text = String(value);
  }
  if (value instanceof Date) return { r, c, k: "d", v: value.toISOString(), t: text, s };
  if (typeof value === "number") return { r, c, k: "n", v: value, t: text || String(value), s };
  if (typeof value === "boolean") return { r, c, k: "b", v: value, t: text || (value ? "TRUE" : "FALSE"), s };
  if (typeof value === "string") return { r, c, k: "s", v: value, t: text || value, s };
  if (typeof value === "object") {
    if ("error" in value) return { r, c, k: "e", v: String((value as any).error), t: text || String((value as any).error), s };
    if ("formula" in value) {
      const result = (value as any).result;
      // 没有缓存值的公式（比如刚用 patch 写进去的）：显示公式本身，别显示成空格子。
      // 我们不重算，算出来的数是「用 Excel 打开之后」的事（D116）。
      const f = String((value as any).formula ?? "");
      return {
        r,
        c,
        k: "f",
        v: result instanceof Date ? result.toISOString() : (result ?? null),
        t: result != null ? text || String(result) : `=${f}`,
        s,
        f,
      };
    }
    if ("richText" in value) {
      const rich = ((value as any).richText as any[]).map((p) => p?.text ?? "").join("");
      return { r, c, k: "s", v: rich, t: text || rich, s };
    }
    if ("text" in value) {
      const t = String((value as any).text ?? "");
      const href = (value as any).hyperlink ? String((value as any).hyperlink) : undefined;
      return { r, c, k: "s", v: t, t: text || t, s, ...(href ? { href } : {}) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- exceljs 后端

class FullBackend implements Backend {
  private wb: ExcelJS.Workbook;
  private pal: Palette;
  private zip: Record<string, Uint8Array>;
  private parts: { name: string; part: string }[];
  private cfRules = new Map<string, Rule[]>();
  private charts = new Map<string, WireChart[]>();

  private file: string;

  constructor(file: string) {
    this.file = file;
    this.wb = new ExcelJS.Workbook();
    this.zip = {};
    this.parts = [];
    this.pal = readPalette({});
  }

  async load(): Promise<void> {
    const buf = fs.readFileSync(this.file);
    this.zip = readZipParts(buf, (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name.startsWith("xl/they") || name.startsWith("xl/theme/") || name.startsWith("xl/drawings/") || name.startsWith("xl/charts/") || name.startsWith("xl/worksheets/")) ?? {};
    this.pal = readPalette(this.zip);
    this.parts = sheetParts(this.zip);
    await this.wb.xlsx.readFile(this.file);
  }

  meta(): SheetMeta[] {
    const out: SheetMeta[] = [];
    let index = 0;
    for (const ws of this.wb.worksheets) {
      const anyWs = ws as any;
      const cols: { w: number; hidden?: boolean }[] = [];
      const maxCol = Math.max(ws.columnCount ?? 0, 1);
      for (let c = 0; c < maxCol; c++) {
        const col = (ws.columns ?? [])[c];
        const width = col?.width;
        cols.push({ w: width ? Math.round(width * 7 + 5) : 64, ...(col?.hidden ? { hidden: true } : {}) });
      }
      const rows: Record<string, number> = {};
      try {
        ws.eachRow({ includeEmpty: false }, (row, r) => {
          if (row.height) rows[String(r - 1)] = Math.round(row.height * 1.333);
        });
      } catch {
        /* 有的表 eachRow 会抛，行高就不是必需品 */
      }
      const merges: [number, number, number, number][] = [];
      for (const ref of (ws as any).model?.merges ?? []) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(ref));
        if (!m) continue;
        merges.push([Number(m[2]) - 1, colIdxOf(m[1]), Number(m[4]) - 1, colIdxOf(m[3])]);
      }
      const view = (ws.views?.[0] ?? {}) as any;
      const freeze = { rows: Number(view.ySplit ?? 0) || 0, cols: Number(view.xSplit ?? 0) || 0 };
      const tabColor = resolveColor(anyWs.properties?.tabColor, this.pal) ?? undefined;
      out.push({
        name: ws.name,
        index: index++,
        hidden: anyWs.state === "hidden" || anyWs.state === "veryHidden",
        tabColor,
        rowCount: Math.max(ws.rowCount ?? 0, 1),
        colCount: Math.max(ws.columnCount ?? 0, 1),
        defColW: 64,
        defRowH: 20,
        cols,
        rows,
        merges,
        freeze,
        charts: this.chartsFor(ws.name),
        cfRanges: (ws as any).conditionalFormattings?.length ?? 0,
      });
    }
    return out;
  }

  private chartsFor(sheetName: string): WireChart[] {
    const hit = this.charts.get(sheetName);
    if (hit) return hit;
    const part = this.parts.find((p) => p.name === sheetName)?.part;
    const boxes = part ? chartBoxes(this.zip, part) : [];
    const charts = boxes.map((b) => ({ r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2, kind: b.kind }));
    this.charts.set(sheetName, charts);
    return charts;
  }

  private rulesFor(ws: ExcelJS.Worksheet): Rule[] {
    const hit = this.cfRules.get(ws.name);
    if (hit) return hit;
    let rules: Rule[] = [];
    try {
      rules = readRules((ws as any).conditionalFormattings ?? [], this.pal, Math.max(0, (ws.rowCount ?? 1) - 1), Math.max(0, (ws.columnCount ?? 1) - 1));
    } catch {
      rules = [];
    }
    this.cfRules.set(ws.name, rules);
    return rules;
  }

  window(sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindowResult {
    const ws = this.wb.getWorksheet(sheet);
    if (!ws) return { cells: [], styles: [], cfs: [] };
    const styles: WireStyle[] = [];
    const cfs: WireStyle[] = [];
    const styleIds = new Map<string, number>();
    const cfIds = new Map<string, number>();
    const styleIndex = (s: WireStyle | null): number => {
      if (!s) return -1;
      const key = JSON.stringify(s);
      const at = styleIds.get(key);
      if (at != null) return at;
      styles.push(s);
      styleIds.set(key, styles.length - 1);
      return styles.length - 1;
    };
    const cells: WireCell[] = [];
    for (let r = r0; r <= r1; r++) {
      const row = ws.getRow(r + 1);
      if (!row) continue;
      for (let c = c0; c <= c1; c++) {
        const cell = row.getCell(c + 1);
        const wire = cellOf(r, c, cell, this.pal, styleIndex);
        if (wire) cells.push(wire);
      }
    }
    // 条件格式最后叠，只算窗口这一片。
    try {
      bindSheetSize({ getCell: (r, c) => ws.getRow(r + 1).getCell(c + 1), rowCount: ws.rowCount ?? 0, columnCount: ws.columnCount ?? 0 });
      const hits = evaluate(
        { getCell: (r, c) => ws.getRow(r + 1).getCell(c + 1), rowCount: ws.rowCount ?? 0, columnCount: ws.columnCount ?? 0 },
        this.rulesFor(ws),
        { r0, r1, c0, c1 },
        (r, c) => ws.getRow(r + 1).getCell(c + 1).value,
      );
      for (const cell of cells) {
        const hit = hits.get(`${cell.r}:${cell.c}`);
        if (!hit) continue;
        if (hit.style) {
          const key = JSON.stringify(hit.style);
          let at = cfIds.get(key);
          if (at == null) {
            cfs.push(hit.style);
            at = cfs.length - 1;
            cfIds.set(key, at);
          }
          cell.cf = at;
        }
        if (hit.bar != null) cell.bar = hit.bar;
        if (hit.icon) cell.icon = hit.icon;
      }
    } catch {
      /* 条件格式坏了不影响看数 */
    }
    return { cells, styles, cfs };
  }

  find(sheet: string, q: string, row: number, col: number): { hits: { r: number; c: number }[]; more: boolean } {
    const ws = this.wb.getWorksheet(sheet);
    const needle = q.toLowerCase();
    const hits: { r: number; c: number }[] = [];
    if (!ws || !needle) return { hits, more: false };
    const rowEnd = ws.rowCount ?? 0;
    const colEnd = ws.columnCount ?? 0;
    let more = false;
    let started = false;
    for (let r = 0; r < rowEnd; r++) {
      if (r < row) continue;
      const cellRow = ws.getRow(r + 1);
      for (let c = 0; c < colEnd; c++) {
        if (!started && r === row && c <= col) continue;
        started = true;
        const cell = cellRow.getCell(c + 1);
        let text = "";
        try {
          text = String(cell.text ?? "");
        } catch {
          text = "";
        }
        if (text.toLowerCase().includes(needle)) {
          if (hits.length >= 200) {
            more = true;
            return { hits, more };
          }
          hits.push({ r, c });
        }
      }
    }
    return { hits, more };
  }
}

const colIdxOf = (letters: string): number => {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// ---------------------------------------------------------------- 轻量后端

class ValuesBackend implements Backend {
  private sheets: ValueSheet[];

  constructor(sheets: ValueSheet[]) {
    this.sheets = sheets;
  }

  meta(): SheetMeta[] {
    return this.sheets.map((s, i) => ({
      name: s.name,
      index: i,
      hidden: false,
      rowCount: Math.max(s.rowCount, 1),
      colCount: Math.max(s.colCount, 1),
      defColW: 64,
      defRowH: 20,
      cols: [],
      rows: {},
      merges: [],
      freeze: { rows: 0, cols: 0 },
      charts: [],
      cfRanges: 0,
    }));
  }

  window(sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindowResult {
    const s = this.sheets.find((x) => x.name === sheet);
    if (!s) return { cells: [], styles: [], cfs: [] };
    const cells: WireCell[] = [];
    for (let r = r0; r <= r1; r++) {
      const row = s.cells.get(r);
      if (!row) continue;
      for (let c = c0; c <= c1; c++) {
        const cell = row.get(c);
        if (cell) cells.push({ ...cell });
      }
    }
    return { cells, styles: [], cfs: [] };
  }

  find(sheet: string, q: string, row: number, col: number): { hits: { r: number; c: number }[]; more: boolean } {
    const s = this.sheets.find((x) => x.name === sheet);
    const needle = q.toLowerCase();
    const hits: { r: number; c: number }[] = [];
    if (!s || !needle) return { hits, more: false };
    let more = false;
    const rows = [...s.cells.keys()].sort((a, b) => a - b);
    for (const r of rows) {
      if (r < row) continue;
      const rowCells = s.cells.get(r)!;
      for (const c of [...rowCells.keys()].sort((a, b) => a - b)) {
        if (r === row && c <= col) continue;
        if (rowCells.get(c)!.t.toLowerCase().includes(needle)) {
          if (hits.length >= 200) return { hits, more: true };
          hits.push({ r, c });
        }
      }
    }
    return { hits, more };
  }
}

// ---------------------------------------------------------------- 入口

let backend: Backend | null = null;
let mode: SheetMode = "full";

export async function openWorkbook(file: string): Promise<SheetOpenResult> {
  const buf = fs.readFileSync(file);
  if (buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return { doc: { mode: "too-big", note: "这是加了密码的 Excel 文件，浏览器里打不开", cells: 0, sheets: [] } };
  }
  const { cells } = countCells(buf);
  if (cells > VALUES_LIMIT) {
    return { doc: { mode: "too-big", note: `这张表约 ${Math.round(cells / 10000)} 万个单元格，浏览器里画不动，请用 Excel 打开`, cells, sheets: [] } };
  }
  if (cells > FULL_LIMIT) {
    // 轻量模式下不加载 exceljs，只解 worksheets + sharedStrings。
    const zip = readZipParts(buf, (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels");
    const parts = sheetParts(zip ?? {});
    const sheets = readValueSheets(buf, parts);
    backend = new ValuesBackend(sheets);
    mode = "values";
    return { doc: { mode, cells, sheets: backend.meta(), note: "表太大，这里只显示值（没有样式和图表）" } };
  }
  const full = new FullBackend(file);
  await full.load();
  backend = full;
  mode = "full";
  return { doc: { mode, cells, sheets: full.meta() } };
}

function need(): Backend {
  if (!backend) throw new Error("表格还没打开");
  return backend;
}

export function handleWindow(sheet: string, r0: number, r1: number, c0: number, c1: number): SheetWindowResult {
  const cap = 20000;
  const rows = Math.min(r1, r0 + 400);
  const cols = Math.min(c1, c0 + 120);
  if ((rows - r0 + 1) * (cols - c0 + 1) > cap) {
    return need().window(sheet, r0, Math.min(rows, r0 + 200), c0, Math.min(cols, c0 + 60));
  }
  return need().window(sheet, r0, rows, c0, cols);
}

export function handleFind(sheet: string, q: string, row: number, col: number) {
  return need().find(sheet, q, row, col);
}

export function currentMode(): SheetMode {
  return mode;
}

// ---------------------------------------------------------------- worker 薄壳

interface Job {
  id: number;
  op: "open" | "window" | "find";
  sheet?: string;
  r0?: number;
  r1?: number;
  c0?: number;
  c1?: number;
  q?: string;
  row?: number;
  col?: number;
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (job: Job) => {
    void (async () => {
      try {
        if (job.op === "open") {
          const out = await openWorkbook(String(workerData?.file ?? ""));
          port.postMessage({ id: job.id, ok: true, data: out });
          return;
        }
        if (job.op === "window") {
          const out = handleWindow(String(job.sheet ?? ""), job.r0 ?? 0, job.r1 ?? 0, job.c0 ?? 0, job.c1 ?? 0);
          port.postMessage({ id: job.id, ok: true, data: out });
          return;
        }
        const out = handleFind(String(job.sheet ?? ""), String(job.q ?? ""), job.row ?? 0, job.col ?? 0);
        port.postMessage({ id: job.id, ok: true, data: out });
      } catch (err: any) {
        port.postMessage({ id: job.id, ok: false, error: String(err?.message ?? err) });
      }
    })();
  });
}
