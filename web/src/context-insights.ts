/**
 * 设置 → 工具 → 上下文洞察。
 *
 * dsh-context 的 Insights 是跨会话首页：KPI、近 7 天用量、活跃度、技能 / 工具 / 命令账本、
 * Context 组成与按项目分组的会话卡片。这里按同一套信息架构做轻量复刻；数据由桥的
 * `/api/context/insights` 聚合，页面只负责筛选、汇总和画图。
 *
 * 与「当前会话」的 Context 面板分工：那里看逐请求正文，这里看「全体 / 分项目」的使用画像。
 */
import { api } from "./api.ts";
import type { CtxInsightBill, CtxInsightData, CtxInsightSession, CtxInsightTally } from "./context-insight-types.ts";
import { CTX_BILL_CATS, ctxDur, ctxFmt, ctxPct } from "./context.ts";
import { fmtDate, fmtRelative, fmtTime, tr } from "./i18n/index.ts";
import "./context-insights.css";

type Kids = Array<Node | string | null | undefined | false>;
type Range = "today" | "7d" | "30d" | "all";
type TallyKind = "skills" | "tools" | "cmds";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: Kids): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

function div(cls?: string, ...kids: Kids): HTMLDivElement {
  return el("div", cls, ...kids);
}

function span(cls?: string, ...kids: Kids): HTMLSpanElement {
  return el("span", cls, ...kids);
}

function button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

function card(title: string, glyph: string, ...kids: Kids): HTMLElement {
  const box = el("section", "ci-card");
  box.append(div("ci-card-head", span("ci-card-title", span("ci-ico", glyph), title)));
  box.append(...(kids.filter((kid): kid is Node | string => kid != null && kid !== false)));
  return box;
}

function empty(text: string): HTMLDivElement {
  return div("ci-empty", text);
}

const BILL_COLOR: Record<keyof CtxInsightBill, string> = {
  sys: "var(--ci-sys)",
  tools: "var(--ci-tools)",
  user: "var(--ci-user)",
  inject: "var(--ci-inject)",
  skill: "var(--ci-skill)",
  toolCalls: "var(--ci-tool)",
  reasoning: "var(--ci-think)",
  answers: "var(--ci-answer)",
};

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeStart(range: Range): number {
  const today = midnight(new Date());
  if (range === "today") return today.getTime();
  if (range === "7d") return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime();
  if (range === "30d") return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29).getTime();
  return 0;
}

function rangeDays(range: Range): Set<string> | null {
  if (range === "all") return null;
  const start = rangeStart(range);
  const out = new Set<string>();
  const today = midnight(new Date());
  for (let d = new Date(start); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) out.add(dayKey(d));
  return out;
}

function inRange(s: CtxInsightSession, range: Range): boolean {
  if (range === "all") return true;
  const keys = rangeDays(range);
  if (!keys) return true;
  for (const key of Object.keys(s.days)) if (keys.has(key)) return true;
  // 还没有 ctxlog / 旧日志的会话：按最后更新时间落在范围里也算活跃，别让会话凭空消失。
  return !Object.keys(s.days).length && s.updatedAt >= rangeStart(range);
}

function sumDays(s: CtxInsightSession, range: Range, field: "tokens" | "cost" | "requests" | "toolCalls" | "toolsMs"): number {
  if (range === "all") {
    if (field === "tokens") return s.tokens;
    if (field === "cost") return s.cost;
    if (field === "requests") return s.requests;
    if (field === "toolCalls") return Object.values(s.tools).reduce((n, t) => n + t.n, 0);
    return Object.values(s.days).reduce((n, d) => n + d.toolsMs, 0);
  }
  const keys = rangeDays(range);
  let out = 0;
  for (const [key, day] of Object.entries(s.days)) if (!keys || keys.has(key)) out += day[field];
  return out;
}

