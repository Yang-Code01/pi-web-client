/**
 * 对端地址的两种用法，口径只留在这里一份：
 * - 比较（「是不是同一台机器」）用 `normAddr`；
 * - 拼 URL（拉图 / 单播）用 `hostForUrl`，IPv6 要带方括号。
 *
 * 以前 discovery.ts / messages.ts 各写了一份 `normAddr`，avatar-files.ts 又抄了一遍
 * 「去 IPv4-mapped、::1 当回环、IPv6 加括号」。三处一旦各自演化，握手的地址和拉图的
 * 地址就会对不上（评审 4）。
 */

/** `::ffff:192.168.1.7` 与 `192.168.1.7` 是同一台机器，比较前先归一。 */
export function normAddr(addr: string): string {
  return addr.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

/** 同一个地址拼进 URL 时要的 host：IPv6 得带方括号，回环与 IPv4-mapped 先归一到 IPv4。 */
export function hostForUrl(addr: string): string {
  const host = normAddr(addr);
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
