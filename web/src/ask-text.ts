/**
 * 提问卡片里的文字怎么显示。
 *
 * 模型给的题干和选项说明是自由文本，两种难看形态都真实出现过：
 * - 把换行二次转义成字面的 `\n`（JSON 里写成了 `\\n`），卡片上就一行里横着两个反斜杠；
 * - 反引号包着的标识符、Windows 路径、`bridge/src/rpc.ts` 这种，纯文本渲染会连反引号一起露出来。
 *
 * 这里只做两件与渲染框架无关的事，方便单测：折换行、把反引号片段切出来。
 */

export interface InlinePiece {
  kind: "text" | "code";
  text: string;
}

/**
 * 字面的 `\n` / `\r\n` 折成真换行。
 *
 * 只在整段里**没有**真换行时才折：已经有真换行的文本里出现 `\n`，多半是代码或正则本身，
 * 折了才是错。宁可放过一段，也不要把人写的 `"a\nb"` 改成断行。
 */
export function unfoldNewlines(s: string): string {
  if (!s || s.includes("\n")) return s;
  return s.replace(/\\r\\n|\\n/g, "\n");
}

/**
 * 按反引号切段：反引号内的算 code，反引号本身不留在文字里。
 *
 * 不配对的反引号（奇数个）按普通字符处理，不吞掉后半段 —— 卡片显示的内容永远比原文只多不少。
 */
export function splitInlineCode(s: string): InlinePiece[] {
  if (!s) return [];
  const pieces: InlinePiece[] = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) pieces.push({ kind: "text", text: s.slice(at, m.index) });
    pieces.push({ kind: "code", text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < s.length) pieces.push({ kind: "text", text: s.slice(at) });
  return pieces;
}

/**
 * 卡片上最终要显示的文字：先切反引号，再只对普通文字折换行。
 *
 * 顺序反过来就会误伤：文本在**谈论** `\n` 本身（比如「把字面的 `\n` 折成换行」这种题干）时，
 * 反引号还没切出来，整段被当自由文本折掉，引用就变形了。代码片段里的是内容，一个字都不动。
 */
export function cardPieces(s: string): InlinePiece[] {
  return splitInlineCode(s).map((p) => (p.kind === "text" ? { kind: "text" as const, text: unfoldNewlines(p.text) } : p));
}
