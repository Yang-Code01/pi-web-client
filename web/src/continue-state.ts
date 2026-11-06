/**
 * 「继续」按钮的三态（D157）。它住在权限按钮正上方那 28.5px 里：权限按钮 44px 贴底，
 * 输入框默认两行 72.5px，空出来的那一截正好放得下一颗 28px 的贴片。
 *
 * 判据全在这里（纯函数，`web/tests/continue-unit.mjs` 只测这一个口），`app.ts` 只负责画和发。
 */
export type ContinueState = "hidden" | "off" | "ready";

/** 只挑 `SessionState` 里跟「能不能再接一轮」有关的字段。 */
export type ContinueSession = {
  owned?: boolean;
  locked?: boolean;
  starting?: boolean;
  running?: boolean;
};

/**
 * - `hidden`：这一页没有写权（只读预览 / 终端里另一个 pi 持锁），发也发不出去 —— 先点「接管会话」。
 * - `off`：pi 起不来或正忙着，或者这条会话还没有任何用户消息（「继续」无处可接）。
 * - `ready`：可以点。
 */
export function continueState(s: ContinueSession | null | undefined, hasUserTurns: boolean): ContinueState {
  if (!s || !s.owned || s.locked) return "hidden";
  if (s.starting || s.running || !hasUserTurns) return "off";
  return "ready";
}
