# D154：注册用户级计划任务，每分钟跑一次 watchdog.mjs。
# 不需要管理员权限；任务以「交互式登录」身份运行，登录后生效。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Dir F:\other-checkout -Port 7964
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Uninstall
param(
  [switch]$Uninstall,
  [string]$Dir = "",
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$TaskName = 'pi-web-bridge-watchdog'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  Write-Host "已移除计划任务 $TaskName"
  return
}

# bin -> bridge-update -> skills -> .pi -> 仓库根
if (-not $Dir) { $Dir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path }
else { $Dir = (Resolve-Path $Dir).Path }
if (-not $Port) { $Port = if ($env:PI_WEB_PORT) { [int]$env:PI_WEB_PORT } else { 7864 } }

$Script = Join-Path $PSScriptRoot 'watchdog.mjs'
if (-not (Test-Path $Script)) { throw "找不到 $Script" }
if (-not (Test-Path (Join-Path $Dir 'bridge\package.json'))) { throw "$Dir 不像 pi-web-client（缺 bridge\package.json）" }

$node = (Get-Command node -ErrorAction Stop).Source
# 参数整体当成一条命令行：路径里的空格交给外层引号，PowerShell 这边只用转义引号。
$arguments = '"{0}" --dir "{1}" --port {2}' -f $Script, $Dir, $Port

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $registered) { throw "Register-ScheduledTask 没有报错，但 $TaskName 不存在" }

Write-Host "已注册计划任务 $TaskName（每 1 分钟检查 http://127.0.0.1:$Port/healthz）"
Write-Host "  仓库：$Dir"
Write-Host "  参数：$arguments"
Write-Host "查看：schtasks /query /tn $TaskName /v /fo list"
Write-Host "日志：$(Join-Path $Dir '.scratch\bridge-update\watchdog.log')"
