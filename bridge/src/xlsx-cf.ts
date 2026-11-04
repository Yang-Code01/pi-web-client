import { resolveColor, type Palette } from "./xlsx-read.ts";
import type { WireStyle } from "./sheet-types.ts";

/**
 * 条件格式在桥端算（D116）。
 *
 * 规则引擎不搬到前端：前端只拿「这一格最后长什么样」。搬前端的代价是每个窗口都要重算规则、
 * 也要把规则表发过去；搬桥端只需要发结果。
 *
 * 覆盖（刻意收窄的「全保真」）：色阶 / 数据条 / 图标集 / cellIs / 表达式里的常见几种 / top10 /
 * 重复值 / 唯一值。认不出来的表达式**直接跳过**，不猜 —— 宁可少画一层底色，也不要画一张假表。
 */

type CfvoType = "min" | "max" | "num" | "percent" | "percentile" | "formula";

interface Cfvo {
  type: CfvoType;
  value?: number;
}

export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface Rule {
  ranges: Range[];
  type: string;
  operator?: string;
  formulae: string[];
  text?: string;
  style?: WireStyle;
  cfvo: Cfvo[];
  colors: string[];
  iconSet?: string;
  reverse?: boolean;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  /** 解析失败的表达式，直接不用。 */
  dead?: boolean;
}

export interface CfHit {
  style?: WireStyle;
  bar?: number;
  icon?: string;
}

function parseRef(ref: string, maxRow: number, maxCol: number): Range[] {
  const out: Range[] = [];
  for (const part of ref.trim().split(/\s+/)) {
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(part);
    if (!m) continue;
    const c1 = colIdx(m[1]);
    const c2 = m[3] ? colIdx(m[3]) : c1;
    const r1 = m[2] ? Number(m[2]) - 1 : 0;
    const r2 = m[4] ? Number(m[4]) - 1 : m[2] ? Number(m[2]) - 1 : maxRow;
    out.push({ r1, c1, r2: Math.min(r2, maxRow), c2: Math.min(c2, maxCol) });
  }
  return out;
}

export function colIdx(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** exceljs 的 `ws.conditionalFormattings` → 我们自己的规则表（颜色已经解成 #RRGGBB）。 */
export function readRules(list: any[], pal: Palette, maxRow: number, maxCol: number): Rule[] {
  const out: Rule[] = [];
  for (const entry of list ?? []) {
    const ref = String(entry?.ref ?? entry?.refs ?? "");
    const ranges = parseRef(ref, maxRow, maxCol);
    if (!ranges.length) continue;
    for (const raw of entry?.rules ?? []) {
      const cfvo: Cfvo[] = (raw.cfvo ?? []).map((v: any) => ({ type: String(v.type ?? "num") as CfvoType, value: typeof v.value === "number" ? v.value : Number(v.value) }));
      const colors: string[] = [];
      const push = (c: any) => {
        const hex = resolveColor(c, pal);
        if (hex) colors.push(hex);
      };
      if (Array.isArray(raw.color)) raw.color.forEach(push);
      else if (raw.color) push(raw.color);
      const rule: Rule = {
        ranges,
        type: String(raw.type ?? ""),
        operator: raw.operator ? String(raw.operator) : undefined,
        formulae: Array.isArray(raw.formulae) ? raw.formulae.map((f: any) => String(f).replace(/^=/, "")) : [],
        text: raw.text != null ? String(raw.text) : undefined,
        style: dxf(raw.style, pal),
        cfvo,
        colors,
        iconSet: raw.iconSet ? String(raw.iconSet) : undefined,
        reverse: raw.reverse === true,
        rank: typeof raw.rank === "number" ? raw.rank : undefined,
        percent: raw.percent === true,
        bottom: raw.bottom === true,
      };
      if (rule.type === "expression" && !parseExpr(rule.formulae[0] ?? "")) rule.dead = true;
      out.push(rule);
    }
  }
  return out;
}

/** dxf（差分样式）：只有字体色 / 加粗 / 底色这几样是常用的，其余忽略。 */
function dxf(style: any, pal: Palette): WireStyle | undefined {
  if (!style) return undefined;
  const out: WireStyle = {};
  const color = resolveColor(style.font?.color, pal);
  if (color) out.color = color;
  if (style.font?.bold) out.bold = true;
  if (style.font?.italic) out.italic = true;
  // dxf 的底色是 bgColor（不是 fgColor）—— 这是 OOXML 里著名的反直觉处。
  const fill = resolveColor(style.fill?.bgColor, pal) ?? resolveColor(style.fill?.fgColor, pal);
  if (fill) out.fill = fill;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- 值

interface Sheet {
  getCell(r: number, c: number): { value: any };
  rowCount: number;
  columnCount: number;
}

/** 参与比较的那个数；不是数就 null。日期按 Excel 的序列号算，跟 Excel 比较规则一致。 */
function numOf(value: any): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime() / 86400000 + 25569;
  if (value && typeof value === "object" && "result" in value) return numOf((value as any).result);
  return null;
}

function textOf(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if ("result" in value) return textOf((value as any).result);
    if ("text" in value) return String((value as any).text);
    if ("richText" in value) return (value as any).richText.map((p: any) => p.text ?? "").join("");
  }
  return "";
}

