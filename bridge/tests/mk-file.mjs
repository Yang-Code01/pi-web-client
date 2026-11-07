/**
 * D167: 新建文件（`makeFile`）—— 空文件、只建一层、绝不覆盖。
 *
 * 新建文件夹（`makeDir`）的校验是**同一套**（checkEntryName / resolveParent），所以这里也顺带
 * 盯着它的报错文字没被重构改掉：新会话弹层、文件管理器、附件弹层都靠这些句子告诉用户哪儿错了。
 *
 *   node bridge/tests/mk-file.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDir, makeFile } from "../src/dirs.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mk-"));
fs.mkdirSync(path.join(root, "sub"));
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
const throwsWith = (fn, text) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err.message.includes(text), `报错是「${err.message}」，没有「${text}」`);
    return;
  }
  assert.fail(`没有抛错（期望「${text}」）`);
};

await check("建出来的是一个 0 字节的空文件，返回绝对路径", async () => {
  const abs = makeFile(root, "a.txt");
  assert.equal(abs, path.join(root, "a.txt"));
  assert.equal(fs.statSync(abs).size, 0);
});

await check("同名文件不会被覆盖：报「已经存在」，原来那几字节原样留着", async () => {
  fs.writeFileSync(path.join(root, "keep.txt"), "do not touch");
  throwsWith(() => makeFile(root, "keep.txt"), "已经存在");
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "do not touch");
});

await check("同名文件夹不会被当成文件写进去，也不会被文件代替", async () => {
  throwsWith(() => makeFile(root, "sub"), "已经存在");
  assert.ok(fs.statSync(path.join(root, "sub")).isDirectory());
});

await check("名字原样：不补扩展名、不改大小写、首尾空白剪掉", async () => {
  const abs = makeFile(root, "  README  ");
  assert.equal(path.basename(abs), "README");
  assert.equal(fs.readFileSync(abs, "utf8"), "");
});

await check("只建一层：名字里带 / 或 \\ 直接拒绝", async () => {
  throwsWith(() => makeFile(root, "a/b.txt"), "文件名里不能有 / 或 \\（一次只建一层）");
  throwsWith(() => makeFile(root, "a\\b.txt"), "文件名里不能有 / 或 \\（一次只建一层）");
});

await check("空名字 / . / .. -> 各自的报错", async () => {
  throwsWith(() => makeFile(root, "   "), "文件名不能为空");
  throwsWith(() => makeFile(root, "."), "文件名不能是 . 或 ..");
  throwsWith(() => makeFile(root, ".."), "文件名不能是 . 或 ..");
});

await check("父目录必须是已经存在的目录", async () => {
  throwsWith(() => makeFile("", "x.txt"), "先进入一个目录再新建文件");
  throwsWith(() => makeFile(path.join(root, "nope"), "x.txt"), "上级目录不存在");
  throwsWith(() => makeFile(path.join(root, "a.txt"), "x.txt"), "上级目录不存在");
});

if (process.platform === "win32") {
  await check("Windows 非法字符 / 结尾点号 / 保留名", async () => {
    throwsWith(() => makeFile(root, 'a:b.txt'), "文件名不能包含 < > : \" | ? *");
    throwsWith(() => makeFile(root, "a."), "Windows 下文件名不能以空格或 . 结尾");
    throwsWith(() => makeFile(root, "con.txt"), "Windows 保留名");
  });
}

await check("多一层：sub 里建的文件落在 sub 里", async () => {
  const abs = makeFile(path.join(root, "sub"), "deep.md");
  assert.equal(abs, path.join(root, "sub", "deep.md"));
});

// ---- 回到 makeDir：重构后报错文字原封不动（三处界面都在念这些句子）
await check("makeDir：空名字 / 带分隔符的报错还是原来那两句", async () => {
  throwsWith(() => makeDir(root, ""), "文件夹名不能为空");
  throwsWith(() => makeDir(root, "x/y"), "文件夹名里不能有 / 或 \\（一次只建一层）");
});

await check("makeDir：同名文件夹 / 同名文件都报「已经存在」", async () => {
  throwsWith(() => makeDir(root, "sub"), "已经存在");
  throwsWith(() => makeDir(root, "a.txt"), "已经存在");
});

await check("makeDir：建出来的还是目录，不是空文件", async () => {
  const abs = makeDir(root, "fresh");
  assert.ok(fs.statSync(abs).isDirectory());
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log("\n全通过");
}
