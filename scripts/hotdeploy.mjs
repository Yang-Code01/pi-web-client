#!/usr/bin/env node
/**
 * 热部署的 worker：切到指定分支 → 编译 → 换掉正在跑的那颗 bridge。
 *
 *   node scripts/hotdeploy.mjs --dir <repo> --branch <branch> [--port 7864]
 *
 * 必须由桥 **detached** 起（桥马上要被它杀掉）。进度写 `<repo>/.scratch/hot-deploy/state.json`，
 * 页面轮询的就是这个文件；结束写 last-run.json。
 *
 * 结论沿用 D154：先 build 后杀进程（build 失败时旧服务原样活着）、只按 pid 杀不 taskkill /T、
 * 新进程开可见 PowerShell 窗口（关窗即停）；旧桥已经在这扇窗口的循环里时复用它，不再另开（D326）。
 * worker 自己没有控制台（detached），它起的每个子进程都必须 windowsHide，否则一次一闪。
 * D268 起支持 --stash：只暂存当前分支，构建用
 * 分支已提交内容，换进程前恢复；不 reset / 不 rebase。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FETCH_ATTEMPTS, FETCH_DIRECT_TIMEOUT_MS, FETCH_PROXY_TIMEOUT_MS, FETCH_RETRY_DELAY_MS, FETCH_SSH_TIMEOUT_MS, FETCH_TOTAL_BUDGET_MS, resolveProxyCandidates, ssh443InsteadOf, stashPush, stashRestore } from "./hotdeploy-git.mjs";
import { bridgeEntry, isShellEntry } from "./bridge-entry.mjs";
import { psQuote, windowHostOf, windowScript } from "./hotdeploy-window.mjs";

const WIN = process.platform === "win32";

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const REPO = path.resolve(argOf("--dir", path.resolve(import.meta.dirname, "..")));
const BRANCH = argOf("--branch", "");
const PORT = Number(argOf("--port", process.env.PI_WEB_PORT || 7864));
const STASH = process.argv.includes("--stash");
/** full = 老路子（自己杀桥、自己起进程）；brain = 只拉代码 + 编译，换脑交给壳（#634）。 */
const MODE = argOf("--mode", "full");
/** 与前端 STEPS 里的「恢复本地改动」一致。 */
const RESTORE_STEP = 3;
// 拉起来的子进程必须落在我们盯着的端口上，否则它去抢 7864，我们永远等不到自己那个端口。
process.env.PI_WEB_PORT = String(PORT);

const WORK = path.join(REPO, ".scratch", "hot-deploy");
const LOG = path.join(WORK, "worker.log");
const STATE = path.join(WORK, "state.json");
const LAST = path.join(WORK, "last-run.json");
const LOCK = path.join(WORK, "lock");
const LIVE = path.join(WORK, "bridge-live.log");
/** 循环窗口脚本：node 退出后看到 RELAUNCH 标记就在同一扇窗口里再起一次。文件名带端口，多开互不干扰。 */
const WINDOW_SCRIPT = path.join(WORK, `bridge-window-${PORT}.ps1`);
const RELAUNCH = path.join(WORK, `relaunch-${PORT}`);

const startedAt = new Date().toISOString();
const state = {
  pid: process.pid,
  branch: BRANCH,
  step: 0,
  phase: "running",
  startedAt,
  finishedAt: null,
  fromBranch: "",
  fromSha: "",
  toSha: "",
  buildId: "",
  exitCode: null,
  error: null,
  port: PORT,
  stash: "",
  stashRestored: false,
  stamps: [],
};
let lockOwned = false;
let oldPid = null;
let newPid = null;

