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

const root = path.resolve(import.meta.dirname, "..");
const entry = bridgeEntry(root);

if (!fs.existsSync(entry)) {
  console.error(`找不到 ${entry} —— 先在仓库根目录跑一次 npm run build`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
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
