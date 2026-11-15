/**
 * 插件市场：照本机 DeepSeek Harness 的 dshmarket 1.73.19「发现」页重画的界面。
 *
 * 逆向来源（可复核）：
 * - `~/.dsh/profiles/desktop/node_modules/dshmarket/client/client.js`（Market.module.css，
 *   类名前缀 `nUhMVa_`，482 条规则）。关键几何：1440×900 宿主里内容宽 960，三列卡片各
 *   310.66px（列距 10），卡片圆角 20、内边距 12/14、标题 14/20·500、正文 12/18、标签 11/17；
 *   搜索框高 32、圆角 12；内层页签高 32、字号 13/20；最近收录横条每张 80px 高。
 * - REA 6.9.0 `analyze-javascript-application` 对 client.js 的静态分析（Evidence 在
 *   `/tmp/dshmarket-rea`，47.8 MB）确认了 Masonry 的列数公式与卡片字段。
 *
 * 这里是 pi 的商店数据，不是 DSH 的目录：卡片上的「未声明 pi 要求」「评论」「收藏」都按
 * pi 包的真实能力落，不伪造 DSH 的下载量 / star / 宿主要求。视觉与交互照 dshmarket。
 */
import { tr } from "./i18n/index.ts";
import { createEl as el } from "./chat.ts";

export type MarketTab = "discover" | "themes" | "favorites" | "installed" | "blocked" | "advanced";
export type MarketSort = "downloads" | "published" | "name";
export type MarketDir = "desc" | "asc";

export interface MarketPackage {
  name: string;
  version: string;
  description: string;
  monthly: number;
  weekly: number;
  link: string;
  publisher: string | null;
  owner?: string | null;
  repository?: string | null;
  homepage?: string | null;
  published?: number;
  keywords?: string[];
}

export interface MarketOp {
  key: string;
  op: string;
  state: "queued" | "running";
}

export interface MarketViewState {
  tab: MarketTab;
  query: string;
  category: string;
  sort: MarketSort;
  dir: MarketDir;
  onlyInstalled: boolean;
  items: MarketPackage[] | null;
  error: string | null;
  loading: boolean;
  installed: Set<string>;
  favorites: Set<string>;
  blocked: Set<string>;
  visible: number;
  scope: "global" | "project";
  canProject: boolean;
  readOnly: boolean;
  updates: number;
  ops: MarketOp[];
  recentHidden: boolean;
}

export interface MarketActions {
  onTab(tab: MarketTab): void;
  onQuery(query: string): void;
  onCategory(category: string): void;
  onSort(sort: MarketSort, dir: MarketDir): void;
  onOnlyInstalled(only: boolean): void;
  onVisible(n: number): void;
  onInstall(pkg: MarketPackage): void;
  onToggleFavorite(name: string): void;
  onToggleBlock(name: string): void;
  onOpenInstalled(): void;
  onRefresh(): void;
  onScope(scope: "global" | "project"): void;
  onInstallSource(source: string): void;
  onExportLog(): void;
  onToggleRecent(hidden: boolean): void;
  onUnblock(name: string): void;
}

export const FAVORITES_KEY = "pi.pluginMarket.favorites";
export const BLOCKED_KEY = "pi.pluginMarket.blocked";
export const RECENT_HIDDEN_KEY = "pi.pluginMarket.recentHidden";

/** Read a persisted name set; bad JSON is an empty set, never a crash. */
export function loadMarketSet(key: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.map(String).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

export function saveMarketSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // Private mode / quota: the UI still works for this tab.
  }
}

/** 1.2m / 3257.3k / 483.9k — dshmarket's own short scale. */
export function formatCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(v));
}

interface CategoryDef {
  id: string;
  label: string;
  keywords: string[];
  text?: RegExp;
}

