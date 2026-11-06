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
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";
const DEFAULT_REPO = path.resolve(import.meta.dirname, "../../../..");

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : dflt;
}

const REPO = path.resolve(argOf("--dir", DEFAULT_REPO));
const PORT = Number(argOf("--port", process.env.PI_WEB_PORT || 7864));
const CHECK = process.argv.includes("--check");
const DRY = process.argv.includes("--dry-run");
const NO_START = process.argv.includes("--no-start");

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

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
  try {
    console.log(line);
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
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

function portPid(port) {
  if (WIN) {
    const r = sh("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ]);
    const n = Number(String(r.stdout || "").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const r = sh("bash", ["-lc", `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1`]);
  const n = Number(String(r.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
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
      "$host.ui.RawUI.WindowTitle = 'pi bridge'",
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

function lockFresh() {
  const raw = readJson(LOCK);
  if (!raw || typeof raw.at !== "string") return false;
  return Date.now() - Date.parse(raw.at) < 5 * 60 * 1000;
}

function writeLock() {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2) + "\n");
}

function finish(result, extra = {}) {
  const pendingUnread = result === "ok" && fs.existsSync(PENDING);
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
    fs.rmSync(LOCK, { force: true });
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
  if (lockFresh()) finish("aborted", { error: "另一个更新正在跑（restart.lock 还新鲜）" });
  const dirty = (git(["status", "--porcelain"]).stdout || "").trim();
  if (dirty) log("工作区有未提交改动，ff-only 合并失败时会原样退出：\n" + dirty.slice(0, 1500));

  const fetched = fetchMain();
  if (fetched.status !== 0) finish("fetch-failed", { error: (fetched.stderr || fetched.stdout || "").trim() });

  fromSha = (git(["rev-parse", "HEAD"]).stdout || "").trim();
  toSha = (git(["rev-parse", "origin/main"]).stdout || "").trim();
  expectedId = distBuildId();
  const stale = distSha() !== fromSha;
  log(`HEAD ${fromSha} origin/main ${toSha} dist ${distSha() || "(none)"}${stale ? " (stale)" : ""}`);

  if (CHECK) {
    const behind = fromSha !== toSha || stale;
    log(behind ? "behind: 需要更新" : "up-to-date: 已是最新");
    console.log(JSON.stringify({ behind, fromSha, toSha, distSha: distSha(), repo: REPO, port: PORT }));
    process.exit(0);
  }

  if (fromSha === toSha && !stale) finish("up-to-date");

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
  const built = spawnSync(WIN ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: REPO,
    shell: WIN, // Windows 上直接 spawn .cmd 会 EINVAL
    stdio: ["ignore", out, out],
    env: process.env,
  });
  fs.closeSync(out);
  if ((built.status ?? 1) !== 0) {
    finish("build-failed", { error: `npm run build 退出码 ${built.status ?? "?"}；旧进程未动，7864 仍在服务旧代码。` });
  }
  expectedId = distBuildId();
  log(`build ok → ${expectedId}`);

  if (DRY) finish("dry-run", { note: "只 pull + build，没有换进程" });

  writeLock();
  oldPid = portPid(PORT);
  const kids = oldPid ? childrenOf(oldPid) : [];
  log(`old bridge pid ${oldPid ?? "(none)"}，子进程 ${kids.join(",") || "none"}`);

  if (oldPid) {
    killPid(oldPid);
    for (let i = 0; i < 24 && alive(oldPid); i++) await sleep(250);
    if (alive(oldPid)) {
      finish("kill-failed", { error: `旧 bridge（pid ${oldPid}）没死；新旧进程都没有被改动。` });
    }
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
    finish("start-failed", { error: `7864 上跑的还是旧 build（健康检查 ${h.buildId} ≠ 期望 ${expectedId}）` });
  }
  if (WIN) {
    const again = portPid(PORT);
    newPid = again;
  }
  finish("ok", { healthz: { version: h.version, buildId: h.buildId, pi: h.pi } });
}

main().catch((e) => {
  log("FATAL", e?.stack ?? e?.message ?? String(e));
  try {
    fs.writeFileSync(LAST, JSON.stringify({ at: startedAt, result: "crashed", error: String(e?.message ?? e) }, null, 2) + "\n");
    fs.rmSync(LOCK, { force: true });
  } catch {}
  process.exit(1);
});
