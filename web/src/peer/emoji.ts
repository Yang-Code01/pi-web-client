import { tr } from "../i18n/index.ts";
import { EMOJI_GROUPS, type EmojiItem, groupItems } from "./emoji-data.ts";

/**
 * 表情面板（内网通输入区左下角的 😊），照 macOS「表情与符号」弹窗做：
 * - 顶部搜索框；中间整页分组（常用 + 8 类，组标题在组内吸顶）；底部一排线条分类图标，滚到哪组亮哪个。
 * - 底栏最右「我的表情」：本机收藏的图片表情（`/api/peer/stickers`），点一下直接作为图片发出。
 * - 选 Unicode emoji 插进输入框，面板不关，可以连点。
 *
 * 面板只管画与回调，网络和发送都交给调用方（`main.ts`），这里不碰 peer 的状态。
 */

/** 回应条上默认的几个（和 QQ / 飞书差不多那一组）。 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🙏", "👀"];

const RECENT_KEY = "peer.emoji.recent";
const RECENT_MAX = 24;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(emoji: string): void {
  const next = [emoji, ...readRecent().filter((x) => x !== emoji)].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式：只是记不住最近用过的 */
  }
}

export interface Sticker {
  id: string;
  size: number;
  mime: string;
  w?: number;
  h?: number;
}

export interface EmojiPanelOpts {
  /** 选了一个 Unicode emoji：插进输入框。 */
  onEmoji: (emoji: string) => void;
  /** 选了一个收藏的图片表情：直接发出去。 */
  onSticker: (id: string) => void;
  loadStickers: () => Promise<Sticker[]>;
  addSticker: (file: File) => Promise<void>;
  removeSticker: (id: string) => Promise<void>;
  close: () => void;
}

/** 上一次停在哪一页：下次打开还是那一页。 */
let lastTab: "emoji" | "sticker" = "emoji";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function stickerUrl(id: string): string {
  return `/api/peer/stickers/raw?id=${encodeURIComponent(id)}`;
}

/** 一个按钮：**mousedown 不抢焦点**，否则点表情时输入框的光标就没了，插不回原处。 */
function keepFocus(b: HTMLElement): void {
  b.addEventListener("mousedown", (ev) => ev.preventDefault());
}

/**
 * 底栏分类图标：照 macOS 表情弹窗底部那一排 SF Symbols 的线条图标画（16×16，1.3px 描边），
 * 不用彩色 emoji 当图标 —— 那正是旧面板看着「乱」的原因。
 */
