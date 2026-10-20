$ErrorActionPreference = 'Stop'

$taskRoot = 'D:\OpenClaw'
$taskInstall = Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
if ($taskInstall.status -ne 'installed' -or $taskInstall.root -ne $taskRoot) {
    throw 'The verified D:\OpenClaw installation was not found.'
}
$taskCommand = Join-Path $taskRoot 'bin\openclaw.cmd'
$taskTemp = Join-Path $taskRoot 'temp'
$taskBackups = Join-Path $taskRoot 'backups'
foreach ($taskDirectory in @($taskTemp, $taskBackups)) {
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
}
$env:PATH = "$($taskInstall.nodeDir);$taskRoot\bin;$taskRoot\cli;$env:PATH"
$env:OPENCLAW_STATE_DIR = Join-Path $taskRoot 'data'
$env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
$env:NPM_CONFIG_PREFIX = Join-Path $taskRoot 'cli'
$env:NPM_CONFIG_CACHE = Join-Path $taskRoot 'npm-cache'
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/'
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:GIT_TERMINAL_PROMPT = '0'

$taskPackage = Invoke-RestMethod -Uri 'https://registry.npmjs.org/@tencent-weixin%2Fopenclaw-weixin/latest' -TimeoutSec 60
if ($taskPackage.name -ne '@tencent-weixin/openclaw-weixin' -or
    $taskPackage.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
    throw 'Unexpected Tencent Weixin npm package metadata.'
}
$taskSpec = "$($taskPackage.name)@$($taskPackage.version)"
Write-Output "Installing Tencent Weixin plugin $taskSpec with state and temporary files under $taskRoot."
Copy-Item -LiteralPath $env:OPENCLAW_CONFIG_PATH -Destination (Join-Path $taskBackups ('openclaw-before-weixin-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.json'))
& $taskCommand plugins install $taskSpec --pin --force
if ($LASTEXITCODE -ne 0) { throw "Plugin installation failed with exit code $LASTEXITCODE." }
& $taskCommand plugins enable openclaw-weixin
if ($LASTEXITCODE -ne 0) { throw "Plugin enable failed with exit code $LASTEXITCODE." }
& $taskCommand config validate
if ($LASTEXITCODE -ne 0) { throw 'OpenClaw configuration validation failed.' }
& $taskCommand plugins inspect openclaw-weixin --runtime --json
if ($LASTEXITCODE -ne 0) { throw 'Weixin plugin runtime inspection failed.' }
