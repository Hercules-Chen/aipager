# 註冊 Worker 排程工作：開機後執行、不論使用者是否登入，使用「已登入 Claude Code 的那個 Windows 帳號」
# 以系統管理員執行；會詢問該帳號密碼（Windows 需要它才能在未登入時載入使用者設定檔）
param(
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [string]$AppDir = "C:\Program Files\AIPager"
)
$bat = Join-Path $AppDir "scripts\start-worker.bat"
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$bat`" > `"C:\ProgramData\AIPager\logs\worker-console.log`" 2>&1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$cred = Get-Credential -UserName $User -Message "輸入 $User 的 Windows 密碼（排程工作用）"
Register-ScheduledTask -TaskName "AIPager Worker" -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force
Write-Host "已註冊排程工作: AIPager Worker (user=$User)"