/** Category ids are stable (used by filters / localStorage); labels go through tr(). */
export const CATEGORY_DEFS: CategoryDef[] = [
  {
    id: "context",
    label: "上下文与记忆",
    keywords: ["context", "memory", "compact", "compression", "compress", "history", "session", "recall", "token-saving", "summarize"],
    text: /上下文|记忆|压缩|摘要|会话历史/i,
  },
  {
    id: "tools",
    label: "工具与能力",
    keywords: ["mcp", "tool", "tools", "search", "web-search", "browser", "terminal", "computer-use", "vision", "image", "skill", "skills", "sandbox", "exec", "shell", "code-search"],
    text: /工具|搜索|浏览器|终端|技能|视觉|图片|沙箱/i,
  },
  {
    id: "model",
    label: "模型与账号接入",
    keywords: ["provider", "model-provider", "openrouter", "ollama", "oauth", "auth", "usage", "billing", "gateway"],
    text: /模型接入|模型提供|provider|账号接入|登录|计费|用量统计|网关/i,
  },
  {
    id: "ui",
    label: "界面与主题",
    keywords: ["ui", "tui", "theme", "skin", "appearance", "statusline", "status-line", "sidebar", "notification", "layout", "render", "design", "font"],
    text: /主题|皮肤|界面|侧栏|通知|状态栏|字体|外观/i,
  },
  {
    id: "workflow",
    label: "工作流与自动化",
    keywords: ["workflow", "automation", "subagent", "subagents", "agent", "agents", "orchestration", "multi-agent", "task", "todo", "goal", "review", "code-review", "planning", "parallel", "team"],
    text: /工作流|自动化|子代理|智能体|任务|计划|评审|并行/i,
  },
  {
    id: "dev",
    label: "开发与运行时",
    keywords: ["runtime", "native-runtime", "developer-tools", "build", "compiler", "debug", "lint", "test", "types", "sdk"],
    text: /开发工具|运行时|编译|构建|调试|测试|代码质量/i,
  },
  {
    id: "security",
    label: "安全与权限",
    keywords: ["security", "permission", "approval", "guard", "audit", "secret", "safety", "escape"],
    text: /安全|权限|审批|审计|密钥/i,
  },
  {
    id: "other",
    label: "其他",
    keywords: [],
  },
];

const CATEGORY_BY_ID = new Map(CATEGORY_DEFS.map((c) => [c.id, c]));

/** The category chips to show at the top; all categories are kept, like dshmarket. */
export function categoryLabel(id: string): string {
  const def = CATEGORY_BY_ID.get(id);
  return def ? tr(def.label) : id;
}

/**
 * Which categories a pi package belongs to. Keyword hits win first (they are the author's own
 * labels), then a description/name regex catches packages that did not tag themselves. At most two
 * chip per card, and never an empty list.
 */
export function categoriesOf(pkg: MarketPackage): string[] {
  const kw = new Set((pkg.keywords ?? []).map((k) => k.toLowerCase()));
  const text = `${pkg.name} ${pkg.description}`;
  const hits: string[] = [];
  for (const def of CATEGORY_DEFS) {
    if (def.id === "other") continue;
    let hit = def.keywords.some((k) => kw.has(k));
    if (!hit && def.text) hit = def.text.test(text);
    if (hit) {
      hits.push(def.id);
      break;
    }
  }
  return hits.length ? hits : ["other"];
}

export function sortPackages(items: MarketPackage[], sort: MarketSort, dir: MarketDir): MarketPackage[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (sort === "name") return mul * a.name.localeCompare(b.name);
    if (sort === "published") return mul * ((a.published ?? 0) - (b.published ?? 0));
    return mul * (a.monthly - b.monthly) || a.name.localeCompare(b.name);
  });
}

export function filterPackages(items: MarketPackage[], category: string, onlyInstalled: boolean, installed: Set<string>, blocked: Set<string> = new Set()): MarketPackage[] {
  let list = items.filter((p) => !blocked.has(p.name));
  if (category !== "all") list = list.filter((p) => categoriesOf(p).includes(category));
  if (onlyInstalled) list = list.filter((p) => installed.has(p.name));
  return list;
}

/** Deal items alternately into N columns, like dshmarket's Masonry. */
export function distributeColumns<T>(items: T[], columns: number): T[][] {
  const n = Math.max(1, Math.floor(columns) || 1);
  const buckets: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => buckets[i % n].push(item));
  return buckets;
}

/** dshmarket's own formula: 2 columns normally, a third once every column can hold a full card. */
export function masonryColumns(width: number): number {
  if (width <= 680) return 1;
  return Math.min(3, Math.max(2, Math.floor((width + 10) / 290)));
}

// ------------------------------------------------------------------ icons

const NS = "http://www.w3.org/2000/svg";

