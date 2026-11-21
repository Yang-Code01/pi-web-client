/**
 * 公式求值器的单元测试（D266）：只看「这条公式算出什么」。
 *
 *   node --experimental-strip-types bridge/tests/sheet-calc-unit.mjs
 */
import { evaluate } from "../src/sheet/calc.ts";

/** 一张小表：A1:D5（0 起算），空白格返回 null。 */
const GRID = [
  ["地区", "金额", "数量", "日期"],
  ["华东", 100, 2, "2024-01-05"],
  ["华南", 250, 5, "2024-02-10"],
  ["华东", 300, 3, "2024-03-15"],
  ["华北", 50, 1, "2024-04-20"],
];

const ctx = {
  at: { r: 0, c: 0 },
  date1904: false,
  cell(_sheet, r, c) {
    const v = GRID[r]?.[c];
    if (v === undefined) return null;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, mo, d] = v.split("-").map(Number);
      return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
    }
    return v;
  },
  range(sheet, r0, c0, r1, c1) {
    const m = [];
    for (let r = r0; r <= r1; r++) {
      const row = [];
      for (let c = c0; c <= c1; c++) row.push(this.cell(sheet, r, c));
      m.push(row);
    }
    return { k: "mx", m };
  },
};

let failures = 0;
let n = 0;
const eq = (src, want) => {
  n++;
  let got;
  try {
    const v = evaluate(src, "表1", ctx);
    got = typeof v === "object" && v !== null && v.k === "err" ? v.v : v;
  } catch (err) {
    got = `抛错：${err?.message ?? err}`;
  }
  if (got !== want && !(typeof want === "number" && typeof got === "number" && Math.abs(want - got) < 1e-9)) {
    failures++;
    console.error(`FAIL ${src}\n     要 ${JSON.stringify(want)}\n     得 ${JSON.stringify(got)}`);
  }
};

// 引用与聚合
eq("SUM(B2:B5)", 700);
eq("SUMIF(A2:A5,\"华东\",B2:B5)", 400);
eq("SUMIFS(B2:B5,A2:A5,\"华东\",C2:C5,\">2\")", 300);
eq("COUNTIF(A2:A5,\"华*\")", 4);
eq("COUNTIF(A2:A5,\"华?\")", 4);
eq("COUNTIFS(A2:A5,\"华东\",C2:C5,\">=3\")", 1);
eq("AVERAGEIFS(B2:B5,A2:A5,\"华东\")", 200);
eq("MAXIFS(B2:B5,A2:A5,\"华东\")", 300);
eq("MINIFS(B2:B5,A2:A5,\"华东\")", 100);
eq("COUNTBLANK(E9:F9)", 2);
eq("SUMPRODUCT(B2:B5,C2:C5)", 100 * 2 + 250 * 5 + 300 * 3 + 50 * 1);
eq("COUNTIF(D2:D5,\">=2024-02-01\")", 3);

// 文本
eq("TEXT(1234.5,\"#,##0.00\")", "1,234.50");
eq("TEXT(0.123,\"0.0%\")", "12.3%");
eq("TEXT(45000,\"yyyy-mm-dd\")", "2023-03-15");
eq("TEXT(1234.5,\"0.0,\")", "1.2"); // 尾部逗号是「除以 1000」，不显示
eq("TEXT(1234,\"[DBNum2]0\")", "壹仟贰佰叁拾肆");
eq("VALUE(\"12.5\")", 12.5);
eq("NUMBERVALUE(\"1.234,56\",\",\",\".\")", 1234.56);
eq("T(\"abc\")", "abc");
eq("N(\"abc\")", 0);
eq("N(TRUE)", 1);
eq("CHAR(65)", "A");
eq("CODE(\"A\")", 65);
eq("CLEAN(\"a\u0007b\")", "ab");
eq("EXACT(\"a\",\"A\")", false);
eq("PROPER(\"hello world\")", "Hello World");
eq("SEARCH(\"c*\",\"abcdef\")", 3);
eq("SEARCH(\"z\",\"abcdef\")", "#VALUE!");
eq("REPLACE(\"abcdef\",2,3,\"X\")", "aXef");
eq("TEXTJOIN(\"-\",TRUE,\"a\",\"\",\"b\")", "a-b");
eq("FIXED(1234.567,1)", "1,234.6");
eq("FIXED(1234.567,1,TRUE)", "1234.6");
eq("DOLLAR(1234.5)", "$1,234.50");

