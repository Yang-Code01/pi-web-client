import type { SessionState } from "./types.ts";

/**
 * 「继续」按钮的三态（D159）。它住在权限按钮正上方那 28.5px 里：权限按钮 44px 贴底，
 * 输入框默认两行 72.5px，空出来的那一截正好放得下一颗 28px 的贴片。
 *
 * 判据全在这里（纯函数，`web/tests/continue-unit.mjs` 只测这一个口），`app.ts` 只负责画和发。
 */
export type ContinueState = "hidden" | "off" | "ready";

/**
 * 只借 `SessionState` 里跟「能不能再接一轮」有关的字段，名字跟着它走 —— 桥那边改名，
 * 这里跟着编译不过，而不是悄悄把 `!s.owned` 变成永远为真（那样按钮会永久消失）。
 * 除 `owned` 外都可缺省：老桥少发一个字段不该把按钮锁死。
 */
export type ContinueSession = Pick<SessionState, "owned"> &
  Partial<Pick<SessionState, "locked" | "running" | "bg">>;

/**
 * - `hidden`：这一页没有写权（只读预览 / 终端里另一个 pi 持锁），发也发不出去 —— 先点「接管会话」。
 *   `locked` 目前只在桥的 `list()` 副本上出现（`bridge/src/sessions.ts` 注释：不许漏进广播的
 *   live state），所以它多半只是个兜底；真正常用的仍是 `owned`。
 * - `off`：正忙着（跑一轮、后台子代理还在跑，D170）—— 点下去是插队多推一轮；
 *   或者这条会话还没有任何用户消息（「继续」无处可接）。
 * - `ready`：可以点。
 *
 * #201 / D178：`starting` 不是灰的理由 —— 启动窗口里发出去的消息照样进桥的待发队列，动作与
 * 平时一样，只是 pi 起来之后才真正开工（D177）。这个按钮只是一个「把继续两个字放进输入框」的
 * 快捷方式，没理由比输入框更早解锁。
 */
export function continueState(s: ContinueSession | null | undefined, hasUserTurns: boolean): ContinueState {
  if (!s || !s.owned || s.locked) return "hidden";
  if (s.running || bgBusy(s) || !hasUserTurns) return "off";
  return "ready";
}

/** 后台子代理在跑（`n` 缺省按 0：老桥不发这个字段）。 */
export function bgBusy(s: ContinueSession | null | undefined): boolean {
  return Boolean(s?.bg && s.bg.n > 0);
}
