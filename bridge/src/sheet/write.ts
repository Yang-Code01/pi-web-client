/**
 * 表格写回（#432）：把前端提交的单元格改动落回 .xlsx。
 *
 * 只碰 `xl/worksheets/sheetN.xml` 的 `<sheetData>`：其它 part 原样拷回去（共享字符串、
 * 样式、VBA、图片、图表都不动）。字符串一律写成 inlineStr，免得回头去改 sharedStrings。
 * 公式只写 `<f>`、不写缓存值——打开表格的程序会重算；本工程自己的预览也按「没缓存」显示空白。
 *
 * 写盘走「临时文件 + rename」，覆盖前留一份 `<文件名>.bak`：WPS/Excel 里改坏了还能退回去。
 */
import fs from "node:fs";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { entryBytes, zipIndex } from "./zip.ts";

export interface CellWrite {
  k: "s" | "n" | "b" | "e" | "f";
  /** 字符串 / 错误值 / 公式原文（不带 `=`）。 */
  t?: string;
  /** 数字 / 布尔。 */
  v?: number;
  /** 公式正文；`k === "f"` 时用它。 */
  f?: string;
}

export interface EditOp {
  r: number;
  c: number;
  /** null：把这格清空（连样式一起删，跟 Excel 的 Delete 一致）。 */
  cell: CellWrite | null;
}

