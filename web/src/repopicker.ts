/**
 * 「评审仓库」选择器：会话目录本身不是仓库时，从它的子目录里挑一个仓库来评。
 *
 * 为什么要有它：会话开在大文件夹（`D:/work`）上是常态，而仓库在下一层（`D:/work/erp/api`）。
 * 以前评审面板遇到这种目录只有一句「这个目录不是 git 仓库，没有东西可评」，人就没路走了。
 *
 * 形态（用户定的样张）：一个紧凑的居中窗 —— 搜索框 + 面包屑 + **一层**目录列表 + 底栏。
 * 一次只列一层，不画无限缩进的树：大文件夹底下动辄几十个子目录，树会把窗口撑爆，而且每展开
 * 一层都是一次 `git rev-parse`（`/api/git/probe` 一次最多 64 个名字）。往下走就是进目录。
 *
 * 仓库徽标来自 `/api/git/probe`：只认「它自己就是仓库根」的子目录（父仓库里的普通目录回 null），
 * 与 #392「目录与仓库」窗判断的是同一件事。
 */
import { api } from "./api.ts";
import { createEl as el } from "./chat.ts";
import { tr } from "./i18n/index.ts";
import { markSurface, pushEscLayer, overlayHost } from "./modal.ts";
import { repoNameOf } from "./review.ts";
import type { GitInfo } from "./types.ts";

export interface RepoPickerOptions {
  /** 从哪个目录开始找（会话目录）。空 = 从盘符列表开始。 */
  start: string;
  /** 已经钉住的那个目录：打开时保持高亮，方便「看看现在选的是谁」。 */
  current?: string;
  /** 用户点了「使用」：交给外面去发 `review.pin`，结果由它们说。 */
  onPick: (dir: string) => void;
  onClose?: () => void;
}

interface Row {
  name: string;
  path: string;
  /** 仓库信息；`undefined` = 还在探，`null` = 探完了，它不是仓库。 */
  info: GitInfo | null | undefined;
}

/** 一层目录的落点：名字 + 绝对路径。`dir` 空（列盘符）时名字本身就是路径。 */
function childPath(dir: string, name: string): string {
  const base = (dir || "").replace(/[\\/]+$/, "");
  if (!base) return name.endsWith(":") ? `${name}/` : name;
  return `${base}/${name}`;
}

/** 长得像路径的输入（有分隔符或盘符）：这种直接当成「用这个目录」，不拿来筛列表。 */
function looksLikePath(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  return /[\\/]/.test(text) || /^[a-zA-Z]:$/.test(text);
}

export class RepoPicker {
  private readonly back: HTMLElement;
  private readonly opts: RepoPickerOptions;
  private readonly input: HTMLInputElement;
  private readonly crumbs: HTMLElement;
  private readonly list: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly useBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private popEsc: (() => void) | null = null;
  onClose: (() => void) | null = null;

  /** 正在列哪一层。 */
  private at: string;
  /** 上一级（桥给的，盘符根是 null）。 */
  private parent: string | null = null;
  private rows: Row[] = [];
  /** 当前这一层自己是不是仓库（底栏「使用」要用）。 */
  private self: GitInfo | null = null;
  private selected = "";
  private query = "";
  private error = "";
  private loading = false;
  /** 每次加载 +1：晚到的旧请求不许盖掉新的（换目录换得快时会撞上）。 */
  private token = 0;