// ---------------------------------------------------------------- 表达式

type Expr = (r: number, c: number) => number | string | boolean | null;

/** 只认这几种写法；其余返回 null（= 这条规则不生效，不猜）。 */
function parseExpr(src: string): Expr | null {
  const f = src.trim().replace(/^=/, "");
  if (!f) return null;
  const upper = f.toUpperCase();

  // 重复值 / 唯一值：COUNTIF($A:$A,A1)>1 之类。
  let m = /^COUNTIF\((.+?),(.+?)\)\s*(>=|<=|<>|>|<|=)\s*(\d+)$/i.exec(upper);
  if (m) {
    const rangeRef = m[1];
    const op = m[3];
    const n = Number(m[4]);
    return (r, c) => {
      const target = textOf(cellValue(r, c));
      let hits = 0;
      for (const value of iterRange(rangeRef, r, c)) if (textOf(value) === target) hits++;
      return compare(hits, op, n);
    };
  }

  // ISBLANK(A1) / ISERROR(A1)
  m = /^(ISBLANK|ISERROR)\((.+)\)$/i.exec(upper);
  if (m) {
    const kind = m[1];
    const ref = parseRefExpr(m[2]);
    if (!ref) return null;
    return (r, c) => {
      const v = cellValue(ref(r, c).r, ref(r, c).c);
      if (kind === "ISBLANK") return v == null || v === "";
      return v && typeof v === "object" && "error" in v ? true : false;
    };
  }

  // 直接比较：A1>100 / $B2<>"x"
  m = /^(?:AND|OR)?\(*\s*(\$?[A-Z]{1,3}\$?\d+)\s*(>=|<=|<>|>|<|=)\s*("(?:[^"]*)"|-?\d+(?:\.\d+)?)\s*\)*$/i.exec(f);
  if (m) {
    const ref = refOf(m[1]);
    const op = m[2];
    const rhsRaw = m[3];
    const rhs = rhsRaw.startsWith('"') ? rhsRaw.slice(1, -1) : Number(rhsRaw);
    return (r, c) => {
      const v = cellValue(ref(r, c).r, ref(r, c).c);
      const left = typeof rhs === "number" ? numOf(v) : textOf(v);
      if (left == null) return false;
      return compare(left as number, op, rhs as number);
    };
  }

  // LEN(A1)>3
  m = /^LEN\((\$?[A-Z]{1,3}\$?\d+)\)\s*(>=|<=|<>|>|<|=)\s*(\d+)$/i.exec(f);
  if (m) {
    const ref = refOf(m[1]);
    const op = m[2];
    const n = Number(m[3]);
    return (r, c) => compare(textOf(cellValue(ref(r, c).r, ref(r, c).c)).length, op, n);
  }

  return null;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    default:
      return false;
  }
}

