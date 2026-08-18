Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:AiCliSchemaVersion = 1
$script:AiCliDefinitions = @{
    claude = [pscustomobject]@{
        Tool = 'claude'
        Package = '@anthropic-ai/claude-code'
        Command = 'claude'
        Arguments = @('--dangerously-skip-permissions')
    }
    codex = [pscustomobject]@{
        Tool = 'codex'
        Package = '@openai/codex'
        Command = 'codex'
        Arguments = @('--dangerously-bypass-approvals-and-sandbox')
    }
    opencode = [pscustomobject]@{
        Tool = 'opencode'
        Package = 'opencode-ai'
        Command = 'opencode'
        Arguments = @('--auto')
    }
}

function Get-AiCliDefinition {
    param([Parameter(Mandatory = $true)][string]$Tool)

    $key = $Tool.ToLowerInvariant()
    if (-not $script:AiCliDefinitions.ContainsKey($key)) {
        throw "Unsupported tool '$Tool'. Expected claude, codex, or opencode."
    }
    return $script:AiCliDefinitions[$key]
}

function Assert-AiCliWindows {
    if ($env:OS -ne 'Windows_NT') {
        throw 'ai-cli-bypass Windows installers require Windows.'
    }
}

function Get-AiCliFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [System.IO.Path]::IsPathRooted($Path) -or
        $Path -match '^[A-Za-z]:($|[^\\/])' -or
        $Path -match '^[\\/](?![\\/])') {
        throw "Expected an absolute path, but received '$Path'."
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-AiCliHome {
    $candidate = $env:AI_CLI_BYPASS_HOME
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $candidate = Join-Path $env:LOCALAPPDATA 'ai-cli-bypass'
        }
        elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            $candidate = Join-Path $env:USERPROFILE 'AppData\Local\ai-cli-bypass'
        }
        else {
            throw 'Cannot determine ai-cli-bypass home because LOCALAPPDATA and USERPROFILE are unavailable.'
        }
    }

    $fullPath = Get-AiCliFullPath $candidate
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals($fullPath.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The ai-cli-bypass home cannot be a filesystem root.'
    }
    return $fullPath
}

function Get-AiCliPaths {
    param([Parameter(Mandatory = $true)][string]$Tool)

    $definition = Get-AiCliDefinition -Tool $Tool
    $projectHome = Get-AiCliHome
    $bin = Join-Path $projectHome 'bin'
    $state = Join-Path $projectHome 'state'

    return [pscustomobject]@{
        Home = $projectHome
        Bin = $bin
        State = $state
        ToolState = Join-Path $state ($definition.Tool + '.json')
        GlobalState = Join-Path $state 'global.json'
        Wrapper = Join-Path $bin ($definition.Command + '.cmd')
    }
}

function Get-AiCliCanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-AiCliFullPath $Path
    for ($pass = 0; $pass -lt 32; $pass++) {
        $root = [System.IO.Path]::GetPathRoot($fullPath)
        $tail = $fullPath.Substring($root.Length)
        $segments = @($tail.Split(@([char]'\', [char]'/'), [System.StringSplitOptions]::RemoveEmptyEntries))
        $current = $root
        $resolved = $false

        for ($index = 0; $index -lt $segments.Count; $index++) {
            $candidate = Join-Path $current $segments[$index]
            if (-not (Test-Path -LiteralPath $candidate)) {
                break
            }

            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                $targetProperty = $item.PSObject.Properties['Target']
                $targets = @()
                if ($null -ne $targetProperty) {
                    $targets = @($targetProperty.Value)
                }
                if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
                    throw "Cannot safely resolve reparse-point path '$candidate'."
                }

                $target = [string]$targets[0]
                if (-not [System.IO.Path]::IsPathRooted($target)) {
                    $target = Join-Path (Split-Path -Parent $candidate) $target
                }
                $remaining = @($segments | Select-Object -Skip ($index + 1))
                $fullPath = Get-AiCliFullPath $target
                foreach ($remainingSegment in $remaining) {
                    $fullPath = Join-Path $fullPath $remainingSegment
                }
                $resolved = $true
                break
            }
            $current = $candidate
        }

        if (-not $resolved) {
            return [System.IO.Path]::GetFullPath($fullPath)
        }
    }
    throw "The path contains too many reparse-point hops: '$Path'."
}

