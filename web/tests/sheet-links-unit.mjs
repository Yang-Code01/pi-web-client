/**
 * #438 页内超链接解析：`#表名!A1` → { sheet, ref }，外链不进来。
 *
 *   node --experimental-strip-types web/tests/sheet-links-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isExternalLink, matchSheetName, parseSheetLink } from "../src/sheet/links.ts";

test("带引号的中文表名 + 单元格", () => {
  assert.deepEqual(parseSheetLink("#'01 基础格式'!A1"), { sheet: "01 基础格式", ref: "A1" });
});

test("区域、绝对引用、反向区域都归一成左上:右下", () => {
  assert.deepEqual(parseSheetLink("#Sheet1!$A$1:$B$2"), { sheet: "Sheet1", ref: "A1:B2" });
  assert.deepEqual(parseSheetLink("#'排序'!B2:A1"), { sheet: "排序", ref: "A1:B2" });
});

test("表名里的单引号用两个单引号转义", () => {
  assert.deepEqual(parseSheetLink("#'A''B'!C3"), { sheet: "A'B", ref: "C3" });
});

test("百分号转义的链接还原成中文", () => {
  assert.deepEqual(parseSheetLink("#%E8%AF%B4%E6%98%8E!B2"), { sheet: "说明", ref: "B2" });
});

test("只给表名落到 A1（Excel 的行为）", () => {
  assert.deepEqual(parseSheetLink("#'说明'!"), { sheet: "说明", ref: "A1" });
});

test("没有表名的格子留在当前表；命名区域不硬跳", () => {
  assert.deepEqual(parseSheetLink("#A1"), { sheet: null, ref: "A1" });
  assert.equal(parseSheetLink("#税率"), null);
});

test("外链与外部工作簿不当作页内跳转", () => {
  assert.equal(parseSheetLink("https://example.com/a#b"), null);
  assert.equal(parseSheetLink("mailto:a@b?subject=x"), null);
  assert.equal(parseSheetLink("#'[book.xlsx]Sheet1'!A1"), null);
  assert.equal(isExternalLink("https://example.com"), true);
  assert.equal(isExternalLink("#'说明'!A1"), false);
});

test("表名匹配先精确再忽略大小写", () => {
  const sheets = [{ name: "说明" }, { name: "Sheet1" }];
  assert.equal(matchSheetName(sheets, "说明"), "说明");
  assert.equal(matchSheetName(sheets, "sheet1"), "Sheet1");
  assert.equal(matchSheetName(sheets, "不存在"), null);
});
