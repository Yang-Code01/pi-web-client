import zlib from "node:zlib";
import { unzipSync, zipSync } from "fflate";
import { readZipParts, sheetParts, isEncrypted } from "./xlsx-read.ts";

/**
 * 外科手术式写回（D116）：只换被改的那一格所在的 `<c>`，其余 zip part 的**压缩字节原样搬运**。
 *
 * 为什么不用 exceljs 写：它读进来再吐出去会把图表、透视表丢掉（exceljs#2607 / #261）。
 * 用户的表是拿来交差的，丢一张图就是事故。所以这里只碰 `xl/worksheets/sheetN.xml`（外加
 * 顺手清掉 `calcChain.xml` 并给 workbook 打上「打开即全量重算」），别的一个字节不动。
 *
 * 代价（写进 D116，也是这个方案的天花板）：
 * - 只能改值 / 公式 / 清空。改样式、插删行列、动图表一律不做。
 * - 被改格子的旧缓存值没了，但**别的**公式格还是文件里的旧缓存值；准数要等 Excel 打开重算。
 */

export type EditKind = "n" | "s" | "b" | "f" | "clear";

export interface CellEdit {
  /** 0-based，和前端网格一致。 */
  r: number;
  c: number;
  t: EditKind;
  v?: string | number | boolean | null;
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0-based 列号 → A / Z / AA … */
export function colName(c: number): string {
  let n = c + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const cellRef = (r: number, c: number): string => `${colName(c)}${r + 1}`;

const colIndex = (ref: string): number => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** 一个格子要写成什么 xml。`style` 是原来那格的 `s` 属性，原样留住。 */
function cellXml(ref: string, sAttr: string, edit: CellEdit): string {
  const open = `<c r="${ref}"${sAttr}`;
  if (edit.t === "clear") return `${open}/>`;
  if (edit.t === "n") {
    const n = typeof edit.v === "number" ? edit.v : Number(edit.v);
    if (!Number.isFinite(n)) return `${open}/>`;
    return `${open}><v>${n}</v></c>`;
  }
  if (edit.t === "b") return `${open} t="b"><v>${edit.v ? 1 : 0}</v></c>`;
  if (edit.t === "f") {
    const f = String(edit.v ?? "").replace(/^=/, "");
    if (!f.trim()) return `${open}/>`;
    // 不写缓存值：让 Excel 打开时自己算，好过写一个我们自己没算过的数。
    return `${open}><f>${escapeXml(f)}</f></c>`;
  }
  const text = String(edit.v ?? "");
  // 空串按「清空内容」处理，但保留样式 —— 和 Excel 里按 Delete 的行为一致。
  if (text === "") return `${open}/>`;
  return `${open} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

interface Row {
  r: number;
  open: string; // `<row r="3" spans="1:5">`
  inner: string;
  selfClosing: boolean;
}

function parseRows(body: string): Row[] {
  const rows: Row[] = [];
  const re = /<row\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const attrs = m[1];
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1);
    const selfClosing = m[2] === "/";
    if (selfClosing) {
      rows.push({ r, open: `<row${attrs}>`, inner: "", selfClosing: true });
      continue;
    }
    const close = body.indexOf("</row>", re.lastIndex);
    const inner = close < 0 ? body.slice(re.lastIndex) : body.slice(re.lastIndex, close);
    rows.push({ r, open: `<row${attrs}>`, inner, selfClosing: false });
    if (close < 0) break;
    re.lastIndex = close + "</row>".length;
  }
  return rows;
}

/** 在行内找到那一格（有就换掉，没有就按列序插进去）。 */
function upsertCell(inner: string, c: number, ref: string, edit: CellEdit): string {
  const re = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  let insertAt = inner.length;
  while ((m = re.exec(inner))) {
    const attrs = m[1];
    const refAttr = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (refAttr === ref) {
      const sAttr = /\bs="(\d+)"/.exec(attrs)?.[1];
      const next = cellXml(ref, sAttr ? ` s="${sAttr}"` : "", edit);
      return inner.slice(0, m.index) + next + inner.slice(m.index + m[0].length);
    }
    if (refAttr && colIndex(refAttr) > c && insertAt === inner.length) insertAt = m.index;
  }
  const sAttr = "";
  const next = cellXml(ref, sAttr, edit);
  return inner.slice(0, insertAt) + next + inner.slice(insertAt);
}

export function patchSheetXml(xml: string, edits: CellEdit[]): string {
  const open = /<sheetData\b[^>]*>/.exec(xml);
  if (!open) return xml;
  const bodyStart = open.index + open[0].length;
  const closeAt = xml.indexOf("</sheetData>", bodyStart);
  const bodyEnd = closeAt < 0 ? xml.length : closeAt;
  const body = xml.slice(bodyStart, bodyEnd);
  const rows = parseRows(body);
  const byRow = new Map<number, Row>();
  for (const row of rows) byRow.set(row.r, row);

  for (const edit of edits) {
    const rowNo = edit.r + 1;
    const ref = cellRef(edit.r, edit.c);
    let row = byRow.get(rowNo);
    if (!row) {
      row = { r: rowNo, open: `<row r="${rowNo}">`, inner: "", selfClosing: false };
      byRow.set(rowNo, row);
    }
    row.inner = upsertCell(row.inner, edit.c, ref, edit);
    row.selfClosing = false;
  }

  const sorted = [...byRow.values()].sort((a, b) => a.r - b.r);
  const nextBody = sorted.map((row) => (row.selfClosing && !row.inner ? `<row r="${row.r}"/>` : `${row.open}${row.inner}</row>`)).join("");

  let out = xml.slice(0, bodyStart) + nextBody + xml.slice(bodyEnd);
  // dimension 不重算也不影响 Excel，但重算一下能让 LibreOffice 之类的工具少犯迷糊。
  const maxR = Math.max(0, ...edits.map((e) => e.r + 1));
  const maxC = Math.max(0, ...edits.map((e) => e.c));
  const dim = /<dimension ref="([A-Z]+\d+)(?::([A-Z]+\d+))?"\s*\/>/.exec(out);
  if (dim) {
    const start = dim[1];
    const end = dim[2] ?? start;
    const endR = Number(/(\d+)/.exec(end)?.[1] ?? 1);
    const endC = colIndex(/([A-Z]+)/.exec(end)?.[1] ?? "A");
    if (maxR > endR || maxC > endC) {
      const nextEnd = `${colName(Math.max(maxC, endC))}${Math.max(maxR, endR)}`;
      out = out.replace(dim[0], `<dimension ref="${start}:${nextEnd}"/>`);
    }
  }
  return out;
}

/** workbook 上打「打开即全量重算」：不这样的话 Excel 会拿旧缓存值当准数。 */
export function fullCalcOnLoad(workbookXml: string): string {
  const calc = /<calcPr\b([^>]*?)\/>/.exec(workbookXml);
  if (calc) {
    const attrs = calc[1].includes("fullCalcOnLoad") ? calc[1].replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"') : `${calc[1]} fullCalcOnLoad="1"`;
    return workbookXml.replace(calc[0], `<calcPr${attrs}/>`);
  }
  return workbookXml.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
}

/** calcChain 是「哪些格子是公式」的索引，改过值就过期了；留着比删掉更容易让 Excel 报修。 */
function dropCalcChain(parts: Record<string, Uint8Array>): void {
  delete parts["xl/calcChain.xml"];
  const ct = parts["[Content_Types].xml"];
  if (ct) {
    const xml = new TextDecoder().decode(ct);
    const next = xml.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
    if (next !== xml) parts["[Content_Types].xml"] = new TextEncoder().encode(next);
  }
  const rels = parts["xl/_rels/workbook.xml.rels"];
  if (rels) {
    const xml = new TextDecoder().decode(rels);
    const next = xml.replace(/<Relationship\b[^>]*Target="(?:\.\/)?calcChain\.xml"[^>]*\/>/g, "");
    if (next !== xml) parts["xl/_rels/workbook.xml.rels"] = new TextEncoder().encode(next);
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  extAttr: number;
  dataStart: number;
}

function readCentral(buf: Buffer): { entries: ZipEntry[]; comment: Buffer } | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  const comment = buf.subarray(eocd + 22, eocd + 22 + commentLen);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL) return null;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const time = buf.readUInt16LE(at + 12);
    const date = buf.readUInt16LE(at + 14);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const uncompSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentAt = buf.readUInt16LE(at + 32);
    const extAttr = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOffset) !== LOCAL) return null;
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const localName = buf.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localName + localExtra;
    entries.push({ name, flags, method, time, date, crc, compSize, uncompSize, extAttr, dataStart });
    at += 46 + nameLen + extraLen + commentAt;
  }
  return { entries, comment };
}

/**
 * 保留 compression / 时间戳 / 外部属性，只换内容。没在 `replacement` 里的条目按原始压缩字节搬运。
 * 返回 null 表示这份 zip 结构我们不敢动，调用方应该退回 fflate 整包重压。
 */
export function repackZip(buf: Buffer, replacement: Record<string, Uint8Array | null>): Buffer | null {
  const central = readCentral(buf);
  if (!central) return null;
  const locals: Buffer[] = [];
  const dirs: Buffer[] = [];
  let offset = 0;
  for (const e of central.entries) {
    if (e.flags & 0x0001) return null; // 加密条目：不碰
    if (e.compSize === 0xffffffff || e.uncompSize === 0xffffffff) return null; // zip64：不碰
    let method = e.method;
    let data: Buffer;
    let crc = e.crc;
    let compSize = e.compSize;
    let uncompSize = e.uncompSize;
    if (e.name in replacement) {
      const next = replacement[e.name];
      if (next === null) continue; // 删掉这一条
      method = 8;
      uncompSize = next.length;
      crc = zlib.crc32(next);
      data = zlib.deflateRawSync(next, { level: 9 });
      compSize = data.length;
    } else {
      data = buf.subarray(e.dataStart, e.dataStart + e.compSize);
    }
    const nameBuf = Buffer.from(e.name, "utf8");
    const flags = e.flags & ~0x0008; // 清掉 data descriptor：我们自己写准确的 size
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(CENTRAL, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(flags, 8);
    centralEntry.writeUInt16LE(method, 10);
    centralEntry.writeUInt16LE(e.time, 12);
    centralEntry.writeUInt16LE(e.date, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compSize, 20);
    centralEntry.writeUInt32LE(uncompSize, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(e.extAttr, 38);
    centralEntry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    dirs.push(centralEntry, nameBuf);
    offset += 30 + nameBuf.length + compSize;
  }
  const cd = Buffer.concat(dirs);
  const count = dirs.length / 2;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/** fflate 整包重压。`repackZip` 认不出这份 zip（或自己写坏了）时的退路。 */
function rezipFallback(buf: Buffer, replacement: Record<string, Uint8Array | null>): Buffer {
  const all: Record<string, Uint8Array> = unzipSync(new Uint8Array(buf));
  for (const [name, data] of Object.entries(replacement)) {
    if (data === null) delete all[name];
    else all[name] = data;
  }
  return Buffer.from(zipSync(all, { level: 6 }));
}

export interface PatchResult {
  bytes: Buffer;
  /** 真正被改的 part，写进日志用。 */
  parts: string[];
  mode: "surgical" | "rezip";
}

export interface SheetEdits {
  sheet: string;
  edits: CellEdit[];
}

/** 把改动写进这份 xlsx（一次可能改了好几张表），后面只 repack 一次。 */
export function applyCellEdits(buf: Buffer, groups: SheetEdits[]): PatchResult {
  if (isEncrypted(buf)) throw Object.assign(new Error("这是加了密码的 Excel 文件，浏览器里改不了"), { status: 400 });
  const parts = readZipParts(buf);
  if (!parts) throw Object.assign(new Error("这个文件解不开（可能不是 xlsx，或者已经损坏）"), { status: 400 });
  const known = sheetParts(parts);
  const replacement: Record<string, Uint8Array | null> = {};
  const changed: string[] = [];
  for (const group of groups) {
    const target = known.find((s) => s.name === group.sheet);
    if (!target) throw Object.assign(new Error(`找不到工作表「${group.sheet}」`), { status: 404 });
    const sheetBuf = parts[target.part];
    if (!sheetBuf) throw Object.assign(new Error(`工作表「${group.sheet}」的内容是空的`), { status: 404 });
    const xml = new TextDecoder().decode(sheetBuf);
    const nextXml = patchSheetXml(xml, group.edits);
    replacement[target.part] = new TextEncoder().encode(nextXml);
    changed.push(target.part);
  }
  const [firstPart] = changed;
  const firstXml = firstPart ? new TextDecoder().decode(replacement[firstPart] as Uint8Array) : "";
  const wbPart = parts["xl/workbook.xml"];
  if (wbPart) replacement["xl/workbook.xml"] = new TextEncoder().encode(fullCalcOnLoad(new TextDecoder().decode(wbPart)));
  if (parts["xl/calcChain.xml"]) {
    dropCalcChain(parts);
    replacement["xl/calcChain.xml"] = null;
    if (parts["[Content_Types].xml"]) replacement["[Content_Types].xml"] = parts["[Content_Types].xml"];
    if (parts["xl/_rels/workbook.xml.rels"]) replacement["xl/_rels/workbook.xml.rels"] = parts["xl/_rels/workbook.xml.rels"];
  }
  const surgical = repackZip(buf, replacement);
  const parts2 = surgical ? readZipParts(surgical, (name) => changed.includes(name)) : null;
  const ok = parts2 && firstPart != null && parts2[firstPart] && new TextDecoder().decode(parts2[firstPart]).includes(firstXml.slice(0, 200));
  if (!surgical || !ok) {
    return { bytes: rezipFallback(buf, replacement), parts: Object.keys(replacement), mode: "rezip" };
  }
  return { bytes: surgical, parts: Object.keys(replacement), mode: "surgical" };
}