function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}`;
  try {
    fs.mkdirSync(WORK, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5 * 1024 * 1024) fs.writeFileSync(LOG, "");
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {}
  // 桥起 worker 时把 stdout/stderr 都指到 worker.log 上了；再 console.log 就是每行两份。
  if (process.stdout.isTTY) {
    try {
      console.log(line);
    } catch {}
  }
}

function writeState(patch = {}) {
  if (typeof patch.step === "number" && state.stamps[state.stamps.length - 1]?.step !== patch.step) {
    state.stamps.push({ step: patch.step, at: Date.now() });
  }
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${STATE}.tmp`, STATE);
  } catch (e) {
    log("写 state.json 失败：", e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** `fetchOrigin()` 是同步流程，重试间隔不能靠 setTimeout。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sh(file, args, opts = {}) {
  // windowsHide：worker 是 detached 起的（无控制台），不带它每个 git / powershell / taskkill 都会弹一扇窗再关掉。
  return spawnSync(file, args, { cwd: REPO, encoding: "utf8", windowsHide: true, ...opts });
}

/** `env` 为 undefined 时不动环境；`opts` 目前只用来传 `timeout`（D375）。 */
function git(args, env, opts = {}) {
  return sh("git", args, { ...(env ? { env } : {}), ...opts });
}

/** 真直连：去掉进程里的代理变量，并显式清空 git 的 http.proxy；否则残留的 HTTPS_PROXY 仍会被 libcurl 使用。 */
function proxyFreeEnv() {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "GIT_PROXY_COMMAND"]) delete env[key];
  // worker 没有控制台：谁要凭据就会卡到超时，直接让它失败。
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** 走代理时保留 env（libcurl 要读），但同样不允许停下来问凭据。 */
function proxyEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/** SSH 443 那条路：绝不留代理变量（它就是绕开 HTTPS 的），也不能让 ssh 停下来问密码或主机指纹。 */
function sshEnv() {
  const env = proxyFreeEnv();
  env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new";
  return env;
}

/** `spawnSync` 超时时 stderr 是空的，只剩 `error.code` —— 不翻译的话用户只看到一句 spawnSync git ETIMEDOUT。 */
function gitReason(result, timeoutMs = 0) {
  if (result?.error?.code === "ETIMEDOUT") return `超过 ${Math.round(timeoutMs / 1000)}s 没连上`;
  return String(result.stderr || result.stdout || result.error?.message || "无输出").trim().slice(0, 300);
}

function changedFiles() {
  const dirty = String(git(["status", "--porcelain", "--untracked-files=normal"]).stdout ?? "").trim();
  return dirty ? dirty.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean) : [];
}

function changedLabel(files) {
  return `${files.slice(0, 5).join("、")}${files.length > 5 ? "…" : ""}`;
}

function alive(pid) {
  if (!pid) return false;
  if (!WIN) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const r = sh("powershell", ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`]);
  return String(r.stdout || "").trim() === "yes";
}

function childrenOf(pid) {
  if (!WIN) {
    const r = sh("bash", ["-lc", `pgrep -P ${pid} 2>/dev/null || true`]);
    return String(r.stdout || "").split(/\s+/).map(Number).filter((n) => n > 0);
  }
  const r = sh("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | % { $_.ProcessId }`]);
  return String(r.stdout || "").split(/\s+/).map(Number).filter((n) => n > 0);
}

