/**
 * 数字 / 日期按 numFmt 显示（D116）。
 *
 * exceljs 读文件时**不套 numFmt**：带 `yyyy/m/d` 的格子 `cell.text` 给的是
 * `Thu Aug 27 2026 00:00:00 GMT+0800 (China Standard Time)`，带 `0.0` 的给 `2`。
 * 这两句直接贴到网格里就是「不像 Excel」，所以自己写一层格式化，覆盖真实报表里常见的写法：
 *
 *   日期  yyyy/m/d  yyyy年m月d日  m/d/yy  yyyy-mm-dd hh:mm  h:mm:ss  [$-\u3010]\u3010...
 *   数字  0  0.0  0.00  #,##0  #,##0.00  0%  0.0%  ¥#,##0  #,##0_);
 *   多段  「正数;负数;零」按值挑一段
 *
 * 认不出来的格式退回 `String(value)`，不猜。
 */

export function formatCell(value: unknown, numFmt?: string, date1904 = false): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return formatDate(value, numFmt || "yyyy/m/d");
  if (typeof value === "number") return formatNumber(value, numFmt);
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const anyValue = value as any;
    if ("result" in anyValue) return formatCell(anyValue.result, numFmt, date1904);
    if ("text" in anyValue) return String(anyValue.text ?? "");
    if ("richText" in anyValue) return (anyValue.richText as any[]).map((p) => p?.text ?? "").join("");
    if ("error" in anyValue) return String(anyValue.error);
  }
  return String(value);
}

const DAY = 86400000;

export function formatDate(date: Date, numFmt: string): string {
  const fmt = numFmt.replace(/\[\$-[0-9A-Fa-f]+\]/g, "").replace(/\[(?!h\])[^\]]*\]/g, "");
  const parts = splitSections(fmt);
  const section = parts[0] ?? "yyyy/m/d";
  const y = date.getFullYear();
  const mon = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const min = date.getMinutes();
  const sec = date.getSeconds();
  const weeks = ["日", "月", "火", "水", "木", "金", "土"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const out: string[] = [];
  let last = "";
  for (const token of tokens(section)) {
    if (token.literal != null) {
      out.push(token.literal);
      continue;
    }
    const t = token.code!;
    const lower = t[0].toLowerCase();
    if (lower === "y") out.push(t.length >= 4 ? String(y) : pad(y % 100));
    else if (lower === "m") {
      // `m` 紧跟在小时后面（或紧挨着秒）就是「分钟」。
      const minute = last === "h" || token.next === "s";
      out.push(minute ? (t.length >= 2 ? pad(min) : String(min)) : t.length === 1 ? String(mon) : pad(mon));
    } else if (lower === "d") {
      if (t.length >= 4) out.push(["日", "月", "火", "水", "木", "金", "土"][date.getDay()]);
      else if (t.length === 3) out.push(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]);
      else out.push(t.length >= 2 ? pad(day) : String(day));
    } else if (lower === "h") out.push(/AM\/PM|A\/P/i.test(section) ? String(hour % 12 || 12) : t.length >= 2 ? pad(hour) : String(hour));
    else if (lower === "s") out.push(t.length >= 2 ? pad(sec) : String(sec));
    else if (/AM\/PM/i.test(t)) out.push(hour < 12 ? "AM" : "PM");
    else out.push(t);
    last = lower;
  }
  const text = out.join("");
  // 「Thu Aug 27 2026 …」这种根本不是格式串：退化成 ISO 日期。
  if (!/[0-9]/.test(text)) return `${y}/${mon}/${day}`;
  void DAY;
  void weeks;
  return text;
}

interface Token {
  code?: string;
  literal?: string;
  next?: string;
}

function tokens(section: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < section.length) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      out.push({ literal: section.slice(i + 1, end < 0 ? section.length : end) });
      i = end < 0 ? section.length : end + 1;
      continue;
    }
    if (ch === "\\" || ch === "!") {
      out.push({ literal: section[i + 1] ?? "" });
      i += 2;
      continue;
    }
    if (ch === "_" || ch === "*") {
      i += 2; // `_x` 占位、`*x` 填充：显示时都当没有
      continue;
    }
    if ("yYmMdDhHsS".includes(ch)) {
      let j = i;
      while (j < section.length && section[j] === ch) j++;
      out.push({ code: section.slice(i, j) });
      i = j;
      continue;
    }
    if (/^AM\/PM$/i.test(section.slice(i, i + 5))) {
      out.push({ code: "AM/PM" });
      i += 5;
      continue;
    }
    out.push({ literal: ch });
    i++;
  }
  // 给每个 code 标上下一个 code，用来区分「m=月」和「m=分」。
  for (let k = 0; k < out.length; k++) {
    const next = out.slice(k + 1).find((t) => t.code);
    out[k].next = next ? next.code![0].toLowerCase() : "";
  }
  return out;
}

function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      out.push(buf);
      buf = "";
      continue;
    }
    if (ch === "\\" && !quoted) {
      buf += ch + (fmt[i + 1] ?? "");
      i++;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function formatNumber(value: number, numFmt?: string): string {
  if (!numFmt || numFmt === "General" || numFmt === "@") return trimNumber(value);
  const sections = splitSections(numFmt);
  const section = value < 0 && sections[1] ? sections[1] : value === 0 && sections[2] ? sections[2] : sections[0];
  if (!section || !/[0#?]/.test(section)) return trimNumber(value);
  const pct = section.includes("%");
  const numeric = /[#,0?]+(?:\.[0#?]+)?/.exec(section);
  if (!numeric) return trimNumber(value);
  const spec = numeric[0];
  const decimals = /\.([0#?]+)/.exec(spec)?.[1].length ?? 0;
  const grouping = /,#|,#/.test(spec) || spec.includes(",");
  const negative = value < 0 || (value === 0 && sections[2] === section && false);
  let n = Math.abs(pct ? value * 100 : value);
  let body = n.toFixed(decimals);
  if (grouping) {
    const [int, frac] = body.split(".");
    body = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac != null ? `.${frac}` : "");
  }
  const prefix = clean(section.slice(0, numeric.index), negative);
  const suffix = clean(section.slice(numeric.index + spec.length), negative);
  const pctSuffix = pct && !suffix.includes("%") ? "%" : "";
  void n;
  return `${prefix}${body}${suffix}${pctSuffix}`;
}

/** 格式串里的前后缀：去掉引号、下划线占位，保留 ¥ $ kg 这类真正的文字。 */
function clean(part: string, negative: boolean): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "\\" || ch === "!") {
      out += part[i + 1] ?? "";
      i++;
      continue;
    }
    if (!quoted) {
      if (ch === "_" || ch === "*") {
        i++;
        continue;
      }
      if (ch === "[") {
        const end = part.indexOf("]", i);
        const inner = part.slice(i + 1, end < 0 ? part.length : end);
        i = end < 0 ? part.length : end;
        // 颜色 / 条件（[Red]、[>=100]）不显示；[$¥-804] 这类取货币符号。
        const cur = /^\$([^\-]*)/.exec(inner)?.[1];
        if (cur) out += cur;
        continue;
      }
      if ("0#?,.%".includes(ch)) {
        if (ch === "%") out += "";
        continue;
      }
    }
    out += ch;
  }
  return negative && out === "-" ? "-" : out;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}
