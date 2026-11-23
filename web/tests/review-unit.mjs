/**
 * 右栏「代码评审」的视图模型：桥发来的一份状态 + 一次进行中的进度 → 面板要显示什么。
 *
 * 为什么要它：面板要同时交代「N 个文件没评」、四档严重度、每条的处理态、以及「这次还是上一次」，
 * 全塞进 DOM 就只能靠截图验。这里把它压成一个普通对象，渲染那一侧再机械地画。
 *
 *   node --experimental-strip-types web/tests/review-unit.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { reviewView } from "../src/review.ts";

const finding = (over = {}) => ({
  key: "k1",
  path: "web/src/a.ts",
  startLine: 10,
  endLine: 12,
  category: "bug",
  severity: "high",
  content: "空指针",
  existingCode: "a.b.c",
  suggestionCode: "",
  anchored: true,
  state: "new",
  mark: "",
  ...over,
});

const run = (over = {}) => ({
  id: "r1",
  status: "done",
  startedAt: "2025-01-01T00:00:00Z",
  finishedAt: "2025-01-01T00:04:00Z",
  mode: "range",
  from: "main",
  to: "HEAD",
  mergeBase: "abc",
  model: "wb2_mac/cn:x",
  findings: [],
  resolved: [],
  skipped: [],
  reviewedFiles: 2,
  totalFiles: 2,
  tokens: 1200,
  error: "",
  errorCode: "",
  ...over,
});

const ocrOk = { installed: true, version: "1.14.2", tooOld: false };

const base = { ocr: ocrOk, installing: false, error: "", notGit: false, progress: null };

test("还没问出 ocr 装没装：先「读状态」，不许先喊没装", () => {
  const view = reviewView({ ...base, state: null, ocr: null });
  assert.equal(view.phase, "loading");
  assert.equal(view.canRun, false);
  assert.equal(view.needsInstall, false);
});

test("没装 ocr：说清要装，别给「开始评审」", () => {
  const view = reviewView({ ...base, state: null, ocr: { installed: false, version: "", tooOld: false } });
  assert.equal(view.phase, "no-ocr");
  assert.equal(view.canRun, false);
  assert.equal(view.needsInstall, true);
  assert.equal(view.needsUpgrade, false);
});

test("ocr 太老：要升级而不是重装", () => {
  const view = reviewView({ ...base, state: null, ocr: { installed: true, version: "1.4.0", tooOld: true } });
  assert.equal(view.phase, "no-ocr");
  assert.equal(view.needsUpgrade, true);
  assert.equal(view.canRun, false);
});

test("不是 git 仓库：一句话说清，别摆一堆按钮", () => {
  const view = reviewView({ ...base, state: null, notGit: true });
  assert.equal(view.phase, "not-git");
  assert.equal(view.canRun, false);
  assert.equal(view.groups.length, 0);
});

test("还没跑过：空态但可以开始", () => {
  const view = reviewView({ ...base, state: { runs: [], marks: {} } });
  assert.equal(view.phase, "empty");
  assert.equal(view.canRun, true);
  assert.equal(view.meta, null);
});

test("跑着：给进度，并且不许再点开始", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ status: "running", finishedAt: "" })], marks: {} },
    progress: {
      repo: "/r",
      runId: "r1",
      status: "running",
      phase: "review",
      totalFiles: 9,
      reviewedFiles: 4,
      currentFile: "web/src/a.ts",
      tokens: 800,
      startedAt: "2025-01-01T00:00:00Z",
      error: "",
      errorCode: "",
    },
  });
  assert.equal(view.phase, "running");
  assert.equal(view.running, true);
  assert.equal(view.canRun, false);
  assert.deepEqual(view.progress, { totalFiles: 9, reviewedFiles: 4, currentFile: "web/src/a.ts", tokens: 800 });
});

test("一次完成的评审：按严重度分组、文件按最坏的那条排", () => {
  const view = reviewView({
    ...base,
    state: {
      runs: [
        run({
          findings: [
            finding({ key: "a", path: "a.ts", severity: "low", startLine: 30 }),
            finding({ key: "b", path: "b.ts", severity: "critical", startLine: 5 }),
            finding({ key: "c", path: "a.ts", severity: "high", startLine: 10 }),
            finding({ key: "d", path: "b.ts", severity: "medium", startLine: 8 }),
          ],
          skipped: [{ path: "big.bin", reason: "too_large" }],
        }),
      ],
      marks: { b: "accept" },
    },
  });
  assert.equal(view.phase, "done");
  assert.deepEqual(
    view.groups.map((g) => g.path),
    ["b.ts", "a.ts"],
    "有严重问题的文件排前面",
  );
  assert.deepEqual(
    view.groups[0].findings.map((f) => f.key),
    ["b", "d"],
    "同一文件里按严重度从重到轻、再按行号",
  );
  assert.equal(view.groups[0].findings[0].mark, "accept");
  assert.equal(view.severity.critical, 1);
  assert.equal(view.severity.high, 1);
  assert.equal(view.severity.medium, 1);
  assert.equal(view.severity.low, 1);
  assert.deepEqual(view.skipped, [{ path: "big.bin", reason: "too_large" }]);
  assert.equal(view.meta.files, 2);
  assert.equal(view.meta.durationMs, 240_000);
  assert.equal(view.meta.tokens, 1200);
});

test("定位不到行的意见排在文件最后，并被标出来", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ findings: [finding({ key: "u", startLine: 0, anchored: false, severity: "critical" }), finding({ key: "x", startLine: 9 })] })], marks: {} },
  });
  assert.deepEqual(
    view.groups[0].findings.map((f) => f.key),
    ["u", "x"],
    "严重度相同也把没法定位的放最后",
  );
  assert.equal(view.groups[0].findings[0].anchored, false);
});

test("已解决的那几条只给个数，不进正文", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ findings: [finding()], resolved: ["gone1", "gone2"] })], marks: {} },
  });
  assert.equal(view.resolved, 2);
  assert.equal(view.groups.length, 1);
});

test("停了 / 失败 / 桥重启：各是各的态，跑的人一眼能分辨", () => {
  const stopped = reviewView({ ...base, state: { runs: [run({ status: "stopped", error: "已停止" })], marks: {} } });
  assert.equal(stopped.phase, "stopped");
  const failed = reviewView({ ...base, state: { runs: [run({ status: "failed", error: "ocr 挂了" })], marks: {} } });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "ocr 挂了");
  const stale = reviewView({ ...base, state: { runs: [run({ status: "stale" })], marks: {} } });
  assert.equal(stale.phase, "stale");
});

test("一条意见都没有也是完成（不算失败），并且能再来一次", () => {
  const view = reviewView({ ...base, state: { runs: [run({ findings: [] })], marks: {} } });
  assert.equal(view.phase, "done");
  assert.equal(view.empty, true);
  assert.equal(view.canRun, true);
  assert.equal(view.groups.length, 0);
});

test("历史条数只数次数，正文只画最近一次", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ id: "r1" }), run({ id: "r2", findings: [finding()] })], marks: {} },
  });
  assert.equal(view.history, 2);
  assert.equal(view.groups.length, 1);
});

test("桥直接回了 error（没到状态那一层）：当失败显示", () => {
  const view = reviewView({ ...base, state: null, error: "这个目录不是 git 仓库" });
  assert.equal(view.phase, "failed");
  assert.equal(view.error, "这个目录不是 git 仓库");
});
