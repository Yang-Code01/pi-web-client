/**
 * #487：交接时预填的会话名。
 *
 * 「交给 agent ▾ → 新开一个会话」建会话之前，面板里的名字框先填上这件事叫什么：
 * - Jira 面板：票号去前缀，只留最后一个连字符之后那一段（`CASPH30INC-17967` → `17967`）。
 * - 分支操作工作台：整条分支 ref 原样（`feat/skill-inject-viz`、`origin/main`、`HEAD~2`）。
 *
 * 规则写在这一处，两个面板共用；返回值是「要不要填」的唯一依据 —— 空串表示不填，
 * 面板那边据此留空，别在界面上出现一个看不见的空名字（`PROJ-` 这种）。
 * 纯函数，不碰 DOM：`web/tests/session-name-unit.mjs` 直接跑它。
 */

/** 票号 → 会话名。`PROJ-1234` → `1234`；没有连字符就整条；取完是空的就返回空串。 */
export function sessionNameFromIssueKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  const cut = trimmed.lastIndexOf("-");
  return (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).trim();
}

/** 分支 ref → 会话名。整条原样，只去前后空白（斜杠是 ref 的一部分，不拆）。 */
export function sessionNameFromBranchRef(ref: string): string {
  return ref.trim();
}
