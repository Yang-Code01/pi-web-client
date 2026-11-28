#!/usr/bin/env node
/**
 * 评审子进程「一句话没答」時，面板拿到的是什么（D454 的验收缝）。
 *
 * 真机那次：`wb2api` 的网关（192.168.31.36:7863）掉线，子进程退出码 0、37 行事件、0 token，
 * 面板只能说「重试后仍然没有给出结论（已用 0k token）……可以换个更便宜的模型」。原因
 * （`connect EHOSTDOWN …`）一直在子进程的事件流里，只是没人读。
 *
 * 这里用真 worker + 假 ocr + 假 pi 走生产那条路，断言三件事：
 *   1. 子进程报了错 → 这组标 failed、整轮 failed，错误原文带出地址，且文案不再说「更便宜」；
 *   2. 子进程报了错就不重试（假 pi 只被起一次）—— 省掉「四组各 25 秒」；
 *   3. 没答但也没报错 → 照旧重试一次；重试还不行才算失败（不让「答上了」的组被误判）；
 *   4. 正常答 JSON 的那条路仍然是 done（没顺手改坏）。
 *
 * 跑：node --experimental-strip-types bridge/tests/review-connect-error-e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WORKER = path.join(ROOT, "bridge", "src", "review-worker.ts");
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-nooutput-")));
const STATE = path.join(TMP, "state");
const REPO = path.join(TMP, "repo");
const BIN = path.join(TMP, "bin");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.PI_WEB_STATE = STATE;
const review = await import("../src/review.ts");
// 别让 startReview 真的 detached 起一份 worker：这个用例自己 spawn，好等它跑完、好数假 pi 起了几次。
review.setReviewLauncher(() => {});

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

const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---- 现场：一个真仓库 + 一处改动（workspace 模式不需要远端）------------------
fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
fs.writeFileSync(path.join(REPO, "demo.txt"), "base\n");
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
fs.writeFileSync(path.join(REPO, "demo.txt"), "base\nchanged\n");

// ---- 假 ocr：一个文件可评，规则空着 ----------------------------------------
fs.mkdirSync(BIN, { recursive: true });
const fakeOcr = path.join(TMP, "fake-ocr.mjs");
fs.writeFileSync(
  fakeOcr,
  [
    "const args = process.argv.slice(2);",
    'if (args.includes("preview")) {',
    '  const n = Number(process.env.FAKE_OCR_FILE_COUNT || 1);',
    '  const files = Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, status: "modified", insertions: 1, deletions: 0 }));',
    '  process.stdout.write(JSON.stringify({ mode: "workspace", files, excluded_files: [] }));',
    '} else if (args.includes("rule")) {',
    '  process.stdout.write("");',
    "} else {",
    '  process.stdout.write("ocr version 1.9.0\\n");',
    "}",
  ].join("\n"),
);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(BIN, "ocr.cmd"), `@"${process.execPath}" "${fakeOcr}" %*\r\n`);
} else {
  const shim = path.join(BIN, "ocr");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeOcr}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

// ---- 假 pi：按 FAKE_PI_MODE 演三种结局，每次调用记一行到 FAKE_PI_CALLS ------------
// 每个场景用自己的 calls 文件：上一个场景残留的 worker 不会把调用次数算进下一个头上。
const fakePi = path.join(TMP, "fake-pi.mjs");
fs.writeFileSync(
  fakePi,
  [
    'import fs from "node:fs";',
    "process.stdin.resume();",
    'const calls = process.env.FAKE_PI_CALLS || "";',
    "const list = (() => { try { return JSON.parse(fs.readFileSync(calls, 'utf8')); } catch { return []; } })();",
    "list.push(Date.now());",
    "if (calls) fs.writeFileSync(calls, JSON.stringify(list));",
    "const mode = process.env.FAKE_PI_MODE || 'error';",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "if (mode === 'error' || mode === 'error-exit') {",
    "  out({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 0 }, stopReason: 'error', errorMessage: 'Connection error.: connect EHOSTDOWN 192.168.31.36:7863 - Local (192.168.31.72:56888)' } });",
    "  if (mode === 'error-exit') { process.exit(1); }",
    "} else if (mode === 'silent') {",
    "  out({ type: 'turn_start' });",
    "} else if (mode === 'split') {",
    "  // 第 1 组两次都超上下文（不重试也没用），第 2 组正常 —— 验「单组的错不许拖死后面的组」",
    "  if (list.length <= 2) out({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 0 }, stopReason: 'error', errorMessage: 'maximum context length exceeded' } });",
    "  else out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ findings: [], skipped: [] }) }], usage: { totalTokens: 7 }, stopReason: 'stop' } });",
    "} else if (mode === 'flaky') {",
    "  // 单次限流：第一次报 429，重试就恢复了 —— 验「非网络错照旧再问一次」",
    "  if (list.length === 1) out({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 0 }, stopReason: 'error', errorMessage: '429 Too Many Requests: rate limit exceeded' } });",
    "  else out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ findings: [], skipped: [] }) }], usage: { totalTokens: 7 }, stopReason: 'stop' } });",
    "} else {",
    "  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ findings: [], skipped: [] }) }], usage: { totalTokens: 7 }, stopReason: 'stop' } });",
    "}",
    "setTimeout(() => process.exit(0), 60);",
  ].join("\n"),
);

const childEnv = (mode, scenario) => ({
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_BIN: fakePi,
  FAKE_PI_MODE: mode,
  FAKE_PI_CALLS: path.join(TMP, `calls-${scenario}.json`),
  // 拆成两组要有 GROUP_FILES + 1 个文件；跟着常量算，不写死 9（改分组阈值时这条不该莫名其妙变红）。
  FAKE_OCR_FILE_COUNT: scenario === "split" ? String(review.GROUP_FILES + 1) : "1",
  PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
});

/** 某个场景里假 pi 被起过几次（文件不存在 = 0 次）。 */
const callsOf = (scenario) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, `calls-${scenario}.json`), "utf8"));
  } catch {
    return [];
  }
};

