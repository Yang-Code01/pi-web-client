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
 *    的 px 是布局 px，而 `getBoundingClientRect()` 给的是视觉 px —— 位置一律先按视觉 px 算、
 *    再除一次缩放（D123 的老坑，跟 `selask.ts` 同一套写法）。但**弧顶、扇形错位、离输入框多高**
 *    这些「相对幽灵自己」的量是布局 px，跟 `.ghost` 的 76px 一样：字号放大时幽灵变大，弧线也按
 *    同样比例变大，不然 125% 字号下缩略图会比它飞的那条弧还高。下面 `START_LIFT` 等几个常量
 *    就是这个意思，别再把它们除一次。
 * 2. **缓动不能写变量**。WAAPI 的 `easing` 不认 `var(--mac-spring)`，会当场抛
 *    `TypeError: not a valid value for easing` —— 所以这里把曲线抄成字面量；抄对没抄对由
 *    `web/tests/pastefly-unit.mjs` 拿 `mac-base.css` 对一遍。
 * 3. **少动一点**。一次贴十张不该飞出十片：最多四片，剩下的靠徽标上的数字。
 *    `prefers-reduced-motion: reduce` 时整段跳过，连弹跳都不做。
 */
import { imageSrc, type PendingImage } from "./images.ts";

/** `--mac-spring`（带一点回弹）。必须跟 `mac-base.css` 里那条一模一样（单测对账）。 */
export const SPRING = "cubic-bezier(0.34, 1.42, 0.64, 1)";

/** 幽灵缩略图的边长（布局 px）。落点靠它的一半来居中，所以它只在这里定义 ——
 *  尺寸是脚本 `style.width/height` 写上去的，`styles.css` 里不再另写一份 76px。 */
const GHOST = 76;
/** 起点在输入框顶边上方多高（布局 px）。 */
const START_LIFT = 54;
/** 悬停帧再多抬一点，像被捏起来（布局 px）。 */
const HOLD_RISE = 8;
/** 弧顶比起点与终点之间的直线再高多少（布局 px）。 */
const ARC_LIFT = 18;
/** 多张之间的错位（布局 px），免得叠成一片完全看不清。 */
const FAN_X = 14;
const FAN_Y = 12;
/** 一张图从浮出到落进徽标要多久；跟原型里调过的一致，再快就只剩残影。 */
const FLY_MS = 700;
/** 多张之间错开的时间：看得出是「好几张」。 */
const STAGGER_MS = 90;
/** 再多也不飞更多片。 */
const MAX_GHOSTS = 4;
/** 徽标实底闪一下的时长。 */
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

