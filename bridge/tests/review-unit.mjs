/**
 * 代码评审的桥端纯逻辑：ocr 的 preview 怎么读、提示词怎么拼、模型那团文本怎么归一成意见、
 * 重跑时哪些是新的哪些还在哪些已经修掉了。
 *
 * 这层的价值全在「认不认得出还是那一条」与「不许把模型自由格式当成真数据」：
 * 判错一个 key，用户上一轮标的「误报」就会在被修好之前反复冒出来。
 *
 *   node --experimental-strip-types bridge/tests/review-unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  classifyOcrFailure,
  diffCommandFor,
  findingKey,
  mergeFindings,
  parsePreview,
  sameScope,
  unaccounted,
  previewArgs,
  readReviewState,
  repoKey,
  sessionKey,
  reviewArgs,
  reviewStateFile,
  toFindings,
  writeReviewState,
  buildPrompt,
  chunkFiles,
  expectRepoMismatch,
  cancelReview,
  reviewProgresses,
  sweepStaleRuns,
  startReview,
  setPick,
  trimRuns,
  RUN_KEEP,
  TIP_PR_LIMIT,
  tipTargets,
  remoteTipTargets,
  headStamp,
  localTips,
  remoteTips,
} from "../src/review.ts";

process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-review-"));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

const throwsCode = (code, fn) => {
  try {
    fn();
  } catch (err) {
    assert.equal(err?.code, code, `期望 code=${code}，实际 ${err?.code}: ${err?.message}`);
    return;
  }
  assert.fail(`期望抛 ${code}，实际没抛`);
};

const finding = (over = {}) => ({
  path: "web/src/a.ts",
  category: "bug",
  severity: "high",
  startLine: 10,
  endLine: 12,
  content: "空指针风险",
  existingCode: "const x = a.b.c;",
  suggestionCode: "",
  anchored: true,
  ...over,
});

// ---------------------------------------------------------------- preview

check("parsePreview 读 snake_case、camelCase 与未知字段", () => {
  const p = parsePreview(
    JSON.stringify({
      mode: "range",
      merge_base: "abc123",
      from: "main",
      to: "HEAD",
      files: [
        { path: "bridge/src/a.ts", status: "modified", additions: 3, deletions: 1, whatever: true },
        { path: "web/src/b.ts", status: "added", added: 9, removed: 0 },
      ],
      excluded: [{ path: "pnpm-lock.yaml", reason: "too_large" }],
    }),
  );
  assert.equal(p.mode, "range");
  assert.equal(p.mergeBase, "abc123");
  assert.equal(p.from, "main");
  assert.equal(p.to, "HEAD");
  assert.deepEqual(
    p.files.map((f) => f.path),
    ["bridge/src/a.ts", "web/src/b.ts"],
  );
  assert.equal(p.files[0].additions, 3);
  assert.equal(p.files[1].additions, 9, "`added/removed` 这种别名也要认");
  assert.deepEqual(p.skipped, [{ path: "pnpm-lock.yaml", reason: "too_large" }]);
});

check("parsePreview 认得真实那份输出（ocr 1.14.2 的字段名，抄下来的一份）", () => {
  const real = {
    schema_version: "1",
    mode: "workspace",
    repository: "/repo",
    from: "",
    to: "",
    merge_base: "",
    total_files: 2,
    reviewable_count: 1,
    excluded_count: 1,
    total_insertions: 11,
    total_deletions: 3,
    reviewable_files: [{ path: "bridge/src/frames.ts", status: "modified", insertions: 11, deletions: 3 }],
    excluded_files: [{ path: "package-lock.json", reason: "lockfile" }],
  };
  const p = parsePreview(JSON.stringify(real));
  assert.equal(p.mode, "workspace");
  assert.equal(p.files[0].additions, 11, "真实字段叫 insertions");
  assert.equal(p.files[0].deletions, 3);
  assert.deepEqual(p.skipped, [{ path: "package-lock.json", reason: "lockfile" }]);
});

check("parsePreview 认 reviewable_files 与 skipped 这两个别名", () => {
  const p = parsePreview(
    JSON.stringify({
      mode: "workspace",
      reviewable_files: [{ path: "a.ts" }],
      skipped: [{ path: "b.png", reason: "binary" }],
    }),
  );
  assert.deepEqual(p.files.map((f) => f.path), ["a.ts"]);
  assert.deepEqual(p.skipped, [{ path: "b.png", reason: "binary" }]);
  assert.equal(p.files[0].status, "", "缺 status 时不编一个出来");
});

check("parsePreview 对垃圾输入给出可读的 code", () => {
  throwsCode("preview_empty", () => parsePreview("   "));
  throwsCode("preview_unparsable", () => parsePreview("not json at all"));
  throwsCode("preview_unparsable", () => parsePreview(JSON.stringify({ nothing: 1 })));
});

check("classifyOcrFailure 分得出「没装」「太老」「跑挂了」", () => {
  assert.equal(classifyOcrFailure("exec: ocr: executable file not found in $PATH", 1), "ocr_missing");
  assert.equal(classifyOcrFailure("unknown flag: --format", 1), "ocr_too_old");
  assert.equal(classifyOcrFailure("Error: failed to resolve merge-base", 1), "failed");
  assert.equal(classifyOcrFailure("", 0), "");
});

check("previewArgs：PR 与「分支范围」同形（from/to），单提交用 -c", () => {
  assert.deepEqual(previewArgs({ mode: "pr", base: "origin/main", target: "refs/pi-web/pr-7", cwd: "/r" }), [
    "delegate",
    "preview",
    "--from",
    "origin/main",
    "--to",
    "refs/pi-web/pr-7",
    "--format",
    "json",
  ]);
});

check("previewArgs 三种模式各拼各的参数", () => {
  assert.deepEqual(previewArgs({ mode: "workspace", cwd: "/r" }), ["delegate", "preview", "--format", "json"]);
  assert.deepEqual(previewArgs({ mode: "range", base: "main", target: "HEAD", cwd: "/r" }), [
    "delegate",
    "preview",
    "--from",
    "main",
    "--to",
    "HEAD",
    "--format",
    "json",
  ]);
  assert.deepEqual(previewArgs({ mode: "commit", commit: "abc", cwd: "/r" }), [
    "delegate",
    "preview",
    "-c",
    "abc",
    "--format",
    "json",
  ]);
});

// ---------------------------------------------------------------- prompt

check("buildPrompt 点到每个文件、给出自己去取 diff 的命令、只许回 JSON", () => {
  const p = parsePreview(
    JSON.stringify({
      mode: "range",
      merge_base: "abc123",
      from: "main",
      to: "HEAD",
      files: [{ path: "bridge/src/a.ts" }, { path: "web/src/b.ts" }],
    }),
  );
  const text = buildPrompt(p, "zh", "内置规则：空指针要报");
  for (const needle of ["bridge/src/a.ts", "web/src/b.ts", "abc123", "内置规则：空指针要报"]) {
    assert.ok(text.includes(needle), `提示词里没有 ${needle}`);
  }
  assert.ok(text.includes("git --no-pager diff"), "得告诉它自己去取 diff");
  assert.ok(text.includes("只输出"), "得明确只回 JSON");
  assert.ok(/中文/.test(text), "语言要写进提示词");
  assert.ok(text.length > 400, "太短的提示词会漏掉协议");
});

check("chunkFiles：按 8 个一组切，最后一组不满也算", () => {
  const files = Array.from({ length: 19 }, (_, i) => ({ path: `f${i}.ts` }));
  const groups = chunkFiles(files);
  assert.deepEqual(groups.map((g) => g.length), [8, 8, 3]);
  assert.equal(new Set(groups.flat().map((f) => f.path)).size, 19, "切完不能丢文件");
  assert.deepEqual(chunkFiles([]), []);
});

check("buildPrompt 带分组时只让评这一组、并说清这是第几组", () => {
  const p = parsePreview(JSON.stringify({ mode: "workspace", files: [{ path: "a.ts" }, { path: "b.ts" }] }));
  const text = buildPrompt(p, "zh", "", { index: 2, total: 5 });
  assert.ok(text.includes("第 2 组"), text.slice(0, 120));
  assert.ok(text.includes("5 组"));
  const single = buildPrompt(p, "zh", "");
  assert.ok(!single.includes("只负责第"), "只跑一组时不要多一段噪音");
});

check("buildPrompt 说清每个文件都得交代 reviewed 或 skipped", () => {
  const p = parsePreview(JSON.stringify({ mode: "workspace", files: [{ path: "a.ts" }] }));
  const text = buildPrompt(p, "en", "");
  assert.ok(/skipped/.test(text));
  assert.ok(/reviewed/.test(text));
});

check("buildPrompt 不带 merge base 时（工作区模式）用 git diff HEAD", () => {
  const p = parsePreview(JSON.stringify({ mode: "workspace", files: [{ path: "a.ts" }] }));
  const cmd = diffCommandFor(p, "a.ts");
  assert.equal(cmd, "git --no-pager diff HEAD -- a.ts");
});

// ---------------------------------------------------------------- 子进程参数

check("reviewArgs 只给只读工具、不带 AGENTS.md、不存会话", () => {
  const args = reviewArgs({ model: "wb2_mac/cn:deepseek-v4.1-flash", provider: "wb2_mac" });
  const tools = args[args.indexOf("--tools") + 1];
  assert.equal(tools, "read,bash,grep,find,ls");
  assert.ok(!/edit|write/.test(tools), "评审进程不许有写工具");
  assert.ok(args.includes("--no-context-files") || args.includes("-nc"));
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--print") || args.includes("-p"));
  assert.equal(args[args.indexOf("--mode") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "wb2_mac/cn:deepseek-v4.1-flash");
  assert.equal(args[args.indexOf("--provider") + 1], "wb2_mac");
  assert.ok(args.includes("--no-mcp"));
});

// ---------------------------------------------------------------- 模型输出归一

check("toFindings 认得围栏 JSON 与裸 JSON，丢缺字段的", () => {
  const fenced = toFindings(
    '好的，结果如下：\n```json\n{"findings":[{"path":"a.ts","content":"NPE","start_line":3,"end_line":4,"category":"bug","severity":"critical","existing_code":"a.b"}],"skipped":[]}\n```\n以上。',
  );
  assert.equal(fenced.findings.length, 1);
  assert.equal(fenced.findings[0].startLine, 3);
  assert.equal(fenced.findings[0].severity, "critical");
  assert.equal(fenced.findings[0].existingCode, "a.b");

  const bare = toFindings('{"findings":[{"content":"没有路径"},{"path":"b.ts"}]}');
  assert.equal(bare.findings.length, 0, "缺 path 或 content 的一律丢掉");

  const skipped = toFindings('{"findings":[],"skipped":[{"path":"c.bin","reason":"binary"}]}');
  assert.deepEqual(skipped.skipped, [{ path: "c.bin", reason: "binary" }]);
});

check("toFindings 把 start_line 0 标成未锚定，未知类别/严重度落到默认档", () => {
  const { findings } = toFindings(
    JSON.stringify({
      findings: [{ path: "a.ts", content: "x", start_line: 0, category: "nonsense", severity: "blocker" }],
    }),
  );
  assert.equal(findings[0].anchored, false);
  assert.equal(findings[0].startLine, 0);
  assert.equal(findings[0].category, "other");
  assert.equal(findings[0].severity, "low");
});

check("toFindings 认 camelCase，并且对完全不是 JSON 的输出给空结果而不是炸", () => {
  const camel = toFindings(
    JSON.stringify({ findings: [{ path: "a.ts", content: "x", startLine: 7, endLine: 8, existingCode: "q" }] }),
  );
  assert.equal(camel.findings[0].startLine, 7);
  assert.equal(camel.findings[0].existingCode, "q");
  assert.deepEqual(toFindings("模型今天不想干活").findings, []);
});

// ---------------------------------------------------------------- 认得上同一条

check("findingKey 只认 path+类别+代码片段", () => {
  const a = finding();
  const b = finding({ content: "换了一种说法", startLine: 99, severity: "low" });
  assert.equal(findingKey(a), findingKey(b), "文案 / 行号 / 严重度都不该影响身份");
  assert.notEqual(findingKey(a), findingKey(finding({ existingCode: "const y = 1;" })));
  assert.notEqual(findingKey(a), findingKey(finding({ category: "security" })));
});

check("findingKey 忽略空白差异（同一段代码被重新缩进不算新意见）", () => {
  const a = finding({ existingCode: "  if (x) {\n    y();\n  }" });
  const b = finding({ existingCode: "if (x) {\n  y();\n}" });
  assert.equal(findingKey(a), findingKey(b));
});

check("mergeFindings 分得出 新增 / 仍在 / 已解决，并保住已标的处理态", () => {
  const a = finding({ path: "a.ts", existingCode: "A" });
  const b = finding({ path: "b.ts", existingCode: "B" });
  const c = finding({ path: "c.ts", existingCode: "C" });
  const marks = { [findingKey(b)]: "false-positive" };
  const out = mergeFindings([a, b], [b, c], marks);
  assert.deepEqual(
    out.findings.map((f) => [f.path, f.state]),
    [
      ["b.ts", "persisting"],
      ["c.ts", "new"],
    ],
  );
  assert.deepEqual(out.resolved, [findingKey(a)]);
  assert.deepEqual(out.resolvedPaths, ["a.ts"], "已解决也要说得出是哪个文件");
  assert.equal(out.findings[0].mark, "false-positive");
  assert.equal(out.findings[1].mark, "", "没标过的就不带处理态");
});

check("mergeFindings 第一次跑（没有上一轮）全部是 new", () => {
  const out = mergeFindings([], [finding()], {});
  assert.equal(out.findings[0].state, "new");
  assert.deepEqual(out.resolved, []);
});

check("sameScope：PR 只跟同一个号比，分支范围要两侧都对上", () => {
  const pr7 = { mode: "pr", from: "origin/main", to: "refs/pi-web/pr-7", mergeBase: "a", pr: 7 };
  assert.equal(sameScope(pr7, { ...pr7 }), true);
  assert.equal(sameScope(pr7, { ...pr7, pr: 8 }), false, "另一个 PR 不是同一个范围");
  const range = { mode: "range", from: "main", to: "HEAD", mergeBase: "a", pr: 0 };
  assert.equal(sameScope(range, { ...range, to: "dev" }), false, "目标分支变了就不是同一件事");
});

check("sameScope：工作区 / 同一对照分支 / 同一提交才算同一个范围", () => {
  const ws = { mode: "workspace", from: "", to: "HEAD", mergeBase: "" };
  const rangeMain = { mode: "range", from: "main", to: "HEAD", mergeBase: "abc" };
  const rangeOther = { mode: "range", from: "develop", to: "HEAD", mergeBase: "def" };
  const commit1 = { mode: "commit", from: "", to: "sha1", mergeBase: "" };
  assert.equal(sameScope(ws, { ...ws }), true);
  assert.equal(sameScope(rangeMain, { ...rangeMain }), true);
  assert.equal(sameScope(rangeMain, rangeOther), false, "换了对照分支就不是同一个范围");
  assert.equal(sameScope(commit1, { ...commit1, to: "sha2" }), false);
  assert.equal(sameScope(ws, rangeMain), false, "工作区那次不能当分支评审的基线");
  assert.equal(sameScope(ws, commit1), false);
});

check("unaccounted：preview 说可评、模型既没报也没 skip 的文件要显式列出来", () => {
  const preview = parsePreview(
    JSON.stringify({
      mode: "workspace",
      reviewable_files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      excluded_files: [{ path: "big.bin", reason: "too_large" }],
    }),
  );
  const out = unaccounted(preview, [{ path: "c.ts", reason: "skipped" }], [{ path: "a.ts", category: "bug", existingCode: "x" }]);
  assert.deepEqual(
    out.map((s) => [s.path, s.reason]),
    [
      ["big.bin", "too_large"],
      ["c.ts", "skipped"],
      ["b.ts", "not_reported"],
    ],
    "有意见的文件算交代过了，只把真正没提的那个列出来",
  );
});

// ---------------------------------------------------------------- 落盘

check("repoKey 抹平尾斜杠与大小写差异（同一个仓库只有一个 key）", () => {
  assert.equal(repoKey("/Users/me/Repo/"), repoKey("/Users/me/Repo"));
  assert.equal(repoKey("/Users/me/Repo"), repoKey("/Users/ME/repo"));
  assert.notEqual(repoKey("/Users/me/a"), repoKey("/Users/me/b"));
});

check("reviewStateFile 落在状态目录的 review/ 下", () => {
  const file = reviewStateFile("/Users/me/repo");
  assert.ok(file.startsWith(process.env.PI_WEB_STATE), file);
  assert.ok(file.includes(path.join("review", "")), file);
});

check("落盘读回：没有文件给空状态，写进去什么读出来什么", () => {
  const repo = "/Users/me/repo";
  assert.deepEqual(readReviewState(repo), { repo, runs: [], marks: {} });
  writeReviewState(repo, {
    repo,
    marks: { k1: "ignore" },
    runs: [{ id: "r1", status: "done", findings: [] }],
  });
  const back = readReviewState(repo);
  assert.equal(back.runs.length, 1);
  assert.equal(back.marks.k1, "ignore");
});

check("会话隔离：同一个仓库里两个会话各有各的评审与处理态", () => {
  const repo = "/Users/me/two-sessions";
  writeReviewState(repo, { repo, runs: [{ id: "a", status: "done", findings: [] }], marks: {} }, "s1");
  writeReviewState(repo, { repo, runs: [{ id: "b", status: "done", findings: [] }], marks: { k: "accept" } }, "s2");
  assert.equal(readReviewState(repo, "s1").runs[0].id, "a");
  assert.equal(readReviewState(repo, "s2").runs[0].id, "b");
  assert.deepEqual(readReviewState(repo, "s1").marks, {}, "处理态也不许串");
  assert.equal(readReviewState(repo, "s3").runs.length, 0, "没评过的会话是空的");
  assert.notEqual(reviewStateFile(repo, "s1"), reviewStateFile(repo, "s2"));
  assert.equal(sessionKey(""), "_nosession");
});

check("期望仓库（#666）：同仓放行、跨仓拒、任一方为空不拦", () => {
  // 两个来源一个是链接原文、一个是 git remote 归一过的：大小写与空格不算差异。
  assert.equal(expectRepoMismatch("acme/widgets", "Acme/Widgets"), false);
  assert.equal(expectRepoMismatch("acme/widgets", " acme/widgets "), false);
  assert.equal(expectRepoMismatch("yang-code01/pi-web-client", "acme/widgets"), true);
  // 不带这个字段（老页面、手输号、别的入口）或认不出本地仓库时一律不拦：这里不是新的闸。
  assert.equal(expectRepoMismatch("acme/widgets", ""), false);
  assert.equal(expectRepoMismatch("", "acme/widgets"), false);
  assert.equal(expectRepoMismatch("", ""), false);
});

check("期望仓库：别仓的号在开跑之前就被拒（不 fetch、不起子进程）", () => {
  // startReview 的这道闸必须在 resolvePullRequest 之前：那一步会 `git fetch refs/pull/N/head`，
  // 号是别仓的就等于把错的东西拉进这个仓库。
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-review-pr-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: repo });
  let code = "";
  try {
    startReview({ dir: repo, mode: "pr", pr: 12, expectRepo: "acme/other", lang: "zh" });
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, "pr_foreign_repo");
  assert.equal(fs.existsSync(reviewStateFile(repo, "")), false, "拒掉的那一次不该落状态");
});

// ---- 并发（D420）：一个会话同时评两条，额度只按会话算 -----------------------

/** 一个没有 remote 的临时仓库：pr 模式会在 resolvePullRequest 里立刻失败，闸门逻辑跑得飞快。 */
function bareRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-web-review-${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function startThrows(o) {
  try {
    startReview(o);
  } catch (err) {
    return err;
  }
  return null;
}

check("并发（D420）：同一会话两条能一起跑，第三条在开跑前就被拒", () => {
  const a = bareRepo("cap-a");
  const b = bareRepo("cap-b");
  const c = bareRepo("cap-c");
  const session = "cap-session";
  const first = startReview({ dir: a, mode: "pr", pr: 1, session, lang: "zh" });
  const one = startReview({ dir: b, mode: "pr", pr: 2, session, lang: "zh" });
  assert.ok(first.runId && one.runId && first.runId !== one.runId, "两条各是一个 runId");
  const third = startThrows({ dir: c, mode: "pr", pr: 3, session, lang: "zh" });
  assert.equal(third?.code, "busy", "第三条必须当场被拒");
  assert.equal(String(third?.params?.p1), "2", "理由里要说清上限是 2");
  // 额度按会话算、跨仓库共用；另一个会话不受影响。
  const other = startReview({ dir: c, mode: "pr", pr: 3, session: "another", lang: "zh" });
  assert.ok(other.runId);
  cancelReview(a, session);
  cancelReview(b, session);
  cancelReview(c, "another");
});

check("并发（D420）：同一个 PR 在同一次会话里只许一条（dup_pr），别的号放行", () => {
  const repo = bareRepo("dup");
  const session = "dup-session";
  startReview({ dir: repo, mode: "pr", pr: 691, session, lang: "zh" });
  const again = startThrows({ dir: repo, mode: "pr", pr: 691, session, lang: "zh" });
  assert.equal(again?.code, "dup_pr");
  assert.equal(String(again?.params?.p1), "691", "提示里要带号");
  // 同一个号在另一个会话里是另一回事
  const otherSession = startReview({ dir: repo, mode: "pr", pr: 691, session: "dup-other", lang: "zh" });
  assert.ok(otherSession.runId);
  // 同一个会话里换一个号照开
  const otherPr = startReview({ dir: repo, mode: "pr", pr: 692, session, lang: "zh" });
  assert.ok(otherPr.runId);
  cancelReview(repo, session);
  cancelReview(repo, "dup-other");
});

check("并发（D420）：按 runId 停一条，另一条不受影响", () => {
  const repo = bareRepo("cancel");
  const session = "cancel-session";
  const a = startReview({ dir: repo, mode: "pr", pr: 1, session, lang: "zh" });
  const b = startReview({ dir: repo, mode: "pr", pr: 2, session, lang: "zh" });
  assert.deepEqual(
    reviewProgresses(repo, session).map((p) => p.runId).sort(),
    [a.runId, b.runId].sort(),
    "两条各有一份进度",
  );
  assert.equal(cancelReview(repo, "other-session", a.runId), false, "别的会话停不动这条");
  assert.equal(cancelReview(repo, session, "no-such-run"), false);
  assert.equal(cancelReview(repo, session, a.runId), true);
  // 子进程可能还在退出的路上：额度与同号查重都不提前放开（否则同一份 diff 会有两个进程）。
  // 同一个 tick 里它还在 active 上，所以这里必然是 dup_pr，而不是重新开跑。
  throwsCode("dup_pr", () => startReview({ dir: repo, mode: "pr", pr: 1, session, lang: "zh" }));
  assert.equal(reviewProgresses(repo, session).length, 2, "a 还在收尾，先别把它从进度里摘掉");
  cancelReview(repo, session, b.runId);
});

check("并发（D420）：进度只按「仓库 + 会话」发给自己的会话", () => {
  const repo = bareRepo("isolate");
  const a = startReview({ dir: repo, mode: "pr", pr: 7, session: "s1", lang: "zh" });
  startReview({ dir: repo, mode: "pr", pr: 8, session: "s2", lang: "zh" });
  assert.deepEqual(reviewProgresses(repo, "s1").map((p) => p.runId), [a.runId]);
  assert.equal(reviewProgresses(repo, "s3").length, 0);
  cancelReview(repo, "s1");
  cancelReview(repo, "s2");
});

check("并发（D420）：桥重启后 sweep 按「条」计数，不只是按文件", () => {
  const prev = process.env.PI_WEB_STATE;
  process.env.PI_WEB_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-review-sweep-"));
  try {
    const repo = "/Users/me/sweep";
    const running = (id) => ({ id, status: "running", findings: [] });
    writeReviewState(repo, { repo, runs: [running("a"), running("b")], marks: {} }, "s1");
    writeReviewState(repo, { repo, runs: [running("c"), { id: "d", status: "done", findings: [] }], marks: {} }, "s2");
    assert.equal(sweepStaleRuns(), 3, "两个会话共三条在跑");
    const all = [...readReviewState(repo, "s1").runs, ...readReviewState(repo, "s2").runs];
    assert.equal(all.filter((r) => r.status === "running").length, 0);
    assert.equal(all.find((r) => r.id === "d").status, "done", "已经跑完的那条不许动");
  } finally {
    process.env.PI_WEB_STATE = prev;
  }
});

check("写盘本身不裁剪：标意见 / 改 pick 不许把正看着的那条挤掉", () => {
  // 裁剪只在 startReview() 加完新记录后做（trimRuns）；写盘是所有改动的窄口，不能在那里截。
  const repo = "/Users/me/many";
  const runs = Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, status: "done", findings: [] }));
  writeReviewState(repo, { repo, runs, marks: {} });
  assert.equal(readReviewState(repo).runs.length, 21);
});