const ICONS: Record<string, string> = {
  clock: '<circle cx="8" cy="8" r="6.3"/><path d="M8 4.4V8l2.6 1.6"/>',
  smiley:
    '<circle cx="8" cy="8" r="6.3"/><path d="M5.4 9.6c.6 1 1.5 1.5 2.6 1.5s2-.5 2.6-1.5"/><circle cx="6" cy="6.6" r=".55" class="f"/><circle cx="10" cy="6.6" r=".55" class="f"/>',
  bear:
    '<circle cx="4.2" cy="4.4" r="1.9"/><circle cx="11.8" cy="4.4" r="1.9"/><ellipse cx="8" cy="9" rx="5.2" ry="4.8"/><ellipse cx="8" cy="10.7" rx="1.9" ry="1.4"/><circle cx="6" cy="8.2" r=".5" class="f"/><circle cx="10" cy="8.2" r=".5" class="f"/>',
  cup: '<path d="M3 5.5h8v3.2a4 4 0 0 1-8 0z"/><path d="M11 6.3h.9a1.7 1.7 0 0 1 0 3.4H11"/><path d="M2.2 14h9.6"/><path d="M5.5 1.8c-.5.6.5 1.2 0 1.9M8.5 1.8c-.5.6.5 1.2 0 1.9"/>',
  ball: '<circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7v12.6"/><path d="M3.6 3.5a6.3 6.3 0 0 1 0 9M12.4 3.5a6.3 6.3 0 0 0 0 9"/>',
  car: '<path d="M2.3 10.8V8.4l1.4-3.6c.2-.5.6-.8 1.2-.8h6.2c.6 0 1 .3 1.2.8l1.4 3.6v2.4z"/><path d="M2.3 8.4h11.4"/><path d="M3.5 10.8v1.6M12.5 10.8v1.6"/><circle cx="4.9" cy="9.6" r=".55" class="f"/><circle cx="11.1" cy="9.6" r=".55" class="f"/>',
  bulb: '<path d="M5.9 11.2c0-1.4-2.2-2.6-2.2-5a4.3 4.3 0 0 1 8.6 0c0 2.4-2.2 3.6-2.2 5z"/><path d="M6.1 13h3.8M6.7 14.7h2.6"/>',
  symbols:
    '<path d="M4.3 9.7 1.9 7.3a1.5 1.5 0 0 1 2.4-1.9 1.5 1.5 0 0 1 2.4 1.9z"/><path d="M14.4 13.6 9.7 8.4a1.6 1.6 0 1 1 2.2-.4l-2.3 2.3a1.8 1.8 0 0 0 2.6 2.4l1.2-1.6"/><path d="M5 11.4v3.2M3.4 13h3.2"/><path d="M10.4 2.6h3.4"/>',
  flag: '<path d="M3.5 14.6V2"/><path d="M3.5 2.6c3-1.4 5.5 1.4 9.3 0v6.6c-3.8 1.4-6.3-1.4-9.3 0"/>',
  sticker:
    '<path d="M13.8 9.4V4.2a2 2 0 0 0-2-2H4.2a2 2 0 0 0-2 2v7.6a2 2 0 0 0 2 2h5.2z"/><path d="M9.4 13.8v-2.4a2 2 0 0 1 2-2h2.4"/><path d="M5.6 7.6c.5 1 1.3 1.4 2.4 1.4"/><circle cx="5.8" cy="5.5" r=".5" class="f"/><circle cx="9.4" cy="5.5" r=".5" class="f"/>',
  search: '<circle cx="6.8" cy="6.8" r="4.6"/><path d="m10.3 10.3 3.9 3.9"/>',
};

function icon(name: string): Element {
  // 常量 SVG 走 DOMParser 转节点（同 branchsheet.ts），不碰 innerHTML。
  const src = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" class="ep-ico">${ICONS[name] ?? ""}</svg>`;
  const root = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
  return document.importNode(root, true);
}

/**
 * 这台机器的 emoji 字体画不画得出某个表情。画不出的两种样子：
 * - 新版本的表情（Win10 的 Segoe UI Emoji 没有 🫠 🥲 🫡…）→ 画成单色的「豆腐块」；
 * - 组合序列（国旗 🇨🇳、ZWJ 的 😮‍💨）→ 拆成两个字，宽度差不多翻倍。
 * 所以一量宽度、二看画出来的像素里有没有彩色。两样都过才放进面板，结果按表情缓存。
 */
const drawableCache = new Map<string, boolean>();
let probe: CanvasRenderingContext2D | null | undefined;
let baseWidth = 0;
function drawable(e: string): boolean {
  const hit = drawableCache.get(e);
  if (hit !== undefined) return hit;
  if (probe === undefined) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      probe = c.getContext("2d", { willReadFrequently: true });
      if (probe) {
        probe.font = '24px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        probe.textBaseline = "top";
        baseWidth = probe.measureText("😀").width;
      }
    } catch {
      probe = null;
    }
  }
  let ok = true;
  if (probe && baseWidth > 0) {
    if (probe.measureText(e).width > baseWidth * 1.5) ok = false;
    else {
      probe.clearRect(0, 0, 32, 32);
      probe.fillStyle = "#000";
      probe.fillText(e, 2, 2);
      const px = probe.getImageData(0, 0, 32, 32).data;
      ok = false;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] ?? 0;
        const g = px[i + 1] ?? 0;
        const b = px[i + 2] ?? 0;
        if ((px[i + 3] ?? 0) > 0 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24)) {
          ok = true;
          break;
        }
      }
    }
  }
  drawableCache.set(e, ok);
  return ok;
}

interface Section {
  key: string;
  name: string;
  icon: string;
  items: EmojiItem[];
}

function sections(): Section[] {
  const out: Section[] = [];
  const recent = readRecent().filter(drawable);
  if (recent.length) out.push({ key: "recent", name: tr("常用"), icon: "clock", items: recent.map((e) => ({ e, k: "" })) });
  for (const g of EMOJI_GROUPS) {
    // 画不出来的（豆腐块、被拆开的国旗）不放进面板：留着只会难看。
    const items = groupItems(g).filter((it) => drawable(it.e));
    if (items.length) out.push({ key: g.icon, name: tr(g.name), icon: g.icon, items });
  }
  return out;
}

