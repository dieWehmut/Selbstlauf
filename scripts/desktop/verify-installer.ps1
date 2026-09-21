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
    [int]$StartupTimeoutSeconds = 90,
    # The window lifecycle check needs a real interactive desktop. It is skipped
    # automatically when there is none; pass this to skip it on a machine that has
    # one (for example a headless agent host driving an emulated session).
    [switch]$SkipWindowLifecycle,
    # An older installer to install first, so this installer is exercised as an
    # in-place upgrade rather than only as a fresh install. That is the path a user
    # takes when they install a newer version over an existing one, and it is where a
    # duplicated uninstall entry or a half-replaced payload would appear.
    [string]$UpgradeFrom
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
    'resources\preload.cjs',
    'resources\web-dist\index.html',
    'resources\service-dist\src\index.js',
    # The service resolves its process provider beside its own module. tsc never
    # emits the PowerShell asset, so this entry is the regression gate for an
    # installer that served a WebUI while discovering no process at all.
    'resources\service-dist\src\process\windows-processes.ps1',
    # The reveal action resolves its own PowerShell asset the same way, so the
    # installed app needs it to be able to show a session's window.
    'resources\service-dist\src\process\window-focus.ps1',
    # Previewing a minimized window shows it briefly with this helper, because a
    # minimized window is absent from the capture layer entirely. Without the file
    # that preview silently degrades to "cannot capture", which is exactly the
    # state this asset exists to remove.
    'resources\service-dist\src\process\window-restore.ps1',
    # Typing into a session's window uses this, so the installed app needs it or that action silently fails.
    'resources\service-dist\src\process\window-input.ps1',
    # The packaged app must ship the logon-task script tree; start-watchdog.ps1
    # resolves service-dist and web-dist beside it at runtime.
    'resources\scripts\continuation\start-watchdog.ps1',
    'resources\scripts\continuation\startup-task.ps1',
    'resources\scripts\continuation\launch-watchdog.mjs',
    # The window and the tray both load the icon from an absolute path. Without
    # this file the packaged app cannot construct a tray, and because
    # `handleWindowClose` only hides when a tray exists (so the app can never
    # become an invisible process), a missing icon degrades into "closing the
    # window quits and stops the service". electron-builder's `win.icon` only
    # brands the executable and does not place the file in resources, so this
    # entry is the regression gate for that whole chain.
    'resources\build\icon.ico'
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

# An in-place upgrade: install the older build first, then the one under test over
# it, without uninstalling. This is the path a user takes when they install a newer
# version, and it is where a duplicated uninstall entry, a phantom Apps & features
# row, or a half-replaced payload would show up. Without -UpgradeFrom only the fresh
# install is exercised, which is a different code path inside NSIS.
if ($UpgradeFrom) {
    $upgradeFromPath = (Resolve-Path -LiteralPath $UpgradeFrom).Path
    Write-Host "upgrade check: installing $upgradeFromPath first"

    $previous = Start-Process -FilePath $upgradeFromPath -ArgumentList '/S', '/currentuser' -PassThru
    Assert-Condition ($previous.WaitForExit($InstallTimeoutSeconds * 1000)) 'the previous installer did not finish in time'
    Assert-Condition ($previous.ExitCode -eq 0) "the previous installer exited with code $($previous.ExitCode)"

    Wait-ForCondition -TimeoutSeconds $StartupTimeoutSeconds -Description 'the previous build to install' -Condition {
        Test-Path -LiteralPath $appExe
    }
    # Read from the installer's own artifact name, which is where the version the
    # build declares is visible, rather than trusting the file name of the download.
    $upgradeVersion = [regex]::Match((Split-Path -Leaf $upgradeFromPath), '(\d+\.\d+\.\d+)').Groups[1].Value
    $expectedVersion = [regex]::Match((Split-Path -Leaf $installerPath), '(\d+\.\d+\.\d+)').Groups[1].Value
    if (-not $upgradeVersion -or -not $expectedVersion) {
        throw 'could not read a version from the installer file names; upgrade checks need them'
    }
    Write-Host "  previous build installed: version $upgradeVersion (expected $expectedVersion after the upgrade)"

    # A file planted in the app directory: a correct upgrade replaces the directory
    # rather than merging into it, so this must be gone afterwards. It distinguishes
    # "the new payload was laid down" from "the old files were left in place".
    $upgradeProbe = Join-Path $installRoot 'upgrade-probe.txt'
    Set-Content -LiteralPath $upgradeProbe -Value 'planted before the upgrade' -Encoding utf8
}

