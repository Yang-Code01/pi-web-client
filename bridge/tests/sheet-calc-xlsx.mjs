/**
 * 求值器走**真 xlsx** 的断言：`sheet-calc-unit.mjs` 用的是伪造的 ctx（矩阵手工打
 * `CACHED_RANGE`），碰不到 `BookCalc.range()` 的区域缓存本身。这里直接量真对象：
 *
 *   1. 一整轮读窗口的公式值（含 VLOOKUP 精确匹配的新索引路径、跨表、环）；
 *   2. 缓存跨窗口复用之后值不变（同一 `book.calc`，第二次读窗口）；
 *   3. 环所在的区域不许进缓存，普通区域必须进且是同一个对象。
 *
 *   node --experimental-strip-types bridge/tests/sheet-calc-xlsx.mjs
 */
import { readBook, readWindow, BookCalc } from "../src/sheet/xlsx.ts";
import { CACHED_RANGE } from "../src/sheet/value.ts";
import { buildCalcXlsx } from "./fixtures/calc-xlsx.mjs";

let n = 0;
const bad = [];
function eq(label, got, want) {
  n++;
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) bad.push(`${label}：要 ${JSON.stringify(want)}，得 ${JSON.stringify(got)}`);
}

/** 一格：数字取原值 `v`，文本 / 错误取显示串 `t`。 */
function cellAt(win, r, c) {
  const cell = win.rows.find((row) => row.r === r)?.cells.find((x) => x.c === c);
  if (!cell) return `(缺格 ${r},${c})`;
  return typeof cell.v === "number" ? cell.v : cell.t;
}

const buf = buildCalcXlsx();
const book = readBook(buf);

/* ---------------------------------------------------------------- 一轮真求值 */
/* fixtures/calc-xlsx.mjs 里所有公式都只写 <f> 不写 <v>：值全靠 fillFormulaValues 现算。 */
const win = readWindow(buf, book, "计算", 0, 3, 0, 8);

eq("B1 SUM(A1:A2)", cellAt(win, 0, 1), 3);
eq("C1 IF(B1>2,…)", cellAt(win, 0, 2), "大");
eq("D1 ROUND(10/3,2)", cellAt(win, 0, 3), 3.33);
eq("E1 拼接 A1&A2&件", cellAt(win, 0, 4), "12件");
eq("F1 VLOOKUP 精确匹配", cellAt(win, 0, 5), 2); // 走 index 快路径
eq("G1 跨表引用", cellAt(win, 0, 6), 42);
eq("B2 同表相加", cellAt(win, 1, 1), 3);
eq("C2 COUNTIF(A1:A2,\">1\")", cellAt(win, 1, 2), 1);
eq("D2 1/0", cellAt(win, 1, 3), "#DIV/0!");
eq("E2 未定义函数", cellAt(win, 1, 4), "#NAME?");
eq("A3 与 A4 成环", cellAt(win, 2, 0), "#CIRC!");
eq("A4 与 A3 成环", cellAt(win, 3, 0), "#CIRC!");

/* -------------------------------------------- 缓存跨窗口：第二次读还是同一批值 */
/* `readWindow` 复用 `book.calc`，所以第二轮直接用上一轮缓存下来的区域矩阵。 */
const win2 = readWindow(buf, book, "计算", 0, 3, 0, 8);

eq("二次读 B1", cellAt(win2, 0, 1), 3);
eq("二次读 C1", cellAt(win2, 0, 2), "大");
eq("二次读 F1", cellAt(win2, 0, 5), 2);
eq("二次读 C2", cellAt(win2, 1, 2), 1);
eq("二次读 A3", cellAt(win2, 2, 0), "#CIRC!");
eq("二次读没有残留的待算格", win2.rows.flatMap((row) => row.cells).filter((c) => c.noCache).length, 0);

/* ------------------------------------------------------------ 缓存标记本身 */
const calc = new BookCalc(buf, book);

// 普通区域：进缓存，且同一个 key 两次拿到的是同一个对象。
const h1 = calc.range("计算", 0, 7, 1, 8); // H1:I2 查找表
const h2 = calc.range("计算", 0, 7, 1, 8);
eq("普通区域进缓存", h1[CACHED_RANGE] === true, true);
eq("同一区域是同一对象", h1 === h2, true);
eq("H1:I2 的内容", h1.m.map((row) => row.map((v) => (typeof v === "string" ? v : Number(v)))), [["a", 1], ["b", 2]]);

// 环所在的区域：#CIRC! 是「正在算」的占位，冻进缓存就再也拿不掉，所以不许缓存。
const cyc1 = calc.range("计算", 2, 0, 3, 0); // A3:A4
const cyc2 = calc.range("计算", 2, 0, 3, 0);
eq("环区域不进缓存", cyc1[CACHED_RANGE] === true, false);
eq("环区域两次读都不是缓存对象", cyc1 === cyc2, false);
eq("环区域每次都是 #CIRC!", cyc2.m.map((row) => row[0].v), ["#CIRC!", "#CIRC!"]);

// 条目上限：每个不同坐标都是新 key，超过上限后新的不再进缓存（防几十万个矩阵撑内存）。
const cap = new BookCalc(buf, book);
let cached = 0;
for (let r = 0; r < 700; r++) if (cap.range("计算", r, 20, r, 20)[CACHED_RANGE] === true) cached++;
eq("条目上限 512 之后不再收新区域", cached, 512);

if (bad.length) {
  console.error(`FAIL ${bad.length}/${n}\n     ${bad.join("\n     ")}`);
  process.exitCode = 1;
} else {
  console.log(`ok ${n} 条`);
}
