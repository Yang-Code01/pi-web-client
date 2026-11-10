/**
 * D161: 默认权限 —— 新会话第一次被桥看见时用哪一个工具权限模式。
 *
 * 存在 pi 自己的 settings.json 里，命名空间 `web.`（桥自有键，pi 的 schema 里没有它，
 * 但 pi 解析设置时对未知键 just passes them through —— 见 settings-schema.js 的
 * `additionalProperties: true`），所以读写都和别的设置走同一条路（D78）：
 *
 *   ~/.pi/agent/settings.json        { "web": { "defaultPermission": "ask" } }
 *   <cwd>/.pi/settings.json          { "web": { "defaultPermission": "strict" } }   ← 项目覆盖全局
 *
 * 解析顺序 项目 → 全局 → `"ask"`（pi 自己不带这个键时的出厂值，也是 D1 的默认）。
 * 两层怎么读、什么时候算「这一层没说话」，都在 `scopedSetting()` 里（D227 起和渲染偏好共用）。
 */
import { scopedSetting } from "./pisettings.ts";
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

const isMode = (v: unknown): v is PermissionMode => typeof v === "string" && (MODES as string[]).includes(v);

export async function defaultPermission(cli: string, cwd: string | null): Promise<PermissionDefault> {
  const hit = await scopedSetting(cli, cwd, DEFAULT_PERMISSION_KEY, isMode);
  if (hit.value && hit.source !== "none") return { mode: hit.value, source: hit.source, path: hit.path };
  return { mode: "ask", source: "fallback", path: null };
}
