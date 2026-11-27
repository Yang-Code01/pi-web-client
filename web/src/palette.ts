/**
 * 主题的强调色。**只有 macOS 那一排八颗**（D353：六色强调色表随「配色主题」一起删掉了，
 * 外观只剩 Mac 风格三套）。
 *
 * id 是稳定标识 —— 它持久化在 `pi.prefs.macAccent` 里，不能翻译，也不能重排/改名；
 * 显示名与「老版本存中文色名 / 六色 id」的迁移表留在 app.ts 与 theme.ts。
 *
 * 照 macOS「系统设置 → 外观 → 强调色」那一排：深底用 Apple 深色模式的 system 色；
 * 浅底取亮色模式与「提高对比度」之间的那一档，白底上还读得清。
 */
export const MAC_ACCENT_IDS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "graphite"] as const;
export type MacAccentId = (typeof MAC_ACCENT_IDS)[number];
export const DEFAULT_MAC_ACCENT = "blue";

export const MAC_ACCENTS: Record<string, { accent: string; dim: string }> = {
  blue: { accent: "#0a84ff", dim: "#0d2a4d" },
  purple: { accent: "#bf5af2", dim: "#3a1f4a" },
  pink: { accent: "#ff375f", dim: "#4a1622" },
  red: { accent: "#ff453a", dim: "#4a1714" },
  orange: { accent: "#ff9f0a", dim: "#4a3008" },
  yellow: { accent: "#ffd60a", dim: "#4a3f08" },
  green: { accent: "#30d158", dim: "#0f3d1c" },
  graphite: { accent: "#98989d", dim: "#2e2e31" },
};

export const MAC_ACCENTS_LIGHT: Record<string, { accent: string; dim: string }> = {
  blue: { accent: "#007aff", dim: "#dbeaff" },
  purple: { accent: "#8944ab", dim: "#efe3f6" },
  pink: { accent: "#d1306b", dim: "#fbe2eb" },
  red: { accent: "#d70015", dim: "#fde0e2" },
  orange: { accent: "#c93400", dim: "#fde6dc" },
  yellow: { accent: "#a05a00", dim: "#f8ebd6" },
  green: { accent: "#248a3d", dim: "#ddf0e1" },
  graphite: { accent: "#6e6e73", dim: "#e8e8ea" },
};

/**
 * 柔和档（D438，`pi.prefs.accentTone = "muted"`）：色相不动，只把 chroma 压到 0.075
 * （石墨本来就是中性，固定 0.004），L 按「强调色作正文时对面板 ≥4.55:1」反解 ——
 * 浅底解出更深的一档、深底解出更亮的一档，所以和鲜艳档一样分两张表。
 *
 * 这里的值不要凭眼睛手改：`web/tests/theme-unit.mjs` 按 4.5 的地板逐颗量，改高了红；
 * 想换观感就改上面的 chroma，再按同一规则重解（过程见 D438 与 .scratch 的定稿脚本）。
 * dim 取柔和色 chroma 的 40%（浅）/ 45%（深），比鲜艳档那批 dim 更灰。
 */
export const MAC_ACCENTS_MUTED_LIGHT: Record<string, { accent: string; dim: string }> = {
  blue: { accent: "#5a77a2", dim: "#dce9fc" },
  purple: { accent: "#886b98", dim: "#efe2f7" },
  pink: { accent: "#9e6673", dim: "#fae0e5" },
  red: { accent: "#a06760", dim: "#fce1dd" },
  orange: { accent: "#9f685a", dim: "#fbe1db" },
  yellow: { accent: "#976d48", dim: "#f7e4d4" },
  green: { accent: "#557f5a", dim: "#dceedd" },
  graphite: { accent: "#757578", dim: "#e8e8e9" },
};

export const MAC_ACCENTS_MUTED: Record<string, { accent: string; dim: string }> = {
  blue: { accent: "#6c8db8", dim: "#222f3f" },
  purple: { accent: "#9c80ae", dim: "#33293a" },
  pink: { accent: "#b67b7e", dim: "#3d2728" },
  red: { accent: "#b67c73", dim: "#3d2724" },
  orange: { accent: "#aa8359", dim: "#392b1b" },
  yellow: { accent: "#988a54", dim: "#332e1a" },
  green: { accent: "#69956d", dim: "#223324" },
  graphite: { accent: "#8a8a8c", dim: "#2e2e2e" },
};