function svgIcon(path: string, size = 14, viewBox = "0 0 16 16", fill = "none", extra?: (svg: SVGSVGElement) => void): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", fill === "none" ? "currentColor" : "none");
  svg.setAttribute("stroke-width", "1.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", path);
  svg.append(p);
  extra?.(svg);
  return svg;
}

const ICON = {
  search: "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586ZM10.2991 10.3933L14.7783 14.8725",
  chevron: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6",
  chevronRight: "M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4",
  download: "M8 1.95317V10.0469M4.25 6.29688L8 10.0469L11.75 6.29688M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469",
  bookmark: "M4 1.5h8a1 1 0 0 1 1 1v11.8a.5.5 0 0 1-.78.41L8 12.2 3.78 14.71A.5.5 0 0 1 3 14.3V2.5a1 1 0 0 1 1-1z",
};

function repoMark(): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute(
    "d",
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z",
  );
  svg.append(p);
  return svg;
}

// ------------------------------------------------------------------ masonry

const masonryRegistry = new Set<HTMLElement>();
let masonryObserver: ResizeObserver | null = null;

function resetMasonry(): void {
  if (masonryObserver) for (const node of masonryRegistry) masonryObserver.unobserve(node);
  masonryRegistry.clear();
}

function layoutMasonry(wrap: HTMLElement, items: MarketPackage[], render: (pkg: MarketPackage) => HTMLElement): void {
  const width = wrap.clientWidth;
  const columns = masonryColumns(width);
  const buckets = distributeColumns(items, columns);
  wrap.replaceChildren();
  for (const bucket of buckets) {
    const col = el("div", "pm-masonry-col");
    for (const pkg of bucket) col.append(render(pkg));
    wrap.append(col);
  }
  wrap.dataset.columns = String(columns);
}

function mountMasonry(wrap: HTMLElement, items: MarketPackage[], render: (pkg: MarketPackage) => HTMLElement): void {
  const relayout = () => {
    if (!wrap.isConnected) return;
    const width = wrap.clientWidth;
    if (width <= 0) return;
    const columns = masonryColumns(width);
    if (wrap.dataset.columns === String(columns)) return;
    layoutMasonry(wrap, items, render);
  };
  layoutMasonry(wrap, items, render);
  if (typeof ResizeObserver !== "undefined") {
    if (!masonryObserver) masonryObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const anyNode = node as HTMLElement & { __pmRelayout?: () => void };
        anyNode.__pmRelayout?.();
      }
    });
    (wrap as HTMLElement & { __pmRelayout?: () => void }).__pmRelayout = relayout;
    masonryObserver.observe(wrap);
    masonryRegistry.add(wrap);
  }
  // The first paint can happen before the sheet has its final width.
  requestAnimationFrame(relayout);
}

// ------------------------------------------------------------------ rendering

function emptyBlock(text: string, extra?: HTMLElement): HTMLElement {
  const box = el("div", "pm-empty");
  box.append(el("div", "pm-empty-text", text));
  if (extra) box.append(extra);
  return box;
}

function pill(label: string, active: boolean, onclick: () => void): HTMLButtonElement {
  const b = el("button", `pm-pill${active ? " on" : ""}`, label) as HTMLButtonElement;
  b.type = "button";
  b.onclick = onclick;
  return b;
}

function installButton(pkg: MarketPackage, state: MarketViewState, actions: MarketActions, compact = false): HTMLElement {
  const busy = state.ops.some((op) => op.key === `install:${pkg.name}`);
  if (state.installed.has(pkg.name)) {
    const ok = el("span", "pm-ok", "✓ ");
    ok.append(document.createTextNode(tr("已安装")));
    return ok;
  }
  const b = el("button", `pm-install${compact ? " compact" : ""}`, busy ? tr("安装中…") : tr("安装")) as HTMLButtonElement;
  b.type = "button";
  b.disabled = state.readOnly || busy;
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    actions.onInstall(pkg);
  };
  return b;
}

function avatar(pkg: MarketPackage): HTMLElement {
  const owner = pkg.owner || pkg.publisher || "";
  const box = el("span", "pm-av");
  if (owner) {
    const img = el("img", "") as HTMLImageElement;
    img.src = `https://github.com/${encodeURIComponent(owner)}?size=96`;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => {
      img.remove();
      box.textContent = owner.slice(0, 1).toUpperCase();
    };
    box.append(img);
    box.title = owner;
  } else {
    box.textContent = (pkg.name.split("/").pop() || "?").slice(0, 1).toUpperCase();
  }
  return box;
}

