// 表格预览的 fixture：全部现场合成，git 里不放二进制（D116）。
//   plain.xlsx  —— 合并单元格 / 底色边框 / 日期与数字格式 / 超链接 / 冻结窗格 / 条件格式四类 / 隐藏 sheet
//   chart.xlsx  —— 手写的最小 xlsx，带一个柱形图（exceljs 不会写图表，只能自己拼 xml）
//   big.xlsx    —— 32 万格，用来验「只读轻量」降级
//   data.csv    —— GBK + 分号，最容易被当成 UTF-8 写坏的那种
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { zipSync } from "fflate";
import iconv from "iconv-lite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const outDir = process.env.XLSX_FIXTURES || path.join(here, "..", "..", "..", ".scratch", "fixtures");

async function plain(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("変更履歴", { views: [{ state: "frozen", ySplit: 3, xSplit: 0 }] });
  ws.columns = [{ width: 12 }, { width: 26 }, { width: 34 }, { width: 14 }, { width: 30 }, { width: 18 }, { width: 10 }];

  ws.mergeCells("A1:F1");
  const title = ws.getCell("A1");
  title.value = "◆変更履歴";
  title.font = { bold: true, size: 14 };
  title.alignment = { vertical: "middle" };
  ws.getRow(1).height = 26;

  const headers = ["日付", "シート/変更箇所", "変更内容", "変更者", "備考", "工数", "件数"];
  headers.forEach((h, i) => {
    const cell = ws.getRow(3).getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF44546A" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      left: { style: "thin", color: { argb: "FFBFBFBF" } },
      right: { style: "thin", color: { argb: "FFBFBFBF" } },
    };
  });

  const rows = [
    [new Date(2026, 7, 27), "媒体項目マッピング", "ブランから受発注を作成する際の発注種別の分門定義を記載", "對木", "https://example.com/browse/A-1", 2, 10],
    [new Date(2026, 8, 25), "金額関連項目一覧\nコピー時の設定値\nチェック処理", "媒購要因に伴う項目の追加", "久保", "https://example.com/browse/A-2", 4.5, 40],
    [new Date(2026, 9, 21), "変更履歴の作成対象", "変更履歴の作成対象", "堀田", "", 1, 90],
    [new Date(2026, 10, 2), "BEチェック処理", "変更履歴の作成対象", "堀田", "", 0.5, 5],
  ];
  rows.forEach((data, i) => {
    const row = ws.getRow(4 + i);
    data.forEach((value, c) => {
      const cell = row.getCell(c + 1);
      cell.border = { bottom: { style: "thin", color: { argb: "FFD9D9D9" } } };
      if (c === 4 && typeof value === "string" && value.startsWith("http")) {
        cell.value = { text: value, hyperlink: value };
        cell.font = { color: { argb: "FF0563C1" }, underline: true };
      } else if (c === 0) {
        cell.value = value;
        cell.numFmt = "yyyy/m/d";
      } else if (c === 5) {
        cell.value = value;
        cell.numFmt = "0.0";
        cell.alignment = { horizontal: "right" };
      } else {
        cell.value = value;
      }
    });
    row.alignment = { vertical: "top", wrapText: true };
  });

  // 30 行填充：只为了「滚得动」，冻结窗格才有东西可验。
  for (let r = 9; r <= 38; r++) {
    ws.getCell(`A${r}`).value = new Date(2025, 0, (r % 28) + 1);
    ws.getCell(`A${r}`).numFmt = "yyyy/m/d";
    ws.getCell(`C${r}`).value = `行${r}`;
    ws.getCell(`G${r}`).value = r;
  }

  const index = wb.addWorksheet("目次");
  index.getCell("A1").value = "目次";
  index.getCell("A1").font = { bold: true };
  index.getCell("A2").value = "変更履歴";
  index.getCell("A2").value = { text: "変更履歴", hyperlink: "#'変更履歴'!A1" };

  const hidden = wb.addWorksheet("作業", { state: "hidden" });
  hidden.getCell("A1").value = "hidden sheet";

  // 条件格式：色阶 / 数据条 / 图标集 / top10 / 表达式（重复值）
  ws.addConditionalFormatting({
    ref: "F4:F7",
    rules: [
      { type: "colorScale", cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }], color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }] },
    ],
  });
  ws.addConditionalFormatting({
    ref: "G4:G7",
    rules: [{ type: "dataBar", cfvo: [{ type: "min" }, { type: "max" }], color: { argb: "FF638EC6" } }],
  });
  ws.addConditionalFormatting({
    ref: "F4:F7",
    rules: [{ type: "iconSet", iconSet: "3TrafficLights1", cfvo: [{ type: "percent", value: 0 }, { type: "percent", value: 33 }, { type: "percent", value: 67 }] }],
  });
  ws.addConditionalFormatting({
    ref: "G4:G7",
    rules: [{ type: "top10", rank: 2, percent: false, bottom: false, style: { font: { bold: true } }, priority: 5 }],
  });
  ws.addConditionalFormatting({
    ref: "C4:C7",
    rules: [{ type: "expression", formulae: ["COUNTIF($C$4:$C$7,C4)>1"], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } }, font: { color: { argb: "FF9C0006" } } }, priority: 1 }],
  });
  ws.addConditionalFormatting({
    ref: "D4:D7",
    rules: [{ type: "cellIs", operator: "equal", formulae: ['"堀田"'], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFEB9C" } } }, priority: 2 }],
  });

  await wb.xlsx.writeFile(file);
}

/** exceljs 写不出图表，所以这份 zip 是手拼的：够 exceljs（和 Excel）认出「这有一张柱形图」。 */
function chart(file) {
  const enc = (s) => new TextEncoder().encode(s);
  const parts = {
    "[Content_Types].xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
    ),
    "_rels/.rels": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="売上" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:D20"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月</t></is></c><c r="B1" t="inlineStr"><is><t>売上</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>1月</t></is></c><c r="B2"><v>120</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>2月</t></is></c><c r="B3"><v>168</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>`,
    ),
    "xl/worksheets/_rels/sheet1.xml.rels": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
    ),
    "xl/drawings/drawing1.xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="グラフ 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
    ),
    "xl/drawings/_rels/drawing1.xml.rels": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
    ),
    "xl/charts/chart1.xml": enc(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>売上!$B$2:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
    ),
  };
  fs.writeFileSync(file, Buffer.from(zipSync(parts, { level: 6 })));
}

