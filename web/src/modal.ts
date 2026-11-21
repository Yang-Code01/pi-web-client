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
 * `mountOverlay` 认 `#app`：往 `document.body` 上挂就不吃 `#app` 的 `zoom`，外观「字号」调到
 * 125% 以上时同一个弹层会跟别的弹层两套尺寸（D123 / D263）。
 *
 * `retireOverlay`：Mac 主题下关闭时先演退场（`.mac-leaving`）再移除。app.ts 自己的 sheet 有一版
 * 更复杂的（同一轮又开了新面板要跳过入场），其余自管弹层的模块用这里的简单版。
 */

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

/** 把浮层挂进 `#app`（拿不到才退回 body，比如单元测试里的假 DOM）。 */
export function mountOverlay(root: HTMLElement): void {
  (document.getElementById("app") ?? document.body).append(root);
}

/**
 * Mac 主题下给浮层挂退场（`.mac-leaving`，mac.css 里配 `mac-fade-out` / `mac-window-out`）。
 * 返回 true 表示动画已经挂上，调用方负责在 MOVE_MS 之后把它移除；false 就当场移除。
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
