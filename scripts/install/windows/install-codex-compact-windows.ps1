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

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ─────────────────────────────────────────────────────────────────────────────
# Codex non-GPT compaction installer
#
# Codex picks its compaction strategy from the provider name, so a custom
# provider called "OpenAI" makes it ask the gateway for OpenAI-only remote
# compaction v2. Third-party gateways answer with ordinary message items and the
# turn dies with "remote compaction v2 expected exactly one compaction output
# item, got 0 from 1 output items". Declaring
# capabilities.remote_compaction = "unsupported" sends compaction back to the
# local summariser, which works for Gemini, Claude, DeepSeek and friends.
#
# The edit itself lives in scripts/install/codex_compact_config.py so Windows
# and Linux cannot drift apart; this script only finds Python, fetches that
# file, and runs it. On top of the config change it installs the
# codex-context-handoff plugin and turns its desktop popups off, so a handoff
# document is written before the context is compacted.
# ─────────────────────────────────────────────────────────────────────────────

$CoreUrl = 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/scripts/install/codex_compact_config.py'
$MarketplaceSource = 'Sunwaycoser/codex-context-handoff'
$PluginId = 'codex-context-handoff@codex-context-handoff'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ChildExitCode {
    # $LASTEXITCODE is an automatic GLOBAL variable. Assigning to it at script
    # scope only creates a shadow copy that native calls never update, so the
    # real value is always read through the global scope here.
    $variable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    if ($null -eq $variable) { return 0 }
    return [int]$variable.Value
}
function Get-CodexHomePath {
    $codexHome = $env:CODEX_HOME
    if ([string]::IsNullOrWhiteSpace($codexHome)) {
        if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            throw 'Neither CODEX_HOME nor USERPROFILE is set, so the Codex config path is unknown.'
        }
        $codexHome = Join-Path $env:USERPROFILE '.codex'
    }
    return [System.IO.Path]::GetFullPath($codexHome)
}

function Get-TargetConfigPath {
    param([string]$Explicit)
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        return [System.IO.Path]::GetFullPath($Explicit)
    }
    return Join-Path (Get-CodexHomePath) 'config.toml'
}

function Find-Python {
    # py -3 first: it is the launcher that resolves the newest 3.x install.
    $candidates = @(
        @{ Name = 'py'; Prefix = @('-3') },
        @{ Name = 'python'; Prefix = @() },
        @{ Name = 'python3'; Prefix = @() }
    )
    $probe = 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'
    foreach ($candidate in $candidates) {
        # Several installs can share a name on PATH; indexing .Source on that
        # array would build one bogus path, so exactly one match is taken.
        $command = @(Get-Command $candidate.Name -CommandType Application -ErrorAction SilentlyContinue) |
            Select-Object -First 1
        if ($null -eq $command) {
            continue
        }
        $source = [string]$command.Source
        if ([string]::IsNullOrWhiteSpace($source)) {
            continue
        }
        $arguments = @($candidate.Prefix) + @('-c', $probe)
        try {
            & $source @arguments 2>&1 | Out-Null
        }
        catch {
            continue
        }
        if ((Get-ChildExitCode) -eq 0) {
            return [pscustomobject]@{ Exe = $source; Prefix = @($candidate.Prefix) }
        }
    }
    return $null
}

function Get-CorePath {
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $local = Join-Path (Split-Path -Parent $PSScriptRoot) 'codex_compact_config.py'
        if (Test-Path -LiteralPath $local -PathType Leaf) {
            return $local
        }
    }
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-compact-core-' + [guid]::NewGuid().ToString('N') + '.py')
    $text = [string](Invoke-RestMethod -Uri $CoreUrl -UseBasicParsing)
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "Downloaded the compaction core from '$CoreUrl' but it was empty."
    }
    [System.IO.File]::WriteAllText($temporary, $text, $Utf8NoBom)
    return $temporary
}

function Disable-HandoffPopups {
    # The plugin shows a native Windows message box per reminder. Turning
    # "notify" off keeps the plain-text reminder and the handoff document.
    $handoffPath = Join-Path (Get-CodexHomePath) 'codex-handoff.json'
    $settings = @{}
    if (Test-Path -LiteralPath $handoffPath -PathType Leaf) {
        try {
            $existing = [System.IO.File]::ReadAllText($handoffPath, $Utf8NoBom) | ConvertFrom-Json
            foreach ($property in $existing.PSObject.Properties) {
                $settings[$property.Name] = $property.Value
            }
        }
        catch {
            Write-Warning "Could not parse $handoffPath; rewriting it with defaults. ($($_.Exception.Message))"
            $settings = @{}
        }
    }
    if ($settings.ContainsKey('notify') -and $settings['notify'] -eq $false) {
        Write-Host "  - popups already disabled in $handoffPath"
        return
    }
    $settings['notify'] = $false
    $json = ConvertTo-Json -InputObject $settings -Depth 8
    [System.IO.File]::WriteAllText($handoffPath, $json + [Environment]::NewLine, $Utf8NoBom)
    Write-Host "  - disabled codex-context-handoff popups in $handoffPath"
}

