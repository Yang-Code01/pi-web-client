import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const APP_NAME = "pi-web-client";
export const VERSION = "0.1.0";

export function stateDir(): string {
  const base = process.env.PI_WEB_STATE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), APP_NAME);
  return base;
}

/** pi's global agent dir — same one the CLI uses (~/.pi/agent). */
export function agentDir(): string {
  return process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function sessionsRoot(): string {
  return path.join(agentDir(), "sessions");
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
