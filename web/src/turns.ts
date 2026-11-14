import { tr } from "./i18n/index.ts";

/**
 * 轮次缩略图（turn rail）：对话右缘一条由短横组成的刻度带，一根短横 = 一轮用户输入。
 *
 * 这块是照着本机 WorkBuddy 5.9.3（Electron，`conversation-history-navigation`）重写的，几何与手感
 * 都对得上它：收起时是一列贴着右缘的短横，鼠标移上去（或键盘聚焦）整块展开成一张毛玻璃面板 ——
 * 每行一轮用户输入、单行右对齐、末行＝当前轮；点一行跳回那一轮，鼠标扫过某行时正文里对应那条
 * 用户消息会亮一下。**收起和展开画的是同一批节点**，只是两套坐标系（收起 14px 一格、展开 28px 一格），
 * 展开时用一次滚动补偿把它们接上 —— 看起来是「同一块东西长大」，不是「换了个列表」（Q-028 的
 * 「要和 chat 融成同一个框」）。
 *
 * 这里只管几何、窗口化和高亮，不认识消息结构：ChatView 递进来的是「一行文字」，跳转也由它自己做。
 *
 * #243: 带子画的是**整段会话**，不只是已载入的部分 —— 桥上把全量轮次索引一起送了下来，
 * 未载入的那些以 `ghost` 排在已载入段上面，淡一档占位；翻出一页就吃掉等量的 ghost。
 * #244: 点 ghost 不再什么都不发生 —— 带子把那一轮的 id 交回去，由 ChatView 自动往回翻页去找。
 */

/** 收起时一根短横占的版面（px）。 */
const STEP_COMPACT = 14;
/** 展开后一行占的版面：行高 26 + 行距 2。 */
const STEP_EXPANDED = 28;
const ROW_H = 26;
const ROW_GAP = 2;
/** 收起时最多摆下多少根短横，再多就在那一条带子里自己滚（不是抽样：一根都不许少）。 */
const MAX_COMPACT_TICKS = 28;
/** 展开后整块面板的高度上限；实际还会按正文视口高度收（见 `measure()`）。 */
const MAX_PANEL_H = 400;
/** 面板高度按正文视口几成算（老版本就是七成：再高就压到输入框上了）。 */
const PANEL_VIEWPORT_SHARE = 0.72;
/** 窗口化：轮次多于这么多就只画看得见的那几行（200 轮全画出来一帧就是几万个节点）。 */
const WINDOW_AT = 120;
/** 窗口上下各多画这么多像素，滚动时不至于一眼看见空白。 */
const OVERSCAN = 56;
/** 一行文字最多渲染这么多字符（tooltip 和读屏用的仍是完整那句）。 */
const TEXT_MAX = 160;
/** 面板宽度由「最长的几条」撑出来：量这么多条（截这么长）就够，不用把 200 条全量一遍。 */
const SIZER_ITEMS = 24;
const SIZER_CHARS = 120;
/** 悬停意图：移到带子上等这么久才展开，移开等这么久才收起 —— 扫过去不算展开。 */
const OPEN_INTENT_MS = 60;
const CLOSE_INTENT_MS = 180;
/** 与 styles.css 的 `--turn-open-dur` / `--turn-close-dur` 一致（那边是动画，这边是收尾时机）。 */
const OPEN_MS = 543;
const CLOSE_MS = 343;

type Phase = "closed" | "opening" | "open" | "closing";

export interface TurnRail {
  /** 换会话：清空所有刻度和行。 */
  clear(): void;
  /** 新增一轮用户输入（`label` 是压成单行的开头文字）。 */
  add(label: string): void;
  /**
   * #220: 往前翻出一页 —— 更早的那些轮插到带上沿，不是尾端。`current` / `hot` 跟着往后挪，
   * 免得「你在这儿」那根刻度换了个人。
   * #243: 这些轮次本来就以 ghost 占位在带上沿，所以先吃掉等量的 ghost 再插（见 `prepend` 里的说明）。
   */
  prepend(labels: string[]): void;
  /**
   * #243: 整段历史里**还没载入**的那些轮（更早的），整体替换「淡的那一段」。
   * 它们永远排在已载入段前面；`onPick` / `onHover` / `setCurrent` 的 index 都只数已载入的轮次。
   * 带 id 是因为翻页会把新轮次插到前面 —— 数字下标一变就指错人（#244）。
   */
  setGhosts(items: { id: string; label: string }[]): void;
  /** 「你在哪一轮」——滚动时由 ChatView 按视口顶部落下的那一轮喂进来（只看已载入的）。 */
  setCurrent(index: number): void;
  /** #244: 自动往回翻页期间，淡的那一段轻脉动 —— 「那一带正在动」。 */
  setBusy(busy: boolean): void;
  /**
   * #244: 跳转失败的那句话，挂在带子上。带子固定在右缘、不随滚动走，而正文顶部那一行
   * （`.chat-more`）在视口上方几千像素外 —— 「可见」得靠这里。由 ChatView 计时清掉。
   */
  setNote(note: string | null): void;
}