check("加新记录时的裁剪：留最后 20 次，更早的滚掉", () => {
  const runs = Array.from({ length: 25 }, (_, i) => ({ id: `k${i}`, status: "done", findings: [] }));
  const state = { repo: "/Users/me/trim", runs, marks: {} };
  trimRuns(state);
  assert.equal(state.runs.length, RUN_KEEP);
  assert.equal(state.runs[0].id, "k5");
  assert.equal(state.runs[state.runs.length - 1].id, "k24");
});

check("「评什么」存得下也读得回（空串照原样存，别被默认值顶掉）", () => {
  const repo = "/Users/me/pickrepo";
  const pick = { mode: "range", pr: 0, base: "main", target: "", commit: "" };
  assert.deepEqual(setPick(repo, pick, "s1").pick, pick);
  assert.deepEqual(readReviewState(repo, "s1").pick, pick);
});

// ---- 过时（#741）：完成态记录核对「现在的 tip 是多少」 ----------------------

/** 异步的那几条（`remoteTips` 要发一次 ls-remote）：`check()` 只认同步函数。 */
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
};

/** 一条已经收尾的记录：只填核对 tip 会读到的那几项，其余留空。 */
const doneRun = (over = {}) => ({
  id: "r1",
  status: "done",
  mode: "range",
  from: "main",
  to: "HEAD",
  mergeBase: "abc",
  pr: 0,
  prTitle: "",
  prHead: "",
  prBase: "",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  headSha: "aaaa1111",
  findings: [],
  ...over,
});

