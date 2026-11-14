/**
 * 造 xlsx fixture（D166）：fflate 手写包内零件，不引 exceljs、不碰 python。
 *
 * 只造 #105 需要的那一份：单工作表、150 行、文本 / 小数 / 整数 / 日期序列号 / 布尔 /
 * 内联字符串 / XML 实体，够验「格子显示文件里的值」与「按行区间取数」。
 * 二进制不进 git：probe 现场生成到 .scratch。
 */
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8, Zip, ZipDeflate } from "fflate";

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
          if (cell.formula !== undefined) {
            // #111：公式 + 文件里存的上次结果。`cached` / `v` 都没给 = Excel 没存结果，
            // 这种格子只有 `<f>`，读的时候必须显空，不能猜 0。
            const cached = cell.cached ?? cell.v;
            const type = cell.type ? ` t="${cell.type}"` : "";
            const value = cached === undefined ? "" : `<v>${esc(cached)}</v>`;
            return `<c r="${ref}"${s}${type}><f>${esc(cell.formula)}</f>${value}</c>`;
          }
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
  const drawings = extra.drawing ? `<drawing r:id="${extra.drawing}"/>` : "";
  const pane = extra.pane
    ? `<pane${extra.pane.xSplit ? ` xSplit="${extra.pane.xSplit}"` : ""}${extra.pane.ySplit ? ` ySplit="${extra.pane.ySplit}"` : ""} topLeftCell="${extra.pane.topLeftCell}" activePane="bottomRight" state="frozen"/>`
    : "";
  const cf = extra.cf ?? "";
  const dim = extra.dimension ?? `A1:H${rows.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${extra.drawing ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : ""}><dimension ref="${dim}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${merges}${cf}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${drawings}</worksheet>`;
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
export function fixtureRows({ firstArea = "华东" } = {}) {
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
    [firstArea, "螺丝", 12.5, 3, 37.5, "中文备注", "001", null],
    ["华南", "扳手", 3.14159, 10, 31.4159, "日本語テスト", "002", { err: "#DIV/0!" }],
    ["华北", "螺母", 45292, 1, 45292, "华东 & 华南 <测试>", "003", null],
    ["西南", "垫片", 1234567.89, 250, 308641972.5, null, "004", { bool: true }],
    ["东北", "铆钉", 0.125, 8, 1, { inline: "内联字符串" }, "005", { bool: false }],
  ];
  for (const [area, product, price, qty, total, note, code, extra] of fixed) {
    let noteCell = null;
    if (typeof note === "string") noteCell = { str: si(note) };
    else if (note) noteCell = { inline: note.inline };
    const cells = [
      { str: si(area) },
      { str: si(product) },
      { num: price },
      { num: qty },
      { num: total },
      noteCell,
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

export function buildXlsx({ firstArea } = {}) {
  const { rows, strings } = fixtureRows({ firstArea });
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

/**
 * 条件格式 fixture（#109）：五类各占一列，外加一条故意不支持的规则。
 *
 *  - B 得分：三色色阶（min / 50% / max），10 → 红、55 → 黄、100 → 绿。
 *  - C 销量：数据条，0..1000 按值画长度（100 / 500 / 1000 = 10% / 50% / 100%）。
 *  - D 评级：三档图标集（1..10，阈值 4 / 7）。
 *  - E 差额：cellIs 小于 0（红字）/ 大于 0（绿字加粗）/ 等于 0（黄底）。
 *  - F 区间：cellIs 介于 10..20（浅绿底）。
 *  - G 隔行：公式规则 MOD(ROW(),2)=0（浅灰底）。
 *  - H 备注：containsText —— 求值器不支持，不涂色，只计数。
 */
const CF_HEADER = ["项目", "得分", "销量", "评级", "差额", "区间", "隔行", "备注"];

const CF_DATA = [
  ["项目1", 10, 100, 1, -30, 5, 10, "重点A"],
  ["项目2", 20, 200, 2, -10, 15, 20, "普通"],
  ["项目3", 30, 300, 3, 0, 25, 30, "重点B"],
  ["项目4", 40, 400, 4, 10, 5, 40, "普通"],
  ["项目5", 50, 500, 5, 30, 15, 50, "普通"],
  ["项目6", 60, 600, 6, -5, 25, 60, "普通"],
  ["项目7", 70, 700, 7, 5, 5, 70, "普通"],
  ["项目8", 80, 800, 8, 0, 15, 80, "普通"],
  ["项目9", 90, 900, 9, 20, 25, 90, "普通"],
  ["项目10", 100, 1000, 10, -20, 5, 100, "普通"],
  ["项目11", 55, 550, 5, 15, 15, 110, "普通"],
];

const CF_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="5"><dxf><font><color rgb="FF9C0006"/></font></dxf><dxf><font><b/><color rgb="FF006100"/></font></dxf><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFFF2CC"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFE2EFDA"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFF2F2F2"/></patternFill></fill></dxf></dxfs></styleSheet>`;

const CF_RULES = `
<conditionalFormatting sqref="B2:B12"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>
<conditionalFormatting sqref="C2:C12"><cfRule type="dataBar" priority="2"><dataBar><cfvo type="num" val="0"/><cfvo type="num" val="1000"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>
<conditionalFormatting sqref="D2:D12"><cfRule type="iconSet" priority="3"><iconSet iconSet="3TrafficLights1"><cfvo type="num" val="0"/><cfvo type="num" val="4"/><cfvo type="num" val="7"/></iconSet></cfRule></conditionalFormatting>
<conditionalFormatting sqref="E2:E12"><cfRule type="cellIs" dxfId="0" priority="4" operator="lessThan"><formula>0</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="5" operator="greaterThan"><formula>0</formula></cfRule><cfRule type="cellIs" dxfId="2" priority="6" operator="equal"><formula>0</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="F2:F12"><cfRule type="cellIs" dxfId="3" priority="7" operator="between"><formula>10</formula><formula>20</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="G2:G12"><cfRule type="expression" dxfId="4" priority="8"><formula>MOD(ROW(),2)=0</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="H2:H12"><cfRule type="containsText" dxfId="2" priority="9" operator="containsText" text="重点"><formula>NOT(ISERROR(SEARCH("重点",H2)))</formula></cfRule></conditionalFormatting>`;

export function buildConditionalXlsx() {
  const strings = [];
  const si = (text) => {
    let i = strings.indexOf(text);
    if (i < 0) {
      strings.push(text);
      i = strings.length - 1;
    }
    return i;
  };
  const rows = [CF_HEADER.map((t) => ({ str: si(t), s: 0 }))];
  for (const row of CF_DATA) {
    rows.push([
      { str: si(row[0]) },
      { num: row[1] },
      { num: row[2] },
      { num: row[3] },
      { num: row[4] },
      { num: row[5] },
      { num: row[6] },
      { str: si(row[7]) },
    ]);
  }
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="条件格式" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(CF_STYLES),
    "xl/sharedStrings.xml": strToU8(sharedStrings(strings)),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(rows, { dimension: "A1:H12", cf: CF_RULES })),
  };
  return zipSync(files, { level: 6 });
}


/**
 * 公式 fixture（#111）：一格「公式 + 文件存的结果」、一格「只有公式」、一格「空 <v>`」、
 * 一格带 `<f>` 的文本公式，外加一张没有公式的表（切过去计数要消失）。
 * 缺缓存值的格子固定 3 个（D3 / D4 / D5），probe 按这个数断言状态条。
 */
const FORMULA_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function formulaRows(si) {
  const rows = [
    ["项目", "数量", "单价", "金额", "备注"].map((t) => ({ str: si(t) })),
    [
      { str: si("螺丝") },
      { num: 3 },
      { num: 12.5 },
      { formula: "B2*C2", v: 37.5 },
      { formula: 'B2&"×"&C2', type: "str", cached: "3×12.5" },
    ],
    [{ str: si("扳手") }, { num: 10 }, { num: 3.5 }, { formula: "B3*C3" }, { inline: "没有 <v>" }],
    [{ str: si("螺母") }, { num: 5 }, { num: 2 }, { formula: "B4*C4", v: "" }, { inline: "空 <v>" }],
    [{ str: si("垫片") }, { num: 2 }, { num: 7.25 }, { formula: "SUM(D2:D4)" }, { inline: "没有 <v>" }],
    [{ str: si("合计") }, { num: 20 }, null, { formula: "SUM(D2:D5)", v: 37.5 }, { inline: "有缓存" }],
  ];
  return rows;
}

export function buildFormulaXlsx() {
  const strings = [];
  const si = (text) => {
    let i = strings.indexOf(text);
    if (i < 0) {
      strings.push(text);
      i = strings.length - 1;
    }
    return i;
  };
  const s1 = sheetXml(formulaRows(si), { dimension: "A1:E6" });
  const s2 = sheetXml([[{ inline: "说明" }], [{ inline: "这张表没有公式，计数只算当前这张表" }]], { dimension: "A1:A2" });
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2]
        .map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销量" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(FORMULA_STYLES),
    "xl/sharedStrings.xml": strToU8(sharedStrings(strings)),
    "xl/worksheets/sheet1.xml": strToU8(s1),
    "xl/worksheets/sheet2.xml": strToU8(s2),
  };
  return zipSync(files, { level: 6 });
}

