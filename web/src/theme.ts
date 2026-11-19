/**
 * 主题（设置 → 外观 → 主题）：整套底色 / 线 / 文字 / 状态色。
 *
 * - 颜色的唯一真源在 `styles.css` 的 `:root[data-theme="…"]`；这里只管 id、显示名、预览小样用的几个色，
 *   以及「这一套是不是浅底」（浅底要换一张更深的强调色表，否则冰蓝字在白底上看不清）。
 * - id 是稳定标识，存在 `pi.prefs.theme` 里：不能翻译、不能改名；显示名走 `tr()`。
 * - 默认 `midnight` 就是原来那套，`<html>` 上不写 `data-theme` 时 CSS 也落在它。
 */
import { ACCENTS, ACCENTS_LIGHT } from "./palette.ts";

export const THEME_IDS = ["midnight", "daylight", "ember", "fjord"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "midnight";

export type ThemeInfo = {
  id: ThemeId;
  /** 中文原文，使用处过 `tr()`。 */
  label: string;
  /** 设置里那颗小样：底 / 面板 / 字 / 线。强调色用用户当前选的那个。 */
  demo: { bg: string; panel: string; text: string; line: string };
  light: boolean;
};

export const THEMES: ThemeInfo[] = [
  { id: "midnight", label: "午夜", demo: { bg: "#0b0d10", panel: "#171b22", text: "#e7eaf0", line: "#2f3a48" }, light: false },
  { id: "daylight", label: "晨光", demo: { bg: "#f5f6f8", panel: "#ffffff", text: "#1f2430", line: "#c9d1db" }, light: true },
  { id: "ember", label: "暖炉", demo: { bg: "#151210", panel: "#241f1b", text: "#efe7df", line: "#4a3f36" }, light: false },
  { id: "fjord", label: "峡湾", demo: { bg: "#2a303b", panel: "#3b4252", text: "#eceff4", line: "#5a6578" }, light: false },
];

export function isTheme(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** 某套主题下某个强调色的实际色值（浅底用深一档的那张表）。 */
export function accentFor(theme: ThemeId, accent: string): { accent: string; dim: string } {
  const table = themeInfo(theme).light ? ACCENTS_LIGHT : ACCENTS;
  return table[accent] ?? table.ice;
}

/**
 * 把主题落到 `<html>`：`data-theme`、强调色两个变量、浏览器地址栏颜色（`meta[name=theme-color]`）。
 * 登录页在 App 之前画，`main.ts` 用 `bootTheme()` 先跑一次，别让浅色用户第一眼闪一下黑。
 */
export function paintTheme(theme: ThemeId, accent: string): void {
  const html = document.documentElement;
  html.dataset.theme = theme;
  const a = accentFor(theme, accent);
  html.style.setProperty("--accent", a.accent);
  html.style.setProperty("--accent-dim", a.dim);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = themeInfo(theme).demo.bg;
}

/** 登录页之前：按已存偏好（没有就默认）把主题先挂上。 */
export function bootTheme(): void {
  let theme: ThemeId = DEFAULT_THEME;
  let accent = "ice";
  try {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "null");
    if (isTheme(p?.theme)) theme = p.theme;
    if (typeof p?.accent === "string" && ACCENTS[p.accent]) accent = p.accent;
  } catch {
    // 读不到就按默认。
  }
  paintTheme(theme, accent);
}
