/**
 * 大段粘贴的折块阈值。聊天区与随手问共用一份：两边都是同一个输入框，凭什么同一段文字在
 * 一个框里折起来、在另一个框里糊一整屏。
 *
 * 依赖故意为零（不 import 任何东西）：`web/i18n-check.mjs` 之外还有几个直接 `import` 源码的
 * 单测（见 `web/tests/`），它们跑在 node 里，模块一挂上 DOM 就崩。
 */
export const PASTE_LINES = 6;
export const PASTE_CHARS = 400;

/** A paste this long (lines or characters) becomes its own foldable block. */
export function shouldFoldPaste(text: string): boolean {
  return text.split("\n").length >= PASTE_LINES || text.length >= PASTE_CHARS;
}
