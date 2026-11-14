/**
 * 公式求值器的函数表（D264）：在 `calc.ts` 那 51 个的基础上，按 WPS 表格自己的函数清单
 * （`Resources/office6/mui/zh_CN/config/etfunctionhelp.cfg` 里那 406 个名字）补齐常用的一批。
 *
 * 取舍和 `calc.ts` 一致：只做「标量语义」——数组公式、动态数组（FILTER / SORT / UNIQUE /
 * SEQUENCE）、外部引用、迭代计算不碰；认不出的一律回错误值 `#NAME?`，不猜。
 * 每个函数的参数个数 / 缺省值 / 错误码都照 Excel 写，因为预览里显示的就是这些字。
 */
import {
  cmp,
  criteria,
  dateSerialOf,
  dateToSerial,
  err,
  flatten,
  isErr,
  isMx,
  numbers,
  partsOf,
  scalar,
  serialToday,
  toBool,
  toNum,
  toStr,
  type CalcCtx,
  type EvalVal,
  type ErrVal,
  type Matrix,
  type Val,
} from "./value.ts";
import { formatValue } from "./numfmt.ts";

/** 第四个参数是「这次调用」的语法节点：ROW()/COLUMN() 要从参数上读坐标。 */
export type Fn = (args: EvalVal[], ctx: CalcCtx, sheet: string | null, node?: FnNode) => EvalVal;

export interface FnNode {
  k: "fn";
  name: string;
  args: unknown[];
}

/* ---------------------------------------------------------------- 小工具 */

/** 取第 i 个参数当数字；缺省值、错误值都照 Excel 的口径处理。 */
function arg(args: EvalVal[], i: number, dflt?: number): number | ErrVal {
  if (i >= args.length || args[i] === undefined) {
    return dflt === undefined ? err("#N/A") : dflt;
  }
  return toNum(args[i]!);
}

function argStr(args: EvalVal[], i: number, dflt = ""): string | ErrVal {
  if (i >= args.length || args[i] === undefined) return dflt;
  return toStr(args[i]!);
}

function argBool(args: EvalVal[], i: number, dflt: boolean): boolean | ErrVal {
  if (i >= args.length || args[i] === undefined) return dflt;
  return toBool(args[i]!);
}

/** 参数里的矩阵（区域）；标量参数按 1×1 处理。 */
function asMatrix(v: EvalVal | undefined): Matrix | null {
  if (v === undefined) return null;
  if (isMx(v)) return v;
  const s = scalar(v);
  return { k: "mx", m: [[s]] };
}

/** 把矩阵摊成一行（HLOOKUP / LOOKUP 用）。 */
function rowValues(m: Matrix, row: number): Val[] {
  return (m.m[row] ?? []).map((v) => scalar(v) as Val);
}

function colValues(m: Matrix, col: number): Val[] {
  return m.m.map((r) => scalar(r[col] ?? null) as Val);
}

/** 数字四舍五入（远离 0，Excel 的 ROUND 就是这样）。 */
function roundAway(x: number, d = 0): number {
  const p = Math.pow(10, d);
  const v = x * p;
  const r = Math.sign(v) * Math.round(Math.abs(v) + Math.abs(v) * 1e-12 + 1e-12);
  return r / p;
}

function sigma(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function mean(xs: number[]): number {
  return xs.length ? sigma(xs) / xs.length : NaN;
}

/** 样本方差（n-1）与总体方差（n）。 */
function variance(xs: number[], sample: boolean): number {
  if (xs.length < (sample ? 2 : 1)) return NaN;
  const m = mean(xs);
  const s = sigma(xs.map((x) => (x - m) * (x - m)));
  return s / (xs.length - (sample ? 1 : 0));
}

/** 把 x 插到已排序数组里的位置（PERCENTILE / QUARTILE 用）。 */
function quantile(xs: number[], p: number, inclusive: boolean): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (inclusive) {
    if (p <= 0) return s[0]!;
    if (p >= 1) return s[s.length - 1]!;
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  }
  if (p <= 0 || p >= 1) return NaN;
  const pos = (s.length + 1) * p;
  if (pos < 1 || pos > s.length) return NaN;
  const lo = Math.floor(pos) - 1;
  const hi = Math.ceil(pos) - 1;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - Math.floor(pos));
}

/** 多条件（SUMIFS / COUNTIFS …）：所有 (区域, 条件) 对都要成立。 */
function matchAll(pairs: { m: Matrix; test: (v: Val) => boolean }[], r: number, c: number): boolean {
  for (const p of pairs) {
    const v = scalar(p.m.m[r]?.[c] ?? null);
    if (isErr(v)) return false;
    if (!p.test(v)) return false;
  }
  return true;
}

function pairsOf(args: EvalVal[], from: number, date1904: boolean): { m: Matrix; test: (v: Val) => boolean }[] | ErrVal {
  const out: { m: Matrix; test: (v: Val) => boolean }[] = [];
  for (let i = from; i + 1 < args.length; i += 2) {
    const m = asMatrix(args[i]);
    if (!m) return err("#VALUE!");
    const crit = toStr(args[i + 1] ?? "");
    if (typeof crit !== "string") return crit;
    out.push({ m, test: criteria(crit, date1904) });
  }
  return out;
}

/* ---------------------------------------------------------------- 日期助手 */

function serialOf(args: EvalVal[], i: number): number | ErrVal {
  const v = args[i];
  if (v === undefined) return err("#N/A");
  const s = scalar(v);
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    const parsed = dateSerialOf(s);
    if (parsed !== null) return parsed;
  }
  return toNum(v);
}

const ymd = (serial: number): { y: number; mo: number; d: number; wd: number } => partsOf(serial);

function endOfMonth(serial: number): number {
  const { y, mo } = ymd(serial);
  const next = dateToSerial(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1);
  return next - 1;
}

function daysInMonth(y: number, mo: number): number {
  return dateToSerial(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1) - dateToSerial(y, mo, 1);
}

/** WORKDAY / NETWORKDAYS 的节假日表（参数里那个区域）。 */
function holidaySet(args: EvalVal[], i: number): Set<number> {
  const set = new Set<number>();
  if (i >= args.length || args[i] === undefined) return set;
  for (const v of numbers([args[i]!])) set.add(Math.floor(v));
  return set;
}

function isWeekend(serial: number): boolean {
  const wd = partsOf(serial).wd;
  return wd === 0 || wd === 6;
}

/* ---------------------------------------------------------------- 财务助手 */

/** PMT 那一族共用的年金公式。 */
function annuity(rate: number, nper: number, pv: number, fv: number, type: number): number | null {
  if (nper === 0) return null;
  if (rate === 0) return -(pv + fv) / nper;
  const f = Math.pow(1 + rate, nper);
  const denom = (1 + rate * type) * (f - 1);
  if (denom === 0) return null;
  return -(rate * (fv + pv * f)) / denom;
}

/** 用牛顿法解一元方程，解不出来返回 null（不硬凑一个数）。 */
function newton(f: (x: number) => number, guess: number, lo: number, hi: number): number | null {
  let x = Math.min(Math.max(guess, lo), hi);
  for (let i = 0; i < 80; i++) {
    const y = f(x);
    if (!Number.isFinite(y)) break;
    if (Math.abs(y) < 1e-10) return x;
    const h = Math.max(1e-6, Math.abs(x) * 1e-6);
    const dy = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = x - y / dy;
    if (!Number.isFinite(next)) break;
    x = Math.min(Math.max(next, lo), hi);
  }
  // 牛顿不收敛就在区间上二分
  let a = lo;
  let b = hi;
  let fa = f(a);
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-10) return m;
    if (fa * fm <= 0) b = m;
    else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/* ---------------------------------------------------------------- 函数表 */

