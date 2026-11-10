/**
 * D227: 渲染偏好 —— 网页怎么排 markdown，跟 pi 的 settings.json 走。
 *
 * 目前只有一个键：`markdown.mermaid`（`off` / `final` / `streaming`，pi 的出厂值是
 * `streaming`）。为什么放在桥里而不是页面自己读：项目的 settings.json 在 `<cwd>/.pi/`，
 * 页面不知道当前会话的 cwd 在磁盘上对应哪个文件、更不知道项目有没有被授信；桥两样都知道，
 * 而且已经在别处（D161）用同一套「项目 → 全局 → 出厂值」读过设置。
 *
 * 值随会话状态下发（`state.mermaid`），于是一个 pi 进程读到的那份设置和网页排版本的是同一份
 * —— 终端和网页不会对同一段 markdown 给出两种行为。
 */
import { scopedSetting } from "./pisettings.ts";

export const MERMAID_KEY = "markdown.mermaid";

export type MermaidMode = "off" | "final" | "streaming";

/** pi 的出厂值（`dist/core/settings-defaults.js`：`markdown: { mermaid: "streaming" }`）。 */
export const MERMAID_DEFAULT: MermaidMode = "streaming";

const MODES: MermaidMode[] = ["off", "final", "streaming"];

const isMode = (v: unknown): v is MermaidMode => typeof v === "string" && (MODES as string[]).includes(v);

export interface MermaidPref {
  mode: MermaidMode;
  /** Which file answered, or `fallback` for pi's own default. */
  source: "project" | "global" | "fallback";
  path: string | null;
}

export async function mermaidPref(cli: string, cwd: string | null): Promise<MermaidPref> {
  const hit = await scopedSetting(cli, cwd, MERMAID_KEY, isMode);
  if (hit.value && hit.source !== "none") return { mode: hit.value, source: hit.source, path: hit.path };
  return { mode: MERMAID_DEFAULT, source: "fallback", path: null };
}
