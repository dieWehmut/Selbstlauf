[CmdletBinding()]
param(
    [int]$Port = 48920,
    [switch]$DryRun,
    [switch]$NoBuild,
    [switch]$Startup
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$LASTEXITCODE = 0
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$startScript = Join-Path $PSScriptRoot 'start-watchdog.ps1'
$stateRoot = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass\continuation'
$pidFile = Join-Path $stateRoot 'watchdog.pid.json'
$manifestPath = Join-Path $stateRoot 'install-manifest.json'
$taskName = 'Selbstlauf Continuation Watchdog'
$taskTool = if ([string]::IsNullOrWhiteSpace($env:WATCHDOG_SCHTASKS_PATH)) { 'schtasks.exe' } else { $env:WATCHDOG_SCHTASKS_PATH }

$startParameters = @{
    Port = $Port
    DryRun = [bool]$DryRun
    NoBuild = [bool]$NoBuild
}
& $startScript @startParameters
if ($LASTEXITCODE -ne 0) { throw "watchdog start failed with exit code $LASTEXITCODE" }

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$origin = "http://127.0.0.1:$($record.port)"
Invoke-RestMethod -Method Post -Uri "$origin/api/install" -Headers @{ Origin = $origin } | Out-Null
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "watchdog install manifest was not created: $manifestPath"
}

if ($Startup) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $ownsExistingTask = $null -ne $manifest.startupTask -and
        [bool]$manifest.startupTask.owned -and
        [string]$manifest.startupTask.name -eq $taskName

    & $taskTool /Query /TN $taskName *> $null
    $taskExists = $LASTEXITCODE -eq 0
    if ($taskExists -and -not $ownsExistingTask) {
        throw "refusing to replace unowned scheduled task '$taskName'"
    }

    $taskAction = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -Port $Port -NoBuild"
    if ($DryRun) { $taskAction += ' -DryRun' }
    & $taskTool /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $taskAction /F *> $null
    if ($LASTEXITCODE -ne 0) { throw "scheduled task registration failed with exit code $LASTEXITCODE" }

    try {
        $manifest.startupTask = [ordered]@{ name = $taskName; owned = $true }
        $manifest.updatedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $temporaryManifest = "$manifestPath.tmp"
        $manifestJson = $manifest | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($temporaryManifest, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force
    }
    catch {
        if (-not $ownsExistingTask) { & $taskTool /Delete /TN $taskName /F *> $null }
        throw
    }
}

Write-Output "watchdog installed; state: $stateRoot; startup: $([bool]$Startup)"
