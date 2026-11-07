/**
 * #121 标签行只画 N 个 + `＋N`；#124 加横向落点；#173 起顺序只有一份 `order`（左栏 / 标签行共用）。
 * 这里只做几何与集合运算（一份 order + 名额 + 当前组 → 可见标签 + 被折叠的组 + 拖动落点），
 * 碰不到 DOM —— 边界（当前组替最后一格、N+1、落点）脱离页面就能核对。
 */

import { moveTo } from "./drag.ts";

/** 名额的兜底值：桥端没下发 `max`（旧桥 / 还没连上）时按 3 画。权威值在桥端 `Workspaces.max`。 */
export const TABS_DEFAULT = 3;

/** 名额的上下界，与桥 `setTabs()` 的 clamp 1–5 是同一对数（#176 再改成 1–12）。 */
export const TABS_MIN = 1;
export const TABS_MAX = 5;

/** 名额进页面先过这一道：步进器 / `ws.tabs` 都只认这个范围。 */
export function clampMax(next: number): number {
  return Math.min(TABS_MAX, Math.max(TABS_MIN, Math.trunc(next)));
}

export interface TabModel {
  /** 标签行依次画哪几组（组 id，顺序即显示顺序）。 */
  visible: string[];
  /** 收进 `＋N` 的组，仍是 order 里的相对顺序。 */
  more: string[];
}

/**
 * 标签行画哪几颗（#173）：按 `order` 取前 `max` 颗；当前组不在其中时**占最后一格**，
 * 原来第 `max` 颗退进 `more`，所以横条永远不超过名额。
 */
export function tabModel(o: { order: readonly string[]; max: number; current?: string }): TabModel {
  const max = Number.isFinite(o.max) ? Math.max(0, Math.trunc(o.max)) : 0;
  // 坏快照里的重复 id 只认第一次出现的那颗。
  const order: string[] = [];
  for (const id of o.order) if (!order.includes(id)) order.push(id);

  const visible = order.slice(0, max);
  const current = o.current && order.includes(o.current) ? o.current : null;
  if (current && visible.length && !visible.includes(current)) visible[visible.length - 1] = current;

  const shown = new Set(visible);
  const more = order.filter((id) => !shown.has(id));
  return { visible, more };
}

/**
 * #175：刚从横条 ＋ 建出来的组，是不是已经收进了 ＋N。桥把新组追加到 `order` 末尾，末尾还放得下
 * 它就在横条上，返回 null；名额坐满时它直接进 `more`，返回 `more` 的条数（提示里的 N）。
 * 快照里根本没这颗（旧广播 / 已删）也当「没什么好说」，不给一句对不上的提示。
 */
export function newTabFold(order: readonly string[], max: number, id: string): number | null {
  const model = tabModel({ order, max });
  return model.more.includes(id) ? model.more.length : null;
}

/** #124 横向落点：`x` 落在哪一颗标签、插在它前面还是后面。 */export interface TabHit {
  id: string;
  side: "before" | "after";
}

/** 一颗标签在 viewport 里的横向占位。 */
export interface TabRect {
  id: string;
  left: number;
  right: number;
}

/**
 * #124 标签行的横向落点。`rects` 按左→右排，**拖动源自己要在调用前剔除**（不然它会一直吸住自己）。
 *
 * 左半 = before、右半 = after（正中线算右半）。第一颗之前贴第一颗的 before，最后一颗之后贴最后一颗
 * 的 after —— 拖出标签行也仍是「排到那一端」，和纵向 `hitTest()` 的「拖太远返回 null」不同：标签行
 * 只有一条轴，没有「拖到树外面」这回事。标签之间的空隙归右边那颗的 before，它和「左边那颗的
 * after」是同一个插入位，所以不必挑。
 */
export function tabHitTest(x: number, rects: TabRect[]): TabHit | null {
  if (!rects.length) return null;
  for (const r of rects) {
    if (x < r.left) return { id: r.id, side: "before" };
    if (x <= r.right) return { id: r.id, side: x < (r.left + r.right) / 2 ? "before" : "after" };
  }
  const last = rects[rects.length - 1];
  return { id: last.id, side: "after" };
}

/**
 * #173 松手后的新 order；`null` = 松在原处（落点就是它的现位置），一个字都不用发。
 * 只搬 `id` 一颗，其余顺序不动（含没画出来的折叠组）—— 拖拽只重排、不增删（#118 R7）。
 */
export function tabReorder(order: readonly string[], id: string, hit: TabHit | null): string[] | null {
  if (!hit || hit.id === id) return null;
  const at = order.indexOf(id);
  const target = order.indexOf(hit.id);
  if (at < 0 || target < 0) return null;
  const next = moveTo(order, id, (at < target ? target - 1 : target) + (hit.side === "after" ? 1 : 0));
  return next.every((x, i) => x === order[i]) ? null : next;
}
