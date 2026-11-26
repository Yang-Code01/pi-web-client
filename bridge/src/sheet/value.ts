/**
 * 求值器的公共零件：值类型、类型转换、比较、条件匹配（D266）。
 *
 * 从 `calc.ts` 里挪出来的——函数表从 51 个涨到两百多个以后，同一条「文本/数字/空
 * 怎么比」的规则要同时被代数运算、COUNTIF 系列和排序用，留在一个文件里既讲不清也测不动。
 */

export type Val = number | string | boolean | null;
export interface ErrVal {
  k: "err";
  v: string;
}
/**
 * 「这块矩阵是 ctx 的缓存对象」的标记（只有 `BookCalc.range()` 会打）。
 *
 * 查找类函数靠它决定要不要给矩阵建索引：同一块区域被几千个 VLOOKUP 问到时建一次索引是
 * 净赚，而每次新建的临时矩阵建索引比线性扫还慢，所以不能无条件建。见 D427。
 */
export const CACHED_RANGE = Symbol("sheet.cachedRange");

export interface Matrix {
  k: "mx";
  m: EvalVal[][];
  /** ctx 保证「同一区域返回同一对象」时打上的标记；一次性的临时矩阵没有它。 */
  [CACHED_RANGE]?: true;
}
export type EvalVal = Val | ErrVal | Matrix;

export interface CalcCtx {
  /** 取一格的值。sheet 为 null 表示当前表。 */
  cell(sheet: string | null, r: number, c: number): EvalVal;
  /** 取一片区域。 */
  range(sheet: string | null, r0: number, c0: number, r1: number, c1: number): Matrix;
  /** 工作簿的日期系统：TEXT / 日期函数要按它算。1904 系统只有老 Mac 文件才有。 */
  date1904?: boolean;
  /** 正在算哪一格：ROW() / COLUMN() 不带参数时要知道自己在哪。 */
  at?: { r: number; c: number };
}

export const err = (v: string): ErrVal => ({ k: "err", v });
export const isErr = (v: EvalVal): v is ErrVal => typeof v === "object" && v !== null && (v as ErrVal).k === "err";
export const isMx = (v: EvalVal): v is Matrix => typeof v === "object" && v !== null && (v as Matrix).k === "mx";

/** 单格引用在运算里就是标量；区域取左上角（Excel 的隐式交叉我们不支持）。 */
export function scalar(v: EvalVal): Val | ErrVal {
  if (isMx(v)) return (v.m[0]?.[0] as Val | ErrVal | undefined) ?? null;
  return v;
}

export function toNum(v: EvalVal): number | ErrVal {
  const s = scalar(v);
  if (isErr(s)) return s;
  if (s === null) return 0;
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  const t = s.trim();
  if (t === "") return 0;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  // 逻辑常量、百分比、货币符号、日期串：Excel 都会替用户转
  if (/^(true)$/i.test(t)) return 1;
  if (/^(false)$/i.test(t)) return 0;
  const pct = /^(-?[\d.,]+)\s*%$/.exec(t);
  if (pct) {
    const base = Number(pct[1]!.replace(/,/g, ""));
    if (Number.isFinite(base)) return base / 100;
  }
  const serial = dateSerialOf(t);
  if (serial !== null) return serial;
  return err("#VALUE!");
}

export function toStr(v: EvalVal): string | ErrVal {
  const s = scalar(v);
  if (isErr(s)) return s;
  if (s === null) return "";
  if (typeof s === "string") return s;
  if (typeof s === "boolean") return s ? "TRUE" : "FALSE";
  // 数字转文本：整数不带小数点，其余按 JS 的最短表示。
  return String(s);
}

export function toBool(v: EvalVal): boolean | ErrVal {
  const s = scalar(v);
  if (isErr(s)) return s;
  if (s === null) return false;
  if (typeof s === "boolean") return s;
  if (typeof s === "number") return s !== 0;
  const t = s.trim().toUpperCase();
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  return err("#VALUE!");
}

/** 把若干参数摊平成标量数组（区域会被展开，错误值保留）。 */
export function flatten(args: EvalVal[]): (Val | ErrVal)[] {
  const out: (Val | ErrVal)[] = [];
  for (const a of args) {
    if (isMx(a)) {
      for (const row of a.m) for (const v of row) if (!isMx(v)) out.push(v);
    } else out.push(a);
  }
  return out;
}

/** SUM / AVERAGE 这类只要数字：文本、空、布尔都跳过（跟 Excel 一样）。 */
export function numbers(args: EvalVal[]): number[] {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) out.push(Number(v));
  }
  return out;
}

/**
 * MAXA / MINA / STDEVA：把文本和布尔也算进去（文本 = 0，TRUE = 1）。
 * 和 `numbers()` 的差别就在这里，Excel 把这个区别做得很大。
 */
