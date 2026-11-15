/**
 * 前端这边的一小份数字格式预览（D266）。
 *
 * 真正的口径在桥端（`bridge/src/sheet/numfmt.ts`，读文件里的 `numFmt` 代码算显示串）。
 * 但用户在功能区里点「中文大写数字」时，格子要**立刻**变样，不能等存盘再重开——所以这里
 * 按功能区的固定菜单（`ribbon.ts` 里那 20 来个代码）再算一遍，只认这些代码；
 * 认不出来就返回 null，调用方继续用桥端给的显示串，绝不自己编一个数出来。
 */
// i18n-ignore-start 这里的中文是「点」「负」这类数字记号本身，不是界面文案，翻译了就错了。

/** 中文数字（DBNum1 小写 / DBNum2 大写 / DBNum3 全角）。 */
const CN_LOW = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const CN_UP = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const CN_FULL = ["０", "１", "２", "３", "４", "５", "６", "７", "８", "９"];
const UNIT_LOW = ["", "十", "百", "千"];
const UNIT_UP = ["", "拾", "佰", "仟"];
const GROUP_UNIT = ["", "万", "亿", "万亿"];

function cnInteger(n: number, style: number): string {
  const digits = style === 3 ? CN_FULL : style === 1 ? CN_LOW : CN_UP;
  const units = style === 1 ? UNIT_LOW : UNIT_UP;
  if (n === 0) return digits[0]!;
  const groups: number[] = [];
  let rest = Math.floor(n);
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let out = "";
  let pendingZero = false;
  for (let g = groups.length - 1; g >= 0; g--) {
    const v = groups[g]!;
    if (v === 0) {
      pendingZero = out !== "";
      continue;
    }
    if (out && (pendingZero || v < 1000)) out += digits[0];
    let part = "";
    for (let u = 3; u >= 0; u--) {
      const d = Math.floor(v / Math.pow(10, u)) % 10;
      if (d === 0) {
        if (part && !part.endsWith(digits[0]!)) part += digits[0];
        continue;
      }
      part += digits[d]! + units[u]!;
    }
    out += part.replace(new RegExp(`${digits[0]}+$`), "") + GROUP_UNIT[g]!;
    pendingZero = false;
  }
  return out;
}

