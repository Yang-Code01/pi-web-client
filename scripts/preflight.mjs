#!/usr/bin/env node
/**
 * 启动前的端口检查（D441）：端口被占时先认出占用者，再决定动不动手。
 *
 * 为什么要有这一步：以前 `npm start` 直接起壳，端口被占就只吐一个 EADDRINUSE 堆栈，
 * 而最常见的情况其实是「我自己已经起了一份」（另开的终端、选了「关窗保留」的那份）——
 * 用户想要的只是「换成这一份」。所以起之前把这件事问清楚：
 *
 *   - 占用者是本项目的桥（命令行里有 `bridge/dist/host.js` 或 `index.js`）→ 问一句，
 *     默认「是」：先请它自己收工（`POST /api/host/stop`，壳按顺序收脑和 pi），
 *     10 秒不退才硬杀（`taskkill /PID /F`，绝不 `/T` —— 树的另一边可能连着别的会话）。
 *   - 占用者是别人的程序 → 只把证据印出来，绝不动手，退出 2。
 *   - 不是交互终端（CI、`npm start | tee`）→ 不猜不杀：要么自己停，要么 `--force`。
 *
 * 本文件既是 `npm start` 链里的一步（`node scripts/preflight.mjs`），也被
 * `scripts/start.mjs` 在 spawn 之前再调一次（覆盖 `start:nobuild` 与直跑）。两次检查不是
 * 原子的，只能把「检查完到 listen 之间被抢」的空窗缩小一点，真被抢了由壳的 EADDRINUSE 兜底。
 *
 * 端口 / 监听地址的解析与 `bridge/src/host.ts` 的 `readPort` / `readHost` 是同一套规则，
 * `scripts/stop.mjs` 也从这里取 —— 别再各写一份。
 *
 * 退出码：0 = 可以继续（端口空着，或者已经换成这一份）；2 = 停在这里（外人的服务、
 * 非交互又没 `--force`、停机失败、端口仍被占）；3 = 用户明确回答「不替换」。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ENTRY_NAMES } from "./bridge-entry.mjs";

/** 端口被占：不继续。 */
export const EXIT_BLOCKED = 2;
/** 用户回答「不替换」：干净的「不动手」。 */
export const EXIT_DECLINED = 3;
/** 可以继续。 */
export const EXIT_OK = 0;

const WIN = process.platform === "win32";
const APP = "pi-web-client";
/** 与 `bridge/src/host.ts` 的 `readPort()` 兜底值一致（跨语言边界各写一份，`preflight-unit` 里有人盯着）。 */
export const DEFAULT_PORT = 7864;
/** 跟 `bridge/src/host.ts` 的 `readHost()` 兜底值一致：只有本机能连。 */
export const DEFAULT_HOST = "127.0.0.1";
/** 优雅停机等端口释放的上限；超过才硬杀。 */
const STOP_GRACE_MS = 10_000;
/** 硬杀之后等端口真空出来的上限。 */
const STOP_KILL_WAIT_MS = 5_000;
/** 它明确拒了 `/api/host/stop`（HTTP 403 同源校验没过 / 405 之类）时只再等这么一会儿。 */
const STOP_REFUSED_GRACE_MS = 2_000;
/** 认「是不是本项目的桥」只看入口文件名，不看绝对路径：占用者可能来自另一份检出
 * （别的 worktree、另一个安装目录），那正是最该被认出来的一类。入口名从
 * `scripts/bridge-entry.mjs` 取，别在这儿再写一份。 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 命令行里第一个词（尊重引号）：`"C:\Program Files\nodejs\node.exe" x.js` → `C:/…/node.exe`。 */
function firstWord(cmd) {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(String(cmd ?? ""));
  const word = m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
  const flat = word.replace(/\\/g, "/");
  return flat.slice(flat.lastIndexOf("/") + 1).toLowerCase();
}

