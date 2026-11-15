/**
 * 数字格式（#108 / D266）：把文件里 `styles.xml` 的 numFmt 代码套到数字上，得到该显示的字。
 *
 * 这一版按 WPS（`Resources/office6/mui/zh_CN/config/numberformat.cfg`、
 * `datetimeformat.cfg`）里那一套格式代码重写过：分区（正;负;零;文本）、
 * 字面量与转义、`#`/`0`/`?` 三种占位、千分位与「缩放逗号」、百分比、
 * 科学记数、分数、日期与累计时长（`[h]`）、中文数字（`[DBNum1/2/3]`）都认。
 * 认不出来的代码退回 `General` 的样子（原样数字），不猜、不四舍五入。
 *
 * 月份 / 星期仍用英文（与 Excel 的 C 区行为一致，不跟浏览器语言走）。
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

/** 反查：这条代码是哪个内置 id（写回 xlsx 时能少造一条自定义 numFmt）。 */
export function builtinFormatId(code: string): number | null {
  const want = code.trim();
  for (const [id, builtin] of Object.entries(BUILTIN)) if (builtin === want) return Number(id);
  return null;
}

/** 数字格式代码：内置 id 或自定义代码。null 表示 General。 */
export function formatCode(numFmtId: number, custom: Map<number, string>): string | null {
  const own = custom.get(numFmtId);
  // 有的生成器把 General 存成自定义格式（164 "General"）：它还是 General，不能当字面量
  // 拼到数字前面，否则 2 会显示成 General2。
  if (own !== undefined) return own.trim().toLowerCase() === "general" ? null : own;
  const builtin = BUILTIN[numFmtId];
  return builtin && builtin !== "General" ? builtin : null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ---------------------------------------------------------------- 分段 */

/** 按顶层 `;` 切成 正 / 负 / 零 / 文本 四段（引号、方括号里的分号不算）。 */
export function sections(code: string): string[] {
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
    } else if (ch === "\\" && i + 1 < code.length) {
      cur += ch + code[++i];
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* ---------------------------------------------------------------- 词法 */

type Node =
  | { t: "lit"; s: string }
  | { t: "digit"; ch: "0" | "#" | "?" }
  | { t: "point" }
  | { t: "comma" }
  | { t: "pct" }
  | { t: "slash" }
  | { t: "date"; ch: string; len: number }
  | { t: "ampm"; s: string }
  | { t: "elapsed"; ch: "h" | "m" | "s"; len: number }
  | { t: "at" }
  | { t: "dbnum"; style: number }
  | { t: "space" };

const DATE_CHARS = "ymdhs";

/** 把一段格式代码切成节点。认不出的字符一律当字面量。 */
/** 引号里的 `.` / `,` 夹在数字位中间时其实是小数点 / 千分位（`0"."0,` 这种写法很常见）。 */
function promoteSeparators(nodes: Node[]): Node[] {
  return nodes.map((n, i) => {
    if (n.t !== "lit" || (n.s !== "." && n.s !== ",")) return n;
    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    if (prev?.t !== "digit" || next?.t !== "digit") return n;
    return n.s === "." ? ({ t: "point" } as Node) : ({ t: "comma" } as Node);
  });
}

function lex(src: string): Node[] {
  const out: Node[] = [];
  let dbnum = -1;
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      out.push({ t: "lit", s: src.slice(i + 1, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === "\\") {
      out.push({ t: "lit", s: src[i + 1] ?? "" });
      i += 2;
      continue;
    }
    if (ch === "[") {
      const end = src.indexOf("]", i);
      const inside = end < 0 ? "" : src.slice(i + 1, end);
      i = end < 0 ? src.length : end + 1;
      if (/^[hms]+$/i.test(inside)) {
        const k = inside[0].toLowerCase() as "h" | "m" | "s";
        out.push({ t: "elapsed", ch: k, len: inside.length });
      } else if (/^dbnum\s*\d+$/i.test(inside)) {
        dbnum = Number(/(\d+)/.exec(inside)?.[1] ?? 1);
        out.push({ t: "dbnum", style: dbnum });
      } else if (/^\$/.test(inside)) {
        // [$¥-804] / [$RMB] / [$-411]：方括号里 `-` 之前是货币符号，之后是区域号。
        const sym = inside.slice(1).split("-")[0] ?? "";
        if (sym) out.push({ t: "lit", s: sym });
      } else if (/^[a-z]+$/i.test(inside) && !/^(red|black|blue|cyan|green|magenta|white|yellow|color\d*)$/i.test(inside)) {
        // 其它 [xxx]（条件、区域号之类）不显示。
      }
      continue;
    }
    if (ch === "_") {
      // `_)` 是「占一个 ) 的宽度」；预览里给一个空格就够。
      out.push({ t: "space" });
      i += 2;
      continue;
    }
    if (ch === "*") {
      // `*x` 是填充，预览里不重复画。
      i += 2;
      continue;
    }
    if (ch === "0" || ch === "#" || ch === "?") {
      out.push({ t: "digit", ch });
      i++;
      continue;
    }
    if (ch === "@") {
      out.push({ t: "at" });
      i++;
      continue;
    }
    if (ch === ".") {
      out.push({ t: "point" });
      i++;
      continue;
    }
    if (ch === ",") {
      out.push({ t: "comma" });
      i++;
      continue;
    }
    if (ch === "%") {
      out.push({ t: "pct" });
      i++;
      continue;
    }
    if (ch === "/") {
      out.push({ t: "slash" });
      i++;
      continue;
    }
    const lower = ch.toLowerCase();
    if (DATE_CHARS.includes(lower)) {
      // 只把「日期语境」里的字母当日期记号：跟着 AM/PM 的 a、普通单词里的字母都不是。
      let len = 1;
      while (i + len < src.length && src[i + len].toLowerCase() === lower) len++;
      out.push({ t: "date", ch: lower, len });
      i += len;
      continue;
    }
    if (/^am\/pm/i.test(src.slice(i))) {
      out.push({ t: "ampm", s: "ampm" });
      i += 5;
      continue;
    }
    if (/^a\/p/i.test(src.slice(i))) {
      out.push({ t: "ampm", s: "ap" });
      i += 3;
      continue;
    }
    if (/^(上午\/下午|上午\/pm)/.test(src.slice(i))) {
      out.push({ t: "ampm", s: "cn" });
      i += 5;
      continue;
    }
    if (lower === "e" && /^e[+-]/i.test(src.slice(i))) {
      // 科学记数的指数记号，交给数字段处理：这里塞一个标记字面量，稍后单独解析。
      out.push({ t: "lit", s: src.slice(i, i + 2).toUpperCase() });
      i += 2;
      continue;
    }
    if (lower === "g" && /^g\/通用格式/i.test(src.slice(i))) {
      out.push({ t: "lit", s: "\u0000GENERAL" }); // General 的占位：数字段按 General 画
      i += 6;
      continue;
    }
    out.push({ t: "lit", s: ch });
    i++;
  }
  void dbnum;
  return promoteSeparators(out);
}

/* ---------------------------------------------------------------- 判定 */

const has = (nodes: Node[], kind: Node["t"]): boolean => nodes.some((n) => n.t === kind);

/** 这一段是不是日期/时刻格式。 */
export function isDateCode(code: string): boolean {
  const nodes = lex(sections(code)[0] ?? "");
  return has(nodes, "date") || has(nodes, "elapsed") || has(nodes, "ampm");
}

/** 这一段是不是「General / 通用格式」。 */
function isGeneral(section: string): boolean {
  const s = section.replace(/\[[^\]]*\]/g, "").trim().toLowerCase();
  return s === "general" || s === "g/通用格式" || s === "";
}

/* ---------------------------------------------------------------- 数字段 */

interface Body {
  /** 数字段在节点里的起止下标（含头不含尾）。 */
  start: number;
  end: number;
  int: string;
  dec: string;
  thousands: boolean;
  /** 数字段后面紧跟的逗号个数：每个把数值除以 1000（WPS 的「单位：万元」就是这么写的）。 */
  scale: number;
  percent: number;
  /** 数字段后面紧跟 `E+` / `E-` 时的指数位数。 */
  exp: number;
  expSign: "-" | "+" | "";
}

const RUN = new Set(["digit", "point", "comma", "slash"]);

function findBody(nodes: Node[]): Body | null {
  let start = -1;
  let runEnd = -1;
  for (let i = 0; i < nodes.length; i++) {
    if (RUN.has(nodes[i].t)) {
      if (start < 0) start = i;
      runEnd = i + 1;
    } else if (start >= 0) break;
  }
  if (start < 0) return null;

  // 最后一个「数字位」之后跟着的逗号是缩放逗号（`0.0,` = 除以 1000），不是千分位。
  let lastDigit = runEnd - 1;
  while (lastDigit >= start && nodes[lastDigit].t !== "digit") lastDigit--;
  if (lastDigit < start) return null;
  let scale = 0;
  for (let i = lastDigit + 1; i < runEnd; i++) if (nodes[i].t === "comma") scale++;
  const bodyEnd = lastDigit + 1;

  const nums = nodes.slice(start, bodyEnd);
  const pointAt = nums.findIndex((n) => n.t === "point");
  const intNodes = pointAt < 0 ? nums : nums.slice(0, pointAt);
  const decNodes = pointAt < 0 ? [] : nums.slice(pointAt + 1);
  const commaAt = intNodes.findIndex((n) => n.t === "comma");
  const pick = (list: Node[]) => list.filter((n) => n.t === "digit").map((n) => (n as { ch: string }).ch).join("");
  const int = pick(intNodes);
  const dec = pick(decNodes);
  const percent = nodes.filter((n) => n.t === "pct").length;

  // 指数：数字段紧后面是 E+ / E- 再来一串 0
  let exp = 0;
  let expSign: "-" | "+" | "" = "";
  const after = nodes[bodyEnd];
  if (after && after.t === "lit" && /^E[+-]$/.test(after.s)) {
    expSign = after.s.endsWith("-") ? "-" : "+";
    let k = 0;
    for (let i = bodyEnd + 1; i < nodes.length && nodes[i].t === "digit"; i++) k++;
    exp = Math.max(1, k);
  }

  return { start, end: bodyEnd, int, dec, thousands: commaAt >= 0, scale, percent, exp, expSign };
}

/** 千分位：只处理整数部分。 */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 数字段 → 显示串（不含前后字面量）。 */
function numberBody(body: Body, value: number): string {
  const mixed = /[?#]/.test(body.int) || /[?#]/.test(body.dec) || !body.int;

  if (body.exp > 0) {
    const step = body.int.replace(/[^0#?]/g, "").length >= 3 ? 3 : 1;
    return scientific(value, body.dec.length, body.exp, body.expSign === "-" ? "-" : "+", step);
  }

  let n = value;
  if (body.percent) n *= Math.pow(100, body.percent);
  if (body.scale) n /= Math.pow(1000, body.scale);

  const decCount = Math.min(body.dec.length, 15);
  const abs = Math.abs(n);
  // JS 的 toFixed 按二进制值截断，1.005 会变成 1.00；Excel 按十进制四舍五入。
  const nudged = abs + (abs > 0 ? abs * 1e-12 : 0);
  let fixed = nudged.toFixed(decCount);
  let [int, frac = ""] = fixed.split(".");

  // `#` 位不补零（小数末尾的 0 去掉），`?` 位补空格，`0` 位补零。
  let decOut = "";
  for (let i = 0; i < decCount; i++) {
    const ch = body.dec[i] ?? "0";
    const digit = frac[i] ?? "";
    if (digit === "") {
      decOut += ch === "0" ? "0" : ch === "?" ? " " : "";
    } else decOut += digit;
  }
  // 末尾的 # 位（以及被它挡住的 0 位）不要
  while (decOut.length) {
    const idx = decOut.length - 1;
    const ch = body.dec[idx] ?? "0";
    if (decOut[idx] === "0" && ch === "#") decOut = decOut.slice(0, -1);
    else break;
  }
  if (!/[^ ]/.test(decOut)) decOut = decOut.replace(/ +$/, "");

  let intOut = int;
  const zeros = (body.int.match(/0/g) ?? []).length;
  if (zeros > intOut.length) intOut = "0".repeat(zeros - intOut.length) + intOut;
  if (body.thousands) intOut = group(intOut);
  if (!mixed && intOut === "") intOut = "0";
  if (mixed && intOut === "0" && !(body.int.match(/0/g) ?? []).length && !body.thousands) intOut = "";
  if (intOut === "" && decOut === "") intOut = "0";

  return decOut ? `${intOut}.${decOut}` : intOut;
}

function scientific(value: number, decimals: number, expDigits: number, sign: "-" | "+", step = 1): string {
  if (value === 0) return `${(0).toFixed(decimals)}E${sign === "-" ? "-" : "+"}${"0".repeat(expDigits)}`;
  const abs = Math.abs(value);
  const exp = Math.floor(Math.floor(Math.log10(abs)) / step) * step;
  const mant = value / Math.pow(10, exp);
  const t = mant.toFixed(decimals);
  const e = String(Math.abs(exp)).padStart(expDigits, "0");
  return `${t}E${exp < 0 ? "-" : "+"}${e}`;
}

/* ---------------------------------------------------------------- 中文数字 */

const CN_LOWER = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const CN_UPPER = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const CN_UNIT_L = ["", "十", "百", "千"];
const CN_UNIT_U = ["", "拾", "佰", "仟"];
const CN_GROUP_U = ["", "万", "亿", "万亿"];

function cnDigits(style: number): string[] {
  if (style === 3) return ["０", "１", "２", "３", "４", "５", "６", "７", "８", "９"];
  return style === 1 ? CN_LOWER : CN_UPPER;
}

/** 整数 → 中文数字（DBNum1 小写 / DBNum2 大写 / DBNum3 全角）。 */
function cnInteger(n: number, style: number): string {
  const digits = cnDigits(style);
  const units = style === 1 ? CN_UNIT_L : CN_UNIT_U;
  if (n === 0) return digits[0];
  const groups: number[] = [];
  let rest = Math.floor(n);
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let out = "";
  let pendingZero = false;
  for (let g = groups.length - 1; g >= 0; g--) {
    const v = groups[g];
    if (v === 0) {
      pendingZero = out !== "";
      continue;
    }
    if (out && (pendingZero || v < 1000)) out += digits[0];
    let part = "";
    for (let u = 3; u >= 0; u--) {
      const d = Math.floor(v / Math.pow(10, u)) % 10;
      if (d === 0) {
        if (part && !part.endsWith(digits[0])) part += digits[0];
        continue;
      }
      part += digits[d] + units[u];
    }
    out += part.replace(new RegExp(`${digits[0]}+$`), "") + CN_GROUP_U[g];
    pendingZero = false;
  }
  return out;
}

/** 带小数的中文数字：12.34 → 一十二点三四。 */
function cnNumber(value: number, style: number, decimals: number): string {
  const digits = cnDigits(style);
  const neg = value < 0;
  const fixed = Math.abs(value).toFixed(Math.min(decimals, 15));
  const [int, frac = ""] = fixed.split(".");
  let out = cnInteger(Number(int || "0"), style);
  if (frac && Number(frac) !== 0) out += `点${[...frac].map((d) => digits[Number(d)]).join("")}`;
  return neg ? `负${out}` : out;
}

/* ---------------------------------------------------------------- 分数 */

interface FracSpec {
  /** 整数部分的占位个数（`# ?/?` 里的 `#`）。0 表示没有整数部分。 */
  intPlaceholders: string;
  /** 分子占位个数。 */
  numDigits: number;
  /** 分母位数（`??/??` 是 2）；`fixedDen` 有值时按固定分母。 */
  denDigits: number;
  fixedDen: number | null;
}

/** `# ?/?`、`# ??/??`、`?/8` 这类分数格式：认出三段各占几位。 */
function fracSpec(nodes: Node[], slashAt: number): FracSpec {
  const intPlaceholders: string[] = [];
  const num: string[] = [];
  const den: string[] = [];
  for (let i = slashAt - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.t === "digit") num.unshift(n.ch);
    else if (n.t === "lit" && /^\d+$/.test(n.s)) num.unshift(n.s);
    else break;
  }
  let numStart = slashAt - num.length;
  // `# ?/?` 里整数占位和分子之间隔着一个字面量（通常是一个空格）
  for (let i = numStart - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.t === "lit" || n.t === "space") continue;
    if (n.t === "digit") {
      numStart = i;
      intPlaceholders.unshift(n.ch);
    } else break;
  }
  let fixed: string | null = null;
  for (let i = slashAt + 1; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.t === "digit") den.push(n.ch);
    else if (n.t === "lit" && /^\d+$/.test(n.s)) fixed = (fixed ?? "") + n.s;
    else break;
  }
  return {
    intPlaceholders: intPlaceholders.join(""),
    numDigits: Math.max(1, num.length),
    denDigits: Math.max(1, den.length),
    fixedDen: fixed ? Number(fixed) : null,
  };
}

/** 分数显示：1.25 按 `# ?/?` → `1 1/4`，按 `?/8` → `10/8`。 */
function fraction(value: number, spec: FracSpec): string {
  const neg = value < 0;
  const abs = Math.abs(value);
  const hasInt = spec.intPlaceholders.length > 0;
  let whole = 0;
  if (hasInt) {
    whole = Math.floor(abs);
  } else if (spec.fixedDen) {
    // 没有整数部分时，分子可以超过分母（Excel 就是这么显示的）
    const n = Math.round(abs * spec.fixedDen);
    return `${neg ? "-" : ""}${n}/${spec.fixedDen}`;
  }

  const maxDen = spec.fixedDen ?? Math.pow(10, spec.denDigits) - 1;
  const rest = abs - whole;
  let num = 0;
  let den = 1;
  if (rest > 0) {
    let best = { err: Infinity, n: 1, d: 1 };
    for (let d = 1; d <= maxDen; d++) {
      const n = Math.round(rest * d);
      const err = Math.abs(rest - n / d);
      if (err < best.err - 1e-12) best = { err, n, d };
      if (err < 1e-12) break;
    }
    num = best.n;
    den = best.d;
    if (!spec.fixedDen) {
      const g = gcd(num, den);
      num /= g;
      den /= g;
    }
  }
  if (num === den && hasInt) {
    whole += 1;
    num = 0;
  }
  // `#` 是可选的整数位：0 就整个不显示（Excel 的 `# ?/?` 对 0.5 显示 `1/2`）
  const optionalInt = hasInt && !spec.intPlaceholders.includes("0");
  const intOut = hasInt && !(optionalInt && whole === 0) ? String(whole) : "";
  if (num === 0) return `${neg ? "-" : ""}${intOut || "0"}`;
  const head = intOut ? `${neg ? "-" : ""}${intOut} ` : neg ? "-" : "";
  return `${head}${num}/${den}`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a) || 1;
}

/* ---------------------------------------------------------------- 日期 */

interface Parts {
  y: number;
  mo: number;
  d: number;
  wd: number;
  h: number;
  mi: number;
  s: number;
}

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");

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

function formatDateNodes(nodes: Node[], value: number, date1904: boolean): string {
  const p = serialParts(value, date1904);
  const twelve = nodes.some((n) => n.t === "ampm");
  const elapsedH = Math.floor(Math.abs(value) * 24);
  const elapsedM = Math.floor(Math.abs(value) * 1440);
  const elapsedS = Math.round(Math.abs(value) * 86400);

  // 先算一遍「m 是月还是分」：紧挨着 h 或在 s 前面的 m 是分钟。
  const kinds: ("mo" | "mi")[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.t !== "date" || n.ch !== "m") {
      kinds.push("mo");
      continue;
    }
    let prev = "";
    for (let j = i - 1; j >= 0; j--) {
      const q = nodes[j];
      if (q.t === "date" || q.t === "elapsed") {
        prev = q.ch;
        break;
      }
      if (q.t === "ampm") break;
    }
    let next = "";
    for (let j = i + 1; j < nodes.length; j++) {
      const q = nodes[j];
      if (q.t === "date" || q.t === "elapsed") {
        next = q.ch;
        break;
      }
      if (q.t === "ampm") break;
    }
    kinds.push(prev === "h" || next === "s" ? "mi" : "mo");
  }

  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.t) {
      case "lit":
        out += n.s === "\u0000GENERAL" ? "" : n.s;
        break;
      case "space":
        out += " ";
        break;
      case "elapsed":
        if (n.ch === "h") out += String(elapsedH).padStart(n.len, "0");
        else if (n.ch === "m") out += String(elapsedM % 60 === 0 ? elapsedM : elapsedM).padStart(n.len, "0");
        else out += String(elapsedS).padStart(n.len, "0");
        break;
      case "ampm":
        if (n.s === "cn") out += p.h < 12 ? "上午" : "下午";
        else if (n.s === "ap") out += p.h < 12 ? "A" : "P";
        else out += p.h < 12 ? "AM" : "PM";
        break;
      case "date": {
        const len = n.len;
        if (n.ch === "y") out += len >= 3 ? pad(p.y, 4) : pad(p.y % 100);
        else if (n.ch === "m") {
          if (kinds[i] === "mi") out += pad(p.mi, len >= 2 ? 2 : 1);
          else if (len >= 5) out += MONTHS[p.mo - 1][0];
          else if (len === 4) out += MONTHS[p.mo - 1];
          else if (len === 3) out += MONTHS[p.mo - 1].slice(0, 3);
          else out += pad(p.mo, len >= 2 ? 2 : 1);
        } else if (n.ch === "d") {
          if (len >= 4) out += DAYS[p.wd];
          else if (len === 3) out += DAYS[p.wd].slice(0, 3);
          else out += pad(p.d, len >= 2 ? 2 : 1);
        } else if (n.ch === "h") {
          const hour = twelve ? (p.h % 12 === 0 ? 12 : p.h % 12) : p.h;
          out += pad(hour, len >= 2 ? 2 : 1);
        } else if (n.ch === "s") out += pad(Math.round(p.s), len >= 2 ? 2 : 1);
        break;
      }
      case "point": {
        // .0 / .00：秒的小数位
        let k = 0;
        for (let j = i + 1; j < nodes.length && nodes[j].t === "digit"; j++) k++;
        if (k > 0) {
          const frac = Math.round((p.s - Math.floor(p.s)) * Math.pow(10, k));
          out += `.${pad(frac, k)}`;
          i += k;
        } else out += ".";
        break;
      }
      case "slash":
        out += "/";
        break;
      case "digit":
        // 日期段里落单的数字位（`.0` 之外）：当字面量
        out += n.ch === "0" ? "0" : "";
        break;
      default:
        break;
    }
  }
  return out.trim();
}

