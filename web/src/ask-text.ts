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
 * 按反引号切段：成对的算 code，反引号本身不留在文字里。
 *
 * 配对按**等长串**认（CommonMark 的规矩）：`x` 用一枚，`` `x` `` 这类要用两枚包围，
 * 里面的单枚就是内容。找不到另一半的头/尾串（落单的一枚、三个连续的代码栅栏、没闭合的两枚）
 * 全部原样当普通字符 —— 卡片显示的文字永远比原文只多不少。
 */
export function splitInlineCode(s: string): InlinePiece[] {
  if (!s) return [];
  const runs: { start: number; len: number }[] = [];
  const re = /`+/g;
  for (let m = re.exec(s); m; m = re.exec(s)) runs.push({ start: m.index, len: m[0].length });
  const pieces: InlinePiece[] = [];
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    let j = i + 1;
    while (j < runs.length && runs[j].len !== open.len) j++;
    if (j === runs.length) continue; // 找不到等长的收尾：这串反引号按普通字符留着
    const close = runs[j];
    if (open.start > at) pieces.push({ kind: "text", text: s.slice(at, open.start) });
    pieces.push({ kind: "code", text: codeBody(s.slice(open.start + open.len, close.start)) });
    at = close.start + close.len;
    i = j;
  }
  if (at < s.length) pieces.push({ kind: "text", text: s.slice(at) });
  return pieces;
}

/** CommonMark 的孤儿空格：两端都是空格（且不全是空格）时各去一个，`` ` `` 才能显示成一枚反引号。 */
function codeBody(body: string): string {
  if (body.trim() && body.startsWith(" ") && body.endsWith(" ")) return body.slice(1, -1);
  return body;
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
