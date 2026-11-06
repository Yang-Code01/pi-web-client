#!/usr/bin/env node
/**
 * D154：把正在跑的 bridge 更新到 main 最新并重启。
 *
 * 用法（**必须 detached 启动**，否则杀掉 bridge 时它自己一起死）：
 *   node restart.mjs --check --dir <repo>        # 只 fetch + 比较，不 build、不杀进程
 *   node restart.mjs --dir <repo>                # 完整流程：ff-only pull → build → 换进程
 *   node restart.mjs --dir <repo> --dry-run      # pull + build，不换进程
 *   node restart.mjs --dir <repo> --no-start     # 只停，不起
 *
 * 顺序是刻意的：先 build 再杀进程。build 失败时旧服务原样活着，窗口期为零。
 * 状态落在 `<repo>/.scratch/bridge-update/`：update.log、last-run.json、restart.lock、pending.md。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { appendLog, argOf, lockFresh, readJson } from "./lib.mjs";

const WIN = process.platform === "win32";
const DEFAULT_REPO = path.resolve(import.meta.dirname, "../../../..");


const REPO = path.resolve(argOf("--dir", DEFAULT_REPO));
const PORT = Number(argOf("--port", process.env.PI_WEB_PORT || 7864));
const CHECK = process.argv.includes("--check");
const DRY = process.argv.includes("--dry-run");
const NO_START = process.argv.includes("--no-start");
// 拉起来的进程必须落在「我们盯着的那一个」端口上：--port 与 PI_WEB_PORT 不一致时，
// 子进程会去抢默认的 7864（EADDRINUSE），然后我们永远等不到自己那个端口。
process.env.PI_WEB_PORT = String(PORT);

const WORK = path.join(REPO, ".scratch", "bridge-update");
const LOG = path.join(WORK, "update.log");
const LAST = path.join(WORK, "last-run.json");
const LOCK = path.join(WORK, "restart.lock");
const PENDING = path.join(WORK, "pending.md");
const LIVE = path.join(WORK, "bridge-live.log");

const startedAt = new Date().toISOString();
let fromSha = "";
let toSha = "";
let expectedId = "";
let oldPid = null;
let newPid = null;
let lockOwned = false;
let killedOld = false;

function log(...parts) {
  const line = appendLog(LOG, 5 * 1024 * 1024, ...parts);
  try {
    console.log(line);
  } catch {}
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

/** 本机 GitHub 直连常不通；AGENTS.md 规定按需带代理，不写进全局 config。 */
function fetchMain() {
  const direct = git(["fetch", "--quiet", "origin", "main"]);
  if (direct.status === 0) return direct;
  const proxy = process.env.BILLION_CONTEXT_PROXY || "http://127.0.0.1:18791";
  log("git fetch 直连失败，改用代理", proxy, (direct.stderr || "").trim().slice(0, 300));
  return git(["-c", `http.https://github.com/.proxy=${proxy}`, "fetch", "--quiet", "origin", "main"]);
}

function distSha() {
  const info = readJson(path.join(REPO, "bridge", "dist", "build-id.json"));
  return info && typeof info.sha === "string" ? info.sha : "";
}

function distBuildId() {
  const info = readJson(path.join(REPO, "bridge", "dist", "build-id.json"));
  return info && typeof info.id === "string" ? info.id : "";
}

function looksLikeBridge(pid) {
  if (!pid || !alive(pid)) return false;
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).CommandLine`,
    ]);
    // 命令行里的路径可能是反斜杠形式：归一成 / 再比（不在源码里写反斜杠字面量）。
    const cmd = String(r.stdout || "").split(String.fromCharCode(92)).join("/");
    return cmd.includes("bridge/dist/index.js");
  }
  const r = sh("bash", ["-lc", `ps -p ${pid} -o command= 2>/dev/null || true`]);
  return /bridge\/dist\/index\.js/.test(String(r.stdout || ""));
}

/** bridge 自己在监听到端口时写的 pid 文件（`bridge/src/pidfile.ts`）。 */
function pidFromFile(port) {
  try {
    const n = Number(fs.readFileSync(path.join(os.tmpdir(), `pi-web-bridge-${port}.pid`), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 找「谁在服务这个端口」。先信 pid 文件：沙箱、容器、本地代理后面，
 * netstat / Get-NetTCPConnection 看不到真正持有 socket 的进程，只会答空 pid。
 */
async function portPid(port) {
  // 1) 服务自己报 pid（/healthz，仅本机可见）—— 最可靠，不依赖进程/端口枚举
  const h = await health();
  if (h && Number.isInteger(h.pid) && looksLikeBridge(h.pid)) return h.pid;
  // 2) 它启动时写的 pid 文件
  const declared = pidFromFile(port);
  if (looksLikeBridge(declared)) return declared;
  // 3) 最后才枚举端口（老版本 bridge 没有前两条;沙箱里可能什么都看不到）
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ]);
    const n = Number(String(r.stdout || "").trim());
    return looksLikeBridge(n) ? n : null;
  }
  const r = sh("bash", ["-lc", `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1`]);
  const n = Number(String(r.stdout || "").trim());
  return looksLikeBridge(n) ? n : null;
}

function childrenOf(pid) {
  if (!WIN) {
    const r = sh("bash", ["-lc", `pgrep -P ${pid} 2>/dev/null || true`]);
    return String(r.stdout || "").split(/\s+/).map(Number).filter((n) => n > 0);
  }
  const r = sh("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | % { $_.ProcessId }`,
  ]);
  return String(r.stdout || "").split(/\s+/).map(Number).filter((n) => n > 0);
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
  const r = sh("powershell", [
    "-NoProfile",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
  ]);
  return String(r.stdout || "").trim() === "yes";
}

