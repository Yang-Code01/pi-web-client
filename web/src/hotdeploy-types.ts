/** 热部署：`bridge/src/hotdeploy.ts` 的返回形状（前端不 import 桥源码，抄一份）。 */

export interface HotdeployBranch {
  name: string;
  sha: string;
  ahead: number;
  behind: number;
  current: boolean;
  /** 被另一个 worktree 检出时的目录；主检出自己不算。 */
  occupiedBy: string | null;
  remoteOnly: boolean;
  lastCommitAt: string | null;
}

export type HotdeployPhase = "running" | "ok" | "fail";

export interface HotdeployRun {
  pid?: number;
  branch?: string;
  step?: number;
  phase?: HotdeployPhase;
  /** 有壳时壳走到哪一步：`running|observing|switched|failed|needs-group-restart`（面板据此说人话）。 */
  stage?: string;
  startedAt?: string;
  finishedAt?: string | null;
  updatedAt?: string;
  fromBranch?: string;
  fromSha?: string;
  toSha?: string;
  buildId?: string;
  exitCode?: number | null;
  error?: string | null;
  port?: number;
  /** 本轮 worker 实际创建的 stash message；没有暂存时为空。 */
  stash?: string;
  /** 本地改动是否已经在换进程前恢复。 */
  stashRestored?: boolean;
  /** worker 每进一个步骤记一次：`{ step, at }`（ms）。 */
  stamps?: { step: number; at: number }[];
}

export interface HotdeploySnapshot {
  repo: string;
  branch: string;
  detached: boolean;
  head: string;
  buildId: string;
  port: number;
  sessions: number;
  dirty: boolean;
  dirtyFiles: string[];
  busy: boolean;
  run: HotdeployRun | null;
  linkedWorktree: boolean;
  /** 壳在前面挡着（#634）：换代只换脑，页面重连后接着看，会话不被切断。旧桥没有这个字段。 */
  hosted?: boolean;
  /** 磁盘上的壳代码已经变了：这次部署会连会话一起重启（面板在点击前就该红字预告）。 */
  hostStale?: boolean;
  log: string;
  branches: HotdeployBranch[];
}

export interface HotdeployRemoveResult {
  ok: boolean;
  code: number;
  /** worktree 目录还在不在：code=2（外链目标丢了）时仍然算删掉了。 */
  removed?: boolean;
  /** 失败是因为里面有未提交的改动 —— 只有这种才值得再点一次强删。 */
  dirty?: boolean;
  stdout: string;
  stderr: string;
}
