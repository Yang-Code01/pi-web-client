/**
 * 主题的六个 accent。id 是稳定标识 —— 它持久化在 `pi.prefs.accent` 里，不能翻译，也不能
 * 重排/改名；显示名与「老版本存中文色名」的迁移表留在 app.ts。
 *
 * 放在这里是因为有两个消费方：外观设置（app.ts）和「当前在哪」那颗的工作区色点（nowchip.ts）。
 * 工作区颜色由 `hash(group.id) % 6` 取这六个之一 —— 不新造调色板。
 */
export const ACCENT_IDS = ["ice", "teal", "violet", "amber", "rose", "slate"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];

/** 亮色 tint + 填充态用的暗底。 */
export const ACCENTS: Record<string, { accent: string; dim: string }> = {
  ice: { accent: "#7dd3fc", dim: "#0e3a4d" },
  teal: { accent: "#5eead4", dim: "#0d3b36" },
  violet: { accent: "#c4b5fd", dim: "#2a2148" },
  amber: { accent: "#fcd34d", dim: "#3d2e0b" },
  rose: { accent: "#fda4af", dim: "#3d1a22" },
  slate: { accent: "#cbd5e1", dim: "#252b36" },
};

/**
 * 浅底主题（「晨光」）用的同六种强调色：亮色 tint 在白底上对比不够，换成深一档；
 * `dim` 反过来是浅底上的淡色填充。id 与上表一一对应。
 */
export const ACCENTS_LIGHT: Record<string, { accent: string; dim: string }> = {
  ice: { accent: "#0369a1", dim: "#dbeefa" },
  teal: { accent: "#0f766e", dim: "#d5f3ee" },
  violet: { accent: "#6d28d9", dim: "#ebe4fc" },
  amber: { accent: "#b45309", dim: "#fbeccc" },
  rose: { accent: "#be123c", dim: "#fbe0e5" },
  slate: { accent: "#475569", dim: "#e3e8ef" },
};

/**
 * Mac 风格主题专用的强调色：照 macOS「系统设置 → 外观 → 强调色」那一排八颗。
 * 存在 `pi.prefs.macAccent`（和 `accent` 分开）：离开 Mac 主题时，原来那一颗原样还在。id 同样不能改名。
 * 深底用 Apple 深色模式的 system 色；浅底取亮色模式与「提高对比度」之间的那一档，白底上还读得清。
 */
export const MAC_ACCENT_IDS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "graphite"] as const;
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
