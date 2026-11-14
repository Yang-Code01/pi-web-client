/**
 * 表格功能区（#433 / D264）：照 WPS 的六个页签排版——开始 / 插入 / 页面 / 公式 / 数据 / 视图。
 *
 * 只做「预览里真能生效」的那些命令：字体开关、字色/填充色、边框、对齐、合并、数字格式、
 * 自动求和、清除、格式刷、冻结窗格、网格线、公式视图、缩放、查找。需要写回文件的命令都走
 * 网格的编辑层，攒在本地改动里，点「保存」才落盘；做不到的（贴图、透视表、宏）留成禁用态，
 * 悬停说明原因，不做假的按钮。
 *
 * 表里那些格式代码是从本机 WPS 的资源里抄的（`numberformat.cfg`、`datetimeformat.cfg`），
 * 所以「中文大写数字」「单位：万元」这些特殊格式跟 WPS 里选出来的是同一串代码。
 */
import type { SheetGrid } from "./grid.ts";
import type { SheetStructOp, SheetStyle, SheetStylePatch } from "../types.ts";

// i18n-ignore-start 功能区的命令名照 WPS 的中文写法（开始/插入/页面/公式/数据/视图、加粗、冻结窗格…），
// 用户就是按 WPS 的肌肉记忆找按钮，翻译成英文反而找不到；术语一致性优先于多语言。

type Kind = "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN";

interface Item {
  node: HTMLElement;
  state?: () => boolean;
  hide?: () => boolean;
  refresh?: () => void;
}

/** 下拉菜单里的一条；`swatch` 是色块，`on` 是当前状态（打勾）。 */
interface MenuEntry {
  label?: string;
  swatch?: string;
  sample?: string;
  on?: () => boolean;
  run?: () => void;
  sep?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** WPS「开始 → 数字格式」那一列（内置 id 就是 Excel 的内置 id）。 */
const NUMBER_FORMATS: { label: string; nf: number | string }[] = [
  { label: "常规", nf: 0 },
  { label: "数值", nf: 2 },
  { label: "货币", nf: 4 },
  { label: "会计专用", nf: '"¥"#,##0.00_);("¥"#,##0.00)' },
  { label: "短日期", nf: 14 },
  { label: "长日期", nf: 'yyyy"年"m"月"d"日"' },
  { label: "时间", nf: 20 },
  { label: "百分比", nf: 10 },
  { label: "科学记数", nf: 11 },
  { label: "分数", nf: 12 },
  { label: "文本", nf: 49 },
];

/** WPS 的「特殊」那一折：中文数字、人民币大写、按万/亿缩放、正负号（抄自 numberformat.cfg）。 */
const SPECIAL_FORMATS: { label: string; nf: string }[] = [
  { label: "邮政编码", nf: "000000" },
  { label: "中文小写数字", nf: "[DBNum1][$-804]G/通用格式" },
  { label: "中文大写数字", nf: "[DBNum2][$-804]G/通用格式" },
  { label: "人民币大写", nf: "[DBNum2][$RMB]G/通用格式;[红色][DBNum2][$RMB]G/通用格式" },
  { label: "单位：万元", nf: '0"."0,"万元"' },
  { label: "万", nf: '0"."0,"万"' },
  { label: "百万", nf: '0.00,,"百万"' },
  { label: "亿", nf: '0"."00,,"亿"' },
  { label: "正负号", nf: "+0;-0;0;@" },
];

/** 主题色 + 标准色（WPS 的取色盘就这两排，够日常用了）。 */
const THEME_COLORS = [
  "#FFFFFF", "#000000", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31",
  "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E",
];
const STANDARD_COLORS = [
  "#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050",
  "#00B0F0", "#0070C0", "#002060", "#7030A0", "#FF99CC", "#A6A6A6",
];

/** 公式页签的「函数库」：按类目列常用函数，点一条就把 `=函数(` 写进公式栏。 */
const FUNCTION_LIBRARY: { label: string; fns: string[] }[] = [
  { label: "财务", fns: ["PMT", "FV", "PV", "NPER", "RATE", "IPMT", "PPMT", "NPV", "IRR", "SLN", "DB"] },
  { label: "逻辑", fns: ["IF", "IFS", "IFERROR", "AND", "OR", "NOT", "XOR", "SWITCH", "TRUE", "FALSE"] },
  { label: "文本", fns: ["CONCAT", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "TRIM", "TEXT", "VALUE", "SUBSTITUTE", "SEARCH", "REPLACE", "UPPER", "LOWER", "PROPER"] },
  { label: "日期和时间", fns: ["TODAY", "NOW", "DATE", "EDATE", "EOMONTH", "DATEDIF", "YEAR", "MONTH", "DAY", "HOUR", "WEEKDAY", "WEEKNUM", "NETWORKDAYS"] },
  { label: "查找与引用", fns: ["VLOOKUP", "HLOOKUP", "XLOOKUP", "LOOKUP", "INDEX", "MATCH", "CHOOSE", "ROW", "COLUMN", "ROWS", "COLUMNS"] },
  { label: "数学与三角", fns: ["SUM", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "INT", "MOD", "POWER", "SQRT", "CEILING", "FLOOR", "MROUND", "TRUNC", "SUMPRODUCT", "SUBTOTAL"] },
  { label: "统计", fns: ["COUNT", "COUNTA", "COUNTIF", "COUNTIFS", "SUMIF", "SUMIFS", "AVERAGE", "AVERAGEIF", "MEDIAN", "MAX", "MIN", "LARGE", "SMALL", "STDEV", "RANK", "PERCENTILE"] },
];

export class Ribbon {
  readonly el: HTMLElement;
  private readonly getGrid: () => SheetGrid | null;
  private readonly panes = new Map<string, HTMLElement>();
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly items: Item[] = [];
  private readonly pageOpts: { on: () => boolean; toggle: () => void } | null;
  private readonly structFn: ((op: SheetStructOp) => void) | null;
  private readonly filterFn: ((col: number | null, value: string | null) => void) | null;
  private readonly onInsertFormula: ((text: string) => void) | null;
  private current = "home";
  /** #437 格式刷：按一下记下这格的样式，下一次选区别处就刷上去。 */
  private painter: { patch: SheetStylePatch; from: string } | null = null;

