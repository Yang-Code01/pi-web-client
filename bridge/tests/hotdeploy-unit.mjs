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
import { buildBranchRows, parseRefLines, parseTrack, parseWorktrees, tailLines } from "../src/hotdeploy.ts";
import { DEFAULT_HOTDEPLOY_PROXY, FETCH_ATTEMPTS, FETCH_DIRECT_TIMEOUT_MS, FETCH_PROXY_TIMEOUT_MS, FETCH_RETRY_DELAY_MS, FETCH_TOTAL_BUDGET_MS, parseScutilProxy, parseWindowsProxyServer, proxyCandidates } from "../../scripts/hotdeploy-git.mjs";

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

// D375：只看 env 等于只试写死的那个端口 —— bridge 是手起的，env 里常常什么都没有。
assert.deepEqual(
  proxyCandidates({}, { httpProxy: "127.0.0.1:7899", system: ["http://127.0.0.1:7899"] }),
  ["http://127.0.0.1:7899", DEFAULT_PROXY],
  "pi 设置排在最前，同一代理只留一次",
);
assert.deepEqual(
  proxyCandidates(
    { HTTPS_PROXY: "http://127.0.0.1:1087" },
    { httpProxy: "http://127.0.0.1:7899", system: ["http://127.0.0.1:7890"] },
  ),
  ["http://127.0.0.1:7899", "http://127.0.0.1:7890", "http://127.0.0.1:1087", DEFAULT_PROXY],
  "顺序：pi 设置 → 系统代理 → env → 默认",
);
assert.deepEqual(proxyCandidates({}, { httpProxy: "  ", system: [] }), [DEFAULT_PROXY], "设置里是空的就当没填");

// 系统代理的两种写法（只解文本，不去碰真注册表）
assert.deepEqual(parseWindowsProxyServer("127.0.0.1:7899"), ["http://127.0.0.1:7899"], "一个地址时所有协议共用");
assert.deepEqual(
  parseWindowsProxyServer("http=127.0.0.1:7899;https=127.0.0.1:7900"),
  ["http://127.0.0.1:7899", "http://127.0.0.1:7900"],
  "分协议写法：CONNECT 代理本身走 http",
);
assert.deepEqual(parseWindowsProxyServer(""), [], "空值不算候选");
assert.deepEqual(
  parseScutilProxy("HTTPProxy : 127.0.0.1\nHTTPPort : 7899\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7899\nSOCKSEnable : 0\n"),
  ["http://127.0.0.1:7899"],
  "scutil 的 HTTP/HTTPS 合并去重",
);
assert.deepEqual(parseScutilProxy("ProxyAutoConfigEnable : 1\n"), [], "PAC 自动脚本拿不到具体地址，不猜");

// ------------------------------------------------- ④ fetch 每次尝试都有上限（D374）

assert.ok(
  Number.isInteger(FETCH_DIRECT_TIMEOUT_MS) && FETCH_DIRECT_TIMEOUT_MS >= 5_000 && FETCH_DIRECT_TIMEOUT_MS <= 60_000,
  `直连上限要在 5~60s 之间，现在是 ${FETCH_DIRECT_TIMEOUT_MS}`,
);
assert.ok(
  Number.isInteger(FETCH_PROXY_TIMEOUT_MS) && FETCH_PROXY_TIMEOUT_MS > FETCH_DIRECT_TIMEOUT_MS,
  `代理上限要比直连长，现在是 ${FETCH_PROXY_TIMEOUT_MS}`,
);

const workerSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", "hotdeploy.mjs"), "utf8");
// 直连与代理那两次 fetch 各是一条 git([... "fetch" ...], env, { timeout: budget(FETCH_*_TIMEOUT_MS) })；解析到本条语句结束为止。
const fetchCalls = [...workerSrc.matchAll(/git\(\s*\[[^\]]*"fetch"[^\]]*\]/g)].map((m) =>
  workerSrc.slice(m.index, workerSrc.indexOf(");", m.index) + 2),
);
assert.equal(fetchCalls.length, 2, "worker 里只有直连与代理两次 fetch");
for (const call of fetchCalls) {
  assert.ok(
    /timeout: [^\n]*FETCH_(DIRECT|PROXY)_TIMEOUT_MS/.test(call),
    `fetch 调用没带上限（直连被墙时会坐满 300s）：${call.slice(0, 120)}`,
  );
  assert.ok(/timeout: budget\(/.test(call), `fetch 的上限要经过总预算（D375），否则候选一多又回到五分钟：${call.slice(0, 120)}`);
}

// ------------------------------------------------- ⑥ 失败后重试一轮，但总时长有预算（D375）

assert.equal(FETCH_ATTEMPTS, 2, "所有候选都不通时只再试一轮，不无限重试");
assert.ok(
  Number.isInteger(FETCH_RETRY_DELAY_MS) && FETCH_RETRY_DELAY_MS >= 1_000 && FETCH_RETRY_DELAY_MS <= 10_000,
  `重试前的等待要在 1~10s 之间（网络抖动几秒就好的量级），现在是 ${FETCH_RETRY_DELAY_MS}`,
);
assert.ok(
  Number.isInteger(FETCH_TOTAL_BUDGET_MS) && FETCH_TOTAL_BUDGET_MS >= 60_000 && FETCH_TOTAL_BUDGET_MS <= 300_000,
  `所有尝试合计的上限要在 1~5 分钟之间，现在是 ${FETCH_TOTAL_BUDGET_MS}`,
);
assert.ok(
  FETCH_TOTAL_BUDGET_MS < 2 * (FETCH_DIRECT_TIMEOUT_MS + 3 * FETCH_PROXY_TIMEOUT_MS),
  "三个代理候选时总预算必须真的能截住两轮",
);
assert.ok(/resolveProxyCandidates\(\)/.test(workerSrc), "worker 要读 pi 设置与系统代理，不能只看 env（D375）");
assert.ok(/for \(let attempt = 1; attempt <= FETCH_ATTEMPTS/.test(workerSrc), "fetch 要有「再试一轮」的循环");
assert.ok(/sleepSync\(FETCH_RETRY_DELAY_MS\)/.test(workerSrc), "重试间隔要用同步等待（worker 是同步流程）");

// ------------------------------------------------- 不闪窗：worker 无控制台，每个子进程都要 windowsHide

for (const name of ["hotdeploy.mjs", "hotdeploy-git.mjs", "hotdeploy-window.mjs"]) {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "scripts", name), "utf8");
  // 每一处 spawnSync( 调用，往后看到本条语句结束（下一个 ");"）为止，必须带 windowsHide 或走 sh()。
  for (const m of src.matchAll(/spawnSync\(/g)) {
    const stmt = src.slice(m.index, src.indexOf(");", m.index) + 2);
    if (/^spawnSync\("npm", \["run", "build"\]/.test(stmt)) continue; // 非 Windows 分支
    assert.ok(stmt.includes("windowsHide"), `${name} 里的 spawnSync 没带 windowsHide：${stmt.slice(0, 80)}`);
  }
}

console.log("hotdeploy-unit: ok");
