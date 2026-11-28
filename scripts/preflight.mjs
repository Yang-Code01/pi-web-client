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
 * `scripts/start.mjs` 在 spawn 之前再调一次（覆盖 `start:nobuild` 与直跑，顺带堵住
 * 「检查完到 listen 之间被人抢了端口」这个空窗）。
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
import { ENTRY_NAMES as BRIDGE_ENTRY_NAMES } from "./bridge-entry.mjs";

/** 端口被占：不继续。 */
export const EXIT_BLOCKED = 2;
/** 用户回答「不替换」：干净的「不动手」。 */
export const EXIT_DECLINED = 3;
/** 可以继续。 */
export const EXIT_OK = 0;

const WIN = process.platform === "win32";
const APP = "pi-web-client";
const DEFAULT_PORT = 7864;
/** 跟 `bridge/src/host.ts` 的 `readHost()` 默认一致：只有本机能连。 */
const DEFAULT_HOST = "127.0.0.1";
/** 优雅停机等端口释放的上限；超过才硬杀。 */
const STOP_GRACE_MS = 10_000;
/** 硬杀之后等端口真空出来的上限。 */
const STOP_KILL_WAIT_MS = 5_000;
/**
 * 认「是不是本项目的桥」只看入口文件名，不看绝对路径：占用者可能来自另一份检出
 * （别的 worktree、另一个安装目录），那正是最该被认出来的一类。入口名从
 * `scripts/bridge-entry.mjs` 取，别在这儿再写一份。
 */
const ENTRY_NAMES = BRIDGE_ENTRY_NAMES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 端口与状态目录

/** 状态目录：`PI_WEB_STATE` → `%LOCALAPPDATA%/pi-web-client`（非 Windows 走 XDG 风格）。 */
export function stateDir() {
  return path.resolve(
    process.env.PI_WEB_STATE ||
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP),
  );
}

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(), "config.json"), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
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

/** 跑一段 PowerShell 拿字符串；失败就是空串，别抛。 */
function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
  });
  if (r.status !== 0) return "";
  return String(r.stdout ?? "").trim();
}

/** 某个 pid 的命令行（认人全靠它；拿不到就是空串）。 */
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
 * 两道关，都是防「看错人就看错人地杀了它」：
 * ① 得是 node 起的（`git add bridge/dist/index.js`、`type bridge\dist\host.js` 这种命令行里
 *   恰好提到入口名的不算）；
 * ② 入口必须是**某个参数的结尾**（`host.js.bak`、`host.js.old` 不算）。
 */
