/**
 * 弹层共用的两件小事：统一的 Esc 弹层栈、以及「挂在哪儿」。
 *
 * Esc 栈（`pushEscLayer`）：每个会被 Esc 关掉的东西（面板、子面板、小框、菜单、预览、选择框…）
 * 打开时登记一层，关闭时调返回的函数摘掉。全局只有一个 document keydown，**冒泡阶段**：
 * - 焦点处的控件要用 Esc 做事（清搜索、取消改名、先收下拉…）就 `preventDefault()` 或
 *   `stopPropagation()`，这一下就算它吃掉了，弹层不再动；
 * - 没人吃的 Esc 交给最上面一层的 `onEsc`（一般就是关它）。一次 Esc 只关一层。
 * `focusScoped` 层（非模态浮窗：预览、表格、幻灯片）只有焦点在自己里面时才接 Esc；焦点在聊天里就
 * 放过去，聊天里的 Esc 不被抢。
 *
 * `overlayHost` / `mountOverlay` 决定「挂在哪儿」：默认认 `#app` —— 往 `document.body` 上挂就不吃
 * `#app` 的 `zoom`，外观「字号」调到 125% 以上时同一个弹层会跟别的弹层两套尺寸（D123 / D263）。
 * **唯一的例外是设置控制台**（`.st-console` 那套壳）：它是量尺，必须 1:1 挂在 `body` 上（D449）——
 * 挂在 `#app` 里时把字号拖到 2.0，面板自己被放大到撑满整屏、手上那根滑杆被推出视口。
 * 判据只此一处：新建 `.st-console` 壳的人不用记得「我要挂 body」，走 `mountOverlay` / `overlay()` 就对。
 *
 * `markSurface`：浮层在**创建处**声明自己是哪一档材质，`mac.css` 只按这个属性挑玻璃 / 圆角 / 入场。
 * 以前材质靠 CSS 里四张手抄的类名名单（遮罩 / 窗口 / 菜单 / 吐司），每加一个面板都要记得去补名字，
 * 漏了就静默退回纯色板（D352 漏过一次、D389 又漏了四个）。现在漏的是「没打标记」，由探针扫出来。
 *
 * `retireOverlay`：Mac 主题下关闭时先演退场（`.mac-leaving`）再移除。app.ts 自己的 sheet 有一版
 * 更复杂的（同一轮又开了新面板要跳过入场），其余自管弹层的模块用这里的简单版。
 */

/**
 * 材质级（#644）：`window` 是带遮罩的窗口（根 = 遮罩，直接子元素 = 面板），`menu` / `toast` 是浮在
 * 页面上的小块，`dock` 是贴边的窗（预览右栏 / 终端），`paper` 是「登记在案、故意不套 Mac 材质」
 * （表格与幻灯片浮窗永远是浅色纸）。CSS 侧的取值集合必须与这张表一致（`theme-unit.mjs` 会红）。
 */
export type SurfaceKind = "window" | "menu" | "toast" | "dock" | "paper";
export const SURFACE_KINDS: readonly SurfaceKind[] = ["window", "menu", "toast", "dock", "paper"];

export interface SurfaceOpts {
  /** `window` 的入场：底部抽屉 / 贴右边推进 / alert 形缩放 / 不演。不写就是窗口从上方落下。 */
  enter?: "drawer" | "side" | "alert" | "none";
  /** 灯箱那种更暗的遮罩（`mac.css` 里 `--mac-scrim` 之外的一档）。 */
  dim?: "dark";
  /**
   * 只对 `window` 有意义：点遮罩时调它（一般就是关掉这层）。**不写就是点遮罩不关、面板轻弹一下**
   * （D437）。现在只有图片灯箱写它：看图时点黑底退出最自然，误触也不丢东西。别的窗口别开这个口子。
   */
  dismiss?: () => void;
}

/** 显式声明了「点遮罩就关」的窗口根 → 关闭函数。 */
const backdropDismiss = new WeakMap<HTMLElement, () => void>();
/** 这一下点击是不是从遮罩上按下的：在面板里拖选 / 拖滚动条、在遮罩上松手，不算点遮罩。 */
let downTarget: EventTarget | null = null;
let backdropInstalled = false;

