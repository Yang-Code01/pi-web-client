/**
 * 文件管理器「输入路径就跳」的桥端那一半：`statPath()` 只回答「这是什么」，不列目录。
 *
 * 三种答案都要对：文件夹（进去）、文件（进父目录并高亮）、没有（原样报错，别退去盘符页）。
 * 盘符根的 dirname 就是它自己，父目录得答空串而不是 `C:\` 自己。它是异步的（睡着的网络盘不该
 * 把整个 bridge 卡住），所以每个 check 都等它。
 *
 *   node bridge/tests/stat-path.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statPath } from "../src/dirs.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-stat-"));
fs.mkdirSync(path.join(root, "sub"));
fs.writeFileSync(path.join(root, "a.txt"), "hi");
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

await check("文件夹 → dir，路径是绝对化的那个", async () => {
  const info = await statPath(path.join(root, "sub"));
  assert.equal(info.kind, "dir");
  assert.equal(info.path, path.join(root, "sub"));
});

await check("文件 → file，父目录是它所在的目录", async () => {
  const info = await statPath(path.join(root, "a.txt"));
  assert.equal(info.kind, "file");
  assert.equal(info.parent, root);
});

await check("不存在的路径 → missing，但仍然给出它的父目录（报错里要显示用户敲的那条）", async () => {
  const info = await statPath(path.join(root, "nope.txt"));
  assert.equal(info.kind, "missing");
  assert.equal(info.parent, root);
  assert.equal(info.path, path.join(root, "nope.txt"));
});

await check("空串 / 只有空白 → 什么都不 stat，免得答出一个「当前目录」", async () => {
  assert.deepEqual(await statPath(""), { path: "", kind: "missing", parent: null });
  assert.deepEqual(await statPath("   "), { path: "", kind: "missing", parent: null });
});

await check("首尾空白不影响判定", async () => {
  const info = await statPath(`  ${path.join(root, "sub")}  `);
  assert.equal(info.kind, "dir");
});

if (process.platform === "win32") {
  await check("盘符根：父目录是空串，不是它自己", async () => {
    const info = await statPath("C:\\");
    assert.equal(info.kind, "dir");
    assert.equal(info.parent, "");
  });
} else {
  await check("POSIX 根：没有父目录就是 null", async () => {
    const info = await statPath("/");
    assert.equal(info.kind, "dir");
    assert.equal(info.parent, null);
  });
}

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
