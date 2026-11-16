/**
 * #438 颜色与标签色：主题色索引、WPS 的边框写法、自定义调色板、sheet 标签色。
 *
 * 起因是用户拿 openpyxl 生成的练习簿预览：正文发白、表头/底纹颜色不对、底部标签没颜色。
 * 逐条钉在这里，别再靠「看起来还行」。
 *
 *   node --experimental-strip-types bridge/tests/sheet-theme-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { readStyles, readTheme, resolveColor } from "../src/sheet/styles.ts";
import { readBook } from "../src/sheet/xlsx.ts";

/** 和 openpyxl / Office 默认主题同名的 12 个槽位，XML 顺序是 dk1,lt1,dk2,lt2… */
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`;

function stylesXml({ font = "", fill = "", border = "", extra = "" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font>${font || '<sz val="11"/><name val="Calibri"/>'}</font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid">${fill || '<fgColor rgb="FFFFFFFF"/>'}</patternFill></fill></fills>
<borders count="2"><border/><border>${border}</border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="${fill ? 1 : 0}" borderId="${border ? 1 : 0}" xfId="0"/></cellXfs>
${extra}
</styleSheet>`;
}

test("主题索引按 Excel 的「背景1/文字1/背景2/文字2」排，不是 clrScheme 的 XML 顺序", () => {
  const theme = readTheme(THEME);
  assert.equal(theme.length, 12);
  assert.equal(theme[0], "#FFFFFF", "theme 0 = 背景 1（lt1）");
  assert.equal(theme[1], "#000000", "theme 1 = 文字 1（dk1）");
  assert.equal(theme[2], "#E7E6E6", "theme 2 = 背景 2（lt2）");
  assert.equal(theme[3], "#44546A", "theme 3 = 文字 2（dk2）");
  assert.equal(theme[4], "#4472C4", "theme 4 = 强调色 1");
  assert.equal(theme[10], "#0563C1", "theme 10 = 超链接色");
});

test("openpyxl 默认字体的 theme=1 解析成黑色，不是白色", () => {
  const t = readStyles(stylesXml({ font: '<sz val="11"/><name val="Calibri"/><color theme="1"/>' }), THEME);
  const st = t.styles[t.index[0]];
  assert.equal(st?.f?.c, "#000000");
});

test("填充的 theme=2 解析成浅灰（lt2），不是深蓝（dk2）", () => {
  const t = readStyles(stylesXml({ fill: '<fgColor theme="2"/>' }), THEME);
  const st = t.styles[t.index[0]];
  assert.equal(st?.bg, "#E7E6E6");
});

test("WPS 的子元素边框写法 <style val=\"thin\"/> 也认", () => {
  const border = '<left><color rgb="FFD9D9D9"/><style val="thin"/></left><right/><top/><bottom/>';
  const t = readStyles(stylesXml({ border }), THEME);
  const st = t.styles[t.index[0]];
  assert.equal(st?.bd?.l, "1px solid #D9D9D9");
});

test("WPS 的 <colors><indexedColors> 覆盖默认索引色", () => {
  const extra = `<colors><indexedColors><rgbColor rgb="00123456"/><rgbColor rgb="00ABCDEF"/></indexedColors></colors>`;
  const t = readStyles(stylesXml({ font: '<color indexed="1"/>', extra }), THEME);
  assert.equal(t.palette[1], "ABCDEF");
  assert.equal(resolveColor('<color indexed="1"/>', readTheme(THEME), t.palette), "#ABCDEF");
});

test("sheet 标签色从 <sheetPr><tabColor> 读出来（rgb 与 theme 两种写法）", () => {
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="蓝色" sheetId="1" r:id="rId1"/><sheet name="主题色" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="008EA9DB"/></sheetPr><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>蓝</t></is></c></row></sheetData></worksheet>`,
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor theme="4"/></sheetPr><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>橙</t></is></c></row></sheetData></worksheet>`,
    ),
    "xl/styles.xml": strToU8(stylesXml()),
    "xl/theme/theme1.xml": strToU8(THEME),
  };
  const book = readBook(zipSync(files, { level: 6 }));
  assert.equal(book.meta.sheets[0]?.tabColor, "#8EA9DB");
  assert.equal(book.meta.sheets[1]?.tabColor, "#4472C4");
});
