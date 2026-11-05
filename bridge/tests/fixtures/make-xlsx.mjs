/**
 * 造 xlsx fixture（D127）：fflate 手写包内零件，不引 exceljs、不碰 python。
 *
 * 只造 #105 需要的那一份：单工作表、150 行、文本 / 小数 / 整数 / 日期序列号 / 布尔 /
 * 内联字符串 / XML 实体，够验「格子显示文件里的值」与「按行区间取数」。
 * 二进制不进 git：probe 现场生成到 .scratch。
 */
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

const HEADER = ["地区", "产品", "单价", "数量", "金额", "备注", "编号", "错误"];

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 共享字符串表：Excel 的 t="s" 格子里存的是这里的下标。 */
function sharedStrings(list) {
  const body = list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${body}</sst>`;
}

function sheetXml(rows, extra = {}) {
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          if (!cell) return "";
          const ref = `${colName(c)}${r + 1}`;
          const s = cell.s === undefined ? "" : ` s="${cell.s}"`;
          if (cell.inline) return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.inline)}</t></is></c>`;
          if (cell.str !== undefined) return `<c r="${ref}"${s} t="s"><v>${cell.str}</v></c>`;
          if (cell.bool !== undefined) return `<c r="${ref}"${s} t="b"><v>${cell.bool ? 1 : 0}</v></c>`;
          if (cell.err !== undefined) return `<c r="${ref}"${s} t="e"><v>${esc(cell.err)}</v></c>`;
          return `<c r="${ref}"${s}><v>${esc(cell.num)}</v></c>`;
        })
        .join("");
      return inner ? `<row r="${r + 1}">${inner}</row>` : "";
    })
    .join("");
  const cols = extra.cols ? `<cols>${extra.cols}</cols>` : "";
  const merges = extra.merges
    ? `<mergeCells count="${extra.merges.length}">${extra.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  const pane = extra.pane
    ? `<pane${extra.pane.xSplit ? ` xSplit="${extra.pane.xSplit}"` : ""}${extra.pane.ySplit ? ` ySplit="${extra.pane.ySplit}"` : ""} topLeftCell="${extra.pane.topLeftCell}" activePane="bottomRight" state="frozen"/>`
    : "";
  const dim = extra.dimension ?? `A1:H${rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${merges}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

export function colName(c) {
  let out = "";
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 行数据：第 0 行表头，其余是数据行（共 150 行）。 */
export function fixtureRows() {
  const values = [...HEADER];
  const si = (text) => {
    let i = values.indexOf(text);
    if (i < 0) {
      values.push(text);
      i = values.length - 1;
    }
    return i;
  };
  const rows = [HEADER.map((t) => ({ str: si(t) }))];
  const fixed = [
    ["华东", "螺丝", 12.5, 3, 37.5, "中文备注", "001", null],
    ["华南", "扳手", 3.14159, 10, 31.4159, "日本語テスト", "002", { err: "#DIV/0!" }],
    ["华北", "螺母", 45292, 1, 45292, "华东 & 华南 <测试>", "003", null],
    ["西南", "垫片", 1234567.89, 250, 308641972.5, null, "004", { bool: true }],
    ["东北", "铆钉", 0.125, 8, 1, { inline: "内联字符串" }, "005", { bool: false }],
  ];
  for (const [area, product, price, qty, total, note, code, extra] of fixed) {
    const cells = [
      { str: si(area) },
      { str: si(product) },
      { num: price },
      { num: qty },
      { num: total },
      note === null ? null : typeof note === "string" ? { str: si(note) } : { inline: note.inline },
      { str: si(code) },
      extra ?? null,
    ];
    rows.push(cells);
  }
  const areas = ["华东", "华南", "华北", "西南", "东北", "西北", "华中", "东南"];
  for (let i = 5; i < 150; i++) {
    const area = areas[i % areas.length];
    rows.push([
      { str: si(area) },
      { str: si(`产品${(i % 9) + 1}`) },
      { num: +(i * 1.25).toFixed(2) },
      { num: (i % 40) + 1 },
      { num: +((i * 1.25 * ((i % 40) + 1)).toFixed(2)) },
      null,
      { str: si(String(100 + i).padStart(3, "0")) },
      null,
    ]);
  }
  return { rows, strings: values };
}

export function buildXlsx() {
  const { rows, strings } = fixtureRows();
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销量" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    "xl/sharedStrings.xml": strToU8(sharedStrings(strings)),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(rows)),
  };
  return zipSync(files, { level: 6 });
}

/**
 * 结构保真 fixture（#108）：合并标题、文件里的列宽、数字/日期/货币/百分比/时刻格式、
 * 冻结首行首列、两张可见表 + 一张隐藏表。数字故意取有歧义的值（45678 只在日期格式下才成日期）。
 */
const REPORT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="h:mm"/><numFmt numFmtId="167" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const REPORT_COLS = [
  '<col min="1" max="1" width="18" customWidth="1"/>',
  '<col min="2" max="2" width="12" customWidth="1"/>',
  '<col min="3" max="3" width="11" customWidth="1"/>',
  '<col min="4" max="4" width="10" customWidth="1"/>',
  '<col min="5" max="5" width="9" customWidth="1"/>',
  '<col min="6" max="6" width="13" customWidth="1"/>',
  '<col min="7" max="7" width="8" customWidth="1"/>',
  '<col min="8" max="8" width="5" customWidth="1"/>',
  // I..N 是「表比窗口宽」的对照组：冻结列要在真的能横向滚动时还贴左边。
  ...["9", "10", "11", "12", "13", "14"].map((n) => `<col min="${n}" max="${n}" width="12" customWidth="1"/>`),
].join("");

const REPORT_HEADER = ["地区", "产品", "单价", "数量", "占比", "日期", "时刻", "备注", "毛利", "成本", "库存", "负责人", "状态", "备注2"];

function reportSheet1(si) {
  const rows = [
    [{ str: si("2024 年度销售汇总"), s: 1 }],
    REPORT_HEADER.map((t) => ({ str: si(t), s: 7 })),
    [
      { str: si("华东"), s: 7 },
      { str: si("螺丝") },
      { num: 1234.5, s: 2 },
      { num: 1234567.89, s: 3 },
      { num: 0.1234, s: 4 },
      { num: 45678, s: 5 },
      { num: 0.75, s: 6 },
      { inline: "这是一段很长的备注文字，列很窄也不该撑破布局" },
      { num: 812345.5, s: 3 },
      { num: 6400 },
      { num: 12 },
      { str: si("张三") },
      { str: si("已核对") },
      { str: si("跨列可见") },
    ],
  ];
  const areas = ["华南", "华北", "西南", "东北", "西北", "华中"];
  for (let r = 3; r <= 40; r++) {
    rows.push([
      { str: si(areas[r % areas.length]), s: 7 },
      { str: si(`产品${(r % 7) + 1}`) },
      { num: 100 + r * 3.5, s: 2 },
      { num: r * 1234, s: 3 },
      { num: ((r % 20) + 1) / 100, s: 4 },
      { num: 45292 + r, s: 5 },
      { num: ((r % 24) + 0.25) / 24, s: 6 },
      null,
      { num: r * 777.5, s: 3 },
      { num: r * 100 },
      { num: r % 30 },
      { str: si(areas[(r + 2) % areas.length]) },
      { str: si(r % 2 ? "已核对" : "待核对") },
      { str: si(`补充${r % 5}`) },
    ]);
  }
  return {
    xml: sheetXml(rows, {
      dimension: "A1:N41",
      cols: REPORT_COLS,
      merges: ["A1:N1"],
      pane: { xSplit: 1, ySplit: 1, topLeftCell: "B2" },
    }),
  };
}

function reportSheet2(si) {
  const rows = [[{ str: si("明细表头"), s: 1 }], [{ str: si("第二张表的数据") }]];
  for (let r = 3; r <= 20; r++) rows.push([{ num: r * 10 }]);
  return { xml: sheetXml(rows, { dimension: "A1:C20", cols: '<col min="1" max="1" width="20" customWidth="1"/>' }) };
}

function reportSheet3() {
  return { xml: sheetXml([[{ inline: "HIDDEN" }]], { dimension: "A1:A1" }) };
}

export function buildReportXlsx() {
  const strings = [];
  const si = (text) => {
    let i = strings.indexOf(text);
    if (i < 0) {
      strings.push(text);
      i = strings.length - 1;
    }
    return i;
  };
  for (const t of [...REPORT_HEADER, "2024 年度销售汇总"]) si(t);
  const s1 = reportSheet1(si);
  const s2 = reportSheet2(si);
  const s3 = reportSheet3();
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2, 3]
        .map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="报表" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/><sheet name="参数" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(REPORT_STYLES),
    "xl/sharedStrings.xml": strToU8(sharedStrings(strings)),
    "xl/worksheets/sheet1.xml": strToU8(s1.xml),
    "xl/worksheets/sheet2.xml": strToU8(s2.xml),
    "xl/worksheets/sheet3.xml": strToU8(s3.xml),
  };
  return zipSync(files, { level: 6 });
}

/** 写到 outDir/plain.xlsx 与 outDir/report.xlsx，返回绝对路径。 */
export function makeFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "plain.xlsx");
  fs.writeFileSync(file, buildXlsx());
  const report = path.join(outDir, "report.xlsx");
  fs.writeFileSync(report, buildReportXlsx());
  return { plain: file, report, files: [file, report] };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const out = process.argv[2] ?? path.join(process.cwd(), "fixtures-out");
  const made = makeFixtures(out);
  console.log(made.plain);
}
