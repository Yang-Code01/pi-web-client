/**
 * 主题（设置 → 外观 → Mac 风格）：整套底色 / 线 / 文字 / 状态色。
 *
 * - 外观只有 Mac 风格三套（浅色 / 深色 / 午夜蓝，D352）：七套「配色主题」已删，把它与 Mac 分两页
 *   并列的那套结构一起退场。所以这里不再有「这套是不是 Mac」的判断 —— 界面就是 Mac 风格。
 * - 颜色的唯一真源在 `theme-tokens.css`：`:root` 就是 Mac 浅色，深色与午夜蓝各一块覆盖。
 * - id 是稳定标识，存在 `pi.prefs.theme` 里：不能翻译、不能改名；显示名走 `tr()`。
 * - 默认是 `mac-light`；旧版本存过的七套配色主题由 `migrateThemePrefs()` 按明暗与色相映射过来。
 */
import { DEFAULT_MAC_ACCENT, MAC_ACCENTS, MAC_ACCENTS_LIGHT } from "./palette.ts";

export const THEME_IDS = ["mac-light", "mac-dark", "mac-midnight"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "mac-light";

export type ThemeInfo = {
  id: ThemeId;
  /** 中文原文，使用处过 `tr()`。 */
  label: string;
  /** 设置里那颗小样：底 / 面板 / 字 / 线。强调色用用户当前选的那个。 */
  demo: { bg: string; panel: string; text: string; line: string };
  light: boolean;
};

export const THEMES: ThemeInfo[] = [
  // 照 macOS 的系统配色取值 —— 中性灰阶、不带色偏，信号色用 Apple 的 system 色
  // （浅底用它的高对比版本）。浅色是 Sonoma 窗口那种 #f5f5f7，深色是石墨中性灰，午夜蓝取 MacBook「午夜色」的蓝黑。
  { id: "mac-light", label: "Mac 浅色", demo: { bg: "#f5f5f7", panel: "#ffffff", text: "#1d1d1f", line: "#c7c7cc" }, light: true },
  { id: "mac-dark", label: "Mac 深色", demo: { bg: "#1c1c1e", panel: "#2c2c2e", text: "#f5f5f7", line: "#48484a" }, light: false },
  { id: "mac-midnight", label: "Mac 午夜蓝", demo: { bg: "#171c26", panel: "#242b3a", text: "#eef1f7", line: "#434d63" }, light: false },
];

export function isTheme(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function themeInfo(id: ThemeId): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME) ?? THEMES[0];
}

/**
 * 旧版本那七套「配色主题」落到哪一套 Mac：蓝黑底的落午夜蓝、中性 / 暖深底落深色、三套浅底落浅色。
 * 只在 `migrateThemePrefs()` 里用一次，别在别处再认这些 id —— 它们在 `isTheme()` 里已经不认识了。
 */
const LEGACY_THEME_MAP: Record<string, ThemeId> = {
  midnight: "mac-midnight",
  dusk: "mac-midnight",
  fjord: "mac-dark",
  ember: "mac-dark",
  daylight: "mac-light",
  light: "mac-light",
  paper: "mac-light",
};

/** 旧六色强调色落哪一颗 macOS 八色（最近色相；slate 是中性灰，落 graphite）。 */
const LEGACY_ACCENT_MAP: Record<string, string> = {
  ice: "blue",
  teal: "green",
  violet: "purple",
  amber: "yellow",
  rose: "pink",
  slate: "graphite",
};

/**
 * 把存在 `pi.prefs` 里的老值换成人认得的新值（纯函数：不读存储、不碰 DOM，单测直接调）。
 *
 * - 主题：认得的 Mac 三套原样；旧配色主题按明暗与色相映射；别的落默认。
 * - 强调色：**只有存的主题是旧配色主题时才搬** —— 那时候真正生效的是 `accent`（六色），
 *   `macAccent` 可能是很久以前用过 Mac 主题留下的残值。已经选了 Mac 主题的人则相反：
 *   `macAccent` 才是他选的，`accent` 是残值。
 * - 幂等：迁过一次之后 `theme` 已经是 Mac 三套之一，第二次不会再动。
 */
