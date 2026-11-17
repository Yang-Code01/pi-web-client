#!/usr/bin/env bash
# 上下班模块的系统级清场：删掉记录器的 HKCU Run 自启项、杀掉记录器进程。
# 由 bin/env.sh fresh 调用；某些用例会把记录器装到 machine 上，失败中断时靠它兜底。
# 记录器不再用计划任务（标准用户注册不了），自启项在 HKCU\...\Run，测试实例的值名还带哈希后缀。
set -uo pipefail

powershell -NoProfile -Command '
  $run = ''HKCU:\Software\Microsoft\Windows\CurrentVersion\Run''
  $props = Get-ItemProperty -LiteralPath $run -ErrorAction SilentlyContinue
  if ($props) {
    $props.PSObject.Properties |
      Where-Object { $_.Name -like ''pi-web-client-workclock*'' } |
      ForEach-Object { Remove-ItemProperty -LiteralPath $run -Name $_.Name -ErrorAction SilentlyContinue }
  }
  Get-CimInstance Win32_Process -Filter "Name = ''powershell.exe''" |
    Where-Object { $_.CommandLine -like "*workclock-agent.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
' >/dev/null 2>&1 || true

echo "workclock: 自启项（HKCU Run）与记录器进程已清（不存在也算清）"
