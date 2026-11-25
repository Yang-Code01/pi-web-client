/**
 * 本项目的更新日志（D195 的 `CHANGELOG.md`，D358 的启动弹窗）—— 一套渲染，两个入口。
 *
 * 数据由桥端解析好（`bridge/src/changelog.ts`），页面只画：左栏「时间定位」+ 统计卡，右边一条
 * 批次时间线，标题右侧是「全部 / 新增 / 修复 / 设计决定」。启动弹窗复用同一批条目（`renderBatch`），
 * 所以引用 chip、引言块、行内代码在两处长得一样。
 *
 * 筛选是**按批**的：点「修复」留下含修复的批次，批内其它条目照常显示 —— 丢掉「这一批在干什么」
 * 比少看两条更亏。
 */
import { createEl as el } from "./chat.ts";
import { icon, type IconName } from "./icons.ts";
import { tr } from "./i18n/index.ts";
import "./changelog.css";

export type LogGroupKind = "new" | "fix" | "design";

export interface LogRef {
  kind: "pr" | "d";
  n: number;
}

export interface LogItem {
  md: string;
  refs: LogRef[];
}

export interface LogGroup {
  kind: LogGroupKind;
  items: LogItem[];
}

export interface LogBatch {
  id: string;
  date: string | null;
  title: string;
  intro: string | null;
  introQuoted: boolean;
  unpublished: boolean;
  groups: LogGroup[];
}

export interface LogMonth {
  key: string;
  year: number;
  month: number;
  count: number;
}

export interface SelfLog {
  stats: { batches: number; items: number; prs: number; unpublished: number };
  months: LogMonth[];
  batches: LogBatch[];
}

/** 「未发布」在左栏和滚动定位里也是一个 key，与 `2026-11` 这类月份并列。 */
const UNPUBLISHED = "unpublished";

/** 滚动监听挂在长期存在的滚动容器上（设置页是 `.st-pane`），重画一次就得把上一份拆掉。 */
const spyOn = new WeakMap<HTMLElement, AbortController>();

const KIND: Record<LogGroupKind, { icon: IconName; cls: string; label: string }> = {
  new: { icon: "sparkle", cls: "ico--new", label: "新增" },
  fix: { icon: "bug", cls: "ico--fix", label: "修复" },
  design: { icon: "gear", cls: "ico--decide", label: "设计决定" },
};

export interface LogRenderOptions {
  /** `#N` 拼 PR 地址用；读不到（不是 GitHub 检出）时 chip 退成不能点的字。 */
  repo?: { owner: string; name: string } | null;
  /** 上次看到的那一批标题：命中处画一条「上次看到这里」。 */
  seenTitle?: string;
  /** `D365` 这类 chip 的落点（设置页把 `docs/DECISIONS.md` 交给预览/编辑器）。 */
  onOpenDecision?: (n: number) => void;
  /** 滚动容器（设置页是 `.st-pane`）；不给就往上找最近一个可滚的。 */
  scrollRoot?: HTMLElement;
  /** 页头左侧已经放好的节点：返回链接、pi / 本项目 分段。 */
  headPrefix?: Node[];
  /** 阅读态自己带标题；控制台头部已经写着标题时传 null。 */
  title?: string | null;
  subtitle?: string;
  /** 时间线末尾那一小句；不给就不画。 */
  footNote?: string;
  /** 关掉页头右侧的筛选（弹窗与「pi」那一侧用不上）。 */
  filters?: boolean;
}

