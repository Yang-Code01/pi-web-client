/**
 * D389：提醒中心。一条**提醒** = 一件「有人在等你」的事（审批卡 / 问卷 / 脚本塞进来的一句话），
 * 四个归宿：还在等你（`waiting`）、处理完了（`handled`）、已读（`read`，只给非阻塞那种）、
 * 已失效（`stale`，桥重启时还挂着的一律转它 —— 那几个 `pi --mode rpc` 子进程已经死了）。
 *
 * 这里的类**不碰时钟、不碰磁盘**：`now` 与 `save` 都是注入的，`bridge/tests/reminders-unit.mjs`
 * 直接喂它跑逻辑。真磁盘由 `diskReminders()` 接到 `state/reminders.json`。
 *
 * 三条不变量（单测盯着）：
 *  1. 「还没弹过」不能用时间戳表示 —— 否则 0 时刻的第一条吐司会被自己吞掉。
 *  2. 角标与清单读**同一个谓词**：`waiting && !muted`，否则会出现「角标 2、清单 3 条」。
 *  3. 在等的条目**不受** cap 与保留期影响：容量策略不许吞掉「有人在等你」。
 */
import { readJson, statePath, writeJson } from "./paths.ts";

export const REMINDER_KEEP_DAYS = 7;
export const REMINDER_CAP = 500;
export const REMINDER_COALESCE_MS = 30_000;
const DAY = 86_400_000;

export type ReminderKind = "approval" | "ask" | "notice";
export type ReminderState = "waiting" | "handled" | "read" | "stale";
export type ReminderOutcome = "approved" | "rejected" | "answered" | "read" | "stale";

export interface Reminder {
  /** 审批 / 问卷直接复用 pi 那边的 id，重连重放时靠它幂等。 */
  id: string;
  kind: ReminderKind;
  sessionId?: string;
  sessionName: string;
  title: string;
  body: string;
  createdAt: number;
  state: ReminderState;
  outcome?: ReminderOutcome;
  settledAt?: number;
  /** 非阻塞类可以带一条同源路径（脚本说「点开看这里」）；审批 / 问卷永远没有。 */
  url?: string;
}

export interface ReminderSettings {
  /** 页面内提醒总开关：关掉只是不弹，角标照常（D389 第 10 条）。 */
  enabled: boolean;
  /** 阻塞类（审批 / 提问）要不要弹吐司。 */
  blocking: boolean;
  /** 其它（脚本 / 构建 / 定时）要不要弹吐司 —— 默认不弹，只进清单。 */
  others: boolean;
}

export interface ReminderInput {
  id: string;
  kind: ReminderKind;
  sessionId?: string;
  sessionName: string;
  title: string;
  body: string;
  url?: string;
}

export interface ReminderView {
  items: Reminder[];
  muted: string[];
  settings: ReminderSettings;
  badge: number;
}

export interface PersistedReminders {
  items: Reminder[];
  muted: string[];
  settings: ReminderSettings;
  /** 每个会话最后一次弹吐司的时刻。**没有这个键 = 从没弹过**，不能拿 0 当哨兵。 */
  lastToastAt: Record<string, number>;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: true, blocking: true, others: false };

const STATES: ReminderState[] = ["waiting", "handled", "read", "stale"];
const KINDS: ReminderKind[] = ["approval", "ask", "notice"];

function looksLikeReminder(v: unknown): v is Reminder {
  const r = v as Reminder | null;
  return !!r && typeof r.id === "string" && KINDS.includes(r.kind) && STATES.includes(r.state);
}

export interface ReminderOpts {
  now?: () => number;
  save?: (p: PersistedReminders) => void;
  load?: () => PersistedReminders | null;
}

export class Reminders {
  private items: Reminder[];
  private mutedIds: Set<string>;
  private settingsValue: ReminderSettings;
  private lastToastAt: Record<string, number>;
  private readonly clock: () => number;
  private readonly persist: (p: PersistedReminders) => void;

  constructor(opts: ReminderOpts = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.persist = opts.save ?? (() => {});
    const loaded = opts.load?.() ?? null;
    this.items = Array.isArray(loaded?.items) ? loaded.items.filter(looksLikeReminder) : [];
    this.mutedIds = new Set(Array.isArray(loaded?.muted) ? loaded.muted.filter((x): x is string => typeof x === "string") : []);
    this.settingsValue = { ...DEFAULT_REMINDER_SETTINGS, ...(loaded?.settings ?? {}) };
    this.lastToastAt = { ...(loaded?.lastToastAt ?? {}) };
    this.prune();
  }

