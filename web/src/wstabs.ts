/**
 * #121 标签行只画 N 个 + `＋N`；#124 加横向落点；#173 起顺序只有一份 `order`（左栏 / 标签行共用）；
 * #174 每一颗可见标签都能拖；#175 横条 ＋ 建的组
 * 直接进 `＋N` 时由 `newTabFold()` 报出它被收在第几行（提示用）。
 * 这里只做几何与集合运算（一份 order + 名额 + 当前组 → 可见标签 + 被折叠的组 + 拖动落点 + 松手后的
 * 新 order），碰不到 DOM —— 边界（当前组替最后一格、落点、原位松手）脱离页面就能核对。
 */

import { moveTo } from "./drag.ts";

/** 名额的兜底值：桥端没下发 `max`（旧桥 / 还没连上）时按 6 画。权威值在桥端 `Workspaces.max`。 */
export const TABS_DEFAULT = 6;

/** 名额的上下界，与桥 `setTabs()` 的接受范围 1–12 是同一对数（#176）。 */
export const TABS_MIN = 1;
export const TABS_MAX = 12;

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

/**
 * #177 组头「移到最前」：把 `id` 搬到 `order` 第一位，其余（含折叠组）相对位置不变。
 * `null` = 已经是最前 / 不在这份 order 里，调用方一个字都不用发。
 */
export function moveToFront(order: readonly string[], id: string): string[] | null {
  const at = order.indexOf(id);
  if (at <= 0) return null;
  return [id, ...order.slice(0, at), ...order.slice(at + 1)];
}

/** #124 横向落点：`x` 落在哪一颗标签、插在它前面还是后面。 */
export interface TabHit {
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
 * #174 松手后的新 order；`null` = 松在原处（落点就是它的现位置），一个字都不用发。
 *
 * 只在**可见段**里搬 `id` 一颗：折叠组没有 DOM，谁也不该把它们拖进来（#172 R14 / R21）。落点是可见段里的
 * 一颗（`tabHitTest()` 量的是画出来的标签，天然夹在 `[0, max-1]`），插位算完后把「重排过的可见段 +
 * 原封不动的折叠段」整份交回去。所以拖到最右端 = 排在可见段最后；替位组也能拖，拖完它就从「临时占
 * 最后一格」变成顺序里的一员，被它顶下去的那颗回 ＋N，横条不涨颗数（#172 R18）。拖拽只重排、不增删
 * （#118 R7）。
 */
export function tabReorder(model: TabModel, id: string, hit: TabHit | null): string[] | null {
  if (!hit) return null;
  const at = model.visible.indexOf(id);
  const target = model.visible.indexOf(hit.id);
  if (at < 0 || target < 0 || target === at) return null;
  const next = moveTo(model.visible, id, (at < target ? target - 1 : target) + (hit.side === "after" ? 1 : 0));
  if (next.every((x, i) => x === model.visible[i])) return null;
  return [...next, ...model.more];
}
