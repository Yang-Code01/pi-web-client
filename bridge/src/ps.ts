/**
 * 桥里跑 PowerShell / 走 UAC 的公共小件：本机管理（`sysmanage.ts`）与上下班记录器（`workclock.ts`）共用。
 *
 * 两条来历：
 * - 脚本从 stdin 进（`-Command -`），避免命令行长度与引号问题；不 detached —— D52 的教训是 Windows 上
 *   detached 会变成 DETACHED_PROCESS，`Start-Process -Verb RunAs` 拿不到桌面会话，UAC 静默失败。
 * - 提权助手写回执文件给桥读：桥自己的 stdout 拿不到提权进程的输出。
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statePath } from "./paths.ts";

export const PS_TIMEOUT = 30_000;
/** 一次 UAC 提权（等人点「是」+ 助手跑完）的总时限。 */
export const UAC_TIMEOUT = 120_000;

export interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 跑一段 Windows PowerShell；脚本走 stdin，见文件头的理由。 */
export function runPowerShell(script: string, timeoutMs = PS_TIMEOUT): Promise<PsResult> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: PsResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => finish({ code: -1, stdout, stderr: err.message, timedOut: false }));
    child.on("close", (code: number | null) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }));
    child.stdin.end(
      `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}\n`,
    );
  });
}

export function parseJson<T>(stdout: string): T | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 有的 PowerShell 会在 JSON 前打一行警告；取最后一个完整对象再试一次。
    const start = text.lastIndexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start)) as T;
    } catch {
      return null;
    }
  }
}

export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export type Receipt = Record<string, unknown> & { ok?: boolean; code?: string; error?: string };

/**
 * 用 UAC 提权跑一段助手脚本。脚本只由校验过的值拼成；`body` 里调 `Write-Receipt` 写成功回执，
 * 抛错时包装成 `{ok:false,code:failCode}`。取消 UAC 时 Start-Process 抛 1223，写成 `uac_denied`。
 * 回执是 JSON，桥再读回来；读不到就是 `no_receipt`。
 */
export async function runElevated(kind: string, body: string, failCode: string): Promise<Receipt> {
  const token = randomUUID();
  const helper = statePath(`sysmanage-${kind}-${token}.ps1`);
  const receipt = statePath(`sysmanage-${kind}-${token}.json`);
  const helperScript =
    `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n` +
    `$receipt=${psQuote(receipt)}\n` +
    `function Write-Receipt([object]$o){[IO.File]::WriteAllText($receipt,($o|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))}\n` +
    `try{\n${body}\n` +
    `}catch{Write-Receipt ([pscustomobject]@{ok=$false;code=${psQuote(failCode)};error=$_.Exception.Message});exit 1}\n`;
  // -ArgumentList 这里必须是一整条字符串：Start-Process 用空格拼接数组，路径带空格会断。
  const argLine = `-NoProfile -ExecutionPolicy Bypass -File "${helper}"`;
  const wrapperScript =
    `$ErrorActionPreference='Stop'\n` +
    `$receipt=${psQuote(receipt)}\n` +
    `try{\n` +
    `$p=Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(argLine)} -Verb RunAs -Wait -PassThru\n` +
    `exit $p.ExitCode\n` +
    `}catch{\n` +
    `$m=$_.Exception.Message\n` +
    `[IO.File]::WriteAllText($receipt,(@{ok=$false;code='uac_denied';error=$m}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))\n` +
    `exit 1\n}\n`;
  try {
    fs.writeFileSync(helper, helperScript, "utf8");
    const result = await runPowerShell(wrapperScript, UAC_TIMEOUT);
    if (result.timedOut) {
      return { ok: false, code: "uac_timeout", error: "等了 120 秒还没有回执：UAC 可能还开着，或者提权助手还在跑" };
    }
    let data: Receipt | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(receipt, "utf8")) as unknown;
      data = parsed && typeof parsed === "object" ? (parsed as Receipt) : null;
    } catch {
      data = null;
    }
    if (!data) {
      return { ok: false, code: "no_receipt", error: result.stderr.trim() || "提权助手没有留下回执" };
    }
    return data;
  } finally {
    for (const file of [helper, receipt]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 留在状态目录里也不影响下一次 */
      }
    }
  }
}