export function looksLikeBridge(cmd) {
  const flat = ` ${String(cmd ?? "").replace(/\\/g, "/")} `;
  if (!/\bnode(?:\.exe)?\b/i.test(flat)) return false;
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
 * `0.0.0.0` / `::` 这种通配地址换成回环 —— 通配不是能连的目标。
 */
export function localBase(host, port) {
  const wildcard = !host || host === "0.0.0.0" || host === "::" || host === "[::]";
  const target = wildcard ? DEFAULT_HOST : host;
  return `http://${target.includes(":") ? `[${target}]` : target}:${port}`;
}

/** 端口上的 /healthz（壳与旧桥都会答），没有就是 null。 */
export async function healthz(port, host = DEFAULT_HOST, ms = 1500) {
  try {
    const res = await fetch(`${localBase(host, port)}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
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
 * 查出占用者。顺序沿用 D154：`/healthz` 自报 pid → pid 文件 → 枚举；
 * 每个候选都要过「命令行里是桥入口」这一关，对不上只当线索、不认作自己人。
 * 前面一步认出来了就不再往下问 —— 枚举（`Get-NetTCPConnection` / `lsof`）是最慢的一步。
 */
export async function probeOwner(port, host = DEFAULT_HOST) {
  const health = await healthz(port, host);
  const tried = new Set();
  let other = null;

  const inspect = (pid, from) => {
    if (!Number.isInteger(pid) || pid <= 0 || tried.has(pid)) return null;
    tried.add(pid);
    // `commandLine()` 读不到就是进程已经没了（`Get-CimInstance` / `ps -p` 对不存在的 pid 返回空），
    // 所以下面这两行就顺带过滤了「/healthz 自报的 pid 其实已经退出」的情况，不用再多 spawn 一次 ps。
    const cmd = commandLine(pid);
    if (looksLikeBridge(cmd)) return { pid, cmd, from };
    if (!other && cmd) other = { pid, cmd, from };
    return null;
  };

  let ours = inspect(health?.pid, "healthz") ?? inspect(pidFromFile(port), "pidfile");
  if (!ours) ours = inspect(listenPid(port), "listen");

  const picked = ours ?? other;
  return {
    port,
    pid: picked?.pid ?? 0,
    cmd: picked?.cmd ?? "",
    from: picked?.from ?? "",
    health,
    ours: Boolean(ours),
    /**
     * 有壳的桥才答 `brain` 这个键（哪怕还没脑、值是 null）。旧桥（`PI_HOST_DISABLE=1`）
     * 的 /healthz 里没有它 —— 那种没有 `/api/host/stop`，只能硬杀。
     */
    shell: Boolean(health && typeof health === "object" && "brain" in health),
  };
}

// ------------------------------------------------------------------ 停机

/** 请壳自己收工：壳先让脑收会话、再带 pi 一起退（`npm run bridge:stop` 用的是同一条路）。 */
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
    return res.ok;
  } catch {
    // 连接断掉不算失败：它可能已经在退、没等回包就把端口关了。
    return false;
  }
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

/** 停掉「自己人」：先优雅、等不到再硬杀，最后一定要看到端口真的空出来。 */
async function stopOwner(owner, port, host, log) {
  if (owner.shell) {
    log(`  先请它自己收工（POST /api/host/stop：壳会按顺序收脑和 pi）…`);
    await postStop(port, host);
    if (await waitFree(port, host, STOP_GRACE_MS)) return true;
    log(`  ${STOP_GRACE_MS / 1000} 秒内没退干净，只好硬杀 pid ${owner.pid}。`);
  } else {
    log(`  它没有壳，没有 /api/host/stop，只能硬杀 pid ${owner.pid}…`);
  }
  await killPid(owner.pid);
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

/**
 * 问一句「要停掉它吗」，可注入 stdin/stdout（仓库里没有 pty，单测就拿假 TTY 喂）。
 * 回车 = 是（默认 Y）；n/no = 不替换；其它输入重问；EOF（Ctrl-D / 输入结束）算「没回答」。
 */
export function askReplace({ stdin = process.stdin, stdout = process.stdout, question = "要停掉它、换成这一份吗？[Y/n] " } = {}) {
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
      else stdout.write(question);
    });
    stdout.write(question);
  });
}

/** `--force` / `PI_START_FORCE=1`：非交互场景（脚本、CI）里明确授权动手。 */
export function forceRequested(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--force")) return true;
  return /^(1|true|yes|y)$/i.test(String(env.PI_START_FORCE ?? "").trim());
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

  if (!owner.ours) {
    log(`${port} 被别的程序占着，不是 pi-web-client：`);
    for (const line of describe(owner)) log(line);
    log(owner.pid ? `我只停自己起的 pi-web-client，这个请你自己处理。` : `认不出占用者的 pid —— 请自己确认后停掉它。`);
    log(`  换个端口起：PI_WEB_PORT=<别的口> npm start`);
    return EXIT_BLOCKED;
  }

  log(`${port} 上已经有一份 pi-web-client 在跑：`);
  for (const line of describe(owner)) log(line);
  if (!owner.shell) {
    log(`  它没有壳（PI_HOST_DISABLE=1 起的旧桥），停它只能硬杀 ——`);
    log(`  它下面的 pi 会话可能变成孤儿，界面上会卡在「终端正在使用」。`);
  }

  if (force) {
    log(`按 --force / PI_START_FORCE=1 处理：不问了，直接停掉它再起这一份。`);
  } else if (!stdin.isTTY) {
    log(`端口被占，但这次不是交互终端，我不替你决定：`);
    log(`  自己停掉：npm run bridge:stop（或回它的终端 Ctrl-C）`);
    log(`  让我停：PI_START_FORCE=1 npm start（npm 会把 --force 追加到链尾，链首这一步读不到它；直跑 node scripts/preflight.mjs --force 也行）`);
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
