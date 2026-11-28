/**
 * 窗口几何（#755）：每扇 `window` 浮层右下角一只抓手，拖完记住、双击复原。
 *
 * 和「终端几何」（D93）的分工：窗口**只记宽高**，位置仍由样式决定（居中窗居中、抽屉贴底）；
 * dock（终端 / 表格 / 幻灯片 / 预览）本来就能被拖走，几何里多两个 `l` / `t`。两者存在同一个键
 * `pi.dialogGeom` 里，`{ [id]: { w, h, l?, t? } }`，单位一律是**布局 px**（`#app` 的 zoom 之前的值）。
 *
 * 几条刻意的选择：
 * - **抓手指向遮罩（`back`）而不是面板**：面板自己可能是滚动容器（新建会话就是 `overflow-y: auto`），
 *   `position: absolute; bottom: 0` 会跟着内容一起滚走；挂遮罩上就不会。代价是要按面板的 rect 摆位置，
 *   窗口开场的位移动画期间也得跟着（所以开场那十几帧用一个短 rAF 循环对齐）。
 * - **没拖过不写 inline 尺寸**：第一次打开时宽高还是样式表那套（抽屉满宽、居中窗 `min(720px, 96vw)`、
 *   高度贴内容），拖过一次才写死 —— 内容少的窗不会莫名多出一块空白。
 * - **窄屏不装**：布局宽 < 900 时窗口本就接近满屏，拉着只会把自己卡住。
 * - 双击 / Enter 复原、方向键 ±16（Shift ±64）调大小；Esc 不碰，留给窗口自己的 Esc 栈（D437 / 「逐层关闭」）。
 */

import { appZoom } from "./modal.ts";
import { clampNum, dragFloat, type FloatBox } from "./floatwin.ts";
import { tr } from "./i18n/index.ts";
import { isExempt, type DialogId } from "./dialoggeom-ids.ts";

export type { DialogId };

const KEY = "pi.dialogGeom";
/** 抓手边长的兜底值；真实值量自 `.win-grip` 的 `offsetWidth`（CSS 的 `--win-grip-size` 是真源）。 */
const GRIP_FALLBACK = 18;
/** 每扇窗的默认地板：再小就只剩标题栏了。调用处可以覆写。 */
const FLOOR_W = 320;
const FLOOR_H = 240;
/** 布局宽小于它就当作窄屏（与 `App.compact()` 同一个阈值）。 */
const COMPACT = 900;
/** 开场动画最多演这么久，这段时间里逐帧把抓手贴回角上。 */
const SETTLE_FRAMES = 18;
/** 更老的「只有终端高度」那个键（Q-026 时代）。 */
const LEGACY_TERM_H = "pi.termH";

export interface Geom {
  w?: number;
  h?: number;
  l?: number;
  t?: number;
}

export interface AttachOpts {
  /** 遮罩（`position: fixed; inset: 0` 那个根）：抓手挂这儿。 */
  back: HTMLElement;
  /** 面板；不传就取 `back` 的第一个元素子节点。 */
  panel?: HTMLElement;
  /** 最小宽高（面板 px）。默认 320×240。 */
  min?: [number, number];
}

export interface WindowGeomHandle {
  grip: HTMLElement;
  /** 最大化之类的状态：true = 收起抓手、先别写 inline 尺寸（记忆留着）；false = 回到记过的大小。 */
  suspend: (on: boolean) => void;
  /**
   * 把记忆里的尺寸重新铺一遍、抓手重新贴角。给「收起 = `hidden`、不摘 DOM」的窗用：
   * 那种窗再打开时几何模块的 rAF 早就收工了，得由 `open()` 叫这一声。
   * 面板看不见时它是空操作（隐藏态 rect 全是 0，铺了也是错的）。
   */
  apply: () => void;
}

// ---------------------------------------------------------------- 存盘

function readAll(): Record<string, Geom> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, Geom> = {};
    for (const [id, geom] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitize(geom);
      if (clean) out[id] = clean;
    }
    return out;
  } catch {
    // 存坏了就当没存过：下一次拖动会重写
    return {};
  }
}

function writeAll(all: Record<string, Geom>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不下也不影响这一次使用
  }
}

