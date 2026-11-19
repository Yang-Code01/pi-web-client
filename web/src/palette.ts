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
