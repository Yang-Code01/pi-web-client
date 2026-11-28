/**
 * #742：分区字号滑杆「让开」—— 拖动时把设置控制台淡成一层薄影，让真页面自己演示。
 *
 * 只有改「面板背后那片页面」的五根分区轨道用它；「设置与控制台」不让开（D455）：
 * 那根的效果就在面板自己身上，再淡掉面板等于拖一下就关掉了设置。
 * 而「字号」照旧让开 —— 用户要的是拖动时能看见页面在变，面板挡不挡另说（m00922）。
 *
 * 这里只做两件事：宿主（`.st-back`）上挂 / 摘 `peeking` 类（视觉全在 CSS 里），以及维护那颗
 * 读数胶囊（文本 + 只读细轨道的填充）。阈值、「松手就回」「Esc 取消」这些时机由调用方
 * （`fontSliderRow`）决定 —— 它才知道拖动从哪一刻算开始。
 */
export const PEEK_MIN_PX = 6;
export const PEEK_KEY_MS = 400;

/** 读数：文本（`142%`）+ 细轨道的填充比（0–1）。范围换算在滑杆那边，这里只管抹。 */
export interface PeekReadout {
  text: string;
  fill: number;
}

export class ConsolePeek {
  private hud: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private valueEl: HTMLElement | null = null;
  private fillEl: HTMLElement | null = null;
  private readonly host: HTMLElement;
  /** 键盘那一下的自动收起（同一个宿主只有一颗，见 `keyPeek`）。 */
  private timer = 0;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** 现在是不是露着的。拖动中的 `pointermove` 每帧都会问一次。 */
  get active(): boolean {
    return this.host.classList.contains("peeking");
  }

  /** `read` 由调用方算好（读数文本 + 0–1 的填充比）：这里不认识滑杆的范围，也不猜。 */
  show(label: string, read: PeekReadout): void {
    // 任何一次「露」都先撤掉键盘那颗待收的计时器：否则 400ms 到点会把**正在拖**的那根收掉。
    this.clearTimer();
    this.ensureHud();
    this.host.classList.add("peeking");
    const name = `${label} · `;
    if (this.labelEl && this.labelEl.textContent !== name) this.labelEl.textContent = name;
    this.set(read);
  }

  /**
   * 键盘调值：露一下、`PEEK_KEY_MS` 没再动就自己收回去（连按合并计时）。
   *
   * 计时器**必须跟着宿主走**，不能一根滑杆一个：胶囊与 `peeking` 类是宿主共用的，六根滑杆都在
   * 同一个 `.st-back` 里 —— 每根各揣一个计时器的话，「按 A 的方向键，400ms 内去拖 B」会在 A 的
   * 计时器到点时把 B 的让开收掉，B 又重新挂着 `peeking` 不会补，面板就当场弹回去了。
   */
  keyPeek(label: string, read: PeekReadout): void {
    this.show(label, read);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.hide();
    }, PEEK_KEY_MS);
  }

  set(read: PeekReadout): void {
    if (!this.active) return;
    if (this.valueEl) this.valueEl.textContent = read.text;
    if (this.fillEl) this.fillEl.style.width = `${Math.max(0, Math.min(1, read.fill)) * 100}%`;
  }

  hide(): void {
    this.clearTimer();
    this.host.classList.remove("peeking");
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  /**
   * 胶囊挂在宿主里、不挂进 `.st-console`：那个壳 `overflow: hidden`，贴底的胶囊会被裁掉。
   * 第一次真正用到时才建（大多数人打开设置只是改主题）。
   */
  private ensureHud(): void {
    if (this.hud?.isConnected) return;
    const hud = document.createElement("div");
    hud.className = "console-peek";
    const label = document.createElement("span");
    label.className = "console-peek__label";
    const value = document.createElement("span");
    value.className = "console-peek__value";
    const rail = document.createElement("span");
    rail.className = "console-peek__rail";
    const fill = document.createElement("i");
    fill.className = "console-peek__fill";
    rail.append(fill);
    hud.append(label, value, rail);
    this.host.append(hud);
    this.hud = hud;
    this.labelEl = label;
    this.valueEl = value;
    this.fillEl = fill;
  }
}

/** 一个宿主一个胶囊：六根滑杆共用同一颗，不会叠出一排。 */
const cache = new WeakMap<HTMLElement, ConsolePeek>();

export function peekFor(host: HTMLElement): ConsolePeek {
  let pk = cache.get(host);
  if (!pk) {
    pk = new ConsolePeek(host);
    cache.set(host, pk);
  }
  return pk;
}
