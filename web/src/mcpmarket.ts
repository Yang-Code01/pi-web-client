/**
 * MCP 市场：沿用插件市场的同一套 dshmarket 外观（`.mk-*`），数据来自官方 MCP Registry。
 * 卡片按 star 排；搜到的是什么就画什么，安装表单仍走 App 里原来的 `mcpInstallForm`。
 */
import { tr } from "./i18n/index.ts";
import { createEl as el } from "./chat.ts";
import { formatCount } from "./pluginmarket.ts";

export type McpCategory = "all" | "npm" | "pypi" | "oci" | "remote";
export type McpSort = "stars" | "name";
export type McpDir = "desc" | "asc";

export interface McpFieldView {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  default: string | null;
  template?: string | null;
}

export interface McpOptionView {
  kind: "npm" | "pypi" | "oci" | "remote";
  label: string;
  identifier: string;
  version: string | null;
  url?: string;
  transport: string;
  env: McpFieldView[];
  headers: McpFieldView[];
  args: string[];
  unavailable?: string;
}

export interface McpMarketItem {
  name: string;
  title: string;
  description: string;
  version: string;
  repo: string | null;
  stars: number;
  options: McpOptionView[];
}

export interface McpMarketState {
  query: string;
  category: McpCategory;
  sort: McpSort;
  dir: McpDir;
  items: McpMarketItem[] | null;
  error: string | null;
  loading: boolean;
  formItem: string | null;
  installedText: string;
  readOnly: boolean;
  building: boolean;
  starsComplete: boolean;
  hasToken: boolean;
  truncated: boolean;
  visible: number;
}

export interface McpMarketActions {
  onQuery(query: string): void;
  onCategory(category: McpCategory): void;
  onSort(sort: McpSort, dir: McpDir): void;
  onVisible(n: number): void;
  onOpenInstall(item: McpMarketItem): void;
  renderInstallForm(host: HTMLElement, item: McpMarketItem): void;
  onExportLog(): void;
  isInstalled(identifier: string): boolean;
  onRefresh(): void;
}

const MCP_KINDS: { id: McpCategory; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "npm", label: "npm" },
  { id: "pypi", label: "PyPI" },
  { id: "oci", label: "Docker" },
  { id: "remote", label: "远程" },
];

const KIND_LABEL: Record<Exclude<McpCategory, "all">, string> = {
  npm: "npm",
  pypi: "PyPI",
  oci: "Docker",
  remote: "远程",
};

/** A server can expose several install options; one card carries all of their kind chips. */
export function mcpKinds(item: McpMarketItem): Exclude<McpCategory, "all">[] {
  const kinds = new Set<Exclude<McpCategory, "all">>();
  for (const option of item.options) kinds.add(option.kind);
  return [...kinds];
}

export function sortMcp(items: McpMarketItem[], sort: McpSort, dir: McpDir): McpMarketItem[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (sort === "name") return mul * (a.title || a.name).localeCompare(b.title || b.name);
    return mul * (a.stars - b.stars) || (a.title || a.name).localeCompare(b.title || b.name);
  });
}

/** Exact name/title matches first, then the rest in the chosen order. */
export function rankMcpSearch(items: McpMarketItem[], query: string, sort: McpSort, dir: McpDir): McpMarketItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return sortMcp(items, sort, dir);
  const exact: McpMarketItem[] = [];
  const rest: McpMarketItem[] = [];
  for (const item of items) {
    const title = (item.title || "").toLowerCase();
    const name = item.name.toLowerCase();
    if (title === q || name === q || name.split("/").pop() === q) exact.push(item);
    else rest.push(item);
  }
  return [...sortMcp(exact, sort, dir), ...sortMcp(rest, sort, dir)];
}

function repoOwner(repo: string | null): string | null {
  if (!repo) return null;
  const m = /github\.com\/([^/]+)\//i.exec(repo);
  return m?.[1] ?? null;
}

function repoMark(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute("d", "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z");
  svg.append(p);
  return svg;
}

function avatar(owner: string | null): HTMLElement {
  const box = el("span", "mk-av");
  if (!owner) {
    box.textContent = "M";
    return box;
  }
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
  return box;
}

function emptyBlock(text: string): HTMLElement {
  return el("div", "mk-empty", text);
}

function loadingBlock(): HTMLElement {
  const box = el("div", "mk-loading");
  box.append(el("span", "mk-logo"), el("span", "", tr("正在加载 MCP 目录…")));
  return box;
}

function errorBlock(state: McpMarketState, actions: McpMarketActions): HTMLElement {
  const box = el("div", "mk-empty");
  box.append(el("div", "mk-empty-text", state.error || tr("MCP 目录加载失败")));
  const retry = el("button", "mk-install", tr("重试")) as HTMLButtonElement;
  retry.type = "button";
  retry.onclick = () => actions.onRefresh();
  box.append(retry);
  return box;
}

