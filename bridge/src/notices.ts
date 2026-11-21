import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 仓库根的 `THIRD-PARTY-NOTICES.md`：设置 → 关于里那张「开源许可」清单的来源。
 *
 * 它由 `tools/notices.mjs` 按依赖锁文件生成（`npm run typecheck` 校验是否同步），
 * 不打包进 `web/dist`：桥换一份依赖，产物里的清单就会过期，而这份永远跟当前安装对得上。
 *
 * 找路径的顺序：模块自己的上两级（dist/index.js 与 src/index.ts 都是 `../../` 到仓库根）→
 * 进程 cwd。发行包里少了这份文件时**如实 404**，不要拿别的文本糊弄过去。
 */
let cached: string | null | undefined;

export function noticesPath(): string[] {
  const out: string[] = [];
  try {
    out.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "THIRD-PARTY-NOTICES.md"));
  } catch {
    /* import.meta.url 不可用（少见 loader）就只看 cwd */
  }
  out.push(path.resolve(process.cwd(), "THIRD-PARTY-NOTICES.md"));
  return out;
}

/** 读一次就缓存：这份文件只在依赖变动时改，运行时改它没有意义。 */
export function noticesText(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const p of noticesPath()) {
    try {
      const text = fs.readFileSync(p, "utf8");
      if (text.trim()) cached = text;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  return cached;
}
