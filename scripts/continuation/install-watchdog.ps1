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
# schtasks.exe denies "/SC ONLOGON" to a non-elevated account, so the per-user
# logon task goes through the sibling helper, which uses the ScheduledTasks
# cmdlets. WATCHDOG_SCHTASKS_PATH still overrides both for tests.
$startupHelper = Join-Path $PSScriptRoot 'startup-task.ps1'
if (-not [string]::IsNullOrWhiteSpace($env:WATCHDOG_SCHTASKS_PATH)) {
    $taskTool = @($env:WATCHDOG_SCHTASKS_PATH)
}
elseif (Test-Path -LiteralPath $startupHelper -PathType Leaf) {
    $taskTool = @('powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $startupHelper)
}
else {
    $taskTool = @('schtasks.exe')
}

function Invoke-TaskTool {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    # The task tool writes "task not found" to stderr, and with the script-wide
    # $ErrorActionPreference = 'Stop' that native output would become a
    # terminating error before $LASTEXITCODE could be inspected.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & $taskTool[0] @($taskTool | Select-Object -Skip 1) @Arguments 2>&1
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

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

    $taskExists = (Invoke-TaskTool /Query /TN $taskName) -eq 0
    if ($taskExists -and -not $ownsExistingTask) {
        throw "refusing to replace unowned scheduled task '$taskName'"
    }

    $taskAction = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -Port $Port -NoBuild"
    if ($DryRun) { $taskAction += ' -DryRun' }
    $createExitCode = Invoke-TaskTool /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $taskAction /F
    if ($createExitCode -ne 0) { throw "scheduled task registration failed with exit code $createExitCode" }

    try {
        $manifest.startupTask = [ordered]@{ name = $taskName; owned = $true }
        $manifest.updatedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $temporaryManifest = "$manifestPath.tmp"
        $manifestJson = $manifest | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($temporaryManifest, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force
    }
    catch {
        if (-not $ownsExistingTask) { $null = Invoke-TaskTool /Delete /TN $taskName /F }
        throw
    }
}

Write-Output "watchdog installed; state: $stateRoot; startup: $([bool]$Startup)"
