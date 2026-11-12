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
import { api } from "./api.ts";
import { errText, fmtRelative, tr } from "./i18n/index.ts";
import type { GitCommit, GitDiff, GitDiffFile, GitExecResult, GitHistory, GitOpParams, GitRefs, GitWorktreeState } from "./types.ts";
import { GIT_OPS, MANUAL_FILTERS, OPS_BY_ID, OP_GROUPS, opFrames, buildHandoffPrompt, type GitOpDef } from "./git-ops.ts";

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
function btn(text: string, cls = "btn ghost"): HTMLButtonElement {
  const b = el("button", cls, text) as HTMLButtonElement;
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
  /** 复用了 JiraPanel / FailPanel 的两个出口：只填不发，不自动发送。 */
  handoff?: { prefill: (text: string) => void; newSessionWith: (text: string) => void };
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
  private readonly handoff: { prefill: (text: string) => void; newSessionWith: (text: string) => void } | null;
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
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: BranchSheetOptions) {
    this.dir = opts.dir;
    this.fallback = opts.branch;
    this.selectedBranch = opts.branch;
    this.refreshChip = opts.refreshChip ?? null;
    this.handoff = opts.handoff ?? null;
    this.embedded = opts.embedded === true;

    this.root = el("div", "sheet-back center branch-back");
    this.root.onclick = (ev) => { if (ev.target === this.root) this.close(); };
    this.sheet = el("div", "branch-sheet go-sheet");
    this.sheet.classList.toggle("go-embedded", this.embedded);
    this.sheet.setAttribute("role", this.embedded ? "region" : "dialog");
    if (this.embedded) this.sheet.setAttribute("aria-label", tr("分支操作工作台"));
    else this.sheet.setAttribute("aria-modal", "true");
    this.sheet.tabIndex = -1;

    const head = el("div", "branch-head");
    const title = el("div", "branch-title");
    title.append(el("span", "branch-glyph", "⎇"), el("span", "", tr("分支操作工作台")), (this.repoEl = el("span", "branch-repo", shortDir(opts.dir))));
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
    const close = el("button", "branch-x", "✕") as HTMLButtonElement;
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
    tools.append(row, copy, close);
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
      if (!this.opLayer.hidden) this.closeOp();
      else this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    this.sheet.focus();
    void this.load(false);
  }

  close(): void {
    if (this.esc) document.removeEventListener("keydown", this.esc, true);
    if (this.embedded) this.sheet.remove();
    else this.root.remove();
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
    const ticket = ++this.ticket;
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
      const diff = await api.gitDiff(this.dir, this.base, "HEAD", "");
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

  private paint(): void {
    if (!this.data) return;
    this.fetchBtn.hidden = this.data.branches.length === 0;
    this.paintCmp(this.data);
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

    const right = el("div", "bc-end right go-cmp-picker");
    const current = data.base || tr("自动 · 跟随 origin/HEAD");
    const input = el("input", "go-cmp-input") as HTMLInputElement;
    input.type = "text";
    input.value = data.base;
    input.placeholder = tr("搜索分支或输入 ref");
    input.setAttribute("aria-label", tr("对照分支"));
    input.dataset.cmpInput = "1";
    const menu = el("div", "go-cmp-menu");
    menu.hidden = true;
    menu.dataset.cmpMenu = "1";
    const toggle = btn("▾", "btn ghost go-cmp-toggle");
    toggle.dataset.cmpToggle = "1";
    toggle.title = tr("搜索对照分支");
    input.oninput = () => this.paintCmpMenu(menu, input.value);
    input.onfocus = () => this.paintCmpMenu(menu, input.value);
    input.onkeydown = (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this.applyCmp(input.value.trim() || (this.refs?.defaultBase ?? ""));
    };
    toggle.onclick = () => this.paintCmpMenu(menu, input.value, true);
    right.append(input, toggle, menu, el("span", "bc-tag go-cmp-tag", current));

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

  /** 候选 = 自动 + 本地/远程两组；输入是子串检索，也能直接回车用任意 ref。 */
  private paintCmpMenu(menu: HTMLElement, query: string, forceOpen = false): void {
    if (forceOpen && !menu.hidden) { menu.hidden = true; return; }
    menu.hidden = false;
    const q = query.trim().toLowerCase();
    const all = [
      { name: "", label: tr("自动 · 跟随 origin/HEAD"), group: tr("自动") },
      ...(this.refs?.groups.flatMap((g) => g.refs.map((r) => ({ name: r.name, label: r.name, group: tr(g.name) }))) ?? []),
      ...this.data?.branches.filter((b) => !(this.refs?.groups.some((g) => g.refs.some((r) => r.name === b.name)))).map((b) => ({ name: b.name, label: b.name, group: tr("历史") })) ?? [],
    ];
    const hit = all.filter((r) => !q || r.label.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
    const list = el("div", "go-cmp-list");
    for (const r of hit) {
      const b = btn(`${r.label} · ${r.group}`, "go-cmp-pick");
      b.dataset.cmpPick = r.name;
      b.classList.toggle("on", r.name === this.base);
      b.onclick = () => this.applyCmp(r.name);
      list.append(b);
    }
    const use = btn(tr("用输入的 ref 对照：{p1}", { p1: query.trim() || "…" }), "go-cmp-use");
    use.dataset.cmpUse = "1";
    use.onclick = () => this.applyCmp(query.trim());
    menu.replaceChildren(list, use);
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

  private paintHistory(): void {
    const data = this.data;
    if (!data) return;
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
    const ai = btn(tr("✎ 选分支 + 写要求 → 交给 AI 操作"), "btn ghost go-side-cta go-side-ai");
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
    const row = el("div", `bc-row ${commit.set === "common" ? "common" : commit.set === "left" ? "only" : "onlyR"}`);
    row.dataset.h = commit.h;
    row.title = `${commit.h} · ${commit.an} · ${fmtRelative(commit.at)}\n${commit.s}`;
    const subject = el("span", "bc-s");
    if (commit.merge) subject.append(el("span", "bc-badge", "merge"));
    subject.append(document.createTextNode(commit.s));
    row.append(el("span", "bc-h", commit.h), subject, el("span", "bc-meta", `${commit.an} · ${fmtRelative(commit.at)}`));
    row.classList.toggle("right", side === "right");
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
    list.append(el("div", "go-side-title", tr("变更文件 · 当前分支 vs {p1}", { p1: this.diff.base })));
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

  private fileDetail(f: GitDiffFile): HTMLElement {
    const box = el("div", "go-file");
    box.append(el("div", "go-file-head", `${f.path} · ${tr(f.kind)} · +${f.additions} −${f.deletions}`));
    if (f.kind === "image" && f.images) {
      const pair = el("div", "go-img-pair");
      for (const [cap, src] of [[tr("对照 · {p1}", { p1: this.diff?.base ?? "" }), f.images.base], [tr("当前 · {p1}", { p1: this.data?.head ?? "" }), f.images.target]] as const) {
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
      for (const line of f.lines) {
        const l = el("div", `go-code ${line.tag}`, line.left);
        const r = el("div", `go-code ${line.tag}`, line.right);
        grid.append(l, r);
      }
      box.append(grid);
      if (f.truncated) box.append(el("div", "go-trunc", tr("大文件已截断：只显示前 {p1} 行 / {p2} KB", { p1: this.diff?.limit.lines ?? 200, p2: Math.round((this.diff?.limit.bytes ?? 409600) / 1024) })));
      if (f.note) box.append(el("div", "go-note", f.note));
    } else {
      box.append(el("div", "go-ph", tr("非文本占位：{p1}", { p1: tr(f.kind) })));
      if (f.note) box.append(el("div", "go-note", f.note));
    }
    return box;
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
    this.opLayer.hidden = true;
    this.opLayer.replaceChildren();
    this.sheet.focus();
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
    const branch = el("select", "go-select") as HTMLSelectElement;
    const names = this.refs?.groups.flatMap((g) => g.refs.map((r) => r.name)) ?? [this.selectedBranch];
    for (const n of [...new Set([this.selectedBranch, ...names])]) {
      const o = el("option") as HTMLOptionElement;
      o.value = n;
      o.textContent = n;
      o.selected = n === this.selectedBranch;
      branch.append(o);
    }
    const req = el("textarea", "go-textarea") as HTMLTextAreaElement;
    req.rows = 3;
    req.placeholder = tr("输入你的要求，例如：判断该切到 main 还是先合并，别直接动 git");
    const preview = pre("");
    const sync = (): void => { preview.textContent = this.branchPrompt(branch.value, req.value); };
    branch.onchange = sync;
    req.oninput = sync;
    sync();
    body.append(
      el("label", "go-label", tr("① 选一条分支")), branch,
      el("label", "go-label", tr("② 输入要求")), req,
      el("label", "go-label", tr("提示词预览")), preview,
      el("div", "go-note", tr("新会话并预填 / 预填到当前会话都只填不发；复用输入框的 prefill() 与 newSessionWith()。")),
    );
    const acts = el("div", "go-acts");
    const goNew = btn(tr("新会话并预填"), "btn primary");
    goNew.dataset.aiGo = "new";
    goNew.onclick = () => this.handoffGo(preview.textContent ?? "", true);
    const goCur = btn(tr("预填到当前会话"));
    goCur.dataset.aiGo = "current";
    goCur.onclick = () => this.handoffGo(preview.textContent ?? "", false);
    acts.append(goNew, goCur, this.cancelBtn());
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  private branchPrompt(branch = this.selectedBranch, requirement = ""): string {
    const refs = this.refs?.groups.flatMap((g) => g.refs.map((r) => r.name)) ?? this.data?.branches.map((b) => b.name) ?? [];
    return buildHandoffPrompt({
      repo: this.data?.repo ?? this.dir,
      branch: this.state?.branch ?? this.fallback,
      selected: branch,
      ahead: this.data?.ahead,
      behind: this.data?.behind,
      dirty: this.state?.dirty,
      refs,
      requirement,
    });
  }

  private openHandoff(prompt: string): void {
    const card = el("div", "go-card go-handoff");
    card.append(this.cardHead(tr("交给 agent"), tr("只填进输入框，不自动发送"), false, ""));
    const body = el("div", "go-card-body");
    const box = pre(prompt);
    body.append(box, el("div", "go-note", tr("新会话并预填 / 预填到当前会话都只填不发；复用输入框的 prefill() 与 newSessionWith()。")));
    const acts = el("div", "go-acts");
    const goNew = btn(tr("新会话并预填"), "btn primary");
    goNew.dataset.aiGo = "new";
    goNew.onclick = () => this.handoffGo(prompt, true);
    const goCur = btn(tr("预填到当前会话"));
    goCur.dataset.aiGo = "current";
    goCur.onclick = () => this.handoffGo(prompt, false);
    acts.append(goNew, goCur, this.cancelBtn());
    body.append(acts);
    card.append(body);
    this.openCard(card, true);
  }

  private handoffGo(prompt: string, newSession: boolean): void {
    if (!this.handoff) { this.say(tr("这个面板没接上输入框，提示词已留在卡里"), true); return; }
    if (newSession) this.handoff.newSessionWith(prompt);
    else this.handoff.prefill(prompt);
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
    const x = btn("✕", "go-card-x");
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

  private openOp(id: string): void {
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
    const banner = el("div", out.ok && !out.pending ? "go-result-card ok" : out.pending ? "go-result-card warn" : "go-result-card bad");
    const title = out.ok && !out.pending ? tr("执行成功 · 已刷新")
      : out.pending ? tr("仓库停在冲突状态") : tr("执行失败 · exit {p1}", { p1: out.exitCode });
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
    agent.onclick = () => this.openHandoff(this.branchPrompt(this.selectedBranch, tr("{p1}：{p2}", { p1: op.title, p2: op.sample })) + "\n\n" + buildHandoffPrompt({
      repo: this.data?.repo ?? this.dir, branch: this.state?.branch ?? this.fallback,
      failure: { argv: out.argv, exitCode: out.exitCode, stderr: out.stderr, code: out.code },
    }));
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
