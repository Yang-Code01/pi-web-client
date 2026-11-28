/**
 * 「PR 信息」dialog（#651）：点面板里那行「已选 #N …」打开。
 *
 * 只回答「这个 PR 是什么」，不显示文件 diff：标题、描述、改动统计、文件清单、提交时间线。
 * 详细评审结果在「评审详情」那扇窗里，两者分工不同。
 */
import { createEl as el } from "./chat.ts";
import { fmtDate, fmtRelative, tr } from "./i18n/index.ts";
import { renderMarkdown } from "./md.ts";
import { markSurface, pushEscLayer, overlayHost } from "./modal.ts";

export interface PrFileInfo {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface PrCommitInfo {
  oid: string;
  headline: string;
  date: string;
  author: string;
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  files: PrFileInfo[];
  filesMore: number;
  commits: PrCommitInfo[];
  commitsMore: number;
}

export class PrSheet {
  private readonly back: HTMLElement;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private popEsc: (() => void) | null = null;
  private number = 0;
  private loading = false;
  private error = "";
  private info: PrInfo | null = null;
  onClose: (() => void) | null = null;

  constructor(number: number) {
    this.number = number;
    this.back = markSurface(el("div", "sheet-back center rv-back"), "window");
    const sheet = el("section", "st-console rv-sheet pr-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("PR 信息"));
    sheet.tabIndex = -1;
    this.head = el("header", "rv-sheet-head");
    this.body = el("div", "pr-sheet-body");
    sheet.append(this.head, this.body);
    this.back.append(sheet);
    this.paint();
  }

  /** 宿主默认交给 `overlayHost()`：控制台是量尺，1:1 挂 body（D450）；测试里仍可显式指定。 */
  mount(parent: HTMLElement = overlayHost(this.back)): void {
    parent.append(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
  }

  /** 桥把详情拿回来了（或报错）。 */
  set(number: number, info: PrInfo | null, error: string): void {
    if (number !== this.number) return;
    this.loading = false;
    this.info = info;
    this.error = error;
    this.paint();
  }

  setLoading(): void {
    this.loading = true;
    this.paint();
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  private paint(): void {
    const info = this.info;
    const headMain = el("div", "rv-sheet-headmain");
    const title = el("h2", "rv-sheet-title", info ? `#${info.number} ${info.title}` : tr("PR #{p1}", { p1: this.number }));
    headMain.append(title);
    if (info) {
      const chip = el("span", "rv-chip", info.state || "");
      chip.dataset.phase = info.state?.toUpperCase() === "OPEN" ? "done" : info.state?.toUpperCase() === "MERGED" ? "running" : "";
      headMain.append(chip);
      headMain.append(
        el(
          "div",
          "rv-sheet-meta",
          [
            `${info.headRefName} → ${info.baseRefName}`,
            info.author,
            fmtRelative(Date.parse(info.createdAt)),
            `${info.changedFiles} ${tr("个文件")}`,
            `+${info.additions} −${info.deletions}`,
            `${info.commits.length + info.commitsMore} ${tr("条提交")}`,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }
    const close = el("button", "btn ghost", tr("关闭")) as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => this.close();
    const headRight = el("div", "rv-sheet-headright");
    if (info?.url) {
      const open = el("a", "btn ghost", tr("在 GitHub 打开")) as HTMLAnchorElement;
      open.href = info.url;
      open.target = "_blank";
      open.rel = "noopener";
      headRight.append(open);
    }
    headRight.append(close);
    this.head.replaceChildren(headMain, headRight);

    if (this.loading && !info) {
      this.body.replaceChildren(el("div", "rv-hint", tr("正在读 PR 信息…")));
      return;
    }
    if (this.error && !info) {
      this.body.replaceChildren(el("div", "rv-error", this.error));
      return;
    }
    if (!info) {
      this.body.replaceChildren(el("div", "rv-hint", tr("没有这个 PR 的信息")));
      return;
    }

    const left = el("div", "rv-sheet-col pr-col");
    left.append(el("div", "rv-sheet-caption", tr("描述")));
    if (info.body.trim()) {
      // PR 描述就是 Markdown（标题、列表、```代码），按正文渲染比一坨纯文本好读得多。
      const body = el("div", "pr-body md-body");
      body.append(renderMarkdown(info.body));
      left.append(body);
    } else {
      left.append(el("div", "rv-hint", tr("这个 PR 没有写描述")));
    }

    const right = el("div", "rv-sheet-col pr-col");
    right.append(el("div", "rv-sheet-caption", tr("提交（{p1}）", { p1: info.commits.length + info.commitsMore })));
    const timeline = el("div", "pr-commits");
    for (const c of info.commits) {
      const row = el("div", "pr-commit");
      row.append(
        el("code", "pr-commit-oid", c.oid.slice(0, 7)),
        el("span", "pr-commit-head", c.headline),
        el("span", "pr-commit-meta", [c.author, c.date ? fmtDate(Date.parse(c.date)) : ""].filter(Boolean).join(" · ")),
      );
      timeline.append(row);
    }
    if (info.commitsMore) timeline.append(el("div", "rv-hint", tr("还有 {p1} 条没列出来", { p1: info.commitsMore })));
    right.append(timeline);
    right.append(el("div", "rv-sheet-caption", tr("改动文件（{p1}）", { p1: info.changedFiles })));
    const files = el("div", "pr-files");
    for (const f of info.files) {
      const row = el("div", "pr-file");
      row.append(
        el("code", "", f.path),
        el("span", "pr-file-stat", `+${f.additions} −${f.deletions}`),
      );
      files.append(row);
    }
    if (info.filesMore) files.append(el("div", "rv-hint", tr("还有 {p1} 个文件没列出来", { p1: info.filesMore })));
    right.append(files);

    this.body.replaceChildren(left, right);
  }
}
