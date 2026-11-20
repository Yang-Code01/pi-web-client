// 加班申请提醒：到点弹系统通知。
//
// 分两块：
//   1. 纯函数（下面这一组）：给定规则和当前时间，算「现在该不该发」。不碰文件、不碰网络，
//      所以能在 Node 里直接 import 出来跑单测。
//   2. 落盘 + 定时器（文件后半段）：读 reminder.json，每 30 秒问一次纯函数。
//
// 「当天补一次」是这个模块的核心取舍：bridge 不一定一直在跑（重启、关机），
// 错过时间点在当天补发一次，但同一天绝不重复——去重靠 lastFiredDate。

import { dateKey } from "./attendance-model.ts";
import { readJson, statePath, writeJson } from "./paths.ts";

export interface ReminderRule {
  enabled: boolean;
  /** ISO 星期：1 = 周一 … 7 = 周日。存数字而不是「周一」是为了能排序、能跨语言。 */
  days: number[];
  /** "HH:MM"，24 小时制。 */
  time: string;
  text: string;
}

export interface ReminderRecord {
  rule: ReminderRule;
  /** 最近一次「该发并且发了」的那天（即今天不重复发的依据）。 */
  lastFiredDate: string;
  /** 最近一次的实际情况：几点发的、推到了几台设备。 */
  lastFiredAt: string;
  lastSent: number;
}

export const REMINDER_TITLE = "加班申请提醒";
export const DEFAULT_REMINDER_TEXT = "该提交本周的加班申请了";
export const MAX_REMINDER_TEXT = 200;
/**
 * 系统通知的 tag：推送（sw.js）和页面自己弹的那条用同一个，系统只留一条，不会叠两遍。
 */
export const REMINDER_TAG = "pi-attendance-reminder";

export const DEFAULT_RULE: ReminderRule = {
  enabled: false,
  days: [5],
  time: "18:00",
  text: DEFAULT_REMINDER_TEXT,
};

function reminderFile(): string {
  return statePath("attendance", "reminder.json");
}

/** ISO 星期：周日是 7，不是 0 —— 和界面上「一二三四五六日」的排法一致。 */
export function weekdayOfDate(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 7 : day;
}

/** "18:00" → 1080。不认形状就回 null（不要拿 NaN 去比较）。 */
export function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function clockOfMinutes(minutes: number): string {
  const total = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 把页面递上来的东西收拾干净。认不出来的字段退回 base，
 * 所以「只改一个字段」的请求也不会把别的字段洗成默认值。
 */
export function normalizeRule(input: unknown, base: ReminderRule = DEFAULT_RULE): ReminderRule {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ReminderRule = { ...base, days: [...base.days] };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.text === "string") {
    // 清空等于「没写」，回落上一版 —— 存一个空标题只会让人以为提醒坏了。
    const text = raw.text.trim().slice(0, MAX_REMINDER_TEXT);
    if (text) out.text = text;
  }
  if (typeof raw.time === "string") {
    const minutes = minutesOf(raw.time);
    if (minutes !== null) out.time = clockOfMinutes(minutes);
  }
  if (Array.isArray(raw.days)) {
    const days = raw.days
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    out.days = Array.from(new Set(days)).sort((a, b) => a - b);
  }
  return out;
}

/**
 * 返回人话；null 表示这条规则可以存。
 *
 * 关着的时候不挑毛病：先关掉、回头再填也是正当用法，不该拦着不让存。
 */
export function ruleProblem(rule: ReminderRule): string | null {
  if (!rule.enabled) return null;
  if (rule.days.length === 0) return "至少选一个星期";
  if (minutesOf(rule.time) === null) return "时间要写成 HH:MM";
  if (!rule.text.trim()) return "提示内容不能空";
  return null;
}

export interface ReminderDue {
  /** 现在该发吗。 */
  fire: boolean;
  /** 已经过了设定的点（说明是「补发」而不是「准点」）。 */
  late: boolean;
  /** 这条规则今天的计划时刻，形如 "2026-11-20T18:00"。不补发时用来告诉用户「本该几点」。 */
  scheduled: string;
  /** 距离计划时刻多少分钟。负数表示还没到。 */
  offsetMinutes: number;
}

/**
 * 该不该发：今天轮到 → 今天还没发过 → 已经过了点。
 *
 * `lastFiredDate` 只在日期相同的时候才有意义，所以这里直接比字符串。
 */
