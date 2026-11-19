/**
 * 主题（设置 → 外观 → 主题）：整套底色 / 线 / 文字 / 状态色。
 *
 * - 颜色的唯一真源在 `styles.css` 的 `:root[data-theme="…"]`；这里只管 id、显示名、预览小样用的几个色，
 *   以及「这一套是不是浅底」（浅底要换一张更深的强调色表，否则冰蓝字在白底上看不清）。
 * - id 是稳定标识，存在 `pi.prefs.theme` 里：不能翻译、不能改名；显示名走 `tr()`。
 * - 默认 `midnight` 就是原来那套，`<html>` 上不写 `data-theme` 时 CSS 也落在它。
 */
import { ACCENTS, ACCENTS_LIGHT } from "./palette.ts";

export const THEME_IDS = ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper"] as const;
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
  // 下面三套与上面四套并列提供，各自与同族的那套拉开：素白是纯白画布（晨光是冷灰底），
  // 深海比峡湾暗一整档、偏蓝黑，沙丘是暖沙浅底（四套里唯一的暖色浅底）。
  { id: "light", label: "素白", demo: { bg: "#ffffff", panel: "#f8f9fb", text: "#101216", line: "#c3cad4" }, light: true },
  { id: "dusk", label: "深海", demo: { bg: "#070b14", panel: "#111a2b", text: "#e3eaf7", line: "#2a3a5c" }, light: false },
  { id: "paper", label: "沙丘", demo: { bg: "#f4efe4", panel: "#fcf9f2", text: "#2a2419", line: "#c7b99e" }, light: true },
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

/**
 * 终端（xterm）跟着主题走：浅底主题里终端要是还黑着，切过去就像窗户上贴了块黑纸。
 *
 * - 16 个 ANSI 色按各套底色手挑，不跟 UI 的信号色走：终端里跑的是别人的程序（git diff、ls、vim），
 *   红绿必须彼此分得开，不能为了跟界面一个调子把两色都压成同一支。
 * - `cursor` 不在这里：它跟着用户选的强调色走，由 app.ts 拼上去。
 */
export type TermPalette = {
  background: string;
  foreground: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

/** 冷调深色（午夜 / 深海共用一套，底色不同、字色各自微调）。 */
const COOL_DARK_ANSI = {
  black: "#1b2028",
  red: "#fb7185",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#7dd3fc",
  magenta: "#c4b5fd",
  cyan: "#5eead4",
  white: "#d6deeb",
  brightBlack: "#4b5563",
  brightRed: "#fda4af",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#bae6fd",
  brightMagenta: "#ddd6fe",
  brightCyan: "#99f6e4",
  brightWhite: "#f8fafc",
};

/** 浅底（晨光 / 素白 / 沙丘共用）：同样的色相，压深到白底上能读。 */
const LIGHT_ANSI = {
  black: "#1f2328",
  red: "#b4232f",
  green: "#1a7f37",
  yellow: "#946800",
  blue: "#1558b0",
  magenta: "#8250df",
  cyan: "#0f6f7d",
  white: "#6b7280",
  brightBlack: "#57606a",
  brightRed: "#cf222e",
  brightGreen: "#16713a",
  brightYellow: "#7d4e00",
  brightBlue: "#0a58c2",
  brightMagenta: "#8250df",
  brightCyan: "#0e7490",
  brightWhite: "#24292f",
};

export const TERM_THEMES: Record<ThemeId, TermPalette> = {
  midnight: { background: "#0b0d10", foreground: "#d6deeb", selectionBackground: "#334155", ...COOL_DARK_ANSI },
  daylight: { background: "#f7f8fa", foreground: "#1f2328", selectionBackground: "#cfe0ef", ...LIGHT_ANSI },
  // 暖炉：底是暖黑，红绿黄都往暖里偏一点，不然在棕底上发脏。
  ember: {
    background: "#151210",
    foreground: "#efe7df",
    selectionBackground: "#46372c",
    black: "#2b2520",
    red: "#f28f8f",
    green: "#b6d98c",
    yellow: "#f0c674",
    blue: "#9fc4e0",
    magenta: "#d9a6d0",
    cyan: "#93d3c8",
    white: "#efe7df",
    brightBlack: "#5c4f44",
    brightRed: "#ffb3b3",
    brightGreen: "#cfe8a8",
    brightYellow: "#ffe0a3",
    brightBlue: "#bcd8ee",
    brightMagenta: "#ecc3e6",
    brightCyan: "#b3e6dd",
    brightWhite: "#fffdf9",
  },
  // 峡湾：slate 底配 Nord 那套色。
  fjord: {
    background: "#2a303b",
    foreground: "#eceff4",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#f08c96",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#f2a6b0",
    brightGreen: "#b8d0a0",
    brightYellow: "#f5dba0",
    brightBlue: "#9db8d6",
    brightMagenta: "#c9a3c3",
    brightCyan: "#9dd2df",
    brightWhite: "#eceff4",
  },
  light: { background: "#ffffff", foreground: "#101216", selectionBackground: "#d6e4f2", ...LIGHT_ANSI },
  dusk: { background: "#070b14", foreground: "#d6e2f5", selectionBackground: "#263a58", ...COOL_DARK_ANSI },
  paper: { background: "#fcf9f2", foreground: "#2a2419", selectionBackground: "#e6dcc2", ...LIGHT_ANSI },
};