function installButton(item: McpMarketItem, state: McpMarketState, actions: McpMarketActions): HTMLElement {
  const installed = item.options.some((o) => Boolean(o.identifier) && actions.isInstalled(o.identifier));
  if (installed) {
    const ok = el("span", "mk-ok", "✓ ");
    ok.append(document.createTextNode(tr("已安装")));
    return ok;
  }
  const usable = item.options.some((o) => !o.unavailable);
  const b = el("button", "mk-install", tr("安装")) as HTMLButtonElement;
  b.type = "button";
  b.disabled = state.readOnly || !usable;
  b.title = usable ? "" : item.options.map((o) => o.unavailable).filter(Boolean).join(tr("；"));
  b.onclick = () => actions.onOpenInstall(item);
  return b;
}

function card(item: McpMarketItem, state: McpMarketState, actions: McpMarketActions): HTMLElement {
  const root = el("article", "mk-card");
  const row1 = el("div", "mk-row1");
  const main = el("div", "mk-card-main");
  const titleLine = el("div", "mk-title-line");
  const repo = item.repo;
  const title = repo ? (el("a", "mk-name", item.title || item.name) as HTMLAnchorElement) : (el("span", "mk-name", item.title || item.name) as HTMLElement);
  if (title instanceof HTMLAnchorElement && repo) {
    title.href = repo;
    title.target = "_blank";
    title.rel = "noopener";
  }
  title.title = item.name;
  titleLine.append(title);
  if (item.repo) titleLine.append(repoMark());
  main.append(titleLine);
  const byline = el("div", "mk-byline");
  byline.append(avatar(repoOwner(item.repo)));
  if (repoOwner(item.repo)) byline.append(el("span", "mk-owner", repoOwner(item.repo) || ""));
  if (item.version) byline.append(el("span", "mk-meta", `· v${item.version}`));
  if (item.stars > 0) byline.append(el("span", "mk-meta", `· ★ ${formatCount(item.stars)}`));
  main.append(byline);
  const action = el("div", "mk-card-action");
  action.append(installButton(item, state, actions));
  row1.append(main, el("div", "mk-grow"), action);
  root.append(row1);
  const desc = el("div", "mk-desc", item.description || tr("（没有描述）"));
  desc.title = item.description || "";
  root.append(desc);
  const foot = el("div", "mk-foot");
  const tags = el("div", "mk-tags");
  tags.append(el("span", "mk-req", tr("官方 MCP Registry")));
  for (const kind of mcpKinds(item)) tags.append(el("span", "mk-tag", KIND_LABEL[kind]));
  foot.append(tags);
  const acts = el("div", "mk-foot-actions");
  if (item.repo) {
    const repo = el("a", "mk-comments", tr("仓库")) as HTMLAnchorElement;
    repo.href = item.repo;
    repo.target = "_blank";
    repo.rel = "noopener";
    acts.append(repo);
  }
  foot.append(acts);
  root.append(foot);
  return root;
}

function searchRow(state: McpMarketState, actions: McpMarketActions): HTMLElement {
  const row = el("div", "mk-search-row");
  const field = el("label", "mk-search");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.2");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586ZM10.2991 10.3933L14.7783 14.8725");
  icon.append(p);
  field.append(icon);
  const input = el("input", "") as HTMLInputElement;
  input.placeholder = tr("搜索 MCP 服务（官方 MCP Registry）");
  input.value = state.query;
  input.spellcheck = false;
  input.oninput = () => actions.onQuery(input.value);
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") actions.onQuery(input.value);
  };
  field.append(input);
  if (state.query) {
    const clear = el("button", "mk-search-clear", "×") as HTMLButtonElement;
    clear.type = "button";
    clear.title = tr("清除搜索");
    clear.onclick = () => {
      input.value = "";
      actions.onQuery("");
    };
    field.append(clear);
  }
  row.append(field);
  const filter = el("details", "mk-filter") as HTMLDetailsElement;
  const summary = el("summary", "");
  summary.append(el("span", "", tr("筛选")));
  const panel = el("div", "mk-filter-menu");
  const group = (title: string, items: [string, boolean, () => void][]) => {
    const box = el("div", "mk-filter-group");
    box.append(el("div", "mk-filter-title", title));
    for (const [label, on, run] of items) {
      const b = el("button", `mk-filter-item${on ? " on" : ""}`, label) as HTMLButtonElement;
      b.type = "button";
      b.onclick = () => {
        filter.open = false;
        run();
      };
      box.append(b);
    }
    panel.append(box);
  };
  group(tr("排序字段"), [
    [tr("Star 数"), state.sort === "stars", () => actions.onSort("stars", state.dir)],
    [tr("名称"), state.sort === "name", () => actions.onSort("name", state.dir)],
  ]);
  group(tr("排序方向"), [
    [tr("降序"), state.dir === "desc", () => actions.onSort(state.sort, "desc")],
    [tr("升序"), state.dir === "asc", () => actions.onSort(state.sort, "asc")],
  ]);
  filter.append(summary, panel);
  row.append(filter);
  return row;
}

