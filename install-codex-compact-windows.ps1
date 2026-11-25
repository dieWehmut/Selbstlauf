[CmdletBinding()]
param(
    [switch]$Revert,
    [switch]$DryRun,
    [double]$LimitRatio = 0.9,
    [switch]$NoAutoLimit,
    [switch]$SkipPlugin,
    [string]$Config,
    [switch]$SkipValidation
)

# The automatic LASTEXITCODE is deliberately not reset here: assigning it at
# script scope creates a shadow copy, so a child script's exit code would be
# invisible to the check at the end of this file.
$ErrorActionPreference = 'Stop'

# One-click entry point: run the local implementation when this file sits inside
# a checkout, otherwise download it and run it from a temporary path. The
# implementation is a thin wrapper around codex_compact_config.py, which is
# shared with the Linux installer.
$options = @{
    Revert = [bool]$Revert
    DryRun = [bool]$DryRun
    LimitRatio = $LimitRatio
    NoAutoLimit = [bool]$NoAutoLimit
    SkipPlugin = [bool]$SkipPlugin
    SkipValidation = [bool]$SkipValidation
}
if (-not [string]::IsNullOrWhiteSpace($Config)) { $options['Config'] = $Config }

$implementation = $null
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidate = Join-Path $PSScriptRoot 'scripts\install\windows\install-codex-compact-windows.ps1'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $implementation = $candidate }
}

if ($null -ne $implementation) {
    & $implementation @options
}
else {
    $entryUrl = 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/install/windows/install-codex-compact-windows.ps1'
    $entryText = [string](Invoke-RestMethod -Uri $entryUrl -UseBasicParsing)
    if ([string]::IsNullOrWhiteSpace($entryText)) { throw "Downloaded Selbstlauf entry point from '$entryUrl' was empty." }
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('selbstlauf-compact-' + [guid]::NewGuid().ToString('N') + '.ps1')
    [System.IO.File]::WriteAllText($temporary, $entryText, (New-Object System.Text.UTF8Encoding($false)))
    try {
        & $temporary @options
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

# $LASTEXITCODE is global; reading it through the global scope avoids the
# shadow copy a script level assignment would create.
$exit = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
if ($null -ne $exit -and [int]$exit.Value -ne 0) { exit [int]$exit.Value }