#!/usr/bin/env node
/**
 * 换脑（热部署只换脑）不能打断正在跑的代码评审（D441 的验收缝）。
 *
 * 现场：评审以前跑在脑里，`switchTo()` 让老脑 exit，正在跑的 OCR / pi 子进程和内存里的
 * findings 一起没了；新脑开机再把记录标成「桥重启了」。现在评审交给 detached worker，
 * 脑只转发进度；这个用例让一次真评审（假 pi + 假 ocr + 真 git 仓库）跨过一次真换脑。
 *
 * 断言：
 *   1. 评审的 worker 不是脑的子进程（换脑前后 pid 不变、还活着）；
 *   2. 换脑后的新脑能从 `review/jobs/` 接回这条进度（`review.get` 的 progresses 里有它）；
 *   3. 评审最终跑到 done，落盘的不是 `bridge-restart` / `worker-lost`；
 *   4. 整组停机时 worker 被收掉，不留在后台。
 *
 * 跑之前先 `npm run build:bridge`。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HOST = path.join(ROOT, "bridge", "dist", "host.js");
const BRAIN = path.join(ROOT, "bridge", "dist", "index.js");
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-swap-")));
const STATE = path.join(TMP, "state");
const REPO = path.join(TMP, "repo");
const BIN = path.join(TMP, "bin");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [HOST, BRAIN]) {
  if (!fs.existsSync(f)) throw new Error(`缺少 ${f} —— 先 npm run build:bridge`);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  for (const line of String(kids.stdout ?? "").split(/\s+/)) if (line) killTree(Number(line));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经没了 */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function until(fn, what, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
    await sleep(100);
  }
}

