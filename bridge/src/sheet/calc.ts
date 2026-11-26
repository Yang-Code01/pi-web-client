/**
 * 公式求值：给预览兜底用。
 *
 * 这里不是 Excel 的完整计算引擎——它有 400 多个函数、数组公式、动态数组、
 * 迭代计算、外部引用。我们只做「打开文件时能把没存结果的公式算出来」这一件事：
 * 四则 / 幂 / 百分号 / 连接 / 比较、单元格与区域引用（可跨表、支持 $）、
 * 以及一批最常用的函数（SUM、IF、VLOOKUP、COUNTIF…）。
 *
 * 求值器不认识的东西一律返回错误值，界面上显示成 `#NAME?` 这类，跟 Excel 一致：
 * 宁可显示错误，也不显示一个看起来像对的错数。
 */

import { criteria, cmp, err, firstErr, flatten, isErr, isMx, numbers, scalar, serialToday, serialToDate, toBool, toNum, toStr, CACHED_RANGE, type CalcCtx, type EvalVal, type Matrix, type Val } from "./value.ts";
import { EXTRA_FNS } from "./functions.ts";
import { roundDecimal } from "./decimal.ts";

export { err, isErr } from "./value.ts";
export type { CalcCtx, ErrVal, EvalVal, Matrix, Val } from "./value.ts";

const fromSerial = (n: number): Date => serialToDate(n, false);

/* ---------------------------------------------------------------- 词法 */

type Tok =
  | { t: "num"; n: number }
  | { t: "str"; s: string }
  | { t: "err"; s: string }
  | { t: "ref"; s: string }
  | { t: "name"; s: string }
  | { t: "op"; s: string }
  | { t: "p"; s: string };

