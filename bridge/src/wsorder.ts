/**
 * #478 新工作区「按天插位」：只做排序的纯函数，不碰会话、不碰磁盘。
 *
 * 规则（见 issue #478 / D290）：新组只在**第一次出现**时按天插一次 —— 插到「第一个比它旧的组」
 * 之前，也就是落进同一天那一档的末尾；已有组的相对顺序一个都不动。之后顺序归 `order`
 * （拖动 / 移到最前 / 名额），别人的会话今天动过也不会把老组挪上去。
 */

/**
 * 本地日历日 → 整数键（例：`20261117`）。
 *
 * 用年/月/日三元组拼，不用 `ms / 86400000`：那个常数假定每天正好 24 小时，夏令时切换那天会差一天。
 * 「日」的定义是桥所在机器的本地时区，不看浏览器时区。
 */
export function dayKey(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * 把 `id` 插到「第一个比 `anchorDay` 旧的组」之前；没有更旧的组就追加末尾。
 *
 * - `id` 已经在 `order` 里：原样返回（命中已有组不改顺序）。
 * - `dayOf` 查不到的组按最旧处理（空组天然排在有活动的组后面）。
 * - 稳定插入：除新组这一颗，其余组的相对顺序原封不动。
 */
export function insertByDay(
  order: readonly string[],
  id: string,
  anchorDay: number,
  dayOf: (groupId: string) => number,
): string[] {
  if (order.includes(id)) return [...order];
  const at = order.findIndex((groupId) => (dayOf(groupId) ?? -Infinity) < anchorDay);
  const next = [...order];
  next.splice(at < 0 ? next.length : at, 0, id);
  return next;
}
