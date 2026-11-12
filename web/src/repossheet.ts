/**
 * #392「目录与仓库」：会话 cwd 不是 git 仓库时，左下角路径 chip 点开的窗。
 *
 * 一个伞形目录（`erp/`）里常有 api、ui 这些各自是仓库的子项目，而状态行只认识 cwd 所在的那个仓库，
 * 所以非仓库 cwd 连 ⎇ chip 都没有。这扇窗把「目录树 → 子仓库 → 分支操作」接起来：
 * - 左：目录树。展开一层才批量探测直接子目录，只有 `rev-parse --show-toplevel` 正好是自己时才标仓库。
 * - 中：仓库列。树里滚过的仓库攒成卡片，点卡片等于选中它。
 * - 右：分支操作面板（复用 BranchSheet 的 embedded 模式，动词 / 操作卡 / 交给 AI 全不变）。
 *
 * 写操作与仓库数据只在本机回环可用（桥端同 D235 的闸）；隧道里树没有标记、面板会报错，这是有意的。
 */
import { createEl as el } from "./chat.ts";
import { api } from "./api.ts";
import { errText, tr } from "./i18n/index.ts";
import { BranchSheet } from "./branchsheet.ts";
import { cleanPath, isAbsolutePath, resolveTyped } from "./dirpicker.ts";
import type { GitInfo } from "./types.ts";

/** 每扇窗按 cwd 记一份位置；展开节点太多时只留最近这些，免得 localStorage 长草。 */
const KEY = "pi.reposSheet";
const EXPANDED_MAX = 40;
const SAVED_MAX = 12;
/** 桥端 `probeChildren` 的默认上限；界面只用来提示「这一层没探完」。 */
const PROBE_CAP = 64;

interface Saved {
  root: string;
  selected: string;
  expanded: string[];
  folded: { tree: boolean; rail: boolean };
}

type SavedMap = Record<string, Saved>;

/** 桥端给的 repo 一律正斜杠；界面里也统一成这个形状，比较 / 拼接才不会一半反斜杠一半正斜杠。 */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function samePath(a: string, b: string): boolean {
  const x = norm(a).replace(/\/+$/, "");
  const y = norm(b).replace(/\/+$/, "");
  // 浏览器里没有 process.platform：按盘符判断是不是 Windows 路径。
  return /^[a-z]:\//i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function parentOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut <= 0 ? norm : norm.slice(0, cut);
}

function nameOf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut < 0 ? norm : norm.slice(cut + 1);
}

function shortPath(p: string, max = 46): string {
  return p.length > max ? `…${p.slice(-(max - 1))}` : p;
}

export interface ReposSheetOptions {
  /** 会话的 cwd：窗打开时从这里起步。 */
  cwd: string;
  /** 写成功后让状态行 chip 与这扇窗一起刷新。 */
  refreshChip?: () => void;
  handoff?: { prefill: (text: string) => void; newSessionWith: (text: string) => void };
}

export class ReposSheet {
  private readonly cwd: string;
  private readonly refreshChip: (() => void) | null;
  private readonly handoff: ReposSheetOptions["handoff"] | null;

  private readonly root: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly body: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly crumbEl: HTMLElement;
  private readonly treeCol: HTMLElement;
  private readonly treeList: HTMLElement;
  private readonly pathInput: HTMLInputElement;
  private readonly railCol: HTMLElement;
  private readonly railList: HTMLElement;
  private readonly railNote: HTMLElement;
  private readonly panelHost: HTMLElement;
  private readonly emptyPane: HTMLElement;
  private readonly emptyText: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly drawerBtn: HTMLButtonElement;

  private panel: BranchSheet | null = null;
  private panelDir = "";

