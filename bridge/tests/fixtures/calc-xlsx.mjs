import { zipSync, strToU8 } from "fflate";

/** 公式补算用的表：所有公式都「只写 <f> 不写 <v>」，模拟 Excel/WPS 没存缓存值。 */
const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:I4"/>
  <col><col min="1" max="9" width="12" customWidth="1"/></col>
  <sheetData>
    <row r="1">
      <c r="A1"><v>1</v></c>
      <c r="B1"><f>SUM(A1:A2)</f></c>
      <c r="C1"><f>IF(B1&gt;2,"大","小")</f></c>
      <c r="D1"><f>ROUND(10/3,2)</f></c>
      <c r="E1"><f>A1&amp;A2&amp;"件"</f></c>
      <c r="F1"><f>VLOOKUP("b",H1:I2,2,FALSE)</f></c>
      <c r="G1"><f>另一张!A1*2</f></c>
      <c r="H1" t="inlineStr"><is><t>a</t></is></c>
      <c r="I1"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2"><v>2</v></c>
      <c r="B2" s="1"><f>A1+A2</f></c>
      <c r="C2"><f>COUNTIF(A1:A2,"&gt;1")</f></c>
      <c r="D2"><f>1/0</f></c>
      <c r="E2"><f>NOSUCHFN(1)</f></c>
      <c r="H2" t="inlineStr"><is><t>b</t></is></c>
      <c r="I2"><v>2</v></c>
    </row>
    <row r="3"><c r="A3"><f>A4</f></c></row>
    <row r="4"><c r="A4"><f>A3</f></c></row>
  </sheetData>
</worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1"/>
  <sheetData><row r="1"><c r="A1"><v>21</v></c></row></sheetData>
</worksheet>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/></numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="计算" sheetId="1" r:id="rId1"/>
    <sheet name="另一张" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

export function buildCalcXlsx() {
  return zipSync({
    "[Content_Types].xml": strToU8(TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "xl/workbook.xml": strToU8(WORKBOOK),
    "xl/_rels/workbook.xml.rels": strToU8(RELS),
    "xl/styles.xml": strToU8(STYLES),
    "xl/worksheets/sheet1.xml": strToU8(SHEET1),
    "xl/worksheets/sheet2.xml": strToU8(SHEET2),
  });
}
