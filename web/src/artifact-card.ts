/**
 * 这一轮写过的产物，收成一张卡（D354）。
 *
 * 以前每个文件一行芯片（图标 / 名字 / 引用 / 打开），一次重构能写八十几个文件，聊天框里
 * 于是铺开三四行药丸，动作比文件名还显眼。现在一轮只有一张卡：收起时一行（一叠纸 +
 * 件数 + 类型小结 + 最近两个名字），点开在同一个位置长出按类型分组的网格；「引用 / 打开」
 * 藏到悬停或键盘聚焦时才浮出来。图形与尺寸来自样张
 * `.scratch/artifact-card/prototype/a-stack.html`。
 *
 * 卡片只管**这一轮**写过的文件；整场会话的产物仍在顶栏「产物」面板里（D208）。
 */
import { tr } from "./i18n/index.ts";

interface Kind {
  id: string;
  /** 分组标题，同时是 i18n 的键。 */
  label: string;
  /** 类型块的底色。 */
  color: string;
  exts: string[];
}

const KINDS: Kind[] = [
  { id: "style", label: "样式", color: "#2f7cf6", exts: ["css", "scss", "sass", "less", "styl"] },
  {
    id: "script",
    label: "脚本",
    color: "#3178c6",
    exts: [
      "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh", "bash", "zsh", "ps1", "go", "rs",
      "java", "kt", "c", "h", "cc", "cpp", "hpp", "rb", "php", "swift", "lua", "sql",
    ],
  },
  { id: "page", label: "页面", color: "#ff9f0a", exts: ["html", "htm", "vue", "svelte", "astro"] },
  {
    id: "image",
    label: "图片",
    color: "#af52de",
    exts: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif", "heic", "pdf"],
  },
  {
    id: "doc",
    label: "文档",
    color: "#8e8e93",
    exts: ["md", "markdown", "mdx", "txt", "doc", "docx", "rtf", "adoc"],
  },
  {
    id: "data",
    label: "数据",
    color: "#34c759",
    exts: ["json", "jsonl", "yaml", "yml", "toml", "csv", "tsv", "xls", "xlsx", "db", "sqlite"],
  },
];
const OTHER: Kind = { id: "other", label: "其他", color: "#636366", exts: [] };

/** 类型块上的字：太长的扩展名换成更好认的写法。 */
const BADGE: Record<string, string> = {
  json: "{}",
  jsonl: "{}",
  yaml: "YML",
  yml: "YML",
  toml: "TML",
  markdown: "MD",
  mdx: "MDX",
  jpeg: "JPG",
  webp: "WEBP",
  svg: "SVG",
  html: "HTML",
  tsx: "TSX",
  jsx: "JSX",
};

/** 一张卡最多画几块；再多就交给「产物」面板，别把聊天记录撑成一面墙。 */
const MAX_TILES = 12;

export interface TurnArtifact {
  path: string;
  writes: number;
}

interface CardState {
  items: TurnArtifact[];
  open: boolean;
  onOpenPanel: () => void;
}

const STATE = new WeakMap<HTMLElement, CardState>();
let seq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function extOf(p: string): string {
  const name = baseName(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindOf(p: string): Kind {
  const ext = extOf(p);
  return KINDS.find((k) => k.exts.includes(ext)) ?? OTHER;
}

function badgeOf(p: string): string {
  const ext = extOf(p);
  if (!ext) return "FILE";
  return BADGE[ext] ?? ext.toUpperCase().slice(0, 3);
}

/** 按类型分组，组序 = 首次出现序。扇形、小结、展开网格都吃这一份。 */
function groupByKind(items: TurnArtifact[]): { kind: Kind; items: TurnArtifact[] }[] {
  const groups: { kind: Kind; items: TurnArtifact[] }[] = [];
  for (const item of items) {
    const k = kindOf(item.path);
    const hit = groups.find((g) => g.kind.id === k.id);
    if (hit) hit.items.push(item);
    else groups.push({ kind: k, items: [item] });
  }
  return groups;
}

/** 收起态左边那叠纸：每种类型一张，最多三张，颜色一眼看出「这轮动了什么」。 */
function fan(items: TurnArtifact[]): HTMLElement {
  const wrap = el("span", "ac-fan");
  const kinds = groupByKind(items).slice(0, 3).map((g) => g.kind);
  if (!kinds.length) kinds.push(OTHER);
  wrap.classList.toggle("is-stack", kinds.length > 1);
  for (const k of kinds) {
    const sheet = el("i", "ac-sheet");
    sheet.style.setProperty("--c", k.color);
    wrap.append(sheet);
  }
  return wrap;
}

/** 「样式 3 · 脚本 9」：数的是全部条目，和标题的件数同一口径。 */
function summary(items: TurnArtifact[]): string {
  return groupByKind(items)
    .map((g) => `${tr(g.kind.label)} ${g.items.length}`)
    .join(" · ");
}

function actButton(text: string, title: string, cls: string, onclick: () => void): HTMLButtonElement {
  const btn = el("button", `ac-act${cls ? ` ${cls}` : ""}`, text) as HTMLButtonElement;
  btn.type = "button";
  btn.title = title;
  btn.onclick = onclick;
  return btn;
}

function tile(item: TurnArtifact): HTMLElement {
  const k = kindOf(item.path);
  const box = el("div", "ac-tile");
  box.dataset.path = item.path;
  // 写了几次只进悬停提示：格子上再挤一列数字就认不出文件名了。
  box.title = item.writes > 1 ? `${item.path} ×${item.writes}` : item.path;
  const badge = el("span", "ac-badge", badgeOf(item.path));
  badge.style.setProperty("--c", k.color);
  const quote = actButton(tr("引用"), tr("把路径引用到输入框"), "quote", () => {
    window.dispatchEvent(new CustomEvent("pi-quote", { detail: { path: item.path } }));
  });
  const open = actButton(tr("打开"), tr("在预览里打开"), "", () => {
    window.dispatchEvent(new CustomEvent("pi-preview", { detail: { path: item.path } }));
  });
  const acts = el("span", "ac-acts");
  acts.append(quote, open);
  box.append(badge, el("span", "ac-nm", baseName(item.path)), acts);
  return box;
}

/** 键盘焦点落在卡里的哪个位置：头部，还是某一块的「引用 / 打开」。 */
function focusedSlot(card: HTMLElement): { path: string; act: string } | "head" | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !card.contains(active)) return null;
  if (active.classList.contains("artcard-head")) return "head";
  const box = active.closest<HTMLElement>(".ac-tile");
  if (!box?.dataset.path || !active.classList.contains("ac-act")) return null;
  return { path: box.dataset.path, act: active.classList.contains("quote") ? "quote" : "open" };
}

