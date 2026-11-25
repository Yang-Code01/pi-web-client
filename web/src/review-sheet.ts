/**
 * 「评审详情」dialog（#651，2026-11 改成「运行台」）。
 *
 * 上一版把左栏留给时间线、右栏留给结果，跑的时候右栏是一整片空白 —— 而时间线本身
 * 就是「第 2 组开始 / 第 2 组完成」这类可折叠的段落。所以现在：
 *
 *   抬头（谁、什么范围、第几次）+ 仪表（进度 / 用量 / 用时 / 正在读）
 *   + 左栏按**组**折叠的运行日志 + 右栏边跑边出的意见 + 底栏批量操作。
 *
 * 三条实现上的硬约束（前两条是上一版的真 bug，别再踩）：
 * - 进度帧每秒来好几次，**不能每帧重建**左右两栏：意见列表按内容签名重建，重建时按
 *   `data-key` 恢复展开项与滚动位置，否则用户刚点开的那条会被下一帧清掉。
 * - 计划里没有 `plan` 的老桥、老记录，退回「一条运行记录」的平铺日志。
 */
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { markSurface, pushEscLayer } from "./modal.ts";
import { renderFindings, type ReviewPanelInput, type Severity } from "./review.ts";

const SEV_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const pad = (n: number) => String(n).padStart(2, "0");

