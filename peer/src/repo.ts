/**
 * 仓库标识的形状：`<host>/<owner>/<name>`（主机小写，D441 只读更新组拿它认「同一份仓库」），
 * 也接受 GitLab 的 `host/group/subgroup/name`。旧的 2 段写法（`owner/name`）照样收 ——
 * 手工改 config 或更早的构建写过这种值，拒掉它只会让那台机器永远进不了组。
 *
 * 单独一个模块，给 config / http / announce 共用 —— 别让基础配置模块反向依赖协议载荷模块（评审 #25）。
 */
export const REPO_RE = /^[\w.-]+(?:\/[\w.-]+)+$/;
/** peer config 的字段上限就是 120：比这更长的标识存不进 config，也没法稳定进组。 */
export const MAX_REPO_LEN = 120;

export function isRepo(raw: unknown): boolean {
  return typeof raw === "string" && raw.length <= MAX_REPO_LEN && REPO_RE.test(raw);
}
