/**
 * 仓库标识的形状：`owner/name`，也接受 GitLab 的 `group/subgroup/name`。
 *
 * 单独一个模块，给 config / http / announce 共用 —— 别让基础配置模块反向依赖协议载荷模块（评审 #25）。
 */
export const REPO_RE = /^[\w.-]+(?:\/[\w.-]+)+$/;
/** peer config 的字段上限就是 120：比这更长的标识存不进 config，也没法稳定进组。 */
export const MAX_REPO_LEN = 120;

export function isRepo(raw: unknown): boolean {
  return typeof raw === "string" && raw.length <= MAX_REPO_LEN && REPO_RE.test(raw);
}
