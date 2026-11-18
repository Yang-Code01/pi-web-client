/**
 * D316 文件搜索索引：纯函数先行，再用临时目录跑一遍真扫描 + 真查询（node:sqlite）。
 *
 *   node bridge/tests/fileindex.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { escapeLike, FileIndex, volumeOf } from "../src/fileindex.ts";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check("escapeLike：%、_、\\ 变成字面量，普通字符不动", async () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("C:\\temp"), "C:\\\\temp");
  assert.equal(escapeLike("report"), "report");
});

await check("volumeOf：Windows 取盘符，POSIX 归到 /", async () => {
  if (process.platform === "win32") {
    assert.equal(volumeOf("C:\\Users\\x"), "C:");
    assert.equal(volumeOf("d:/work"), "D:");
  } else {
    assert.equal(volumeOf("/home/x"), "/");
  }
});

await check("扫描一个临时目录：前缀能命中、子串也能命中、SKIP 目录不进库", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  const nested = path.join(root, "docs", "guide");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "report.md"), "a".repeat(120));
  fs.writeFileSync(path.join(nested, "install-report.txt"), "b".repeat(20));
  fs.writeFileSync(path.join(root, "notes.txt"), "c");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "d");

  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  assert.equal(index.status().state, "off", "空库时状态是 off");
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  const ready = index.status();
  assert.equal(ready.state, "ready", `扫描没在 5s 内完成：${JSON.stringify(ready)}`);
  assert.ok(ready.indexed >= 3, `库里应该至少 3 条，实际 ${ready.indexed}`);

  const prefix = index.query("report");
  assert.ok(prefix.rows.length >= 1, "按名字前缀应命中 report.md");
  assert.equal(prefix.rows[0].name.toLowerCase().startsWith("report") || prefix.rows[0].name.includes("report"), true);

  const substr = index.query("install");
  assert.ok(
    substr.rows.some((r) => r.name === "install-report.txt"),
    "子串段应该补上 install-report.txt",
  );

  const none = index.query("没有这个文件xyz");
  assert.equal(none.rows.length, 0);

  const bySize = index.query("", { sort: "size" });
  assert.ok(bySize.rows.length >= 3);
  assert.ok(bySize.rows[0].size >= bySize.rows[bySize.rows.length - 1].size, "按大小排应从大到小");

  const skipped = index.query("index.js");
  assert.equal(skipped.rows.some((r) => r.path.includes("node_modules")), false, "node_modules 不该进库");

  assert.equal(index.query("report", { limit: 1 }).rows.length, 1, "limit 生效");

  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

await check("删掉的文件在下一次 syncPath 后消失", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  const gone = path.join(root, "gone.txt");
  fs.writeFileSync(gone, "x");
  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  assert.equal(index.query("gone").rows.length, 1);
  fs.rmSync(gone, { force: true });
  await index.syncPath(gone);
  assert.equal(index.query("gone").rows.length, 0, "删掉之后不该还在结果里");
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

await check("PI_WEB_FILEINDEX=0 时不开库", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  process.env.PI_WEB_FILEINDEX = "0";
  const index = new FileIndex({ dbFile: path.join(root, "files.db"), roots: [root] });
  await index.open();
  assert.equal(index.status().state, "off");
  assert.equal(index.query("x").rows.length, 0);
  delete process.env.PI_WEB_FILEINDEX;
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

await check("卷勾选：全取消 = 一条不给，勾回一个 = 只剩它", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  fs.writeFileSync(path.join(root, "alpha.txt"), "x");
  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  const vol = index.status().volumes[0].id;
  assert.equal(index.query("alpha").rows.length, 1);
  index.setVolumes([]);
  assert.equal(index.status().volumes[0].enabled, false, "全取消后卷应是 disabled");
  assert.equal(index.query("alpha").rows.length, 0, "全取消后一条都不该给 —— 空范围≠不限范围");
  index.setVolumes([vol]);
  assert.equal(index.status().volumes[0].enabled, true);
  assert.equal(index.query("alpha").rows.length, 1, "勾回之后应恢复");
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\nfileindex: ok");
