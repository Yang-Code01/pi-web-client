import { unzipSync } from "fflate";
import type { WireCell } from "./sheet-types.ts";

/**
 * 「只读轻量」模式用的最小 xlsx 解析器（D116）。
 *
 * 30 万格以上就不再让 exceljs 上手了 —— 它给 100 万格要 1.5 GB 内存（实测），而这台桥还开着
 * 一堆 pi 会话。这里只解 `<c>` 里的值和 sharedStrings，内存大概是文件文本的几倍，没有样式。
 */

export interface ValueSheet {
  name: string;
  rowCount: number;
  colCount: number;
  cells: Map<number, Map<number, WireCell>>;
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, "&");

/** `<si>` / `<is>` 里可能是富文本（多个 `<t>` 段），按顺序拼起来。 */
function runs(inner: string): string {
  let out = "";
  for (const m of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]);
  return out;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) out.push(runs(m[1]));
  return out;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function countCells(buf: Buffer): { cells: number; parts: Record<string, Uint8Array> } {
  const parts = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith("xl/worksheets/") && f.name.endsWith(".xml") });
  let cells = 0;
  for (const [name, data] of Object.entries(parts)) {
    if (name.includes("/_rels/")) continue;
    const xml = new TextDecoder().decode(data as Uint8Array);
    const dim = /<dimension\b[^>]*ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(xml);
    if (dim) {
      const c1 = colIndex(dim[1]);
      const r1 = Number(dim[2]);
      const c2 = dim[3] ? colIndex(dim[3]) : c1;
      const r2 = dim[4] ? Number(dim[4]) : r1;
      cells += Math.max(0, r2 - r1 + 1) * Math.max(0, c2 - c1 + 1);
    } else {
      // 没写 dimension 的表：数 <c 的个数（上界，够用来做阈值判断）。
      cells += (xml.match(/<c\b/g) ?? []).length;
    }
  }
  return { cells, parts };
}

/** 只解值和 sharedStrings。`only` 用来限定要哪几张 sheet（省内存）。 */
export function readValueSheets(buf: Buffer, targets: { name: string; part: string }[]): ValueSheet[] {
  const want = new Set(targets.map((t) => t.part));
  const parts = unzipSync(new Uint8Array(buf), {
    filter: (f) => want.has(f.name) || f.name === "xl/sharedStrings.xml",
  });
  const strings = parts["xl/sharedStrings.xml"] ? sharedStrings(new TextDecoder().decode(parts["xl/sharedStrings.xml"])) : [];
  const out: ValueSheet[] = [];
  for (const target of targets) {
    const data = parts[target.part];
    if (!data) continue;
    const xml = new TextDecoder().decode(data);
    const cells = new Map<number, Map<number, WireCell>>();
    let maxRow = 0;
    let maxCol = 0;
    for (const rowM of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      for (const m of rowM[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1];
        const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
        if (!ref) continue;
        const c = colIndex(ref[1]);
        const r = Number(ref[2]) - 1;
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const body = m[2] ?? "";
        const vRaw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
        let cell: WireCell;
        if (t === "s") {
          const s = strings[Number(vRaw ?? -1)] ?? "";
          cell = { r, c, k: f ? "f" : "s", v: s, t: s, s: 0 };
        } else if (t === "inlineStr") {
          const s = runs(body);
          cell = { r, c, k: "s", v: s, t: s, s: 0 };
        } else if (t === "str") {
          const s = vRaw != null ? unescapeXml(vRaw) : "";
          cell = { r, c, k: f ? "f" : "s", v: s, t: s, s: 0 };
        } else if (t === "b") {
          const on = vRaw === "1";
          cell = { r, c, k: "b", v: on, t: on ? "TRUE" : "FALSE", s: 0 };
        } else if (t === "e") {
          const s = vRaw != null ? unescapeXml(vRaw) : "#N/A";
          cell = { r, c, k: "e", v: s, t: s, s: 0 };
        } else {
          const n = Number(vRaw ?? "");
          if (vRaw == null || !Number.isFinite(n)) continue;
          cell = { r, c, k: "n", v: n, t: String(n), s: 0 };
        }
        if (f) cell.f = unescapeXml(f);
        const byRow = cells.get(r) ?? new Map<number, WireCell>();
        byRow.set(c, cell);
        cells.set(r, byRow);
        if (r > maxRow) maxRow = r;
        if (c > maxCol) maxCol = c;
      }
    }
    out.push({ name: target.name, rowCount: maxRow + 1, colCount: maxCol + 1, cells });
  }
  return out;
}