  /** 浮窗挂上网格之后才能用；按钮只会在那之后被点到。 */
  private get grid(): SheetGrid {
    const grid = this.getGrid();
    if (!grid) throw new Error("表格还没准备好");
    return grid;
  }

  constructor(
    grid: () => SheetGrid | null,
    right: HTMLElement[],
    opts: {
      find: () => void;
      page?: { on: () => boolean; toggle: () => void };
      struct?: (op: SheetStructOp) => void;
      filter?: (col: number | null, value: string | null) => void;
      /** 公式页的「函数库」把 `=SUM(` 插进公式栏 / 正在编辑的格子。 */
      insertFormula?: (text: string) => void;
    },
  ) {
    this.getGrid = grid;
    this.pageOpts = opts.page ?? null;
    this.structFn = opts.struct ?? null;
    this.filterFn = opts.filter ?? null;
    this.onInsertFormula = opts.insertFormula ?? null;
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
    this.closeMenu();
    this.update();
  }

  /** 每次选区 / 改动 / 缩放变化后调一次，把开关按钮的亮灭刷对。 */
  update(): void {
    for (const item of this.items) {
      if (item.hide) item.node.hidden = item.hide();
      if (item.state) item.node.classList.toggle("on", item.state());
      item.refresh?.();
    }
    // 格式刷：选区一变就把记下的样式刷过去（WPS 的「刷一下」）
    const grid = this.getGrid();
    if (this.painter && grid) {
      const ref = grid.selectionRef;
      if (ref !== this.painter.from) {
        grid.applyStyleToSelection(this.painter.patch);
        this.painter = null;
      }
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

  /** 一排按钮后面挂一个 ▾，点开是弹出的菜单（WPS 的「拆开的下拉」就是这个形状）。 */
  private dropdown(label: string, title: string, cls: string, build: () => MenuEntry[][]): HTMLElement {
    const box = el("span", "sd-rb-dd");
    const main = this.btn(label, title, () => {
      const menu = this.openMenu(box, build());
      void menu;
    }, cls);
    const caret = el("button", "sd-rb-caret-b", "▾");
    caret.type = "button";
    caret.title = title;
    caret.onmousedown = (ev) => ev.preventDefault();
    caret.onclick = () => this.openMenu(box, build());
    box.append(main, caret);
    return box;
  }

  /** 当前打开的那个菜单（同一时刻只留一个，旧的监听也要拆掉，否则后面点的菜单会被它关掉）。 */
  private menuNode: HTMLElement | null = null;
  private menuOff: ((ev: Event) => void) | null = null;

  private openMenu(anchor: HTMLElement, groups: MenuEntry[][]): HTMLElement {
    this.closeMenu();
    const menu = el("div", "sd-rb-menu");
    for (const group of groups) {
      if (!group.length) continue;
      const box = el("div", "sd-rb-mg");
      for (const entry of group) {
        if (entry.sep) {
          box.append(el("div", "sd-rb-msep"));
          continue;
        }
        const row = el("button", "sd-rb-mi");
        row.type = "button";
        if (entry.swatch) {
          const dot = el("span", "sd-rb-swatch");
          dot.style.background = entry.swatch;
          row.append(dot);
        } else if (entry.sample) {
          row.append(el("span", "sd-rb-sample", entry.sample));
        }
        row.append(el("span", "sd-rb-mlabel", entry.label ?? ""));
        if (entry.on?.()) row.append(el("span", "sd-rb-mtick", "✓"));
        row.onclick = () => {
          this.closeMenu();
          entry.run?.();
          this.update();
        };
        box.append(row);
      }
      menu.append(box);
    }
    this.el.append(menu);
    // 顶在按钮下面；用 ribbon 自己的坐标系（`#app` 里有 zoom，视觉 px 要除回去）
    const host = this.el.getBoundingClientRect();
    const scale = this.el.offsetWidth ? host.width / this.el.offsetWidth : 1;
    const box = anchor.getBoundingClientRect();
    const left = (box.left - host.left) / scale;
    const top = (box.bottom - host.top) / scale;
    menu.style.left = `${Math.max(0, Math.min(left, this.el.offsetWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${top}px`;
    if (host.top + top * scale + menu.offsetHeight > window.innerHeight - 8) {
      menu.style.top = `${Math.max(0, (box.top - host.top) / scale - menu.offsetHeight - 2)}px`;
    }
    const off = (ev: Event): void => {
      if (menu.contains(ev.target as Node)) return;
      this.closeMenu();
    };
    this.menuNode = menu;
    this.menuOff = off;
    setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
    return menu;
  }

  private closeMenu(): void {
    if (this.menuOff) {
      document.removeEventListener("pointerdown", this.menuOff, true);
      this.menuOff = null;
    }
    this.menuNode?.remove();
    this.menuNode = null;
    document.querySelectorAll(".sd-rb-menu").forEach((node) => node.remove());
  }

  // ---------------------------------------------------------------- 开始

  private buildHome(opts: { find: () => void; struct?: (op: SheetStructOp) => void }): void {
    const pane = this.panes.get("home")!;
    const g = this.grid;

    const copy = (cut: boolean) => {
      const text = g.selectionText;
      void navigator.clipboard?.writeText(text);
      if (cut) g.clearSelectionForRibbon();
    };

    const fillColors = (): MenuEntry[][] => [
      [
        { label: "无填充", swatch: "transparent", run: () => g.applyStyleToSelection({ bg: null }) },
        { label: "自动", swatch: "#ffffff", run: () => g.applyStyleToSelection({ bg: null }) },
      ],
      THEME_COLORS.map((c) => ({ swatch: c, label: c, run: () => g.applyStyleToSelection({ bg: c }) })),
      STANDARD_COLORS.map((c) => ({ swatch: c, label: c, run: () => g.applyStyleToSelection({ bg: c }) })),
    ];

    const fontColors = (): MenuEntry[][] => [
      [
        { label: "自动", swatch: "#000000", run: () => g.applyStyleToSelection({ fc: "#000000" }) },
      ],
      THEME_COLORS.map((c) => ({ swatch: c, label: c, run: () => g.applyStyleToSelection({ fc: c }) })),
      STANDARD_COLORS.map((c) => ({ swatch: c, label: c, run: () => g.applyStyleToSelection({ fc: c }) })),
    ];

    const borderMenu = (): MenuEntry[][] => {
      const thin = "thin" as const;
      const all = { t: thin, r: thin, b: thin, l: thin };
      const none = { t: "none" as const, r: "none" as const, b: "none" as const, l: "none" as const };
      return [
        [
          { label: "下边框", run: () => g.applyStyleToSelection({ bd: { b: thin } }) },
          { label: "上边框", run: () => g.applyStyleToSelection({ bd: { t: thin } }) },
          { label: "左边框", run: () => g.applyStyleToSelection({ bd: { l: thin } }) },
          { label: "右边框", run: () => g.applyStyleToSelection({ bd: { r: thin } }) },
        ],
        [
          { label: "所有框线", run: () => g.applyStyleToSelection({ bd: all }) },
          { label: "外侧框线", run: () => g.applyStyleToSelection({ bd: all }) },
          { label: "双底框线", run: () => g.applyStyleToSelection({ bd: { b: "double" } }) },
          { label: "粗外框线", run: () => g.applyStyleToSelection({ bd: { t: "medium", r: "medium", b: "medium", l: "medium" } }) },
        ],
        [{ label: "无边框", run: () => g.applyStyleToSelection({ bd: none }) }],
      ];
    };

    const numberMenu = (): MenuEntry[][] => [
      NUMBER_FORMATS.map((f) => ({
        label: f.label,
        on: () => false,
        run: () => this.setNumberFormat(f.nf),
      })),
      SPECIAL_FORMATS.map((f) => ({
        label: f.label,
        run: () => this.setNumberFormat(f.nf),
      })),
      [{ label: "增加小数位", run: () => this.stepDecimals(1) }, { label: "减少小数位", run: () => this.stepDecimals(-1) }],
    ];

    const mergeMenu = (): MenuEntry[][] => [
      [
        {
          label: "合并后居中",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "merge", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
            g.applyStyleToSelection({ h: "c" });
          },
        },
        {
          label: "合并单元格",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "merge", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
          },
        },
      ],
      [
        {
          label: "取消合并",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "unmerge", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
          },
        },
      ],
    ];

