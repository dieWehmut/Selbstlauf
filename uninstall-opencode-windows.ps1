[CmdletBinding()]
param([switch]$KeepCli)

$ErrorActionPreference = 'Stop'
$implementation = $null
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidate = Join-Path $PSScriptRoot 'scripts\uninstall\windows\uninstall-opencode-windows.ps1'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $implementation = $candidate }
}
if ($null -ne $implementation) {
    & $implementation -KeepCli:$KeepCli
}
else {
    $coreUrl = 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/windows/AiCliBypass.ps1'
    $coreText = [string](Invoke-RestMethod -Uri $coreUrl -UseBasicParsing)
    if ([string]::IsNullOrWhiteSpace($coreText)) { throw "Downloaded Selbstlauf core from '$coreUrl' was empty." }
    . ([scriptblock]::Create($coreText))
    Uninstall-AiCliBypass -Tool 'opencode' -KeepCli:$KeepCli
}
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
