[CmdletBinding()]
param([string]$StateRoot)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass\continuation'
}
$stateRoot = [System.IO.Path]::GetFullPath($StateRoot)
$pidFile = Join-Path $stateRoot 'watchdog.pid.json'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'watchdog is not running (PID file is absent)'
    exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$watchdogPid = [int]$record.pid
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $watchdogPid"
if (-not $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Output 'watchdog process is gone; removed stale PID file'
    exit 0
}

if ($process.CommandLine -notmatch 'apps[\\/]watchdog[\\/]dist[\\/]src[\\/]index\.js') {
    throw "refusing to stop PID $watchdogPid because it is not the ai-cli-bypass watchdog"
}

Stop-Process -Id $watchdogPid -Force
Wait-Process -Id $watchdogPid -Timeout 5 -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Output "watchdog stopped (PID $watchdogPid)"