export function numbersA(args: EvalVal[]): number[] {
  const out: number[] = [];
  for (const v of flatten(args)) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    else if (typeof v === "string") out.push(Number.isFinite(Number(v)) ? Number(v) : 0);
  }
  return out;
}

/**
 * 第一个错误值（参数顺序、区域内行优先）。
 *
 * 不要用 `flatten(args)` 再扫：带区域参数的函数（VLOOKUP 的查找表）每次调用都要摊平
 * 一个几千格的矩阵 —— 4000 个 VLOOKUP × 8000 格 = 3200 万次 push，实测 537ms。
 * 区域在求值期间只读（见 `CACHED_RANGE`），所以缓存过的矩阵能把这一扫描降到一次。
 */
export function firstErr(args: EvalVal[]): ErrVal | null {
  for (const v of args) {
    if (!isMx(v)) {
      if (isErr(v)) return v;
      continue;
    }
    const hit = firstErrCache.get(v);
    if (hit !== undefined) {
      if (hit) return hit;
      continue;
    }
    let found: ErrVal | null = null;
    for (const row of v.m) {
      for (const cell of row) if (isErr(cell)) {
        found = cell;
        break;
      }
      if (found) break;
    }
    if (v[CACHED_RANGE]) firstErrCache.set(v, found);
  }
  return null;
}

/** 只给「ctx 保证同一区域返回同一对象」的矩阵用（`CACHED_RANGE`），否则值可能变。 */
const firstErrCache = new WeakMap<Matrix, ErrVal | null>();

/** 比较用的一侧取值：数字 / 布尔 / 空都折成数，文本给 null（文本比任何数都大）。 */
function cmpNum(v: Val): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  return null;
}

/** 比较：数字比数字、文本比文本（不区分大小写），不同类型按 Excel 的次序排。 */
export function cmp(a: Val, b: Val): number {
  if (typeof a === "number" && typeof b === "number") {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    // 逻辑值只跟「能当数字的东西」比大小（TRUE ≡ 1）；跟文本不比数值 ——
    // Excel 的次序是 数字 < 文本 < 逻辑值，所以 `TRUE = "1"` 是 FALSE，不是相等。
    const x = cmpNum(a);
    const y = cmpNum(b);
    // 逻辑值一定折成 0/1，所以这里至多一边是 null（另一边是文本）：文本排前面。
    if (x === null || y === null) return x === null ? -1 : 1;
    if (x < y) return -1;
    return x > y ? 1 : 0;
  }
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/* ---------------------------------------------------------------- 日期序列号 */

/** Excel 序列号 → 毫秒时间戳（1900 系统按 Excel 那个假的 1900-02-29 处理）。 */
export function serialToDate(serial: number, date1904 = false): Date {
  const days = Math.floor(serial);
  if (date1904) return new Date(Date.UTC(1904, 0, 1) + days * 86400000);
  return new Date(Date.UTC(1899, 11, days >= 60 ? 30 : 31) + days * 86400000);
}

/** 年月日 → 序列号（1900 系统；60 之前的数按 Excel 的 bug 口径）。 */
export function dateToSerial(y: number, mo: number, d: number, date1904 = false): number {
  if (date1904) {
    const base = Date.UTC(1904, 0, 1);
    return Math.round((Date.UTC(y, mo - 1, d) - base) / 86400000);
  }
  const base = Date.UTC(1899, 11, y === 1900 && mo === 1 ? 31 : 30);
  let serial = Math.round((Date.UTC(y, mo - 1, d) - base) / 86400000);
  if (y === 1900 && mo === 1 && d === 31) serial = 31;
  return serial;
}

/** 序列号 → 年月日时分秒。 */
export function partsOf(serial: number, date1904 = false): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const total = Math.round(serial * 86400);
  const days = Math.floor(total / 86400);
  const rest = total - days * 86400;
  const dt = serialToDate(days, date1904);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    wd: dt.getUTCDay(),
    h: Math.floor(rest / 3600),
    mi: Math.floor((rest % 3600) / 60),
    s: rest % 60,
  };
}

