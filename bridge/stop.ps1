$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'service.pid'
if (!(Test-Path -LiteralPath $taskPidFile)) { Write-Output 'WeChat bridge is not running.'; exit 0 }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
$taskInstall = Get-Content -LiteralPath 'D:\OpenClaw\installation.json' -Raw | ConvertFrom-Json
$taskNode = Join-Path $taskInstall.nodeDir 'node.exe'
$taskMain = Join-Path $PSScriptRoot 'main.mjs'
if ($taskProcess -and $taskProcess.ExecutablePath -eq $taskNode -and $taskProcess.CommandLine.Contains($taskMain)) {
    Stop-Process -Id $taskProcessId
    Write-Output 'WeChat bridge stopped. Pending messages remain on disk.'
} else { Write-Output 'No matching WeChat bridge process found. No process was stopped.' }