function moreMenu(pkg: MarketPackage, state: MarketViewState, actions: MarketActions): HTMLDetailsElement {
  const details = el("details", "pm-more") as HTMLDetailsElement;
  const summary = el("summary", "", "···");
  summary.title = tr("更多");
  const menu = el("div", "pm-menu");
  const blocked = state.blocked.has(pkg.name);
  const blockBtn = el("button", "", blocked ? tr("取消屏蔽") : tr("屏蔽")) as HTMLButtonElement;
  blockBtn.type = "button";
  blockBtn.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    details.open = false;
    actions.onToggleBlock(pkg.name);
  };
  const open = el("a", "", tr("在 npm 上查看")) as HTMLAnchorElement;
  open.href = pkg.link;
  open.target = "_blank";
  open.rel = "noopener";
  menu.append(blockBtn, open);
  details.append(summary, menu);
  return details;
}

function tag(text: string): HTMLElement {
  return el("span", "pm-tag", text);
}

function marketCard(pkg: MarketPackage, state: MarketViewState, actions: MarketActions): HTMLElement {
  const card = el("article", "pm-card");
  const row1 = el("div", "pm-row1");
  const main = el("div", "pm-card-main");
  const titleLine = el("div", "pm-title-line");
  const name = el("a", "pm-name", pkg.name) as HTMLAnchorElement;
  name.href = pkg.link;
  name.target = "_blank";
  name.rel = "noopener";
  name.title = pkg.name;
  titleLine.append(name);
  if (pkg.repository) titleLine.append(repoMark());
  main.append(titleLine);

  const byline = el("div", "pm-byline");
  byline.append(avatar(pkg));
  if (pkg.owner || pkg.publisher) byline.append(el("span", "pm-owner", pkg.owner || pkg.publisher || ""));
  if (pkg.version) byline.append(el("span", "pm-meta", `· v${pkg.version}`));
  if (pkg.monthly > 0) byline.append(el("span", "pm-meta", `· ↓ ${formatCount(pkg.monthly)}`));
  main.append(byline);
  const action = el("div", "pm-card-action");
  action.append(installButton(pkg, state, actions));
  row1.append(main, el("div", "pm-grow"), action);
  card.append(row1);

  const desc = el("div", "pm-desc", pkg.description || tr("（没有描述）"));
  desc.title = pkg.description || "";
  card.append(desc);

  const foot = el("div", "pm-foot");
  const tags = el("div", "pm-tags");
  tags.append(el("span", "pm-req", tr("未声明 pi 要求")));
  for (const id of categoriesOf(pkg)) tags.append(tag(categoryLabel(id)));
  foot.append(tags);

  const acts = el("div", "pm-foot-actions");
  const fav = el("button", `pm-fav${state.favorites.has(pkg.name) ? " on" : ""}`) as HTMLButtonElement;
  fav.type = "button";
  fav.title = state.favorites.has(pkg.name) ? tr("取消收藏") : tr("加入收藏");
  fav.setAttribute("aria-pressed", String(state.favorites.has(pkg.name)));
  fav.append(svgIcon(ICON.bookmark, 14));
  fav.onclick = () => actions.onToggleFavorite(pkg.name);
  const comments = el("button", "pm-comments", tr("评论")) as HTMLButtonElement;
  comments.type = "button";
  comments.title = tr("在 npm 上查看这个插件");
  comments.onclick = () => window.open(pkg.link, "_blank", "noopener");
  acts.append(fav, comments, moreMenu(pkg, state, actions));
  foot.append(acts);
  card.append(foot);
  return card;
}

function recentTile(pkg: MarketPackage, state: MarketViewState, actions: MarketActions): HTMLElement {
  const tile = el("div", "pm-recent-tile");
  const top = el("div", "pm-recent-top");
  const av = avatar(pkg);
  av.classList.add("pm-recent-av");
  const nameBox = el("div", "pm-recent-name");
  const name = el("a", "pm-name", pkg.name) as HTMLAnchorElement;
  name.href = pkg.link;
  name.target = "_blank";
  name.rel = "noopener";
  name.title = pkg.name;
  nameBox.append(name);
  top.append(av, nameBox, installButton(pkg, state, actions, true));
  tile.append(top);
  const bottom = el("div", "pm-recent-bottom");
  bottom.append(el("p", "pm-recent-desc", pkg.description || ""));
  bottom.append(moreMenu(pkg, state, actions));
  tile.append(bottom);
  return tile;
}