/**
 * 页面视图 fixture（#112）：在 plain.xlsx 上加一个真的图表部件（手写 DrawingML chart）。
 *
 * 只为了证明「zip 里有 xl/charts/chartN.xml」这条判据：LibreOffice 转 PDF 时能把
 * 表格和图表画进同一张纸。图表引用销量表的 A2:A8 / D2:D8。
 */
export function buildChartXlsx() {
  const { rows, strings } = fixtureRows();
  const cats = ["华东", "华南", "华北", "西南", "东北", "西北", "华中"];
  const vals = [3, 10, 1, 250, 8, 6, 7];
  const pt = (i, v) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`;
  const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:lang val="zh-CN"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1200"/><a:t>月度销量</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>'销量'!$D$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>数量</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>'销量'!$A$2:$A$8</c:f><c:strCache><c:ptCount val="7"/>${cats.map(pt).join("")}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>'销量'!$D$2:$D$8</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="7"/>${vals.map(pt).join("")}</c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>18</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
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
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(rows, { drawing: "rId1" })),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    ),
    "xl/drawings/drawing1.xml": strToU8(drawing),
    "xl/drawings/_rels/drawing1.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
    ),
    "xl/charts/chart1.xml": strToU8(chart),
  };
  return zipSync(files, { level: 6 });
}

/** 写到 outDir/plain.xlsx 与 outDir/report.xlsx，返回绝对路径。 */

/*
 * GBK 编码：Node 只有解码器（`TextDecoder("gbk")`），没有编码器。
 * 反转一次全表（12000 对左右的常用字，实测 ~21 ms），同一进程里只建一次。
 */
let gbkMap = null;
function gbkTable() {
  if (gbkMap) return gbkMap;
  const dec = new TextDecoder("gbk");
  gbkMap = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== "\ufffd" && !gbkMap.has(ch)) gbkMap.set(ch, (lead << 8) | trail);
    }
  }
  return gbkMap;
}

export function gbkBytes(text) {
  const table = gbkTable();
  const out = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else {
      const pair = table.get(ch);
      if (pair) out.push(pair >> 8, pair & 0xff);
      else out.push(0x3f); // 编不出来的字写成 "?"：fixture 里不会出现
    }
  }
  return Buffer.from(out);
}

const UTF8_CSV = [
  "地区;产品;单价;备注",
  '华东;"螺丝;M4";12.5;中文备注',
  '华南;扳手;3.14159;"他说 ""好"""',
  "华北;螺母;45292;第三行",
].join("\r\n");

const BOM_CSV = ["地区,产品,数量,备注", "华东,螺丝,3,带 BOM 的 CSV", "华南,扳手,10,第二行"].join("\r\n");

const GBK_CSV = ["地区;产品;单价;备注", "华东;螺丝;12.5;中文备注", "华南;扳手;3.14;第二行", "华北;螺母;45292;第三行"].join(
  "\r\n",
);

/** 超上限用：5 万行以上、但字节数仍在 2 MB 以内。 */
export function bigCsv() {
  const lines = ["行号,数值,备注"];
  for (let i = 1; i <= 50100; i++) lines.push(`${i},v${i},备注${i}`);
  return lines.join("\n");
}

/** 三份编码的 CSV + 一份超行数上限的。 */
export function makeCsvFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, buf) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, buf);
    return file;
  };
  const utf8 = write("utf8.csv", Buffer.from(UTF8_CSV, "utf8"));
  const bom = write("bom.csv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BOM_CSV, "utf8")]));
  const gbk = write("gbk.csv", gbkBytes(GBK_CSV));
  const big = write("big.csv", Buffer.from(bigCsv(), "utf8"));
  return { utf8, bom, gbk, big, files: [utf8, bom, gbk, big] };
}

/**
 * 富样式 fixture（#427）：把 Excel 里常见的「好看」都放进来一份，专治渲染退化。
 *
 * 标题行（18pt 粗体 + medium 下边框 + 合并）、深蓝表头（白字 / 居中 / 换行）、
 * 隔行浅蓝填充、细灰四边框、货币 / 日期 / 百分比 / 负数红括号 / 千分位、右缩进两格、
 * 自动换行的备注、30 字符宽的长列、行 3 显式 34.5pt、行 9 隐藏、冻结 B3、
 * 合计行黄底粗体、一行溢出到右侧空列的长文本；第二张表 `showGridLines="0"`。
 */
const STYLED_FONTS = [
  `<font><sz val="11"/><color rgb="FF1F2430"/><name val="Calibri"/><family val="2"/></font>`, // 0 正文
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>`, // 1 表头白字
  `<font><b/><sz val="18"/><color rgb="FF1F3864"/><name val="Calibri"/></font>`, // 2 标题
  `<font><sz val="9"/><color rgb="FF7F7F7F"/><name val="Calibri"/></font>`, // 3 小灰（备注）
  `<font><b/><sz val="12"/><color rgb="FF1F2430"/><name val="Calibri"/></font>`, // 4 合计
  `<font><b/><sz val="16"/><color rgb="FF2E75B6"/><name val="Calibri"/></font>`, // 5 说明页大标题
];
const STYLED_FILLS = [
  `<fill><patternFill patternType="none"/></fill>`,
  `<fill><patternFill patternType="gray125"/></fill>`,
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>`, // 深蓝表头
  `<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>`, // 隔行浅蓝
  `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>`, // 合计黄
];
const styledSide = (rgb = "FFD9D9D9") => `<color rgb="${rgb}"/><style val="thin"/>`;
const STYLED_BORDERS = [
  `<border><left/><right/><top/><bottom/><diagonal/></border>`, // 0 无
  `<border><left>${styledSide()}</left><right>${styledSide()}</right><top>${styledSide()}</top><bottom>${styledSide()}</bottom><diagonal/></border>`, // 1 细灰四边
  `<border><left>${styledSide()}</left><right>${styledSide()}</right><top>${styledSide()}</top><bottom><color rgb="FF1F4E79"/><style val="medium"/></bottom><diagonal/></border>`, // 2 表头
  `<border><left>${styledSide("FFBFBFBF")}</left><right>${styledSide("FFBFBFBF")}</right><top><color rgb="FF1F4E79"/><style val="medium"/></top><bottom><color rgb="FF1F4E79"/><style val="medium"/></bottom><diagonal/></border>`, // 3 标题/合计
];

/** 富样式 fixture 的内容，导出给 probe 断言用。 */
export const STYLED = {
  sheet: "销售明细",
  header: ["地区", "产品", "单价", "数量", "占比", "日期", "备注", "状态"],
  rows: [
    ["华东", "螺丝 M6", 1234.5, 1234568, 0.123, 45678, "这是一段很长的备注，用来测换行与行高自适应", "进行中", 812346, 6400, 12],
    ["东北", "产品 4", 110.5, 3702, 0.04, 45296, "短备注", "已完成", 2333, 300, 3],
    ["西北", "产品 5", 114, 4936, 0.05, 45297, "含税价，季度结算，需要财务复核后入账", "待审核", 3110, 400, 4],
    ["华中", "产品 6", 117.5, 6170, 0.06, 45298, "", "已完成", 3888, 500, 5],
    ["华南", "产品 7（出口）", 121, 7404, 0.07, 45299, "出口报关号 SH-2024-0912", "进行中", 4665, 600, 6],
    ["华北", "产品 1", 124.5, 8638, 0.08, 45300, "", "已完成", 5443, 700, 7],
    // 第 9 行被 hidden="1" 藏起来：行号要直接跳到 10。
    ["西南", "产品 2", 126, 9426, 0.09, 45301, "这一行在文件里被隐藏", "已完成", 6220, 800, 8],
    ["华北", "产品 2", 128.5, 10214, 0.1, 45302, "", "已完成", 6998, 900, 9],
  ],
  /** 合计行（1 基）、隐藏行、显式加高的行。 */
  totalRow: 11,
  hiddenRow: 9,
  tallRow: 3,
};

export function buildStyledXlsx() {
  const xfs = [];
  const xf = (numFmt, font, fill, border, align) =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1"' : ""}>${align ? `<alignment ${align}/>` : ""}</xf>`;
  const add = (numFmt, font, fill, border, align) => xfs.push(xf(numFmt, font, fill, border, align)) - 1;
  const DEF = add(0, 0, 0, 0);
  const TITLE = add(0, 2, 0, 3, 'horizontal="center" vertical="center"');
  const HEAD = add(0, 1, 2, 2, 'horizontal="center" vertical="center" wrapText="1"');
  const TEXT = add(0, 0, 0, 1, 'vertical="center"');
  const MONEY = add(164, 0, 0, 1, 'horizontal="right" vertical="center"');
  const DATE = add(165, 0, 0, 1, 'horizontal="center" vertical="center"');
  const PCT = add(167, 0, 0, 1, 'horizontal="center" vertical="center"');
  const NOTE = add(0, 3, 0, 1, 'vertical="center" wrapText="1"');
  const NEG = add(169, 0, 0, 1, 'horizontal="right" vertical="center"');
  const INT = add(3, 0, 0, 1, 'horizontal="right" vertical="center"');
  const TOT_MONEY = add(164, 4, 4, 3, 'horizontal="right" vertical="center"');
  const TOT_TEXT = add(0, 4, 4, 3, 'horizontal="center" vertical="center"');
  const PLAIN_INDENT = add(0, 0, 0, 0, 'horizontal="left" indent="2"');
  const BIG = add(0, 5, 0, 0, 'horizontal="center" vertical="center"');
  // 隔行浅蓝：同样的对齐/边框，只换 fill。
  const B_TEXT = add(0, 0, 3, 1, 'vertical="center"');
  const B_MONEY = add(164, 0, 3, 1, 'horizontal="right" vertical="center"');
  const B_DATE = add(165, 0, 3, 1, 'horizontal="center" vertical="center"');
  const B_PCT = add(167, 0, 3, 1, 'horizontal="center" vertical="center"');
  const B_NOTE = add(0, 3, 3, 1, 'vertical="center" wrapText="1"');
  const B_NEG = add(169, 0, 3, 1, 'horizontal="right" vertical="center"');
  const B_INT = add(3, 0, 3, 1, 'horizontal="right" vertical="center"');

  const inline = (ref, st, text) => `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  const num = (ref, st, n) => `<c r="${ref}" s="${st}"><v>${n}</v></c>`;
  const bare = (ref, st) => `<c r="${ref}" s="${st}"/>`;

  const widths = [11, 16, 13, 10, 9, 12, 30, 11, 10, 11, 10];
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");

  const rows = [];
  rows.push(
    `<row r="1" ht="33" customHeight="1">${inline("A1", TITLE, "2024 年度销售汇总（华东 / 华南 / 华北）")}${["B", "C", "D", "E", "F", "G", "H"].map((c) => bare(`${c}1`, TITLE)).join("")}</row>`,
  );
  rows.push(`<row r="2" ht="24" customHeight="1">${STYLED.header.map((h, i) => inline(`${colName(i)}2`, HEAD, h)).join("")}</row>`);
  STYLED.rows.forEach((d, i) => {
    const r = 3 + i;
    const band = i % 2 === 1;
    const ht = i === 0 ? ' ht="34.5" customHeight="1"' : "";
    const hidden = r === STYLED.hiddenRow ? ' hidden="1"' : "";
    rows.push(
      `<row r="${r}"${ht}${hidden}>` +
        inline(`A${r}`, band ? B_TEXT : TEXT, d[0]) +
        inline(`B${r}`, band ? B_TEXT : TEXT, d[1]) +
        num(`C${r}`, band ? B_MONEY : MONEY, d[2]) +
        num(`D${r}`, band ? B_MONEY : MONEY, d[3]) +
        num(`E${r}`, band ? B_PCT : PCT, d[4]) +
        num(`F${r}`, band ? B_DATE : DATE, d[5]) +
        inline(`G${r}`, band ? B_NOTE : NOTE, d[6]) +
        inline(`H${r}`, band ? B_TEXT : TEXT, d[7]) +
        num(`I${r}`, band ? B_MONEY : MONEY, d[8]) +
        num(`J${r}`, band ? B_NEG : NEG, i === 2 ? -d[9] : d[9]) +
        num(`K${r}`, band ? B_INT : INT, d[10]) +
        `</row>`,
    );
  });
  const tr = STYLED.totalRow;
  rows.push(
    `<row r="${tr}" ht="22" customHeight="1">${inline(`A${tr}`, TOT_TEXT, "合计")}${bare(`B${tr}`, TOT_TEXT)}${num(`C${tr}`, TOT_MONEY, 2450.66)}${num(`D${tr}`, TOT_MONEY, 268128)}${num(`E${tr}`, TOT_MONEY, 1)}${bare(`F${tr}`, TOT_TEXT)}${inline(`G${tr}`, TOT_TEXT, "以上为 2024 年全年数据")}${bare(`H${tr}`, TOT_TEXT)}</row>`,
  );
  rows.push(
    `<row r="${tr + 1}">${inline(`A${tr + 1}`, PLAIN_INDENT, "缩进两格的说明文字")}${inline(`B${tr + 1}`, TEXT, "这是一段会溢出到右侧空白列的很长很长的文本，用来验证 Excel 的 overflow 行为")}${["C", "D", "E", "F", "G", "H"].map((c) => bare(`${c}${tr + 1}`, DEF)).join("")}</row>`,
  );

  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:K${tr + 1}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="B3" sqref="B3"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" defaultColWidth="8.43"/><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData><mergeCells count="1"><mergeCell ref="A1:H1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1" ht="21" customHeight="1">${inline("A1", BIG, "无网格线的说明页")}${bare("B1", BIG)}${bare("C1", BIG)}</row><row r="2">${inline("A2", TEXT, "左侧留白，居中显示的日期：")}${num("B2", DATE, 45678)}${bare("C2", DEF)}</row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${STYLED.sheet}" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
      ),
      "xl/theme/theme1.xml": strToU8(theme),
      "xl/styles.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="167" formatCode="0.0%"/><numFmt numFmtId="169" formatCode="#,##0.00;[Red](#,##0.00)"/></numFmts><fonts count="${STYLED_FONTS.length}">${STYLED_FONTS.join("")}</fonts><fills count="${STYLED_FILLS.length}">${STYLED_FILLS.join("")}</fills><borders count="${STYLED_BORDERS.length}">${STYLED_BORDERS.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet1),
      "xl/worksheets/sheet2.xml": strToU8(sheet2),
    },
    { level: 6 },
  );
}

// 1×1 红点：够小，也好认（自然宽高 > 0 就说明字节真的取到了）。
const PIC_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * #427：带图片的表。一张两格锚点（B2 → E7，铺满这片），一张一格锚点（固定 120×80 贴在 G2）。
 * 图片走 drawing + media 两个 part，和 Excel 存出来的结构一致。
 */
export function buildPicXlsx() {
  const NS = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const pic = (id, name, blip) =>
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${esc(name)}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${blip}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
  const from = (c, r) => `<xdr:from><xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`;
  const to = (c, r) => `<xdr:to><xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr ${NS}><xdr:twoCellAnchor editAs="oneCell">${from(1, 1)}${to(4, 6)}${pic(2, "两格锚点", "rId1")}<xdr:clientData/></xdr:twoCellAnchor><xdr:oneCellAnchor>${from(6, 1)}<xdr:ext cx="1143000" cy="762000"/>${pic(3, "一格锚点", "rId1")}<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;

  const rows = [];
  rows.push(`<row r="1"><c r="A1" t="inlineStr"><is><t>图片放置</t></is></c></row>`);
  rows.push(`<row r="2"><c r="A2" t="inlineStr"><is><t>两格锚点</t></is></c></row>`);
  rows.push(`<row r="7"><c r="A7" t="inlineStr"><is><t>一格锚点</t></is></c></row>`);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:J10"/><sheetData>${rows.join("")}</sheetData><drawing r:id="rId1"/></worksheet>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="图片" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
      "xl/styles.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      ),
      "xl/drawings/drawing1.xml": strToU8(drawing),
      "xl/drawings/_rels/drawing1.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
      ),
      "xl/media/image1.png": Buffer.from(PIC_PNG, "base64"),
    },
    { level: 6 },
  );
}

