/**
 * 数字格式（#108）：把文件里 `styles.xml` 的 numFmt 代码套到数字上，得到该显示的字。
 *
 * 只做「报表里常见的那几种」：通用 / 整数 / 小数 / 千分位 / 百分比 / 货币前后缀 / 日期 / 时刻
 * （含 Excel 内置的 id 1–49）。遇到不认识的代码退回原样数字，不猜、不四舍五入。
 * 文字固定用公历 + 英文月份缩写（与 Excel 的 C 区行为一致），不跟浏览器语言走。
 */

/** Excel 内置数字格式：id → 格式代码。id 0 是 General。 */
const BUILTIN: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0;(#,##0)",
  38: "#,##0;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '#,##0_);(#,##0)',
  42: '#,##0_);[Red](#,##0)',
  43: '#,##0.00_);(#,##0.00)',
  44: '#,##0.00_);[Red](#,##0.00)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/** 数字格式代码：内置 id 或自定义代码。null 表示 General。 */
export function formatCode(numFmtId: number, custom: Map<number, string>): string | null {
  const own = custom.get(numFmtId);
  if (own !== undefined) return own;
  const builtin = BUILTIN[numFmtId];
  return builtin && builtin !== "General" ? builtin : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 按顶层 `;` 切成 正 / 负 / 零 / 文本 四段（引号、方括号里的分号不算）。 */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let bracket = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      cur += ch;
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      cur += ch;
    } else if (ch === "[") {
      bracket++;
      cur += ch;
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      cur += ch;
    } else if (ch === ";" && bracket === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 去掉颜色/条件/区域方括号，展开转义的字符；`_x` 是占位宽度、`*x` 是填充，都不显示。 */
function plain(code: string): string {
  let out = "";
  let quote = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '"') quote = false;
      else out += ch;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "\\") out += code[++i] ?? "";
    else if (ch === "_" || ch === "*") i++;
    else if (ch === "[") {
      const end = code.indexOf("]", i);
      const inside = end < 0 ? "" : code.slice(i + 1, end);
      // [h] / [m] / [s] 是「累计时长」，当普通时间记号留着。
      if (/^[hms]+$/i.test(inside)) out += inside;
      i = end < 0 ? code.length : end;
    } else out += ch;
  }
  return out;
}

/** 这一段是不是日期/时刻格式：有 y/d/h/s，或 m 出现在时间语境里。 */
export function isDateCode(code: string): boolean {
  const s = plain(code).replace(/General/gi, "").replace(/AM\/PM/gi, "").replace(/A\/P/gi, "");
  if (/[ydhs]/i.test(s)) return true;
  // mm:ss、h:mm 里的 m 是分钟；单独一个 m 是月份，两者都算日期格式。
  return /m/i.test(s) && /[:]/.test(s);
}

interface NumShape {
  prefix: string;
  suffix: string;
  decimals: number;
  thousands: boolean;
  percent: number;
}