    const clearMenu = (): MenuEntry[][] => [
      [
        { label: "清除内容", run: () => g.clearSelectionForRibbon() },
        { label: "清除格式", run: () => g.applyStyleToSelection({ b: false, i: false, u: false, bg: null, bd: { t: "none", r: "none", b: "none", l: "none" }, nf: 0 }) },
      ],
      [{ label: "全部清除", run: () => { g.clearSelectionForRibbon(); g.applyStyleToSelection({ b: false, i: false, u: false, bg: null, nf: 0 }); } }],
      [
        {
          label: "清除条件格式",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "clearCf", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
          },
        },
      ],
    ];

    const sumMenu = (): MenuEntry[][] => [
      (["SUM", "AVERAGE", "COUNT", "MAX", "MIN"] as Kind[]).map((kind) => ({
        label: { SUM: "求和", AVERAGE: "平均值", COUNT: "计数", MAX: "最大值", MIN: "最小值" }[kind],
        run: () => g.autoSum(kind),
      })),
    ];

    const sortMenu = (): MenuEntry[][] => [
      [
        {
          label: "升序",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "sort", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1, key: g.cursor.c, desc: false });
          },
        },
        {
          label: "降序",
          run: () => {
            const s = g.selectionBox;
            opts.struct?.({ t: "sort", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1, key: g.cursor.c, desc: true });
          },
        },
      ],
      [{ label: "筛选", run: () => this.filterFn?.(g.cursor.c, g.selectionText) }, { label: "清除筛选", run: () => this.filterFn?.(null, null) }],
    ];

    pane.append(
      this.grp("剪贴板", [
        this.disabled("粘贴", "用 Ctrl+V 粘贴（这里不读系统剪贴板）"),
        this.btn("复制", "复制选中区域", () => copy(false)),
        this.btn("剪切", "复制并清空选中区域", () => {
          copy(false);
          g.clearSelectionForRibbon();
        }),
        this.painterBtn(),
      ]),
      this.sep(),
      this.grp("字体", [
        this.selectFont(),
        this.selectSize(),
        this.btn("A−", "字号小一号", () => this.stepFont(-1)),
        this.btn("A+", "字号大一号", () => this.stepFont(1)),
        this.toggle("B", "加粗", () => g.applyStyleToSelection({ b: !g.activeStyle?.f?.b }), () => !!g.activeStyle?.f?.b),
        this.toggle("I", "斜体", () => g.applyStyleToSelection({ i: !g.activeStyle?.f?.i }), () => !!g.activeStyle?.f?.i),
        this.toggle("U", "下划线", () => g.applyStyleToSelection({ u: !g.activeStyle?.f?.u }), () => !!g.activeStyle?.f?.u),
        this.colorButton("A", "字色：红 / 黑 切换", "sd-rb-fc", () => g.applyStyleToSelection({ fc: g.activeStyle?.f?.c === "#C00000" ? "#000000" : "#C00000" }), fontColors),
        this.colorButton("▨", "填充：黄 / 无 切换", "sd-rb-bg", () => g.applyStyleToSelection({ bg: g.activeStyle?.bg === "#FFF2CC" ? null : "#FFF2CC" }), fillColors),
        this.borderButton(borderMenu),
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
        this.mergeButton(mergeMenu, opts),
      ]),
      this.sep(),
      this.grp("数字", [
        this.numberButton(numberMenu),
        this.btn("¥", "货币（两位小数）", () => this.setNumberFormat(4)),
        this.btn("%", "百分比", () => this.setNumberFormat(10)),
        this.btn("千分位", "千分位整数", () => this.setNumberFormat(3)),
        this.btn("0.0", "加一位小数", () => this.stepDecimals(1)),
        this.btn(".00", "减一位小数", () => this.stepDecimals(-1)),
      ]),
      this.sep(),
      this.grp("样式", [
        this.btn("清格式", "清除选中区域的条件格式", () => {
          const s = g.selectionBox;
          opts.struct?.({ t: "clearCf", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
        }),
      ]),
      this.sep(),
      this.grp("编辑", [
        this.dropdown("Σ 自动求和", "自动求和（点右侧箭头选别的函数）", "", sumMenu),
        this.dropdown("清除", "清除内容 / 格式 / 条件格式", "", clearMenu),
        this.dropdown("排序和筛选", "升序 / 降序 / 筛选", "", sortMenu),
        this.btn("撤销", "撤销 Ctrl+Z", () => g.undo()),
        this.btn("重做", "重做 Ctrl+Y", () => g.redo()),
        this.btn("查找", "查找 Ctrl+F", opts.find),
      ]),
    );
  }

  /** 合并/取消合并：主按钮保持「把选中区域合并成一格」，箭头里是 WPS 那三种。 */
  private mergeButton(build: () => MenuEntry[][], opts: { struct?: (op: SheetStructOp) => void }): HTMLElement {
    const g = this.grid;
    const box = el("span", "sd-rb-dd");
    const main = this.btn("合并", "把选中区域合并成一格", () => {
      const s = g.selectionBox;
      opts.struct?.({ t: "merge", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
    });
    const unmerge = this.btn("拆", "取消选中区域里的合并", () => {
      const s = g.selectionBox;
      opts.struct?.({ t: "unmerge", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1 });
    });
    const caret = el("button", "sd-rb-caret-b", "▾");
    caret.type = "button";
    caret.title = "合并后居中 / 合并单元格 / 取消合并";
    caret.onmousedown = (ev) => ev.preventDefault();
    caret.onclick = () => this.openMenu(box, build());
    box.append(main, unmerge, caret);
    return box;
  }

  /** 数字格式：主按钮是「常规」，箭头里是 WPS 那张完整列表 + 特殊格式。 */
  private numberButton(build: () => MenuEntry[][]): HTMLElement {
    const box = el("span", "sd-rb-dd");
    const main = this.btn("格式", "数字格式（点右侧箭头选具体格式）", () => this.setNumberFormat(0));
    const caret = el("button", "sd-rb-caret-b", "▾");
    caret.type = "button";
    caret.title = "数字格式";
    caret.onmousedown = (ev) => ev.preventDefault();
    caret.onclick = () => this.openMenu(box, build());
    box.append(main, caret);
    return box;
  }

  /**
   * 颜色按钮：主按钮沿用原来那颗「一按就切换」（黄底 / 红字），右侧箭头打开 WPS 那种色板。
   * 保留旧按钮的 title 是有意的——探针和用户的肌肉记忆都按它找。
   */
  private colorButton(label: string, title: string, cls: string, quick: () => void, build: () => MenuEntry[][]): HTMLElement {
    const box = el("span", "sd-rb-dd");
    const main = this.btn(label, title, quick, cls);
    const caret = el("button", "sd-rb-caret-b", "▾");
    caret.type = "button";
    caret.title = `${title}（选色）`;
    caret.onmousedown = (ev) => ev.preventDefault();
    caret.onclick = () => this.openMenu(box, build());
    box.append(main, caret);
    return box;
  }

  /** 应用一条数字格式（顺手记住它，供「加/减一位小数」用）。 */
  private setNumberFormat(nf: number | string): void {
    if (typeof nf === "string") this.lastCode = nf;
    else {
      const known: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 14: "m/d/yy", 20: "h:mm", 49: "@" };
      this.lastCode = known[nf] ?? "0.00";
    }
    this.grid.applyStyleToSelection({ nf });
  }

  /** 边框：主按钮铺满格子细边框，箭头里是单边 / 无边框 / 双底等。 */
  private borderButton(build: () => MenuEntry[][]): HTMLElement {
    const g = this.grid;
    const box = el("span", "sd-rb-dd");
    const main = this.btn("田", "给选区加细边框（四周 + 网格）", () => {
      g.applyStyleToSelection({ bd: { t: "thin", r: "thin", b: "thin", l: "thin" } });
    }, "sd-rb-bd");
    const caret = el("button", "sd-rb-caret-b", "▾");
    caret.type = "button";
    caret.title = "边框";
    caret.onmousedown = (ev) => ev.preventDefault();
    caret.onclick = () => this.openMenu(box, build());
    box.append(main, caret);
    return box;
  }

  /** 格式刷：按一下记住当前格的样子，下一次选区别处就刷上去。 */
  private painterBtn(): HTMLButtonElement {
    const node = this.btn("刷", "格式刷：先选一格有样子的，再选目标区域", () => {
      const style = this.grid.activeStyle;
      const patch = patchOf(style);
      if (!patch) return;
      if (this.painter) this.painter = null;
      else this.painter = { patch, from: this.grid.selectionRef };
    }, "sd-rb-painter");
    this.items.push({ node, state: () => !!this.painter });
    return node;
  }

  /** 上一次在功能区里选过的数字格式代码（用来算「加/减一位小数」的起点）。 */
  private lastCode = "0.00";

  /** 数字格式的小数位加减：在上一版代码上多写/少写一个 0。 */
  private stepDecimals(delta: number): void {
    const m = /^(.*?)(0)(\.(0+))?$/.exec(this.lastCode) ?? /^(.*?)(0)(\.(0+))?$/.exec("0.00");
    const head = m?.[1] ?? "";
    const frac = m?.[4] ?? "00";
    const next = Math.max(0, Math.min(8, frac.length + delta));
    const code = `${head}0${next ? `.${"0".repeat(next)}` : ""}`;
    this.lastCode = code;
    this.grid.applyStyleToSelection({ nf: code });
  }

  /** 字体名：真下拉，选项 = 这份表用到的字体 + 常见字体。 */
  private selectFont(): HTMLElement {
    const box = el("select", "sd-rb-sel sd-rb-fname");
    box.title = "字体";
    const current = (): string => this.grid.activeStyle?.f?.n ?? "Calibri";
    const fill = (): void => {
      const used = (this.grid.meta.styles ?? []).map((s) => s.f?.n).filter((x): x is string => !!x);
      const common = ["Calibri", "Arial", "Times New Roman", "宋体", "微软雅黑", "等线", "黑体", "楷体"];
      const names = [...new Set([current(), ...used, ...common])];
      box.replaceChildren(...names.map((n) => {
        const opt = el("option", "", n);
        opt.value = n;
        return opt;
      }));
    };
    fill();
    this.items.push({
      node: box,
      refresh: () => {
        const v = current();
        if (![...box.options].some((o) => o.value === v)) fill();
        if (box.value !== v) box.value = v;
      },
    });
    box.onchange = () => this.grid.applyStyleToSelection({ fn: box.value });
    return box;
  }

  /** 字号：真下拉（WPS 的常用档位）。 */
  private selectSize(): HTMLElement {
    const box = el("select", "sd-rb-sel sd-rb-fsize");
    box.title = "字号";
    const current = (): string => String(this.grid.activeStyle?.f?.s ?? 11);
    const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48];
    this.items.push({
      node: box,
      refresh: () => {
        const v = current();
        const all = [...new Set([...sizes.map(String), v])].sort((a, b) => Number(a) - Number(b));
        if (box.options.length !== all.length) {
          box.replaceChildren(...all.map((n) => {
            const opt = el("option", "", n);
            opt.value = n;
            return opt;
          }));
        }
        if (box.value !== v) box.value = v;
      },
    });
    box.onchange = () => this.grid.applyStyleToSelection({ fs: Number(box.value) });
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
      this.grp("行和列", [
        this.btn("插入行", "在当前行上方插入一行", () => this.structFn?.({ t: "insRow", at: g.cursor.r, n: 1 })),
        this.btn("插入列", "在当前列左侧插入一列", () => this.structFn?.({ t: "insCol", at: g.cursor.c, n: 1 })),
        this.btn("删除行", "删掉当前这一行", () => this.structFn?.({ t: "delRow", at: g.cursor.r, n: 1 })),
        this.btn("删除列", "删掉当前这一列", () => this.structFn?.({ t: "delCol", at: g.cursor.c, n: 1 })),
      ]),
      this.sep(),
      this.grp("插图", [
        this.disabled("图片", "内置图片是只读显示的，暂不支持插新图"),
        this.disabled("图表", "文件里已有的图表是只读显示的，暂不支持插新图"),
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
    const libs = FUNCTION_LIBRARY.map((cat) =>
      this.dropdown(cat.label, `${cat.label}函数`, "sd-rb-fn", () => [
        cat.fns.map((name) => ({
          label: name,
          run: () => this.insertFn(name),
        })),
      ]),
    );
    pane.append(
      this.grp("函数库", libs),
      this.sep(),
      this.grp("自动求和", [fn("SUM", "自动求和"), fn("AVERAGE", "平均值"), fn("COUNT", "计数"), fn("MAX", "最大值"), fn("MIN", "最小值")]),
      this.sep(),
      this.grp("显示", [
        this.toggle("显示公式", "格子里显示 =公式 原文", () => g.setShowFormulas(!g.formulasShown), () => g.formulasShown),
        this.btn("查找", "找公式或文字", opts.find),
      ]),
    );
  }

  /** 从函数库点一个函数：`=SUM(` 直接进公式栏 / 正在编辑的格子。 */
  private insertFn(name: string): void {
    const text = `=${name}(`;
    if (this.onInsertFormula) this.onInsertFormula(text);
    else this.grid.writeAt(text);
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
        this.btn("冻结首行", "第一行不动", () => g.setFreeze({ rows: 1, cols: 0 })),
        this.btn("冻结首列", "第一列不动", () => g.setFreeze({ rows: 0, cols: 1 })),
        this.btn("取消冻结", "回到文件里的冻结设置", () => g.setFreeze(null)),
      ]),
      this.sep(),
      this.grp("排序和筛选", [
        this.btn("升序", "按当前列把选中区域从小到大排", () => {
          const s = g.selectionBox;
          this.structFn?.({ t: "sort", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1, key: g.cursor.c, desc: false });
        }),
        this.btn("降序", "按当前列把选中区域从大到小排", () => {
          const s = g.selectionBox;
          this.structFn?.({ t: "sort", r1: s.r0, c1: s.c0, r2: s.r1, c2: s.c1, key: g.cursor.c, desc: true });
        }),
        this.btn("筛选", "只显示当前列里和这格相同的行", () => this.filterFn?.(g.cursor.c, g.selectionText)),
        this.btn("清除筛选", "把筛选出来的行都放回来", () => this.filterFn?.(null, null)),
      ]),
      this.sep(),
      this.grp("编辑", [this.btn("查找", "查找 Ctrl+F", opts.find)]),
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
        this.btn("冻结首行", "第一行不动", () => g.setFreeze({ rows: 1, cols: 0 })),
        this.btn("冻结首列", "第一列不动", () => g.setFreeze({ rows: 0, cols: 1 })),
        this.btn("取消冻结", "回到文件里的冻结设置", () => g.setFreeze(null)),
        this.btn("−", "缩小", () => this.zoom(-0.1)),
        this.btn("+", "放大", () => this.zoom(0.1)),
      ]),
    );
  }
}

/** 把「这格现在的样子」翻成一条样式补丁（格式刷用）。 */
function patchOf(style: SheetStyle | undefined): SheetStylePatch | null {
  if (!style) return null;
  const patch: SheetStylePatch = {};
  if (style.f) {
    patch.b = !!style.f.b;
    patch.i = !!style.f.i;
    patch.u = !!style.f.u;
    if (style.f.n) patch.fn = style.f.n;
    if (style.f.s) patch.fs = style.f.s;
    if (style.f.c) patch.fc = style.f.c;
  }
  patch.bg = style.bg ?? null;
  if (style.h === "l" || style.h === "c" || style.h === "r") patch.h = style.h;
  if (style.v === "t" || style.v === "m" || style.v === "b") patch.v = style.v;
  if (style.w) patch.w = true;
  return patch;
}
// i18n-ignore-end
