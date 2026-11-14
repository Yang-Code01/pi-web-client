/** #436 自动筛选的最小工作簿：两列六行，A 列带 autoFilter。 */
import { zipSync, strToU8 } from "fflate";

const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
const ROOT = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WB = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="筛选" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const WBRELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const row = (r, a, b) => `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${a}</t></is></c><c r="B${r}"><v>${b}</v></c></row>`;
const SHEET = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B6"/><sheetData>${row(1, "地区", 0)}${row(2, "华东", 10)}${row(3, "华南", 20)}${row(4, "华东", 30)}${row(5, "华北", 40)}${row(6, "华南", 50)}</sheetData><autoFilter ref="A1:B6"/></worksheet>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;

export function buildFilterXlsx() {
  return zipSync({
    "[Content_Types].xml": strToU8(CT),
    "_rels/.rels": strToU8(ROOT),
    "xl/workbook.xml": strToU8(WB),
    "xl/_rels/workbook.xml.rels": strToU8(WBRELS),
    "xl/worksheets/sheet1.xml": strToU8(SHEET),
    "xl/styles.xml": strToU8(STYLES),
  });
}