  constructor(opts: RepoPickerOptions) {
    this.opts = opts;
    this.at = (opts.start || "").trim();
    this.back = markSurface(el("div", "sheet-back center rv-back"), "window");

    const sheet = el("section", "st-console repopick");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", tr("选一个仓库"));
    sheet.tabIndex = -1;

    const head = el("header", "rv-sheet-head");
    const headMain = el("div", "rv-sheet-headmain");
    headMain.append(el("h2", "rv-sheet-title", tr("选一个仓库")));
    headMain.append(el("div", "rv-sheet-meta", tr("会话目录不是 git 仓库：从它的子目录里挑一个来评审")));
    const closeBtn = el("button", "btn ghost", tr("取消")) as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.onclick = () => this.close();
    head.append(headMain, closeBtn);

    const body = el("div", "repopick-body");
    const search = el("div", "repopick-search");
    this.input = el("input", "repopick-q") as HTMLInputElement;
    this.input.type = "search";
    this.input.placeholder = tr("筛这一层…（也可以直接输路径后回车）");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.oninput = () => {
      this.query = this.input.value;
      this.paintRows();
      this.syncFoot();
    };
    this.input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.use();
        return;
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        this.step(ev.key === "ArrowDown" ? 1 : -1);
      }
    };
    search.append(this.input);
    this.crumbs = el("div", "repopick-crumbs");
    this.list = el("div", "repopick-list");
    this.list.setAttribute("role", "listbox");
    this.note = el("div", "repopick-note");
    body.append(search, this.crumbs, this.list, this.note);

    const foot = el("div", "repopick-foot");
    this.foot = el("div", "repopick-footinfo");
    this.useBtn = el("button", "btn primary repopick-use") as HTMLButtonElement;
    this.useBtn.type = "button";
    this.useBtn.onclick = () => this.use();
    foot.append(this.foot, this.useBtn);
    body.append(foot);

    sheet.append(head, body);
    this.back.append(sheet);
    if (opts.current) this.selected = opts.current;
  }

  /** 宿主默认交给 `overlayHost()`：控制台是量尺，1:1 挂 body（D450）；测试里仍可显式指定。 */
  mount(parent: HTMLElement = overlayHost(this.back)): void {
    parent.append(this.back);
    this.popEsc = pushEscLayer({ el: this.back, onEsc: () => this.close() });
    void this.load(this.at);
  }

  close(): void {
    this.popEsc?.();
    this.popEsc = null;
    this.back.remove();
    this.onClose?.();
  }

  // -------------------------------------------------------------------------
  // 数据
  // -------------------------------------------------------------------------

  private async load(dir: string): Promise<void> {
    this.token += 1;
    const token = this.token;
    this.at = dir;
    this.rows = [];
    this.parent = null;
    this.self = null;
    this.error = "";
    this.loading = true;
    this.selected = "";
    this.query = "";
    this.input.value = "";
    this.paint();
    try {
      const out = await api.dirs(dir);
      if (token !== this.token) return;
      this.parent = out.parent ?? this.parentOf(dir);
      this.error = out.error ?? "";
      this.rows = (out.dirs ?? []).map((name) => ({ name, path: childPath(dir, name), info: undefined }));
      this.loading = false;
      this.paint();
      void this.probe(dir, token);
      void this.probeSelf(dir, token);
    } catch (err) {
      if (token !== this.token) return;
      this.loading = false;
      this.error = err instanceof Error ? err.message : String(err);
      this.paint();
    }
  }

  /** 这一层每个子目录是不是仓库（一次问完；桥那边一次最多 64 个，多的先不探）。 */
  private async probe(dir: string, token: number): Promise<void> {
    if (!dir || !this.rows.length) return;
    const names = this.rows.slice(0, 64).map((r) => r.name);
    try {
      const out = await api.gitProbe(dir, names);
      if (token !== this.token) return;
      for (const row of this.rows) {
        if (names.includes(row.name)) row.info = out.probes[row.name] ?? null;
      }
    } catch {
      if (token !== this.token) return;
      // 探不动就当成「不知道」：行还能点，能不能用交给桥最后那一步去判。
      for (const row of this.rows) row.info = undefined;
    }
    this.paintRows();
  }

  /** 当前这一层自己是不是仓库：底栏要写「使用 <它>」并点得着。 */
  private async probeSelf(dir: string, token: number): Promise<void> {
    if (!dir) return;
    try {
      const info = await api.git(dir);
      if (token !== this.token) return;
      this.self = info;
    } catch {
      if (token !== this.token) return;
      this.self = null;
    }
    this.paintCrumbs();
    this.syncFoot();
  }

  /** 桥没给 `parent` 时自己算一个（只用来放「..」那一行，盘符根算不出来就不放）。 */
  private parentOf(dir: string): string | null {
    const text = (dir || "").replace(/[\\/]+$/, "");
    if (!text) return null;
    const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    if (cut < 0) return null;
    const head = text.slice(0, cut);
    if (!head || /^[a-zA-Z]:$/.test(head)) return head || null;
    return head;
  }

  // -------------------------------------------------------------------------
  // 画
  // -------------------------------------------------------------------------

  private paint(): void {
    this.paintCrumbs();
    this.paintRows();
    this.syncFoot();
  }

  private paintCrumbs(): void {
    this.crumbs.textContent = "";
    // 面包屑：盘符 / 每一节都点得回去。路径分隔符两种都认（Windows 上两种都有）。
    const text = (this.at || "").replace(/[\\/]+$/, "");
    const parts: { label: string; path: string }[] = [];
    if (text) {
      const segs = text.split(/[\\/]/).filter(Boolean);
      let acc = "";
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        // 盘符那一节要带尾斜杠才是可用的根（`git -C D:` 与 `D:/` 不是一回事）。
        const path = /^[a-zA-Z]:$/.test(acc) ? `${acc}/` : acc;
        parts.push({ label: seg, path });
      }
    }
    for (let i = 0; i < parts.length; i += 1) {
      if (i) this.crumbs.append(el("span", "repopick-sep", "/"));
      const crumb = el("button", "repopick-crumb", parts[i].label) as HTMLButtonElement;
      crumb.type = "button";
      crumb.onclick = () => void this.load(parts[i].path);
      this.crumbs.append(crumb);
    }
    // 这一层自己是仓库时，面包屑末尾直接标出来：省得用户再猜「它算不算」。
    if (this.self) {
      const tag = el("span", "repopick-selftag", tr("本层就是仓库"));
      const bits = [this.self.branch, this.self.dirty ? tr("{p1} 处改动", { p1: this.self.dirty }) : ""].filter(Boolean);
      tag.title = bits.join(" · ");
      this.crumbs.append(tag);
    }
  }

  /** 这一刻筛出来的行：画列表和键盘上下走都认这一份，两处不许各自算。 */
  private matched(): Row[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.rows;
    return this.rows.filter((row) => row.name.toLowerCase().includes(q));
  }

  private paintRows(): void {
    this.list.textContent = "";
    const q = this.query.trim().toLowerCase();
    if (this.loading) {
      this.list.append(el("div", "repopick-empty", tr("读取中…")));
      return;
    }
    if (this.error) {
      this.list.append(el("div", "repopick-empty", this.error));
      return;
    }
    if (this.parent !== null) {
      const up = el("button", "repopick-row repopick-up") as HTMLButtonElement;
      up.type = "button";
      up.append(el("span", "repopick-name", ".."));
      up.onclick = () => void this.load(this.parent ?? "");
      this.list.append(up);
    }
    const shown = this.matched();
    if (!shown.length) {
      this.list.append(el("div", "repopick-empty", q ? tr("这一层没有匹配的目录") : tr("这一层没有子目录")));
      return;
    }
    for (const row of shown) {
      const btn = el("button", "repopick-row") as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.path = row.path;
      if (row.path === this.selected) btn.classList.add("on");
      const mark = el("span", "repopick-dot");
      if (row.info === undefined) mark.classList.add("wait");
      else if (row.info) mark.classList.add("repo");
      btn.append(mark, el("span", "repopick-name", row.name));
      if (row.info) {
        const bits = [row.info.branch || (row.info.detached ? tr("游离 HEAD") : ""), row.info.dirty ? tr("{p1} 处改动", { p1: row.info.dirty }) : ""].filter(Boolean);
        if (bits.length) btn.append(el("span", "repopick-badge", bits.join(" · ")));
      } else if (row.info === null) {
        btn.append(el("span", "repopick-faint", tr("不是仓库")));
      }
      // 点一行：是仓库就选中它；不是仓库就进去找（用户点的意思通常是「看看里面」）。
      btn.onclick = () => {
        if (row.info === null) {
          void this.load(row.path);
          return;
        }
        this.select(row.path);
      };
      const drill = el("button", "repopick-drill", "›") as HTMLButtonElement;
      drill.type = "button";
      drill.title = tr("进入这一层");
      drill.setAttribute("aria-label", tr("进入这一层"));
      drill.onclick = (ev) => {
        ev.stopPropagation();
        void this.load(row.path);
      };
      btn.append(drill);
      this.list.append(btn);
    }
  }

  private syncFoot(): void {
    const q = this.query.trim();
    const target = this.target(q);
    const name = repoNameOf(target) || target;
    this.useBtn.textContent = target ? tr("使用 {p1}", { p1: name }) : tr("使用");
    this.useBtn.disabled = !target;
    this.foot.textContent = "";
    if (this.self) {
      this.foot.append(el("span", "", tr("本层：{p1}", { p1: repoNameOf(this.at) || this.at })));
    }
    if (q && looksLikePath(q)) {
      this.foot.append(el("span", "repopick-hint", tr("回车用这个路径：{p1}", { p1: q })));
    }
  }

  /** 底栏那颗按钮现在会作用在哪个目录。 */
  private target(q = this.query.trim()): string {
    if (q && looksLikePath(q)) return q;
    return this.selected || (this.self ? this.at : "");
  }

  private select(path: string): void {
    this.selected = path;
    this.paintRows();
    this.syncFoot();
  }

  /** 键盘上下移：只在当前筛出来的行之间走，仓库行才停（不是仓库的点下去是「进入」，不是选）。 */
  private step(delta: number): void {
    // 只在这一刻**看得见**的仓库行之间走：拿未筛的行算会选中屏幕上根本不存在的那一条。
    const paths = this.matched().filter((row) => row.info).map((row) => row.path);
    if (!paths.length) return;
    const at = paths.indexOf(this.selected);
    let next = 0;
    if (at < 0) next = delta > 0 ? 0 : paths.length - 1;
    else next = (at + delta + paths.length) % paths.length;
    this.select(paths[next]);
  }

  private use(): void {
    const target = this.target();
    if (!target) return;
    this.opts.onPick(target);
  }
}
