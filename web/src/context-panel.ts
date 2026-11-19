/**
 * #384 Context 面板的渲染层。
 *
 * 纯函数在 `context.ts`；这里只负责把视图画成 dsh-context 那种密集的仪表板：
 * 统计 / 会话计量 / Token donut / 耗时 donut / 当前上下文 / 趋势 / 浏览器 / 事件 / 文件 / 命令。
 *
 * 所有状态（选中哪次请求、趋势粒度、浏览器基线、手风琴展开、筛选）都留在实例里，`update()`
 * 重画时不会丢掉。面板由 app.ts 打开/关闭，ctxlog 或 stats 每来一条就 update 一次。
 */
import {
  CTX_CATS,
  ctxBillRows,
  ctxBrowserView,
  ctxCommandRows,
  ctxCompactAfterSeq,
  ctxCompRows,
  ctxDur,
  ctxEvents,
  ctxFmt,
  ctxFileRows,
  ctxKpis,
  ctxPct,
  ctxRequests,
  ctxSummary,
  ctxTiming,
  ctxTokenStats,
  ctxTotal,
  ctxUsageMap,
  ctxTrendRows,
  type CtxBill,
  type CtxBrowserCat,
  type CtxCats,
  type CtxEvent,
  type CtxItem,
  type CtxLine,
  type CtxPolicy,
  type CtxTimingRow,
  type CtxTrendRow,
} from "./context.ts";
import { fmtTime, tr } from "./i18n/index.ts";
import { renderMarkdown } from "./md.ts";
import { ctxSectionMarkdown, ctxSkillCatalog, type SkillCatalog, type SkillEntry } from "./context-viz.ts";
import "./context-panel.css";

export interface ContextPanelData {
  lines: CtxLine[];
  contextWindow: number | null;
  measured: number | null;
  /** #484：三层阈值解析后的两条线；null = 还没拿到（会话没在跑、或还没发第一条消息）。 */
  policy: CtxPolicy | null;
  model: string;
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null;
  cost: number | null;
  owned: boolean;
}

type Kids = Array<Node | string | null | undefined | false>;

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

function icon(cls: string, glyph: string): HTMLSpanElement {
  return span(`cx-ico ${cls}`, glyph);
}

const CAT_COLOR: Record<string, string> = {
  "c-sys": "var(--cx-sys)",
  "c-tools": "var(--cx-tools)",
  "c-user": "var(--cx-user)",
  "c-inject": "var(--cx-inject)",
  "c-skill": "var(--cx-skill)",
  "c-asst": "var(--cx-asst)",
  "c-toolr": "var(--cx-toolr)",
  "c-tool": "var(--cx-toolr)",
  "c-think": "var(--cx-think)",
  "c-answer": "var(--cx-answer)",
  "c-wait": "var(--cx-wait)",
  "c-args": "var(--cx-args)",
  "c-other": "var(--cx-other)",
};

function colorOf(cls: string): string {
  return CAT_COLOR[cls] ?? "var(--faint)";
}

function dot(cls: string): HTMLSpanElement {
  const d = span(`cx-dot ${cls}`);
  d.style.background = colorOf(cls);
  return d;
}

/** 横向堆叠条：宽度按 tokens 占比。 */
function stackBar(cats: CtxCats | CtxBill, total: number): HTMLDivElement {
  const bar = div("cx-stack");
  const sum = Math.max(1, total);
  for (const c of CTX_CATS) {
    const n = (cats as any)[c.id] ?? 0;
    if (!n) continue;
    const seg = span(`cx-seg ${c.cls}`);
    seg.style.width = `${(n / sum) * 100}%`;
    seg.style.background = colorOf(c.cls);
    bar.append(seg);
  }
  return bar;
}

function donut(rows: Array<{ tokens: number; cls: string }>, top: string, sub: string): HTMLDivElement {
  const total = rows.reduce((s, r) => s + Math.max(0, r.tokens), 0) || 1;
  const wrap = div("cx-donut");
  const size = 96;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 42 42");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
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
    circle.setAttribute("stroke", colorOf(r.cls));
    circle.setAttribute("stroke-dasharray", `${pct} ${100 - pct}`);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    circle.setAttribute("transform", "rotate(-90 21 21)");
    svg.append(circle);
    offset += pct;
  }
  const center = div("cx-donut-center", el("b", "", top), el("span", "", sub));
  wrap.append(svg, center);
  return wrap;
}

function legendRow(rows: Array<{ id: string; label: string; cls: string; tokens: number; pct: number }>): HTMLDivElement {
  const list = div("cx-legend");
  for (const r of rows) {
    const row = div("cx-legend-row");
    const main = div("cx-legend-main", dot(r.cls), span("cx-legend-label", r.label), span("cx-legend-pct", ctxPct(r.pct)));
    const sub = span("cx-legend-sub", `≈${ctxFmt(r.tokens)}`);
    row.append(main, sub);
    list.append(row);
  }
  return list;
}

function card(title: string, glyph: string, ...kids: Kids): HTMLElement {
  const box = el("section", "cx-card");
  const head = div("cx-card-head", span("cx-card-title", icon("cx-ico-card", glyph), title));
  box.append(head, ...(kids.filter((kid): kid is Node | string => kid != null && kid !== false)));
  return box;
}

function chip(label: string, n: number | null, cls = "cx-chip", onClick?: () => void): HTMLElement {
  const c = onClick ? button(cls, "", onClick) : span(cls);
  c.append(span("cx-chip-label", label));
  if (n != null) c.append(el("b", "", String(n)));
  return c;
}

function empty(text: string): HTMLDivElement {
  return div("cx-empty", text);
}

/** 正文的可读化视图：`skills` = 技能目录表，`md` = Markdown，`null` = 原样 `<pre>`。 */
type VizKind = "skills" | "md" | null;

/**
 * 按内容缓存的小表：面板每来一行日志就整块重画，解析 XML / 建 Markdown DOM 不能每次都重来。
 * 同一 key 的 src 变了就地重算；超过上限整表清空（面板里活着的条目本来就有限）。
 */
function memo<V>(cap: number) {
  const map = new Map<string, { src: string; value: V }>();
  return (key: string, src: string, make: (src: string) => V): V => {
    const hit = map.get(key);
    if (hit && hit.src === src) return hit.value;
    if (map.size > cap) map.clear();
    const value = make(src);
    map.set(key, { src, value });
    return value;
  };
}

