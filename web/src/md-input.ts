/**
 * #511 Markdown 输入规则：打字时的块级 / 行内转换。
 *
 * 纯函数、不碰 DOM：编辑器（记录面板与内网通共用）只负责把命中的结果落到 contenteditable。
 * 规则集合是刻意收窄的——块级只认行首标记 + 空格，行内只认闭合符号，代码块里不判定。
 *
 * 撤销由调用方负责：行内转换用一次 `execCommand("insertHTML")`（原生一步撤销），
 * 块级替换用编辑器自己的一次性快照（`Ctrl+Z` 回到打标记前的段落）。
 */

export type BlockKind = "ul" | "ol" | "blockquote" | "h1" | "h2" | "h3";

export interface BlockHit {
  kind: BlockKind;
  /** 触发标记的长度（含末尾空格）：调用方要把它从段落开头删掉。 */
  marker: number;
  /** 标记之后剩下的文字（转换后留在新块里）。 */
  rest: string;
}

/**
 * 行首标记 + 空格。只在光标正好在标记末尾时命中：`- ` / `* ` / `1. ` / `# ` / `## ` / `### ` / `> `。
 * `#### ` 及以上不转（#511 的决定），`*` 与 `-` 都要跟一个空格。
 */
export function matchBlock(text: string, caret: number): BlockHit | null {
  if (caret <= 0 || caret !== text.length) return null;
  const head = text.slice(0, caret);
  // 标记必须就是整段（`- ` 后面又打了一个空格就不算）。
  const exact = (m: RegExpExecArray | null, kind: BlockKind): BlockHit | null =>
    m && m[0].length === head.length ? { kind, marker: m[0].length, rest: "" } : null;

  const ul = exact(/^(- |\* )/.exec(head), "ul");
  if (ul) return ul;

  const ol = exact(/^(\d+\. )/.exec(head), "ol");
  if (ol) return ol;

  const hash = /^(#{1,3}) /.exec(head);
  if (hash) return exact(hash, `h${hash[1].length}` as BlockKind);

  return exact(/^(> )/.exec(head), "blockquote");
}

export interface InlineHit {
  /** 要替换的区间（相对段落文本）。 */
  from: number;
  to: number;
  /** 替换成的 HTML（内容已转义）。 */
  html: string;
}

/**
 * 闭符号一敲完就转。从最长/最容易误判的开始试：`**` 先于 `*`，`~~` 先于 `*`。
 * 链接只认 `http(s)://` 与站内 `/` 开头；内容为空不转。
 */
export function matchInline(text: string, caret: number): InlineHit | null {
  if (caret <= 0 || caret > text.length) return null;
  const head = text.slice(0, caret);

  let m = /(\*\*)([^*\s](?:[^*\n]*[^*\s])?)\*\*$/.exec(head);
  if (m) return hit(head, m, `<strong>${esc(m[2])}</strong>`);

  m = /~~([^~\n]+)~~$/.exec(head);
  if (m) return hit(head, m, `<s>${esc(m[1])}</s>`);

  m = /`([^`\n]+)`$/.exec(head);
  if (m) return hit(head, m, `<code>${esc(m[1])}</code>`);

  m = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)$/.exec(head);
  if (m) return hit(head, m, `<a href="${esc(m[2])}">${esc(m[1])}</a>`);

  // 单个 `*`：前面不能紧挨 `*`（那是上面那条规则的地盘），内容首尾不能是空白。
  m = /(^|[^*])\*([^*\s](?:[^*\n]*[^*\s])?)\*$/.exec(head);
  if (m) {
    const start = head.length - m[0].length + m[1].length;
    return { from: start, to: caret, html: `<em>${esc(m[2])}</em>` };
  }

  return null;
}

/** 命中时把首尾符号一起换掉；`m[0]` 一定在 `head` 末尾。 */
function hit(head: string, m: RegExpExecArray, html: string): InlineHit {
  const from = head.length - m[0].length;
  return { from, to: head.length, html };
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
