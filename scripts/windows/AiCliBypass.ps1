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
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if ($replaceSucceeded -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Write-AiCliAtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [System.Text.Encoding]$Encoding = (New-Object System.Text.UTF8Encoding($false))
    )

    Write-AiCliAtomicBytes -Path $Path -Bytes $Encoding.GetBytes($Text)
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
    $wrapperWritten = $false
    $toolStateWritten = $false
    $globalStateWritten = $false
    $packageCreated = $false
    $pathChange = $null

    try {
        if ($null -ne $existingToolState) {
            $installedByBypass = [bool]$existingToolState.InstalledByBypass
        }
        else {
            $packageExisted = Test-AiCliPackageInstalled -Package $definition.Package
            $installedByBypass = -not $packageExisted
        }

        $packageCreated = ($null -eq $existingToolState -and $installedByBypass)
        Install-AiCliPackage -Package $definition.Package

        $npmPrefix = Get-AiCliNpmPrefix
        $targetShim = Join-Path $npmPrefix ($definition.Command + '.cmd')
        if (-not (Test-Path -LiteralPath $targetShim -PathType Leaf)) {
            throw "The expected upstream npm shim was not created at '$targetShim'."
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
        $toolState = [pscustomobject][ordered]@{
            SchemaVersion = $script:AiCliSchemaVersion
            Tool = $definition.Tool
            Package = $definition.Package
            Command = $definition.Command
            TargetShim = $canonicalTarget
            WrapperPath = $canonicalWrapper
            Arguments = @($definition.Arguments)
            InstalledByBypass = [bool]$installedByBypass
        }

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

        Write-Host "Installed $($definition.Command) wrapper with $($definition.Arguments -join ' ')."
        Write-Warning 'This bypass mode disables normal approval protections. Use it only in an environment you trust.'
    }
    catch {
        $originalError = $_
        $rollbackErrors = New-Object System.Collections.Generic.List[string]

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

    if ($null -ne $toolState -and [bool]$toolState.InstalledByBypass -and -not $KeepCli) {
        Uninstall-AiCliPackage -Package $definition.Package
    }

    if (Test-Path -LiteralPath $paths.Wrapper) {
        if (-not (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf)) {
            throw "Refusing to remove non-file wrapper path '$($paths.Wrapper)'."
        }
        Remove-Item -LiteralPath $paths.Wrapper -Force
    }
    if (Test-Path -LiteralPath $paths.ToolState) {
        if (-not (Test-Path -LiteralPath $paths.ToolState -PathType Leaf)) {
            throw "Refusing to remove non-file state path '$($paths.ToolState)'."
        }
        Remove-Item -LiteralPath $paths.ToolState -Force
    }

    if (-not (Test-AiCliAnyKnownWrapper -BinDirectory $paths.Bin)) {
        $removeUserPath = ($null -ne $globalState -and [bool]$globalState.UserPathAddedByBypass)
        $processPathKey = Get-AiCliPathOwnershipKey $paths.Bin
        $removeProcessPath = $script:AiCliProcessPathOwnership.ContainsKey($processPathKey)
        if ($removeUserPath -or $removeProcessPath) {
            Remove-AiCliPathEntry -Entry $paths.Bin -RemoveUser:$removeUserPath -RemoveProcess:$removeProcessPath
        }
        if (Test-Path -LiteralPath $paths.GlobalState -PathType Leaf) {
            Remove-Item -LiteralPath $paths.GlobalState -Force
        }
        Remove-AiCliEmptyDirectories
    }

    Write-Host "Removed the ai-cli-bypass wrapper for $($definition.Command)."
}