/** 只认有限的数字，且宽高得是正的：手改 localStorage 或者旧版本留下的脏值不该把窗口撑爆。 */
function sanitize(raw: unknown): Geom | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const geom: Geom = {};
  for (const k of ["w", "h", "l", "t"] as const) {
    const n = Number(src[k]);
    if (Number.isFinite(n)) geom[k] = k === "w" || k === "h" ? Math.max(1, n) : n;
  }
  if (geom.w === undefined && geom.h === undefined && geom.l === undefined && geom.t === undefined) return null;
  return geom;
}

export function loadGeom(id: DialogId): Geom | null {
  return readAll()[id] ?? null;
}

export function saveGeom(id: DialogId, geom: Geom): void {
  const clean = sanitize(geom);
  if (!clean) return;
  const all = readAll();
  all[id] = clean;
  writeAll(all);
}

export function clearGeom(id: DialogId): void {
  const all = readAll();
  if (!(id in all)) return;
  delete all[id];
  writeAll(all);
}

/**
 * 把四个旧键搬进新键：**读一次、不删旧键**。回滚到旧构建时终端与表格还认得原来的位置 ——
 * 这是刻意留的，不是忘了清理。
 */
/** 「已经搬过了」的标记：迁移只该发生一次，否则每次挂窗都会把刚被复原 / 还原掉的旧键又搬回来。 */
const MIGRATED = "pi.dialogGeom.migrated";

export function migrateOldGeom(): void {
  try {
    if (localStorage.getItem(MIGRATED) === "1") return;
  } catch {
    // 读不到标记（禁用站点数据）就当没搬过：下面的写入也会失败，不影响这一屏
  }
  const all = readAll();
  let dirty = false;
  const put = (id: DialogId, geom: Geom | null): void => {
    if (!geom || all[id]) return;
    const clean = sanitize(geom);
    if (!clean) return;
    all[id] = clean;
    dirty = true;
  };
  const parse = (key: string): Geom | null => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return sanitize(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  /** 旧键里可能是个裸数字（`pi.viewerW` / `pi.termH` 就是），也可能读不到 —— 一律当没有。 */
  const num = (key: string): number => {
    try {
      const raw = Number(localStorage.getItem(key));
      return Number.isFinite(raw) ? raw : NaN;
    } catch {
      return NaN;
    }
  };

  put("term", parse("pi.termGeom"));
  // Q-026 时代只记了高度（`pi.termH`），没有位置；比它还老的机器上也可能是这个键。
  if (!all.term) {
    const h = num(LEGACY_TERM_H);
    if (h >= 140) put("term", { h });
  }
  // 文件预览只记宽度（`pi.viewerW`），高度由样式和视口决定。
  const viewerW = num("pi.viewerW");
  if (viewerW >= 320) put("preview", { w: viewerW });
  put("sheet", parse("pi.sheetGeom"));
  put("slides", parse("pi.slidesGeom"));

  if (dirty) writeAll(all);
  try {
    localStorage.setItem(MIGRATED, "1");
  } catch {
    // 写不进去就下次再搬一遍（幂等：目标 id 已存在的不覆盖）
  }
}

/**
 * 「还原所有窗口尺寸」：所有 id 一起忘掉（含 dock 的位置），**旧键也删掉**。
 *
 * 删旧键是刻意的例外（迁移本身「读一次、不删」，那是为了回滚）：用户既然说「全还原」，
 * 旧键留着就等于把「还没搬完的旧记忆」藏在地毯下面，回滚回去反而更困惑。
 */
export function resetAllWindowGeom(): void {
  writeAll({});
  for (const key of ["pi.termGeom", LEGACY_TERM_H, "pi.viewerW", "pi.sheetGeom", "pi.slidesGeom"]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 删不掉也只能这样
    }
  }
}

// ---------------------------------------------------------------- 尺寸数学

/** 遮罩的内边距：板子不能顶到遮罩边上去（`.sheet-back.center` 那圈 16px）。 */
function backdropPad(back: HTMLElement): [number, number] {
  const cs = getComputedStyle(back);
  const px = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  const py = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
  return [px, py];
}

/**
 * 一处浮层里同时存在两套「缩放后的坐标」：
 * - **面板空间**：写进 `panel.style.width` 的那套。挂在 `#app` 里的窗口差一个 `--ui-scale`；
 *   `.st-console` 那一族（设置 / 模型 / 产物 / 评审 …）1:1 挂 body、但自己吃 `zoom: var(--st-zoom)`
 *   （D463），差的就是它。
 * - **遮罩空间**：抓手是遮罩的子元素，它的 `left/top` 在这套里。
 *
 * 两个都**实测**（rect ÷ offsetWidth），不猜 CSS 变量：字号、控制台倍率、以后再加的缩放层都自动算进去。
 * 量不到（面板还没挂上、`display: none`）才退回 `--ui-scale`。
 */