function shortPath(path: string): string {
  if (path.length <= 64) return path;
  const parts = path.split("/");
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function baseName(path: string): string {
  const p = path.split(/[\\/]/).filter(Boolean);
  return p[p.length - 1] ?? path;
}

/** 把请求 seq 映射到 T/S，事件行、趋势提示都用它。 */
function turnStepMap(lines: CtxLine[]): Map<number, { turn: number; step: number }> {
  const map = new Map<number, { turn: number; step: number }>();
  for (const r of ctxRequests(lines)) map.set(r.seq, { turn: r.turn ?? 1, step: r.step ?? 1 });
  return map;
}

/** 事件行的图标 / 名称 / 详情只推导一次，UI 循环不再写三组并行 ternary。 */
function eventDisplay(e: CtxEvent): { icon: string; name: string; detail: string } {
  switch (e.kind) {
    case "inject":
      return { icon: "+", name: tr("注入"), detail: e.label || "–" };
    case "compact":
    case "compact_failed":
      return {
        icon: e.kind === "compact" ? "✂" : "⚠",
        name: e.kind === "compact" ? tr("压缩上下文") : tr("压缩失败"),
        detail: [e.before == null ? "" : `${ctxFmt(e.before)} tokens`, e.reason].filter(Boolean).join(" · ") || "–",
      };
    case "model":
      return { icon: "⇄", name: tr("模型切换"), detail: `${e.previous || "–"} → ${e.model || "–"}` };
  }
}

export class ContextPanel {
  private readonly host: HTMLElement;
  private data: ContextPanelData | null = null;
  private pickSeq: number | null = null;
  private gran: "step" | "turn" = "step";
  private trendMode: "full" | "delta" = "full";
  private base: "step" | "turn" = "step";
  private browserMode: "full" | "delta" = "full";
  private readonly openCats = new Set<string>();
  private readonly openItems = new Set<string>();
  /** 哪些条目类目被切到「原文」；默认都是可读化视图。 */
  private readonly vizRaw = new Set<string>();
  /** 技能目录里展开了哪几个技能（名字 + 路径；整块重画后仍保留）。 */
  private readonly openSkills = new Set<string>();
  private readonly skillMemo = memo<SkillCatalog>(24);
  private readonly sectionMemo = memo<string>(24);
  private readonly mdMemo = memo<Node[]>(40);
  private readonly catQuery = new Map<string, string>();
  private readonly asstKind = new Map<string, string>();
  private toolSort: "size" | "name" = "size";
  private fileFilter: "all" | "read" | "write" | "search" = "all";
  private fileSort: "count" | "lines" | "latest" | "path" | "name" = "count";
  private fileQuery = "";
  private cmdFilter: "all" | "failed" | "slow" | "background" = "all";
  private cmdSort: "latest" | "slowest" = "latest";
  private cmdQuery = "";
  private eventKind: CtxEvent["kind"] | null = null;
  /** 过滤框正在组字：这期间不重画（见 `searchBox`）。 */
  private composing = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  update(data: ContextPanelData): void {
    this.data = data;
    const reqs = ctxRequests(data.lines);
    if (this.pickSeq != null && !reqs.some((r) => r.seq === this.pickSeq)) this.pickSeq = null;
    this.render();
  }

  /**
   * 面板里的过滤框。每敲一下都整块重画，但输入法组字期间（拼音 / 假名还没上屏）不能重画：
   * 换掉 input 会把半截拼音当成文字提交（「wen」+「wenj文件」）。组字时只记值，上屏后再画；
   * 这段时间里 ctxlog / stats 触发的重画也一起推迟。
   */
  private searchBox(key: string, placeholder: string, value: string, set: (v: string) => void): HTMLInputElement {
    const search = el("input", "cx-search");
    search.type = "search";
    search.dataset.cxKey = key;
    search.placeholder = placeholder;
    search.value = value;
    search.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    search.addEventListener("compositionend", () => {
      this.composing = false;
      set(search.value);
      this.render();
    });
    search.addEventListener("input", (ev) => {
      if (this.composing || (ev as InputEvent).isComposing) return;
      set(search.value);
      this.render();
    });
    // 组字中途失焦而浏览器没发 compositionend：别让面板从此不再重画。
    search.addEventListener("blur", () => {
      if (!this.composing) return;
      this.composing = false;
      set(search.value);
      this.render();
    });
    return search;
  }

  private render(): void {
    if (this.composing) return; // compositionend 会补画一次
    const data = this.data;
    const scroller = this.host.closest<HTMLElement>(".settings-body");
    const top = scroller?.scrollTop ?? 0;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement && this.host.contains(active) ? active.dataset.cxKey ?? null : null;
    const focusPlaceholder = active instanceof HTMLInputElement && this.host.contains(active) ? active.placeholder : null;
    const focusCaret = focusPlaceholder || focusKey ? (active as HTMLInputElement).selectionStart : null;
    this.host.replaceChildren();
    if (!data) return;
    if (!data.owned) {
      this.host.append(el("div", "cx-root", empty(tr("接管会话后可见（组成数据来自正在运行的 pi）"))));
      return;
    }
    const reqs = ctxRequests(data.lines);
    if (!reqs.length) {
      // 还没有 request，但扩展可能已经记了注入 / 文件 / 命令；别把这些数据藏起来。
      const root = div("cx-root", empty(tr("还没有组成数据：发一条消息，下一轮就有（估算，供参考）")));
      if (data.lines.length) root.append(this.eventsCard(data.lines), this.filesCard(data.lines), this.commandsCard(data.lines));
      this.host.append(root);
      return;
    }
    const summary = ctxSummary(data.lines);
    const token = ctxTokenStats(data.lines);
    const timing = ctxTiming(data.lines);
    const kpis = ctxKpis(reqs, data.contextWindow, data.measured, data.policy);
    const root = div("cx-root");
    root.append(
      div("cx-top", this.statsCard(summary), this.meterCard(data, kpis, token)),
      div("cx-duo", this.tokenCard(token), this.timingCard(timing)),
      div("cx-main", this.currentCard(data, kpis, reqs), this.browserCard(data.lines, reqs)),
      this.trendCard(data.lines, reqs, summary),
      div("cx-lower", this.eventsCard(data.lines), this.filesCard(data.lines)),
      this.commandsCard(data.lines),
    );
    this.host.append(root);
    if (scroller) scroller.scrollTop = top;
    if (focusKey || focusPlaceholder) {
      const next =
        (focusKey ? this.host.querySelector<HTMLInputElement>(`input[data-cx-key="${focusKey}"]`) : null) ??
        [...this.host.querySelectorAll<HTMLInputElement>("input.cx-search")].find((i) => i.placeholder === focusPlaceholder);
      if (next) {
        next.focus();
        if (focusCaret != null) next.setSelectionRange(focusCaret, focusCaret);
      }
    }
  }

  // ---------------------------------------------------------------- stats ledger

  private statsCard(summary: ReturnType<typeof ctxSummary>): HTMLElement {
    const box = card(tr("上下文统计"), "▦");
    box.classList.add("cx-stats");
    const kpis = div(
      "cx-kpis",
      this.kpi(tr("轮次"), String(summary.turns)),
      this.kpi(tr("步数"), String(summary.steps)),
      this.kpi(tr("技能加载"), String(summary.skills)),
      this.kpi(tr("模型回复"), String(summary.answers)),
    );
    box.append(kpis);

    const eventRow = div("cx-ledger");
    eventRow.append(
      span("cx-ledger-label", tr("上下文事件")),
      chip(tr("注入"), summary.events.inject, "cx-chip cx-chip-event"),
      chip(tr("压缩"), summary.events.compact, "cx-chip cx-chip-event"),
      chip(tr("剪枝"), summary.events.prune, "cx-chip cx-chip-event cx-chip-dim"),
      chip(tr("切换"), summary.events.model, "cx-chip cx-chip-event cx-chip-dim"),
    );
    box.append(eventRow);

    const tools = summary.toolRows;
    const toolRow = div("cx-ledger");
    toolRow.append(span("cx-ledger-label", tr("工具调用")), el("b", "cx-ledger-total", String(tools.reduce((s, t) => s + t.runs, 0))));
    const topTools = tools.slice(0, 5);
    for (const t of topTools) toolRow.append(chip(t.tool, t.runs, "cx-chip cx-chip-tool"));
    if (tools.length > topTools.length) toolRow.append(chip(tr("其他 +{p1}", { p1: String(tools.length - topTools.length) }), null, "cx-chip cx-chip-dim"));
    box.append(toolRow);

    const cmds = summary.commandRows;
    const cmdRow = div("cx-ledger");
    cmdRow.append(span("cx-ledger-label", tr("命令执行")), el("b", "cx-ledger-total", String(cmds.reduce((s, c) => s + c.runs, 0))));
    const topCmds = cmds.slice(0, 5);
    for (const c of topCmds) cmdRow.append(chip(c.program, c.runs, "cx-chip cx-chip-cmd"));
    if (cmds.length > topCmds.length) cmdRow.append(chip(tr("其他 +{p1}", { p1: String(cmds.length - topCmds.length) }), null, "cx-chip cx-chip-dim"));
    box.append(cmdRow);

    const userRow = div("cx-ledger");
    userRow.append(
      span("cx-ledger-label", tr("输入输出")),
      chip(tr("用户"), summary.users, "cx-chip cx-chip-user"),
      chip(tr("读取"), summary.fileRows.reduce((s, f) => s + f.reads, 0), "cx-chip cx-chip-file"),
      chip(tr("写入"), summary.fileRows.reduce((s, f) => s + f.writes, 0), "cx-chip cx-chip-file cx-chip-dim"),
    );
    box.append(userRow);
    return box;
  }

  private kpi(label: string, value: string): HTMLElement {
    const k = div("cx-kpi", span("cx-kpi-k", label), el("b", "cx-kpi-v", value));
    return k;
  }

  // ---------------------------------------------------------------- meter

  private meterCard(data: ContextPanelData, kpis: ReturnType<typeof ctxKpis>, token: ReturnType<typeof ctxTokenStats>): HTMLElement {
    const box = card(tr("会话计量"), "◔");
    const total = token.actual || data.tokens?.total || kpis.current;
    const cost = data.cost == null ? "–" : `$${data.cost.toFixed(4)}`;
    const grid = div(
      "cx-meter-grid",
      this.meter(tr("累计 token"), ctxFmt(total)),
      this.meter(tr("累计费用"), cost),
      this.meter(tr("当前上下文"), ctxFmt(kpis.current)),
      this.meter(tr("缓存命中"), token.cacheHit == null ? "–" : ctxPct(token.cacheHit, 2)),
      this.meter(tr("本会话峰值"), ctxFmt(kpis.peak)),
      this.meter(tr("距自动压缩"), kpis.tillCompact == null ? "–" : `~${ctxFmt(kpis.tillCompact)}`),
      this.meter(tr("距自动交接"), kpis.tillHandoff == null ? "–" : `~${ctxFmt(kpis.tillHandoff)}`),
    );
    box.append(grid);
    if (data.contextWindow) {
      box.append(div("cx-meter-line", tr("窗口 {p1}", { p1: ctxFmt(data.contextWindow) }), span("cx-meter-pct", ctxPct((kpis.current / data.contextWindow) * 100))));
    }
    const lines: string[] = [];
    if (kpis.compactLine != null && kpis.compactPercent != null) {
      lines.push(tr("自动压缩 {p1}% ≈ {p2}", { p1: String(Math.round(kpis.compactPercent)), p2: ctxFmt(kpis.compactLine) }));
    }
    if (kpis.handoffLine != null && kpis.handoffPercent != null) {
      lines.push(tr("自动交接 {p1}% ≈ {p2}", { p1: String(Math.round(kpis.handoffPercent)), p2: ctxFmt(kpis.handoffLine) }));
    }
    if (lines.length) box.append(div("cx-note cx-lines", ...lines.map((line) => span("cx-line", line))));
    box.append(
      div(
        "cx-note",
        tr("输入 {p1} · 输出 {p2} · 缓存读 {p3} · 缓存写 {p4}", {
          p1: ctxFmt(token.input),
          p2: ctxFmt(token.output),
          p3: ctxFmt(token.cacheRead),
          p4: ctxFmt(token.cacheWrite),
        }),
      ),
      div("cx-note", tr("总计为 provider 计费口径；组成拆分是本地估算，不混算")),
    );
    return box;
  }

  private meter(label: string, value: string): HTMLElement {
    return div("cx-meter", span("cx-meter-k", label), el("b", "cx-meter-v", value));
  }

  // ---------------------------------------------------------------- token & timing

  private tokenCard(token: ReturnType<typeof ctxTokenStats>): HTMLElement {
    const rows = ctxBillRows(token);
    const box = card(tr("Token 统计"), "◔");
    box.querySelector(".cx-card-head")?.append(span("cx-badge", tr("缓存命中 {p1}", { p1: token.cacheHit == null ? "–" : ctxPct(token.cacheHit, 2) })));
    const body = div("cx-donut-row");
    body.append(donut(rows.map((r) => ({ tokens: r.tokens, cls: r.cls })), ctxFmt(token.total), tr("总用量")), legendRow(rows));
    box.append(body);
    return box;
  }

  private timingCard(timing: ReturnType<typeof ctxTiming>): HTMLElement {
    const box = card(tr("耗时统计"), "◷");
    box.querySelector(".cx-card-head")?.append(span("cx-badge", timing.tps == null ? "–" : tr("输出速度 {p1} tok/s", { p1: String(Math.round(timing.tps)) })));
    const rows: CtxTimingRow[] = timing.rows;
    const body = div("cx-donut-row");
    const legend = div("cx-legend");
    for (const r of rows) {
      const row = div("cx-legend-row");
      row.append(
        div("cx-legend-main", dot(r.cls), span("cx-legend-label", tr(r.label)), span("cx-legend-pct", ctxPct(r.pct))),
        span("cx-legend-sub", r.id === "tool" && r.count ? ctxDur(r.ms) + " · " + tr("{p1}次", { p1: String(r.count) }) : ctxDur(r.ms)),
      );
      legend.append(row);
    }
    body.append(donut(rows.map((r) => ({ tokens: r.ms, cls: r.cls })), ctxDur(timing.total), tr("活跃时长")), legend);
    box.append(body);
    const timeline = div("cx-timeline");
    for (const r of rows) {
      if (r.ms <= 0) continue;
      const seg = span(`cx-timeline-seg ${r.cls}`);
      seg.style.width = `${r.pct}%`;
      seg.style.background = colorOf(r.cls);
      seg.title = `${tr(r.label)} · ${ctxDur(r.ms)}`;
      timeline.append(seg);
    }
    box.append(timeline, div("cx-timeline-labels", span("", "0"), span("", ctxDur(timing.total / 4)), span("", ctxDur(timing.total / 2)), span("", ctxDur((timing.total * 3) / 4)), span("", ctxDur(timing.total))));
    return box;
  }

  // ---------------------------------------------------------------- current context

  private currentCard(data: ContextPanelData, kpis: ReturnType<typeof ctxKpis>, reqs: CtxLine[]): HTMLElement {
    const box = card(tr("当前上下文"), "◉");
    box.querySelector(".cx-card-head")?.append(span("cx-badge", data.model || "–"));
    const last = reqs[reqs.length - 1]!;
    const pct = kpis.window ? (kpis.current / kpis.window) * 100 : 0;
    const head = div(
      "cx-current-head",
      div("cx-current-num", el("b", "", ctxFmt(kpis.current)), span("", kpis.window ? tr(" / {p1} tokens", { p1: ctxFmt(kpis.window) }) : "")),
      div("cx-current-pct", span("", ctxPct(pct)), span("cx-current-label", tr("上下文已用"))),
    );
    box.append(head);
    const bar = div("cx-progress");
    const used = div("cx-progress-used");
    const total = Math.max(1, kpis.window ?? kpis.current);
    // 外层先定宽（占窗口几成），段再按类目在已用部分里分：只给段写百分比时，父级是按内容收缩的 flex 项，
    // 百分比无从解析，整条只剩几个 1px（39.6% 画成 7px）。
    const usedSum = CTX_CATS.reduce((s, c) => s + (last.cats?.[c.id] ?? 0), 0);
    used.style.width = `${Math.min(100, (usedSum / total) * 100)}%`;
    for (const c of CTX_CATS) {
      const n = last.cats?.[c.id] ?? 0;
      if (!n) continue;
      const seg = span(`cx-progress-seg ${c.cls}`);
      seg.style.width = `${(n / Math.max(1, usedSum)) * 100}%`;
      seg.style.background = colorOf(c.cls);
      used.append(seg);
    }
    bar.append(used, span("cx-progress-free"));
    box.append(bar);
    const rows = ctxCompRows(last);
    const legend = div("cx-legend cx-legend-2col");
    for (const r of rows) {
      const row = div("cx-legend-row");
      row.append(div("cx-legend-main", dot(r.cls), span("cx-legend-label", r.label), span("cx-legend-pct", ctxPct(r.pct))), span("cx-legend-sub", `≈${ctxFmt(r.tokens)}`));
      legend.append(row);
    }
    box.append(legend);
    if (kpis.measured != null && kpis.measured > 0 && last.total && kpis.measured !== last.total) {
      box.append(div("cx-note", tr("估算合计 ≈ {p1} · 实际 {p2}", { p1: ctxFmt(last.total), p2: ctxFmt(kpis.measured) })));
    } else {
      box.append(div("cx-note", tr("组成是本地估算（CJK÷1.5 / 其他÷4），不等于 provider 计费 token")));
    }
    return box;
  }

  // ---------------------------------------------------------------- browser

  private browserCard(lines: CtxLine[], reqs: CtxLine[]): HTMLElement {
    const box = card(tr("上下文浏览器"), "▤");
    const selectedSeq = this.pickSeq ?? reqs[reqs.length - 1]!.seq;
    const view = ctxBrowserView(lines, selectedSeq, this.base, this.browserMode);
    const head = box.querySelector(".cx-card-head")!;
    const controls = div("cx-browser-controls");
    const select = el("select", "cx-select");
    // 下拉只列最近 40 次；从趋势图点了更早的柱子时把那一项补在最前面，否则下拉会显示成别的步。
    const listed = reqs.slice(-40);
    const picked = reqs.find((r) => r.seq === selectedSeq);
    if (picked && !listed.includes(picked)) listed.unshift(picked);
    for (const r of listed) {
      const opt = el("option", "", `T${r.turn ?? 1} · S${r.step ?? 1}`);
      opt.value = String(r.seq);
      if (r.seq === selectedSeq) opt.selected = true;
      select.append(opt);
    }
    select.onchange = () => {
      this.pickSeq = Number(select.value);
      this.render();
    };
    controls.append(select);
    for (const [id, label] of [["step", tr("比前步")], ["turn", tr("比前轮")]] as const) {
      controls.append(button(`cx-seg${this.base === id ? " on" : ""}`, label, () => {
        this.base = id;
        this.render();
      }));
    }
    for (const [id, label] of [["full", tr("全量")], ["delta", tr("增量")]] as const) {
      controls.append(button(`cx-seg${this.browserMode === id ? " on" : ""}`, label, () => {
        this.browserMode = id;
        this.render();
      }));
    }
    head.append(controls);
    if (!view.selected) {
      box.append(empty(tr("还没有组成数据：发一条消息，下一轮就有（估算，供参考）")));
      return box;
    }
    const top = div("cx-browser-top");
    top.append(
      span("cx-browser-title", view.selected.seq === reqs[reqs.length - 1]!.seq ? tr("当前 · 下一次请求") : tr("第 {p1} 轮 · 第 {p2} 步", { p1: String(view.selected.turn ?? 1), p2: String(view.selected.step ?? 1) })),
      span("cx-browser-total", tr("估算合计 ≈ {p1}", { p1: ctxFmt(view.total) })),
    );
    if (view.actual != null) top.append(span("cx-browser-actual", tr("实际 {p1}", { p1: ctxFmt(view.actual) })));
    const barCats = { sys: 0, tools: 0, user: 0, inject: 0, skill: 0, asst: 0, toolr: 0 } as CtxCats;
    for (const c of view.cats) barCats[c.id as keyof CtxCats] = c.tokens;
    box.append(top, stackBar(barCats, view.total));
    const acc = div("cx-acc");
    for (const cat of view.cats) {
      if (!cat.count && !cat.tokens) continue;
      acc.append(this.browserCat(cat));
    }
    box.append(acc);
    if (view.omitted) box.append(div("cx-note", tr("… 另有 {p1} 条更早的消息也在上下文中（超出展示窗口）", { p1: String(view.omitted) })));
    return box;
  }

  private browserCat(cat: CtxBrowserCat): HTMLElement {
    const open = this.openCats.has(cat.id);
    const wrap = div(`cx-acc-item${open ? " open" : ""}`);
    const head = button("cx-acc-head", "", () => {
      if (this.openCats.has(cat.id)) this.openCats.delete(cat.id);
      else this.openCats.add(cat.id);
      this.render();
    });
    head.append(dot(cat.cls), span("cx-acc-label", cat.label), span("cx-acc-count", tr("{p1} 项", { p1: String(cat.count) })));
    head.append(span("cx-acc-tokens", `≈${ctxFmt(cat.tokens)}`), span("cx-acc-pct", ctxPct(cat.pct)), span("cx-caret", open ? "⌃" : "⌄"));
    // 开关放在类目头行：不展开类目也能看见「这段正文能读、也能退回原文」。
    if (cat.items.some((it) => this.vizKind(it))) {
      const top = div("cx-acc-top");
      top.append(head, this.vizToggle(cat));
      wrap.append(top);
    } else wrap.append(head);
    if (open) {
      const body = div("cx-acc-body");
      const bar = div("cx-browser-filters");
      const query = this.catQuery.get(cat.id) ?? "";
      bar.append(this.searchBox(`cat:${cat.id}`, tr("过滤条目…"), query, (v) => this.catQuery.set(cat.id, v)));
      if (cat.id === "asst") {
        const counts = { reasoning: 0, call: 0, answer: 0 } as Record<string, number>;
        for (const it of cat.items) if (it.kind && it.kind in counts) counts[it.kind] += 1;
        const picked = this.asstKind.get(cat.id) ?? "";
        for (const [id, label] of [["reasoning", tr("思考")], ["call", tr("工具")], ["answer", tr("回答")]] as const) {
          bar.append(
            button(`cx-seg${picked === id ? " on" : ""}`, `${label} ${counts[id]}`, () => {
              this.asstKind.set(cat.id, picked === id ? "" : id);
              this.render();
            }),
          );
        }
      }
      if (cat.id === "tools") {
        for (const [id, label] of [["size", tr("按大小")], ["name", tr("按名称")]] as const) {
          bar.append(
            button(`cx-seg${this.toolSort === id ? " on" : ""}`, label, () => {
              this.toolSort = id;
              this.render();
            }),
          );
        }
      }
      body.append(bar);
      const needle = query.trim().toLowerCase();
      const kind = this.asstKind.get(cat.id) ?? "";
      let items = cat.items.filter((it) => {
        if (kind && it.kind !== kind) return false;
        if (!needle) return true;
        return [it.label, it.sub, it.preview, it.content].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
      });
      if (cat.id === "tools") {
        items = [...items].sort((a, b) => (this.toolSort === "name" ? a.label.localeCompare(b.label) : b.tokens - a.tokens || a.label.localeCompare(b.label)));
      }
      if (!items.length) body.append(empty(tr("没有匹配当前过滤条件的行")));
      for (const item of items.slice(0, 80)) body.append(this.browserItem(item));
      if (items.length > 80) body.append(div("cx-note", tr("另有 {p1} 项未显示", { p1: String(items.length - 80) })));
      if (query || kind) body.append(div("cx-note", tr("已过滤：{p1} / {p2} 项", { p1: String(items.length), p2: String(cat.items.length) })));
      wrap.append(body);
    }
    return wrap;
  }

  /** 类目头行上的「可视化 / 原文」开关；原文就是改造之前那段纯文本。 */
  private vizToggle(cat: CtxBrowserCat): HTMLElement {
    const raw = this.vizRaw.has(cat.id);
    const toggle = div("cx-viz-toggle");
    toggle.append(
      button(`cx-seg${raw ? "" : " on"}`, tr("可视化"), () => {
        this.vizRaw.delete(cat.id);
        this.render();
      }),
      button(`cx-seg${raw ? " on" : ""}`, tr("原文"), () => {
        this.vizRaw.add(cat.id);
        this.render();
      }),
    );
    return toggle;
  }

  /** 一行条目：收起时是预览，展开显示 prompt / schema / 消息 / 参数 / 结果正文。 */
  private browserItem(item: CtxItem): HTMLElement {
    const open = this.openItems.has(item.id);
    const wrap = div(`cx-item-wrap${open ? " open" : ""}`);
    const row = button("cx-item", "", () => {
      if (this.openItems.has(item.id)) this.openItems.delete(item.id);
      else this.openItems.add(item.id);
      this.render();
    });
    let viz = this.vizRaw.has(item.cat) ? null : this.vizKind(item);
    let catalog = viz === "skills" ? this.catalogOf(item) : null;
    // 解析不出技能条目（旧日志 / 格式变了）时退回原文，而不是画一张空表。
    if (viz === "skills" && !catalog?.skills.length) {
      viz = null;
      catalog = null;
    }
    // 读得懂的正文，行上也换成读得懂的摘要：`<skills>` 那段 XML 的第一行对人不构成信息。
    const label = catalog ? tr("技能目录") : item.label || item.kind || "?";
    const preview = this.itemPreview(item, viz, catalog);
    const main = div("cx-item-main", span("cx-item-label", label), item.sub ? span("cx-item-sub", item.sub) : null);
    if (preview) main.append(span("cx-item-preview", preview));
    row.append(span("cx-caret", open ? "⌄" : "›"), main, span("cx-item-tokens", `≈${ctxFmt(item.tokens)}`));
    if (item.kind) row.title = `${item.label} · ${item.kind}`;
    wrap.append(row);
    if (open) {
      const detail = div("cx-item-detail");
      const meta = div("cx-item-meta");
      if (item.body?.tool) meta.append(span("cx-item-tag", tr("工具 · {p1}", { p1: item.body.tool })));
      if (item.body?.status) meta.append(span(`cx-item-tag ${item.body.status === "failed" ? "bad" : "ok"}`, item.body.status === "failed" ? tr("失败") : "OK"));
      if (item.body?.command) meta.append(span("cx-item-tag mono", item.body.command));
      if (item.body?.exitCode != null) meta.append(span("cx-item-tag mono", `exit ${item.body.exitCode}`));
      if (item.body?.path) meta.append(span("cx-item-tag mono", item.body.path));
      if (meta.childNodes.length) detail.append(meta);
      if (item.body?.args) {
        detail.append(div("cx-item-section", tr("参数")));
        detail.append(el("pre", "cx-item-body", item.body.args));
      }
      if (item.content) {
        if (item.body?.args) detail.append(div("cx-item-section", tr("结果")));
        detail.append(this.itemBody(item, viz, catalog));
      } else if (item.preview) {
        detail.append(el("pre", "cx-item-body", item.preview));
        detail.append(div("cx-note", tr("旧版日志只保留了预览；下一次请求起可以展开正文")));
      } else {
        detail.append(div("cx-item-missing", tr("这条没有可显示的正文（图片或空消息）")));
      }
      wrap.append(detail);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- 可读化正文

  /**
   * 这条正文能不能换成读得懂的视图：技能目录（`sec:skills`）/ Markdown（SKILL.md、注入段）。
   * 只看 kind / cat，不解析内容 —— 解析留到真要画的那一刻，由 `catalogOf` / `sectionMd` 各自缓存。
   */
  private vizKind(item: CtxItem): VizKind {
    if (!item.content) return null;
    if (item.kind === "skill") return "md";
    if (item.cat === "inject") return item.kind === "section" || item.kind === "inject" ? "md" : null;
    if (item.cat === "skill" && item.kind === "section") return "skills";
    return null;
  }

  /** 行上的摘要：目录给条数，注入段给读得懂的第一行，其余保持原样。 */
  private itemPreview(item: CtxItem, viz: VizKind, catalog: SkillCatalog | null): string {
    if (catalog) return tr("共 {p1} 个技能", { p1: String(catalog.skills.length) });
    if (viz === "md" && item.cat === "inject") {
      const line = this.sectionMd(item).split("\n").find((l) => l.trim());
      return (line ?? item.preview ?? "").trim();
    }
    return item.preview ?? "";
  }

  /** 展开后的正文：技能目录表 / Markdown / 原来的纯文本。 */
  private itemBody(item: CtxItem, viz: VizKind, catalog: SkillCatalog | null): HTMLElement {
    if (viz === "skills" && catalog) return this.skillTable(item.cat, catalog);
    if (viz === "md") return this.markdownBody(item);
    return el("pre", "cx-item-body", item.content ?? "");
  }

  /** 解析 `sec:skills` 的 XML；同一份 content 只解析一次（面板每来一行日志就重画一遍）。 */
  private catalogOf(item: CtxItem): SkillCatalog {
    return this.skillMemo(item.id, item.content ?? "", ctxSkillCatalog);
  }

  /** 注入段正文 → Markdown（剥分节标签 + 文件分界行）。预览行与展开正文共用这一份结果。 */
  private sectionMd(item: CtxItem): string {
    return this.sectionMemo(item.id, item.content ?? "", ctxSectionMarkdown);
  }

  /** 技能目录：两列紧凑表（名字 / 两行说明），点一行看完整说明与 SKILL.md 路径。 */
  private skillTable(catId: string, catalog: SkillCatalog): HTMLElement {
    const box = div("cx-viz cx-skill-table");
    const needle = (this.catQuery.get(catId) ?? "").trim().toLowerCase();
    const rows = needle
      ? catalog.skills.filter((s) => `${s.name}\n${s.description}\n${s.location}`.toLowerCase().includes(needle))
      : catalog.skills;
    const head = div("cx-skill-intro");
    head.append(
      span(
        "cx-skill-count",
        rows.length === catalog.skills.length
          ? tr("共 {p1} 个技能", { p1: String(rows.length) })
          : tr("{p1} / {p2} 个技能", { p1: String(rows.length), p2: String(catalog.skills.length) }),
      ),
    );
    if (catalog.intro) {
      const note = span("cx-skill-note", catalog.intro);
      note.title = catalog.intro;
      head.append(note);
    }
    box.append(head);
    if (!rows.length) box.append(empty(tr("没有匹配的技能")));
    for (const s of rows) box.append(this.skillRow(s));
    return box;
  }

  private skillRow(s: SkillEntry): HTMLElement {
    // 同名技能可能来自两个目录，展开状态按 名字+路径 记，别互相带着开。
    const key = `${s.name}\n${s.location}`;
    const open = this.openSkills.has(key);
    // 按钮而不是 div：42 行里靠键盘也能走（Tab + Enter），和类目里其它行一致。
    const row = el("button", `cx-skill-row${open ? " open" : ""}`);
    row.type = "button";
    row.title = s.location ? `${s.name} · ${s.location}` : s.name;
    row.setAttribute("aria-expanded", String(open));
    row.append(span("cx-skill-name", s.name), span("cx-skill-desc", s.description || tr("（没有描述）")));
    if (open && s.location) row.append(span("cx-skill-path", s.location));
    // 就地展开 / 收起：整块重画会把列表滚回顶部（42 个技能时很难忍）。
    row.onclick = () => {
      const willOpen = !this.openSkills.has(key);
      if (willOpen) this.openSkills.add(key);
      else this.openSkills.delete(key);
      row.classList.toggle("open", willOpen);
      row.setAttribute("aria-expanded", String(willOpen));
      row.querySelector(".cx-skill-path")?.remove();
      if (willOpen && s.location) row.append(span("cx-skill-path", s.location));
    };
    return row;
  }

  /** SKILL.md / 注入段走 Markdown。节点按内容缓存：面板更新很密，别每来一行就重解析一遍。 */
  private markdownBody(item: CtxItem): HTMLElement {
    const box = div("cx-viz cx-md");
    const nodes = this.mdMemo(`${item.id}#md`, this.sectionMd(item), (src) => Array.from(renderMarkdown(src, { doc: true }).childNodes));
    box.append(...nodes);
    return box;
  }

  // ---------------------------------------------------------------- trend

  private trendCard(lines: CtxLine[], reqs: CtxLine[], summary: ReturnType<typeof ctxSummary>): HTMLElement {
    const box = card(tr("上下文趋势"), "▥");
    const head = box.querySelector(".cx-card-head")!;
    const controls = div("cx-trend-controls");
    for (const [id, label] of [["step", tr("步骤")], ["turn", tr("轮次")]] as const) {
      controls.append(button(`cx-seg${this.gran === id ? " on" : ""}`, label, () => {
        this.gran = id;
        this.render();
      }));
    }
    for (const [id, label] of [["full", tr("全量")], ["delta", tr("增量")]] as const) {
      controls.append(button(`cx-seg${this.trendMode === id ? " on" : ""}`, label, () => {
        this.trendMode = id;
        this.render();
      }));
    }
    head.append(controls);
    const rows = ctxTrendRows(lines, this.gran, this.trendMode);
    if (!rows.length) {
      box.append(empty(tr("发起一轮对话后，这里会展示每次模型请求的上下文构成")));
      return box;
    }
    const pickedSeq = this.pickSeq ?? reqs[reqs.length - 1]!.seq;
    // 「轮次」粒度下一根柱 = 一轮，seq 是该轮最后一步；选中的若是轮中间的一步，就落在包含它的那一轮。
    const pickedRow = rows.find((r) => r.seq >= pickedSeq) ?? rows[rows.length - 1]!;
    const max = Math.max(...rows.map((r) => r.total), 1);
    const chart = div("cx-chart");
    const yaxis = div("cx-yaxis");
    for (let i = 4; i >= 0; i--) yaxis.append(span("", ctxFmt((max * i) / 4)));
    const grid = div("cx-grid");
    for (let i = 0; i <= 4; i++) grid.append(span("cx-grid-line"));
    const bars = div("cx-bars");
    const scissors = ctxCompactAfterSeq(lines);
    for (const row of rows) {
      const b = button(`cx-bar${row === pickedRow ? " picked" : ""}`, "", () => {
        this.pickSeq = row.seq;
        this.render();
      });
      const tip = [`T${row.turn} S${row.step}`];
      for (const c of CTX_CATS) {
        const n = row.cats[c.id] ?? 0;
        if (n) tip.push(`${tr(c.label)} ${ctxFmt(n)}`);
      }
      if (row.actual) tip.push(tr("实际"), ctxFmt(row.actual));
      b.title = tip.join(" · ");
      const stack = div("cx-bar-stack");
      stack.style.height = `${(row.total / max) * 100}%`;
      for (const c of CTX_CATS) {
        const n = row.cats[c.id] ?? 0;
        if (!n) continue;
        const seg = span(`cx-bar-seg ${c.cls}`);
        seg.style.height = `${(n / Math.max(1, row.total)) * 100}%`;
        seg.style.background = colorOf(c.cls);
        stack.append(seg);
      }
      b.append(stack);
      if (scissors.has(row.seq)) b.append(span("cx-scissor", "✂"));
      bars.append(b);
    }
    const plot = div("cx-plot", grid, bars);
    chart.append(yaxis, plot);
    box.append(chart);
    const xlabels = div("cx-xlabels");
    rows.forEach((r, i) => {
      if (rows.length > 12 && i % Math.ceil(rows.length / 8) !== 0 && i !== rows.length - 1) return;
      xlabels.append(span("", this.gran === "turn" ? String(r.turn) : String(r.step)));
    });
    box.append(xlabels, this.trendDetail(pickedRow, summary, reqs));
    return box;
  }

  private trendDetail(row: CtxTrendRow, summary: ReturnType<typeof ctxSummary>, reqs: CtxLine[]): HTMLElement {
    const box = div("cx-detail");
    const total = ctxTotal(row.request);
    const sameTurn = reqs.filter((r) => (r.turn ?? 1) === row.turn).length;
    const title = div(
      "cx-detail-title",
      span("", tr("第 {p1} 轮 · 第 {p2} 步 (共 {p3} 步)", { p1: String(row.turn), p2: String(row.step), p3: String(sameTurn || summary.steps) })),
      span("cx-detail-time", fmtTime(row.ts)),
    );
    const badges = div("cx-badges");
    if (row.actual != null) badges.append(span("cx-badge", tr("实际 {p1}", { p1: ctxFmt(row.actual) })));
    const u = ctxUsageMap(this.data?.lines ?? []).get(row.seq) ?? null;
    if (u) {
      badges.append(span("cx-badge", tr("输出 {p1}", { p1: ctxFmt(u.usage.output) })));
      const totalInput = u.usage.input + u.usage.cacheRead + u.usage.cacheWrite;
      if (totalInput > 0) badges.append(span("cx-badge", tr("缓存 {p1}", { p1: ctxPct((u.usage.cacheRead / totalInput) * 100, 2) })));
    }
    box.append(title, badges);
    const items = row.request.items?.length ? row.request.items : [];
    const user = items.find((i) => i.cat === "user");
    const reply = items.filter((i) => i.cat === "asst").slice(-2);
    const input = items.filter((i) => i.cat === "toolr").slice(-2);
    const brief = div("cx-brief");
    brief.append(this.briefRow(tr("用户"), user?.preview ?? "–"));
    brief.append(this.briefRow(tr("输入"), input.length ? input.map((i) => i.label).join(" · ") : tr("（无新增）")));
    brief.append(this.briefRow(tr("回复"), reply.length ? reply.map((i) => i.preview || i.label).join(" · ") : "–"));
    box.append(brief);
    box.append(stackBar(row.cats, row.total));
    const legend = div("cx-legend cx-legend-4col");
    for (const c of CTX_CATS) {
      const n = row.cats[c.id] ?? 0;
      if (!n) continue;
      const r = div("cx-legend-row");
      r.append(div("cx-legend-main", dot(c.cls), span("cx-legend-label", tr(c.label)), span("cx-legend-pct", ctxPct((n / Math.max(1, row.total)) * 100))), span("cx-legend-sub", `≈${ctxFmt(n)}`));
      legend.append(r);
    }
    box.append(legend);
    if (total !== row.total) box.append(div("cx-note", tr("估算合计 ≈ {p1}", { p1: ctxFmt(total) })));
    return box;
  }

  private briefRow(label: string, text: string): HTMLElement {
    const row = div("cx-brief-row");
    row.append(span("cx-brief-k", label), span("cx-brief-v", text || "–"));
    return row;
  }

  // ---------------------------------------------------------------- events

  private eventsCard(lines: CtxLine[]): HTMLElement {
    const box = card(tr("上下文事件"), "✦");
    const all = ctxEvents(lines);
    const ts = turnStepMap(lines);
    const head = box.querySelector(".cx-card-head")!;
    const chips = div("cx-chips");
    const counts: Array<[CtxEvent["kind"], string, number]> = [
      ["inject", tr("注入"), all.filter((e) => e.kind === "inject").length],
      ["compact", tr("压缩"), all.filter((e) => e.kind === "compact").length],
      ["compact_failed", tr("失败"), all.filter((e) => e.kind === "compact_failed").length],
      ["model", tr("切换"), all.filter((e) => e.kind === "model").length],
    ];
    for (const [kind, label, n] of counts) {
      chips.append(chip(label, n, `cx-chip cx-chip-event${this.eventKind === kind ? " on" : ""}${n === 0 ? " cx-chip-dim" : ""}`, () => {
        this.eventKind = this.eventKind === kind ? null : kind;
        this.render();
      }));
    }
    head.append(chips);
    const list = div("cx-list");
    const events = this.eventKind ? all.filter((e) => e.kind === this.eventKind) : all;
    if (!events.length) list.append(empty(tr("暂无上下文事件（压缩、注入、模型切换会出现在这里）")));
    for (const e of events.slice(-30).reverse()) {
      const row = div("cx-event");
      const meta = eventDisplay(e);
      const at = ts.get(e.atSeq);
      row.append(
        span(`cx-event-ico ${e.kind}`, meta.icon),
        span("cx-event-name", meta.name),
        span("cx-event-detail", meta.detail),
        span("cx-event-at", at ? `T${at.turn} S${at.step}` : "–"),
      );
      if (e.tokens) row.append(span("cx-event-tokens", `+${ctxFmt(e.tokens)}`));
      row.append(span("cx-event-time", fmtTime(e.ts)));
      list.append(row);
    }
    box.append(list);
    return box;
  }

  // ---------------------------------------------------------------- files

  private filesCard(lines: CtxLine[]): HTMLElement {
    const box = card(tr("文件活动"), "▣");
    const all = ctxFileRows(lines);
    const head = box.querySelector(".cx-card-head")!;
    const chips = div("cx-chips");
    const counts = {
      all: all.length,
      read: all.reduce((s, f) => s + f.reads, 0),
      write: all.reduce((s, f) => s + f.writes, 0),
      search: all.reduce((s, f) => s + f.searches, 0),
    };
    for (const [id, label] of [["all", tr("全部")], ["read", tr("读取")], ["write", tr("写入")], ["search", tr("搜索")]] as const) {
      chips.append(chip(label, counts[id], `cx-chip cx-chip-file${this.fileFilter === id ? " on" : ""}${counts[id] === 0 ? " cx-chip-dim" : ""}`, () => {
        this.fileFilter = id;
        this.render();
      }));
    }
    head.append(chips);
    const tools = div("cx-tools-row");
    tools.append(this.searchBox("files", tr("按路径过滤…"), this.fileQuery, (v) => (this.fileQuery = v)));
    for (const [id, label] of [["count", tr("按次数")], ["lines", tr("按行数")], ["latest", tr("按最新")], ["path", tr("按路径")], ["name", tr("按文件名")]] as const) {
      tools.append(button(`cx-sort${this.fileSort === id ? " on" : ""}`, label, () => {
        this.fileSort = id;
        this.render();
      }));
    }
    box.append(tools);
    let rows = all.filter((f) => {
      if (this.fileFilter === "read" && !f.reads) return false;
      if (this.fileFilter === "write" && !f.writes) return false;
      if (this.fileFilter === "search" && !f.searches) return false;
      if (this.fileQuery && !f.path.toLowerCase().includes(this.fileQuery.toLowerCase())) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      if (this.fileSort === "lines") return b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path);
      if (this.fileSort === "latest") return b.lastTs - a.lastTs || a.path.localeCompare(b.path);
      if (this.fileSort === "path") return a.path.localeCompare(b.path);
      if (this.fileSort === "name") return baseName(a.path).localeCompare(baseName(b.path));
      const ac = this.fileFilter === "read" ? a.reads : this.fileFilter === "write" ? a.writes : this.fileFilter === "search" ? a.searches : a.ops;
      const bc = this.fileFilter === "read" ? b.reads : this.fileFilter === "write" ? b.writes : this.fileFilter === "search" ? b.searches : b.ops;
      return bc - ac || a.path.localeCompare(b.path);
    });
    const list = div("cx-list");
    if (!rows.length) list.append(empty(all.length ? tr("没有匹配当前过滤条件的文件") : tr("该范围内没有文件读取、写入或搜索操作")));
    for (const f of rows.slice(0, 40)) {
      const row = div("cx-file");
      const main = div("cx-file-main", span("cx-file-name", baseName(f.path)), span("cx-file-path", shortPath(f.path)));
      main.title = f.path;
      row.append(
        span("cx-file-ico", f.writes ? "✎" : f.searches ? "⌕" : "▤"),
        main,
        span("cx-file-delta", `+${f.added} −${f.removed}`),
        span("cx-file-count", `${f.ops}`),
        span("cx-file-time", fmtTime(f.lastTs)),
      );
      list.append(row);
    }
    box.append(list);
    box.append(div("cx-note", tr("{p1} 个文件 · {p2} 次操作", { p1: String(all.length), p2: String(all.reduce((s, f) => s + f.ops, 0)) })));
    return box;
  }

  // ---------------------------------------------------------------- commands

  private commandsCard(lines: CtxLine[]): HTMLElement {
    const box = card(tr("命令执行"), "▸");
    const all = ctxCommandRows(lines);
    const runs = lines.filter((l) => l.kind === "activity" && l.activity === "command");
    const head = box.querySelector(".cx-card-head")!;
    const chips = div("cx-chips");
    const failed = runs.filter((r) => r.status === "failed").length;
    const slow = runs.filter((r) => (r.durationMs ?? 0) >= 1000).length;
    const bg = runs.filter((r) => r.parent).length;
    for (const [id, label, n] of [
      ["all", tr("全部"), runs.length],
      ["failed", tr("失败"), failed],
      ["slow", tr("慢"), slow],
      ["background", tr("后台"), bg],
    ] as const) {
      chips.append(chip(label, n, `cx-chip cx-chip-cmd${this.cmdFilter === id ? " on" : ""}${n === 0 ? " cx-chip-dim" : ""}`, () => {
        this.cmdFilter = id;
        this.render();
      }));
    }
    head.append(chips);
    const summary = div(
      "cx-cmd-summary",
      this.meter(tr("运行记录"), String(runs.length)),
      this.meter(tr("合计耗时"), ctxDur(runs.reduce((s, r) => s + (r.durationMs ?? 0), 0))),
      this.meter(tr("失败"), `${failed}${runs.length ? ` · ${ctxPct((failed / runs.length) * 100)}` : ""}`),
      this.meter(tr("后台"), String(bg)),
    );
    box.append(summary);
    const tools = div("cx-tools-row");
    tools.append(this.searchBox("commands", tr("过滤命令…"), this.cmdQuery, (v) => (this.cmdQuery = v)));
    for (const [id, label] of [["latest", tr("最新")], ["slowest", tr("最慢")]] as const) {
      tools.append(button(`cx-sort${this.cmdSort === id ? " on" : ""}`, label, () => {
        this.cmdSort = id;
        this.render();
      }));
    }
    box.append(tools);
    let rows = runs.filter((r) => {
      if (this.cmdFilter === "failed" && r.status !== "failed") return false;
      if (this.cmdFilter === "slow" && (r.durationMs ?? 0) < 1000) return false;
      if (this.cmdFilter === "background" && !r.parent) return false;
      if (this.cmdQuery && !(r.program || "").toLowerCase().includes(this.cmdQuery.toLowerCase())) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => (this.cmdSort === "slowest" ? (b.durationMs ?? 0) - (a.durationMs ?? 0) : (b.ts ?? 0) - (a.ts ?? 0)));
    const body = div("cx-cmd-body");
    const rail = div("cx-cmd-rail");
    rail.append(div("cx-rail-title", tr("程序 · {p1}", { p1: String(all.length) })));
    for (const c of all.slice(0, 14)) {
      const r = div("cx-rail-row");
      r.append(span("cx-rail-name", c.program), span("cx-rail-runs", `×${c.runs}`), span("cx-rail-avg", c.avgMs == null ? "–" : ctxDur(c.avgMs)));
      rail.append(r);
    }
    const list = div("cx-list cx-cmd-list");
    if (!rows.length) list.append(empty(runs.length ? tr("没有匹配当前过滤条件的命令") : tr("本会话没有执行过命令")));
    for (const r of rows.slice(0, 40)) {
      const row = div("cx-cmd");
      row.append(
        span(`cx-cmd-status ${r.status ?? "ok"}`, r.status === "failed" ? "×" : "›"),
        span("cx-cmd-name", r.program || "?"),
      );
      if (r.parent) row.append(span("cx-badge", tr("后台")));
      row.append(span("cx-cmd-dur", r.durationMs == null ? "–" : ctxDur(r.durationMs)), span("cx-cmd-time", fmtTime(r.ts ?? 0)));
      list.append(row);
    }
    body.append(rail, list);
    box.append(body);
    return box;
  }
}