export function migrateThemePrefs(raw: unknown): { theme: ThemeId; macAccent: string } {
  const p = (raw && typeof raw === "object" ? raw : {}) as { theme?: unknown; accent?: unknown; macAccent?: unknown };
  // 一律 hasOwn：这些都是普通对象，`in` / 取下标会让 "constructor" / "toString" 混进来。
  const legacyTheme = typeof p.theme === "string" && Object.hasOwn(LEGACY_THEME_MAP, p.theme) ? p.theme : null;
  const theme: ThemeId = isTheme(p.theme) ? p.theme : (legacyTheme ? LEGACY_THEME_MAP[legacyTheme] : undefined) ?? DEFAULT_THEME;
  const stored = typeof p.macAccent === "string" && Object.hasOwn(MAC_ACCENTS, p.macAccent) ? p.macAccent : undefined;
  const legacyAccent =
    typeof p.accent === "string" && Object.hasOwn(LEGACY_ACCENT_MAP, p.accent) ? LEGACY_ACCENT_MAP[p.accent] : undefined;
  // D337 之前的版本根本没有 `theme` 键：那时生效的就是 `accent`，同样算「旧用户」。
  // 漏掉这一支会把他们的颜色静默换成系统蓝，而且写回之后再也找不回来。
  const legacyUser = legacyTheme !== null || p.theme === undefined;
  const macAccent = (legacyUser ? legacyAccent ?? stored : stored) ?? DEFAULT_MAC_ACCENT;
  return { theme, macAccent };
}

/** 某套主题下某个强调色的实际色值（浅底用亮色模式那一档、深底用深色模式那一档）。 */
export function accentFor(theme: ThemeId, accent: string): { accent: string; dim: string } {
  const info = themeInfo(theme);
  const mac = info.light ? MAC_ACCENTS_LIGHT : MAC_ACCENTS;
  // hasOwn：认的是「表里有的 id」，不是原型链上的名字（"constructor" 之类会返回函数）。
  return Object.hasOwn(mac, accent) ? mac[accent] : mac[DEFAULT_MAC_ACCENT];
}

/** 粗算相对亮度，只用来给强调色底挑黑字还是白字。 */
function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 强调色底上的字：跟 macOS 一样默认白字（蓝底白字），只有黄、橙这种亮色换深字。
 */
export function accentInk(theme: ThemeId, accent: string): string {
  return luminance(accentFor(theme, accent).accent) > 0.4 ? "#1d1d1f" : "#ffffff";
}

/**
 * 把主题落到 `<html>`：`data-theme` + 固定的 `data-ui="mac"`、强调色两个变量、浏览器地址栏颜色
 * （`meta[name=theme-color]`）。
 * 登录页在 App 之前画，`main.ts` 用 `bootTheme()` 先跑一次，别让浅色用户第一眼闪一下黑。
 */
export function paintTheme(theme: ThemeId, accent: string): void {
  const html = document.documentElement;
  html.dataset.theme = theme;
  // `data-ui="mac"`：mac.css 只认这一个开关（毛玻璃、圆角、动效、控件形状都挂在它下面）。
  // 外观只剩 Mac 风格，所以它恒挂 —— 留着这层是为了把 Mac 材质集中在那几个文件里，而不是在每条规则上加分支。
  html.dataset.ui = "mac";
  const a = accentFor(theme, accent);
  html.style.setProperty("--accent", a.accent);
  html.style.setProperty("--accent-dim", a.dim);
  html.style.setProperty("--accent-ink", accentInk(theme, accent));
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = themeInfo(theme).demo.bg;
}

/**
 * 按已存偏好（没有就默认）把主题挂上：主界面在登录页之前跑一次；内网通页面（peer.html，独立文档）
 * 靠它跟主界面同一套主题，主界面改了偏好时它再跑一次（`storage` 事件，D350）。
 * 旧版本存的配色主题（fjord / dusk …）在这里就按迁移表换掉，不会先闪一帧旧观感。
 */
export function bootTheme(): void {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem("pi.prefs") ?? "null");
  } catch {
    // 读不到就按默认。
  }
  const { theme, macAccent } = migrateThemePrefs(raw);
  paintTheme(theme, macAccent);
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

/** 浅底（Mac 浅色）：同样的色相，压深到白底上能读。终端配色没跟着换成 Terminal.app（D352）。 */
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
  "mac-light": { background: "#ffffff", foreground: "#1d1d1f", selectionBackground: "#b3d7ff", ...LIGHT_ANSI },
  "mac-dark": { background: "#1c1c1e", foreground: "#f5f5f7", selectionBackground: "#3f638b", ...APPLE_DARK_ANSI },
  "mac-midnight": { background: "#171c26", foreground: "#eef1f7", selectionBackground: "#34507a", ...APPLE_DARK_ANSI },
};