interface Spaces {
  /** 视觉 px ÷ 面板 px。 */
  panel: number;
  /** 视觉 px ÷ 遮罩 px。 */
  host: number;
}

/**
 * 一个元素「视觉 px ÷ 自己的 CSS px」的倍率 = 从它到文档根之间所有祖先 `zoom` 的乘积。
 *
 * **为什么不用 `rect ÷ offsetWidth`**：那个比值把 `transform` 也算进去了。面板入场动画正是
 * `scale: 0.94 → 1`（`mac-window-in`，460ms 弹簧），量在动画中间就是错的；而 `apply()` 只在
 * 挂载那一刻跑一次，错的尺寸要等到下一次窗口 resize 才被纠正。按祖先链上的 `zoom` 算与动画无关：
 * `zoom` 是布局属性，不受 transform 影响，隐藏时（`display: none`）也照样读得到。
 *
 * 读 computed style 要走整条祖先链，所以结果**只跟三样东西有关**时才缓存：倍率只在
 * 「字号 / 控制台倍率变了」时变 —— 那两件事都会触发窗口 resize 之外的 `apply()`（见 `onWindowResize`
 * 与调用处的 `--st-zoom` 变更），这里每次现算、不缓存，反正一扇窗一次挂载只算两回。
 */
function zoomOf(el: HTMLElement): number {
  let zoom = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const raw = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(raw) && raw > 0) zoom *= raw;
  }
  return zoom > 0 ? zoom : appZoom();
}

function spacesOf(back: HTMLElement, panel: HTMLElement): Spaces {
  return { host: zoomOf(back), panel: zoomOf(panel) };
}

/** 面板空间里能用多大：视口（÷ 面板缩放）再扣掉遮罩留白（也要换算成面板空间）。 */
function viewBox(sp: Spaces, back: HTMLElement): { vw: number; vh: number } {
  const [padX, padY] = backdropPad(back);
  const toPanel = sp.host / sp.panel;
  return {
    vw: window.innerWidth / sp.panel - padX * toPanel,
    vh: window.innerHeight / sp.panel - padY * toPanel,
  };
}

/**
 * 铺尺寸。顺手把 `max-height` 让开：样式表里那几条盖子（`.sheet` 78vh、`.context-sheet` 92%）
 * 是为了「没拖过时别顶满」，用户既然拖了就该由指针说了算 —— 不摘的话往下拖到 78vh 就卡住、
 * 爪子还跟着手指走，像坏了。上限仍由 `viewBox()` 夹在视口里。
 */
function setBox(panel: HTMLElement, w: number, h: number): void {
  panel.style.width = `${Math.round(w)}px`;
  panel.style.height = `${Math.round(h)}px`;
  panel.style.maxHeight = "none";
}

/** 摘掉「拖过之后才写」的那几样 inline 尺寸，回到样式表说了算。 */
function clearBox(panel: HTMLElement): void {
  for (const prop of ["width", "height", "max-height"]) panel.style.removeProperty(prop);
}

function measureBox(panel: HTMLElement, sp: Spaces): { w: number; h: number } {
  const r = panel.getBoundingClientRect();
  return { w: r.width / sp.panel, h: r.height / sp.panel };
}

// ---------------------------------------------------------------- 窗口

/**
 * 开着的窗口登记表。**一个 window 的 resize 监听管全部窗口**（不是每扇挂一个：窗口开开关关，
 * 每扇挂一个就是一条只增不减的监听器泄漏）。每次 resize 顺手把已经从文档里摘掉的收摊。
 */
interface LiveWindow {
  apply: () => void;
  place: () => void;
  drop: () => void;
}

const live = new Map<HTMLElement, LiveWindow>();
let resizeBound = false;

function bindWindowResize(): void {
  if (resizeBound) return;
  resizeBound = true;
  window.addEventListener("resize", onWindowResize);
}

/** 把已经从文档里摘掉的窗口收摊（观察器断开、登记项删掉）。开窗与 resize 时各跑一次。 */
function pruneDeadWindows(): void {
  for (const [panel, win] of live) {
    if (panel.isConnected) continue;
    win.drop();
    live.delete(panel);
  }
}

