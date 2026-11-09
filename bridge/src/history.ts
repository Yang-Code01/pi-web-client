import { oneLine, type Item } from "./items.ts";

/** 一页历史多少条（#218：60 是手感值 —— 一屏上下能读到几轮，首帧又不会超过两百 KB）。 */
export const HISTORY_PAGE_SIZE = 60;

/** 轮次索引里一行文字的宽度：刻度带旁边只放得下一句短话（#242）。 */
const TURN_TEXT_MAX = 80;

/** 整段会话的一轮（#242）：一条用户消息算一轮，`items` 里的用户条目按原顺序各占一条。 */
export interface HistoryTurn {
  /** 这条用户消息在条目流里的 id，与 `items` 里的 id 对得上。 */
  id: string;
  /** 折成一行、超过 `TURN_TEXT_MAX` 截断后的正文；图片只报张数，不占字。 */
  text: string;
  images: number;
}

/** `session` 帧里跟着 `items` 一起下发的元数据。 */
export interface SessionHistory {
  hasMore: boolean;
  total: number;
  /**
   * 整段会话的轮次索引（#242），不只是这一页的。声明成可选是为了「新前端连老桥」：
   * 老桥没有这个字段；桥上永远填，没有轮次就是 `[]`。
   */
  turns?: HistoryTurn[];
}

/** 整段会话的轮次索引：`items` 里的用户消息按原顺序，每条一轮。 */
function turnIndex(items: Item[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const item of items) {
    if (item.kind !== "user") continue;
    turns.push({ id: item.id, text: oneLine(item.text, TURN_TEXT_MAX), images: item.images.length });
  }
  return turns;
}

export interface HistoryPage extends SessionHistory {
  items: Item[];
}

/** 一帧整页历史的正文（`items` / `session` 帧共用）。 */
export interface HistoryFrame {
  items: Item[];
  history: SessionHistory;
}

/** `history.before` 的响应体（协议见 #220）。 */
export interface HistorySlice {
  items: Item[];
  hasMore: boolean;
}

function pageSize(limit: number | undefined): number {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return HISTORY_PAGE_SIZE;
  return Math.min(HISTORY_PAGE_SIZE, Math.max(1, n));
}

/**
 * 页首尽量落在用户消息上：先看 `[末页起点, end)` 里**最早**的那条用户消息；
 * 窗口里没有，就往前找最近的一条（工具调用再密，这一页也带回它开头那句用户消息，
 * 界面上不会从半句工具输出开始）；一条用户消息都没有才按条数切。
 */
function pageStart(items: Item[], end: number, limit: number): number {
  const cut = Math.max(0, end - limit);
  for (let i = cut; i < end; i++) if (items[i].kind === "user") return i;
  for (let i = cut - 1; i >= 0; i--) if (items[i].kind === "user") return i;
  return cut;
}

/**
 * 末尾一页：打开 / 切换 / 新建会话时 `session` 帧带的就是它。
 */
export function tailPage(items: Item[], limit = HISTORY_PAGE_SIZE): HistoryPage {
  const start = pageStart(items, items.length, pageSize(limit));
  return { items: items.slice(start), hasMore: start > 0, total: items.length, turns: turnIndex(items) };
}

/**
 * 整页帧的正文。普通会话是末尾一页；`full` 是随手问 —— 它没有「载入更早」的入口
 * （spec #218 Out of Scope），超过一页也只能整段下发，否则前面的话会静默消失。
 */
export function itemsFrame(items: Item[], opts: { full?: boolean } = {}): HistoryFrame {
  if (opts.full) return { items, history: { hasMore: false, total: items.length, turns: turnIndex(items) } };
  const page = tailPage(items);
  return { items: page.items, history: { hasMore: page.hasMore, total: page.total, turns: page.turns } };
}

/**
 * 游标 `before`（当前页第一条的 id）之前那一页。游标找不到（会话被截断 / 换了一条）
 * 就回空页 + `hasMore: false`，不报错 —— 那是协议约定的「没有更早的了」。
 */
export function pageBefore(items: Item[], before: string, limit = HISTORY_PAGE_SIZE): HistorySlice {
  const end = items.findIndex((it) => it.id === before);
  if (end < 0) return { items: [], hasMore: false };
  const start = pageStart(items, end, pageSize(limit));
  return { items: items.slice(start, end), hasMore: start > 0 };
}