export const EXTRA_FNS: Record<string, Fn> = {
  /* ---------------- 文本 ---------------- */

  /** TEXT(值, 格式)：直接借用预览自己的数字格式引擎，跟格子上显示的字一致。 */
  TEXT: (a, ctx) => {
    const fmt = toStr(a[1] ?? "");
    if (typeof fmt !== "string") return fmt;
    const v = scalar(a[0] ?? null);
    if (isErr(v)) return v;
    if (typeof v === "string") {
      const serial = dateSerialOf(v);
      return serial === null ? v : formatValue(serial, fmt, ctx.date1904 === true);
    }
    if (typeof v === "boolean") return formatValue(v ? 1 : 0, fmt, ctx.date1904 === true);
    if (v === null) return formatValue(0, fmt, ctx.date1904 === true);
    return formatValue(v, fmt, ctx.date1904 === true);
  },
  VALUE: (a) => {
    const s = toStr(a[0] ?? "");
    if (typeof s !== "string") return s;
    return toNum(s);
  },
  NUMBERVALUE: (a) => {
    const s = toStr(a[0] ?? "");
    if (typeof s !== "string") return s;
    const dec = a.length > 1 ? toStr(a[1]!) : ".";
    const grp = a.length > 2 ? toStr(a[2]!) : ",";
    if (typeof dec !== "string") return dec;
    if (typeof grp !== "string") return grp;
    const cleaned = s.split(grp || "\u0000").join("").split(dec === "" ? "." : dec).join(".");
    const n = Number(cleaned.replace(/%/g, "")) / (s.includes("%") ? 100 : 1);
    return Number.isFinite(n) ? n : err("#VALUE!");
  },
  T: (a) => (typeof scalar(a[0] ?? null) === "string" ? scalar(a[0] ?? null) : ""),
  CHAR: (a) => {
    const n = arg(a, 0);
    if (typeof n !== "number") return n;
    if (n < 1 || n > 65535) return err("#VALUE!");
    return String.fromCharCode(Math.trunc(n));
  },
  CODE: (a) => {
    const s = argStr(a, 0);
    if (typeof s !== "string") return s;
    if (!s) return err("#VALUE!");
    return s.charCodeAt(0);
  },
  CLEAN: (a) => {
    const s = argStr(a, 0);
    if (typeof s !== "string") return s;
    return s.replace(/[\u0000-\u001f]/g, "");
  },
  EXACT: (a) => {
    const x = argStr(a, 0);
    const y = argStr(a, 1);
    if (typeof x !== "string") return x;
    if (typeof y !== "string") return y;
    return x === y;
  },
  PROPER: (a) => {
    const s = argStr(a, 0);
    if (typeof s !== "string") return s;
    return s.toLowerCase().replace(/(^|[^A-Za-z])([A-Za-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  },
  /** SEARCH：不分大小写、支持通配，跟 FIND 的差别就在这里。 */
  SEARCH: (a) => {
    const needle = argStr(a, 0);
    const hay = argStr(a, 1);
    const start = a.length > 2 ? arg(a, 2) : 1;
    if (typeof needle !== "string") return needle;
    if (typeof hay !== "string") return hay;
    if (typeof start !== "number") return start;
    const from = Math.max(0, Math.trunc(start) - 1);
    if (from > hay.length) return err("#VALUE!");
    const rx = new RegExp(
      needle.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : c === "?" ? "." : `\\${c}`)),
      "i",
    );
    const m = rx.exec(hay.slice(from));
    return m ? from + m.index + 1 : err("#VALUE!");
  },
  REPLACE: (a) => {
    const old = argStr(a, 0);
    const start = arg(a, 1);
    const count = arg(a, 2);
    const fresh = argStr(a, 3);
    if (typeof old !== "string") return old;
    if (typeof start !== "number") return start;
    if (typeof count !== "number") return count;
    if (typeof fresh !== "string") return fresh;
    const at = Math.max(0, Math.trunc(start) - 1);
    return old.slice(0, at) + fresh + old.slice(at + Math.max(0, Math.trunc(count)));
  },
  TEXTJOIN: (a) => {
    const sep = argStr(a, 0);
    const ignore = argBool(a, 1, true);
    if (typeof sep !== "string") return sep;
    if (typeof ignore !== "boolean") return ignore;
    const parts: string[] = [];
    for (const v of flatten(a.slice(2))) {
      if (isErr(v)) return v;
      if (v === null) continue;
      const s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
      if (ignore && s.trim() === "") continue;
      parts.push(s);
    }
    return parts.join(sep);
  },
  FIXED: (a) => {
    const x = arg(a, 0);
    const d = a.length > 1 ? arg(a, 1) : 2;
    const noComma = a.length > 2 ? argBool(a, 2, false) : false;
    if (typeof x !== "number") return x;
    if (typeof d !== "number") return d;
    if (typeof noComma !== "boolean") return noComma;
    const digits = Math.max(0, Math.trunc(d));
    const body = Math.abs(roundAway(x, digits)).toFixed(digits);
    const [int, frac] = body.split(".");
    const grouped = noComma ? int! : int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${x < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : digits ? `.${"0".repeat(digits)}` : ""}`;
  },
  DOLLAR: (a) => {
    const x = arg(a, 0);
    const d = a.length > 1 ? arg(a, 1) : 2;
    if (typeof x !== "number") return x;
    if (typeof d !== "number") return d;
    return formatValue(x, `"$"#,##0.${"0".repeat(Math.max(1, Math.trunc(d)))}_);("$"#,##0.${"0".repeat(Math.max(1, Math.trunc(d)))})`, false).trim();
  },

  /* ---------------- 日期与时间 ---------------- */

  DATE: (a) => {
    const y = arg(a, 0);
    const mo = arg(a, 1);
    const d = arg(a, 2);
    if (typeof y !== "number") return y;
    if (typeof mo !== "number") return mo;
    if (typeof d !== "number") return d;
    // 月份可以越界（DATE(2024,13,1) = 2025-01-01），Excel 就是这么滚的
    const year = Math.trunc(y) + Math.floor((Math.trunc(mo) - 1) / 12);
    const month = ((((Math.trunc(mo) - 1) % 12) + 12) % 12) + 1;
    return dateToSerial(year, month, Math.trunc(d));
  },
  DATEVALUE: (a) => {
    const s = argStr(a, 0);
    if (typeof s !== "string") return s;
    const serial = dateSerialOf(s);
    return serial === null ? err("#VALUE!") : Math.floor(serial);
  },
  TIME: (a) => {
    const h = arg(a, 0);
    const mi = arg(a, 1);
    const s = arg(a, 2);
    if (typeof h !== "number") return h;
    if (typeof mi !== "number") return mi;
    if (typeof s !== "number") return s;
    const total = Math.trunc(h) * 3600 + Math.trunc(mi) * 60 + Math.trunc(s);
    return (total % 86400) / 86400;
  },
  TIMEVALUE: (a) => {
    const s = argStr(a, 0);
    if (typeof s !== "string") return s;
    const serial = dateSerialOf(s);
    return serial === null ? err("#VALUE!") : serial - Math.floor(serial);
  },
  HOUR: (a) => {
    const s = serialOf(a, 0);
    if (typeof s !== "number") return s;
    if (s < 0) return err("#NUM!");
    return partsOf(s).h;
  },
  MINUTE: (a) => {
    const s = serialOf(a, 0);
    if (typeof s !== "number") return s;
    if (s < 0) return err("#NUM!");
    return partsOf(s).mi;
  },
  SECOND: (a) => {
    const s = serialOf(a, 0);
    if (typeof s !== "number") return s;
    if (s < 0) return err("#NUM!");
    return Math.round(partsOf(s).s);
  },
  /** WEEKDAY(日期, [类型])：type=1 周日=1；2 周一=1；3 周一=0。 */
  WEEKDAY: (a) => {
    const s = serialOf(a, 0);
    const type = a.length > 1 ? arg(a, 1) : 1;
    if (typeof s !== "number") return s;
    if (typeof type !== "number") return type;
    const wd = partsOf(s).wd;
    switch (Math.trunc(type)) {
      case 2:
        return wd === 0 ? 7 : wd;
      case 3:
        return wd === 0 ? 6 : wd - 1;
      case 11:
      case 12:
      case 13:
      case 14:
      case 15:
      case 16:
      case 17: {
        const monday = Math.trunc(type) - 11; // 11 → 周一=1
        return ((wd - 1 - monday + 7) % 7) + 1;
      }
      default:
        return wd + 1;
    }
  },
  WEEKNUM: (a) => {
    const s = serialOf(a, 0);
    const type = a.length > 1 ? arg(a, 1) : 1;
    if (typeof s !== "number") return s;
    if (typeof type !== "number") return type;
    const { y } = partsOf(s);
    const jan1 = dateToSerial(y, 1, 1);
    const offset = Math.trunc(type) === 2 ? 1 : 0;
    const startDow = (partsOf(jan1).wd + 6 - offset + 7) % 7;
    return Math.floor((Math.floor(s) - jan1 + startDow) / 7) + 1;
  },
  DAYS360: (a) => {
    const start = serialOf(a, 0);
    const end = serialOf(a, 1);
    const method = a.length > 2 ? argBool(a, 2, false) : false;
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    if (typeof method !== "boolean") return method;
    const p = ymd(end);
    const q = ymd(start);
    let d1 = q.d;
    let d2 = p.d;
    if (method) {
      d1 = Math.min(d1, 30);
      d2 = Math.min(d2, 30);
    } else {
      if (d1 === 31) d1 = 30;
      if (d2 === 31 && d1 === 30) d2 = 30;
    }
    return (p.y - q.y) * 360 + (p.mo - q.mo) * 30 + (d2 - d1);
  },
  /** EDATE：按整月推移，日按目标月的天数夹住（1/31 + 1 月 = 2/28）。 */
  EDATE: (a) => {
    const s = serialOf(a, 0);
    const months = arg(a, 1);
    if (typeof s !== "number") return s;
    if (typeof months !== "number") return months;
    const p = ymd(s);
    const total = p.y * 12 + (p.mo - 1) + Math.trunc(months);
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return dateToSerial(y, mo, Math.min(p.d, daysInMonth(y, mo)));
  },
  EOMONTH: (a) => {
    const s = serialOf(a, 0);
    const months = arg(a, 1);
    if (typeof s !== "number") return s;
    if (typeof months !== "number") return months;
    const p = ymd(s);
    const total = p.y * 12 + (p.mo - 1) + Math.trunc(months);
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return dateToSerial(y, mo, daysInMonth(y, mo));
  },
  /** DATEDIF：Excel 藏起来的老函数，WPS 也留着；单位按年/月/日。 */
  DATEDIF: (a) => {
    const start = serialOf(a, 0);
    const end = serialOf(a, 1);
    const unitIn = argStr(a, 2);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    if (typeof unitIn !== "string") return unitIn;
    if (end < start) return err("#NUM!");
    const unit = unitIn.toUpperCase();
    const p = ymd(start);
    const q = ymd(end);
    const months = (q.y - p.y) * 12 + (q.mo - p.mo) - (q.d < p.d ? 1 : 0);
    switch (unit) {
      case "Y":
        return Math.floor(months / 12);
      case "M":
        return months;
      case "D":
        return Math.floor(end) - Math.floor(start);
      case "MD": {
        const anchor = dateToSerial(q.y, q.mo, Math.min(p.d, daysInMonth(q.y, q.mo)));
        return Math.floor(end) - (anchor > end ? dateToSerial(q.y, q.mo - 1 || 12, p.d) : anchor);
      }
      case "YM":
        return months % 12;
      case "YD": {
        const anchor = dateToSerial(q.y, p.mo, Math.min(p.d, daysInMonth(q.y, p.mo)));
        return Math.floor(end) - (anchor > end ? dateToSerial(q.y - 1, p.mo, p.d) : anchor);
      }
      default:
        return err("#NUM!");
    }
  },
  /** YEARFRAC：basis 0 = 30/360（默认），1 = 实际/实际，2 = 实际/360，3 = 实际/365。 */
  YEARFRAC: (a) => {
    const start = serialOf(a, 0);
    const end = serialOf(a, 1);
    const basis = a.length > 2 ? arg(a, 2) : 0;
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    if (typeof basis !== "number") return basis;
    const days = end - start;
    switch (Math.trunc(basis)) {
      case 1: {
        const y1 = ymd(start).y;
        const y2 = ymd(end).y;
        if (y1 === y2) {
          const denom = dateToSerial(y1 + 1, 1, 1) - dateToSerial(y1, 1, 1);
          return days / denom;
        }
        let total = 0;
        for (let y = y1; y < y2; y++) total += (dateToSerial(y + 1, 1, 1) - dateToSerial(y, 1, 1)) / (dateToSerial(y + 1, 1, 1) - dateToSerial(y, 1, 1));
        return days / (365 * Math.max(1, y2 - y1));
      }
      case 2:
        return days / 360;
      case 3:
        return days / 365;
      case 4:
        return days / 360; // 欧洲 30/360 与美式在各月 31 号上的差别忽略不计
      default: {
        const p = ymd(start);
        const q = ymd(end);
        let d1 = Math.min(p.d, 30);
        const d2 = p.d >= 30 ? Math.min(q.d, 30) : q.d;
        return ((q.y - p.y) * 360 + (q.mo - p.mo) * 30 + (d2 - d1)) / 360;
      }
    }
  },
  WORKDAY: (a) => {
    const start = serialOf(a, 0);
    const days = arg(a, 1);
    if (typeof start !== "number") return start;
    if (typeof days !== "number") return days;
    const skip = holidaySet(a, 2);
    let cur = Math.floor(start);
    let left = Math.abs(Math.trunc(days));
    const step = days >= 0 ? 1 : -1;
    while (left > 0) {
      cur += step;
      if (!isWeekend(cur) && !skip.has(cur)) left--;
    }
    return cur;
  },
  NETWORKDAYS: (a) => {
    const start = serialOf(a, 0);
    const end = serialOf(a, 1);
    if (typeof start !== "number") return start;
    if (typeof end !== "number") return end;
    const skip = holidaySet(a, 2);
    const lo = Math.floor(Math.min(start, end));
    const hi = Math.floor(Math.max(start, end));
    let n = 0;
    for (let d = lo; d <= hi; d++) if (!isWeekend(d) && !skip.has(d)) n++;
    return Math.sign(end - start) * n;
  },

  /* ---------------- 数学与三角 ---------------- */

  PI: () => Math.PI,
  SQRTPI: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return x < 0 ? err("#NUM!") : Math.sqrt(x * Math.PI);
  },
  EXP: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.exp(x) : x;
  },
  LN: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return x <= 0 ? err("#NUM!") : Math.log(x);
  },
  LOG: (a) => {
    const x = arg(a, 0);
    const base = a.length > 1 ? arg(a, 1) : 10;
    if (typeof x !== "number") return x;
    if (typeof base !== "number") return base;
    if (x <= 0 || base <= 0) return err("#NUM!");
    return Math.log(x) / Math.log(base);
  },
  LOG10: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return x <= 0 ? err("#NUM!") : Math.log10(x);
  },
  SIN: (a) => trig(a, Math.sin),
  COS: (a) => trig(a, Math.cos),
  TAN: (a) => trig(a, Math.tan),
  ASIN: (a) => arcTrig(a, Math.asin),
  ACOS: (a) => arcTrig(a, Math.acos),
  ATAN: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.atan(x) : x;
  },
  ATAN2: (a) => {
    const x = arg(a, 0);
    const y = arg(a, 1);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    if (x === 0 && y === 0) return err("#DIV/0!");
    return Math.atan2(y, x);
  },
  SINH: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.sinh(x) : x;
  },
  COSH: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.cosh(x) : x;
  },
  TANH: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.tanh(x) : x;
  },
  ASINH: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? Math.asinh(x) : x;
  },
  ACOSH: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return x < 1 ? err("#NUM!") : Math.acosh(x);
  },
  ATANH: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return Math.abs(x) >= 1 ? err("#NUM!") : Math.atanh(x);
  },
  DEGREES: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? (x * 180) / Math.PI : x;
  },
  RADIANS: (a) => {
    const x = arg(a, 0);
    return typeof x === "number" ? (x * Math.PI) / 180 : x;
  },
  CEILING: (a) => {
    const x = arg(a, 0);
    const sig = a.length > 1 ? arg(a, 1) : 1;
    if (typeof x !== "number") return x;
    if (typeof sig !== "number") return sig;
    if (sig === 0) return x > 0 ? 0 : err("#DIV/0!");
    // Excel：正数向上、负数朝 0 取（CEILING(-2.5,2) = -2）
    return x / sig >= 0 ? Math.ceil(x / sig) * sig : -Math.floor(Math.abs(x / sig)) * Math.abs(sig);
  },
  FLOOR: (a) => {
    const x = arg(a, 0);
    const sig = a.length > 1 ? arg(a, 1) : 1;
    if (typeof x !== "number") return x;
    if (typeof sig !== "number") return sig;
    if (sig === 0) return x === 0 ? 0 : err("#DIV/0!");
    return x / sig >= 0 ? Math.floor(x / sig) * sig : -Math.ceil(Math.abs(x / sig)) * Math.abs(sig);
  },
  MROUND: (a) => {
    const x = arg(a, 0);
    const mult = arg(a, 1);
    if (typeof x !== "number") return x;
    if (typeof mult !== "number") return mult;
    if (mult === 0) return 0;
    if (x * mult < 0) return err("#NUM!");
    return Math.sign(x) * Math.round(Math.abs(x) / Math.abs(mult)) * Math.abs(mult);
  },
  TRUNC: (a) => {
    const x = arg(a, 0);
    const d = a.length > 1 ? arg(a, 1) : 0;
    if (typeof x !== "number") return x;
    if (typeof d !== "number") return d;
    const p = Math.pow(10, Math.trunc(d));
    return Math.trunc(x * p) / p;
  },
  QUOTIENT: (a) => {
    const x = arg(a, 0);
    const y = arg(a, 1);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    if (y === 0) return err("#DIV/0!");
    return Math.trunc(x / y);
  },
  EVEN: (a) => roundDirection(a, Math.ceil, 2),
  ODD: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    const n = Math.ceil(Math.abs(x));
    const even = n % 2 === 0 ? n + 1 : n;
    return Math.sign(x) * even;
  },
  GCD: (a) => {
    const xs = numbers(a).map((x) => Math.abs(Math.trunc(x)));
    if (!xs.length) return err("#VALUE!");
    return xs.reduce((x, y) => {
      let m = x;
      let n2 = y;
      while (n2) [m, n2] = [n2, m % n2];
      return m;
    });
  },
  LCM: (a) => {
    const xs = numbers(a).map((x) => Math.abs(Math.trunc(x))).filter((x) => x > 0);
    if (!xs.length) return err("#VALUE!");
    const gcd = (x: number, y: number): number => {
      let m = x;
      let n2 = y;
      while (n2) [m, n2] = [n2, m % n2];
      return m;
    };
    return xs.reduce((x, y) => (x / gcd(x, y)) * y);
  },
  FACT: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    if (x < 0) return err("#NUM!");
    let r = 1;
    for (let i = 2; i <= Math.trunc(x); i++) r *= i;
    return r;
  },
  FACTDOUBLE: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    if (x < 0) return err("#NUM!");
    let r = 1;
    for (let i = Math.trunc(x); i > 1; i -= 2) r *= i;
    return r;
  },
  COMBIN: (a) => {
    const n = arg(a, 0);
    const k = arg(a, 1);
    if (typeof n !== "number") return n;
    if (typeof k !== "number") return k;
    if (n < 0 || k < 0 || k > n) return err("#NUM!");
    let r = 1;
    for (let i = 0; i < Math.trunc(k); i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  },
  PERMUT: (a) => {
    const n = arg(a, 0);
    const k = arg(a, 1);
    if (typeof n !== "number") return n;
    if (typeof k !== "number") return k;
    if (n < 0 || k < 0 || k > n) return err("#NUM!");
    let r = 1;
    for (let i = 0; i < Math.trunc(k); i++) r *= n - i;
    return r;
  },
  MULTINOMIAL: (a) => {
    const xs = numbers(a).map((x) => Math.trunc(x));
    if (xs.some((x) => x < 0)) return err("#NUM!");
    const total = xs.reduce((x, y) => x + y, 0);
    let r = 1;
    for (let i = 2; i <= total; i++) r *= i;
    for (const x of xs) for (let i = 2; i <= x; i++) r /= i;
    return Math.round(r);
  },
  SUMSQ: (a) => sigma(numbers(a).map((x) => x * x)),
  SUMX2MY2: (a) => pairSum(a, (x, y) => x * x - y * y),
  SUMX2PY2: (a) => pairSum(a, (x, y) => x * x + y * y),
  SUMXMY2: (a) => pairSum(a, (x, y) => (x - y) * (x - y)),
  /** SUMPRODUCT：逐格相乘再求和；单参数的用法是「按条件数数」。 */
  SUMPRODUCT: (a) => {
    if (!a.length) return err("#VALUE!");
    const ms = a.map((v) => asMatrix(v));
    if (ms.some((m) => m === null)) return err("#VALUE!");
    const first = ms[0]!;
    let total = 0;
    for (let r = 0; r < first.m.length; r++) {
      for (let c = 0; c < (first.m[r]?.length ?? 0); c++) {
        let prod = 1;
        for (const m of ms) {
          const v = scalar(m!.m[r]?.[c] ?? null);
          if (isErr(v)) continue;
          prod *= typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
        }
        total += prod;
      }
    }
    return total;
  },
  RAND: () => Math.random(),
  RANDBETWEEN: (a) => {
    const lo = arg(a, 0);
    const hi = arg(a, 1);
    if (typeof lo !== "number") return lo;
    if (typeof hi !== "number") return hi;
    if (lo > hi) return err("#NUM!");
    return Math.floor(lo + Math.random() * (hi - lo + 1));
  },
  ROMAN: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    const n = Math.trunc(x);
    if (n < 0 || n > 3999) return err("#VALUE!");
    const table: [number, string][] = [
      [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
      [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
    ];
    let rest = n;
    let out = "";
    for (const [v, sym] of table) while (rest >= v) (out += sym), (rest -= v);
    return out || "0";
  },

  /* ---------------- 统计 ---------------- */

  COUNTBLANK: (a) => flatten(a).filter((v) => v === null || v === "").length,
  COUNTIFS: (a, ctx) => {
    const pairs = pairsOf(a, 0, ctx.date1904 === true);
    if (!Array.isArray(pairs)) return pairs;
    if (!pairs.length) return err("#VALUE!");
    const rows = Math.max(...pairs.map((p) => p.m.m.length));
    let n = 0;
    for (let r = 0; r < rows; r++) {
      const cols = pairs[0]!.m.m[r]?.length ?? 0;
      for (let c = 0; c < cols; c++) if (matchAll(pairs, r, c)) n++;
    }
    return n;
  },
  SUMIFS: (a, ctx) => aggregateIfs(a, ctx, "sum"),
  AVERAGEIFS: (a, ctx) => aggregateIfs(a, ctx, "avg"),
  MAXIFS: (a, ctx) => aggregateIfs(a, ctx, "max"),
  MINIFS: (a, ctx) => aggregateIfs(a, ctx, "min"),
  MEDIAN: (a) => {
    const xs = numbers(a);
    if (!xs.length) return err("#NUM!");
    const s = [...xs].sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  },
  MODE: (a) => {
    const xs = numbers(a);
    const count = new Map<number, number>();
    for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
    let best: number | null = null;
    let bestN = 1;
    for (const [x, n] of count) if (n > bestN) (best = x), (bestN = n);
    return best === null ? err("#N/A") : best;
  },
  LARGE: (a) => nthLargest(a, true),
  SMALL: (a) => nthLargest(a, false),
  RANK: (a) => rankOf(a, false),
  "RANK.EQ": (a) => rankOf(a, false),
  "RANK.AVG": (a) => rankOf(a, true),
  PERCENTILE: (a) => percentileOf(a, true),
  "PERCENTILE.INC": (a) => percentileOf(a, true),
  "PERCENTILE.EXC": (a) => percentileOf(a, false),
  QUARTILE: (a) => {
    const xs = numbers([a[0] ?? null]);
    const q = arg(a, 1);
    if (!xs.length) return err("#NUM!");
    if (typeof q !== "number") return q;
    const k = Math.trunc(q);
    if (k < 0 || k > 4) return err("#NUM!");
    return quantile(xs, k / 4, true);
  },
  STDEV: (a) => Math.sqrt(variance(numbers(a), true)),
  "STDEV.S": (a) => Math.sqrt(variance(numbers(a), true)),
  STDEVP: (a) => Math.sqrt(variance(numbers(a), false)),
  "STDEV.P": (a) => Math.sqrt(variance(numbers(a), false)),
  VAR: (a) => nz(variance(numbers(a), true)),
  "VAR.S": (a) => nz(variance(numbers(a), true)),
  VARP: (a) => nz(variance(numbers(a), false)),
  "VAR.P": (a) => nz(variance(numbers(a), false)),
  DEVSQ: (a) => {
    const xs = numbers(a);
    const m = mean(xs);
    return sigma(xs.map((x) => (x - m) * (x - m)));
  },
  GEOMEAN: (a) => {
    const xs = numbers(a);
    if (!xs.length || xs.some((x) => x <= 0)) return err("#NUM!");
    return Math.exp(sigma(xs.map((x) => Math.log(x))) / xs.length);
  },
  HARMEAN: (a) => {
    const xs = numbers(a);
    if (!xs.length || xs.some((x) => x <= 0)) return err("#NUM!");
    return xs.length / sigma(xs.map((x) => 1 / x));
  },
  AVEDEV: (a) => {
    const xs = numbers(a);
    if (!xs.length) return err("#NUM!");
    const m = mean(xs);
    return sigma(xs.map((x) => Math.abs(x - m))) / xs.length;
  },
  SKEW: (a) => {
    const xs = numbers(a);
    const n = xs.length;
    if (n < 3) return err("#DIV/0!");
    const m = mean(xs);
    const s = Math.sqrt(variance(xs, true));
    if (s === 0) return err("#DIV/0!");
    return (n / ((n - 1) * (n - 2))) * sigma(xs.map((x) => Math.pow((x - m) / s, 3)));
  },
  KURT: (a) => {
    const xs = numbers(a);
    const n = xs.length;
    if (n < 4) return err("#DIV/0!");
    const m = mean(xs);
    const s2 = variance(xs, true);
    if (s2 === 0) return err("#DIV/0!");
    const sum4 = sigma(xs.map((x) => Math.pow(x - m, 4)));
    return (n * (n + 1) * sum4) / ((n - 1) * (n - 2) * (n - 3) * s2 * s2) - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  },
  TRIMMEAN: (a) => {
    const xs = numbers([a[0] ?? null]);
    const pct = arg(a, 1, 0);
    if (!xs.length) return err("#NUM!");
    if (typeof pct !== "number") return pct;
    if (pct < 0 || pct >= 1) return err("#NUM!");
    const s = [...xs].sort((x, y) => x - y);
    const cut = Math.floor(s.length * pct / 2);
    return mean(s.slice(cut, s.length - cut));
  },
  STANDARDIZE: (a) => {
    const x = arg(a, 0);
    const m = arg(a, 1);
    const s = arg(a, 2);
    if (typeof x !== "number") return x;
    if (typeof m !== "number") return m;
    if (typeof s !== "number") return s;
    return s <= 0 ? err("#NUM!") : (x - m) / s;
  },
  CORREL: (a) => corr(a, "corr"),
  PEARSON: (a) => corr(a, "corr"),
  RSQ: (a) => corr(a, "rsq"),
  SLOPE: (a) => corr(a, "slope"),
  INTERCEPT: (a) => corr(a, "intercept"),
  STEYX: (a) => corr(a, "steyx"),
  FORECAST: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    const slope = corr([a[1] ?? null, a[2] ?? null], "slope");
    const intercept = corr([a[1] ?? null, a[2] ?? null], "intercept");
    if (typeof slope !== "number") return slope;
    if (typeof intercept !== "number") return intercept;
    return intercept + slope * x;
  },
  MAXA: (a) => {
    const xs = numbersA2(a);
    return xs.length ? Math.max(...xs) : 0;
  },
  MINA: (a) => {
    const xs = numbersA2(a);
    return xs.length ? Math.min(...xs) : 0;
  },
  AVERAGEA: (a) => {
    const xs = numbersA2(a);
    return xs.length ? mean(xs) : err("#DIV/0!");
  },

  /* ---------------- 查找与引用 ---------------- */

  HLOOKUP: (a) => {
    const key = scalar(a[0] ?? null);
    const m = asMatrix(a[1]);
    const rowIdx = arg(a, 2);
    if (!m) return err("#VALUE!");
    if (typeof rowIdx !== "number") return rowIdx;
    const approx = a.length > 3 ? toBool(a[3]) !== false : true;
    const head = rowValues(m, 0);
    let found: Val | undefined;
    for (let i = 0; i < head.length; i++) {
      const c = cmp(head[i]!, key as Val);
      if (approx ? c <= 0 : c === 0) {
        found = colValues(m, i)[Math.trunc(rowIdx) - 1] ?? null;
        if (!approx) break;
      }
    }
    return found === undefined ? err("#N/A") : found;
  },
  /** LOOKUP：近似匹配的祖传函数（找不到更小的就报 #N/A）。 */
  LOOKUP: (a) => {
    const key = scalar(a[0] ?? null);
    const lookupM = asMatrix(a[1]);
    if (!lookupM) return err("#VALUE!");
    const resultM = a.length > 2 ? asMatrix(a[2]) : lookupM;
    if (!resultM) return err("#VALUE!");
    const keys = lookupM.m.length === 1 ? rowValues(lookupM, 0) : colValues(lookupM, 0);
    const results = lookupM.m.length === 1 ? rowValues(resultM, resultM.m.length - 1) : colValues(resultM, resultM.m[0]?.length ? resultM.m[0].length - 1 : 0);
    let best = -1;
    for (let i = 0; i < keys.length; i++) if (cmp(keys[i]!, key as Val) <= 0) best = i;
    if (best < 0) return err("#N/A");
    return results[best] ?? null;
  },
  /** XLOOKUP：精确优先；match_mode 0 精确、-1 向下取小、1 向上取大、2 通配。 */
  XLOOKUP: (a) => {
    const key = scalar(a[0] ?? null);
    const keysM = asMatrix(a[1]);
    const resM = asMatrix(a[2]);
    if (!keysM || !resM) return err("#VALUE!");
    const ifNotFound = a.length > 3 ? a[3] : undefined;
    const matchMode = a.length > 4 ? arg(a, 4, 0) : 0;
    if (typeof matchMode !== "number") return matchMode;
    const keys = keysM.m.length === 1 ? rowValues(keysM, 0) : colValues(keysM, 0);
    const results = resM.m.length === 1 ? rowValues(resM, 0) : colValues(resM, 0);
    let hit = -1;
    if (Math.trunc(matchMode) === 2) {
      const rx = new RegExp(String(key).replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : c === "?" ? "." : `\\${c}`)), "i");
      hit = keys.findIndex((v) => typeof v === "string" && rx.test(v));
    } else {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (cmp(k, key as Val) === 0) {
          hit = i;
          break;
        }
      }
      if (hit < 0 && Math.trunc(matchMode) !== 0) {
        let best = { err: Infinity, i: -1 };
        for (let i = 0; i < keys.length; i++) {
          const c = cmp(keys[i]!, key as Val);
          if (Math.trunc(matchMode) < 0 && c < 0) {
            const d = Math.abs(cmp(keys[i]!, key as Val));
            if (d < best.err) best = { err: d, i };
            else if (best.i < 0) best = { err: d, i };
          } else if (Math.trunc(matchMode) > 0 && c > 0) {
            if (best.i < 0) best = { err: 0, i };
          }
        }
        if (Math.trunc(matchMode) < 0 && best.i < 0) hit = keys.length - 1;
        else hit = best.i;
      }
    }
    if (hit < 0) return ifNotFound !== undefined ? ifNotFound : err("#N/A");
    return results[hit] ?? null;
  },
  /** XMATCH：返回位置（1 起）。 */
  XMATCH: (a) => {
    const key = scalar(a[0] ?? null);
    const m = asMatrix(a[1]);
    if (!m) return err("#VALUE!");
    const mode = a.length > 2 ? arg(a, 2, 0) : 0;
    if (typeof mode !== "number") return mode;
    const keys = m.m.length === 1 ? rowValues(m, 0) : colValues(m, 0);
    for (let i = 0; i < keys.length; i++) if (cmp(keys[i]!, key as Val) === 0) return i + 1;
    if (Math.trunc(mode) < 0) {
      let best = -1;
      for (let i = 0; i < keys.length; i++) if (cmp(keys[i]!, key as Val) < 0) best = i;
      return best < 0 ? err("#N/A") : best + 1;
    }
    if (Math.trunc(mode) > 0) {
      for (let i = 0; i < keys.length; i++) if (cmp(keys[i]!, key as Val) > 0) return i + 1;
    }
    return err("#N/A");
  },
  CHOOSE: (a) => {
    const idx = arg(a, 0);
    if (typeof idx !== "number") return idx;
    const i = Math.trunc(idx);
    if (i < 1 || i >= a.length) return err("#VALUE!");
    return scalar(a[i] ?? null);
  },
  COLUMN: (a, ctx, _sheet, node) => {
    const ref = refArg(node);
    if (ref) return ref.c0 + 1;
    return ctx.at ? ctx.at.c + 1 : err("#VALUE!");
  },
  ROW: (a, ctx, _sheet, node) => {
    const ref = refArg(node);
    if (ref) return ref.r0 + 1;
    return ctx.at ? ctx.at.r + 1 : err("#VALUE!");
  },
  ROWS: (a) => {
    const m = asMatrix(a[0]);
    return m ? m.m.length : err("#VALUE!");
  },
  COLUMNS: (a) => {
    const m = asMatrix(a[0]);
    return m ? Math.max(0, m.m[0]?.length ?? 0) : err("#VALUE!");
  },

  /* ---------------- 逻辑 ---------------- */

  TRUE: () => true,
  FALSE: () => false,
  XOR: (a) => {
    let n = 0;
    for (const v of flatten(a)) {
      if (isErr(v)) return v;
      if (typeof v === "boolean") n += v ? 1 : 0;
      else if (typeof v === "number") n += v !== 0 ? 1 : 0;
    }
    return n % 2 === 1;
  },
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) {
      const cond = toBool(a[i] ?? null);
      if (isErr(cond)) return cond;
      if (cond) return scalar(a[i + 1] ?? null);
    }
    return err("#N/A");
  },
  SWITCH: (a) => {
    const v = scalar(a[0] ?? null);
    if (isErr(v)) return v;
    let i = 1;
    for (; i + 1 < a.length; i += 2) {
      const cand = scalar(a[i] ?? null);
      if (isErr(cand)) continue;
      if (cmp(v, cand) === 0) return scalar(a[i + 1] ?? null);
    }
    return i < a.length ? scalar(a[i] ?? null) : err("#N/A");
  },

  /* ---------------- 信息 ---------------- */

  N: (a) => {
    const v = scalar(a[0] ?? null);
    if (isErr(v)) return v;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return 0;
  },
  NA: () => err("#N/A"),
  ISERR: (a) => {
    const v = scalar(a[0] ?? null);
    return isErr(v) && v.v !== "#N/A";
  },
  ISNA: (a) => {
    const v = scalar(a[0] ?? null);
    return isErr(v) && v.v === "#N/A";
  },
  ISLOGICAL: (a) => typeof scalar(a[0] ?? null) === "boolean",
  ISNONTEXT: (a) => typeof scalar(a[0] ?? null) !== "string",
  ISEVEN: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return Math.trunc(x) % 2 === 0;
  },
  ISODD: (a) => {
    const x = arg(a, 0);
    if (typeof x !== "number") return x;
    return Math.abs(Math.trunc(x)) % 2 === 1;
  },
  TYPE: (a) => {
    const v = scalar(a[0] ?? null);
    if (isErr(v)) return 16;
    if (typeof v === "number") return 1;
    if (typeof v === "string") return 2;
    if (typeof v === "boolean") return 4;
    return 1;
  },
  /** ERROR.TYPE：Excel 里的编号是固定的，别改。 */
  "ERROR.TYPE": (a) => {
    const v = scalar(a[0] ?? null);
    if (!isErr(v)) return err("#N/A");
    const map: Record<string, number> = {
      "#NULL!": 1,
      "#DIV/0!": 2,
      "#VALUE!": 3,
      "#REF!": 4,
      "#NAME?": 5,
      "#NUM!": 6,
      "#N/A": 7,
    };
    return map[v.v] ?? err("#N/A");
  },

  /* ---------------- 财务 ---------------- */

  PMT: (a) => {
    const rate = arg(a, 0);
    const nper = arg(a, 1);
    const pv = arg(a, 2);
    const fv = a.length > 3 ? arg(a, 3) : 0;
    const type = a.length > 4 ? arg(a, 4) : 0;
    for (const x of [rate, nper, pv, fv, type]) if (typeof x !== "number") return x;
    const r = annuity(rate as number, nper as number, pv as number, fv as number, type as number);
    return r === null ? err("#NUM!") : r;
  },
  FV: (a) => {
    const rate = arg(a, 0);
    const nper = arg(a, 1);
    const pmt = arg(a, 2);
    const pv = a.length > 3 ? arg(a, 3) : 0;
    const type = a.length > 4 ? arg(a, 4) : 0;
    for (const x of [rate, nper, pmt, pv, type]) if (typeof x !== "number") return x;
    const r = rate as number;
    const n = nper as number;
    if (r === 0) return -(pv as number) - (pmt as number) * n;
    const f = Math.pow(1 + r, n);
    return -((pv as number) * f + (pmt as number) * (1 + r * (type as number)) * ((f - 1) / r));
  },
  PV: (a) => {
    const rate = arg(a, 0);
    const nper = arg(a, 1);
    const pmt = arg(a, 2);
    const fv = a.length > 3 ? arg(a, 3) : 0;
    const type = a.length > 4 ? arg(a, 4) : 0;
    for (const x of [rate, nper, pmt, fv, type]) if (typeof x !== "number") return x;
    const r = rate as number;
    const n = nper as number;
    if (r === 0) return -(fv as number) - (pmt as number) * n;
    const f = Math.pow(1 + r, n);
    return -((fv as number) + (pmt as number) * (1 + r * (type as number)) * ((f - 1) / r)) / f;
  },
  NPER: (a) => {
    const rate = arg(a, 0);
    const pmt = arg(a, 1);
    const pv = arg(a, 2);
    const fv = a.length > 3 ? arg(a, 3) : 0;
    const type = a.length > 4 ? arg(a, 4) : 0;
    for (const x of [rate, pmt, pv, fv, type]) if (typeof x !== "number") return x;
    const r = rate as number;
    const p = pmt as number;
    if (r === 0) return p === 0 ? err("#NUM!") : -((pv as number) + (fv as number)) / p;
    const adj = (p * (1 + r * (type as number))) / r;
    const ratio = (adj - (fv as number)) / ((pv as number) + adj);
    if (!(ratio > 0)) return err("#NUM!");
    return Math.log(ratio) / Math.log(1 + r);
  },
  IPMT: (a) => {
    const rate = arg(a, 0);
    const per = arg(a, 1);
    const nper = arg(a, 2);
    const pv = arg(a, 3);
    const fv = a.length > 4 ? arg(a, 4) : 0;
    const type = a.length > 5 ? arg(a, 5) : 0;
    for (const x of [rate, per, nper, pv, fv, type]) if (typeof x !== "number") return x;
    const r = rate as number;
    const period = Math.trunc(per as number);
    if (period < 1 || period > Math.trunc(nper as number)) return err("#NUM!");
    const pay = annuity(r, nper as number, pv as number, fv as number, type as number);
    if (pay === null) return err("#NUM!");
    let balance = pv as number;
    let interest = 0;
    for (let k = 1; k <= period; k++) {
      interest = r === 0 ? 0 : -(balance * r);
      if (type === 1 && k === 1) interest = 0;
      const principal = pay - interest;
      balance += principal;
      if (k === period) return interest;
    }
    return interest;
  },
  PPMT: (a) => {
    const rate = arg(a, 0);
    const per = arg(a, 1);
    const nper = arg(a, 2);
    const pv = arg(a, 3);
    const fv = a.length > 4 ? arg(a, 4) : 0;
    const type = a.length > 5 ? arg(a, 5) : 0;
    for (const x of [rate, per, nper, pv, fv, type]) if (typeof x !== "number") return x;
    const pay = annuity(rate as number, nper as number, pv as number, fv as number, type as number);
    if (pay === null) return err("#NUM!");
    const interest = EXTRA_FNS.IPMT!(a, { cell: () => null, range: () => ({ k: "mx", m: [] }) }, null);
    if (typeof interest !== "number") return interest;
    return pay - interest;
  },
  RATE: (a) => {
    const nper = arg(a, 0);
    const pmt = arg(a, 1);
    const pv = arg(a, 2);
    const fv = a.length > 3 ? arg(a, 3) : 0;
    const type = a.length > 4 ? arg(a, 4) : 0;
    const guess = a.length > 5 ? arg(a, 5, 0.1) : 0.1;
    for (const x of [nper, pmt, pv, fv, type, guess]) if (typeof x !== "number") return x;
    const f = (r: number): number =>
      r === 0
        ? (pv as number) + (pmt as number) * (nper as number) + (fv as number)
        : (pv as number) * Math.pow(1 + r, nper as number) +
          (pmt as number) * (1 + r * (type as number)) * ((Math.pow(1 + r, nper as number) - 1) / r) +
          (fv as number);
    const hit = newton(f, guess as number, -0.999999, 1e6);
    return hit === null ? err("#NUM!") : hit;
  },
  NPV: (a) => {
    const rate = arg(a, 0);
    if (typeof rate !== "number") return rate;
    const flows = numbers(a.slice(1));
    return flows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, i + 1), 0);
  },
  IRR: (a) => {
    const flows = numbers([a[0] ?? null]);
    if (flows.length < 2) return err("#NUM!");
    const f = (r: number): number => flows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, i), 0);
    const hit = newton(f, 0.1, -0.999999, 1e6);
    return hit === null ? err("#NUM!") : hit;
  },
  MIRR: (a) => {
    const flows = numbers([a[0] ?? null]);
    const frate = arg(a, 1);
    const rrate = arg(a, 2);
    if (typeof frate !== "number") return frate;
    if (typeof rrate !== "number") return rrate;
    const n = flows.length;
    if (n < 2) return err("#NUM!");
    const pvNeg = flows.reduce((acc, cf, i) => (cf < 0 ? acc + cf / Math.pow(1 + frate, i) : acc), 0);
    const fvPos = flows.reduce((acc, cf, i) => (cf > 0 ? acc + cf * Math.pow(1 + rrate, n - 1 - i) : acc), 0);
    if (pvNeg >= 0 || fvPos <= 0) return err("#NUM!");
    return Math.pow(fvPos / -pvNeg, 1 / (n - 1)) - 1;
  },
  XNPV: (a) => {
    const rate = arg(a, 0);
    if (typeof rate !== "number") return rate;
    const amounts = numbers([a[1] ?? null]);
    const dates = numbers([a[2] ?? null]);
    if (amounts.length !== dates.length || !amounts.length) return err("#NUM!");
    const t0 = dates[0]!;
    return amounts.reduce((acc, cf, i) => acc + cf / Math.pow(1 + rate, (dates[i]! - t0) / 365), 0);
  },
  XIRR: (a) => {
    const amounts = numbers([a[0] ?? null]);
    const dates = numbers([a[1] ?? null]);
    if (amounts.length !== dates.length || amounts.length < 2) return err("#NUM!");
    const t0 = dates[0]!;
    const f = (r: number): number => amounts.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, (dates[i]! - t0) / 365), 0);
    const hit = newton(f, 0.1, -0.999999, 1e6);
    return hit === null ? err("#NUM!") : hit;
  },
  SLN: (a) => {
    const cost = arg(a, 0);
    const salvage = arg(a, 1);
    const life = arg(a, 2);
    for (const x of [cost, salvage, life]) if (typeof x !== "number") return x;
    if (life === 0) return err("#DIV/0!");
    return ((cost as number) - (salvage as number)) / (life as number);
  },
  SYD: (a) => {
    const cost = arg(a, 0);
    const salvage = arg(a, 1);
    const life = arg(a, 2);
    const per = arg(a, 3);
    for (const x of [cost, salvage, life, per]) if (typeof x !== "number") return x;
    const n = life as number;
    const p = per as number;
    return ((cost as number - (salvage as number)) * (n - p + 1) * 2) / (n * (n + 1));
  },
  DB: (a) => {
    const cost = arg(a, 0);
    const salvage = arg(a, 1);
    const life = arg(a, 2);
    const period = arg(a, 3);
    const month = a.length > 4 ? arg(a, 4, 12) : 12;
    for (const x of [cost, salvage, life, period, month]) if (typeof x !== "number") return x;
    const rate = roundAway(1 - Math.pow((salvage as number) / (cost as number), 1 / (life as number)), 3);
    let book = cost as number;
    let dep = 0;
    for (let p = 1; p <= Math.trunc(period as number); p++) {
      dep = p === 1 ? (book * rate * (month as number)) / 12 : book * rate;
      book -= dep;
    }
    return dep;
  },
  DDB: (a) => {
    const cost = arg(a, 0);
    const salvage = arg(a, 1);
    const life = arg(a, 2);
    const period = arg(a, 3);
    const factor = a.length > 4 ? arg(a, 4, 2) : 2;
    for (const x of [cost, salvage, life, period, factor]) if (typeof x !== "number") return x;
    const rate = (factor as number) / (life as number);
    let book = cost as number;
    let dep = 0;
    for (let p = 1; p <= Math.trunc(period as number); p++) {
      dep = Math.min(book * rate, book - (salvage as number));
      book -= dep;
    }
    return Math.max(0, dep);
  },

  /* ---------------- 工程（进制转换这一小撮） ---------------- */

  BIN2DEC: (a) => fromBase(a, 2),
  OCT2DEC: (a) => fromBase(a, 8),
  HEX2DEC: (a) => fromBase(a, 16),
  DEC2BIN: (a) => toBase(a, 2),
  DEC2OCT: (a) => toBase(a, 8),
  DEC2HEX: (a) => toBase(a, 16),
  DELTA: (a) => {
    const x = arg(a, 0);
    const y = a.length > 1 ? arg(a, 1, 0) : 0;
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    return x === y ? 1 : 0;
  },
  GESTEP: (a) => {
    const x = arg(a, 0);
    const step = a.length > 1 ? arg(a, 1, 0) : 0;
    if (typeof x !== "number") return x;
    if (typeof step !== "number") return step;
    return x >= step ? 1 : 0;
  },
};