function themeCard(pkg: MarketPackage, state: MarketViewState, actions: MarketActions): HTMLElement {
  const card = el("article", "pm-theme-card");
  const cover = el("div", "pm-theme-cover");
  // Deterministic swatch from the package name; dshmarket uses the plugin's real screenshots.
  let h = 0;
  for (const ch of pkg.name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  cover.style.background = `linear-gradient(135deg, hsl(${hue} 32% 24%), hsl(${(hue + 42) % 360} 38% 16%))`;
  const swatches = el("div", "pm-swatches");
  for (const d of [0, 18, 36]) {
    const i = el("i", "");
    i.style.background = `hsl(${(hue + d) % 360} 46% 52%)`;
    swatches.append(i);
  }
  cover.append(swatches, el("span", "pm-theme-preview", tr("预览")));
  card.append(cover);
  const body = el("div", "pm-theme-body");
  const head = el("div", "pm-theme-head");
  const title = el("a", "pm-name", pkg.name) as HTMLAnchorElement;
  title.href = pkg.link;
  title.target = "_blank";
  title.rel = "noopener";
  head.append(title);
  if (pkg.repository) head.append(repoMark());
  head.append(el("span", "pm-grow"), installButton(pkg, state, actions, true));
  body.append(head);
  const byline = el("div", "pm-byline");
  byline.append(el("span", "pm-owner", pkg.owner || pkg.publisher || ""));
  if (pkg.version) byline.append(el("span", "pm-meta", `· v${pkg.version}`));
  if (pkg.monthly > 0) byline.append(el("span", "pm-meta", `· ↓ ${formatCount(pkg.monthly)}`));
  body.append(byline);
  body.append(el("p", "pm-theme-desc", pkg.description || ""));
  card.append(body);
  return card;
}

function statusLine(state: MarketViewState): HTMLElement {
  const line = el("div", "pm-note");
  if (state.error) line.append(el("span", "pm-note-bad", state.error));
  else if (state.items) {
    if (state.loading) line.append(el("span", "pm-spin"), el("span", "", tr("正在刷新插件目录…")));
    else line.append(el("span", "", tr("目录来自 npm（keywords:pi-package），按月下载量排序；搜索走 npm。")));
  }
  return line;
}

function searchRow(state: MarketViewState, actions: MarketActions): HTMLElement {
  const row = el("div", "pm-search-row");
  const field = el("label", "pm-search");
  field.append(svgIcon(ICON.search, 14));
  const input = el("input", "") as HTMLInputElement;
  input.placeholder = tr("搜索插件，例如：通知、终端、记忆…");
  input.value = state.query;
  input.spellcheck = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  input.oninput = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => actions.onQuery(input.value), 300);
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      if (timer) clearTimeout(timer);
      actions.onQuery(input.value);
    }
  };
  field.append(input);
  if (state.query) {
    const clear = el("button", "pm-search-clear", "×") as HTMLButtonElement;
    clear.type = "button";
    clear.title = tr("清除搜索");
    clear.onclick = () => {
      input.value = "";
      actions.onQuery("");
    };
    field.append(clear);
  }
  row.append(field);
  row.append(filterMenu(state, actions));
  return row;
}

function filterMenu(state: MarketViewState, actions: MarketActions): HTMLElement {
  const details = el("details", "pm-filter") as HTMLDetailsElement;
  const summary = el("summary", "");
  summary.append(svgIcon(ICON.chevron, 14), el("span", "", tr("筛选")));
  const panel = el("div", "pm-filter-menu");
  const group = (title: string, items: [string, boolean, () => void][]) => {
    const g = el("div", "pm-filter-group");
    g.append(el("div", "pm-filter-title", title));
    for (const [label, on, run] of items) {
      const b = el("button", `pm-filter-item${on ? " on" : ""}`, label) as HTMLButtonElement;
      b.type = "button";
      b.onclick = () => {
        details.open = false;
        run();
      };
      g.append(b);
    }
    panel.append(g);
  };
  group(tr("排序字段"), [
    [tr("月下载量"), state.sort === "downloads", () => actions.onSort("downloads", state.dir)],
    [tr("收录时间"), state.sort === "published", () => actions.onSort("published", state.dir)],
    [tr("名称"), state.sort === "name", () => actions.onSort("name", state.dir)],
  ]);
  group(tr("排序方向"), [
    [tr("降序"), state.dir === "desc", () => actions.onSort(state.sort, "desc")],
    [tr("升序"), state.dir === "asc", () => actions.onSort(state.sort, "asc")],
  ]);
  group(tr("显示"), [[tr("只看已安装"), state.onlyInstalled, () => actions.onOnlyInstalled(!state.onlyInstalled)]]);
  details.append(summary, panel);
  return details;
}

