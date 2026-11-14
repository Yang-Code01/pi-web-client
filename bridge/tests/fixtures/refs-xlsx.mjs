/** #435 超链接 + 批注的最小工作簿：A1 外链、B2 页内跳转、C3 带两段批注。 */
import { zipSync, strToU8 } from "fflate";

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>
</Types>`;
const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
const WB = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="链接" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WBRELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:C3"/>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>官网</t></is></c></row>
<row r="2"><c r="B2" t="inlineStr"><is><t>跳到说明</t></is></c></row>
<row r="3"><c r="C3" t="inlineStr"><is><t>带批注</t></is></c></row>
</sheetData>
<hyperlinks>
<hyperlink ref="A1" r:id="rId1"/>
<hyperlink ref="B2" location="'链接'!A1:B2" display="跳到说明"/>
</hyperlinks>
</worksheet>`;
const SHEETRELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/wps" TargetMode="External"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>
</Relationships>`;
const COMMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<authors><author>测试</author></authors>
<commentList>
<comment ref="C3" authorId="0"><text><r><rPr><b/></rPr><t>第一段</t></r><r><t xml:space="preserve"> 第二段</t></r></text></comment>
</commentList>
</comments>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

export function buildRefsXlsx() {
  return zipSync({
    "[Content_Types].xml": strToU8(CT),
    "_rels/.rels": strToU8(ROOT),
    "xl/workbook.xml": strToU8(WB),
    "xl/_rels/workbook.xml.rels": strToU8(WBRELS),
    "xl/worksheets/sheet1.xml": strToU8(SHEET),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(SHEETRELS),
    "xl/comments1.xml": strToU8(COMMENTS),
    "xl/styles.xml": strToU8(STYLES),
  });
}
