/**
 * 主题（设置 → 外观 → 主题）：整套底色 / 线 / 文字 / 状态色。
 *
 * - 颜色的唯一真源在 `styles.css` 的 `:root[data-theme="…"]`；这里只管 id、显示名、预览小样用的几个色，
 *   以及「这一套是不是浅底」（浅底要换一张更深的强调色表，否则冰蓝字在白底上看不清）。
 * - id 是稳定标识，存在 `pi.prefs.theme` 里：不能翻译、不能改名；显示名走 `tr()`。
 * - 默认是 `mac-light`（第一次打开时还会弹一张主题选择，见 app.ts 的 maybeThemeIntro）。
 *   CSS 的 `:root` 兜底仍是 `midnight` 那套：`<html>` 上不写 `data-theme` 时落在它；JS 一跑就会写上默认的 mac-light。
 */
import { ACCENTS, ACCENTS_LIGHT, DEFAULT_MAC_ACCENT, MAC_ACCENTS, MAC_ACCENTS_LIGHT } from "./palette.ts";

export const THEME_IDS = ["midnight", "daylight", "ember", "fjord", "light", "dusk", "paper", "mac-light", "mac-dark", "mac-midnight"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "mac-light";

export type ThemeInfo = {
  id: ThemeId;
  /** 中文原文，使用处过 `tr()`。 */
  label: string;
  /** 设置里那颗小样：底 / 面板 / 字 / 线。强调色用用户当前选的那个。 */
  demo: { bg: string; panel: string; text: string; line: string };
  light: boolean;
  /** 归在「Mac 风格」那一页（设置里单独一个子类），小样左上角画三颗红绿灯。不写就是「配色主题」那一页。 */
  mac?: true;
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
  // Mac 风格（设置里单独一页）：照 macOS 的系统配色取值 —— 中性灰阶、不带色偏，信号色用 Apple 的 system 色
  // （浅底用它的高对比版本）。浅色是 Sonoma 窗口那种 #f5f5f7，深色是石墨中性灰，午夜蓝取 MacBook「午夜色」的蓝黑。
  { id: "mac-light", label: "Mac 浅色", demo: { bg: "#f5f5f7", panel: "#ffffff", text: "#1d1d1f", line: "#c7c7cc" }, light: true, mac: true },
  { id: "mac-dark", label: "Mac 深色", demo: { bg: "#1c1c1e", panel: "#2c2c2e", text: "#f5f5f7", line: "#48484a" }, light: false, mac: true },
  { id: "mac-midnight", label: "Mac 午夜蓝", demo: { bg: "#171c26", panel: "#242b3a", text: "#eef1f7", line: "#434d63" }, light: false, mac: true },
];

export function isTheme(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME) ?? THEMES[0];
}

/** 是不是 Mac 风格那一族：强调色换 macOS 八色、文字不分三档、界面换 Mac 的质感与动效（mac.css）。 */
export function isMacTheme(theme: ThemeId): boolean {
  return themeInfo(theme).mac === true;
}

/**
 * 这套主题下真正生效的强调色 id：Mac 主题读 `macAccent`（macOS 八色），别的读 `accent`（原来六色）。
 * 两份分开存，换来换去谁也不覆盖谁。
 */
export function activeAccent(theme: ThemeId, prefs: { accent: string; macAccent: string }): string {
  return isMacTheme(theme) ? prefs.macAccent : prefs.accent;
}

/** 某套主题下某个强调色的实际色值（浅底用深一档的那张表；Mac 主题用 macOS 八色那张表）。 */
export function accentFor(theme: ThemeId, accent: string): { accent: string; dim: string } {
  const info = themeInfo(theme);
  if (info.mac) {
    const mac = info.light ? MAC_ACCENTS_LIGHT : MAC_ACCENTS;
    return mac[accent] ?? mac[DEFAULT_MAC_ACCENT];
  }
  const table = info.light ? ACCENTS_LIGHT : ACCENTS;
  return table[accent] ?? table.ice;
}

