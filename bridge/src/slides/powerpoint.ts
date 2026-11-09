/**
 * PowerPoint 的 COM 驱动（D209）：把演示文稿无窗口、只读、禁宏地导出成 PDF。
 *
 * 三条硬约束，每一条都在下面有对应的做法：
 * 1. **不弹窗口** —— `Presentations.Open(..., WithWindow:=msoFalse)`，用户只会看到 PowerPoint
 *    进程在后台起来一下（多显示器下仍可能闪一个窗，issue #265 已接受）。
 * 2. **不跟用户抢** —— 同一个 COM 实例一次只跑一个转换（`docpdf/service.ts` 里排队）。
 * 3. **超时不能留僵尸** —— 超时先杀 powershell，再把这期间**新出现**的 POWERPNT.EXE 收掉
 *    （只杀新的：用户自己开着的演示文稿不许动）。
 *
 * 只支持 Windows；别的平台上 `available()` 为 false，界面只留「用本机程序打开」。
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PdfConvertError } from "../docpdf/service.ts";

const TIMEOUT_MS = 120_000;
/** 页数上限（D209）：超了就不转，别让 PowerPoint 在后台烤十分钟。 */
export const MAX_PAGES = 200;

export interface PowerpointProbe {
  available: boolean;
  /** 找到的 POWERPNT.EXE（只用于展示/排错；实际起 COM 的是 `PowerPoint.Application`）。 */
  exe: string | null;
}

let cached: PowerpointProbe | null = null;

/** 注册表 App Paths 写的就是安装位置；找不到再看两处固定路径。 */
function registryExe(): string | null {
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE", "/ve"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
    if (m) {
      const exe = m[1].replace(/^"|"$/g, "").trim();
      if (exe && fs.existsSync(exe)) return exe;
    }
  } catch {
    /* 没有这条键就是没装，或没权限 —— 交给固定路径。 */
  }
  const fixed = [
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft Office", "Root", "Office16", "POWERPNT.EXE"),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Office",
      "Root",
      "Office16",
      "POWERPNT.EXE",
    ),
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  return null;
}

/** COM 类没注册时点开会报「类未注册」，不如提前说没装。 */
function classRegistered(): boolean {
  try {
    execFileSync("reg", ["query", "HKCR\\PowerPoint.Application", "/ve"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 启动时探一次（有缓存）；`PI_POWERPOINT` 只用于显式指定「有」，不用于启动 COM。 */
export function probePowerpoint(force = false): PowerpointProbe {
  if (cached && !force) return cached;
  if (process.platform !== "win32") {
    cached = { available: false, exe: null };
    return cached;
  }
  const exe =
    process.env.PI_POWERPOINT && fs.existsSync(process.env.PI_POWERPOINT)
      ? process.env.PI_POWERPOINT
      : registryExe();
  cached = { available: Boolean(exe) && classRegistered(), exe };
  return cached;
}

/** 当前所有 POWERPNT 进程；转换前后各取一次，差集就是这次起的。 */
function powerpointPids(): Set<number> {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"POWERPNT\.EXE","(\d+)"/i);
      if (m) pids.add(Number(m[1]));
    }
    return pids;
  } catch {
    return new Set();
  }
}

function killNewPowerpoint(before: Set<number>): void {
  for (const pid of powerpointPids()) {
    if (before.has(pid)) continue;
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    } catch {
      /* 已经退了 */
    }
  }
}

/** 正在跑的那一次转换之前已有的 POWERPNT 集合；超时兜底用它算「谁是这次起的」。 */
let runningBefore: Set<number> | null = null;

/** 超时兜底（service 的 `engine.kill`）：收拾 PowerShell 留下的 POWERPNT。 */
export function killPowerpoint(): void {
  if (runningBefore) killNewPowerpoint(runningBefore);
}

/**
 * PowerShell 脚本：**ASCII-only**（PowerShell 5.1 会按 ANSI 读无 BOM 的 UTF-8，中文注释会炸），
 * 且 `param()` 必须是第一条语句。先 Close 再 Quit，避免退出时弹「是否保存」。
 */
const SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][int]$MaxPages
)
$ErrorActionPreference = 'Stop'
try {
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $app.DisplayAlerts = 1            # ppAlertsNone
    $app.AutomationSecurity = 3       # msoAutomationSecurityForceDisable
    $pres = $app.Presentations.Open($Src, $true, $false, $false)  # ReadOnly, Untitled, WithWindow
    try {
      $pages = $pres.Slides.Count
      if ($pages -gt $MaxPages) {
        [Console]::Error.WriteLine("SLIDES_TOO_MANY:$pages")
        exit 2
      }
      $pres.SaveAs($Out, 32)          # ppSaveAsPDF
    } finally {
      try { $pres.Close() } catch { }
    }
  } finally {
    try { $app.Quit() } catch { }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("SLIDES_ERROR:" + $_.Exception.Message)
  exit 1
}
`;

/**
 * 把一份演示文稿导出成 PDF。失败抛 `PdfConvertError`，码：
 * `slides_pdf_pages`（页数超限）/ `slides_pdf_powerpoint`（没装或 COM 起不来）/ `slides_pdf_failed`。
 */
export async function convertWithPowerpoint(abs: string, workDir: string): Promise<string> {
  const script = path.join(workDir, "convert.ps1");
  await fs.promises.writeFile(script, SCRIPT, "utf8");
  const out = path.join(workDir, `${path.basename(abs, path.extname(abs))}.pdf`);
  const before = powerpointPids();
  runningBefore = before;

  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Src",
        abs,
        "-Out",
        out,
        "-MaxPages",
        String(MAX_PAGES),
      ],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        runningBefore = null;
        const said = `${String(stdout ?? "")} ${String(stderr ?? "")}`.trim();
        if (!err) {
          resolve();
          return;
        }
        const tooMany = said.match(/SLIDES_TOO_MANY:(\d+)/);
        if (tooMany) {
          reject(new PdfConvertError("slides_pdf_pages", `这份演示文稿有 ${tooMany[1]} 页，超过 ${MAX_PAGES} 页上限`));
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT" || /timed out/i.test((err as Error).message)) {
          killNewPowerpoint(before);
          reject(new PdfConvertError("slides_pdf_timeout", `转换超时（${TIMEOUT_MS / 1000} 秒）`));
          return;
        }
        if (/0x80040154|0x80080005|Class not registered|类未注册/i.test(said)) {
          reject(new PdfConvertError("slides_pdf_powerpoint", `PowerPoint 起不来：${said.slice(-300)}`));
          return;
        }
        reject(new PdfConvertError("slides_pdf_failed", `PowerPoint 转换失败：${said.slice(-300) || (err as Error).message}`));
      },
    );
  });

  return out;
}
