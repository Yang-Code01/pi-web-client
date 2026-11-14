/**
 * 结构改动（#434）：合并 / 取消合并、插入 / 删除行列、排序。
 *
 * 和 `write.ts` 的「改几格」不同，这几样要动**整张表**的坐标：格子引用要平移、合并区要
 * 跟着挪、`<dimension>` 要重算。做法的原则还是「只重写要动的地方」——行列 XML 逐行重组，
 * 样式下标、公式原文、行高列宽这些属性原样带过去，别的 part 一个字节都不碰。
 *
 * 公式里的相对引用**不跟着平移**（Excel 会，但那是公式引擎的活）。插入/删除后打开 Excel
 * 重算时，引用会指向原来的坐标——这一点在界面上有提示，见 D256。
 */
import fs from "node:fs";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { zipIndex } from "./zip.ts";
import { attrOf, colName, partOf } from "./write.ts";

export type StructOp =
  | { t: "merge"; r1: number; c1: number; r2: number; c2: number }
  | { t: "unmerge"; r1: number; c1: number; r2: number; c2: number }
  | { t: "insRow" | "delRow"; at: number; n: number }
  | { t: "insCol" | "delCol"; at: number; n: number }
  | { t: "sort"; r1: number; c1: number; r2: number; c2: number; key: number; desc: boolean }
  /** 按某一列的值筛（`value: null` = 清除筛选）。Excel 里就是把不匹配的行藏起来。 */
  | { t: "filter"; c: number; value: string | null }
  /** 抹掉选中区域上的条件格式（只删规则，不动底色/字色这些静态样式）。 */
  | { t: "clearCf"; r1: number; c1: number; r2: number; c2: number }
  /** 拖列宽（`w` 是字符数）/ 拖行高（`h` 是磅）。 */
  | { t: "colWidth"; c: number; w: number }
  | { t: "rowHeight"; r: number; h: number };

const MAX_EDIT_BYTES = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8");

interface Cell {
  /** `<c` 之后、`>` 之前的属性（`r` 会被重写）。 */
  attrs: string;
  /** 子节点（`<v>…</v>` / `<is>…</is>` / `<f>…</f>`）。 */
  inner: string;
}

interface Row {
  r: number;
  /** `<row` 之后的属性。 */
  attrs: string;
  cells: Map<number, Cell>;
}

/** 0 基 → `A1`。 */
function ref(c: number, r: number): string {
  return `${colName(c)}${r + 1}`;
}