// 日期与时间
eq("DATE(2024,1,5)", 45296);
eq("DATE(2024,13,1)", 45658);
eq("DATEVALUE(\"2024-03-15\")", 45366);
eq("TIME(6,30,0)", 0.2708333333333333);
eq("HOUR(0.75)", 18);
eq("MINUTE(0.5)", 0);
eq("SECOND(TIME(1,2,3))", 3);
eq("WEEKDAY(DATE(2024,1,1))", 2);
eq("WEEKDAY(DATE(2024,1,1),2)", 1);
eq("WEEKNUM(DATE(2024,1,1))", 1);
eq("WEEKNUM(DATE(2024,12,31))", 53);
eq("DAYS360(DATE(2024,1,31),DATE(2024,3,31))", 60);
eq("EDATE(DATE(2024,1,31),1)", 45351);
eq("EOMONTH(DATE(2024,1,15),0)", 45322);
eq("EOMONTH(DATE(2024,1,15),1)", 45351);
eq("DATEDIF(DATE(2024,1,1),DATE(2025,3,15),\"Y\")", 1);
eq("DATEDIF(DATE(2024,1,1),DATE(2025,3,15),\"M\")", 14);
eq("DATEDIF(DATE(2024,1,1),DATE(2025,3,15),\"D\")", 439);
eq("YEARFRAC(DATE(2024,1,1),DATE(2024,7,1))", 0.5);
eq("NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))", 23);
eq("WORKDAY(DATE(2024,1,31),1)", 45323); // 2024-01-31 是周三，下一个工作日是 02-01

// 数学
eq("CEILING(2.1,1)", 3);
eq("CEILING(-2.5,2)", -2);
eq("FLOOR(2.9,1)", 2);
eq("MROUND(7,5)", 5);
eq("MROUND(-7,-5)", -5);
eq("TRUNC(8.9)", 8);
eq("TRUNC(8.99,1)", 8.9);
eq("QUOTIENT(10,3)", 3);
eq("EVEN(3)", 4);
eq("ODD(3)", 3);
eq("ODD(2)", 3);
eq("GCD(12,18)", 6);
eq("LCM(4,6)", 12);
eq("FACT(5)", 120);
eq("COMBIN(5,2)", 10);
eq("PERMUT(5,2)", 20);
eq("SUMSQ(3,4)", 25);
eq("SUMXMY2(B2:B3,C2:C3)", 69629);
eq("ROMAN(1994)", "MCMXCIV");
eq("LOG(100)", 2);
eq("LN(EXP(1))", 1);
eq("ROUND(-2.5,0)", -3);
eq("ROUND(2.5,0)", 3);
// 大数：舍入不能拿「相对补偿」去凑（曾经 ROUND(12345678901234.5,0) = …247）
eq("ROUND(12345678901234.5,0)", 12345678901235);
eq("ROUND(123456789012345,0)", 123456789012345);
eq("ROUND(1.005,2)", 1.01);
eq("ROUND(1234.5,-2)", 1200);
// ROUNDUP / ROUNDDOWN 的方向按绝对值算（负数曾经跑反）
eq("ROUNDUP(-2.1,0)", -3);
eq("ROUNDDOWN(-2.9,0)", -2);
eq("ROUNDDOWN(-2.19,1)", -2.1);
eq("ROUNDUP(2.67,2)", 2.67); // 二进制误差不能把它抬成 2.68
eq("ROUNDDOWN(-0.4,0)", 0);
eq("FIXED(12345678901234.5,2)", "12,345,678,901,234.50");
eq("FIXED(-1234.567,1)", "-1,234.6");
eq("TEXT(12345678901234.5,\"#,##0.00\")", "12,345,678,901,234.50");

