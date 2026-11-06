# D154：注册用户级计划任务，每分钟跑一次 watchdog.mjs。
# 不需要管理员权限；任务以「交互式登录」身份运行，登录后生效。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'pi-web-bridge-watchdog'
$Script = Join-Path $PSScriptRoot 'watchdog.mjs'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  Write-Host "已移除计划任务 $TaskName"
  return
}

$node = (Get-Command node -ErrorAction Stop).Source

try {
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$Script`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
} catch {
  # 老系统上 Register-ScheduledTask 可能需要提权，退回 schtasks（用户任务不需要管理员）
  Write-Host "Register-ScheduledTask 失败（$($_.Exception.Message)），改用 schtasks" -ForegroundColor Yellow
  $cmd = "`"$node`" `"$Script`""
  schtasks /create /tn $TaskName /tr $cmd /sc minute /mo 1 /f | Out-Null
}

Write-Host "已注册计划任务 $TaskName（每 1 分钟检查 http://127.0.0.1:7864/healthz）"
Write-Host "查看：schtasks /query /tn $TaskName /v /fo list"
Write-Host "日志：.scratch\bridge-update\watchdog.log"