function Test-AiCliPathIsWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    $canonicalPath = (Get-AiCliCanonicalPath $Path).TrimEnd('\', '/')
    $canonicalDirectory = (Get-AiCliCanonicalPath $Directory).TrimEnd('\', '/')
    if ([string]::Equals($canonicalPath, $canonicalDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $directoryPrefix = $canonicalDirectory + [System.IO.Path]::DirectorySeparatorChar
    return $canonicalPath.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-AiCliNpmCommand {
    $override = $env:AI_CLI_BYPASS_NPM
    if (-not [string]::IsNullOrWhiteSpace($override)) {
        if (-not [System.IO.Path]::IsPathRooted($override)) {
            throw "The AI_CLI_BYPASS_NPM override must be an absolute npm.cmd path: '$override'."
        }
        $fullOverride = [System.IO.Path]::GetFullPath($override)
        if (-not (Test-Path -LiteralPath $fullOverride -PathType Leaf)) {
            throw "npm.cmd was not found at '$fullOverride'."
        }
        if (-not [string]::Equals([System.IO.Path]::GetFileName($fullOverride), 'npm.cmd', [StringComparison]::OrdinalIgnoreCase)) {
            throw "The AI_CLI_BYPASS_NPM override must identify npm.cmd, not '$fullOverride'."
        }
        return $fullOverride
    }

    $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        throw 'npm.cmd was not found. Install Node.js/npm and ensure npm.cmd is on PATH.'
    }

    $commandPath = if (-not [string]::IsNullOrWhiteSpace($command.Source)) { $command.Source } else { $command.Path }
    if ([string]::IsNullOrWhiteSpace($commandPath) -or -not (Test-Path -LiteralPath $commandPath -PathType Leaf)) {
        throw 'npm.cmd resolved to an invalid application path.'
    }
    return [System.IO.Path]::GetFullPath($commandPath)
}

function Invoke-AiCliNpm {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )

    $npmCommand = Get-AiCliNpmCommand
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ('ai-cli-bypass-' + [Guid]::NewGuid().ToString('N') + '.stderr')
    $previousErrorActionPreference = $ErrorActionPreference
    $output = @()
    $stderr = @()
    try {
        # Native npm warnings are non-fatal. Capture stderr separately because the
        # core runs with Stop semantics for PowerShell errors.
        $ErrorActionPreference = 'Continue'
        $output = @(& $npmCommand @Arguments 2> $stderrPath)
        $exitCode = $LASTEXITCODE
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            $stderr = @([System.IO.File]::ReadAllLines($stderrPath))
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
            try { Remove-Item -LiteralPath $stderrPath -Force } catch { }
        }
    }
    if ($AllowedExitCodes -notcontains $exitCode) {
        $renderedOutput = (@($output + $stderr | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Trim()
        $message = "npm $($Arguments -join ' ') failed with exit code $exitCode."
        if (-not [string]::IsNullOrWhiteSpace($renderedOutput)) {
            $message += " $renderedOutput"
        }
        throw $message
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output | ForEach-Object { [string]$_ })
    }
}

function Test-AiCliPackageInstalled {
    param([Parameter(Mandatory = $true)][string]$Package)

    $result = Invoke-AiCliNpm -Arguments @('list', '--global', '--depth=0', $Package) -AllowedExitCodes @(0, 1)
    return $result.ExitCode -eq 0
}

function Get-AiCliNpmPrefix {
    $result = Invoke-AiCliNpm -Arguments @('prefix', '--global')
    $lines = @(
        $result.Output |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($lines.Count -eq 0) {
        throw 'npm prefix --global returned an empty prefix.'
    }

    $prefix = $lines[$lines.Count - 1]
    if ($prefix.IndexOfAny(@([char]13, [char]10, [char]34)) -ge 0) {
        throw 'npm prefix --global returned a prefix containing quotes or newlines.'
    }
    if (-not [System.IO.Path]::IsPathRooted($prefix)) {
        throw "npm prefix --global returned a non-absolute path: '$prefix'."
    }
    return [System.IO.Path]::GetFullPath($prefix)
}

function Test-AiCliExistingTargetShim {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$RequireCodexShim
    )

    try {
        if ([string]::IsNullOrWhiteSpace($Target) -or -not (Test-Path -LiteralPath $Target -PathType Leaf)) {
            return $null
        }
        $canonicalTarget = Get-AiCliCanonicalPath $Target
        if (-not [string]::Equals([System.IO.Path]::GetExtension($canonicalTarget), '.cmd', [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
        if (Test-AiCliPathIsWithin -Path $canonicalTarget -Directory $Paths.Bin) {
            return $null
        }
        if ($RequireCodexShim -and -not (Test-AiCliCodexNpmShimContent -Target $canonicalTarget)) {
            return $null
        }
        return $canonicalTarget
    }
    catch {
        return $null
    }
}

function Test-AiCliCodexNpmShimContent {
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

function Find-AiCliExistingTargetShim {
    param(
        [Parameter(Mandatory = $true)]$Definition,
        [Parameter(Mandatory = $true)]$Paths,
        [AllowNull()]$ExistingState
    )

    if ($Definition.Tool -ne 'codex') {
        return $null
    }
    if ($null -ne $ExistingState -and $null -ne $ExistingState.PSObject.Properties['TargetShim']) {
        $fromState = Test-AiCliExistingTargetShim -Target ([string]$ExistingState.TargetShim) -Paths $Paths -RequireCodexShim
        if ($null -ne $fromState) {
            return $fromState
        }
    }

    $commands = @(Get-Command ($Definition.Command + '.cmd') -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        $candidate = if (-not [string]::IsNullOrWhiteSpace([string]$command.Source)) { [string]$command.Source } else { [string]$command.Path }
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        $discovered = Test-AiCliExistingTargetShim -Target $candidate -Paths $Paths -RequireCodexShim
        if ($null -ne $discovered) {
            return $discovered
        }
    }
    return $null
}

function Install-AiCliPackage {
    param([Parameter(Mandatory = $true)][string]$Package)

    $null = Invoke-AiCliNpm -Arguments @('install', '--global', $Package)
}

function Uninstall-AiCliPackage {
    param([Parameter(Mandatory = $true)][string]$Package)

    $null = Invoke-AiCliNpm -Arguments @('uninstall', '--global', $Package)
}

function Read-AiCliJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Expected a JSON state file at '$Path'."
    }

    $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "JSON state file '$Path' is empty."
    }
    try {
        return $text | ConvertFrom-Json
    }
    catch {
        throw "JSON state file '$Path' is invalid: $($_.Exception.Message)"
    }
}

function Write-AiCliAtomicBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $parent -Force
    }

    $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $backupPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
    $replaceSucceeded = $false
    try {
        [System.IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        if (Test-Path -LiteralPath $Path) {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw "Cannot replace non-file path '$Path'."
            }
            [System.IO.File]::Replace($temporaryPath, $Path, $backupPath)
            $replaceSucceeded = $true
        }
        else {
            [System.IO.File]::Move($temporaryPath, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            try { Remove-Item -LiteralPath $temporaryPath -Force } catch { }
        }
        if ($replaceSucceeded -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            # The replacement is already committed; a cleanup failure must not
            # make callers believe the write itself failed.
            try { Remove-Item -LiteralPath $backupPath -Force } catch { }
        }
    }
}

function Write-AiCliAtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [System.Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false))
    )

    $preamble = @($Encoding.GetPreamble())
    $content = @($Encoding.GetBytes($Text))
    Write-AiCliAtomicBytes -Path $Path -Bytes ([byte[]]($preamble + $content))
}

function Write-AiCliJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = ($Value | ConvertTo-Json -Depth 6) + "`r`n"
    Write-AiCliAtomicText -Path $Path -Text $json -Encoding (New-Object System.Text.UTF8Encoding($false))
}

function Get-AiCliFileSnapshot {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "Expected a file at '$Path'."
        }
        return [pscustomobject]@{
            Existed = $true
            Bytes = [System.IO.File]::ReadAllBytes($Path)
        }
    }
    return [pscustomobject]@{
        Existed = $false
        Bytes = $null
    }
}

function Restore-AiCliFileSnapshot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Snapshot
    )

    if ([bool]$Snapshot.Existed) {
        Write-AiCliAtomicBytes -Path $Path -Bytes ([byte[]]$Snapshot.Bytes)
    }
    elseif (Test-Path -LiteralPath $Path -PathType Leaf) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Get-AiCliUserPath {
    $pathFile = $env:AI_CLI_BYPASS_USER_PATH_FILE
    if (-not [string]::IsNullOrWhiteSpace($pathFile)) {
        $fullPath = Get-AiCliFullPath $pathFile
        if (-not (Test-Path -LiteralPath $fullPath)) {
            return ''
        }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Expected a file-backed user PATH at '$fullPath'."
        }
        return [System.IO.File]::ReadAllText($fullPath, (New-Object System.Text.UTF8Encoding($false)))
    }

    $value = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $value) {
        return ''
    }
    return $value
}

function Set-AiCliUserPath {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $pathFile = $env:AI_CLI_BYPASS_USER_PATH_FILE
    if (-not [string]::IsNullOrWhiteSpace($pathFile)) {
        $fullPath = Get-AiCliFullPath $pathFile
        $parent = Split-Path -Parent $fullPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            $null = New-Item -ItemType Directory -Path $parent -Force
        }
        [System.IO.File]::WriteAllText($fullPath, $Value, (New-Object System.Text.UTF8Encoding($false)))
        return
    }

    [Environment]::SetEnvironmentVariable('Path', $Value, 'User')
}

