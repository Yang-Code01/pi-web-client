/**
 * 自动评审的限时授权 —— 脑侧只负责**写盘与收回**。判定在 `bridge/ext/grant-match.ts`：
 * 那份会被 pi 子进程以 `.ts` 直接加载，闸门每次工具调用都重读会话的 allow 文件。
 *
 * 这里刻意不 import ext（桥的 tsconfig `rootDir` 是 `src`，跨出去会把构建带坏），
 * 所以下面这个形状与那边逐字段一致，改一处就得改两处 —— 单测会同时钉住两边。
 */
import fs from "node:fs";
import path from "node:path";
import { readJson, statePath, writeJson } from "./paths.ts";

/** 与 `bridge/ext/grant-match.ts` 的 `AutoGrant` 同一份形状。 */
export interface AutoGrant {
  branch: string;
  pr: number;
  repo: string;
  /** `owner/name`（从 origin 认出来的；认不出是空串 —— 闸门那边对显式点名的仓库会一律拒）。 */
  slug: string;
  expiresAt: number;
}

/** 一次运行最长授权多久：轮数上限 10 轮，每轮最坏几分钟，6 小时上限够宽。 */
export const GRANT_TTL_MS = 6 * 60 * 60 * 1000;

function allowFile(session: string): string {
  return statePath("allow", `${session}.json`);
}

/** 读会话 allow 文件里的那份授权（读不出来 / 过期都当没有）。 */
export function readGrant(session: string, now = Date.now()): AutoGrant | null {
  try {
    const data = readJson<Record<string, unknown>>(allowFile(session), {});
    const auto = data?.auto as any;
    if (!auto || typeof auto !== "object") return null;
    const grant: AutoGrant = {
      branch: String(auto.branch ?? ""),
      pr: Number(auto.pr) || 0,
      repo: String(auto.repo ?? ""),
      slug: String(auto.slug ?? ""),
      expiresAt: Number(auto.expiresAt) || 0,
    };
    if (!grant.expiresAt || grant.expiresAt <= now) return null;
    return grant;
  } catch {
    return null;
  }
}

/** 写 / 收授权。`null` 就是收回（运行结束、按停、失败都要走到这里）。 */
export function writeGrant(session: string, grant: Omit<AutoGrant, "expiresAt"> | null, now = Date.now()): void {
  const file = allowFile(session);
  let data: Record<string, unknown> = {};
  try {
    data = readJson<Record<string, unknown>>(file, {}) ?? {};
  } catch {
    data = {};
  }
  if (!grant || (!grant.branch && !grant.pr)) delete data.auto;
  else data.auto = { ...grant, expiresAt: now + GRANT_TTL_MS };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, data);
}
