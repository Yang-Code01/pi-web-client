/**
 * 条件格式（#109）：色阶 / 数据条 / 图标集 / 单元格值规则 / 公式规则。
 *
 * 五类都在桥端求值：读表 XML 里的 <conditionalFormatting> 与 styles 里的 <dxfs>，
 * 把「这个格子该用什么底色 / 字色 / 加粗 / 数据条 / 图标」算成 WireCell.fx，
 * 前端只贴样式、不再理解规则。
 *
 * 认不出的规则（containsText、top10、aboveAverage…）不涂色，只由
 * SheetInfo.cfUnsupported 计数，状态条据此提示「N 条条件格式暂不支持」。
 *
 * 统计量（色阶的 min/max/percentile、数据条的 min/max）在每张表第一次取窗口时
 * 算一次，挂在 Book 上随文件版本缓存；流式与增量留给 #110。
 */

export interface CellFx {
  /** 底色，CSS 颜色。 */
  bg?: string;
  /** 字色。 */
  fg?: string;
  /** 加粗（1 表示要）。 */
  b?: 1;
  /** 数据条：[占格宽的比例 0..1, 颜色]。 */
  bar?: [number, string];
  /** 图标：[图标集名, 字形, 颜色, 等级]。 */
  icon?: { s: string; g: string; c: string; l: number };
}

export interface SheetCf {
  unsupported: number;
  at: (r: number, c: number) => CellFx | undefined;
}

interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

interface Dxf {
  bg?: string;
  fg?: string;
  bold?: boolean;
}

interface Cfvo {
  t: string;
  v: number;
}

interface Rule {
  idx: number;
  priority: number;
  stop: boolean;
  rects: Rect[];
  kind: "scale" | "bar" | "icon" | "cell" | "expr";
  /** 色阶：已解析的停靠点，按值升序。 */
  stops?: { v: number; rgb: string }[];
  /** 数据条：范围与颜色。 */
  bar?: { min: number; max: number; rgb: string };
  /** 图标集：阈值（等级 0..n-1）、反向、gte。 */
  icon?: { set: string; steps: number[]; reverse: boolean; gte: boolean };
  /** 单元格值规则。 */
  op?: string;
  atoms?: Node[];
  /** 公式规则。 */
  ast?: Node;
  dxf?: Dxf;
  /** 公式规则 / 单元格值规则相对 sqref 左上角的锚点。 */
  anchor?: { r: number; c: number };
}

type Value = number | string | boolean | null;

import { attr, colIndex, refOf, texts, unescapeXml } from "./xml.ts";

/** `A1:B2 C3` → 闭区间列表。 */
function rectsOf(sqref: string): Rect[] {
  const out: Rect[] = [];
  for (const part of sqref.trim().split(/\s+/)) {
    if (!part) continue;
    const [a, b] = part.split(":");
    const first = refOf(a ?? "");
    const last = refOf(b ?? a ?? "");
    if (!first || !last) continue;
    out.push({
      r0: Math.min(first.r, last.r),
      r1: Math.max(first.r, last.r),
      c0: Math.min(first.c, last.c),
      c1: Math.max(first.c, last.c),
    });
  }
  return out;
}

function inRect(q: Rect, r: number, c: number): boolean {
  return r >= q.r0 && r <= q.r1 && c >= q.c0 && c <= q.c1;
}

/** `rgb="FFRRGGBB"` / `rgb="RRGGBB"` → `#RRGGBB`；theme/indexed 认不出就交给默认色。 */
function colorOf(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const rgb = attr(tag, "rgb");
  if (!rgb || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(rgb)) return null;
  return `#${(rgb.length === 8 ? rgb.slice(2) : rgb).toUpperCase()}`;
}