/* ---------------------------------------------------------------- 出口 */

function literal(nodes: Node[], from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) {
    const n = nodes[i];
    if (n.t === "lit") out += n.s === "\u0000GENERAL" ? "" : n.s;
    else if (n.t === "space") out += " ";
    else if (n.t === "pct") out += "%";
    else if (n.t === "point") out += ".";
    else if (n.t === "comma") out += ",";
    else if (n.t === "slash") out += "/";
  }
  return out;
}

function formatNumberSection(section: string, value: number): string {
  const nodes = lex(section);
  const dbnum = nodes.find((n) => n.t === "dbnum") as { t: "dbnum"; style: number } | undefined;
  if (isGeneral(section)) {
    // [DBNum2] + G/通用格式：整串换成中文数字（中文大写金额就是这么写的）
    return dbnum ? cnNumber(value, dbnum.style, decimalPlaces(value)) : generalNumber(value);
  }

  // 分数：`# ?/?` / `?/8` 这类有斜杠的走单独一条路
  const slashAt = nodes.findIndex((n) => n.t === "slash");
  if (slashAt > 0) {
    const spec = fracSpec(nodes, slashAt);
    const prefix = literal(nodes, 0, slashAt - spec.numDigits - spec.intPlaceholders.length);
    return prefix + fraction(value, spec);
  }

  const body = findBody(nodes);
  if (!body) {
    const text = literal(nodes, 0, nodes.length);
    return dbnum ? cnNumber(value, dbnum.style, 0) + text : text;
  }
  if (dbnum) return cnNumber(value, dbnum.style, body.dec.length);

  const neg = value < 0;
  const shown = numberBody(body, Math.abs(value));
  const prefix = literal(nodes, 0, body.start);
  const suffix = skipRunTail(literal(nodes, body.end, nodes.length));
  return `${neg ? "-" : ""}${prefix}${shown}${suffix}`;
}