# `/currentuser` is required, not optional: this product is per-user
# (`perMachine: false`), and an assisted NSIS installer invoked with a bare `/S`
# defaults to an all-users path, so it asks for elevation. In an interactive
# session that leaves a UAC prompt nobody answers and the verification hangs
# forever instead of failing.
$process = Start-Process -FilePath $installerPath -ArgumentList '/S', '/currentuser' -PassThru
Assert-Condition ($process.WaitForExit($InstallTimeoutSeconds * 1000)) "installer did not finish within $InstallTimeoutSeconds seconds"
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

if ($UpgradeFrom) {
    # The findings that only an upgrade can produce.
    Assert-Condition (-not (Test-Path -LiteralPath $upgradeProbe)) 'the app directory was merged into rather than replaced (the plant file survived)'

    $entries = @(
        Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like '*Selbstlauf*' }
    )
    # A second entry would put a phantom row in Apps & features pointing at nothing.
    Assert-Condition ($entries.Count -eq 1) "the upgrade left $($entries.Count) uninstall entries instead of one"
    $installedVersion = (Get-Item -LiteralPath $appExe).VersionInfo.FileVersion
    Assert-Condition ($entries[0].DisplayVersion -eq $installedVersion) "the uninstall entry says $($entries[0].DisplayVersion) but the app is $installedVersion"
    Assert-Condition ($installedVersion -eq $expectedVersion) "the upgrade left version $installedVersion instead of $expectedVersion"
    Write-Host "  upgrade check passed: $upgradeVersion -> $installedVersion, one uninstall entry, payload replaced"
}

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