function cfvosOf(block: string): Cfvo[] {
  const out: Cfvo[] = [];
  for (const m of block.matchAll(/<cfvo\b([^>]*?)\/?>/g)) {
    const t = attr(m[1] ?? "", "type") ?? "num";
    const v = Number(attr(m[1] ?? "", "val") ?? "0");
    out.push({ t, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

/** styles.xml 的 `<dxfs>`：单元格值 / 公式规则要用的字色、加粗、底色。 */
export function readDxfs(stylesXml: string | null): Dxf[] {
  if (!stylesXml) return [];
  const block = /<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(stylesXml)?.[1] ?? "";
  const out: Dxf[] = [];
  for (const m of block.matchAll(/<dxf\b[^>]*>([\s\S]*?)<\/dxf>/g)) {
    const inner = m[1] ?? "";
    const font = /<font\b[^>]*>([\s\S]*?)<\/font>/.exec(inner)?.[1] ?? "";
    const fill = /<fill\b[^>]*>([\s\S]*?)<\/fill>/.exec(inner)?.[1] ?? "";
    const fg = colorOf(/<color\b[^>]*\/>/.exec(font)?.[0]);
    const boldTag = /<b\b[^>]*\/>/.exec(font)?.[0] ?? "";
    const bold = !!boldTag && !/val\s*=\s*["'](0|false)["']/i.test(boldTag);
    const bg = colorOf(/<bgColor\b[^>]*\/>/.exec(fill)?.[0]) ?? colorOf(/<fgColor\b[^>]*\/>/.exec(fill)?.[0]);
    out.push({ ...(bg ? { bg } : {}), ...(fg ? { fg } : {}), ...(bold ? { bold: true } : {}) });
  }
  return out;
}

/** 状态条上的「N 条暂不支持」：只数认不出的规则类型。 */
export function countCfUnsupported(xml: string): number {
  let n = 0;
  for (const m of xml.matchAll(/<cfRule\b([^>]*?)\/?>/g)) {
    const type = attr(m[1] ?? "", "type") ?? "";
    if (!["colorScale", "dataBar", "iconSet", "cellIs", "expression"].includes(type)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- 小公式求值器

class ParseError extends Error {}

type Node =
  | { t: "n"; v: number }
  | { t: "s"; v: string }
  | { t: "ref"; r: number; c: number; ar: boolean; ac: boolean }
  | { t: "f"; name: string; args: Node[] }
  | { t: "b"; op: string; a: Node; b: Node }
  | { t: "u"; op: string; a: Node };

interface Token {
  t: "num" | "str" | "id" | "ref" | "op";
  v: string;
}

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = "";
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else s += src[i++];
      }
      if (!closed) throw new ParseError("unterminated string");
      out.push({ t: "str", v: s });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ParseError("bad number");
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "$" || /[A-Za-z_]/.test(ch)) {
      const ref = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(src.slice(i));
      if (ref) {
        out.push({ t: "ref", v: ref[0] });
        i += ref[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (!id) throw new ParseError("bad token");
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new ParseError(`unexpected ${ch}`);
  }
  return out;
}

/** 解析一条 CF 公式（`MOD(ROW(),2)=0`、`$A2>10`…）；认不出就抛 ParseError。 */
export function parseFormula(src: string): Node {
  const ts = lex(src);
  let i = 0;
  const at = (v: string) => ts[i]?.t === "op" && ts[i].v === v;

  function comparisons(): Node {
    let a = concat();
    while (ts[i]?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(ts[i].v)) {
      const op = ts[i].v;
      i++;
      a = { t: "b", op, a, b: concat() };
    }
    return a;
  }
  function concat(): Node {
    let a = add();
    while (at("&")) {
      i++;
      a = { t: "b", op: "&", a, b: add() };
    }
    return a;
  }
  function add(): Node {
    let a = mul();
    while (ts[i]?.t === "op" && (ts[i].v === "+" || ts[i].v === "-")) {
      const op = ts[i].v;
      i++;
      a = { t: "b", op, a, b: mul() };
    }
    return a;
  }
  function mul(): Node {
    let a = power();
    while (ts[i]?.t === "op" && (ts[i].v === "*" || ts[i].v === "/")) {
      const op = ts[i].v;
      i++;
      a = { t: "b", op, a, b: power() };
    }
    return a;
  }
  function power(): Node {
    const a = unary();
    if (at("^")) {
      i++;
      return { t: "b", op: "^", a, b: power() };
    }
    return a;
  }
  function unary(): Node {
    if (ts[i]?.t === "op" && (ts[i].v === "-" || ts[i].v === "+")) {
      const op = ts[i].v;
      i++;
      return { t: "u", op, a: unary() };
    }
    return primary();
  }
  function primary(): Node {
    const t = ts[i];
    if (!t) throw new ParseError("eof");
    if (t.t === "num") {
      i++;
      return { t: "n", v: Number(t.v) };
    }
    if (t.t === "str") {
      i++;
      return { t: "s", v: t.v };
    }
    if (t.t === "ref") {
      i++;
      const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(t.v);
      if (!m) throw new ParseError("bad ref");
      return { t: "ref", r: Number(m[4]) - 1, c: colIndex(m[2]), ar: m[1] === "$", ac: m[3] === "$" };
    }
    if (t.t === "id") {
      i++;
      if (at("(")) {
        i++;
        const args: Node[] = [];
        if (!at(")")) {
          for (;;) {
            args.push(comparisons());
            if (at(",")) {
              i++;
              continue;
            }
            break;
          }
        }
        if (!at(")")) throw new ParseError("missing )");
        i++;
        return { t: "f", name: t.v.toUpperCase(), args };
      }
      const up = t.v.toUpperCase();
      if (up === "TRUE") return { t: "n", v: 1 };
      if (up === "FALSE") return { t: "n", v: 0 };
      throw new ParseError(`bad name ${t.v}`);
    }
    if (at("(")) {
      i++;
      const inner = comparisons();
      if (!at(")")) throw new ParseError("missing )");
      i++;
      return inner;
    }
    throw new ParseError("bad primary");
  }

  const node = comparisons();
  if (i !== ts.length) throw new ParseError("trailing tokens");
  return node;
}

interface Ctx {
  row: number;
  col: number;
  dr: number;
  dc: number;
  get: (r: number, c: number) => Value;
}

function toNum(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : 0;
}

function toText(v: Value): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function truthy(v: Value): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "";
}

/** Excel 的比较：数字/布尔按数字，字符串不分大小写。 */
function cmp(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (typeof a === "number" || typeof b === "number" || typeof a === "boolean" || typeof b === "boolean") {
    const x = toNum(a);
    const y = toNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toText(a).toLowerCase();
  const y = toText(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function evalNode(n: Node, ctx: Ctx): Value {
  switch (n.t) {
    case "n":
      return n.v;
    case "s":
      return n.v;
    case "ref": {
      const r = n.ar ? n.r : n.r + ctx.dr;
      const c = n.ac ? n.c : n.c + ctx.dc;
      return ctx.get(r, c);
    }
    case "u": {
      const v = evalNode(n.a, ctx);
      return n.op === "-" ? -toNum(v) : toNum(v);
    }
    case "b": {
      if (n.op === "&") return toText(evalNode(n.a, ctx)) + toText(evalNode(n.b, ctx));
      const a = evalNode(n.a, ctx);
      const b = evalNode(n.b, ctx);
      if (n.op === "=") return cmp(a, b) === 0;
      if (n.op === "<>") return cmp(a, b) !== 0;
      if (n.op === "<") return cmp(a, b) < 0;
      if (n.op === ">") return cmp(a, b) > 0;
      if (n.op === "<=") return cmp(a, b) <= 0;
      if (n.op === ">=") return cmp(a, b) >= 0;
      if (n.op === "+") return toNum(a) + toNum(b);
      if (n.op === "-") return toNum(a) - toNum(b);
      if (n.op === "*") return toNum(a) * toNum(b);
      if (n.op === "/") return toNum(b) === 0 ? null : toNum(a) / toNum(b);
      if (n.op === "^") return Math.pow(toNum(a), toNum(b));
      throw new ParseError(`bad op ${n.op}`);
    }
    case "f":
      return callFn(n, ctx);
  }
}

function callFn(n: Extract<Node, { t: "f" }>, ctx: Ctx): Value {
  const arg = (i: number): Value => {
    const node = n.args[i];
    return node ? evalNode(node, ctx) : null;
  };
  switch (n.name) {
    case "IF":
      return truthy(arg(0)) ? arg(1) : n.args.length > 2 ? arg(2) : false;
    case "AND":
      return n.args.every((_, i) => truthy(arg(i)));
    case "OR":
      return n.args.some((_, i) => truthy(arg(i)));
    case "NOT":
      return !truthy(arg(0));
    case "MOD": {
      const b = toNum(arg(1));
      const a = toNum(arg(0));
      return b === 0 ? null : a - b * Math.floor(a / b);
    }
    case "ROW":
      return ctx.row + 1;
    case "COLUMN":
      return ctx.col + 1;
    case "ABS":
      return Math.abs(toNum(arg(0)));
    case "INT":
      return Math.floor(toNum(arg(0)));
    case "ROUND": {
      const digits = n.args.length > 1 ? toNum(arg(1)) : 0;
      const p = Math.pow(10, digits);
      return Math.round(toNum(arg(0)) * p) / p;
    }
    case "LEN":
      return toText(arg(0)).length;
    case "ISBLANK": {
      const v = arg(0);
      return v === null || v === "";
    }
    case "ISNUMBER":
      return typeof arg(0) === "number";
    case "ISTEXT":
      return typeof arg(0) === "string";
    default:
      throw new ParseError(`unknown function ${n.name}`);
  }
}

// ---------------------------------------------------------------- 规则解析与求值

function resolveCfvo(c: Cfvo, nums: number[], min: number, max: number): number {
  switch (c.t) {
    case "min":
      return min;
    case "max":
      return max;
    case "num":
      return c.v;
    case "percent":
      return min + (max - min) * (c.v / 100);
    case "percentile": {
      if (!nums.length) return min;
      const rank = (c.v / 100) * (nums.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      return nums[lo] + (nums[hi] - nums[lo]) * (rank - lo);
    }
    default:
      // formula / autoMin / autoMax：没有等价信息，退回数值本身。
      return c.v;
  }
}

function lerp(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const SCALE_2 = ["#F8696B", "#63BE7B"];
const SCALE_3 = ["#F8696B", "#FFEB84", "#63BE7B"];

interface IconStyle {
  g: string[];
  c: string[];
}

const ICONS: Record<string, IconStyle> = {
  "3Arrows": { g: ["↓", "→", "↑"], c: ["#D64545", "#D9A300", "#3F9F4A"] },
  "3ArrowsGray": { g: ["↓", "→", "↑"], c: ["#9AA3AD", "#8A939E", "#5B646E"] },
  "3TrafficLights1": { g: ["●", "●", "●"], c: ["#D64545", "#D9A300", "#3F9F4A"] },
  "3TrafficLights2": { g: ["●", "●", "●"], c: ["#3F9F4A", "#D9A300", "#D64545"] },
  "3Symbols": { g: ["✕", "!", "✓"], c: ["#D64545", "#D9A300", "#3F9F4A"] },
  "3Symbols2": { g: ["✕", "!", "✓"], c: ["#D64545", "#D9A300", "#3F9F4A"] },
  "3Flags": { g: ["⚑", "⚑", "⚑"], c: ["#D64545", "#D9A300", "#3F9F4A"] },
  "3Stars": { g: ["★", "★", "★"], c: ["#C9CED6", "#D9A300", "#B8860B"] },
  "4Arrows": { g: ["↓", "↘", "↗", "↑"], c: ["#D64545", "#D98A2B", "#D9A300", "#3F9F4A"] },
  "5Arrows": { g: ["↓", "↘", "→", "↗", "↑"], c: ["#D64545", "#D98A2B", "#D9A300", "#8FAF3F", "#3F9F4A"] },
  "4Rating": { g: ["◔", "◑", "◕", "●"], c: ["#9AA3AD", "#7F8893", "#5B646E", "#3F9F4A"] },
  "5Rating": { g: ["○", "◔", "◑", "◕", "●"], c: ["#9AA3AD", "#8A939E", "#7F8893", "#5B646E", "#3F9F4A"] },
};

const FALLBACK_ICONS: Record<number, string[]> = {
  3: ["○", "◐", "●"],
  4: ["○", "◔", "◑", "●"],
  5: ["○", "◔", "◐", "◕", "●"],
};

function iconAt(set: string, level: number): IconStyle | null {
  const style = ICONS[set];
  if (style && level >= 0 && level < style.g.length) return style;
  const glyphs = FALLBACK_ICONS[level >= 0 ? Math.max(3, Math.min(5, level + 1)) : 3];
  return glyphs ? { g: glyphs, c: glyphs.map((_, i) => `rgba(70, 78, 90, ${0.45 + (0.35 * i) / Math.max(1, glyphs.length - 1)})`), } : null;
}

function cellValueOf(kind: string, body: string, strings: string[]): Value {
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
  if (kind === "s") {
    const text = strings[Number(v)];
    if (text === undefined) return null;
    return textToValue(text);
  }
  if (kind === "inlineStr") return textToValue(texts(body));
  if (kind === "str") return unescapeXml(v);
  if (kind === "b") return v.trim() === "1";
  if (kind === "e") return null;
  if (v.trim() === "") return null;
  return textToValue(unescapeXml(v.trim()));
}

function textToValue(text: string): Value {
  const trimmed = text.trim();
  if (trimmed === "") return text;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : text;
}

function collectValues(xml: string, strings: string[], bbox: Rect | null): Map<string, Value> {
  const out = new Map<string, Value>();
  if (!bbox) return out;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? "";
    const pos = refOf(attr(attrs, "r") ?? "");
    if (!pos || !inRect(bbox, pos.r, pos.c)) continue;
    out.set(`${pos.r}:${pos.c}`, cellValueOf(attr(attrs, "t") ?? "n", m[2] ?? "", strings));
  }
  return out;
}

/** 解析一张表的条件格式，返回按格取 fx 的入口。 */
export function buildCf(xml: string, strings: string[], dxfs: Dxf[]): SheetCf {
  const rules: Rule[] = [];
  let unsupported = 0;
  let idx = 0;
  for (const block of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const rects = rectsOf(attr(block[1] ?? "", "sqref") ?? "");
    if (!rects.length) continue;
    for (const m of (block[2] ?? "").matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
      const attrs = m[1] ?? "";
      const body = m[2] ?? "";
      const type = attr(attrs, "type") ?? "";
      const priority = Number(attr(attrs, "priority") ?? "0") || Number.MAX_SAFE_INTEGER;
      const stop = /^(1|true)$/i.test(attr(attrs, "stopIfTrue") ?? "");
      const dxfId = Number(attr(attrs, "dxfId") ?? "");
      const dxf = Number.isFinite(dxfId) ? dxfs[dxfId] : undefined;
      const anchor = { r: rects[0].r0, c: rects[0].c0 };
      const base = { idx: idx++, priority, stop, rects } as const;
      if (type === "colorScale") {
        const cfvos = cfvosOf(body);
        const colors = [...body.matchAll(/<color\b[^>]*\/>/g)].map((m) => colorOf(m[0]));
        const defaults = cfvos.length === 2 ? SCALE_2 : SCALE_3;
        const fallback = cfvos.map((_, i) => colors[i] ?? defaults[i] ?? "#FFFFFF");
        rules.push({ ...base, kind: "scale", stops: cfvos.map((_, i) => ({ v: 0, rgb: fallback[i] })) });
      } else if (type === "dataBar") {
        const cfvos = cfvosOf(body);
        const rgb = colorOf(/<dataBar\b[\s\S]*?(<color\b[^>]*\/>)/.exec(body)?.[1]) ?? "#638EC6";
        rules.push({
          ...base,
          kind: "bar",
          bar: { min: cfvos[0]?.v ?? 0, max: cfvos[1]?.v ?? 1, rgb },
        });
      } else if (type === "iconSet") {
        const tag = /<iconSet\b[^>]*>/.exec(body)?.[0] ?? "";
        const set = attr(tag, "iconSet") ?? "3TrafficLights1";
        const cfvos = cfvosOf(body);
        rules.push({
          ...base,
          kind: "icon",
          icon: {
            set,
            steps: cfvos.map((c) => c.v),
            reverse: /^(1|true)$/i.test(attr(tag, "reverse") ?? ""),
            gte: attr(tag, "gte") === null ? true : /^(1|true)$/i.test(attr(tag, "gte") ?? ""),
          },
        });
      } else if (type === "cellIs" && dxf) {
        const formulas = [...body.matchAll(/<formula\b[^>]*>([\s\S]*?)<\/formula>/g)].map((f) => unescapeXml(f[1] ?? ""));
        try {
          rules.push({
            ...base,
            kind: "cell",
            op: attr(attrs, "operator") ?? "equal",
            atoms: formulas.map((f) => parseFormula(f)),
            anchor,
            dxf,
          });
        } catch (err) {
          // 认不出的公式就当这条规则不命中，不涂色；解析器自身的意外错误照常抛。
          if (!(err instanceof ParseError)) throw err;
        }
      } else if (type === "expression" && dxf) {
        const formula = [...body.matchAll(/<formula\b[^>]*>([\s\S]*?)<\/formula>/g)].map((f) => unescapeXml(f[1] ?? ""))[0] ?? "";
        try {
          rules.push({ ...base, kind: "expr", ast: parseFormula(formula), anchor, dxf });
        } catch (err) {
          // 同上。
          if (!(err instanceof ParseError)) throw err;
        }
      } else {
        unsupported++;
      }
    }
  }

  const bbox = rules.reduce<Rect | null>((acc, rule) => {
    for (const q of rule.rects) {
      if (!acc) acc = { ...q };
      else {
        acc.r0 = Math.min(acc.r0, q.r0);
        acc.c0 = Math.min(acc.c0, q.c0);
        acc.r1 = Math.max(acc.r1, q.r1);
        acc.c1 = Math.max(acc.c1, q.c1);
      }
    }
    return acc;
  }, null);
  const values = collectValues(xml, strings, bbox);

  const numbersIn = (rects: Rect[]): number[] => {
    const out: number[] = [];
    for (const [key, v] of values) {
      if (typeof v !== "number") continue;
      const [r, c] = key.split(":").map(Number);
      if (rects.some((q) => inRect(q, r, c))) out.push(v);
    }
    out.sort((a, b) => a - b);
    return out;
  };

  // 统计量只算一次：色阶 / 数据条的 cfvo 都依赖范围里的数值。
  for (const rule of rules) {
    if (rule.kind !== "scale" && rule.kind !== "bar") continue;
    const nums = numbersIn(rule.rects);
    const min = nums.length ? nums[0] : 0;
    const max = nums.length ? nums[nums.length - 1] : 0;
    if (rule.kind === "scale") {
      const cfvos = cfvosOf(/<colorScale\b[\s\S]*?<\/colorScale>/.exec(cfText(xml, rule))?.[0] ?? "");
      const stops = (rule.stops ?? []).map((s, i) => ({ v: resolveCfvo(cfvos[i] ?? { t: "min", v: 0 }, nums, min, max), rgb: s.rgb }));
      stops.sort((a, b) => a.v - b.v);
      rule.stops = stops;
    } else if (rule.bar) {
      const barXml = /<dataBar\b[\s\S]*?<\/dataBar>/.exec(cfText(xml, rule))?.[0] ?? "";
      const cfvos = cfvosOf(barXml);
      rule.bar.min = resolveCfvo(cfvos[0] ?? { t: "min", v: 0 }, nums, min, max);
      rule.bar.max = resolveCfvo(cfvos[1] ?? { t: "max", v: 0 }, nums, min, max);
    }
  }

  const ordered = rules.slice().sort((a, b) => a.priority - b.priority || a.idx - b.idx);
  const get = (r: number, c: number): Value => values.get(`${r}:${c}`) ?? null;

  const at = (r: number, c: number): CellFx | undefined => {
    let out: CellFx | null = null;
    for (const rule of ordered) {
      if (!rule.rects.some((q) => inRect(q, r, c))) continue;
      const value = get(r, c);
      let hit = false;
      if (rule.kind === "scale" && typeof value === "number" && rule.stops?.length) {
        out = { ...(out ?? {}), bg: scaleColor(rule.stops, value) };
        hit = true;
      } else if (rule.kind === "bar" && typeof value === "number" && rule.bar) {
        const span = rule.bar.max - rule.bar.min;
        const f = span > 0 ? Math.max(0, Math.min(1, (value - rule.bar.min) / span)) : value >= rule.bar.max ? 1 : 0;
        out = { ...(out ?? {}), bar: [f, rule.bar.rgb] };
        hit = true;
      } else if (rule.kind === "icon" && typeof value === "number" && rule.icon) {
        const steps = rule.icon.steps;
        const n = Math.max(3, steps.length);
        let level = 0;
        for (let i = 1; i < steps.length; i++) {
          if (rule.icon.gte ? value >= steps[i] : value > steps[i]) level = i;
        }
        if (rule.icon.reverse) level = n - 1 - level;
        const style = iconAt(rule.icon.set, level);
        if (style) {
          const glyph = style.g[level] ?? style.g[style.g.length - 1] ?? "●";
          const color = style.c[level] ?? style.c[style.c.length - 1] ?? "#5B646E";
          out = { ...(out ?? {}), icon: { s: rule.icon.set, g: glyph, c: color, l: level } };
          hit = true;
        }
      } else if ((rule.kind === "cell" || rule.kind === "expr") && rule.dxf) {
        hit = ruleHit(rule, r, c, get);
        if (hit) {
          const dxf = rule.dxf;
          out = { ...(out ?? {}) };
          if (dxf.bg && !out.bg) out.bg = dxf.bg;
          if (dxf.fg && !out.fg) out.fg = dxf.fg;
          if (dxf.bold && !out.b) out.b = 1;
        }
      }
      if (hit && rule.stop) break;
    }
    return out ?? undefined;
  };

  return { unsupported, at };
}

/** 只为了再读一遍某条规则自己的 XML（统计量要用它自己的 cfvo）。 */
function cfText(xml: string, rule: Rule): string {
  const tag = rule.kind === "scale" ? "colorScale" : "dataBar";
  let i = 0;
  for (const m of xml.matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)) {
    if (i++ !== rule.idx) continue;
    const body = m[2] ?? "";
    return new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`).exec(body)?.[0] ?? "";
  }
  return "";
}

function scaleColor(stops: { v: number; rgb: string }[], value: number): string {
  if (stops.length === 1) return stops[0].rgb;
  if (value <= stops[0].v) return stops[0].rgb;
  const last = stops[stops.length - 1];
  if (value >= last.v) return last.rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value < a.v || value > b.v) continue;
    if (b.v === a.v) return b.rgb;
    return lerp(a.rgb, b.rgb, (value - a.v) / (b.v - a.v));
  }
  return last.rgb;
}

function ruleHit(rule: Rule, r: number, c: number, get: (r: number, c: number) => Value): boolean {
  if (!rule.anchor) return false;
  const ctx: Ctx = { row: r, col: c, dr: r - rule.anchor.r, dc: c - rule.anchor.c, get };
  try {
    if (rule.kind === "expr") return !!rule.ast && truthy(evalNode(rule.ast, ctx));
    const atoms = rule.atoms ?? [];
    if (!atoms.length) return false;
    const value = get(r, c);
    const a = evalNode(atoms[0], ctx);
    switch (rule.op) {
      case "lessThan":
        return cmp(value, a) < 0;
      case "lessThanOrEqual":
        return cmp(value, a) <= 0;
      case "greaterThan":
        return cmp(value, a) > 0;
      case "greaterThanOrEqual":
        return cmp(value, a) >= 0;
      case "equal":
        return cmp(value, a) === 0;
      case "notEqual":
        return cmp(value, a) !== 0;
      case "between": {
        if (!atoms[1]) return false;
        const b = evalNode(atoms[1], ctx);
        return cmp(value, a) >= 0 && cmp(value, b) <= 0;
      }
      case "notBetween": {
        if (!atoms[1]) return false;
        const b = evalNode(atoms[1], ctx);
        return cmp(value, a) < 0 || cmp(value, b) > 0;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