function parseRows(data: string): Row[] {
  const rows: Row[] = [];
  const ROW = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const m of data.matchAll(ROW)) {
    const rn = Number(attrOf(`<row ${m[1] ?? ""}`, "r") ?? "");
    if (!Number.isFinite(rn) || rn < 1) continue;
    const cells = new Map<number, Cell>();
    for (const cm of (m[2] ?? "").matchAll(CELL)) {
      const attrs = cm[1] ?? "";
      const at = /^\$?([A-Za-z]{1,3})\$?\d+$/.exec(attrOf(`<c ${attrs}`, "r") ?? "");
      if (!at) continue;
      let c = 0;
      for (const ch of at[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
      cells.set(c - 1, { attrs: attrs.replace(/\sr="[^"]*"/, ""), inner: cm[2] ?? "" });
    }
    rows.push({ r: rn - 1, attrs: (m[1] ?? "").replace(/\sr="[^"]*"/, ""), cells });
  }
  return rows.sort((a, b) => a.r - b.r);
}

/** 在属性串里写/改一个属性（`r="3" hidden="1"` 这种原样字符串）。 */
function setAttr(attrs: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`);
  if (re.test(attrs)) return attrs.replace(re, ` ${name}="${value}"`);
  return `${attrs} ${name}="${value}"`;
}

function rowXml(row: Row): string {
  const attrs = row.attrs.trim();
  const cells = [...row.cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([c, cell]) => (cell.inner ? `<c r="${ref(c, row.r)}"${cell.attrs}>${cell.inner}</c>` : `<c r="${ref(c, row.r)}"${cell.attrs}/>`))
    .join("");
  return `<row ${attrs ? `${attrs} ` : ""}r="${row.r + 1}"${cells ? `>${cells}</row>` : "/>"}`;
}

interface Merges {
  list: [number, number, number, number][];
  /** `<mergeCells …>` 的原始开标签（没有就是 null）。 */
  open: string | null;
  /** 在整张 XML 里的位置，用来替换 / 插入。 */
  at: number;
  length: number;
}

function parseMerges(xml: string): Merges {
  const m = /<mergeCells([^>]*)>([\s\S]*?)<\/mergeCells>/.exec(xml);
  const list: [number, number, number, number][] = [];
  if (m) {
    for (const mm of m[2].matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>/g)) {
      const [a, b] = mm[1].split(":");
      const one = /^([A-Za-z]{1,3})(\d+)$/.exec(a ?? "");
      const two = /^([A-Za-z]{1,3})(\d+)$/.exec(b ?? a ?? "");
      if (!one || !two) continue;
      const col = (s: string): number => {
        let n = 0;
        for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
      };
      list.push([Number(one[2]) - 1, col(one[1]), Number(two[2]) - 1, col(two[1])]);
    }
  }
  return { list, open: m ? `<mergeCells${m[1]}>` : null, at: m?.index ?? -1, length: m?.[0].length ?? 0 };
}

function mergeXml(list: [number, number, number, number][]): string {
  if (!list.length) return "";
  const body = list.map(([r1, c1, r2, c2]) => `<mergeCell ref="${ref(c1, r1)}:${ref(c2, r2)}"/>`).join("");
  return `<mergeCells count="${list.length}">${body}</mergeCells>`;
}

/** 合并区跟着行列平移：整段在下面/右边就平移，跨边界就夹住，落在删除区里就丢掉。 */
function shiftMerges(list: [number, number, number, number][], axis: "r" | "c", at: number, delta: number): [number, number, number, number][] {
  const i0 = axis === "r" ? 0 : 1;
  const i1 = axis === "r" ? 2 : 3;
  const out: [number, number, number, number][] = [];
  for (const box of list) {
    const a = box[i0];
    const b = box[i1];
    if (delta > 0) {
      if (a >= at) {
        box[i0] += delta;
        box[i1] += delta;
        out.push(box);
      } else if (b >= at) {
        box[i1] += delta;
        out.push(box);
      } else out.push(box);
      continue;
    }
    const n = -delta;
    if (a >= at + n) {
      box[i0] -= n;
      box[i1] -= n;
      out.push(box);
    } else if (b >= at + n) {
      box[i0] = at;
      box[i1] = Math.max(at, b - n);
      if (box[i1] >= box[i0]) out.push(box);
    } else if (b < at) out.push(box);
  }
  return out;
}

/** 把合并区写回去（没有就删掉整段，保持和 Excel 一致）。 */
function writeMerges(xml: string, list: [number, number, number, number][]): string {
  const body = mergeXml(list);
  const m = /<mergeCells[^>]*>[\s\S]*?<\/mergeCells>/.exec(xml);
  if (m) return xml.slice(0, m.index) + body + xml.slice(m.index + m[0].length);
  if (!body) return xml;
  // 原来没有 mergeCells：紧跟 </sheetData> 插进去。
  const at = xml.indexOf("</sheetData>");
  if (at < 0) return xml;
  return `${xml.slice(0, at + "</sheetData>".length)}${body}${xml.slice(at + "</sheetData>".length)}`;
}

/** 用实际的行列重算 `<dimension>`（可选标签，写准了打开更快）。 */
function fitDimension(xml: string, rows: Row[]): string {
  const m = /<dimension\b[^>]*\/>/.exec(xml);
  if (!m) return xml;
  let r1 = 0;
  let c1 = 0;
  for (const row of rows) {
    r1 = Math.max(r1, row.r);
    for (const c of row.cells.keys()) c1 = Math.max(c1, c);
  }
  const box = rows.length ? `${ref(0, 0)}:${ref(c1, r1)}` : "A1";
  return xml.replace(m[0], `<dimension ref="${box}"/>`);
}

function replaceSheetData(xml: string, rows: Row[]): string {
  const m = /<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/.exec(xml);
  if (!m) return xml;
  const body = rows.map(rowXml).join("");
  const next = `${xml.slice(0, m.index)}<sheetData>${body}</sheetData>${xml.slice(m.index + m[0].length)}`;
  return fitDimension(next, rows);
}

/** 共享字符串表：排序要拿真文字比大小。 */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = utf8.decode(raw);
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
}

function cellValue(cell: Cell | undefined, sst: string[]): string | number | null {
  if (!cell) return null;
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1];
  if (/\bt="s"/.test(cell.attrs)) return v === undefined ? null : (sst[Number(v)] ?? "");
  if (/\bt="inlineStr"/.test(cell.attrs)) return /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell.inner)?.[1] ?? "";
  if (/\bt="str"/.test(cell.attrs)) return v ?? "";
  if (/\bt="b"/.test(cell.attrs)) return v === "1" ? 1 : 0;
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh", { numeric: true });
}

/** 排序：只重排范围内每个格子里的「内容」，样式跟着内容走，行高留在原地。 */
function sortRange(rows: Row[], op: Extract<StructOp, { t: "sort" }>, sst: string[]): Row[] {
  const r0 = Math.min(op.r1, op.r2);
  const r1 = Math.max(op.r1, op.r2);
  const c0 = Math.min(op.c1, op.c2);
  const c1 = Math.max(op.c1, op.c2);
  const key = Math.min(Math.max(op.key, c0), c1);
  const inside = rows.filter((x) => x.r >= r0 && x.r <= r1);
  if (inside.length < 2) return rows;
  const keyed = inside.map((row) => ({
    row,
    key: cellValue(row.cells.get(key), sst),
    cells: new Map([...row.cells.entries()].filter(([c]) => c >= c0 && c <= c1)),
  }));
  keyed.sort((a, b) => (op.desc ? -compare(a.key, b.key) : compare(a.key, b.key)));
  // 排序是稳定的：同一个键的相对顺序别乱。
  keyed.forEach((item, i) => {
    const row = inside[i];
    if (!row) return;
    for (const c of row.cells.keys()) if (c >= c0 && c <= c1) row.cells.delete(c);
    for (const [c, cell] of item.cells) row.cells.set(c, cell);
  });
  return rows;
}

/** 数字属性：去掉浮点尾巴（18.0000 → 18）。 */
function num(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/**
 * 列宽：Excel 按「字符数」存。把目标列从已有区间里拆出来，再补一条自定义宽。
 * 区间不能被别的 `<col>` 盖住，否则 Excel 读到的还是旧的那条。
 */
function setColWidth(xml: string, c: number, chars: number): string {
  const n = c + 1;
  const block = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml);
  const spans: { min: number; max: number; attrs: string }[] = [];
  if (block) {
    for (const m of (block[1] ?? "").matchAll(/<col\b([^>]*?)\/>/g)) {
      const a = m[1] ?? "";
      const min = Number(attrOf(`<col ${a}`, "min") ?? "0");
      const max = Number(attrOf(`<col ${a}`, "max") ?? "0");
      if (min > 0 && max >= min) spans.push({ min, max, attrs: a });
    }
  }
  const out: { min: number; max: number; attrs: string }[] = [];
  for (const s of spans) {
    if (n < s.min || n > s.max) {
      out.push(s);
      continue;
    }
    if (s.min < n) out.push({ min: s.min, max: n - 1, attrs: s.attrs });
    if (s.max > n) out.push({ min: n + 1, max: s.max, attrs: s.attrs });
  }
  out.push({ min: n, max: n, attrs: `width="${num(Math.max(0, Math.min(255, chars)))}" customWidth="1"` });
  out.sort((a, b) => a.min - b.min);
  const body = out
    .map((s) => {
      const rest = s.attrs
        .replace(/\bmin="[^"]*"/g, "")
        .replace(/\bmax="[^"]*"/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const own = s.min === n && s.max === n ? s.attrs : rest;
      return `<col min="${s.min}" max="${s.max}"${own ? ` ${own}` : ""}/>`;
    })
    .join("");
  const cols = `<cols>${body}</cols>`;
  if (block) return xml.replace(block[0], cols);
  return xml.replace(/<sheetData\b/, `${cols}<sheetData`);
}

/** 行高：写在 `<row r="n" ht="…" customHeight="1">` 上；行不存在就补一条空行。 */
function setRowHeight(xml: string, r: number, pt: number): string {
  const n = r + 1;
  const ht = num(Math.max(0, Math.min(409, pt)));
  let hit = false;
  const out = xml.replace(/<row\b([^>]*?)(\/?)>/g, (all, attrs: string) => {
    if (hit || Number(attrOf(`<row ${attrs}`, "r") ?? "0") !== n) return all;
    hit = true;
    let a = ` ${attrs.trim()}`;
    a = /\bht="[^"]*"/.test(a) ? a.replace(/\bht="[^"]*"/, `ht="${ht}"`) : `${a} ht="${ht}"`;
    a = /\bcustomHeight="[^"]*"/.test(a) ? a.replace(/\bcustomHeight="[^"]*"/, `customHeight="1"`) : `${a} customHeight="1"`;
    return `<row${a}>`;
  });
  if (hit) return out;
  // 新行要插在按 r 升序的位置上，不能一律甩到末尾（Excel 对乱序的 row 会挑食）。
  const mk = `<row r="${n}" ht="${ht}" customHeight="1"/>`;
  let done = false;
  const placed = out.replace(/<row\b([^>]*?)>/, (all, attrs: string) => {
    if (done) return all;
    const rn = Number(attrOf(`<row ${attrs}`, "r") ?? "0");
    if (rn > n) {
      done = true;
      return `${mk}${all}`;
    }
    return all;
  });
  return done ? placed : out.replace(/<\/sheetData>/, `${mk}</sheetData>`);
}

export function applyStruct(xml: string, op: StructOp, sst: string[] = []): string {
  // 条件格式不在 sheetData 里，先办它，免得被「没有格子」挡回去。
  if (op.t === "clearCf") return clearCf(xml, op);
  // 列宽 / 行高也是独立段落，不必解析整张表。
  if (op.t === "colWidth") return setColWidth(xml, op.c, op.w);
  if (op.t === "rowHeight") return setRowHeight(xml, op.r, op.h);
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
  if (!data) return xml;
  let rows = parseRows(data[1]);
  const merges = parseMerges(xml);

  if (op.t === "merge") {
    const box: [number, number, number, number] = [Math.min(op.r1, op.r2), Math.min(op.c1, op.c2), Math.max(op.r1, op.r2), Math.max(op.c1, op.c2)];
    if (box[0] === box[2] && box[1] === box[3]) return xml;
    merges.list = merges.list.filter((m) => !(m[0] === box[0] && m[1] === box[1] && m[2] === box[2] && m[3] === box[3]));
    // 和已有合并区重叠的先拆掉，Excel 也不允许重叠。
    merges.list = merges.list.filter((m) => m[2] < box[0] || m[0] > box[2] || m[3] < box[1] || m[1] > box[3]);
    merges.list.push(box);
    return writeMerges(replaceSheetData(xml, rows), merges.list);
  }

  if (op.t === "unmerge") {
    const r0 = Math.min(op.r1, op.r2);
    const r2 = Math.max(op.r1, op.r2);
    const c0 = Math.min(op.c1, op.c2);
    const c2 = Math.max(op.c1, op.c2);
    merges.list = merges.list.filter((m) => !(m[0] >= r0 && m[2] <= r2 && m[1] >= c0 && m[3] <= c2));
    return writeMerges(replaceSheetData(xml, rows), merges.list);
  }

  if (op.t === "insRow" || op.t === "delRow") {
    const n = Math.max(1, Math.round(op.n));
    const at = Math.max(0, Math.round(op.at));
    if (op.t === "insRow") {
      rows = rows.map((row) => (row.r >= at ? { ...row, r: row.r + n } : row));
    } else {
      rows = rows
        .filter((row) => row.r < at || row.r >= at + n)
        .map((row) => (row.r >= at + n ? { ...row, r: row.r - n } : row));
    }
    merges.list = shiftMerges(merges.list, "r", at, op.t === "insRow" ? n : -n);
    return writeMerges(replaceSheetData(xml, rows), merges.list);
  }

  if (op.t === "insCol" || op.t === "delCol") {
    const n = Math.max(1, Math.round(op.n));
    const at = Math.max(0, Math.round(op.at));
    const move = (c: number): number | null => {
      if (op.t === "insCol") return c >= at ? c + n : c;
      if (c < at) return c;
      if (c < at + n) return null;
      return c - n;
    };
    rows = rows.map((row) => {
      const cells = new Map<number, Cell>();
      for (const [c, cell] of row.cells) {
        const next = move(c);
        if (next !== null) cells.set(next, cell);
      }
      return { ...row, cells };
    });
    merges.list = shiftMerges(merges.list, "c", at, op.t === "insCol" ? n : -n);
    return writeMerges(replaceSheetData(xml, rows), merges.list);
  }

  if (op.t === "sort") {
    rows = sortRange(rows, op, sst);
    return replaceSheetData(xml, rows);
  }
  if (op.t === "filter") {
    const want = op.value === null ? null : op.value.trim();
    for (const row of rows) {
      const cell = row.cells.get(op.c);
      const text = cell ? String(cellValue(cell, sst) ?? "").trim() : "";
      const hit = want === null || text === want;
      row.attrs = hit ? row.attrs.replace(/\s+hidden="[^"]*"/g, "").replace(/\s+hidden='[^']*'/g, "") : setAttr(row.attrs, "hidden", "1");
    }
    return replaceSheetData(xml, rows);
  }
  return xml;
}

/** "B2" / "B2:D9" → 0 基闭区间；看不懂就 null。 */
function a1Box(sq: string): { r0: number; r1: number; c0: number; c1: number } | null {
  const one = (t: string) => {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(t.trim().toUpperCase());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1] ?? "") c = c * 26 + (ch.charCodeAt(0) - 64);
    return { c: c - 1, r: Number(m[2]) - 1 };
  };
  const parts = sq.split(":");
  const a = one(parts[0] ?? "");
  const b = parts.length > 1 ? one(parts[1] ?? "") : a;
  if (!a || !b) return null;
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
}

/**
 * 条件格式是独立于 sheetData 的一串 `<conditionalFormatting sqref="…">`。
 * 选中的范围整块被删掉；只剩一部分的，把 sqref 里那几块摘掉、规则留着。
 */
function clearCf(xml: string, op: Extract<StructOp, { t: "clearCf" }>): string {
  const r0 = Math.min(op.r1, op.r2);
  const r1 = Math.max(op.r1, op.r2);
  const c0 = Math.min(op.c1, op.c2);
  const c1 = Math.max(op.c1, op.c2);
  return xml.replace(
    /<conditionalFormatting([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g,
    (_all, attrs: string, body: string) => {
      const sq = attrOf(attrs, "sqref") ?? "";
      const keep = sq
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => {
          const b = a1Box(t);
          if (!b) return true;
          return b.r1 < r0 || b.r0 > r1 || b.c1 < c0 || b.c0 > c1;
        });
      if (!keep.length) return "";
      return `<conditionalFormatting sqref="${keep.join(" ")}">${body}</conditionalFormatting>`;
    },
  );
}

export interface StructResult {
  mtime: number;
  size: number;
  /** 改完这张表还剩多少行（前端拿去更新「N 行」）。 */
  rows: number;
}

export async function saveStruct(abs: string, sheet: string, op: StructOp, expectMtime: number): Promise<StructResult> {
  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error("不是文件"), { code: "sheet_write" });
  if (Math.abs(st.mtimeMs - expectMtime) > 1) throw Object.assign(new Error("文件已被别的程序改过，重新打开再编辑"), { code: "sheet_stale" });
  if (st.size > MAX_EDIT_BYTES) throw Object.assign(new Error("文件太大，编辑请用本机程序打开"), { code: "sheet_too_big" });
  const buf = new Uint8Array(await fs.promises.readFile(abs));
  const dir = zipIndex(buf);
  if (!dir) throw Object.assign(new Error("这个文件不是 xlsx 包"), { code: "sheet_unsupported" });
  const part = partOf(dir, buf, sheet);
  if (!part) throw Object.assign(new Error("找不到这个工作表"), { code: "sheet_write" });
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf) as Record<string, Uint8Array>;
  } catch {
    throw Object.assign(new Error("这个文件解不开"), { code: "sheet_decode" });
  }
  const raw = files[part];
  if (!raw) throw Object.assign(new Error("找不到这个工作表"), { code: "sheet_write" });
  const xml = utf8.decode(raw);
  const next = applyStruct(xml, op, sharedStrings(files));
  if (next !== xml) files[part] = strToU8(next);
  const out = zipSync(files, { level: 6 });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.pi-tmp`);
  const bak = `${abs}.bak`;
  await fs.promises.writeFile(tmp, out);
  if (!fs.existsSync(bak)) await fs.promises.copyFile(abs, bak).catch(() => undefined);
  await fs.promises.rename(tmp, abs);
  const after = await fs.promises.stat(abs);
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(next);
  return { mtime: after.mtimeMs, size: after.size, rows: data ? parseRows(data[1]).length : 0 };
}
