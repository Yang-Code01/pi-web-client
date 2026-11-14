/**
 * 写回一条**自定义**数字格式（D264）：WPS 的「中文大写数字 / 单位：万元 / 正负号」都不是
 * Excel 的内置 id，得在 `xl/styles.xml` 里造一条 `<numFmt>` 再让格子指过去。
 *
 *   node --experimental-strip-types bridge/tests/sheet-style-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { buildXlsx } from "./fixtures/make-xlsx.mjs";
import { readBook, readWindow } from "../src/sheet/xlsx.ts";
import { saveBook } from "../src/sheet/write.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-style-"));
const FILE = path.join(DIR, "plain.xlsx");
fs.writeFileSync(FILE, buildXlsx());

const ops = [
  // 中文大写数字（WPS 特殊格式）
  { r: 4, c: 2, cell: { k: "n", v: 1234567.89, style: { nf: "[DBNum2][$-804]G/通用格式" } } },
  // 带单位的小数
  { r: 1, c: 2, cell: { k: "n", v: 12.5, style: { nf: '0.00"元"' } } },
  // 分数
  { r: 2, c: 2, cell: { k: "n", v: 3.14159, style: { nf: "# ?/??" } } },
  // 中文日期
  { r: 3, c: 2, cell: { k: "n", v: 45292, style: { nf: 'yyyy"年"m"月"d"日"' } } },
];

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const mtime = fs.statSync(FILE).mtimeMs;
await saveBook(FILE, "销量", ops, mtime);

const buf = new Uint8Array(fs.readFileSync(FILE));
const book = readBook(buf);
const info = book.meta.sheets[0];
const win = readWindow(buf, book, info.name, 0, 6, 0, 3);
const text = (r, c) => win.rows[r]?.cells.find((x) => x.c === c)?.t;

check("中文大写数字写得进去、读得回来", () => assert.equal(text(4, 2), "壹佰贰拾叁万肆仟伍佰陆拾柒点捌玖"));
check("自定义后缀 0.00\"元\"", () => assert.equal(text(1, 2), "12.50元"));
check("分数 # ?/??", () => assert.equal(text(2, 2), "3 14/99"));
check("中文日期 yyyy年m月d日", () => assert.equal(text(3, 2), "2024年1月1日"));

const files = unzipSync(buf);
const styles = strFromU8(files["xl/styles.xml"]);
check("styles.xml 里造出了 4 条自定义 numFmt", () => {
  const list = [...styles.matchAll(/<numFmt\b[^>]*\/>/g)].map((m) => m[0]);
  assert.equal(list.length, 4, list.join(" "));
  assert.match(styles, /<numFmts count="4">/);
});
check("numFmt 的 id 从 164 起且不重复", () => {
  const ids = [...styles.matchAll(/<numFmt numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [164, 165, 166, 167]);
});
check("自定义代码里的引号被转义了", () => {
  assert.ok(styles.includes("&quot;元&quot;"), styles.slice(0, 400));
});
check("numFmts 排在 cellXfs 前面（schema 顺序）", () => {
  assert.ok(styles.indexOf("<numFmts") < styles.indexOf("<cellXfs"), "顺序不对");
});

// 同一条代码再写一次：不能多造一条
const mtime2 = fs.statSync(FILE).mtimeMs;
await saveBook(FILE, "销量", [{ r: 1, c: 3, cell: { k: "n", v: 1, style: { nf: '0.00"元"' } } }], mtime2);
const styles2 = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(FILE)))["xl/styles.xml"]);
check("同一条格式代码复用已有的 numFmt id", () => {
  const list = [...styles2.matchAll(/<numFmt\b[^>]*\/>/g)];
  assert.equal(list.length, 4, list.map((m) => m[0]).join(" "));
});

fs.rmSync(DIR, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 条不符合预期`);
  process.exit(1);
}
console.log("\n全部通过");
