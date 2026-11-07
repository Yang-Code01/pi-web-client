/**
 * 挂在 body 上、`position: fixed` 的菜单该落在哪一格 —— 组头 ⋯、置顶胶囊的气泡、「全部置顶会话」、
 * 被折叠的工作区、「工作区与会话」浮层，全是贴着某一颗按钮往下一弹的东西，落位规矩只该有一份。
 *
 * 规矩：先贴锚点下方 `gap` 像素；下方放不下就整块翻到锚点上方（上方更宽敞时）；上下都只剩一条缝
 * 就把高度封到那一侧剩下的空间，菜单自己滚 —— 窗口再矮也得能点到「删除工作区」，不能让它整行
 * 戳到窗口外面去。左右同样夹进窗口的 `EDGE`。
 *
 * 抽成纯函数是为了让 `web/tests/menuplace-unit.mjs` 直接盯边角：组头贴着窗口底、窗口比菜单还矮、
 * 窄到塞不下。DOM 那侧只负责量尺寸和应用结果，见 `stickMenu()`。
 */

export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export interface BoxSize {
  w: number;
  h: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** 所选那侧的可用高度（已扣掉 gap 与边距）。`cap: false` 时别应用它：那种浮层自带高度上限。 */
  maxHeight: number;
  /** 翻到锚点上方了没有（单测与探针靠它解释结果）。 */
  flipped: boolean;
}

export interface MenuOpts {
  /** 菜单与锚点之间留的缝，默认 `MENU_GAP`。（组头 ⋯ 用 4px，置顶条那几颗用 6px。） */
  gap?: number;
  /** `false` = 不封顶、不写 `max-height`：浮层自己有限高和体内滚动（`.ws-pop` 的 70vh）。 */
  cap?: boolean;
}

/** 菜单与锚点之间留的缝。 */
export const MENU_GAP = 4;
/** 菜单离窗口边缘至少这么多。 */
export const MENU_EDGE = 8;
/** 上下都塞不下时至少留这么高能点 —— 封顶到 0 就是一块点不动的壳。 */
export const MENU_MIN_H = 96;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

export function placeMenu(
  anchor: AnchorRect,
  size: BoxSize,
  viewport: BoxSize,
  opts: MenuOpts = {},
): MenuPlacement {
  const gap = opts.gap ?? MENU_GAP;
  const below = viewport.h - anchor.bottom - gap - MENU_EDGE;
  const above = anchor.top - gap - MENU_EDGE;
  // 默认往下开；只有「下方确实放不下」且「上方更宽敞」才翻上去，免得菜单在窗口中间自己跳。
  const flipped = size.h > below && above > below;
  const room = flipped ? above : below;
  // 窗口比菜单还矮时别封顶到 0：留一截能点的，宁可压到边距上（位置照样夹在窗口里）。
  const maxHeight = Math.max(0, Math.floor(Math.max(room, Math.min(size.h, MENU_MIN_H))));
  // 自带限高的浮层按真实高度摆；其余按封顶后的高度摆，否则「翻到上方」会与锚点之间空出一段。
  const h = opts.cap === false ? size.h : Math.min(size.h, maxHeight);
  const top = flipped ? anchor.top - gap - h : anchor.bottom + gap;
  return {
    left: Math.round(clamp(anchor.left, MENU_EDGE, viewport.w - size.w - MENU_EDGE)),
    top: Math.round(clamp(top, MENU_EDGE, viewport.h - h - MENU_EDGE)),
    maxHeight,
    flipped,
  };
}

/**
 * 把已经挂进 body 的菜单摆到锚点旁边。两趟量：先放开上一趟的封顶量自然高（矮窗口里被压过的菜单
 * 判不准「下方放不放得下」），封顶后若挤出竖向滚动条、宽度变了，再按真实宽度夹一次左右。
 *
 * `cap: false` 给自带高度上限的浮层（`.ws-pop` 有 70vh + 体内滚动）：只要位置，不要封顶。
 */
export function stickMenu(node: HTMLElement, anchor: AnchorRect, opts: MenuOpts = {}): MenuPlacement {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const cap = opts.cap !== false;
  node.style.maxHeight = "";
  const natural = { w: node.offsetWidth, h: node.offsetHeight };
  let at = placeMenu(anchor, natural, viewport, opts);
  if (cap) node.style.maxHeight = `${at.maxHeight}px`;
  if (cap && node.offsetWidth !== natural.w) {
    // 滚动条把宽度挤大了：高度还按自然高判翻转，左右按真实宽度重夹。
    at = placeMenu(anchor, { w: node.offsetWidth, h: natural.h }, viewport, opts);
    node.style.maxHeight = `${at.maxHeight}px`;
  }
  node.style.left = `${at.left}px`;
  node.style.top = `${at.top}px`;
  return at;
}