export function makeFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "plain.xlsx");
  fs.writeFileSync(file, buildXlsx());
  const report = path.join(outDir, "report.xlsx");
  fs.writeFileSync(report, buildReportXlsx());
  const chart = path.join(outDir, "chart.xlsx");
  fs.writeFileSync(chart, buildChartXlsx());
  const cf = path.join(outDir, "cf.xlsx");
  fs.writeFileSync(cf, buildConditionalXlsx());
  const formula = path.join(outDir, "formula.xlsx");
  fs.writeFileSync(formula, buildFormulaXlsx());
  const styled = path.join(outDir, "styled.xlsx");
  fs.writeFileSync(styled, buildStyledXlsx());
  const pic = path.join(outDir, "pic.xlsx");
  fs.writeFileSync(pic, buildPicXlsx());
  const csv = makeCsvFixtures(outDir);
  return { plain: file, report, chart, cf, formula, styled, pic, csv, files: [file, report, chart, cf, formula, styled, pic, ...csv.files] };
}

/** OLE2 复合文档头：老式 .xls，以及加密过的 OOXML 包（CFB 包着加密流）都以它开头。 */
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function cfbDoc(label) {
  const pad = Buffer.alloc(512, 0);
  pad.write(label, 0, "utf8");
  return Buffer.concat([CFB, pad]);
}

