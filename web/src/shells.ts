/**
 * 四套壳的「拼法」表（#98 / #72）。
 *
 * 壳与壳之间只差**哪几块拼在一起**，交互内核（`PillBar` / `NowChip` / `buildTree` / `drag`）是
 * 同一份。所以差异集中在这张纯表里：渲染层读表决定哪一行、哪一列画不画，而不是到处
 * `if (id === "b")`。竖列（C）和色点条（D）连数据都是同一份（`railModel`），只是尺寸不同。
 *
 * 纯函数，单测在 `web/tests/shells-unit.mjs`。
 */
import type { LayoutId } from "./layout.ts";

/** 一套壳由哪几块拼出来。 */
export interface ShellParts {
  /** 工作区标签页（A）：#119 起挂在顶栏那一行里，而不是自己独占一条网格行。 */
  tabsRow: boolean;
  /** 顶栏下第 2 行：当前会话那颗 + 本区胶囊（A）。 */
  sessionRow: boolean;
  /** 当前会话那颗挂在顶栏里（B/C/D），而不是行 2。 */
  chipTop: boolean;
  /** 点那颗 = 展开工作区浮层。B 是它唯一的切组入口；C/D 顺手也给了同一个浮层。 */
  chipOpensOverlay: boolean;
  /** 最左常驻 48px 工作区竖列（C）。 */
  rail: boolean;
  /** 左栏收起时不彻底消失，缩成 52px 色点条（D）。 */
  strip: boolean;
}

const PARTS: Record<LayoutId, ShellParts> = {
  // 两行制：两条横栏，那颗在行 2 的最左（它是指示，不是按钮）。
  a: { tabsRow: true, sessionRow: true, chipTop: false, chipOpensOverlay: false, rail: false, strip: false },
  // 一行制：横栏全收，只剩顶栏那颗；点开才是工作区浮层。
  b: { tabsRow: false, sessionRow: false, chipTop: true, chipOpensOverlay: true, rail: false, strip: false },
  // 工作区竖列：最左常驻一列色点 + 两字头，切组靠它；顶栏仍是那颗。
  c: { tabsRow: false, sessionRow: false, chipTop: true, chipOpensOverlay: true, rail: true, strip: false },
  // 树 + 图标条：左栏照旧是树，收起时缩成色点条。
  d: { tabsRow: false, sessionRow: false, chipTop: true, chipOpensOverlay: true, rail: false, strip: true },
};

/** 不认识的 id 回 A —— 与 `layout.ts` 的兜底同一条口径（脏记录不该让界面打不开）。 */
export function shellParts(id: LayoutId): ShellParts {
  return PARTS[id] ?? PARTS.a;
}

/**
 * #175：横条末尾那颗「＋ 新建工作区」跟标签行同进同出 —— B/C/D 没有标签行，也就不画这颗
 * （同一个「新建」在四个壳里四个位置，反而没人知道该去哪找）。纯表推导，单测守这一条。
 */
export function tabsAddShown(parts: ShellParts): boolean {
  return parts.tabsRow;
}

/**
 * 两字头：竖列 48px / 色点条 52px，全名放不下（全名进 `title` 与 `aria-label`）。
 * 按**字**取而不是按码元取，代理对不会被劈成半个字符。空名字给个占位，不留一格空白。
 */
export function railLabel(name: string): string {
  const s = String(name ?? "").trim();
  if (!s) return "··";
  return [...s].slice(0, 2).join("");
}

/** 竖列 / 色点条的一格。两套壳共用，只有 CSS 尺寸不同。 */
export interface RailItem {
  id: string;
  /** 两字头 */
  label: string;
  /** 全名（`title` / `aria-label` 用） */
  name: string;
  color: string;
  count: number;
  pending: number;
  current: boolean;
}

/**
 * 组 → 竖列的一格。参数用结构类型而不是 `TreeGroup<S>`：这两个壳只关心「名字 / 颜色 / 数量 /
 * 待处理」，`buildTree()` 给什么泛型都吃得下。
 */
export function railModel(
  groups: readonly { id: string; name: string; color: string; sessions: readonly unknown[]; pending: number }[],
  currentId: string | null,
): RailItem[] {
  return groups.map((g) => ({
    id: g.id,
    label: railLabel(g.name),
    name: g.name,
    color: g.color,
    count: g.sessions.length,
    pending: g.pending,
    current: g.id === currentId,
  }));
}