function categoryRow(state: McpMarketState, items: McpMarketItem[], actions: McpMarketActions): HTMLElement {
  const cats = el("div", "mk-cats");
  const wrap = el("div", "mk-cats-wrap");
  for (const kind of MCP_KINDS) {
    const count = kind.id === "all" ? items.length : items.filter((p) => mcpKinds(p).includes(kind.id as Exclude<McpCategory, "all">)).length;
    const b = el("button", `mk-pill${state.category === kind.id ? " on" : ""}`) as HTMLButtonElement;
    b.type = "button";
    if (kind.id === "all") {
      b.append(document.createTextNode(tr("全部")), el("span", "mk-pill-count", ` (${formatCount(count)})`));
    } else b.textContent = tr(kind.label);
    b.onclick = () => actions.onCategory(kind.id);
    wrap.append(b);
  }
  cats.append(wrap);
  return cats;
}

/** Simple masonry: deal alternately, then re-layout once the page has its real width. */
function mountMasonry(wrap: HTMLElement, items: McpMarketItem[], render: (item: McpMarketItem) => HTMLElement): void {
  const layout = () => {
    const width = wrap.clientWidth;
    if (width <= 0) return;
    const columns = width <= 680 ? 1 : Math.min(3, Math.max(2, Math.floor((width + 10) / 290)));
    const buckets = Array.from({ length: columns }, () => [] as McpMarketItem[]);
    items.forEach((item, i) => buckets[i % columns].push(item));
    wrap.replaceChildren();
    for (const bucket of buckets) {
      const col = el("div", "mk-masonry-col");
      for (const item of bucket) col.append(render(item));
      wrap.append(col);
    }
  };
  layout();
  requestAnimationFrame(layout);
}

/** Render the MCP market. The outer tab is already "MCP 市场"; this is the page body. */
export function renderMcpMarket(state: McpMarketState, actions: McpMarketActions): HTMLElement {
  const root = el("div", "mk-root mk-mcp-root");
  const tabs = el("div", "mk-tabs");
  const discover = el("button", "mk-tab on", tr("发现")) as HTMLButtonElement;
  discover.type = "button";
  tabs.append(discover, el("span", "mk-grow"));
  const exportBtn = el("button", "mk-top-btn") as HTMLButtonElement;
  exportBtn.type = "button";
  exportBtn.append(el("span", "", tr("导出日志")));
  exportBtn.onclick = () => actions.onExportLog();
  tabs.append(exportBtn);
  root.append(tabs);

  const body = el("div", "mk-body");
  const sticky = el("div", "mk-sticky");
  sticky.append(searchRow(state, actions));
  sticky.append(categoryRow(state, state.items ?? [], actions));
  body.append(sticky);

  const note = el("div", "mk-note");
  if (state.error) note.append(el("span", "mk-note-bad", state.error));
  else if (state.items) {
    const notes: string[] = [tr("来源是官方 MCP Registry，按仓库的 GitHub star 排序。")];
    if (state.building) notes.push(tr("排行数据正在后台建立（第一次要几分钟，取决于网络），现在显示的是 Registry 的直接搜索结果，没有 star；建好后这里会自动换成排行。"));
    else if (state.truncated) notes.push(tr("Registry 条目太多，排行只统计了前面的一部分。"));
    else if (!state.starsComplete) notes.push(state.hasToken ? tr("部分仓库的 star 没查到。") : tr("没登录 GitHub CLI（gh），star 只查到一部分：运行 gh auth login 后排行更准。"));
    note.append(el("span", "", notes.join("")));
  }
  body.append(note);

  const items = state.items ?? [];
  const filtered = items.filter((item) => {
    if (state.category !== "all" && !mcpKinds(item).includes(state.category)) return false;
    return true;
  });
  const ranked = rankMcpSearch(filtered, state.query, state.sort, state.dir);
  if (!state.items) {
    body.append(state.error ? errorBlock(state, actions) : loadingBlock());
  } else if (!ranked.length) {
    body.append(emptyBlock(tr("没有找到匹配的 MCP 服务。")));
  } else {
    const formItem = state.formItem ? ranked.find((item) => item.name === state.formItem) : null;
    if (formItem) {
      const panel = el("div", "mk-form-panel");
      panel.append(el("div", "mk-form-title", tr("安装 {p1}", { p1: formItem.title || formItem.name })));
      actions.renderInstallForm(panel, formItem);
      body.append(panel);
    }
    const wrap = el("div", "mk-masonry");
    body.append(wrap);
    mountMasonry(wrap, ranked.slice(0, Math.max(12, state.visible)), (item) => card(item, state, actions));
    if (ranked.length > Math.max(12, state.visible)) {
      const more = el("div", "mk-load-more");
      const b = el("button", "mk-install", tr("加载更多（还有 {p1} 个）", { p1: ranked.length - Math.max(12, state.visible) })) as HTMLButtonElement;
      b.type = "button";
      b.onclick = () => actions.onVisible(state.visible + 30);
      more.append(b);
      body.append(more);
    }
  }
  root.append(body);
  return root;
}
