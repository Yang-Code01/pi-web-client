/**
 * 探针共用一个浏览器入口（D114 / D177）：
 *
 * `probes/*.mjs` 里原本每个文件都抄了一份「去 npx 缓存里翻 playwright」的解析器 —— 19 份。缓存目录名
 * 是 npx 安装时算出来的哈希，换台机器、重装一次就不一样；抄的那一份一旦写死或漏掉 `PW_PATH`，只有
 * 真跑那个探针的人才会撞上 ERR_MODULE_NOT_FOUND，而且报错指向探针自己，看着像探针坏了。
 *
 * 所以：探针不许自己翻缓存，也不许裸 import "playwright"（仓库没有这个依赖），统一
 * `import { loadPlaywright } from "../tools/playwright.mjs"`。
 *
 * Run: node web/tests/probes-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, "probes");
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.join(DIR, f));

const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

test("探针里没有第二份 playwright 解析器", () => {
  const bad = files.filter((f) => read(f).includes("npm-cache"));
  assert.deepEqual(bad.map(rel), [], "这些探针自己翻 npx 缓存，改成 tools/playwright.mjs");
});

test("探针不裸 import playwright", () => {
  const bad = files.filter((f) => /from\s+["']playwright["']/.test(read(f)));
  assert.deepEqual(bad.map(rel), [], "仓库没有 playwright 依赖，走 tools/playwright.mjs");
});

test("共用入口还在，且真的会 launch 一次才认账", () => {
  const src = read(path.join(ROOT, "tools/playwright.mjs"));
  assert.match(src, /export async function loadPlaywright\(\)/);
  assert.match(src, /PW_PATH/);
  assert.match(src, /\.launch\(\)/, "导入成功不算数：浏览器没下载时只有 launch 会报");
});