function isWindowRoot(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.macSurface === "window";
}

/** 点遮罩不关的反馈：面板轻轻放大再回来，约 150ms。用 WAAPI 的 `scale`，不碰 CSS 的 `animation` / `transform`，
 *  入场还没演完时点了也不会把入场打断。系统开了「减少动态效果」就不演。 */
export function nudgeWindow(root: HTMLElement): void {
  const panel = [...root.children].find((c): c is HTMLElement => c instanceof HTMLElement && !c.hidden) ?? null;
  if (!panel || typeof panel.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  for (const a of panel.getAnimations()) if (a.id === "backdrop-nudge") a.cancel();
  panel.animate([{ scale: "1" }, { scale: "1.015" }, { scale: "1" }], {
    duration: 160,
    easing: "ease-out",
    id: "backdrop-nudge",
  });
}

/** 遮罩上的点击全局只在这一处处理（D437）：声明了 `dismiss` 的关，其余只轻弹。不拦传播 ——
 *  窗口里开着的下拉 / 菜单靠 document 上的监听「点外面就关」，点遮罩也得让它们收起。 */
function installBackdrop(): void {
  if (backdropInstalled || typeof document === "undefined") return;
  backdropInstalled = true;
  document.addEventListener("pointerdown", (ev) => (downTarget = ev.target), true);
  document.addEventListener("click", (ev) => {
    const target = ev.target;
    const pressed = downTarget;
    downTarget = null;
    if (!isWindowRoot(target)) return;
    // 键盘触发的 click（detail 0）不会落在遮罩上；鼠标从面板里按下、拖到遮罩上松手也不算。
    if (pressed !== null && pressed !== target) return;
    const dismiss = backdropDismiss.get(target);
    if (dismiss) dismiss();
    else nudgeWindow(target);
  });
}

/**
 * 给浮层打上材质标记；返回节点本身，方便 `const pop = markSurface(el("div", "remind-pop"), "menu")`。
 *
 * 只在**创建处**调一次。别在别处补调 —— 那等于又把「谁忘了」变成一个人肉约定。
 */
export function markSurface<T extends HTMLElement>(node: T, kind: SurfaceKind, opts: SurfaceOpts = {}): T {
  node.dataset.macSurface = kind;
  if (opts.enter) node.dataset.macEnter = opts.enter;
  if (opts.dim) node.dataset.macDim = opts.dim;
  if (kind === "window") {
    if (opts.dismiss) backdropDismiss.set(node, opts.dismiss);
    installBackdrop();
  }
  return node;
}

export interface EscLayer {
  /** 层的根元素；`focusScoped` 时用它判断焦点是否在层里。 */
  el?: HTMLElement;
  /** 非模态浮窗：只有焦点在 `el` 里时才接 Esc。 */
  focusScoped?: boolean;
  /** Esc 到了这一层时执行（一般是关它）。 */
  onEsc: () => void;
}

const layers: EscLayer[] = [];
let installed = false;

function acceptsEsc(layer: EscLayer): boolean {
  if (!layer.focusScoped) return true;
  const active = document.activeElement;
  return Boolean(layer.el && active && layer.el.contains(active));
}

/**
 * 让栈顶第一层肯接 Esc 的那层关掉一层；返回是否有层接了。
 * 传了 `ev` 就先 `preventDefault()`。给「别的文档转过来的 Esc」用（内网通 iframe 里没人接的 Esc）。
 */
export function escapeTopLayer(ev?: KeyboardEvent): boolean {
  // 从上往下找第一层肯接 Esc 的：焦点不在的非模态浮窗让到下面那层。
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    // 挂着的那扇已经从页面上拿掉（小框被取消 / 面板被替换）：顺手摘掉，别让它挡住下面的层。
    if (layer.el && !layer.el.isConnected) {
      layers.splice(i, 1);
      continue;
    }
    if (!acceptsEsc(layer)) continue;
    ev?.preventDefault();
    layer.onEsc();
    return true;
  }
  return false;
}

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing) return;
  escapeTopLayer(ev);
}

