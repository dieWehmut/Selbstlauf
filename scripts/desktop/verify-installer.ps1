#!/usr/bin/env pwsh
# Install the Selbstlauf desktop setup silently, assert the installed app is
# complete and able to host its bundled watchdog service, then uninstall it.
#
# The file assertions are the regression gate for the ARM64 payload bug where
# the NSIS 7z plugin silently skipped every ARM64-filtered binary and still
# exited 0 with a partially installed app.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [int]$InstallTimeoutSeconds = 240,
    [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Selbstlauf'
$appExe = Join-Path $installRoot 'Selbstlauf.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Selbstlauf.exe'
$stateRoot = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass\continuation'
$watchdogPidFile = Join-Path $stateRoot 'watchdog.pid.json'
$startupTaskName = 'Selbstlauf Continuation Watchdog'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\1cb81a0d-dabd-5e19-9fd9-86ff38a6ca44'
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Selbstlauf.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Selbstlauf.lnk')
)
$requiredFiles = @(
    'Selbstlauf.exe',
    'ffmpeg.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'd3dcompiler_47.dll',
    'vk_swiftshader.dll',
    'vulkan-1.dll',
    'icudtl.dat',
    'resources.pak',
    'resources\app.asar',
    'resources\preload.mjs',
    'resources\web-dist\index.html',
    'resources\service-dist\src\index.js',
    # The service resolves its process provider beside its own module. tsc never
    # emits the PowerShell asset, so this entry is the regression gate for an
    # installer that served a WebUI while discovering no process at all.
    'resources\service-dist\src\process\windows-processes.ps1',
    # The reveal action resolves its own PowerShell asset the same way, so the
    # installed app needs it to be able to show a session's window.
    'resources\service-dist\src\process\window-focus.ps1',
    # The packaged app must ship the logon-task script tree; start-watchdog.ps1
    # resolves service-dist and web-dist beside it at runtime.
    'resources\scripts\continuation\start-watchdog.ps1',
    'resources\scripts\continuation\startup-task.ps1',
    'resources\scripts\continuation\launch-watchdog.mjs'
)

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Wait-ForCondition {
    param([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Description, [int]$IntervalMs = 500)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds $IntervalMs
    }
    throw "timed out after $TimeoutSeconds seconds waiting for $Description"
}

function Test-FileLocked {
    # Windows-on-ARM keeps the emulated image of an executed installer binary in
    # the XtaCache translation cache, so that file stays open for minutes. Such a
    # leftover is an environment artifact, unlike a file the uninstaller simply
    # failed to delete.
    param([string]$Path)
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
    }
    catch {
        return $true
    }
    $stream.Close()
    return $false
}

function Stop-SelbstlaufProcess {
    # taskkill writes to stderr when a process is absent, which would abort the
    # script under $ErrorActionPreference = 'Stop'.
    $ErrorActionPreference = 'SilentlyContinue'
    foreach ($name in @('Selbstlauf.exe', 'Un_A.exe', 'Au_.exe')) {
        & taskkill.exe /F /IM $name /T 2>$null | Out-Null
    }
    $ErrorActionPreference = 'Stop'
    # Windows-on-ARM can keep a terminated process in the "terminating" state
    # for a couple of minutes while its emulated image is still mapped.
    Wait-ForCondition -TimeoutSeconds 240 -Description 'the app process tree to exit' -Condition {
        @(Get-Process -Name 'Selbstlauf', 'Un_A', 'Au_' -ErrorAction SilentlyContinue).Count -eq 0
    }
}

function Remove-InstallRoot {
    if (-not (Test-Path -LiteralPath $installRoot)) { return }
    $removed = $false
    for ($attempt = 0; $attempt -lt 12 -and -not $removed; $attempt++) {
        try {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
            $removed = $true
        } catch {
            Start-Sleep -Seconds 5
        }
    }
    if (-not $removed) {
        # Windows-on-ARM keeps the emulated image of an executed installer in
        # the XtaCache translation cache, so a previously run uninstaller can
        # stay locked for the rest of the session. The installation itself is
        # unaffected, so this is a warning rather than a failure.
        Write-Warning "could not fully clean $installRoot; continuing with the leftovers"
    }
}

Write-Output "verifying $installerPath"

Stop-SelbstlaufProcess
Remove-InstallRoot
Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
foreach ($shortcut in $shortcuts) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }

$process = Start-Process -FilePath $installerPath -ArgumentList '/S' -PassThru -Wait
Assert-Condition ($process.ExitCode -eq 0) "installer exited with code $($process.ExitCode)"

Wait-ForCondition -TimeoutSeconds $InstallTimeoutSeconds -Description 'the installed app to appear' -Condition {
    Test-Path -LiteralPath $appExe
}

foreach ($relative in $requiredFiles) {
    $target = Join-Path $installRoot $relative
    Assert-Condition (Test-Path -LiteralPath $target) "installed app is missing $relative"
    Assert-Condition ((Get-Item -LiteralPath $target).Length -gt 0) "installed $relative is empty"
}
Assert-Condition ((Get-Item -LiteralPath $appExe).Length -gt 200MB) 'installed Selbstlauf.exe looks truncated'

$installedCount = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File).Count
Assert-Condition ($installedCount -ge 124) "installed app has only $installedCount files"

foreach ($shortcut in $shortcuts) {
    Assert-Condition (Test-Path -LiteralPath $shortcut) "missing shortcut $shortcut"
}
Assert-Condition (Test-Path -LiteralPath $uninstallKey) 'missing uninstall registry entry'

Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
$app = Start-Process -FilePath $appExe -PassThru
Wait-ForCondition -TimeoutSeconds $StartupTimeoutSeconds -Description 'the bundled watchdog service to report its port' -Condition {
    Test-Path -LiteralPath $watchdogPidFile
}
$record = Get-Content -LiteralPath $watchdogPidFile -Raw | ConvertFrom-Json
Assert-Condition ($null -ne $record.port) 'watchdog pid file has no port'
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/health" -TimeoutSec 30
Assert-Condition ($health.watchdogRunning -eq $true) 'bundled watchdog service is not running'
$index = Invoke-WebRequest -Uri "http://127.0.0.1:$($record.port)/" -TimeoutSec 30 -UseBasicParsing
Assert-Condition ($index.Content -match 'id="root"') 'bundled WebUI was not served'
Write-Output "installed app serves its WebUI on port $($record.port)"

# A running service with a reachable WebUI is not evidence that it watches
# anything: the installed provider is a separate asset and the packaged app
# hosts the watchdog inside Selbstlauf.exe, whose image name is not a supported
# CLI. Prove the whole chain by starting one process that carries a supported
# signature and requiring the installed service to report it.
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
Assert-Condition ($null -ne $nodeExe) 'node.exe is required to prove the installed app discovers a live process'
$probeDirectory = Join-Path $env:TEMP 'selbstlauf-discovery-probe'
New-Item -ItemType Directory -Force -Path $probeDirectory | Out-Null
# The probe keeps running under its own file name and carries the marker path as
# an argument, so the provider sees a supported CLI token on its command line.
# Passing an inline `-e` script would need quoting that Start-Process does not do.
$probeScript = Join-Path $probeDirectory 'probe.js'
Set-Content -LiteralPath $probeScript -Value 'setInterval(() => undefined, 1000);' -Encoding Ascii
$probeMarker = Join-Path $probeDirectory 'claude.ps1'
Set-Content -LiteralPath $probeMarker -Value '# discovery probe marker; never executed' -Encoding Ascii
$probe = Start-Process -FilePath $nodeExe -ArgumentList @($probeScript, $probeMarker) -PassThru -WindowStyle Hidden
try {
    $discovered = @()
    $listed = @()
    $deadline = [DateTime]::UtcNow.AddSeconds(180)
    while ([DateTime]::UtcNow -lt $deadline -and $discovered.Count -eq 0) {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/sessions" -TimeoutSec 60
        $listed = @($response.sessions)
        $discovered = @($listed | Where-Object { $_.rootPid -eq $probe.Id })
        if ($discovered.Count -eq 0) { Start-Sleep -Milliseconds 1000 }
    }
    Assert-Condition ($discovered.Count -gt 0) (
        "the installed app never discovered probe PID $($probe.Id); it listed " +
        "$($listed.Count) session(s): " +
        (@($listed | ForEach-Object { "$($_.tool):$($_.rootPid)" }) -join ', '))
    $session = $discovered[0]
    Assert-Condition ($session.tool -eq 'claude') "installed app classified the probe process as $($session.tool)"
    Assert-Condition ($session.alive -eq $true) 'installed app reported the probe process as not alive'
    Write-Output "installed app discovered the probe process as $($session.tool) PID $($session.rootPid)"
    # The same service must also turn a watched process into a recorded decision,
    # which is the difference between watching and merely listing.
    $decisions = @()
    $decisionDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $decisionDeadline -and $decisions.Count -eq 0) {
        $audit = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/audit?limit=200" -TimeoutSec 30
        # Global audit events carry no sessionId, and StrictMode rejects a
        # property lookup that does not exist on every element.
        $decisions = @($audit.events | Where-Object {
            $_.type -eq 'decision' -and
            ($_.PSObject.Properties.Name -contains 'sessionId') -and
            $_.sessionId -eq $session.id
        })
        if ($decisions.Count -eq 0) { Start-Sleep -Milliseconds 1000 }
    }
    Assert-Condition ($decisions.Count -gt 0) "the installed app recorded no decision for session $($session.id)"
    Write-Output "installed app recorded watchdog decisions for PID $($probe.Id)"
} finally {
    # taskkill writes to stderr for an already-exited tree, which would abort the
    # script under $ErrorActionPreference = 'Stop' and mask the real failure.
    $ErrorActionPreference = 'SilentlyContinue'
    if (-not $probe.HasExited) { & taskkill.exe /F /T /PID $probe.Id 2>$null | Out-Null }
    Remove-Item -LiteralPath $probeDirectory -Recurse -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = 'Stop'
}