/** 数字段后面那些「已经算进数值里」的记号（缩放逗号、指数标记）不再当字面量印出来。 */
function skipRunTail(text: string): string {
  return text.replace(/^,+/, "").replace(/^E[+-]\d*/, "").replace(/^\d+/, "");
}

/** 一个数按 General 显示时有几位小数（中文数字用它决定要不要「点叁肆」）。 */
function decimalPlaces(value: number): number {
  const text = generalNumber(Math.abs(value));
  const frac = text.split(".")[1] ?? "";
  return Math.min(4, frac.replace(/[^0-9]/g, "").length);
}

/** Excel 的 General：最多 11 位有效数字，去掉多余的 0。 */
function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e11) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1e11 || (abs > 0 && abs < 1e-4)) {
    const exp = Math.floor(Math.log10(abs));
    const mant = (value / Math.pow(10, exp)).toPrecision(10).replace(/\.?0+$/, "");
    return `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const text = value.toPrecision(11).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return text;
}

/**
 * 一个数字格按它的格式代码显示成什么。未知代码退回 `String(value)`（原样数字，不撒谎）。
 */
export function formatValue(value: number, code: string, date1904: boolean): string {
  const secs = sections(code);
  let sec = secs[0] ?? "";
  let v = value;
  if (value < 0 && secs.length > 1) {
    sec = secs[1] ?? sec;
    v = -value; // 第二段自己把负号 / 括号写好了
  } else if (value === 0 && secs.length > 2) sec = secs[2] ?? sec;
  if (!sec.trim()) sec = secs[0] ?? code;
  if (!sec.trim()) return generalNumber(v);
  if (isDateCode(sec)) return formatDateNodes(lex(sec), v, date1904);
  return formatNumberSection(sec, v);
}

/** 文本格走第四段（`@` 是原文）；没有第四段就原样。 */
export function formatText(text: string, code: string): string {
  const secs = sections(code);
  const sec = secs.length >= 4 ? secs[3] : secs.length === 1 && secs[0].includes("@") ? secs[0] : null;
  if (sec === null) return text;
  let out = "";
  for (const n of lex(sec)) {
    if (n.t === "at") out += text;
    else if (n.t === "lit") out += n.s === "\u0000GENERAL" ? "" : n.s;
    else if (n.t === "space") out += " ";
  }
  return out;
}
