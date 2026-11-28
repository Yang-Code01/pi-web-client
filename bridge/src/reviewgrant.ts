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

/**
 * 读会话 allow 文件里的那份授权（读不出来 / 过期都当没有）。
 *
 * 桥内**没有**生产调用方：闸门在 pi 子进程里读（`ext/grant-match.ts` 自己解析），这里只是写盘
 * 那一半的对照读法，给单测与排错用。保留导出是为了 `reviewgrant-unit.mjs` 能钉住写进去的形状。
 */
export function readGrant(session: string, now = Date.now()): AutoGrant | null {
  try {
    const data = readJson<Record<string, unknown>>(allowFile(session), {});
    const auto: unknown = data?.auto;
    // 盘上的形状不可信：逐格 `typeof` 守卫，不用 `as any` 一把放过。
    if (!auto || typeof auto !== "object" || Array.isArray(auto)) return null;
    const o = auto as Record<string, unknown>;
    const grant: AutoGrant = {
      branch: typeof o.branch === "string" ? o.branch : "",
      pr: Number(o.pr) || 0,
      repo: typeof o.repo === "string" ? o.repo : "",
      slug: typeof o.slug === "string" ? o.slug : "",
      expiresAt: Number(o.expiresAt) || 0,
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
