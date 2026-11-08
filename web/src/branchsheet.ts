/**
 * D193: 分支 chip 的弹窗 —— 左边当前分支的线性历史，右边一条对照分支的历史，顶上一条
 * 「领先 / 落后 / 从哪儿分叉」。只读：不 checkout、不 merge、不 pull。
 *
 * 三个决定都写在这里，改之前先读：
 * - **不自动 fetch**：打开只用本地 remote-tracking ref（秒开、不摸网络），要新数据点底部的
 *   `⟳ 拉取最新`。fetch 是唯一会出网的 git 调用，桥端还额外拒绝隧道访问。
 * - **集合由桥算**：每行是 `left` / `right` / `common` 三类之一，页面只负责淡显和描边 —
 *   两边各算一套迟早会漂（"你独有"的行在另一列却也算独有）。
 * - **弹窗是快照**：标题里带仓库路径、底部带数据时间；期间切分支不会被推着刷新，重开一次就是新的。
 */
import { createEl as el } from "./chat.ts";
import { api } from "./api.ts";
import { errText, fmtRelative, tr } from "./i18n/index.ts";
import type { GitCommit, GitHistory } from "./types.ts";

/** 左列标签：当前 HEAD 还是游离 HEAD —— 顶部和列头共用一份，别各算一遍。 */
function headTag(data: GitHistory): string {
  return data.detached ? tr("游离 HEAD") : "HEAD";
}

/** 右列标签：远程 ref 还是本地分支（没配远程时才会落到本地）。 */
function baseTag(data: GitHistory): string {
  return data.base.startsWith("origin/") || data.branches.length ? tr("远程") : tr("本地");
}

/** 一次取多少条；「再加载」按同样大小往后翻。 */
const PAGE = 80;
/** 和桥端 `gitHistory` 的 300 封顶对齐：到了就别再给按钮，按钮点了也不会长。 */
const LIMIT_MAX = 300;

export interface BranchSheetOptions {
  /** 会话的 cwd；桥端会自己找仓库根。 */
  dir: string;
  /** 打开那一刻的分支名，数据回来之前先显示它。 */
  branch: string;
}

export class BranchSheet {
  private readonly dir: string;
  private readonly fallback: string;
  private readonly root: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly repoEl: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly cmpEl: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly colsEl: HTMLElement;
  private readonly stampEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly fetchBtn: HTMLButtonElement;
  private readonly fetchLabel: HTMLSpanElement;