// 统计
eq("MEDIAN(1,2,3,4)", 2.5);
eq("MODE(1,2,2,3)", 2);
eq("LARGE(B2:B5,2)", 250);
eq("SMALL(B2:B5,2)", 100);
eq("RANK(250,B2:B5)", 2);
eq("PERCENTILE(B2:B5,0.5)", 175);
eq("QUARTILE(B2:B5,2)", 175);
eq("STDEV(B2:B5)", 119.02380714238083);
eq("VAR.P(1,2,3,4)", 1.25);
eq("DEVSQ(1,2,3)", 2);
eq("GEOMEAN(1,4)", 2);
eq("HARMEAN(1,2)", 1.3333333333333333);
eq("AVEDEV(1,2,3,4)", 1);
eq("STANDARDIZE(42,40,1.5)", 1.3333333333333333);
eq("CORREL(B2:B5,C2:C5)", 0.7789240586062484);
eq("SLOPE(B2:B5,C2:C5)", 54.285714285714285);
eq("INTERCEPT(B2:B5,C2:C5)", 25.714285714285722);
eq("RSQ(B2:B5,C2:C5)", 0.6067226890756302);
eq("FORECAST(4,B2:B5,C2:C5)", 242.85714285714286);
eq("MAXA(1,TRUE)", 1);
eq("TRIMMEAN(B2:B5,0.5)", 175);

// 查找
eq("HLOOKUP(\"金额\",B1:D2,2,FALSE)", 100);
eq("LOOKUP(3,C2:C3,A2:A3)", "华东"); // 近似匹配要求升序，只拿排好的两行试
eq("XLOOKUP(\"华南\",A2:A5,B2:B5)", 250);
eq("XLOOKUP(\"华南\",A2:A5,C2:C5)", 5);
eq("XLOOKUP(\"火星\",A2:A5,B2:B5,\"没有\")", "没有");
eq("XLOOKUP(\"华南\",A2:A5,B2:B5,\"没有\")", 250);
eq("MATCH(\"华南\",A2:A5,0)", 2);
eq("INDEX(B2:B5,2)", 250);
eq("CHOOSE(2,\"甲\",\"乙\",\"丙\")", "乙");
eq("ROWS(B2:B5)", 4);
eq("COLUMNS(B1:D1)", 3);
eq("ROW()", 1);
eq("COLUMN()", 1);
eq("ROW(B7)", 7);
eq("COLUMN(D2)", 4);

// 逻辑与信息
eq("IFS(FALSE,1,TRUE,2)", 2);
eq("IFS(FALSE,1,FALSE,2)", "#N/A");
eq("SWITCH(2,1,\"一\",2,\"二\",\"其他\")", "二");
eq("SWITCH(9,1,\"一\",2,\"二\",\"其他\")", "其他");
eq("XOR(TRUE,TRUE,TRUE)", true);
eq("ISERR(1/0)", true);
eq("ISNA(NA())", true);
eq("ISERR(NA())", false);
eq("ISLOGICAL(TRUE)", true);
eq("ISNONTEXT(1)", true);
eq("ISEVEN(4)", true);
eq("ISODD(4)", false);
eq("TYPE(\"a\")", 2);
eq("ERROR.TYPE(1/0)", 2);
eq("ERROR.TYPE(1)", "#N/A");

// 财务
eq("PMT(0.05,10,1000)", -129.5045749645167);
eq("FV(0.05,10,-100,0)", 1257.7892535548837);
eq("PV(0.05,10,-100,0)", 772.1734929184817);
eq("NPER(0.05,-100,1000)", 14.206699082890442);
eq("SLN(1000,100,5)", 180);
eq("SYD(1000,100,5,1)", 300);
eq("NPV(0.1,-100,60,60)", 3.7565740045078755);

// 工程
eq("DEC2BIN(5)", "101");
eq("DEC2HEX(255)", "FF");
eq("BIN2DEC(\"101\")", 5);
eq("HEX2DEC(\"FF\")", 255);
eq("DELTA(1,1)", 1);
eq("GESTEP(5,4)", 1);

// 错误传播
eq("SUM(1,1/0)", "#DIV/0!");
eq("SUMIF(A2:A5,\"火星\",B2:B5)", 0);
eq("NOSUCHFN(1)", "#NAME?");
eq("1/0", "#DIV/0!");
eq("\"3\"+4", 7);
eq("\"x\"+4", "#VALUE!");

if (failures) {
  console.error(`\n${failures}/${n} 条不符合预期`);
  process.exit(1);
}
console.log(`全部通过（${n} 条）`);
