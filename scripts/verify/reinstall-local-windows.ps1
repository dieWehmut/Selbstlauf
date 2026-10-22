param(
  [string]$PackageRoot = "$env:LOCALAPPDATA\Temp\selbstlauf-settings-package-20261022",
  [string]$Evidence = "$env:LOCALAPPDATA\Temp\selbstlauf-settings-reinstall-20261022",
  [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$installRoot = "$env:LOCALAPPDATA\Programs\Selbstlauf"
$stateRoot = "$env:LOCALAPPDATA\ai-cli-bypass\continuation"
$installer = "$PackageRoot\Selbstlauf-Setup-0.9.5-x64.exe"
$config = "$stateRoot\config.json"
$exe = "$installRoot\Selbstlauf.exe"
if (-not (Test-Path $installer)) { throw 'Verified local installer is missing' }
if ((Get-Item $exe).VersionInfo.FileVersion -ne '0.9.5') { throw 'Refusing to change an unexpected installed version' }
if (Test-Path $Evidence) {
  if (-not $Resume -or (Test-Path "$Evidence\reinstall-result.json")) { throw 'Inspect the previous reinstall before retrying' }
} else {
  New-Item -ItemType Directory -Path $Evidence | Out-Null
  Copy-Item -LiteralPath $stateRoot -Destination "$Evidence\state-before" -Recurse
  Copy-Item -LiteralPath $installRoot -Destination "$Evidence\installation-before" -Recurse
}
$beforeConfig = (Get-FileHash "$Evidence\state-before\config.json" -Algorithm SHA256).Hash
if ((Get-FileHash $config -Algorithm SHA256).Hash -ne $beforeConfig) { throw 'Config differs from backup; inspect before reinstall' }
$desktopPath = "$stateRoot\desktop-settings.json"
$beforeDesktop = if (Test-Path $desktopPath) { (Get-FileHash $desktopPath -Algorithm SHA256).Hash } else { $null }

# Request a normal close; if close-to-tray keeps it alive, stop only this app's
# process tree before replacing its files. Agent tools are never upgraded.
$running = @(Get-Process Selbstlauf -ErrorAction SilentlyContinue)
foreach ($p in $running) { if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() } }
Start-Sleep -Seconds 2
foreach ($p in @(Get-Process Selbstlauf -ErrorAction SilentlyContinue)) {
  if ($p.Path -eq $exe) {
    # Earlier iterations can already have stopped a child in the same tree.
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
    $ErrorActionPreference = 'Stop'
  }
}
$process = Start-Process -FilePath $installer -ArgumentList '/S','/currentuser' -PassThru
if (-not $process.WaitForExit(240000)) { throw 'Installer is still running; inspect it before continuing' }
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
if ((Get-Item $exe).VersionInfo.FileVersion -ne '0.9.5') { throw 'Installed version changed unexpectedly' }
if ((Get-FileHash $config -Algorithm SHA256).Hash -ne $beforeConfig) { throw 'User config changed during reinstall' }
if ($beforeDesktop -and (Get-FileHash $desktopPath -Algorithm SHA256).Hash -ne $beforeDesktop) { throw 'Desktop settings changed during reinstall' }

$resources = @('app.asar','preload.cjs','web-dist\index.html','service-dist\src\index.js','build\icon.ico')
foreach ($relative in $resources) {
  $source = "$PackageRoot\win-unpacked\resources\$relative"
  $target = "$installRoot\resources\$relative"
  if ((Get-FileHash $source -Algorithm SHA256).Hash -ne (Get-FileHash $target -Algorithm SHA256).Hash) { throw "Installed resource mismatch: $relative" }
}
Start-Process -FilePath $exe
$deadline = [DateTime]::UtcNow.AddSeconds(90)
$health = $null
do {
  try {
    $pidRecord = Get-Content "$stateRoot\watchdog.pid.json" -Raw | ConvertFrom-Json
    $origin = "http://127.0.0.1:$($pidRecord.port)"
    $health = Invoke-RestMethod "$origin/api/health" -TimeoutSec 3
  } catch { $health = $null }
  if (-not $health) { Start-Sleep -Milliseconds 500 }
} while (-not $health -and [DateTime]::UtcNow -lt $deadline)
if (-not $health.ok) { throw 'Installed app service failed to start' }
$result = [ordered]@{
  version = (Get-Item $exe).VersionInfo.FileVersion
  installer = $installer
  installerSha256 = (Get-FileHash $installer -Algorithm SHA256).Hash
  configSha256Before = $beforeConfig
  configSha256After = (Get-FileHash $config -Algorithm SHA256).Hash
  asarSha256 = (Get-FileHash "$installRoot\resources\app.asar" -Algorithm SHA256).Hash
  origin = $origin
  health = $health
  backupDirectory = $Evidence
}
$result | ConvertTo-Json -Depth 8 | Set-Content "$Evidence\reinstall-result.json" -Encoding UTF8
$result | ConvertTo-Json -Depth 8
