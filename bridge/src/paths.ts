import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const APP_NAME = "pi-web-client";
export const VERSION = "0.1.0";

export function stateDir(): string {
  const base = process.env.PI_WEB_STATE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP_NAME);
  // pi 子进程的 cwd 不一定是 bridge 的（scratch 会话有自己的中性 cwd），而 `--session-dir`、
  // `-e` 这类路径参数 pi 都拿自己的 cwd 解析。状态目录如果因 PI_WEB_STATE 传了相对路径而
  // 相对，spawn 出去就会指错地方（#384 实测：context-log 的安装副本被解析到 scratch cwd 下）。
  // 这里归一成绝对路径，所有 statePath() 的消费者（含写进扩展文件的 LOG_DIR）都不再踩这个坑。
  return path.resolve(base);
}

/**
 * The environment a pi child gets: `process.env` minus the bridge's own `PI_WEB_*` settings, which
 * configure the bridge and are none of pi's business. A spawn site adds on top only what pi has to
 * know (the gate's allow-file, the ask URL/token). This is also what keeps a test's injected
 * thresholds out of pi (D120).
 */
export function piChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("PI_WEB_")) env[key] = value;
  }
  // wb2api 网关跑在 127.0.0.1:7863。外部代理（HTTP_PROXY/HTTPS_PROXY）常把 loopback
  // 请求也一起截走：代理一挂，翻译子进程就报 "Connection error."，页面只看到日文原文。
  // 本地地址永远不该走代理，这里统一给 pi 子进程补上白名单（已有的值原样保留）。
  const loopback = ["127.0.0.1", "localhost", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"]) {
    if (env[key] === "*") continue;
    const merged = (env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const host of loopback) if (!merged.includes(host)) merged.push(host);
    env[key] = merged.join(",");
  }
  return env;
}

/** `~` / `~/x` / `~\x` → home, the way pi's normalizePath does it (utils/paths.js). */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * pi's global agent dir — the same one the CLI resolves (config.js getAgentDir):
 * `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
 *
 * `PI_AGENT_DIR` is a bridge-only test seam (probes point it at a fixture tree). It is never
 * passed on to pi, so the pi children keep their real auth/models while the bridge lists fixtures.
 */
export function agentDir(): string {
  if (process.env.PI_AGENT_DIR) return process.env.PI_AGENT_DIR;
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return expandTilde(env);
  return path.join(os.homedir(), ".pi", "agent");
}

export interface SessionsRoot {
  dir: string;
  /** Where the answer came from — shown in /api/me so a mismatch with the terminal is explainable. */
  source: "PI_AGENT_DIR" | "PI_CODING_AGENT_SESSION_DIR" | "settings.sessionDir" | "default";
}

let warnedRelative = "";

/**
 * Where pi keeps session files, in pi's own order (main.js: `--session-dir` → env → settings):
 * `PI_CODING_AGENT_SESSION_DIR`, then the global settings' `sessionDir`, then `<agentDir>/sessions`.
 * A custom dir holds every project's `.jsonl` flat; the default one has a `--<cwd>--` folder each.
 *
 * Not covered: a project-level `.pi/settings.json` `sessionDir`, or a relative global one — those
 * resolve against each project's cwd, so there is no single folder to list.
 */
export function sessionsRootInfo(): SessionsRoot {
  if (process.env.PI_AGENT_DIR) return { dir: path.join(process.env.PI_AGENT_DIR, "sessions"), source: "PI_AGENT_DIR" };
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env) return { dir: path.resolve(expandTilde(env)), source: "PI_CODING_AGENT_SESSION_DIR" };
  const settings = readJson<{ sessionDir?: unknown }>(path.join(agentDir(), "settings.json"), {});
  if (typeof settings.sessionDir === "string" && settings.sessionDir.trim()) {
    const dir = expandTilde(settings.sessionDir.trim());
    if (path.isAbsolute(dir)) return { dir: path.resolve(dir), source: "settings.sessionDir" };
    if (warnedRelative !== dir) {
      warnedRelative = dir;
      console.error(`[paths] settings.sessionDir "${dir}" is relative (per-project); listing the default sessions dir instead`);
    }
  }
  return { dir: path.join(agentDir(), "sessions"), source: "default" };
}

export function sessionsRoot(): string {
  return sessionsRootInfo().dir;
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function ensureStateDirs(): void {
  ensureDir(stateDir());
  ensureDir(path.join(stateDir(), "logs"));
}

export function statePath(...parts: string[]): string {
  return path.join(stateDir(), ...parts);
}

// ---------------------------------------------------------------- 随手问 (scratch chat, #86)

/**
 * 随手问's whole world: a throwaway session directory plus the neutral cwd its pi runs in. It lives
 * under the bridge's own state dir, which `PI_WEB_STATE` already scopes per instance — a second
 * bridge on the same machine wipes its own copy and cannot touch this one.
 */
export function scratchRoot(): string {
  return statePath("scratch");
}

/** The `--session-dir` handed to 随手问's pi: outside pi's session root, so no scan ever lists it. */
export function scratchSessionsDir(): string {
  return path.join(scratchRoot(), "sessions");
}

/** The neutral cwd: it belongs to no project, so relative paths cannot land in one. */
export function scratchCwd(): string {
  return path.join(scratchRoot(), "cwd");
}

/**
 * Wipe 随手问's directory and put the two empty directories back. Called at startup (before anything
 * is spawned, when nothing can exist there yet) and on shutdown, so "no record" survives a crash as
 * well as a clean exit. Idempotent and never throws: a leftover we cannot delete is not worth a
 * failed boot.
 */
export function resetScratchDir(): void {
  try {
    fs.rmSync(scratchRoot(), { recursive: true, force: true });
  } catch {
    /* an undeletable leftover only costs disk, the same as an unwritable state dir */
  }
  ensureDir(scratchSessionsDir());
  ensureDir(scratchCwd());
}

/**
 * 读状态文件，顺便说清「到底读到了没有」。`readJson` 把「文件不存在」和「读失败 / 解析失败」
 * 揉成同一个 fallback：对只读的调用方够用，但凡是**会回写**的存储都不能这么用 —— 一次瞬时
 * 读失败（EBUSY、EACCES、写到一半被截断）会让它拿空状态覆盖盘上的真数据，且不可逆。
 *
 * 文件不存在 = 首次运行，不是错误（`ok: true`）；其它情况 `ok: false` 并带上原因。
 */
export function readJsonChecked<T>(file: string, fallback: T): { ok: boolean; value: T; error?: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) as T };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: fallback };
    return { ok: false, value: fallback, error: (err as Error)?.message ?? String(err) };
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