  /** 来了一件「有人在等你」的事。返回这条提醒、以及要不要弹一条吐司。 */
  add(input: ReminderInput): { reminder: Reminder; toast: boolean } {
    const existing = this.items.find((r) => r.id === input.id);
    if (existing) return { reminder: existing, toast: false };

    const now = this.clock();
    const reminder: Reminder = {
      id: input.id,
      kind: input.kind,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      sessionName: input.sessionName,
      title: input.title,
      body: input.body,
      createdAt: now,
      state: "waiting",
      ...(input.url ? { url: input.url } : {}),
    };
    this.items.unshift(reminder);
    const toast = this.takeToast(input, now);
    this.commit();
    return { reminder, toast };
  }

  private takeToast(input: ReminderInput, now: number): boolean {
    if (!this.settingsValue.enabled) return false;
    if (!(input.kind === "notice" ? this.settingsValue.others : this.settingsValue.blocking)) return false;
    if (this.muted(input.sessionId)) return false;
    const key = input.sessionId ?? "notice";
    const last = this.lastToastAt[key];
    if (last !== undefined && now - last < REMINDER_COALESCE_MS) return false;
    this.lastToastAt[key] = now;
    return true;
  }

  /** 批了 / 拒了 / 答了 / 取消（取消算失效，不算处理完）。 */
  settle(id: string, decision: string): void {
    const outcome = outcomeOf(decision);
    const at = this.clock();
    for (const r of this.items) {
      if (r.id !== id || r.state !== "waiting") continue;
      r.state = outcome === "stale" ? "stale" : "handled";
      r.outcome = outcome;
      r.settledAt = at;
    }
    this.commit();
  }

  /** 非阻塞那种「点一下就消」。审批与问卷点开不算处理过（那得真去批 / 真去答）。 */
  read(id: string): void {
    const at = this.clock();
    for (const r of this.items) {
      if (r.id !== id || r.state !== "waiting" || r.kind !== "notice") continue;
      r.state = "read";
      r.outcome = "read";
      r.settledAt = at;
    }
    this.commit();
  }

  mute(sessionId: string, on: boolean): void {
    if (on) this.mutedIds.add(sessionId);
    else this.mutedIds.delete(sessionId);
    this.commit();
  }

  muted(sessionId: string | undefined): boolean {
    return !!sessionId && this.mutedIds.has(sessionId);
  }

  /** 桥重启：还挂着的一律失效。 */
  markStaleAll(): void {
    const at = this.clock();
    for (const r of this.items) {
      if (r.state !== "waiting") continue;
      r.state = "stale";
      r.outcome = "stale";
      r.settledAt = at;
    }
    this.commit();
  }

  settings(): ReminderSettings {
    return { ...this.settingsValue };
  }

  setSettings(partial: Partial<ReminderSettings>): ReminderSettings {
    this.settingsValue = { ...this.settingsValue, ...partial };
    this.commit();
    return this.settings();
  }

  view(): ReminderView {
    return {
      items: this.items.map((r) => ({ ...r })),
      muted: [...this.mutedIds],
      settings: this.settings(),
      badge: this.badge(),
    };
  }

  /** 角标 = 全部在等的（含当前会话），去掉静音的。清单读的是同一个谓词。 */
  badge(): number {
    return this.items.filter((r) => r.state === "waiting" && !this.muted(r.sessionId)).length;
  }

  private commit(): void {
    this.prune();
    this.persist({
      items: this.items,
      muted: [...this.mutedIds],
      settings: this.settingsValue,
      lastToastAt: this.lastToastAt,
    });
  }

  /** 保留期与容量只裁「已处理」的；在等的一条都不动。 */
  private prune(): void {
    const cutoff = this.clock() - REMINDER_KEEP_DAYS * DAY;
    const fresh = this.items.filter((r) => r.state === "waiting" || (r.settledAt ?? r.createdAt) >= cutoff);
    const room = Math.max(0, REMINDER_CAP - fresh.filter((r) => r.state === "waiting").length);
    let kept = 0;
    this.items = fresh.filter((r) => {
      if (r.state === "waiting") return true;
      if (kept >= room) return false;
      kept += 1;
      return true;
    });
  }
}

function outcomeOf(decision: string): ReminderOutcome {
  switch (decision) {
    case "approve":
    case "always":
    case "approved":
      return "approved";
    case "reject":
    case "rejected":
      return "rejected";
    case "answered":
      return "answered";
    default:
      return "stale";
  }
}

/** 真磁盘那一位：`state/reminders.json`。读坏就当空的，别把整份历史扔进异常。 */
export function diskReminders(): Reminders {
  const file = statePath("reminders.json");
  return new Reminders({
    load: () => {
      const data = readJson<PersistedReminders | null>(file, null);
      return data && typeof data === "object" ? data : null;
    },
    save: (p) => writeJson(file, p),
  });
}
