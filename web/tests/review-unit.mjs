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
import { fixPrompt, fixPromptMany, parsePrNumber, repoFromUrl, reviewView } from "../src/review.ts";

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
  pr: 0,
  prTitle: "",
  prHead: "",
  prBase: "",
  model: "wb2_mac/cn:x",
  provider: "wb2_mac",
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

const base = { ocr: ocrOk, installing: false, error: "", notGit: false, progresses: [], cap: 2 };

test("还没问出 ocr 装没装：先「读状态」，不许先喊没装", () => {
  const view = reviewView({ ...base, state: null, ocr: null });
  assert.equal(view.phase, "loading");
  assert.equal(view.canRun, false);
  assert.equal(view.needsInstall, false);
});

test("ocr 那一帧丢了、桥又回了错：要把错摆出来，不许一直「读状态」", () => {
  const view = reviewView({ ...base, state: null, ocr: null, error: "这个目录不是 git 仓库" });
  assert.equal(view.phase, "failed");
  assert.equal(view.error, "这个目录不是 git 仓库");
});

test("ocr 那一帧丢了、但已经有评审记录：照常显示那一次，不许回到「读状态」", () => {
  const view = reviewView({ ...base, state: { runs: [run({ findings: [finding()] })], marks: {} }, ocr: null });
  assert.equal(view.phase, "done");
  assert.equal(view.groups.length, 1);
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
  // 默认范围是 PR，而这里没选号：显式用「工作区改动」这种不需要额外输入的
  const view = reviewView({ ...base, state: { runs: [], marks: {} }, mode: "workspace" });
  assert.equal(view.phase, "empty");
  assert.equal(view.canRun, true);
  assert.equal(view.meta, null);
});

const prog = (runId, over = {}) => ({
  repo: "/r",
  runId,
  status: "running",
  phase: "review",
  totalFiles: 9,
  reviewedFiles: 0,
  currentFile: "",
  tokens: 0,
  startedAt: "2025-01-01T00:00:00Z",
  error: "",
  errorCode: "",
  ...over,
});

test("跑着一条：给进度，但还剩一条额度，可以再开", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ status: "running", finishedAt: "" })], marks: {} },
    progresses: [prog("r1", { reviewedFiles: 4, currentFile: "web/src/a.ts", tokens: 800 })],
    mode: "workspace",
  });
  assert.equal(view.phase, "running");
  assert.equal(view.running, true);
  assert.equal(view.runningCount, 1);
  assert.equal(view.atCap, false);
  assert.equal(view.canRun, true, "同会话还能再开一条（D419）");
  assert.deepEqual(view.progress, { totalFiles: 9, reviewedFiles: 4, currentFile: "web/src/a.ts", tokens: 800 });
});

test("跑满两条：进度各归各的卡，第三条不许开，理由说清上限", () => {
  const view = reviewView({
    ...base,
    state: {
      runs: [
        run({ id: "r1", status: "running", finishedAt: "", startedAt: "2025-01-01T00:00:00Z" }),
        run({ id: "r2", status: "running", finishedAt: "", startedAt: "2025-01-01T00:02:00Z", mode: "pr", pr: 691 }),
      ],
      marks: {},
    },
    progresses: [prog("r1", { reviewedFiles: 3 }), prog("r2", { reviewedFiles: 1, totalFiles: 5 })],
    mode: "workspace",
  });
  assert.equal(view.runningCount, 2);
  assert.equal(view.atCap, true);
  assert.equal(view.canRun, false);
  assert.match(view.missingWhy, /2/);
  assert.deepEqual(view.runs.map((c) => c.live && c.live.reviewed), [1, 3], "每条卡都拿到自己的进度");
  assert.ok(view.runs.every((c) => c.running));
});

