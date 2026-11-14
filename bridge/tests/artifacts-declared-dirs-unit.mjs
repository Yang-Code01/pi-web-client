/**
 * D252 回归：脚本批量生成的产物也要进「本会话的产物」。
 *
 * 真实症状（2026-11-14「功能测试」会话）：assistant 在正文里声明了
 * `F:\pi-web-client\.scratch\testbook\feature-chat\`，目录里 53 个文件全由
 * bash / Playwright / ffmpeg 生成，弹窗却只列 write 系工具写过的 5 行。
 *
 * 跑法：`node bridge/tests/artifacts-declared-dirs-unit.mjs`
 * 每个用例自己 mkdtemp 一个工作目录 —— 不碰真的仓库，也不依赖 git。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwc-artifacts-declared-state-"));
process.env.PI_WEB_STATE = stateRoot;

const { listArtifacts, recordSnapshot } = await import("../src/artifacts.ts");

let n = 0;
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pwc-artifacts-declared-${++n}-`));
}
function write(dir, name, data) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}
function slash(p) {
  return p.split(path.sep).join("/");
}
function sessionFile(cwd, startedAt, entries) {
  const file = path.join(cwd, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: `declared-${n}`, timestamp: startedAt, cwd }),
    ...entries.map((e) => JSON.stringify(e)),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
function assistantText(text, thinking = "") {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        ...(thinking ? [{ type: "thinking", thinking }] : []),
        { type: "text", text },
      ],
    },
  };
}

// ---------------------------------------------------------------- 主症状：声明目录里的批量生成物
{
  const cwd = tmpdir();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const startedMs = Date.parse(startedAt);
  const declared = path.join(cwd, ".scratch", "testbook", "feature-chat");
  const outside = tmpdir();
  const forbidden = path.join(cwd, "node_modules", "pkg");
  const systemDir = tmpdir();

  const fresh = [
    write(declared, "index.html", "<html></html>\n"),
    write(declared, "clips/a.mp4", Buffer.from([0x00, 0x01, 0x02, 0x03])),
    write(declared, "shots/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    write(declared, "nested/deep.txt", "deep\n"),
  ];
  const old = write(declared, "old.txt", "from an earlier run\n");
  fs.utimesSync(old, new Date(startedMs - 10 * 60_000), new Date(startedMs - 10 * 60_000));
  write(outside, "outside.mp4", "outside\n");
  write(forbidden, "blocked.txt", "blocked\n");
  write(systemDir, "system.txt", "system\n");
  // cwd 根也在声明里：绝不能因此把整个工作目录扫进来。
  write(cwd, "root.txt", "root\n");

  const file = sessionFile(cwd, startedAt, [
    {
      type: "message",
      message: { role: "system", content: [{ type: "text", text: `产物（\`${systemDir}${path.sep}\`）` }] },
    },
    assistantText(
      [
        `**产物**（\`${declared}${path.sep}\`）`,
        "- `index.html` — 目录页",
        "- `clips\\*.mp4` — 11 段",
        "",
        `产物（\`${cwd}${path.sep}\`）`,
        `产物（\`${outside}${path.sep}\`）`,
        `产物（\`${forbidden}${path.sep}\`）`,
      ].join("\n"),
      `产物（\`${systemDir}${path.sep}\`）`,
    ),
  ]);

  const out = await listArtifacts(`declared-main-${n}`, cwd, [], { file, startedAt });
  assert.equal(out.items.length, fresh.length, "脚本生成的 4 个新文件都应出现在产物弹窗里（旧文件不算）");
  assert.equal(out.summary.generated, fresh.length, "汇总要有独立的「目录产物」计数");
  assert.equal(out.baseline, "exact", "目录行按声明确认，不该把整份清单说成基线缺失");

  const absSet = new Set(out.items.map((r) => r.abs));
  for (const p of fresh) assert.equal(absSet.has(p), true, `漏了 ${p}`);
  assert.equal(absSet.has(old), false, "会话开始前就有的旧文件不该混进来");
  assert.equal(absSet.has(path.join(outside, "outside.mp4")), false, "会话外的目录不该扫");
  assert.equal(absSet.has(path.join(forbidden, "blocked.txt")), false, "node_modules 不该扫");
  assert.equal(absSet.has(path.join(cwd, "root.txt")), false, "cwd 根不该扫");
  assert.equal(absSet.has(path.join(systemDir, "system.txt")), false, "system / thinking 里的路径不算交付声明");

  for (const r of out.items) {
    assert.equal(r.origin, "directory");
    assert.equal(r.status, "generated", "目录产物不是 git 估算出来的「修改」");
    assert.equal(r.estimate, false);
    assert.equal(r.diffable, false, "没有写入前原文，不能进看改动弹窗");
    assert.equal(r.why, "generated-no-baseline");
    assert.equal(r.tool, "", "不该伪造工具名");
    assert.equal(r.writes, 0, "不该伪造写入次数");
    assert.equal(r.declared, true);
    assert.equal(r.group, `${slash(declared)}/`);
    assert.equal(r.path.startsWith(".scratch/testbook/feature-chat/"), true, "path 应是相对 cwd 的可预览路径");
    assert.equal(r.rel.includes(".scratch/testbook/feature-chat/"), false, "rel 应是相对声明目录的路径");
  }
  const byRel = new Map(out.items.map((r) => [r.rel, r]));
  assert.equal(byRel.get("clips/a.mp4")?.binary, true, "二进制要标 binary");
  assert.equal(byRel.get("index.html")?.binary, false, "HTML 不是二进制");
  assert.equal(byRel.get("nested/deep.txt")?.rel, "nested/deep.txt", "子目录要递归");
}

// ---------------------------------------------------------------- 同一个文件同时被工具写过：工具行优先
{
  const cwd = tmpdir();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const declared = path.join(cwd, "out");
  const abs = path.join(declared, "same.txt");
  recordSnapshot(`declared-dedupe-${n}`, abs);
  write(declared, "same.txt", "new\n");
  write(declared, "other.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const file = sessionFile(cwd, startedAt, [assistantText(`产物（\`${declared}${path.sep}\`）`)]);
  const out = await listArtifacts(`declared-dedupe-${n}`, cwd, [{ path: "out/same.txt", tool: "write", writes: 1 }], { file, startedAt });

  assert.equal(out.items.length, 2, "工具写入 + 另一个目录文件，去重后应是两行");
  const same = out.items.find((r) => r.abs === abs);
  assert.equal(same?.origin, "tool", "精确基线/diff 的工具行不能被目录行覆盖");
  assert.equal(same?.status, "new");
  assert.equal(same?.tool, "write");
  assert.equal(same?.writes, 1);
  assert.equal(same?.diffable, true);
  const other = out.items.find((r) => r.abs === path.join(declared, "other.png"));
  assert.equal(other?.origin, "directory");
  assert.equal(other?.status, "generated");
}

// ---------------------------------------------------------------- 没有 assistant 声明：不猜目录
{
  const cwd = tmpdir();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const dir = path.join(cwd, "somewhere");
  write(dir, "a.txt", "a\n");
  const file = sessionFile(cwd, startedAt, [
    { type: "message", message: { role: "system", content: [{ type: "text", text: `产物（\`${dir}${path.sep}\`）` }] } },
    assistantText("只是聊到产物，没有声明目录。", `产物（\`${dir}${path.sep}\`）`),
  ]);
  const out = await listArtifacts(`declared-none-${n}`, cwd, [], { file, startedAt });
  assert.equal(out.items.length, 0, "system / thinking 里的路径绝不能当成交付目录");
  assert.equal(out.summary.generated, 0);
}

// ---------------------------------------------------------------- 长会话：尾部声明仍可发现
{
  const cwd = tmpdir();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const declared = path.join(cwd, "late");
  write(declared, "late.txt", "late\n");
  const file = path.join(cwd, "long.jsonl");
  const filler = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(600_000) }] },
  });
  const ending = JSON.stringify(assistantText(`产物（\`${declared}${path.sep}\`）`));
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "long", timestamp: startedAt, cwd })}\n${filler}\n${ending}\n`);
  const out = await listArtifacts(`declared-tail-${n}`, cwd, [], { file, startedAt });
  assert.equal(out.items.length, 1, "流式扫整份时，尾部声明不能被整段截断的第一行吞掉");
  assert.equal(out.items[0]?.rel, "late.txt");
}

// ---------------------------------------------------------------- 长会话：声明在前、后面又写很多也不能漏
{
  const cwd = tmpdir();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const declared = path.join(cwd, "early");
  write(declared, "early.txt", "early\n");
  const filler = {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(120_000) }] },
  };
  // 声明后面写 720 KB，超过旧实现的 512 KB 尾部窗口；只扫尾巴必然漏掉。
  const file = sessionFile(cwd, startedAt, [
    assistantText(`产物（\`${declared}${path.sep}\`）`),
    ...Array.from({ length: 6 }, () => filler),
  ]);
  const out = await listArtifacts(`declared-early-${n}`, cwd, [], { file, startedAt });
  assert.equal(out.items.length, 1, "声明被 512 KB 以后写的历史挤出尾部时也要能发现");
  assert.equal(out.items[0]?.rel, "early.txt");
  assert.equal(out.items[0]?.group, `${slash(declared)}/`);
}

console.log("artifacts-declared-dirs-unit: all passed");
