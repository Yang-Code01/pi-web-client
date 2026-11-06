/**
 * #121 标签行只画 N 个 + `＋N`。这里只做几何与集合运算（组序 / 固定组 / 名额 / 当前组 → 可见
 * 标签 + 被折叠的组），碰不到 DOM —— 边界（补位、替换、N+1）脱离页面就能核对。
 *
 * `extra` 是 #118 R9 的唯一破例：可见集合已经全是固定组、当前组还在圈外时，多画一颗也要让
 * 「我在哪一组」看得见。其余情况 `visible.length <= max`。
 */

/** #121 本轮名额硬编码；#122 起换成桥端下发的 `max`（1–5，用户可调）。 */
export const TAB_SLOTS = 3;

export interface TabModel {
  /** 标签行依次画哪几组（组 id，顺序即显示顺序）。 */
  visible: string[];
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

  const taken = new Set(pinned.slice(0, max));
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
  return { visible, more, extra };
}
