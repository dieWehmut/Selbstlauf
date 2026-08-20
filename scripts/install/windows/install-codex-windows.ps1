Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-CodexInstallerConfigPath {
    try {
        $codexHomePath = $env:CODEX_HOME
        if ([string]::IsNullOrWhiteSpace($codexHomePath)) {
            if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
                return $null
            }
            $codexHomePath = Join-Path $env:USERPROFILE '.codex'
        }
        if (-not [System.IO.Path]::IsPathRooted($codexHomePath)) {
            return $null
        }
        return Join-Path ([System.IO.Path]::GetFullPath($codexHomePath)) 'config.toml'
    }
    catch {
        return $null
    }
}

function Get-CodexInstallerTomlCodePortion {
    param([AllowEmptyString()][AllowNull()][string]$Line)

    if ($null -eq $Line) {
        return ''
    }
    $mode = 0
    $escaped = $false
    for ($index = 0; $index -lt $Line.Length;) {
        if ($mode -eq 0) {
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq '"""') {
                $mode = 3
                $index += 3
                continue
            }
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq "'''") {
                $mode = 4
                $index += 3
                continue
            }
            $character = $Line[$index]
            if ($character -eq [char]34) {
                $mode = 1
                $index++
                continue
            }
            if ($character -eq [char]39) {
                $mode = 2
                $index++
                continue
            }
            if ($character -eq [char]35) {
                return $Line.Substring(0, $index)
            }
            $index++
            continue
        }
        if ($mode -eq 1) {
            $character = $Line[$index]
            if ($escaped) {
                $escaped = $false
                $index++
                continue
            }
            if ($character -eq [char]92) {
                $escaped = $true
                $index++
                continue
            }
            if ($character -eq [char]34) {
                $mode = 0
            }
            $index++
            continue
        }
        if ($mode -eq 2) {
            if ($Line[$index] -eq [char]39) {
                $mode = 0
            }
            $index++
            continue
        }
        $delimiter = if ($mode -eq 3) { '"""' } else { "'''" }
        if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq $delimiter -and
            ($mode -eq 4 -or -not $escaped)) {
            $mode = 0
            $escaped = $false
            $index += 3
        }
        else {
            if ($mode -eq 3 -and $Line[$index] -eq [char]92) {
                $escaped = -not $escaped
            }
            else {
                $escaped = $false
            }
            $index++
        }
    }
    return $Line
}

function Convert-CodexInstallerTomlBasicKey {
    param([Parameter(Mandatory = $true)][string]$Value)

    $builder = New-Object System.Text.StringBuilder
    for ($index = 0; $index -lt $Value.Length; $index++) {
        $character = $Value[$index]
        if ($character -ne [char]92) {
            [void]$builder.Append($character)
            continue
        }
        $index++
        if ($index -ge $Value.Length) {
            throw 'Codex config contains an unterminated escape in a quoted key.'
        }
        $escape = $Value[$index]
        $digitCount = 0
        $simpleValue = $null
        switch -CaseSensitive ($escape) {
            'b' { $simpleValue = [char]8 }
            't' { $simpleValue = [char]9 }
            'n' { $simpleValue = [char]10 }
            'f' { $simpleValue = [char]12 }
            'r' { $simpleValue = [char]13 }
            'e' { $simpleValue = [char]27 }
            '"' { $simpleValue = [char]34 }
            '\' { $simpleValue = [char]92 }
            'u' { $digitCount = 4 }
            'U' { $digitCount = 8 }
            default { throw "Codex config contains an unsupported escape '\$escape' in a quoted key." }
        }
        if ($digitCount -eq 0) {
            [void]$builder.Append($simpleValue)
            continue
        }

        if ($index + $digitCount -ge $Value.Length) {
            throw 'Codex config contains an incomplete Unicode escape in a quoted key.'
        }
        $hex = $Value.Substring($index + 1, $digitCount)
        if ($hex -notmatch ('^[0-9A-Fa-f]{' + $digitCount + '}$')) {
            throw 'Codex config contains an invalid Unicode escape in a quoted key.'
        }
        $codePoint = [Convert]::ToUInt32($hex, 16)
        if ($codePoint -gt 0x10FFFF -or ($codePoint -ge 0xD800 -and $codePoint -le 0xDFFF)) {
            throw 'Codex config contains an invalid Unicode code point in a quoted key.'
        }
        [void]$builder.Append([char]::ConvertFromUtf32([int]$codePoint))
        $index += $digitCount
    }
    return $builder.ToString()
}

