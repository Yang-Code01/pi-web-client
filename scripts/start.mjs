#!/usr/bin/env node
/**
 * `npm start` / `npm run start:nobuild` 真正起的那个文件。
 *
 * 有 `bridge/dist/host.js` 就走壳（#634：壳持有端口和会话管道，热部署只换脑），
 * 否则退回 `bridge/dist/index.js`。`PI_HOST_DISABLE=1` 是留给排错的逃生口。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bridgeEntry } from "./bridge-entry.mjs";
import { EXIT_OK, forceRequested, preflight } from "./preflight.mjs";

const root = path.resolve(import.meta.dirname, "..");
const entry = bridgeEntry(root);

if (!fs.existsSync(entry)) {
  console.error(`找不到 ${entry} —— 先在仓库根目录跑一次 npm run build`);
  process.exit(1);
}

/**
 * `--force` 是给启动前那次检查的，不是给桥的：桥不认识这个参数，转过去只会被当成未知项。
 */
function bridgeArgs() {
  return process.argv.slice(2).filter((a) => a !== "--force" && !a.startsWith("--force="));
}

// 起之前再查一次（D441）：`start:nobuild` 与直跑都不经过 `npm start` 链里的那一步。
// 跟链首那次不是原子的，只能把「检查完到 listen 之间被抢」的空窗缩小一点（真被抢了由壳的
// EADDRINUSE 兜底）。端口空着时这一步一声不响。
const preflightCode = await preflight({ force: forceRequested() });
if (preflightCode !== EXIT_OK) process.exit(preflightCode);

const child = spawn(process.execPath, [entry, ...bridgeArgs()], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 已经没了 */
    }
  });
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