check("tipTargets 只核对「完成的、分支或 PR 的、记了被评 sha 的」记录", () => {
  const runs = [
    doneRun({ id: "range", to: "HEAD" }),
    doneRun({ id: "pr", mode: "pr", pr: 7, to: "refs/pi-web/pr-7" }),
    doneRun({ id: "ws", mode: "workspace", to: "HEAD", from: "" }),
    doneRun({ id: "commit", mode: "commit", to: "abc1234", from: "" }),
    doneRun({ id: "failed", status: "failed" }),
    doneRun({ id: "stopped", status: "stopped" }),
    doneRun({ id: "running", status: "running" }),
    doneRun({ id: "old", headSha: undefined }),
  ];
  assert.deepEqual(
    tipTargets(runs).map((t) => t.ref),
    ["HEAD", "refs/pi-web/pr-7"],
    "工作区、单提交、没跑成的、老记录都不核对",
  );
});

check("tipTargets 新的在前，按 ref 去重（同一个分支评过两次只核对一次）", () => {
  const runs = [
    doneRun({ id: "a", to: "HEAD", startedAt: "2026-01-01T00:00:00.000Z" }),
    doneRun({ id: "b", to: "feat/x", startedAt: "2026-01-02T00:00:00.000Z" }),
    doneRun({ id: "c", to: "HEAD", startedAt: "2026-01-03T00:00:00.000Z" }),
  ];
  assert.deepEqual(tipTargets(runs).map((t) => t.ref), ["HEAD", "feat/x"]);
});