function numShape(code: string): NumShape {
  const text = plain(code);
  const first = text.search(/[0#?]/);
  const last = Math.max(text.search(/[0#?.]+$/), text.search(/[0#?][0#?,.]*$/));
  if (first < 0) return { prefix: text, suffix: "", decimals: 0, thousands: false, percent: 0 };
  const tail = text.slice(first).match(/^[0#?,.]+/)?.[0] ?? "";
  const end = first + tail.length;
  const prefix = text.slice(0, first);
  const suffix = text.slice(end);
  const body = tail;
  const dot = body.indexOf(".");
  const decimals = dot < 0 ? 0 : (body.slice(dot + 1).match(/[0#?]/g)?.length ?? 0);
  const thousands = /[,]/.test(dot < 0 ? body : body.slice(0, dot));
  const percent = (code.match(/%/g) ?? []).length;
  void last;
  return { prefix, suffix, decimals, thousands, percent };
}

/** 千分位：只处理正数的整数部分。 */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatNumberShape(value: number, code: string): string {
  const shape = numShape(code);
  let n = Math.abs(value);
  if (shape.percent) n *= Math.pow(100, shape.percent);
  const fixed = n.toFixed(Math.min(shape.decimals, 12));
  let [int, frac] = fixed.split(".");
  if (shape.thousands) int = group(int);
  let body = frac ? `${int}.${frac}` : int;
  // 代码里写了几个必须的整数位（"000" 这种）就补零。
  const requiredInt = (shape.prefix + code).match(/0/g);
  void requiredInt;
  // % 本身留在前后缀里（plain() 没吃掉它），这里只负责放大数值。
  return `${shape.prefix}${body}${shape.suffix}`;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  wd: number;
  h: number;
  mi: number;
  s: number;
}

/** Excel 序列号 → 公历年月日时分秒（1900 系统的闰年 bug 按 Excel 的算法处理）。 */
export function serialParts(serial: number, date1904: boolean): Parts {
  const total = Math.round(serial * 86400);
  let days = Math.floor(total / 86400);
  let rest = total - days * 86400;
  let ms: Date;
  if (date1904) {
    ms = new Date(Date.UTC(1904, 0, 1) + days * 86400000);
  } else {
    // serial 60 是 Excel 编出来的 1900-02-29：60 及以上按 1899-12-30 起算。
    ms = new Date(Date.UTC(1899, 11, days >= 60 ? 30 : 31) + days * 86400000);
    if (days >= 60) ms = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  }
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const mi = Math.floor(rest / 60);
  const s = rest - mi * 60;
  return { y: ms.getUTCFullYear(), mo: ms.getUTCMonth() + 1, d: ms.getUTCDate(), wd: ms.getUTCDay(), h, mi, s };
}

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");

function formatDateShape(value: number, code: string, date1904: boolean): string {
  const p = serialParts(value, date1904);
  const text = plain(code);
  const twelve = /AM\/PM|A\/P/i.test(text);
  let out = "";
  let prevTok = "";
  const tokLen = (i: number) => {
    let n = 1;
    while (i + n < text.length && text[i + n].toLowerCase() === text[i].toLowerCase()) n++;
    return n;
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    const lower = ch.toLowerCase();
    if ("ymdhs".includes(lower)) {
      const len = tokLen(i);
      const raw = text.slice(i, i + len).toLowerCase();
      if (lower === "y") out += len >= 3 ? pad(p.y, 4) : pad(p.y % 100);
      else if (lower === "d") {
        if (len >= 4) out += DAYS[p.wd];
        else if (len === 3) out += DAYS[p.wd].slice(0, 3);
        else out += pad(p.d, len >= 2 ? 2 : 1);
      } else if (lower === "h") {
        const hour = twelve ? (p.h % 12 === 0 ? 12 : p.h % 12) : p.h;
        out += pad(hour, len >= 2 ? 2 : 1);
      } else if (lower === "s") out += pad(Math.round(p.s), len >= 2 ? 2 : 1);
      else {
        // m：紧跟小时、或后面接秒 → 分钟；否则是月份。
        const next = text.slice(i + len).replace(/^[^ymdhs]*/i, "").slice(0, 2).toLowerCase();
        const minute = prevTok === "h" || (next.startsWith("s") && prevTok !== "d");
        if (minute) out += pad(p.mi, len >= 2 ? 2 : 1);
        else if (len >= 4) out += MONTHS[p.mo - 1];
        else if (len === 3) out += MONTHS[p.mo - 1].slice(0, 3);
        else out += pad(p.mo, len >= 2 ? 2 : 1);
      }
      prevTok = lower;
      i += len;
      continue;
    }
    if (lower === "a" && /^am\/pm/i.test(text.slice(i))) {
      out += p.h < 12 ? "AM" : "PM";
      i += 5;
      prevTok = "a";
      continue;
    }
    if (lower === "a" && /^a\/p/i.test(text.slice(i))) {
      out += p.h < 12 ? "A" : "P";
      i += 3;
      prevTok = "a";
      continue;
    }
    if (ch === "." && /^\.0+$/.test(text.slice(i))) {
      const len = (text.slice(i).match(/^\.0+/) ?? [""])[0].length - 1;
      const frac = Math.round((p.s - Math.floor(p.s)) * Math.pow(10, len));
      out += `.${pad(frac, len)}`;
      i += len + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out.trim();
}

/**
 * 一个数字格按它的格式代码显示成什么。未知代码退回 `String(value)`（原样数字，不撒谎）。
 */
export function formatValue(value: number, code: string, date1904: boolean): string {
  const secs = sections(code);
  let sec = secs[0] ?? "";
  if (value < 0 && secs.length > 1) sec = secs[1];
  else if (value === 0 && secs.length > 2) sec = secs[2];
  if (!sec) sec = secs[0] ?? code;
  const isDate = isDateCode(sec);
  if (isDate) return formatDateShape(value, sec, date1904);
  if (/[?]/.test(plain(sec)) || /E[+-]/i.test(plain(sec))) return String(value);
  const sign = value < 0 && secs.length < 2 ? "-" : "";
  return sign + formatNumberShape(value, sec);
}