function Get-CodexInstallerTomlKeyName {
    param(
        [AllowNull()][string]$BareName,
        [AllowNull()][string]$DoubleName,
        [AllowNull()][string]$SingleName
    )

    if (-not [string]::IsNullOrEmpty($BareName)) {
        return $BareName
    }
    if (-not [string]::IsNullOrEmpty($SingleName)) {
        return $SingleName
    }
    if (-not [string]::IsNullOrEmpty($DoubleName)) {
        return Convert-CodexInstallerTomlBasicKey -Value $DoubleName
    }
    return $null
}

function Get-CodexInstallerTomlTripleDelimiter {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)

    $mode = 0
    $escaped = $false
    for ($index = 0; $index -lt $Line.Length;) {
        if ($mode -eq 0) {
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq '"""') {
                $mode = 3
                $index += 3
                continue
            }
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq "'''") {
                $mode = 4
                $index += 3
                continue
            }
            $character = $Line[$index]
            if ($character -eq [char]35) {
                break
            }
            if ($character -eq [char]34) {
                $mode = 1
            }
            elseif ($character -eq [char]39) {
                $mode = 2
            }
            $index++
            continue
        }
        if ($mode -eq 3) {
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq '"""' -and -not $escaped) {
                $mode = 0
                $escaped = $false
                $index += 3
                continue
            }
            if ($Line[$index] -eq [char]92) {
                $escaped = -not $escaped
            }
            else {
                $escaped = $false
            }
            $index++
            continue
        }
        if ($mode -eq 4) {
            if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq "'''") {
                $mode = 0
                $index += 3
                continue
            }
            $index++
            continue
        }
        if ($mode -eq 1) {
            $character = $Line[$index]
            if ($escaped) {
                $escaped = $false
                $index++
                continue
            }
            if ($character -eq [char]92) {
                $escaped = $true
                $index++
                continue
            }
            if ($character -eq [char]34) {
                $mode = 0
            }
            $index++
            continue
        }
        if ($Line[$index] -eq [char]39) {
            $mode = 0
        }
        $index++
    }
    if ($mode -eq 3) {
        return '"""'
    }
    if ($mode -eq 4) {
        return "'''"
    }
    return $null
}

function Get-CodexInstallerTomlMultilineDelimiterCount {
    param(
        [AllowEmptyString()][AllowNull()][string]$Line,
        [Parameter(Mandatory = $true)][string]$Delimiter
    )

    if ($null -eq $Line -or $Delimiter.Length -ne 3) {
        return 0
    }
    $count = 0
    $index = 0
    $backslashRun = 0
    while ($index -lt $Line.Length) {
        if ($Line[$index] -eq [char]92) {
            $backslashRun++
            $index++
            continue
        }
        if ($index + 2 -lt $Line.Length -and $Line.Substring($index, 3) -eq $Delimiter) {
            if ($Delimiter -eq "'''" -or ($backslashRun % 2) -eq 0) {
                $count++
            }
            $index += 3
            $backslashRun = 0
            continue
        }
        $backslashRun = 0
        $index++
    }
    return $count
}

