/**
 * 弹层共用的两件小事：捕获阶段的 Esc、以及「挂在哪儿」。
 *
 * 为什么单独一份：邮箱面板（`mail.ts`）和 AI 发信确认框（`mailconfirm.ts`）各自写了同一段
 * 「document.addEventListener("keydown", …, true)` + Esc 时 preventDefault/stopPropagation」，
 * 而这段必须用**捕获**阶段 —— 否则输入框、编辑器先把 Esc 吃掉，弹层关不掉。
 *
 * `mountOverlay` 认 `#app`：往 `document.body` 上挂就不吃 `#app` 的 `zoom`，外观「字号」调到
 * 125% 以上时同一个弹层会跟别的弹层两套尺寸（D123 / D263）。
 */

/** 捕获阶段拦 Esc；返回「卸掉」的函数（重复调用安全）。 */
export function trapEscape(onEscape: () => void): () => void {
  const handler = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    onEscape();
  };
  document.addEventListener("keydown", handler, true);
  return () => document.removeEventListener("keydown", handler, true);
}

/** 把浮层挂进 `#app`（拿不到才退回 body，比如单元测试里的假 DOM）。 */
export function mountOverlay(root: HTMLElement): void {
  (document.getElementById("app") ?? document.body).append(root);
}
