/**
 * 热部署：桥端纯函数的单测 —— 不跑 git、不碰真进程。
 *
 *   node bridge/tests/hotdeploy-unit.mjs
 *
 * 和 sysmanage-unit 一样靠类型擦除直跑 src/*.ts，不加 --experimental-transform-types。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBranchRows, parseRefLines, parseTrack, parseWorktrees, tailLines } from "../src/hotdeploy.ts";
import { DEFAULT_HOTDEPLOY_PROXY, proxyCandidates } from "../../scripts/hotdeploy-git.mjs";

const TAB = String.fromCharCode(9);

// ------------------------------------------------- ① worktree 列表

const porcelain = [
  "worktree F:/repo",
  "HEAD abc1234",
  "branch refs/heads/main",
  "",
  "worktree F:/repo-wt/feat-a",
  "HEAD aaa1111",
  "branch refs/heads/feat/a",
  "",
  "worktree F:/repo-wt/detached",
  "HEAD ddd2222",
  "detached",
  "",
].join("\n");

const wts = parseWorktrees(porcelain);
assert.equal(wts.length, 3, "三块 worktree");
assert.deepEqual(wts[0], { path: "F:/repo", branch: "main", detached: false });
assert.equal(wts[1].branch, "feat/a", "refs/heads/ 前缀要去掉");
assert.equal(wts[2].branch, null);
assert.equal(wts[2].detached, true, "detached 要认出来");

// ------------------------------------------------- ② upstream track

assert.deepEqual(parseTrack("[ahead 2, behind 3]"), { ahead: 2, behind: 3, gone: false });
assert.deepEqual(parseTrack("[ahead 1]"), { ahead: 1, behind: 0, gone: false });
assert.deepEqual(parseTrack("[behind 7]"), { ahead: 0, behind: 7, gone: false });
assert.equal(parseTrack("[gone]").gone, true, "上游被删了要标 gone");
assert.deepEqual(parseTrack(""), { ahead: 0, behind: 0, gone: false });

// ------------------------------------------------- ③ for-each-ref 行

const refsOut = [
  [`refs/heads/main`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/heads/feat/a`, "aaa1111", "[ahead 2]", "2026-02-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/HEAD`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/main`, "abc1234", "", "2026-01-01T00:00:00+08:00"].join(TAB),
  [`refs/remotes/origin/feat/only`, "bbb2222", "", "2025-12-01T00:00:00+08:00"].join(TAB),
  "",
].join("\n");

const refs = parseRefLines(refsOut);
assert.equal(refs.length, 4, "origin/HEAD 不算一条分支");
assert.deepEqual(
  refs.map((r) => `${r.remote ? "R" : "L"}:${r.name}`),
  ["L:main", "L:feat/a", "R:main", "R:feat/only"],
  "refs/heads 与 refs/remotes/origin 都要去掉前缀",
);

// ------------------------------------------------- ④ 分支行：本地在前、占用的标出来

const rows = buildBranchRows(refs, wts, "main", "F:/repo");
assert.deepEqual(
  rows.map((r) => r.name),
  ["main", "feat/a", "feat/only"],
  "本地在前、当前分支排最前、只在远端的补在后面",
);
const main = rows[0];
assert.equal(main.current, true);
assert.equal(main.occupiedBy, null, "自己所在的 worktree 不算占用");
const featA = rows[1];
assert.equal(featA.occupiedBy, "F:/repo-wt/feat-a", "被别的 worktree 检出要带上路径");
assert.equal(featA.ahead, 2);
assert.equal(featA.remoteOnly, false);
const only = rows[2];
assert.equal(only.remoteOnly, true);
assert.equal(only.sha, "bbb2222");

// 路径大小写 / 分隔符不同也算同一份主检出
const winRows = buildBranchRows(parseRefLines(refsOut), parseWorktrees(porcelain.replace("F:/repo-wt/feat-a", "f:\\repo-wt\\feat-a")), "main", "F:/repo");
assert.equal(winRows[1].occupiedBy, "f:\\repo-wt\\feat-a");

// ------------------------------------------------- ⑤ 日志尾

const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hotdeploy-")), "worker.log");
fs.writeFileSync(log, "one\ntwo\nthree\nfour\n");
assert.deepEqual(tailLines(log, 2), ["three", "four"], "只要末尾 N 行");
assert.deepEqual(tailLines(path.join(path.dirname(log), "nope.log"), 5), [], "没有日志就是空的，不炸");

// ------------------------------------------------- ⑥ 热部署 fetch 的代理候选

const DEFAULT_PROXY = DEFAULT_HOTDEPLOY_PROXY;
assert.deepEqual(
  proxyCandidates({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:7899", HTTPS_PROXY: "http://127.0.0.1:7899" }),
  ["http://127.0.0.1:7899", DEFAULT_PROXY],
  "显式代理优先，重复值只留一次，默认代理兜底",
);
assert.deepEqual(
  proxyCandidates({ HTTPS_PROXY: " http://127.0.0.1:7899 ", HTTP_PROXY: "http://127.0.0.1:7899" }),
  ["http://127.0.0.1:7899", DEFAULT_PROXY],
  "环境代理去空白后去重",
);
assert.deepEqual(
  proxyCandidates({ HTTPS_PROXY: "HTTP://127.0.0.1:7899/", HTTP_PROXY: "http://127.0.0.1:7899" }),
  ["http://127.0.0.1:7899", DEFAULT_PROXY],
  "代理 URL 正规化后去重",
);
assert.deepEqual(proxyCandidates({}), [DEFAULT_PROXY], "没有环境代理时仍尝试历史默认端口");
assert.deepEqual(
  proxyCandidates({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:7899", ALL_PROXY: "socks5://127.0.0.1:1080" }),
  ["http://127.0.0.1:7899", "socks5://127.0.0.1:1080", DEFAULT_PROXY],
  "ALL_PROXY 排在 HTTP(S)_PROXY 之后",
);

console.log("hotdeploy-unit: ok");

// ------------------------------------------------- ⑦ 每个 spawn 都必须 windowsHide（D312）

/*
 * 热部署的 worker 是被 detached 起的（bridge/src/hotdeploy.ts 的 startRun），
 * 在 Windows 上这个进程没有控制台。从这种进程里 spawn 控制台程序，CreateProcess
 * 会给每个子进程新分配一扇可见终端窗口（一次部署 20 扇，还抢焦点）。
 * windowsHide 只作用于直接子进程、不会往下继承，所以每个 spawn 都得自己带。
 *
 * 这条测试是静态扫描：新写一个漏了 windowsHide 的 spawn，这里就红。
 * 唯一允许「不隐藏」的是 Start-Process —— 那扇是 D154 要人看着的桥窗口，由 powershell 自己开，
 * 不走这几条 spawn 路径，所以下面另外断言它还在。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SPAWN_FILES = [
  "scripts/hotdeploy.mjs",
  "scripts/hotdeploy-git.mjs",
  "scripts/build.mjs",
  "bridge/src/hotdeploy.ts",
  ".pi/skills/bridge-update/bin/restart.mjs",
];

/** 抓出每个 spawn 系列调用（括号配对，跳过字符串里的括号）。 */
function spawnCalls(src) {
  const calls = [];
  for (const name of ["spawnSync", "spawn", "execFileSync", "execFile"]) {
    const re = new RegExp("(?<![\\w.$])" + name + "\\(", "g");
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + name.length + 1;
      let depth = 1;
      let quote = null;
      let i = start;
      for (; i < src.length && depth > 0; i += 1) {
        const c = src[i];
        if (quote) {
          if (c === "\\") i += 1;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
      }
      calls.push({ name, line: src.slice(0, m.index).split(/\r?\n/).length, text: src.slice(m.index, i) });
    }
  }
  return calls;
}

for (const rel of SPAWN_FILES) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const calls = spawnCalls(src);
  assert.ok(calls.length > 0, `${rel}：一个 spawn 都没扫到，扫描器自己坏了`);
  for (const call of calls) {
    assert.ok(
      call.text.includes("windowsHide"),
      `${rel}:${call.line} 的 ${call.name}() 少了 windowsHide —— Windows 上会多一扇终端窗口（D312）`,
    );
  }
}

// 桥那扇窗口必须继续由 Start-Process 开：改成直接 spawn 就没人看得见它在跑、也没法关窗即停（D154）。
for (const rel of ["scripts/hotdeploy.mjs", ".pi/skills/bridge-update/bin/restart.mjs"]) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  assert.ok(src.includes("Start-Process powershell"), `${rel}：可见的桥窗口应当继续由 Start-Process 打开`);
}

console.log("hotdeploy-unit: ok（含 D312 的 windowsHide 扫描）");
