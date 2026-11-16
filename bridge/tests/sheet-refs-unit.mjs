/**
 * #438 超链接目标归一：页内目标最终都必须是 `#…`，外链保持原样。
 *
 * openpyxl 把页内链接写成 relationship 的 `Target="#'表名'!A1"`（TargetMode=External），
 * WPS / Excel 常用 `<hyperlink location="'表名'!A1"/>`。两种都得能落到同一条跳转路径上，
 * 否则前端只看见一个 `#` 开头的字符串、当外链丢掉（用户报「点进去跳不到对应 sheet」）。
 *
 *   node --experimental-strip-types bridge/tests/sheet-refs-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { readBook, readWindow } from "../src/sheet/xlsx.ts";

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
const WB = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="目录" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const WBRELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
const CELLS = ["A1", "A2", "A3", "A4", "A5", "A6"];
const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:A6"/>
<sheetData>${CELLS.map((r, i) => `<row r="${i + 1}"><c r="${r}" t="inlineStr"><is><t>${r}</t></is></c></row>`).join("")}</sheetData>
<hyperlinks>
<hyperlink ref="A1" location="'说明'!B2:C3"/>
<hyperlink ref="A2" r:id="rId1"/>
<hyperlink ref="A3" r:id="rId2"/>
<hyperlink ref="A4" location="%E8%AF%B4%E6%98%8E!A1"/>
<hyperlink ref="A5" location="说明!A1"/>
<hyperlink ref="A6" location="#'说明'!D4"/>
</hyperlinks>
</worksheet>`;
const SHEETRELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="#'说明'!D4" TargetMode="External"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a%20b?x=1" TargetMode="External"/>
</Relationships>`;
const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D4"/><sheetData><row r="4"><c r="D4" t="inlineStr"><is><t>目标</t></is></c></row></sheetData></worksheet>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

function book() {
  return zipSync(
    {
      "[Content_Types].xml": strToU8(CT),
      "_rels/.rels": strToU8(ROOT),
      "xl/workbook.xml": strToU8(WB),
      "xl/_rels/workbook.xml.rels": strToU8(WBRELS),
      "xl/worksheets/sheet1.xml": strToU8(SHEET),
      "xl/worksheets/_rels/sheet1.xml.rels": strToU8(SHEETRELS),
      "xl/worksheets/sheet2.xml": strToU8(SHEET2),
      "xl/styles.xml": strToU8(STYLES),
    },
    { level: 6 },
  );
}

const buf = book();
const wb = readBook(buf);
const win = readWindow(buf, wb, "目录", 0, 6, 0, 0);
const link = (r) => win.rows.find((row) => row.r === r)?.cells.find((c) => c.c === 0)?.lnk;

test("location 的页内链接带 # 前缀", () => {
  assert.equal(link(0), "#'说明'!B2:C3");
});

test("relationship 目标本身以 # 开头时原样保留（openpyxl）", () => {
  assert.equal(link(1), "#'说明'!D4");
});

test("relationship 的外链保持原样", () => {
  assert.equal(link(2), "https://example.com/a%20b?x=1");
});

test("location 的百分号转义还原成中文表名", () => {
  assert.equal(link(3), "#说明!A1");
});

test("没引号的表名也能用", () => {
  assert.equal(link(4), "#说明!A1");
});

test("location 自带 # 时不叠成 ##", () => {
  assert.equal(link(5), "#'说明'!D4");
});
