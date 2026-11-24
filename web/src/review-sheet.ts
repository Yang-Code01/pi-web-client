/**
 * 「评审详情」dialog（#651）：跑着看时间线，跑完看结果。
 *
 * 右栏只有 300px，塞不下「时间线 + 每条意见的代码片段 + 没评的文件」；所以这一扇窗比面板宽，
 * 但内容与面板同源 —— `renderFindings()` / `renderTimeline()` 两边共用，不另画一套。
 */
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { markSurface, pushEscLayer } from "./modal.ts";
import { renderFindings, renderTimeline, type ReviewPanelInput, type Severity } from "./review.ts";

export class ReviewSheet {
  private readonly back: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private popEsc: (() => void) | null = null;
  private input: ReviewPanelInput;
  onClose: (() => void) | null = null;

  constructor(input: ReviewPanelInput) {
    this.input = input;
    this.back = markSurface(el("div", "sheet-back center rv-back"), "window");
    this.back.onclick = (ev) => {
      if (ev.target === this.back) this.close();
    };

    const sheet = el("section", "st-console rv-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("评审详情"));
    sheet.tabIndex = -1;

    const head = el("header", "rv-sheet-head");
    const headMain = el("div", "rv-sheet-headmain");
    this.title = el("h2", "rv-sheet-title", tr("评审详情"));
    this.status = el("span", "rv-chip", "");
    this.meta = el("div", "rv-sheet-meta", "");
    headMain.append(this.title, this.status, this.meta);
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    const headRight = el("div", "rv-sheet-headright");
    this.stopBtn = el("button", "btn ghost rv-stop-btn", tr("中断评审")) as HTMLButtonElement;
    this.stopBtn.type = "button";
    this.stopBtn.onclick = () => this.input.actions.onStop();
    headRight.append(this.stopBtn, close);
    head.append(headMain, headRight);

    this.left = el("div", "rv-sheet-col rv-sheet-left");
    this.right = el("div", "rv-sheet-col rv-sheet-right");
    const body = el("div", "rv-sheet-body");
    body.append(this.left, this.right);

    sheet.append(head, body);
    this.back.append(sheet);
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

  private refresh(): void {
    const { view } = this.input;
    const label =
      view.phase === "running"
        ? tr("评审中")
        : view.phase === "done"
          ? tr("完成")
          : view.phase === "failed"
            ? tr("失败")
            : view.phase === "stopped"
              ? tr("已停止")
              : view.phase === "stale"
                ? tr("已失效")
                : view.phase === "empty"
                  ? tr("还没跑过")
                  : "";
    this.status.textContent = label;
    this.status.dataset.phase = view.phase;
    // 跑着的时候顶栏给一颗「中断评审」：详情窗开着也不该逼人回去点面板。
    const stopBtn = this.stopBtn;
    stopBtn.hidden = !view.running;

    const who =
      view.mode === "pr"
        ? tr("PR #{p1}", { p1: view.pr || "?" })
        : view.mode === "range"
          ? tr("{p1} vs {p2}", { p1: view.target || "HEAD", p2: view.base })
          : view.mode === "commit"
            ? tr("提交 {p1}", { p1: view.commit || "HEAD" })
            : tr("工作区改动");
    const bits = [who, this.input.modelName || tr("默认模型")];
    if (view.meta) {
      bits.push(tr("{p1} 个文件", { p1: view.meta.files }));
      if (view.meta.skipped) bits.push(tr("{p1} 个没评", { p1: view.meta.skipped }));
      if (view.meta.tokens) bits.push(tr("{p1} tokens", { p1: view.meta.tokens }));
      if (view.meta.durationMs !== null) bits.push(tr("{p1} 秒", { p1: Math.round(view.meta.durationMs / 1000) }));
    } else if (view.progress) {
      bits.push(tr("{p1}/{p2} 个文件", { p1: view.progress.reviewedFiles, p2: view.progress.totalFiles }));
      if (view.progress.tokens) bits.push(tr("{p1} tokens", { p1: view.progress.tokens }));
    }
    if (view.group) bits.push(tr("第 {p1}/{p2} 组", { p1: view.group.index, p2: view.group.total }));
    this.meta.textContent = bits.join(" · ");

    this.left.replaceChildren(el("div", "rv-sheet-caption", tr("进度")), renderTimeline(view, 0));
    const right: HTMLElement[] = [el("div", "rv-sheet-caption", tr("结果"))];
    if (view.running) right.push(el("div", "rv-hint", tr("评审还在跑，意见会陆续出现。")));
    if (view.error) right.push(el("div", "rv-error", view.error));
    const bulk = this.bulkRow();
    if (bulk) right.push(bulk);
    right.push(renderFindings(this.input));
    this.right.replaceChildren(...right);
  }

  /** 一条条交太慢：上面一颗「全部」，再按严重度各一颗（只列真有的档位）。 */
  private bulkRow(): HTMLElement | null {
    const all = this.input.view.groups.flatMap((g) => g.findings);
    if (!all.length) return null;
    const box = el("div", "rv-bulk");
    const make = (label: string, list: typeof all, cls: string) => {
      const b = el("button", `btn ghost rv-bulk-btn ${cls}`, `${label} · ${list.length}`) as HTMLButtonElement;
      b.type = "button";
      b.disabled = this.input.view.running;
      b.title = this.input.view.running ? tr("评审中：等跑完再交给 agent") : "";
      b.onclick = () => this.input.actions.onFixMany(list);
      return b;
    };
    box.append(make(tr("全部交给 agent"), all, "all"));
    const order: Severity[] = ["critical", "high", "medium", "low"];
    for (const sev of order) {
      const list = all.filter((f) => f.severity === sev);
      if (!list.length) continue;
      box.append(make(this.input.severityLabels[sev] ?? sev, list, sev));
    }
    return box;
  }
}
