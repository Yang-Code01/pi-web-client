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
  /** GitHub 的单文件 diff 锚点（`diff-<sha256(路径)>`），点一行文件直接落到它。 */
  anchor?: string;
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
  /**
   * 号是从正文里**猜**出来的（`PR #669` 这种只有号、没有链接的转述）：仓库靠本会话补全，
   * 号是不是 PR 也要桥确认过才留卡。见 `ghBareRefs()`。
   */
  weak?: boolean;
}

const LINK_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues|commit)\/([\w-]+)/g;

/**
 * URL 里的路名 → 我们的 kind（`issues` 要单数化）。写成表，别写嵌套三元 —— 桥的 `seenLinks()`
 * （`bridge/src/github.ts`）是同一张表，改一边就得改另一边。
 */
const LINK_KIND: Record<string, GhLinkKind> = { pull: "pull", issues: "issue", commit: "commit" };

/**
 * 「PR #669」「PR：**#669**」「pull #669」里那个号。号后面只允许句尾标点 / 收尾加粗之类的
 * 非字母数字字符，避开 `#669abc` 这种。`i` 是为了 `pr #12` 这种小写写法。
 */
const REF_RE = /(?:\bPR\b|\bpull\b)\s*[:：]?\s*(?:\*\*|__|`)?\s*#(\d{1,7})(?![\w-])/gi;

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
    out.push({ kind: LINK_KIND[kind] ?? "commit", repo: `${owner}/${repo}`, id, url });
  }
  return out;
}

/**
 * 正文里「只写了号」的 PR 转述：`PR #669`、`PR：**#669**`、`pull #669`、`PR#669`。
 *
 * 号前**必须**有 PR / pull 字样 —— 本仓库的 issue 与 PR 共用一套编号，裸 `#669` 画成 PR 卡
 * 会把 issue 说成 PR（D399 记过同类错数据）。所以「已开 #669」这种写法故意不认。
 *
 * `repo` 是**本会话仓库**（卡片那边问 `githubSessionRepo()`）。还没问回来时传空串：
 * 号照样给，卡片先只有号，判据到了再补仓库。
 */
export function ghBareRefs(text: string, repo: string): GhLink[] {
  const out: GhLink[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? "").matchAll(REF_RE)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      kind: "pull",
      repo,
      id,
      url: repo ? `https://github.com/${repo}/pull/${id}` : "",
      weak: true,
    });
  }
  return out;
}

/**
 * 一段文本该挂哪几张卡：先 URL（有依据），再只有号的猜测（`weak`），同号去重、按 `max` 截断。
 *
 * 去重按 `仓库#号`：URL 自带仓库，所以同一段里出现同一条 PR 的 URL 时，猜出来的那张不再画。
 * 不同仓库的同号不算重复（D399：跨仓的同号 PR 是两件事）。
 * 猜测卡在仓库还没问回来（`repo` 空）时排不进去重，交给卡片层在判据到达后再比一次。
 */
export function ghCardLinks(text: string, repo: string, max: number): GhLink[] {
  const links = ghLinksIn(text);
  const seen = new Set(links.map((l) => `${l.repo.toLowerCase()}#${l.id}`));
  const out: GhLink[] = [...links];
  for (const ref of ghBareRefs(text, repo)) {
    if (repo && seen.has(`${repo.toLowerCase()}#${ref.id}`)) continue;
    out.push(ref);
  }
  return out.slice(0, max);
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

/** 评审钮被禁用的理由码（界面负责翻译成人话，纯函数不带中文）。 */
export type ReviewBlock = "" | "foreign";

export interface ReviewAffordance {
  /** 画不画这颗钮。 */
  show: boolean;
  disabled: boolean;
  /** 为什么禁用：`foreign` = 这张卡属于别的仓库。 */
  reason: ReviewBlock;
}

/**
 * 链接卡上那颗「代码评审」钮该长什么样（#666）。
 *
 * 为什么需要判：评审是**在本会话目录**里跑的 —— 桥先 `gh pr view <号>` 再 fetch
 * `refs/pull/<号>/head`，拿别的仓库的卡去评，会静默评成本仓库同号的那一只（D399 记过同类错数据）。
 *
 * 三个分支：
 * - 不是 PR 卡 → 不画（issue 没东西可评，commit 这次不做入口）。
 * - 任一边的仓库名还空着（会话刚切、状态接口还没回）→ **先画成能点**：宁可点到后由桥拒（会说明理由），
 *   也不要让人看到一屏灰钮再齐刷刷变亮。
 * - 两边都有且不等 → 画但禁用，理由给 `foreign`。大小写不算差异（GitHub 的仓库名本来就不分大小写，
 *   而两个来源一个是链接原文、一个是 `gh` 归一过的）。
 */
export function reviewAffordance(opts: { kind: GhLinkKind; cardRepo: string; sessionRepo: string }): ReviewAffordance {
  if (opts.kind !== "pull") return { show: false, disabled: false, reason: "" };
  const card = (opts.cardRepo ?? "").trim().toLowerCase();
  const session = (opts.sessionRepo ?? "").trim().toLowerCase();
  if (!card || !session || card === session) return { show: true, disabled: false, reason: "" };
  return { show: true, disabled: true, reason: "foreign" };
}
