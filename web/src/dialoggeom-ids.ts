/**
 * 窗口几何的 id 表（#755）。
 *
 * 为什么单独一个文件、为什么一个字都不 import：`web/tests/dialog-geom-unit.mjs` 要拿它跟源码里真实
 * 调用 `attachWindowGeom("<id>")` 的地方对账（漏接一扇窗就红）。那个守卫跑在 node 里，不该为了读一张
 * 常量表被 `dialoggeom.ts` 的 DOM 依赖拖进来。
 *
 * **id 不从 CSS 类名推导**：`.rv-back` 被代码评审 / PR / 交接 / 仓库选择四扇共用，推导出来的 id 会
 * 让它们共一份尺寸；也不从窗口标题推导 —— 改一个字的文案就丢记忆。
 *
 * 加一扇新窗：往 `WINDOW_IDS` 补一个 id，再在创建它的地方调一次 `attachWindowGeom`。守卫会盯着。
 */

/** 要能拉大小的窗口（`data-mac-surface="window"`）。 */
export const WINDOW_IDS = [
  "display",
  "peer",
  "model",
  "skillstore",
  "insight",
  "context",
  "sub-policy",
  "sub-handoff",
  "new-session",
  "theme-intro",
  "ws-intro",
  "ws-delete",
  "ws-new",
  "artifacts",
  "diff",
  "manager",
  "settings",
  "share",
  "bug",
  "ext",
  "tree",
  "bg",
  "image",
  "keys",
  "args",
  "branch",
  "fileconsole",
  "filesearch",
  "handoff",
  "hotdeploy",
  "jira",
  "jira-ask",
  "jira-picker",
  "mail",
  "notes",
  "notes-pick",
  "notes-submit",
  "peer-pick",
  "pr",
  "repo-pick",
  "repos",
  "review",
  "auto-review",
  "auto-round",
  "scratch",
  "sysmanage",
  "whatsnew",
] as const;

/**
 * 早就能拉的浮窗（`dock` / `paper`）。它们自己管位置，所以几何里多两个字段 `l` / `t`；
 * 这次只把存储键统一到 `pi.dialogGeom`，手势一个字不改。
 */
export const DOCK_IDS = ["term", "preview", "sheet", "slides"] as const;

/**
 * 拉了也没意义的窗：内容撑不开、拉大只是多留白或者多黑边。它们**不装抓手、不写盘**。
 *
 * - `lightbox`：图片灯箱，图是等比缩放（`max-height: 86vh`），拉窗只是加黑边；
 * - `choose` / `translate-pick`：alert 形的「选一个」小框，几行字；
 * - `mail-confirm`：写信那一下的确认，几行字；
 * - `stepup` / `lan-install` / `pi-update`：`.modal` 那族的确认框，里面的表单写死 `min(360px, 100%)`。
 */
export const EXEMPT_IDS = [
  "lightbox",
  "choose",
  "translate-pick",
  "mail-confirm",
  "stepup",
  "lan-install",
  "pi-update",
] as const;

export type WindowId = (typeof WINDOW_IDS)[number];
export type DockId = (typeof DOCK_IDS)[number];
export type DialogId = WindowId | DockId | (typeof EXEMPT_IDS)[number];

export function isExempt(id: string): boolean {
  return (EXEMPT_IDS as readonly string[]).includes(id);
}
