/**
 * 桥的入口选择：有 `bridge/dist/host.js` 就走壳（壳持有端口和会话管道，热部署只换脑），
 * 否则退回 `bridge/dist/index.js`。`PI_HOST_DISABLE=1` 是留给排错的逃生口。
 *
 * 启动（scripts/start.mjs）与热部署换进程（scripts/hotdeploy.mjs）都从这里取，
 * 别再各写一份：改入口名或逃生口时只改一边，两条启动路径就会分叉。
 */
import fs from "node:fs";
import path from "node:path";

/** 返回入口的绝对路径（选谁只看 `repo` 里构建出了什么）。 */
export function bridgeEntry(repo) {
  const host = path.join(repo, "bridge", "dist", "host.js");
  return process.env.PI_HOST_DISABLE === "1" || !fs.existsSync(host)
    ? path.join(repo, "bridge", "dist", "index.js")
    : host;
}
