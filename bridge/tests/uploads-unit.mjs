/**
 * 「从本设备选文件」的上传暂存区：文件名清洗、重名、原子落盘、30 天清理。
 *
 * 这里只测磁盘规则（公开接口 uploads.ts），不经过 HTTP、不碰浏览器；按钮 → 输入框那条接线
 * 在 attach-picker.mjs 里用真桥 + 真页面跑。
 *
 *   node --experimental-strip-types bridge/tests/uploads-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_UPLOAD_BYTES, pruneUploads, removeUpload, safeName, saveUpload, uploadsDir } from "../src/uploads.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-uploads-"));
process.env.PI_WEB_STATE = root;

const SID = "sess-123";
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name} — ${err.message}`);
  }
};
const throwsCode = (fn, code) => {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `抛的是 ${err.code}，期望 ${code}（${err.message}）`);
    return;
  }
  assert.fail(`没有抛错（期望 ${code}）`);
};

check("只取 basename：/ 和 \\ 都当分隔符，目录部分丢掉", () => {
  assert.equal(safeName("a\\b/c.pdf"), "c.pdf");
  assert.equal(safeName("../../x.txt"), "x.txt");
  assert.equal(safeName("C:\\Users\\me\\报告.docx"), "报告.docx");
});

check("控制字符与 Windows 非法字符被洗掉，其余原样", () => {
  assert.equal(safeName('a\u0001b<>:"|?*c.txt'), "abc.txt");
  assert.equal(safeName("hello.  "), "hello");
});

check("空名 / . / .. 回退成 file", () => {
  assert.equal(safeName(""), "file");
  assert.equal(safeName("   "), "file");
  assert.equal(safeName("."), "file");
  assert.equal(safeName(".."), "file");
});

check("Windows 保留名加下划线，避免 CON.txt 这类名字建不出来", () => {
  assert.equal(safeName("CON.txt"), "_CON.txt");
  assert.equal(safeName("lpt1"), "_lpt1");
});

check("中文、空格、emoji 原样保留", () => {
  const name = "报告 v2 🚀.txt";
  const saved = saveUpload(SID, name, Buffer.from("hello"));
  assert.equal(saved.name, name);
  assert.equal(fs.readFileSync(saved.path, "utf8"), "hello");
});

check("0 字节文件照常落盘", () => {
  const saved = saveUpload(SID, "empty.txt", Buffer.alloc(0));
  assert.equal(fs.statSync(saved.path).size, 0);
});

check("同名不覆盖：第二份是 foo-2.pdf，两份内容各归各的", () => {
  const a = saveUpload(SID, "foo.pdf", Buffer.from("one"));
  const b = saveUpload(SID, "foo.pdf", Buffer.from("two"));
  assert.equal(path.basename(a.path), "foo.pdf");
  assert.equal(path.basename(b.path), "foo-2.pdf");
  assert.equal(fs.readFileSync(a.path, "utf8"), "one");
  assert.equal(fs.readFileSync(b.path, "utf8"), "two");
});

check("超长名字截到 120 字符，扩展名还在", () => {
  const saved = saveUpload(SID, `${"很".repeat(300)}.txt`, Buffer.from("x"));
  const chars = Array.from(saved.name);
  assert.equal(chars.length, 120);
  assert.ok(saved.name.endsWith(".txt"), `被截成了「${saved.name}」`);
});

check(`超过 ${MAX_UPLOAD_BYTES} 字节直接拒绝（code=too_large），不落半份文件`, () => {
  const before = fs.readdirSync(uploadsDir(SID)).length;
  throwsCode(() => saveUpload(SID, "big.bin", Buffer.alloc(MAX_UPLOAD_BYTES + 1)), "too_large");
  assert.equal(fs.readdirSync(uploadsDir(SID)).length, before);
});

check("保存后不留临时文件", () => {
  assert.deepEqual(fs.readdirSync(uploadsDir(SID)).filter((n) => n.startsWith(".upload-")), []);
});

check("removeUpload 只删本会话目录里的文件", () => {
  const saved = saveUpload(SID, "gone.txt", Buffer.from("x"));
  assert.equal(removeUpload(SID, saved.path), true);
  assert.equal(fs.existsSync(saved.path), false);
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "keep");
  assert.equal(removeUpload(SID, outside), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

check("pruneUploads：只清 30 天没动过的会话目录和残留临时文件", () => {
  const oldDir = uploadsDir("old-session");
  const newDir = uploadsDir("new-session");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldFile = path.join(oldDir, "old.txt");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(path.join(newDir, "new.txt"), "new");
  const staleTmp = path.join(root, "uploads", ".upload-crashed.tmp");
  fs.writeFileSync(staleTmp, "half");
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
  fs.utimesSync(oldDir, old, old);
  fs.utimesSync(staleTmp, old, old);
  const keepOutside = path.join(root, "keep-me");
  fs.mkdirSync(keepOutside, { recursive: true });
  fs.utimesSync(keepOutside, old, old);

  const removed = pruneUploads();
  assert.equal(removed, 2, `清了 ${removed} 项，期望 2（旧目录 + 残留临时文件）`);
  assert.equal(fs.existsSync(oldDir), false);
  assert.ok(fs.existsSync(newDir));
  assert.equal(fs.existsSync(staleTmp), false);
  assert.ok(fs.existsSync(keepOutside), "uploads 之外的旧目录不该被碰");
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log("\n全通过");
}