const git = (args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 一个真仓库 + 一处工作区改动：workspace 模式不需要远端，OCR 的 preview 由假 ocr 给。
fs.mkdirSync(REPO, { recursive: true });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
fs.writeFileSync(path.join(REPO, "demo.txt"), "base\n");
git(["add", "."]);
git(["commit", "-q", "-m", "base"]);
fs.writeFileSync(path.join(REPO, "demo.txt"), "base\nchanged\n");

// 假 ocr：preview 说有一个文件可评，rule 空着（规则只是加分项）。放在 PATH 里走生产那条调用路径
// （Windows 是 `cmd.exe /c ocr`，POSIX 是直接 `ocr`），不给测试专门开第二条分支。
fs.mkdirSync(BIN, { recursive: true });
const fakeOcr = path.join(TMP, "fake-ocr.mjs");
fs.writeFileSync(
  fakeOcr,
  [
    "const args = process.argv.slice(2);",
    'if (args.includes("preview")) {',
    '  process.stdout.write(JSON.stringify({ mode: "workspace", files: [{ path: "demo.txt", status: "modified", insertions: 1, deletions: 0 }], excluded_files: [] }));',
    "} else if (args.includes(\"rule\")) {",
    "  process.stdout.write(\"\");",
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

// 假 pi：先吐一行 tool 事件（让进度真的动起来），等一会儿再交一份空 findings。
// 延迟要长过「换脑观察 + 老脑退出 + 新脑接管」，否则换完脑评审已经结束了，断言不到接回。
const fakePi = path.join(TMP, "fake-pi.mjs");
fs.writeFileSync(
  fakePi,
  [
    "process.stdin.resume();",
    'process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "demo.txt" } }) + "\\n");',
    "const delay = Number(process.env.FAKE_PI_DELAY_MS || 12000);",
    "setTimeout(() => {",
    '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: \'{"findings":[],"skipped":[]}\' }], usage: { totalTokens: 7 } } }) + "\\n");',
    "  setTimeout(() => process.exit(0), 80);",
    "}, delay);",
  ].join("\n"),
);

// 口令 test（跟测试环境同一招）：先让脑用临时 state 写一次。
execFileSync(process.execPath, [BRAIN, "--passphrase", "test"], {
  env: { ...process.env, PI_WEB_STATE: STATE, PI_WEB_WHATS_NEW: "0" },
  stdio: "ignore",
  timeout: 30000,
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const origins = { origin: base, "sec-fetch-site": "same-origin" };
const logs = [];
const host = spawn(process.execPath, [HOST], {
  env: {
    ...process.env,
    PI_WEB_PORT: String(port),
    PI_WEB_STATE: STATE,
    PI_WEB_OPEN: "0",
    PI_WEB_WHATS_NEW: "0",
    PI_HOST_OBSERVE_MS: "600",
    PI_BIN: fakePi,
    PI_WEB_GH_JS: path.join(ROOT, "bridge", "tests", "fixtures", "fake-gh.mjs"),
    FAKE_GH_ACCOUNTS: JSON.stringify([{ login: "Yang-Code01", active: true }]),
    FAKE_PI_DELAY_MS: "12000",
    PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.on("data", (c) => logs.push(String(c)));
host.stderr.on("data", (c) => logs.push(String(c)));
let exitCode = null;
let exitSignal = null;
host.on("exit", (code, signal) => {
  exitCode = code ?? -1;
  exitSignal = signal;
});

const getJson = async (p) => (await fetch(base + p)).json();
const post = async (p, extraHeaders = {}, body = {}) => {
  const res = await fetch(base + p, { method: "POST", headers: { ...origins, ...extraHeaders }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function connectWs(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  const seen = [];
  ws.on("message", (buf) => {
    try {
      seen.push(JSON.parse(buf.toString()));
    } catch {
      /* 不是 JSON 就跳过 */
    }
  });
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const waitFor = async (pred, what, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = seen.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
      await sleep(80);
    }
  };
  return { ws, seen, waitFor };
}

const jobFile = (runId) => path.join(STATE, "review", "jobs", `${runId}.json`);
const jobPid = (runId) => {
  try {
    return Number(JSON.parse(fs.readFileSync(jobFile(runId), "utf8")).pid) || 0;
  } catch {
    return 0;
  }
};
const runOf = (state, runId) => state?.runs?.find((r) => r.id === runId) ?? null;

let workerPid = 0;
try {
  await until(async () => {
    try {
      return (await getJson("/healthz")).brain?.ready;
    } catch {
      return false;
    }
  }, "真脑在壳后面就绪");
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "test" }),
  });
  assert.equal(login.status, 200, "口令 test 应该能登进来");
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  const page = await connectWs(cookie);
  await page.waitFor((m) => m.type === "hello", "ws hello");
  const session = "review-swap-e2e";
  page.ws.send(JSON.stringify({ type: "review.run", dir: REPO, sessionId: session, mode: "workspace", lang: "zh", model: "fake-review" }));
  const started = await page.waitFor((m) => m.type === "review.started", "评审开跑");
  const runId = started.runId;
  assert.ok(runId, "review.started 要带 runId");

  // 1. worker 是独立进程：job 文件里有 pid，而且不是脑的 pid。
  const brainBefore = (await getJson("/api/host/status")).brain;
  workerPid = await until(() => jobPid(runId), "worker 的 job 文件落盘");
  assert.ok(workerPid > 0, "job 文件里要写 worker pid");
  assert.notEqual(workerPid, brainBefore.pid, "评审必须跑在独立进程里，不是脑自己");
  assert.ok(alive(workerPid), "评审 worker 应该正在跑");
  const before = page.seen.find((m) => m.type === "review.progress" && m.runId === runId);
  assert.ok(before, "页面应该已经收到这条评审的进度");

  // 2. 换脑：只换脑，不碰 worker。
  const swapped = await post("/api/host/deploy?action=swap");
  assert.equal(swapped.status, 200, "swap 接口应该放行");
  const brainAfter = await until(async () => {
    const b = (await getJson("/api/host/status")).brain;
    return b?.ready && b.pid !== brainBefore.pid ? b : null;
  }, "新一代脑接管");
  assert.notEqual(brainAfter.pid, brainBefore.pid, "脑必须换了");
  assert.ok(alive(workerPid), "换脑之后评审 worker 必须还活着");

  // 3. 新脑接回这条评审：review.get 的 progresses 里要有它（不是从上一代脑继承的，是 job 文件）。
  const page2 = await connectWs(cookie);
  await page2.waitFor((m) => m.type === "hello", "换脑后重连的 hello");
  page2.ws.send(JSON.stringify({ type: "review.get", dir: REPO, sessionId: session }));
  const resumed = await until(
    () => page2.seen.find((m) => m.type === "review.state" && m.sessionId === session && m.state?.runs?.some((r) => r.id === runId)),
    "新脑回一份 review.state",
  );
  assert.ok(
    (resumed.progresses ?? []).some((p) => p.runId === runId),
    "新脑必须从 review/jobs 接回正在跑的这条（progresses 里有它）",
  );

  // 4. 评审自己跑完：状态是 done，不是 bridge-restart / worker-lost。
  const done = await until(async () => {
    page2.ws.send(JSON.stringify({ type: "review.get", dir: REPO, sessionId: session }));
    await sleep(150);
    const frames = page2.seen.filter((m) => m.type === "review.state" && m.sessionId === session);
    const run = runOf(frames.at(-1)?.state, runId);
    return run?.status === "done" ? run : null;
  }, "评审跑完（done）", 40000);
  assert.equal(done.errorCode ?? "", "", "换脑不该让评审报 bridge-restart / worker-lost");
  assert.equal(done.totalFiles, 1, "假 ocr 给了一个文件");
  await until(() => !alive(workerPid), "评审 worker 收尾退出", 10000);
  await until(() => !fs.existsSync(jobFile(runId)), "job 文件被收掉", 10000);

  // 5. 整组停机：先开一条新的（慢的）评审，再停桥，worker 必须跟着走，不许留到后台。
  page2.ws.send(JSON.stringify({ type: "review.run", dir: REPO, sessionId: session, mode: "workspace", lang: "zh", model: "fake-review" }));
  const started2 = await page2.waitFor((m) => m.type === "review.started" && m.runId !== runId, "第二条评审开跑");
  const pid2 = await until(() => jobPid(started2.runId), "第二条的 worker 起来");
  assert.ok(alive(pid2), "第二条 worker 应该正在跑");
  const stopped = await post("/api/host/stop");
  assert.equal(stopped.status, 200, "停机接口应该放行");
  await until(async () => exitCode !== null, "壳退出", 15000);
  assert.equal(exitCode, 0, exitSignal ? `主动停机被信号 ${exitSignal} 终止` : "主动停机应该是 0");
  await until(() => !alive(pid2), "停机时评审 worker 被收掉", 10000);
  console.log("review-worker-e2e: ok");
} catch (err) {
  console.error(String(err?.stack ?? err));
  console.error(`--- host 日志 ---\n${logs.join("").slice(-6000)}`);
  process.exitCode = 1;
} finally {
  if (workerPid && alive(workerPid)) {
    try {
      killTree(workerPid);
    } catch {
      /* ignore */
    }
  }
  if (exitCode === null) {
    killTree(host.pid);
    await Promise.race([new Promise((r) => host.once("exit", r)), sleep(5000)]);
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
