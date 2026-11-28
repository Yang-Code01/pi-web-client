/**
 * 贴图之后那一下：图片先浮出来，再缩进右下角的「+N 图」徽标（D446）。
 *
 * 只做一件事 —— 让「贴上了」看得见。以前贴图只把徽标文字从「+1 图」改成「+2 图」，
 * 视线不在那个角落就等于没发生；现在贴上的图会以缩略图从输入框上方浮出来，弧形飞进徽标，
 * 落地那一刻徽标弹一下并实底闪一下。
 *
 * 三个必须自己算的地方：
 *
 * 1. **坐标是两套**。`#app` 上挂着 `zoom: var(--ui-scale)`，幽灵层也挂在里面，所以写进 style
 *    的 px 是布局 px，而 `getBoundingClientRect()` 给的是视觉 px —— 一律先按视觉 px 算、再除一次
 *    缩放（D123 的老坑，跟 `selask.ts` 同一套写法）。
 * 2. **缓动不能写变量**。WAAPI 的 `easing` 不认 `var(--mac-spring)`，会当场抛
 *    `TypeError: not a valid value for easing` —— 所以这里把两条曲线再抄一遍，值必须跟
 *    `mac-base.css` 里的 `--mac-ease` / `--mac-spring` 一致。
 * 3. **少动一点**。一次贴十张不该飞出十片：最多四片，剩下的靠徽标上的数字。
 *    `prefers-reduced-motion: reduce` 时整段跳过，连弹跳都不做。
 */
import type { PendingImage } from "./images.ts";

/** `--mac-ease`（iOS 弹层那条「快出慢收」）。 */
export const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** `--mac-spring`（带一点回弹）。 */
export const SPRING = "cubic-bezier(0.34, 1.42, 0.64, 1)";

/** 幽灵缩略图的边长（布局 px）。 */
const GHOST = 76;
/** 一张图从浮出到落进徽标要多久；跟原型里调过的一致，再快就只剩残影。 */
const FLY_MS = 700;
/** 多张之间错开的时间：看得出是「好几张」。 */
const STAGGER_MS = 90;
/** 再多也不飞更多片。 */
const MAX_GHOSTS = 4;
/** 徽标实底闪一下的时长（跟 styles.css 的动画时长目的一致，只是这里用定时器收）。 */
const FLASH_MS = 260;

export interface PasteFlyOpts {
  /** 落点：`+N 图` 那颗徽标（隐藏或量不到尺寸就不飞）。 */
  badge: HTMLElement;
  /** 起点：通常是输入框（`.composer-input`）的视觉 rect；缺省就从徽标自己飞出来。 */
  origin: DOMRect | null;
  /** 幽灵层挂哪儿 —— 必须是 `#app`（跟着字号缩放，别挂 body 上写死 px）。 */
  host: () => HTMLElement | null;
  /** 视觉 px → 布局 px 的除数（`#app` 的 zoom）。 */
  scale: () => number;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 待发图片 → 能塞进 `<img src>` 的 data URL（跟待发图片弹窗里缩略图用的是同一个）。 */
export function imageSrc(image: PendingImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * 徽标「落地」提示：弹一下 + 实底闪一下。
 * 弹跳是唯一一个不依赖幽灵缩略图的信号（最后一张落地、以及目录里选图附加时都用它）。
 */
export function badgeLanded(badge: HTMLElement, scale = 1.14): void {
  if (reducedMotion()) return;
  badge.animate(
    [
      { transform: "scale(.62)", opacity: 0.35 },
      { transform: `scale(${scale})`, opacity: 1, offset: 0.52 },
      { transform: "scale(.97)", offset: 0.78 },
      { transform: "scale(1)" },
    ],
    { duration: 400, easing: SPRING },
  );
  // 实底那一下交给 CSS：半透明强调色叠在浅底上几乎看不出变化（`.image-badge.flash`）。
  badge.classList.add("flash");
  window.setTimeout(() => badge.classList.remove("flash"), FLASH_MS);
}

/** 幽灵层的单例：没有幽灵在飞时整个摘掉，别在 `#app` 里留一层常驻的全屏浮层。 */
function layer(host: HTMLElement): HTMLElement {
  let el = host.querySelector<HTMLElement>(":scope > .paste-fly");
  if (!el) {
    el = document.createElement("div");
    el.className = "paste-fly";
    host.append(el);
  }
  return el;
}

/**
 * 把刚贴上的图从输入框飞进徽标。返回落地（最后一张停下）的 Promise，方便测试等它结束；
 * 不关心的话直接 `void` 掉。
 */
export function flyImagesToBadge(srcs: readonly string[], opts: PasteFlyOpts): Promise<void> {
  const host = opts.host();
  const target = opts.badge.getBoundingClientRect();
  if (!host || !srcs.length || reducedMotion() || target.width < 2) return Promise.resolve();

  const s = opts.scale() || 1;
  const from = opts.origin ?? target;
  const layerEl = layer(host);
  const shown = srcs.slice(0, MAX_GHOSTS);
  const flights: Promise<void>[] = [];

  // 先在视觉 px 里算清楚（幽灵的视觉边长是 GHOST × 缩放），再整体除一次换成布局 px：
  // 起点 = 输入框中间偏上（图「从输入框里浮出来」），终点 = 徽标正中。
  const half = (GHOST * s) / 2;
  const startX = (from.left + from.width / 2 - half) / s;
  const startY = (from.top - 54 * s) / s;
  const endX = (target.left + target.width / 2 - half) / s;
  const endY = (target.top + target.height / 2 - half) / s;
  const midX = startX + (endX - startX) * 0.4;
  const midY = startY + (endY - startY) * 0.4 - 18;

  shown.forEach((src, i) => {
    const ghost = document.createElement("div");
    ghost.className = "ghost";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    ghost.append(img);
    layerEl.append(ghost);
    // 多张时错开一点，免得叠成一片完全看不清。
    const dx = i * 14;
    const dy = i * 12;
    const anim = ghost.animate(
      [
        { transform: `translate(${startX + dx}px, ${startY + dy}px) scale(.7) rotate(-4deg)`, opacity: 0, offset: 0, easing: "cubic-bezier(.2,.9,.3,1)" },
        { transform: `translate(${startX + dx}px, ${startY + dy - 8}px) scale(1) rotate(-2deg)`, opacity: 1, offset: 0.22, easing: "ease-out" },
        { transform: `translate(${midX + dx}px, ${midY + dy}px) scale(.94) rotate(-1deg)`, opacity: 1, offset: 0.52, easing: "cubic-bezier(.45,0,.15,1)" },
        { transform: `translate(${endX}px, ${endY}px) scale(.2)`, opacity: 0.85, offset: 0.9, easing: "ease-out" },
        { transform: `translate(${endX}px, ${endY}px) scale(.12)`, opacity: 0, offset: 1 },
      ],
      { duration: FLY_MS, delay: i * STAGGER_MS, fill: "forwards" },
    );
    flights.push(
      new Promise<void>((resolve) => {
        anim.onfinish = () => {
          ghost.remove();
          // 飞完一张就收一层：最后一张落地时整层拆掉，`#app` 里不留空浮层。
          if (!layerEl.childElementCount) layerEl.remove();
          resolve();
        };
      }),
    );
  });

  // 落地只弹一次 —— 等最后一张（含错开延迟）停下。
  return Promise.all(flights).then(() => badgeLanded(opts.badge, 1.2));
}