function tabsRow(state: MarketViewState, actions: MarketActions): HTMLElement {
  const tabs = el("div", "pm-tabs");
  const tab = (id: MarketTab, label: string, count?: number) => {
    const b = el("button", `pm-tab${state.tab === id ? " on" : ""}`, count && count > 0 ? `${label} (${count})` : label) as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => actions.onTab(id);
    tabs.append(b);
  };
  tab("discover", tr("发现"));
  tab("themes", tr("主题"));
  tab("favorites", tr("收藏"), state.favorites.size);
  const installed = el("button", "pm-tab", tr("已安装 ({p1})", { p1: state.installed.size })) as HTMLButtonElement;
  installed.type = "button";
  installed.onclick = () => actions.onOpenInstalled();
  tabs.append(installed);
  tab("blocked", tr("已屏蔽"));
  tab("advanced", tr("高级"));
  tabs.append(el("span", "pm-grow"));

  const exportBtn = el("button", "pm-top-btn") as HTMLButtonElement;
  exportBtn.type = "button";
  exportBtn.append(svgIcon(ICON.download, 14), el("span", "", tr("导出日志")));
  exportBtn.onclick = () => actions.onExportLog();
  tabs.append(exportBtn);

  const tasks = el("details", "pm-tasks") as HTMLDetailsElement;
  const summary = el("summary", "pm-top-btn");
  summary.append(el("span", "", tr("任务")), svgIcon(ICON.chevron, 12));
  const panel = el("div", "pm-task-menu");
  if (!state.ops.length) panel.append(el("div", "pm-task-empty", tr("暂无进行中的操作")));
  else for (const op of state.ops) {
    const row = el("div", "pm-task-row");
    row.append(el("span", "", op.op));
    if (op.state === "queued") row.append(el("span", "pm-task-state", tr("（排队中）")));
    panel.append(row);
  }
  tasks.append(summary, panel);
  tabs.append(tasks);
  return tabs;
}

function categoryRow(state: MarketViewState, items: MarketPackage[], actions: MarketActions): HTMLElement {
  const cats = el("div", "pm-cats");
  const wrap = el("div", "pm-cats-wrap");
  wrap.append(pill(tr("全部 ({p1})", { p1: formatCount(items.length) }), state.category === "all", () => actions.onCategory("all")));
  for (const def of CATEGORY_DEFS) {
    if (def.id === "other") continue;
    const count = items.filter((p) => categoriesOf(p).includes(def.id)).length;
    if (!count && items.length) continue;
    wrap.append(pill(categoryLabel(def.id), state.category === def.id, () => actions.onCategory(def.id)));
  }
  cats.append(wrap);
  return cats;
}

function recentBlock(items: MarketPackage[], state: MarketViewState, actions: MarketActions): HTMLElement | null {
  if (state.tab !== "discover" || state.query || state.category !== "all" || !items.length) return null;
  const recent = sortPackages(items.filter((p) => !state.blocked.has(p.name)), "published", "desc").slice(0, 8);
  if (!recent.length) return null;
  if (state.recentHidden) {
    const show = el("button", "pm-recent-show") as HTMLButtonElement;
    show.type = "button";
    show.append(svgIcon(ICON.chevronRight, 14), el("span", "", tr("显示最近收录")));
    show.onclick = () => actions.onToggleRecent(false);
    return show;
  }
  const section = el("section", "pm-recent");
  const head = el("div", "pm-recent-head");
  const toggle = el("button", "pm-recent-toggle") as HTMLButtonElement;
  toggle.type = "button";
  toggle.append(svgIcon(ICON.chevron, 14), el("span", "", tr("最近收录")));
  head.append(toggle);
  const hide = el("button", "pm-recent-hide", tr("隐藏这一块")) as HTMLButtonElement;
  hide.type = "button";
  hide.onclick = () => actions.onToggleRecent(true);
  head.append(hide);
  section.append(head);
  const row = el("div", "pm-recent-row");
  for (const pkg of recent) row.append(recentTile(pkg, state, actions));
  section.append(row);
  return section;
}