/** 时间线里存的是毫秒时间戳，人看的是「17:09」。 */
function clock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function mmss(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

const num = (n: number | null | undefined) => Number(n || 0).toLocaleString("en-US");

/** FNV-1a：签名里要判「这段字变没变」，只比长度会把等长改动漏掉。 */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function phaseLabel(phase: ReviewPanelInput["view"]["phase"]): string {
  switch (phase) {
    case "running":
      return tr("评审中");
    case "done":
      return tr("完成");
    case "failed":
      return tr("失败");
    case "stopped":
      return tr("已停止");
    case "stale":
      return tr("已失效");
    case "empty":
      return tr("还没跑过");
    default:
      return "";
  }
}

export class ReviewSheet {
  private readonly back: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly eyebrow: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly inst: HTMLElement;
  private readonly bigFiles: HTMLElement;
  private readonly subFiles: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly bigTokens: HTMLElement;
  private readonly subTokens: HTMLElement;
  private readonly bigTime: HTMLElement;
  private readonly subTime: HTMLElement;
  private readonly cur: HTMLElement;
  private readonly curLabel: HTMLElement;
  private readonly curText: HTMLElement;
  private readonly curHint: HTMLElement;
  private readonly logBody: HTMLElement;
  private readonly logCount: HTMLElement;
  private readonly findCount: HTMLElement;
  private readonly findFilters: HTMLElement;
  private readonly findBody: HTMLElement;
  private readonly bulkBox: HTMLElement;
  private readonly footStats: HTMLElement;
  private popEsc: (() => void) | null = null;
  private input: ReviewPanelInput;
  /** 分段的展开状态：用户点过的记住，没点过的按「正在跑的那组默认展开」。 */
  private readonly openStages = new Map<string, boolean>();
  private filter: "all" | Severity = "all";
  private logSig = "";
  private findSig = "";
  private bulkSig = "";
  onClose: (() => void) | null = null;

  constructor(input: ReviewPanelInput) {
    this.input = input;
    this.back = markSurface(el("div", "sheet-back center rv-back"), "window");
    this.back.onclick = (ev) => {
      if (ev.target === this.back) this.close();
    };

    this.sheet = el("section", "st-console rv-sheet");
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("评审详情"));
    this.sheet.tabIndex = -1;

    // ---- 抬头
    const head = el("header", "rv-sheet-head");
    const headMain = el("div", "rv-sheet-headmain");
    this.eyebrow = el("div", "rv-sheet-eyebrow", "");
    this.title = el("h2", "rv-sheet-title", tr("评审详情"));
    this.status = el("span", "rv-chip", "");
    const titleRow = el("div", "rv-sheet-titlerow");
    titleRow.append(this.title, this.status);
    this.meta = el("div", "rv-sheet-meta", "");
    headMain.append(this.eyebrow, titleRow, this.meta);
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    const headRight = el("div", "rv-sheet-headright");
    this.stopBtn = el("button", "btn ghost rv-stop-btn", tr("中断评审")) as HTMLButtonElement;
    this.stopBtn.type = "button";
    this.stopBtn.onclick = () => this.input.actions.onStop();
    headRight.append(this.stopBtn, close);
    head.append(headMain, headRight);

    // ---- 仪表：进度 / 用量 / 用时
    this.inst = el("div", "rv-inst");
    this.bigFiles = el("b", "", "0");
    this.subFiles = el("span", "", "");
    this.meter = el("div", "rv-meter");
    const filesCell = this.cell(tr("进度"), this.bigFiles, this.subFiles, this.meter);
    this.bigTokens = el("b", "", "0");
    this.subTokens = el("span", "", "");
    const tokensCell = this.cell(tr("用量"), this.bigTokens, this.subTokens);
    this.bigTime = el("b", "", "—");
    this.subTime = el("span", "", "");
    const timeCell = this.cell(tr("用时"), this.bigTime, this.subTime);
    const cells = el("div", "rv-inst-cells");
    cells.append(filesCell, tokensCell, timeCell);

    this.cur = el("div", "rv-cur");
    this.curLabel = el("span", "rv-cur-label", "");
    this.curText = el("code", "rv-cur-file", "");
    this.curHint = el("span", "rv-cur-hint", "");
    this.cur.append(el("span", "rv-dot"), this.curLabel, this.curText, this.curHint);
    this.inst.append(cells, this.cur);

    // ---- 主体：左日志 / 右意见
    const log = el("div", "rv-runlog");
    const logCap = el("div", "rv-runlog-cap");
    this.logCount = el("span", "rv-runlog-count", "");
    logCap.append(el("span", "", tr("运行日志")), this.logCount);
    this.logBody = el("div", "rv-runlog-body");
    log.append(logCap, this.logBody);

    const find = el("div", "rv-find");
    this.findCount = el("span", "rv-find-count", "");
    this.findFilters = el("div", "rv-filters");
    const findCap = el("div", "rv-find-cap");
    findCap.append(el("span", "", tr("意见")), this.findCount, this.findFilters);
    this.findBody = el("div", "rv-find-body");
    find.append(findCap, this.findBody);

    const body = el("div", "rv-sheet-body");
    body.append(log, find);

    // ---- 底栏
    const foot = el("footer", "rv-sheet-foot");
    this.bulkBox = el("div", "rv-bulk");
    this.footStats = el("div", "rv-foot-stats", "");
    foot.append(this.bulkBox, this.footStats);

    this.sheet.append(head, this.inst, body, foot);
    this.back.append(this.sheet);
    this.refresh();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
  }

  update(input: ReviewPanelInput): void {
    this.input = input;
    this.refresh();
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  private cell(label: string, big: HTMLElement, sub: HTMLElement, extra?: HTMLElement): HTMLElement {
    const cell = el("div", "rv-inst-cell");
    const top = el("div", "rv-inst-label", label);
    const line = el("div", "rv-inst-big");
    line.append(big, sub);
    cell.append(top, line);
    if (extra) cell.append(extra);
    return cell;
  }

  private refresh(): void {
    const { view } = this.input;
    const running = view.running;

    this.sheet.dataset.phase = view.phase;
    this.status.textContent = phaseLabel(view.phase);
    this.status.dataset.phase = view.phase;
    this.stopBtn.hidden = !running;

    // ---- 抬头
    const isPr = view.mode === "pr";
    const who = isPr
      ? tr("PR #{p1}", { p1: view.pr || "?" })
      : view.mode === "range"
        ? tr("{p1} vs {p2}", { p1: view.target || "HEAD", p2: view.base })
        : view.mode === "commit"
          ? tr("提交 {p1}", { p1: view.commit || "HEAD" })
          : tr("工作区改动");
    this.eyebrow.textContent = isPr ? `${tr("代码评审")} · ${who}` : `${tr("代码评审")} · ${who}`;
    this.title.textContent = (isPr && view.prTitle) || tr("评审详情");
    const metaBits: string[] = [];
    if (isPr && view.prHead) metaBits.push(`${view.prHead} → ${view.prBase || "main"}`);
    else if (view.mode === "range" && view.base) metaBits.push(`${view.target || "HEAD"} → ${view.base}`);
    if (!(view.hasRun || running)) metaBits.push(this.input.modelName || tr("默认模型"));
    if (view.history > 1) metaBits.push(tr("第 {p1} 次评审", { p1: view.history }));
    this.meta.textContent = metaBits.join(" · ");

    // ---- 仪表
    const plan = view.plan;
    const files = view.progress?.totalFiles ?? view.meta?.files ?? view.runFiles.total;
    const reviewed = view.progress?.reviewedFiles ?? view.meta?.reviewed ?? view.runFiles.reviewed;
    const tokens = view.progress?.tokens ?? view.meta?.tokens ?? view.runFiles.tokens;
    const hasRun = view.hasRun || running;
    this.inst.hidden = !hasRun;

    this.bigFiles.textContent = reviewed ? num(reviewed) : files ? "0" : "—";
    this.subFiles.textContent = files ? tr("/ {p1} 个文件", { p1: num(files) }) : "";
    this.bigTokens.textContent = tokens ? num(tokens) : "—";
    this.subTokens.textContent = tokens ? tr("tokens") : "";
    this.bigTime.textContent = mmss(view.elapsedMs);

    const doneGroups = plan.filter((g) => g.state === "done");
    const active = plan.find((g) => g.state === "running");
    const failed = plan.find((g) => g.state === "failed");
    const groupIndex = active?.index ?? view.group?.index ?? doneGroups.length;

    this.meter.dataset.empty = files ? "0" : "1";
    this.meter.replaceChildren();
    if (plan.length) {
      for (const g of plan) {
        const seg = el("i", "");
        seg.dataset.state = g.state;
        this.meter.append(seg);
      }
    } else {
      const seg = el("i", "");
      seg.style.width = `${files ? Math.min(100, Math.round((reviewed / files) * 100)) : 0}%`;
      this.meter.append(seg);
    }

    if (running) {
      const started = view.timeline.find((l) => l.group === groupIndex)?.at;
      this.subFiles.textContent = active
        ? tr("第 {p1}/{p2} 组进行中 · {p3} 开始", {
            p1: active.index,
            p2: plan.length,
            p3: clock(started ?? 0) || "—",
          })
        : tr("第 {p1}/{p2} 组 · {p3} 个文件", { p1: groupIndex, p2: plan.length || view.group?.total || "?", p3: num(files) });
      this.subTime.textContent = this.estimateText(plan, view.elapsedMs);
      this.subTokens.textContent = this.input.modelName || tr("默认模型");
    } else if (view.phase === "failed" || view.phase === "stopped") {
      this.subFiles.textContent = files ? tr("/ {p1} 个文件", { p1: num(files) }) : "";
      const avg = view.elapsedMs && doneGroups.length ? view.elapsedMs / doneGroups.length : null;
      this.subTime.textContent = avg ? tr("平均 {p1} 一组", { p1: mmss(avg) }) : "";
      this.subTokens.textContent = this.input.modelName || tr("默认模型");
    } else if (view.meta) {
      this.subFiles.textContent = tr("{p1} 个文件", { p1: num(view.meta.files) });
      const avgN = plan.length || view.group?.total || 1;
      // 只有一组时「平均 09:14 一组」等于把用时再说一遍，不画
      const avg = avgN > 1 && view.meta.durationMs ? view.meta.durationMs / avgN : null;
      this.subTime.textContent = avg ? tr("平均 {p1} 一组", { p1: mmss(avg) }) : "";
      this.subTokens.textContent = this.input.modelName || tr("默认模型");
    }

    // ---- 正在读 / 收尾
    const findings = view.groups.flatMap((g) => g.findings);
    this.cur.dataset.phase = view.phase;
    if (running) {
      this.curLabel.textContent = tr("正在读");
      this.curText.textContent = view.progress?.currentFile || "…";
      this.curHint.textContent = active ? tr("{p1} 个文件", { p1: active.files }) : "";
      this.cur.querySelector(".rv-dot")?.classList.add("live");
    } else {
      this.cur.querySelector(".rv-dot")?.classList.remove("live");
      if (view.phase === "done") {
        this.curLabel.textContent = tr("完成");
        this.curText.textContent = tr("{p1} 个文件 · {p2} 组 · {p3} · {p4} tokens", {
          p1: num(view.meta?.files ?? files),
          p2: plan.length || view.group?.total || 0,
          p3: mmss(view.meta?.durationMs ?? view.elapsedMs),
          p4: num(view.meta?.tokens ?? tokens),
        });
        this.curHint.textContent = findings.length ? tr("{p1} 条意见", { p1: findings.length }) : "";
      } else if (view.phase === "failed" || view.phase === "stopped") {
        this.curLabel.textContent = phaseLabel(view.phase);
        // 错误正文在右栏顶上那张卡里，这里只给一行「停在哪」，不重复一长串
        this.curText.textContent =
          plan.length && (failed ?? doneGroups.length)
            ? tr("停在第 {p1} 组", { p1: (failed ?? doneGroups[doneGroups.length - 1])?.index ?? 1 })
            : view.error || tr("这次没评成");
        this.curHint.textContent = tr("{p1} 条意见", { p1: findings.length });
      } else {
        this.curLabel.textContent = phaseLabel(view.phase);
        this.curText.textContent = "";
        this.curHint.textContent = "";
      }
    }

    this.logCount.textContent = view.timeline.length ? tr("{p1} 行", { p1: view.timeline.length }) : "";
    this.renderLog(view);
    this.renderFindings(view);
    this.updateFoot(view);
  }

  /** 按已完成组的平均耗时估还要多久（一组都没有时不给假数）。 */
  private estimateText(plan: ReviewPanelInput["view"]["plan"], elapsed: number | null): string {
    const done = plan.filter((g) => g.state === "done" && g.startedAt && g.finishedAt);
    if (!done.length) return elapsed !== null ? tr("已跑 {p1}", { p1: mmss(elapsed) }) : "";
    const sum = done.reduce((n, g) => n + Math.max(0, Date.parse(g.finishedAt) - Date.parse(g.startedAt)), 0);
    const avg = sum / done.length;
    const left = plan.length - done.length - (plan.some((g) => g.state === "running") ? 1 : 0);
    if (left <= 0) return tr("已跑 {p1}", { p1: mmss(elapsed) });
    return tr("还要约 {p1}", { p1: mmss(avg * (left + 0.5)) });
  }

  // ------------------------------------------------------------------ 左栏
  private renderLog(view: ReviewPanelInput["view"]): void {
    const sig = [
      view.phase,
      view.running ? view.progress?.currentFile ?? "" : "",
      view.timeline.map((l) => `${l.at}:${l.text}`).join("|"),
      view.plan.map((g) => `${g.index}/${g.state}/${g.files}/${g.findings}`).join(","),
      [...this.openStages.entries()].map(([k, v]) => `${k}=${v}`).join(","),
    ].join("#");
    if (sig === this.logSig) return;
    this.logSig = sig;

    const groupsStarted = view.plan.some((g) => g.state !== "pending");
    const stages: { id: string; label: string; meta: string; state: string; lines: typeof view.timeline }[] = [];
    const prep = view.timeline.filter((l) => !l.group);
    if (view.plan.length) {
      stages.push({
        id: "prep",
        label: tr("准备"),
        meta: prep.length ? tr("{p1} 行", { p1: prep.length }) : "",
        state: "done",
        lines: prep,
      });
      for (const g of view.plan) {
        const lines = view.timeline.filter((l) => l.group === g.index);
        const meta =
          g.state === "done"
            ? tr("{p1} 文件 · {p2} 条 · {p3}", {
                p1: g.files,
                p2: g.findings,
                p3: clock(Date.parse(g.finishedAt)) || "",
              })
            : g.state === "running"
              ? tr("{p1} 文件 · 进行中", { p1: g.files })
              : g.state === "failed"
                ? tr("{p1} 文件 · 失败", { p1: g.files })
                : tr("{p1} 文件 · 待跑", { p1: g.files });
        stages.push({ id: `g${g.index}`, label: tr("第 {p1} 组", { p1: g.index }), meta, state: g.state, lines });
      }
    } else {
      stages.push({
        id: "all",
        label: tr("运行记录"),
        meta: view.timeline.length ? tr("{p1} 行", { p1: view.timeline.length }) : "",
        state: view.running ? "running" : "done",
        lines: view.timeline,
      });
    }

    const box = el("div", "rv-stages");
    for (const stage of stages) {
      const open =
        this.openStages.get(stage.id) ??
        (stage.state === "running"
          ? true
          : stage.id === "prep"
            ? !groupsStarted && view.timeline.length > 0
            : stage.state === "failed");
      const wrap = el("section", "rv-stg");
      wrap.dataset.state = stage.state;
      wrap.dataset.open = open ? "1" : "0";
      const head = el("button", "rv-stg-head") as HTMLButtonElement;
      head.type = "button";
      head.append(el("span", "rv-stg-ico", ""), el("span", "rv-stg-label", stage.label));
      head.append(el("span", "rv-stg-meta", stage.meta), el("span", "rv-chev"));
      head.onclick = () => {
        this.openStages.set(stage.id, !open);
        this.logSig = "";
        this.refresh();
      };
      wrap.append(head);
      if (open) {
        const lines = el("div", "rv-stg-body");
        for (const line of stage.lines) {
          const row = el("div", "rv-rl");
          row.append(el("span", "rv-rl-at", clock(line.at)), el("span", "rv-rl-tx", line.text));
          lines.append(row);
        }
        if (stage.state === "running") {
          const row = el("div", "rv-rl rv-rl-now");
          row.append(
            el("span", "rv-rl-at", ""),
            el("span", "rv-rl-tx", view.progress?.currentFile ? tr("正在读 {p1}", { p1: view.progress.currentFile }) : tr("等一下…")),
          );
          lines.append(row);
        }
        if (stage.id === "prep" && stage.state === "done" && !stage.lines.length) {
          lines.append(el("div", "rv-rl rv-rl-quiet", tr("没有记录")));
        }
        wrap.append(lines);
      }
      box.append(wrap);
    }
    this.logBody.replaceChildren(box);
  }

  // ------------------------------------------------------------------ 右栏
  private renderFindings(view: ReviewPanelInput["view"]): void {
    const all = view.groups.flatMap((g) => g.findings);
    const counts: Record<string, number> = { all: all.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of all) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    // 选中的那一档已经没有了（换了一次评审 / 被标记掉了）：回到「全部」，别留一屏空白。
    if (this.filter !== "all" && !counts[this.filter]) this.filter = "all";

    const shownGroups =
      this.filter === "all"
        ? view.groups
        : view.groups
            .map((g) => ({ ...g, findings: g.findings.filter((f) => f.severity === this.filter) }))
            .filter((g) => g.findings.length);

    const sig = [
      view.running,
      view.phase,
      view.error,
      this.filter,
      view.resolvedPaths.join(","),
      // 没评的原因也要算：条数不变、原因换了（另一批排除）同样得重画。
      view.skipped.map((s) => `${s.path}:${s.reason}`).join(","),
      view.empty,
      // 签名必须含正文/位置/代码：另一批评审结果里 key 重合的可能性不能赌，
      // 只要内容变了就重画，否则数量不变时会一直显示旧意见（等长改动也算变了，所以取哈希）。
      view.groups
        .map((g) =>
          `${g.path}@${g.findings
            .map(
              (f) =>
                `${f.key}:${f.mark}:${f.severity}:${f.state}:${f.startLine}:${hash(f.content)}:${hash(f.existingCode)}:${hash(f.suggestionCode)}`,
            )
            .join(",")}`,
        )
        .join("|"),
    ].join("#");
    const fresh = sig !== this.findSig;
    this.findSig = sig;

    this.findCount.textContent = all.length ? `${counts.all}` : "";
    this.findCount.dataset.live = view.running ? "1" : "0";
    if (view.running) this.findCount.title = tr("评审还在跑，意见会陆续出现。");
    this.renderFilters(counts, all.length);

    if (!fresh) return;

    // 重建前记下展开了哪几条、滚到哪了 —— 进度帧来的比人点得快，不记就会被清掉。
    const openKeys = new Set<string>();
    for (const row of this.findBody.querySelectorAll<HTMLElement>(".rv-finding.open")) {
      const key = row.dataset.key;
      if (key) openKeys.add(key);
    }
    const scroll = this.findBody.scrollTop;

    const box = el("div", "rv-find-list");
    if (view.error) box.append(el("div", "rv-error", view.error));
    if (this.filter !== "all" && !shownGroups.length && !view.running) {
      box.append(el("div", "rv-hint", tr("这一类暂时没有意见。")));
    } else {
      const shown = {
        ...view,
        empty: view.empty && this.filter === "all",
        groups: shownGroups,
      };
      box.append(renderFindings({ ...this.input, view: shown }));
    }
    if (view.running) {
      const g = view.group;
      const plan = view.plan.find((p) => p.state === "running");
      const pending = el("div", "rv-pending");
      pending.append(
        el("span", "rv-dot live"),
        el("span", "rv-pending-label", tr("第 {p1} 组正在读", { p1: plan?.index ?? g?.index ?? "?" })),
        el("span", "rv-pending-meta", plan ? tr("{p1} 个文件", { p1: plan.files }) : ""),
      );
      for (let i = 0; i < 2; i += 1) pending.append(el("div", "rv-skel"));
      box.append(pending);
    }
    this.findBody.replaceChildren(box);

    for (const key of openKeys) {
      const row = this.findBody.querySelector<HTMLElement>(`.rv-finding[data-key="${CSS.escape(key)}"]`);
      if (!row) continue;
      row.classList.add("open");
      const inner = row.querySelector<HTMLElement>(".rv-body");
      if (inner) inner.hidden = false;
    }
    this.findBody.scrollTop = scroll;
  }

  private renderFilters(counts: Record<string, number>, total: number): void {
    const sig = `${total}:${SEV_ORDER.map((s) => counts[s]).join("/")}:${this.filter}`;
    if (this.findFilters.dataset.sig === sig) return;
    this.findFilters.dataset.sig = sig;
    const make = (value: "all" | Severity, label: string, n: number) => {
      const b = el("button", "rv-filter") as HTMLButtonElement;
      b.type = "button";
      b.dataset.sev = value;
      b.setAttribute("aria-pressed", String(this.filter === value));
      b.append(el("span", "rv-filter-dot"), el("span", "", label), el("span", "rv-filter-n", String(n)));
      b.onclick = () => {
        this.filter = value;
        this.findSig = "";
        this.findFilters.dataset.sig = "";
        this.refresh();
      };
      return b;
    };
    const box = el("div", "rv-filters-in");
    box.append(make("all", tr("全部"), total));
    for (const sev of SEV_ORDER) {
      if (!counts[sev]) continue;
      box.append(make(sev, this.input.severityLabels[sev] ?? sev, counts[sev]));
    }
    this.findFilters.replaceChildren(box);
  }

  // ------------------------------------------------------------------ 底栏
  private updateFoot(view: ReviewPanelInput["view"]): void {
    const all = view.groups.flatMap((g) => g.findings);
    const accepted = all.filter((f) => f.mark === "accept").length;
    this.footStats.textContent = all.length
      ? tr("已接受 {p1} · 待处理 {p2}", { p1: accepted, p2: all.length - accepted })
      : "";

    // 缓存签名要含意见身份：只比严重度序列时，换了一批「同分布」的意见不会重建按钮，
    // 而 onclick 闭包捕获的是上一批数组 —— 点下去会把旧意见交给 agent。
    const sig = `${view.running}:${all.map((f) => `${f.key}/${f.severity}/${f.mark}`).join(",")}`;
    if (sig === this.bulkSig) return;
    this.bulkSig = sig;
    if (!all.length) {
      this.bulkBox.replaceChildren();
      return;
    }
    const make = (label: string, list: typeof all, cls: string) => {
      const b = el("button", `btn ghost rv-bulk-btn ${cls}`, `${label} · ${list.length}`) as HTMLButtonElement;
      b.type = "button";
      b.disabled = view.running;
      b.title = view.running ? tr("评审中：等跑完再交给 agent") : "";
      b.onclick = () => this.input.actions.onFixMany(list);
      return b;
    };
    const box = el("div", "rv-bulk-in");
    box.append(make(tr("全部交给 agent"), all, "all"));
    for (const sev of SEV_ORDER) {
      const list = all.filter((f) => f.severity === sev);
      if (!list.length) continue;
      box.append(make(this.input.severityLabels[sev] ?? sev, list, sev));
    }
    this.bulkBox.replaceChildren(box);
  }
}