function looksLikeBridge(pid) {
  if (!pid || !alive(pid)) return false;
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).CommandLine`,
    ]);
    return String(r.stdout || "").split(String.fromCharCode(92)).join("/").includes("bridge/dist/index.js");
  }
  const r = sh("bash", ["-lc", `ps -p ${pid} -o command= 2>/dev/null || true`]);
  return /bridge\/dist\/index\.js/.test(String(r.stdout || ""));
}

function pidFromFile(port) {
  try {
    const n = Number(fs.readFileSync(path.join(os.tmpdir(), `pi-web-bridge-${port}.pid`), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 找出在服务这个端口的那颗 bridge：/healthz 自己报的 pid 最可靠，pid 文件兜底。 */
async function portPid() {
  const h = await health();
  if (h && Number.isInteger(h.pid) && looksLikeBridge(h.pid)) return h.pid;
  const declared = pidFromFile(PORT);
  if (looksLikeBridge(declared)) return declared;
  return null;
}

function killPid(pid) {
  // 绝不用 taskkill /T：一棵树里还有会话子进程，/T 会把 worker 自己带下去。
  if (WIN) return sh("taskkill", ["/PID", String(pid), "/F"]);
  return sh("kill", ["-TERM", String(pid)]);
}

function truncateLive() {
  try {
    if (fs.existsSync(LIVE) && fs.statSync(LIVE).size > 5 * 1024 * 1024) fs.writeFileSync(LIVE, "");
  } catch {}
}

/** 等循环窗口把 RELAUNCH 标记收走（= 它已经在起新桥）。 */
async function relaunchTaken(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!fs.existsSync(RELAUNCH)) return true;
    await sleep(150);
  }
  return !fs.existsSync(RELAUNCH);
}

/** 开一扇新的可见窗口跑循环脚本：人能看到输出，关窗即停（D154）。 */
function startBridge() {
  truncateLive();
  const entry = bridgeEntry(REPO);
  // PowerShell 5.1 认反斜杠；非 Windows 直接跑 node，用原生路径即可。
  const scriptEntry = WIN ? entry.split("/").join("\\") : entry;
  fs.writeFileSync(WINDOW_SCRIPT, windowScript({ repo: REPO, port: PORT, node: process.execPath, live: LIVE, relaunch: RELAUNCH, entry: scriptEntry }));
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `Start-Process powershell -ArgumentList ${psQuote(`-NoProfile -ExecutionPolicy Bypass -File "${WINDOW_SCRIPT}"`)} -WorkingDirectory ${psQuote(REPO)}`,
    ]);
    if (r.status !== 0) log("Start-Process 失败：", String(r.stderr || "").trim().slice(0, 400));
    return;
  }
  const out = fs.openSync(LIVE, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: REPO,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  newPid = child.pid ?? null;
}

function takeLock() {
  try {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: startedAt }), { flag: "wx" });
    lockOwned = true;
    return true;
  } catch {
    return false;
  }
}

function lockFresh() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    return Number.isInteger(held?.pid) && held.pid !== process.pid && alive(held.pid);
  } catch {
    return false;
  }
}

function finish(result, extra = {}) {
  const phase = result === "ok" ? "ok" : "fail";
  writeState({ phase, finishedAt: new Date().toISOString(), ...extra });
  const payload = {
    at: startedAt,
    finishedAt: new Date().toISOString(),
    result,
    branch: BRANCH,
    fromBranch: state.fromBranch,
    fromSha: state.fromSha,
    toSha: state.toSha,
    buildId: state.buildId,
    step: state.step,
    exitCode: state.exitCode,
    oldPid,
    newPid,
    error: state.error ?? null,
    stash: state.stash || null,
    stashRestored: state.stashRestored,
    log: LOG,
  };
  try {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(LAST, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {}
  log(`=== ${result} ===`, state.error ? String(state.error).slice(0, 600) : "");
  try {
    if (lockOwned) fs.rmSync(LOCK, { force: true });
  } catch {}
  process.exit(result === "ok" ? 0 : 1);
}

function fail(step, result, code, message) {
  finish(result, { step, exitCode: code, error: message });
}

/** 失败时若还留着本轮 stash，先尝试恢复；恢复失败要把 stash message 留在 error 里。 */
function failAfterStash(step, result, code, message) {
  let finalMessage = message;
  if (state.stash && !state.stashRestored) {
    const restored = stashRestore(REPO, state.stash);
    if (restored.ok) {
      state.stashRestored = true;
      finalMessage = `${message}\n（本地改动已恢复到工作区）`;
    } else {
      finalMessage = `${message}\n本地改动恢复失败（stash: ${state.stash}）：${restored.why}`;
    }
  }
  fail(step, result, code, finalMessage);
}

/**
 * 本机 GitHub 直连常不通：按 AGENTS.md，失败才按需带代理，不写进全局 config。
 *
 * 候选不能只看 env：worker 的 env 通常是空的（bridge 是手起的），只看 env 等于只试那个写死的
 * 18791 —— 它现在多数机器上都不在监听。所以先读 pi 设置里的 httpProxy，再读系统代理（D376）。
 */
/** 直连：清掉代理变量，上限见 FETCH_DIRECT_TIMEOUT_MS（D375）。 */
function fetchDirectOnce(nth, budget) {
  log(`git fetch 直连，最多等 ${FETCH_DIRECT_TIMEOUT_MS / 1000}s${nth}`);
  const result = git(
    ["-c", "http.proxy=", "-c", "https.proxy=", "fetch", "--prune", "--quiet", "origin"],
    proxyFreeEnv(),
    { timeout: budget(FETCH_DIRECT_TIMEOUT_MS) },
  );
  return result.status === 0 ? { ok: true } : { reason: gitReason(result, FETCH_DIRECT_TIMEOUT_MS) };
}

/** 走一个候选代理（D376）。 */
function fetchProxyOnce(proxy, budget) {
  const result = git(
    ["-c", `http.proxy=${proxy}`, "-c", `https.proxy=${proxy}`, "fetch", "--prune", "--quiet", "origin"],
    proxyEnv(),
    { timeout: budget(FETCH_PROXY_TIMEOUT_MS) },
  );
  return result.status === 0 ? { ok: true } : { reason: gitReason(result, FETCH_PROXY_TIMEOUT_MS) };
}

/** 换传输：SSH over 443，不接受任何代理变量（D377）。 */
function fetchSshOnce(insteadOf, budget) {
  const result = git(
    ["-c", insteadOf, "-c", "http.proxy=", "fetch", "--prune", "--quiet", "origin"],
    sshEnv(),
    { timeout: budget(FETCH_SSH_TIMEOUT_MS) },
  );
  return result.status === 0 ? { ok: true } : { reason: gitReason(result, FETCH_SSH_TIMEOUT_MS) };
}

/** 一轮：直连 → 每个候选代理 → 换传输。任一成功即返回，失败原因都记进 failures。 */
function fetchRound({ nth, proxies, insteadOf, left, budget, failures }) {
  if (left() < 1_000) return null;
  const direct = fetchDirectOnce(nth, budget);
  if (direct.ok) return direct;
  failures.push(`直连${nth}：${direct.reason}`);
  log("git fetch 直连失败，改用代理", direct.reason);
  for (const proxy of proxies) {
    if (left() < 1_000) break;
    const viaProxy = fetchProxyOnce(proxy, budget);
    if (viaProxy.ok) {
      log("git fetch 代理成功", proxy);
      return viaProxy;
    }
    failures.push(`代理 ${proxy}${nth}：${viaProxy.reason}`);
    log("git fetch 代理失败", proxy, viaProxy.reason);
  }
  // 换传输：HTTPS 被整段掉线、代理全不通时，GitHub 的 SSH 端点还常能从 443 走通（D377）。
  if (!insteadOf || left() < 1_000) return null;
  log(`git fetch 换传输 ssh.github.com:443，最多等 ${FETCH_SSH_TIMEOUT_MS / 1000}s${nth}`);
  const viaSsh = fetchSshOnce(insteadOf, budget);
  if (viaSsh.ok) {
    log("git fetch 走 SSH 443 成功");
    return viaSsh;
  }
  failures.push(`ssh.github.com:443${nth}：${viaSsh.reason}`);
  log("git fetch 走 SSH 443 失败", viaSsh.reason, /publickey/i.test(viaSsh.reason) ? "（这台机器的 SSH key 没登记到 GitHub，这条路要先加 key）" : "");
  return null;
}

/**
 * 拉取 origin。每次尝试都有上限（D375），候选不止 env（D376），全失败再试一轮，最后换传输（D377）。
 * 任何一条路径都不许等凭据、不许等满 libcurl 默认的 300s —— 界面只在「检查更新」上，卡住会被当成死机。
 */
function fetchOrigin() {
  const proxies = resolveProxyCandidates();
  log(`代理候选 ${proxies.length} 个`, proxies.join("、"));
  // 只能顶替 GitHub 的 HTTPS 远程：origin 是 SSH 或别的宿主时这条路没意义（D377）。
  const insteadOf = ssh443InsteadOf(String(git(["remote", "get-url", "origin"]).stdout ?? ""));
  const deadline = Date.now() + FETCH_TOTAL_BUDGET_MS;
  const left = () => deadline - Date.now();
  // 又要受总预算约束，否则候选一多，两轮能把「检查更新」拖回五分钟（D376）。
  const budget = (want) => Math.max(1_000, Math.min(want, left()));
  const failures = [];
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      if (left() < FETCH_RETRY_DELAY_MS + 1_000) break;
      log(`所有路径都不通，等 ${FETCH_RETRY_DELAY_MS / 1000}s 后重试一轮（第 ${attempt}/${FETCH_ATTEMPTS} 轮）`);
      sleepSync(FETCH_RETRY_DELAY_MS);
    }
    const nth = FETCH_ATTEMPTS > 1 ? `，第 ${attempt}/${FETCH_ATTEMPTS} 轮` : "";
    if (fetchRound({ nth, proxies, insteadOf, left, budget, failures })) {
      if (attempt > 1) log(`第 ${attempt} 轮通了`);
      return { ok: true };
    }
  }
  return { ok: false, err: `${failures.join("；")}；如果 bridge 启动时继承了旧代理，重启 bridge 后再试` };
}
function occupiedBy(branch) {
  const out = git(["worktree", "list", "--porcelain"]).stdout ?? "";
  let cur = "";
  for (const line of String(out).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) cur = line.slice("worktree ".length);
    else if (line.trim() === `branch refs/heads/${branch}` && path.resolve(cur).toLowerCase() !== path.resolve(REPO).toLowerCase()) {
      return cur;
    }
  }
  return "";
}

function localBranch(branch) {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

function shortHead() {
  return (git(["rev-parse", "--short", "HEAD"]).stdout ?? "").trim();
}

function distBuildId() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, "bridge", "dist", "build-id.json"), "utf8"));
    return typeof raw?.id === "string" ? raw.id : "";
  } catch {
    return "";
  }
}

function build() {
  // Node 在 Windows 上不能直接 spawn .cmd（EINVAL），整条命令过 shell；输出走日志文件，不占终端。
  const out = fs.openSync(LOG, "a");
  const opts = { stdio: ["ignore", out, out], env: process.env };
  if (WIN) opts.shell = true;
  const r = sh("npm", ["run", "build"], opts);
  fs.closeSync(out);
  if (r.error) return { code: 1, why: r.error.message };
  const code = r.status ?? 1;
  if (code !== 0) {
    const tail = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split(/\r?\n/).slice(-12).join("\n") : "";
    return { code, why: tail.slice(-1200) };
  }
  return { code: 0, why: "" };
}

async function main() {
  if (!BRANCH) fail(0, "bad-args", null, "没有 --branch：热部署必须指定一条分支");
  if (!fs.existsSync(path.join(REPO, "bridge", "package.json"))) fail(0, "bad-repo", null, `${REPO} 不像 pi-web-client（缺 bridge/package.json）`);
  if (lockFresh()) fail(0, "busy", null, "另一个热部署正在跑（lock 还新鲜）");
  try {
    fs.rmSync(LOCK, { force: true });
  } catch {}
  if (!takeLock()) fail(0, "busy", null, `拿不到 ${LOCK}`);
  log(`=== hotdeploy ${REPO} → ${BRANCH} :${PORT} ===`);
  writeState({ step: 0 });

  const cur = (git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout ?? "").trim();
  state.fromBranch = cur === "HEAD" ? "(detached)" : cur;
  state.fromSha = shortHead();
  writeState({});
  log(`当前 ${state.fromBranch} ${state.fromSha}`);

  const files = changedFiles();
  if (files.length) {
    const list = changedLabel(files);
    if (!STASH) {
      fail(0, "dirty", null, `主检出有未提交的改动（${list}），先提交或还原再来`);
    }
    if (cur === "HEAD" || cur !== BRANCH) {
      fail(0, "stash-branch", null, `暂存只能用在当前分支上：现在在 ${cur === "HEAD" ? "(detached)" : cur}，目标是 ${BRANCH}`);
    }
    const msg = `hotdeploy-${process.pid}-${Date.now().toString(36)}`;
    const pushed = stashPush(REPO, msg);
    if (!pushed.ok) {
      if (pushed.created) {
        state.stash = msg;
        state.stashRestored = false;
        writeState({});
        failAfterStash(0, "stash-failed", null, `${pushed.why}\nstash 可能已经创建：${msg}`);
      }
      fail(0, "stash-failed", null, pushed.why);
    }
    state.stash = msg;
    state.stashRestored = false;
    writeState({});
    const left = changedFiles();
    if (left.length) {
      failAfterStash(0, "stash-failed", null, `git stash 后工作区仍有改动（${changedLabel(left)}）`);
    }
    log(`已暂存 ${files.length} 个改动：${msg}`);
  }

  const fetched = fetchOrigin();
  if (!fetched.ok) failAfterStash(0, "fetch-failed", null, `git fetch 失败：${String(fetched.err || "")}`);
  const has = localBranch(BRANCH) || git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]).status === 0;
  if (!has) failAfterStash(0, "no-branch", null, `本地和 origin 都没有这条分支：${BRANCH}`);
  log("fetch ok");

  // ---- 1. 拉取所选分支
  writeState({ step: 1 });
  const taken = occupiedBy(BRANCH);
  if (taken) failAfterStash(1, "occupied", null, `${BRANCH} 已经被 ${taken} 检出；先去那个目录收掉它，或换一条分支`);

  if (localBranch(BRANCH)) {
    if (cur !== BRANCH) {
      const sw = git(["switch", BRANCH]);
      if (sw.status !== 0) failAfterStash(1, "switch-failed", sw.status, `git switch ${BRANCH} 失败：${String(sw.stderr || "").trim().slice(0, 600)}`);
    }
    const behind = git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]);
    const n = Number(String(behind.stdout ?? "").trim() || 0);
    if (n > 0) {
      log(`落后 origin/${BRANCH} ${n} 个提交，ff-only 跟上`);
      const mg = git(["merge", "--ff-only", `origin/${BRANCH}`]);
      if (mg.status !== 0) failAfterStash(1, "merge-failed", mg.status, `合不上 origin/${BRANCH}：${String(mg.stderr || "").trim().slice(0, 600)}`);
    }
  } else {
    const sw = git(["switch", "-c", BRANCH, "--track", `origin/${BRANCH}`]);
    if (sw.status !== 0) failAfterStash(1, "switch-failed", sw.status, `git switch -c ${BRANCH} 失败：${String(sw.stderr || "").trim().slice(0, 600)}`);
  }
  state.toSha = shortHead();
  writeState({});
  log(`现在在 ${BRANCH} ${state.toSha}`);

  // ---- 2. 编译（失败就停在这里：旧进程照跑，窗口期为零）
  writeState({ step: 2 });
  const built = build();
  if (built.code !== 0) failAfterStash(2, "build-failed", built.code, String(built.why || "").slice(0, 1200));
  state.buildId = distBuildId();
  writeState({});
  log(`build ok ${state.buildId}`);

  // ---- 3. 恢复本地改动（只有真的暂存了才走这里；必须在杀旧进程之前）
  if (state.stash) {
    writeState({ step: RESTORE_STEP });
    const restored = stashRestore(REPO, state.stash);
    if (!restored.ok) {
      fail(RESTORE_STEP, "stash-pop-failed", null, `本地改动恢复失败：${restored.why}\nstash 还在：${state.stash}`);
    }
    state.stashRestored = true;
    writeState({});
    log("本地改动已恢复");
  }

  // ---- 4. 换进程
  // 有壳时到这里就结束：壳持有端口和会话管道，换脑由它做（它才活得过这次切换）。
  if (MODE === "brain") {
    if (isShellEntry(REPO)) {
      writeState({ step: 4 });
      log("构建完成，交给壳换脑");
      finish("ok");
      return;
    }
    // 退路入口（PI_HOST_DISABLE=1 或 dist/host.js 不存在）没有壳可换：再 finish("ok") 就是
    // 谎报成功 —— 新构建根本没跑起来。继续走下面的完整重启，让新代码真的生效。
    log(`这次没有壳（入口是 ${path.relative(REPO, bridgeEntry(REPO))}），按完整模式重启旧桥`);
  }
  writeState({ step: 4 });
  oldPid = await portPid();
  // 旧桥跑在本端口的循环窗口里：杀之前放下标记，窗口自己在原地起新桥，不另开窗。
  const host = WIN ? windowHostOf(oldPid, PORT) : null;
  if (host) {
    fs.writeFileSync(RELAUNCH, String(process.pid));
    log(`旧 bridge 在窗口 pid ${host} 里，换完在同一扇窗口里起`);
  }
  if (oldPid) {
    log(`杀掉旧 bridge pid ${oldPid}`);
    // worker 自己是旧 bridge 的子进程 —— 别把自己算进去（算进去就自杀，旧桥还活着，状态卡在 running）。
    for (const kid of childrenOf(oldPid)) {
      if (kid === process.pid) continue;
      log(`  子进程 ${kid}`);
      killPid(kid);
    }
    killPid(oldPid);
    for (let i = 0; i < 20 && alive(oldPid); i += 1) await sleep(150);
    if (alive(oldPid)) log(`旧 pid ${oldPid} 还活着（可能权限不够），继续起新的`);
  } else {
    log("端口上没找到在跑的 bridge，直接起新的");
  }
  // 窗口 5 秒内没收走标记（旧桥没死、窗口被关了…）就收回标记，照旧开一扇新窗口。
  if (host && !alive(oldPid) && (await relaunchTaken(5000))) {
    log("同一扇窗口已在起新桥，等 /healthz");
  } else {
    if (host) log("窗口没接手，改开新窗口");
    fs.rmSync(RELAUNCH, { force: true });
    startBridge();
    log("新窗口已拉起，等 /healthz");
  }

  // ---- 5. 健康检查
  writeState({ step: 5 });
  const deadline = Date.now() + 45_000;
  let last = null;
  while (Date.now() < deadline) {
    const h = await health();
    if (h) {
      last = h;
      if (!state.buildId || String(h.buildId ?? "") === state.buildId) break;
    }
    await sleep(400);
  }
  if (!last) fail(5, "start-failed", null, `45 秒内 ${PORT} 上没有响应；看新开的那扇窗口，或到 ${LOG} 看输出`);
  if (state.buildId && String(last.buildId ?? "") !== state.buildId) {
    fail(5, "stale-health", null, `端口回话的是旧进程（${last.buildId}），新构建 ${state.buildId} 没起来；多半是没抢到端口`);
  }
  newPid = Number.isInteger(last.pid) ? last.pid : null;
  log(`healthz ok ${last.buildId} pid ${newPid ?? "-"}`);
  finish("ok");
}

main().catch((err) => {
  try {
    failAfterStash(state.step ?? 0, "crashed", null, String(err?.stack ?? err).slice(0, 1200));
  } catch {
    process.exit(1);
  }
});
