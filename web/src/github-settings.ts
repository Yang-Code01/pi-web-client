/**
 * GitHub 通道的两个开关（#661）：设置 →「外观」→「对话」里能开能关。
 *
 * 为什么是纯函数：连坐规则（主开关关掉时「自动弹面板」跟着失效）是一条**行为**，不是一段画界面的
 * 代码 —— 放这里 `web/tests/github-unit.mjs` 能直接盯着它，界面那边只负责问一句。
 *
 * 存在 `pi.prefs`（跟着这台设备走），不进桥端 settings.json：关掉的是界面动作，不是服务。
 */

export interface GithubPrefs {
  /** 聊天里的 PR / issue / commit 链接变卡片。主开关。 */
  githubCards?: boolean;
  /** AI 建完 PR 自动把右栏面板推开。 */
  githubAutoPanel?: boolean;
}

export interface GithubFeature {
  cards: boolean;
  autoPanel: boolean;
}

/**
 * 两个开关的**生效值**。默认都开；主开关关掉时 `autoPanel` 一定是 false —— 否则会出现
 * 「面板自己弹出来了、但聊天里一张卡都没有」这种用户没法理解的状态。
 */
export function githubFeature(prefs: GithubPrefs | null | undefined): GithubFeature {
  const cards = prefs?.githubCards !== false;
  if (!cards) return { cards: false, autoPanel: false };
  return { cards: true, autoPanel: prefs?.githubAutoPanel !== false };
}
