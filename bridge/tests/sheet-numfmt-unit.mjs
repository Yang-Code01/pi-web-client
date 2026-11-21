/**
 * 数字格式引擎（D266）的单元测试：只看「这个数字按这段代码显示成什么字」。
 *
 *   node --experimental-strip-types bridge/tests/sheet-numfmt-unit.mjs
 */
import { formatValue, formatText, isDateCode } from "../src/sheet/numfmt.ts";

let failures = 0;
const eq = (code, value, want, date1904 = false) => {
  let got;
  try {
    got = formatValue(value, code, date1904);
  } catch (err) {
    failures++;
    console.error(`FAIL ${code} ← ${value}：抛了 ${err?.message ?? err}`);
    return;
  }
  if (got !== want) {
    failures++;
    console.error(`FAIL ${JSON.stringify(code)} ← ${value}\n     要 ${JSON.stringify(want)}\n     得 ${JSON.stringify(got)}`);
  } else console.log(`ok   ${JSON.stringify(code)} ← ${value} = ${JSON.stringify(got)}`);
};

const eqText = (code, text, want) => {
  const got = formatText(text, code);
  if (got !== want) {
    failures++;
    console.error(`FAIL text ${JSON.stringify(code)} ← ${JSON.stringify(text)}：要 ${JSON.stringify(want)} 得 ${JSON.stringify(got)}`);
  } else console.log(`ok   text ${JSON.stringify(code)} ← ${JSON.stringify(text)} = ${JSON.stringify(got)}`);
};

// 常规
eq("General", 1234.5678, "1234.5678");
eq("General", 0.1 + 0.2, "0.3");
eq("General", -42, "-42");
eq("0", 1234.5678, "1235");
eq("0", -1234.5678, "-1235");
eq("000", 7, "007");
eq("000000", 1234, "001234");

// 小数与千分位
eq("0.00", 1.005, "1.01");
eq("0.00", 2, "2.00");
eq("#,##0", 1234567, "1,234,567");
eq("#,##0.00", -1234.5, "-1,234.50");
eq("#.##", 2, "2");
eq("#.##", 2.5, "2.5");
eq("#.##", 2.567, "2.57");
eq("#", 0, "0");
eq("#,##0_);(#,##0)", -1234, "(1,234)");
eq("#,##0.00_);[Red](#,##0.00)", -1234.5, "(1,234.50)");
eq('"$"#,##0.00', 5, "$5.00");
eq('"$"#,##0.00', -5, "-$5.00");
eq('"$"#,##0_);("$"#,##0)', 5, "$5 "); // `_)` 是占位宽度，Excel 也留这个空格
eq('0 "元"', 5, "5 元");

// 百分比 / 缩放逗号 / 科学记数
eq("0%", 0.1234, "12%");
eq("0.00%", 0.1234, "12.34%");
eq('0"."0,"万元"', 1234567, "1234.6万元");
eq('0.00,,"百万"', 123456789, "123.46百万");
eq("0.00E+00", 12345, "1.23E+04");
eq("0.00E+00", 0.0001234, "1.23E-04");
eq("##0.0E+0", 12345, "12.3E+3");

// 分数
eq("# ?/?", 1.25, "1 1/4");
eq("# ?/?", 0.5, "1/2");
eq("# ??/??", 3.14159, "3 14/99");
eq("?/8", 0.75, "6/8");

// 中文数字
eq("[DBNum1][$-804]G/通用格式", 12, "一十二");
eq("[DBNum2][$-804]G/通用格式", 12345.67, "壹万贰仟叁佰肆拾伍点陆柒");
// 两段式：负数走第二段，负数符号由第二段自己决定（这里是红字，不加负号）
eq("[DBNum2][$RMB]G/通用格式;[红色][DBNum2][$RMB]G/通用格式", -1234, "壹仟贰佰叁拾肆");
eq("[DBNum1]0", 100000, "一十万");

// 日期与时刻
eq("m/d/yy", 45000, "3/15/23");
eq("yyyy-mm-dd", 45000, "2023-03-15");
eq("yyyy年M月d日", 45000, "2023年3月15日");
eq("yyyy-M-d h:mm", 45000.5, "2023-3-15 12:00");
eq("h:mm AM/PM", 45000.75, "6:00 PM");
eq("h:mm:ss", 45000.50001157407, "12:00:01");
eq("[h]:mm:ss", 1.5, "36:00:00");
eq("dddd", 45000, "Wednesday");
eq("ddd", 45000, "Wed");
eq("d-mmm-yy", 45000, "15-Mar-23");
eq("mm:ss", 0.5, "00:00");
eq("yyyy/m/d h:mm:ss", 1, "1900/1/1 0:00:00");
eq("上午/下午h时m分", 45000.75, "下午6时0分");
eq("yyyy\"年\"m\"月\"d\"日\"", 45000, "2023年3月15日");

// 1904 日期系统
eq("yyyy-mm-dd", 1, "1904-01-02", true);

// 文本段
eqText("@", "原文", "原文");
eqText("0.00_);[Red](0.00);0.00;@", "原文", "原文");
eqText('@"元"', "12", "12元");

// 十进制舍入：量级再大也不能被「相对补偿」带偏（曾经 1e12 → 1000000000001）
eq("0", 1e12, "1000000000000");
eq("0", 123456789012345, "123456789012345");
eq("#,##0.00", 12345678901234.5, "12,345,678,901,234.50");
eq(`0.${"0".repeat(15)}`, 1 / 3, "0.333333333333333");
eq("0.00", 0.1 + 0.2, "0.30");
// 舍到 0 之后不留负号

eq("0", -0.4, "0");
eq("0.00", -0.0001, "0.00");
eq("0", -0.5, "-1"); // half-up：-0.5 远离 0 是 -1

// 判定
for (const [code, want] of [["yyyy-mm-dd", true], ["hh:mm", true], ["0.00", false], ["0%", false], ['"$"#,##0', false]]) {
  const got = isDateCode(code);
  if (got !== want) {
    failures++;
    console.error(`FAIL isDateCode(${JSON.stringify(code)}) 要 ${want} 得 ${got}`);
  } else console.log(`ok   isDateCode(${JSON.stringify(code)}) = ${got}`);
}

if (failures) {
  console.error(`\n${failures} 条不符合预期`);
  process.exit(1);
}
console.log("\n全部通过");