function Normalize-AiCliPathEntry {
    param([AllowEmptyString()][AllowNull()][string]$Entry)

    if ($null -eq $Entry) {
        return ''
    }

    $normalized = $Entry.Trim()
    if ($normalized.Length -ge 2 -and $normalized[0] -eq [char]34 -and $normalized[$normalized.Length - 1] -eq [char]34) {
        $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        return ''
    }

    if ([System.IO.Path]::IsPathRooted($normalized)) {
        try {
            $normalized = [System.IO.Path]::GetFullPath($normalized)
        }
        catch {
            return $normalized.TrimEnd('\', '/')
        }
    }

    $root = [System.IO.Path]::GetPathRoot($normalized)
    $minimumLength = if ([string]::IsNullOrEmpty($root)) { 0 } else { $root.TrimEnd('\', '/').Length }
    while ($normalized.Length -gt $minimumLength -and ($normalized.EndsWith('\') -or $normalized.EndsWith('/'))) {
        $normalized = $normalized.Substring(0, $normalized.Length - 1)
    }
    return $normalized
}

function Get-AiCliCodexConfigPath {
    $codexHomePath = $env:CODEX_HOME
    if ([string]::IsNullOrWhiteSpace($codexHomePath)) {
        if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            throw 'Cannot determine CODEX_HOME because USERPROFILE is unavailable.'
        }
        $codexHomePath = Join-Path $env:USERPROFILE '.codex'
    }

    return Join-Path (Get-AiCliFullPath $codexHomePath) 'config.toml'
}

function Read-AiCliUtf8TextFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and
        $bytes[0] -eq 0xEF -and
        $bytes[1] -eq 0xBB -and
        $bytes[2] -eq 0xBF
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }
    return [pscustomobject]@{
        Text = $text
        HasBom = $hasBom
    }
}

function Get-AiCliUtf8Encoding {
    param([bool]$WithBom)

    if ($WithBom) {
        return New-Object System.Text.UTF8Encoding($true)
    }
    return New-Object System.Text.UTF8Encoding($false)
}

function Get-AiCliTomlCodePortion {
    param([AllowEmptyString()][AllowNull()][string]$Line)

    if ($null -eq $Line) {
        return ''
    }

    # Remove comments without treating quote characters inside a comment as
    # TOML string delimiters. Triple-quoted strings keep '#' as content.
    $mode = 0 # 0=code, 1=basic, 2=literal, 3=multiline basic, 4=multiline literal
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

function Convert-AiCliTomlBasicKey {
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

function Get-AiCliTomlKeyName {
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
        return Convert-AiCliTomlBasicKey -Value $DoubleName
    }
    return $null
}

function Get-AiCliTomlDocument {
    param([AllowEmptyString()][AllowNull()][string]$Text)

    if ($null -eq $Text) {
        $Text = ''
    }
    if ($Text.Length -gt 0 -and [int][char]$Text[0] -eq 0xFEFF) {
        $Text = $Text.Substring(1)
    }
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } elseif ($Text.Contains("`n")) { "`n" } elseif ($Text.Contains("`r")) { "`r" } else { "`r`n" }
    $hasFinalNewline = $Text.EndsWith("`r`n") -or $Text.EndsWith("`n") -or $Text.EndsWith("`r")
    if ([string]::IsNullOrEmpty($Text)) {
        $lines = @()
    }
    else {
        $lines = @([regex]::Split($Text, "`r`n|`n|`r"))
    }
    if ($hasFinalNewline -and $lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        if ($lines.Count -eq 1) {
            $lines = @()
        }
        else {
            $lines = @($lines[0..($lines.Count - 2)])
        }
    }

    $tableIndex = $lines.Count
    $multilineDelimiter = $null
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = [string]$lines[$index]
        if ($null -ne $multilineDelimiter) {
            $delimiterCount = Get-AiCliTomlMultilineDelimiterCount -Line $line -Delimiter $multilineDelimiter
            if ($delimiterCount -gt 0) {
                $multilineDelimiter = $null
            }
            continue
        }
        $codeLine = Get-AiCliTomlCodePortion -Line $line
        $newDelimiter = Get-AiCliTomlTripleDelimiter -Line $codeLine
        if ($null -ne $newDelimiter) {
            $multilineDelimiter = $newDelimiter
            continue
        }
        if ($codeLine -match '^\s*\[\[?') {
            $tableIndex = $index
            break
        }
    }
    if ($null -ne $multilineDelimiter) {
        throw 'Codex config contains an unterminated TOML multiline string.'
    }

    return [pscustomobject]@{
        Lines = @($lines)
        Newline = $newline
        HasFinalNewline = $hasFinalNewline
        TableIndex = $tableIndex
    }
}

function Convert-AiCliTomlDocumentToText {
    param([Parameter(Mandatory = $true)]$Document)

    $text = @($Document.Lines) -join [string]$Document.Newline
    if ([bool]$Document.HasFinalNewline -and @($Document.Lines).Count -gt 0) {
        $text += [string]$Document.Newline
    }
    return $text
}

function Get-AiCliTomlAssignmentValue {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)

    if ($Line -notmatch '^\s*(?:(?:[A-Za-z0-9_-]+)|"(?:\\.|[^"\\])*"|''[^'']*'')\s*=\s*(?<rhs>.*)$') {
        return $null
    }
    $rhs = $Matches['rhs'].Trim()
    if ($rhs -match '^"(?<quoted>(?:\\.|[^"\\])*)"\s*(?:#.*)?$') {
        return [string]$Matches['quoted']
    }
    return (($rhs -replace '\s+#.*$', '').Trim())
}

function Get-AiCliTomlTripleDelimiter {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)

    $mode = 0 # 0=code, 1=basic, 2=literal
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

