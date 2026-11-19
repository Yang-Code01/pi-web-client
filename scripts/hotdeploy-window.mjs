/**
 * 热部署换进程用的那扇可见 PowerShell 窗口。脚本是个循环：node 退出后若看到 relaunch 标记，
 * 就在同一扇窗口里再起一次（worker 杀旧桥前放下标记），否则窗口照旧随桥一起关（关窗即停）。
 * 单独成文件是为了让测试能 import，不触发 worker 的 main()。
 */
import { spawnSync } from "node:child_process";

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 循环窗口脚本。PS 5.1 按 ANSI 读无 BOM 文件；窗口标题与路径都可能是中文，必须带 BOM。
 * 直接跑 node，别经过 npm：npm.cmd 把窗口标题改回 PowerShell，那扇窗口就认不出来了。
 * 分支每轮现查：脚本只在开窗那次写，复用窗口时写死的分支名就过期了。
 */
export function windowScript({ repo, port, node, live, relaunch }) {
  return [
    `\uFEFF$host.ui.RawUI.WindowTitle = 'pi bridge · ${port}'`,
    `Set-Location -LiteralPath ${psQuote(repo)}`,
    `$relaunch = ${psQuote(relaunch)}`,
    "Remove-Item -LiteralPath $relaunch -Force -ErrorAction SilentlyContinue",
    "while ($true) {",
    "  $b = git rev-parse --abbrev-ref HEAD 2>$null",
    `  Write-Host "pi bridge · ${port} · $b —— 这扇窗口关了桥就停了" -ForegroundColor DarkGray`,
    `  & ${psQuote(node)} 'bridge\\dist\\index.js' 2>&1 | Tee-Object -FilePath ${psQuote(live)} -Append`,
    "  if (-not (Test-Path -LiteralPath $relaunch)) { break }",
    "  Remove-Item -LiteralPath $relaunch -Force -ErrorAction SilentlyContinue",
    "  Write-Host ''",
    "  Write-Host '—— 热部署：在这扇窗口里换上新构建 ——' -ForegroundColor Cyan",
    "}",
    "",
  ].join("\r\n");
}

/**
 * 旧桥的父进程若是本端口的循环窗口（`powershell -File bridge-window-<port>.ps1`），返回它的 pid。
 * 旧版 worker 开的 `start-bridge.ps1` 窗口不认：那个脚本没有循环，杀了桥窗口就关。只在 Windows 上调。
 */
export function windowHostOf(pid, port) {
  if (!pid) return null;
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$c = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; ` +
        "if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.ParentProcessId) -ErrorAction SilentlyContinue; " +
        "if ($p) { [string]$p.ProcessId + [char]9 + $p.CommandLine } }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const [ppid, cmd = ""] = String(r.stdout || "").trim().split("\t");
  const n = Number(ppid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const norm = cmd.split(String.fromCharCode(92)).join("/").toLowerCase();
  return norm.includes(`/bridge-window-${port}.ps1`) ? n : null;
}
