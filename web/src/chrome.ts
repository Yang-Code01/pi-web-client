/**
 * 顶栏 / 输入框下沿那 11 颗按钮的可见性（#281 / #288）。
 *
 * **唯一一份定义**：桥存的是偏好（`chrome`），页面只问这里「这一颗该不该画」，不在各个渲染点
 * 各拼一遍条件。三态用「键在不在」表达 —— 键缺失 = 默认行为，`false` = 关掉，`true` = 显式打开
 * （`true` 连 560px 以下那条 D138 规则一起顶开；没碰过的仍按 CSS 默认收起来）。
 *
 * 纯函数，单测在 `web/tests/chrome-unit.mjs`。桥端的白名单在 `bridge/src/extmgr.ts`。
 */

/** 写进状态 / 协议里的稳定 id（不是文案）。顶栏 7 颗、下沿 4 颗。 */
export const CHROME_IDS = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira", "skills", "ext", "attach", "model"] as const;
export type ChromeId = (typeof CHROME_IDS)[number];

/** 只有三种状态：键缺失 / `false` / `true`。 */
export type ChromeState = Partial<Record<ChromeId, boolean>>;

/** 判断一颗按钮时真正影响结果的两种事实，调用方现算，函数本身不读 DOM。 */
export interface ChromeContext {
  /** 有当前会话。产物与文件管理器只在会话里才有内容。 */
  hasSession: boolean;
  /** D138 的窄屏（560px 以下）。只影响文件管理器的**默认**。 */
  narrow: boolean;
}

const SESSION_ONLY: readonly string[] = ["artifacts", "files"];

/** D138 在 560px 以下用 CSS 藏掉的按钮：只有它们存在「显式打开要顶开样式表」的问题。 */
const NARROW_CSS_HIDDEN: readonly ChromeId[] = ["files"];

/**
 * 这一颗画不画。`id` 收 `string` 是因为桥可能带来更新版本的 id：不认识的按默认画，旧页面不该
 * 因此把新按钮藏掉。
 */
export function isChromeVisible(id: ChromeId | string, chrome: ChromeState | null | undefined, ctx: ChromeContext): boolean {
  if (!(CHROME_IDS as readonly string[]).includes(id)) return true;
  if (SESSION_ONLY.includes(id) && !ctx.hasSession) return false;
  const choice = chrome?.[id as ChromeId];
  if (choice === false) return false;
  if (choice === true) return true;
  if (id === "files" && ctx.narrow) return false;
  return true;
}

/**
 * #292「开关优先」：窄屏要顶开 D138 的那些 id —— 空数组表示没人显式打开，样式表原样生效。
 * 只表达「显式 true」这一件事，不含会话事实；没开会话时按钮仍带 `hidden`，页面靠覆盖规则里的
 * `:not([hidden])` 不让它复活。页面把它写成根元素的 `data-chrome-narrow`。
 */
export function narrowForcedVisible(chrome: ChromeState | null | undefined): ChromeId[] {
  return NARROW_CSS_HIDDEN.filter((id) => chrome?.[id] === true);
}

/** 页面收到 `hello.ui.chrome` / `ui.ui.chrome` 时归一：未知 id 与非布尔值都不进页面状态。 */
export function chromeFrom(value: unknown): ChromeState {
  const out: ChromeState = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const id of CHROME_IDS) {
    const choice = (value as Record<string, unknown>)[id];
    if (typeof choice === "boolean") out[id] = choice;
  }
  return out;
}
