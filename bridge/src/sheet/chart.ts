/**
 * #434 图表：把工作簿里的图表对象读成「能画的东西」。
 *
 * 图表在 xlsx 里是三层——`drawing1.xml` 里记位置（`xdr:from/to`）和 `r:id`，
 * drawing 的 rels 指到 `charts/chart1.xml`，chart 里才是系列和引用
 * （`c:tx` / `c:cat` / `c:val` 里的 `$B$2:$B$5`）。这里只读值；线的粗细、
 * 渐变那些在 `c:spPr` 里，前端画的时候用统一配色。
 *
 * 只认柱/条、折线、饼、面积、散点；雷达、股价、曲面之类的图对象仍然不画。
 */
import { entryBytes, type ZipEntry } from "./zip.ts";

/** 一条系列：名字 + 数值（空格子算 null，画的时候断开）。 */
export interface WireSeries {
  name: string;
  values: (number | null)[];
}

export interface WireChart {
  /** zip 里的图表 part，前端拿它当 key。 */
  id: string;
  kind: "bar" | "line" | "pie" | "area" | "scatter";
  /** 横向条形（`barDir="bar"`）。 */
  horizontal?: 1;
  title?: string;
  cats: string[];
  series: WireSeries[];
  /** 锚点：左上角格 + 偏移，右下角同理（EMU 已换成 px）。 */
  c0: number;
  r0: number;
  ox: number;
  oy: number;
  c1?: number;
  r1?: number;
  ox1?: number;
  oy1?: number;
}

const EMU_PX = 9525;
const MAX_CHARTS = 40;

/** 找一个标签（忽略命名空间前缀）的内容。 */
function first(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/** `<c:f>Sheet1!$B$2:$B$5</c:f>` → 表名 + 0 基闭区间；看不懂就 null。 */
export function rangeRef(ref: string): { sheet: string; r0: number; r1: number; c0: number; c1: number } | null {
  const text = ref.trim().replace(/^=/, "");
  const bang = text.lastIndexOf("!");
  const sheet = bang >= 0 ? text.slice(0, bang).replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'") : "";
  const box = text.slice(bang + 1);
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(box);
  if (!m) return null;
  const col = (s: string): number => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const r0 = Number(m[2]) - 1;
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c0 = col(m[1]!);
  const c1 = m[3] ? col(m[3]) : c0;
  return { sheet, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
}

/** 锚点（图片和图表共用一套结构）。 */
function anchorOf(block: string, which: "from" | "to"): { c: number; r: number; ox: number; oy: number } | null {
  const part = first(block, which);
  if (!part) return null;
  const num = (name: string): number => Number(new RegExp(`<(?:\\w+:)?${name}>(-?\\d+)<`).exec(part)?.[1] ?? 0);
  return { c: num("col"), r: num("row"), ox: num("colOff") / EMU_PX, oy: num("rowOff") / EMU_PX };
}

/** 把 `<c:f>` 的引用换成数值；`sheet` 是表名，前端不需要知道。 */
export type RangeValues = (ref: string) => (string | number | null)[][] | null;

function numbers(grid: (string | number | null)[][] | null): (number | null)[] {
  if (!grid) return [];
  return grid.map((row) => {
    const v = row[0];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
  });
}

/** 图表自带的值缓存：series 的 `numCache` / 类目的 `strCache`，取不到单元格时兜底。 */
function cacheOf(inner: string, kind: "num" | "str"): (string | number | null)[] {
  const cache = first(inner, `${kind}Cache`);
  if (!cache) return [];
  const out: (string | number | null)[] = [];
  for (const pt of cache.matchAll(/<(?:c:)?pt(?:\s[^>]*)?>([\s\S]*?)<\/(?:c:)?pt>/g)) {
    const idx = Number(attr(pt[0]!, "idx"));
    const v = /<c:v>([\s\S]*?)<\/c:v>/.exec(pt[1] ?? "")?.[1] ?? "";
    const val = kind === "num" ? (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null) : v;
    while (out.length < idx) out.push(null);
    out[idx] = val;
  }
  return out;
}

function textOf(inner: string): string {
  return [...inner.matchAll(/<(?:a|A):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:a|A):t>/g)].map((m) => m[1] ?? "").join("").trim();
}

/** 读一张表里的全部图表。`values` 把 `Sheet!$A$1:$B$3` 取成值。 */
export function readSheetCharts(buf: Uint8Array, dir: Map<string, ZipEntry>, sheetPart: string, values: RangeValues): WireChart[] {
  const text = (part: string): string | null => {
    const entry = dir.get(part);
    if (!entry) return null;
    try {
      return new TextDecoder().decode(entryBytes(buf, entry));
    } catch {
      return null;
    }
  };
  const relsText = text(sheetPart.replace(/([^/]+)$/, "_rels/$1.rels"));
  if (!relsText) return [];
  const drawingRel = [...relsText.matchAll(/<Relationship(?:\s[^>]*)?>/g)]
    .map((m) => m[0])
    .find((tag) => attr(tag, "Type").endsWith("/drawing"));
  if (!drawingRel) return [];

  const drawingPart = resolve(sheetPart, attr(drawingRel, "Target"));
  const drawingXml = text(drawingPart);
  if (!drawingXml) return [];
  const chartTargets = new Map<string, string>();
  const drawingRels = text(drawingPart.replace(/([^/]+)$/, "_rels/$1.rels"));
  if (drawingRels) {
    for (const m of drawingRels.matchAll(/<Relationship(?:\s[^>]*)?>/g)) {
      chartTargets.set(attr(m[0], "Id"), resolve(drawingPart, attr(m[0], "Target")));
    }
  }

  const out: WireChart[] = [];
  // 锚点在 `twoCellAnchor` 上，`graphicFrame` 只是它里面的孩子。
  for (const m of drawingXml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g)) {
    if (out.length >= MAX_CHARTS) break;
    const block = m[2] ?? "";
    if (!/<xdr:graphicFrame\b/.test(block)) continue;
    const rid = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(block)?.[1];
    const part = rid ? chartTargets.get(rid) : null;
    const xml = part ? text(part) : null;
    if (!part || !xml) continue;
    const chart = readChart(xml, values);
    if (!chart) continue;
    const from = anchorOf(block, "from");
    if (!from) continue;
    const to = anchorOf(block, "to");
    out.push({
      ...chart,
      id: part,
      c0: from.c,
      r0: from.r,
      ox: Math.round(from.ox),
      oy: Math.round(from.oy),
      ...(to ? { c1: to.c, r1: to.r, ox1: Math.round(to.ox), oy1: Math.round(to.oy) } : {}),
    });
  }
  return out;
}

