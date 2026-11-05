/**
 * 工作区布局偏好（#97 / #72 壳 A）。设置里选的是「哪一种壳」，不是一堆零散开关，
 * 所以独立成一个模块：读口（`layoutPref`）、渲染口（`activeLayout`）、以及给设置面板
 * 画 chip 用的清单。
 *
 * 存的值是稳定 id（`a`/`b`/`c`/`d`），**不是**标签文字 —— 标签要过 `tr()`，id 进了
 * localStorage 就不能再随语言变（同 `ACCENTS` 的理由）。#98 点亮其余三颗时只在这里
 * 把 id 加进 `IMPLEMENTED`，渲染层不用改。
 */

export type LayoutId = "a" | "b" | "c" | "d";

/** 画进设置的顺序，也是键盘 Tab 的顺序。 */
export const LAYOUT_IDS: readonly LayoutId[] = ["a", "b", "c", "d"];

/** 标签是中文原文，使用处 `tr(label)`（同 `SIZES` 那张表）。 */
export const LAYOUTS: readonly { id: LayoutId; label: string }[] = [
  { id: "a", label: "两行制" },
  { id: "b", label: "一行制" },
  { id: "c", label: "工作区竖列" },
  { id: "d", label: "树 + 图标条" },
];

/** 这一版真正画得出来的壳。#98 起四套都在，这里只是「万一某套临时拿掉」的开关。 */
const IMPLEMENTED: readonly LayoutId[] = ["a", "b", "c", "d"];

export function layoutSupported(id: LayoutId): boolean {
  return IMPLEMENTED.includes(id);
}

function normalize(raw: unknown): LayoutId | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (LAYOUT_IDS as readonly string[]).includes(v) ? (v as LayoutId) : null;
}

/**
 * 读口：#98 复用这个，不要在别处再写死 `"a"`。存的值不认识（手改 localStorage、
 * 旧版本删掉的壳）一律回 A —— 一条脏记录不该让界面打不开。
 */
export function layoutPref(prefs?: { layout?: unknown } | null): LayoutId {
  if (!prefs || typeof prefs !== "object") return "a";
  return normalize(prefs.layout) ?? "a";
}

/**
 * 渲染口：这一版实现不了的壳先按 A 画，但存的值原样留着 —— 用户（或 #98 期间手改的
 * localStorage）选过 B，等 B 真做出来就直接生效，不用再选一次。
 */
export function activeLayout(prefs?: { layout?: unknown } | null): LayoutId {
  const id = layoutPref(prefs);
  return layoutSupported(id) ? id : "a";
}
