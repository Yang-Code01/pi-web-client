/**
 * 会话徽标（左栏卡片右下 / ★ 行胶囊 / 会话管理 / 工作区浮层）的**唯一**判定（D453）。
 *
 * 这一格只有一个：所以顺序就是全部的价值 —— 说错一格，用户就会把「评审还在跑」当成
 * 「已经收工」，或者被一枚不阻塞的「评审中」盖住正在等他的问卷。
 *
 * 顺序（左 > 右）：待回答 > 待确认 > 终端占用 > 运行中 > 后台 > 评审中 > 完成。
 * - 「在等你」永远先说：那两档要人动手。
 * - `running` 只说「pi 进程在忙」：审批 / 问卷在等时它也常常是 true，所以更要排在后面。
 * - 后台子代理（D170）：会话自己 settle 了、派出去的 runner 还在跑，pi 回来会接着做 —— 排评审前面。
 * - 评审（D453）：detached worker（D446），会话早就完成也可能还在评 —— 只压过「完成」与空位。
 *
 * 纯函数：DOM 由 `app.ts` 的 `badgeChip()` 抹上去，点开去哪也由它决定（`kind`）。
 * 单测 `web/tests/session-badge-unit.mjs` 只测这一层；画与点在 `probes/round9-badges.mjs` 里把关。
 */
import { bgBusy } from "./continue-state.ts";
import { tr } from "./i18n/index.ts";

export type BadgeKind = "ask" | "approve" | "locked" | "run" | "bg" | "review" | "done";

export interface SessionBadge {
  kind: BadgeKind;
  text: string;
  cls: "wait" | "lock" | "run" | "reviewing" | "done";
  title: string;
  /** Blocked on the user — worth calling out in the pin strip header. */
  pending: boolean;
  /**
   * 点得开的两枚：`bg`（看后台任务详情）与 `review`（切到那个会话 + 右栏代码评审）。
   * 「完成 / 运行中 / 在等你」都只是读数，点了不该有别的意思。
   */
  clickable: boolean;
}

/**
 * 只借 `SessionState` 里与这一格有关的几项。全部可缺省：旧桥少发一个字段不该让徽标变样。
 * 反过来也得记住，**缺字段时是静默降级**（少一档徽标，不会编译不过）—— 改名 / 挪字段时，
 * 这里和 `web/tests/session-badge-unit.mjs` 要一起看到。
 */
export interface BadgeSession {
  asks?: number;
  approvals: number;
  locked?: boolean;
  running: boolean;
  done: boolean;
  /** D170：后台子代理（`n` 缺省按 0）。 */
  bg?: { n?: number; agent?: string } | null;
  /** D453：这个会话在跑几条评审（旧桥不发 = 0）。 */
  review?: number | null;
}

/**
 * D162: 「完成」也显示在**当前打开的会话**上 —— 打开只是看，不再把完成抹掉。否则用户点开确认
 * 一眼，卡片就从「完成」退回时间，再也没法从列表判断这一轮到底结束了没有。
 */
export function sessionBadge(s: BadgeSession): SessionBadge | null {
  if (s.asks && s.asks > 0) {
    return {
      kind: "ask",
      text: s.asks > 1 ? tr("待回答 {p1}", { p1: s.asks }) : tr("待回答"),
      cls: "wait",
      title: tr("在等你回答问卷，这个会话停在这儿了"),
      pending: true,
      clickable: false,
    };
  }
  if (s.approvals > 0) {
    return {
      kind: "approve",
      text: s.approvals > 1 ? tr("待确认 {p1}", { p1: s.approvals }) : tr("待确认"),
      cls: "wait",
      title: tr("在等你确认这条命令"),
      pending: true,
      clickable: false,
    };
  }
  if (s.locked) {
    return {
      kind: "locked",
      text: tr("终端占用"),
      cls: "lock",
      title: tr("pi CLI 在终端里正用着这个会话，网页这边只能看"),
      pending: false,
      clickable: false,
    };
  }
  if (s.running) {
    return { kind: "run", text: tr("运行中"), cls: "run", title: tr("agent 正在推进"), pending: false, clickable: false };
  }
  // D170: 会话自己 settle 了，派出去的 runner 还在跑 —— 「完成」是假的，得先把这枚亮出来。
  if (bgBusy(s)) {
    const n = s.bg?.n ?? 0;
    return {
      kind: "bg",
      text: n > 1 ? tr("后台 {p1}", { p1: n }) : tr("后台"),
      cls: "run",
      title: s.bg?.agent ? tr("子代理 {p1} 还在后台跑，pi 会在它回来时接着做", { p1: s.bg.agent }) : tr("子代理还在后台跑，pi 会在它回来时接着做"),
      pending: false,
      clickable: true,
    };
  }
  // D453: 评审是 detached worker（D446），会话早就完成也可能还在评 —— 不露这一格就等于说「没事了」。
  const reviews = Number(s.review) || 0;
  if (reviews > 0) {
    return {
      kind: "review",
      text: reviews > 1 ? tr("评审中 {p1}", { p1: reviews }) : tr("评审中"),
      cls: "reviewing",
      title: tr("有 {p1} 条评审在跑，点开去右栏「代码评审」看进度", { p1: reviews }),
      pending: false,
      clickable: true,
    };
  }
  if (s.done) return { kind: "done", text: tr("完成"), cls: "done", title: "", pending: false, clickable: false };
  return null;
}
