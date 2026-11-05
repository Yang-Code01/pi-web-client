/**
 * 表格浮窗（D127）：不是 viewer 面板、没有遮罩、不抢焦点，层级与终端并列。
 *
 * 几何按界面缩放归一（布局 px）后记在 localStorage 的 `pi.sheetGeom`；
 * 拖标题栏移动、拖右下角改宽高、拖顶边只改高、双击复原、打开时 clamp 回可视区。
 */
import { tr, errText, fmtTime } from "../i18n/index.ts";
import type { SheetInfo, SheetMatches, SheetMeta, SheetTier, SheetWindow } from "../types.ts";
import { clampNum, dragFloat, measureFloat, pinFloat, type FloatBox } from "../floatwin.ts";
import { SheetGrid, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "./grid.ts";

const KEY = "pi.sheetGeom";
const MIN_W = 420;
const MIN_H = 260;

type Tab = "grid" | "source";

/** CSV 的源码面：改完交给外面保存（#113）。有它才出「表格 / 源码」两个 tab。 */
export interface SheetSource {
  text: string;
  /** 截断 / 超大时的说明，放在底栏。 */
  note?: string;
  /** 没有就不给保存（截断的文件只读）。 */
  onSave?: (text: string) => Promise<void>;
}

export interface SheetDialogOpts {
  token: string;
  name: string;
  path: string;
  /** 原文件的裸地址（`/raw/<token>/<rel>`）：下载不经过任何接口。 */
  raw: string;
  scale: () => number;
  loadMeta: () => Promise<SheetMeta>;
  fetchWindow: (sheet: string, r0: number, r1: number, c0: number, c1: number) => Promise<SheetWindow>;
  /** #113：CSV 的源码面（有它才出「表格 / 源码」两个 tab）。 */
  source?: SheetSource;
  /** #107：整表查找。前端手里只有可视窗口，所以整表扫描只能落在桥端；不给就不出查找入口。 */
  findSheet?: (sheet: string, q: string) => Promise<SheetMatches>;
  /** #107：把「文件路径 + A1:C9」交给对话框（只插入，不发送）。 */
  onQuote?: (text: string) => void;
  /** #106 出口：交给这台电脑上的默认程序打开原文件。 */
  onOpen: () => Promise<void>;
  onReveal: () => Promise<void>;
  /** 文件被改过之后重新开一趟（要新的凭据，所以由 app 重走 /api/preview）。 */
  onReopen: () => void;
  onClose: () => void;
  onRaise: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** #107：拿数档位的中文标签（`tr` 在使用处，别把译文交给这里的表）。 */
function tierLabel(tier: SheetTier | undefined): string {
  if (tier === "values") return tr("只读值");
  if (tier === "none") return tr("仅清单");
  return tr("全量");
}

export class SheetDialog {
  readonly root: HTMLElement;
  private readonly opts: SheetDialogOpts;
  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly footBar: HTMLElement;
  /** #108：底部的工作表标签与「N 个隐藏工作表」提示（`.sd-tab` 是 CSV 的表格/源码，别混）。 */
  private readonly wsTabs: HTMLElement;
  private readonly wsHint: HTMLElement;
  /** #109：认不出的条件格式规则计数。 */
  private readonly cfHint: HTMLElement;
  /** #111：选中格的公式栏（Excel 顶上那条），只在表格面显示。 */
  private readonly fx: HTMLElement;
  private readonly fxRef: HTMLElement;
  private readonly fxBody: HTMLElement;
  /** #107：工具条（查找 / 引用给 pi），只在表格面显示。 */
  private readonly tools: HTMLElement;
  private readonly findBar: HTMLElement;
  private readonly findIn: HTMLInputElement;
  private readonly findAt: HTMLElement;
  private readonly findBtn: HTMLButtonElement;
  /** #107：底栏的定位信息（只读 / 行列数 / 档位）与缩放。 */
  private readonly ro: HTMLElement;
  private readonly dims: HTMLElement;
  private readonly tier: HTMLElement;
  /** 缩放百分比：点它就是回 100%（数据驱动，不在 foot() 里重建）。 */
  private readonly zoomPct: HTMLButtonElement = el("button", "sd-zoom-pct", "100%");
  /** #107：查找状态：命中坐标、当前那一处、请求序号（防止旧结果盖新结果）。 */
  private hits: { r: number; c: number }[] = [];
  private hitAt = 0;
  private findSeq = 0;
  private findTimer = 0;
  private truncated = false;
  /** #111：底栏那条「N 格无缓存值」。 */
  private readonly status: HTMLElement;
  private tab: Tab = "grid";
  private sheets: SheetInfo[] = [];
  private readonly tabs: HTMLElement[] = [];
  private src: HTMLTextAreaElement | null = null;
  private saveMsg: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private grid: SheetGrid | null = null;
  private closed = false;

  constructor(opts: SheetDialogOpts) {
    this.opts = opts;
    this.root = el("section", "sd");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", opts.name);

    const grip = el("div", "sd-grip");
    grip.title = tr("拖动改高度（双击复原）");

    this.head = el("header", "sd-head");
    const who = el("div", "sd-who");
    who.append(el("span", "sd-name", opts.name), el("span", "sd-path", opts.path));
    this.head.append(el("span", "sd-ico", "📊"), who);

    const close = el("button", "sd-btn sd-close", "✕");
    close.type = "button";
    close.title = tr("关闭");
    close.setAttribute("aria-label", tr("关闭"));
    close.onclick = () => this.close();
    this.head.append(close);

    this.body = el("div", "sd-body");
    this.pane = el("div", "sd-pane");
    this.body.append(this.pane);
    const resize = el("div", "sd-resize");
    resize.title = tr("拖动改大小（双击复原）");

    this.wsTabs = el("nav", "sd-wstabs");
    this.wsTabs.setAttribute("role", "tablist");
    this.wsTabs.setAttribute("aria-label", tr("工作表"));
    this.wsHint = el("span", "sd-wshint");
    this.wsHint.hidden = true;
    this.cfHint = el("span", "sd-cfhint");
    this.cfHint.hidden = true;

    this.fx = el("div", "sd-fx");
    this.fx.hidden = true;
    this.fxRef = el("span", "sd-fx-ref");
    this.fxBody = el("span", "sd-fx-body");
    this.fx.append(this.fxRef, this.fxBody);
    this.status = el("span", "sd-status");
    this.status.hidden = true;
    this.ro = el("span", "sd-ro", tr("只读"));
    this.dims = el("span", "sd-dims");
    this.tier = el("span", "sd-tier");

    // #107：查找 / 引用那条工具条（盖在公式栏上面，只在表格面显示）。
    this.tools = el("div", "sd-tools");
    this.findBtn = el("button", "sd-find-btn", tr("查找"));
    this.findBtn.type = "button";
    this.findBtn.title = tr("查找（Ctrl+F）");
    this.findBtn.onclick = () => this.openFind();
    this.findBar = el("div", "sd-find");
    this.findBar.hidden = true;
    this.findIn = el("input", "sd-find-in");
    this.findIn.type = "search";
    this.findIn.placeholder = tr("查找");
    this.findIn.setAttribute("aria-label", tr("查找"));
    this.findIn.addEventListener("input", () => {
      window.clearTimeout(this.findTimer);
      this.findTimer = window.setTimeout(() => void this.runFind(this.findIn.value), 200);
    });
    this.findIn.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      this.step(ev.shiftKey ? -1 : 1);
    });
    this.findAt = el("span", "sd-find-count", "0/0");
    const prev = el("button", "sd-find-btn", "‹");
    prev.type = "button";
    prev.title = tr("上一个");
    prev.onclick = () => this.step(-1);
    const next = el("button", "sd-find-btn", "›");
    next.type = "button";
    next.title = tr("下一个");
    next.onclick = () => this.step(1);
    this.findBar.append(this.findIn, this.findAt, prev, next);

    const spacer = el("span", "sd-spacer");
    const quote = el("button", "sd-act sd-quote", tr("引用给 pi"));
    quote.type = "button";
    quote.title = tr("把选区（文件路径 + A1:C9）插进对话框，不发送");
    quote.onclick = () => this.quote();
    this.tools.append(this.findBtn, this.findBar, spacer, quote);
    // CSV 没有源码面以外的查找（本地内存里已经有全文，但本票只做 .xlsx）。
    if (!opts.findSheet) {
      this.findBtn.hidden = true;
      this.findBar.hidden = true;
    }
    if (!opts.onQuote) quote.hidden = true;

    this.footBar = this.foot(opts);
    this.footBar.prepend(this.wsTabs, this.status, this.wsHint, this.cfHint);
    this.body.insertBefore(this.tools, this.pane);
    this.root.append(grip, this.head, this.body, this.footBar, resize);
    this.root.addEventListener("keydown", this.onKeyDown);
    if (opts.source) this.buildSource(opts.source);
    this.wire(grip, resize);
  }

  /** Ctrl/Cmd+F 开查找（跟浏览器不抢），Esc 收起。 */
  private onKeyDown = (ev: KeyboardEvent): void => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === "f" || ev.key === "F") && this.opts.findSheet) {
      ev.preventDefault();
      this.openFind();
      return;
    }
    if (ev.key === "Escape" && !this.findBar.hidden) {
      ev.preventDefault();
      this.closeFind();
    }
  };

  private openFind(): void {
    if (this.closed || !this.grid || !this.opts.findSheet) return;
    this.findBar.hidden = false;
    this.findIn.focus();
    this.findIn.select();
    if (this.findIn.value.trim()) void this.runFind(this.findIn.value);
  }

  private closeFind(): void {
    this.findBar.hidden = true;
    this.hits = [];
    this.hitAt = 0;
    this.truncated = false;
    this.grid?.setHits([], -1);
    this.grid?.focusView();
    this.paintFind();
  }

  /** #107：让桥端扫整表。请求可能跑一会儿，`findSeq` 保证只认最后那次。 */
  private async runFind(query: string): Promise<void> {
    const grid = this.grid;
    const find = this.opts.findSheet;
    if (!grid || !find || this.closed) return;
    const seq = ++this.findSeq;
    const q = query.trim();
    if (!q) {
      this.hits = [];
      this.hitAt = 0;
      this.truncated = false;
      grid.setHits([], -1);
      this.paintFind();
      return;
    }
    try {
      const res = await find(grid.activeSheet, q);
      if (seq !== this.findSeq || this.closed || !this.grid) return;
      this.hits = res.matches ?? [];
      this.truncated = !!res.truncated;
      this.hitAt = 0;
      this.grid.setHits(this.hits, 0);
      this.paintFind();
    } catch (err) {
      if (seq !== this.findSeq || this.closed) return;
      this.hits = [];
      this.hitAt = 0;
      this.truncated = false;
      this.grid?.setHits([], -1);
      this.findAt.textContent = "0/0";
      this.findAt.title = errText(err);
    }
  }

  /** 上一处 / 下一处（数字超界会绕回来）。 */
  private step(delta: number): void {
    const grid = this.grid;
    if (!grid || !this.hits.length) return;
    this.hitAt = ((this.hitAt + delta) % this.hits.length + this.hits.length) % this.hits.length;
    grid.setHitAt(this.hitAt);
    this.paintFind();
  }

  private paintFind(): void {
    const n = this.hits.length;
    this.findAt.textContent = `${n ? this.hitAt + 1 : 0}/${n}`;
    this.findAt.title = this.truncated ? tr("命中太多，只显示前 {p1} 处", { p1: n }) : "";
  }

  /** #107：引用 = 文件路径 + 选区坐标（A2:C4）。只插进对话框，不发送。 */
  private quote(): void {
    const grid = this.grid;
    if (!grid || !this.opts.onQuote) return;
    this.opts.onQuote(`${this.opts.path} ${grid.selectionRef}`);
  }

  /**
   * 底部一条（#107 整合）：工作表标签 + 只读 / 行列数 / 档位 / 无缓存值 / 条件格式 / 缩放，
   * 右边是回到真文件的三个出口（#106）。宽度不够时换行，不把任何一项顶出可视区。
   */
  private foot(opts: SheetDialogOpts): HTMLElement {
    const bar = el("footer", "sd-foot");
    const meta = el("span", "sd-meta");
    meta.append(this.ro, this.dims, this.tier);

    const zoom = el("span", "sd-zoom");
    const out = el("button", "sd-zbtn", "−");
    out.type = "button";
    out.dataset.k = "zout";
    out.title = tr("缩小");
    out.onclick = () => this.zoomTo(-1);
    this.zoomPct.type = "button";
    this.zoomPct.dataset.k = "z100";
    this.zoomPct.title = tr("复原 100%");
    this.zoomPct.onclick = () => this.zoomTo(0, true);
    const into = el("button", "sd-zbtn", "+");
    into.type = "button";
    into.dataset.k = "zin";
    into.title = tr("放大");
    into.onclick = () => this.zoomTo(1);
    zoom.append(out, this.zoomPct, into);

    const open = el("button", "sd-act", tr("用默认程序打开"));
    open.type = "button";
    open.title = tr("交给这台电脑上的默认程序打开原文件");
    open.onclick = () => {
      open.disabled = true;
      void opts.onOpen().finally(() => {
        open.disabled = false;
      });
    };
    const reveal = el("button", "sd-act", tr("📂 在文件夹中显示"));
    reveal.type = "button";
    reveal.title = tr("在文件管理器里定位这个文件");
    reveal.onclick = () => void opts.onReveal();
    // 下载不靠桥：跟预览同一份原字节，浏览器直接存。
    const dl = el("a", "sd-act sd-dl", tr("下载"));
    dl.href = opts.raw;
    dl.download = opts.name;
    dl.title = tr("把原文件下载下来");
    bar.append(meta, zoom, open, reveal, dl);
    return bar;
  }

  /** #107：缩放 ±10%；`reset` 直接回 100%。标签跟着网格的真实值走。 */
  private zoomTo(delta: number, reset = false): void {
    const grid = this.grid;
    if (!grid) return;
    if (reset) grid.setZoom(1);
    else grid.setZoom(clampNum(grid.zoom + delta * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
    this.zoomPct.textContent = `${Math.round(grid.zoom * 100)}%`;
  }

  /** #107：底栏那排「这张表长什么样」：行列数、拿数档位。 */
  private paintMeta(sheets: SheetInfo[], sheet: string): void {
    const info = sheets.find((s) => s.name === sheet);
    this.dims.textContent = info ? tr("{p1} 行 × {p2} 列", { p1: info.rows, p2: info.cols }) : "";
    this.tier.textContent = tierLabel(info?.tier);
  }

  /** 源码面：两个 tab + 可编辑的 textarea；说明与保存结果并进底栏那条。 */
  private buildSource(source: SheetSource): void {
    const bar = el("div", "sd-tabs");
    for (const [id, label] of [
      ["grid", tr("表格")],
      ["source", tr("源码")],
    ] as const) {
      const btn = el("button", "sd-tab", label);
      btn.type = "button";
      btn.dataset.tab = id;
      btn.onclick = () => this.showTab(id);
      this.tabs.push(btn);
      bar.append(btn);
    }

    this.src = el("textarea", "sd-src");
    this.src.value = source.text;
    this.src.spellcheck = false;
    this.src.hidden = true;
    this.src.setAttribute("aria-label", tr("源码"));
    this.src.addEventListener("focusin", () => this.opts.onRaise());

    const note = el("span", "sd-note", source.note ?? "");
    note.hidden = !source.note;
    this.saveMsg = el("span", "sd-save-msg");
    this.footBar.prepend(note, this.saveMsg);

    if (source.onSave) {
      const save = el("button", "sd-btn sd-save", tr("保存"));
      save.type = "button";
      save.title = tr("保存（按原编码写回）");
      save.onclick = () => void this.save(source);
      this.saveBtn = save;
      this.head.insertBefore(save, this.head.lastElementChild);
    }

    this.body.insertBefore(bar, this.pane);
    this.body.append(this.src);
    this.showTab("grid");
  }

  private showTab(which: Tab): void {
    this.tab = which;
    this.pane.hidden = which === "source";
    this.tools.hidden = which !== "grid";
    if (this.src) this.src.hidden = which !== "source";
    this.fx.hidden = which !== "grid" || !this.fxRef.textContent;
    for (const btn of this.tabs) btn.classList.toggle("on", btn.dataset.tab === which);
    if (which === "grid") this.grid?.refresh();
  }

  /** #111：选中格的原文（公式带 `=`）/ 值；空表里的格子就是空串。 */
  private showFormula(sel: { ref: string; text: string } | null): void {
    if (!sel) {
      this.fx.hidden = true;
      return;
    }
    this.fxRef.textContent = sel.ref;
    this.fxBody.textContent = sel.text;
    this.fxBody.title = sel.text;
    this.fx.hidden = this.tab !== "grid";
  }

  /** #111：#107：底栏那些「这张表是什么样」（只读 / 行列数 / 档位 / 无缓存值）。 */
  private paintStatus(sheets: SheetInfo[], sheet: string): void {
    this.paintMeta(sheets, sheet);
    const n = sheets.find((s) => s.name === sheet)?.noCache ?? 0;
    this.status.textContent = n ? tr("{p1} 格无缓存值", { p1: n }) : "";
    this.status.title = n ? tr("需用表格软件重算") : "";
    this.status.hidden = !n;
  }

  private async save(source: SheetSource): Promise<void> {
    const btn = this.saveBtn;
    const msg = this.saveMsg;
    if (!btn || !msg || !this.src || !source.onSave) return;
    btn.disabled = true;
    msg.textContent = tr("保存中…");
    msg.className = "sd-save-msg";
    try {
      await source.onSave(this.src.value);
      if (this.closed) return;
      msg.textContent = tr("已保存 · {p1}", { p1: fmtTime() });
      msg.className = "sd-save-msg ok";
    } catch (err) {
      if (this.closed) return;
      msg.textContent = errText(err);
      msg.className = "sd-save-msg err";
    } finally {
      btn.disabled = false;
    }
  }

  /** #108：底部只列可见的工作表；藏起来的只报个数，不给出入口。 */
  private renderTabs(sheets: SheetInfo[], active: string): void {
    this.sheets = sheets;
    this.wsTabs.replaceChildren();
    for (const info of sheets) {
      if (info.hidden) continue;
      const btn = el("button", "sd-wstab", info.name);
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", info.name === active ? "true" : "false");
      btn.onclick = () => void this.pickSheet(info.name);
      this.wsTabs.append(btn);
    }
    const hidden = sheets.filter((s) => s.hidden).length;
    this.wsHint.textContent = hidden ? tr("{p1} 个隐藏工作表", { p1: hidden }) : "";
    this.wsHint.hidden = !hidden;
    this.renderCfHint(active);
  }

  /** #109：当前表里认不出的条件格式规则，只报个数，不阻止查看。 */
  private renderCfHint(active: string): void {
    const n = this.sheets.find((s) => s.name === active)?.cfUnsupported ?? 0;
    this.cfHint.textContent = n ? tr("{p1} 条条件格式暂不支持", { p1: n }) : "";
    this.cfHint.hidden = !n;
  }

  private async pickSheet(name: string): Promise<void> {
    if (!this.grid || this.grid.activeSheet === name) return;
    for (const btn of this.wsTabs.children) {
      btn.setAttribute("aria-selected", btn.textContent === name ? "true" : "false");
    }
    await this.grid.setSheet(name);
    this.renderCfHint(name);
    this.paintStatus(this.sheets, name);
  }

  /** 源码改过并保存之后换一份数据：行列数都可能变，网格整个重建。 */
  async setData(meta: SheetMeta, fetchWindow: SheetDialogOpts["fetchWindow"]): Promise<void> {
    this.opts.fetchWindow = fetchWindow;
    this.opts.loadMeta = async () => meta;
    this.grid?.destroy();
    this.grid = null;
    await this.load();
  }

  /** 挂上去之后调用：先按记忆摆好，再取元数据。 */
  open(): void {
    this.applyGeom();
    void this.load();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroy();
    this.opts.onClose();
  }

  destroy(): void {
    this.grid?.destroy();
    this.grid = null;
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }

  private async load(): Promise<void> {
    this.showMessage(tr("正在读取…"));
    try {
      const meta = await this.opts.loadMeta();
      if (this.closed) return;
      // 打开时落在第一张看得见的表上（文件名那格传给 meta.name 的不一定是它）。
      const first = meta.sheets.find((s) => !s.hidden)?.name ?? meta.name;
      this.sheets = meta.sheets;
      // 公式栏插在网格上面；标签页（CSV 的）在它上面。
      if (this.pane.parentElement === this.body) this.body.insertBefore(this.fx, this.pane);
      this.renderTabs(meta.sheets, first);
      this.paintStatus(meta.sheets, first);
      this.grid = new SheetGrid({
        meta,
        sheet: first,
        fetchWindow: this.opts.fetchWindow,
        // #111：选中格变了，公式栏跟着换。
        onSelect: (sel) => this.showFormula(sel),
        // 文件在预览之后被改过：停下，说清楚，别拿旧数据装作没事（#106）。
        onStale: () => this.stale(),
      });
      this.pane.replaceChildren(this.grid.root);
      await this.grid.start();
    } catch (err) {
      if (this.closed) return;
      const code = (err as { code?: string } | null)?.code;
      if (code === "sheet_stale") {
        this.stale();
        return;
      }
      if (code === "sheet_unsupported") {
        this.blocked(tr("这个格式这里不支持，用本机程序打开"), [{ label: tr("用默认程序打开"), run: () => void this.opts.onOpen() }]);
        return;
      }
      this.showMessage(tr("读不了这张表：{p1}", { p1: errText(err) }));
    }
  }

  /** 文件在这扇窗打开之后被改过：旧凭据已失效，只剩「重新打开」这一条路。 */
  private stale(): void {
    if (this.closed) return;
    this.blocked(tr("文件已改变，重新打开"), [{ label: tr("重新打开"), run: () => this.opts.onReopen() }]);
  }

  /** 盖住网格：说清楚发生了什么，外加能继续走下去的按钮。 */
  private blocked(text: string, actions: { label: string; run: () => void }[]): void {
    this.grid?.destroy();
    this.grid = null;
    const box = el("div", "sd-block");
    box.append(el("div", "sd-block-text", text));
    if (actions.length) {
      const row = el("div", "sd-block-acts");
      for (const action of actions) {
        const b = el("button", "sd-act", action.label);
        b.type = "button";
        b.onclick = () => action.run();
        row.append(b);
      }
      box.append(row);
    }
    this.body.replaceChildren(box);
  }

  private showMessage(text: string): void {
    this.pane.replaceChildren(el("div", "sd-msg", text));
  }

  private wire(grip: HTMLElement, resize: HTMLElement): void {
    const opts = {
      scale: () => this.opts.scale(),
      inset: () => 0,
      save: () => this.saveGeom(),
    };
    dragFloat(
      this.head,
      this.root,
      "move",
      (box, dx, dy, view) => {
        this.root.style.left = `${clampNum(box.l + dx, 0, Math.max(0, view.vw - box.w))}px`;
        this.root.style.top = `${clampNum(box.t + dy, 0, Math.max(0, view.vh - box.h))}px`;
      },
      opts,
    );
    this.head.ondblclick = (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      this.resetGeom();
    };

    dragFloat(
      resize,
      this.root,
      "size",
      (box, dx, dy, view) => {
        this.root.style.width = `${clampNum(box.w + dx, MIN_W, Math.max(MIN_W, view.vw - box.l))}px`;
        this.root.style.height = `${clampNum(box.h + dy, MIN_H, Math.max(MIN_H, view.vh - box.t))}px`;
        this.resized();
      },
      opts,
    );
    resize.ondblclick = () => this.resetGeom();

    dragFloat(
      grip,
      this.root,
      "grip",
      (box, _dx, dy) => {
        const bottom = box.t + box.h;
        const h = clampNum(box.h - dy, MIN_H, bottom);
        this.root.style.top = `${clampNum(bottom - h, 0, bottom)}px`;
        this.root.style.height = `${h}px`;
        this.resized();
      },
      opts,
    );
    grip.ondblclick = () => this.resetGeom();

    this.root.addEventListener("pointerdown", () => this.opts.onRaise(), true);
    this.root.addEventListener("focusin", () => this.opts.onRaise());
    window.addEventListener("resize", this.onResize);
  }

  private onResize = (): void => {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const box = this.currentBox();
    const w = Math.min(box.w, vw);
    const h = Math.min(box.h, vh);
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    pinFloat(this.root, { l: box.l, t: box.t, w, h }, s, 0);
    this.resized();
  };

  private resized(): void {
    // 宽高刚变：可视行数变了，重新算一遍窗口。
    requestAnimationFrame(() => this.grid?.refresh());
  }

  private defaults(): FloatBox {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const w = Math.max(MIN_W, Math.min(1180, vw - 48));
    const h = Math.max(MIN_H, Math.min(780, vh - 48));
    return { l: Math.max(0, (vw - w) / 2), t: Math.max(0, (vh - h) / 2), w, h };
  }

  private readGeom(): Partial<FloatBox> | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<FloatBox>;
      if (!value || typeof value !== "object") return null;
      return value;
    } catch {
      return null;
    }
  }

  private currentBox(): FloatBox {
    return measureFloat(this.root, this.opts.scale());
  }

  private applyGeom(): void {
    const s = this.opts.scale();
    const vw = window.innerWidth / s;
    const vh = window.innerHeight / s;
    const def = this.defaults();
    const stored = this.readGeom();
    const w = clampNum(stored?.w ?? def.w, Math.min(MIN_W, vw), vw);
    const h = clampNum(stored?.h ?? def.h, Math.min(MIN_H, vh), vh);
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    pinFloat(this.root, { l: stored?.l ?? def.l, t: stored?.t ?? def.t, w, h }, s, 0);
  }

  private saveGeom(): void {
    const box = this.currentBox();
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ l: Math.round(box.l), t: Math.round(box.t), w: Math.round(box.w), h: Math.round(box.h) }),
      );
    } catch {
      /* 存不下也还能用这一次 */
    }
  }

  private resetGeom(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 忘不掉也还能用这一次 */
    }
    this.root.classList.remove("pinned");
    for (const prop of ["left", "top", "bottom", "transform", "width", "height"]) this.root.style.removeProperty(prop);
    this.applyGeom();
    this.resized();
  }
}
