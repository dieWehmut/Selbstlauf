[CmdletBinding()]
param(
    [string]$StateRoot,
    [string]$RepositoryRoot,
    [int]$ExpectedPid = 0,
    [ValidateRange(0, 30000)]
    [int]$DelayMilliseconds = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$LASTEXITCODE = 0
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass\continuation'
}
$stateRoot = [System.IO.Path]::GetFullPath($StateRoot)
if ((Split-Path -Leaf $stateRoot) -ine 'continuation' -or
    (Split-Path -Leaf (Split-Path -Parent $stateRoot)) -ine 'ai-cli-bypass') {
    throw 'refusing to uninstall from a state directory outside ai-cli-bypass\continuation'
}

$manifestPath = Join-Path $stateRoot 'install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "refusing to uninstall without an ownership manifest: $manifestPath"
}
$stateItem = Get-Item -LiteralPath $stateRoot -Force
if (($stateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'refusing to uninstall a reparse-point state directory'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1 -or
    [string]$manifest.product -ne 'Selbstlauf Continuation Watchdog' -or
    -not [bool]$manifest.ownsStateRoot -or
    [System.IO.Path]::GetFullPath([string]$manifest.stateRoot) -ine $stateRoot) {
    throw 'refusing to uninstall with an invalid or mismatched ownership manifest'
}

$manifestRepositoryRoot = [System.IO.Path]::GetFullPath([string]$manifest.repositoryRoot)
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = $manifestRepositoryRoot }
$repositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
if ($repositoryRoot -ine $manifestRepositoryRoot) {
    throw 'refusing to uninstall because the repository root does not match the ownership manifest'
}

$knownOwnedFiles = @('config.json', 'audit.jsonl', 'claude-leases.json', 'claude-leases.json.lock', 'watchdog.pid.json', 'watchdog.log', 'watchdog-error.log', 'watchdog-uninstall.log', 'install-manifest.json')
if ($null -eq $manifest.ownedPaths -or @($manifest.ownedPaths).Count -eq 0) {
    throw 'refusing to uninstall without an owned-path manifest'
}
$ownedPaths = @($manifest.ownedPaths | ForEach-Object { [string]$_ })
foreach ($relativePath in $ownedPaths) {
    if ($knownOwnedFiles -notcontains $relativePath -or
        $relativePath -match '[\\/:]' -or $relativePath -in @('.', '..')) {
        throw "refusing to uninstall unsafe owned path '$relativePath'"
    }
}

if ($DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
$pidFile = Join-Path $stateRoot 'watchdog.pid.json'
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $watchdogPid = [int]$record.pid
    if ($ExpectedPid -gt 0 -and $watchdogPid -ne $ExpectedPid) {
        throw "refusing to stop PID $watchdogPid because PID $ExpectedPid requested the uninstall"
    }
    $watchdogProcess = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
    if ($watchdogProcess) {
        $entryPoint = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'apps\watchdog\dist\src\index.js'))
        if ($null -eq $record.entryPath -or [System.IO.Path]::GetFullPath([string]$record.entryPath) -ine $entryPoint) {
            throw "refusing to stop PID $watchdogPid because its entry path is not owned"
        }
        if ($null -eq $record.executablePath -or
            [System.IO.Path]::GetFullPath([string]$record.executablePath) -ine [System.IO.Path]::GetFullPath([string]$watchdogProcess.Path)) {
            throw "refusing to stop PID $watchdogPid because its executable path changed"
        }
        if ($null -eq $record.processStartedAtMs) {
            throw "refusing to stop PID $watchdogPid because its start time is absent"
        }
        $actualStartedAtMs = [DateTimeOffset]::new($watchdogProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
        if ([Math]::Abs($actualStartedAtMs - [long]$record.processStartedAtMs) -gt 5000) {
            throw "refusing to stop PID $watchdogPid because its start time changed"
        }
        Stop-Process -Id $watchdogPid -Force
        Wait-Process -Id $watchdogPid -Timeout 5 -ErrorAction SilentlyContinue
    }
}

if ($null -ne $manifest.startupTask -and [bool]$manifest.startupTask.owned) {
    $taskName = [string]$manifest.startupTask.name
    if ($taskName -ne 'Selbstlauf Continuation Watchdog') {
        throw "refusing to remove unexpected scheduled task '$taskName'"
    }
    $taskTool = if ([string]::IsNullOrWhiteSpace($env:WATCHDOG_SCHTASKS_PATH)) { 'schtasks.exe' } else { $env:WATCHDOG_SCHTASKS_PATH }
    & $taskTool /Query /TN $taskName *> $null
    if ($LASTEXITCODE -eq 0) {
        & $taskTool /Delete /TN $taskName /F *> $null
        if ($LASTEXITCODE -ne 0) { throw "scheduled task removal failed with exit code $LASTEXITCODE" }
    }
}

foreach ($relativePath in $ownedPaths) {
    if ($relativePath -eq 'install-manifest.json') { continue }
    $ownedPath = Join-Path $stateRoot $relativePath
    if (Test-Path -LiteralPath $ownedPath -PathType Container) {
        throw "refusing to recursively remove owned path '$relativePath'"
    }
    Remove-Item -LiteralPath $ownedPath -Force -ErrorAction SilentlyContinue
}
$remaining = @(Get-ChildItem -LiteralPath $stateRoot -Force | Where-Object { $_.Name -ne 'install-manifest.json' })
if ($remaining.Count -gt 0) {
    Write-Output "watchdog stopped; preserved user files: $((@($remaining.Name) -join ', '))"
    exit 0
}
Remove-Item -LiteralPath (Join-Path $stateRoot 'install-manifest.json') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stateRoot -Force -ErrorAction SilentlyContinue
Write-Output "watchdog uninstalled; removed owned state: $stateRoot"
