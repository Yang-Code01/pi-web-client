/**
 * 设置 → 子代理 → acp_delegate（#215）：读写的是 **billion-context 的配置文件**，不是 pi 的
 * settings.json，所以它有自己的两条 RPC，也不吃 global / project 那套 scope。
 *
 * 同一份文件里还躺着 `providers`（路由与登录）和 `sessions`（压缩状态），整份覆盖一次就全没了，
 * 因此写盘只有一种做法：读出整份 JSON、只替换 `pi.subagents`、临时文件 + rename 落盘；读不懂的
 * 文件就抛错，一个字节都不动。文件不存在时按「只有 pi.subagents」创建，目录不存在时先建。
 *
 * 路径按 billion-context 自己的解析顺序：`BILI_CONFIG_FILE` → `$XDG_CONFIG_HOME` →
 * `~/.config/billion-context/billion-context.json`。
 *
 * 四个字段都可缺省；空值 = 删键 = 回到 billion-context 的内置默认（`enabled` 默认开、
 * `maxConcurrent` 默认不限）。删到一支不剩时连空壳一起删，文件保持最小形状。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandTilde, writeJson } from "./paths.ts";

/** billion-context 的思考档位；与 pi 的七档同名，但这是它自己的枚举，不共用 pi 的常量。 */
export const ACP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** `null` = 这个键不在文件里，即用它自己的默认。 */
export interface AcpDelegateConfig {
  enabled: boolean | null;
  maxDepth: number | null;
  maxConcurrent: number | null;
  thinkingLevel: string | null;
}

export interface AcpDelegateView {
  path: string;
  exists: boolean;
  /** 读不懂这个文件的原因；非 null 时页面禁用保存 —— 在这种文件上写会抹掉 providers / sessions。 */
  error: string | null;
  config: AcpDelegateConfig;
}

/** 只带用户真改过的那几个键；`null` 表示删键。 */
export interface AcpDelegatePatch {
  enabled?: boolean | null;
  maxDepth?: number | null;
  maxConcurrent?: number | null;
  thinkingLevel?: string | null;
}

const EMPTY: AcpDelegateConfig = { enabled: null, maxDepth: null, maxConcurrent: null, thinkingLevel: null };

const PATCH_KEYS = ["enabled", "maxDepth", "maxConcurrent", "thinkingLevel"] as const;

export function acpConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const explicit = env.BILI_CONFIG_FILE?.trim();
  if (explicit) return path.resolve(expandTilde(explicit));
  // `HOME` 与 os.homedir() 平时是同一个；各认一次是为了测试能在不给真家目录动手术的前提下验路径。
  const homeDir = env.HOME?.trim() ? path.resolve(expandTilde(env.HOME.trim())) : home;
  const base = path.resolve(expandTilde(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config")));
  return path.join(base, "billion-context", "billion-context.json");
}

/** 只读：文件不在是 `exists: false`，不是错误；读不懂给 `error`，前端据此禁用保存。 */
export function readAcpDelegate(file: string = acpConfigPath()): AcpDelegateView {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return { path: file, exists: !missing, error: missing ? null : message(err), config: { ...EMPTY } };
  }
  try {
    return { path: file, exists: true, error: null, config: readConfig(parseRoot(text, file)) };
  } catch (err) {
    return { path: file, exists: true, error: message(err), config: { ...EMPTY } };
  }
}

/** 深合并写一条 patch。文件读不懂 / patch 不合法时抛错，磁盘保持原样。 */
export function writeAcpDelegate(patch: unknown, file: string = acpConfigPath()): AcpDelegateView {
  const changes = normalizePatch(patch);

  let root: Record<string, unknown> = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} 读不了：${message(err)}`);
  }
  if (text.trim()) root = { ...parseRoot(text, file) };

  const parent = root.pi;
  if (parent !== undefined && !asRecord(parent)) throw new Error(`${file} 里的 pi 不是对象：不敢改它`);
  const pi: Record<string, unknown> = { ...asRecord(parent) };
  // `"subagents": false` 是 billion-context 支持的布尔简写：先摊成对象，patch 只改 maxDepth 时
  // 别把它悄悄掰回「启用」。
  const sub: Record<string, unknown> = pi.subagents === false ? { enabled: false } : { ...asRecord(pi.subagents) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete sub[key];
    else sub[key] = value;
  }
  if (Object.keys(sub).length) pi.subagents = sub;
  else delete pi.subagents;
  if (Object.keys(pi).length) root.pi = pi;
  else delete root.pi;

  // paths.writeJson：先建目录、写 `<file>.tmp`、再 rename —— 同一目录内的 rename 是原子的。
  writeJson(file, root);
  return readAcpDelegate(file);
}

function parseRoot(text: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON（${message(err)}）`);
  }
  const root = asRecord(parsed);
  if (!root) throw new Error(`${file} 的根不是 JSON 对象`);
  const pi = root.pi;
  if (pi !== undefined && pi !== null && !asRecord(pi)) throw new Error(`${file} 里的 pi 不是对象`);
  const sub = asRecord(pi)?.subagents;
  if (sub !== undefined && sub !== null && typeof sub !== "boolean" && !asRecord(sub)) {
    throw new Error(`${file} 里的 pi.subagents 不是对象也不是布尔值`);
  }
  return root;
}

function readConfig(root: Record<string, unknown>): AcpDelegateConfig {
  const sub = asRecord(root.pi)?.subagents;
  if (sub === false) return { ...EMPTY, enabled: false };
  const record = asRecord(sub);
  if (!record) return { ...EMPTY };
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : null,
    maxDepth: asNumber(record.maxDepth),
    maxConcurrent: asNumber(record.maxConcurrent),
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : null,
  };
}

/** 只接受 finite 的整数，别把 1.5 或 `"3"` 当成合法配置写进去。 */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizePatch(patch: unknown): AcpDelegatePatch {
  const record = asRecord(patch);
  if (!record) throw new Error("patch 必须是对象");
  for (const key of Object.keys(record)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) throw new Error(`不认识的键：${key}`);
  }
  const out: AcpDelegatePatch = {};
  for (const key of PATCH_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new Error("enabled 只能是 true / false / 空");
      out.enabled = value;
      continue;
    }
    if (key === "thinkingLevel") {
      if (typeof value !== "string" || !(ACP_THINKING_LEVELS as readonly string[]).includes(value)) {
        throw new Error(`thinkingLevel 只能是 ${ACP_THINKING_LEVELS.join(" / ")}`);
      }
      out.thinkingLevel = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${key} 只能是 ≥ 1 的整数（空 = 删掉这个键）`);
    }
    out[key] = value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