/* ---------------------------------------------------------------- 表外的助手 */

function trig(a: EvalVal[], fn: (x: number) => number): EvalVal {
  const x = arg(a, 0);
  return typeof x === "number" ? fn(x) : x;
}

function arcTrig(a: EvalVal[], fn: (x: number) => number): EvalVal {
  const x = arg(a, 0);
  if (typeof x !== "number") return x;
  return Math.abs(x) > 1 ? err("#NUM!") : fn(x);
}

function roundDirection(a: EvalVal[], fn: (x: number) => number, step: number): EvalVal {
  const x = arg(a, 0);
  if (typeof x !== "number") return x;
  const n = fn(Math.abs(x) / step) * step;
  return Math.sign(x) * n;
}

function pairSum(a: EvalVal[], fn: (x: number, y: number) => number): EvalVal {
  const xs = numbers([a[0] ?? null]);
  const ys = numbers([a[1] ?? null]);
  if (xs.length !== ys.length) return err("#N/A");
  return xs.reduce((acc, x, i) => acc + fn(x, ys[i]!), 0);
}

function nz(x: number): EvalVal {
  return Number.isFinite(x) ? x : err("#DIV/0!");
}

function numbersA2(args: EvalVal[]): number[] {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    else if (typeof v === "string") out.push(Number.isFinite(Number(v)) ? Number(v) : 0);
  }
  return out;
}