/** 只有行内 markdown：反引号、`**粗**`、`[文字](地址)`。整段走 renderMarkdown 会变成块级 `<p>`。 */
export function inlineHtml(md: string): string {
  const esc = md.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  return esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function monthKeyOf(batch: LogBatch): string {
  return batch.unpublished || !batch.date ? UNPUBLISHED : batch.date.slice(0, 7);
}

function dateLabel(date: string): string {
  const [y, m, d] = date.split("-");
  return tr("{p1} 年 {p2} 月 {p3} 日", { p1: y, p2: String(Number(m)), p3: String(Number(d)) });
}

function monthLabel(year: number, month: number): string {
  return tr("{p1} 年 {p2} 月", { p1: String(year), p2: String(month) });
}

/** 一条引用：PR 可点去 GitHub，`D#` 交给调用方打开决定记录。 */
function refChips(refs: LogRef[], opts: LogRenderOptions): HTMLElement {
  const box = el("span", "refs");
  for (const r of refs) {
    if (r.kind === "pr") {
      const repo = opts.repo;
      if (!repo) {
        const plain = el("span", "ref ref--pr", `#${r.n}`);
        plain.title = tr("PR #{p1}", { p1: String(r.n) });
        box.append(plain);
        continue;
      }
      const a = el("a", "ref ref--pr", `#${r.n}`);
      a.href = `https://github.com/${repo.owner}/${repo.name}/pull/${r.n}`;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.title = tr("在 GitHub 上看 PR #{p1}", { p1: String(r.n) });
      box.append(a);
      continue;
    }
    const b = el("button", "ref ref--d", `D${r.n}`) as HTMLButtonElement;
    b.type = "button";
    b.title = tr("打开这条决定：D{p1}", { p1: String(r.n) });
    b.onclick = () => opts.onOpenDecision?.(r.n);
    box.append(b);
  }
  return box;
}

/**
 * 一批：日期 → 主题 → 引言 → 条目。弹窗直接用它，所以这里不带任何页面级的东西。
 */
export function renderBatch(batch: LogBatch, opts: LogRenderOptions = {}): HTMLElement {
  const art = el("article", `cl-batch${batch.unpublished ? " undated" : ""}`);
  const date = el("div", "cl-date");
  if (batch.date) date.append(el("span", undefined, dateLabel(batch.date)));
  else date.append(el("span", "tag", tr("未发布")));
  art.append(date);

  if (batch.title) {
    const h = el("h3");
    h.innerHTML = inlineHtml(batch.title);
    art.append(h);
  }

  if (batch.intro) {
    const box = el("div", "cl-intro");
    box.append(icon(batch.introQuoted ? "alert" : "fileText", { size: 13 }));
    const p = el("div");
    p.innerHTML = batch.intro
      .split("\n")
      .map((line) => inlineHtml(line))
      .join("<br>");
    box.append(p);
    art.append(box);
  }

  const ul = el("ul", "cl-items");
  for (const g of batch.groups) {
    const meta = KIND[g.kind];
    for (const item of g.items) {
      const li = el("li", "cl-item");
      li.append(icon(meta.icon, { size: 13, cls: meta.cls }));
      const txt = el("div");
      txt.innerHTML = inlineHtml(item.md);
      if (item.refs.length) txt.append(refChips(item.refs, opts));
      li.append(txt);
      ul.append(li);
    }
  }
  art.append(ul);
  return art;
}

/**
 * 页头：`headPrefix`（返回、分段）→ 标题 → 一行说明，右侧放 `right`（筛选 pills）。
 * 「pi」那一页也用它，好让两页的页头是一副样子。
 */
export function renderLogHead(parts: {
  prefix?: Node[];
  title?: string | null;
  subtitle?: string;
  right?: HTMLElement;
}): HTMLElement {
  const head = el("header", "cl-head");
  const main = el("div", "cl-head__main");
  for (const node of parts.prefix ?? []) main.append(node);
  if (parts.title) main.append(el("h2", "cl-title", parts.title));
  if (parts.subtitle) main.append(el("p", "cl-sub", parts.subtitle));
  head.append(main);
  if (parts.right) head.append(parts.right);
  return head;
}

/**
 * 整页：左栏月份 + 统计卡，右边时间线。返回根节点，调用方自己挂进 `.st-pane`。
 *
 * 筛选与滚动高亮都在这里闭环：切换筛选只重画左栏与时间线，页头不动。
 */
export function renderLogPage(log: SelfLog, opts: LogRenderOptions = {}): HTMLElement {
  const page = el("div", "cl-page");
  let kind: LogGroupKind | "all" = "all";
  let active: string | null = null;
  /** 点月份自己滚过去的这段时间里别让滚动监听把高亮抢回去。 */
  let spyLock = 0;

  const filters = el("div", "cl-filters");
  const body = el("div", "cl-body");
  const rail = el("aside", "cl-rail");
  const timeline = el("div", "cl-timeline");
  body.append(rail, timeline);
  page.append(
    renderLogHead({
      prefix: opts.headPrefix,
      title: opts.title ?? null,
      subtitle: opts.subtitle,
      right: opts.filters === false ? undefined : filters,
    }),
    body,
  );

  const railLabel = el("div", "cl-rail__label");
  railLabel.append(icon("clock", { size: 12 }), el("span", undefined, tr("时间定位")));
  const months = el("div", "cl-monthlist");
  const stats = el("div", "cl-stats");
  const statRow = (n: number, label: string): HTMLElement => {
    const row = el("div", "cl-stat");
    row.append(el("b", undefined, String(n)), el("span", undefined, label));
    return row;
  };
  stats.append(
    statRow(log.stats.batches, tr("批更新")),
    statRow(log.stats.items, tr("条变化")),
    statRow(log.stats.prs, tr("个 PR")),
  );
  rail.append(railLabel, months, stats);

  const visible = (): LogBatch[] =>
    kind === "all" ? log.batches : log.batches.filter((b) => b.groups.some((g) => g.kind === kind));

  const scrollRoot = (): HTMLElement | null =>
    opts.scrollRoot ?? page.closest<HTMLElement>(".st-pane, .sheet-body, .cl-scroll");

  const jumpTo = (key: string): void => {
    const target = timeline.querySelector<HTMLElement>(`.cl-batch[data-month="${key}"]`);
    const root = scrollRoot();
    if (!target || !root) return;
    active = key;
    spyLock = Date.now() + 700;
    paintMonths();
    // 用 scrollIntoView 而不是自己算 `rect 差 + scrollTop`：`#app` 上有 `zoom`（外观「字号」），
    // 子树的 rect 与 scrollTop 不在同一个坐标系里（1.25 字号下差 25%），手算就会滚过头。
    target.style.scrollMarginTop = "12px";
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const paintMonths = (): void => {
    const list = visible();
    const counts = new Map<string, number>();
    for (const b of list) {
      const key = monthKeyOf(b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const order: { key: string; label: string; count: number }[] = [];
    if (counts.has(UNPUBLISHED)) {
      order.push({ key: UNPUBLISHED, label: tr("未发布"), count: counts.get(UNPUBLISHED) ?? 0 });
    }
    for (const m of log.months) {
      const count = counts.get(m.key);
      if (count) order.push({ key: m.key, label: monthLabel(m.year, m.month), count });
    }
    if (!order.some((m) => m.key === active)) active = order[0]?.key ?? null;

    months.replaceChildren();
    for (const m of order) {
      const b = el("button", `cl-month${m.key === active ? " on" : ""}`) as HTMLButtonElement;
      b.type = "button";
      b.dataset.month = m.key;
      b.append(el("span", undefined, m.label), el("em", undefined, String(m.count)));
      b.onclick = () => jumpTo(m.key);
      months.append(b);
    }
  };

  const paintTimeline = (): void => {
    timeline.replaceChildren();
    const list = visible();
    if (!list.length) {
      timeline.append(el("div", "cl-empty", tr("这一栏还没有内容。")));
      return;
    }
    const newestDated = list.find((b) => !b.unpublished);
    let seenDrawn = false;
    for (const batch of list) {
      const art = renderBatch(batch, opts);
      art.dataset.month = monthKeyOf(batch);
      if (batch === newestDated) art.classList.add("latest");
      timeline.append(art);
      // 「上次看到这里」画在已读那一批的**下面**：再往下都是没看过的。
      if (!seenDrawn && opts.seenTitle && batch.title === opts.seenTitle) {
        seenDrawn = true;
        timeline.append(el("div", "cl-unseen", tr("上次看到这里")));
      }
    }
    if (opts.footNote) timeline.append(el("div", "cl-foot", opts.footNote));
  };

  const paintFilters = (): void => {
    const counts: Record<string, number> = { all: log.batches.length };
    for (const k of Object.keys(KIND) as LogGroupKind[]) {
      counts[k] = log.batches.filter((b) => b.groups.some((g) => g.kind === k)).length;
    }
    filters.replaceChildren();
    const entries: [LogGroupKind | "all", string][] = [
      ["all", tr("全部")],
      ...(Object.keys(KIND) as LogGroupKind[]).map((k): [LogGroupKind, string] => [k, tr(KIND[k].label)]),
    ];
    for (const [k, label] of entries) {
      const b = el("button", `cl-filter${kind === k ? " on" : ""}`, label) as HTMLButtonElement;
      b.type = "button";
      b.title = tr("{p1} 批", { p1: String(counts[k]) });
      b.onclick = () => {
        if (kind === k) return;
        kind = k;
        active = null;
        paintFilters();
        paintMonths();
        paintTimeline();
        scrollRoot()?.scrollTo({ top: 0 });
      };
      filters.append(b);
    }
  };

  // 滚动时高亮当前月份：取「顶部已经越过的最后一批」所属的那个月。
  const root = scrollRoot();
  if (root) {
    spyOn.get(root)?.abort();
    const ctl = new AbortController();
    spyOn.set(root, ctl);
    let ticking = false;
    root.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (Date.now() < spyLock) return;
        const top = root.getBoundingClientRect().top + 16;
        let key: string | null = null;
        for (const node of timeline.querySelectorAll<HTMLElement>(".cl-batch")) {
          if (node.getBoundingClientRect().top <= top) key = node.dataset.month ?? key;
        }
        if (key && key !== active) {
          active = key;
          paintMonths();
        }
      });
    }, { signal: ctl.signal });
  }

  paintFilters();
  paintMonths();
  paintTimeline();
  return page;
}
