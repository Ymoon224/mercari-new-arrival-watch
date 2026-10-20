$ErrorActionPreference = 'Stop'
$taskSourceRoot = Split-Path -Parent $PSScriptRoot
$taskBridgeRoot = 'D:\OpenClaw\mercari-bridge'
$taskInstall = Get-Content -LiteralPath 'D:\OpenClaw\installation.json' -Raw | ConvertFrom-Json
if ($taskInstall.status -ne 'installed' -or $taskInstall.root -ne 'D:\OpenClaw') { throw 'Verified D-drive OpenClaw installation not found.' }
try {
    $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17869/health' -TimeoutSec 2
    if ($taskHealth.service -eq 'mercari-weixin-bridge') { throw 'Stop the existing bridge before updating its files.' }
} catch {
    if ($_.Exception.Message -eq 'Stop the existing bridge before updating its files.') { throw }
}
New-Item -ItemType Directory -Path $taskBridgeRoot -Force | Out-Null
foreach ($taskName in @('main.mjs','service.mjs','weixin.mjs','receipts.mjs','recipients.mjs','discover.mjs','start.ps1','stop.ps1')) {
    Copy-Item -LiteralPath (Join-Path $taskSourceRoot "bridge\$taskName") -Destination (Join-Path $taskBridgeRoot $taskName) -Force
}
& (Join-Path $taskInstall.nodeDir 'node.exe') (Join-Path $PSScriptRoot 'configure-weixin-bridge.mjs') $taskBridgeRoot
if ($LASTEXITCODE -ne 0) { throw 'Bridge configuration failed.' }
$taskStartCmd = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"' + "`r`n" + 'if errorlevel 1 pause' + "`r`n"
$taskStopCmd = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"' + "`r`n" + 'if errorlevel 1 pause' + "`r`n"
[IO.File]::WriteAllText((Join-Path $taskBridgeRoot '启动微信转发.cmd'), $taskStartCmd, [Text.Encoding]::ASCII)
[IO.File]::WriteAllText((Join-Path $taskBridgeRoot '停止微信转发.cmd'), $taskStopCmd, [Text.Encoding]::ASCII)
$taskAddCmd = '@echo off' + "`r`n" + 'call "D:\OpenClaw\bin\openclaw.cmd" channels login --channel openclaw-weixin' + "`r`n" + 'pause' + "`r`n"
[IO.File]::WriteAllText((Join-Path $taskBridgeRoot '添加微信接收人.cmd'), $taskAddCmd, [Text.Encoding]::ASCII)
Write-Output "Bridge installed: $taskBridgeRoot"