function Test-CodexInstallerFullAccessConfig {
    $configPath = Get-CodexInstallerConfigPath
    if ([string]::IsNullOrWhiteSpace($configPath) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return $false
    }

    try {
        $text = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
            $text = $text.Substring(1)
        }
        $values = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
        $multilineDelimiter = $null
        foreach ($line in @([regex]::Split($text, "`r`n|`n|`r"))) {
            if ($null -ne $multilineDelimiter) {
                $delimiterCount = Get-CodexInstallerTomlMultilineDelimiterCount -Line $line -Delimiter $multilineDelimiter
                if ($delimiterCount -gt 0) {
                    $multilineDelimiter = $null
                }
                continue
            }
            $newDelimiter = Get-CodexInstallerTomlTripleDelimiter -Line $line
            if ($null -ne $newDelimiter) {
                $multilineDelimiter = $newDelimiter
                continue
            }
            $codeLine = Get-CodexInstallerTomlCodePortion -Line $line
            if ($codeLine -match '^\s*\[') {
                break
            }
            if ($codeLine -notmatch '^\s*(?:(?<bareName>[A-Za-z0-9_-]+)|"(?<doubleName>(?:\\.|[^"\\])*)"|''(?<singleName>[^'']*)'')\s*=\s*(?<rhs>.*)$') {
                continue
            }
            $bareName = if ($Matches.ContainsKey('bareName')) { [string]$Matches['bareName'] } else { $null }
            $doubleName = if ($Matches.ContainsKey('doubleName')) { [string]$Matches['doubleName'] } else { $null }
            $singleName = if ($Matches.ContainsKey('singleName')) { [string]$Matches['singleName'] } else { $null }
            $name = Get-CodexInstallerTomlKeyName -BareName $bareName -DoubleName $doubleName -SingleName $singleName
            $knownName = $false
            foreach ($candidate in @('approval_policy', 'sandbox_mode', 'default_permissions')) {
                if ([string]::Equals($candidate, [string]$name, [StringComparison]::Ordinal)) {
                    $knownName = $true
                    break
                }
            }
            if (-not $knownName) {
                continue
            }
            if ($values.ContainsKey($name)) {
                return $false
            }
            $rhs = ([string]$Matches['rhs']).Trim()
            if ($rhs -notmatch '^"(?<value>(?:\\.|[^"\\])*)"\s*(?:#.*)?$') {
                return $false
            }
            $values[$name] = [string]$Matches['value']
        }
        if ($null -ne $multilineDelimiter) {
            return $false
        }

        if (-not $values.ContainsKey('approval_policy') -or $values['approval_policy'] -ne 'never') {
            return $false
        }
        $hasSandbox = $values.ContainsKey('sandbox_mode')
        $hasDefaultPermissions = $values.ContainsKey('default_permissions')
        if ($hasSandbox -and $hasDefaultPermissions) {
            return $false
        }
        return (($hasSandbox -and $values['sandbox_mode'] -eq 'danger-full-access') -or
            ($hasDefaultPermissions -and $values['default_permissions'] -eq ':danger-full-access'))
    }
    catch {
        return $false
    }
}

function Get-CodexInstallerProjectHome {
    try {
        $projectHome = $env:AI_CLI_BYPASS_HOME
        if ([string]::IsNullOrWhiteSpace($projectHome)) {
            if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
                return $null
            }
            $projectHome = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass'
        }
        if (-not [System.IO.Path]::IsPathRooted($projectHome)) {
            return $null
        }
        return [System.IO.Path]::GetFullPath($projectHome)
    }
    catch {
        return $null
    }
}

