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
