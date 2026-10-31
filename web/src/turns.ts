/**
 * 轮次缩略图（turn rail）：对话右缘一条刻度带，一根刻度 = 一轮用户输入。鼠标移到带上才展开左侧的
 * 小列表 —— 每行是那一轮的开头（单行、右对齐、超出打点），末行＝当前这一轮。点一行（或一根刻度）
 * 就跳回那一轮，鼠标扫过某行时那一轮会亮一下，顺带在正文里高亮对应那条用户消息（Q-028）。
 *
 * 这里只管几何、抽样和高亮，不认识消息结构：ChatView 递进来的是「一行文字」，跳转也由它自己做。
 */

/** 刻度只有 2px 高、间距 4px，所以一条刻度占 6px 版面。 */
const TICK_H = 2;
const TICK_GAP = 4;

export interface TurnRail {
  /** 换会话：清空所有刻度和行。 */
  clear(): void;
  /** 新增一轮用户输入（`label` 是压成单行的开头文字）。 */
  add(label: string): void;
  /** 「你在哪一轮」——滚动时由 ChatView 按视口顶部落下的那一轮喂进来。 */
  setCurrent(index: number): void;
}

export interface TurnRailOpts {
  /** 点某一行 / 某根刻度。 */
  onPick(index: number): void;
  /** 鼠标在某一行上（null = 离开），用于在正文里预览高亮那条消息。 */
  onHover(index: number | null): void;
  /**
   * 正文的滚动视口。带子的高度和垂直中心都按它算 —— 宿主（对话栏）还包含输入框与底栏，
   * 按宿主的七成算会让长会话的刻度一直长到输入框里去。
   */
  viewport?: HTMLElement | null;
}

export function mountTurnRail(host: HTMLElement, opts: TurnRailOpts): TurnRail {
  const rail = document.createElement("div");
  rail.className = "turn-rail";
  rail.hidden = true;
  const list = document.createElement("div");
  list.className = "turn-list";
  rail.append(list);
  host.append(rail);

  const labels: string[] = [];
  /** 刻度下标 → 轮次下标。轮次多于版面时按比例抽样，首尾一定保留（最后一轮永远在带上）。 */
  let mapped: number[] = [];
  let ticks: HTMLButtonElement[] = [];
  let rows: HTMLButtonElement[] = [];
  let current = -1;
  let hot = -1;

  /** 一根刻度代表从它到下一根刻度之间的所有轮次，所以「当前」落在区间里就算命中。 */
  const covers = (k: number, index: number): boolean => {
    const from = mapped[k];
    const to = k + 1 < mapped.length ? mapped[k + 1] : labels.length;
    return index >= from && index < to;
  };

  const markCurrent = (): void => {
    rows.forEach((row, i) => row.classList.toggle("cur", i === current));
    ticks.forEach((tick, k) => tick.classList.toggle("cur", current >= 0 && covers(k, current)));
  };

  const markHot = (): void => {
    rows.forEach((row, i) => row.classList.toggle("hot", i === hot));
    ticks.forEach((tick, k) => tick.classList.toggle("hot", hot >= 0 && covers(k, hot)));
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
    rail.hidden = labels.length < 2;
    frame();
    // 版面高度按正文视口七成算：刻度带上下一起来，最长也就是这个高度。
    const view = opts.viewport ?? host;
    const avail = Math.max(96, Math.round((view.clientHeight || 560) * 0.7));
    const fit = Math.max(3, Math.floor((avail + TICK_GAP) / (TICK_H + TICK_GAP)));
    mapped = [];
    if (labels.length <= fit) {
      for (let i = 0; i < labels.length; i++) mapped.push(i);
    } else {
      for (let j = 0; j < fit; j++) mapped.push(Math.round((j * (labels.length - 1)) / (fit - 1)));
    }

    ticks = mapped.map((index) => {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.className = "turn-tick";
      tick.dataset.i = String(index);
      tick.title = `第 ${index + 1} 轮：${labels[index]}`;
      tick.setAttribute("aria-label", `跳到第 ${index + 1} 轮：${labels[index]}`);
      tick.onclick = () => opts.onPick(index);
      tick.onpointerenter = () => {
        hot = index;
        markHot();
        opts.onHover(index);
      };
      return tick;
    });

    rows = labels.map((label, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "turn-row";
      row.dataset.i = String(index);
      row.title = `第 ${index + 1} 轮：${label}`;
      const text = document.createElement("span");
      text.className = "txt";
      text.textContent = label;
      const dash = document.createElement("span");
      dash.className = "dash";
      row.append(text, dash);
      row.onclick = () => opts.onPick(index);
      row.onpointerenter = () => {
        hot = index;
        markHot();
        opts.onHover(index);
      };
      return row;
    });

    rail.replaceChildren(...ticks, list);
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
      current = -1;
      hot = -1;
      paint();
    },
    add(label) {
      labels.push(label);
      schedulePaint();
    },
    setCurrent(index) {
      const next = labels.length ? Math.max(0, Math.min(labels.length - 1, index)) : -1;
      if (next === current) return;
      current = next;
      markCurrent();
    },
  };
}