function restoreFocus(card: HTMLElement, slot: { path: string; act: string }): void {
  const box = [...card.querySelectorAll<HTMLElement>(".ac-tile")].find((t) => t.dataset.path === slot.path);
  const btn = box?.querySelector<HTMLButtonElement>(slot.act === "quote" ? ".ac-act.quote" : ".ac-acts .ac-act:not(.quote)");
  btn?.focus({ preventScroll: true });
}

function paint(card: HTMLElement): void {
  const st = STATE.get(card);
  if (!st) return;
  const total = st.items.length;
  // 卡片最多画 MAX_TILES 块：标题与小结都数全部条目，画不下的那些交给脚注和产物面板。
  const shown = st.items.slice(0, MAX_TILES);
  const id = card.dataset.body ?? "";

  const head = el("button", "artcard-head") as HTMLButtonElement;
  head.type = "button";
  head.setAttribute("aria-expanded", st.open ? "true" : "false");
  head.setAttribute("aria-controls", id);
  const body = el("div", "ac-body");
  body.id = id;
  const setOpen = (open: boolean) => {
    st.open = open;
    card.dataset.open = open ? "1" : "0";
    head.setAttribute("aria-expanded", String(open));
    // 收起时身体只剩一条 0fr 的轨道，里面的按钮仍会进 Tab 序：inert 一起关掉。
    body.inert = !open;
  };
  head.onclick = () => setOpen(!st.open);

  const main = el("span", "ac-main");
  main.append(
    el("b", "ac-title", tr("{p1} 个产物", { p1: String(total) })),
    el("span", "ac-sub", summary(st.items)),
  );
  const recent = el("span", "ac-recent");
  const last = st.items.slice(Math.max(0, total - 2)).reverse().map((i) => baseName(i.path));
  if (last.length) recent.textContent = tr("最近 {p1}", { p1: last.join(tr("、")) });
  head.append(fan(st.items), main, recent, el("span", "ac-chev"));

  const inner = el("div", "ac-inner");
  for (const g of groupByKind(shown)) {
    const row = el("div", "ac-group");
    const label = el("div", "ac-gl");
    label.append(el("b", undefined, tr(g.kind.label)), el("span", undefined, String(g.items.length)));
    const grid = el("div", "ac-grid");
    for (const item of g.items) grid.append(tile(item));
    row.append(label, grid);
    inner.append(row);
  }
  if (total > MAX_TILES) {
    const more = el("div", "ac-more");
    const jump = el("button", "ac-link", tr("在产物面板中打开")) as HTMLButtonElement;
    jump.type = "button";
    jump.onclick = () => st.onOpenPanel();
    more.append(el("span", undefined, tr("还有 {p1} 个", { p1: String(total - MAX_TILES) })), jump);
    inner.append(more);
  }

  // 收起时那行 0fr 只压扁 .ac-clip；inner 自己带内边距，留在里面被裁掉才不会撑出几像素。
  const clip = el("div", "ac-clip");
  clip.append(inner);
  body.append(clip);
  const keep = focusedSlot(card);
  body.inert = !st.open;
  card.replaceChildren(head, body);
  // 重画会换掉整棵子树：正在键盘上走动的那个按钮按路径接回来。
  if (keep === "head") head.focus({ preventScroll: true });
  else if (keep) restoreFocus(card, keep);
}

/** 一轮一张卡；`onOpenPanel` 用来把「还有 N 个」交回产物面板。 */
export function createArtifactCard(onOpenPanel: () => void): HTMLElement {
  const card = el("section", "artcard");
  card.dataset.open = "0";
  card.dataset.body = `artcard-body-${++seq}`;
  STATE.set(card, { items: [], open: false, onOpenPanel });
  paint(card);
  return card;
}

/**
 * 记一次写入。同一路径再写只加次数 —— 卡片靠类型与件数讲话，不逐行报工具。
 * 重写也会重画：分组与件数不变，但「最近」、「还有 N 个」和悬停提示里的次数会变。
 */
export function addTurnArtifact(card: HTMLElement, path: string): void {
  const st = STATE.get(card);
  if (!st) return;
  const hit = st.items.find((i) => i.path === path);
  if (hit) hit.writes += 1;
  else st.items.push({ path, writes: 1 });
  paint(card);
}
