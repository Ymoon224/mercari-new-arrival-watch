$ErrorActionPreference = 'Stop'
$taskBridgeRoot = 'D:\OpenClaw\mercari-bridge'
$taskConfigFile = Join-Path $taskBridgeRoot 'config.json'
$taskQueueFile = Join-Path $taskBridgeRoot 'deliveries.json'
$taskConfigBefore = Get-Content -LiteralPath $taskConfigFile -Raw | ConvertFrom-Json
& (Join-Path $taskBridgeRoot 'stop.ps1')
$taskBackupDir = Join-Path $taskBridgeRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackupDir -Force | Out-Null
foreach ($taskName in @('config.json','recipients.json','deliveries.json','main.mjs','service.mjs','weixin.mjs','recipients.mjs','discover.mjs','start.ps1','stop.ps1')) {
    $taskSource = Join-Path $taskBridgeRoot $taskName
    if (Test-Path -LiteralPath $taskSource) { Copy-Item -LiteralPath $taskSource -Destination (Join-Path $taskBackupDir $taskName) }
}
if (Test-Path -LiteralPath (Join-Path $taskBridgeRoot 'queues')) { Copy-Item -LiteralPath (Join-Path $taskBridgeRoot 'queues') -Destination (Join-Path $taskBackupDir 'queues') -Recurse }
if (Test-Path -LiteralPath (Join-Path $taskBridgeRoot 'deleted-queues')) { Copy-Item -LiteralPath (Join-Path $taskBridgeRoot 'deleted-queues') -Destination (Join-Path $taskBackupDir 'deleted-queues') -Recurse }
$taskQueueExisted = Test-Path -LiteralPath $taskQueueFile
$taskQueueHash = if ($taskQueueExisted) { (Get-FileHash -LiteralPath $taskQueueFile -Algorithm SHA256).Hash } else { $null }
& (Join-Path $PSScriptRoot 'install-mercari-bridge-d.ps1')
$taskConfigAfter = Get-Content -LiteralPath $taskConfigFile -Raw | ConvertFrom-Json
if ($taskConfigBefore.token -ne $taskConfigAfter.token -or $taskConfigBefore.target -ne $taskConfigAfter.target) { throw 'Connection identity changed; service not started. Restore the local backup.' }
if ((Test-Path -LiteralPath $taskQueueFile) -ne $taskQueueExisted) { throw 'Queue presence changed during installation; service not started.' }
if ($taskQueueExisted -and (Get-FileHash -LiteralPath $taskQueueFile -Algorithm SHA256).Hash -ne $taskQueueHash) { throw 'Queue changed during installation; service not started. Inspect the local backup.' }
Write-Output 'Login identity, connection key and complete queue were preserved. A local backup was saved.'
& (Join-Path $taskBridgeRoot 'start.ps1')
