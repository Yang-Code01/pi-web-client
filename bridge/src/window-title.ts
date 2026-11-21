/**
 * D358：把实例名写进页面标题。
 *
 * 测试环境（`.pi/skills/pi-web-client-test-dev/bin/env.mjs`）和正式的 7864 常同时开着，浏览器 tab 上
 * 一排都是「pi」，认不出哪个是刚起来的那份。桥启动时读 `PI_WEB_WINDOW_TITLE`，把这段文字塞进它送出的
 * index.html：`<title>` 直接换成它（首帧就对），再挂一个 `window.__piWindowTitle` 给前端（前端每次重画
 * 标题时会把会话标题接在后面，见 `web/src/window-title.ts`）。
 *
 * 只在环境变量非空时动手；正式实例没设它，页面一个字节都不变。
 */
export function windowTitleFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.PI_WEB_WINDOW_TITLE ?? "").trim();
}

/** 给 index.html 换上标题并注入前端要读的那个全局。 */
export function injectWindowTitle(html: string, title: string): string {
  const text = title.trim();
  if (!text) return html;
  const forTag = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 进了 <script> 就得防 `</script>` 提前闭合；JSON.stringify 不处理 `<`，自己转。
  const forJs = JSON.stringify(text).replace(/</g, "\\u003c");
  const script = `<script>window.__piWindowTitle=${forJs}</script>`;
  const titled = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${forTag}</title>`);
  if (/<\/head>/i.test(titled)) return titled.replace(/<\/head>/i, `${script}</head>`);
  return `${script}${titled}`;
}