/** SUMIFS / AVERAGEIFS / MAXIFS / MINIFS：第一个参数是要汇总的区，后面成对是条件。 */
function aggregateIfs(a: EvalVal[], ctx: CalcCtx, mode: "sum" | "avg" | "max" | "min"): EvalVal {
  const sumM = asMatrix(a[0]);
  if (!sumM) return err("#VALUE!");
  const pairs = pairsOf(a, 1, ctx.date1904 === true);
  if (!Array.isArray(pairs)) return pairs;
  if (!pairs.length) return err("#VALUE!");
  const picked: number[] = [];
  for (let r = 0; r < sumM.m.length; r++) {
    for (let c = 0; c < (sumM.m[r]?.length ?? 0); c++) {
      if (!matchAll(pairs, r, c)) continue;
      const v = scalar(sumM.m[r]?.[c] ?? null);
      if (typeof v === "number" && Number.isFinite(v)) picked.push(v);
    }
  }
  switch (mode) {
    case "sum":
      return sigma(picked);
    case "avg":
      return picked.length ? mean(picked) : err("#DIV/0!");
    case "max":
      return picked.length ? Math.max(...picked) : 0;
    case "min":
      return picked.length ? Math.min(...picked) : 0;
  }
}

function nthLargest(a: EvalVal[], big: boolean): EvalVal {
  const xs = numbers([a[0] ?? null]);
  const k = arg(a, 1);
  if (!xs.length) return err("#NUM!");
  if (typeof k !== "number") return k;
  const idx = Math.trunc(k);
  if (idx < 1 || idx > xs.length) return err("#NUM!");
  const s = [...xs].sort((x, y) => (big ? y - x : x - y));
  return s[idx - 1]!;
}