/** `$A$1` → (r,c) => 固定的那一格；`A1` → 相对当前格平移。 */
function refOf(token: string): (r: number, c: number) => { r: number; c: number } {
  const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/i.exec(token);
  if (!m) return (r, c) => ({ r, c });
  const absCol = m[1] === "$";
  const col = colIdx(m[2].toUpperCase());
  const absRow = m[3] === "$";
  const row = Number(m[4]) - 1;
  return (r, c) => ({ r: absRow ? row : r + row - 0, c: absCol ? col : c + col });
}

function parseRefExpr(src: string): ((r: number, c: number) => { r: number; c: number }) | null {
  const m = /^(\$?[A-Z]{1,3}\$?\d+)$/i.exec(src.trim());
  return m ? refOf(m[1]) : null;
}

/**
 * 表达式里读单元格：要做到「和 Excel 一样按当前格相对引用」，只能现场从 sheet 读。
 * 这里的 `cellValue` 由调用方用闭包注入（见 `evaluate`）。
 */
let cellValue: (r: number, c: number) => any = () => null;
let iterRange: (ref: string, r: number, c: number) => any[] = () => [];

// ---------------------------------------------------------------- 求值

function cfvoValue(v: Cfvo, stats: Stats): number {
  switch (v.type) {
    case "min":
      return stats.min;
    case "max":
      return stats.max;
    case "percent":
      return stats.min + ((stats.max - stats.min) * (v.value ?? 0)) / 100;
    case "percentile":
      return stats.percentile(v.value ?? 0);
    default:
      return Number.isFinite(v.value) ? (v.value as number) : stats.min;
  }
}

interface Stats {
  min: number;
  max: number;
  values: number[];
  percentile(p: number): number;
}

