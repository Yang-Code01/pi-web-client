/**
 * 文件管理器的「输入路径就跳」：路径怎么读（引号、相对/绝对、Windows 有根无盘符）。
 *
 * 只测这一层纯函数。输入框 → /api/stat → 进目录或高亮一行，由 `probes/fs-path-jump.mjs` 的
 * 浏览器探针把关 —— 那才是它的公开缝。
 *
 * Run: node --experimental-transform-types web/tests/dirpath-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanPath, fileNameOf, isAbsolutePath, joinPath, resolveTyped } from "../src/dirpicker.ts";

// ---------------------------------------------------------------- 引号与空白

test("首尾空白和 Explorer 自带的那对引号都去掉", () => {
  assert.equal(cleanPath("  C:\\work  "), "C:\\work");
  assert.equal(cleanPath('"C:\\Program Files\\a.txt"'), "C:\\Program Files\\a.txt");
  assert.equal(cleanPath("'D:/x'"), "D:/x");
  assert.equal(cleanPath(""), "");
});

test("只有配对才去引号：TypeScript 的 `'a'` 那种半截引号留着", () => {
  assert.equal(cleanPath('"C:\\x'), '"C:\\x');
  assert.equal(cleanPath("'"), "'");
});

// ---------------------------------------------------------------- 绝对路径的三种长相

test("盘符、UNC、POSIX 根都是绝对路径", () => {
  assert.equal(isAbsolutePath("C:\\work"), true);
  assert.equal(isAbsolutePath("c:/work"), true);
  assert.equal(isAbsolutePath("\\\\srv\\share\\x"), true);
  assert.equal(isAbsolutePath("/home/me"), true);
  assert.equal(isAbsolutePath("work"), false);
  assert.equal(isAbsolutePath(".\\work"), false);
  assert.equal(isAbsolutePath("C:"), false);
  assert.equal(isAbsolutePath(""), false);
});

test("拼接按已有路径的分隔符走，盘符根不会粘出反斜杠", () => {
  assert.equal(joinPath("C:\\work", "a.txt"), "C:\\work\\a.txt");
  assert.equal(joinPath("C:\\work\\", "a.txt"), "C:\\work\\a.txt");
  assert.equal(joinPath("C:/work/", "a.txt"), "C:/work/a.txt");
  assert.equal(joinPath("/home/me", "a.txt"), "/home/me/a.txt");
  assert.equal(joinPath("", "a.txt"), "a.txt");
});

// ---------------------------------------------------------------- 文件名

test("文件名取最后一段，尾部分隔符不算一段", () => {
  assert.equal(fileNameOf("C:\\work\\a.txt"), "a.txt");
  assert.equal(fileNameOf("C:/work/a.txt"), "a.txt");
  assert.equal(fileNameOf("C:\\work\\"), "work");
  assert.equal(fileNameOf("/"), "/");
});

// ---------------------------------------------------------------- 相对路径落在「当前目录」

test("相对路径按当前目录拼，不交给桥端的 cwd", () => {
  assert.equal(resolveTyped("notes/today.md", "C:\\work"), "C:\\work\\notes/today.md");
  assert.equal(resolveTyped("./a.txt", "F:/pi-web-client"), "F:/pi-web-client/a.txt");
});

test("绝对路径原样通过，相对路径才拼", () => {
  assert.equal(resolveTyped("D:\\other\\a.txt", "C:\\work"), "D:\\other\\a.txt");
  assert.equal(resolveTyped('"C:\\Program Files\\x"', "C:\\work"), "C:\\Program Files\\x");
  assert.equal(resolveTyped("\\\\srv\\share\\x", "C:\\work"), "\\\\srv\\share\\x");
  assert.equal(resolveTyped("/home/me/x", "/home/me"), "/home/me/x");
});

test("Windows 的有根无盘符路径落在当前盘上（\\Users\\me 不是相对路径）", () => {
  assert.equal(resolveTyped("\\Users\\me", "C:\\work"), "C:\\Users\\me");
  assert.equal(resolveTyped("/Users/me", "D:/work"), "D:/Users/me");
});

test("只敲盘符 `C:` 就是那颗盘，不是拼成 `C:\work\C:`", () => {
  assert.equal(resolveTyped("C:", "C:\\work"), "C:\\");
  assert.equal(resolveTyped("d:", "C:\\work"), "d:\\");
});

test("空输入原样返回空，别拼出一个「当前目录」去 stat", () => {
  assert.equal(resolveTyped("", "C:\\work"), "");
  assert.equal(resolveTyped("   ", "C:\\work"), "");
});

test("还没有当前目录（盘符页）时不做相对拼接", () => {
  assert.equal(resolveTyped("work", ""), "work");
  assert.equal(resolveTyped("\\Users\\me", ""), "\\Users\\me");
});
