/**
 * 产物的两个来源（D275）：write 系工具记「写过」，`open_preview` 记「交付过」。
 *
 * 只测纯函数那一层：弹窗与芯片的排布由 `web/src/chat.ts` 负责，这里管的是「哪些路径进列表、
 * 同一条路径两种来源谁说了算、次数怎么算」。这层没有 DOM，所以能单测。
 *
 * Run: node --experimental-strip-types web/tests/artifact-sources-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { artifactSources, noteArtifact, noteMentioned, toolPath } from "../src/artifact-sources.ts";
import { extractMentionedPaths, looksLikePath } from "../src/md.ts";

const map = () => new Map();
const paths = (m) => artifactSources(m).map((it) => `${it.path}:${it.tool}×${it.writes}`);

test("写入工具：记一条，并在多次写入时累加次数", () => {
  const m = map();
  assert.deepEqual(noteArtifact(m, "write", { path: "a.md" }), { path: "a.md", isWrite: true });
  assert.deepEqual(noteArtifact(m, "Edit", { file_path: "a.md" }), { path: "a.md", isWrite: true });
  assert.deepEqual(paths(m), ["a.md:edit×2"]);
});

test("交付工具：open_preview 也进列表，但不算「写过」", () => {
  const m = map();
  const hit = noteArtifact(m, "open_preview", { path: "/tmp/book.xlsx" });
  assert.deepEqual(hit, { path: "/tmp/book.xlsx", isWrite: false });
  assert.deepEqual(artifactSources(m), [{ path: "/tmp/book.xlsx", tool: "open_preview", writes: 1, delivered: true }]);
});

test("同一路径先写后开：留写入那条（它才有写入前的原文）", () => {
  const m = map();
  noteArtifact(m, "write", { path: "a.html" });
  noteArtifact(m, "open_preview", { path: "a.html" });
  assert.deepEqual(artifactSources(m), [{ path: "a.html", tool: "write", writes: 1 }]);
});

test("同一路径先开后写：升级成写入那条，次数只算写过的", () => {
  const m = map();
  noteArtifact(m, "open_preview", { path: "a.html" });
  noteArtifact(m, "open_preview", { path: "a.html" });
  noteArtifact(m, "write", { path: "a.html" });
  assert.deepEqual(artifactSources(m), [{ path: "a.html", tool: "write", writes: 1 }]);
});

test("与产物无关的工具、缺路径的参数都不进列表", () => {
  const m = map();
  assert.equal(noteArtifact(m, "bash", { command: "ls" }), null);
  assert.equal(noteArtifact(m, "read", { path: "a.md" }), null);
  assert.equal(noteArtifact(m, "write", {}), null);
  assert.equal(noteArtifact(m, "open_preview", { path: "   " }), null);
  assert.equal(m.size, 0);
});

test("顺序：最近写 / 打开的在最前，重复记一条会挪到最前", () => {
  const m = map();
  noteArtifact(m, "write", { path: "old.md" });
  noteArtifact(m, "open_preview", { path: "book.xlsx" });
  noteArtifact(m, "write", { path: "old.md" });
  assert.deepEqual(artifactSources(m).map((it) => it.path), ["old.md", "book.xlsx"]);
});

test("toolPath：几种参数写法都认，非字符串 / 空白不算", () => {
  assert.equal(toolPath({ path: "a" }), "a");
  assert.equal(toolPath({ file_path: " b " }), "b");
  assert.equal(toolPath({ filePath: "c" }), "c");
  assert.equal(toolPath({ file: "d" }), "d");
  assert.equal(toolPath({ filename: "e" }), "e");
  assert.equal(toolPath({ path: 1 }), "");
  assert.equal(toolPath(null), "");
});

test("noteMentioned：补收回复提及路径，且不覆盖已有写入或交付记录", () => {
  const m = map();
  noteArtifact(m, "write", { path: "a.html" });
  noteArtifact(m, "open_preview", { path: "b.html" });
  noteMentioned(m, ["a.html", "b.html", "C:\\soft\\10_計画\\report(プラン).html"]);
  assert.deepEqual(artifactSources(m), [
    { path: "C:\\soft\\10_計画\\report(プラン).html", tool: "mentioned", writes: 1, delivered: true, mentioned: true },
    { path: "b.html", tool: "open_preview", writes: 1, delivered: true },
    { path: "a.html", tool: "write", writes: 1 },
  ]);
});

test("noteMentioned：先提及后写入时，升级为写入且次数从 1 算", () => {
  const m = map();
  noteMentioned(m, ["out.html"]);
  noteArtifact(m, "write", { path: "out.html" });
  assert.deepEqual(artifactSources(m), [{ path: "out.html", tool: "write", writes: 1 }]);
});

test("extractMentionedPaths：支持反引号内带括号文件名、纯文本路径、本地链接，跳过代码块与 URL", () => {
  assert.equal(looksLikePath("C:\\soft\\10_計画\\AI駆動開発\\planning-external-report(プラン).html"), true);
  const reply = [
    "两份报告都写好了：",
    "- `C:\\soft\\10_計画\\AI駆動開発\\planning-external-report(プラン).html`",
    "- `C:\\soft\\10_計画\\AI駆動開発\\planning-internal-report(プラン).html`",
    "另见 [说明](docs/report.md) 与 C:\\api\\.jira\\impact-20261104.html 和 https://example.com/a.html",
    "```bash",
    "cat C:\\ignored\\in-code-block.html",
    "```",
  ].join("\n");
  assert.deepEqual(extractMentionedPaths(reply), [
    "C:\\soft\\10_計画\\AI駆動開発\\planning-external-report(プラン).html",
    "C:\\soft\\10_計画\\AI駆動開発\\planning-internal-report(プラン).html",
    "docs/report.md",
    "C:\\api\\.jira\\impact-20261104.html",
  ]);
});
