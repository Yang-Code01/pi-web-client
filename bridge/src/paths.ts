import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const APP_NAME = "pi-web-client";
export const VERSION = "0.1.0";

export function stateDir(): string {
  const base = process.env.PI_WEB_STATE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP_NAME);
  return base;
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
