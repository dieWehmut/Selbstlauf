param([switch]$KeepCli)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$localCore = $null
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidateCore = Join-Path $PSScriptRoot 'scripts\windows\AiCliBypass.ps1'
    if (Test-Path -LiteralPath $candidateCore -PathType Leaf) {
        $localCore = $candidateCore
    }
}

if ($null -ne $localCore) {
    . $localCore
}
else {
    $coreUrl = 'https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/scripts/windows/AiCliBypass.ps1'
    $coreText = [string](Invoke-RestMethod -Uri $coreUrl -UseBasicParsing)
    if ([string]::IsNullOrWhiteSpace($coreText)) {
        throw "Downloaded ai-cli-bypass core from '$coreUrl' was empty."
    }
    $coreScript = [scriptblock]::Create($coreText)
    . $coreScript
}

if ($null -eq (Get-Command Uninstall-AiCliBypass -CommandType Function -ErrorAction SilentlyContinue)) {
    throw 'The ai-cli-bypass core did not define Uninstall-AiCliBypass.'
}

Uninstall-AiCliBypass -Tool 'opencode' -KeepCli:$KeepCli
