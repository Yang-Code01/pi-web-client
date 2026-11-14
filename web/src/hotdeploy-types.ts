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
  log: string;
  branches: HotdeployBranch[];
}

export interface HotdeployRemoveResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}