check("remoteTipTargets 按 PR 号去重、最多 3 个（留着最新的那一份 ref）", () => {
  const runs = [];
  for (let i = 1; i <= 5; i += 1) {
    runs.push(doneRun({ id: `p${i}`, mode: "pr", pr: i, to: `refs/pi-web/pr-${i}`, startedAt: `2026-01-0${i}T00:00:00.000Z` }));
  }
  // 同一个号评了第二次：只该查一次
  runs.push(doneRun({ id: "p5again", mode: "pr", pr: 5, to: "refs/pi-web/pr-5", startedAt: "2026-01-09T00:00:00.000Z" }));
  const picked = remoteTipTargets(tipTargets(runs));
  assert.deepEqual(picked.map((t) => t.pr), [5, 4, 3], `上限是 ${TIP_PR_LIMIT} 个，新的优先`);
  assert.equal(picked.filter((t) => t.pr === 5).length, 1, "同一个 PR 只留一条");
});

check("localTips 拿本地 rev-parse 的结果当 tip；认不出这个 ref 就不给 key", () => {
  const runs = [doneRun({ id: "a", to: "HEAD" }), doneRun({ id: "b", to: "feat/gone" })];
  const tips = localTips(runs, (ref) => (ref === "HEAD" ? "bbbb2222" : ""));
  assert.deepEqual(tips, { HEAD: "bbbb2222" }, "认不出的 ref 是「不知道」，不是空串");
});

