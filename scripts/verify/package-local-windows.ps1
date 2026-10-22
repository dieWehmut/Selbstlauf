param(
  [string]$Repository = "$env:LOCALAPPDATA\Temp\selbstlauf-verify\repo-win",
  [string]$Output = "$env:LOCALAPPDATA\Temp\selbstlauf-settings-package-20261022"
)
$ErrorActionPreference = 'Stop'
$package = Get-Content -LiteralPath "$Repository\apps\desktop\package.json" -Raw | ConvertFrom-Json
if ($package.version -ne '0.9.5') { throw "Expected local version 0.9.5, got $($package.version)" }
$electron = Get-Content -LiteralPath "$Repository\node_modules\electron\package.json" -Raw | ConvertFrom-Json
if ($electron.version -ne '44.4.1') { throw "Expected locked Electron 44.4.1" }
$env:SELBSTLAUF_DESKTOP_OUTPUT = $Output
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
# The native packages already belong to this independent Windows checkout.
# Do not invoke npm install, an updater, or a release publication.
Set-Location -LiteralPath "$Repository\apps\desktop"
# node-pty 1.1.0 ships N-API prebuilds, already exercised by native Electron.
# Rebuilding them would require unrelated Visual Studio component changes.
if (-not (Test-Path "$Repository\node_modules\node-pty\prebuilds\win32-x64\conpty.node")) { throw 'Missing verified node-pty x64 prebuild' }
& "$env:USERPROFILE\software\node\node.exe" "$Repository\node_modules\electron-builder\out\cli\cli.js" --win nsis:x64 --publish never --config electron-builder.config.mjs '--config.npmRebuild=false'
if ($LASTEXITCODE -ne 0) { throw "Local package build failed: $LASTEXITCODE" }
Get-ChildItem -LiteralPath $Output -Filter '*.exe' | Select-Object Name,Length | ConvertTo-Json