function Test-CodexInstallerNpmShimContent {
    param([Parameter(Mandatory = $true)][string]$Target)

    try {
        if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
            return $false
        }
        $targetFullPath = [System.IO.Path]::GetFullPath($Target)
        $packageEntry = Join-Path (Split-Path -Parent $targetFullPath) 'node_modules\@openai\codex\bin\codex.js'
        if (-not (Test-Path -LiteralPath $packageEntry -PathType Leaf)) {
            return $false
        }
        $text = [System.IO.File]::ReadAllText($Target, (New-Object System.Text.UTF8Encoding($false)))
        foreach ($line in @([regex]::Split($text, '\r\n|\n|\r'))) {
            $trimmed = ([string]$line).Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed) -or
                $trimmed.StartsWith('::') -or
                $trimmed -match '(?i)^@?rem(?:\s|$)') {
                continue
            }
            if ($trimmed -match '(?i)dp0.*node_modules\s*[\\/]+\s*@openai\s*[\\/]+\s*codex\s*[\\/]+\s*bin\s*[\\/]+\s*codex\.js' -and
                $trimmed -match '%\*') {
                return $true
            }
        }
        return $false
    }
    catch {
        return $false
    }
}

function Normalize-CodexInstallerPathEntry {
    param([AllowEmptyString()][AllowNull()][string]$Entry)

    if ([string]::IsNullOrWhiteSpace($Entry)) {
        return ''
    }
    $normalized = $Entry.Trim()
    if ($normalized.Length -ge 2 -and $normalized[0] -eq [char]34 -and $normalized[$normalized.Length - 1] -eq [char]34) {
        $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
    }
    try {
        $normalized = [System.IO.Path]::GetFullPath($normalized)
    }
    catch { }
    return $normalized.TrimEnd('\', '/')
}

function Test-CodexInstallerPathContains {
    param(
        [AllowEmptyString()][AllowNull()][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $expected = Normalize-CodexInstallerPathEntry -Entry $Entry
    if ([string]::IsNullOrWhiteSpace($expected)) {
        return $false
    }
    foreach ($candidate in @(([string]$PathValue).Split([char]';'))) {
        if ([string]::Equals((Normalize-CodexInstallerPathEntry -Entry $candidate), $expected, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Test-CodexInstallerWrapper {
    param(
        [Parameter(Mandatory = $true)][string]$WrapperPath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    try {
        if (-not (Test-Path -LiteralPath $WrapperPath -PathType Leaf)) {
            return $false
        }
        $text = [System.IO.File]::ReadAllText($WrapperPath, (New-Object System.Text.UTF8Encoding($false)))
        $escapedTarget = ([System.IO.Path]::GetFullPath($TargetPath)).Replace('%', '%%')
        return $text.Contains('"' + $escapedTarget + '"') -and
            $text.Contains('--dangerously-bypass-approvals-and-sandbox %*')
    }
    catch {
        return $false
    }
}

function Test-CodexInstallerTargetPath {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [AllowNull()][string]$WrapperPath
    )

    try {
        if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
            return $false
        }
        $candidateFullPath = [System.IO.Path]::GetFullPath($Target)
        if (-not [string]::Equals([System.IO.Path]::GetExtension($candidateFullPath), '.cmd', [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        if (-not [string]::IsNullOrWhiteSpace($WrapperPath)) {
            $wrapperFullPath = [System.IO.Path]::GetFullPath($WrapperPath)
            $wrapperDirectory = (Split-Path -Parent $wrapperFullPath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
            if ([string]::Equals($candidateFullPath, $wrapperFullPath, [StringComparison]::OrdinalIgnoreCase) -or
                $candidateFullPath.StartsWith($wrapperDirectory, [StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
        }
        if (-not (Test-CodexInstallerNpmShimContent -Target $candidateFullPath)) {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Test-CodexInstallerUpstreamCommand {
    $projectHome = Get-CodexInstallerProjectHome
    $wrapperPath = if ($null -ne $projectHome) { Join-Path $projectHome 'bin\codex.cmd' } else { $null }
    if ($null -ne $projectHome) {
        $statePath = Join-Path $projectHome 'state\codex.json'
        if (Test-Path -LiteralPath $statePath) {
            if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
                return $false
            }
            try {
                $state = [System.IO.File]::ReadAllText($statePath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
                foreach ($required in @('SchemaVersion', 'Tool', 'Package', 'Command', 'TargetShim', 'WrapperPath', 'Arguments', 'InstalledByBypass', 'CodexConfig')) {
                    if ($null -eq $state.PSObject.Properties[$required]) {
                        return $false
                    }
                }
                if ([int]$state.SchemaVersion -ne 1 -or
                    [string]$state.Tool -ne 'codex' -or
                    [string]$state.Package -ne '@openai/codex' -or
                    [string]$state.Command -ne 'codex' -or
                    -not ($state.InstalledByBypass -is [bool])) {
                    return $false
                }
                if (-not [string]::Equals(
                        [System.IO.Path]::GetFullPath([string]$state.WrapperPath),
                        [System.IO.Path]::GetFullPath([string]$wrapperPath),
                        [StringComparison]::OrdinalIgnoreCase)) {
                    return $false
                }
                foreach ($required in @('Path', 'ConfigExisted', 'ApprovalPolicy', 'SandboxMode')) {
                    if ($null -eq $state.CodexConfig.PSObject.Properties[$required]) {
                        return $false
                    }
                }
                $activeConfigPath = Get-CodexInstallerConfigPath
                if ([string]::IsNullOrWhiteSpace($activeConfigPath) -or
                    -not [string]::Equals([System.IO.Path]::GetFullPath([string]$state.CodexConfig.Path), [System.IO.Path]::GetFullPath($activeConfigPath), [StringComparison]::OrdinalIgnoreCase)) {
                    return $false
                }
                if ($null -ne $state.PSObject.Properties['TargetShim'] -and
                    (Test-CodexInstallerTargetPath -Target ([string]$state.TargetShim) -WrapperPath $wrapperPath)) {
                    $wrapperDirectory = Split-Path -Parent $wrapperPath
                    $userPath = if (-not [string]::IsNullOrWhiteSpace($env:AI_CLI_BYPASS_USER_PATH_FILE) -and
                        (Test-Path -LiteralPath $env:AI_CLI_BYPASS_USER_PATH_FILE -PathType Leaf)) {
                        [System.IO.File]::ReadAllText($env:AI_CLI_BYPASS_USER_PATH_FILE, (New-Object System.Text.UTF8Encoding($false)))
                    }
                    else {
                        [Environment]::GetEnvironmentVariable('Path', 'User')
                    }
                    if ((Test-CodexInstallerWrapper -WrapperPath $wrapperPath -TargetPath ([string]$state.TargetShim)) -and
                        (Test-CodexInstallerPathContains -PathValue $userPath -Entry $wrapperDirectory)) {
                        if (-not (Test-CodexInstallerPathContains -PathValue $env:Path -Entry $wrapperDirectory)) {
                            $env:Path = if ([string]::IsNullOrEmpty($env:Path)) {
                                $wrapperDirectory
                            }
                            else {
                                $wrapperDirectory + ';' + $env:Path
                            }
                        }
                        return $true
                    }
                    return $false
                }
                return $false
            }
            catch {
                return $false
            }
        }
    }
    foreach ($command in @(Get-Command 'codex.cmd' -CommandType Application -All -ErrorAction SilentlyContinue)) {
        $candidate = if (-not [string]::IsNullOrWhiteSpace([string]$command.Source)) { [string]$command.Source } else { [string]$command.Path }
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        if (Test-CodexInstallerTargetPath -Target $candidate -WrapperPath $wrapperPath) {
            return $true
        }
    }
    return $false
}

if ((Test-CodexInstallerFullAccessConfig) -and (Test-CodexInstallerUpstreamCommand)) {
    Write-Host 'Codex is already installed and configured for Full Access; skipped npm and wrapper setup.'
    Write-Warning 'Full Access disables normal approval and sandbox protections. Use it only in an environment you trust.'
    return
}

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

Install-AiCliBypass -Tool 'codex'
