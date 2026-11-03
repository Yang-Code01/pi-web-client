/**
 * D110: 界面语言。字典的键是**中文原文**（gettext 风格），中文直接返回键本身，只有 en / ja 需要
 * 词典。`|ctx` 后缀用来在「同一个中文、两种英文」时消歧（例如「关闭|toggle」），后缀不参与展示。
 *
 * 加一门外语要动的地方：`Lang` 联合类型、`DICTS`、`LOCALES`、`web/src/i18n-check.mjs` 的键集合
 * 比对，以及 `docs/I18N.md` 的术语表。
 */

export type Lang = "zh-Hans" | "en" | "ja";

/** 三处出现顺序 = 设置面板里 chip 的顺序。 */
export const LANGS: [Lang, string][] = [
  ["zh-Hans", "简体中文"],
  ["en", "English"],
  ["ja", "日本語"],
];

export type Params = Record<string, string | number>;

/** 值可以是模板串，也可以是函数（英文复数、日文量词这类没法用一条模板糊过去的地方）。 */
export type Entry = string | ((params: Params) => string);
export type Dict = Record<string, Entry>;

import { en } from "./en.ts";
import { ja } from "./ja.ts";

const DICTS: Record<Lang, Dict> = { "zh-Hans": {}, en, ja };

/** Intl 用的区域码：中文固定简体，英文用 en（不站队 en-US 的 12 小时制，时间另外显式给 hourCycle）。 */
const LOCALES: Record<Lang, string> = { "zh-Hans": "zh-CN", en: "en", ja: "ja-JP" };

let lang: Lang = "zh-Hans";
const listeners = new Set<() => void>();
const warned = new Set<string>();

/** 首次打开时用：跟浏览器，认不出的语言给英文。zh-Hant / zh-TW 也落简体（见 docs/I18N.md 限制）。 */
export function detectLang(): Lang {
  const list = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const raw of list) {
    const tag = String(raw).toLowerCase();
    if (tag.startsWith("zh")) return "zh-Hans";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function isLang(value: unknown): value is Lang {
  return value === "zh-Hans" || value === "en" || value === "ja";
}

export function getLang(): Lang {
  return lang;
}

export function onLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 只改状态 + 通知订阅者；写 prefs 和重渲染由调用方负责（它能一次改完再画）。 */
export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  for (const fn of listeners) fn();
}

/** `<html lang>` 与 Intl 的当前值，启动时调一次。 */
export function applyLang(next: Lang): void {
  lang = next;
  document.documentElement.lang = next;
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/**
 * `tr("已保存 · {time}", { time })`。词典没命中时用中文原文兜底（英文界面会出现一句中文，
 * 但不会炸），并在控制台提醒一次 —— `i18n-check.mjs` 会在 CI 里先把这种情况拦掉。
 *
 * 名字是 `tr` 不是 `t`：这个仓库里 `t` 已经被当作局部变量用惯了（trust、target、token…），
 * 一个叫 `t` 的 import 会把那几十处的含义偷掉。
 */
export function tr(key: string, params?: Params): string {
  const bare = key.split("|")[0];
  const entry = DICTS[lang]?.[key] ?? DICTS[lang]?.[bare];
  if (entry === undefined) {
    if (lang !== "zh-Hans" && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing ${lang} for: ${key}`);
    }
    return interpolate(bare, params);
  }
  return typeof entry === "function" ? entry(params ?? {}) : interpolate(entry, params);
}

function locale(): string {
  return LOCALES[lang];
}

/** 对话里的时刻：`14:05`。中文/日文 24 小时制，英文也用 24 小时制（时间戳不站队 AM/PM）。 */
export function fmtTime(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** 纯日期：`2026/11/04` 这类，按当前区域。 */
export function fmtDate(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale());
}

export function fmtNum(value: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale(), opts).format(value);
}

/** 相对时间（会话列表的时间戳）。一分钟内用「刚刚」，其余走 Intl.RelativeTimeFormat。 */
export function fmtRelative(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return tr("刚刚");
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  if (diff < 3_600_000) return rtf.format(-Math.floor(diff / 60_000), "minute");
  if (diff < 86_400_000) return rtf.format(-Math.floor(diff / 3_600_000), "hour");
  return fmtDate(ts);
}

/**
 * 后端错误的显示文案：bridge 现在回 `{ error: 中文兜底, code, params }`，认得出的码走词典
 * （`bridge.err.<code>`），认不出就用它自己那句话。
 */
export function errText(err: unknown): string {
  // 两种命名都在用：HTTP 响应走 `{code, params}`（bridge 的 fail()），WS 事件 / 隧道状态走
  // `{errCode, errParams}`（`code` 在那几个 payload 里已经是退出码，占不得）。
  const e = err as { code?: string; params?: Params; errCode?: string; errParams?: Params; message?: string; error?: string } | null | undefined;
  const code = e?.code ?? e?.errCode;
  if (code) {
    const key = `bridge.err.${code}`;
    if (DICTS[lang]?.[key] !== undefined) return tr(key, e?.params ?? e?.errParams);
  }
  return e?.message ?? e?.error ?? tr("出错了");
}
