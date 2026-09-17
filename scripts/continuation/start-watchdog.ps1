[CmdletBinding()]
param(
    [int]$Port = 48920,
    [switch]$DryRun,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# The repository keeps the compiled service in apps/cli/dist; the packaged
# desktop app ships the same tree as resources/service-dist next to this script.
$packageRoot = Join-Path $repoRoot 'apps\cli'
$launcher = Join-Path $PSScriptRoot 'launch-watchdog.mjs'
$stateRoot = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass\continuation'
$pidFile = Join-Path $stateRoot 'watchdog.pid.json'
$logFile = Join-Path $stateRoot 'watchdog.log'
$errorLogFile = Join-Path $stateRoot 'watchdog-error.log'
$launcherPidFile = Join-Path $stateRoot 'watchdog.launch.pid'
$serviceEntryCandidates = @(
    (Join-Path $packageRoot 'dist\src\index.js'),
    (Join-Path $repoRoot 'service-dist\src\index.js')
)

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

$entryPoint = $serviceEntryCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $entryPoint -and -not $NoBuild -and (Test-Path -LiteralPath $packageRoot)) {
    # Only a repository checkout can build the entry point; a packaged install
    # ships it, so a missing dist there instead fails with the paths it probed.
    & npm --prefix $repoRoot --workspace apps/cli run build
    if ($LASTEXITCODE -ne 0) { throw "watchdog build failed with exit code $LASTEXITCODE" }
    $entryPoint = $serviceEntryCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if ($null -eq $entryPoint) {
    throw "watchdog entry point not found: $($serviceEntryCandidates -join '; ')"
}

if (Test-Path -LiteralPath $pidFile) {
    try {
        $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $existingProcess = Get-Process -Id ([int]$existing.pid) -ErrorAction Stop
        $existingCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$existing.pid)"
        if ($existingCim -and $existingCim.CommandLine -match '(?:apps[\\/]cli[\\/]dist|service-dist)[\\/]src[\\/]index\.js') {
            Write-Output "watchdog already running (PID $($existing.pid), port $($existing.port))"
            exit 0
        }
    } catch {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}

$launcherArguments = @(
    $launcher,
    '--entry', $entryPoint,
    '--cwd', $repoRoot,
    '--stdout', $logFile,
    '--stderr', $errorLogFile,
    '--port', [string]$Port,
    '--pid-file', $launcherPidFile
)
if ($DryRun) {
    $launcherArguments += '--dry-run'
}
Remove-Item -LiteralPath $launcherPidFile -Force -ErrorAction SilentlyContinue
$quotedLauncherArguments = $launcherArguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }
Start-Process -FilePath 'node.exe' -ArgumentList $quotedLauncherArguments -WorkingDirectory $repoRoot -WindowStyle Hidden
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not (Test-Path -LiteralPath $launcherPidFile) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
}
if (-not (Test-Path -LiteralPath $launcherPidFile)) {
    throw "watchdog launcher failed; see $errorLogFile"
}
$launchedPid = (Get-Content -LiteralPath $launcherPidFile -Raw).Trim()
Remove-Item -LiteralPath $launcherPidFile -Force -ErrorAction SilentlyContinue
if (-not ($launchedPid -match '^\d+$')) { throw "watchdog launcher returned an invalid PID" }
$process = Get-Process -Id ([int]$launchedPid) -ErrorAction Stop

Start-Sleep -Milliseconds 150
if ($process.HasExited) {
    throw "watchdog exited immediately with code $($process.ExitCode); see $errorLogFile"
}
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not (Test-Path -LiteralPath $pidFile) -and [DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) { throw "watchdog exited with code $($process.ExitCode); see $errorLogFile" }
    Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $pidFile)) {
    Stop-Process -Id ([int]$launchedPid) -Force -ErrorAction SilentlyContinue
    throw "watchdog did not create its PID file; see $errorLogFile"
}
$started = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
Write-Output "watchdog started (PID $($started.pid), port $($started.port)); state: $stateRoot"
