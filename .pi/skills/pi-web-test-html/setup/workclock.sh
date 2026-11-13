#!/usr/bin/env bash
# 上下班模块的系统级清场：卸掉记录器计划任务、杀掉记录器进程。
# 由 bin/env.sh fresh 调用；某些用例会把记录器装到 machine 上，失败中断时靠它兜底。
set -uo pipefail

powershell -NoProfile -Command '
  Stop-ScheduledTask -TaskName "pi-web-client-workclock" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "pi-web-client-workclock" -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = ''powershell.exe''" |
    Where-Object { $_.CommandLine -like "*workclock-agent.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
' >/dev/null 2>&1 || true

echo "workclock: 计划任务与记录器进程已清（不存在也算清）"