export interface TurnRailOpts {
  /** 点某一行 / 某一根短横。 */
  onPick(index: number): void;
  /** #244: 点未载入的那一行 / 那一根短横 —— 交回它的 id，跳转由 ChatView 自己翻页去找。 */
  onPickGhost?(id: string): void;
  /** 鼠标在某一行上（null = 离开），用于在正文里预览高亮那条消息。 */
  onHover(index: number | null): void;
  /**
   * 正文的滚动视口。带子的垂直中心、「能放下几根短横」、「面板能长多高」都按它算 —— 宿主
   * （对话栏）还包含输入框与底栏，按宿主算会让长会话的刻度一直长到输入框里去。
   */
  viewport?: HTMLElement | null;
}

/** 一根短横 / 一行是什么，给 tooltip 和读屏用；ghost 多一句「（未载入）」。 */
function titleOf(index: number, label: string, ghost: boolean): string {
  return ghost
    ? tr("第 {p1} 轮（未载入）：{p2}", { p1: index + 1, p2: label })
    : tr("第 {p1} 轮：{p2}", { p1: index + 1, p2: label });
}

/** 无障碍名字比 tooltip 多说一个动作 —— 两者都能点，ghost 点了是「往回翻到它」。 */
function ariaOf(index: number, label: string, ghost: boolean): string {
  return ghost
    ? tr("跳到第 {p1} 轮（未载入）：{p2}", { p1: index + 1, p2: label })
    : tr("跳到第 {p1} 轮：{p2}", { p1: index + 1, p2: label });
}

/** 版面算出来的那几个高度（px）。坐标原点都是「面板顶端」。 */
interface Geometry {
  /** 收起时那条可见带子的高度：摆得下的短横数 × 14 + 上下各 10。 */
  compactH: number;
  /** 收起时所有短横铺开要多高（超过 compactH 就得滚）。 */
  contentH: number;
  /** 展开后所有行铺开要多高。 */
  fullH: number;
  /** 展开后面板的高度（被视口和 MAX_PANEL_H 收过）。 */
  panelH: number;
  /** 面板外框高度：两种形态里更高的那个 —— 带子永远居中在这块里，切换时不会跳一下。 */
  outerH: number;
  /** 轮次少的时候把短横居中在面板高度里，展开才不用跳。 */
  compactOffset: number;
  /** 行容器的高度：两套坐标系都要放得下。 */
  rowsH: number;
}

