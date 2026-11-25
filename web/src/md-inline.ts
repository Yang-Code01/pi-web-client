/**
 * 行内 markdown：反引号、`**粗**`、`[文字](地址)`。
 *
 * 条目正文是**一行一句话**，整段丢给 `renderMarkdown` 会包成块级 `<p>`（间距、行高都不是这套
 * 版面的），所以单独一小套。单独一个文件是因为它不碰 DOM —— `web/tests/changelog-inline-unit.mjs`
 * 能直接跑 `node --experimental-strip-types`。
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * 链接地址只放行 `http(s):` / `mailto:` 与相对写法（`docs/x.md`、`#anchor`）。
 *
 * CHANGELOG 是仓库内容，但仓库内容会被抄进别人的 fork、也会被手工改；`[点我](javascript:…)`
 * 一旦被写进 `href`，点一下就是在这页的源上执行脚本（页面里带着桥的会话与预览通道）。
 * 放不过去的地址**只留文字**，不造 `<a>`。
 */
export function safeHref(href: string): boolean {
  // 先按浏览器的脾气归一：前导/中间的空白与控制字符在解析 scheme 时会被吃掉，
  // ` java\tscript:` 这种写法照样能跑，只看原始字符串会被绕过。
  const cleaned = href.replace(/[\u0000-\u0020\u007f]/g, "");
  // 带 scheme 的（`javascript:`、`data:`、`vbscript:`、`file:`…）只认 http / https / mailto；
  // 不带 scheme 的相对地址交回浏览器，和 `<a href="docs/x.md">` 一样只做同源导航。
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!m) return true;
  return /^(?:https?|mailto)$/i.test(m[1]);
}

/** 行内 markdown → HTML 片段（已转义，可直接进 `innerHTML`）。 */
export function inlineHtml(md: string): string {
  const esc = md.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
  return esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, href: string) =>
      safeHref(href) ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : label,
    );
}
