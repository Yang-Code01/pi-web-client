
import { tr } from "./i18n/index.ts";

/**
 * 轮次缩略图（turn rail）：对话右缘一条刻度带，一根刻度 = 一轮用户输入。鼠标移到带上才展开左侧的
 * 小列表 —— 每行是那一轮的开头（单行、右对齐、超出打点），末行＝当前这一轮。点一行（或一根刻度）
 * 就跳回那一轮，鼠标扫过某行时那一轮会亮一下，顺带在正文里高亮对应那条用户消息（Q-028）。
 *
 * 这里只管几何、抽样和高亮，不认识消息结构：ChatView 递进来的是「一行文字」，跳转也由它自己做。
 *
 * #243: 带子画的是**整段会话**，不只是已载入的部分 —— 桥上把全量轮次索引一起送了下来，
 * 未载入的那些以 `ghost` 排在已载入段上面，淡一档占位；翻出一页就吃掉等量的 ghost。
 * #244: 点 ghost 不再什么都不发生 —— 带子把那一轮的 id 交回去，由 ChatView 自动往回翻页去找。
 */

/** 刻度只有 2px 高、间距 4px，所以一条刻度占 6px 版面。 */
const TICK_H = 2;
const TICK_GAP = 4;

export interface TurnRail {
  /** 换会话：清空所有刻度和行。 */
  clear(): void;
  /** 新增一轮用户输入（`label` 是压成单行的开头文字）。 */
  add(label: string): void;
  /**
   * #220: 往前翻出一页 —— 更早的那些轮插到带上沿，不是尾端。`current` / `hot` 跟着往后挪，
   * 免得「你在这儿」那根刻度换了个人。
   * #243: 这些轮次本来就以 ghost 占位在带上沿，所以先吃掉等量的 ghost 再插（见实现里的说明）。
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
  /** 点某一行 / 某根刻度。 */
  onPick(index: number): void;
  /** #244: 点未载入的那一行 / 那一根刻度 —— 交回它的 id，跳转由 ChatView 自己翻页去找。 */
  onPickGhost?(id: string): void;
  /** 鼠标在某一行上（null = 离开），用于在正文里预览高亮那条消息。 */
  onHover(index: number | null): void;
  /**
   * 正文的滚动视口。带子的高度和垂直中心都按它算 —— 宿主（对话栏）还包含输入框与底栏，
   * 按宿主的七成算会让长会话的刻度一直长到输入框里去。
   */
  viewport?: HTMLElement | null;
}

/** 一根刻度 / 一行的写法：ghost 与已载入共用「第 N 轮：…」，ghost 多一句「（未载入）」。 */
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