export function serialToday(): number {
  const now = new Date();
  const days = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(1899, 11, 30);
  return Math.floor(days / 86400000);
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 那个月有几天（2 月按公历闰年算）。1900-02-29 是 Excel 的假闰日，我们认不出：它只会撞上 3 月 1 日。 */
function daysInMonth(y: number, mo: number): number {
  if (mo === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) return 29;
  return MONTH_DAYS[mo - 1]!;
}

/**
 * 把 `2024-01-05`、`2024/1/5`、`2024年1月5日`、`1/5/2024`、`18:30`、`2024-01-05 18:30`
 * 这类串解成序列号。认不出来返回 null（不猜）。
 */
export function dateSerialOf(text: string, date1904 = false): number | null {
  const t = text.trim();
  if (!t) return null;
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (timeOnly) {
    const h = Number(timeOnly[1]);
    const mi = Number(timeOnly[2]);
    const s = Number(timeOnly[3] ?? 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    return (h * 3600 + mi * 60 + s) / 86400;
  }
  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:时]\s*(\d{1,2})(?:\s*[:分]\s*(\d{1,2}))?\s*秒?)?$/.exec(t);
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t);
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0;
  if (cn) {
    y = Number(cn[1]);
    mo = Number(cn[2]);
    d = Number(cn[3]);
    h = Number(cn[4] ?? 0);
    mi = Number(cn[5] ?? 0);
    s = Number(cn[6] ?? 0);
  } else if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
    h = Number(iso[4] ?? 0);
    mi = Number(iso[5] ?? 0);
    s = Number(iso[6] ?? 0);
  } else if (us) {
    mo = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
  } else {
    // 只写月份名（Jan 5 2024 / 5-Jan-2024）
    const named = /^(\d{1,2})[-\s]+([A-Za-z]{3,})[-\s,]+(\d{4})$/.exec(t) ?? /^([A-Za-z]{3,})[-\s]+(\d{1,2})[-\s,]+(\d{4})$/.exec(t);
    if (!named) return null;
    const first = named[1]!;
    const isMonthFirst = !/^\d+$/.test(first);
    const monthText = (isMonthFirst ? first : named[2]!).slice(0, 3).toLowerCase();
    const idx = MONTH_NAMES.indexOf(monthText);
    if (idx < 0) return null;
    mo = idx + 1;
    d = Number(isMonthFirst ? named[2] : first);
    y = Number(named[3]);
  }
  if (mo < 1 || mo > 12 || d < 1) return null;
  // `Date.UTC(2024, 1, 31)` 会静默进位到 3 月 2 日：拿它当筛选条件就成了另一天。
  // 非法日期一律认不出（返回 null），让调用方报 #VALUE! 或按文本比。
  if (d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const serial = dateToSerial(y, mo, d, date1904);
  return serial + (h * 3600 + mi * 60 + s) / 86400;
}

/* ---------------------------------------------------------------- 条件匹配 */

/** `*` / `?` 通配（`~*` 是字面量星号），大小写不敏感——Excel 的 COUNTIF 就是这么比的。 */
export function wildcardRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~") {
      const next = pattern[++i];
      out += next ? next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "~";
    } else if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** 把 COUNTIF 的条件文本变成判定函数。数字比较、文本比较、通配、日期串都认。 */
export function criteria(re: string, date1904 = false): (v: Val) => boolean {
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(re.trim())!;
  const op = m[1] ?? "=";
  const raw = m[2] ?? "";
  const asDate = raw === "" ? null : dateSerialOf(raw, date1904);
  const num = Number(raw);
  const isnum = raw !== "" && Number.isFinite(num) && !/[?]/.test(raw) && !/[a-z]{2,}/i.test(raw);
  const rx = /[*?]/.test(raw) && (op === "=" || op === "<>") ? wildcardRegex(raw) : null;
  const low = raw.toLowerCase();

  return (v: Val) => {
    if (op === "<>" && raw === "") return v !== null && v !== "";
    if (op === "=" && raw === "") return v === null || v === "";
    // 错误值不参与匹配（Excel 的 COUNTIF 直接不算这一格）
    if (v === null) {
      return op === "<>" ? true : op === "=" ? raw === "" : false;
    }
    if (rx && typeof v === "string") return op === "<>" ? !rx.test(v) : rx.test(v);
    if (asDate !== null && (typeof v === "number" || typeof v === "string")) {
      const target = typeof v === "number" ? v : dateSerialOf(v, date1904);
      if (target !== null && target !== undefined) {
        switch (op) {
          case "=":
            return Math.abs(target - asDate) < 1e-9;
          case "<>":
            return Math.abs(target - asDate) >= 1e-9;
          case "<":
            return target < asDate;
          case ">":
            return target > asDate;
          case "<=":
            return target <= asDate;
          case ">=":
            return target >= asDate;
        }
      }
    }
    if (isnum && typeof v === "number") {
      switch (op) {
        case "=":
          return v === num;
        case "<>":
          return v !== num;
        case "<":
          return v < num;
        case ">":
          return v > num;
        case "<=":
          return v <= num;
        case ">=":
          return v >= num;
      }
    }
    const a = typeof v === "string" ? v.toLowerCase() : v === null ? "" : String(v).toLowerCase();
    switch (op) {
      case "=":
        return a === low;
      case "<>":
        return a !== low;
      case "<":
        return a < low;
      case ">":
        return a > low;
      case "<=":
        return a <= low;
      case ">=":
        return a >= low;
    }
    return false;
  };
}
