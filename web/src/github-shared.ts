/**
 * GitHub 通道（#661）：面板与链接卡共用的形状与纯函数。
 *
 * 这里只有类型和纯函数：`web/tests/github-unit.mjs` 要绕开 chat.ts / CSS 直接跑它们，桥那边
 * 的字段名也只在这份里钉一次（`bridge/src/github.ts` 的 `PullRow` 与它逐字对应）。
 */

import { tr } from "./i18n/index.ts";

export interface GhAccountView {
  login: string;
  /** `gh` = 借 gh 的登录态；`pat` = 本工程里存的一枚细粒度令牌。 */
  kind: "gh" | "pat";
  active: boolean;
}

export interface GhSessionAccount {
  login: string;
  kind: "gh" | "pat";
  /** 这个账号是怎么选出来的（界面上说人话用）。 */
  source: "session" | "project" | "global" | "active" | "pat-only" | "none";
}

export interface GithubStateView {
  ok: boolean;
  /** 这台机器有没有真 gh。没有时写操作走壳的内置实现（需要 PAT）。 */
  gh: boolean;
  ghState: "no-gh" | "logged-out" | "ok";
  ghError: string;
  accounts: GhAccountView[];
  /** 存过 PAT 的登录名（与 accounts 去重后仍单独给一份，界面据此打标）。 */
  pats: string[];
  session: GhSessionAccount | null;
  repo: string | null;
  readonly: boolean;
}

export interface PullRow {
  number: number;
  title: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface PullCheck {
  name: string;
  state: string;
}

export interface PullComment {
  author: string;
  body: string;
  at: string;
}

export interface PullDetailView {
  ok: boolean;
  pull: PullRow;
  body: string;
  state: string;
  mergeable: boolean | null;
  files: PullFile[];
  /** 这一版里 checks 与 comments 是示例样本，页面上要如实标注。 */
  sample: { checks: PullCheck[]; comments: PullComment[] };
}

export interface PullsView {
  ok: boolean;
  repo: string;
  login: string | null;
  /** 一个令牌都没有：只能读公开仓库，写操作要在面板里填 PAT。 */
  anonymous: boolean;
  pulls: PullRow[];
}

/** 面板要认的那些 GitHub 链接。与桥的 `seenLinks()` 同一条正则口径。 */
export type GhLinkKind = "pull" | "issue" | "commit";

export interface GhLink {
  kind: GhLinkKind;
  repo: string;
  /** pull / issue 的号；commit 是 sha。 */
  id: string;
  url: string;
}

const LINK_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/([\w-]+)/g;

/**
 * 从一段文本里认出 GitHub 链接（工具卡 `<pre>` 里的裸 URL、AI 正文、用户自己敲的话）。
 * 同一 URL 只算一次，顺序按第一次出现。句尾标点不进来：`id` 只认 `[\w-]`。
 */
export function ghLinksIn(text: string): GhLink[] {
  const out: GhLink[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? "").matchAll(LINK_RE)) {
    const [, owner, repo, kind, id] = m;
    const url = `https://github.com/${owner}/${repo}/${kind}/${id}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ kind: kind === "pull" ? "pull" : kind === "issues" ? "issue" : "commit", repo: `${owner}/${repo}`, id, url });
  }
  return out;
}

/**
 * 相对时间的**数值部分**：面板与卡片都拿它，再各自 `tr()` 成一句话。
 * 这里不返回成品句子 —— 界面文案必须过 `tr()`，一个纯函数不该带回中文。
 */
export function ghAge(iso: string, now = Date.now()): { unit: "now" | "min" | "hour" | "day"; n: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return { unit: "now", n: 0 };
  if (mins < 60) return { unit: "min", n: mins };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { unit: "hour", n: hours };
  return { unit: "day", n: Math.round(hours / 24) };
}

/**
 * 相对时间那句话。放在这里而不是两个调用点各写一份：面板与链接卡用的是同一批数字，
 * 文案也该是同一条（评审时被点出来过）。
 */
export function ghAgeText(age: { unit: "now" | "min" | "hour" | "day"; n: number }): string {
  if (age.unit === "now") return tr("刚刚");
  if (age.unit === "min") return tr("{p1} 分钟前", { p1: age.n });
  if (age.unit === "hour") return tr("{p1} 小时前", { p1: age.n });
  return tr("{p1} 天前", { p1: age.n });
}

/** `+128 −42`；两个都是 0 时给空串（草稿 PR 常常还没有差异）。 */
export function ghChurn(additions: number, deletions: number): string {
  if (!additions && !deletions) return "";
  return `+${additions} −${deletions}`;
}
