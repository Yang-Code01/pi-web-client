/**
 * 超长条目收成摘要卡（D421）：卡片标题行右边那句「27 行 · 931 字」就是这两个数。
 *
 * 行数照字面数换行（`\n`），字数去掉所有空白 —— 中文里「931 字」比「412 个单词」更接近直觉，
 * 中英混排的消息照同一把尺子量，两个人都不会被那个数字骗。
 */
export function longCardCounts(text: string): { lines: number; chars: number } {
  // 老桥、Windows 剪贴板都可能塞进 `\r\n`：先统一，否则行数会多算一倍。
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) return { lines: 0, chars: 0 };
  return { lines: body.split("\n").length, chars: body.replace(/\s/g, "").length };
}
