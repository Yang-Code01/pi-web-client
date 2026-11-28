/**
 * 仓库标识的形状：`owner/name`，也接受 GitLab 的 `group/subgroup/name`。
 *
 * 单独一个模块，给 config / http / announce 共用 —— 别让基础配置模块反向依赖协议载荷模块（评审 #25）。
 */
export const REPO_RE = /^[\w.-]+(?:\/[\w.-]+)+$/;

export function isRepo(raw: unknown): boolean {
  return typeof raw === "string" && raw.length <= 160 && REPO_RE.test(raw);
}
