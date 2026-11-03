# Claude Relay worker 啟動腳本（UTF-8 BOM，供 Windows PowerShell 5.x 正確解析中文）
param(
    [string]$Config = "C:\ProgramData\ClaudeRelay\node\node.json",
    [string]$AppDir = "C:\Program Files\ClaudeRelay",
    [int]$InspectPort = 0,
    [switch]$Once
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Info([string]$msg) { Write-Host ("[start-worker {0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) }

if (-not (Test-Path $Config)) { Write-Info "找不到設定檔: $Config"; exit 2 }
$cfg = Get-Content -Raw -Encoding UTF8 $Config | ConvertFrom-Json

Write-Info "config      = $Config"
Write-Info "node_id     = $($cfg.node_id)"
Write-Info "hub_url     = $($cfg.hub_url)"
Write-Info "roles/labels = 由 Hub 管理（relayctl nodes show $($cfg.node_id)）"
Write-Info "claude_path = $($cfg.claude_path)"
Write-Info "token_file  = $($cfg.token_file)  (內容不顯示)"
Write-Info "node        = $(& node --version)"
Write-Info "user        = $env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $cfg.claude_path)) { Write-Info "claude_path 不存在，請先安裝 Claude Code 並登入"; exit 3 }
Write-Info "claude      = $(& $cfg.claude_path --version)"

$nodeArgs = @()
if ($InspectPort -gt 0) { $nodeArgs += "--inspect=127.0.0.1:$InspectPort"; Write-Info "Chrome DevTools: chrome://inspect -> 127.0.0.1:$InspectPort" }
$nodeArgs += @((Join-Path $AppDir "bin\worker.js"), "--config", $Config)

$delay = 5
while ($true) {
    Write-Info ("running: node {0}" -f ($nodeArgs -join ' '))
    & node @nodeArgs
    $code = $LASTEXITCODE
    Write-Info "worker exit code = $code"
    if ($Once -or $code -eq 0) { exit $code }
    if ($code -eq -1073741819) { Write-Info "native crash (0xC0000005)，請先檢查 Node 執行環境 / Volta 設定" }
    Write-Info "將在 $delay 秒後重新啟動"
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 300)
}
