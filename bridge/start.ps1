$ErrorActionPreference = 'Stop'
$taskBridgeRoot = $PSScriptRoot
$taskInstall = Get-Content -LiteralPath 'D:\OpenClaw\installation.json' -Raw | ConvertFrom-Json
$taskNode = Join-Path $taskInstall.nodeDir 'node.exe'
try {
    $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17869/health' -TimeoutSec 2
    if ($taskHealth.service -eq 'mercari-weixin-bridge') { Write-Output 'WeChat bridge is already running.'; exit 0 }
    throw 'Port 17869 is occupied by another service.'
} catch {
    if ($_.Exception.Message -eq 'Port 17869 is occupied by another service.') { throw }
}
$taskMain = Join-Path $taskBridgeRoot 'main.mjs'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + $taskMain + '"') -WorkingDirectory $taskBridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskBridgeRoot 'service.log') -RedirectStandardError (Join-Path $taskBridgeRoot 'service-error.log')
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskBridgeRoot 'service.pid')
for ($taskAttempt = 0; $taskAttempt -lt 20; $taskAttempt++) {
    Start-Sleep -Milliseconds 500
    if ($taskProcess.HasExited) { throw 'WeChat bridge exited. See service-error.log in this folder.' }
    try {
        $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17869/health' -TimeoutSec 2
        if ($taskHealth.service -eq 'mercari-weixin-bridge') { Write-Output 'WeChat bridge started: http://127.0.0.1:17869/setup'; exit 0 }
    } catch {}
}
throw 'The bridge did not become ready. Check service-error.log.'
