/**
 * D208 产物基线 / 差异的单元测试。
 *
 * 跑法：`node --experimental-transform-types bridge/tests/artifacts-unit.mjs`
 * 每个用例自己 mkdtemp 一个工作目录 —— 不碰真的仓库，也就不需要 mock git。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-artifacts-state-"));
process.env.PI_WEB_STATE = stateRoot;

const { diffArtifact, forgetSession, listArtifacts, recordSnapshot } = await import("../src/artifacts.ts");

let n = 0;
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pwc-artifacts-${++n}-`));
}
function write(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}
function sid(tag) {
  return `test-session-${tag}-${Math.random().toString(16).slice(2, 8)}`;
}
// ---------------------------------------------------------------- 新增
{
  const dir = tmpdir();
  const id = sid("new");
  const abs = path.join(dir, "fresh.ts");
  const snap = recordSnapshot(id, abs);
  assert.equal(snap.snap?.existed, false, "不存在的文件也要留一条「当时没有」的基线");

  fs.writeFileSync(abs, "export const a = 1;\nexport const b = 2;\n");
  const listed = await listArtifacts(id, dir, [{ path: "fresh.ts", tool: "write", writes: 1 }]);
  const row = listed.items[0];
  assert.equal(row.status, "new");
  assert.equal(row.added, 2);
  assert.equal(row.removed, 0);
  assert.equal(row.diffable, true);
  assert.equal(listed.summary.new, 1);
  assert.equal(listed.baseline, "exact");

  const d = await diffArtifact(id, dir, "fresh.ts");
  assert.equal(d.added, 2);
  assert.equal(d.hunks[0].header.startsWith("@@ -0,0"), true, `纯新增应是 -0,0 开头：${d.hunks[0].header}`);

  forgetSession(id);
  assert.equal(fs.existsSync(path.join(stateRoot, "artifacts", id)), false, "forgetSession 要连目录一起删");
}

// ---------------------------------------------------------------- 修改
{
  const dir = tmpdir();
  const id = sid("mod");
  const abs = write(dir, "app.ts", "a\nb\nc\n");
  recordSnapshot(id, abs);
  fs.writeFileSync(abs, "a\nB\nc\nd\n");
  const listed = await listArtifacts(id, dir, [{ path: "app.ts", tool: "edit", writes: 2 }]);
  const row = listed.items[0];
  assert.equal(row.status, "modified");
  assert.equal(row.added, 2);
  assert.equal(row.removed, 1);
  assert.equal(row.writes, 2);
  assert.equal(row.tool, "edit");

  const d = await diffArtifact(id, dir, "app.ts");
  assert.equal(d.hunks.length, 1);
  const marks = d.hunks[0].lines.map((l) => l.kind).join("");
  assert.equal(marks, " -+ +", `行标记不对：${marks}`);
}

// ---------------------------------------------------------------- 没变（含 CRLF 归一）
{
  const dir = tmpdir();
  const id = sid("same");
  const abs = write(dir, "same.md", "one\ntwo\n");
  recordSnapshot(id, abs);
  fs.writeFileSync(abs, "one\ntwo\n");
  assert.equal((await listArtifacts(id, dir, [{ path: "same.md" }])).items[0].status, "same");

  const crlf = write(dir, "eol.md", "one\r\ntwo\r\n");
  recordSnapshot(id, crlf);
  fs.writeFileSync(crlf, "one\ntwo\n");
  assert.equal((await listArtifacts(id, dir, [{ path: "eol.md" }])).items[0].status, "same", "换行符不同不算改动");
}

// ---------------------------------------------------------------- 已删除
{
  const dir = tmpdir();
  const id = sid("del");
  const abs = write(dir, "gone.md", "x\ny\n");
  recordSnapshot(id, abs);
  fs.unlinkSync(abs);
  const row = (await listArtifacts(id, dir, [{ path: "gone.md" }])).items[0];
  assert.equal(row.status, "deleted");
  assert.equal(row.removed, 2);
  const d = await diffArtifact(id, dir, "gone.md");
  assert.equal(d.status, "deleted");
  assert.equal(d.removed, 2);
}

// ---------------------------------------------------------------- 二进制
{
  const dir = tmpdir();
  const id = sid("bin");
  const abs = write(dir, "shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  recordSnapshot(id, abs);
  fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
  const row = (await listArtifacts(id, dir, [{ path: "shot.png" }])).items[0];
  assert.equal(row.binary, true);
  assert.equal(row.status, "modified");
  assert.equal(row.diffable, false);
  const d = await diffArtifact(id, dir, "shot.png");
  assert.equal(d.reason, "binary");
  assert.equal(d.hunks.length, 0);
}

// ---------------------------------------------------------------- 没有基线
{
  const dir = tmpdir();
  const id = sid("unknown");
  write(dir, "old.ts", "whatever\n");
  const out = await listArtifacts(id, dir, [{ path: "old.ts" }]);
  const row = out.items[0];
  assert.equal(row.status, "unknown", "没有基线又不在这条路径的 git 历史里，就只能是未知");
  assert.equal(row.why, "no-baseline");
  assert.equal(out.baseline, "none");
  const d = await diffArtifact(id, dir, "old.ts");
  assert.equal(d.reason, "no-baseline");
}

// ---------------------------------------------------------------- 路径：相对/绝对写的是同一个文件
{
  const dir = tmpdir();
  const id = sid("dedupe");
  const abs = write(dir, "dup.ts", "1\n");
  fs.writeFileSync(path.join(dir, "dup.ts"), "2\n");
  recordSnapshot(id, abs);
  const out = await listArtifacts(id, dir, [
    { path: "dup.ts", tool: "edit", writes: 1 },
    { path: abs, tool: "write", writes: 1 },
  ]);
  assert.equal(out.items.length, 1, "同一文件两种写法只留一行");
}

// ---------------------------------------------------------------- 超过 5000 行：没比，不等于没变
{
  const dir = tmpdir();
  const id = sid("huge");
  const big = (tag) => Array.from({ length: 6000 }, (_, i) => `${tag} ${i}`).join("\n");
  const abs = write(dir, "huge.ts", big("line"));
  recordSnapshot(id, abs);
  fs.writeFileSync(path.join(dir, "huge.ts"), big("LINE"));
  const out = await listArtifacts(id, dir, [{ path: "huge.ts", tool: "write", writes: 1 }]);
  const row = out.items[0];
  assert.equal(row.status, "unknown", "太大没比 → 未知，不能写成未变");
  assert.equal(row.why, "diff-too-large");
  assert.equal(row.diffable, false);
}

console.log("artifacts-unit: all passed");