async function big(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("data");
  const rows = 20000;
  ws.getRow(1).values = Array.from({ length: 16 }, (_, i) => `列${i + 1}`);
  for (let r = 2; r <= rows; r++) {
    ws.getRow(r).values = Array.from({ length: 16 }, (_, c) => (c % 3 === 0 ? r * c : `v${r}-${c}`));
  }
  await wb.xlsx.writeFile(file);
}

function csv(file) {
  const lines = [
    "日付;担当;内容;金額;備考",
    "2026/08/27;對木;媒体項目マッピング;12000;ブランから受発注",
    "2026/09/25;久保;金額関連項目一覧;34500;コピー時の設定値",
    "2026/10/21;堀田;変更履歴の作成対象;8000;媒体明細(共通情報)",
    "2026/11/02;堀田;BEチェック処理;0;取0の場合",
  ].join("\r\n");
  fs.writeFileSync(file, iconv.encode(`${lines}\r\n`, "gbk"));
}

export async function makeFixtures() {
  fs.mkdirSync(outDir, { recursive: true });
  const want = path.join(outDir, "plain.xlsx");
  if (!fs.existsSync(want)) {
    await plain(want);
    chart(path.join(outDir, "chart.xlsx"));
    await big(path.join(outDir, "big.xlsx"));
    csv(path.join(outDir, "data.csv"));
  }
  return {
    plain: want,
    chart: path.join(outDir, "chart.xlsx"),
    big: path.join(outDir, "big.xlsx"),
    csv: path.join(outDir, "data.csv"),
  };
}

if (process.argv[1] && process.argv[1].endsWith("make-xlsx.mjs")) {
  const out = await makeFixtures();
  for (const [name, file] of Object.entries(out)) console.log(`${name}\t${file}\t${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