/** 起一份真 worker 跑完这一次评审（job 已由 startReview 写好）。 */
async function runWorker(runId, mode, scenario) {
  const job = review.reviewJobFile(runId);
  const child = spawn(process.execPath, ["--experimental-strip-types", WORKER, job], {
    env: childEnv(mode, scenario),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (c) => (logs += String(c)));
  child.stderr.on("data", (c) => (logs += String(c)));
  const done = new Promise((r) => child.on("exit", (code) => r(code)));
  const code = await done;
  return { code, logs };
}

/** 等落盘的状态里这条 run 不再是 running。 */
async function waitRun(session, runId, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const state = review.readReviewState(REPO, session);
    const run = state.runs.find((r) => r.id === runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - t0 > ms) throw new Error(`超时：${session} 的评审还停在 ${run?.status}`);
    await sleep(100);
  }
}

const start = (session, model = "cn:glm-5.4") => {
  const { runId } = review.startReview({
    dir: REPO,
    mode: "workspace",
    session,
    model,
    provider: "wb2api",
    lang: "zh",
  });
  return runId;
};

/**
 * 一个场景：起 worker、等落盘再断言。断言抛错只算这一条失败，接着跑下一个场景 ——
 * 否则一次 waitRun 超时就把后面的用例和最后的汇总一起带走。
 */