function rankOf(a: EvalVal[], average: boolean): EvalVal {
  const x = arg(a, 0);
  if (typeof x !== "number") return x;
  const xs = numbers([a[1] ?? null]);
  const order = a.length > 2 ? arg(a, 2, 0) : 0;
  if (typeof order !== "number") return order;
  const asc = Math.trunc(order) !== 0;
  const sorted = [...xs].sort((p, q) => (asc ? p - q : q - p));
  const first = sorted.findIndex((v) => v === x);
  if (first < 0) return err("#N/A");
  if (!average) return first + 1;
  const ties = sorted.filter((v) => v === x).length;
  return first + (ties + 1) / 2;
}

function percentileOf(a: EvalVal[], inclusive: boolean): EvalVal {
  const xs = numbers([a[0] ?? null]);
  const p = arg(a, 1);
  if (!xs.length) return err("#NUM!");
  if (typeof p !== "number") return p;
  if (p < 0 || p > 1) return err("#NUM!");
  const v = quantile(xs, p, inclusive);
  return Number.isFinite(v) ? v : err("#NUM!");
}

/** CORREL / SLOPE / INTERCEPT / RSQ / STEYX：一条最小二乘的五个说法。 */
function corr(a: EvalVal[], mode: "corr" | "slope" | "intercept" | "rsq" | "steyx"): EvalVal {
  const ys = numbers([a[0] ?? null]);
  const xs = numbers([a[1] ?? null]);
  if (xs.length !== ys.length || xs.length < 2) return err("#N/A");
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0) return err("#DIV/0!");
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  switch (mode) {
    case "slope":
      return slope;
    case "intercept":
      return intercept;
    case "corr":
      return syy === 0 ? err("#DIV/0!") : sxy / Math.sqrt(sxx * syy);
    case "rsq": {
      if (syy === 0) return err("#DIV/0!");
      const r = sxy / Math.sqrt(sxx * syy);
      return r * r;
    }
    case "steyx": {
      const ss = syy - (sxy * sxy) / sxx;
      return Math.sqrt(Math.max(0, ss) / (xs.length - 2));
    }
  }
}