check("headStamp：收尾时记被评的 sha，`HEAD` 再记当时那条分支", () => {
  const deps = { shaOf: () => "aaaa1111", branch: () => "feat/a" };
  assert.deepEqual(headStamp({ to: "HEAD" }, deps), { headSha: "aaaa1111", headRef: "feat/a" });
  assert.deepEqual(headStamp({ to: "feat/x" }, deps), { headSha: "aaaa1111" }, "分支名本身就是 ref，不用记当时在哪");
  // 分离头指针 / 认不出这个 ref：宁可少记一项，也不编一个值
  assert.deepEqual(headStamp({ to: "HEAD" }, { shaOf: () => "aaaa1111", branch: () => "" }), { headSha: "aaaa1111" });
  assert.deepEqual(headStamp({ to: "feat/gone" }, { shaOf: () => "", branch: () => "feat/a" }), {});
});

check("`to: HEAD` 的记录只在**同一条分支**上比：换分支不是「有新提交」", () => {
  const runs = [doneRun({ id: "a", to: "HEAD", headRef: "feat/a" })];
  assert.deepEqual(localTips(runs, () => "bbbb2222", "feat/a"), { HEAD: "bbbb2222" }, "同一条分支：照旧比");
  assert.deepEqual(localTips(runs, () => "bbbb2222", "feat/b"), {}, "换到别的分支：核对不了，不标");
  // 分离头指针（现在没有分支名）与老记录（当时没记分支）都退回「照旧比」。
  assert.deepEqual(localTips(runs, () => "bbbb2222", ""), { HEAD: "bbbb2222" });
  assert.deepEqual(localTips([doneRun({ id: "b", to: "HEAD" })], () => "bbbb2222", "feat/b"), { HEAD: "bbbb2222" });
});

