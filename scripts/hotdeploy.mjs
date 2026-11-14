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
 * 新进程开可见 PowerShell 窗口（关窗即停）、不 stash / 不 reset / 不 rebase。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const REPO = path.resolve(argOf("--dir", path.resolve(import.meta.dirname, "..")));
const BRANCH = argOf("--branch", "");
const PORT = Number(argOf("--port", process.env.PI_WEB_PORT || 7864));
// 拉起来的子进程必须落在我们盯着的端口上，否则它去抢 7864，我们永远等不到自己那个端口。
process.env.PI_WEB_PORT = String(PORT);

const WORK = path.join(REPO, ".scratch", "hot-deploy");
const LOG = path.join(WORK, "worker.log");
const STATE = path.join(WORK, "state.json");
const LAST = path.join(WORK, "last-run.json");
const LOCK = path.join(WORK, "lock");
const LIVE = path.join(WORK, "bridge-live.log");

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

function sh(file, args, opts = {}) {
  return spawnSync(file, args, { cwd: REPO, encoding: "utf8", ...opts });
}

function git(args) {
  return sh("git", args);
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 可见窗口里直接跑 `node bridge/dist/index.js`：人能看到输出，关窗即停（D154）。 */
function startBridge() {
  try {
    if (fs.existsSync(LIVE) && fs.statSync(LIVE).size > 5 * 1024 * 1024) fs.writeFileSync(LIVE, "");
  } catch {}
  const launcher = path.join(WORK, "start-bridge.ps1");
  // PS 5.1 按 ANSI 读无 BOM 文件；窗口标题与路径都可能是中文，必须带 BOM。
  // 直接跑 node，别经过 npm：npm.cmd 把窗口标题改回 PowerShell，那扇窗口就认不出来了。
  const body = [
    `\uFEFF$host.ui.RawUI.WindowTitle = 'pi bridge · ${PORT}'`,
    `Set-Location -LiteralPath ${psQuote(REPO)}`,
    `Write-Host 'pi bridge · ${PORT} · ${BRANCH || "?"} —— 这扇窗口关了桥就停了' -ForegroundColor DarkGray`,
    `& ${psQuote(process.execPath)} 'bridge\\dist\\index.js' 2>&1 | Tee-Object -FilePath ${psQuote(LIVE)} -Append`,
    "",
  ].join("\r\n");
  fs.writeFileSync(launcher, body);
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `Start-Process powershell -ArgumentList ${psQuote(`-NoProfile -File "${launcher}"`)} -WorkingDirectory ${psQuote(REPO)}`,
    ]);
    if (r.status !== 0) log("Start-Process 失败：", String(r.stderr || "").trim().slice(0, 400));
    return;
  }
  const out = fs.openSync(LIVE, "a");
  const child = spawn(process.execPath, [path.join(REPO, "bridge", "dist", "index.js")], {
    cwd: REPO,
    detached: true,
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
    oldPid,
    newPid,
    error: state.error ?? null,
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

/** 本机 GitHub 直连常不通：按 AGENTS.md，失败才按需带代理，不写进全局 config。 */
function fetchOrigin() {
  const direct = git(["fetch", "--prune", "--quiet", "origin"]);
  if (direct.status === 0) return { ok: true };
  const proxy = process.env.BILLION_CONTEXT_PROXY || "http://127.0.0.1:18791";
  log("git fetch 直连失败，改用代理", proxy, String(direct.stderr || "").trim().slice(0, 200));
  const viaProxy = git(["-c", `http.https://github.com/.proxy=${proxy}`, "fetch", "--prune", "--quiet", "origin"]);
  return { ok: viaProxy.status === 0, err: viaProxy.status === 0 ? "" : String(viaProxy.stderr || "").trim() };
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
  // Node 在 Windows 上不能直接 spawn .cmd（EINVAL），整条命令过 shell。
  const out = fs.openSync(LOG, "a");
  const r = WIN
    ? spawnSync(`npm run build`, { cwd: REPO, stdio: ["ignore", out, out], shell: true, env: process.env })
    : spawnSync("npm", ["run", "build"], { cwd: REPO, stdio: ["ignore", out, out], env: process.env });
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

  const dirty = String(git(["status", "--porcelain", "--untracked-files=normal"]).stdout ?? "").trim();
  if (dirty) {
    const files = dirty.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean);
    fail(0, "dirty", null, `主检出有未提交的改动（${files.slice(0, 5).join("、")}${files.length > 5 ? "…" : ""}），先提交或还原再来`);
  }

  const fetched = fetchOrigin();
  if (!fetched.ok) fail(0, "fetch-failed", null, `git fetch 失败：${String(fetched.err || "").slice(0, 600)}`);
  const has = localBranch(BRANCH) || git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]).status === 0;
  if (!has) fail(0, "no-branch", null, `本地和 origin 都没有这条分支：${BRANCH}`);
  log("fetch ok");

  // ---- 1. 拉取所选分支
  writeState({ step: 1 });
  const taken = occupiedBy(BRANCH);
  if (taken) fail(1, "occupied", null, `${BRANCH} 已经被 ${taken} 检出；先去那个目录收掉它，或换一条分支`);

  if (localBranch(BRANCH)) {
    if (cur !== BRANCH) {
      const sw = git(["switch", BRANCH]);
      if (sw.status !== 0) fail(1, "switch-failed", sw.status, `git switch ${BRANCH} 失败：${String(sw.stderr || "").trim().slice(0, 600)}`);
    }
    const behind = git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]);
    const n = Number(String(behind.stdout ?? "").trim() || 0);
    if (n > 0) {
      log(`落后 origin/${BRANCH} ${n} 个提交，ff-only 跟上`);
      const mg = git(["merge", "--ff-only", `origin/${BRANCH}`]);
      if (mg.status !== 0) fail(1, "merge-failed", mg.status, `合不上 origin/${BRANCH}：${String(mg.stderr || "").trim().slice(0, 600)}`);
    }
  } else {
    const sw = git(["switch", "-c", BRANCH, "--track", `origin/${BRANCH}`]);
    if (sw.status !== 0) fail(1, "switch-failed", sw.status, `git switch -c ${BRANCH} 失败：${String(sw.stderr || "").trim().slice(0, 600)}`);
  }
  state.toSha = shortHead();
  writeState({});
  log(`现在在 ${BRANCH} ${state.toSha}`);

  // ---- 2. 编译（失败就停在这里：旧进程照跑，窗口期为零）
  writeState({ step: 2 });
  const built = build();
  if (built.code !== 0) fail(2, "build-failed", built.code, String(built.why || "").slice(0, 1200));
  state.buildId = distBuildId();
  writeState({});
  log(`build ok ${state.buildId}`);

  // ---- 3. 换进程
  writeState({ step: 3 });
  oldPid = await portPid();
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
  startBridge();
  log("新窗口已拉起，等 /healthz");

  // ---- 4. 健康检查
  writeState({ step: 4 });
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
  if (!last) fail(4, "start-failed", null, `45 秒内 ${PORT} 上没有响应；看新开的那扇窗口，或到 ${LOG} 看输出`);
  if (state.buildId && String(last.buildId ?? "") !== state.buildId) {
    fail(4, "stale-health", null, `端口回话的是旧进程（${last.buildId}），新构建 ${state.buildId} 没起来；多半是没抢到端口`);
  }
  newPid = Number.isInteger(last.pid) ? last.pid : null;
  log(`healthz ok ${last.buildId} pid ${newPid ?? "-"}`);
  finish("ok");
}

main().catch((err) => {
  try {
    fail(state.step ?? 0, "crashed", null, String(err?.stack ?? err).slice(0, 1200));
  } catch {
    process.exit(1);
  }
});