function cnNumber(value: number, style: number, decimals: number): string {
  const digits = style === 3 ? CN_FULL : style === 1 ? CN_LOW : CN_UP;
  const fixed = Math.abs(value).toFixed(Math.min(decimals, 15));
  const [int, frac = ""] = fixed.split(".");
  let out = cnInteger(Number(int || "0"), style);
  if (frac && Number(frac) !== 0) out += `点${[...frac].map((d) => digits[Number(d)]!).join("")}`;
  return value < 0 ? `负${out}` : out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function serialParts(serial: number): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  const total = Math.round(serial * 86400);
  const days = Math.floor(total / 86400);
  const rest = total - days * 86400;
  const dt = new Date(Date.UTC(1899, 11, days >= 60 ? 30 : 31) + days * 86400000);
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

const pad = (n: number, w = 2): string => String(Math.trunc(n)).padStart(w, "0");

/** 按顶层 `;` 分段（引号里的不算）。 */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"') quote = !quote;
    if (ch === ";" && !quote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 去掉 [DBNum2] / [红色] / [$-804] 这类方括号，返回正文和中文数字样式。 */
function stripBrackets(section: string): { text: string; dbnum: number } {
  let dbnum = 0;
  let text = "";
  for (let i = 0; i < section.length; i++) {
    const ch = section[i]!;
    if (ch === "[") {
      const end = section.indexOf("]", i);
      const inside = end < 0 ? "" : section.slice(i + 1, end);
      const m = /^dbnum\s*(\d+)$/i.exec(inside);
      if (m) dbnum = Number(m[1]);
      const cur = /^\$(.+?)(?:-|$)/.exec(inside);
      if (cur && cur[1] && !/^\$?RMB$/i.test(inside)) text += cur[1].replace(/-.*$/, "");
      i = end < 0 ? section.length : end;
      continue;
    }
    text += ch;
  }
  return { text, dbnum };
}

function numberPart(text: string, value: number): string | null {
  const percent = (text.match(/%/g) ?? []).length;
  const body = /[0#?][0#?,.]*/.exec(text);
  if (!body) return null;
  const raw = body[0];
  // 末尾的逗号是「除以 1000」，中间的才是千分位
  const lastDigit = Math.max(raw.lastIndexOf("0"), raw.lastIndexOf("#"), raw.lastIndexOf("?"));
  const tail = raw.slice(lastDigit + 1);
  const scale = (tail.match(/,/g) ?? []).length;
  const core = raw.slice(0, lastDigit + 1);
  const dot = core.indexOf(".");
  const intPart = (dot < 0 ? core : core.slice(0, dot)).replace(/[^0#?]/g, "");
  const decPart = dot < 0 ? "" : core.slice(dot + 1).replace(/[^0#?]/g, "");
  const thousands = core.slice(0, dot < 0 ? core.length : dot).includes(",");

  let n = Math.abs(value);
  if (percent) n *= Math.pow(100, percent);
  if (scale) n /= Math.pow(1000, scale);
  const abs = n + n * 1e-12;
  const fixed = abs.toFixed(Math.min(decPart.length, 15));
  const [int, frac = ""] = fixed.split(".");

  let decOut = "";
  for (let i = 0; i < decPart.length; i++) {
    const ch = decPart[i]!;
    const digit = frac[i];
    if (digit === undefined) decOut += ch === "0" ? "0" : ch === "?" ? " " : "";
    else decOut += digit;
  }
  while (decOut.length && decOut.endsWith("0") && decPart[decOut.length - 1] === "#") decOut = decOut.slice(0, -1);
  if (!/[^ ]/.test(decOut)) decOut = decOut.replace(/ +$/, "");

  let intOut = int ?? "0";
  const zeros = (intPart.match(/0/g) ?? []).length;
  if (zeros > intOut.length) intOut = "0".repeat(zeros - intOut.length) + intOut;
  if (thousands) intOut = intOut.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const head = text.slice(0, body.index);
  const suffix = text.slice(body.index + raw.length);
  const sign = value < 0 ? "-" : "";
  return `${sign}${head}${decOut ? `${intOut}.${decOut}` : intOut}${suffix.replace(/^,/, "")}`;
}

function datePart(text: string, value: number): string {
  const p = serialParts(value);
  const twelve = /AM\/PM|A\/P/i.test(text);
  const elapsedH = Math.floor(Math.abs(value) * 24);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    const lower = ch.toLowerCase();
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      out += text.slice(i + 1, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (lower === "[" && /^\[[hms]+\]/i.test(text.slice(i))) {
      const token = /^\[([hms]+)\]/i.exec(text.slice(i))!;
      out += String(elapsedH).padStart(token[1]!.length, "0");
      i += token[0].length;
      continue;
    }
    if (!"ymdhs".includes(lower)) {
      if (/^am\/pm/i.test(text.slice(i))) {
        out += p.h < 12 ? "AM" : "PM";
        i += 5;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    let len = 1;
    while (i + len < text.length && text[i + len]!.toLowerCase() === lower) len++;
    const rest = text.slice(i + len);
    if (lower === "y") out += len >= 3 ? pad(p.y, 4) : pad(p.y % 100);
    else if (lower === "m") {
      // 紧跟 h、或后面接 s 的 m 是分钟
      const prevChar = out.trim().slice(-1);
      const isMinute = prevChar === "" ? false : /[h:]/.test(prevChar) || /^\s*:?\s*s/i.test(rest);
      if (isMinute) out += pad(p.mi, len >= 2 ? 2 : 1);
      else if (len >= 4) out += MONTHS[p.mo - 1];
      else if (len === 3) out += MONTHS[p.mo - 1]!.slice(0, 3);
      else out += pad(p.mo, len >= 2 ? 2 : 1);
    } else if (lower === "d") {
      if (len >= 4) out += DAYS[p.wd];
      else if (len === 3) out += DAYS[p.wd]!.slice(0, 3);
      else out += pad(p.d, len >= 2 ? 2 : 1);
    } else if (lower === "h") {
      const hour = twelve ? (p.h % 12 === 0 ? 12 : p.h % 12) : p.h;
      out += pad(hour, len >= 2 ? 2 : 1);
    } else if (lower === "s") out += pad(Math.round(p.s), len >= 2 ? 2 : 1);
    i += len;
  }
  return out;
}

/**
 * 一个数字按功能区菜单里的代码显示成什么。认不出的代码返回 null（调用方退回桥端的显示串）。
 */
export function formatLocal(value: number, code: string): string | null {
  if (!Number.isFinite(value)) return null;
  const sections = splitSections(code);
  let sec = sections[0] ?? "";
  let v = value;
  if (value < 0 && sections.length > 1) {
    sec = sections[1] ?? sec;
    v = -value;
  } else if (value === 0 && sections.length > 2) sec = sections[2] ?? sec;
  if (!sec.trim()) return String(v);

  const { text, dbnum } = stripBrackets(sec);
  const flat = text.replace(/\s/g, "");
  if (/^general$/i.test(flat) || /^g\/通用格式$/i.test(text.trim())) {
    if (dbnum) {
      const frac = String(Math.abs(v)).split(".")[1] ?? "";
      return cnNumber(v, dbnum, Math.min(4, frac.replace(/\D/g, "").length));
    }
    return Number.isInteger(v) ? String(v) : String(v);
  }
  if ("ymdhs".includes(text[0]?.toLowerCase() ?? "") || /\[[hms]\]/i.test(text) || /am\/pm/i.test(text)) return datePart(text, v);
  if (text.includes("@") && !/[0#?]/.test(text)) return text.replace(/@/g, String(v));
  if (/[?]/.test(text) && text.includes("/")) return null; // 分数：交回桥端
  if (/E[+-]/i.test(text)) return null; // 科学记数：交回桥端
  const out = numberPart(text, v < 0 ? -v : v);
  if (out === null) return null;
  return v < 0 && sections.length > 1 ? out : out;
}
// i18n-ignore-end
