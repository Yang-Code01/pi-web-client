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

function sheetXml(rows) {
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          if (!cell) return "";
          const ref = `${colName(c)}${r + 1}`;
          if (cell.inline) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.inline)}</t></is></c>`;
          if (cell.str !== undefined) return `<c r="${ref}" t="s"><v>${cell.str}</v></c>`;
          if (cell.bool !== undefined) return `<c r="${ref}" t="b"><v>${cell.bool ? 1 : 0}</v></c>`;
          if (cell.err !== undefined) return `<c r="${ref}" t="e"><v>${esc(cell.err)}</v></c>`;
          return `<c r="${ref}"><v>${esc(cell.num)}</v></c>`;
        })
        .join("");
      return inner ? `<row r="${r + 1}">${inner}</row>` : "";
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H${rows.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${body}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
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

/** 写到 outDir/plain.xlsx，返回绝对路径。 */
export function makeFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "plain.xlsx");
  fs.writeFileSync(file, buildXlsx());
  return { plain: file, files: [file] };
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const out = process.argv[2] ?? path.join(process.cwd(), "fixtures-out");
  const made = makeFixtures(out);
  console.log(made.plain);
}
