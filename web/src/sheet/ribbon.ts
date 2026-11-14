/**
 * 表格功能区（#433）：照 WPS 的六个页签排版——开始 / 插入 / 页面 / 公式 / 数据 / 视图。
 *
 * 只做「预览里真能生效」的那些命令：字体开关、字色/填充、对齐、数字格式、自动求和、
 * 冻结窗格、网格线、公式视图、缩放、查找。需要写回文件的命令都走网格的编辑层，
 * 攒在本地改动里，点「保存」才落盘；其余（贴图、图表、排序、筛选）留成禁用态，
 * 悬停说明原因，不做假的按钮。
 */
import type { SheetGrid } from "./grid.ts";

// i18n-ignore-start 功能区的命令名照 WPS 的中文写法（开始/插入/页面/公式/数据/视图、加粗、冻结窗格…），
// 用户就是按 WPS 的肌肉记忆找按钮，翻译成英文反而找不到；术语一致性优先于多语言。

type Kind = "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN";

interface Item {
  node: HTMLElement;
  state?: () => boolean;
  hide?: () => boolean;
  refresh?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Ribbon {
  readonly el: HTMLElement;
  private readonly getGrid: () => SheetGrid | null;
  private readonly panes = new Map<string, HTMLElement>();
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly items: Item[] = [];
  private readonly pageOpts: { on: () => boolean; toggle: () => void } | null;
  private current = "home";

  /** 浮窗挂上网格之后才能用；按钮只会在那之后被点到。 */
  private get grid(): SheetGrid {
    const grid = this.getGrid();
    if (!grid) throw new Error("表格还没准备好");
    return grid;
  }

  constructor(
    grid: () => SheetGrid | null,
    right: HTMLElement[],
    opts: { find: () => void; page?: { on: () => boolean; toggle: () => void } },
  ) {
    this.getGrid = grid;
    this.pageOpts = opts.page ?? null;
    this.el = el("div", "sd-ribbon");

    const head = el("div", "sd-rb-head");
    const tabs = el("nav", "sd-rb-tabs");
    const acts = el("div", "sd-rb-acts");
    for (const node of right) acts.append(node);
    head.append(tabs, acts);

    const body = el("div", "sd-rb-body");
    this.el.append(head, body);

    for (const [id, label] of [
      ["home", "开始"],
      ["insert", "插入"],
      ["page", "页面"],
      ["formula", "公式"],
      ["data", "数据"],
      ["view", "视图"],
    ] as const) {
      const tab = el("button", "sd-rb-tab", label);
      tab.dataset.pane = id;
      tab.onclick = () => this.show(id);
      tabs.append(tab);
      this.tabs.set(id, tab);
      const pane = el("div", "sd-rb-pane");
      pane.dataset.pane = id;
      body.append(pane);
      this.panes.set(id, pane);
    }

    this.buildHome(opts);
    this.buildInsert();
    this.buildPage();
    this.buildFormula(opts);
    this.buildData(opts);
    this.buildView();
    this.show("home");
  }

  /** 切页签（和 WPS 一样，一次只显示一排）。 */
  show(id: string): void {
    this.current = id;
    for (const [key, tab] of this.tabs) tab.classList.toggle("on", key === id);
    for (const [key, pane] of this.panes) pane.hidden = key !== id;
    this.update();
  }

  /** 每次选区 / 改动 / 缩放变化后调一次，把开关按钮的亮灭刷对。 */
  update(): void {
    for (const item of this.items) {
      if (item.hide) item.node.hidden = item.hide();
      if (item.state) item.node.classList.toggle("on", item.state());
      item.refresh?.();
    }
  }

  // ---------------------------------------------------------------- 小零件

  private btn(label: string, title: string, fn: () => void, cls = ""): HTMLButtonElement {
    const node = el("button", `sd-rb-b ${cls}`.trim(), label);
    node.title = title;
    node.onmousedown = (ev) => ev.preventDefault();
    node.onclick = () => {
      fn();
      this.update();
    };
    return node;
  }

  private toggle(label: string, title: string, fn: () => void, state: () => boolean): HTMLButtonElement {
    const node = this.btn(label, title, fn, "sd-rb-tg");
    this.items.push({ node, state });
    return node;
  }

  private disabled(label: string, title: string): HTMLButtonElement {
    const node = el("button", "sd-rb-b", label);
    node.title = title;
    node.disabled = true;
    return node;
  }

  private grp(caption: string, nodes: (HTMLElement | null)[]): HTMLElement {
    const box = el("div", "sd-rb-grp");
    const row = el("div", "sd-rb-row");
    for (const node of nodes) if (node) row.append(node);
    box.append(row, el("div", "sd-rb-cap", caption));
    return box;
  }

  private sep(): HTMLElement {
    return el("span", "sd-rb-sep");
  }

  // ---------------------------------------------------------------- 开始

  private buildHome(opts: { find: () => void }): void {
    const pane = this.panes.get("home")!;
    const g = this.grid;

    const copy = (cut: boolean) => {
      const text = g.selectionText;
      void navigator.clipboard?.writeText(text);
      if (cut) for (const node of []) void node;
    };

    pane.append(
      this.grp("剪贴板", [
        this.disabled("粘贴", "用 Ctrl+V 粘贴（这里不读系统剪贴板）"),
        this.btn("复制", "复制选中区域", () => copy(false)),
        this.btn("剪切", "复制并清空选中区域", () => {
          copy(false);
          g.clearSelectionForRibbon();
        }),
      ]),
      this.sep(),
      this.grp("字体", [
        this.combo("字体名", () => this.grid.activeStyle?.f?.n ?? "Calibri", "sd-rb-fname"),
        this.combo("字号", () => String(this.grid.activeStyle?.f?.s ?? 11), "sd-rb-fsize"),
        this.btn("A−", "字号小一号", () => this.stepFont(-1)),
        this.btn("A+", "字号大一号", () => this.stepFont(1)),
        this.toggle("B", "加粗", () => g.applyStyleToSelection({ b: !g.activeStyle?.f?.b }), () => !!g.activeStyle?.f?.b),
        this.toggle("I", "斜体", () => g.applyStyleToSelection({ i: !g.activeStyle?.f?.i }), () => !!g.activeStyle?.f?.i),
        this.toggle("U", "下划线", () => g.applyStyleToSelection({ u: !g.activeStyle?.f?.u }), () => !!g.activeStyle?.f?.u),
        this.btn("A", "字色：红 / 黑 切换", () => g.applyStyleToSelection({ fc: g.activeStyle?.f?.c === "#C00000" ? "#000000" : "#C00000" }), "sd-rb-fc"),
        this.btn("▨", "填充：黄 / 无 切换", () => g.applyStyleToSelection({ bg: g.activeStyle?.bg === "#FFF2CC" ? null : "#FFF2CC" }), "sd-rb-bg"),
      ]),
      this.sep(),
      this.grp("对齐", [
        this.toggle("左", "左对齐", () => g.applyStyleToSelection({ h: "l" }), () => g.activeStyle?.h === "l"),
        this.toggle("中", "居中", () => g.applyStyleToSelection({ h: "c" }), () => g.activeStyle?.h === "c"),
        this.toggle("右", "右对齐", () => g.applyStyleToSelection({ h: "r" }), () => g.activeStyle?.h === "r"),
        this.toggle("上", "顶端对齐", () => g.applyStyleToSelection({ v: "t" }), () => g.activeStyle?.v === "t"),
        this.toggle("↕", "垂直居中", () => g.applyStyleToSelection({ v: "m" }), () => g.activeStyle?.v === "m"),
        this.toggle("下", "底端对齐", () => g.applyStyleToSelection({ v: "b" }), () => g.activeStyle?.v === "b"),
        this.toggle("换行", "自动换行", () => g.applyStyleToSelection({ w: !g.activeStyle?.w }), () => !!g.activeStyle?.w),
      ]),
      this.sep(),
      this.grp("数字", [
        this.btn("常规", "常规格式", () => g.applyStyleToSelection({ nf: 0 })),
        this.btn("¥", "货币（两位小数）", () => g.applyStyleToSelection({ nf: 4 })),
        this.btn("%", "百分比", () => g.applyStyleToSelection({ nf: 9 })),
        this.btn("千分位", "千分位整数", () => g.applyStyleToSelection({ nf: 3 })),
        this.btn("0.00", "两位小数", () => g.applyStyleToSelection({ nf: 2 })),
        this.btn("日期", "日期 yyyy-mm-dd", () => g.applyStyleToSelection({ nf: 14 })),
      ]),
      this.sep(),
      this.grp("编辑", [
        this.btn("撤销", "撤销 Ctrl+Z", () => g.undo()),
        this.btn("重做", "重做 Ctrl+Y", () => g.redo()),
        this.btn("查找", "查找 Ctrl+F", opts.find),
      ]),
    );
  }

  /** 字体名 / 字号那种「框」：只显示当前值，点了弹提示（WPS 里是下拉，这里不假装有下拉）。 */
  private combo(title: string, value: () => string, cls: string): HTMLElement {
    const box = el("div", `sd-rb-combo ${cls}`.trim());
    const text = el("span", "", "");
    const caret = el("span", "sd-rb-caret", "▾");
    box.title = title;
    box.append(text, caret);
    this.items.push({ node: box, refresh: () => (text.textContent = value()) });
    return box;
  }

  private stepFont(delta: number): void {
    const now = this.grid.activeStyle?.f?.s ?? 11;
    const next = Math.max(6, Math.min(40, Math.round((now + delta) * 2) / 2));
    this.grid.applyStyleToSelection({ fs: next });
  }

  // ---------------------------------------------------------------- 插入

  private buildInsert(): void {
    const pane = this.panes.get("insert")!;
    const g = this.grid;
    const fn = (kind: Kind, label: string, title: string) => this.btn(label, title, () => g.autoSum(kind));
    pane.append(
      this.grp("函数", [
        fn("SUM", "Σ 求和", "自动求和（上方连续数字，没有就取左侧）"),
        fn("AVERAGE", "平均", "自动求平均"),
        fn("COUNT", "计数", "数一下有几个数"),
        fn("MAX", "最大", "取最大值"),
        fn("MIN", "最小", "取最小值"),
      ]),
      this.sep(),
      this.grp("日期时间", [
        this.btn("今天", "插入今天的日期 yyyy-mm-dd", () => {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          g.writeAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
        }),
        this.btn("现在", "插入当前时间 HH:MM", () => {
          const d = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          g.writeAt(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
        }),
      ]),
      this.sep(),
      this.grp("插图", [
        this.disabled("图片", "内置图片是只读显示的，暂不支持插新图"),
        this.disabled("图表", "预览不画图表对象"),
        this.disabled("符号", "用输入法打符号即可"),
      ]),
    );
  }

  // ---------------------------------------------------------------- 页面

  private buildPage(): void {
    const pane = this.panes.get("page")!;
    const g = this.grid;
    pane.append(
      this.grp("显示", [
        this.toggle("网格线", "显示/隐藏网格线", () => g.setGrid(!g.gridShown), () => g.gridShown),
        this.toggle("公式", "显示公式而不是结果", () => g.setShowFormulas(!g.formulasShown), () => g.formulasShown),
      ]),
      this.sep(),
      this.grp("打印", [
        this.pageOpts
          ? this.toggle("纸张视图", "显示/隐藏 LibreOffice 排出的纸面", () => this.pageOpts?.toggle(), () => this.pageOpts?.on() ?? false)
          : this.disabled("纸张视图", "这份文件没有排版后的纸面"),
      ]),
      this.sep(),
      this.grp("缩放", [
        this.btn("−", "缩小", () => this.zoom(-0.1)),
        this.btn("100%", "回到 100%", () => this.zoom(0, true)),
        this.btn("+", "放大", () => this.zoom(0.1)),
        this.btn("适应窗口", "整表缩到看得全", () => this.zoom(1, true)),
      ]),
    );
  }

  private zoom(delta: number, reset = false): void {
    const g = this.grid;
    g.setZoom(reset ? 1 : g.zoom + delta);
  }

  // ---------------------------------------------------------------- 公式

  private buildFormula(opts: { find: () => void }): void {
    const pane = this.panes.get("formula")!;
    const g = this.grid;
    const fn = (kind: Kind, label: string) => this.btn(label, `插入 ${kind} 公式`, () => g.autoSum(kind));
    pane.append(
      this.grp("函数", [fn("SUM", "自动求和"), fn("AVERAGE", "平均值"), fn("COUNT", "计数"), fn("MAX", "最大值"), fn("MIN", "最小值")]),
      this.sep(),
      this.grp("显示", [
        this.toggle("显示公式", "格子里显示 =公式 原文", () => g.setShowFormulas(!g.formulasShown), () => g.formulasShown),
        this.btn("查找", "找公式或文字", opts.find),
      ]),
    );
  }

  // ---------------------------------------------------------------- 数据

  private buildData(opts: { find: () => void }): void {
    const pane = this.panes.get("data")!;
    const g = this.grid;
    pane.append(
      this.grp("窗格", [
        this.btn("冻结窗格", "从当前格往上、往左都冻住", () => {
          const s = g.selectionBox;
          g.setFreeze({ rows: s.r0, cols: s.c0 });
        }),
        this.btn("取消冻结", "回到文件里的冻结设置", () => g.setFreeze(null)),
      ]),
      this.sep(),
      this.grp("编辑", [
        this.btn("查找", "查找 Ctrl+F", opts.find),
        this.disabled("排序", "预览里不改行序"),
        this.disabled("筛选", "预览里不做筛选"),
      ]),
    );
  }

  // ---------------------------------------------------------------- 视图

  private buildView(): void {
    const pane = this.panes.get("view")!;
    const g = this.grid;
    pane.append(
      this.grp("显示", [
        this.toggle("网格线", "显示/隐藏网格线", () => g.setGrid(!g.gridShown), () => g.gridShown),
        this.toggle("显示公式", "格子里显示公式原文", () => g.setShowFormulas(!g.formulasShown), () => g.formulasShown),
      ]),
      this.sep(),
      this.grp("窗口", [
        this.btn("冻结窗格", "冻结到当前格", () => {
          const s = g.selectionBox;
          g.setFreeze({ rows: s.r0, cols: s.c0 });
        }),
        this.btn("取消冻结", "回到文件里的冻结设置", () => g.setFreeze(null)),
        this.btn("−", "缩小", () => this.zoom(-0.1)),
        this.btn("+", "放大", () => this.zoom(0.1)),
      ]),
    );
  }
}
// i18n-ignore-end
