import type { SessionState } from "./types.ts";

/**
 * 输入框上方那一行「重讲」的三态（D358）。它是 `wait-what` 那套「没看懂就让人重讲一遍」的
 * 常驻入口：不命令模型自己反思，而是把「重讲」变成一个看得见、点一下就发的动作。
 *
 * 判据全在这里（纯函数，`web/tests/retell-state-unit.mjs` 只测这一个口），`app.ts` 只负责画和发。
 */
export type RetellState = "hidden" | "off" | "ready";

/**
 * 只借跟「能不能现在重讲」有关的字段，其余可缺省：老桥少发一个字段不该把按钮锁死。
 * `owned` 不进来 —— 没接管的会话发消息本来就会自动接管（`sendPrompt` 的老规矩），
 * 重讲跟手打一句是同一个动作，没有理由比输入框更早关掉。
 */
export type RetellSession = Partial<Pick<SessionState, "running">>;

/**
 * - `hidden`：没开会话，或者这一条会话还没人答过（新建的空会话 —— 没有可重讲的对象，
 *   一行灰按钮只会占地方）。
 * - `off`：有回答，但这一轮还在跑 —— 半截回答重讲没有意义。
 * - `ready`：可以点。
 */
export function retellState(s: RetellSession | null | undefined, hasAnswer: boolean): RetellState {
  if (!s) return "hidden";
  if (!hasAnswer) return "hidden";
  if (s.running) return "off";
  return "ready";
}
