/**
 * D321 文件搜索索引：纯函数先行，再用临时目录跑一遍真扫描 + 真查询（node:sqlite）。
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

await check("扫到一半被打断：再开库不认半套索引，转 off 等重扫", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  const dbFile = path.join(root, ".idx", "files.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE files(path TEXT PRIMARY KEY, nlow TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0, is_dir INTEGER NOT NULL DEFAULT 0, vol TEXT NOT NULL, gen INTEGER NOT NULL);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO files(path,nlow,size,mtime,is_dir,vol,gen) VALUES(?,?,?,?,?,?,?)").run(
    "C:\\half\\a.txt", "a.txt", 1, 0, 0, "C:", 1);
  db.prepare("INSERT INTO meta(k, v) VALUES('scanStartedAt', ?)").run(String(Date.now()));
  db.close();
  const index = new FileIndex({ dbFile, roots: [root] });
  await index.open();
  assert.equal(index.status().state, "off", "半套索引不该当 ready —— 否则会永久缺一半文件");
  assert.equal(index.status().indexed, 1, "库里的行还在（只是等重扫清掉）");
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// D324：2.06M 行的真库上，计划走歪 = 单次 20 s 的同步阻塞，面板空着、整个 bridge 停住。
// 计划只看 SQL 形状与索引，小库上 SQLite 的选择和大库一样（都没 ANALYZE），所以在这里钉死。
await check("查询计划：不走 idx_files_vol、前缀是区间、名字子串是覆盖扫描、空查询不排临时表", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  fs.writeFileSync(path.join(root, "alpha.txt"), "x");
  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  const vols = [index.status().volumes[0].id];
  for (const sort of ["name", "size", "mtime"]) {
    for (const q of ["", "al", "pha"]) {
      for (const plan of index.explain(q, { volumes: vols, sort })) {
        assert.ok(!plan.includes("idx_files_vol"), `q=${q} sort=${sort} 走了 vol 索引：${plan}`);
        // 空查询按名字排就该顺着名字索引走（取够 LIMIT 就停）；有词时顺着它逐行回表找子串 = 读完整张表。
        if (q) assert.ok(!/SCAN files USING INDEX idx_files_nlow/.test(plan), `q=${q} sort=${sort} 顺着名字索引逐行回表：${plan}`);
      }
    }
    const empty = index.explain("", { volumes: vols, sort })[0];
    assert.ok(!empty.includes("TEMP B-TREE"), `空查询 sort=${sort} 要走索引顺序，不排全表：${empty}`);
  }
  const [prefix, sub, ...rest] = index.explain("al", { volumes: vols });
  assert.match(prefix, /idx_files_nlow \(nlow>\? AND nlow<\?\)/, `前缀要用名字索引的区间：${prefix}`);
  assert.match(sub, /COVERING INDEX idx_files_nlow/, `名字子串要在索引上覆盖扫描：${sub}`);
  assert.equal(rest.length, 0, "不带分隔符时不该扫整条路径");
  assert.equal(index.explain("x/al", { volumes: vols }).length, 3, "带分隔符才加路径那一段");
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

await check("只按名字匹配；搜索词带 \\ 或 / 才匹配路径", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  fs.mkdirSync(path.join(root, "docs", "guide"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide", "install.txt"), "x");
  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  const names = (q) => index.query(q).rows.map((r) => r.name);
  assert.deepEqual(names("guide"), ["guide"], "只命中名字叫 guide 的目录，不命中它下面的文件");
  assert.ok(names("guide/inst").includes("install.txt"), "带 / 时按路径命中");
  assert.ok(names(`guide${path.sep}inst`).includes("install.txt"), "带本机分隔符时按路径命中");
  assert.equal(names("100%").length, 0, "% 是字面量");
  index.close();
  fs.rmSync(root, { recursive: true, force: true });
});

await check("重建索引不清表：重扫期间照样搜得到，扫完删掉没再见到的行", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fileindex-"));
  fs.writeFileSync(path.join(root, "keep.txt"), "x");
  fs.writeFileSync(path.join(root, "gone.txt"), "x");
  const index = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await index.open();
  index.start();
  for (let i = 0; i < 100 && index.status().state !== "ready"; i += 1) await sleep(50);
  index.close();
  // 关着的时候删一个：再开库不会收到 watch 事件，只能靠重扫按 gen 清掉。
  fs.rmSync(path.join(root, "gone.txt"));
  const again = new FileIndex({ dbFile: path.join(root, ".idx", "files.db"), roots: [root] });
  await again.open();
  again.start();
  assert.equal(again.status().state, "scanning");
  assert.equal(again.query("keep").rows.length, 1, "重扫刚开始就该还能搜到旧行");
  for (let i = 0; i < 100 && again.status().state !== "ready"; i += 1) await sleep(50);
  assert.equal(again.query("keep").rows.length, 1);
  assert.equal(again.query("gone").rows.length, 0, "扫完应删掉本轮没见到的行");
  again.close();
  fs.rmSync(root, { recursive: true, force: true });
});

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\nfileindex: ok");