/**
 * #106 的降级 fixture：这里打不开、只能交给 Excel 的那些格式。
 *  - legacy.xls 老式复合文档
 *  - secret.xlsx 加密过的包（扩展名是 xlsx，内容却是 CFB）
 *  - table.ods 开放文档格式（是个 zip，但不是 xlsx 的零件）
 *  - fake.xlsx 改了扩展名的 docx（是 zip，但没有 xl/workbook.xml）
 */
export function makeUnsupportedFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, bytes) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  return {
    legacy: write("legacy.xls", cfbDoc("legacy xls")),
    secret: write("secret.xlsx", cfbDoc("encrypted ooxml")),
    ods: write(
      "table.ods",
      Buffer.from(
        zipSync({
          mimetype: strToU8("application/vnd.oasis.opendocument.spreadsheet"),
          "content.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell><text:p>ODS</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
          ),
        }),
      ),
    ),
    fake: write(
      "fake.xlsx",
      Buffer.from(
        zipSync({
          "[Content_Types].xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
          ),
          "word/document.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`,
          ),
        }),
      ),
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * #110 压测表：五档（2 万 / 10 万 / 40 万 / 100 万 / 300 万格），统一 100 列。
 * 只用来量阈值，不进 git（.scratch 下现场生成）。全表一个 colorScale：
 * full 档要真的把 CF 统计量算一遍，light 档则完全不碰它。
 * ------------------------------------------------------------------------ */

