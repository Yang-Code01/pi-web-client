import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 端口 → pid 文件（D154）。
 *
 * 更新器（`.pi/skills/bridge-update/bin/restart.mjs`）靠它找「谁在服务这个端口」。
 * 不靠 `netstat` / `Get-NetTCPConnection`：在沙箱、容器或本地代理后面，它们看不到
 * 真正持有 socket 的进程，会答一个空 pid，更新器就会去起第二个实例撞 EADDRINUSE。
 */
export function pidFile(port: number): string {
  return path.join(os.tmpdir(), `pi-web-bridge-${port}.pid`);
}

export function writePidFile(port: number): void {
  try {
    fs.writeFileSync(pidFile(port), `${process.pid}\n`, "utf8");
  } catch {
    /* 临时目录不可写不该阻止服务启动 */
  }
}

export function removePidFile(port: number): void {
  try {
    fs.unlinkSync(pidFile(port));
  } catch {
    /* 已经不在了 */
  }
}

export function readPidFile(port: number): number | null {
  try {
    const n = Number(fs.readFileSync(pidFile(port), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