// 表名可以是中文、可以带引号，也可能是 `Sheet1`；不带 `!` 的一律不是引用。
const REF_RE = /^(?:(?:'(?:[^']|'')+'|[^\s!()+\-*/^&<>=,:%"]+)!)?\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_(])/;
const OPS = ["<=", ">=", "<>", "=", "<", ">", "&", "+", "-", "*", "/", "^", "%"];

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const m = /^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) return null;
      out.push({ t: "num", n: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (; j < src.length; j++) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j++;
            continue;
          }
          break;
        }
        s += src[j];
      }
      if (j >= src.length) return null;
      out.push({ t: "str", s });
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const m = /^#[A-Za-z0-9/?!]+/.exec(src.slice(i));
      if (!m) return null;
      out.push({ t: "err", s: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ":") {
      out.push({ t: "p", s: ch });
      i++;
      continue;
    }
    // 先按引用试（表名可能是中文），再退回函数名 / 布尔名。
    // 但「名字后面紧跟 (」一定是函数调用：LOG10(、DEC2BIN(、SUMX2MY2( 都会被引用规则误吞。
    const callAhead = /^[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(src.slice(i));
    const ref = callAhead ? null : REF_RE.exec(src.slice(i));
    if (ref) {
      out.push({ t: "ref", s: ref[0].replace(/^'((?:[^']|'')+)'!/, (_, n: string) => `${n.replace(/''/g, "'")}!`) });
      i += ref[0].length;
      continue;
    }
    if (ch === "_" || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
      const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (!name) return null;
      out.push({ t: "name", s: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return null;
    out.push({ t: "op", s: op });
    i += op.length;
  }
  return out;
}

/* ---------------------------------------------------------------- 语法 */

type Node =
  | { k: "val"; v: Val }
  | { k: "err"; v: string }
  | { k: "ref"; sheet: string | null; r0: number; c0: number; r1: number; c1: number }
  | { k: "fn"; name: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "un"; op: string; a: Node };

function parseRef(s: string): { sheet: string | null; r0: number; c0: number; r1: number; c1: number } | null {
  let sheet: string | null = null;
  let body = s;
  const bang = s.lastIndexOf("!");
  if (bang >= 0) {
    sheet = s.slice(0, bang);
    body = s.slice(bang + 1);
  }
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(body);
  if (!m) return null;
  const col = (x: string): number => {
    let n = 0;
    const up = x.toUpperCase();
    for (const ch of up) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const r0 = Number(m[2]) - 1;
  const c0 = col(m[1]!);
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c1 = m[3] ? col(m[3]) : c0;
  if (r0 < 0 || c0 < 0 || r1 < r0 || c1 < c0) return null;
  return { sheet, r0, c0, r1, c1 };
}

class Parser {
  private i = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private eat(t: string): boolean {
    const tok = this.peek();
    if (tok && (tok.t === "p" || tok.t === "op") && tok.s === t) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node | null {
    const n = this.expr();
    return n && this.i === this.toks.length ? n : null;
  }

  private expr(): Node | null {
    return this.compare();
  }
  private compare(): Node | null {
    let a = this.concat();
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t !== "op") break;
      if (!["=", "<>", "<", ">", "<=", ">="].includes(tok.s)) break;
      this.i++;
      const b = this.concat();
      if (!a || !b) return null;
      a = { k: "bin", op: tok.s, a, b };
    }
    return a;
  }
  private concat(): Node | null {
    let a = this.add();
    while (this.eat("&")) {
      const b = this.add();
      if (!a || !b) return null;
      a = { k: "bin", op: "&", a, b };
    }
    return a;
  }
  private add(): Node | null {
    let a = this.mul();
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t !== "op" || (tok.s !== "+" && tok.s !== "-")) break;
      this.i++;
      const b = this.mul();
      if (!a || !b) return null;
      a = { k: "bin", op: tok.s, a, b };
    }
    return a;
  }
  private mul(): Node | null {
    let a = this.pow();
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t !== "op" || (tok.s !== "*" && tok.s !== "/")) break;
      this.i++;
      const b = this.pow();
      if (!a || !b) return null;
      a = { k: "bin", op: tok.s, a, b };
    }
    return a;
  }
  private pow(): Node | null {
    let a = this.unary();
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t !== "op" || tok.s !== "^") break;
      this.i++;
      const b = this.unary();
      if (!a || !b) return null;
      a = { k: "bin", op: "^", a, b };
    }
    return a;
  }
  private unary(): Node | null {
    if (this.eat("-")) {
      const a = this.unary();
      return a ? { k: "un", op: "-", a } : null;
    }
    if (this.eat("+")) return this.unary();
    return this.postfix();
  }
  private postfix(): Node | null {
    let a = this.primary();
    while (this.eat("%")) {
      if (!a) return null;
      a = { k: "bin", op: "/", a, b: { k: "val", v: 100 } };
    }
    return a;
  }
  private primary(): Node | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.t === "num") {
      this.i++;
      return { k: "val", v: tok.n };
    }
    if (tok.t === "str") {
      this.i++;
      return { k: "val", v: tok.s };
    }
    if (tok.t === "err") {
      this.i++;
      return { k: "err", v: tok.s };
    }
    if (tok.t === "p" && tok.s === "(") {
      this.i++;
      const n = this.expr();
      return this.eat(")") ? n : null;
    }
    if (tok.t === "ref") {
      this.i++;
      const head = parseRef(tok.s);
      if (!head) return null;
      // A1:B2 的尾巴：token 流里是 ":" + ref
      const colon = this.peek();
      if (colon && colon.t === "p" && colon.s === ":") {
        const tailTok = this.toks[this.i + 1];
        if (!tailTok || tailTok.t !== "ref") return null;
        const tail = parseRef(tailTok.s);
        if (!tail) return null;
        this.i += 2;
        return {
          k: "ref",
          sheet: head.sheet,
          r0: head.r0,
          c0: head.c0,
          r1: Math.max(head.r1, tail.r1),
          c1: Math.max(head.c1, tail.c1),
        };
      }
      return { k: "ref", sheet: head.sheet, r0: head.r0, c0: head.c0, r1: head.r1, c1: head.c1 };
    }
    if (tok.t === "name") {
      this.i++;
      const up = tok.s.toUpperCase();
      if (up === "TRUE") return { k: "val", v: true };
      if (up === "FALSE") return { k: "val", v: false };
      if (!this.eat("(")) return { k: "err", v: "#NAME?" };
      const args: Node[] = [];
      if (!this.eat(")")) {
        for (;;) {
          // 省略的参数（`IF(A1>0,A1,)`、`SUM(1,,2)`）算一个空值。以前这里直接 `return null`，
          // 整条公式被当成解析失败，界面上报成「函数名拼错」的 #NAME?。
          const t = this.peek();
          if (t && (t.t === "p" || t.t === "op") && (t.s === "," || t.s === ")")) {
            args.push({ k: "val", v: null });
          } else {
            const a = this.expr();
            if (!a) return null;
            args.push(a);
          }
          if (this.eat(")")) break;
          if (!this.eat(",")) return null;
        }
      }
      return { k: "fn", name: up, args };
    }
    return null;
  }
}