# Closing the window must hide it to the tray, not quit the app or stop the
# service. A stub-level unit test cannot catch this: the previous release passed
# every unit test and every check above while `WM_CLOSE` on the real window quit
# the application and stopped the watchdog, because the packaged build was
# missing the icon and therefore never created a tray. Drive the real window.
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SelbstlaufWindowProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(Probe cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool Probe(IntPtr h, IntPtr p);
  public class Entry { public IntPtr Handle; public string Class; public string Title; public bool Visible; }
  public static List<Entry> ForProcess(int target) {
    var found = new List<Entry>();
    EnumWindows((h, p) => {
      int owner; GetWindowThreadProcessId(h, out owner);
      if (owner == target) {
        var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
        var title = new StringBuilder(256); GetWindowText(h, title, title.Capacity);
        found.Add(new Entry { Handle = h, Class = cls.ToString(), Title = title.ToString(), Visible = IsWindowVisible(h) });
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

$WM_CLOSE = 0x0010
$SW_SHOW = 5
$windowClient = { param($Method, $Url, $Body)
    if ($Body) { Invoke-RestMethod -Method $Method -Uri $Url -Body $Body -ContentType 'application/json' -TimeoutSec 30 }
    else { Invoke-RestMethod -Method $Method -Uri $Url -TimeoutSec 30 }
}

# Driving the window needs a real interactive desktop: a runner where the app has
# no window at all cannot distinguish "the tray is broken" from "there is no
# desktop here". The icon check above is unconditional and is what actually
# guards the packaging, so this section is skipped loudly rather than turning a
# headless environment into a false failure.
$hasDesktop = [Environment]::UserInteractive -and $null -ne (Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Select-Object -First 1)
$runLifecycleCheck = -not $SkipWindowLifecycle -and $hasDesktop

if (-not $runLifecycleCheck) {
    $why = if ($SkipWindowLifecycle) { '-SkipWindowLifecycle was passed' } else { 'no interactive desktop (no explorer.exe / non-interactive session)' }
    Write-Warning "skipping the window lifecycle check: $why"
    Write-Output 'SKIPPED: window lifecycle check (icon asset check still enforced)'
} else {

# The app's own window is the visible, titled top-level window of its process.
# It is created with `show: false` and revealed on `ready-to-show`, so a freshly
# started app is briefly window-less; wait for the reveal instead of racing it.
$appWindow = $null
$windowDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
while ([DateTime]::UtcNow -lt $windowDeadline -and $null -eq $appWindow) {
    $appWindows = @()
    foreach ($process in @(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue)) {
        $appWindows += [SelbstlaufWindowProbe]::ForProcess($process.Id)
    }
    $appWindow = $appWindows | Where-Object { $_.Visible -and $_.Title.Length -gt 0 } | Select-Object -First 1
    if ($null -eq $appWindow) { Start-Sleep -Milliseconds 500 }
}
Assert-Condition ($null -ne $appWindow) "the installed app exposed no visible window within $StartupTimeoutSeconds seconds"

# Electron only creates this hidden host window when a Tray really exists; it is
# the mechanical proof that the tray was built (UI Automation cannot see the
# Windows 11 notification area's icons).
$trayHosts = @($appWindows | Where-Object { $_.Class -eq 'Electron_NotifyIconHostWindow' })
Assert-Condition ($trayHosts.Count -gt 0) 'the installed app created no tray (no Electron_NotifyIconHostWindow)'
Write-Output "installed app owns a tray (window '$($appWindow.Title)')"

$healthBefore = & $windowClient 'Get' "http://127.0.0.1:$($record.port)/api/health" $null
Assert-Condition ($healthBefore.watchdogRunning -eq $true) 'watchdog was not running before the close test'

# Exactly what the title bar's X and Alt+F4 send.
[void][SelbstlaufWindowProbe]::SendMessage($appWindow.Handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Seconds 3

$stillExists = [SelbstlaufWindowProbe]::IsWindow($appWindow.Handle)
$stillVisible = [SelbstlaufWindowProbe]::IsWindowVisible($appWindow.Handle)
$aliveAfter = @(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue).Count
$healthAfter = $null
try { $healthAfter = & $windowClient 'Get' "http://127.0.0.1:$($record.port)/api/health" $null } catch { }
$appWindowsAfter = @()
foreach ($process in @(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue)) {
    $appWindowsAfter += [SelbstlaufWindowProbe]::ForProcess($process.Id)
}
$trayHostsAfter = @($appWindowsAfter | Where-Object { $_.Class -eq 'Electron_NotifyIconHostWindow' })

Assert-Condition ($stillExists) 'closing the window destroyed it instead of hiding it'
Assert-Condition (-not $stillVisible) 'closing the window left it visible'
Assert-Condition ($aliveAfter -gt 0) 'closing the window quit the application'
Assert-Condition ($trayHostsAfter.Count -gt 0) 'closing the window destroyed the tray'
Assert-Condition ($null -ne $healthAfter) 'the bundled service stopped when the window was closed'
Assert-Condition ($healthAfter.watchdogRunning -eq $true) 'the bundled watchdog stopped when the window was closed'
Assert-Condition ($healthAfter.startedAtMs -eq $healthBefore.startedAtMs) 'closing the window restarted the bundled service'
Write-Output 'closing the installed window hides it to the tray and keeps the watchdog running'

# Put the window back, the way a tray left-click does, so the checks below (and
# the uninstall step) run against a normal, visible app.
[void][SelbstlaufWindowProbe]::ShowWindow($appWindow.Handle, $SW_SHOW)
Start-Sleep -Seconds 2
Assert-Condition ([SelbstlaufWindowProbe]::IsWindowVisible($appWindow.Handle)) 'the hidden window could not be shown again'
Write-Output 'the hidden window can be restored'

# The other branch of the same switch: `closeToTray: false` must really quit.
#
# The default (above) hides the window and keeps the service; this half is what
# 关闭时最小化到托盘 turns off, and it was unreachable until the settings bridge
# loaded at all. The store is exercised through the app's own file rather than by
# driving the renderer, so the check stays inside PowerShell.
$desktopSettingsPath = Join-Path $stateRoot 'desktop-settings.json'
Set-Content -LiteralPath $desktopSettingsPath -Value '{"closeToTray":false,"preferredTerminal":null}' -Encoding Ascii
Assert-Condition (Test-Path -LiteralPath $desktopSettingsPath) 'could not write the desktop settings file'

# Restart so the setting is read at startup, the way a person's change applies.
Stop-SelbstlaufProcess
Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
$restarted = Start-Process -FilePath $appExe -PassThru
Wait-ForCondition -TimeoutSeconds $StartupTimeoutSeconds -Description 'the service to come back after the settings change' -Condition {
    Test-Path -LiteralPath $watchdogPidFile
}
$recordAfterRestart = Get-Content -LiteralPath $watchdogPidFile -Raw | ConvertFrom-Json
$quitWindow = $null
$quitDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
while ([DateTime]::UtcNow -lt $quitDeadline -and $null -eq $quitWindow) {
    foreach ($process in @(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue)) {
        $quitWindow = [SelbstlaufWindowProbe]::ForProcess($process.Id) |
            Where-Object { $_.Visible -and $_.Title.Length -gt 0 } | Select-Object -First 1
        if ($null -ne $quitWindow) { break }
    }
    if ($null -eq $quitWindow) { Start-Sleep -Milliseconds 500 }
}
Assert-Condition ($null -ne $quitWindow) 'no visible window after restarting with closeToTray=false'

[void][SelbstlaufWindowProbe]::SendMessage($quitWindow.Handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
# Wait for the app to actually exit rather than sleeping a fixed six seconds.
#
# The fixed sleep is what made this fail intermittently on CI: the app takes longer to shut down there than
# on a workstation, so the count was read while the process was still going and the check reported
# "closeToTray=false did not quit the application" for a shutdown that was merely still in progress. Waiting
# for the condition is both more reliable and a stronger assertion, since it fails only when the process
# genuinely does not go away.
$quitDeadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $quitDeadline) {
    if (@(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}
$quitAlive = @(Get-Process -Name 'Selbstlauf' -ErrorAction SilentlyContinue).Count
$quitServiceUp = $false
try {
    $healthAfterQuit = Invoke-RestMethod -Uri "http://127.0.0.1:$($recordAfterRestart.port)/api/health" -TimeoutSec 8
    $quitServiceUp = $healthAfterQuit.watchdogRunning -eq $true
} catch { }
Assert-Condition ($quitAlive -eq 0) 'closeToTray=false did not quit the application'
Assert-Condition (-not $quitServiceUp) 'closeToTray=false left the bundled service running'
Write-Output 'with closeToTray=false, closing the window quits and stops the watchdog'

# Restore the default so the uninstall step below starts from a clean state, and
# bring the app back up: the quit above deliberately left nothing running, and the
# discovery and startup-task checks that follow need a live app.
Remove-Item -LiteralPath $desktopSettingsPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
[void](Start-Process -FilePath $appExe -PassThru)
Wait-ForCondition -TimeoutSeconds $StartupTimeoutSeconds -Description 'the service to come back after restoring the default setting' -Condition {
    Test-Path -LiteralPath $watchdogPidFile
}
$record = Get-Content -LiteralPath $watchdogPidFile -Raw | ConvertFrom-Json
Assert-Condition ($null -ne $record.port) 'watchdog pid file has no port after the restart'
$healthRestored = Invoke-RestMethod -Uri "http://127.0.0.1:$($record.port)/api/health" -TimeoutSec 30
Assert-Condition ($healthRestored.watchdogRunning -eq $true) 'the service did not come back after restoring the default'
Write-Output 'restored the default and brought the app back up'

}

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

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S', '/currentuser' -PassThru
Assert-Condition ($uninstall.WaitForExit($InstallTimeoutSeconds * 1000)) "uninstaller did not finish within $InstallTimeoutSeconds seconds"
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