function tallyInRange(row: CtxInsightTally, range: Range): boolean {
  return range === "all" || row.last >= rangeStart(range);
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

interface Project {
  id: string;
  name: string;
  path: string;
}

function projectOf(s: CtxInsightSession, data: CtxInsightData): Project {
  const ws = s.ws || data.workspace.overrides[s.id] || "";
  const group = ws ? data.workspace.groups.find((g) => g.id === ws) : undefined;
  if (group) {
    return { id: group.id, name: group.name || baseName(group.key || s.cwd) || tr("未命名项目"), path: group.key || s.cwd };
  }
  if (s.cwd) return { id: `cwd:${s.cwd}`, name: baseName(s.cwd) || s.cwd, path: s.cwd };
  return { id: "ungrouped", name: tr("未分组"), path: "" };
}

interface Totals {
  sessions: number;
  tokens: number;
  cost: number;
  costKnown: number;
  cacheRead: number;
  input: number;
  cacheWrite: number;
  requests: number;
  turns: number;
  toolCalls: number;
  toolsMs: number;
  bill: CtxInsightBill;
  skills: Map<string, CtxInsightTally>;
  tools: Map<string, CtxInsightTally>;
  cmds: Map<string, CtxInsightTally>;
  files: { read: number; write: number; search: number };
}

function blankTotals(): Totals {
  return {
    sessions: 0,
    tokens: 0,
    cost: 0,
    costKnown: 0,
    cacheRead: 0,
    input: 0,
    cacheWrite: 0,
    requests: 0,
    turns: 0,
    toolCalls: 0,
    toolsMs: 0,
    bill: { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, reasoning: 0, answers: 0 },
    skills: new Map(),
    tools: new Map(),
    cmds: new Map(),
    files: { read: 0, write: 0, search: 0 },
  };
}

function mergeTally(dst: Map<string, CtxInsightTally>, src: Record<string, CtxInsightTally>, range: Range): void {
  for (const [name, row] of Object.entries(src)) {
    if (!tallyInRange(row, range)) continue;
    const cur = dst.get(name) ?? { n: 0, last: 0 };
    cur.n += row.n;
    cur.last = Math.max(cur.last, row.last);
    dst.set(name, cur);
  }
}

function aggregate(sessions: CtxInsightSession[], range: Range): Totals {
  const t = blankTotals();
  for (const s of sessions) {
    t.sessions += 1;
    t.tokens += sumDays(s, range, "tokens");
    t.cost += sumDays(s, range, "cost");
    if (s.costKnown) t.costKnown += 1;
    t.cacheRead += s.cacheRead;
    t.input += s.input;
    t.cacheWrite += s.cacheWrite;
    t.requests += sumDays(s, range, "requests");
    t.turns += s.turns;
    t.toolCalls += sumDays(s, range, "toolCalls");
    t.toolsMs += sumDays(s, range, "toolsMs");
    for (const key of Object.keys(t.bill) as Array<keyof CtxInsightBill>) t.bill[key] += s.bill[key];
    mergeTally(t.skills, s.skills, range);
    mergeTally(t.tools, s.tools, range);
    mergeTally(t.cmds, s.cmds, range);
    t.files.read += s.files.read;
    t.files.write += s.files.write;
    t.files.search += s.files.search;
  }
  return t;
}

function sessionHas(s: CtxInsightSession, kind: TallyKind, name: string): boolean {
  return Boolean((s[kind] ?? {})[name]);
}

function donut(rows: Array<{ tokens: number; color: string }>, top: string, sub: string): HTMLElement {
  const total = rows.reduce((s, r) => s + Math.max(0, r.tokens), 0) || 1;
  const wrap = div("ci-donut");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 42 42");
  svg.setAttribute("width", "104");
  svg.setAttribute("height", "104");
  let offset = 0;
  for (const r of rows) {
    const pct = (Math.max(0, r.tokens) / total) * 100;
    if (pct <= 0) continue;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "21");
    circle.setAttribute("cy", "21");
    circle.setAttribute("r", "15.9155");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke-width", "4");
    circle.setAttribute("stroke", r.color);
    circle.setAttribute("stroke-dasharray", `${pct} ${100 - pct}`);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    circle.setAttribute("transform", "rotate(-90 21 21)");
    svg.append(circle);
    offset += pct;
  }
  const center = div("ci-donut-center", el("b", "", top), el("span", "", sub));
  wrap.append(svg, center);
  return wrap;
}

