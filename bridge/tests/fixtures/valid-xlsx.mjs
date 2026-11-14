/** #436 数据验证的最小工作簿：A 列写死列表、B 列引用 D1:D3、C 列整数规则。 */
import { zipSync, strToU8 } from "fflate";

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
const WB = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="表单" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WBRELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:D10"/>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>状态</t></is></c><c r="B1" t="inlineStr"><is><t>优先级</t></is></c><c r="C1" t="inlineStr"><is><t>数量</t></is></c><c r="D1" t="inlineStr"><is><t>低</t></is></c></row>
<row r="2"><c r="D2" t="inlineStr"><is><t>中</t></is></c></row>
<row r="3"><c r="D3" t="inlineStr"><is><t>高</t></is></c></row>
</sheetData>
<dataValidations count="3">
<dataValidation type="list" allowBlank="1" showDropDown="0" sqref="A2:A10"><formula1>"是,否,待定"</formula1></dataValidation>
<dataValidation type="list" allowBlank="1" sqref="B2:B10"><formula1>$D$1:$D$3</formula1></dataValidation>
<dataValidation type="whole" operator="between" sqref="C2:C10" error="只能填 0 到 999 的整数"><formula1>0</formula1><formula2>999</formula2></dataValidation>
</dataValidations>
</worksheet>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

export function buildValidXlsx() {
  return zipSync({
    "[Content_Types].xml": strToU8(CT),
    "_rels/.rels": strToU8(ROOT),
    "xl/workbook.xml": strToU8(WB),
    "xl/_rels/workbook.xml.rels": strToU8(WBRELS),
    "xl/worksheets/sheet1.xml": strToU8(SHEET),
    "xl/styles.xml": strToU8(STYLES),
  });
}