function killPid(pid) {
  // 绝不用 taskkill /T：一棵树里可能还有别的会话，而且 /T 会把更新器自己带下去。
  if (WIN) return sh("taskkill", ["/PID", String(pid), "/F"]);
  return sh("kill", ["-TERM", String(pid)]);
}

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitHealthy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = await health();
    if (h) return h;
    await sleep(500);
  }
  return null;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function truncateLog() {
  try {
    if (fs.statSync(LIVE).size > 5 * 1024 * 1024) fs.writeFileSync(LIVE, "");
  } catch {}
}

/** 可见窗口里跑 `npm run start:nobuild`：人还能看到 build/运行输出，关窗即停。 */
function startBridge() {
  truncateLog();
  const launcher = path.join(WORK, "start-bridge.ps1");
  fs.writeFileSync(
    launcher,
    [
      // PS 5.1 按 ANSI 读无 BOM 文件；窗口标题与路径都可能是中文，必须带 BOM。
      "﻿$host.ui.RawUI.WindowTitle = 'pi bridge'",
      `Set-Location -LiteralPath ${psQuote(REPO)}`,
      `npm run start:nobuild 2>&1 | Tee-Object -FilePath ${psQuote(LIVE)} -Append`,
      "",
    ].join("\r\n"),
  );
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `Start-Process powershell -ArgumentList ${psQuote(`-NoProfile -File "${launcher}"`)} -WorkingDirectory ${psQuote(REPO)}`,
    ]);
    if (r.status !== 0) log("Start-Process 失败：", (r.stderr || "").trim().slice(0, 400));
    return;
  }
  const out = fs.openSync(LIVE, "a");
  const child = spawn(process.execPath, ["bridge/dist/index.js"], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  newPid = child.pid ?? null;
}

/**
 * 先占锁，再 merge/build：整段更新期间都得占着，否则第二个 restart（或看门狗）会
 * 并发 build、并发换进程。`wx` 是原子的 —— 两个进程同时创建，只有一个能成功。
 */
function takeLock() {
  try {
    const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2);
    fs.writeFileSync(LOCK, body, { flag: "wx" });
    lockOwned = true;
    return true;
  } catch {
    return false;
  }
}

function finish(result, extra = {}) {
  // 旧 bridge 真的被杀掉过，这一轮 turn 就被切断了 —— 不管新进程有没有起来，
  // 下一次会话都该去读 pending.md 接着做完（start-failed 同样会打断 turn）。
  const pendingUnread = killedOld && fs.existsSync(PENDING);
  const payload = {
    at: startedAt,
    finishedAt: new Date().toISOString(),
    result,
    repo: REPO,
    port: PORT,
    fromSha,
    toSha,
    buildId: expectedId,
    oldPid,
    newPid,
    pendingUnread,
    log: LOG,
    ...extra,
  };
  try {
    fs.writeFileSync(LAST, JSON.stringify(payload, null, 2) + "\n");
  } catch {}
  if (result === "ok") log(`=== ok === build ${expectedId}，pid ${oldPid ?? "-"} → ${newPid ?? "-"}`);
  else log(`=== ${result} ===`, extra.error ? String(extra.error).slice(0, 800) : "");
  try {
    if (lockOwned) fs.rmSync(LOCK, { force: true });
  } catch {}
  process.exit(result === "ok" || result === "up-to-date" || result === "behind" || result === "dry-run" ? 0 : 1);
}