/* ---------------------------------------------------------------- 求值 */

function binNode(n: Node & { k: "bin" }, ctx: CalcCtx, sheet: string | null): EvalVal {
      const a = evalNode(n.a, ctx, sheet);
      const b = evalNode(n.b, ctx, sheet);
      if (n.op === "&") {
        const x = toStr(a);
        const y = toStr(b);
        if (typeof x !== "string") return x;
        if (typeof y !== "string") return y;
        return x + y;
      }
      if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
        const x = scalar(a);
        const y = scalar(b);
        if (isErr(x)) return x;
        if (isErr(y)) return y;
        const c = cmp(x, y);
        if (n.op === "=") return c === 0;
        if (n.op === "<>") return c !== 0;
        if (n.op === "<") return c < 0;
        if (n.op === ">") return c > 0;
        if (n.op === "<=") return c <= 0;
        return c >= 0;
      }
      const x = toNum(a);
      const y = toNum(b);
      if (typeof x !== "number") return x;
      if (typeof y !== "number") return y;
      switch (n.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? err("#DIV/0!") : x / y;
        case "^":
          return Math.pow(x, y);
        default:
          return err("#VALUE!");
      }
    }

function evalNode(n: Node, ctx: CalcCtx, sheet: string | null): EvalVal {
  switch (n.k) {
    case "val":
      return n.v;
    case "err":
      return err(n.v);
    case "ref": {
      const target = n.sheet ?? sheet;
      if (n.r0 === n.r1 && n.c0 === n.c1) return ctx.cell(target, n.r0, n.c0);
      return ctx.range(target, n.r0, n.c0, n.r1, n.c1);
    }
    case "un": {
      const v = toNum(evalNode(n.a, ctx, sheet));
      if (typeof v !== "number") return v;
      return n.op === "-" ? -v : v;
    }
    case "bin":
      return binNode(n, ctx, sheet);
    case "fn":
      return callFn(n, ctx, sheet);
  }
}

/* ---------------------------------------------------------------- 精确查找的索引 */

/**
 * 桶：同一桶里才**可能**相等，桶内再用 `cmp()` 确认。桶只需不比 cmp 严格（相等必定同桶），
 * 所以宁可放宽 —— 多几个候选只是多几次 cmp。
 *
 * 数字与文本在 `cmp()` 里永不相等；空格子在 cmp 眼里等值于文本 "null"，所以它进 `s:` 桶。
 * 逻辑值不走桶（逻辑值与数字在 `cmp()` 里相等，桶模型对不上）：那种列干脆不建索引。
 */
function bucketOf(v: Val): string {
  if (typeof v === "number") return `n:${v}`;
  return `s:${String(v).toLowerCase()}`;
}

interface ExactIndex {
  buckets: Map<string, number[]>;
  /** 列里有逻辑值就不建（见 `bucketOf` 的注释），改由 `scanRow` 线性扫。 */
  usable: boolean;
}

/** 精确查找的索引，跟着矩阵对象走（ctx 缓存过的矩阵才会被复用，见 `CACHED_RANGE`）。 */
const exactIndex = new WeakMap<Matrix, ExactIndex>();

function buildIndex(m: Matrix): ExactIndex {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < m.m.length; i++) {
    const first = m.m[i]?.[0] ?? null;
    if (isMx(first) || isErr(first)) continue;
    if (typeof first === "boolean") return { buckets, usable: false };
    const k = bucketOf(first as Val);
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }
  return { buckets, usable: true };
}

