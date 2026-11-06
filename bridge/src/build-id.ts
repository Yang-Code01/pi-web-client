import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./paths.ts";

/**
 * D154：这次构建的标识（`<短提交>-<时间戳>`），由 `scripts/build.mjs` 写进 `dist/build-id.json`。
 *
 * 版号（VERSION）是手写的，两次 build 之间不会变，前端没法靠它判断「页面里的 JS 是不是上一版」。
 * 直接跑源码（`node --experimental-strip-types src/index.ts`）时没有 dist，退回版号即可。
 */
export const BUILD_ID: string = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "build-id.json"), "utf8"));
    return typeof raw.id === "string" && raw.id ? raw.id : VERSION;
  } catch {
    return VERSION;
  }
})();
