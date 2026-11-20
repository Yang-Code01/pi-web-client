/**
 * 问卷「在预览里打开」直连预览：`previewTargetOf` / `absoluteFileIn` 的纯函数层。
 *
 * Run: node --experimental-strip-types web/tests/ask-preview-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { absoluteFileIn, previewTargetOf } from "../src/ask-preview.ts";

const open = { label: "在预览里打开（推荐）", description: "在右侧预览面板里看。" };

test("题干里的 Windows 绝对路径：点「在预览里打开」就拿到它", () => {
  const prompt = "原型文件 E:/yqm/pi-web-client-wt/artifacts-console/web/prototype/artifacts-console.html 已写好，要在预览里打开吗？";
  assert.equal(previewTargetOf(prompt, open), "E:/yqm/pi-web-client-wt/artifacts-console/web/prototype/artifacts-console.html");
});

test("截图那题：只有相对路径 + worktree 目录 → 不猜，交给模型", () => {
  const prompt = "原型文件 web/prototype/artifacts-console.html 已写好（worktree: E:/yqm/pi-web-client-wt/artifacts-console），要在预览里打开吗？";
  assert.equal(previewTargetOf(prompt, open), null);
});

test("「先不看」不触发", () => {
  assert.equal(previewTargetOf("C:\\a\\b.html 要打开吗？", { label: "先不看", description: "只保留路径" }), null);
});

test("选项说明里的路径优先于题干", () => {
  const prompt = "报告 C:\\tmp\\old.md 和新版都在，要在预览里打开吗？";
  const opt = { label: "在预览里打开", description: "打开 C:\\tmp\\new.html" };
  assert.equal(previewTargetOf(prompt, opt), "C:\\tmp\\new.html");
});

test("反引号 / 「」 里的路径可以带空格和日文", () => {
  assert.equal(absoluteFileIn("文件 `C:\\soft\\10_計画\\AI 駆動\\report(プラン).html` 已生成"), "C:\\soft\\10_計画\\AI 駆動\\report(プラン).html");
  assert.equal(absoluteFileIn("文件「D:/x y/z.png」好了"), "D:/x y/z.png");
});

test("裸路径后面粘着中文 / 英文标点、括号都切掉", () => {
  assert.equal(absoluteFileIn("看 E:/a/b.html，好吗"), "E:/a/b.html");
  assert.equal(absoluteFileIn("(see /home/me/out.svg)."), "/home/me/out.svg");
  assert.equal(absoluteFileIn("见（E:/a/b.md）"), "E:/a/b.md");
});

test("相对路径中间的 / 不当成 POSIX 绝对路径", () => {
  assert.equal(absoluteFileIn("写在 web/prototype/x.html 里"), null);
});

test("英文 / 日文标签也认", () => {
  assert.equal(previewTargetOf("Open /tmp/a.html?", { label: "Open in preview (Recommended)" }), "/tmp/a.html");
  assert.equal(previewTargetOf("E:/a.png を開く？", { label: "プレビューで開く" }), "E:/a.png");
});