function Install-ContextHandoff {
    # codex shows up several times on PATH here (this project's wrapper, npm's
    # codex.cmd and npm's extension-less shell script). Only one runnable form
    # is used: joining them into a single string yields a command that does not
    # exist.
    # Not $matches: that name is the automatic variable -match writes to, and the
    # filter below matches, so it would overwrite the list mid-enumeration.
    $codexCandidates = @(Get-Command 'codex' -CommandType Application -ErrorAction SilentlyContinue)
    if ($codexCandidates.Count -eq 0) {
        Write-Host '  - codex is not on PATH, so the codex-context-handoff plugin was skipped'
        return
    }
    $codex = $codexCandidates | Where-Object { ([string]$_.Source) -match '\.(exe|cmd|bat)$' } | Select-Object -First 1
    if ($null -eq $codex) {
        $codex = $codexCandidates | Select-Object -First 1
    }
    $codexPath = [string]$codex.Source
    # `codex plugin add` materialises the plugin under the cache directory, which
    # is a cheaper and quieter "is it installed" probe than parsing `plugin list`.
    $pluginRoot = Join-Path (Get-CodexHomePath) 'plugins\cache\codex-context-handoff'
    if (Test-Path -LiteralPath $pluginRoot -PathType Container) {
        Write-Host '  - codex-context-handoff is already installed'
        try { Disable-HandoffPopups } catch { Write-Warning "Could not update codex-handoff.json: $($_.Exception.Message)" }
        return
    }
    Write-Host 'Installing the codex-context-handoff plugin (pre-compaction handoff notes)'
    try {
        & $codexPath plugin marketplace add $MarketplaceSource 2>&1 | Out-Null
        $installOutput = ("" + (& $codexPath plugin add $PluginId 2>&1 | Out-String)).Trim()
        if ((Get-ChildExitCode) -ne 0) {
            Write-Warning "Could not install $PluginId. The config patch is still applied."
            @($installOutput -split "`r?`n" | Where-Object { $_.Trim() }) |
                Select-Object -Last 3 |
                ForEach-Object { Write-Host "      $_" }
            return
        }
        Write-Host '  - plugin installed'
        Disable-HandoffPopups
    }
    catch {
        Write-Warning "Plugin setup failed: $($_.Exception.Message). The config patch is still applied."
    }
}

$mode = if ($Revert) { 'revert' } else { 'apply' }
$configPath = Get-TargetConfigPath -Explicit $Config

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Host "Codex config not found at $configPath" -ForegroundColor Red
    Write-Host 'Start Codex once so it writes the file, or point the script at one with -Config.'
    exit 1
}

$python = Find-Python
if ($null -eq $python) {
    Write-Host 'Python 3.8 or newer was not found, and the config patcher needs it.' -ForegroundColor Yellow
    Write-Host 'Install it once, then re-run this script:'
    Write-Host '  winget install --id Python.Python.3.12 -e'
    Write-Host '  (or)  https://www.python.org/downloads/windows/'
    exit 1
}

$core = Get-CorePath
$coreArguments = @($python.Prefix) + @('-X', 'utf8', $core, $mode, '--config', $configPath)
$ratio = $LimitRatio.ToString([System.Globalization.CultureInfo]::InvariantCulture)
if ($DryRun) { $coreArguments += '--dry-run' }
if ($SkipValidation) { $coreArguments += '--skip-validation' }
if ($mode -eq 'apply') {
    $coreArguments += @('--limit-ratio', $ratio)
    if ($NoAutoLimit) { $coreArguments += '--no-auto-limit' }
}

& $python.Exe @coreArguments
$status = Get-ChildExitCode
if ($status -ne 0) {
    exit $status
}

if ($mode -eq 'apply' -and -not $DryRun -and -not $SkipPlugin) {
    Install-ContextHandoff
}

Write-Host ''
if ($mode -eq 'revert') {
    Write-Host 'Reverted. Restart Codex so it reloads config.toml.'
}
elseif ($DryRun) {
    Write-Host 'Dry run only: config.toml was not modified.'
}
else {
    Write-Host 'Next steps:'
    Write-Host '  1. Restart Codex so it reloads config.toml.'
    Write-Host '  2. In the Codex TUI run  /hooks  once and trust the codex-context-handoff hooks.'
    Write-Host '  3. To undo, run the same installer again with -Revert.'
}
exit 0