/** `Element.animate` 缺失或拒绝这组关键帧时返回 null —— 动效是加分项，不该让贴图本身出错。 */
function animate(el: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  try {
    return el.animate(keyframes, options);
  } catch {
    return null;
  }
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 徽标身上正在跑的那条落地动画、和那个要摘 `.flash` 的定时器。
 * 连贴两次时先收掉上一次：不 cancel 的话动画对象会一直堆到 400ms，前一个定时器还会把刚挂上的
 * `.flash` 提前摘掉（第二次落地看起来就没闪）。
 */
const landing = new WeakMap<HTMLElement, { anim?: Animation | null; flash?: number }>();

/**
 * 徽标「落地」提示：弹一下 + 实底闪一下。
 * 弹跳是唯一一个不依赖幽灵缩略图也能成立的信号 —— 每一批附加（粘贴 / 拖拽 / 选文件 / 相册）
 * 最后都会调它一次。
 */
export function badgeLanded(badge: HTMLElement, pop = 1.2): void {
  if (reducedMotion()) return;
  const prev = landing.get(badge) ?? {};
  prev.anim?.cancel();
  if (prev.flash !== undefined) window.clearTimeout(prev.flash);
  const anim = animate(
    badge,
    [
      { transform: "scale(.62)", opacity: 0.35 },
      { transform: `scale(${pop})`, opacity: 1, offset: 0.52 },
      { transform: "scale(.97)", offset: 0.78 },
      { transform: "scale(1)" },
    ],
    { duration: 400, easing: SPRING },
  );
  // 实底那一下交给 CSS：半透明强调色叠在浅底上几乎看不出变化（`.image-badge.flash`）。
  badge.classList.add("flash");
  const flash = window.setTimeout(() => badge.classList.remove("flash"), FLASH_MS);
  landing.set(badge, { anim, flash });
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
 * 不关心的话直接 `void` 掉。动画被取消时也算这一张「停下」，Promise 不会悬着。
 */
export function flyImagesToBadge(images: readonly PendingImage[], opts: PasteFlyOpts): Promise<void> {
  // 调用方是 `void` 掉的：这里既不能把异常抛进 `addImages()`（那会连累整条贴图路径），
  // 也不能留下一条 unhandled rejection（那等于每次贴图都在控制台报一次错）。
  // 兜底只此一处，而且不静默 —— 真出了意外至少留一行控制台记录，查得到来源。
  try {
    return runFly(images, opts).catch((ex) => report(ex));
  } catch (ex) {
    report(ex);
    return Promise.resolve();
  }
}

/** 动效坏了不该挡住贴图，但也不该无声无息。 */
function report(ex: unknown): void {
  console.warn("paste-fly: 动效没能跑起来", ex);
}

function runFly(images: readonly PendingImage[], opts: PasteFlyOpts): Promise<void> {
  // 先做便宜的判断，最后才读 rect：`addImages()` 刚改过 DOM，多读一次就是多一次强制同步布局。
  // 拼 data URL 排在 `reducedMotion()` 与裁片之后：一次贴十几张 2048px 的图，只给真要飞的几片拼。
  if (!images.length || reducedMotion()) return Promise.resolve();
  const host = opts.host();
  const target = opts.badge.getBoundingClientRect();
  if (!host || target.width < 2) return Promise.resolve();

  const s = opts.scale() || 1;
  const from = opts.origin ?? target;
  const layerEl = layer(host);
  const shown = images.slice(0, MAX_GHOSTS).map(imageSrc);
  const flights: Promise<void>[] = [];

  // 两个中心点（视觉 px → 布局 px），弧顶与扇形错位直接加布局 px（见文件头第 1 条）。
  const half = (GHOST * s) / 2;
  const startX = (from.left + from.width / 2 - half) / s;
  const startY = from.top / s - START_LIFT;
  const endX = (target.left + target.width / 2 - half) / s;
  const endY = (target.top + target.height / 2 - half) / s;
  const midX = startX + (endX - startX) * 0.4;
  const midY = startY + (endY - startY) * 0.4 - ARC_LIFT;

  shown.forEach((src, i) => {
    const ghost = document.createElement("div");
    ghost.className = "ghost";
    ghost.style.width = `${GHOST}px`;
    ghost.style.height = `${GHOST}px`;
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    ghost.append(img);
    layerEl.append(ghost);
    const dx = i * FAN_X;
    const dy = i * FAN_Y;
    const anim = animate(
      ghost,
      [
        { transform: `translate(${startX + dx}px, ${startY + dy}px) scale(.7) rotate(-4deg)`, opacity: 0, offset: 0, easing: "cubic-bezier(.2,.9,.3,1)" },
        { transform: `translate(${startX + dx}px, ${startY + dy - HOLD_RISE}px) scale(1) rotate(-2deg)`, opacity: 1, offset: 0.22, easing: "ease-out" },
        { transform: `translate(${midX + dx}px, ${midY + dy}px) scale(.94) rotate(-1deg)`, opacity: 1, offset: 0.52, easing: "cubic-bezier(.45,0,.15,1)" },
        { transform: `translate(${endX}px, ${endY}px) scale(.2)`, opacity: 0.85, offset: 0.9, easing: "ease-out" },
        { transform: `translate(${endX}px, ${endY}px) scale(.12)`, opacity: 0, offset: 1 },
      ],
      { duration: FLY_MS, delay: i * STAGGER_MS, fill: "forwards" },
    );
    if (!anim) {
      // 引擎不接这组关键帧：这一片当场收掉（整批都收掉时层也别留着）。
      ghost.remove();
      if (!layerEl.childElementCount) layerEl.remove();
      return;
    }
    flights.push(
      new Promise<void>((resolve) => {
        // `finished` 在正常结束与**被取消**两种情况下都会落定（取消时 reject 一个 AbortError）。
        // 只接 `onfinish` 的话，动画一被取消（元素被摘掉、`#app` 重建、标签页被冻结后台清理）
        // 幽灵和这一层就永远留在 DOM 里，徽标也不弹，这个 Promise 也不 resolve。
        const settle = () => {
          ghost.remove();
          // 飞完一张就收一层：最后一张落地时整层拆掉，`#app` 里不留空浮层。
          if (!layerEl.childElementCount) layerEl.remove();
          resolve();
        };
        anim.finished.then(settle, settle);
      }),
    );
  });

  // 落地只弹一次 —— 等最后一张（含错开延迟）停下。这个 Promise 不 reject：调用方是 `void` 掉的。
  return Promise.all(flights).then(() => badgeLanded(opts.badge));
}
