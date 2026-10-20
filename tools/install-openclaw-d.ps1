[CmdletBinding()]
param([string]$InstallRoot = 'D:\OpenClaw')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($taskRoot -ne 'D:\OpenClaw') { throw 'This installer is scoped to D:\OpenClaw.' }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This installer requires Windows x64.' }
$taskMarker = Join-Path $taskRoot 'installation.json'
if ((Test-Path -LiteralPath $taskRoot) -and !(Test-Path -LiteralPath $taskMarker)) {
    if (@(Get-ChildItem -LiteralPath $taskRoot -Force).Count -gt 0) { throw 'The target contains unrecognized existing files. No files were changed.' }
}

function Get-OfficialFile([string]$Uri, [string]$Destination) {
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -TimeoutSec 240
}
function Set-UserSetting([string]$Name, [string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
}

New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$taskDownloads = Join-Path $taskRoot 'downloads'
$taskRuntime = Join-Path $taskRoot 'runtime'
$taskCli = Join-Path $taskRoot 'cli'
$taskBin = Join-Path $taskRoot 'bin'
$taskData = Join-Path $taskRoot 'data'
$taskWorkspace = Join-Path $taskRoot 'workspace'
$taskCache = Join-Path $taskRoot 'npm-cache'
foreach ($taskDirectory in @($taskDownloads, $taskRuntime, $taskCli, $taskBin, $taskData, $taskWorkspace, $taskCache)) {
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
}
if (!(Test-Path -LiteralPath $taskMarker)) {
    [pscustomobject]@{ status = 'installing'; root = $taskRoot; createdAt = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $taskMarker -Encoding utf8
}

Write-Output 'Reading official Node.js and npm package metadata...'
$taskNodeReleases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
$taskNodeRelease = $taskNodeReleases | Where-Object { $_.version -match '^v24\.\d+\.\d+$' -and $_.lts -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
if (!$taskNodeRelease) { throw 'No official Node.js 24 LTS Windows x64 ZIP found.' }
$taskPackage = Invoke-RestMethod -Uri 'https://registry.npmjs.org/openclaw/latest' -TimeoutSec 60
if ($taskPackage.name -ne 'openclaw' -or $taskPackage.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
    throw 'Unexpected OpenClaw registry metadata.'
}
$taskNodeVersion = $taskNodeRelease.version
$taskOpenclawVersion = $taskPackage.version
$taskNodeFolder = "node-$taskNodeVersion-win-x64"
$taskNodeDir = Join-Path $taskRuntime $taskNodeFolder
$taskNodeExe = Join-Path $taskNodeDir 'node.exe'
$taskZipName = "$taskNodeFolder.zip"
$taskZip = Join-Path $taskDownloads $taskZipName
$taskSums = Join-Path $taskDownloads "SHASUMS256-$taskNodeVersion.txt"
Write-Output "Selected Node.js $taskNodeVersion LTS, OpenClaw $taskOpenclawVersion (Node requirement: $($taskPackage.engines.node))."

if (!(Test-Path -LiteralPath $taskNodeExe)) {
    Write-Output 'Downloading the official Node.js ZIP and SHA-256 checksum list...'
    Get-OfficialFile "https://nodejs.org/dist/$taskNodeVersion/$taskZipName" $taskZip
    Get-OfficialFile "https://nodejs.org/dist/$taskNodeVersion/SHASUMS256.txt" $taskSums
    $taskChecksum = Get-Content -LiteralPath $taskSums | Where-Object { $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape($taskZipName) + '$') } | Select-Object -First 1
    if (!$taskChecksum) { throw 'The official checksum list does not contain the selected ZIP.' }
    $taskExpected = ($taskChecksum -split '\s+')[0]
    $taskActual = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskActual -ne $taskExpected) { throw 'Node.js ZIP checksum verification failed. Installation stopped.' }
    Write-Output 'Node.js SHA-256 verified. Extracting to D:...'
    Expand-Archive -LiteralPath $taskZip -DestinationPath $taskRuntime -Force
}
$taskSignature = Get-AuthenticodeSignature -LiteralPath $taskNodeExe
if ($taskSignature.Status -ne 'Valid') { throw "Node.js executable signature is not valid: $($taskSignature.Status)" }
Write-Output "Node.js executable signature verified: $($taskSignature.SignerCertificate.Subject)."

$env:PATH = "$taskNodeDir;$taskCli;$taskBin;$env:PATH"
$env:OPENCLAW_STATE_DIR = $taskData
$env:OPENCLAW_CONFIG_PATH = Join-Path $taskData 'openclaw.json'
$env:NPM_CONFIG_PREFIX = $taskCli
$env:NPM_CONFIG_CACHE = $taskCache
$env:GIT_TERMINAL_PROMPT = '0'
$taskNpmCmd = Join-Path $taskNodeDir 'npm.cmd'
$taskNpmVersionText = (& $taskNpmCmd --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'npm verification failed.' }
Write-Output "npm $taskNpmVersionText is ready. Installing OpenClaw under $taskCli..."
$taskNpmArguments = @('install', '--global', "openclaw@$taskOpenclawVersion", '--prefix', $taskCli, '--cache', $taskCache,
    '--registry', 'https://registry.npmjs.org/', '--no-audit', '--no-fund')
if ([version]($taskNpmVersionText -replace '-.*$', '') -ge [version]'11.16.0') { $taskNpmArguments += '--allow-scripts=openclaw' }
& $taskNpmCmd @taskNpmArguments
if ($LASTEXITCODE -ne 0) { throw "OpenClaw npm installation failed with exit code $LASTEXITCODE. Logs remain in $taskCache." }

$taskEntry = Join-Path $taskCli 'node_modules\openclaw\openclaw.mjs'
if (!(Test-Path -LiteralPath $taskEntry)) { throw 'Installed OpenClaw CLI entry was not found.' }
$taskWrapper = @"
@echo off
setlocal
set "OPENCLAW_STATE_DIR=$taskData"
set "OPENCLAW_CONFIG_PATH=$taskData\openclaw.json"
set "PATH=$taskNodeDir;%PATH%"
"$taskNodeExe" "$taskEntry" %*
exit /b %errorlevel%
"@
[IO.File]::WriteAllText((Join-Path $taskBin 'openclaw.cmd'), $taskWrapper.Replace("`n", "`r`n"), [Text.UTF8Encoding]::new($false))
$taskConfigPath = Join-Path $taskData 'openclaw.json'
if (!(Test-Path -LiteralPath $taskConfigPath)) {
    @{ agents = @{ defaults = @{ workspace = $taskWorkspace } }; gateway = @{ mode = 'local'; bind = 'loopback' } } |
        ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
}

$taskOldPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$taskBackupPath = Join-Path $taskRoot 'environment-before-install.json'
if (!(Test-Path -LiteralPath $taskBackupPath)) {
    @{ Path = $taskOldPath; OPENCLAW_STATE_DIR = [Environment]::GetEnvironmentVariable('OPENCLAW_STATE_DIR', 'User');
       OPENCLAW_CONFIG_PATH = [Environment]::GetEnvironmentVariable('OPENCLAW_CONFIG_PATH', 'User');
       NPM_CONFIG_PREFIX = [Environment]::GetEnvironmentVariable('NPM_CONFIG_PREFIX', 'User');
       NPM_CONFIG_CACHE = [Environment]::GetEnvironmentVariable('NPM_CONFIG_CACHE', 'User') } |
        ConvertTo-Json | Set-Content -LiteralPath $taskBackupPath -Encoding utf8
}
$taskPathParts = @($taskBin, $taskNodeDir, $taskCli) + @($taskOldPath -split ';' | Where-Object { $_ -and $_ -notin @($taskBin, $taskNodeDir, $taskCli) })
Set-UserSetting 'Path' ($taskPathParts -join ';')
Set-UserSetting 'OPENCLAW_STATE_DIR' $taskData
Set-UserSetting 'OPENCLAW_CONFIG_PATH' $taskConfigPath
Set-UserSetting 'NPM_CONFIG_PREFIX' $taskCli
Set-UserSetting 'NPM_CONFIG_CACHE' $taskCache

Write-Output 'Verifying the installed commands...'
& $taskNodeExe --version
& $taskNpmCmd --version
& $taskNodeExe $taskEntry --version
if ($LASTEXITCODE -ne 0) { throw 'OpenClaw CLI version verification failed.' }
& $taskNodeExe $taskEntry config validate
if ($LASTEXITCODE -ne 0) { throw 'OpenClaw configuration validation failed.' }
$taskResult = [pscustomobject]@{ status = 'installed'; root = $taskRoot; node = $taskNodeVersion;
    npm = $taskNpmVersionText; openclaw = $taskOpenclawVersion; nodeDir = $taskNodeDir;
    cliEntry = $taskEntry; command = (Join-Path $taskBin 'openclaw.cmd'); stateDir = $taskData;
    workspace = $taskWorkspace; installedAt = [DateTime]::UtcNow.ToString('o'); gatewayStarted = $false }
$taskResult | ConvertTo-Json | Set-Content -LiteralPath $taskMarker -Encoding utf8
$taskResult | ConvertTo-Json
