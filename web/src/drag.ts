/**
 * #99：拖拽整理会话的落点判定。
 *
 * 左栏树和壳 B 的浮层共用这一份：渲染层把「组 / 卡片 / 放回工程」的矩形量出来交给 `hitTest()`，
 * 拿回「目标组 + 插入位置 + 那条 2px 线画在哪」；松手时再用 `planDrop()` 换算成一条 manage 消息。
 *
 * 全是纯函数：没有 DOM、没有 socket。几何的边界条件（组间空隙、空组、末张卡下沿）靠
 * `web/tests/drag-unit.mjs` 测，别用浏览器探针去猜像素。
 *
 * 三件事的分工：
 * - 同组 → `arrange`（沿用既有 `commitArrangement()` 读 DOM 顺序）；
 * - 跨组 → `ws.move`（只写 override；顺序由桥的 order 决定，**不**重写 order 数组，
 *   否则顺手把别的组的顺序也改了）；
 * - 「放回工程」→ `ws.move` 且 `wsId: ""`（桥那边=删掉 override，回到 cwd 推导）。
 */

/** 一张卡片在 viewport 里的纵向占位。 */
export interface DragItem {
  id: string;
  top: number;
  bottom: number;
}

/** 一个工作区在 viewport 里的纵向占位。`contentTop` 是组头下沿（空组的线画在这里）。 */
export interface DragGroup {
  wsId: string;
  top: number;
  bottom: number;
  contentTop: number;
  /** 组里可见的卡片，纵向有序；拖动源自己要在调用前剔除。 */
  items: DragItem[];
}

/** 「放回工程」落点。 */
export interface DragPool {
  top: number;
  bottom: number;
}

export interface DropHit {
  /** 目标工作区 id；落在「放回工程」时为空串。 */
  wsId: string;
  /** 组内插入位置（0 = 最前）；落在「放回工程」时为 -1。 */
  index: number;
  /** 2px 高亮线的纵坐标，与传进来的坐标同一坐标系。 */
  line: number;
  /** true = 落在「放回工程」上。 */
  pool: boolean;
}

export type DropPlan =
  | { action: "reorder"; ids: string[]; wsId: string; index: number }
  | { action: "move"; ids: string[]; wsId: string }
  | { action: "restore"; ids: string[]; wsId: "" };

/**
 * 「这个 y 落在哪一组、插到第几位」。
 *
 * - `pool` 优先：它压在树尾，不能让它附近的组抢走；
 * - 组间那几像素空隙归最近的一组（`slack` 内），避免线一闪一闪；
 * - 离得太远（拖出树、拖到「已归档」区）返回 null，渲染层据此清掉高亮、松手也不动作。
 */
export function hitTest(y: number, groups: DragGroup[], pool?: DragPool | null, slack = 8): DropHit | null {
  if (pool && y >= pool.top && y <= pool.bottom) return { wsId: "", index: -1, line: pool.bottom, pool: true };

  let target = groups.find((g) => y >= g.top && y <= g.bottom);
  if (!target) {
    let best = slack + 1;
    for (const g of groups) {
      const gap = y < g.top ? g.top - y : y > g.bottom ? y - g.bottom : 0;
      if (gap <= slack && gap < best) {
        best = gap;
        target = g;
      }
    }
  }
  if (!target) return null;

  const at = target.items.filter((it) => y > (it.top + it.bottom) / 2).length;
  const line = at < target.items.length ? target.items[at].top : target.items.length ? target.items[target.items.length - 1].bottom : target.contentTop;
  return { wsId: target.wsId, index: at, line, pool: false };
}

/** 松手该发什么。`fromWs` 是拖动源现在所在的组。 */
export function planDrop(id: string, fromWs: string, hit: DropHit): DropPlan {
  if (hit.pool) return { action: "restore", ids: [id], wsId: "" };
  if (hit.wsId !== fromWs) return { action: "move", ids: [id], wsId: hit.wsId };
  return { action: "reorder", ids: [id], wsId: hit.wsId, index: hit.index };
}

/** 把 `id` 挪到「不含它」的列表里的第 `index` 位；结果用于 DOM 摆放与顺序断言。 */
export function moveTo<T extends string>(list: readonly T[], id: T, index: number): T[] {
  const rest = list.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  rest.splice(at, 0, id);
  return rest;
}

/**
 * #102：拖拽的键盘等价。方向键选组、落点换算都走上面同一套，只是把「指针的 y」
 * 换成「树序里相邻的那一组」。树序就是左栏里组的先后（buildTree 的输出序）。
 */

/** 树序里 `wsId` 相邻的组：`dir: 1` 是下一个，`-1` 是上一个；没有（边界 / 不在树里）是 null。 */
export function neighborWs(wsId: string, wsIds: readonly string[], dir: -1 | 1): string | null {
  const at = wsIds.indexOf(wsId);
  if (at < 0) return null;
  const to = at + dir;
  return to >= 0 && to < wsIds.length ? (wsIds[to] ?? null) : null;
}

/**
 * 卡片上 Alt+←/→ 的计划：搬到相邻组 = `planDrop()` 的 move（只写 override，不重排 order，
 * 与指针拖拽跨组同一条路）；到头了返回 null（不动、不发消息）。
 */
export function keyMovePlan(id: string, fromWs: string, wsIds: readonly string[], dir: -1 | 1): DropPlan | null {
  const to = neighborWs(fromWs, wsIds, dir);
  if (!to) return null;
  return planDrop(id, fromWs, { wsId: to, index: 0, line: 0, pool: false });
}

/**
 * 卡片上 Alt+↑/↓ 的目标位：组内插到上一位 / 下一位；已在边上返回 null（不动、不发消息），
 * 不能把 clamp 过的边界误当成「挪成功」。
 */
export function keyShiftIndex(index: number, dir: -1 | 1, count: number): number | null {
  const to = index + dir;
  return to >= 0 && to < count ? to : null;
}