/** ROW(A5) / COLUMN(C1) 要的是坐标，值里没有——从参数节点上拿。 */
function refArg(node: FnNode | undefined): { r0: number; c0: number } | null {
  const first = node?.args[0] as { k?: string; r0?: number; c0?: number } | undefined;
  if (!first || first.k !== "ref" || typeof first.r0 !== "number" || typeof first.c0 !== "number") return null;
  return { r0: first.r0, c0: first.c0 };
}

function fromBase(a: EvalVal[], base: number): EvalVal {
  const s = argStr(a, 0);
  if (typeof s !== "string") return s;
  const digits = parseInt(s.trim(), base);
  if (!Number.isFinite(digits)) return err("#NUM!");
  // Excel 的进制转换按 10 位补码理解负数
  if (s.trim().length === 10 && digits > Math.pow(2, 39) - 1) return digits - Math.pow(2, 40);
  return digits;
}

function toBase(a: EvalVal[], base: number): EvalVal {
  const x = arg(a, 0);
  const places = a.length > 1 ? arg(a, 1) : 0;
  if (typeof x !== "number") return x;
  if (typeof places !== "number") return places;
  const n = Math.trunc(x);
  if (base === 2 && (n < -512 || n > 511)) return err("#NUM!");
  if (base === 8 && (n < -536870912 || n > 536870911)) return err("#NUM!");
  const text = n < 0 ? (Math.pow(2, base === 2 ? 10 : base === 8 ? 30 : 40) + n).toString(base).toUpperCase() : Math.abs(n).toString(base).toUpperCase();
  const width = Math.trunc(places);
  return width > 0 ? text.padStart(width, "0") : text;
}