  private data: GitHistory | null = null;
  private base = "";
  private limit = PAGE;
  private tab: "left" | "right" = "left";
  /** 只要最新那次请求的答案：拉 base 下拉拉得快时，先发的旧答案不许盖新的。 */
  private ticket = 0;
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: BranchSheetOptions) {
    this.dir = opts.dir;
    this.fallback = opts.branch;

    this.root = el("div", "sheet-back center branch-back");
    this.root.onclick = (ev) => {
      if (ev.target === this.root) this.close();
    };
    this.sheet = el("div", "branch-sheet");
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("分支历史"));
    this.sheet.tabIndex = -1;

    const head = el("div", "branch-head");
    const title = el("div", "branch-title");
    title.append(el("span", "branch-glyph", "⎇"), el("span", "", tr("分支历史")), (this.repoEl = el("span", "branch-repo", opts.dir)));
    this.copyBtn = el("button", "btn ghost", tr("复制分支名")) as HTMLButtonElement;
    this.copyBtn.type = "button";
    this.copyBtn.onclick = () => void this.copy();
    const close = el("button", "branch-x", "✕") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", tr("关闭"));
    close.title = tr("Esc 关闭");
    close.onclick = () => this.close();
    const tools = el("div", "branch-tools");
    tools.append(this.copyBtn, close);
    head.append(title, tools);

    this.cmpEl = el("div", "branch-cmp");
    this.tabsEl = el("div", "branch-tabs");
    this.colsEl = el("div", "branch-cols");
    const foot = el("div", "branch-foot");
    this.stampEl = el("span", "branch-stamp", tr("正在读 git…"));
    this.hintEl = el("span", "branch-hint");
    this.fetchBtn = el("button", "btn ghost branch-fetch") as HTMLButtonElement;
    this.fetchBtn.type = "button";
    this.fetchLabel = el("span", "", tr("拉取最新"));
    this.fetchBtn.append(el("span", "branch-fetch-glyph", "⟳"), this.fetchLabel);
    this.fetchBtn.title = tr("从远程拉一次（只更新 remote-tracking ref）");
    this.fetchBtn.onclick = () => void this.doFetch();
    const esc = el("span", "branch-esc", tr("Esc 关闭"));
    const footRight = el("div", "branch-foot-right");
    footRight.append(this.hintEl, this.fetchBtn, esc);
    foot.append(this.stampEl, footRight);

    this.sheet.append(head, this.cmpEl, this.tabsEl, this.colsEl, foot);
    this.root.append(this.sheet);
    this.paintLoading();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
    this.esc = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    this.sheet.focus();
    void this.load(false);
  }

  close(): void {
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    this.root.remove();
    this.onClose?.();
  }

  // ---------------------------------------------------------------- data

  private async load(fresh: boolean): Promise<void> {
    const ticket = ++this.ticket;
    try {
      const data = await api.gitHistory(this.dir, this.base, this.limit, fresh);
      if (ticket !== this.ticket) return;
      this.data = data;
      // baseAuto 时保持空串：下拉里那项是「自动」，选回它才能真的回到跟随 origin/HEAD。
      this.base = data.baseAuto ? "" : data.base;
      this.repoEl.textContent = data.repo;
      this.repoEl.title = data.repo;
      this.paint();
    } catch (err) {
      if (ticket !== this.ticket) return;
      // 换对照分支失败时留着上一份数据：顶部那条和下拉还在，才能直接挑另一个分支。
      this.paintError(err, this.data);
    }
  }

  private async copy(): Promise<void> {
    const text = this.data?.head || this.fallback;
    const copy = navigator.clipboard?.writeText(text);
    if (!copy) return;
    const back = tr("复制分支名");
    void copy
      .then(() => {
        this.copyBtn.textContent = tr("已复制");
        setTimeout(() => {
          if (this.copyBtn.isConnected && this.copyBtn.textContent === tr("已复制")) this.copyBtn.textContent = back;
        }, 900);
      })
      .catch(() => {});
  }

  private async doFetch(): Promise<void> {
    if (this.fetchBtn.disabled) return;
    this.fetchBtn.disabled = true;
    this.fetchLabel.textContent = tr("正在 fetch…");
    this.say("");
    try {
      const out = await api.gitFetch(this.dir);
      this.limit = PAGE;
      await this.load(true);
      this.say(tr("已从 {p1} 拉了最新", { p1: out.remote }));
    } catch (err) {
      this.say(errText(err), true);
    } finally {
      this.fetchBtn.disabled = false;
      this.fetchLabel.textContent = tr("拉取最新");
    }
  }

  private say(text: string, bad = false): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle("bad", bad);
  }

  // ---------------------------------------------------------------- paint

  private paintLoading(): void {
    this.cmpEl.replaceChildren(el("div", "branch-skeleton", tr("正在读 git…")));
    this.colsEl.replaceChildren();
    this.tabsEl.replaceChildren();
    this.stampEl.textContent = tr("正在读 git…");
  }

  private paintError(err: unknown, keep: GitHistory | null = null): void {
    const code = (err as { code?: string } | null)?.code;
    // 有上一份数据就别拆顶部：下拉是唯一能换条分支再试的入口。
    if (!keep) {
      this.cmpEl.replaceChildren();
      this.tabsEl.replaceChildren();
    }
    const box = el("div", "branch-note");
    if (code === "empty") {
      box.append(el("div", "branch-note-title", tr("这个仓库还没有提交")), el("div", "branch-note-sub", tr("有一次提交之后这里就有历史了")));
    } else {
      box.append(el("div", "branch-note-title", errText(err)));
      const retry = el("button", "btn ghost", tr("重试"));
      retry.onclick = () => {
        this.paintLoading();
        void this.load(true);
      };
      box.append(retry);
    }
    this.colsEl.replaceChildren(box);
    this.stampEl.textContent = tr("只读");
    this.fetchBtn.hidden = keep ? keep.branches.length === 0 : true;
  }

  private paint(): void {
    const data = this.data;
    if (!data) return;
    this.fetchBtn.hidden = data.branches.length === 0;
    this.paintCmp(data);
    this.paintTabs(data);
    this.paintCols(data);
    this.paintFoot(data);
  }

  private paintCmp(data: GitHistory): void {
    const left = el("div", "bc-end left");
    left.append(el("span", "branch-glyph", "⎇"), el("span", "bc-name", data.head || tr("(未知)")));
    left.append(el("span", "bc-tag", headTag(data)));

    const mid = el("div", "bc-mid");
    const pills = el("div", "bc-pills");
    const ahead = el("span", "bc-pill ahead", tr("↑ 领先 {p1}", { p1: data.ahead }));
    const behind = el("span", "bc-pill behind", tr("↓ 落后 {p1}", { p1: data.behind }));
    if (!data.ahead) ahead.classList.add("zero");
    if (!data.behind) behind.classList.add("zero");
    pills.append(ahead, behind);
    mid.append(pills);
    if (data.mergeBase) {
      mid.append(el("span", "bc-fork", tr("分叉于 {p1} · {p2}", { p1: data.mergeBase.h, p2: fmtRelative(data.mergeBase.at) })));
    }

    const right = el("div", "bc-end right");
    if (data.branches.length) {
      const select = el("select", "bc-base") as HTMLSelectElement;
      select.setAttribute("aria-label", tr("对照分支"));
      const auto = el("option") as HTMLOptionElement;
      auto.value = "";
      auto.textContent = tr("自动 · 跟随 origin/HEAD");
      auto.selected = data.baseAuto;
      select.append(auto);
      for (const branch of data.branches) {
        const option = el("option") as HTMLOptionElement;
        option.value = branch.name;
        option.textContent = branch.name;
        if (branch.name === data.base) option.selected = true;
        select.append(option);
      }
      if (!data.branches.some((b) => b.name === data.base)) {
        const option = el("option") as HTMLOptionElement;
        option.value = data.base;
        option.textContent = data.base;
        option.selected = true;
        select.prepend(option);
      }
      select.onchange = () => {
        this.base = select.value;
        this.limit = PAGE;
        this.say("");
        void this.load(false);
      };
      right.append(select);
    } else {
      right.append(el("span", "bc-name", data.base));
    }
    right.append(el("span", "bc-tag", baseTag(data)));

    const bar = el("div", "bc-bar");
    const total = data.ahead + data.behind;
    const a = el("i", "a");
    const b = el("i", "b");
    // 比例条只是读数：两边都为 0 时收成一条安静的底色线，不假装「刚好对半」。
    if (total > 0) {
      a.style.flex = String(data.ahead);
      b.style.flex = String(data.behind);
    } else {
      a.style.flex = "0";
      b.style.flex = "0";
      bar.classList.add("even");
    }
    bar.append(a, b);

    const counts = el("div", "bc-counts");
    counts.append(el("span", "", tr("{p1} 条你独有", { p1: data.ahead })), el("span", "", tr("{p1} 条你没有", { p1: data.behind })));

    this.cmpEl.replaceChildren(left, mid, right, bar, counts);
  }

  private paintTabs(data: GitHistory): void {
    const make = (side: "left" | "right", text: string): HTMLButtonElement => {
      const btn = el("button", this.tab === side ? "on" : "", text) as HTMLButtonElement;
      btn.type = "button";
      btn.onclick = () => {
        this.tab = side;
        this.colsEl.dataset.show = side;
        this.tabsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
      };
      return btn;
    };
    this.tabsEl.replaceChildren(
      make("left", tr("当前 · {p1}", { p1: data.head })),
      make("right", tr("对照 · {p1}", { p1: data.base })),
    );
    this.colsEl.dataset.show = this.tab;
  }

  private paintCols(data: GitHistory): void {
    const left = this.column("left", data.head, headTag(data), tr("{p1} 条你独有", { p1: data.ahead }), data.left, data.more.left);
    const right = this.column("right", data.base, baseTag(data), tr("{p1} 条你没有", { p1: data.behind }), data.right, data.more.right);
    this.colsEl.replaceChildren(left, right);
  }

  private column(side: "left" | "right", name: string, tag: string, count: string, rows: GitCommit[], more: boolean): HTMLElement {
    const col = el("section", "bc-col");
    col.dataset.side = side;
    const head = el("div", "bc-col-head");
    if (side === "left") head.append(el("span", "branch-glyph", "⎇"));
    head.append(el("span", "bc-name", name), el("span", "bc-tag", tag), el("span", "grow"), el("span", "bc-count", count));
    const body = el("div", "bc-rows");
    body.append(...rows.map((row) => this.row(row, side)));
    if (!rows.length) body.append(el("div", "bc-empty", tr("没有提交")));
    if (more && this.limit < LIMIT_MAX) {
      const moreBtn = el("button", "bc-more", tr("再加载 {p1} 条", { p1: PAGE })) as HTMLButtonElement;
      moreBtn.type = "button";
      moreBtn.onclick = () => {
        moreBtn.disabled = true;
        moreBtn.textContent = tr("正在读 git…");
        this.limit = Math.min(LIMIT_MAX, this.limit + PAGE);
        void this.load(false);
      };
      body.append(moreBtn);
    } else if (more) {
      body.append(el("div", "bc-empty", tr("只显示最近 {p1} 条", { p1: LIMIT_MAX })));
    }
    col.append(head, body);
    return col;
  }

  private row(commit: GitCommit, side: "left" | "right"): HTMLElement {
    const row = el("div", `bc-row ${commit.set === "common" ? "common" : commit.set === "left" ? "only" : "onlyR"}`);
    row.dataset.h = commit.h;
    row.title = `${commit.h} · ${commit.an} · ${fmtRelative(commit.at)}\n${commit.s}`;
    const subject = el("span", "bc-s");
    if (commit.merge) subject.append(el("span", "bc-badge", "merge"));
    subject.append(document.createTextNode(commit.s));
    // 右列的「你有我无」是黄边，左列是绿边：颜色跟着「哪边多了东西」走，不跟列走。
    row.append(el("span", "bc-h", commit.h), subject, el("span", "bc-meta", `${commit.an} · ${fmtRelative(commit.at)}`));
    row.classList.toggle("right", side === "right");
    return row;
  }

  private paintFoot(data: GitHistory): void {
    const when = data.fetchedAt ? fmtRelative(data.fetchedAt) : tr("不知道（还没 fetch 过）");
    this.stampEl.textContent = tr("数据来自 {p1} · 只读", { p1: when });
  }
}
