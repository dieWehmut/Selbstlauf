Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$localCore = $null
if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $candidateCore = Join-Path $PSScriptRoot '..\..\windows\AiCliBypass.ps1'
    if (Test-Path -LiteralPath $candidateCore -PathType Leaf) {
        $localCore = $candidateCore
    }
}

if ($null -ne $localCore) {
    . $localCore
}
else {
    $coreUrl = 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/windows/AiCliBypass.ps1'
    $coreText = [string](Invoke-RestMethod -Uri $coreUrl -UseBasicParsing)
    if ([string]::IsNullOrWhiteSpace($coreText)) {
        throw "Downloaded ai-cli-bypass core from '$coreUrl' was empty."
    }
    $coreScript = [scriptblock]::Create($coreText)
    . $coreScript
}

if ($null -eq (Get-Command Install-AiCliBypass -CommandType Function -ErrorAction SilentlyContinue)) {
    throw 'The ai-cli-bypass core did not define Install-AiCliBypass.'
}

Install-AiCliBypass -Tool 'opencode'