export function mountTurnRail(host: HTMLElement, opts: TurnRailOpts): TurnRail {
  const rail = document.createElement("aside");
  rail.className = "turn-rail";
  rail.hidden = true;
  /** 收起时唯一接指针的东西：一块透明按钮，正好盖在那一列短横上（WorkBuddy 的 `rail-hit`）。 */
  const hit = document.createElement("button");
  hit.type = "button";
  hit.className = "turn-hit";
  hit.setAttribute("aria-expanded", "false");
  hit.setAttribute("aria-label", tr("对话轮次"));
  const outer = document.createElement("div");
  outer.className = "turn-panel-outer";
  const surface = document.createElement("div");
  surface.className = "turn-surface";
  const panel = document.createElement("div");
  panel.className = "turn-panel";
  /** 面板宽度靠它撑：把最长的几条塞进去量，`width: max-content` 才量得出「该多宽」。 */
  const sizer = document.createElement("div");
  sizer.className = "turn-sizer";
  sizer.setAttribute("aria-hidden", "true");
  const list = document.createElement("div");
  list.className = "turn-list";
  const rowsBox = document.createElement("div");
  rowsBox.className = "turn-rows";
  list.append(rowsBox);
  panel.append(sizer, list);
  outer.append(surface, panel);
  /** #244: 失败提示的落点（面板上方）；重画子节点时要把它带上。 */
  const note = document.createElement("div");
  note.className = "turn-note";
  note.hidden = true;
  note.setAttribute("role", "status");
  rail.append(outer, hit, note);
  rail.setAttribute("aria-label", tr("对话轮次"));
  host.append(rail);

  /** 已载入的轮次（实线段）。 */
  const labels: string[] = [];
  /**
   * 未载入的轮次（`ghost`）：从最早的到离已载入段最近的。和 `labels` 拼起来才是整段会话的顺序；
   * 翻出一页就从**尾部**吃掉等量 ghost。
   */
  let ghosts: { id: string; label: string }[] = [];
  /** 「当前」/「悬停」都只用**已载入轮次的下标**（ChatView 的坐标系），画的时候再加 ghost 偏移。 */
  let current = -1;
  let hot = -1;
  /** 收起 / 展开中 / 展开 / 收起中。 */
  let phase: Phase = "closed";
  let geom: Geometry = measure(0);
  /**
   * 同一个滚动容器、两套坐标：收起时它是「短横滚到哪儿了」，展开时是「面板滚到哪儿了」。
   * 切换形态时这两个值不一样，靠 `commitScroll()` 在关掉动效的那一帧里换过去。
   */
  let compactTop = 0;
  let expandedTop = 0;
  /** 窗口化时要画的那批下标（`null` = 全画）。两套坐标各算一段再并起来，所以不一定连号。 */
  let shown: number[] | null = null;

  const total = (): number => ghosts.length + labels.length;
  const labelOf = (index: number): string =>
    index < ghosts.length ? ghosts[index].label : labels[index - ghosts.length];
  const isGhost = (index: number): boolean => index < ghosts.length;
  /** 整条带子里的下标 → 已载入轮次的下标（ghost 段是负数）。 */
  const turnOf = (index: number): number => index - ghosts.length;

  /** 版面：全部按正文视口算，视口矮的时候面板跟着矮，绝不长到输入框上去。 */
  function measure(count: number): Geometry {
    const view = opts.viewport ?? host;
    const viewH = view.clientHeight || 560;
    const maxPanel = Math.max(160, Math.min(MAX_PANEL_H, Math.round(viewH * PANEL_VIEWPORT_SHARE)));
    // 短横也得摆得进同一段高度：窄窗口下 28 根会顶穿视口。
    const fits = Math.floor((maxPanel - 20) / STEP_COMPACT);
    const ticks = Math.min(count, MAX_COMPACT_TICKS, Math.max(3, fits));
    const compactH = ticks * STEP_COMPACT + 20;
    const contentH = count * STEP_COMPACT + 20;
    const fullH = count * ROW_H + Math.max(0, count - 1) * ROW_GAP + 16;
    const panelH = Math.min(maxPanel, fullH);
    return {
      compactH,
      contentH,
      fullH,
      panelH,
      outerH: Math.max(compactH, panelH),
      compactOffset: Math.max(0, (panelH - contentH) / 2),
      rowsH: Math.max(contentH, fullH),
    };
  }

  /**
   * `#app` 上挂着 `zoom: var(--ui-scale)`（外观「字号」）：`getBoundingClientRect()` 量到的是**视觉**
   * px，写进 style 的 px 却是**布局** px、渲染时还会再乘一次缩放（D123 的同一个坑，只不过这次在 TS 里）。
   * 直角换一次，字号 125% 以上带子才不会往下漂几十像素。
   */
  const uiScale = (): number => {
    const raw = Number.parseFloat(getComputedStyle(rail).getPropertyValue("--ui-scale"));
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  };

  /** 让带子垂直居中于正文视口（而不是连输入框一起算的整个对话栏）。 */
  const frame = (): void => {
    const view = opts.viewport;
    if (!view || view === host) return;
    const box = host.getBoundingClientRect();
    const port = view.getBoundingClientRect();
    const scale = uiScale();
    rail.style.top = `${Math.round((port.top - box.top + port.height / 2) / scale)}px`;
  };

  /** 把版面写进 CSS 变量 —— 几何只有这一处真源，样式表只管怎么用。 */
  const applyGeometry = (): void => {
    rail.style.setProperty("--turn-compact-h", `${geom.compactH}px`);
    rail.style.setProperty("--turn-panel-h", `${geom.panelH}px`);
    rail.style.setProperty("--turn-outer-h", `${geom.outerH}px`);
    rail.style.setProperty("--turn-rows-h", `${geom.rowsH}px`);
    // 收起时那条可见带子在面板里的垂直位置（面板比它高时上下各留一半）。
    rail.style.setProperty("--turn-closed-inset-y", `${(geom.outerH - geom.compactH) / 2}px`);
    rail.style.setProperty("--turn-expanded-inset-y", `${(geom.outerH - geom.panelH) / 2}px`);
  };

  /** 一行 / 一根短横在两种形态下的纵向中心。收起时多一个 `compactOffset`：轮次少就居中。 */
  const compactY = (index: number): number => geom.compactOffset + 17 + index * STEP_COMPACT;
  const expandedY = (index: number): number => 21 + index * STEP_EXPANDED;

  // ---------------------------------------------------------------- 两套坐标之间的交接

  const clampTop = (top: number, height: number): number =>
    Math.max(0, Math.min(Math.max(0, height - list.clientHeight), top));

  const setVar = (name: string, value: number): void => {
    rail.style.setProperty(name, `${value}px`);
  };

  /** 跳过动效地改 scrollTop：加 `scroll-commit` 关掉过渡 → 改值 → 强制重排 → 摘掉。 */
  const commitScroll = (top: number): void => {
    rail.classList.add("scroll-commit");
    setVar("--turn-expanded-scroll-offset", 0);
    setVar("--turn-scroll-compensation", 0);
    list.scrollTop = top;
    void rail.getBoundingClientRect();
    rail.classList.remove("scroll-commit");
  };

  /** 收起态里把「当前」那根短横带进可见带子（长会话里它可能在上面老远）。 */
  const keepCurrentInBand = (): void => {
    if (phase !== "closed" || current < 0) return;
    const center = compactY(ghosts.length + current);
    const room = list.clientHeight;
    // 已经站在带子里就一像素都别动（乱设 scrollTop 会把平滑滚动按回原处）。
    if (center - 1 >= list.scrollTop && center + 1 <= list.scrollTop + room) return;
    compactTop = clampTop(center - room / 2, geom.contentH);
    list.scrollTop = compactTop;
    paintFade();
  };

  /** 视口里那一段（窗口化用）：一格一格的坐标轴反推首尾下标。 */
  const rangeAt = (
    top: number,
    height: number,
    firstCenter: number,
    step: number,
  ): { start: number; end: number } | null => {
    const count = total();
    if (count <= 0) return null;
    const start = Math.max(0, Math.ceil((top - OVERSCAN - firstCenter) / step));
    const end = Math.min(count - 1, Math.floor((top + height + OVERSCAN - firstCenter) / step));
    return start <= end ? { start, end } : null;
  };

  /**
   * 收起和展开两套坐标各算一遍再并起来 —— 过渡中间那几帧两边都得有节点在。
   * 并的是**下标集合**，不是 min..max 那一段：两套坐标离得远的时候（刚换会话时收起那一段还在顶上、
   * 面板已经滚到底），取区间会把中间几百条一起画出来，窗口化就等于没做。
   */
  const shownRange = (): number[] | null => {
    const count = total();
    if (count <= WINDOW_AT) return null;
    const closed = phase === "closed" || phase === "closing";
    const compact = rangeAt(closed ? list.scrollTop : compactTop, geom.compactH, geom.compactOffset + 17, STEP_COMPACT);
    const expanded = rangeAt(closed ? expandedTop : list.scrollTop, geom.panelH, 21, STEP_EXPANDED);
    // 首尾不硬塞进来：那等于「全都画」，窗口化就白做了（长会话滚到中间时最后那根短横本来就看不见）。
    const seen = new Set<number>();
    for (const range of [compact, expanded]) {
      if (!range) continue;
      for (let i = range.start; i <= Math.min(range.end, count - 1); i++) seen.add(i);
    }
    if (current >= 0) seen.add(ghosts.length + current);
    return [...seen].sort((a, b) => a - b);
  };

  /** 两次窗口是不是同一批下标（`null` = 全画）。 */
  const sameRange = (a: number[] | null, b: number[] | null): boolean => {
    if (a === b) return true;
    if (a === null || b === null || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  /** 重算窗口化的那一段；范围没变就只刷淡出（滚动时这条路径最常走）。 */
  const refreshWindow = (): void => {
    if (!shown) {
      paintFade();
      return;
    }
    const next = shownRange();
    if (sameRange(next, shown)) {
      paintFade();
      return;
    }
    shown = next;
    buildRows();
    paintFade();
  };

  // ---------------------------------------------------------------- 画

  const markHot = (): void => {
    const at = hot >= 0 ? ghosts.length + hot : -1;
    for (const row of rowsBox.children) {
      row.classList.toggle("hot", Number((row as HTMLElement).dataset.i) === at);
    }
  };

  const markCurrent = (): void => {
    const at = current >= 0 ? ghosts.length + current : -1;
    for (const row of rowsBox.children) {
      row.classList.toggle("cur", Number((row as HTMLElement).dataset.i) === at);
    }
  };

  /** 收起时这一排只是「刻度」，不是 200 个 Tab 停靠点；读屏也不念。 */
  const syncReachable = (): void => {
    const reachable = phase === "opening" || phase === "open";
    for (const row of rowsBox.children) {
      (row as HTMLButtonElement).tabIndex = reachable ? 0 : -1;
      if (reachable) row.removeAttribute("aria-hidden");
      else row.setAttribute("aria-hidden", "true");
    }
    hit.tabIndex = reachable ? -1 : 0;
  };

  /**
   * 一行（= 一根短横）的节点。**复用**而不是每帧重建：展开着的时候节点被拆掉，谁在它身上拿着焦点就
   * 会收到一次 focusout（`onHover(null)` 顺手把刚点出来的高亮抹掉），指针底下的 hover 也会丢。
   * 行是绝对定位的，DOM 顺序不影响摆放，所以只增删差额、不重排。
   */
  const rowNodes = new Map<string, HTMLButtonElement>();

  const paintRow = (row: HTMLButtonElement, index: number): void => {
    const ghost = isGhost(index);
    const turn = turnOf(index);
    const text = labelOf(index);
    row.className = ghost ? "turn-row ghost" : "turn-row";
    row.dataset.i = String(index);
    row.style.setProperty("--turn-compact-y", `${compactY(index)}px`);
    row.style.setProperty("--turn-expanded-y", `${expandedY(index)}px`);
    row.title = titleOf(index, text, ghost);
    row.setAttribute("aria-label", ariaOf(index, text, ghost));
    let cap = row.firstElementChild as HTMLElement | null;
    if (!cap) {
      cap = document.createElement("span");
      cap.className = "txt";
      const dash = document.createElement("span");
      dash.className = "dash";
      dash.setAttribute("aria-hidden", "true");
      row.append(cap, dash);
    }
    cap.textContent = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
    if (ghost) {
      const id = ghosts[index].id;
      row.onclick = () => opts.onPickGhost?.(id);
      // ghost 还没载入：没有节点可预览，不挂 hover。
      row.onpointerenter = null;
      row.onpointerleave = null;
    } else {
      row.onclick = () => opts.onPick(turn);
      row.onpointerenter = () => {
        if (hot === turn) return;
        hot = turn;
        markHot();
        opts.onHover(turn);
      };
      row.onpointerleave = () => {
        if (hot !== turn) return;
        hot = -1;
        markHot();
        opts.onHover(null);
      };
    }
  };

  const buildRows = (): void => {
    const indices = shown ?? Array.from({ length: total() }, (_, i) => i);
    const keep = new Set<string>();
    for (const index of indices) {
      const key = String(index);
      keep.add(key);
      let row = rowNodes.get(key);
      if (!row) {
        row = document.createElement("button");
        row.type = "button";
        rowNodes.set(key, row);
      }
      // 复用池里的节点也可能已经被 `replaceChildren()` 摘下来了（换会话、带子收起来）。
      if (!row.isConnected) rowsBox.append(row);
      paintRow(row, index);
    }
    for (const [key, row] of rowNodes) {
      if (keep.has(key)) continue;
      row.remove();
      rowNodes.delete(key);
    }
    markCurrent();
    markHot();
    syncReachable();
  };

  /** 面板宽度：塞最长的几条进去量（`width: max-content` 认的是它们）。 */
  const paintSizer = (): void => {
    const picked: { text: string; width: number }[] = [];
    for (let i = 0; i < total(); i++) {
      const raw = labelOf(i);
      const text = raw.length > SIZER_CHARS ? raw.slice(0, SIZER_CHARS) : raw;
      // 全角按两个字符宽算：只为了排个序，差一点都不影响结论。
      let width = 0;
      for (const ch of text) width += ch.charCodeAt(0) > 11903 ? 2 : 1;
      picked.push({ text, width });
    }
    picked.sort((a, b) => b.width - a.width);
    sizer.replaceChildren(...picked.slice(0, SIZER_ITEMS).map((item) => {
      const span = document.createElement("span");
      span.textContent = item.text;
      return span;
    }));
  };

  /** 上下那两条淡出（滚到头的那个方向就不淡了）。收起时那一条带子也会滚，一样要淡。 */
  const paintFade = (): void => {
    // 收起时滚的是短横那一段（`contentH`），展开时滚的是所有行（`rowsH`）—— 判「还有没有」得看各自的底。
    const bottom = phase === "closed" ? geom.contentH : geom.rowsH;
    const top = list.scrollTop > 1;
    const more = list.scrollTop < bottom - list.clientHeight - 1;
    list.classList.toggle("fade-top", top);
    list.classList.toggle("fade-bottom", more);
  };

  const paint = (): void => {
    const count = total();
    rail.hidden = count < 2;
    if (count < 2) {
      hardReset();
      rowsBox.replaceChildren();
      rowNodes.clear();
      sizer.replaceChildren();
      return;
    }
    frame();
    geom = measure(count);
    applyGeometry();
    // 先把「当前那一轮」带进可见带子，再按滚到的位置算窗口 —— 反过来的话，新建的会话会先按
    // scrollTop=0 画最上面那一段，而「当前」在最底下，连 cur 都标不到。
    if (phase === "closed") keepCurrentInBand();
    shown = shownRange();
    paintSizer();
    buildRows();
    // 窗口化之后 DOM 里只剩看得见的那几十行，「一共几轮、几轮还没载入」得留个地方读（用例、
    // 排查都靠它；读屏走的是每一行自己的 aria-label）。
    rail.dataset.turns = String(count);
    rail.dataset.ghosts = String(ghosts.length);
    rail.dataset.rendered = String(rowNodes.size);
    paintFade();
  };

  // 一次 reset 会连着一两百次 add()，每次都重建节点就是 O(n²) 的 DOM 开销；合并到一帧里画一次。
  let pending = 0;
  const schedulePaint = (): void => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      paint();
    });
  };

  // ---------------------------------------------------------------- 展 / 收

  let openTimer = 0;
  let closeTimer = 0;
  let openIntent = 0;
  let closeIntent = 0;

  /** 展开时把哪一行放在「原来的视线上」：正被指着的那行优先，其次当前轮，最后是最后一轮。 */
  const anchorIndex = (): number => {
    if (hot >= 0) return ghosts.length + hot;
    if (current >= 0) return ghosts.length + current;
    return ghosts.length + Math.max(0, labels.length - 1);
  };

  /**
   * 换会话 / 带子整条收起来：四种状态、四个计时器、两套滚动位置一起归零。
   * 比 `closeRail()` 狠 —— 那个在「正在收」时会早退，换会话时正好会卡在 `closing` 上（面板永远差
   * 343ms 才真正收起，下一次画的窗口就落在两套坐标之间）。
   */
  function hardReset(): void {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    window.clearTimeout(openIntent);
    window.clearTimeout(closeIntent);
    openTimer = 0;
    closeTimer = 0;
    openIntent = 0;
    closeIntent = 0;
    phase = "closed";
    rail.classList.remove("open", "settled");
    hit.setAttribute("aria-expanded", "false");
    setVar("--turn-expanded-scroll-offset", 0);
    setVar("--turn-scroll-compensation", 0);
    compactTop = 0;
    expandedTop = 0;
    list.scrollTop = 0;
    hot = -1;
  }

  function openRail(): void {
    if (phase === "open" || phase === "opening" || rail.hidden) return;
    window.clearTimeout(closeIntent);
    closeIntent = 0;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    window.clearTimeout(openTimer);
    const at = anchorIndex();
    compactTop = list.scrollTop;
    const row = rowsBox.querySelector<HTMLElement>(`[data-i="${at}"]`);
    if (row) {
      // 展开后那一行要落在展开坐标系里的同一条视线上：先把面板的 scrollTop 定好，差多少先用
      // CSS 变量补掉 —— 动画期间两套坐标就是这么接上的。
      const box = list.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const onScreen = (rect.top + rect.bottom) / 2 - box.top;
      expandedTop = clampTop(expandedY(at) - onScreen, geom.rowsH);
      setVar("--turn-expanded-scroll-offset", compactTop - expandedTop);
    } else {
      expandedTop = compactTop;
      setVar("--turn-expanded-scroll-offset", 0);
    }
    phase = "opening";
    rail.classList.add("open");
    rail.classList.remove("settled");
    hit.setAttribute("aria-expanded", "true");
    syncReachable();
    paintFade();
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      commitScroll(expandedTop);
      rail.classList.add("settled");
      phase = "open";
      syncReachable();
      paintFade();
    }, OPEN_MS);
  }

  function closeRail(): void {
    if (phase === "closed" || phase === "closing") return;
    window.clearTimeout(openIntent);
    openIntent = 0;
    window.clearTimeout(openTimer);
    openTimer = 0;
    // 收起同样要接上：面板这会儿的 scrollTop 是展开那一套的，推回去多少先补多少。
    setVar("--turn-scroll-compensation", list.scrollTop - compactTop);
    phase = "closing";
    rail.classList.remove("open", "settled");
    hit.setAttribute("aria-expanded", "false");
    syncReachable();
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      commitScroll(compactTop);
      phase = "closed";
      syncReachable();
      keepCurrentInBand();
      paintFade();
    }, CLOSE_MS);
  }

  /** 指针 / 焦点进来：等一小会儿（扫过去不算）；正在收就当场再展开。 */
  const wantOpen = (immediate = false): void => {
    window.clearTimeout(closeIntent);
    closeIntent = 0;
    if (phase === "open" || phase === "opening") return;
    window.clearTimeout(openTimer);
    openTimer = 0;
    window.clearTimeout(openIntent);
    const delay = immediate || phase === "closing" ? 0 : OPEN_INTENT_MS;
    openIntent = window.setTimeout(() => {
      openIntent = 0;
      openRail();
    }, delay);
  };

  /** 指针离开：也等一小会儿 —— 从短横扫到行、从一行扫到另一行都不算离开。 */
  const wantClose = (): void => {
    window.clearTimeout(openIntent);
    openIntent = 0;
    if (phase !== "open" && phase !== "opening") return;
    window.clearTimeout(closeIntent);
    closeIntent = window.setTimeout(() => {
      closeIntent = 0;
      hot = -1;
      markHot();
      opts.onHover(null);
      closeRail();
    }, CLOSE_INTENT_MS);
  };

  // 收起时滚动那一条带子（长会话里短横摆不下）：记住位置，别把它忘了。
  // 展开状态下滚动的是面板自己，那一路见下面的 scrollFrame。
  let scrollFrame = 0;
  list.addEventListener("scroll", () => {
    // 收起时滚的是短横那一段（长会话里跟着「当前」走），展开时滚的是面板自己。
    if (phase === "closed") compactTop = list.scrollTop;
    else expandedTop = list.scrollTop;
    if (!shown) {
      paintFade();
      return;
    }
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      refreshWindow();
    });
  }, { passive: true });

  // 指针进出的判定：`pointerenter` 不冒泡，而带子自身 `pointer-events: none`（指针实际落在子节点
  // 上），所以用 over / out + 看 relatedTarget 还在不在带子里。
  const inside = (node: EventTarget | null): boolean => node instanceof Node && rail.contains(node);
  /**
   * 指针是不是还压在带子上。节点被删掉时浏览器会补一次 `pointerout`、`relatedTarget` 是 null ——
   * 那不叫「离开」，可长会话里窗口化一直在删改行，照它收起就会来回抖（开 → 收 → 开，永远落不定）。
   */
  const stillOver = (ev: PointerEvent): boolean => {
    const box = rail.getBoundingClientRect();
    return ev.clientX >= box.left && ev.clientX <= box.right && ev.clientY >= box.top && ev.clientY <= box.bottom;
  };
  rail.addEventListener("pointerover", (ev) => {
    const from = (ev as PointerEvent).relatedTarget;
    if (inside(from)) return;
    // 行被重建成同一位置的新节点也会补一次 over（relatedTarget 为 null）：指针没动，不算进来。
    if (from === null && stillOver(ev as PointerEvent) && (phase === "open" || phase === "opening")) return;
    wantOpen();
  });
  rail.addEventListener("pointerout", (ev) => {
    const to = (ev as PointerEvent).relatedTarget;
    if (inside(to)) return;
    if (to === null && stillOver(ev as PointerEvent)) return;
    wantClose();
  });
  // 键盘走另一条路：聚焦就展开（不等那 60ms），失焦、Esc 就收起。
  // 注意：从 `.turn-hit` 焦点挪到某一行上时 relatedTarget 也在带子里 —— 那是「还没展开」，不是
  // 「已经展开了」，所以这里不能像指针那样一律放过（`wantOpen()` 自己在已展开时会早退）。
  rail.addEventListener("focusin", () => {
    wantOpen(true);
  });
  rail.addEventListener("focusout", (ev) => {
    const to = (ev as FocusEvent).relatedTarget;
    if (inside(to)) return;
    // `relatedTarget` 为 null = 焦点掉回 body 上了：多半是窗口化把那行拿掉（长会话里滚一下就会发生），
    // 不是「用户走了」。照它收起，键盘用户每滚一下面板就闪一次。
    if (to === null) return;
    hot = -1;
    markHot();
    opts.onHover(null);
    closeRail();
  });
  rail.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key !== "Escape") return;
    ev.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
    closeRail();
  });
  hit.addEventListener("keydown", (ev) => {
    // 回车 / 空格展开（它本身就是个按钮，别让默认行为把页面滚一下）。
    const key = (ev as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    ev.preventDefault();
    openRail();
  });

  // 视口（以及宿主）变高变矮会改变能放下几根短横、面板能长多高，顺便重算一次。
  let measuring = false;
  const ro = new ResizeObserver(() => {
    if (measuring || total() < 2) return;
    measuring = true;
    try {
      paint();
    } finally {
      measuring = false;
    }
  });
  ro.observe(host);
  if (opts.viewport && opts.viewport !== host) ro.observe(opts.viewport);

  return {
    clear() {
      labels.length = 0;
      ghosts = [];
      current = -1;
      shown = null;
      rowNodes.clear();
      hardReset();
      paint();
    },
    add(label) {
      labels.push(label);
      schedulePaint();
    },
    setGhosts(items) {
      ghosts = items.map((item) => ({ ...item }));
      schedulePaint();
    },
    prepend(items) {
      if (!items.length) return;
      // #243: 这些轮次本来就以 ghost 占位在带子上沿，先吃掉等量的（从离已载入段最近的开始）。
      // 索引缺失（老桥 / 被截断）时 ghost 可能不够：不拦住翻页，多出来的轮次直接按已载入画。
      const eaten = Math.min(items.length, ghosts.length);
      if (eaten) ghosts = ghosts.slice(0, ghosts.length - eaten);
      labels.unshift(...items);
      if (current >= 0) current += items.length;
      if (hot >= 0) hot += items.length;
      schedulePaint();
    },
    setCurrent(index) {
      const next = labels.length ? Math.max(0, Math.min(labels.length - 1, index)) : -1;
      if (next === current) return;
      current = next;
      keepCurrentInBand();
      // 窗口化时「当前」可能不在画出来的那一段里（比如刚跳到底部）：先把它带进窗口再标。
      refreshWindow();
      markCurrent();
    },
    setBusy(busy) {
      rail.classList.toggle("busy", busy);
    },
    setNote(text) {
      note.textContent = text ?? "";
      note.hidden = !text;
    },
  };
}