export function emojiPanel(opts: EmojiPanelOpts): HTMLElement {
  const panel = el("div", "emoji-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", tr("表情"));

  // 顶部：搜索框（照 macOS：圆角浅底，左边放大镜）。「我的表情」页不显示。
  const top = el("div", "ep-top");
  const field = el("label", "ep-search");
  field.append(icon("search"));
  const search = el("input");
  search.type = "search";
  search.placeholder = tr("搜索表情");
  search.spellcheck = false;
  search.autocomplete = "off";
  field.append(search);
  top.append(field);

  const body = el("div", "ep-body");
  const bar = el("div", "ep-bar");
  bar.setAttribute("role", "tablist");
  panel.append(top, body, bar);

  const secs = sections();
  const jumps = new Map<string, HTMLButtonElement>();
  const anchors = new Map<string, HTMLElement>();
  let scroll: HTMLElement | null = null;
  let current = "";

  const mark = (key: string): void => {
    current = key;
    for (const [k, b] of jumps) {
      b.classList.toggle("on", k === key);
      b.setAttribute("aria-selected", String(k === key));
    }
  };

  const pick = (emoji: string): void => {
    const searching = document.activeElement === search;
    pushRecent(emoji);
    opts.onEmoji(emoji);
    // 插表情要把焦点交回输入框（execCommand 只认焦点所在处）；人还在搜索框里连着挑时，再把焦点还给搜索框。
    if (searching) search.focus({ preventScroll: true });
  };

  const cell = (it: EmojiItem): HTMLButtonElement => {
    const b = el("button", "ep-e", it.e);
    b.type = "button";
    b.title = it.k ? `${it.e} ${it.k.split(" ")[0]}` : it.e;
    keepFocus(b);
    b.addEventListener("click", () => pick(it.e));
    return b;
  };

  /** 整页分组：每组一个 section（标题 sticky 只在本组内吸顶，翻到下一组时被顶走，和 macOS 一样）。 */
  const paintAll = (): void => {
    const sc = el("div", "ep-scroll");
    anchors.clear();
    for (const sec of secs) {
      const box = el("section", "ep-group");
      box.dataset.key = sec.key;
      const grid = el("div", "ep-grid");
      for (const it of sec.items) grid.append(cell(it));
      box.append(el("div", "ep-sec", sec.name), grid);
      sc.append(box);
      anchors.set(sec.key, box);
    }
    // 滚动时底栏跟着亮当前那一组：取最后一个「顶边已经到视口顶」的组。
    sc.addEventListener("scroll", () => {
      let key = secs[0]?.key ?? "";
      for (const sec of secs) {
        const a = anchors.get(sec.key);
        if (a && a.offsetTop <= sc.scrollTop + 1) key = sec.key;
      }
      if (key !== current) mark(key);
    }, { passive: true });
    scroll = sc;
    body.replaceChildren(sc);
  };

  const paintSearch = (q: string): void => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const hits: EmojiItem[] = [];
    for (const sec of secs) {
      if (sec.key === "recent") continue;
      for (const it of sec.items) {
        if (seen.has(it.e)) continue;
        if (words.every((w) => it.k.includes(w) || it.e === w)) {
          seen.add(it.e);
          hits.push(it);
        }
      }
    }
    const sc = el("div", "ep-scroll");
    if (hits.length) {
      const grid = el("div", "ep-grid");
      for (const it of hits) grid.append(cell(it));
      sc.append(el("div", "ep-sec", tr("搜索结果")), grid);
    } else {
      sc.append(el("div", "ep-empty", tr("没有找到表情")));
    }
    scroll = null;
    body.replaceChildren(sc);
  };

  const showEmoji = (): void => {
    lastTab = "emoji";
    panel.classList.remove("stickers-on");
    jumps.get("sticker")?.classList.remove("on");
    const q = search.value.trim();
    if (q) {
      paintSearch(q);
      mark("");
    } else {
      paintAll();
      mark(secs[0]?.key ?? "");
    }
  };

  /**
   * 跳到某一组。**不能用组标题的 offsetTop**：标题是 position: sticky，已经吸在顶上的那些
   * 量出来的是「吸住时的位置」（≈ 当前 scrollTop），往回跳就原地不动 —— 旧面板「点后面的
   * 分类再点前面的没反应」就是这个。改量不吸顶的整组容器。
   */
  const jumpTo = (key: string): void => {
    if (lastTab !== "emoji" || !scroll) {
      search.value = "";
      showEmoji();
    }
    const a = anchors.get(key);
    if (scroll && a) scroll.scrollTop = a.offsetTop;
    mark(key);
  };

  const paintSticker = async (): Promise<void> => {
    // 重取时不动已经画好的格子（D316）；首次打开且慢过 220ms 才挂「读取中…」。
    const fresh = !body.querySelector(".stickers");
    if (fresh) body.replaceChildren();
    const slow = fresh ? window.setTimeout(() => body.replaceChildren(el("div", "ep-empty", tr("读取中…"))), 220) : 0;
    let list: Sticker[] = [];
    try {
      list = await opts.loadStickers();
    } catch (err) {
      window.clearTimeout(slow);
      body.replaceChildren(el("div", "ep-empty", (err as Error).message));
      return;
    }
    window.clearTimeout(slow);
    if (lastTab !== "sticker") return;
    const sc = el("div", "ep-scroll");
    const grid = el("div", "ep-grid stickers");
    // 第一个格子是「添加」：选本机图片收藏进来（聊天里的图也能右键「添加到表情」）。
    const add = el("label", "ep-s ep-add");
    add.title = tr("添加表情（png / jpg / gif / webp，5 MB 以内）");
    add.append(el("span", "", "+"));
    const input = el("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", async () => {
      for (const f of [...(input.files ?? [])]) {
        try {
          await opts.addSticker(f);
        } catch {
          /* 调用方已经 toast 过了 */
        }
      }
      void paintSticker();
    });
    add.append(input);
    grid.append(add);
    for (const s of list) {
      const b = el("button", "ep-s");
      b.type = "button";
      b.title = tr("点一下发送；右键删除");
      keepFocus(b);
      const img = el("img");
      img.src = stickerUrl(s.id);
      img.alt = "";
      img.loading = "lazy";
      b.append(img);
      b.addEventListener("click", () => opts.onSticker(s.id));
      b.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!window.confirm(tr("从「我的表情」里删掉这个？"))) return;
        void opts.removeSticker(s.id).then(() => paintSticker());
      });
      grid.append(b);
    }
    sc.append(el("div", "ep-sec", tr("我的表情")), grid);
    if (!list.length) sc.append(el("div", "ep-tip", tr("还没有收藏。点「+」选图片，或在聊天里右键一张图「添加到表情」。")));
    scroll = null;
    body.replaceChildren(sc);
  };

  const showSticker = (): void => {
    lastTab = "sticker";
    panel.classList.add("stickers-on");
    mark("sticker");
    void paintSticker();
  };

  // 底栏：每组一个线条图标，最右隔一道竖线放「我的表情」。
  const jumpBtn = (key: string, ico: string, name: string, act: () => void): HTMLButtonElement => {
    const b = el("button", "ep-jump");
    b.type = "button";
    b.title = name;
    b.dataset.key = key;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", name);
    b.append(icon(ico));
    keepFocus(b);
    b.addEventListener("click", act);
    jumps.set(key, b);
    return b;
  };
  for (const sec of secs) bar.append(jumpBtn(sec.key, sec.icon, sec.name, () => jumpTo(sec.key)));
  bar.append(el("span", "ep-bar-sep"), jumpBtn("sticker", "sticker", tr("我的表情"), showSticker));

  search.addEventListener("input", () => showEmoji());
  search.addEventListener("keydown", (ev) => {
    // 搜索框里的按键别冒泡到输入区（Enter 会被当成「发送」）；Esc 交给外层关面板。
    if (ev.key === "Escape") return;
    ev.stopPropagation();
    if (ev.key === "Enter" && !ev.isComposing) {
      ev.preventDefault();
      const first = body.querySelector<HTMLButtonElement>(".ep-e");
      if (first?.textContent) pick(first.textContent);
    }
  });
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      opts.close();
    }
  });

  if (lastTab === "sticker") showSticker();
  else showEmoji();
  return panel;
}