// ------------------------------------------------------------------ 端口与状态目录

/** 配置只读一次：`readPort` 与 `readHost` 各要一遍，进程活着的这段时间它不会变。 */
let configCache;

/** 状态目录：`PI_WEB_STATE` → `%LOCALAPPDATA%/pi-web-client`（非 Windows 走 XDG 风格）。 */
export function stateDir() {
  return path.resolve(
    process.env.PI_WEB_STATE ||
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP),
  );
}

function readConfig() {
  if (configCache) return configCache;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(), "config.json"), "utf8"));
    configCache = cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    configCache = {};
  }
  return configCache;
}

/** `PI_WEB_PORT` → 状态目录 `config.json` 的 `port` → 7864。 */
export function readPort() {
  const env = Number(process.env.PI_WEB_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  const cfg = readConfig();
  if (Number.isInteger(cfg.port) && cfg.port > 0) return cfg.port;
  return DEFAULT_PORT;
}

/** `PI_WEB_HOST` → 配置里的 `host` → 回环（壳默认只让本机连，别把口令暴露给局域网）。 */
export function readHost() {
  if (process.env.PI_WEB_HOST) return process.env.PI_WEB_HOST;
  const cfg = readConfig();
  if (typeof cfg.host === "string" && cfg.host) return cfg.host;
  return DEFAULT_HOST;
}

/** 端口 → pid 文件（D154），与 `bridge/src/pidfile.ts` 同一路径。 */
export function pidFile(port) {
  return path.join(os.tmpdir(), `pi-web-bridge-${port}.pid`);
}

export function pidFromFile(port) {
  try {
    const n = Number(fs.readFileSync(pidFile(port), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 认人

/** 跑一段 PowerShell 拿字符串。**查询本身失败**（超时、没权限、没有 powershell）返回 `null`，
 * 跟「查到了、但是空」区分开：前者不能当「它不是本项目的桥」看。 */
function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? "").trim();
}

/** 某个 pid 的命令行（认人全靠它）。进程已经没了 → `""`；查询本身失败 → `null`。 */
export function commandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (WIN) {
    return ps(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CommandLine }`);
  }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (r.error) return null;
  return r.status === 0 ? String(r.stdout ?? "").trim() : "";
}

/**
 * pid 的工作目录。Windows 上拿不到（进程 API 不暴露），返回空串 —— 命令行里的入口
 * 路径已经足够看出是谁、来自哪份检出，别为了这一行去上 NativeAOT。
 * 拿不到时由调用方写一句「看不到」，别静默省略（用户会以为那一行不该有问题）。
 */
export function workingDir(pid) {
  if (WIN || !Number.isInteger(pid) || pid <= 0) return "";
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (WIN) return ps(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' }`) === "yes";
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 命令行里带着本项目桥的入口 = 这是「我自己」起的一份（哪份检出都算）。
 *
 * 三道关，都是防「看错人就看错人地杀了它」：
 * ① 命令行的**第一个词**得是 node（`git add bridge/dist/index.js`、`echo node …host.js`、
 *    `npm run x -- bridge/dist/index.js` 这些只是命令行里提到入口名，不算）；
 * ② 入口必须是**某个参数的结尾**（`host.js.bak`、`host.js.old` 不算）；
 * ③ 入口前必须是真正的参数边界（空白或引号）。
 */
export function looksLikeBridge(cmd) {
  const argv0 = firstWord(cmd);
  if (argv0 !== "node" && argv0 !== "node.exe") return false;
  const flat = ` ${String(cmd ?? "").replace(/\\/g, "/")} `;
  return ENTRY_NAMES.some((name) => new RegExp(`[\\s"'][^\\s"']*${escapeRe(name)}(?=$|[\\s"'])`).test(flat));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 谁在 listen 这个端口（枚举兜底：/healthz 与 pid 文件都不灵时用）。 */
export function listenPid(port) {
  if (WIN) {
    const out = ps(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    );
    const n = Number(out);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const first = String(r.stdout ?? "")
    .split(/\s+/)
    .find(Boolean);
  const n = Number(first);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 探活与停机要打的地址。壳可能只听某个具体 IP（`PI_WEB_HOST`），那就打那个地址；
 * 通配地址换成对应的回环 —— 通配不是能连的目标。`0.0.0.0` 是 v4 通配（回环 `127.0.0.1`），
 * `::` 是 v6 通配（回环 `[::1]`）：Linux 上 `bindv6only=1` 时 `::` 不收 v4 回环连接，
 * 拿 `127.0.0.1` 去探会永远探不到，于是把自家的壳当成外人、连 `--force` 也不肯停。
 */
export function localBase(host, port) {
  const h = String(host ?? "");
  const target = !h || h === "0.0.0.0" ? DEFAULT_HOST : h === "::" || h === "[::]" ? "::1" : h;
  const authority = target.includes(":") && !target.startsWith("[") ? `[${target}]` : target;
  return `http://${authority}:${port}`;
}

/**
 * 端口上的 /healthz（壳与旧桥都会答）。
 * - 连不上 → `null`
 * - 答了但不是能读的 JSON（回包被截断、端口上是别的服务）→ `{ body: null }`
 *
 * 这两种必须分开：后者说明端口上确实有东西在答，不能当成「它没有壳」就去硬杀。
 */
export async function healthz(port, host = DEFAULT_HOST, ms = 1500) {
  try {
    const res = await fetch(`${localBase(host, port)}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { body: null };
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      return { body: body && typeof body === "object" ? body : null };
    } catch {
      return { body: null };
    }
  } catch {
    return null;
  }
}

/** 真拿「壳会用的那个地址」去 bind 一次：能 bind 才是真的空。 */
export async function portFree(port, host = DEFAULT_HOST) {
  const srv = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    if (srv.listening) await new Promise((r) => srv.close(r));
  }
}

/**
 * 一次问完「谁在 listen 这个端口」和「这几个 pid 的命令行」，每行 `pid|commandLine`，
 * 另加一行 `listen|<pid>`。
 *
 * 为什么合并：Windows 上一次 `powershell` 冷启动本机实测 1.5~1.9 秒，而认人最多要问三四个
 * pid；分开问（`commandLine` / `listenPid` 各起一次）就是六七秒的白等。进程内的
 * `Get-CimInstance` 每个只要几十毫秒，所以全塞进同一次调用。
 *
 * 整个查询失败（powershell 超时 / 没权限）→ `null`：**不能**当成「这些进程都不在」。
 * 返回 `{ listen, lines, failed, listenUnknown }`：
 * - `lines` 里没有某个 pid、又不在 `failed` 里，才是「进程已经不在了」；
 * - `failed` 是「这个 pid 问不到」（没 lsof / ps 挂了 / 权限不够）—— 不等于它不是本项目的桥；
 * - `listenUnknown` 是「谁在 listen 这一项没问到」（端口明明忙着，却报不出 pid）。
 */
export function processDetails(port, pids = []) {
  const want = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];
  const lines = new Map();
  if (WIN) {
    const list = want.join(",");
    const script =
      `$wanted = @(); ` +
      `$own = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); ` +
      `if ($own) { "listen|$([int]$own)"; $wanted += [int]$own }; ` +
      (list ? `foreach ($x in '${list}'.Split(',')) { $wanted += [int]$x }; ` : "") +
      `foreach ($w in ($wanted | Select-Object -Unique)) { ` +
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$w" -ErrorAction SilentlyContinue; ` +
      `if ($p) { "$($p.ProcessId)|$($p.CommandLine)" } }`;
    const raw = ps(script);
    if (raw === null) return null;
    let listen = null;
    for (const line of raw.split(/\r?\n/)) {
      const at = line.indexOf("|");
      if (at <= 0) continue;
      const head = line.slice(0, at);
      const pid = Number(head);
      // `listen|1234` 那一行的左半边不是 pid，先认它、从右半边取号。
      if (head === "listen") {
        const own = Number(line.slice(at + 1));
        if (Number.isInteger(own) && own > 0) listen = own;
        continue;
      }
      if (!Number.isInteger(pid) || pid <= 0) continue;
      lines.set(pid, line.slice(at + 1));
    }
    // Windows 的一次查询里没有「问不到某个 pid」这种半状态：没输出就是没这个进程。
    return { listen, lines, failed: new Set(), listenUnknown: listen === null };
  }
  // unix：`lsof` + `ps` 都是毫秒级，一次一个反而简单。
  const listen = listenPid(port);
  const failed = new Set();
  for (const pid of [...new Set([...want, ...(listen ? [listen] : [])])]) {
    const cmd = commandLine(pid);
    // 单个 pid 问不到不代表整个查询失败：把「谁在 listen」和已经问到的部分留着。
    if (cmd === null) failed.add(pid);
    else if (cmd) lines.set(pid, cmd);
  }
  return { listen, lines, failed, listenUnknown: listen === null };
}

/**
 * 查出占用者。顺序沿用 D154：`/healthz` 自报 pid → pid 文件 → 枚举；
 * 每个候选都要过「命令行里是桥入口」这一关，对不上只当线索、不认作自己人。
 * 三条线索在同一个 `processDetails` 里一次问完（Windows 上一次 powershell 1.5s 起）。
 */
export async function probeOwner(port, host = DEFAULT_HOST) {
  const hz = await healthz(port, host);
  const health = hz?.body ?? null;
  const fromFile = pidFromFile(port);
  const details = processDetails(port, [health?.pid, fromFile]);
  let other = null;
  /** 端口上答了东西、或者压根没问成：**不当外人也不当自己人**。 */
  let unverified = null;

  const inspect = (pid, from) => {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // 查询本身失败（powershell 超时 / 没权限）：不确定，**不等于**「不是本项目的桥」。
    if (!details) {
      unverified ??= { pid, from };
      return null;
    }
    // 这个 pid 的命令行问不到（没 lsof / ps 挂了）：不确定，**不等于**「它不是本项目的桥」。
    if (details.failed.has(pid)) {
      unverified ??= { pid, from };
      return null;
    }
    const cmd = details.lines.get(pid);
    if (cmd === undefined) return null; // 进程已经没了
    if (looksLikeBridge(cmd)) return { pid, cmd, from };
    if (!other) other = { pid, cmd, from };
    return null;
  };

  const ours =
    inspect(health?.pid, "healthz") ??
    inspect(fromFile, "pidfile") ??
    inspect(details?.listen, "listen");
  if (!ours && !other && !unverified) {
    // 连 listen 的 pid 都没问到（没 lsof / 枚举失败），或者端口答了但读不懂：一样不确定。
    if (!details || details.listenUnknown) unverified = { pid: health?.pid ?? fromFile ?? 0, from: "listen" };
    else if (hz && !health) unverified = { pid: 0, from: "healthz" };
  }

  const picked = ours ?? other;
  return {
    port,
    pid: picked?.pid ?? unverified?.pid ?? 0,
    cmd: picked?.cmd ?? "",
    from: picked?.from ?? unverified?.from ?? "",
    health,
    ours: Boolean(ours),
    /**
     * /healthz 答了，但回包不是能读的 JSON（被截断、或端口上是别的服务）。这种时候不知道
     * 它有没有壳，硬杀可能把壳连着下面的 pi 会话一起弄成孤儿。
     */
    unreadable: Boolean(hz) && !health,
    /**
     * 没法确认是谁（读不到命令行，或者它答的 /healthz 读不懂）。这种时候**什么都不动**：
     * 连 `/api/host/stop` 都不发 —— 端口上的东西如果不是桥，那条 POST 会被当成什么指令，
     * 没人事先知道。
     */
    unverified: Boolean(unverified),
    /**
     * 有壳的桥才答 `brain` 这个键（哪怕还没脑、值是 null）。旧桥（`PI_HOST_DISABLE=1`）
     * 的 /healthz 里没有它 —— 那种没有 `/api/host/stop`，只能硬杀。
     */
    shell: Boolean(health && typeof health === "object" && "brain" in health),
  };
}

// ------------------------------------------------------------------ 停机

/**
 * 请壳自己收工：壳先让脑收会话、再带 pi 一起退（`npm run bridge:stop` 用的是同一条路）。
 *
 * 返回 `{ ok, status }`：`status` 为 `null` 表示**没连上**（它可能已经在退，没等回包就把端口关了）；
 * `ok === false && status !== null` 是「它答了、但拒绝了」（同源校验没过 / 路由不对）—— 这两种
 * 情况的等待时间不一样，所以不能折成一个布尔值。
 */
async function postStop(port, host = DEFAULT_HOST) {
  const base = localBase(host, port);
  try {
    const res = await fetch(`${base}/api/host/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 壳的 sameOrigin 校验：命令行这边把 Origin 写成它自己的地址就是「同源」。
        origin: base,
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    // 连接断掉不算失败：它可能已经在退、没等回包就把端口关了。
    return { ok: false, status: null };
  }
}

/**
 * 它明确拒了 `/api/host/stop` 时等多久：它不会因为等得久一点就改主意，但可能正在被别处停。
 */
function stopGrace(stop) {
  return stop.ok || stop.status === null ? STOP_GRACE_MS : STOP_REFUSED_GRACE_MS;
}

/** 硬杀一个 pid。**绝不 `/T`**：树的另一边可能连着别的会话，会把更新器自己一起带下去。 */
export async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (!alive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已经没了 */
  }
}

async function waitFree(port, host, ms) {
  const t0 = Date.now();
  for (;;) {
    if (await portFree(port, host)) return true;
    if (Date.now() - t0 >= ms) return false;
    await sleep(100);
  }
}

/**
 * 硬杀之后把 pid 文件清掉。
 *
 * `bridge/src/pidfile.ts` 的 `removePidFile` 挂在壳自己的 exit 钩子上，`taskkill /F` 不走钩子，
 * 于是文件里会一直记着一个已经不存在的 pid —— 下一轮的 `explainPortTaken` 和更新器
 * （`.pi/skills/bridge-update`）都会照着它去找，找到一个空号。只删「记的还是这一个 pid」那份，
 * 不替别人清账。
 */
function forgetPidFile(port, pid) {
  if (pidFromFile(port) !== pid) return;
  try {
    fs.unlinkSync(pidFile(port));
  } catch {
    /* 删不掉就留着：下一轮认人时它指向的进程已经不在，不会被当成占用者 */
  }
}

/** 停掉「自己人」：先优雅、等不到再硬杀，最后一定要看到端口真的空出来。 */
async function stopOwner(owner, port, host, log) {
  if (owner.shell) {
    log(`  先请它自己收工（POST /api/host/stop：壳会按顺序收脑和 pi）…`);
    const stop = await postStop(port, host);
    // 它要是明说「不行」，等满 10 秒只是白等；没连上反而要等（它可能正在退）。
    if (await waitFree(port, host, stopGrace(stop))) return true;
    log(
      stop.status === null
        ? `  没连上（它可能已经在退），等不到端口释放，硬杀 pid ${owner.pid}。`
        : stop.ok
          ? `  ${STOP_GRACE_MS / 1000} 秒内没退干净，只好硬杀 pid ${owner.pid}。`
          : `  它拒了 /api/host/stop（HTTP ${stop.status}），不再干等，硬杀 pid ${owner.pid}。`,
    );
  } else {
    log(`  它没有壳，没有 /api/host/stop，只能硬杀 pid ${owner.pid}…`);
  }
  await killPid(owner.pid);
  forgetPidFile(port, owner.pid);
  if (await waitFree(port, host, STOP_KILL_WAIT_MS)) return true;
  log(`  硬杀之后 ${port} 还是被占着 —— 有别的东西接手了，停在这里。`);
  return false;
}

// ------------------------------------------------------------------ 提问

function formatUptime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 60) return `${Math.round(n)} 秒`;
  if (n < 3600) return `${Math.floor(n / 60)} 分钟`;
  return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分钟`;
}

/** 把占用者摊开成几行证据：pid、版本、跑了多久、工作目录、命令行、在跑的会话。 */
function describe(owner) {
  const lines = [];
  const bits = [];
  if (owner.pid) bits.push(`pid ${owner.pid}`);
  const h = owner.health && typeof owner.health === "object" ? owner.health : {};
  if (h.version) bits.push(`${h.version}${h.buildId ? `+${h.buildId}` : ""}`);
  const up = formatUptime(h.uptime);
  if (up) bits.push(`已跑 ${up}`);
  if (owner.from && owner.from !== "healthz") bits.push(`由 ${owner.from} 认出`);
  if (bits.length) lines.push(`  ${bits.join(" · ")}`);
  const cwd = workingDir(owner.pid);
  if (owner.pid) lines.push(cwd ? `  工作目录 ${cwd}` : `  工作目录 看不见（Windows 上拿不到别的进程的工作目录，看命令行里的入口路径）`);
  if (owner.cmd) lines.push(`  命令行 ${owner.cmd}`);
  if (Array.isArray(h.sessions)) {
    const running = h.sessions.filter((s) => s && s.turnActive).length;
    lines.push(`  ${h.sessions.length} 个会话${running ? `（${running} 个回合正在跑）` : ""}`);
  }
  return lines;
}

const ASK_PROMPT = "要停掉它、换成这一份吗？[Y/n] ";

/**
 * 往输出里写提示。`process.stdout` 走同步写：提问总是紧跟一次 `process.exit()`，
 * 管道里的异步写会被截断（`npm start | tee` 时最后一行提示会丢）。
 */
function writeOut(stdout, text) {
  if (stdout === process.stdout) {
    try {
      fs.writeSync(1, text);
      return;
    } catch {
      /* 下游关了管道（| head）*/
    }
  }
  stdout.write(text);
}

/**
 * 问一句「要停掉它吗」，可注入 stdin/stdout（仓库里没有 pty，单测就拿假 TTY 喂）。
 * 回车 = 是（默认 Y）；n/no = 不替换；其它输入重问；EOF（Ctrl-D / 输入结束）算「没回答」。
 */
export function askReplace({ stdin = process.stdin, stdout = process.stdout, question = ASK_PROMPT } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(value);
    };
    rl.on("close", () => finish(null));
    rl.on("line", (line) => {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") finish(true);
      else if (answer === "n" || answer === "no") finish(false);
      else writeOut(stdout, question);
    });
    writeOut(stdout, question);
  });
}

/** `--force` / `PI_START_FORCE=1` / `npm start --force`：明确授权动手（非交互场景用）。 */
export function forceRequested(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--force")) return true;
  const on = (v) => /^(1|true|yes|y)$/i.test(String(v ?? "").trim());
  if (on(env.PI_START_FORCE)) return true;
  // `npm start --force`：npm 把 `--force` 吃成自己的配置、不进脚本参数，只留这个环境变量。
  return on(env.npm_config_force);
}

// ------------------------------------------------------------------ 主流程

/**
 * 端口空着就静默返回 0；被占就按上面的规则处理。
 * `log` 用同步写：最后 `process.exit()` 时管道里的异步写会被截断。
 */
export async function preflight(opts = {}) {
  const port = readPort();
  const host = readHost();
  const force = opts.force ?? forceRequested();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const log = (line) => {
    try {
      fs.writeSync(1, `${line}\n`);
    } catch {
      /* 下游关了管道（| head），别为一行日志炸掉 */
    }
  };

  if (await portFree(port, host)) return EXIT_OK;

  const owner = await probeOwner(port, host);

  if (!owner.ours && owner.unverified) {
    log(`${port} 上有东西在听，但没法确认是不是本项目的桥：`);
    for (const line of describe(owner)) log(line);
    if (owner.pid && !owner.cmd) log(`  命令行 读不到（powershell 超时、或者权限不够）`);
    // 不确定就不动手：连 `/api/host/stop` 都不发。端口上的东西如果不是桥，那条 POST 会被当成
    // 什么指令，没人事先知道 —— 要停它得由人明确发起。
    log(`  不确定就不动手。确认之后自己停：npm run bridge:stop`);
    log(`  或者换一个端口起：PI_WEB_PORT=<别的口> npm start`);
    return EXIT_BLOCKED;
  }

  if (!owner.ours) {
    log(`${port} 被别的程序占着，不是 pi-web-client：`);
    for (const line of describe(owner)) log(line);
    log(owner.pid ? `我只停自己起的 pi-web-client，这个请你自己处理。` : `认不出占用者的 pid —— 请自己确认后停掉它。`);
    log(`  换个端口起：PI_WEB_PORT=<别的口> npm start`);
    return EXIT_BLOCKED;
  }

  log(`${port} 上已经有一份 pi-web-client 在跑：`);
  for (const line of describe(owner)) log(line);
  if (owner.unreadable) {
    // 认出了是本项目的桥，但它的 /healthz 没读懂：不敢断它有没有壳，也就不能硬杀。
    log(`  它的 /healthz 没读懂（回包被截断？），不敢直接硬杀 —— 万一它是壳，硬杀会把下面的 pi 会话变成孤儿。`);
    log(`  先请它自己收工试试（POST /api/host/stop）…`);
    const stop = await postStop(port, host);
    if (await waitFree(port, host, stopGrace(stop))) {
      log(`  它自己退了，端口空出来了。`);
      return EXIT_OK;
    }
    log(`  它没退。自己确认一下：npm run bridge:stop；或者换一个端口：PI_WEB_PORT=<别的口> npm start`);
    return EXIT_BLOCKED;
  }
  if (!owner.shell) {
    log(`  它没有壳（PI_HOST_DISABLE=1 起的旧桥），停它只能硬杀 ——`);
    log(`  它下面的 pi 会话可能变成孤儿，界面上会卡在「终端正在使用」。`);
  }

  if (force) {
    log(`按 --force / PI_START_FORCE=1 处理：不问了，直接停掉它再起这一份。`);
  } else if (!stdin.isTTY) {
    log(`端口被占，但这次不是交互终端，我不替你决定：`);
    log(`  自己停掉：npm run bridge:stop（或回它的终端 Ctrl-C）`);
    log(`  让我停：npm start --force（或 PI_START_FORCE=1 npm start；直跑 node scripts/preflight.mjs --force 也行）`);
    return EXIT_BLOCKED;
  } else {
    const answer = await askReplace({ stdin, stdout });
    if (answer === null) {
      log(`没有回答（输入结束了），那就什么都不动。`);
      return EXIT_BLOCKED;
    }
    if (!answer) {
      log(`好，那就不动它 —— 这一份没有起来。`);
      return EXIT_DECLINED;
    }
  }

  log(`好，把它停掉。`);
  return (await stopOwner(owner, port, host, log)) ? EXIT_OK : EXIT_BLOCKED;
}

const self = path.resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invoked && invoked === self) {
  preflight().then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.stack ?? err));
      process.exit(EXIT_BLOCKED);
    },
  );
}