# The installed app must be able to own its logon task from the install root; a
# repository-only path would register a task that never starts.
$startupHelper = Join-Path $installRoot 'resources\scripts\continuation\startup-task.ps1'
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $startupHelper /Delete /TN $startupTaskName /F 2>$null | Out-Null
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($record.port)/api/startup/install" -Headers @{ Origin = "http://127.0.0.1:$($record.port)" } -TimeoutSec 120 | Out-Null
$startup = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/startup" -TimeoutSec 60
Assert-Condition ($startup.installed -eq $true) 'the installed app did not register its logon task'
$registeredAction = (Get-ScheduledTask -TaskName $startupTaskName).Actions | Select-Object -First 1
$installedScript = (Resolve-Path -LiteralPath (Join-Path $installRoot 'resources\scripts\continuation\start-watchdog.ps1')).Path
Assert-Condition ($registeredAction.Arguments -match [regex]::Escape($installedScript)) "the logon task does not run the installed script: $($registeredAction.Arguments)"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($record.port)/api/startup/uninstall" -Headers @{ Origin = "http://127.0.0.1:$($record.port)" } -TimeoutSec 120 | Out-Null
$startupAfter = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/startup" -TimeoutSec 60
Assert-Condition ($startupAfter.installed -eq $false) 'the installed app did not remove its logon task'
Write-Output 'installed app owns and removes its per-user logon task'

Stop-SelbstlaufProcess
& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $installRoot 'resources\scripts\continuation\startup-task.ps1') /Delete /TN $startupTaskName /F 2>$null | Out-Null

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
Assert-Condition ($uninstall.ExitCode -eq 0) "uninstaller exited with code $($uninstall.ExitCode)"
foreach ($shortcut in $shortcuts) {
    Wait-ForCondition -TimeoutSeconds 180 -Description "the uninstaller to remove $shortcut" -Condition {
        -not (Test-Path -LiteralPath $shortcut)
    }
}
Assert-Condition (-not (Test-Path -LiteralPath $uninstallKey)) 'uninstall left its registry entry behind'

# Only the emulated uninstaller image may remain, and only while this host keeps
# it open; every other installed file must be gone.
Wait-ForCondition -TimeoutSeconds 300 -Description 'the uninstaller to remove the installed app' -Condition {
    if (-not (Test-Path -LiteralPath $installRoot)) { return $true }
    $leftovers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { -not (Test-FileLocked -Path $_.FullName) })
    return $leftovers.Count -eq 0
}
$lockedLeftovers = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -ErrorAction SilentlyContinue)
if ($lockedLeftovers.Count -gt 0) {
    Write-Warning "uninstall left $($lockedLeftovers.Count) locked file(s) behind: $(($lockedLeftovers.Name) -join ', ')"
}

Write-Output "installer verification passed: $installerPath"
