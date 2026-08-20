$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
$script:Readmes = @(
    (Join-Path $script:RepositoryRoot 'README.md'),
    (Join-Path $script:RepositoryRoot 'docs\README.zh-TW.md'),
    (Join-Path $script:RepositoryRoot 'docs\README.en.md')
)
$script:WindowsScripts = @(
    'install-claude-windows.ps1', 'uninstall-claude-windows.ps1',
    'install-codex-windows.ps1', 'uninstall-codex-windows.ps1',
    'install-opencode-windows.ps1', 'uninstall-opencode-windows.ps1'
)
$script:LinuxScripts = @(
    'install-claude-root.sh', 'reset-claude.sh',
    'install-codex-root.sh', 'reset-codex.sh',
    'install-opencode-root.sh', 'reset-opencode.sh'
)
$script:Packages = @('@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai')
$script:Arguments = @(
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
    '--auto'
)
$script:OrganizedScriptPaths = @(
    'scripts\install\windows\install-claude-windows.ps1',
    'scripts\install\windows\install-codex-windows.ps1',
    'scripts\install\windows\install-opencode-windows.ps1',
    'scripts\uninstall\windows\uninstall-claude-windows.ps1',
    'scripts\uninstall\windows\uninstall-codex-windows.ps1',
    'scripts\uninstall\windows\uninstall-opencode-windows.ps1',
    'scripts\install\linux\install-claude-root.sh',
    'scripts\install\linux\install-codex-root.sh',
    'scripts\install\linux\install-opencode-root.sh',
    'scripts\uninstall\linux\reset-claude.sh',
    'scripts\uninstall\linux\reset-codex.sh',
    'scripts\uninstall\linux\reset-opencode.sh',
    'scripts\continuation\start-watchdog.ps1',
    'scripts\continuation\stop-watchdog.ps1',
    'scripts\continuation\install-watchdog.ps1',
    'scripts\continuation\uninstall-watchdog.ps1'
)

function Assert-Documentation {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw $Message
    }
}

function Read-Utf8 {
    param([string]$Path)

    Assert-Documentation (Test-Path -LiteralPath $Path -PathType Leaf) "Missing documentation file: $Path"
    return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-LinksResolve {
    param([string]$Path, [string]$Text)

    $pattern = '(?m)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)'
    foreach ($match in [regex]::Matches($Text, $pattern)) {
        $target = [string]$match.Groups[1].Value
        if ($target -match '^(?i:[a-z][a-z0-9+.-]*:|//|#)') {
            continue
        }
        $targetPath = $target.Split('#')[0]
        if ([string]::IsNullOrWhiteSpace($targetPath)) {
            continue
        }
        $resolved = Join-Path (Split-Path -Parent $Path) $targetPath
        Assert-Documentation (Test-Path -LiteralPath $resolved) "Broken relative link in $Path`: $target"
    }
}

foreach ($relativePath in $script:WindowsScripts + $script:LinuxScripts + $script:OrganizedScriptPaths) {
    Assert-Documentation (Test-Path -LiteralPath (Join-Path $script:RepositoryRoot $relativePath) -PathType Leaf) "Missing organized or compatibility script: $relativePath"
}

foreach ($readmePath in $script:Readmes) {
    $readme = Read-Utf8 $readmePath
    Assert-Documentation (([regex]::Matches($readme, '(?m)^```')).Count % 2 -eq 0) "Unbalanced Markdown fences in $readmePath"
    Assert-Documentation ($readme -match '(?i)Node\.js' -and $readme -match '(?i)npm') "Node.js/npm prerequisites missing in $readmePath"
    Assert-Documentation ($readme -match '(?i)PowerShell 5\.1') "PowerShell 5.1 prerequisite missing in $readmePath"
    Assert-Documentation ($readme -match '(?i)MIT License') "MIT license mention missing in $readmePath"
    Assert-Documentation ($readme -match '\[!WARNING\]') "Security warning missing in $readmePath"
    Assert-Documentation ($readme -match '(?i)Windows' -and $readme -match '(?i)Linux') "Platform sections missing in $readmePath"

    foreach ($name in $script:WindowsScripts + $script:LinuxScripts + $script:Packages + $script:Arguments) {
        Assert-Documentation ($readme.Contains($name)) "'$name' is missing in $readmePath"
    }
    foreach ($name in @('approval_policy', 'sandbox_mode', 'danger-full-access')) {
        Assert-Documentation ($readme.Contains($name)) "Codex Full Access setting '$name' is missing in $readmePath"
    }
    Assert-Documentation ($readme -match '(?i)persistent|persist|持久|持續') "Persistent Codex configuration is not documented in $readmePath"
    Assert-Documentation ($readme -match '(?i)skips?\s+npm|npm.*skip|跳過.*npm|略過.*npm') "The repeat-install npm fast path is not documented in $readmePath"
    Assert-Documentation ($readme.Contains('install-watchdog.ps1') -and $readme.Contains('uninstall-watchdog.ps1')) "Watchdog install/uninstall scripts are missing in $readmePath"
    Assert-Documentation ($readme -match '(?i)-Startup|启动|啟動') "Watchdog startup-task control is missing in $readmePath"
    Assert-Documentation ($readme -match '(?i)install-manifest\.json|ownership manifest|所有權 manifest|所有权 manifest') "Watchdog ownership boundary is missing in $readmePath"
    Assert-Documentation ($readme.Contains('/api/watchdog/start') -and $readme.Contains('/api/watchdog/stop') -and $readme.Contains('/api/uninstall')) "WebUI lifecycle routes are missing in $readmePath"
    Assert-LinksResolve -Path $readmePath -Text $readme
}

$license = Join-Path $script:RepositoryRoot 'LICENSE'
Assert-Documentation (Test-Path -LiteralPath $license -PathType Leaf) 'LICENSE is missing.'
$licenseText = [System.IO.File]::ReadAllText($license, (New-Object System.Text.UTF8Encoding($false)))
Assert-Documentation ($licenseText.Contains('MIT License')) 'LICENSE does not contain MIT License.'
Assert-Documentation ($licenseText.Contains('Copyright (c) 2026 dieWehmut')) 'LICENSE copyright line is incorrect.'

Write-Output 'All documentation tests passed.'