export const STRESS_TIERS = [
  { name: "stress-2w.xlsx", rows: 200, cols: 100, cells: 20_000, tier: "full" },
  { name: "stress-10w.xlsx", rows: 1_000, cols: 100, cells: 100_000, tier: "full" },
  { name: "stress-40w.xlsx", rows: 4_000, cols: 100, cells: 400_000, tier: "light" },
  { name: "stress-100w.xlsx", rows: 10_000, cols: 100, cells: 1_000_000, tier: "light" },
  { name: "stress-300w.xlsx", rows: 30_000, cols: 100, cells: 3_000_000, tier: "none" },
];

const STRESS_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>`;

function stressSheet(rows, cols, emit) {
  const width = colName(cols - 1);
  emit(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${width}${rows}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>`,
  );
  const refs = Array.from({ length: cols }, (_, c) => colName(c));
  const head = refs.map((ref, c) => `<c r="${ref}1" t="inlineStr"><is><t>${c === 0 ? "行" : `列${c}`}</t></is></c>`).join("");
  emit(`<row r="1">${head}</row>`);
  let buf = "";
  for (let r = 1; r < rows; r++) {
    buf += `<row r="${r + 1}">`;
    for (let c = 0; c < cols; c++) {
      const v = c === 0 ? r + 1 : r * 1000 + c;
      buf += `<c r="${refs[c]}${r + 1}"><v>${v}</v></c>`;
    }
    buf += "</row>";
    // 3M 格的 XML 不能一口气拼完：按 ~512KB 一段推给 deflate。
    if (buf.length >= 512 * 1024) {
      emit(buf);
      buf = "";
    }
  }
  if (buf) emit(buf);
  emit(
    `</sheetData><conditionalFormatting sqref="A2:${width}${rows}"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
  );
}

/** 流式写 zip：3M 格的 XML 只按段过 deflate，压缩后的字节才留在内存里。 */
function writeZipStream(file, parts) {
  return new Promise((resolve, reject) => {
    const out = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      out.push(chunk);
      if (!final) return;
      try {
        fs.writeFileSync(file, Buffer.concat(out));
        resolve(file);
      } catch (e) {
        reject(e);
      }
    });
    try {
      for (const part of parts) {
        const entry = new ZipDeflate(part.name, { level: 1 });
        zip.add(entry);
        part.write((text) => entry.push(strToU8(text), false));
        entry.push(new Uint8Array(0), true);
      }
      zip.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** 造一张 rows×cols 的压测表（首列行号，其余 r*1000+c），带一个覆盖全表的色阶。 */
export async function buildStressXlsx(file, { rows, cols }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sheetName = `大表${rows}`;
  const files = [
    {
      name: "[Content_Types].xml",
      write: (push) =>
        push(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        ),
    },
    {
      name: "_rels/.rels",
      write: (push) =>
        push(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        ),
    },
    {
      name: "xl/workbook.xml",
      write: (push) =>
        push(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      write: (push) =>
        push(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        ),
    },
    { name: "xl/styles.xml", write: (push) => push(STRESS_STYLES) },
    { name: "xl/worksheets/sheet1.xml", write: (push) => stressSheet(rows, cols, push) },
  ];
  await writeZipStream(file, files);
  return file;
}

export async function makeStressFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const made = [];
  for (const tier of STRESS_TIERS) {
    const file = path.join(outDir, tier.name);
    await buildStressXlsx(file, { rows: tier.rows, cols: tier.cols });
    made.push({ ...tier, file });
  }
  return made;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const out = process.argv[2] ?? path.join(process.cwd(), "fixtures-out");
  const made = makeFixtures(out);
  console.log(made.plain);
  for (const f of made.csv.files) console.log(f);
}