/** 没索引时的退化路径（逻辑值列 / 逻辑值键）。 */
function scanRow(m: Matrix, key: Val): number {
  for (let i = 0; i < m.m.length; i++) {
    const first = m.m[i]?.[0] ?? null;
    if (isMx(first) || isErr(first)) continue;
    if (cmp(first as Val, key) === 0) return i;
  }
  return -1;
}

/** 与 key 精确相等的**第一行**（0 基）；-1 表示没有。顺序与线性扫的 `break` 一致。 */
function exactRow(m: Matrix, key: Val): number {
  let idx = exactIndex.get(m);
  if (!idx) exactIndex.set(m, (idx = buildIndex(m)));
  if (!idx.usable || typeof key === "boolean") return scanRow(m, key);
  for (const i of idx.buckets.get(bucketOf(key)) ?? []) {
    const first = m.m[i]?.[0] ?? null;
    if (!isMx(first) && !isErr(first) && cmp(first as Val, key) === 0) return i;
  }
  return -1;
}

/* ---------------------------------------------------------------- 函数 */




import type { Fn, FnNode } from "./functions.ts";

const FNS: Record<string, Fn> = {
  SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => numbers(a).reduce((x, y) => x * y, 1),
  AVERAGE: (a) => {
    const ns = numbers(a);
    return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : err("#DIV/0!");
  },
  COUNT: (a) => numbers(a).length,
  COUNTA: (a) => flatten(a).filter((v) => v !== null && v !== "").length,
  MIN: (a) => {
    const ns = numbers(a);
    return ns.length ? Math.min(...ns) : 0;
  },
  MAX: (a) => {
    const ns = numbers(a);
    return ns.length ? Math.max(...ns) : 0;
  },
  ABS: (a) => {
    const n = toNum(a[0] ?? null);
    return typeof n === "number" ? Math.abs(n) : n;
  },
  SIGN: (a) => {
    const n = toNum(a[0] ?? null);
    return typeof n === "number" ? Math.sign(n) : n;
  },
  INT: (a) => {
    const n = toNum(a[0] ?? null);
    return typeof n === "number" ? Math.floor(n) : n;
  },
  MOD: (a) => {
    const x = toNum(a[0] ?? null);
    const y = toNum(a[1] ?? null);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    return y === 0 ? err("#DIV/0!") : x - Math.floor(x / y) * y;
  },
  POWER: (a) => {
    const x = toNum(a[0] ?? null);
    const y = toNum(a[1] ?? null);
    if (typeof x !== "number") return x;
    if (typeof y !== "number") return y;
    return Math.pow(x, y);
  },
  SQRT: (a) => {
    const n = toNum(a[0] ?? null);
    if (typeof n !== "number") return n;
    return n < 0 ? err("#NUM!") : Math.sqrt(n);
  },
  ROUND: (a) => roundTo(a, 0),
  ROUNDUP: (a) => roundTo(a, 1),
  ROUNDDOWN: (a) => roundTo(a, -1),
  IF: (a) => {
    const c = toBool(a[0] ?? null);
    if (typeof c !== "boolean") return c;
    // 参数整个省掉时 Excel 给 TRUE/FALSE（`IF(A1>0,A1)`）；写成空参数 `IF(A1>0,A1,)` 则是 0。
    const pick = (v: EvalVal | undefined, dflt: boolean): EvalVal => (v === undefined ? dflt : (v ?? 0));
    return c ? pick(a[1], true) : pick(a[2], false);
  },
  IFERROR: (a) => {
    const v = a[0] ?? null;
    if (!isErr(scalar(v))) return v;
    return a[1] === undefined ? "" : (a[1] ?? 0);
  },
  IFNA: (a) => {
    const v = scalar(a[0] ?? null);
    if (!(isErr(v) && v.v === "#N/A")) return v;
    return a[1] === undefined ? "" : (a[1] ?? 0);
  },
  AND: (a) => {
    for (const v of flatten(a)) {
      const b = toBool(v);
      if (typeof b !== "boolean") return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (a) => {
    for (const v of flatten(a)) {
      const b = toBool(v);
      if (typeof b !== "boolean") return b;
      if (b) return true;
    }
    return false;
  },
  NOT: (a) => {
    const b = toBool(a[0] ?? null);
    return typeof b === "boolean" ? !b : b;
  },
  ISBLANK: (a) => scalar(a[0] ?? null) === null || scalar(a[0] ?? null) === "",
  ISNUMBER: (a) => typeof scalar(a[0] ?? null) === "number",
  ISTEXT: (a) => typeof scalar(a[0] ?? null) === "string",
  ISERROR: (a) => isErr(scalar(a[0] ?? null)),
  LEN: (a) => {
    const s = toStr(a[0] ?? null);
    return typeof s === "string" ? s.length : s;
  },
  LEFT: (a) => {
    const s = toStr(a[0] ?? null);
    if (typeof s !== "string") return s;
    const n = a.length > 1 ? toNum(a[1]!) : 1;
    if (typeof n !== "number") return n;
    if (n < 0) return err("#VALUE!"); // Excel：个数不能为负
    return s.slice(0, Math.trunc(n));
  },
  RIGHT: (a) => {
    const s = toStr(a[0] ?? null);
    if (typeof s !== "string") return s;
    const n = a.length > 1 ? toNum(a[1]!) : 1;
    if (typeof n !== "number") return n;
    if (n < 0) return err("#VALUE!");
    // 注意 `slice(-0)` 会取整串，0 个字符要单独挡一下
    const k = Math.trunc(n);
    return k === 0 ? "" : s.slice(-k);
  },
  MID: (a) => {
    const s = toStr(a[0] ?? null);
    const st = toNum(a[1] ?? null);
    const len = toNum(a[2] ?? null);
    if (typeof s !== "string") return s;
    if (typeof st !== "number") return st;
    if (typeof len !== "number") return len;
    // Excel：起点从 1 算，起点 < 1 或长度 < 0 都是 #VALUE!（以前静默当成 1 / 空串）
    if (st < 1 || len < 0) return err("#VALUE!");
    return s.substr(Math.trunc(st) - 1, Math.trunc(len));
  },
  TRIM: (a) => {
    const s = toStr(a[0] ?? null);
    return typeof s === "string" ? s.trim() : s;
  },
  UPPER: (a) => {
    const s = toStr(a[0] ?? null);
    return typeof s === "string" ? s.toUpperCase() : s;
  },
  LOWER: (a) => {
    const s = toStr(a[0] ?? null);
    return typeof s === "string" ? s.toLowerCase() : s;
  },
  CONCAT: (a) => {
    let out = "";
    for (const v of flatten(a)) {
      const s = toStr(v);
      if (typeof s !== "string") return s;
      out += s;
    }
    return out;
  },
  CONCATENATE: (a) => FNS.CONCAT!(a, {} as CalcCtx, null),
  FIND: (a) => {
    const needle = toStr(a[0] ?? null);
    const hay = toStr(a[1] ?? null);
    if (typeof needle !== "string") return needle;
    if (typeof hay !== "string") return hay;
    const at = hay.indexOf(needle);
    return at < 0 ? err("#VALUE!") : at + 1;
  },
  SUBSTITUTE: (a) => {
    const s = toStr(a[0] ?? null);
    const from = toStr(a[1] ?? null);
    const to = toStr(a[2] ?? null);
    const which = a.length > 3 ? toNum(a[3]!) : 0;
    if (typeof s !== "string") return s;
    if (typeof from !== "string") return from;
    if (typeof to !== "string") return to;
    if (typeof which !== "number") return which;
    if (from === "") return s;
    const n = Math.trunc(which);
    if (a.length > 3 && n < 1) return err("#VALUE!"); // Excel：第几个不能是 0 / 负数
    if (n < 1) return s.split(from).join(to); // 不指定就全换
    // 只换第 n 个：定位那一段再拼三段，别沿用 split/join 把所有的都换掉
    let at = -1;
    let pos = 0;
    for (let k = 0; k < n; k++) {
      at = s.indexOf(from, pos);
      if (at < 0) return s; // 不足 n 个：原样返回
      pos = at + from.length;
    }
    return s.slice(0, at) + to + s.slice(at + from.length);
  },
  REPT: (a) => {
    const s = toStr(a[0] ?? null);
    const n = toNum(a[1] ?? null);
    if (typeof s !== "string") return s;
    if (typeof n !== "number") return n;
    return s.repeat(Math.max(0, Math.min(1000, Math.trunc(n))));
  },
  VALUE: (a) => toNum(a[0] ?? null),
  ROW: () => err("#NAME?"),
  TODAY: () => serialToday(),
  NOW: () => {
    const d = new Date();
    return serialToday() + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  },
  YEAR: (a) => {
    const n = toNum(a[0] ?? serialToday());
    return typeof n === "number" ? fromSerial(n).getUTCFullYear() : n;
  },
  MONTH: (a) => {
    const n = toNum(a[0] ?? serialToday());
    return typeof n === "number" ? fromSerial(n).getUTCMonth() + 1 : n;
  },
  DAY: (a) => {
    const n = toNum(a[0] ?? serialToday());
    return typeof n === "number" ? fromSerial(n).getUTCDate() : n;
  },
  COUNTIF: (a) => {
    const m = a[0];
    if (!m || !isMx(m)) return err("#VALUE!");
    const test = criteria(toStr(a[1] ?? "") as string);
    let n = 0;
    for (const row of m.m) for (const v of row) if (!isMx(v) && !isErr(v) && test(v)) n++;
    return n;
  },
  SUMIF: (a) => {
    const m = a[0];
    if (!m || !isMx(m)) return err("#VALUE!");
    const test = criteria(toStr(a[1] ?? "") as string);
    const sum = a[2] && isMx(a[2]) ? a[2] : m;
    let total = 0;
    for (let r = 0; r < m.m.length; r++) {
      for (let c = 0; c < (m.m[r]?.length ?? 0); c++) {
        const v = m.m[r]?.[c];
        if (v !== undefined && !isMx(v) && !isErr(v) && test(v)) {
          const n = sum.m[r]?.[c];
          if (typeof n === "number") total += n;
        }
      }
    }
    return total;
  },
  AVERAGEIF: (a) => {
    const m = a[0];
    if (!m || !isMx(m)) return err("#VALUE!");
    const test = criteria(toStr(a[1] ?? "") as string);
    const sum = a[2] && isMx(a[2]) ? a[2] : m;
    let total = 0;
    let n = 0;
    for (let r = 0; r < m.m.length; r++) {
      for (let c = 0; c < (m.m[r]?.length ?? 0); c++) {
        const v = m.m[r]?.[c];
        if (v !== undefined && !isMx(v) && !isErr(v) && test(v)) {
          const x = sum.m[r]?.[c];
          if (typeof x === "number") {
            total += x;
            n++;
          }
        }
      }
    }
    return n ? total / n : err("#DIV/0!");
  },
  VLOOKUP: (a) => {
    const key = scalar(a[0] ?? null);
    const m = a[1];
    const col = toNum(a[2] ?? null);
    if (!m || !isMx(m)) return err("#VALUE!");
    if (typeof col !== "number") return col;
    // 第四个参数是「近似匹配」：FALSE 才是精确匹配（Excel 的定义，别弄反）。
    const approx = a.length > 3 ? toBool(a[3]!) !== false : true;
    // 精确匹配 + ctx 缓存过的区域（同一块区域会被几千个公式问）：走索引，不再线性扫。
    // 4000 行 × 4000 个 VLOOKUP = 1600 万次 cmp，实测 13.7 s（`.scratch/sheet-perf`）。
    if (!approx && m[CACHED_RANGE] && !isErr(key) && !isMx(key)) {
      const i = exactRow(m, key as Val);
      if (i < 0) return err("#N/A");
      const hitVal = m.m[i]?.[Math.trunc(col) - 1];
      return hitVal === undefined || isMx(hitVal) ? err("#REF!") : hitVal;
    }
    let found: EvalVal | undefined;
    for (const row of m.m) {
      const first = row[0] ?? null;
      if (isMx(first) || isErr(first)) continue;
      const c = cmp(first, key as Val);
      if (approx ? c <= 0 : c === 0) {
        const v = row[Math.trunc(col) - 1];
        found = v === undefined || isMx(v) ? err("#REF!") : v;
        if (!approx) break;
      }
    }
    return found === undefined ? err("#N/A") : found;
  },
  INDEX: (a) => {
    const m = a[0];
    if (!m || !isMx(m)) return err("#VALUE!");
    const r = toNum(a[1] ?? 1);
    const c = a.length > 2 ? toNum(a[2]!) : 1;
    if (typeof r !== "number") return r;
    if (typeof c !== "number") return c;
    const v = m.m[Math.trunc(r) - 1]?.[Math.trunc(c) - 1];
    return v === undefined || isMx(v) ? err("#REF!") : v;
  },
  MATCH: (a) => {
    const key = scalar(a[0] ?? null);
    const m = a[1];
    if (!m || !isMx(m)) return err("#VALUE!");
    const flat = m.m.map((r) => r[0]).filter((v): v is Val => v !== undefined && !isMx(v) && !isErr(v));
    const exact = a.length > 2 ? toNum(a[2]!) : 1;
    let found = -1;
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i]!;
      const c = cmp(v, key as Val);
      if (exact === 0 ? c === 0 : c <= 0) found = i;
      if (exact === 0 && c === 0) break;
    }
    return found < 0 ? err("#N/A") : found + 1;
  },
};

