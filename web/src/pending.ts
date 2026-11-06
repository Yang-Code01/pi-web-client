/**
 * 列表里那两个「待处理」数字（待回答 / 待确认）怎么维护、画之前以谁为准（D156）。
 *
 * 桥只在计数变化时发 `approval.add|remove`、`ask.add|remove`，不补一条新的 `session.state`
 * （见 `bridge/src/sessions.ts` 的 ask / approval 段落），所以列表里那两个数字全靠前端跟着
 * 事件自己加减。规则只有三条，写在这里而不是散在 `app.ts` 的分支里：
 *
 * 1. **按类型分开**：提问只加 `asks`，批准只加 `approvals` —— 早先一律塞进 `approvals`，
 *    于是答完的提问在卡上顶着「待确认」。
 * 2. **add / remove 对称**：当前会话也照加照减。本地队列（`this.asks` / `this.approvals`）
 *    是当前会话的另一份账，`approval.remove` 曾经只给「不在看的会话」减数，切过去再答就永远
 *    清不掉。
 * 3. **画当前会话时以本地队列为准**：本地队列在订阅快照和作答时会重置，比列表里那份累加值新。
 *    快照还没回来的那一小段（刚 `openSession`、队列已被清空）例外，见 `App.pendingFresh`。
 *    列表那份留给组头角标、钉条和别的会话来事时的卡片；删除护栏只读 `approvals`
 *    （`App.busy()`，与桥端 `sessions.ts` 的 `trash()` 一致），不读这里的 `asks`。
 */
import type { SessionState } from "./types.ts";

export type PendingKind = "approvals" | "asks";

/** 当前会话自己的两份队列长度（`App.approvals` / `App.asks`）。 */
export interface PendingCounts {
  approvals: number;
  asks: number;
}

function findSession(sessions: SessionState[], id: string): SessionState | undefined {
  return sessions.find((s) => s.id === id);
}

/** 一条事件落地：`sessionId` 那行的对应计数 `+delta`。找不到会话就什么都不做，结果夹在 ≥0。 */
export function applyPending(sessions: SessionState[], sessionId: string, kind: PendingKind, delta: number): void {
  const s = findSession(sessions, sessionId);
  if (!s) return;
  s[kind] = Math.max(0, (s[kind] ?? 0) + delta);
}

/** 订阅快照到了：列表里那条直接换成快照里的队列长度 —— 快照是权威值，累加值只是它的影子。 */
export function syncPending(sessions: SessionState[], sessionId: string, counts: PendingCounts): void {
  const s = findSession(sessions, sessionId);
  if (!s) return;
  s.approvals = counts.approvals;
  s.asks = counts.asks;
}

/**
 * 画徽标用的那份会话：当前会话换成本地队列的长度，别的会话原样返回（可以直接读那份累加值）。
 * 返回的可能是同一个对象，调用方不许就地改。
 */
export function badgeSession(s: SessionState, currentId: string | null, local: PendingCounts): SessionState {
  if (!currentId || s.id !== currentId) return s;
  return { ...s, approvals: local.approvals, asks: local.asks };
}