function mergeRepo() {
  try {
    fs.mkdirSync(WORK, { recursive: true });
  } catch {}
  if (!fs.existsSync(path.join(REPO, "bridge", "package.json"))) {
    finish("bad-repo", { error: `${REPO} 不像 pi-web-client（缺 bridge/package.json）` });
  }
  log(`=== update ${REPO} :${PORT} start ${startedAt} ===`);

  // --check 是只读探针：不占锁、不写 last-run.json（否则会把上一次的 pendingUnread 冲掉）。
  if (!CHECK) {
    if (lockFresh(LOCK)) finish("aborted", { error: "另一个更新正在跑（restart.lock 还新鲜）" });
    if (!takeLock()) {
      // 陈旧的锁（上次崩在 build 里）可以接管，活的不行。
      try {
        fs.rmSync(LOCK, { force: true });
      } catch {}
      if (!takeLock()) finish("aborted", { error: `拿不到 ${LOCK}，另一个更新可能正在起` });
    }
  }
  const fetched = fetchMain();
  if (fetched.status !== 0) {
    if (CHECK) {
      console.log(JSON.stringify({ behind: null, error: (fetched.stderr || fetched.stdout || "").trim(), repo: REPO }));
      process.exit(1);
    }
    finish("fetch-failed", { error: (fetched.stderr || fetched.stdout || "").trim() });
  }

  fromSha = (git(["rev-parse", "HEAD"]).stdout || "").trim();
  toSha = (git(["rev-parse", "origin/main"]).stdout || "").trim();
  expectedId = distBuildId();
  // build-id.json 里存的是 `git rev-parse --short HEAD`（7 位），HEAD 是全长，只能前缀比。
  const builtSha = distSha();
  const stale = !builtSha || !fromSha.startsWith(builtSha);
  log(`HEAD ${fromSha} origin/main ${toSha} dist ${distSha() || "(none)"}${stale ? " (stale)" : ""}`);

  if (CHECK) {
    const behind = fromSha !== toSha || stale;
    log(behind ? "behind: 需要更新" : "up-to-date: 已是最新");
    console.log(JSON.stringify({ behind, fromSha, toSha, distSha: distSha(), repo: REPO, port: PORT }));
    process.exit(0);
  }

  if (fromSha === toSha && !stale) finish("up-to-date");

  // 工作区不干净就不合并：ff-only 通常照样成功（未提交的文件没被碰到），
  // 然后 `npm run build` 会把这些没提交的改动编进产物 —— 服务就不再等于 main。
  const dirty = (git(["status", "--porcelain"]).stdout || "").trim();
  if (dirty) {
    finish("merge-failed", {
      error:
        "主检出有未提交改动，不能保证构建产物等于 main；没有 stash，也没有杀进程。" +
        String.fromCharCode(10) +
        dirty.slice(0, 1500),
    });
  }

  const merged = git(["merge", "--ff-only", "origin/main"]);
  if (merged.status !== 0) {
    finish("merge-failed", {
      error: "git merge --ff-only 失败（主检出可能已有未提交改动或历史分叉）；没有 stash，也没有杀进程。\n" + (merged.stderr || merged.stdout || ""),
    });
  }
  fromSha = (git(["rev-parse", "HEAD"]).stdout || "").trim();
  log(`merged → ${fromSha}`);
}

async function main() {
  mergeRepo();

  // 先 build，后杀进程：编译失败时 7864 上还是旧代码在服务，窗口期为零。
  log("npm run build …");
  const out = fs.openSync(LOG, "a");
  // Windows 上 .cmd 只能过 shell（否则 EINVAL）；整条命令当一个字符串传，避开 DEP0190。
  const built = WIN
    ? spawnSync("npm run build", { cwd: REPO, shell: true, stdio: ["ignore", out, out], env: process.env })
    : spawnSync("npm", ["run", "build"], { cwd: REPO, stdio: ["ignore", out, out], env: process.env });
  fs.closeSync(out);
  if ((built.status ?? 1) !== 0) {
    finish("build-failed", { error: `npm run build 退出码 ${built.status ?? "?"}；旧进程未动，7864 仍在服务旧代码。` });
  }
  expectedId = distBuildId();
  log(`build ok → ${expectedId}`);

  if (DRY) finish("dry-run", { note: "只 pull + build，没有换进程" });

  oldPid = await portPid(PORT);
  const kids = oldPid ? childrenOf(oldPid) : [];
  log(`old bridge pid ${oldPid ?? "(none)"}，子进程 ${kids.join(",") || "none"}`);

  if (oldPid) {
    killPid(oldPid);
    for (let i = 0; i < 24 && alive(oldPid); i++) await sleep(250);
    if (alive(oldPid)) {
      finish("kill-failed", { error: `旧 bridge（pid ${oldPid}）没死；新旧进程都没有被改动。` });
    }
    killedOld = true;
    log("旧 bridge 已退出");
  }
  // 桥死了但 pi 子进程可能还活着：它们占着会话锁，会让会话永远显示「终端正在使用」。
  for (const pid of kids) {
    if (alive(pid)) {
      killPid(pid);
      log("清掉孤儿进程", pid);
    }
  }

  if (NO_START) finish("stopped", { note: "按 --no-start 只停不启" });

  startBridge();
  log("新进程已启动，等 /healthz …");
  const h = await waitHealthy(45_000);
  if (!h) finish("start-failed", { error: "45 秒内 /healthz 没有起来；看 bridge-live.log。" });
  if (h.buildId && expectedId && h.buildId !== expectedId) {
    finish("start-failed", { error: `${PORT} 上跑的还是旧 build（健康检查 ${h.buildId} ≠ 期望 ${expectedId}）` });
  }
  newPid = Number.isInteger(h.pid) ? h.pid : await portPid(PORT);
  finish("ok", { healthz: { version: h.version, buildId: h.buildId, pi: h.pi } });
}

main().catch((e) => {
  log("FATAL", e?.stack ?? e?.message ?? String(e));
  try {
    fs.writeFileSync(LAST, JSON.stringify({ at: startedAt, result: "crashed", error: String(e?.message ?? e) }, null, 2) + "\n");
    if (lockOwned) fs.rmSync(LOCK, { force: true });
  } catch {}
  process.exit(1);
});