test("并发（D419）：在跑的置顶，其余按开跑时间倒序", () => {
  const view = reviewView({
    ...base,
    state: {
      runs: [
        run({ id: "old", status: "done", startedAt: "2025-01-01T00:00:00Z" }),
        run({ id: "live1", status: "running", finishedAt: "", startedAt: "2025-01-02T00:00:00Z" }),
        run({ id: "mid", status: "done", startedAt: "2025-01-03T00:00:00Z" }),
        run({ id: "live2", status: "running", finishedAt: "", startedAt: "2025-01-04T00:00:00Z", mode: "pr", pr: 700 }),
      ],
      marks: {},
    },
  });
  assert.deepEqual(view.runs.map((c) => c.id), ["live2", "live1", "mid", "old"]);
  assert.equal(view.history, 4);
  assert.equal(view.runningCount, 2);
});

test("并发（D419）：停掉一条（记录已收尾），额度还回来", () => {
  const view = reviewView({
    ...base,
    state: {
      runs: [
        run({ id: "r1", status: "stopped", finishedAt: "2025-01-01T00:01:00Z" }),
        run({ id: "r2", status: "running", finishedAt: "" }),
      ],
      marks: {},
    },
    progresses: [prog("r2")],
    mode: "workspace",
  });
  assert.equal(view.runningCount, 1);
  assert.equal(view.canRun, true);
  assert.equal(view.phase, "running", "展开的那条还在跑");
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

test("已解决的那几条不进正文，但要说得出来是哪些文件", () => {
  const view = reviewView({
    ...base,
    state: { runs: [run({ findings: [finding()], resolved: ["gone1", "gone2"], resolvedPaths: ["a.ts", "b.ts"] })], marks: {} },
  });
  assert.equal(view.resolved, 2);
  assert.deepEqual(view.resolvedPaths, ["a.ts", "b.ts"]);
  assert.equal(view.groups.length, 1);
});

test("错误说人话：认得出 errorCode 就不画桥写死的那句中文", () => {
  const stopped = reviewView({ ...base, state: { runs: [run({ status: "stopped", error: "已停止", errorCode: "stopped" })], marks: {} } });
  assert.equal(stopped.error, "已停止");
  const stale = reviewView({ ...base, state: { runs: [run({ status: "stale", error: "桥重启了，这次评审没跑完", errorCode: "bridge-restart" })], marks: {} } });
  assert.ok(stale.error.includes("重跑"), stale.error);
  const unknown = reviewView({ ...base, state: { runs: [run({ status: "failed", error: "自己写的怪错误", errorCode: "weird" })], marks: {} } });
  assert.equal(unknown.error, "自己写的怪错误", "认不出的码才回退原文");
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
  const view = reviewView({ ...base, state: { runs: [run({ findings: [] })], marks: {} }, mode: "workspace" });
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

test("PR 模式：没选号就不能开评，选了就能", () => {
  const empty = reviewView({ ...base, state: { runs: [], marks: {} }, mode: "pr", pr: "", prs: [] });
  assert.equal(empty.mode, "pr");
  assert.equal(empty.missing, true);
  assert.equal(empty.canRun, false);
  const picked = reviewView({
    ...base,
    state: { runs: [], marks: {} },
    mode: "pr",
    pr: "258",
    prs: [{ number: 258, title: "加个面板", headRefName: "feat/x", baseRefName: "main", draft: false }],
  });
  assert.equal(picked.canRun, true);
  assert.equal(picked.prs.length, 1);
});

test("粘 GitHub 的 PR 链接也能认出号（不能只挑数字：账号名里有 01）", () => {
  assert.equal(parsePrNumber("658"), 658);
  assert.equal(parsePrNumber("#658"), 658);
  assert.equal(parsePrNumber("  # 658 "), 658);
  assert.equal(parsePrNumber("https://github.com/Yang-Code01/pi-web-client/pull/658"), 658);
  assert.equal(parsePrNumber("https://github.com/o/r/pull/640/files"), 640);
  assert.equal(parsePrNumber("https://github.com/Yang-Code01/pi-web-client"), null, "没有 /pull/ 的链接不是号");
  assert.equal(parsePrNumber("ask-card"), null);
  assert.equal(parsePrNumber(""), null);
});

test("从链接里认 owner/repo（用来提醒「这不是本仓库」）", () => {
  assert.equal(repoFromUrl("https://github.com/Yang-Code01/pi-web-client/pull/658"), "yang-code01/pi-web-client");
  assert.equal(repoFromUrl("git@github.com:Yang-Code01/pi-web-client.git"), "yang-code01/pi-web-client");
  assert.equal(repoFromUrl("ask-card"), "");
});

test("交给 agent 的那段话带上 PR / 分支，并要求先判断是否真的成立", () => {
  const f = finding({ key: "k1", path: "web/src/a.ts", startLine: 12, content: "空指针风险" });
  const one = fixPrompt(f, { repo: "yang-code01/pi-web-client", pr: 658, prTitle: "加个面板", prHead: "feat/x", prBase: "main" });
  for (const needle of ["PR #658", "feat/x", "main", "yang-code01/pi-web-client", "web/src/a.ts:12", "先判断"]) {
    assert.ok(one.includes(needle), `缺 ${needle}：${one.slice(0, 60)}`);
  }
  const branch = fixPrompt(f, { mode: "range", from: "main", to: "dev" });
  assert.ok(branch.includes("分支") && branch.includes("dev"), branch.slice(0, 60));
  const many = fixPromptMany([f, finding({ key: "k2", path: "b.ts", startLine: 3 })], { pr: 658, prHead: "feat/x", prBase: "main" });
  assert.ok(many.includes("PR #658"));
  assert.ok(many.includes("2 条") || many.includes("2 findings"), many.slice(0, 80));
  assert.ok(many.includes("web/src/a.ts:12") && many.includes("b.ts:3"));
});

test("PR 检索：号 / 标题 / 分支 / 作者都能搜，空串给全部", () => {
  const prs = [
    { number: 658, title: "右栏加一颗「代码评审」页签", headRefName: "feat/code-review-panel", baseRefName: "main", draft: false, author: "qingmin-new" },
    { number: 640, title: "fix(web): 提问卡片把字面折行", headRefName: "fix/ask-card-text", baseRefName: "main", draft: false, author: "Yang-Code01" },
  ];
  const call = (q) => reviewView({ ...base, state: { runs: [], marks: {} }, mode: "pr", prs, prQuery: q });
  assert.deepEqual(call("").prs.map((p) => p.number), [658, 640]);
  assert.deepEqual(call("#64").prs.map((p) => p.number), [640], "带不带 # 都认");
  assert.deepEqual(call("代码评审").prs.map((p) => p.number), [658], "标题");
  assert.deepEqual(call("ask-card").prs.map((p) => p.number), [640], "分支名");
  assert.deepEqual(call("yang-code").prs.map((p) => p.number), [640], "作者，大小写不敏感");
  assert.deepEqual(call("没有这个东西").prs, []);
  assert.equal(call("没有这个东西").prAll, 2, "total 仍然说全部有几个");
});

test("PR 列表拉不到：把原因说出来，号输入框照样能用", () => {
  const view = reviewView({
    ...base,
    state: { runs: [], marks: {} },
    mode: "pr",
    pr: "12",
    prs: [],
    prError: "gh 没登录",
  });
  assert.equal(view.prError, "gh 没登录");
  assert.equal(view.prs.length, 0);
  assert.equal(view.canRun, true, "手输的号仍然能评");
});

test("分支范围：两侧都要有值才算齐", () => {
  const noTarget = reviewView({ ...base, state: { runs: [], marks: {} }, mode: "range", base: "main", target: "" });
  assert.equal(noTarget.missing, true);
  assert.equal(noTarget.canRun, false);
  const ok = reviewView({ ...base, state: { runs: [], marks: {} }, mode: "range", base: "main", target: "HEAD" });
  assert.equal(ok.canRun, true);
});

test("桥直接回了 error（没到状态那一层）：当失败显示", () => {
  const view = reviewView({ ...base, state: null, error: "这个目录不是 git 仓库" });
  assert.equal(view.phase, "failed");
  assert.equal(view.error, "这个目录不是 git 仓库");
});
