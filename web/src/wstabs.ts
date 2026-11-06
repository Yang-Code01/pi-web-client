/**
 * #121 标签行只画 N 个 + `＋N`；#124 再加横向落点与固定组重排。这里只做几何与集合运算（组序 /
 * 固定组 / 名额 / 当前组 → 可见标签 + 被折叠的组 + 拖动落点），碰不到 DOM —— 边界（补位、替换、
 * N+1、左半 / 右半）脱离页面就能核对。
 *
 * `extra` 是 #118 R9 的唯一破例：可见集合已经全是固定组、当前组还在圈外时，多画一颗也要让
 * 「我在哪一组」看得见。其余情况 `visible.length <= max`。
 */

import { moveTo } from "./drag.ts";

/** 名额的兜底值：桥端没下发 `max`（旧桥 / 还没连上）时按 3 画。权威值在桥端 `Workspaces.max`。 */
export const TABS_DEFAULT = 3;

export interface TabModel {
  /** 标签行依次画哪几组（组 id，顺序即显示顺序）。 */
  visible: string[];
  /** `visible` 里属于固定组的那一段（前缀）；#124 只有这几颗能拖。 */
  fixed: string[];
  /** 收进 `＋N` 的组，仍是左栏组序。 */
  more: string[];
  /** `visible.length === max + 1`：为当前组多画了一颗（#118 R9）。 */
  extra: boolean;
}

export function tabModel(o: { order: string[]; pinned: string[]; max: number; current?: string }): TabModel {
  const max = Number.isFinite(o.max) ? Math.max(0, Math.trunc(o.max)) : 0;
  const inOrder = new Set(o.order);
  // 坏文件里的脏 id / 重复 id 在这里就剔掉：渲染层只该看到存在的组。
  const pinned: string[] = [];
  for (const id of o.pinned) if (inOrder.has(id) && !pinned.includes(id)) pinned.push(id);

  const head = pinned.slice(0, max);
  const taken = new Set(head);
  const visible = [...taken];
  // 按左栏组序补位到名额 —— 补位排在固定组后面，固定组的位置不会被活动时间挤走。
  for (const id of o.order) {
    if (visible.length >= max) break;
    if (taken.has(id)) continue;
    taken.add(id);
    visible.push(id);
  }

  // 当前组必须看得见：挤掉最后一个**补位**组（固定组不动）；一个补位都没有就往后追一颗。
  const pinnedSet = new Set(pinned);
  const current = o.current && inOrder.has(o.current) ? o.current : null;
  let extra = false;
  if (current && !taken.has(current)) {
    let at = -1;
    for (let i = visible.length - 1; i >= 0; i--) {
      if (!pinnedSet.has(visible[i])) {
        at = i;
        break;
      }
    }
    if (at >= 0) visible[at] = current;
    else {
      visible.push(current);
      extra = true;
    }
  }

  const shown = new Set(visible);
  const more: string[] = [];
  for (const id of o.order) {
    if (shown.has(id)) continue;
    shown.add(id);
    more.push(id);
  }
  // 固定组永远占 visible 的前缀（补位只往后排、当前组只挤补位），所以拖动的那几颗就是这一段。
  return { visible, fixed: head, more, extra };
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
 * #124 松手后的固定组新顺序；`null` = 松在原处（落点就是它的现位置），一个字都不用发。
 * 只搬 `id` 一颗，其余顺序不动 —— 拖拽只重排、不增删（#118 R7）。
 */
export function tabReorder(pinned: readonly string[], id: string, hit: TabHit | null): string[] | null {
  if (!hit || hit.id === id) return null;
  const at = pinned.indexOf(id);
  const target = pinned.indexOf(hit.id);
  if (at < 0 || target < 0) return null;
  const next = moveTo(pinned, id, (at < target ? target - 1 : target) + (hit.side === "after" ? 1 : 0));
  return next.every((x, i) => x === pinned[i]) ? null : next;
}