/** 粗算相对亮度，只用来给强调色底挑黑字还是白字。 */
function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 强调色底上的字：Mac 主题跟 macOS 一样默认白字（蓝底白字），只有黄、橙这种亮色换深字。
 * 别的主题由 styles.css 各自的 `--accent-ink` 决定，这里返回 null（并且清掉 Mac 留下的行内值）。
 */
export function accentInk(theme: ThemeId, accent: string): string | null {
  if (!isMacTheme(theme)) return null;
  return luminance(accentFor(theme, accent).accent) > 0.4 ? "#1d1d1f" : "#ffffff";
}

/**
 * 把主题落到 `<html>`：`data-theme`、强调色两个变量、浏览器地址栏颜色（`meta[name=theme-color]`）。
 * 登录页在 App 之前画，`main.ts` 用 `bootTheme()` 先跑一次，别让浅色用户第一眼闪一下黑。
 */
export function paintTheme(theme: ThemeId, accent: string): void {
  const html = document.documentElement;
  html.dataset.theme = theme;
  // `data-ui="mac"`：mac.css 只认这一个开关（毛玻璃、圆角、动效、控件形状都挂在它下面），
  // 别的主题不写这个属性，一像素也不受影响。
  if (isMacTheme(theme)) html.dataset.ui = "mac";
  else delete html.dataset.ui;
  const a = accentFor(theme, accent);
  html.style.setProperty("--accent", a.accent);
  html.style.setProperty("--accent-dim", a.dim);
  const ink = accentInk(theme, accent);
  if (ink) html.style.setProperty("--accent-ink", ink);
  else html.style.removeProperty("--accent-ink");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = themeInfo(theme).demo.bg;
}

/**
 * 按已存偏好（没有就默认）把主题挂上：主界面在登录页之前跑一次；内网通页面（peer.html，独立文档）
 * 靠它跟主界面同一套主题，主界面改了偏好时它再跑一次（`storage` 事件，D350）。
 * 文字三档（`data-text`）也一起落：主界面随后 applyPrefs 会再写一遍同样的值。
 */
export function bootTheme(): void {
  let theme: ThemeId = DEFAULT_THEME;
  let accent = "ice";
  let macAccent = DEFAULT_MAC_ACCENT;
  let text = "normal";
  try {
    const p = JSON.parse(localStorage.getItem("pi.prefs") ?? "null");
    if (isTheme(p?.theme)) theme = p.theme;
    if (typeof p?.accent === "string" && ACCENTS[p.accent]) accent = p.accent;
    if (typeof p?.macAccent === "string" && MAC_ACCENTS[p.macAccent]) macAccent = p.macAccent;
    if (p?.text === "soft" || p?.text === "bright") text = p.text;
  } catch {
    // 读不到就按默认。
  }
  paintTheme(theme, activeAccent(theme, { accent, macAccent }));
  // Mac 主题不分三档（同 app.ts 的 applyPrefs）。
  document.documentElement.dataset.text = isMacTheme(theme) ? "normal" : text;
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

/** Mac 深色 / 午夜蓝：macOS 深色模式的 system 色（systemRed / Green / Blue …），蓝调亮一档好在黑底上读。 */
const APPLE_DARK_ANSI = {
  black: "#3a3a3c",
  red: "#ff453a",
  green: "#32d74b",
  yellow: "#ffd60a",
  blue: "#409cff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#e5e5ea",
  brightBlack: "#636366",
  brightRed: "#ff6961",
  brightGreen: "#5de36f",
  brightYellow: "#ffe14d",
  brightBlue: "#70b7ff",
  brightMagenta: "#da8fff",
  brightCyan: "#8ae0ff",
  brightWhite: "#ffffff",
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
  "mac-light": { background: "#ffffff", foreground: "#1d1d1f", selectionBackground: "#b3d7ff", ...LIGHT_ANSI },
  "mac-dark": { background: "#1c1c1e", foreground: "#f5f5f7", selectionBackground: "#3f638b", ...APPLE_DARK_ANSI },
  "mac-midnight": { background: "#171c26", foreground: "#eef1f7", selectionBackground: "#34507a", ...APPLE_DARK_ANSI },
};