function onWindowResize(): void {
  pruneDeadWindows();
  for (const [panel, win] of live) {
    if (!panel.isConnected) continue;
    // 缩放之后把尺寸夹回视口、窄屏收起 / 宽屏装回来 —— 这两件事都在 `apply()` 里，
    // 别在外面再补一句 `grip.hidden = false`（会跟窄屏那一支打架）。
    win.apply();
    win.place();
  }
}

export function attachWindowGeom(id: DialogId, opts: AttachOpts): WindowGeomHandle | null {
  if (isExempt(id)) return null;
  const back = opts.back;
  const panel = opts.panel ?? (back.firstElementChild as HTMLElement | null);
  if (!panel) return null;
  const [minW, minH] = opts.min ?? [FLOOR_W, FLOOR_H];
  const spaces = (): Spaces => spacesOf(back, panel);
  /** 窄不窄看**遮罩空间**（视口 ÷ 宿主缩放）：与控制台自己的折叠档位（按面板宽）是两件事。 */
  const narrow = (): boolean => window.innerWidth / spaces().host < COMPACT;

  const grip = document.createElement("div");
  grip.className = "win-grip";
  grip.setAttribute("role", "separator");
  grip.tabIndex = 0;
  // 屏幕阅读器与悬停提示说同一句话：这是什么、怎么用。
  const label = tr("拖动调整窗口大小（双击复原）");
  grip.setAttribute("aria-label", label);
  grip.title = label;
  panel.classList.add("win-grip-panel");
  back.append(grip);

  let suspended = false;
  /**
   * 面板「真的看得见」：挂在文档里，而且有 client rect。隐藏态（`hidden` / `display: none`）下
   * rect 全是 0 —— 铺尺寸没意义（显示出来 CSS 自己会铺），摆位置更是错的（爪子会落到遮罩左上角）。
   * 所以 `apply()` / `place()` 只在看得见时跑；看不见的那次跳过，显示出来之后由
   * ResizeObserver（`display: none → 可见` 会触发一次回调）与下面的 rAF 补上。
   */
  const shown = (): boolean => panel.isConnected && panel.getClientRects().length > 0;
  // 窄屏（布局宽 < 900）起步就收起；转宽屏时由 `apply()` 装回来（那次 resize 会调它）。
  if (narrow()) {
    grip.hidden = true;
    grip.tabIndex = -1;
  }

  /** 把爪子贴到面板右下角。面板开场有位移 / 缩放动画，所以登场那几帧要反复对。
   *  面板看不见（`hidden`）时 rect 全是 0，摆了等于摆到左上角 —— 那一下跳过，等显示出来再摆。 */
  const place = (): void => {
    if (!shown()) return;
    // 抓手是遮罩的直接子元素，`left/top` 在**遮罩空间**里（控制台窗口的遮罩与面板不是一个缩放）。
    const size = grip.offsetWidth || GRIP_FALLBACK;
    const pr = panel.getBoundingClientRect();
    const br = back.getBoundingClientRect();
    const host = spaces().host;
    grip.style.left = `${Math.round((pr.right - br.left) / host) - size}px`;
    grip.style.top = `${Math.round((pr.bottom - br.top) / host) - size}px`;
  };

  const apply = (): void => {
    if (!shown()) return;
    if (narrow()) {
      grip.hidden = true;
      grip.tabIndex = -1;
      clearBox(panel);
      place();
      return;
    }
    if (suspended) {
      // 最大化期间：inline 尺寸会盖住 `.sheet.peer-sheet.max { width/height: 100% }`，
      // 而抓手上一次改动留下的 inline 值还在 —— 一律摘掉，等退出最大化再铺回来。
      clearBox(panel);
      place();
      return;
    }
    grip.hidden = false;
    grip.tabIndex = 0;
    const geom = loadGeom(id);
    if (!geom || geom.w === undefined || geom.h === undefined) {
      // 没拖过：一次 inline 都不写，完全交给样式表（高度贴内容、抽屉满宽）。
      clearBox(panel);
      place();
      return;
    }
    const sp = spaces();
    const { vw, vh } = viewBox(sp, back);
    setBox(panel, clampNum(geom.w, Math.min(minW, vw), vw), clampNum(geom.h, Math.min(minH, vh), vh));
    place();
  };

  const save = (): void => {
    const { w, h } = measureBox(panel, spaces());
    saveGeom(id, { w: Math.round(w), h: Math.round(h) });
  };

  const reset = (): void => {
    clearGeom(id);
    apply();
  };

  const suspend = (on: boolean): void => {
    suspended = on;
    grip.hidden = on || narrow();
    grip.tabIndex = on || narrow() ? -1 : 0;
    // 最大化靠 CSS 的 `width/height: 100%`，inline 尺寸会盖住它 —— 先摘掉，退出最大化时再铺回来。
    if (on) {
      clearBox(panel);
    } else {
      apply();
    }
    place();
  };

  // 已经挂进文档且看得见就当场铺尺寸、当场摆位置（不能等下一帧：第一帧会看见抓手闪在窗中间）。
  // 还没挂上（多数调用点是 `back.append(sheet)` 之后、`overlay()` 之前）就等挂上再说 ——
  // 遮罩的内边距要挂进文档才量得到。
  let booted = false;
  if (shown()) {
    booted = true;
    apply();
    place();
  }
  // 之后再把开场那十几帧跟一遍：入场动画（抽屉推进 / 窗口落下）期间 rect 一直在动，
  // ResizeObserver 只认尺寸变化，看不到位移。等挂载也在这几帧里 —— 窗口被立刻关掉的极端情况下
  // 帧数用完就收工，别留下一个永远转下去的 rAF。
  let settleToken = 0;
  const settle = (): void => {
    const token = ++settleToken;
    let tries = SETTLE_FRAMES;
    const tick = (): void => {
      if (token !== settleToken) return; // 又开了一轮新的（收起再打开），这轮作废
      if (panel.isConnected) {
        if (!booted && shown()) {
          booted = true;
          apply();
        }
        place();
      }
      if (--tries > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  settle();

  dragFloat(
    grip,
    panel,
    "size",
    (box, dx, dy) => {
      const { vw, vh } = viewBox(spaces(), back);
      setBox(panel, clampNum(box.w + dx, minW, Math.max(minW, vw)), clampNum(box.h + dy, minH, Math.max(minH, vh)));
      place();
    },
    // `dragFloat` 的 `scale` 是「视觉 px → 面板 px」，与存盘同一套。
    { scale: () => spaces().panel, inset: () => 0, pin: false, save },
  );

  grip.addEventListener("dblclick", reset);
  grip.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      reset();
      return;
    }
    const step = ev.shiftKey ? 64 : 16;
    const dx = ev.key === "ArrowRight" ? step : ev.key === "ArrowLeft" ? -step : 0;
    const dy = ev.key === "ArrowDown" ? step : ev.key === "ArrowUp" ? -step : 0;
    if (!dx && !dy) return;
    // 抓手上自己吃掉方向键：别让它穿到窗里的列表 / 表格（那里方向键是干活用的）。
    ev.preventDefault();
    ev.stopPropagation();
    const sp = spaces();
    const { vw, vh } = viewBox(sp, back);
    const now = measureBox(panel, sp);
    setBox(panel, clampNum(now.w + dx, minW, Math.max(minW, vw)), clampNum(now.h + dy, minH, Math.max(minH, vh)));
    save();
    place();
  });

  // 面板自己变尺寸（内容变多、字号变了）时爪子跟着走。面板从文档里被摘掉（关窗）之后这一步
  // 由下面的常驻登记表收摊 —— 一扇窗一个 ResizeObserver，不摘就是几十个僵尸观察者。
  let wasShown = shown();
  const ro = new ResizeObserver(() => {
    if (!shown()) {
      wasShown = false;
      return;
    }
    // 从看不见到看得见（随手问 / 选文件浮层是 `hidden = true` 收起、不摘 DOM）：铺一遍，并且
    // 把「开场那十几帧」重新跟一遍 —— 显示出来那一刻入场动画照样会演，而首次挂载那一轮早就收工了。
    if (!wasShown) {
      wasShown = true;
      apply();
      settle();
      return;
    }
    place();
  });
  ro.observe(panel);

  pruneDeadWindows();
  live.set(panel, { apply, place, drop: () => ro.disconnect() });
  bindWindowResize();

  return { grip, suspend, apply };
}

/**
 * 给 dock 用的低层入口：量一块「布局 px」的盒子并写盘（`l` / `t` 只有 dock 写）。
 * 终端 / 表格 / 幻灯片各自的手势照旧，只把存储换成这一个键。
 */
export function saveDockGeom(id: DialogId, box: FloatBox): void {
  saveGeom(id, { l: Math.round(box.l), t: Math.round(box.t), w: Math.round(box.w), h: Math.round(box.h) });
}
