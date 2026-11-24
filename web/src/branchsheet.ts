/**
 * D235: 聊天状态行分支 chip 打开的「分支操作工作台」。
 *
 * 取代 D193 的三条旧约定（当年那个只读的分支历史弹窗）：不再只读、不再是快照、对照分支不再只有纯下拉。
 * - 三 tab：历史 / 差异 / 图解手册；写操作一律走 **居中操作卡**（样张 D，用户 m00390 选定）。
 * - 动作从 web/src/git-ops.ts 的单一注册表来；界面只发 id + 结构化 params，桥端白名单拼 argv。
 * - 成功后 fresh 重拉 history / 仓库信息 / state / refs；失败给退出码、原始 stderr、argv 与交给 agent。
 * - 图解、红色确认卡、脏区三选一、冲突逐文件标记、交给 agent 两个出口，都在这一张卡里收口。
 */
import { createEl as el } from "./chat.ts";
import { icon, face, type IconName } from "./icons.ts";
import { api } from "./api.ts";
import { errText, fmtRelative, tr } from "./i18n/index.ts";
import type { GitCommit, GitCommitDetail, GitDiff, GitDiffFile, GitExecResult, GitHistory, GitOpParams, GitRefs, GitWorktreeState } from "./types.ts";
import { markSurface, retireOverlay } from "./modal.ts";
import { GIT_OPS, MANUAL_FILTERS, OPS_BY_ID, OP_GROUPS, opFrames, buildHandoffPrompt, type GitOpDef } from "./git-ops.ts";
import { sessionNameFromBranchRef } from "./session-name.ts";

/** 一次取多少条；「再加载」按同样大小往后翻。 */
const PAGE = 80;
/** 和桥端 `gitHistory` 的 300 封顶对齐：到了就别再给按钮。 */
const LIMIT_MAX = 300;
/** 常驻在标题栏的动词，其余都从「全部动词」里进。 */
const QUICK_IDS = ["commit", "switch", "merge", "cherry_pick", "revert", "fetch", "tag"];

/** 左列标签：当前 HEAD 还是游离 HEAD —— 顶部和列头共用一份。 */
function headTag(data: GitHistory): string {
  return data.detached ? tr("游离 HEAD") : "HEAD";
}
/** 右列标签：只有当对照 ref 真的在 remote-tracking 列表里才标「远程」。 */
function baseTag(data: GitHistory): string {
  return data.branches.some((b) => b.name === data.base) ? tr("远程") : tr("本地");
}
function btn(label: IconName | string, cls = "btn ghost"): HTMLButtonElement {
  const b = el("button", cls) as HTMLButtonElement;
  b.append(face(label, 14));
  b.type = "button";
  return b;
}
function pre(text: string): HTMLElement {
  return el("pre", "go-pre", text);
}
function shortDir(dir: string): string {
  return dir.length > 52 ? `…${dir.slice(-49)}` : dir;
}
/**
 * opFrames() 是纯常量 SVG；用 DOMParser 转成节点再挂，避开 innerHTML。
 * 字符串里的 `<svg>` **必须带 xmlns**：XML 解析不会补默认命名空间，少了它整棵树落在
 * 无命名空间里，`<style>` 的文字就按正文画出来、圆和线也不渲染（app.ts 的 iconNodes()
 * 也是同一个坑的另一半，那里靠 HTML 片段解析器补命名空间）。
 */
function svgNode(svg: string): Node {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.documentElement.nodeName === "parsererror") return document.createTextNode("");
  return document.importNode(doc.documentElement, true);
}

export interface BranchSheetOptions {
  /** 会话的 cwd；桥端会自己找仓库根。 */
  dir: string;
  /** 打开那一刻的分支名，数据回来之前先显示它。 */
  branch: string;
  /** 成功后让 app.ts 的状态行 chip 跟着变（fresh）。 */
  refreshChip?: () => void;
  /** 复用了 JiraPanel / FailPanel 的两个出口：只填不发，不自动发送。#487：`name` 预填进新会话的名字框。 */
  handoff?: { prefill: (text: string, name?: string) => void; newSessionWith: (text: string, name?: string) => void };
  /**
   * #392：嵌进「目录与仓库」右栏，而不是自己开一扇全屏窗。
   * 不建背景遮罩、不绑 document 的 Esc、不显示标题与 ✕；分支侧栏收进头部下拉。
   */
  embedded?: boolean;
}

export class BranchSheet {
  private dir: string;
  private fallback: string;
  private readonly embedded: boolean;
  private readonly refreshChip: (() => void) | null;
  private readonly handoff: { prefill: (text: string, name?: string) => void; newSessionWith: (text: string, name?: string) => void } | null;
  private readonly root: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly repoEl: HTMLElement;
  private readonly cmpEl: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly colsEl: HTMLElement;
  private readonly stampEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly fetchBtn: HTMLButtonElement;
  private readonly opLayer: HTMLElement;
  /** embedded 时「分支 · 本地 + 远程」的浮层（老工作台里仍是常驻 aside）。 */
  private readonly sidePop: HTMLElement;
  private readonly sideToggle: HTMLButtonElement;
  private sideOpen = false;

