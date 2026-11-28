/**
 * #742：字号滑杆「让开」—— 拖动时把设置控制台淡成一层薄影，让真页面自己演示。
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

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** 现在是不是露着的。拖动中的 `pointermove` 每帧都会问一次。 */
  get active(): boolean {
    return this.host.classList.contains("peeking");
  }

  /** `read` 由调用方算好（读数文本 + 0–1 的填充比）：这里不认识滑杆的范围，也不猜。 */
  show(label: string, read: PeekReadout): void {
    this.ensureHud();
    this.host.classList.add("peeking");
    if (this.labelEl) this.labelEl.textContent = `${label} · `;
    this.set(read);
  }

  set(read: PeekReadout): void {
    if (!this.active) return;
    if (this.valueEl) this.valueEl.textContent = read.text;
    if (this.fillEl) this.fillEl.style.width = `${Math.max(0, Math.min(1, read.fill)) * 100}%`;
  }

  hide(): void {
    this.host.classList.remove("peeking");
  }

  /**
   * 胶囊挂在宿主里、不挂进 `.st-console`：那个壳 `overflow: hidden`，贴底的胶囊会被裁掉。
   * 第一次真正用到时才建（大多数人打开设置只是改主题）。
   */
  private ensureHud(): void {
    if (this.hud?.isConnected) return;
    const hud = document.createElement("div");
    hud.className = "peek-hud";
    const label = document.createElement("span");
    label.className = "peek-hud__label";
    const value = document.createElement("span");
    value.className = "peek-hud__value";
    const rail = document.createElement("span");
    rail.className = "peek-hud__rail";
    const fill = document.createElement("i");
    fill.className = "peek-hud__fill";
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