  private rootDir = "";
  private selected = "";
  private readonly expanded = new Set<string>();
  private readonly childDirs = new Map<string, string[]>();
  private readonly probes = new Map<string, Record<string, GitInfo | null>>();
  private readonly loading = new Set<string>();
  private readonly truncated = new Set<string>();
  /** 每个目录已经探测到第几个名字：截断后用「继续探测」接着往后走，不从头重探。 */
  private readonly probedCount = new Map<string, number>();
  private readonly repos = new Map<string, GitInfo>();
  private selfInfo: GitInfo | null = null;
  private probeError = false;
  private drawerOpen = false;
  private folded = { tree: false, rail: false };
  private booted = false;
  private esc: ((ev: KeyboardEvent) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(opts: ReposSheetOptions) {
    this.cwd = opts.cwd;
    this.refreshChip = opts.refreshChip ?? null;
    this.handoff = opts.handoff ?? null;

    this.root = el("div", "sheet-back center repos-back");
    this.root.onclick = (ev) => {
      if (ev.target === this.root) this.close();
    };
    this.sheet = el("div", "repos-sheet");
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("aria-label", tr("目录与仓库"));
    this.sheet.tabIndex = -1;

    const head = el("div", "repos-head");
    const titles = el("div", "repos-titles");
    this.subEl = el("div", "repos-sub", shortPath(opts.cwd));
    this.subEl.title = opts.cwd;
    titles.append(el("div", "repos-title", tr("目录与仓库")), this.subEl);
    this.crumbEl = el("div", "repos-crumb");
    const actions = el("div", "repos-actions");
    this.drawerBtn = el("button", "btn ghost repos-drawerbtn", tr("目录")) as HTMLButtonElement;
    this.drawerBtn.type = "button";
    this.drawerBtn.onclick = () => {
      this.drawerOpen = !this.drawerOpen;
      this.paintDrawer();
    };
    const copy = el("button", "btn ghost repos-copy", tr("复制路径")) as HTMLButtonElement;
    copy.type = "button";
    copy.onclick = () => void this.copyPath(copy);
    const close = el("button", "repos-x", "✕") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", tr("关闭"));
    close.title = tr("Esc 关闭");
    close.onclick = () => this.close();
    actions.append(this.drawerBtn, copy, close);
    head.append(titles, this.crumbEl, actions);

    this.body = el("div", "repos-body");

    this.treeCol = el("div", "repos-col repos-tree");
    const treeTop = el("div", "repos-tree-top");
    const up = el("button", "btn ghost repos-up", "↑") as HTMLButtonElement;
    up.type = "button";
    up.title = tr("上级目录");
    up.onclick = () => void this.openRoot(parentOf(this.rootDir));
    this.pathInput = el("input", "repos-path") as HTMLInputElement;
    this.pathInput.type = "text";
    this.pathInput.spellcheck = false;
    this.pathInput.placeholder = tr("输入路径后回车");
    this.pathInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void this.gotoTyped();
      }
    });
    const foldTree = el("button", "btn ghost repos-fold", "«") as HTMLButtonElement;
    foldTree.type = "button";
    foldTree.title = tr("折叠这一列");
    foldTree.onclick = () => this.foldCol("tree");
    treeTop.append(up, this.pathInput, foldTree);
    this.treeList = el("div", "repos-tree-list");
    this.treeCol.append(treeTop, this.treeList);

    this.railCol = el("div", "repos-col repos-rail");
    const railHead = el("div", "repos-rail-head");
    railHead.append(el("span", "repos-rail-title", tr("仓库")), el("span", "grow"));
    const foldRail = el("button", "btn ghost repos-fold", "«") as HTMLButtonElement;
    foldRail.type = "button";
    foldRail.title = tr("折叠这一列");
    foldRail.onclick = () => this.foldCol("rail");
    railHead.append(foldRail);
    this.railList = el("div", "repos-rail-list");
    this.railNote = el("div", "repos-rail-note");
    this.railCol.append(railHead, this.railList, this.railNote);

    this.emptyText = el("div", "repos-empty-text", tr("在左边选一个目录"));
    this.emptyHint = el("div", "repos-empty-hint");
    this.emptyHint.hidden = true;
    this.emptyPane = el("div", "repos-empty");
    this.emptyPane.append(this.emptyText, this.emptyHint);
    this.panelHost = el("div", "repos-panel");
    this.panelHost.append(this.emptyPane);

    const foot = el("div", "repos-foot");
    this.hintEl = el("span", "repos-hint");
    foot.append(this.hintEl, el("span", "grow"), el("span", "repos-esc", tr("Esc 关闭")));

    this.sheet.append(head, this.body, foot);
    this.root.append(this.sheet);
    this.paintBody();
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root);
    this.esc = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      // 层叠：操作卡 / 分支浮层 → 目录抽屉 → 窗口。
      if (this.panel?.closeLayer()) {
        return;
      }
      if (this.drawerOpen) {
        this.drawerOpen = false;
        this.paintDrawer();
        return;
      }
      this.close();
    };
    document.addEventListener("keydown", this.esc, true);
    this.sheet.focus();
    void this.boot();
  }

  close(): void {
    if (this.esc) {
      document.removeEventListener("keydown", this.esc, true);
    }
    this.panel?.close();
    this.panel = null;
    this.root.remove();
    this.onClose?.();
  }

  // ---------------------------------------------------------------- 持久化

  private readSaved(): Saved | null {
    try {
      const all = JSON.parse(localStorage.getItem(KEY) ?? "null") as SavedMap | null;
      const hit = all?.[this.cwd];
      if (!hit || typeof hit.root !== "string" || !Array.isArray(hit.expanded)) return null;
      return hit;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.booted || !this.rootDir) return;
    try {
      const all = (JSON.parse(localStorage.getItem(KEY) ?? "null") as SavedMap | null) ?? {};
      all[this.cwd] = {
        root: this.rootDir,
        selected: this.selected,
        expanded: [...this.expanded].slice(0, EXPANDED_MAX),
        folded: { ...this.folded },
      };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - SAVED_MAX))) delete all[k];
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // 隐私模式 / 配额满：位置记不住不算故障。
    }
  }

  // ---------------------------------------------------------------- 载入

  private async boot(): Promise<void> {
    const saved = this.readSaved();
    this.rootDir = norm(saved?.root || this.cwd);
    this.folded = saved?.folded ?? this.folded;
    this.pathInput.value = this.rootDir;
    this.subEl.textContent = shortPath(this.rootDir);
    this.subEl.title = this.rootDir;
    this.booted = true;
    await this.expand(this.rootDir, true);
    const wanted = (saved?.expanded ?? []).filter((d) => d !== this.rootDir && this.inside(d));
    for (const dir of wanted) {
      if (this.expanded.size > EXPANDED_MAX) break;
      await this.expand(dir, true);
    }
    const pick = saved?.selected ?? "";
    if (pick) {
      const stat = await api.statPath(pick).catch(() => null);
      if (stat?.kind === "dir") this.select(pick);
      else this.render();
    } else this.render();
  }

  private inside(dir: string): boolean {
    const root = this.rootDir.replace(/[\\/]+$/, "").toLowerCase();
    const d = dir.replace(/[\\/]+$/, "").toLowerCase();
    return d === root || d.startsWith(`${root}/`) || d.startsWith(`${root}\\`);
  }

  /** 展开一层：列目录 + 批量探测直接子目录；数据缓存到本次打开为止。 */
  private async expand(dir: string, quiet = false): Promise<void> {
    this.expanded.add(dir);
    if (this.childDirs.has(dir) || this.loading.has(dir)) {
      if (!quiet) this.render();
      return;
    }
    this.loading.add(dir);
    if (!quiet) this.render();
    try {
      if (samePath(dir, this.rootDir)) {
        const self = await api.git(dir).catch(() => null);
        this.selfInfo = self?.repo && samePath(self.repo, dir) ? self : null;
        if (this.selfInfo) this.repos.set(this.selfInfo.repo, this.selfInfo);
      }
      const list = await api.dirs(dir);
      // spec：只列目录，点开头与 node_modules 不进树（依赖目录里可能有几十个仓库）。
      const names = list.dirs.filter((name) => !name.startsWith(".") && name !== "node_modules");
      this.childDirs.set(dir, names);
      if (names.length) {
        const from = this.probedCount.get(dir) ?? 0;
        const slice = names.slice(from, from + PROBE_CAP);
        const batch = await api.gitProbe(dir, slice);
        this.probes.set(dir, { ...(this.probes.get(dir) ?? {}), ...batch.probes });
        this.probedCount.set(dir, from + slice.length);
        if (from + slice.length < names.length) this.truncated.add(dir);
        else this.truncated.delete(dir);
        for (const name of slice) {
          const info = batch.probes[name];
          if (info?.repo) this.repos.set(info.repo, info);
        }
      } else this.probes.set(dir, {});
    } catch (err) {
      this.childDirs.set(dir, []);
      this.probeError = true;
      this.say(errText(err));
    } finally {
      this.loading.delete(dir);
    }
    this.render();
  }

  /** 一层超过上限时，接着往后探测下一批（只追加，不重头扫）。 */
  private async probeMore(dir: string): Promise<void> {
    const names = this.childDirs.get(dir) ?? [];
    const from = this.probedCount.get(dir) ?? names.length;
    const slice = names.slice(from, from + PROBE_CAP);
    if (!slice.length) {
      this.truncated.delete(dir);
      this.render();
      return;
    }
    try {
      const batch = await api.gitProbe(dir, slice);
      this.probes.set(dir, { ...(this.probes.get(dir) ?? {}), ...batch.probes });
      this.probedCount.set(dir, from + slice.length);
      if (from + slice.length >= names.length) this.truncated.delete(dir);
      for (const name of slice) {
        const info = batch.probes[name];
        if (info?.repo) this.repos.set(info.repo, info);
      }
      this.probeError = false;
    } catch {
      this.probeError = true;
    }
    this.render();
  }

  private async openRoot(input: string): Promise<void> {
    const dir = norm(input);
    if (!dir || dir === this.rootDir) return;
    this.rootDir = dir;
    this.selected = "";
    this.expanded.clear();
    this.childDirs.clear();
    this.probes.clear();
    this.truncated.clear();
    this.probedCount.clear();
    this.repos.clear();
    this.probeError = false;
    this.pathInput.value = dir;
    this.subEl.textContent = shortPath(dir);
    this.subEl.title = dir;
    this.say("");
    this.panelDir = "";
    this.panelHost.hidden = true;
    this.emptyPane.hidden = false;
    this.emptyText.textContent = tr("在左边选一个目录");
    this.emptyHint.hidden = true;
    this.crumbEl.replaceChildren();
    await this.expand(dir);
    this.save();
  }

  private async gotoTyped(): Promise<void> {
    const raw = cleanPath(this.pathInput.value);
    if (!raw) return;
    const abs = isAbsolutePath(raw) ? raw : resolveTyped(raw, this.rootDir);
    const stat = await api.statPath(abs).catch(() => null);
    if (!stat || stat.kind === "missing") {
      this.say(tr("这个路径不存在"));
      return;
    }
    if (stat.kind === "file") {
      await this.openRoot(stat.parent ?? parentOf(abs));
      return;
    }
    if (stat.kind === "denied") {
      this.say(tr("读不了这个目录"));
      return;
    }
    await this.openRoot(stat.path);
  }

  // ---------------------------------------------------------------- 选中与面板

  private infoOf(dir: string): GitInfo | null {
    if (dir === this.rootDir) return this.selfInfo;
    return this.probes.get(parentOf(dir))?.[nameOf(dir)] ?? null;
  }

  private select(dir: string): void {
    this.selected = dir;
    this.drawerOpen = false;
    const info = this.infoOf(dir);
    if (!info) {
      this.panelHost.hidden = true;
      this.emptyPane.hidden = false;
      this.emptyText.textContent = tr("这个目录不是 git 仓库");
      // spec：若它的直接子目录里有仓库，提示往下看一眼（树里已有标记）。
      const kids = Object.values(this.probes.get(dir) ?? {}).some((x) => Boolean(x));
      this.emptyHint.hidden = !kids;
      this.emptyHint.textContent = kids ? tr("直接子目录里有仓库，展开看看") : "";
      this.crumbEl.replaceChildren();
      this.render();
      this.save();
      return;
    }
    this.emptyHint.hidden = true;
    this.panelHost.hidden = false;
    this.emptyPane.hidden = true;
    this.paintCrumb(info);
    if (!this.panel) {
      this.panel = new BranchSheet({
        dir: info.repo,
        branch: info.branch,
        embedded: true,
        refreshChip: () => {
          this.refreshChip?.();
          void this.refreshTree();
        },
        handoff: this.handoff ?? undefined,
      });
      this.panel.mount(this.panelHost);
      this.panelDir = info.repo;
    } else if (this.panelDir !== info.repo) {
      this.panelDir = info.repo;
      this.panel.setDir(info.repo, info.branch);
    }
    this.render();
    this.save();
  }

  private paintCrumb(info: GitInfo): void {
    this.crumbEl.replaceChildren();
    const path = el("span", "repos-crumb-path", shortPath(info.repo, 58));
    path.title = info.repo;
    this.crumbEl.append(path);
    const branch = el("span", "repos-crumb-branch");
    branch.append(el("span", "branch-glyph", "⎇"), el("span", "", info.branch || tr("(无提交)")));
    this.crumbEl.append(branch);
    if (info.dirty) this.crumbEl.append(el("span", "repos-crumb-dirty", tr("{p1} 个改动", { p1: info.dirty })));
    if (info.detached) this.crumbEl.append(el("span", "repos-crumb-tag", "detached"));
    if (this.selected !== info.repo) this.crumbEl.append(el("span", "repos-crumb-sub", tr("选中：{p1}", { p1: nameOf(this.selected) })));
  }

  /** 写操作之后：根目录的分支/dirty 与已展开层的仓库标记都要重新读一遍。 */
  private async refreshTree(): Promise<void> {
    try {
      const self = this.rootDir ? await api.git(this.rootDir, true).catch(() => null) : null;
      this.selfInfo = self?.repo && samePath(self.repo, this.rootDir) ? self : null;
      if (this.selfInfo) this.repos.set(this.selfInfo.repo, this.selfInfo);
      for (const dir of this.expanded) {
        const names = this.childDirs.get(dir) ?? [];
        if (!names.length) continue;
        // 已探测过几批就刷几批（只重读探过的，不把截断后的全量一次拉回来）。
        const upTo = this.probedCount.get(dir) ?? PROBE_CAP;
        const batch = await api.gitProbe(dir, names.slice(0, upTo), true);
        this.probes.set(dir, { ...(this.probes.get(dir) ?? {}), ...batch.probes });
        for (const name of names.slice(0, upTo)) {
          const info = batch.probes[name];
          if (info?.repo) this.repos.set(info.repo, info);
        }
      }
      this.render();
      if (this.selected) {
        const info = this.infoOf(this.selected);
        if (info) this.paintCrumb(info);
      }
    } catch {
      // 刷新失败保持旧标记：下一轮展开或重开窗会再读。
    }
  }

  // ---------------------------------------------------------------- 绘制

  private paintBody(): void {
    const strips: HTMLElement[] = [];
    if (this.folded.tree) strips.push(this.strip("tree", tr("目录"), ""));
    else strips.push(this.treeCol);
    if (this.folded.rail) strips.push(this.strip("rail", tr("仓库"), String(this.repos.size)));
    else strips.push(this.railCol);
    strips.push(this.panelHost);
    this.body.replaceChildren(...strips);
    // 用变量而不是 inline grid-template-columns：窄屏要靠媒体查询改成单列，inline 会压过 CSS。
    this.body.style.setProperty("--rw-tree", this.folded.tree ? "26px" : "224px");
    this.body.style.setProperty("--rw-rail", this.folded.rail ? "26px" : "214px");
    this.paintDrawer();
  }

  private strip(col: "tree" | "rail", label: string, count: string): HTMLElement {
    const b = el("button", `repos-strip repos-strip-${col}`) as HTMLButtonElement;
    b.type = "button";
    b.dataset.unfold = col;
    b.title = tr("展开这一列");
    b.append(el("span", "repos-strip-caret", "▸"), el("span", "repos-strip-label", label));
    if (count) b.append(el("span", "repos-strip-count", count));
    b.onclick = () => {
      this.folded[col] = false;
      this.render();
      this.save();
    };
    return b;
  }

  private foldCol(col: "tree" | "rail"): void {
    this.folded[col] = true;
    this.render();
    this.save();
  }

  private paintDrawer(): void {
    this.body.classList.toggle("drawer-open", this.drawerOpen);
    this.drawerBtn.classList.toggle("on", this.drawerOpen);
  }

  private render(): void {
    this.paintBody();
    this.renderTree();
    this.renderRail();
    this.sheet.classList.toggle("booted", this.booted);
  }

  private renderTree(): void {
    this.treeList.replaceChildren();
    this.treeList.append(this.rowEl(this.rootDir, 0, true));
    const walk = (dir: string, depth: number): void => {
      if (!this.expanded.has(dir)) return;
      for (const name of this.childDirs.get(dir) ?? []) {
        const child = `${norm(dir).replace(/\/+$/, "")}/${name}`;
        this.treeList.append(this.rowEl(child, depth + 1, false));
        walk(child, depth + 1);
      }
      // spec：超上限时明说「还有 N 个没探测」，点一下接着探（不重头扫）。
      if (this.truncated.has(dir)) {
        const left = (this.childDirs.get(dir)?.length ?? 0) - (this.probedCount.get(dir) ?? 0);
        const more = el("button", "repos-more") as HTMLButtonElement;
        more.type = "button";
        more.textContent = tr("这一层还有 {p1} 个目录没探测", { p1: left });
        more.style.paddingLeft = `${22 + depth * 14}px`;
        more.onclick = (ev) => {
          ev.stopPropagation();
          void this.probeMore(dir);
        };
        this.treeList.append(more);
      }
    };
    walk(this.rootDir, 0);
  }

  private rowEl(dir: string, depth: number, isRoot: boolean): HTMLElement {
    const row = el("button", "repos-row") as HTMLButtonElement;
    row.type = "button";
    row.dataset.dir = dir;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const info = this.infoOf(dir);
    const hasKids = this.childDirs.get(dir)?.length ? true : !this.childDirs.has(dir);
    const open = this.expanded.has(dir);
    let glyph = "·";
    if (open) glyph = "▾";
    else if (hasKids) glyph = "▸";
    const caret = el("span", `repos-caret${open ? " open" : ""}${hasKids ? "" : " leaf"}`, glyph);
    row.append(caret);
    const name = el("span", "repos-name", isRoot ? nameOf(dir) || dir : nameOf(dir));
    row.append(name);
    if (this.loading.has(dir)) row.append(el("span", "repos-thinking", "…"));
    if (info) {
      const git = el("span", "repos-git");
      git.append(el("span", "branch-glyph", "⎇"), el("span", "repos-branch", info.branch || tr("(无提交)")));
      if (info.dirty) git.append(el("span", "repos-dot", ""), el("span", "repos-dirty", String(info.dirty)));
      row.append(git);
    }
    row.classList.toggle("on", this.selected === dir);
    row.classList.toggle("repo", Boolean(info));
    row.title = info?.repo ?? dir;
    row.onclick = (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest(".repos-caret")) {
        if (open) this.expanded.delete(dir);
        else void this.expand(dir);
        this.render();
        this.save();
        return;
      }
      this.select(dir);
      if (window.matchMedia("(max-width: 860px)").matches) {
        this.drawerOpen = false;
        this.paintDrawer();
      }
    };
    return row;
  }

  private renderRail(): void {
    this.railList.replaceChildren();
    const list = [...this.repos.values()].sort((a, b) => a.repo.localeCompare(b.repo));
    for (const info of list) {
      const card = el("button", "repos-card") as HTMLButtonElement;
      card.type = "button";
      card.dataset.repo = info.repo;
      card.classList.toggle("on", this.selected === info.repo || this.selected.startsWith(`${info.repo}/`) || this.selected.startsWith(`${info.repo}\\`));
      const top = el("div", "repos-card-top");
      top.append(el("span", "repos-card-name", nameOf(info.repo) || info.repo));
      if (info.dirty) top.append(el("span", "repos-card-dot", ""), el("span", "repos-card-dirty", String(info.dirty)));
      const line = el("div", "repos-card-branch");
      line.append(el("span", "branch-glyph", "⎇"), el("span", "", info.branch || tr("(无提交)")));
      if (info.detached) line.append(el("span", "repos-crumb-tag", "detached"));
      if (info.empty) line.append(el("span", "repos-crumb-tag", tr("空仓库")));
      card.append(top, line);
      card.title = info.repo;
      card.onclick = () => this.select(info.repo);
      this.railList.append(card);
    }
    if (!list.length) this.railList.append(el("div", "repos-rail-empty", tr("展开目录后，这里是找到的仓库")));
    this.railNote.textContent = this.probeError ? tr("读不到仓库标记：可能是在隧道/公网访问") : "";
    this.railNote.hidden = !this.probeError;
  }

  private say(text: string): void {
    this.hintEl.textContent = text;
  }

  private async copyPath(button: HTMLElement): Promise<void> {
    const text = this.selected || this.rootDir || this.cwd;
    const copy = navigator.clipboard?.writeText(text);
    if (!copy) return;
    const back = button.textContent ?? tr("复制路径");
    void copy
      .then(() => {
        button.textContent = tr("已复制");
        setTimeout(() => {
          if (button.isConnected && button.textContent === tr("已复制")) button.textContent = back;
        }, 900);
      })
      .catch(() => {});
  }
}