check("localTips 不碰网络：PR 那几条留给远端那半", () => {
  let asked = 0;
  const runs = [doneRun({ id: "pr", mode: "pr", pr: 7, to: "refs/pi-web/pr-7" })];
  localTips(runs, () => {
    asked += 1;
    return "cccc3333";
  });
  assert.equal(asked, 0);
});

await checkAsync("remoteTips 一次 ls-remote 拿一批；失败或抛错的那个号不出现（不是空串）", async () => {
  const runs = [
    doneRun({ id: "a", mode: "pr", pr: 1, to: "refs/pi-web/pr-1" }),
    doneRun({ id: "b", mode: "pr", pr: 2, to: "refs/pi-web/pr-2" }),
    doneRun({ id: "c", mode: "pr", pr: 3, to: "refs/pi-web/pr-3", startedAt: "2026-01-05T00:00:00.000Z" }),
  ];
  const calls = [];
  const tips = await remoteTips(runs, async (prs) => {
    calls.push([...prs]);
    // 2 号远端没答（PR 没了 / 超时）：不该冒充「没变」。
    return { 1: "dddd4444" };
  });
  assert.deepEqual(tips, { "refs/pi-web/pr-1": "dddd4444" });
  assert.equal(calls.length, 1, "一批只发一次 ls-remote");
  assert.deepEqual([...calls[0]].sort(), [1, 2, 3], "三个号在同一次里问");
});

await checkAsync("远端整个坏掉时一条 key 都不给（超时 = 不知道，不是「没变」）", async () => {
  const runs = [doneRun({ id: "a", mode: "pr", pr: 1, to: "refs/pi-web/pr-1" })];
  const tips = await remoteTips(runs, async () => {
    throw new Error("ls-remote 超时");
  });
  assert.deepEqual(tips, {});
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
