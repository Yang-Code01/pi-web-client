/**
 * #436 自动筛选（`<autoFilter ref="A1:H20">`）：预览里做两件事——
 * 表头上画出「筛选」小箭头，以及把每一列的去重值列出来供选择。
 *
 * 只读取值，不改文件；真正的「筛下去」由 `struct.ts` 的 `filter` 操作写回
 * （隐藏行 + `<filterColumn>`），Excel 打开时看到的是同一份状态。
 */
import { colIndex, parseSqref } from "./valid.ts";

export interface WireFilter {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  /** 列号（0 基）→ 该列在筛选区里的去重值（最多 300 个）。 */
  values: Record<number, string[]>;
  /** 列号 → 当前筛的值（没有就是全部）。 */
  active: Record<number, string>;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

export function readFilter(xml: string, strings: string[]): WireFilter | null {
  const m = /<autoFilter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/autoFilter>)/.exec(xml);
  if (!m) return null;
  const box = parseSqref(attrOf(`<a ${m[1] ?? ""}`, "ref") ?? "");
  if (!box) return null;
  const values: Record<number, string[]> = {};
  const seen = new Map<number, Set<string>>();
  for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = `<c ${c[1] ?? ""}`;
    const r = attrOf(tag, "r");
    if (!r) continue;
    const pos = /^([A-Z]{1,3})(\d+)$/.exec(r.toUpperCase());
    if (!pos) continue;
    const col = colIndex(pos[1] ?? "A");
    const row = Number(pos[2]) - 1;
    if (row <= box.r0 || row > box.r1 || col < box.c0 || col > box.c1) continue;
    const body = c[2] ?? "";
    const kind = attrOf(tag, "t") ?? "n";
    let v = "";
    if (kind === "inlineStr") v = unescapeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? "");
    else {
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
      v = kind === "s" ? strings[Number(raw)] ?? "" : unescapeXml(raw);
    }
    v = v.trim();
    if (!v) continue;
    let set = seen.get(col);
    if (!set) {
      set = new Set();
      seen.set(col, set);
      values[col] = [];
    }
    if (set.has(v) || set.size >= 300) continue;
    set.add(v);
    values[col].push(v);
  }
  const active: Record<number, string> = {};
  for (const fc of (m[2] ?? "").matchAll(/<filterColumn\b([^>]*?)>([\s\S]*?)<\/filterColumn>/g)) {
    const colId = Number(attrOf(`<f ${fc[1] ?? ""}`, "colId"));
    const val = /<filter\b[^>]*\bval="([^"]*)"/.exec(fc[2] ?? "")?.[1];
    if (Number.isFinite(colId) && val !== undefined) active[box.c0 + colId] = unescapeXml(val);
  }
  return { ...box, values, active };
}