/** 单个文件允许编辑的大小上限：整包解压 + 重压缩的内存是它的两三倍。 */
const MAX_EDIT_BYTES = 64 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 不允许这些控制字符，粘进来会把整包写坏。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** A1 → { r, c }（0 基）。 */
function refOf(text: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(text.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = Number(m[2]) - 1;
  if (r < 0 || c < 1) return null;
  return { r, c: c - 1 };
}

/** 0 基列号 → 字母（0 → A）。 */
export function colName(c: number): string {
  let n = c + 1;
  let out = "";
  while (n > 0) {
    const d = (n - 1) % 26;
    out = String.fromCharCode(65 + d) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** 把一条改动写成 `<c>`；`s` 是原来那格的样式下标（有就留着）。 */
function cellXml(r: number, c: number, cell: CellWrite | null, style: string | null): string {
  if (!cell) return "";
  const ref = `${colName(c)}${r + 1}`;
  const s = style && /^\d+$/.test(style) && style !== "0" ? ` s="${style}"` : "";
  if (cell.k === "f") {
    const body = escapeXml(cell.f ?? "");
    return body ? `<c r="${ref}"${s}><f>${body}</f></c>` : `<c r="${ref}"${s}/>`;
  }
  if (cell.k === "n") {
    const v = Number(cell.v ?? cell.t ?? "");
    if (!Number.isFinite(v)) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${v}</v></c>`;
  }
  if (cell.k === "b") {
    return `<c r="${ref}"${s} t="b"><v>${cell.v ? 1 : 0}</v></c>`;
  }
  if (cell.k === "e") {
    return `<c r="${ref}"${s} t="e"><v>${escapeXml(cell.t ?? "#N/A")}</v></c>`;
  }
  const text = cell.t ?? "";
  if (!text) return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

interface RowBox {
  /** 原样的 `<row …>` 开标签（不含结尾的 `>` 或 `/>`）。 */
  open: string;
  /** 列号 → 原样的 `<c …>…</c>`。 */
  cells: Map<number, string>;
}

const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/**
 * 把改动合并进一张表的 XML。只重写动到的行：没动的行连字节都不变（保留原格式与公式）。
 */
export function applyEdits(xml: string, ops: EditOp[]): string {
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
  if (!data) return xml;

  const byRow = new Map<number, Map<number, EditOp>>();
  for (const op of ops) {
    if (!Number.isFinite(op.r) || !Number.isFinite(op.c) || op.r < 0 || op.c < 0) continue;
    let row = byRow.get(op.r);
    if (!row) {
      row = new Map();
      byRow.set(op.r, row);
    }
    row.set(op.c, op);
  }
  if (!byRow.size) return xml;

  const rows = new Map<number, RowBox>();
  const order: number[] = [];
  for (const m of data[1].matchAll(ROW_RE)) {
    const attrs = m[1] ?? "";
    const rn = Number(attrOf(`<row ${attrs}`, "r") ?? "");
    if (!Number.isFinite(rn) || rn < 1) continue;
    const row: RowBox = { open: `<row ${attrs}`.replace(/\s*\/$/, ""), cells: new Map() };
    for (const cm of (m[2] ?? "").matchAll(CELL_RE)) {
      const cAttrs = cm[1] ?? "";
      const ref = attrOf(`<c ${cAttrs}`, "r") ?? "";
      const at = refOf(ref);
      if (!at) continue;
      row.cells.set(at.c, `<c ${cAttrs}>${cm[2] ?? ""}</c>`);
    }
    rows.set(rn - 1, row);
    order.push(rn - 1);
  }

  // 动到的行如果文件里没有，就补一行（行本身没有格式，走默认行高）。
  for (const r of byRow.keys()) {
    if (rows.has(r)) continue;
    rows.set(r, { open: `<row r="${r + 1}"`, cells: new Map() });
    order.push(r);
  }
  order.sort((a, b) => a - b);

  const rebuilt: string[] = [];
  for (const rn of order) {
    const row = rows.get(rn);
    if (!row) continue;
    const edits = byRow.get(rn);
    if (!edits) {
      const body = [...row.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
      rebuilt.push(body ? `${row.open}>${body}</row>` : `${row.open}/>`);
      continue;
    }
    const cols = new Set<number>([...row.cells.keys(), ...edits.keys()]);
    const out: string[] = [];
    for (const c of [...cols].sort((a, b) => a - b)) {
      const op = edits.get(c);
      if (op) {
        const old = row.cells.get(c) ?? "";
        const s = old ? attrOf(`<c ${old.slice(2, old.indexOf(">"))}`, "s") : null;
        const next = cellXml(rn, c, op.cell, s);
        if (next) out.push(next);
        continue;
      }
      const keep = row.cells.get(c);
      if (keep) out.push(keep);
    }
    rebuilt.push(out.length ? `${row.open}>${out.join("")}</row>` : `${row.open}/>`);
  }

  const head = xml.slice(0, data.index);
  const tail = xml.slice(data.index + data[0].length);
  const sheetData = `<sheetData>${rebuilt.join("")}</sheetData>`;
  let next = `${head}${sheetData}${tail}`;
  next = growDimension(next, ops);
  return next;
}

/** `<dimension ref="A1:C9"/>` 是可选的加速信息，写漏了 Excel 也会自己算；这里只把它撑大。 */
function growDimension(xml: string, ops: EditOp[]): string {
  const m = /<dimension\b[^>]*\bref="([^"]*)"[^>]*\/>/.exec(xml);
  if (!m) return xml;
  const [a, b] = m[1].split(":");
  const start = refOf(a ?? "");
  const end = refOf(b ?? a ?? "");
  if (!start || !end) return xml;
  let { r: r0, c: c0 } = start;
  let { r: r1, c: c1 } = end;
  for (const op of ops) {
    r0 = Math.min(r0, op.r);
    c0 = Math.min(c0, op.c);
    r1 = Math.max(r1, op.r);
    c1 = Math.max(c1, op.c);
  }
  const ref = r0 === r1 && c0 === c1 ? `${colName(c0)}${r0 + 1}` : `${colName(c0)}${r0 + 1}:${colName(c1)}${r1 + 1}`;
  return xml.replace(m[0], `<dimension ref="${ref}"/>`);
}

/** sheet 名 → zip 里的 part 路径（`xl/worksheets/sheet1.xml`）。 */
function partOf(dir: Map<string, unknown>, buf: Uint8Array, sheet: string): string | null {
  const read = (name: string): string | null => {
    const entry = zipIndex(buf)?.get(name);
    if (!entry) return null;
    try {
      return utf8.decode(entryBytes(buf, entry));
    } catch {
      return null;
    }
  };
  const workbook = read("xl/workbook.xml") ?? "";
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attrOf(m[0], "Id");
    const target = attrOf(m[0], "Target");
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    if (attrOf(m[0], "name") !== sheet) continue;
    const rid = attrOf(m[0], "r:id") ?? attrOf(m[0], "id");
    const rel = rid ? targets.get(rid) : null;
    if (!rel) continue;
    const part = `xl/${rel}`.replace(/\/\.\//g, "/");
    return dir.has(part) ? part : null;
  }
  return null;
}

export interface SaveResult {
  mtime: number;
  size: number;
  /** 改动了几格（调用方拿去写日志）。 */
  cells: number;
}

/**
 * 应用一批改动并写回原文件。mtime 对不上（这期间被 WPS/Excel 另存过）就拒绝，别把别人的改动盖掉。
 */
export async function saveBook(abs: string, sheet: string, ops: EditOp[], expectMtime: number): Promise<SaveResult> {
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
  const next = applyEdits(xml, ops);
  if (next !== xml) files[part] = strToU8(next);
  // 公式改过：让打开它的程序重算，别拿旧缓存当真。
  const wb = files["xl/workbook.xml"];
  if (wb && ops.some((op) => op.cell?.k === "f")) {
    const text = utf8.decode(wb);
    const patched = /<calcPr\b[^>]*\/>/.test(text)
      ? text.replace(/<calcPr\b[^>]*\/>/, (tag) => (/\bfullCalcOnLoad=/.test(tag) ? tag.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : tag.replace(/\/>$/, ' fullCalcOnLoad="1"/>')))
      : text.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>');
    files["xl/workbook.xml"] = strToU8(patched);
  }

  const out = zipSync(files, { level: 6 });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.pi-tmp`);
  const bak = `${abs}.bak`;
  await fs.promises.writeFile(tmp, out);
  // 第一份备份保留「原样」：只在没有备份时写，避免用户手滑两次就把好版本覆盖掉。
  if (!fs.existsSync(bak)) await fs.promises.copyFile(abs, bak).catch(() => undefined);
  await fs.promises.rename(tmp, abs);
  const after = await fs.promises.stat(abs);
  return { mtime: after.mtimeMs, size: after.size, cells: ops.length };
}

export { encoder };
