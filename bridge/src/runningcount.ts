/**
 * 「现在有几个会话真在跑」——热部署对话框上那个数字。
 *
 * 为什么不是 `list().filter(s => s.running)`：`list()` 是从磁盘扫出来的展示列表，壳里换过脑之后
 * 新脑的会话是 adopt 出来的，`running` 由壳的 turnActive 恢复；展示列表里那些没进程的条目
 * 即使标着 running 也不算「在跑」。这里只认「有活进程 + 这一轮没结束」。
 */
export interface RunningProbe {
  live: boolean;
  state: { running: boolean };
}

export function countRunning(sessions: Iterable<RunningProbe>): number {
  let n = 0;
  for (const s of sessions) if (s.live && s.state.running) n++;
  return n;
}