function resolve(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/");
  parts.pop();
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function readChart(xml: string, values: RangeValues): Omit<WireChart, "id" | "c0" | "r0" | "ox" | "oy"> | null {
  const kinds: [string, WireChart["kind"]][] = [
    ["barChart", "bar"],
    ["lineChart", "line"],
    ["pieChart", "pie"],
    ["areaChart", "area"],
    ["scatterChart", "scatter"],
  ];
  const hit = kinds.find(([tag]) => new RegExp(`<(?:\\w+:)?${tag}\\b`).test(xml));
  if (!hit) return null;
  const chartBody = first(xml, hit[0]) ?? "";
  const title = first(xml, "title");
  const horizontal = hit[1] === "bar" && /<(?:c:)?barDir\b[^>]*val="bar"/.test(chartBody) ? 1 : undefined;

  const series: WireSeries[] = [];
  for (const ser of chartBody.matchAll(/<(?:c:)?ser\b[^>]*>([\s\S]*?)<\/(?:c:)?ser>/g)) {
    const body = ser[1] ?? "";
    const tx = first(body, "tx") ?? "";
    const name = textOf(tx) || (/<c:v>([^<]*)<\/c:v>/.exec(tx)?.[1] ?? "");
    const valBlock = /<(?:c:)?val>([\s\S]*)<\/(?:c:)?val>/.exec(body)?.[1] ?? "";
    const valRef = /<(?:c:)?f>([^<]*)<\/(?:c:)?f>/.exec(valBlock)?.[1] ?? "";
    const live = valRef && rangeRef(valRef) ? values(valRef) : null;
    const num = live && live.length ? numbers(live) : (cacheOf(valBlock, "num") as (number | null)[]);
    if (!num.length) continue;
    series.push({ name, values: num });
  }
  if (!series.length) return null;

  const firstSer = /<(?:c:)?ser\b[^>]*>([\s\S]*?)<\/(?:c:)?ser>/.exec(chartBody)?.[1] ?? "";
  const catBlock = /<(?:c:)?cat>([\s\S]*)<\/(?:c:)?cat>/.exec(firstSer)?.[1] ?? "";
  const catRef = /<(?:c:)?f>([^<]*)<\/(?:c:)?f>/.exec(catBlock)?.[1] ?? "";
  const grid = catRef && rangeRef(catRef) ? values(catRef) : null;
  let cats: string[] = [];
  if (grid && grid.length) cats = grid.map((row) => (row[0] === null || row[0] === undefined ? "" : String(row[0])));
  else cats = cacheOf(catBlock, "str").map((v) => (v === null ? "" : String(v)));
  if (!cats.length) cats = series[0]!.values.map((_, i) => String(i + 1));

  return {
    kind: hit[1],
    ...(horizontal ? { horizontal } : {}),
    ...(title && textOf(title) ? { title: textOf(title) } : {}),
    cats,
    series,
  };
}