function statsOf(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    values: sorted,
    percentile(p) {
      if (!sorted.length) return 0;
      const idx = Math.max(0, Math.min(1, p / 100)) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    },
  };
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const out = [16, 8, 0].map((shift) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${out.join("")}`.toUpperCase();
}

export interface CfEval {
  /** 当前窗口的命中表，key 是 `r:c`。 */
  hits: Map<string, CfHit>;
}

/**
 * 把一个 sheet 的所有条件格式规则对窗口求值。`read` 是读某格原始值的回调。
 * 每条规则扫一次范围算统计（并缓存），之后窗口内逐格判断。
 */
export function evaluate(sheet: Sheet, rules: Rule[], win: { r0: number; r1: number; c0: number; c1: number }, read: (r: number, c: number) => any): Map<string, CfHit> {
  cellValue = read;
  iterRange = (ref) => {
    const m = /^\$?([A-Z]{1,3})\$?(\d+)?:\$?([A-Z]{1,3})\$?(\d+)?$/i.exec(ref.trim());
    if (!m) return [];
    const c1 = colIdx(m[1].toUpperCase());
    const c2 = colIdx(m[3].toUpperCase());
    const r1 = m[2] ? Number(m[2]) - 1 : 0;
    const r2 = m[4] ? Number(m[4]) - 1 : Math.min(sheet.rowCount, 200000) - 1;
    const out: any[] = [];
    const budget = { left: 200000 };
    for (let row = r1; row <= r2 && budget.left > 0; row++) {
      for (let col = c1; col <= c2 && budget.left > 0; col++, budget.left--) out.push(read(row, col));
    }
    return out;
  };

  const hits = new Map<string, CfHit>();
  for (const rule of rules) {
    if (rule.dead) continue;
    const inWin = rule.ranges.some((r) => r.r1 <= win.r1 && win.r0 <= r.r2 && r.c1 <= win.c1 && win.c0 <= r.c2);
    const stats = needsStats(rule) ? statsFor(sheet, rule, read) : null;
    if (!inWin && !stats) continue;
    for (const range of rule.ranges) {
      const r0 = Math.max(range.r1, win.r0);
      const r1 = Math.min(range.r2, win.r1);
      const c0 = Math.max(range.c1, win.c0);
      const c1 = Math.min(range.c2, win.c1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const hit = hitOf(rule, r, c, stats, read);
          if (!hit) continue;
          const key = `${r}:${c}`;
          const prev = hits.get(key) ?? {};
          // 先到的规则优先级更高（OOXML 里 priority 越小越先，exceljs 已按顺序给出）。
          hits.set(key, { ...hit, ...prev });
        }
      }
    }
  }
  return hits;
}

function needsStats(rule: Rule): boolean {
  return rule.type === "colorScale" || rule.type === "dataBar" || rule.type === "iconSet" || rule.type === "top10";
}

const statsCache = new WeakMap<Rule, WeakMap<object, Stats>>();

function statsFor(sheet: Sheet, rule: Rule, read: (r: number, c: number) => any): Stats {
  let bySheet = statsCache.get(rule);
  if (!bySheet) {
    bySheet = new WeakMap();
    statsCache.set(rule, bySheet);
  }
  const key = sheet as unknown as object;
  const cached = bySheet.get(key);
  if (cached) return cached;
  const values: number[] = [];
  for (const range of rule.ranges) {
    const rEnd = Math.min(range.r2, Math.max(0, sheet.rowCount - 1));
    const cEnd = Math.min(range.c2, Math.max(0, sheet.columnCount - 1));
    // 超大范围（整列引用）只取前 20 万格算统计，够用且不至于卡死。
    let budget = 200000;
    for (let r = range.r1; r <= rEnd && budget > 0; r++) {
      for (let c = range.c1; c <= cEnd && budget > 0; c++, budget--) {
        const n = numOf(read(r, c));
        if (n != null) values.push(n);
      }
    }
  }
  const stats = statsOf(values);
  bySheet.set(key, stats);
  return stats;
}

function hitOf(rule: Rule, r: number, c: number, stats: Stats | null, read: (r: number, c: number) => any): CfHit | null {
  const value = read(r, c);
  const n = numOf(value);
  switch (rule.type) {
    case "colorScale": {
      if (!stats || n == null || rule.colors.length < 2) return null;
      const points = rule.cfvo.length ? rule.cfvo : [{ type: "min" as CfvoType }, { type: "max" as CfvoType }];
      const stops = points.map((v, i) => ({ at: cfvoValue(v, stats), color: rule.colors[Math.min(i, rule.colors.length - 1)] }));
      if (stops.length === 2) stops.splice(1, 0, { at: (stops[0].at + stops[1].at) / 2, color: mix(stops[0].color, stops[1].color, 0.5) });
      const lo = stops[0];
      const hi = stops[stops.length - 1];
      const span = hi.at - lo.at || 1;
      const t = Math.max(0, Math.min(1, (n - lo.at) / span));
      let color = stops[0].color;
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        if (n >= a.at && n <= b.at) {
          color = mix(a.color, b.color, b.at - a.at ? (n - a.at) / (b.at - a.at) : 0);
          break;
        }
        if (n > b.at) color = b.color;
      }
      void t;
      const dark = parseInt(color.slice(1), 16);
      const lum = ((dark >> 16) & 255) * 0.3 + ((dark >> 8) & 255) * 0.59 + (dark & 255) * 0.11;
      return { style: { fill: color, color: lum > 150 ? "#000000" : "#FFFFFF" } };
    }
    case "dataBar": {
      if (!stats || n == null) return null;
      const lo = cfvoValue(rule.cfvo[0] ?? { type: "min" }, stats);
      const hi = cfvoValue(rule.cfvo[1] ?? { type: "max" }, stats);
      const pct = hi - lo ? Math.max(0, Math.min(1, (n - lo) / (hi - lo))) : 0;
      return { bar: pct, style: { fill: `linear-gradient(90deg, ${rule.colors[0] ?? "#638EC6"} ${(pct * 100).toFixed(1)}%, transparent ${(pct * 100).toFixed(1)}%)` } };
    }
    case "iconSet": {
      if (!stats || n == null) return null;
      const set = rule.iconSet ?? "3TrafficLights1";
      const glyphs = iconGlyphs(set);
      const n3 = glyphs.length;
      const points = rule.cfvo.length >= n3 ? rule.cfvo : [{ type: "percent" as CfvoType, value: 0 }, { type: "percent" as CfvoType, value: 33 }, { type: "percent" as CfvoType, value: 67 }];
      let idx = 0;
      for (let i = 0; i < n3; i++) if (n >= cfvoValue(points[i], stats)) idx = i;
      if (rule.reverse) idx = n3 - 1 - idx;
      return { icon: glyphs[idx] };
    }
    case "cellIs": {
      if (!rule.style) return null;
      const raw = (rule.formulae[0] ?? "").trim();
      const literal = /^"(.*)"$/.exec(raw);
      // 文本比较（`D4="堀田"`）走字符串，数字比较走数值 —— Excel 自己也是这么分的。
      if (literal) {
        const op = operatorOf(rule.operator);
        const hay = textOf(value);
        const hit = op === "=" ? hay === literal[1] : op === "<>" ? hay !== literal[1] : op === ">" ? hay > literal[1] : op === "<" ? hay < literal[1] : false;
        return hit ? { style: rule.style } : null;
      }
      const rhs = Number(raw);
      if (!Number.isFinite(rhs) || n == null) return null;
      const hit = compare(n, operatorOf(rule.operator), rhs);
      return hit ? { style: rule.style } : null;
    }
    case "expression": {
      if (!rule.style) return null;
      const expr = parseExpr(rule.formulae[0] ?? "");
      if (!expr) return null;
      return expr(r, c) ? { style: rule.style } : null;
    }
    case "containsText": {
      if (!rule.style) return null;
      const hay = textOf(value).toLowerCase();
      const needle = (rule.text ?? rule.formulae[0] ?? "").replace(/^"(.*)"$/, "$1").toLowerCase();
      if (!needle) return null;
      const hit = rule.operator === "notContains" ? !hay.includes(needle) : rule.operator === "beginsWith" ? hay.startsWith(needle) : rule.operator === "endsWith" ? hay.endsWith(needle) : hay.includes(needle);
      return hit ? { style: rule.style } : null;
    }
    case "top10": {
      if (!stats || n == null || !rule.rank) return null;
      const sorted = rule.bottom ? stats.values : [...stats.values].reverse();
      const cut = rule.percent ? Math.max(1, Math.round((rule.rank / 100) * sorted.length)) : rule.rank;
      const threshold = sorted[Math.min(cut, sorted.length) - 1];
      if (threshold == null) return null;
      const hit = rule.bottom ? n <= threshold : n >= threshold;
      return hit && rule.style ? { style: rule.style } : null;
    }
    case "duplicateValues":
    case "uniqueValues": {
      if (!rule.style) return null;
      const target = textOf(value);
      if (!target) return null;
      let count = 0;
      for (const range of rule.ranges) {
        const rEnd = Math.min(range.r2, sheetRows() - 1);
        const cEnd = Math.min(range.c2, sheetCols() - 1);
        for (let rr = range.r1; rr <= rEnd && count < 2; rr++) {
          for (let cc = range.c1; cc <= cEnd && count < 2; cc++) if (textOf(read(rr, cc)) === target) count++;
        }
      }
      const dup = count > 1;
      return (rule.type === "duplicateValues") === dup ? { style: rule.style } : null;
    }
    default:
      return null;
  }
}

let sheetRows = () => 0;
let sheetCols = () => 0;

function operatorOf(op?: string): string {
  switch (op) {
    case "greaterThan":
      return ">";
    case "greaterThanOrEqual":
      return ">=";
    case "lessThan":
      return "<";
    case "lessThanOrEqual":
      return "<=";
    case "equal":
      return "=";
    case "notEqual":
      return "<>";
    default:
      return "=";
  }
}

function iconGlyphs(set: string): string[] {
  const name = set.toLowerCase();
  if (name.includes("trafficlight")) return ["🔴", "🟡", "🟢"];
  if (name.includes("arrow")) return ["▼", "▶", "▲"];
  if (name.includes("flag")) return ["⚑", "⚐", "⚐"];
  if (name.includes("star")) return ["★", "☆", "☆"];
  if (name.includes("rating")) return ["⯀", "⯀", "⯀"];
  if (name.includes("quarter")) return ["◕", "◑", "◔"];
  return ["✖", "❗", "✔"];
}

/** 让 evaluate 知道 sheet 的边界（重复值那条规则要扫范围）。 */
export function bindSheetSize(sheet: Sheet): void {
  sheetRows = () => sheet.rowCount;
  sheetCols = () => sheet.columnCount;
}
