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

// ---------------------------------------------------------------- 交付文件（脚本生成，没有写入前原文）
{
  const dir = tmpdir();
  const id = sid("delivered");
  write(dir, "book.xlsx", "not really a workbook\n");
  const row = (await listArtifacts(id, dir, [{ path: "book.xlsx", tool: "open_preview", writes: 2, delivered: true }])).items[0];
  assert.equal(row.status, "unknown");
  assert.equal(row.why, "delivered-only", "脚本产物没有写入前原文，不能说成「桥没在运行」");
  assert.equal(row.tool, "open_preview");
  assert.equal(row.writes, 2);
  // 同一条路径由写入工具报上来时，说法仍是 no-baseline（没交付这层身份）。
  const viaWrite = (await listArtifacts(id, dir, [{ path: "book.xlsx", tool: "write", writes: 1 }])).items[0];
  assert.equal(viaWrite.why, "no-baseline");
}

// ---------------------------------------------------------------- 回复正文提及的路径（按存在 + mtime 过滤）
{
  const dir = tmpdir();
  const id = sid("mentioned");
  const now = Date.now();
  const sessionStart = new Date(now - 10_000).toISOString();
  // 会话前已存在的旧参考文件
  const oldRef = write(dir, "old-ref.html", "old\n");
  const oldSec = (now - 60_000) / 1000;
  fs.utimesSync(oldRef, oldSec, oldSec);
  // 会话开始后脚本生成的新报告
  const fresh = write(dir, "planning-external-report(プラン).html", "<html>new</html>\n");
  const out = await listArtifacts(
    id,
    dir,
    [
      { path: fresh, tool: "mentioned", writes: 1, delivered: true, mentioned: true },
      { path: oldRef, tool: "mentioned", writes: 1, delivered: true, mentioned: true },
      { path: path.join(dir, "missing.html"), tool: "mentioned", writes: 1, delivered: true, mentioned: true },
      { path: dir, tool: "mentioned", writes: 1, delivered: true, mentioned: true },
    ],
    { startedAt: sessionStart },
  );
  assert.equal(out.items.length, 1, "只收录会话开始后写过的真实文件，过滤旧文件、不存在路径和目录");
  assert.equal(out.items[0].path, fresh);
  assert.equal(out.items[0].why, "mentioned-only");
  assert.equal(out.items[0].tool, "mentioned");

  // 同一文件既有提及（在前）又有真实写入（在后），不同写法指向同一 abs：保留写入记录。
  recordSnapshot(id, fresh);
  fs.writeFileSync(fresh, "<html>updated</html>\n");
  const merged = await listArtifacts(
    id,
    dir,
    [
      { path: fresh, tool: "mentioned", writes: 1, delivered: true, mentioned: true },
      { path: "planning-external-report(プラン).html", tool: "write", writes: 2 },
    ],
    { startedAt: sessionStart },
  );
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].tool, "write");
  assert.equal(merged.items[0].writes, 2);
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

// ---------------------------------------------------------------- 没有基线、按 git 估算：未跟踪 = 新增；cwd 是子目录也要对上路径
{
  const { execFileSync } = await import("node:child_process");
  const repo = tmpdir();
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  const sub = path.join(repo, "pkg");
  fs.mkdirSync(sub);
  write(sub, "tracked.ts", "a\nb\n");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(sub, "tracked.ts"), "a\nB\n");
  write(sub, "untracked.ts", "x\ny\nz\n");
  fs.writeFileSync(path.join(sub, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const id = sid("git");
  const out = await listArtifacts(id, sub, [
    { path: "tracked.ts", tool: "edit", writes: 1 },
    { path: "untracked.ts", tool: "write", writes: 1 },
    { path: "pic.png", tool: "write", writes: 1 },
  ]);
  const by = Object.fromEntries(out.items.map((r) => [r.path, r]));
  assert.equal(by["tracked.ts"].status, "modified", "cwd 在仓库子目录：git 路径要按仓库根算");
  assert.equal(by["tracked.ts"].estimate, true);
  assert.equal(by["tracked.ts"].added, 1);
  assert.equal(by["tracked.ts"].removed, 1);
  assert.equal(by["untracked.ts"].status, "new", "HEAD 里没有的文件按 git 估算是新增，不是「修改 +N −0」");
  assert.equal(by["untracked.ts"].added, 3);
  assert.equal(by["untracked.ts"].estimate, true);
  assert.equal(by["pic.png"].status, "new", "未跟踪的二进制也是新增");
  assert.equal(out.summary.new, 2);

  const dt = await diffArtifact(id, sub, "tracked.ts");
  assert.equal(dt.status, "modified");
  assert.equal(dt.estimate, true);
  assert.equal(dt.added, 1);
  const du = await diffArtifact(id, sub, "untracked.ts");
  assert.equal(du.reason, undefined, `列表说能看改动，差异页就不能说没有原文：${du.reason}`);
  assert.equal(du.status, "new");
  assert.equal(du.estimate, true);
  assert.equal(du.added, 3);
}

console.log("artifacts-unit: all passed");