function barStack(bill: CtxInsightBill, total: number): HTMLElement {
  const bar = div("ci-stack");
  const denom = Math.max(1, total);
  for (const c of CTX_BILL_CATS) {
    const n = bill[c.id];
    if (!n) continue;
    const seg = span("ci-seg");
    seg.style.width = `${(n / denom) * 100}%`;
    seg.style.background = BILL_COLOR[c.id];
    seg.title = `${tr(c.label)} ${ctxFmt(n)}`;
    bar.append(seg);
  }
  return bar;
}

interface ViewOptions {
  openSession: (id: string) => void;
  currentId: string | null;
}

export class ContextInsightsView {
  private readonly host: HTMLElement;
  private readonly opts: ViewOptions;
  private data: CtxInsightData | null = null;
  private error = "";
  private loading = false;
  private range: Range = "30d";
  private project: string | null = null;
  private search = "";
  private sort: "recent" | "tokens" | "context" = "recent";
  private dayFilter = "";
  private tally: { kind: TallyKind; name: string } | null = null;

  constructor(host: HTMLElement, opts: ViewOptions) {
    this.host = host;
    this.opts = opts;
  }

  async load(force = false): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      this.data = await api.contextInsights();
      if (force) this.error = "";
    } catch (err: any) {
      this.error = String(err?.message ?? err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private allProjects(): Project[] {
    if (!this.data) return [];
    const map = new Map<string, Project>();
    for (const s of this.data.sessions) {
      const p = projectOf(s, this.data);
      if (!map.has(p.id)) map.set(p.id, p);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private visibleSessions(): CtxInsightSession[] {
    if (!this.data) return [];
    const range = this.range;
    return this.data.sessions.filter((s) => {
      if (!inRange(s, range)) return false;
      if (this.project && projectOf(s, this.data!).id !== this.project) return false;
      if (this.dayFilter && !(s.days[this.dayFilter]?.requests > 0)) return false;
      if (this.tally && !sessionHas(s, this.tally.kind, this.tally.name)) return false;
      if (this.search) {
        const q = this.search.toLowerCase();
        const project = projectOf(s, this.data!).name.toLowerCase();
        if (![s.name, s.cwd, s.lastUser, project, s.model].some((v) => String(v).toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }

  private render(): void {
    const top = this.host.closest<HTMLElement>(".settings-body")?.scrollTop ?? 0;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement && this.host.contains(active) ? active.dataset.ciKey ?? "" : "";
    const caret = focusKey ? (active as HTMLInputElement).selectionStart : null;
    this.host.replaceChildren();
    if (this.loading && !this.data) {
      this.host.append(div("ci-root", empty(tr("正在汇总所有会话…"))));
      return;
    }
    if (this.error && !this.data) {
      this.host.append(
        div(
          "ci-root",
          div(
            "ci-error",
            span("", tr("读不到上下文洞察：{p1}", { p1: this.error })),
            button("btn", tr("重试"), () => void this.load(true)),
          ),
        ),
      );
      return;
    }
    if (!this.data) {
      this.host.append(div("ci-root", empty(tr("还没有数据"))));
      return;
    }
    const data = this.data;
    const visible = this.visibleSessions();
    const totals = aggregate(visible, this.range);
    const root = div("ci-root");

    root.append(this.toolbar(data));
    root.append(this.kpiRow(totals));
    root.append(this.usageAndComposition(visible, totals));
    root.append(this.heatmap(visible));
    root.append(this.tallyRow(visible));
    root.append(this.projectCard(data));
    root.append(this.sessionCard(visible));
    if (this.error) root.append(div("ci-error", span("", tr("刷新失败：{p1}", { p1: this.error }))));
    this.host.append(root);
    if (focusKey) {
      const again = this.host.querySelector<HTMLInputElement>(`input[data-ci-key="${focusKey}"]`);
      if (again) {
        again.focus();
        if (caret != null) again.setSelectionRange(caret, caret);
      }
    }
    const scroller = this.host.closest<HTMLElement>(".settings-body");
    if (scroller) scroller.scrollTop = top;
  }

  private toolbar(data: CtxInsightData): HTMLElement {
    const bar = div("ci-toolbar");
    const left = div("ci-toolbar-left");
    const ranges: Array<[Range, string]> = [
      ["today", tr("今天")],
      ["7d", tr("近 7 天")],
      ["30d", tr("近 30 天")],
      ["all", tr("全部")],
    ];
    for (const [id, label] of ranges) {
      left.append(
        button(`ci-seg${this.range === id ? " on" : ""}`, label, () => {
          this.range = id;
          this.dayFilter = "";
          this.render();
        }),
      );
    }
    const projects = this.allProjects();
    const chips = div("ci-projects");
    chips.append(
      button(`ci-chip${this.project === null ? " on" : ""}`, tr("全体"), () => {
        this.project = null;
        this.render();
      }),
    );
    for (const p of projects) {
      const n = data.sessions.filter((s) => projectOf(s, data).id === p.id).length;
      chips.append(
        button(`ci-chip${this.project === p.id ? " on" : ""}`, `${p.name} ${n}`, () => {
          this.project = this.project === p.id ? null : p.id;
          this.render();
        }),
      );
    }
    left.append(chips);
    bar.append(left);
    const right = div("ci-toolbar-right");
    if (this.dayFilter) right.append(button("ci-filter-tag", `${this.dayFilter} ×`, () => { this.dayFilter = ""; this.render(); }));
    if (this.tally) {
      right.append(
        button("ci-filter-tag", `${this.tally.name} ×`, () => {
          this.tally = null;
          this.render();
        }),
      );
    }
    right.append(button("btn ghost", tr("刷新"), () => void this.load(true)));
    bar.append(right);
    return bar;
  }

  private kpiRow(t: Totals): HTMLElement {
    const cache = t.input + t.cacheRead + t.cacheWrite;
    const grid = div("ci-kpis");
    grid.append(
      this.kpi(tr("会话"), String(t.sessions), tr("请求 {p1}", { p1: String(t.requests) })),
      this.kpi(tr("Token 消耗"), ctxFmt(t.tokens), tr("provider 计费口径")),
      this.kpi(tr("预估费用"), t.costKnown ? `$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}` : "–", tr("已计价 {p1} 个会话", { p1: String(t.costKnown) })),
      this.kpi(tr("缓存命中"), cache > 0 ? ctxPct((t.cacheRead / cache) * 100, 2) : "–", tr("缓存读 / 全部输入")),
      this.kpi(tr("轮次"), String(t.turns), tr("步数 {p1}", { p1: String(t.requests) })),
      this.kpi(tr("工具执行"), String(t.toolCalls), t.toolsMs > 0 ? ctxDur(t.toolsMs) : tr("无耗时数据")),
    );
    return grid;
  }

  private kpi(label: string, value: string, sub: string): HTMLElement {
    return div("ci-kpi", span("ci-kpi-k", label), el("b", "ci-kpi-v", value), span("ci-kpi-sub", sub));
  }

  private usageAndComposition(sessions: CtxInsightSession[], totals: Totals): HTMLElement {
    const row = div("ci-row2");
    const days: Array<{ key: string; tokens: number; cost: number }> = [];
    const today = midnight(new Date());
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = dayKey(d);
      let tokens = 0;
      let cost = 0;
      for (const s of sessions) {
        const day = s.days[key];
        if (!day) continue;
        tokens += day.tokens;
        cost += day.cost;
      }
      days.push({ key, tokens, cost });
    }
    const maxTokens = Math.max(...days.map((d) => d.tokens), 1);
    const maxCost = Math.max(...days.map((d) => d.cost), 0.0001);
    const usage = card(tr("近 7 天用量"), "▥");
    const chart = div("ci-usage");
    for (const day of days) {
      const col = div("ci-usage-day");
      const bars = div("ci-usage-bars");
      const tok = span("ci-usage-bar tokens");
      tok.style.height = `${Math.max(2, (day.tokens / maxTokens) * 100)}%`;
      tok.title = `${day.key} · ${ctxFmt(day.tokens)} tokens`;
      const cost = span("ci-usage-bar cost");
      cost.style.height = `${Math.max(1, (day.cost / maxCost) * 100)}%`;
      cost.title = `${day.key} · $${day.cost.toFixed(4)}`;
      bars.append(tok, cost);
      col.append(bars, span("ci-usage-label", day.key.slice(5)), span("ci-usage-value", day.tokens ? ctxFmt(day.tokens) : "–"));
      chart.append(col);
    }
    usage.append(chart, div("ci-legend-note", span("ci-dot tokens"), tr("Token"), span("ci-dot cost"), tr("费用")));

    const comp = card(tr("Context 组成"), "◔");
    const raw = CTX_BILL_CATS.map((c) => ({ id: c.id, label: tr(c.label), tokens: totals.bill[c.id], color: BILL_COLOR[c.id], cls: c.cls }));
    const billTotal = raw.reduce((n, r) => n + r.tokens, 0);
    const shownTotal = totals.tokens || billTotal;
    // 各类是逐请求估算的合计，provider 的计费总量是实际值：按比例缩到实际总量，
    // 这样图例的百分比永远从同一个分母来，也不会出现「工具调用 247.1%」。
    const scale = billTotal > 0 ? shownTotal / billTotal : 1;
    const rows = raw.map((r) => ({ ...r, tokens: r.tokens * scale }));
    const body = div("ci-donut-row");
    body.append(donut(rows.map((r) => ({ tokens: r.tokens, color: r.color })), ctxFmt(shownTotal), tr("计费 Token")));
    const legend = div("ci-legend");
    const denom = Math.max(1, billTotal);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const line = div("ci-legend-row");
      line.append(span("ci-dot"), span("ci-legend-label", r.label), span("ci-legend-pct", ctxPct((raw[i].tokens / denom) * 100)), span("ci-legend-sub", ctxFmt(r.tokens)));
      (line.firstElementChild as HTMLElement).style.background = r.color;
      legend.append(line);
    }
    body.append(legend);
    comp.append(body);
    row.append(usage, comp);
    return row;
  }

  private heatmap(sessions: CtxInsightSession[]): HTMLElement {
    const box = card(tr("活跃度"), "▦");
    box.querySelector(".ci-card-head")!.append(span("ci-badge", tr("最近 8 周 · 点击筛选日期")));
    const today = midnight(new Date());
    // 从本周一往前数 7 周，8 列 × 7 行；未来的格子留空，星期标签才和行对齐。
    const mondayOffset = (today.getDay() + 6) % 7;
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset - 49);
    const cells: Array<{ key: string; tokens: number; sessions: number; date: Date; future: boolean }> = [];
    let max = 1;
    for (let i = 0; i < 56; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = dayKey(d);
      const future = d.getTime() > today.getTime();
      let tokens = 0;
      let n = 0;
      if (!future) {
        for (const s of sessions) {
          const day = s.days[key];
          if (!day) continue;
          tokens += day.tokens;
          if (day.requests > 0) n += 1;
        }
      }
      max = Math.max(max, tokens);
      cells.push({ key, tokens, sessions: n, date: d, future });
    }
    const grid = div("ci-heat");
    const weekdays = div("ci-heat-wd");
    for (const label of [tr("一"), tr("二"), tr("三"), tr("四"), tr("五"), tr("六"), tr("日")]) weekdays.append(span("", label));
    const columns = div("ci-heat-cols");
    for (let w = 0; w < 8; w++) {
      const col = div("ci-heat-col");
      for (let d = 0; d < 7; d++) {
        const cell = cells[w * 7 + d];
        const level = cell.tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((cell.tokens / max) * 4)));
        const node = button(`ci-heat-cell lv${level}${this.dayFilter === cell.key ? " on" : ""}${cell.future ? " future" : ""}`, "", () => {
          if (cell.future) return;
          this.dayFilter = this.dayFilter === cell.key ? "" : cell.key;
          this.render();
        });
        if (cell.future) node.disabled = true;
        node.title = tr("{p1} · {p2} tokens · {p3} 个活跃会话", {
          p1: cell.key,
          p2: ctxFmt(cell.tokens),
          p3: String(cell.sessions),
        });
        col.append(node);
      }
      columns.append(col);
    }
    box.append(div("ci-heat-body", weekdays, columns));
    box.append(div("ci-legend-note", span("ci-heat-scale"), tr("少"), span("ci-heat-swatch lv1"), span("ci-heat-swatch lv2"), span("ci-heat-swatch lv3"), span("ci-heat-swatch lv4"), tr("多")));
    return box;
  }

  private tallyRow(sessions: CtxInsightSession[]): HTMLElement {
    const row = div("ci-ledgers");
    row.append(
      this.tallyCard("skills", tr("技能加载"), "✦", tr("统计范围内暂无技能加载"), sessions),
      this.tallyCard("tools", tr("工具调用"), "⚒", tr("统计范围内暂无工具调用"), sessions),
      this.tallyCard("cmds", tr("命令执行"), "▸", tr("统计范围内暂无命令执行"), sessions),
    );
    return row;
  }

  private tallyCard(kind: TallyKind, title: string, glyph: string, emptyText: string, sessions: CtxInsightSession[]): HTMLElement {
    const box = card(title, glyph);
    const map = new Map<string, CtxInsightTally>();
    for (const s of sessions) mergeTally(map, s[kind], this.range);
    const rows = [...map.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last || a[0].localeCompare(b[0]));
    const total = rows.reduce((n, [, r]) => n + r.n, 0);
    box.querySelector(".ci-card-head")!.append(span("ci-badge", tr("{p1} 个 · {p2} 次", { p1: String(rows.length), p2: String(total) })));
    if (!rows.length) {
      box.append(empty(emptyText));
      return box;
    }
    const list = div("ci-tallies");
    for (const [name, row] of rows.slice(0, 20)) {
      const active = this.tally?.kind === kind && this.tally.name === name;
      const btn = button(`ci-tally${active ? " on" : ""}`, "", () => {
        this.tally = active ? null : { kind, name };
        this.render();
      });
      btn.append(span("ci-tally-name", name), span("ci-tally-n", String(row.n)), span("ci-tally-last", fmtRelative(row.last)));
      list.append(btn);
    }
    box.append(list);
    if (rows.length > 20) box.append(div("ci-note", tr("另有 {p1} 个", { p1: String(rows.length - 20) })));
    return box;
  }

  private projectCard(data: CtxInsightData): HTMLElement {
    const box = card(tr("分项目"), "▤");
    const by = new Map<string, { project: Project; sessions: CtxInsightSession[] }>();
    for (const s of data.sessions) {
      if (!inRange(s, this.range)) continue;
      const p = projectOf(s, data);
      const row = by.get(p.id) ?? { project: p, sessions: [] };
      row.sessions.push(s);
      by.set(p.id, row);
    }
    const rows = [...by.values()].map(({ project, sessions }) => {
      const t = aggregate(sessions, this.range);
      return { project, t, sessions: sessions.length };
    }).sort((a, b) => b.t.tokens - a.t.tokens || b.sessions - a.sessions || a.project.name.localeCompare(b.project.name));
    if (!rows.length) {
      box.append(empty(tr("统计范围内没有项目")));
      return box;
    }
    const table = div("ci-projects-table");
    const head = div("ci-project-row head");
    head.append(span("", tr("项目")), span("", tr("会话")), span("", tr("Token")), span("", tr("费用")), span("", tr("缓存")), span("", tr("工具")), span("", tr("最近")));
    table.append(head);
    const max = Math.max(...rows.map((r) => r.t.tokens), 1);
    for (const { project, t, sessions } of rows) {
      const row = button(`ci-project-row${this.project === project.id ? " on" : ""}`, "", () => {
        this.project = this.project === project.id ? null : project.id;
        this.render();
      });
      const name = div("ci-project-name");
      name.append(span("", project.name), span("ci-project-path", project.path || "–"));
      const bar = span("ci-project-bar");
      bar.style.width = `${Math.max(2, (t.tokens / max) * 100)}%`;
      const cache = t.input + t.cacheRead + t.cacheWrite;
      row.append(
        name,
        span("ci-project-num", String(sessions)),
        span("ci-project-num", ctxFmt(t.tokens)),
        span("ci-project-num", t.costKnown ? `$${t.cost.toFixed(2)}` : "–"),
        span("ci-project-num", cache ? ctxPct((t.cacheRead / cache) * 100) : "–"),
        span("ci-project-num", String(t.toolCalls)),
        span("ci-project-num", t.sessions ? fmtRelative(Math.max(...data.sessions.filter((s) => projectOf(s, data).id === project.id).map((s) => s.updatedAt))) : "–"),
      );
      row.append(bar);
      table.append(row);
    }
    box.append(table);
    return box;
  }

  private sessionCard(sessions: CtxInsightSession[]): HTMLElement {
    const box = card(tr("会话"), "◫");
    const head = box.querySelector(".ci-card-head")!;
    const controls = div("ci-session-controls");
    const search = el("input", "ci-search");
    search.type = "search";
    search.dataset.ciKey = "sessions";
    search.placeholder = tr("搜索标题 / 目录 / 最后消息…");
    search.value = this.search;
    search.oninput = () => {
      this.search = search.value;
      this.render();
    };
    controls.append(search);
    for (const [id, label] of [["recent", tr("最近更新")], ["tokens", tr("Token 总用量")], ["context", tr("当前上下文")]] as const) {
      controls.append(button(`ci-seg${this.sort === id ? " on" : ""}`, label, () => { this.sort = id; this.render(); }));
    }
    head.append(controls);
    if (!sessions.length) {
      box.append(empty(this.data?.sessions.length ? tr("没有匹配当前筛选条件的会话") : tr("还没有会话")));
      return box;
    }
    const sorted = [...sessions].sort((a, b) => {
      if (this.sort === "tokens") return b.tokens - a.tokens || b.updatedAt - a.updatedAt;
      if (this.sort === "context") return b.context - a.context || b.updatedAt - a.updatedAt;
      return b.updatedAt - a.updatedAt;
    });
    const grid = div("ci-sessions");
    for (const s of sorted) {
      const project = this.data ? projectOf(s, this.data) : { name: "", id: "" };
      const cardEl = button("ci-session", "", () => this.opts.openSession(s.id));
      const head = div("ci-session-head");
      head.append(
        span("ci-session-name", s.name),
        ...(this.opts.currentId === s.id ? [span("ci-session-live", tr("当前"))] : []),
        ...(s.running ? [span("ci-session-live", tr("运行中"))] : []),
        ...(s.archived ? [span("ci-session-arch", tr("已归档"))] : []),
      );
      cardEl.append(head);
      cardEl.append(div("ci-session-meta", span("", project.name), span("", s.model || "–"), span("", fmtRelative(s.updatedAt))));
      cardEl.append(barStack(s.bill, Object.values(s.bill).reduce((n, v) => n + v, 0)));
      const stats = div("ci-session-stats");
      stats.append(
        this.stat(tr("Token"), ctxFmt(s.tokens || s.context)),
        this.stat(tr("轮次"), `${s.turns} / ${s.steps}`),
        this.stat(tr("当前上下文"), ctxFmt(s.context)),
        this.stat(tr("费用"), s.costKnown ? `$${s.cost.toFixed(3)}` : "–"),
      );
      cardEl.append(stats);
      if (s.lastUser) cardEl.append(div("ci-session-last", s.lastUser));
      else cardEl.append(div("ci-session-last", fmtDate(s.updatedAt)));
      grid.append(cardEl);
    }
    box.append(grid);
    return box;
  }

  private stat(label: string, value: string): HTMLElement {
    return div("ci-stat", span("ci-stat-k", label), el("b", "ci-stat-v", value));
  }
}
