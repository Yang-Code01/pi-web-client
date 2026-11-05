/**
 * #102：重画后的焦点归还状态机（键盘等价）。
 *
 * 一次键盘动作（Alt+方向键挪卡、折叠组）之后会连来一次或多次 `renderSessions()`：本地重排 /
 * 折叠自己画一次，`ws.move` 还会等 `workspaces` + `sessions.list` 两条回执各画一次。每次重画
 * 都换掉整棵 DOM，把焦点甩回 body，所以重画完要把焦点还回去 —— 但只还得有次数：pending 带着
 * 一份「消费预算」，每消费一次（焦点真落到卡 / 组头上）预算减一，见底即清。预算见底之后，
 * 任何普通重画（改名、收推送……）都不再抢焦点，不会把正要打字的 rename 输入框顶掉。
 *
 * 纯函数、不碰 DOM：查节点由调用方传入（`lookup`），方便脱离页面单测。
 */

/** 一次焦点归还请求：目标 id + 剩余可消费次数。 */
export interface PendingFocus {
  id: string;
  budget: number;
}

export type PendingFocusKind = "card" | "ws";

export interface PendingFocusState {
  card: PendingFocus | null;
  ws: PendingFocus | null;
}

/** 一次手势会连来几次重画，pending 就该能被消费几次：卡是两条回执，组头折叠是本地一次。 */
export function focusBudget(kind: PendingFocusKind): number {
  return kind === "card" ? 2 : 1;
}

/** 键盘动作发起时武装一个归还目标。一次手势只有一个目标，后按的赢（顺手清掉另一种）。 */
export function armFocus(kind: PendingFocusKind, id: string): PendingFocusState {
  return kind === "card"
    ? { card: { id, budget: focusBudget("card") }, ws: null }
    : { card: null, ws: { id, budget: focusBudget("ws") } };
}

export interface FocusOutcome {
  /** 这次该拿焦点的节点；null = 没有 pending 或目标已不在树里。 */
  focus: HTMLElement | null;
  /** 消费后的新状态（预算扣减 / 落空清除），调用方原样存回去。 */
  next: PendingFocusState;
}

/** 消费一次：卡片优先（移动 / 重排后），组头次之（折叠 / 展开后）。 */
export function consumeFocus(
  state: PendingFocusState,
  lookup: (kind: PendingFocusKind, id: string) => HTMLElement | null,
): FocusOutcome {
  let next = state;
  for (const kind of ["card", "ws"] as const) {
    const pending = state[kind];
    if (!pending) continue;
    const node = lookup(kind, pending.id);
    if (!node) {
      // 目标不在这棵树里：真没了（会话删除 / 收进归档 / 组没了），落空清掉。
      next = { ...next, [kind]: null };
      continue;
    }
    const budget = pending.budget - 1;
    return {
      focus: node,
      next: { ...next, [kind]: budget > 0 ? { id: pending.id, budget } : null },
    };
  }
  return { focus: null, next };
}
