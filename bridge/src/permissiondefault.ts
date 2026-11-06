/**
 * D157: 默认权限 —— 新会话第一次被桥看见时用哪一个工具权限模式。
 *
 * 存在 pi 自己的 settings.json 里，命名空间 `web.`（桥自有键，pi 的 schema 里没有它，
 * 但 pi 解析设置时对未知键 just passes them through —— 见 settings-schema.js 的
 * `additionalProperties: true`），所以读写都和别的设置走同一条路（D78）：
 *
 *   ~/.pi/agent/settings.json        { "web": { "defaultPermission": "ask" } }
 *   <cwd>/.pi/settings.json          { "web": { "defaultPermission": "strict" } }   ← 项目覆盖全局
 *
 * 解析顺序 项目 → 全局 → `"ask"`（pi 自己不带这个键时的出厂值，也是 D1 的默认）。
 */
import { readSettings } from "./pisettings.ts";
import type { PermissionMode } from "./sessions.ts";

/** The dotted key inside settings.json. Written by the settings form like any other setting. */
export const DEFAULT_PERMISSION_KEY = "web.defaultPermission";

const MODES: PermissionMode[] = ["readonly", "strict", "ask", "auto"];

export interface PermissionDefault {
  mode: PermissionMode;
  /** Where the value came from: which file answered, or pi's factory `ask`. */
  source: "project" | "global" | "fallback";
  /** That file's path, or null for the factory value. */
  path: string | null;
}

function pick(json: Record<string, unknown> | null): PermissionMode | null {
  const web = json?.web;
  if (!web || typeof web !== "object" || Array.isArray(web)) return null;
  const mode = (web as Record<string, unknown>).defaultPermission;
  return typeof mode === "string" && (MODES as string[]).includes(mode) ? (mode as PermissionMode) : null;
}

export async function defaultPermission(cli: string, cwd: string | null): Promise<PermissionDefault> {
  let out: PermissionDefault = { mode: "ask", source: "fallback", path: null };
  for (const scope of ["project", "global"] as const) {
    if (scope === "project" && !cwd) continue;
    // An unreadable or broken file just doesn't answer: the next scope still gets a say.
    try {
      const view = await readSettings(cli, scope, cwd);
      // An untrusted project's settings.json is not loaded by pi at all — it must not answer here
      // either. `writable` is that trust decision (see pisettings.ts), so it doubles as the gate.
      if (scope === "project" && !view.writable) continue;
      const mode = pick(view.json);
      if (mode) {
        out = { mode, source: scope, path: view.path };
        break;
      }
    } catch {
      /* 读不到就当没设 */
    }
  }
  return out;
}
