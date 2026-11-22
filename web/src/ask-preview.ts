/**
 * 问卷里的「在预览里打开」点下去就打开，不等整份问卷提交（D226 当时留下的 Out of Scope）。
 *
 * 为什么要前端自己开：多题问卷要全部答完才回给模型，模型没拿到答案就调不了 `open_preview`。
 * 模型一旦把「要在预览里打开吗？」和「选哪个样张」塞进同一份问卷，用户点了打开却什么都没出来，
 * 下一题已经在逼他选 —— 还没看就要选。单题问卷也省一次模型往返（1–3 秒的空白）。
 *
 * 只认**绝对路径**：相对路径在桥那边按会话 cwd 解析，而产物常写在别的 worktree 里，猜错就打开
 * 另一份同名文件或一张报错页。认不出路径时什么都不做，交给模型拿到答案后照旧调 `open_preview`
 * （同路径再开一次是幂等的：只抬面板，不重建 iframe —— D388；`pushStep` 仍会记一步）。
 */

export interface PreviewOption {
  label: string;
  description?: string;
}

/** 交付提示词（bridge/src/delivery.ts）规定的选项文字，外加英文 / 日文界面下模型可能写的说法。 */
const OPEN_LABEL = /^\s*(在预览里打开|在预览中打开|Open in preview|プレビューで開く)/i;

/** 文件名要有扩展名：题干里另一处常写着 worktree 目录（不能拿来开）。 */
const EXT = /\.[A-Za-z0-9]{1,8}$/;

/** 包在 `…` / "…" / 「…」 里的路径可以带空格，先认这些。 */
const QUOTED = /`([^`\n]+)`|"([^"\n]+)"|「([^」\n]+)」|“([^”\n]+)”/g;

/** 没包起来的绝对路径：遇到空白、中文标点、引号就断。前面紧挨着字母 / 斜杠的 `/` 是相对路径的中间段（`web/x.html`），不算。 */
const BARE = /(?<![\w.~\-/\\:])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?，。、；：（）「」“”]+/g;

const isAbsolute = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || /^\/[^/]/.test(p);

/** 末尾粘着的英文标点（句号、逗号、右括号没配对）去掉。 */
function trimTail(p: string): string {
  let s = p.trim().replace(/[.,;:!]+$/, "");
  while (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1);
  return s;
}

/** 一段文字里第一个像文件的绝对路径；没有返回 null。 */
export function absoluteFileIn(text: string): string | null {
  if (!text) return null;
  for (const m of text.matchAll(QUOTED)) {
    const p = trimTail(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
    if (isAbsolute(p) && EXT.test(p)) return p;
  }
  for (const m of text.matchAll(BARE)) {
    const p = trimTail(m[0]);
    if (isAbsolute(p) && EXT.test(p)) return p;
  }
  return null;
}

/**
 * 用户点的这个选项是不是「在预览里打开」；是就返回要开的绝对路径（先看选项说明，再看题干），
 * 否则 null。
 */
export function previewTargetOf(prompt: string, option: PreviewOption): string | null {
  if (!OPEN_LABEL.test(option.label)) return null;
  return absoluteFileIn(option.description ?? "") ?? absoluteFileIn(prompt);
}