  private data: GitHistory | null = null;
  private state: GitWorktreeState | null = null;
  private refs: GitRefs | null = null;
  private diff: GitDiff | null = null;
  private diffFile = -1;
  private base = "";
  /** #651：从「单条提交」那次评审跳过来时，差异看的是这一条提交 vs 父提交。 */
  private diffCommit = "";
  /** #651：从「工作区改动」那次评审跳过来时，差异看的是工作区 vs HEAD。 */
  private diffWorktree = false;
  private limit = PAGE;
  private tab: "history" | "diff" | "manual" = "history";
  private side: "left" | "right" = "left";
  private manualFilter = MANUAL_FILTERS[0];
  private selectedBranch = "";
  private busy = false;
  /** 右栏「本地 / 远程」两组的折叠状态，key 是桥端给的组名；没记过的一律折叠。 */
  private foldedGroups: Record<string, boolean> = (() => {
    try { return (JSON.parse(localStorage.getItem("pi.goGroupsFolded") ?? "null") as Record<string, boolean> | null) ?? {}; } catch { return {}; }
  })();
  /** 只要最新那次请求的答案：换对照分支拉得快时，旧答案不许盖新的。 */
  private ticket = 0;
  /** #651：正在跑的那次 `load()`。从评审跳过来时要等它，否则 loadDiff 会被它的 ticket 丢掉。 */
  private loading: Promise<void> | null = null;
  /** D289: 提交详情按 `repo|sha` 缓存在会话里；写操作成功或换目录时整块丢掉。 */
  private commitCache = new Map<string, GitCommitDetail>();
  /** 详情卡是从哪一行打开的：关掉它把焦点还回去。 */
  private commitRow: HTMLElement | null = null;
  /** 后回来的详情不许盖掉新打开的那张卡。 */
  private commitTicket = 0;
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: BranchSheetOptions) {
    this.dir = opts.dir;
    this.fallback = opts.branch;
    this.selectedBranch = opts.branch;
    this.refreshChip = opts.refreshChip ?? null;
    this.handoff = opts.handoff ?? null;
    this.embedded = opts.embedded === true;

    this.root = markSurface(el("div", "sheet-back center branch-back"), "window");
    this.root.onclick = (ev) => { if (ev.target === this.root) this.close(); };
    this.sheet = el("div", "branch-sheet go-sheet");
    this.sheet.classList.toggle("go-embedded", this.embedded);
    this.sheet.setAttribute("role", this.embedded ? "region" : "dialog");
    if (this.embedded) this.sheet.setAttribute("aria-label", tr("分支操作工作台"));
    else this.sheet.setAttribute("aria-modal", "true");
    this.sheet.tabIndex = -1;

    const head = el("div", "branch-head");
    const title = el("div", "branch-title");
    const repo = el("span", "branch-repo", shortDir(opts.dir));
    this.repoEl = repo;
    title.append(el("span", "branch-glyph", "⎇"), el("span", "", tr("分支操作工作台")), repo);
    this.repoEl.title = opts.dir;
    const tools = el("div", "branch-tools");
    const row = el("span", "go-tool-row");
    for (const id of QUICK_IDS) {
      const op = OPS_BY_ID[id];
      const b = btn(`${op.glyph} ${op.title}`, op.red ? "btn ghost go-danger" : "btn ghost");
      b.title = op.sub;
      b.dataset.op = id;
      b.onclick = () => this.openOp(id);
      row.append(b);
    }
    const all = btn(tr("全部动词 · {p1}", { p1: GIT_OPS.length }), "btn ghost go-all");
    all.dataset.verbs = "1";
    all.onclick = () => this.openVerbs();
    const ai = btn(tr("交给 AI 操作…"), "btn ghost go-ai");
    ai.dataset.ai = "1";
    ai.onclick = () => this.openAi();
    row.append(all, ai);
    const copy = btn(tr("复制分支名"));
    copy.onclick = () => void this.copy(copy);
    // 复制路径也收进标题栏：路径 chip 单击恒为开窗，不再兼复制。
    const copyPath = btn(tr("复制路径"));
    copyPath.dataset.copyPath = "1";
    copyPath.onclick = () => void this.copyText(this.data?.repo || this.dir, copyPath, tr("复制路径"));
    const close = el("button", "branch-x") as HTMLButtonElement;
    close.append(icon("close", { size: 14 }));
    close.type = "button";
    close.setAttribute("aria-label", tr("关闭"));
    close.title = tr("Esc 关闭");
    close.onclick = () => this.close();
    // embedded：外窗已有标题与 ✕，这里只留工具行；分支侧栏改成一个下拉。
    this.sideToggle = btn(tr("分支 · 本地 + 远程"), "btn ghost go-side-toggle");
    this.sideToggle.dataset.sideToggle = "1";
    this.sideToggle.onclick = () => { this.sideOpen = !this.sideOpen; this.paintSideVisibility(); };
    if (this.embedded) {
      title.hidden = true;
      close.hidden = true;
      row.append(this.sideToggle);
    }
    tools.append(row, copy);
    // embedded 时外窗（目录与仓库）已有复制路径，别重复一颗。
    if (!this.embedded) tools.append(copyPath);
    tools.append(close);
    head.append(title, tools);

    this.cmpEl = el("div", "branch-cmp");
    this.tabsEl = el("div", "go-tabs");
    this.colsEl = el("div", "go-body");
    const foot = el("div", "branch-foot");
    this.stampEl = el("span", "branch-stamp", tr("正在读 git…"));
    this.hintEl = el("span", "branch-hint");
    this.fetchBtn = el("button", "btn ghost branch-fetch") as HTMLButtonElement;
    this.fetchBtn.type = "button";
    this.fetchBtn.append(el("span", "branch-fetch-glyph", "⟳"), el("span", "", tr("拉取最新")));
    this.fetchBtn.title = tr("从远程拉一次（只更新 remote-tracking ref）");
    this.fetchBtn.onclick = () => void this.doFetch();
    const footRight = el("div", "branch-foot-right");
    footRight.append(this.hintEl, this.fetchBtn, el("span", "branch-esc", tr("Esc 关闭")));
    foot.append(this.stampEl, footRight);

    this.opLayer = el("div", "go-op-layer");
    this.opLayer.hidden = true;
    this.opLayer.onclick = (ev) => { if (ev.target === this.opLayer) this.closeOp(); };
    this.sidePop = el("div", "go-side-pop");
    this.sidePop.hidden = true;
    this.sheet.append(head, this.cmpEl, this.tabsEl, this.colsEl, foot, this.sidePop, this.opLayer);
    this.root.append(this.sheet);
    this.paintLoading();
  }

  mount(parent: HTMLElement): void {
    if (this.embedded) {
      // 外窗负责 Esc 链与焦点：这里只把自己挂进右栏，不注册 document 监听。
      parent.append(this.sheet);
      void this.load(false);
      return;
    }
    parent.append(this.root);
    this.esc = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (this.opLayer.hidden) this.close();
      else this.closeOp();
    };
    document.addEventListener("keydown", this.esc, true);
    this.sheet.focus();
    void this.load(false);
  }

  close(): void {
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    // embedded 时 `sheet` 是别的面板里的一块子区域，退场会把整张父面板一起拖下水，只能直接拆。
    if (this.embedded) this.sheet.remove();
    else retireOverlay(this.root);
    this.onClose?.();
  }

  /** #392：换仓库。在途请求靠 ticket 丢弃，旧 diff / 分支 / 侧栏一律不沿用。 */
  setDir(dir: string, branch = ""): void {
    this.dir = dir;
    this.fallback = branch;
    this.selectedBranch = branch;
    this.base = "";
    this.limit = PAGE;
    this.diff = null;
    this.diffFile = -1;
    this.data = null;
    this.state = null;
    this.refs = null;
    this.commitCache.clear();
    this.commitRow = null;
    this.ticket += 1;
    this.sideOpen = false;
    this.paintSideVisibility();
    this.repoEl.textContent = shortDir(dir);
    this.repoEl.title = dir;
    this.paintLoading();
    void this.load(false);
  }

  /** #392：外窗的 Esc 链先用这一层（操作卡 → 分支浮层），返回 true 表示它收掉了。 */
  closeLayer(): boolean {
    if (!this.opLayer.hidden) {
      this.closeOp();
      return true;
    }
    if (this.embedded && this.sideOpen) {
      this.sideOpen = false;
      this.paintSideVisibility();
      return true;
    }
    return false;
  }

  private paintSideVisibility(): void {
    this.sidePop.hidden = !(this.embedded && this.sideOpen);
    this.sideToggle.classList.toggle("on", this.embedded && this.sideOpen);
    this.sideToggle.setAttribute("aria-expanded", String(this.embedded && this.sideOpen));
  }

  // ---------------------------------------------------------------- data

  /** 一次把历史、仓库状态、分支表都拉齐；写成功后 fresh=true 让 chip 与 5s 缓存一起更新。 */
  private async load(fresh: boolean): Promise<void> {
    this.loading = this.loadInner(fresh);
    return this.loading;
  }

  private async loadInner(fresh: boolean): Promise<void> {
    const ticket = ++this.ticket;
    // D289: 拉取 / 写操作之后提交详情可能已经变了（新提交、改写、推送），缓存整块丢掉。
    if (fresh) this.commitCache.clear();
    this.setBusy(true);
    this.paintBusy();
    try {
      const [data, state, refs] = await Promise.all([
        api.gitHistory(this.dir, this.base, this.limit, fresh),
        api.gitState(this.dir),
        api.gitRefs(this.dir),
      ]);
      if (ticket !== this.ticket) return;
      this.data = data;
      this.state = state;
      this.refs = refs;
      this.base = data.baseAuto ? "" : data.base;
      this.repoEl.textContent = data.repo;
      this.repoEl.title = data.repo;
      if (state.branch) this.selectedBranch = state.branch;
      this.paint();
      if (this.tab === "diff") void this.loadDiff();
    } catch (err) {
      if (ticket !== this.ticket) return;
      this.paintError(err, this.data);
    } finally {
      if (ticket === this.ticket) this.setBusy(false);
    }
  }

  private async loadDiff(): Promise<void> {
    const ticket = this.ticket;
    try {
      const diff = await api.gitDiff(this.dir, this.base, "HEAD", this.diffCommit, this.diffWorktree);
      if (ticket !== this.ticket || this.tab !== "diff") return;
      this.diff = diff;
      if (this.diffFile >= diff.files.length) this.diffFile = -1;
      this.paintTabBody();
    } catch (err) {
      if (ticket !== this.ticket) return;
      this.diff = null;
      this.colsEl.replaceChildren(el("div", "branch-note", errText(err)));
    }
  }

  /**
   * #651：从「代码评审」的一条意见跳过来 —— 切到「差异」、选中那个文件、把命中的那段代码标出来。
   *
   * 差异数据里没有行号（`lines` 只有左右两格文字），所以定位靠**那段代码**而不是行号：
   * 先比改动侧、再比对照侧，都找不到就只切到那个文件。行号只进 tooltip。
   */
  async openDiffAt(o: { base?: string; commit?: string; worktree?: boolean; path: string; line?: number; code?: string }): Promise<void> {
    const commit = o.commit ?? "";
    const worktree = o.worktree === true;
    if ((o.base !== undefined && o.base !== this.base) || commit !== this.diffCommit || worktree !== this.diffWorktree) {
      if (o.base !== undefined) this.base = o.base;
      this.diffCommit = commit;
      this.diffWorktree = worktree;
      this.diff = null;
    }
    this.tab = "diff";
    this.paintTabs();
    // 刚打开时那一次 `load()` 还在飞（它会把 ticket 加一，让这里发出的 loadDiff 作废）：先等它。
    if (this.loading) await this.loading.catch(() => {});
    if (!this.diff) await this.loadDiff();
    const files = this.diff?.files ?? [];
    const idx = files.findIndex((f) => f.path === o.path || f.old === o.path);
    if (idx >= 0) this.diffFile = idx;
    this.paintTabBody();
    const needle = (o.code ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    if (!needle) return;
    const rows = [...this.colsEl.querySelectorAll<HTMLElement>(".go-code")];
    const row = rows.find((r) => r.textContent?.trim() === needle);
    if (!row) return;
    row.classList.add("rv-hit");
    if (o.line) row.title = tr("第 {p1} 行", { p1: o.line });
    row.scrollIntoView({ block: "center" });
  }

  private async copy(button: HTMLButtonElement): Promise<void> {
    const text = this.data?.head || this.fallback;
    const copy = navigator.clipboard?.writeText(text);
    if (!copy) return;
    void copy.then(() => {
      button.textContent = tr("已复制");
      setTimeout(() => { if (button.isConnected) button.textContent = tr("复制分支名"); }, 900);
    }).catch(() => {});
  }

  private async doFetch(): Promise<void> {
    if (this.fetchBtn.disabled || this.busy) return;
    this.fetchBtn.disabled = true;
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
    }
  }

  private say(text: string, bad = false): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle("bad", bad);
  }

  private saveFoldedGroups(): void {
    try { localStorage.setItem("pi.goGroupsFolded", JSON.stringify(this.foldedGroups)); } catch { /* 隐私模式之类：不记也行 */ }
  }

  // ---------------------------------------------------------------- paint

  private paintLoading(): void {
    this.cmpEl.replaceChildren(el("div", "branch-skeleton", tr("正在读 git…")));
    this.tabsEl.replaceChildren();
    this.colsEl.replaceChildren(el("div", "branch-skeleton", tr("正在读 git…")));
    this.stampEl.textContent = tr("正在读 git…");
  }

  private paintBusy(): void {
    if (!this.data) this.paintLoading();
    this.stampEl.textContent = tr("正在读 git…");
  }

  private paintError(err: unknown, keep: GitHistory | null = null): void {
    const code = (err as { code?: string } | null)?.code;
    if (!keep) { this.cmpEl.replaceChildren(); this.tabsEl.replaceChildren(); }
    const box = el("div", "branch-note");
    if (code === "empty") {
      box.append(el("div", "branch-note-title", tr("这个仓库还没有提交")), el("div", "branch-note-sub", tr("有一次提交之后这里就有历史了")));
    } else {
      box.append(el("div", "branch-note-title", errText(err)));
      const retry = btn(tr("重试"));
      retry.onclick = () => { this.paintLoading(); void this.load(true); };
      box.append(retry);
    }
    this.colsEl.replaceChildren(box);
    this.stampEl.textContent = tr("读取失败");
    this.fetchBtn.hidden = keep ? keep.branches.length === 0 : true;
  }

  /**
   * D289: 后台每次刷新都会把顶部对照栏整条重画 —— 正在里面打字的人会被清空，
   * 展开着的对照菜单也会被换掉（点下去那一刻正好被替换就点了个空）。
   * 对照栏长什么样只取决于这几个字段，没变就别重画。
   */
  private cmpSig = "";

  private paint(): void {
    if (!this.data) return;
    this.fetchBtn.hidden = this.data.branches.length === 0;
    const cmpSig = [
      this.data.head, this.data.base, this.data.ahead, this.data.behind,
      this.data.mergeBase?.h ?? "", JSON.stringify(this.data.branches),
    ].join("");
    if (cmpSig !== this.cmpSig) {
      this.cmpSig = cmpSig;
      this.paintCmp(this.data);
    }
    this.paintTabs();
    this.paintTabBody();
    const when = this.data.fetchedAt ? fmtRelative(this.data.fetchedAt) : tr("不知道（还没 fetch 过）");
    this.stampEl.textContent = tr("数据来自 {p1} · 操作后会刷新", { p1: when });
  }

  private paintCmp(data: GitHistory): void {
    const left = el("div", "bc-end left");
    left.append(el("span", "branch-glyph", "⎇"), el("span", "bc-name", data.head || tr("(未知)")), el("span", "bc-tag", headTag(data)));

    const mid = el("div", "bc-mid");
    const pills = el("div", "bc-pills");
    const ahead = el("span", "bc-pill ahead", tr("↑ 领先 {p1}", { p1: data.ahead }));
    const behind = el("span", "bc-pill behind", tr("↓ 落后 {p1}", { p1: data.behind }));
    if (!data.ahead) ahead.classList.add("zero");
    if (!data.behind) behind.classList.add("zero");
    pills.append(ahead, behind);
    mid.append(pills);
    if (data.mergeBase) mid.append(el("span", "bc-fork", tr("分叉于 {p1} · {p2}", { p1: data.mergeBase.h, p2: fmtRelative(data.mergeBase.at) })));

    const right = el("div", "bc-end right");
    const current = data.base || tr("自动 · 跟随 origin/HEAD");
    const picker = this.branchPicker({
      value: data.base,
      placeholder: tr("搜索分支或输入 ref"),
      ariaLabel: tr("对照分支"),
      toggleTitle: tr("搜索对照分支"),
      key: "cmp",
      auto: tr("自动 · 跟随 origin/HEAD"),
      isActive: (name) => name === this.base,
      useLabel: (text) => tr("用输入的 ref 对照：{p1}", { p1: text || "…" }),
      onPick: (ref) => this.applyCmp(ref),
      // 空输入回车仍按老规矩落到默认对照分支；点「自动」那一项才是不带 ref 的对照。
      onSubmit: (ref) => this.applyCmp(ref || (this.refs?.defaultBase ?? "")),
    });
    right.append(picker.wrap, el("span", "bc-tag go-cmp-tag", current));

    const bar = el("div", "bc-bar");
    const total = data.ahead + data.behind;
    const a = el("i", "a");
    const b = el("i", "b");
    if (total > 0) { a.style.flex = String(data.ahead); b.style.flex = String(data.behind); }
    else { a.style.flex = "0"; b.style.flex = "0"; bar.classList.add("even"); }
    bar.append(a, b);
    const counts = el("div", "bc-counts");
    counts.append(el("span", "", tr("{p1} 条你独有", { p1: data.ahead })), el("span", "", tr("{p1} 条你没有", { p1: data.behind })));
    this.cmpEl.replaceChildren(left, mid, right, bar, counts);
  }

  /**
   * 分支选择器：能检索、能点，也能直接输任意 ref。对照分支与「交给 AI 操作」共用这一份，
   * 差别只在传不传 auto（AI 卡不想要「自动 · 跟随 origin/HEAD」这一项）。
   */
  private branchPicker(opts: {
    value: string;
    placeholder: string;
    ariaLabel: string;
    toggleTitle: string;
    key: string;
    useLabel: (text: string) => string;
    onPick: (value: string) => void;
    onInput?: (value: string) => void;
    onSubmit?: (value: string) => void;
    isActive?: (name: string) => boolean;
    auto?: string;
    ensure?: string[];
    openOnFocus?: boolean;
  }): { wrap: HTMLElement; input: HTMLInputElement } {
    // 「全部 N 个分支」这一折的状态按每个选择器各记一份：默认收起，换检索词就收回。
    let allOpen = false;
    let foldKey = "";
    let listening = false;

    const wrap = el("div", "go-cmp-picker");
    const input = el("input", "go-cmp-input") as HTMLInputElement;
    input.type = "text";
    input.value = opts.value;
    input.placeholder = opts.placeholder;
    input.setAttribute("aria-label", opts.ariaLabel);
    input.setAttribute(`data-${opts.key}-input`, "1");

    const menu = markSurface(el("div", "go-cmp-menu"), "menu");
    menu.hidden = true;
    menu.setAttribute(`data-${opts.key}-menu`, "1");

    const toggle = btn("▾", "btn ghost go-cmp-toggle");
    toggle.setAttribute(`data-${opts.key}-toggle`, "1");
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = opts.toggleTitle;

    const outside = (ev: PointerEvent): void => {
      if (!wrap.contains(ev.target as Node)) close();
    };
    const close = (): void => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      allOpen = false;
      foldKey = "";
      if (listening) { listening = false; document.removeEventListener("pointerdown", outside, true); }
    };
    const pick = (value: string): void => {
      input.value = value;
      close();
      // AI 卡里选完把焦点还给输入框，好接着改字；对照分支会立刻重载重画，不用管焦点。
      if (opts.openOnFocus === false) input.focus();
      opts.onPick(value);
    };
    const submit = (): void => {
      const value = input.value.trim();
      input.value = value;
      close();
      (opts.onSubmit ?? opts.onPick)(value);
    };
    const paint = (query: string, forceOpen = false): void => {
      if (forceOpen && !menu.hidden) { close(); return; }
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      if (!listening) { listening = true; document.addEventListener("pointerdown", outside, true); }
      const q = query.trim().toLowerCase();
      // 输入变了就收回「全部」：检索是主线，折叠区只是给「想挑别的分支」留的出口。
      if (query.trim() !== foldKey) { foldKey = query.trim(); allOpen = false; }
      const seen = new Set<string>();
      const all: { name: string; label: string; group: string }[] = [];
      if (opts.auto !== undefined) all.push({ name: "", label: opts.auto, group: tr("自动") });
      for (const g of this.refs?.groups ?? []) {
        for (const r of g.refs) {
          if (seen.has(r.name)) continue;
          seen.add(r.name);
          all.push({ name: r.name, label: r.name, group: tr(g.name) });
        }
      }
      for (const b of this.data?.branches ?? []) {
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        all.push({ name: b.name, label: b.name, group: tr("历史") });
      }
      // refs 还没读回来时，至少把当前选中的分支留在列表里。
      for (const name of opts.ensure ?? []) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        all.push({ name, label: name, group: tr("历史") });
      }
      const hit = all.filter((r) => !q || r.label.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
      const list = el("div", "go-cmp-list");
      // 有检索词时列表会被筛短，想挑别的分支就得先清空输入。
      // 于是补一折「全部 N 个分支」：默认收起，点开才铺全量；检索词一改又收回。
      const branchTotal = all.filter((r) => r.name !== "").length;
      const folded = Boolean(q) && all.some((r) => r.name !== "" && !hit.includes(r));
      if (folded) {
        const head = btn("", "go-cmp-fold");
        head.setAttribute(`data-${opts.key}-fold`, "1");
        head.setAttribute("aria-expanded", String(allOpen));
        head.title = tr("展开看所有分支");
        head.append(
          el("span", "go-cmp-caret", allOpen ? "▾" : "▸"),
          el("span", "go-cmp-fold-name", tr("全部 {p1} 个分支", { p1: branchTotal })),
          el("span", "go-cmp-fold-count", tr("匹配 {p1}", { p1: hit.filter((r) => r.name !== "").length })),
        );
        head.onclick = () => { allOpen = !allOpen; paint(query); };
        list.append(head);
      }
      for (const r of folded && allOpen ? all : hit) {
        const b = btn(`${r.label} · ${r.group}`, "go-cmp-pick");
        b.setAttribute(`data-${opts.key}-pick`, r.name);
        b.classList.toggle("on", (opts.isActive ?? ((name) => name === input.value))(r.name));
        b.onclick = () => pick(r.name);
        list.append(b);
      }
      const typed = query.trim();
      const use = btn(opts.useLabel(typed), "go-cmp-use");
      use.setAttribute(`data-${opts.key}-use`, "1");
      // AI 卡没有「自动」这一项，空输入时没有可用的东西可选。
      use.disabled = !typed && opts.auto === undefined;
      use.onclick = () => { if (!use.disabled) pick(typed); };
      menu.replaceChildren(list, use);
    };

    input.oninput = () => { opts.onInput?.(input.value); paint(input.value); };
    input.onfocus = () => { if (opts.openOnFocus !== false) paint(input.value); };
    input.onclick = () => { if (menu.hidden) paint(input.value); };
    input.onkeydown = (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      submit();
    };
    toggle.onclick = () => paint(input.value, true);
    wrap.append(input, toggle, menu);
    return { wrap, input };
  }

  private applyCmp(ref: string): void {
    if (!ref && this.base === "") return;
    this.base = ref;
    this.limit = PAGE;
    this.diff = null;
    this.diffFile = -1;
    this.say("");
    void this.load(false);
  }

  private paintTabs(): void {
    const tabs: [BranchSheet["tab"], string][] = [
      ["history", tr("历史")], ["diff", tr("差异")], ["manual", tr("图解手册")],
    ];
    this.tabsEl.replaceChildren(...tabs.map(([id, text]) => {
      const b = btn(text, this.tab === id ? "on" : "");
      b.dataset.tab = id;
      b.onclick = () => {
        this.tab = id;
        this.paintTabs();
        this.paintTabBody();
        if (id === "diff" && !this.diff) void this.loadDiff();
      };
      return b;
    }));
  }

  private paintTabBody(): void {
    if (this.tab === "history") this.paintHistory();
    else if (this.tab === "diff") this.paintDiff();
    else this.paintManual();
  }

  // ---------------------------------------------------------------- 历史

  /**
   * D289: 后台每几秒重拉一次历史，`paintHistory()` 会把整批 `.bc-row` 换掉 —— 高亮、
   * 键盘焦点、滚动位置全跟着旧节点一起消失（test:githist:ui 就是被这个绊住的）。
   * 数据与这一屏长得一样时干脆别重画。
   */
  private historySig = "";

  private paintHistory(): void {
    const data = this.data;
    if (!data) return;
    // 侧栏的折叠状态 / 选中的分支也决定这一屏长什么样（组头、选中高亮都是本地状态）。
    const sig = `${this.side}${this.selectedBranch}${JSON.stringify(this.foldedGroups)}${JSON.stringify(this.refs)}${JSON.stringify(data)}`;
    const same = this.colsEl.firstElementChild?.classList.contains("go-history") === true;
    if (sig === this.historySig && same) {
      this.keepCommitRow();
      return;
    }
    this.historySig = sig;
    const wrap = el("div", "go-history");
    const sideTabs = el("div", "go-side-tabs");
    const makeSide = (side: "left" | "right", text: string): HTMLButtonElement => {
      const b = btn(text, this.side === side ? "on" : "");
      b.onclick = () => { this.side = side; this.paintHistory(); };
      return b;
    };
    sideTabs.append(makeSide("left", tr("当前 · {p1}", { p1: data.head })), makeSide("right", tr("对照 · {p1}", { p1: data.base })));
    const left = this.column("left", data.head, headTag(data), tr("{p1} 条你独有", { p1: data.ahead }), data.left, data.more.left);
    const right = this.column("right", data.base, baseTag(data), tr("{p1} 条你没有", { p1: data.behind }), data.right, data.more.right);
    const cols = el("div", "branch-cols");
    cols.dataset.show = this.side;
    cols.append(left, right);
    wrap.append(sideTabs, cols);

    if (this.embedded) {
      // #392：新窗口里没有常驻右栏，列表进头部下拉；侧栏内容与两颗 CTA 与老工作台一致。
      this.sidePop.replaceChildren(this.branchSideEl(data));
      this.sideToggle.textContent = tr("分支 · 本地 + 远程 · {p1}", { p1: this.branchLocalCount(data) });
    } else {
      wrap.append(this.branchSideEl(data));
    }
    this.colsEl.replaceChildren(wrap);
    this.keepCommitRow();
  }

  /**
   * D289: 列表被重画（后台刷新、换对照、写操作后 fresh 重拉）之后，还开着的详情卡那一行的
   * 高亮要跟到新节点上 —— 否则老节点跟着 replaceChildren 一起丢了，人看到的是「高亮自己没了」。
   */
  private keepCommitRow(): void {
    if (this.opLayer.hidden) return;
    const sha = this.opLayer.querySelector<HTMLElement>("[data-commit]")?.dataset.commit;
    if (!sha) return;
    const row = this.colsEl.querySelector<HTMLElement>(`.bc-row[data-h="${sha}"]`);
    if (!row) return;
    this.commitRow?.classList.remove("is-open");
    this.commitRow = row;
    row.classList.add("is-open");
  }

  private branchLocalCount(data: GitHistory): number {
    const groups = this.refs?.groups;
    if (!groups) return data.branches.length;
    return groups.reduce((n, g) => n + g.refs.length, 0);
  }

  /** 老工作台的常驻 aside，也供 embedded 的分支浮层复用。 */
  private branchSideEl(data: GitHistory): HTMLElement {
    const side = el("aside", "go-branch-side");
    side.append(el("div", "go-side-title", tr("分支 · 本地 + 远程")));
    for (const g of this.refs?.groups ?? [{ name: tr("历史"), refs: data.branches.map((b) => ({ name: b.name, at: b.at, current: b.name === data.head })) }]) {
      // 组头可折叠：分支一多，两组全展开会把右栏撑成一条望不到头的列表。默认折叠。
      const folded = this.foldedGroups[g.name] ?? true;
      const head = btn("", "go-side-group");
      head.dataset.group = g.name;
      head.setAttribute("aria-expanded", String(!folded));
      head.title = tr("展开或收起这一组分支");
      head.append(
        el("span", "go-side-caret", folded ? "▸" : "▾"),
        el("span", "go-side-name", tr(g.name)),
        el("span", "go-side-count", String(g.refs.length)),
      );
      head.onclick = () => {
        this.foldedGroups[g.name] = !folded;
        this.saveFoldedGroups();
        this.paintHistory();
      };
      side.append(head);
      if (folded) continue;
      for (const r of g.refs) {
        const b = btn(`${r.current ? "● " : ""}${r.name}`, "go-branch-row");
        b.dataset.branch = r.name;
        b.classList.toggle("on", r.name === this.selectedBranch);
        b.title = tr("选中后交给 agent 打包咨询");
        b.onclick = () => { this.selectedBranch = r.name; this.paintHistory(); };
        side.append(b);
      }
    }
    const ask = btn(tr("打包成一次咨询 → 交给 agent"), "btn ghost go-side-cta");
    ask.dataset.agent = "branch";
    ask.onclick = () => this.openHandoff(this.branchPrompt());
    side.append(ask);
    const ai = btn("", "btn ghost go-side-cta go-side-ai");
    ai.append(icon("pencil", { size: 13 }), el("span", "", tr("选分支 + 写要求 → 交给 AI 操作")));
    ai.dataset.ai = "1";
    ai.onclick = () => this.openAi();
    side.append(ai);
    return side;
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
      const moreBtn = btn(tr("再加载 {p1} 条", { p1: PAGE }), "bc-more");
      moreBtn.onclick = () => {
        moreBtn.disabled = true;
        moreBtn.textContent = tr("正在读 git…");
        this.limit = Math.min(LIMIT_MAX, this.limit + PAGE);
        void this.load(false);
      };
      body.append(moreBtn);
    } else if (more) body.append(el("div", "bc-empty", tr("只显示最近 {p1} 条", { p1: LIMIT_MAX })));
    col.append(head, body);
    return col;
  }

  private row(commit: GitCommit, side: "left" | "right"): HTMLElement {
    let setClass = "onlyR";
    if (commit.set === "common") setClass = "common";
    else if (commit.set === "left") setClass = "only";
    const row = el("div", `bc-row ${setClass}`);
    row.dataset.h = commit.h;
    row.title = `${commit.h} · ${commit.an} · ${fmtRelative(commit.at)}\n${commit.s}`;
    const subject = el("span", "bc-s");
    if (commit.merge) subject.append(el("span", "bc-badge", "merge"));
    subject.append(document.createTextNode(commit.s));
    row.append(el("span", "bc-h", commit.h), subject, el("span", "bc-meta", `${commit.an} · ${fmtRelative(commit.at)}`));
    row.classList.toggle("right", side === "right");
    // D289: 整行就是「看这条提交的详情」，键盘 Tab 到它、Enter / 空格打开。
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", tr("查看提交 {p1}：{p2}", { p1: commit.h.slice(0, 7), p2: commit.s }));
    const open = (): void => this.openCommit(commit, row);
    row.onclick = open;
    row.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      open();
    };
    return row;
  }

  // ---------------------------------------------------------------- 差异

  private paintDiff(): void {
    if (!this.diff) {
      this.colsEl.replaceChildren(el("div", "branch-skeleton", tr("正在读差异…")));
      return;
    }
    const wrap = el("div", "go-diff");
    const list = el("div", "go-diff-files");
    list.append(
      el(
        "div",
        "go-side-title",
        this.diff.worktree ? tr("变更文件 · 工作区改动") : tr("变更文件 · 当前分支 vs {p1}", { p1: this.diff.base }),
      ),
    );
    this.diff.files.forEach((f, i) => {
      const b = btn(`${f.status} ${f.path}`, "go-diff-row");
      b.dataset.file = String(i);
      b.classList.toggle("on", i === this.diffFile);
      b.onclick = () => { this.diffFile = i; this.paintDiff(); };
      list.append(b);
    });
    if (!this.diff.files.length) list.append(el("div", "bc-empty", tr("两边没有差异")));
    const detail = el("div", "go-diff-detail");
    const f = this.diff.files[this.diffFile];
    detail.append(f ? this.fileDetail(f) : el("div", "go-diff-empty", tr("点左边一个文件看并排差异")));
    wrap.append(list, detail);
    this.colsEl.replaceChildren(wrap);
  }

  /**
   * D289: `caps` 换掉图片两侧的落款（分支对照说「对照 / 当前」，提交详情说「父提交 / 本提交」）；
   * `limit` 换成桥端这次实际用的截断阈值，省略时用工作台自己那份。
   */
  /**
   * D289: 并排两栏的单元格。`hunk` 那条 `@@ -a,b +c,d @@` 要成对占两栏 —— 网格用
   * `:nth-child(odd)` 画中间那条分隔线，插一个跨栏元素会把后面每一行的奇偶都错开。
   */
  private codeRows(f: GitDiffFile): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const line of f.lines) {
      if (line.tag === "hunk") {
        const head = el("div", "go-code hunk", line.left);
        head.title = line.left;
        out.push(head, el("div", "go-code hunk"));
        continue;
      }
      out.push(el("div", `go-code ${line.tag}`, line.left), el("div", `go-code ${line.tag}`, line.right));
    }
    return out;
  }

  private fileDetail(
    f: GitDiffFile,
    caps?: { left: string; right: string },
    limit: { lines: number; bytes: number } | null = this.diff?.limit ?? null,
  ): HTMLElement {
    const box = el("div", "go-file");
    box.append(el("div", "go-file-head", `${f.path} · ${tr(f.kind)} · +${f.additions} −${f.deletions}`));
    if (f.kind === "image" && f.images) {
      const pair = el("div", "go-img-pair");
      const capL = caps?.left ?? tr("对照 · {p1}", { p1: this.diff?.base ?? "" });
      const capR = caps?.right ?? tr("当前 · {p1}", { p1: this.data?.head ?? "" });
      for (const [cap, src] of [[capL, f.images.base], [capR, f.images.target]] as const) {
        const cell = el("div", "go-img-cell");
        cell.append(el("span", "go-cap", cap));
        if (src) {
          const img = el("img", "go-img") as HTMLImageElement;
          img.src = src;
          img.alt = cap;
          cell.append(img);
        } else cell.append(el("div", "go-ph", tr("这一侧没有图片")));
        pair.append(cell);
      }
      box.append(pair);
    } else if (f.kind === "text") {
      const grid = el("div", "go-codegrid");
      grid.append(...this.codeRows(f));
      box.append(grid);
      if (f.truncated) box.append(el("div", "go-trunc", tr("大文件已截断：只显示前 {p1} 行 / {p2} KB", { p1: limit?.lines ?? 200, p2: Math.round((limit?.bytes ?? 409600) / 1024) })));
      if (f.note) box.append(el("div", "go-note", f.note));
    } else {
      box.append(el("div", "go-ph", tr("非文本占位：{p1}", { p1: tr(f.kind) })));
      if (f.note) box.append(el("div", "go-note", f.note));
    }
    return box;
  }

  // ---------------------------------------------------------------- 提交详情（D289）

  /**
   * D289: 历史里点一行 → 这条提交的详情卡（样张 B：左主右，右栏上文件清单下并排差异）。
   *
   * 卡先按行里已有的数据画出来（短哈希、标题、作者、相对时间），元信息 / 文件清单 / 说明等
   * `/api/git/commit` 回来再补；**点开哪个文件才拉哪一份差异** —— 桥端那个接口不读 blob，
   * 一次全量 diff 才是真的贵。关掉它（Esc / ✕ / 点遮罩）都回到工作台，焦点还给这一行。
   */
  private openCommit(commit: GitCommit, rowEl: HTMLElement): void {
    const repo = this.data?.repo ?? this.dir;
    const key = `${repo}|${commit.h}`;
    const ticket = ++this.commitTicket;
    rowEl.classList.add("is-open");
    this.commitRow = rowEl;

    const card = el("div", "go-card go-commit");
    card.dataset.commit = commit.h;
    card.tabIndex = -1;
    card.append(this.cardHead(`${commit.h.slice(0, 7)}  ${commit.s}`, `${commit.an} · ${fmtRelative(commit.at)}`, false, "◍"));

    const cardBody = el("div", "go-commit-body");
    const side = el("div", "go-commit-side");
    side.dataset.commitSide = "1";
    const main = el("div", "go-commit-main");
    const filesHead = el("div", "go-commit-files-head");
    filesHead.dataset.commitFilesHead = "1";
    const fileList = el("div", "go-commit-files");
    fileList.dataset.commitFiles = "1";
    const pane = el("div", "go-commit-diff");
    pane.dataset.commitDiff = "1";
    main.append(filesHead, fileList, pane);
    cardBody.append(side, main);
    const foot = el("div", "go-card-foot go-commit-foot");
    card.append(cardBody, foot);
    this.openCard(card, true);
    card.focus();

    let detail: GitCommitDetail | null = null;
    let picked = -1;
    let loadingMore = false;

    const paintSide = (d: GitCommitDetail | null): void => {
      side.replaceChildren();
      if (!d) {
        side.append(el("div", "go-commit-wait", tr("正在读这条提交…")));
        return;
      }
      const meta = el("div", "go-commit-meta");
      const line = (k: string, v: Node | string): void => {
        const row = el("div", "go-meta-row");
        const val = el("span", "go-meta-v");
        if (typeof v === "string") val.textContent = v;
        else val.append(v);
        row.append(el("span", "go-meta-k", k), val);
        meta.append(row);
      };
      line(tr("作者"), d.author);
      line(tr("时间"), fmtRelative(d.at));
      if (d.parents.length === 1) {
        const one = el("span", "go-meta-mono", d.parents[0].slice(0, 7));
        one.title = d.parents[0];
        line(tr("父提交"), one);
      } else if (d.parents.length > 1) {
        const wrap = el("span", "go-meta-parents");
        d.parents.forEach((p, i) => {
          const one = el("span", "go-meta-mono", p.slice(0, 7));
          one.title = p;
          if (i === 0) one.append(el("span", "go-meta-tag", tr("第一父")));
          wrap.append(one);
        });
        line(tr("父提交"), wrap);
      } else line(tr("父提交"), tr("（根提交）"));
      const chips = el("span", "go-meta-chips");
      if (d.onHead) chips.append(el("span", "go-commit-chip ok", tr("在当前分支")));
      chips.append(el("span", d.pushed ? "go-commit-chip" : "go-commit-chip warn", d.pushed ? tr("已推送") : tr("未推送")));
      if (d.merge) chips.append(el("span", "go-commit-chip", "merge"));
      line(tr("位置"), chips);
      if (d.decorations.trim()) {
        const deco = el("span", "go-meta-chips");
        for (const one of d.decorations.split(",").map((x) => x.trim()).filter(Boolean)) deco.append(el("span", "go-commit-chip", one));
        line(tr("引用"), deco);
      }
      const sha = el("span", "go-meta-mono go-meta-sha", d.sha);
      sha.title = d.sha;
      line(tr("SHA"), sha);
      side.append(meta);

      const box = el("div", "go-commit-msg-box");
      box.append(el("div", "go-commit-msg-title", tr("提交说明")));
      const msg = el("div", d.body ? "go-commit-msg" : "go-commit-msg go-empty", d.body || tr("（只有标题，没有补充说明）"));
      box.append(msg);
      if (d.body.split("\n").length > 6 || d.body.length > 420 || d.bodyTruncated) {
        const more = btn(tr("展开全文"), "go-commit-more");
        more.dataset.commitMore = "1";
        more.onclick = () => {
          const open = msg.classList.toggle("open");
          more.textContent = open ? tr("收起") : tr("展开全文");
        };
        box.append(more);
      }
      if (d.bodyTruncated) box.append(el("div", "go-note", tr("说明太长，只显示前 {p1} 行", { p1: d.limit.bodyLines })));
      side.append(box);
    };

    const paintFiles = (): void => {
      filesHead.replaceChildren(el("span", "go-commit-files-title", tr("变更文件")));
      fileList.replaceChildren();
      if (!detail) {
        fileList.append(el("div", "go-commit-wait", tr("正在读文件清单…")));
        return;
      }
      const d = detail;
      filesHead.replaceChildren();
      const add = d.files.reduce((n, f) => n + f.additions, 0);
      const del = d.files.reduce((n, f) => n + f.deletions, 0);
      filesHead.append(
        el("span", "go-commit-files-title", tr("变更文件 {p1} 个", { p1: d.files.length })),
        el("span", "grow"),
        el("span", "go-commit-total", `+${add} −${del}`),
      );
      d.files.forEach((f, i) => {
        const b = btn("", "go-commit-file");
        b.dataset.commitFile = String(i);
        b.classList.toggle("on", i === picked);
        b.append(el("span", "go-fstat", f.status), el("span", "go-fpath", f.path), el("span", "go-fnum", f.binary ? tr("二进制") : `+${f.additions} −${f.deletions}`));
        b.title = f.old ? tr("原名 {p1} → 现名 {p2}", { p1: f.old, p2: f.path }) : f.path;
        b.onclick = () => {
          picked = i;
          paintFiles();
          void loadFile(i);
        };
        fileList.append(b);
      });
      if (!d.files.length) fileList.append(el("div", "bc-empty", tr("这条提交没有文件改动")));
      if (d.more) fileList.append(el("div", "go-note", tr("只列出前 {p1} 个文件，共 {p2} 个", { p1: d.limit.files, p2: d.total })));
    };

    /**
     * D289: 差异按 `@@` 块分页。`from === 0` 是换文件（清空重画），`from > 0` 是往下续拉，
     * 直接往已有的 `.go-codegrid` 后面追加 —— 桥端一页 20 块，滚到底再要下一页，
     * 所以「一屏 200 行、改在后面的看不到」这个毛病没了。
     */
    const hunkMore = (box: HTMLElement, full: GitDiffFile): void => {
      box.querySelector("[data-hunk-more]")?.remove();
      const h = full.hunks;
      if (!h) return;
      const next = h.from + h.count;
      if (next >= h.total) return;
      const noteEl = el("div", "go-hunk-more", tr("已显示 {p1}/{p2} 个变更块 · 继续往下滚看剩下的", { p1: next, p2: h.total }));
      noteEl.dataset.hunkMore = String(next);
      box.append(noteEl);
    };

    const loadFile = async (i: number, from = 0): Promise<void> => {
      const d = detail;
      const f = d?.files[i];
      if (!d || !f) return;
      if (from > 0 && loadingMore) return;
      if (from === 0) pane.replaceChildren(el("div", "branch-skeleton", tr("正在读差异…")));
      loadingMore = from > 0;
      try {
        const full = await api.gitCommitFile(this.dir, d.sha, f.path, f.old ?? "", from);
        if (ticket !== this.commitTicket || !card.isConnected || picked !== i) return;
        const box = from > 0 ? pane.querySelector<HTMLElement>(".go-file") : null;
        const grid = box?.querySelector<HTMLElement>(".go-codegrid");
        if (from > 0 && box && grid) {
          grid.append(...this.codeRows(full));
          hunkMore(box, full);
        } else if (from === 0) {
          const one = this.fileDetail(full, {
            left: d.parents.length ? tr("父提交 · {p1}", { p1: d.parents[0].slice(0, 7) }) : tr("（空树）"),
            right: tr("本提交 · {p1}", { p1: d.short }),
          }, null);
          pane.replaceChildren(one);
          hunkMore(one, full);
        }
      } catch (err) {
        if (ticket !== this.commitTicket || !card.isConnected) return;
        if (from === 0) pane.replaceChildren(el("div", "branch-note", errText(err)));
        else pane.querySelector("[data-hunk-more]")?.replaceWith(el("div", "branch-note", errText(err)));
      } finally {
        loadingMore = false;
      }
    };

    const paintFoot = (): void => {
      // 底栏不放「Esc / ✕ / 点遮罩都关掉它」那句提示：说明展开全文时会压到内容上，
      // 而且三种关法本来就套在 ✕ 与遮罩上，写在按钮旁边是废话。
      foot.replaceChildren();
      const acts = el("div", "go-acts");
      const copy = btn(tr("复制 SHA"));
      copy.dataset.commitCopy = "1";
      copy.onclick = () => void this.copyText(detail?.sha ?? commit.h, copy, tr("复制 SHA"));
      const pick = btn(tr("摘提交"), "btn ghost");
      pick.dataset.commitOp = "cherry_pick";
      const revert = btn(tr("回滚"), "btn ghost go-danger");
      revert.dataset.commitOp = "revert";
      for (const b of [pick, revert]) {
        b.onclick = () => {
          const sha = detail?.sha ?? commit.h;
          this.closeOp();
          this.openOp(b.dataset.commitOp ?? "", { hashes: sha });
        };
      }
      // 不适合的照常显示、禁用 + 说明（grilling 定的「不藏按钮」）；merge 提交两个动词都要 -m，
      // 现有操作卡没有 -m 入口，与其让人跑出一条红字，不如先禁掉。
      const pickWhy = detail?.onHead
        ? tr("这条已经在当前分支上，摘过来会是一个空提交")
        : detail?.merge
          ? tr("这是 merge 提交，摘提交要先指定 -m，操作卡还没有这个入口")
          : null;
      const revertWhy = detail?.merge
        ? tr("这是 merge 提交，回滚要先指定 -m，操作卡还没有这个入口")
        : null;
      pick.disabled = !!pickWhy;
      pick.title = pickWhy ?? tr("把这条提交摘到当前分支（走现有的摘提交操作卡）");
      revert.disabled = !!revertWhy;
      revert.title = revertWhy ?? tr("在当前分支上生成一条反向提交（走现有的回滚操作卡）");
      const close = btn(tr("关闭"), "btn primary");
      close.dataset.commitClose = "1";
      close.onclick = () => this.closeOp();
      acts.append(copy, pick, revert, close);
      foot.append(acts);
    };

    const apply = (d: GitCommitDetail): void => {
      detail = d;
      paintSide(d);
      paintFiles();
      paintFoot();
      const first = d.files.findIndex((f) => f.kind === "text");
      if (first >= 0) {
        picked = first;
        paintFiles();
        void loadFile(first);
      } else pane.replaceChildren(el("div", "go-diff-empty", tr("这条提交没有可显示的文本差异")));
      const on = fileList.querySelector<HTMLElement>(`[data-commit-file="${Math.max(picked, 0)}"]`);
      on?.focus();
      on?.scrollIntoView({ block: "nearest" });
    };

    // 滚到底就把下一页变更块接上（一页 20 块，见桥端 HUNKS_PER_PAGE）。
    pane.addEventListener("scroll", () => {
      const noteEl = pane.querySelector<HTMLElement>("[data-hunk-more]");
      if (!noteEl || picked < 0 || loadingMore) return;
      if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 160) return;
      void loadFile(picked, Number(noteEl.dataset.hunkMore ?? 0));
    });

    pane.append(el("div", "go-diff-empty", tr("正在读这条提交…")));
    paintSide(null);
    paintFiles();
    paintFoot();

    const cached = this.commitCache.get(key);
    if (cached) { apply(cached); return; }
    void (async () => {
      try {
        const d = await api.gitCommit(this.dir, commit.h);
        this.commitCache.set(key, d);
        if (ticket !== this.commitTicket || !card.isConnected) return;
        apply(d);
      } catch (err) {
        if (ticket !== this.commitTicket || !card.isConnected) return;
        side.replaceChildren(el("div", "branch-note", errText(err)));
        fileList.replaceChildren();
        filesHead.replaceChildren(el("span", "go-commit-files-title", tr("变更文件")));
        pane.replaceChildren(el("div", "go-diff-empty", tr("读不到这条提交的详情")));
      }
    })();
  }

  /** 复制一段文字，按钮上闪一下「已复制」。分支名与提交 SHA 共用。 */
  private async copyText(text: string, button: HTMLButtonElement, label: string): Promise<void> {
    const done = navigator.clipboard?.writeText(text);
    if (!done) return;
    await done.then(() => {
      button.textContent = tr("已复制");
      setTimeout(() => { if (button.isConnected) button.textContent = label; }, 900);
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- 图解手册

  private paintManual(): void {
    const wrap = el("div", "go-manual");
    const filters = el("div", "go-filters");
    for (const f of MANUAL_FILTERS) {
      const b = btn(f, "go-filter");
      b.classList.toggle("on", f === this.manualFilter);
      b.onclick = () => { this.manualFilter = f; this.paintManual(); };
      filters.append(b);
    }
    const grid = el("div", "go-manual-grid");
    const redOnly = this.manualFilter === MANUAL_FILTERS[1];
    const group = OP_GROUPS.find((g) => tr(g) === this.manualFilter);
    const ops = GIT_OPS.filter((op) => redOnly ? op.red : !group || op.group === group);
    for (const op of ops) {
      const card = el("div", op.red ? "go-mcard red" : "go-mcard");
      card.append(el("div", "go-mcard-head", `${op.glyph}  ${op.title}`), el("div", "go-mcard-sub", op.sub));
      const frames = opFrames(op);
      const ill = el("div", "go-mcard-ill");
      for (const svg of frames) {
        const cell = el("div", "go-ill-cell");
        cell.append(svgNode(svg));
        ill.append(cell);
      }
      card.append(ill, el("div", "go-mcard-ex", op.explain));
      const open = btn(tr("打开操作卡"), "btn ghost");
      open.dataset.op = op.id;
      open.onclick = () => this.openOp(op.id);
      card.append(open);
      grid.append(card);
    }
    wrap.append(filters, grid);
    this.colsEl.replaceChildren(wrap);
  }

  // ---------------------------------------------------------------- 操作卡（居中，样张 D）

  private closeOp(): void {
    this.commitTicket += 1;
    const back = this.commitRow?.isConnected ? this.commitRow : this.sheet;
    this.commitRow?.classList.remove("is-open");
    this.commitRow = null;
    this.opLayer.hidden = true;
    this.opLayer.replaceChildren();
    back.focus();
  }

  private openCard(node: HTMLElement, wide = false): void {
    // 每张卡都留一个结果槽：从确认卡 / 脏区卡 / 继续卡里执行时，失败卡有地方落。
    if (!node.querySelector("[data-result]")) {
      const slot = el("div", "go-result");
      slot.dataset.result = "1";
      node.append(slot);
    }
    this.opLayer.replaceChildren(node);
    this.opLayer.hidden = false;
    node.classList.toggle("wide", wide);
    const first = node.querySelector<HTMLElement>("input, textarea, select, button.primary");
    first?.focus();
  }

  private openVerbs(): void {
    const card = el("div", "go-card go-verbs");
    card.append(this.cardHead(tr("全部动词 · {p1}", { p1: GIT_OPS.length }), tr("每个动作都有图解、参数和风险说明"), false, ""));
    const body = el("div", "go-verbs-body");
    for (const g of OP_GROUPS) {
      const box = el("div", "go-verbs-group");
      box.append(el("div", "go-verbs-title", tr(g)));
      const grid = el("div", "go-verbs-grid");
      for (const op of GIT_OPS.filter((o) => o.group === g)) {
        const b = btn(`${op.glyph}  ${op.title}`, op.red ? "go-verb red" : "go-verb");
        b.dataset.op = op.id;
        b.title = op.sub;
        b.onclick = () => this.openOp(op.id);
        grid.append(b);
      }
      box.append(grid);
      body.append(box);
    }
    card.append(body, this.cardFoot());
    this.openCard(card, true);
  }

  private openAi(): void {
    const card = el("div", "go-card go-ai-card");
    card.append(this.cardHead(tr("交给 AI 操作"), tr("只把提示词放进输入框，不自动发送、不先动 git"), false, ""));
    const body = el("div", "go-card-body");
    const req = el("textarea", "go-textarea") as HTMLTextAreaElement;
    req.rows = 3;
    req.placeholder = tr("输入你的要求，例如：判断该切到 main 还是先合并，别直接动 git");
    const preview = pre("");
    const sync = (value: string): void => { preview.textContent = this.branchPrompt(value, req.value); };
    // 和对照分支同一个选择器：可检索、可点、也可直接输 ref；打开卡时不自动弹菜单。
    const picker = this.branchPicker({
      value: this.selectedBranch,
      placeholder: tr("搜索分支或输入 ref"),
      ariaLabel: tr("分支"),
      toggleTitle: tr("展开分支候选"),
      key: "aib",
      ensure: [this.selectedBranch],
      openOnFocus: false,
      useLabel: (text) => tr("用输入的分支：{p1}", { p1: text || "…" }),
      onPick: (value) => sync(value),
      onInput: (value) => sync(value),
    });
    req.oninput = () => sync(picker.input.value);
    sync(picker.input.value);
    body.append(
      el("label", "go-label", tr("① 选一条分支")), picker.wrap,
      el("label", "go-label", tr("② 输入要求")), req,
      el("label", "go-label", tr("提示词预览")), preview,
      el("div", "go-note", tr("新会话并预填 / 预填到当前会话都只填不发；复用输入框的 prefill() 与 newSessionWith()。")),
    );
    const acts = el("div", "go-acts");
    const goNew = btn(tr("新会话并预填"), "btn primary");
    goNew.dataset.aiGo = "new";
    goNew.onclick = () => this.handoffGo(preview.textContent ?? "", true, sessionNameFromBranchRef(picker.input.value));
    const goCur = btn(tr("预填到当前会话"));
    goCur.dataset.aiGo = "current";
    goCur.onclick = () => this.handoffGo(preview.textContent ?? "", false, sessionNameFromBranchRef(picker.input.value));
    acts.append(goNew, goCur, this.cancelBtn());
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  private branchPrompt(
    branch = this.selectedBranch,
    requirement = "",
    failure?: { argv: string[]; exitCode: number; stderr: string; code?: string },
  ): string {
    return buildHandoffPrompt({
      repo: this.data?.repo ?? this.dir,
      branch: this.state?.branch ?? this.fallback,
      selected: branch,
      ahead: this.data?.ahead,
      behind: this.data?.behind,
      dirty: this.state?.dirty,
      requirement,
      failure,
    });
  }

  /**
   * `ref` 是这条提示词用的分支：名字就用它（#487），默认当前选中的那条。
   */
  private openHandoff(prompt: string, ref = this.selectedBranch): void {
    const name = sessionNameFromBranchRef(ref);
    const card = el("div", "go-card go-handoff");
    card.append(this.cardHead(tr("交给 agent"), tr("只填进输入框，不自动发送"), false, ""));
    const body = el("div", "go-card-body");
    const box = pre(prompt);
    body.append(box, el("div", "go-note", tr("新会话并预填 / 预填到当前会话都只填不发；复用输入框的 prefill() 与 newSessionWith()。")));
    const acts = el("div", "go-acts");
    const goNew = btn(tr("新会话并预填"), "btn primary");
    goNew.dataset.aiGo = "new";
    goNew.onclick = () => this.handoffGo(prompt, true, name);
    const goCur = btn(tr("预填到当前会话"));
    goCur.dataset.aiGo = "current";
    goCur.onclick = () => this.handoffGo(prompt, false, name);
    acts.append(goNew, goCur, this.cancelBtn());
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  private handoffGo(prompt: string, newSession: boolean, name?: string): void {
    if (!this.handoff) { this.say(tr("这个面板没接上输入框，提示词已留在卡里"), true); return; }
    if (newSession) this.handoff.newSessionWith(prompt, name);
    else this.handoff.prefill(prompt, name);
    this.say(tr("已放进输入框，没有自动发送"));
    this.closeOp();
  }

  private cancelBtn(): HTMLButtonElement {
    const b = btn(tr("取消"));
    b.dataset.cancel = "1";
    b.onclick = () => this.closeOp();
    return b;
  }

  private cardHead(title: string, sub: string, red: boolean, glyph: string): HTMLElement {
    const head = el("div", red ? "go-card-head red" : "go-card-head");
    head.append(el("span", "go-card-glyph", glyph), el("div", "go-card-titles", ""));
    const titles = head.lastElementChild as HTMLElement;
    titles.append(el("div", "go-card-title", title), el("div", "go-card-sub", sub));
    const x = btn("close", "go-card-x");
    x.onclick = () => this.closeOp();
    head.append(x);
    return head;
  }

  private cardFoot(): HTMLElement {
    const foot = el("div", "go-card-foot");
    foot.append(el("span", "", tr("普通动作点「执行」即跑；红色动作再加一张确认卡")));
    foot.append(this.cancelBtn());
    return foot;
  }

  // ---------------------------------------------------------------- 单动词操作卡

  /** D289: `prefill` 让提交详情里的「摘提交 / 回滚」把哈希带进操作卡，用户不用再抄一遍。 */
  private openOp(id: string, prefill: GitOpParams = {}): void {
    const op = OPS_BY_ID[id];
    if (!op) return;
    // 冲突态只放行中止 / 继续 / handoff，其余一律禁点。
    if (this.state?.pending && !["abort", "continue"].includes(id)) {
      this.say(tr("仓库停在冲突状态：只放行中止 / 继续 / 交给 agent"), true);
      return;
    }
    const card = el("div", "go-card go-op-card");
    card.dataset.opCard = id;
    card.append(this.cardHead(op.title, op.sub, !!op.red, op.glyph));
    const body = el("div", "go-card-body");
    body.append(this.frames(op), el("div", "go-explain", op.explain), el("div", "go-risk", op.risk));
    const form = el("div", "go-form");
    form.dataset.form = "1";
    const state = this.state;
    for (const field of op.fields) {
      form.append(el("label", "go-label", field.label));
      if (field.type === "files") {
        form.append(this.filePicker(op, state));
      } else if (field.type === "branch" || field.type === "ref") {
        const input = el("input", "go-input") as HTMLInputElement;
        input.dataset.field = field.key;
        input.value = field.type === "branch" ? (this.selectedBranch || "") : (field.placeholder ?? "");
        input.placeholder = field.placeholder ?? "";
        form.append(input);
      } else if (field.type === "textarea") {
        const input = el("textarea", "go-textarea") as HTMLTextAreaElement;
        input.rows = 2;
        input.dataset.field = field.key;
        input.placeholder = field.placeholder ?? "";
        form.append(input);
      } else {
        const input = el("input", "go-input") as HTMLInputElement;
        input.type = field.type === "number" ? "number" : "text";
        input.dataset.field = field.key;
        input.placeholder = field.placeholder ?? "";
        form.append(input);
      }
    }
    for (const [key, value] of Object.entries(prefill)) {
      const node = form.querySelector<HTMLInputElement>(`[data-field="${key}"]`);
      if (node && typeof value === "string") node.value = value;
    }
    const switches = el("div", "go-switches");
    for (const sw of op.switches) {
      const label = el("label", "go-switch");
      const input = el("input") as HTMLInputElement;
      input.type = "checkbox";
      input.dataset.switch = sw.key;
      input.checked = !!sw.defaultOn;
      label.append(input, el("span", "", sw.label));
      if (sw.hint) label.append(el("span", "go-switch-hint", sw.hint));
      switches.append(label);
    }
    form.append(switches);
    form.append(el("label", "go-label", tr("将执行的命令（桥端白名单拼接）")), pre(op.sample));
    body.append(form);
    const acts = el("div", "go-acts");
    const run = btn(op.red ? tr("查看确认卡") : tr("执行"), "btn primary");
    run.dataset.run = "1";
    run.onclick = () => {
      const params = this.readParams(card, op);
      if (!params) return;
      if (op.red && id !== "restore") { this.openConfirm(op, params); return; }
      // restore 的逐文件勾选清单本身就是确认（第 8 轮共识），不再叠第二张红色卡。
      void this.runOp(op, params);
    };
    const agent = btn(tr("交给 agent"));
    agent.dataset.agent = "op";
    agent.onclick = () => this.openHandoff(this.branchPrompt(this.selectedBranch, tr("{p1}：{p2}", { p1: op.title, p2: op.sample })));
    acts.append(run, agent, this.cancelBtn());
    body.append(acts);
    const result = el("div", "go-result");
    result.dataset.result = "1";
    card.append(body, result);
    this.openCard(card, true);
  }

  private frames(op: GitOpDef): HTMLElement {
    const box = el("div", "go-frames");
    const [before, after] = opFrames(op);
    const cell = (svg: string, cap: string): HTMLElement => {
      const c = el("div", "go-frame-cell");
      const frame = el("div", "go-frame");
      frame.append(svgNode(svg));
      c.append(frame, el("div", "go-cap", cap));
      return c;
    };
    box.append(cell(before, op.before), el("div", "go-arrow", "→"), cell(after, op.after));
    return box;
  }

  private filePicker(op: GitOpDef, state: GitWorktreeState | null): HTMLElement {
    const box = el("div", "go-files");
    box.dataset.files = "1";
    if (!state) { box.append(el("div", "go-note", tr("正在读仓库状态…"))); return box; }
    const groups: [string, typeof state.staged][] = [
      [tr("已暂存"), state.staged], [tr("未暂存"), state.unstaged], [tr("未跟踪"), state.untracked],
    ];
    if (op.id === "restore") groups.shift(); // restore 不列已暂存：只丢工作区改动
    for (const [name, files] of groups) {
      box.append(el("div", "go-files-group", name));
      for (const f of files) {
        const label = el("label", "go-file-check");
        const input = el("input") as HTMLInputElement;
        input.type = "checkbox";
        input.dataset.path = f.path;
        input.checked = op.id === "stage" && name === tr("未暂存");
        label.append(input, el("span", "", f.path), el("span", "go-file-status", f.status));
        box.append(label);
      }
      if (!files.length) box.append(el("div", "go-note", tr("（空）")));
    }
    return box;
  }

  private readParams(card: HTMLElement, op: GitOpDef): GitOpParams | null {
    const params: GitOpParams = {};
    for (const elm of card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-field]")) {
      const key = elm.dataset.field ?? "";
      const value = elm.value.trim();
      const field = op.fields.find((f) => f.key === key);
      if (field?.required && !value && field.type !== "files") {
        this.say(tr("「{p1}」还没填", { p1: field.label }), true);
        elm.focus();
        return null;
      }
      if (value) params[key] = value;
    }
    const picker = card.querySelector<HTMLElement>("[data-files]");
    if (picker) {
      const paths = [...picker.querySelectorAll<HTMLInputElement>("input[data-path]:checked")].map((i) => i.dataset.path ?? "").filter(Boolean);
      if (!paths.length) { this.say(tr("先勾中至少一个文件"), true); return null; }
      params.paths = paths;
    }
    for (const elm of card.querySelectorAll<HTMLInputElement>("[data-switch]")) params[elm.dataset.switch ?? ""] = elm.checked;
    for (const field of op.fields) {
      if (field.key === "remote" && !params.remote) params.remote = "origin";
      if (field.key === "branch" && !params.branch) params.branch = this.state?.branch ?? "";
    }
    return params;
  }

  private openConfirm(op: GitOpDef, params: GitOpParams): void {
    const card = el("div", "go-card go-confirm");
    card.dataset.confirm = op.id;
    card.append(this.cardHead(tr("确认 · {p1}", { p1: op.title }), tr("红色动作：会丢东西，执行前再看一眼"), true, op.glyph));
    const body = el("div", "go-card-body");
    body.append(el("div", "go-danger-title", tr("这一步会丢：")));
    const lose = el("ul", "go-lose");
    for (const item of op.lose ?? []) lose.append(el("li", "", item));
    body.append(lose);
    if (op.rollback) {
      body.append(el("label", "go-label", tr("可复制的回退命令")), pre(op.rollback));
      const copy = btn(tr("复制回退命令"));
      copy.dataset.copy = op.rollback;
      copy.onclick = () => void navigator.clipboard?.writeText(op.rollback ?? "");
      body.append(copy);
    }
    const acts = el("div", "go-acts");
    const force = btn(tr("执行（不可撤回）"), "btn primary danger");
    force.dataset.force = "1";
    force.onclick = () => void this.runOp(op, params);
    acts.append(force, this.cancelBtn());
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  // ---------------------------------------------------------------- 执行 / 结果

  private async runOp(op: GitOpDef, params: GitOpParams): Promise<void> {
    // 上一个动作还在收尾（paintResult 之后的 load() 刷新）：这一下不能静默扔掉，否则用户
    // 看到的就是「点了执行没反应」。执行按钮同时被 data-busy 压成不可点，键盘回车走到
    // 这里也会得到一句回话。
    if (this.busy) {
      this.say(tr("上一步还在收尾，稍等一下再点"), true);
      return;
    }
    // 脏区且会覆盖工作区：弹三选一，不直接跑。
    if (op.covers && this.state?.dirty && !params.__skipDirty) {
      this.openDirty(op, params);
      return;
    }
    const clean: GitOpParams = { ...params };
    delete clean.__skipDirty;
    this.setBusy(true);
    this.say(tr("正在执行 {p1}…", { p1: op.title }));
    const card = this.opLayer.firstElementChild as HTMLElement | null;
    if (card?.querySelector<HTMLElement>("[data-result]")) {
      card.querySelector<HTMLElement>("[data-result]")!.replaceChildren(el("div", "go-note", tr("正在执行 {p1}…", { p1: op.title })));
    }
    try {
      const out = await api.gitOp(this.dir, op.id, clean);
      this.state = out.state;
      this.paintResult(out, op, clean);
      if (out.refresh) {
        this.refreshChip?.();
        this.diff = null;
        await this.load(true);
      }
    } catch (err) {
      const card2 = this.opLayer.firstElementChild as HTMLElement | null;
      const box = card2?.querySelector<HTMLElement>("[data-result]") ?? this.opLayer;
      box.replaceChildren(el("div", "go-result-card bad", errText(err)));
      this.say(errText(err), true);
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 「忙着」对用户可见：执行卡上的 run / force 按钮在 data-busy 下置灰且不可点，
   * 自动化和真人点击都会等它过去，而不是被一声不响地吞掉（详见 runOp 的短路）。
   */
  private setBusy(on: boolean): void {
    this.busy = on;
    if (on) this.opLayer.dataset.busy = "1";
    else delete this.opLayer.dataset.busy;
  }

  private openDirty(op: GitOpDef, params: GitOpParams): void {
    const card = el("div", "go-card go-dirty");
    card.append(this.cardHead(tr("工作区有改动"), tr("这个操作会覆盖文件，先选一种处理"), false, "!"));
    const body = el("div", "go-card-body");
    body.append(el("div", "go-note", tr("未提交改动：{p1} 个文件", { p1: this.state?.dirty ?? 0 })));
    const acts = el("div", "go-acts");
    const stash = btn(tr("先 stash，再继续"), "btn primary");
    stash.dataset.dirtyStash = "1";
    stash.onclick = () => void (async () => {
      const saved = await api.gitOp(this.dir, "stash", { message: tr("操作 {p1} 之前自动收起", { p1: op.title }), includeUntracked: true });
      if (!saved.ok) { this.paintResult(saved, OPS_BY_ID.stash, {}); return; }
      void this.runOp(op, { ...params, __skipDirty: true });
    })();
    const discard = btn(tr("逐文件放弃…"));
    discard.dataset.dirtyDiscard = "1";
    discard.onclick = () => this.openOp("restore");
    const cancel = this.cancelBtn();
    cancel.textContent = tr("取消这次操作");
    acts.append(stash, discard, cancel);
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  private paintResult(out: GitExecResult, op: GitOpDef, params: GitOpParams): void {
    let tone = "bad";
    if (out.ok && !out.pending) tone = "ok";
    else if (out.pending) tone = "warn";
    const banner = el("div", `go-result-card ${tone}`);
    let title = tr("执行失败 · exit {p1}", { p1: out.exitCode });
    if (out.ok && !out.pending) title = tr("执行成功 · 已刷新");
    else if (out.pending) title = tr("仓库停在冲突状态");
    banner.append(el("div", "go-result-title", title));
    // argv 是传给 git 的参数（不含程序名），补上 `git` 才是用户能照着复制的命令。
    banner.append(el("label", "go-label", tr("已执行命令")), pre(`$ git ${out.argv.join(" ")}`));
    if (out.stdout.trim()) banner.append(el("label", "go-label", tr("git 输出")), pre(out.stdout.trim().slice(0, 4000)));
    if (out.stderr.trim()) banner.append(el("label", "go-label", tr("原始 stderr")), pre(out.stderr.trim().slice(0, 8000)));
    if (out.code === "auth") banner.append(el("div", "go-note", tr("配置系统 credential helper 后再试；网页不收集账号密码。")));
    if (out.code === "identity") banner.append(el("div", "go-note", tr("先在本机配好 user.name / user.email，网页不代填身份。")));
    const acts = el("div", "go-acts");
    const agent = btn(tr("交给 agent 看这个失败"));
    agent.dataset.agent = "result";
    agent.onclick = () => this.openHandoff(this.branchPrompt(
      this.selectedBranch,
      tr("{p1}：{p2}", { p1: op.title, p2: op.sample }),
      { argv: out.argv, exitCode: out.exitCode, stderr: out.stderr, code: out.code },
    ));
    acts.append(agent);
    if (out.pending) {
      const abort = btn(tr("中止冲突操作"));
      abort.dataset.op = "abort";
      abort.onclick = () => this.openOp("abort");
      const cont = btn(tr("继续冲突操作"));
      cont.dataset.op = "continue";
      cont.onclick = () => this.openConflictContinue();
      acts.append(abort, cont);
    }
    banner.append(acts);
    const card = this.opLayer.firstElementChild as HTMLElement | null;
    const box = card?.querySelector<HTMLElement>("[data-result]") ?? this.opLayer;
    box.replaceChildren(banner);
    if (out.ok && !out.pending) this.say(tr("{p1} 完成 · 已刷新历史与状态行", { p1: op.title }));
    else if (out.pending) this.say(tr("冲突：只放行中止 / 继续 / 交给 agent"), true);
    else this.say(tr("{p1} 失败", { p1: op.title }), true);
    // 冲突文件清单（可点开查看器：这里先列名字，避免再引一层依赖）
    if (out.conflicts.length) {
      const list = el("div", "go-conflicts");
      list.append(el("div", "go-danger-title", tr("冲突文件 · {p1} 个", { p1: out.conflicts.length })));
      for (const p of out.conflicts) list.append(el("div", "go-conflict-row", p));
      box.append(list);
    }
    void params;
  }

  private openConflictContinue(): void {
    const conflicts = this.state?.conflicts ?? [];
    const card = el("div", "go-card go-conflict");
    card.append(this.cardHead(tr("继续冲突操作"), tr("逐个勾完才能继续"), false, "▶"));
    const body = el("div", "go-card-body");
    const list = el("div", "go-conflicts");
    for (const p of conflicts) {
      const label = el("label", "go-file-check");
      const input = el("input") as HTMLInputElement;
      input.type = "checkbox";
      input.dataset.conflict = p;
      label.append(input, el("span", "", p));
      list.append(label);
    }
    if (!conflicts.length) list.append(el("div", "go-note", tr("没有冲突文件")));
    const cont = btn(tr("继续"), "btn primary");
    cont.dataset.continue = "1";
    cont.disabled = conflicts.length > 0;
    const sync = (): void => {
      const left = conflicts.length - [...list.querySelectorAll<HTMLInputElement>("input[data-conflict]:checked")].length;
      cont.disabled = left > 0;
      cont.textContent = left ? tr("还差 {p1} 个文件", { p1: left }) : tr("继续");
    };
    list.onchange = sync;
    cont.onclick = () => void this.runOp(OPS_BY_ID.continue, {});
    const acts = el("div", "go-acts");
    acts.append(cont, this.cancelBtn());
    body.append(list, acts);
    card.append(body);
    this.openCard(card, true);
  }
}