Object.assign(FNS, EXTRA_FNS);

function roundTo(a: EvalVal[], mode: number): EvalVal {
  const x = toNum(a[0] ?? null);
  const d = a.length > 1 ? toNum(a[1]!) : 0;
  if (typeof x !== "number") return x;
  if (typeof d !== "number") return d;
  // mode: 0 = ROUND（half-up）、>0 = ROUNDUP（远离 0）、<0 = ROUNDDOWN（朝 0）。
  // 方向要按**绝对值**定，否则负数会朝反方向跑；舍入本身走十进制（`x * 10^d` 有二进制误差）。
  let dir: -1 | 0 | 1 = 0;
  if (mode > 0) dir = 1;
  else if (mode < 0) dir = -1;
  return roundDecimal(x, Math.trunc(d), dir);
}

function callFn(n: Node & { k: "fn" }, ctx: CalcCtx, sheet: string | null): EvalVal {
  const fn = FNS[n.name];
  if (!fn) return err("#NAME?");
  const args = n.args.map((a) => evalNode(a, ctx, sheet));
  const bad = firstErr(args);
  if (bad && !SELF_HANDLED.has(n.name)) return bad;
  return fn(args, ctx, sheet, n as unknown as FnNode);
}

/** IF / IFERROR 这类要看得到错误值自己决定，不能在这里统一短路（每次调用重建一个 Set 太贵）。 */
const SELF_HANDLED = new Set(["IF", "IFERROR", "IFNA", "ISERROR", "ISERR", "ISNA", "TYPE", "ERROR.TYPE", "AGGREGATE", "IFS", "SWITCH", "N", "T", "TEXT", "COUNTIF", "COUNTIFS", "SUMIF", "SUMIFS", "AVERAGEIF", "AVERAGEIFS", "MAXIFS", "MINIFS", "ISLOGICAL", "ISNUMBER", "ISTEXT", "ISNONTEXT", "ISBLANK", "ISEVEN", "ISODD"]);

/* ---------------------------------------------------------------- 入口 */

const CACHE = new Map<string, Node | null>();
const CACHE_MAX = 4000;

function astOf(src: string): Node | null {
  if (CACHE.has(src)) return CACHE.get(src) ?? null;
  const toks = tokenize(src);
  const node = toks ? new Parser(toks).parse() : null;
  if (CACHE.size > CACHE_MAX) CACHE.clear();
  CACHE.set(src, node);
  return node;
}

/** 算一条公式。`sheet` 是公式所在表（相对引用的基准）。失败返回错误值。 */
export function evaluate(src: string, sheet: string, ctx: CalcCtx): EvalVal {
  const body = src.startsWith("=") ? src.slice(1) : src;
  const node = astOf(body);
  if (!node) return err("#NAME?");
  try {
    const v = evalNode(node, ctx, sheet);
    return isMx(v) ? scalar(v) : v;
  } catch {
    return err("#VALUE!");
  }
}
