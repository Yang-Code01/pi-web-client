#!/usr/bin/env node
/**
 * 评审子进程「一句话没答」時，面板拿到的是什么（D452 的验收缝）。
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
    '  process.stdout.write(JSON.stringify({ mode: "workspace", files: [{ path: "demo.txt", status: "modified", insertions: 1, deletions: 0 }], excluded_files: [] }));',
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

// ---- 假 pi：按 FAKE_PI_MODE 演三种结局，并把自己起了几次记在 calls.json -----------
const fakePi = path.join(TMP, "fake-pi.mjs");
const callsFile = path.join(TMP, "calls.json");
fs.writeFileSync(
  fakePi,
  [
    'import fs from "node:fs";',
    "process.stdin.resume();",
    `const calls = ${JSON.stringify(callsFile)};`,
    "let n = 0;",
    "try { n = JSON.parse(fs.readFileSync(calls, 'utf8')).length; } catch {}",
    "const list = (() => { try { return JSON.parse(fs.readFileSync(calls, 'utf8')); } catch { return []; } })();",
    "list.push(Date.now());",
    "fs.writeFileSync(calls, JSON.stringify(list));",
    "const mode = process.env.FAKE_PI_MODE || 'error';",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "if (mode === 'error') {",
    "  out({ type: 'message_end', message: { role: 'assistant', content: [], usage: { totalTokens: 0 }, stopReason: 'error', errorMessage: 'Connection error.: connect EHOSTDOWN 192.168.31.36:7863 - Local (192.168.31.72:56888)' } });",
    "} else if (mode === 'silent') {",
    "  out({ type: 'turn_start' });",
    "} else {",
    "  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ findings: [], skipped: [] }) }], usage: { totalTokens: 7 }, stopReason: 'stop' } });",
    "}",
    "setTimeout(() => process.exit(0), 60);",
  ].join("\n"),
);

const childEnv = (mode) => ({
  ...process.env,
  PI_WEB_STATE: STATE,
  PI_BIN: fakePi,
  FAKE_PI_MODE: mode,
  PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
});

/** 起一份真 worker 跑完这一次评审（job 已由 startReview 写好）。 */
async function runWorker(runId, mode) {
  const job = review.reviewJobFile(runId);
  const child = spawn(process.execPath, ["--experimental-strip-types", WORKER, job], {
    env: childEnv(mode),
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

// ---- 1. 子进程报了错：不重试、带原话、说「没连上」 -----------------------------
{
  const session = "s-connect-error";
  const runId = start(session);
  const { code } = await runWorker(runId, "error");
  assert.equal(code, 0, "假 pi 退了 0，worker 也该退 0");
  const run = await waitRun(session, runId);
  const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));

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
  check("报了错就不再重试：假 pi 只被起了一次", () => {
    assert.equal(calls.length, 1, `实际起了 ${calls.length} 次`);
  });
}

// ---- 2. 没答但也没报错：照旧重试一次，重试还不行才算失败 ------------------------
{
  const session = "s-silent";
  const before = JSON.parse(fs.readFileSync(callsFile, "utf8")).length;
  const runId = start(session);
  await runWorker(runId, "silent");
  const run = await waitRun(session, runId);
  const calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));

  check("沉默无答：重试一次（两回子进程）", () => {
    assert.equal(calls.length - before, 2, `实际起了 ${calls.length - before} 次`);
  });
  check("沉默无答：仍然算失败，文案不留「输出 N 行」当结论", () => {
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "child_no_output");
    assert.match(run.error, /没有给出结论/);
  });
}

// ---- 3. 正常作答：仍然 done（别把好路改坏） -----------------------------------
{
  const session = "s-ok";
  const runId = start(session);
  await runWorker(runId, "ok");
  const run = await waitRun(session, runId);
  check("正常作答：done，没有错误", () => {
    assert.equal(run.status, "done");
    assert.equal(run.error, "");
    assert.ok(run.tokens > 0, "用量要记下来");
  });
}

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
