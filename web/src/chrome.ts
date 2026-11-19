/**
 * 顶栏 / 输入框下沿那 14 颗按钮的可见性（#281 / #288）。
 *
 * **唯一一份定义**：桥存的是偏好（`chrome`），页面只问这里「这一颗该不该画」，不在各个渲染点
 * 各拼一遍条件。三态用「键在不在」表达 —— 键缺失 = 默认行为（`DEFAULT_HIDDEN` 里默认不画，
 * 其余默认画），`false` = 关掉，`true` = 显式打开（连 560px 以下那条 D138 规则一起顶开）。
 *
 * 纯函数，单测在 `web/tests/chrome-unit.mjs`。桥端的白名单在 `bridge/src/extmgr.ts`。
 */

/** 写进状态 / 协议里的稳定 id（不是文案）。顶栏 9 颗、下沿 5 颗。 */
export const CHROME_IDS = ["artifacts", "terminal", "files", "notes", "peer", "scratch", "jira", "mail", "filesearch", "skills", "context", "ext", "attach", "model"] as const;
export type ChromeId = (typeof CHROME_IDS)[number];

/** 只有三种状态：键缺失 / `false` / `true`。 */
export type ChromeState = Partial<Record<ChromeId, boolean>>;

/** 判断一颗按钮时真正影响结果的事实，调用方现算，函数本身不读 DOM。 */
export interface ChromeContext {
  /** 有当前会话。产物与文件管理器只在会话里才有内容。 */
  hasSession: boolean;
}

const SESSION_ONLY: readonly string[] = ["artifacts", "files"];

/**
 * 默认不占顶栏的 id。三态不变 —— 键缺失按这里的默认（不画），`true` 才画出来，
 * `false` 与缺失同效但会记住「关过」。
 *
 * 用户 2026-11-19 把两颗的默认对调：文件管理器默认不显示、Everything 默认显示（D331）。
 * 文件管理器的 560px 规则（D138）只在显式 `true` 时还要「顶开样式表」这件事上继续存在，
 * 不再从宽度推默认。
 */
const DEFAULT_HIDDEN: readonly ChromeId[] = ["files"];

/** 只在会话里才有内容的 id：没开会话时连显式打开也画不出来。列表只在这里写一次。 */
export function isSessionOnly(id: ChromeId | string): boolean {
  return SESSION_ONLY.includes(id);
}

/** D138 在 560px 以下用 CSS 藏掉的按钮（样式表里那条 `@media` 还在）：只有它们存在
 * 「显式打开要顶开样式表」的问题，与「默认画不画」是两件事。 */
const NARROW_CSS_HIDDEN: readonly ChromeId[] = ["files"];

/**
 * 这一颗画不画。`id` 收 `string` 是因为桥可能带来更新版本的 id：不认识的按默认画，旧页面不该
 * 因此把新按钮藏掉。
 */
export function isChromeVisible(id: ChromeId | string, chrome: ChromeState | null | undefined, ctx: ChromeContext): boolean {
  if (!(CHROME_IDS as readonly string[]).includes(id)) return true;
  if (isSessionOnly(id) && !ctx.hasSession) return false;
  const choice = chrome?.[id as ChromeId];
  if (choice === false) return false;
  if (choice === true) return true;
  if (DEFAULT_HIDDEN.includes(id as ChromeId)) return false;
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