function Get-AiCliTomlMultilineDelimiterCount {
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

function Set-AiCliTomlAssignmentLine {
    param(
        [Parameter(Mandatory = $true)][string]$Line,
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$FallbackName
    )

    if ($Line -match '^(?<prefix>\s*(?:(?:[A-Za-z0-9_-]+)|"(?:\\.|[^"\\])*"|''[^'']*'')\s*=\s*)"(?:\\.|[^"\\])*"(?<suffix>\s*(?:#.*)?)$') {
        return ([string]$Matches['prefix']) + '"' + $Value + '"' + [string]$Matches['suffix']
    }
    return "$FallbackName = `"$Value`""
}

function Get-AiCliTopLevelTomlAssignments {
    param(
        [AllowEmptyString()][AllowNull()][string]$Text,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    $document = Get-AiCliTomlDocument -Text $Text
    $assignments = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
    $multilineDelimiter = $null
    for ($index = 0; $index -lt $document.TableIndex; $index++) {
        $line = [string]$document.Lines[$index]
        if ($null -ne $multilineDelimiter) {
            $delimiterCount = Get-AiCliTomlMultilineDelimiterCount -Line $line -Delimiter $multilineDelimiter
            if ($delimiterCount -gt 0) {
                $multilineDelimiter = $null
            }
            continue
        }
        $codeLine = Get-AiCliTomlCodePortion -Line $line
        $newDelimiter = Get-AiCliTomlTripleDelimiter -Line $codeLine
        if ($null -ne $newDelimiter) {
            $multilineDelimiter = $newDelimiter
            continue
        }
        if ($codeLine -notmatch '^\s*(?:(?<bareName>[A-Za-z0-9_-]+)|"(?<doubleName>(?:\\.|[^"\\])*)"|''(?<singleName>[^'']*)'')\s*=\s*(?<rhs>.*)$') {
            continue
        }
        $bareName = if ($Matches.ContainsKey('bareName')) { [string]$Matches['bareName'] } else { $null }
        $doubleName = if ($Matches.ContainsKey('doubleName')) { [string]$Matches['doubleName'] } else { $null }
        $singleName = if ($Matches.ContainsKey('singleName')) { [string]$Matches['singleName'] } else { $null }
        $name = Get-AiCliTomlKeyName -BareName $bareName -DoubleName $doubleName -SingleName $singleName
        $knownName = $false
        foreach ($candidate in $Names) {
            if ([string]::Equals([string]$candidate, [string]$name, [StringComparison]::Ordinal)) {
                $knownName = $true
                break
            }
        }
        if (-not $knownName) {
            continue
        }
        if ($assignments.ContainsKey($name)) {
            throw "Duplicate top-level Codex setting '$name' was found in config.toml."
        }
        $assignments[$name] = [pscustomobject][ordered]@{
            Name = $name
            Value = Get-AiCliTomlAssignmentValue -Line $line
            RawLine = $line
            Index = $index
        }
    }

    return [pscustomobject]@{
        Document = $document
        Assignments = $assignments
    }
}

function New-AiCliCodexConfigBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Assignments,
        [Parameter(Mandatory = $true)][bool]$ConfigExisted
    )

    $approval = $Assignments['approval_policy']
    $sandbox = $Assignments['sandbox_mode']
    return [pscustomobject][ordered]@{
        Path = [System.IO.Path]::GetFullPath($Path)
        ConfigExisted = $ConfigExisted
        ApprovalPolicy = [pscustomobject][ordered]@{
            Present = ($null -ne $approval)
            RawLine = if ($null -ne $approval) { [string]$approval.RawLine } else { $null }
            InstalledRawLine = $null
        }
        SandboxMode = [pscustomobject][ordered]@{
            Present = ($null -ne $sandbox)
            RawLine = if ($null -ne $sandbox) { [string]$sandbox.RawLine } else { $null }
            InstalledRawLine = $null
        }
    }
}

function Set-AiCliCodexFullAccess {
    param(
        [AllowNull()]$ExistingBackup,
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = Get-AiCliCodexConfigPath
    }
    $configExisted = Test-Path -LiteralPath $Path -PathType Leaf
    if ((Test-Path -LiteralPath $Path) -and (-not $configExisted)) {
        throw "Codex config path '$Path' is not a file."
    }
    $fileData = if ($configExisted) { Read-AiCliUtf8TextFile -Path $Path } else { $null }
    $text = if ($null -ne $fileData) { [string]$fileData.Text } else { '' }
    $parsed = Get-AiCliTopLevelTomlAssignments -Text $text -Names @('approval_policy', 'sandbox_mode', 'default_permissions')
    if ($parsed.Assignments.ContainsKey('default_permissions')) {
        throw 'Codex config contains top-level default_permissions; remove or resolve it before enabling legacy sandbox_mode Full Access.'
    }

    $backup = if ($null -ne $ExistingBackup) {
        if ($null -eq $ExistingBackup.PSObject.Properties['Path']) {
            throw 'Existing Codex config backup is missing Path.'
        }
        $backupPath = Get-AiCliFullPath ([string]$ExistingBackup.Path)
        if (-not [string]::Equals($backupPath, (Get-AiCliFullPath $Path), [StringComparison]::OrdinalIgnoreCase)) {
            throw "CODEX_HOME changed from '$backupPath' to '$Path'. Uninstall the existing bypass before installing into a different Codex home."
        }
        $ExistingBackup
    }
    else {
        New-AiCliCodexConfigBackup -Path $Path -Assignments $parsed.Assignments -ConfigExisted $configExisted
    }

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in @($parsed.Document.Lines)) {
        $lines.Add([string]$line)
    }
    $insertions = New-Object System.Collections.Generic.List[string]
    $installedApprovalLine = $null
    $installedSandboxLine = $null
    if ($parsed.Assignments.ContainsKey('approval_policy')) {
        $assignment = $parsed.Assignments['approval_policy']
        $installedApprovalLine = Set-AiCliTomlAssignmentLine -Line ([string]$assignment.RawLine) -Value 'never' -FallbackName 'approval_policy'
        $lines[$assignment.Index] = $installedApprovalLine
    }
    else {
        $installedApprovalLine = 'approval_policy = "never"'
        $insertions.Add($installedApprovalLine)
    }
    if ($parsed.Assignments.ContainsKey('sandbox_mode')) {
        $assignment = $parsed.Assignments['sandbox_mode']
        $installedSandboxLine = Set-AiCliTomlAssignmentLine -Line ([string]$assignment.RawLine) -Value 'danger-full-access' -FallbackName 'sandbox_mode'
        $lines[$assignment.Index] = $installedSandboxLine
    }
    else {
        $installedSandboxLine = 'sandbox_mode = "danger-full-access"'
        $insertions.Add($installedSandboxLine)
    }

    if ($insertions.Count -gt 0) {
        $insertAt = $parsed.Document.TableIndex
        $combined = New-Object System.Collections.Generic.List[string]
        for ($index = 0; $index -lt $insertAt; $index++) { $combined.Add($lines[$index]) }
        foreach ($line in $insertions) { $combined.Add($line) }
        for ($index = $insertAt; $index -lt $lines.Count; $index++) { $combined.Add($lines[$index]) }
        $lines = $combined
    }

    $backup.ApprovalPolicy | Add-Member -MemberType NoteProperty -Name InstalledRawLine -Value $installedApprovalLine -Force | Out-Null
    $backup.SandboxMode | Add-Member -MemberType NoteProperty -Name InstalledRawLine -Value $installedSandboxLine -Force | Out-Null

    $document = [pscustomobject]@{
        Lines = @($lines)
        Newline = $parsed.Document.Newline
        HasFinalNewline = if ($configExisted) { [bool]$parsed.Document.HasFinalNewline } else { $true }
    }
    $encoding = Get-AiCliUtf8Encoding -WithBom ([bool]($null -ne $fileData -and $fileData.HasBom))
    Write-AiCliAtomicText -Path $Path -Text (Convert-AiCliTomlDocumentToText -Document $document) -Encoding $encoding
    return $backup
}

function Restore-AiCliCodexConfig {
    param([Parameter(Mandatory = $true)]$Backup)

    foreach ($name in @('Path', 'ConfigExisted', 'ApprovalPolicy', 'SandboxMode')) {
        if ($null -eq $Backup.PSObject.Properties[$name]) {
            throw "Codex config state is missing '$name'."
        }
    }
    $path = Get-AiCliFullPath ([string]$Backup.Path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ([bool]$Backup.ApprovalPolicy.Present -or [bool]$Backup.SandboxMode.Present) {
            Write-Warning "Codex config '$path' is missing; original settings could not be restored."
        }
        return
    }

    $fileData = Read-AiCliUtf8TextFile -Path $path
    $text = [string]$fileData.Text
    $parsed = Get-AiCliTopLevelTomlAssignments -Text $text -Names @('approval_policy', 'sandbox_mode')
    $expected = @{
        approval_policy = 'never'
        sandbox_mode = 'danger-full-access'
    }
    $backups = @{
        approval_policy = $Backup.ApprovalPolicy
        sandbox_mode = $Backup.SandboxMode
    }
    $removeIndexes = New-Object System.Collections.Generic.List[int]
    $replacements = @{}
    foreach ($name in @('approval_policy', 'sandbox_mode')) {
        $current = $parsed.Assignments[$name]
        if ($null -eq $current) {
            if ([bool]$backups[$name].Present) {
                Write-Warning "Codex setting '$name' is missing; leaving the user's current configuration unchanged."
            }
            continue
        }
        $backupSetting = $backups[$name]
        $hasFingerprint = $null -ne $backupSetting.PSObject.Properties['InstalledRawLine']
        if ($hasFingerprint) {
            if (-not [string]::Equals([string]$current.RawLine, [string]$backupSetting.InstalledRawLine, [StringComparison]::Ordinal)) {
                Write-Warning "Codex setting '$name' was changed after installation; leaving the user's value unchanged."
                continue
            }
        }
        elseif ([string]$current.Value -ne $expected[$name]) {
            Write-Warning "Codex setting '$name' was changed after installation; leaving the user's value unchanged."
            continue
        }
        if ([bool]$backups[$name].Present) {
            $replacements[$current.Index] = [string]$backups[$name].RawLine
        }
        else {
            $removeIndexes.Add([int]$current.Index)
        }
    }

    $lines = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt @($parsed.Document.Lines).Count; $index++) {
        if ($removeIndexes.Contains($index)) {
            continue
        }
        if ($replacements.ContainsKey($index)) {
            $lines.Add([string]$replacements[$index])
        }
        else {
            $lines.Add([string]$parsed.Document.Lines[$index])
        }
    }
    $changed = ($replacements.Count -gt 0 -or $removeIndexes.Count -gt 0)
    if (-not $changed) {
        return
    }

    $document = [pscustomobject]@{
        Lines = @($lines)
        Newline = $parsed.Document.Newline
        HasFinalNewline = [bool]$parsed.Document.HasFinalNewline
    }
    $restoredText = Convert-AiCliTomlDocumentToText -Document $document
    if (-not [bool]$Backup.ConfigExisted -and [string]::IsNullOrEmpty($restoredText)) {
        Remove-Item -LiteralPath $path -Force
    }
    else {
        Write-AiCliAtomicText -Path $path -Text $restoredText -Encoding (Get-AiCliUtf8Encoding -WithBom ([bool]$fileData.HasBom))
    }
}

function Get-AiCliPathOwnershipKey {
    param([Parameter(Mandatory = $true)][string]$Entry)

    return (Normalize-AiCliPathEntry $Entry).ToUpperInvariant()
}

if ($null -eq (Get-Variable -Name AiCliProcessPathOwnership -Scope Script -ErrorAction SilentlyContinue)) {
    $script:AiCliProcessPathOwnership = @{}
}

function Test-AiCliPathEntry {
    param(
        [AllowEmptyString()][AllowNull()][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $normalizedEntry = Normalize-AiCliPathEntry $Entry
    foreach ($candidate in @(if ($null -eq $PathValue) { @() } else { $PathValue.Split([char]';') })) {
        if ([string]::Equals((Normalize-AiCliPathEntry $candidate), $normalizedEntry, [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Remove-AiCliPathEntryFromValue {
    param(
        [AllowEmptyString()][AllowNull()][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    if ($null -eq $PathValue) {
        return ''
    }

    $normalizedEntry = Normalize-AiCliPathEntry $Entry
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($PathValue.Split([char]';'))) {
        if (-not [string]::Equals((Normalize-AiCliPathEntry $candidate), $normalizedEntry, [StringComparison]::OrdinalIgnoreCase)) {
            $kept.Add($candidate)
        }
    }
    return $kept -join ';'
}

function Add-AiCliPathEntry {
    param([Parameter(Mandatory = $true)][string]$Entry)

    $canonicalEntry = Get-AiCliFullPath $Entry
    $originalUserPath = Get-AiCliUserPath
    $originalProcessPath = if ($null -eq $env:Path) { '' } else { $env:Path }
    $userAdded = -not (Test-AiCliPathEntry -PathValue $originalUserPath -Entry $canonicalEntry)
    $processAdded = -not (Test-AiCliPathEntry -PathValue $originalProcessPath -Entry $canonicalEntry)

    try {
        if ($userAdded) {
            $newUserPath = if ([string]::IsNullOrEmpty($originalUserPath)) { $canonicalEntry } else { $canonicalEntry + ';' + $originalUserPath }
            Set-AiCliUserPath -Value $newUserPath
        }
        if ($processAdded) {
            $env:Path = if ([string]::IsNullOrEmpty($originalProcessPath)) { $canonicalEntry } else { $canonicalEntry + ';' + $originalProcessPath }
            $script:AiCliProcessPathOwnership[(Get-AiCliPathOwnershipKey $canonicalEntry)] = $true
        }
    }
    catch {
        if ($userAdded) {
            try { Set-AiCliUserPath -Value $originalUserPath } catch { }
        }
        if ($processAdded) {
            $env:Path = $originalProcessPath
            $script:AiCliProcessPathOwnership.Remove((Get-AiCliPathOwnershipKey $canonicalEntry))
        }
        throw
    }

    return [pscustomobject]@{
        Entry = $canonicalEntry
        UserAdded = $userAdded
        ProcessAdded = $processAdded
    }
}

function Undo-AiCliPathAddition {
    param([Parameter(Mandatory = $true)]$Change)

    if ([bool]$Change.UserAdded) {
        $currentUserPath = Get-AiCliUserPath
        Set-AiCliUserPath -Value (Remove-AiCliPathEntryFromValue -PathValue $currentUserPath -Entry $Change.Entry)
    }
    if ([bool]$Change.ProcessAdded) {
        $currentProcessPath = if ($null -eq $env:Path) { '' } else { $env:Path }
        $env:Path = Remove-AiCliPathEntryFromValue -PathValue $currentProcessPath -Entry $Change.Entry
        $script:AiCliProcessPathOwnership.Remove((Get-AiCliPathOwnershipKey $Change.Entry))
    }
}

function Remove-AiCliPathEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Entry,
        [switch]$RemoveUser,
        [switch]$RemoveProcess
    )

    $canonicalEntry = Get-AiCliFullPath $Entry
    $removeUserPath = [bool]$RemoveUser
    $removeProcessPath = [bool]$RemoveProcess
    if (-not $PSBoundParameters.ContainsKey('RemoveUser') -and -not $PSBoundParameters.ContainsKey('RemoveProcess')) {
        $removeUserPath = $true
        $removeProcessPath = $true
    }
    if ($removeUserPath) {
        $userPath = Get-AiCliUserPath
        Set-AiCliUserPath -Value (Remove-AiCliPathEntryFromValue -PathValue $userPath -Entry $canonicalEntry)
    }
    if ($removeProcessPath) {
        $processPath = if ($null -eq $env:Path) { '' } else { $env:Path }
        $env:Path = Remove-AiCliPathEntryFromValue -PathValue $processPath -Entry $canonicalEntry
        $script:AiCliProcessPathOwnership.Remove((Get-AiCliPathOwnershipKey $canonicalEntry))
    }
}

function New-AiCliWrapperContent {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    if ($Target.IndexOf([char]34) -ge 0) {
        throw 'The upstream shim target cannot contain double quotes.'
    }
    if ($Target.IndexOfAny(@([char]13, [char]10)) -ge 0) {
        throw 'The upstream shim target cannot contain newlines.'
    }
    if (-not [System.IO.Path]::IsPathRooted($Target)) {
        throw "The upstream shim target must be an absolute path: '$Target'."
    }

    $canonicalTarget = Get-AiCliCanonicalPath $Target
    if (-not (Test-Path -LiteralPath $canonicalTarget -PathType Leaf)) {
        throw "The upstream npm shim does not exist at '$canonicalTarget'."
    }
    if (-not [string]::Equals([System.IO.Path]::GetExtension($canonicalTarget), '.cmd', [StringComparison]::OrdinalIgnoreCase)) {
        throw "The upstream npm shim must be a .cmd file: '$canonicalTarget'."
    }

    $wrapperDirectory = (Get-AiCliPaths -Tool 'claude').Bin
    if (Test-AiCliPathIsWithin -Path $canonicalTarget -Directory $wrapperDirectory) {
        throw "The upstream shim target must be outside the ai-cli-bypass wrapper directory '$wrapperDirectory'."
    }

    foreach ($argument in $Arguments) {
        if ([string]::IsNullOrWhiteSpace($argument) -or $argument.IndexOfAny(@([char]13, [char]10, [char]34)) -ge 0) {
            throw "Invalid injected wrapper argument '$argument'."
        }
    }

    # The target batch file is the final command, so only this batch parse must
    # be escaped. Avoid CALL: it reparses %* and corrupts user percent signs.
    $escapedTarget = $canonicalTarget.Replace('%', '%%')
    $injectedArguments = $Arguments -join ' '
    $lines = @(
        '@echo off',
        'setlocal DisableDelayedExpansion',
        ('"{0}" {1} %*' -f $escapedTarget, $injectedArguments)
    )
    return ($lines -join "`r`n") + "`r`n"
}

function Assert-AiCliStateProperty {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$StateName
    )

    if ($null -eq $State.PSObject.Properties[$Name]) {
        throw "$StateName state is missing required property '$Name'."
    }
}

function Assert-AiCliCodexConfigState {
    param([Parameter(Mandatory = $true)]$State)

    foreach ($name in @('Path', 'ConfigExisted', 'ApprovalPolicy', 'SandboxMode')) {
        Assert-AiCliStateProperty -State $State -Name $name -StateName 'CodexConfig'
    }
    if (-not [System.IO.Path]::IsPathRooted([string]$State.Path)) {
        throw 'CodexConfig Path must be absolute.'
    }
    if (-not ($State.ConfigExisted -is [bool])) {
        throw 'CodexConfig ConfigExisted must be a Boolean.'
    }
    foreach ($name in @('ApprovalPolicy', 'SandboxMode')) {
        $setting = $State.$name
        foreach ($property in @('Present', 'RawLine')) {
            Assert-AiCliStateProperty -State $setting -Name $property -StateName ('CodexConfig.' + $name)
        }
        if ($null -ne $setting.PSObject.Properties['InstalledRawLine'] -and
            $null -ne $setting.InstalledRawLine -and
            -not ($setting.InstalledRawLine -is [string])) {
            throw "CodexConfig $name InstalledRawLine must be a string when present."
        }
        if (-not ($setting.Present -is [bool])) {
            throw "CodexConfig $name Present must be a Boolean."
        }
        if ([bool]$setting.Present -and $null -eq $setting.RawLine) {
            throw "CodexConfig $name RawLine must be present when the setting existed."
        }
    }
}

function Assert-AiCliToolState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Definition,
        [Parameter(Mandatory = $true)]$Paths
    )

    foreach ($name in @('SchemaVersion', 'Tool', 'Package', 'Command', 'TargetShim', 'WrapperPath', 'Arguments', 'InstalledByBypass')) {
        Assert-AiCliStateProperty -State $State -Name $name -StateName 'Tool'
    }
    if ([int]$State.SchemaVersion -ne $script:AiCliSchemaVersion) {
        throw "Unsupported tool state schema '$($State.SchemaVersion)'."
    }
    if ($State.Tool -ne $Definition.Tool -or $State.Package -ne $Definition.Package -or $State.Command -ne $Definition.Command) {
        throw "Tool state does not match the fixed '$($Definition.Tool)' registry definition."
    }
    if (-not [string]::Equals((Get-AiCliCanonicalPath ([string]$State.WrapperPath)), (Get-AiCliCanonicalPath $Paths.Wrapper), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Tool state wrapper path does not match the project-owned wrapper path.'
    }
    if (-not ($State.InstalledByBypass -is [bool])) {
        throw 'Tool state InstalledByBypass must be a Boolean.'
    }
    if ($Definition.Tool -eq 'codex' -and $null -ne $State.PSObject.Properties['CodexConfig']) {
        Assert-AiCliCodexConfigState -State $State.CodexConfig
    }
}

function Assert-AiCliGlobalState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)]$Paths
    )

    foreach ($name in @('SchemaVersion', 'WrapperDirectory', 'UserPathAddedByBypass')) {
        Assert-AiCliStateProperty -State $State -Name $name -StateName 'Global'
    }
    if ([int]$State.SchemaVersion -ne $script:AiCliSchemaVersion) {
        throw "Unsupported global state schema '$($State.SchemaVersion)'."
    }
    if (-not [string]::Equals((Get-AiCliCanonicalPath ([string]$State.WrapperDirectory)), (Get-AiCliCanonicalPath $Paths.Bin), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Global state wrapper directory does not match the project-owned wrapper directory.'
    }
    if (-not ($State.UserPathAddedByBypass -is [bool])) {
        throw 'Global state UserPathAddedByBypass must be a Boolean.'
    }
}

function Test-AiCliAnyKnownWrapper {
    param([Parameter(Mandatory = $true)][string]$BinDirectory)

    foreach ($name in @('claude.cmd', 'codex.cmd', 'opencode.cmd')) {
        if (Test-Path -LiteralPath (Join-Path $BinDirectory $name) -PathType Leaf) {
            return $true
        }
    }
    return $false
}

function Remove-AiCliEmptyDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return
    }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Remove-AiCliEmptyDirectories {
    $projectHome = Get-AiCliHome
    $bin = Join-Path $projectHome 'bin'
    $state = Join-Path $projectHome 'state'
    Remove-AiCliEmptyDirectory -Path $bin
    Remove-AiCliEmptyDirectory -Path $state
    Remove-AiCliEmptyDirectory -Path $projectHome
}

function Install-AiCliBypass {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'opencode')][string]$Tool)

    Assert-AiCliWindows
    $definition = Get-AiCliDefinition -Tool $Tool
    $paths = Get-AiCliPaths -Tool $Tool

    $existingToolState = Read-AiCliJson -Path $paths.ToolState
    $existingGlobalState = Read-AiCliJson -Path $paths.GlobalState
    if ($null -ne $existingToolState) {
        Assert-AiCliToolState -State $existingToolState -Definition $definition -Paths $paths
    }
    if ($null -ne $existingGlobalState) {
        Assert-AiCliGlobalState -State $existingGlobalState -Paths $paths
    }

    $wrapperSnapshot = Get-AiCliFileSnapshot -Path $paths.Wrapper
    $toolStateSnapshot = Get-AiCliFileSnapshot -Path $paths.ToolState
    $globalStateSnapshot = Get-AiCliFileSnapshot -Path $paths.GlobalState
    $codexConfigPath = $null
    $codexConfigSnapshot = $null
    if ($definition.Tool -eq 'codex') {
        $codexConfigPath = Get-AiCliCodexConfigPath
        if ($null -ne $existingToolState -and $null -ne $existingToolState.PSObject.Properties['CodexConfig']) {
            $savedConfigPath = Get-AiCliFullPath ([string]$existingToolState.CodexConfig.Path)
            if (-not [string]::Equals($savedConfigPath, $codexConfigPath, [StringComparison]::OrdinalIgnoreCase)) {
                throw "CODEX_HOME changed from '$savedConfigPath' to '$codexConfigPath'. Uninstall the existing bypass before installing into a different Codex home."
            }
        }
        $codexConfigSnapshot = Get-AiCliFileSnapshot -Path $codexConfigPath
    }
    $wrapperWritten = $false
    $toolStateWritten = $false
    $globalStateWritten = $false
    $codexConfigWritten = $false
    $packageCreated = $false
    $packageExistedBeforeInstall = $null
    $pathChange = $null
    $existingTargetShim = Find-AiCliExistingTargetShim -Definition $definition -Paths $paths -ExistingState $existingToolState

    try {
        $existingCodexConfig = $null
        if ($definition.Tool -eq 'codex') {
            $existingCodexConfig = if ($null -ne $existingToolState -and $null -ne $existingToolState.PSObject.Properties['CodexConfig']) {
                $existingToolState.CodexConfig
            }
            else {
                $null
            }
            $codexConfig = Set-AiCliCodexFullAccess -Path $codexConfigPath -ExistingBackup $existingCodexConfig
            $codexConfigWritten = $true
        }

        if ($null -eq $existingTargetShim) {
            $packageExistedBeforeInstall = Test-AiCliPackageInstalled -Package $definition.Package
        }

        if ($definition.Tool -eq 'codex' -and $null -eq $existingTargetShim -and [bool]$packageExistedBeforeInstall) {
            $npmPrefix = Get-AiCliNpmPrefix
            $prefixTarget = Join-Path $npmPrefix ($definition.Command + '.cmd')
            $existingTargetShim = Test-AiCliExistingTargetShim -Target $prefixTarget -Paths $paths -RequireCodexShim
            if ($null -eq $existingTargetShim) {
                throw "The $($definition.Package) package is already installed, but its official npm shim could not be located. Refusing to mutate the existing package; repair the npm shim or PATH and retry."
            }
        }

        $packageCreated = ($null -eq $existingTargetShim -and $packageExistedBeforeInstall -eq $false)
        $targetWasExisting = ($null -ne $existingTargetShim)
        if ($null -ne $existingTargetShim) {
            $targetShim = $existingTargetShim
        }
        else {
            Install-AiCliPackage -Package $definition.Package
            $npmPrefix = Get-AiCliNpmPrefix
            $targetShim = Join-Path $npmPrefix ($definition.Command + '.cmd')
            if (-not (Test-Path -LiteralPath $targetShim -PathType Leaf)) {
                throw "The expected upstream npm shim was not created at '$targetShim'."
            }
            if ($definition.Tool -eq 'codex' -and -not (Test-AiCliCodexNpmShimContent -Target $targetShim)) {
                throw "The npm shim at '$targetShim' does not identify the official @openai/codex CLI."
            }
        }
        $packageCreated = (-not $targetWasExisting -and $packageExistedBeforeInstall -eq $false)

        $targetMatchesSavedState = $false
        if ($null -ne $existingToolState -and $null -ne $existingToolState.PSObject.Properties['TargetShim']) {
            try {
                $targetMatchesSavedState = [string]::Equals(
                    (Get-AiCliCanonicalPath $targetShim),
                    (Get-AiCliCanonicalPath ([string]$existingToolState.TargetShim)),
                    [StringComparison]::OrdinalIgnoreCase)
            }
            catch {
                $targetMatchesSavedState = $false
            }
        }
        if ($packageCreated) {
            $installedByBypass = $true
        }
        elseif ($null -ne $existingToolState) {
            $installedByBypass = [bool]$existingToolState.InstalledByBypass -and $targetMatchesSavedState
        }
        elseif ($targetWasExisting) {
            $installedByBypass = $false
        }
        else {
            $installedByBypass = -not [bool]$packageExistedBeforeInstall
        }

        $canonicalTarget = Get-AiCliCanonicalPath $targetShim
        $canonicalWrapper = Get-AiCliCanonicalPath $paths.Wrapper
        if ([string]::Equals($canonicalTarget, $canonicalWrapper, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The upstream npm shim and project wrapper paths must differ.'
        }
        if (Test-AiCliPathIsWithin -Path $canonicalTarget -Directory $paths.Bin) {
            throw 'The upstream npm shim cannot be inside the project wrapper directory.'
        }

        $wrapperContent = New-AiCliWrapperContent -Target $canonicalTarget -Arguments @($definition.Arguments)

        $toolStateData = [ordered]@{
            SchemaVersion = $script:AiCliSchemaVersion
            Tool = $definition.Tool
            Package = $definition.Package
            Command = $definition.Command
            TargetShim = $canonicalTarget
            WrapperPath = $canonicalWrapper
            Arguments = @($definition.Arguments)
            InstalledByBypass = [bool]$installedByBypass
        }
        if ($definition.Tool -eq 'codex') {
            $toolStateData.CodexConfig = $codexConfig
        }
        $toolState = [pscustomobject]$toolStateData

        Write-AiCliAtomicText -Path $paths.Wrapper -Text $wrapperContent -Encoding (New-Object System.Text.UTF8Encoding($false))
        $wrapperWritten = $true
        Write-AiCliJson -Path $paths.ToolState -Value $toolState
        $toolStateWritten = $true

        $pathChange = Add-AiCliPathEntry -Entry $paths.Bin
        $pathOwned = [bool]$pathChange.UserAdded
        if ($null -ne $existingGlobalState -and [bool]$existingGlobalState.UserPathAddedByBypass) {
            $pathOwned = $true
        }
        $globalState = [pscustomobject][ordered]@{
            SchemaVersion = $script:AiCliSchemaVersion
            WrapperDirectory = Get-AiCliCanonicalPath $paths.Bin
            UserPathAddedByBypass = [bool]$pathOwned
        }
        Write-AiCliJson -Path $paths.GlobalState -Value $globalState
        $globalStateWritten = $true

        if ($definition.Tool -eq 'codex' -and $null -ne $existingTargetShim) {
            Write-Host 'Codex is already installed; configured persistent Full Access and skipped npm.'
        }
        else {
            Write-Host "Installed $($definition.Command) wrapper with $($definition.Arguments -join ' ')."
        }
        Write-Warning 'This bypass mode disables normal approval protections. Use it only in an environment you trust.'
    }
    catch {
        $originalError = $_
        $rollbackErrors = New-Object System.Collections.Generic.List[string]

        if ($codexConfigWritten) {
            try { Restore-AiCliFileSnapshot -Path $codexConfigPath -Snapshot $codexConfigSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($globalStateWritten) {
            try { Restore-AiCliFileSnapshot -Path $paths.GlobalState -Snapshot $globalStateSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($null -ne $pathChange) {
            try { Undo-AiCliPathAddition -Change $pathChange } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($toolStateWritten) {
            try { Restore-AiCliFileSnapshot -Path $paths.ToolState -Snapshot $toolStateSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($wrapperWritten) {
            try { Restore-AiCliFileSnapshot -Path $paths.Wrapper -Snapshot $wrapperSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($packageCreated) {
            try { Uninstall-AiCliPackage -Package $definition.Package } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        try { Remove-AiCliEmptyDirectories } catch { $rollbackErrors.Add($_.Exception.Message) }

        if ($rollbackErrors.Count -gt 0) {
            throw "Installation failed: $($originalError.Exception.Message) Rollback also failed: $($rollbackErrors -join ' | ')"
        }
        throw $originalError
    }
}

function Uninstall-AiCliBypass {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'opencode')][string]$Tool,
        [switch]$KeepCli
    )

    Assert-AiCliWindows
    $definition = Get-AiCliDefinition -Tool $Tool
    $paths = Get-AiCliPaths -Tool $Tool
    $toolState = Read-AiCliJson -Path $paths.ToolState
    $globalState = Read-AiCliJson -Path $paths.GlobalState

    if ($null -ne $toolState) {
        Assert-AiCliToolState -State $toolState -Definition $definition -Paths $paths
    }
    if ($null -ne $globalState) {
        Assert-AiCliGlobalState -State $globalState -Paths $paths
    }

    # Validate and snapshot every local artifact before changing Codex config or
    # touching npm. Package removal is the final transaction step.
    if ((Test-Path -LiteralPath $paths.Wrapper) -and -not (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf)) {
        throw "Refusing to remove non-file wrapper path '$($paths.Wrapper)'."
    }
    $wrapperSnapshot = Get-AiCliFileSnapshot -Path $paths.Wrapper
    $toolStateSnapshot = Get-AiCliFileSnapshot -Path $paths.ToolState
    $globalStateSnapshot = Get-AiCliFileSnapshot -Path $paths.GlobalState
    $originalUserPath = Get-AiCliUserPath
    $originalProcessPath = if ($null -eq $env:Path) { '' } else { $env:Path }
    $processPathKey = Get-AiCliPathOwnershipKey $paths.Bin
    $processPathOwnedBefore = $script:AiCliProcessPathOwnership.ContainsKey($processPathKey)
    $codexConfigSnapshot = $null
    $codexConfigPath = $null
    $codexConfigChangeAttempted = $false
    $wrapperChangeAttempted = $false
    $toolStateChangeAttempted = $false
    $pathChangeAttempted = $false
    $globalStateChangeAttempted = $false

    try {
        if ($definition.Tool -eq 'codex' -and $null -ne $toolState -and $null -ne $toolState.PSObject.Properties['CodexConfig']) {
            $codexConfigPath = Get-AiCliFullPath ([string]$toolState.CodexConfig.Path)
            $codexConfigSnapshot = Get-AiCliFileSnapshot -Path $codexConfigPath
            $codexConfigChangeAttempted = $true
            Restore-AiCliCodexConfig -Backup $toolState.CodexConfig
        }

        if (Test-Path -LiteralPath $paths.Wrapper) {
            $wrapperChangeAttempted = $true
            Remove-Item -LiteralPath $paths.Wrapper -Force
        }
        if (Test-Path -LiteralPath $paths.ToolState) {
            $toolStateChangeAttempted = $true
            Remove-Item -LiteralPath $paths.ToolState -Force
        }

        if (-not (Test-AiCliAnyKnownWrapper -BinDirectory $paths.Bin)) {
            $removeUserPath = ($null -ne $globalState -and [bool]$globalState.UserPathAddedByBypass)
            $removeProcessPath = $script:AiCliProcessPathOwnership.ContainsKey($processPathKey)
            if ($removeUserPath -or $removeProcessPath) {
                $pathChangeAttempted = $true
                Remove-AiCliPathEntry -Entry $paths.Bin -RemoveUser:$removeUserPath -RemoveProcess:$removeProcessPath
            }
            if (Test-Path -LiteralPath $paths.GlobalState -PathType Leaf) {
                $globalStateChangeAttempted = $true
                Remove-Item -LiteralPath $paths.GlobalState -Force
            }
            Remove-AiCliEmptyDirectories
        }

        if ($null -ne $toolState -and [bool]$toolState.InstalledByBypass -and -not $KeepCli) {
            Uninstall-AiCliPackage -Package $definition.Package
        }
    }
    catch {
        $originalError = $_
        $rollbackErrors = New-Object System.Collections.Generic.List[string]

        if ($globalStateChangeAttempted) {
            try { Restore-AiCliFileSnapshot -Path $paths.GlobalState -Snapshot $globalStateSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($pathChangeAttempted) {
            try { Set-AiCliUserPath -Value $originalUserPath } catch { $rollbackErrors.Add($_.Exception.Message) }
            try { $env:Path = $originalProcessPath } catch { $rollbackErrors.Add($_.Exception.Message) }
            if ($processPathOwnedBefore) {
                $script:AiCliProcessPathOwnership[$processPathKey] = $true
            }
            else {
                $script:AiCliProcessPathOwnership.Remove($processPathKey)
            }
        }
        if ($toolStateChangeAttempted) {
            try { Restore-AiCliFileSnapshot -Path $paths.ToolState -Snapshot $toolStateSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($wrapperChangeAttempted) {
            try { Restore-AiCliFileSnapshot -Path $paths.Wrapper -Snapshot $wrapperSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if ($codexConfigChangeAttempted -and $null -ne $codexConfigSnapshot) {
            try { Restore-AiCliFileSnapshot -Path $codexConfigPath -Snapshot $codexConfigSnapshot } catch { $rollbackErrors.Add($_.Exception.Message) }
        }

        if ($rollbackErrors.Count -gt 0) {
            throw "Uninstall failed: $($originalError.Exception.Message) Rollback also failed: $($rollbackErrors -join ' | ')"
        }
        throw $originalError
    }

    Write-Host "Removed the ai-cli-bypass wrapper for $($definition.Command)."
}