/** 登记一层 Esc；返回「摘掉」的函数（重复调用安全）。 */
export function pushEscLayer(layer: EscLayer): () => void {
  if (!installed) {
    document.addEventListener("keydown", onKeyDown);
    installed = true;
  }
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/** 模态弹层的简写：任何时候 Esc 都调 `onEscape`。 */
export function trapEscape(onEscape: () => void): () => void {
  return pushEscLayer({ onEsc: onEscape });
}

/**
 * 现在有没有「大块浮层」开着（窗口 / 贴边窗 / 表格浮窗）。
 *
 * 判据是材质标记（#644），不再另抄一份类名名单 —— 抄漏一个，自动弹出的东西就会压在灯箱或
 * 子弹层上面。菜单与吐司不算：它们随手一关就没了，为了它们把更新日志压掉整场不划算
 * （`.update-bar` 是长期挂着的一条）。
 */
export function overlaysOpen(): boolean {
  return Boolean(
    document.querySelector('[data-mac-surface="window"], [data-mac-surface="dock"], [data-mac-surface="paper"]'),
  );
}

/**
 * 浮层挂哪儿：默认进 `#app`（拿不到才退回 body，比如单元测试里的假 DOM），跟着外观「字号」缩放。
 * 例外只有**控制台宿主**：它自己就是 `.st-console`，或直接装着 `.st-console`（`.st-back` /
 * `.sheet-back` 这类外壳）—— 控制台是量尺，1:1 挂 body（D449）。
 *
 * 判据刻意只认**直接子级**：哪个普通浮层把一个 `.st-console` 当子面板嵌在深处，不该跟着它一起
 * 脱开缩放（那种情况是「浮层里嵌了一块控制台」，不是「这个浮层就是控制台」）。
 */
export function overlayHost(root: HTMLElement): HTMLElement {
  const isConsole = root.matches(".st-console") || Boolean(root.querySelector(":scope > .st-console"));
  return isConsole ? document.body : (document.getElementById("app") ?? document.body);
}

export function mountOverlay(root: HTMLElement): void {
  overlayHost(root).append(root);
}

/**
 * `#app` 上挂着 `zoom: var(--ui-scale)`（外观「字号」）：`getBoundingClientRect()` 量到的是**视觉** px，
 * 而写进 `style.left/top` 的是布局 px，中间差一个缩放。挂进 `#app` 的浮层贴锚点时先除一次。
 */
export function appZoom(): number {
  const app = document.getElementById("app");
  const raw = Number.parseFloat(getComputedStyle(app ?? document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Mac 主题下给浮层挂退场（`.mac-leaving`，mac.css 里配 `mac-fade-out` / `mac-window-out`）。
 * 返回 true 表示动画已经挂上，调用方负责在 LEAVE_MS 之后把它移除；false 就当场移除。
 *
 * 判断主题看 `html[data-ui]` 而不是传给各模块的 prefs：动画是 CSS 按这个属性挑的，
 * 两边用同一个开关才不会出现「JS 以为在演、CSS 不认」的一帧空白。
 */
export function startLeaving(node: HTMLElement): boolean {
  if (document.documentElement.dataset.ui !== "mac") return false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  node.classList.add("mac-leaving");
  node.inert = true;
  return true;
}

/** 退场动画的时长（mac.css 里那 200ms 留 10ms 余量）。 */
export const LEAVE_MS = 210;

/**
 * 关掉一层浮层：Mac 主题下先演退场再移除，其它主题立即移除。
 * 自管弹层的模块（系统管理 / Jira / 邮箱 / 确认框 / 灯箱 / 笔记选人 / 小选择器）都该走这里，
 * 否则它们的关闭会和 app.ts 那批 sheet 两个手感。
 */
export function retireOverlay(node: HTMLElement | null): void {
  if (!node) return;
  if (!startLeaving(node)) {
    node.remove();
    return;
  }
  window.setTimeout(() => node.remove(), LEAVE_MS);
}
