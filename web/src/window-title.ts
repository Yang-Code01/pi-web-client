/**
 * D358：浏览器 tab 上的标题。
 *
 * 正式实例照旧是「会话标题 · pi」/「pi」。测试实例由桥在 index.html 里注入 `window.__piWindowTitle`
 * （`PI_WEB_WINDOW_TITLE` = 「测试 <实例名>」），它顶在最前面 —— 一排 pi 窗口里一眼认出是哪一份，
 * 会话标题跟在后面仍然告诉你在哪个会话里。
 */
type WindowWithTitle = { __piWindowTitle?: unknown };

/** 桥注入的窗口标题前缀；正式实例没有，返回空串。 */
export function windowTitlePrefix(scope: WindowWithTitle & typeof globalThis = globalThis as WindowWithTitle & typeof globalThis): string {
  const raw = scope.__piWindowTitle;
  return typeof raw === "string" ? raw.trim() : "";
}

/** `document.title` 的唯一算法：前缀（测试实例）→ 会话标题 → `pi`。 */
export function documentTitle(sessionTitle: string | null | undefined, prefix: string = windowTitlePrefix()): string {
  const title = String(sessionTitle ?? "").trim();
  if (!prefix) return title ? `${title} · pi` : "pi";
  return title ? `${prefix} · ${title}` : prefix;
}