async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err?.message ?? err}`);
  }
}

try {
  // ---- 1. 子进程报了错：不重试、带原话、说「没连上」 -----------------------------
  await scenario("网关报错", async () => {
    const session = "s-connect-error";
    const runId = start(session);
    const { code, logs } = await runWorker(runId, "error", "error");
    check("假 pi 退了 0，worker 也退 0", () => assert.equal(code, 0, logs.slice(-500)));
    const run = await waitRun(session, runId);
    const calls = callsOf("error");

    check("网关报错：整轮记成 failed（不是 done，也不是「完成 0 条」）", () => {
      assert.equal(run.status, "failed");
      assert.equal(run.errorCode, "child_no_output");
    });
    check("错误原文带出地址，并说清是没连上", () => {
      assert.match(run.error, /192\.168\.31\.36:7863/, `实际：${run.error}`);
      assert.match(run.error, /没连上/);
      assert.doesNotMatch(run.error, /更便宜/, "网络故障不该被说成「模型不划算」");
    });
    check("分组计划里第 1 组是 failed", () => {
      assert.equal(run.plan?.[0]?.state, "failed", `实际：${JSON.stringify(run.plan)}`);
    });
    check("来源连不上就不再重试：假 pi 只被起了一次", () => {
      assert.equal(calls.length, 1, `实际起了 ${calls.length} 次`);
    });
  });

  // ---- 1b. 报错之后又以非 0 退出：原因不许缩成「退出码 N」 ---------------------------
  await scenario("报错并非 0 退出", async () => {
    const session = "s-error-exit";
    const runId = start(session);
    const { code } = await runWorker(runId, "error-exit", "error-exit");
    check("worker 自己仍然是 0（它只是跑完了一次评审）", () => assert.equal(code, 0));
    const run = await waitRun(session, runId);
    check("非 0 退出也带出 provider 原话，不是「退出码 1」", () => {
      assert.equal(run.status, "failed");
      assert.equal(run.errorCode, "child_failed");
      assert.match(run.error, /192\.168\.31\.36:7863/, `实际：${run.error}`);
      assert.doesNotMatch(run.error, /退出码/, "有原话就不该只报行数/退出码");
    });
  });

  // ---- 2. 没答但也没报错：照旧重试一次，重试还不行才算失败 ------------------------
  await scenario("沉默无答", async () => {
    const session = "s-silent";
    const runId = start(session);
    await runWorker(runId, "silent", "silent");
    const run = await waitRun(session, runId);
    const calls = callsOf("silent");

    check("沉默无答：重试一次（两回子进程）", () => {
      assert.equal(calls.length, 2, `实际起了 ${calls.length} 次`);
    });
    check("沉默无答：仍然算失败，文案不留「输出 N 行」当结论", () => {
      assert.equal(run.status, "failed");
      assert.equal(run.errorCode, "child_no_output");
      assert.match(run.error, /没有给出结论/);
    });
  });

  // ---- 2b. 只影响一组的错（超上下文 / 单次限流）：别把后面的组一起拖死 ---------------
  await scenario("单组错", async () => {
    const session = "s-split";
    const runId = start(session);
    await runWorker(runId, "split", "split");
    const run = await waitRun(session, runId);
    const calls = callsOf("split");

    check("单组复错：第 1 组 failed，第 2 组照跑（plan 里 done）", () => {
      assert.equal(run.plan?.[0]?.state, "failed", `实际：${JSON.stringify(run.plan)}`);
      assert.equal(run.plan?.[1]?.state, "done", `实际：${JSON.stringify(run.plan)}`);
    });
    check("单组复错：第 1 组重试过一次（共 2 次），第 2 组 1 次", () => {
      assert.equal(calls.length, 3, `实际起了 ${calls.length} 次`);
    });
    check("单组复错：整轮仍算 failed（覆盖不全），但文案不说断网", () => {
      assert.equal(run.status, "failed");
      assert.equal(run.errorCode, "child_no_output");
      assert.match(run.error, /没有给出结论/);
      assert.doesNotMatch(run.error, /没连上/, "超上下文不是网络故障");
    });
  });

  // ---- 2c. 单次限流（429）：照老规矩再问一次，这一次就答上了 → 整轮 done -----------------
  await scenario("限流后恢复", async () => {
    const session = "s-flaky";
    const runId = start(session);
    await runWorker(runId, "flaky", "flaky");
    const run = await waitRun(session, runId);
    const calls = callsOf("flaky");

    check("限流后重试成功：一共起两次，第 1 组 done", () => {
      assert.equal(calls.length, 2, `实际起了 ${calls.length} 次`);
      assert.equal(run.plan?.[0]?.state, "done", `实际：${JSON.stringify(run.plan)}`);
    });
    check("限流后重试成功：整轮是 done，不是 failed", () => {
      assert.equal(run.status, "done");
      assert.equal(run.error, "");
    });
  });

  // ---- 3. 正常作答：仍然 done（别把好路改坏） -----------------------------------
  await scenario("正常作答", async () => {
    const session = "s-ok";
    const runId = start(session);
    await runWorker(runId, "ok", "ok");
    const run = await waitRun(session, runId);
    check("正常作答：done，没有错误", () => {
      assert.equal(run.status, "done");
      assert.equal(run.error, "");
      assert.ok(run.tokens > 0, "用量要记下来");
    });
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