function loadingBlock(): HTMLElement {
  const box = el("div", "pm-loading");
  box.append(el("span", "pm-logo"), el("span", "", tr("正在加载插件目录…")));
  return box;
}

function errorBlock(state: MarketViewState, actions: MarketActions): HTMLElement {
  const box = el("div", "pm-empty");
  box.append(el("div", "pm-empty-text", state.error || tr("插件目录加载失败")));
  const retry = el("button", "pm-install", tr("重试")) as HTMLButtonElement;
  retry.type = "button";
  retry.onclick = () => actions.onRefresh();
  box.append(retry);
  return box;
}

function discoverPage(state: MarketViewState, actions: MarketActions): HTMLElement {
  const page = el("div", "pm-page");
  const items = state.items ?? [];
  page.append(statusLine(state));
  const recent = recentBlock(items, state, actions);
  if (recent) page.append(recent);
  const filtered = sortPackages(filterPackages(items, state.category, state.onlyInstalled, state.installed, state.blocked), state.sort, state.dir);
  if (!state.items) {
    page.append(state.error ? errorBlock(state, actions) : loadingBlock());
    return page;
  }
  if (!filtered.length) {
    const clear = el("button", "pm-install", tr("清除筛选")) as HTMLButtonElement;
    clear.type = "button";
    clear.onclick = () => {
      actions.onCategory("all");
      actions.onOnlyInstalled(false);
      actions.onQuery("");
    };
    page.append(emptyBlock(tr("没有找到匹配的插件。"), clear));
    return page;
  }
  const shown = filtered.slice(0, Math.max(12, state.visible));
  const wrap = el("div", "pm-masonry");
  page.append(wrap);
  mountMasonry(wrap, shown, (pkg) => marketCard(pkg, state, actions));
  if (filtered.length > shown.length) {
    const more = el("div", "pm-load-more");
    const b = el("button", "pm-install", tr("加载更多（还有 {p1} 个）", { p1: filtered.length - shown.length })) as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => actions.onVisible(state.visible + 30);
    more.append(b);
    page.append(more);
  }
  return page;
}

function favoritesPage(state: MarketViewState, actions: MarketActions): HTMLElement {
  const page = el("div", "pm-page");
  const items = state.items ?? [];
  if (!state.items) {
    page.append(state.error ? errorBlock(state, actions) : loadingBlock());
    return page;
  }
  const favs = sortPackages(items.filter((p) => state.favorites.has(p.name) && !state.blocked.has(p.name)), state.sort, state.dir);
  if (!favs.length) {
    page.append(emptyBlock(tr("还没有收藏。在「发现」或「主题」里点书签图标，或在「已安装」的「···」里加入收藏。")));
    return page;
  }
  page.append(el("div", "pm-note", tr("共 {p1} 个收藏", { p1: favs.length })));
  const wrap = el("div", "pm-masonry");
  page.append(wrap);
  mountMasonry(wrap, favs, (pkg) => marketCard(pkg, state, actions));
  return page;
}

function themesPage(state: MarketViewState, actions: MarketActions): HTMLElement {
  const page = el("div", "pm-page");
  const items = state.items ?? [];
  if (!state.items) {
    page.append(state.error ? errorBlock(state, actions) : loadingBlock());
    return page;
  }
  const themes = sortPackages(items.filter((p) => !state.blocked.has(p.name) && (categoriesOf(p).includes("ui") || /theme|skin|外观|主题|皮肤/i.test(`${p.name} ${p.description}`))), state.sort, state.dir);
  if (!themes.length) {
    page.append(emptyBlock(tr("目录里暂无主题。")));
    return page;
  }
  page.append(el("div", "pm-note", tr("{p1} 款主题", { p1: themes.length })));
  const grid = el("div", "pm-theme-grid");
  for (const pkg of themes.slice(0, Math.max(12, state.visible))) grid.append(themeCard(pkg, state, actions));
  page.append(grid);
  return page;
}

