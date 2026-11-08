/**
 * 隧道状态的两份来源（D197）：`/api/tunnel` 的回包，和 WS `hello` 里带的快照。
 *
 * hello 的快照是**连上那一刻**算出来的：公网页面 socket 频繁重连，一个早于「关掉」发出的
 * hello 会在关掉之后到达。直接盖上去，按钮就从「开公网隧道」翻回「关掉公网隧道」——
 * 桥已经关了，界面还说开着。`updatedAt` 是桥端 `Tunnel.setState()` 盖的时间戳，两边同一个钟，
 * 所以只认更新的那份就够了。
 *
 * Run: node --experimental-transform-types web/tests/tunnel-snapshot-unit.mjs
 */

/** 手里那份与来的一份，取更新的；来的是空/旧的就原样留着。 */
export function newerTunnel<T extends { updatedAt: number }>(prev: T, next: T | null | undefined): T {
  return next && next.updatedAt >= prev.updatedAt ? next : prev;
}