export function mountTurnRail(host: HTMLElement, opts: TurnRailOpts): TurnRail {
  const rail = document.createElement("div");
  rail.className = "turn-rail";
  rail.hidden = true;
  const list = document.createElement("div");
  list.className = "turn-list";
  rail.append(list);
  /** #244: 失败提示的落点（在带子顶端往左伸出去）；`paint()` 重建子节点时要把它带上。 */
  const note = document.createElement("div");
  note.className = "turn-note";
  note.hidden = true;
  note.setAttribute("role", "status");
  host.append(rail);

  /** 已载入的轮次（刻度带下半段，实线）。 */
  const labels: string[] = [];
  /**
   * 未载入的轮次（刻度带上半段，`ghost`）：从最早的到离已载入段最近的。和 `labels` 拼起来才是
   * 整段会话的顺序；翻出一页就从**尾部**吃掉等量 ghost。
   */
  let ghosts: { id: string; label: string }[] = [];
  /** 刻度下标 → 整条带子里的轮次下标（ghost + 已载入）。轮次多于版面时按比例抽样，首尾一定保留。 */
  let mapped: number[] = [];
  let ticks: HTMLButtonElement[] = [];
  let rows: HTMLButtonElement[] = [];
  /** 「当前」/「悬停」都只用**已载入轮次的下标**（ChatView 的坐标系），画的时候再加 ghost 偏移。 */
  let current = -1;
  let hot = -1;

  const total = (): number => ghosts.length + labels.length;

  /** 一根刻度代表从它到下一根刻度之间的所有轮次，所以「当前」落在区间里就算命中。 */
  const covers = (k: number, index: number): boolean => {
    const from = mapped[k];
    const to = k + 1 < mapped.length ? mapped[k + 1] : total();
    return index >= from && index < to;
  };

  const markCurrent = (): void => {
    const at = current >= 0 ? ghosts.length + current : -1;
    rows.forEach((row, i) => {
      row.classList.toggle("cur", i === at);
    });
    // ghost 只占位：即使某个 ghost 刻度的区间伸进了已载入段，「当前」也不能落在它上面。
    ticks.forEach((tick, k) => {
      tick.classList.toggle("cur", at >= 0 && mapped[k] >= ghosts.length && covers(k, at));
    });
  };

  const markHot = (): void => {
    const at = hot >= 0 ? ghosts.length + hot : -1;
    rows.forEach((row, i) => {
      row.classList.toggle("hot", i === at);
    });
    ticks.forEach((tick, k) => {
      tick.classList.toggle("hot", at >= 0 && mapped[k] >= ghosts.length && covers(k, at));
    });
  };

  /** 让带子垂直居中于正文视口（而不是连输入框一起算的整个对话栏）。 */
  const frame = (): void => {
    const view = opts.viewport;
    if (!view || view === host) return;
    const box = host.getBoundingClientRect();
    const port = view.getBoundingClientRect();
    rail.style.top = `${Math.round(port.top - box.top + port.height / 2)}px`;
  };

  const paint = (): void => {
    // 带子是整段会话（ghost + 已载入）的缩略，不只是已经翻出来的那几页。
    const all = [...ghosts.map((ghost) => ghost.label), ...labels];
    rail.hidden = all.length < 2;
    frame();
    // 版面高度按正文视口七成算：刻度带上下一起来，最长也就是这个高度。
    const view = opts.viewport ?? host;
    const avail = Math.max(96, Math.round((view.clientHeight || 560) * 0.7));
    const fit = Math.max(3, Math.floor((avail + TICK_GAP) / (TICK_H + TICK_GAP)));
    mapped = [];
    if (all.length <= fit) {
      for (let i = 0; i < all.length; i++) mapped.push(i);
    } else {
      for (let j = 0; j < fit; j++) mapped.push(Math.round((j * (all.length - 1)) / (fit - 1)));
    }

    ticks = mapped.map((index) => {
      const ghost = index < ghosts.length;
      // 已载入轮次的下标（ghost 内部加偏移，ChatView 递进来的坐标不用改）。
      const turn = index - ghosts.length;
      const label = ghost ? ghosts[index].label : labels[turn];
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = ghost ? "turn-tick ghost" : "turn-tick";
      tick.dataset.i = String(index);
      tick.title = titleOf(index, label, ghost);
      tick.setAttribute("aria-label", ariaOf(index, label, ghost));
      // ghost 还没载入：点它交给 ChatView 自动往回翻页（#244），没有节点可预览所以不挂 hover。
      if (ghost) {
        const id = ghosts[index].id;
        tick.onclick = () => opts.onPickGhost?.(id);
      } else {
        tick.onclick = () => opts.onPick(turn);
        tick.onpointerenter = () => {
          hot = turn;
          markHot();
          opts.onHover(turn);
        };
      }
      return tick;
    });

    rows = all.map((label, index) => {
      const ghost = index < ghosts.length;
      const turn = index - ghosts.length;
      const row = document.createElement("button");
      row.type = "button";
      row.className = ghost ? "turn-row ghost" : "turn-row";
      row.dataset.i = String(index);
      row.title = titleOf(index, label, ghost);
      // 行按钮的可及名默认只是那行字；ghost 要听得出「还没载入、点了会去翻」。#244 两种都给同一套。
      row.setAttribute("aria-label", ariaOf(index, label, ghost));
      const text = document.createElement("span");
      text.className = "txt";
      text.textContent = label;
      const dash = document.createElement("span");
      dash.className = "dash";
      row.append(text, dash);
      if (ghost) {
        const id = ghosts[index].id;
        row.onclick = () => opts.onPickGhost?.(id);
      } else {
        row.onclick = () => opts.onPick(turn);
        row.onpointerenter = () => {
          hot = turn;
          markHot();
          opts.onHover(turn);
        };
      }
      return row;
    });

    rail.replaceChildren(...ticks, list, note);
    list.replaceChildren(...rows);
    markCurrent();
    markHot();
    list.scrollTop = list.scrollHeight;
  };

  // 一次 reset 会连着一两百次 add()，每次都重建刻度和行就是 O(n²) 的 DOM 开销；合并到一帧里画一次。
  let paintPending = 0;
  const schedulePaint = (): void => {
    if (paintPending) return;
    paintPending = requestAnimationFrame(() => {
      paintPending = 0;
      paint();
    });
  };

  // 整条带子离开才算「不看了」：从刻度扫到行、从一行扫到另一行都不算离开。
  rail.addEventListener("pointerleave", () => {
    hot = -1;
    markHot();
    opts.onHover(null);
  });
  // 每次展开都先停在最下面：正在发生的这一轮是最常被点的。
  const toBottom = (): void => {
    list.scrollTop = list.scrollHeight;
  };
  rail.addEventListener("pointerenter", toBottom);
  rail.addEventListener("focusin", toBottom);
  // 视口（以及宿主）变高变矮会改变能放下几根刻度、带子该停在哪，顺便重算一次。
  const ro = new ResizeObserver(() => {
    if (labels.length) paint();
  });
  ro.observe(host);
  if (opts.viewport && opts.viewport !== host) ro.observe(opts.viewport);

  return {
    clear() {
      labels.length = 0;
      ghosts = [];
      current = -1;
      hot = -1;
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