function blockedPage(state: MarketViewState, actions: MarketActions): HTMLElement {
  const page = el("div", "pm-page");
  const names = [...state.blocked].sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    page.append(emptyBlock(tr("还没有屏蔽任何插件。")));
    return page;
  }
  const list = el("div", "pm-blocked-list");
  for (const name of names) {
    const row = el("div", "pm-blocked-row");
    row.append(el("span", "pm-blocked-name", name));
    const b = el("button", "pm-install", tr("取消屏蔽")) as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => actions.onUnblock(name);
    row.append(b);
    list.append(row);
  }
  page.append(list);
  return page;
}

function advancedPage(state: MarketViewState, actions: MarketActions): HTMLElement {
  const page = el("div", "pm-page pm-advanced");
  const section = (title: string, hint: string, body: HTMLElement) => {
    const box = el("div", "pm-adv-card");
    box.append(el("div", "pm-adv-title", title), el("div", "pm-adv-hint", hint), body);
    page.append(box);
  };

  const sourceBox = el("div", "pm-adv-form");
  const input = el("input", "pm-input") as HTMLInputElement;
  input.placeholder = "npm:@scope/pkg · git:github.com/user/repo · ./local/path";
  const go = el("button", "pm-install", tr("安装包")) as HTMLButtonElement;
  go.type = "button";
  go.disabled = state.readOnly;
  go.onclick = () => {
    const value = input.value.trim();
    if (value) actions.onInstallSource(value);
  };
  sourceBox.append(input, go);
  section(tr("按来源安装包"), tr("商店里没有的 git、本地路径，直接从来源装。"), sourceBox);

  const scopeBox = el("div", "pm-adv-form");
  const scope = el("select", "pm-input") as HTMLSelectElement;
  scope.append(new Option(tr("装到全局"), "global"), new Option(tr("装到当前项目"), "project"));
  scope.value = state.scope;
  scope.disabled = !state.canProject;
  scope.onchange = () => actions.onScope(scope.value === "project" ? "project" : "global");
  scopeBox.append(scope);
  section(tr("安装位置"), tr("当前项目不可用时只能装到全局。"), scopeBox);

  const refreshBox = el("div", "pm-adv-form");
  const refresh = el("button", "pm-install", tr("刷新插件目录")) as HTMLButtonElement;
  refresh.type = "button";
  refresh.onclick = () => actions.onRefresh();
  refreshBox.append(refresh);
  section(tr("目录"), tr("数据源是 npm（keywords:pi-package），和 pi.dev 画廊同一批包。"), refreshBox);

  const exportBox = el("div", "pm-adv-form");
  const exportBtn = el("button", "pm-install", tr("导出日志")) as HTMLButtonElement;
  exportBtn.type = "button";
  exportBtn.onclick = () => actions.onExportLog();
  exportBox.append(exportBtn);
  section(tr("导出日志"), tr("把当前目录与已安装清单写成纯文本，方便反馈。"), exportBox);
  return page;
}

/** Render the whole market. Caller repaints this on every state change. */
export function renderPluginMarket(state: MarketViewState, actions: MarketActions): HTMLElement {
  resetMasonry();
  const root = el("div", "pm-root");
  root.append(tabsRow(state, actions));
  const body = el("div", "pm-body");
  if (state.tab !== "blocked" && state.tab !== "advanced") {
    const sticky = el("div", "pm-sticky");
    sticky.append(searchRow(state, actions));
    if (state.tab === "discover") sticky.append(categoryRow(state, state.items ?? [], actions));
    body.append(sticky);
  }
  if (state.tab === "discover") body.append(discoverPage(state, actions));
  else if (state.tab === "themes") body.append(themesPage(state, actions));
  else if (state.tab === "favorites") body.append(favoritesPage(state, actions));
  else if (state.tab === "blocked") body.append(blockedPage(state, actions));
  else if (state.tab === "advanced") body.append(advancedPage(state, actions));
  root.append(body);
  return root;
}

// Menus close when clicking anywhere else, like dshmarket's popovers. One delegated listener for the
// whole page; the market is repainted often, so per-render listeners would pile up.
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target as Node | null;
      for (const details of document.querySelectorAll<HTMLDetailsElement>("details.pm-filter[open], details.pm-tasks[open], details.pm-more[open]")) {
        if (target && !details.contains(target)) details.open = false;
      }
    },
    true,
  );
}
