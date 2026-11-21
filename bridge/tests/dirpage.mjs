/**
 * 大目录分页（issue #499）的桥端那一半：过滤、排序、切页，以及「文件夹恒在前」这条容易被
 * 排序方向带偏的规矩。
 *
 * 纯函数先测（`filterEntries` / `orderEntries` / `pageEntries`），再拿一个临时目录跑真清单：
 * 分页的 total 是过滤后的总数、按大小排时目录不会跟着翻转、递归能找到子目录里的文件。
 *
 *   node bridge/tests/dirpage.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterEntries, listDirPage, orderEntries, pageEntries } from "../src/dirs.ts";

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};

const dir = (name) => ({ name, kind: "dir" });
const file = (name, size, mtime) => ({ name, kind: "file", size, mtime });

await check("过滤：大小写不敏感，递归时也匹配相对路径", async () => {
  const rows = [{ name: "README.md", kind: "file" }, { name: "a.txt", kind: "file" }, { name: "docs", kind: "dir", rel: undefined }];
  assert.equal(filterEntries(rows, "read").length, 1);
  assert.equal(filterEntries(rows, "  README ").length, 1);
  assert.equal(filterEntries(rows, "txt").length, 1);
  assert.equal(filterEntries(rows, "").length, 3);
  const nested = [{ name: "install.md", kind: "file", rel: "docs/guide/install.md" }];
  assert.equal(filterEntries(nested, "guide").length, 1);
  assert.equal(filterEntries(nested, "nothing").length, 0);
});

await check("排序：名字升序点文件在后，降序文件夹仍在最前", async () => {
  const rows = [file("b.md", 1, 1), dir("z"), dir(".git"), file("a.md", 2, 2)];
  const asc = orderEntries(rows, "name", "asc").map((e) => e.name);
  // 点文件排在后面（沿用 listDirs 的老顺序），文件夹与文件各自成组。
  assert.deepEqual(asc, ["z", ".git", "a.md", "b.md"]);
  const desc = orderEntries(rows, "name", "desc").map((e) => e.name);
  assert.deepEqual(desc, [".git", "z", "b.md", "a.md"]);
});

await check("排序：按大小降序时文件夹不会翻到末尾（原型里踩过的坑）", async () => {
  const rows = [file("small", 10, 1), dir("web"), dir("bridge"), file("big", 900, 2)];
  const out = orderEntries(rows, "size", "desc").map((e) => e.name);
  assert.deepEqual(out, ["bridge", "web", "big", "small"]);
});

await check("排序：按时间时文件夹之间也看各自的 mtime", async () => {
  const rows = [dir("old"), dir("new"), file("a", 1, 5), file("b", 1, 50)];
  const out = orderEntries(rows, "mtime", "desc").map((e) => e.name);
  assert.deepEqual(out, ["new", "old", "b", "a"]);
});

await check("切页：offset 越界给空数组，limit 至少 1", async () => {
  const rows = ["a", "b", "c", "d"].map((n) => file(n, 1, 1));
  assert.deepEqual(pageEntries(rows, 2, 2).map((e) => e.name), ["c", "d"]);
  assert.deepEqual(pageEntries(rows, 9, 2), []);
  assert.equal(pageEntries(rows, 0, 0).length, 1);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-dirpage-"));
fs.mkdirSync(path.join(root, "docs", "guide"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules"));
fs.writeFileSync(path.join(root, "README.md"), "x".repeat(300));
fs.writeFileSync(path.join(root, "a.txt"), "x");
fs.writeFileSync(path.join(root, "b.txt"), "x".repeat(120));
fs.writeFileSync(path.join(root, "docs", "guide", "install.md"), "x");
fs.writeFileSync(path.join(root, "node_modules", "skip-me.md"), "x");
fs.writeFileSync(path.join(root, "node_modules", "a.txt"), "x");

await check("清单：total 是过滤后的总数，一页只给 limit 条", async () => {
  const all = await listDirPage(root, { limit: 200 });
  assert.equal(all.error, undefined);
  // 3 个文件夹（docs / node_modules / 0 个）+ 3 个文件
  assert.equal(all.total, 5);
  assert.equal(all.entries.length, 5);
  assert.equal(all.entries[0].kind, "dir", "文件夹恒在前");
  const first = await listDirPage(root, { limit: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first.dirs, ["docs", "node_modules"]);
  const second = await listDirPage(root, { limit: 2, offset: 2 });
  assert.equal(second.entries.length, 2);
  assert.notEqual(second.entries[0].name, first.entries[0].name);
});

await check("清单：limit / offset 不是数字时回退到默认值，不能切出空页", async () => {
  // URL 上 `?limit=abc` 就是 NaN：以前一路传到 slice，返回 0 条而 total 照旧。
  const bad = await listDirPage(root, { limit: Number("abc"), offset: Number("abc") });
  assert.equal(bad.total, 5);
  assert.equal(bad.entries.length, 5, "NaN 应当当作没传，而不是空页");
  const nan = await listDirPage(root, { limit: Number.NaN, offset: Number.NaN });
  assert.equal(nan.entries.length, 5);
  const inf = await listDirPage(root, { limit: Number.POSITIVE_INFINITY, offset: Number.NaN });
  assert.equal(inf.entries.length, 5, "Infinity 也要兜住");
});

await check("清单：筛选词命中名字，total 跟着变", async () => {
  const hit = await listDirPage(root, { q: "txt" });
  assert.equal(hit.total, 2);
  assert.deepEqual(hit.entries.map((e) => e.name), ["a.txt", "b.txt"]);
});

await check("清单：按大小降序，文件夹在前、文件从大到小", async () => {
  const page = await listDirPage(root, { sort: "size", dir: "desc" });
  assert.deepEqual(page.entries.map((e) => e.name), ["docs", "node_modules", "README.md", "b.txt", "a.txt"]);
  assert.equal(page.entries[2].size, 300);
  assert.equal(page.statsPending, undefined);
});

await check("清单：按时间降序给到 mtime，文件夹也有时间", async () => {
  const page = await listDirPage(root, { sort: "mtime", dir: "desc" });
  assert.equal(page.entries.length, 5);
  for (const entry of page.entries) assert.equal(typeof entry.mtime, "number", entry.name);
  assert.equal(page.entries[0].kind, "dir");
});

await check("清单：递归（sub=1）找到子目录里的文件，并带 rel", async () => {
  const page = await listDirPage(root, { sub: true, q: "install" });
  assert.equal(page.total, 1);
  assert.equal(page.entries[0].rel, "docs/guide/install.md");
  assert.equal(page.entries[0].name, "install.md");
  // node_modules 在 @ 搜索的 SKIP 里，不该被翻出来
  const nm = await listDirPage(root, { sub: true, q: "skip-me" });
  assert.equal(nm.total, 0);
});

await check("清单：不存在的目录报 dirs_missing，而不是空目录", async () => {
  const page = await listDirPage(path.join(root, "nope"));
  assert.equal(page.errCode, "dirs_missing");
  assert.match(page.error, /不存在/);
});

await check("清单：空路径给盘符页（没有 error）", async () => {
  const page = await listDirPage("");
  assert.equal(page.path, "");
  assert.equal(page.error, undefined);
  assert.equal(page.parent, null);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