export function reminderDue(rule: ReminderRule, lastFiredDate: string, now: Date): ReminderDue {
  const today = dateKey(now);
  const scheduled = `${today}T${rule.time}`;
  const base: ReminderDue = { fire: false, late: false, scheduled, offsetMinutes: 0 };
  if (!rule.enabled) return base;
  if (ruleProblem(rule)) return base;
  if (!rule.days.includes(weekdayOfDate(now))) return base;
  const target = minutesOf(rule.time);
  if (target === null) return base;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const offsetMinutes = nowMinutes - target;
  base.offsetMinutes = offsetMinutes;
  if (offsetMinutes < 0) return base;
  if (lastFiredDate === today) return base;
  // 准点那一分钟内算「准点」，再往后就是开机补发。
  return { ...base, fire: true, late: offsetMinutes > 0 };
}

/** 通知正文：补发时把「本该几点」说清楚，免得以为系统抽风。 */
export function reminderBody(rule: ReminderRule, late: boolean): string {
  return late ? `${rule.text}（今天 ${rule.time} 的提醒）` : rule.text;
}

export function readReminder(): ReminderRecord {
  const raw = readJson<Partial<ReminderRecord> | null>(reminderFile(), null);
  const rule = normalizeRule(raw?.rule ?? {}, DEFAULT_RULE);
  return {
    rule,
    lastFiredDate: typeof raw?.lastFiredDate === "string" ? raw.lastFiredDate : "",
    lastFiredAt: typeof raw?.lastFiredAt === "string" ? raw.lastFiredAt : "",
    lastSent: Number(raw?.lastSent ?? 0) || 0,
  };
}

export function writeReminder(rec: ReminderRecord): void {
  writeJson(reminderFile(), rec);
}

/** 只用到 push / enabled / subscriptionCount，单测里塞个假的就够。 */
export interface ReminderSink {
  enabled: boolean;
  subscriptionCount: () => number;
  push: (
    title: string,
    body: string,
    url: string,
    force?: boolean,
    extra?: { tag?: string; sticky?: boolean },
  ) => Promise<{ sent: number; failed: number }>;
}

export interface ReminderLoopOptions {
  notifier: ReminderSink;
  /** 通知点开时打开的地址。 */
  url: () => string;
  log?: (line: string) => void;
  /**
   * 到点时同时告诉正开着的页面（D349）：Web Push 在「页面就在眼前」时可能被浏览器 / 旧 sw 吞掉，
   * 页面自己再弹一条系统通知 + 页内提示，保证任何情况下都看得到。
   */
  onFire?: (title: string, body: string) => void;
  /** 单测用的短间隔。 */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * 起一个每 30 秒问一次的循环，返回停掉它的函数。
 *
 * 立刻跑第一次：这样「开机时已经过了点」能当场补发，不用等到下一个整 30 秒。
 */
export function startReminderLoop(opts: ReminderLoopOptions): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const now = opts.now ?? (() => new Date());
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const rec = readReminder();
      const at = now();
      const due = reminderDue(rec.rule, rec.lastFiredDate, at);
      if (!due.fire) return;
      const body = reminderBody(rec.rule, due.late);
      // 先把「今天发过了」落盘再发：桥中途被杀也不会重启后补第二遍。
      writeReminder({
        rule: rec.rule,
        lastFiredDate: dateKey(at),
        lastFiredAt: new Date().toISOString(),
        lastSent: rec.lastSent,
      });
      try {
        opts.onFire?.(REMINDER_TITLE, body);
      } catch {
        /* 页面通道坏了不影响推送 */
      }
      const result = await opts.notifier
        .push(REMINDER_TITLE, body, opts.url(), true, { tag: REMINDER_TAG, sticky: true })
        .catch(() => ({ sent: 0, failed: 0 }));
      writeReminder({
        rule: rec.rule,
        lastFiredDate: dateKey(at),
        lastFiredAt: new Date().toISOString(),
        lastSent: result.sent,
      });
      opts.log?.(`attendance reminder fired${due.late ? " (补发)" : ""}: sent ${result.sent}, failed ${result.failed}`);
    } catch (err) {
      opts.log?.(`attendance reminder failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // 别因为一个纯定时器把进程吊着不退出。
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
