/**
 * 把选中的文字折成一段 Markdown 引用（D416）：聊天区拖选后那颗「问一下」把它塞进随手问的输入框，
 * pi 那边读到的就是一段 `>` 引用，用户也能在 textarea 里直接改。
 *
 * 纯函数、不带任何 DOM 依赖 —— `web/tests/quoteblock-unit.mjs` 直接盯边角（空行、缩进、超长）。
 */

/** 引用块最多带多少字。再长的选区只留开头这一截，末尾加「…」，别让一次拖选把输入框塞满。 */
export const QUOTE_MAX = 4000;

/** 太长就截断，`max` 为 0 或负数表示不截。按码点切 —— 别把 emoji / 代理对切成半个。 */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (max <= 0 || chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

/**
 * 选中文字 → 引用块：按行加 `> `，空行写成光秃秃的 `>`（Markdown 的续行写法），
 * 首尾的空行去掉（拖选经常把段落之间的空行一起带上），块尾**不带**换行 —— 换几行由调用处决定。
 *
 * 传进来的文字已经是 `selection.toString()`，浏览器给的换行是 `\n`；仍然按 `\r\n?` 归一化，
 * 免得从别的来源（探针、粘贴）进来时行首多出半个 `\r`。
 */
export function quoteBlock(text: string, max = QUOTE_MAX): string {
  const lines = cut(text.replace(/\r\n?/g, "\n"), max)
    .split("\n")
    // 行尾空白留着没意义，还会在引用里多出一截空白；缩进**不能**动（代码块靠它）。
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return "";
  return lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}
