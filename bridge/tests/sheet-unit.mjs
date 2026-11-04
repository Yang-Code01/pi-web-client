// 桥端表格链路的单测：fixture → 打开 → 读窗口 → 条件格式 → 写回 → 图表还在不在。
// 跑法：node --experimental-strip-types bridge/tests/sheet-unit.mjs
import fs from "node:fs";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { makeFixtures, outDir } from "./fixtures/make-xlsx.mjs";
import { openSheet, saveSheet, sheetFind, sheetWindow } from "../src/sheet.ts";
import { openPreview } from "../src/preview.ts";

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

fs.rmSync(outDir, { recursive: true, force: true });
const files = await makeFixtures();
const st = (f) => fs.statSync(f);
const open = (f) => openSheet(openPreview({ cwd: outDir, file: null }, f).abs, st(f));

console.log("plain.xlsx");
{
  const doc = await open(files.plain);
  eq("mode", doc.mode, "full");
  ok("sheets ≥ 3", doc.sheets.length >= 3, `(got ${doc.sheets.length})`);
  const main = doc.sheets.find((s) => s.name === "変更履歴");
  ok("sheet 名带 CJK", Boolean(main));
  eq("合并单元格", main.merges[0], [0, 0, 0, 5]);
  eq("冻结 3 行", main.freeze.rows, 3);
  ok("隐藏 sheet", doc.sheets.some((s) => s.hidden));

  const win = await sheetWindow(doc.token, "変更履歴", 0, 12, 0, 6);
  const at = (r, c) => win.cells.find((x) => x.r === r && x.c === c);
  eq("A1 标题文本", at(0, 0)?.t, "◆変更履歴");
  eq("A1 加粗", win.styles[at(0, 0).s]?.bold, true);
  eq("表头底色", win.styles[at(2, 0).s]?.fill, "#44546A");
  eq("表头白字", win.styles[at(2, 0).s]?.color, "#FFFFFF");
  eq("表头边框", win.styles[at(2, 0).s]?.border?.t, "1px solid #BFBFBF");
  ok("日期是 d 类", at(3, 0)?.k === "d", `(got ${at(3, 0)?.k})`);
  eq("日期格式化", at(3, 0)?.t, "2026/8/27");
  eq("数字一位小数", at(3, 5)?.t, "2.0");
  ok("超链接带着", String(at(3, 4)?.href ?? "").startsWith("https://"), `(got ${at(3, 4)?.href})`);

  const cf = (r, c) => win.cfs[at(r, c)?.cf ?? -1];
  ok("色阶生效（F4 有底色）", Boolean(cf(3, 5)?.fill), `(got ${JSON.stringify(cf(3, 5))})`);
  ok("色阶最小值偏红", String(cf(6, 5)?.fill ?? "").startsWith("#F"), `(got ${cf(6, 5)?.fill})`);
  ok("数据条按比例", (at(5, 6)?.bar ?? 0) > 0.9, `(got ${at(5, 6)?.bar})`);
  ok("图标集给了符号", Boolean(at(5, 5)?.icon), `(got ${at(5, 5)?.icon})`);
  eq("cellIs 文本命中", cf(5, 3)?.fill, "#FFEB9C");
  eq("表达式：重复值命中 C6", cf(5, 2)?.fill, "#FFC7CE");
  eq("表达式：唯一值不命中 C4", cf(3, 2)?.fill, undefined);

  const found = await sheetFind(doc.token, "変更履歴", "堀田", 0, 0);
  ok("表内查找", found.hits.length >= 2, `(got ${found.hits.length})`);

  // 写回：改一格已有的、一格新的（要新插 row 和 c），再验别的 part 没动。
  const before = unzipSync(new Uint8Array(fs.readFileSync(files.plain)));
  const out = saveSheet({
    token: doc.token,
    groups: [
      {
        sheet: "変更履歴",
        edits: [
          { r: 3, c: 5, t: "n", v: 9.25 },
          { r: 3, c: 3, t: "s", v: "テスト & <tag>" },
          { r: 40, c: 25, t: "s", v: "遠いセル" },
        ],
      },
    ],
    mtime: doc.mtime,
    size: doc.size,
  });
  eq("写回方式", out.mode, "surgical");
  const after = unzipSync(new Uint8Array(fs.readFileSync(files.plain)));
  ok("zip 条目数不变", Object.keys(before).length === Object.keys(after).length);
  const same = ["xl/theme/theme1.xml", "xl/sharedStrings.xml", "docProps/core.xml"].filter((n) => before[n] && after[n] && Buffer.compare(Buffer.from(before[n]), Buffer.from(after[n])) === 0);
  ok("无关 part 一个字节没动", same.length >= 1, `(same=${same.join(",")})`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(files.plain);
  const ws = wb.getWorksheet("変更履歴");
  eq("写回后数字", ws.getCell("F4").value, 9.25);
  eq("写回后文本", ws.getCell("D4").value, "テスト & <tag>");
  eq("新插入的远格", ws.getCell("Z41").value, "遠いセル");
  eq("样式没丢（表头底色）", ws.getCell("A3").fill?.fgColor?.argb, "FF44546A");
  eq("合并单元格没丢", ws.getCell("A1").isMerged, true);
}

console.log("chart.xlsx");
{
  const doc = await open(files.chart);
  eq("图表个数", doc.sheets[0].charts.length, 1);
  eq("图表类型", doc.sheets[0].charts[0]?.kind, "bar");
  eq("图表锚点", [doc.sheets[0].charts[0]?.c1, doc.sheets[0].charts[0]?.r2], [3, 14]);
  const chartBefore = unzipSync(new Uint8Array(fs.readFileSync(files.chart)))["xl/charts/chart1.xml"];
  saveSheet({ token: doc.token, groups: [{ sheet: "売上", edits: [{ r: 1, c: 1, t: "n", v: 999 }] }], mtime: doc.mtime, size: doc.size });
  const zipAfter = unzipSync(new Uint8Array(fs.readFileSync(files.chart)));
  ok("写回之后图表 part 还在", Boolean(zipAfter["xl/charts/chart1.xml"]));
  eq("图表内容没变", Buffer.compare(Buffer.from(chartBefore), Buffer.from(zipAfter["xl/charts/chart1.xml"])), 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(files.chart);
  eq("图表那格写进去了", wb.getWorksheet("売上").getCell("B2").value, 999);
}

console.log("data.csv（GBK + 分号）");
{
  const doc = await open(files.csv);
  eq("认出来是分号", doc.csv.delimiter, ";");
  eq("认出来是 GBK", doc.csv.encoding, "gbk");
  const win = await sheetWindow(doc.token, "data", 0, 2, 0, 4);
  eq("表头", win.cells.find((c) => c.r === 0 && c.c === 0)?.t, "日付");
  eq("数字列被认成数字", win.cells.find((c) => c.r === 1 && c.c === 3)?.k, "n");
  saveSheet({ token: doc.token, groups: [{ sheet: "data", edits: [{ r: 1, c: 2, t: "s", v: "媒体項目マッピング改" }] }], mtime: doc.mtime, size: doc.size });
  const bytes = fs.readFileSync(files.csv);
  ok("没有偷偷加 BOM", !(bytes[0] === 0xef && bytes[1] === 0xbb));
  ok("还是 CRLF", bytes.includes(Buffer.from([0x0d, 0x0a])));
  const iconv = (await import("iconv-lite")).default;
  const text = iconv.decode(bytes, "gbk");
  ok("改的那格在", text.includes("媒体項目マッピング改"), text.split("\r\n")[1]);
  ok("分号没变逗号", text.split("\r\n")[0] === "日付;担当;内容;金額;備考");
}

console.log("big.xlsx（32 万格）");
{
  const doc = await open(files.big);
  eq("降级成只读轻量", doc.mode, "values");
  ok("行数认出来了", doc.sheets[0].rowCount >= 20000, `(got ${doc.sheets[0].rowCount})`);
  const win = await sheetWindow(doc.token, "data", 0, 5, 0, 3);
  ok("轻量模式也能取格子", win.cells.length > 10, `(got ${win.cells.length})`);
  eq("表头中文", win.cells.find((c) => c.r === 0 && c.c === 0)?.t, "列1");
}

console.log(failures ? `\n${failures} 个断言失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
