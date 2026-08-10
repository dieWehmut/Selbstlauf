$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Passed = 0
$script:Failed = 0
$script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
$script:CorePath = Join-Path $script:RepositoryRoot 'scripts\windows\AiCliBypass.ps1'
$script:PowerShellExe = (Get-Command powershell.exe -CommandType Application).Source
$script:RealUserPathBefore = [Environment]::GetEnvironmentVariable('Path', 'User')
$script:ExpectedRemoteUrl = 'https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/scripts/windows/AiCliBypass.ps1'
$script:EnvironmentNames = @(
    'AI_CLI_BYPASS_HOME',
    'AI_CLI_BYPASS_NPM',
    'AI_CLI_BYPASS_USER_PATH_FILE',
    'FAKE_NPM_PREFIX',
    'FAKE_NPM_LOG',
    'FAKE_NPM_PACKAGE_PRESENT',
    'FAKE_NPM_FAIL_INSTALL',
    'FAKE_NPM_FAIL_UNINSTALL',
    'FAKE_CLI_EXIT',
    'FAKE_CLI_LOG_DIR',
    'FAKE_REMOTE_CORE',
    'FAKE_REMOTE_ENTRY',
    'FAKE_REMOTE_URL_LOG',
    'AI_CLI_UNUSED',
    'Path'
)

$script:EntryPoints = @(
    'install-claude-windows.ps1',
    'uninstall-claude-windows.ps1',
    'install-codex-windows.ps1',
    'uninstall-codex-windows.ps1',
    'install-opencode-windows.ps1',
    'uninstall-opencode-windows.ps1'
)

$script:ExpectedTools = [ordered]@{
    claude = [pscustomobject]@{
        Package = '@anthropic-ai/claude-code'
        Command = 'claude'
        Argument = '--dangerously-skip-permissions'
    }
    codex = [pscustomobject]@{
        Package = '@openai/codex'
        Command = 'codex'
        Argument = '--dangerously-bypass-approvals-and-sandbox'
    }
    opencode = [pscustomobject]@{
        Package = 'opencode-ai'
        Command = 'opencode'
        Argument = '--auto'
    }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)

    if ($Expected -ne $Actual) {
        throw "$Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-SequenceEqual {
    param(
        [object[]]$Expected,
        [object[]]$Actual,
        [string]$Message
    )

    Assert-Equal $Expected.Count $Actual.Count "$Message (count)"
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        Assert-Equal ([string]$Expected[$index]) ([string]$Actual[$index]) "$Message (index $index)"
    }
}

function Assert-Throws {
    param(
        [scriptblock]$Body,
        [string]$Message,
        [string]$ErrorPattern = '*'
    )

    $caught = $null
    try {
        & $Body
    }
    catch {
        $caught = $_
    }

    Assert-True ($null -ne $caught) $Message
    if ($ErrorPattern -ne '*') {
        Assert-True ($caught.Exception.Message -like $ErrorPattern) "$Message`nUnexpected error: $($caught.Exception.Message)"
    }
}

function Invoke-Test {
    param([string]$Name, [scriptblock]$Body)

    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name"
    }
    catch {
        $script:Failed++
        Write-Host "FAIL $Name"
        Write-Host $_
    }
}

function Set-ProcessEnvironmentValue {
    param([string]$Name, [AllowNull()][string]$Value)

    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Write-TestText {
    param(
        [string]$Path,
        [string]$Text,
        [System.Text.Encoding]$Encoding = ([System.Text.Encoding]::Default)
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $parent -Force
    }
    [System.IO.File]::WriteAllText($Path, $Text, $Encoding)
}

function New-TestContext {
    param([switch]$PercentInPrefix)

    $savedEnvironment = @{}
    foreach ($name in $script:EnvironmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }

    $unicodeName = ([string][char]0x6D4B) + ([string][char]0x8BD5)
    $rootName = 'ai cli bypass {0} {1}' -f $unicodeName, ([Guid]::NewGuid().ToString('N'))
    $root = Join-Path ([System.IO.Path]::GetTempPath()) $rootName
    $fakeBin = Join-Path $root 'fake npm bin'
    $testHome = Join-Path $root 'local app data\ai-cli-bypass'
    $prefixName = 'npm prefix {0}' -f $unicodeName
    if ($PercentInPrefix) {
        $prefixName += ' %AI_CLI_UNUSED%'
    }
    $prefix = Join-Path $root $prefixName
    $npmLog = Join-Path $root 'npm calls.log'
    $cliLogDirectory = Join-Path $root 'cli logs'
    $userPathFile = Join-Path $root 'persisted user path.txt'
    $fakeNpm = Join-Path $fakeBin 'npm.cmd'

    $null = New-Item -ItemType Directory -Path $fakeBin, $testHome, $prefix, $cliLogDirectory -Force
    Write-TestText -Path $npmLog -Text '' -Encoding (New-Object System.Text.UTF8Encoding($false))
    Write-TestText -Path $userPathFile -Text 'C:\Existing Tool;C:\Unrelated' -Encoding (New-Object System.Text.UTF8Encoding($false))

    $fakeNpmContent = @'
@echo off
setlocal DisableDelayedExpansion
>>"%FAKE_NPM_LOG%" echo %*
if /I "%~1"=="list" exit /b %FAKE_NPM_PACKAGE_PRESENT%
if /I "%~1"=="install" if "%FAKE_NPM_FAIL_INSTALL%"=="1" exit /b 41
if /I "%~1"=="uninstall" if "%FAKE_NPM_FAIL_UNINSTALL%"=="1" exit /b 42
if /I "%~1"=="prefix" echo %FAKE_NPM_PREFIX%
exit /b 0
'@
    Write-TestText -Path $fakeNpm -Text ($fakeNpmContent -replace "(?<!`r)`n", "`r`n")

    foreach ($toolName in $script:ExpectedTools.Keys) {
        $command = $script:ExpectedTools[$toolName].Command
        $shimPath = Join-Path $prefix ($command + '.cmd')
        $shimContent = @"
@echo off
setlocal DisableDelayedExpansion
>>"%FAKE_CLI_LOG_DIR%\$command-args.txt" echo %*
exit /b %FAKE_CLI_EXIT%
"@
        Write-TestText -Path $shimPath -Text ($shimContent -replace "(?<!`r)`n", "`r`n")
    }

    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_HOME' $testHome
    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_NPM' $fakeNpm
    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_USER_PATH_FILE' $userPathFile
    Set-ProcessEnvironmentValue 'FAKE_NPM_PREFIX' $prefix
    Set-ProcessEnvironmentValue 'FAKE_NPM_LOG' $npmLog
    Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '1'
    Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '0'
    Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '0'
    Set-ProcessEnvironmentValue 'FAKE_CLI_EXIT' '0'
    Set-ProcessEnvironmentValue 'FAKE_CLI_LOG_DIR' $cliLogDirectory
    Set-ProcessEnvironmentValue 'FAKE_REMOTE_CORE' $null
    Set-ProcessEnvironmentValue 'FAKE_REMOTE_ENTRY' $null
    Set-ProcessEnvironmentValue 'FAKE_REMOTE_URL_LOG' $null
    Set-ProcessEnvironmentValue 'AI_CLI_UNUSED' $null

    $systemPath = Join-Path $env:SystemRoot 'System32'
    Set-ProcessEnvironmentValue 'Path' ($fakeBin + ';' + $systemPath)

    return [pscustomobject]@{
        Root = $root
        Home = $testHome
        Prefix = $prefix
        FakeNpm = $fakeNpm
        NpmLog = $npmLog
        CliLogDirectory = $cliLogDirectory
        UserPathFile = $userPathFile
        SavedEnvironment = $savedEnvironment
    }
}

function Remove-TestContext {
    param($Context)

    foreach ($name in $script:EnvironmentNames) {
        Set-ProcessEnvironmentValue $name $Context.SavedEnvironment[$name]
    }

    if (Test-Path -LiteralPath $Context.Root) {
        Remove-Item -LiteralPath $Context.Root -Recurse -Force
    }
}

function Get-NpmLogLines {
    param($Context)

    if (-not (Test-Path -LiteralPath $Context.NpmLog)) {
        return @()
    }

    return @(
        [System.IO.File]::ReadAllLines($Context.NpmLog) |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -ne '' }
    )
}

function Assert-NpmLogContains {
    param($Context, [string]$Expected)

    $lines = @(Get-NpmLogLines $Context)
    Assert-True ($lines -contains $Expected) "npm log did not contain '$Expected'. Actual: $($lines -join ' | ')"
}

function Get-JsonFile {
    param([string]$Path)

    return ([System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json)
}

function Get-NormalizedPathMatchCount {
    param([string]$PathValue, [string]$Entry)

    $count = 0
    foreach ($candidate in @($PathValue -split ';')) {
        if ((Normalize-AiCliPathEntry $candidate) -eq (Normalize-AiCliPathEntry $Entry)) {
            $count++
        }
    }
    return $count
}

function Invoke-CmdFile {
    param(
        [string]$CommandPath,
        [string]$Arguments,
        [string]$RunnerDirectory
    )

    $null = $RunnerDirectory
    & $env:ComSpec /d /c "call `"$CommandPath`" $Arguments"
    return $LASTEXITCODE
}

function Test-PowerShellSyntax {
    $paths = @($script:CorePath)
    $paths += @($script:EntryPoints | ForEach-Object { Join-Path $script:RepositoryRoot $_ })

    foreach ($path in $paths) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Missing production PowerShell file: $path"
        $tokens = $null
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        Assert-Equal 0 @($errors).Count "PowerShell parser errors in $path`: $($errors -join '; ')"
    }
}

function Test-ToolDefinitions {
    foreach ($toolName in $script:ExpectedTools.Keys) {
        $expected = $script:ExpectedTools[$toolName]
        $actual = Get-AiCliDefinition -Tool $toolName
        Assert-Equal $toolName $actual.Tool "Tool name for $toolName"
        Assert-Equal $expected.Package $actual.Package "Package for $toolName"
        Assert-Equal $expected.Command $actual.Command "Command for $toolName"
        Assert-SequenceEqual @($expected.Argument) @($actual.Arguments) "Arguments for $toolName"
    }
    Assert-Throws { Get-AiCliDefinition -Tool 'opencode-beta' } 'OpenCode beta must not be supported.' '*Unsupported tool*'
}

function Test-AllToolInstalls {
    foreach ($toolName in $script:ExpectedTools.Keys) {
        $context = New-TestContext
        try {
            $expected = $script:ExpectedTools[$toolName]
            $upstream = Join-Path $context.Prefix ($expected.Command + '.cmd')
            $upstreamBefore = [System.IO.File]::ReadAllBytes($upstream)

            Install-AiCliBypass -Tool $toolName

            $paths = Get-AiCliPaths -Tool $toolName
            Assert-True (Test-Path -LiteralPath $upstream -PathType Leaf) "Upstream shim was removed for $toolName."
            Assert-SequenceEqual $upstreamBefore ([System.IO.File]::ReadAllBytes($upstream)) "Upstream shim changed for $toolName"
            Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) "Wrapper missing for $toolName."
            Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) "Tool state missing for $toolName."
            Assert-True (Test-Path -LiteralPath $paths.GlobalState -PathType Leaf) "Global state missing for $toolName."

            $state = Get-JsonFile $paths.ToolState
            Assert-SequenceEqual @('SchemaVersion', 'Tool', 'Package', 'Command', 'TargetShim', 'WrapperPath', 'Arguments', 'InstalledByBypass') @($state.PSObject.Properties.Name) "Tool state properties for $toolName"
            Assert-Equal 1 $state.SchemaVersion "Tool schema for $toolName"
            Assert-Equal $toolName $state.Tool "Tool state name for $toolName"
            Assert-Equal $expected.Package $state.Package "Tool state package for $toolName"
            Assert-Equal $expected.Command $state.Command "Tool state command for $toolName"
            Assert-Equal ([System.IO.Path]::GetFullPath($upstream)) $state.TargetShim "Target path for $toolName"
            Assert-Equal ([System.IO.Path]::GetFullPath($paths.Wrapper)) $state.WrapperPath "Wrapper path for $toolName"
            Assert-SequenceEqual @($expected.Argument) @($state.Arguments) "State arguments for $toolName"
            Assert-True ([bool]$state.InstalledByBypass) "Fresh package ownership missing for $toolName."

            $globalState = Get-JsonFile $paths.GlobalState
            Assert-SequenceEqual @('SchemaVersion', 'WrapperDirectory', 'UserPathAddedByBypass') @($globalState.PSObject.Properties.Name) "Global state properties for $toolName"
            Assert-Equal 1 $globalState.SchemaVersion "Global schema for $toolName"
            Assert-Equal ([System.IO.Path]::GetFullPath($paths.Bin)) $globalState.WrapperDirectory "Wrapper directory state for $toolName"
            Assert-True ([bool]$globalState.UserPathAddedByBypass) "PATH ownership missing for $toolName."

            $stateBytes = [System.IO.File]::ReadAllBytes($paths.ToolState)
            $hasBom = $stateBytes.Length -ge 3 -and $stateBytes[0] -eq 0xEF -and $stateBytes[1] -eq 0xBB -and $stateBytes[2] -eq 0xBF
            Assert-True (-not $hasBom) "Tool state must be UTF-8 without BOM for $toolName."

            $wrapperText = [System.IO.File]::ReadAllText($paths.Wrapper, (New-Object System.Text.UTF8Encoding($false)))
            Assert-True ($wrapperText.Contains('setlocal DisableDelayedExpansion')) "Delayed expansion was not disabled for $toolName."
            Assert-True ($wrapperText.Contains($expected.Argument + ' %*')) "Injected argument ordering is wrong for $toolName."
            Assert-True (-not [System.Text.RegularExpressions.Regex]::IsMatch($wrapperText, "(?<!`r)`n")) "Wrapper contains non-CRLF lines for $toolName."
            Assert-NpmLogContains $context ('list --global --depth=0 ' + $expected.Package)
            Assert-NpmLogContains $context ('install --global ' + $expected.Package)
        }
        finally {
            Remove-TestContext $context
        }
    }
}

function Test-WrapperForwarding {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'FAKE_CLI_EXIT' '37'
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'

        $exitCode = Invoke-CmdFile -CommandPath $paths.Wrapper -Arguments 'alpha "two words"' -RunnerDirectory $context.Root
        Assert-Equal 37 $exitCode 'Wrapper did not propagate the target exit code.'

        $argumentLog = Join-Path $context.CliLogDirectory 'codex-args.txt'
        Assert-True (Test-Path -LiteralPath $argumentLog -PathType Leaf) 'Codex target was not called.'
        $arguments = [System.IO.File]::ReadAllText($argumentLog, [System.Text.Encoding]::Default).Trim()
        Assert-Equal '--dangerously-bypass-approvals-and-sandbox alpha "two words"' $arguments 'Wrapper did not inject before user arguments.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-PathCharactersAndWrapperValidation {
    $context = New-TestContext -PercentInPrefix
    try {
        Install-AiCliBypass -Tool 'claude'
        $paths = Get-AiCliPaths -Tool 'claude'
        $target = Join-Path $context.Prefix 'claude.cmd'
        $wrapperText = [System.IO.File]::ReadAllText($paths.Wrapper, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True ($wrapperText.Contains($target.Replace('%', '%%%%'))) 'Percent characters in the target were not escaped for both CALL parsing passes.'

        $exitCode = Invoke-CmdFile -CommandPath $paths.Wrapper -Arguments 'plain' -RunnerDirectory $context.Root
        Assert-Equal 0 $exitCode 'Wrapper failed for a path containing spaces, non-ASCII, and percent characters.'
        Assert-True (Test-Path -LiteralPath (Join-Path $context.CliLogDirectory 'claude-args.txt')) 'Target in special-character path was not executed.'

        Assert-Throws { New-AiCliWrapperContent -Target 'relative\claude.cmd' -Arguments @('--flag') } 'Drive-relative wrapper targets must fail.' '*absolute*'
        Assert-Throws { New-AiCliWrapperContent -Target ('C:\bad"path\claude.cmd') -Arguments @('--flag') } 'Quoted wrapper targets must fail.' '*quotes*'
        Assert-Throws { New-AiCliWrapperContent -Target ("C:\bad`npath\claude.cmd") -Arguments @('--flag') } 'Multiline wrapper targets must fail.' '*newlines*'

        $insideBin = Join-Path $paths.Bin 'nested\claude.cmd'
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $insideBin) -Force
        Write-TestText -Path $insideBin -Text "@exit /b 0`r`n"
        Assert-Throws { New-AiCliWrapperContent -Target $insideBin -Arguments @('--flag') } 'Targets beneath the wrapper directory must fail.' '*wrapper directory*'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-Reinstall {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $firstState = Get-JsonFile $paths.ToolState
        Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '0'

        Install-AiCliBypass -Tool 'codex'

        $secondState = Get-JsonFile $paths.ToolState
        Assert-True ([bool]$secondState.InstalledByBypass) 'Reinstall did not preserve original package ownership.'
        Assert-Equal $firstState.TargetShim $secondState.TargetShim 'Reinstall changed the upstream target unexpectedly.'
        Assert-True (-not [string]::Equals($secondState.TargetShim, $secondState.WrapperPath, [StringComparison]::OrdinalIgnoreCase)) 'Reinstall created a recursive wrapper.'
        Assert-Equal 1 (Get-NormalizedPathMatchCount ([System.IO.File]::ReadAllText($context.UserPathFile)) $paths.Bin) 'Reinstall duplicated the user PATH entry.'
        Assert-Equal 1 (Get-NormalizedPathMatchCount $env:Path $paths.Bin) 'Reinstall duplicated the process PATH entry.'

        $wrapperBeforeFailure = [System.IO.File]::ReadAllBytes($paths.Wrapper)
        $stateBeforeFailure = [System.IO.File]::ReadAllBytes($paths.ToolState)
        $globalBeforeFailure = [System.IO.File]::ReadAllBytes($paths.GlobalState)
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '1'
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'A failed reinstall must throw.' '*npm*install*'
        Assert-SequenceEqual $wrapperBeforeFailure ([System.IO.File]::ReadAllBytes($paths.Wrapper)) 'Failed reinstall changed wrapper bytes.'
        Assert-SequenceEqual $stateBeforeFailure ([System.IO.File]::ReadAllBytes($paths.ToolState)) 'Failed reinstall changed tool state bytes.'
        Assert-SequenceEqual $globalBeforeFailure ([System.IO.File]::ReadAllBytes($paths.GlobalState)) 'Failed reinstall changed global state bytes.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-OwnedPackageUninstall {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'claude'
        $paths = Get-AiCliPaths -Tool 'claude'
        Uninstall-AiCliBypass -Tool 'claude'

        Assert-NpmLogContains $context 'uninstall --global @anthropic-ai/claude-code'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Owned wrapper remained after uninstall.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Owned state remained after uninstall.'
        Assert-True (Test-Path -LiteralPath (Join-Path $context.Prefix 'claude.cmd')) 'Uninstall deleted the upstream shim directly.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-ExistingPackageUninstall {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '0'
        Install-AiCliBypass -Tool 'opencode'
        $paths = Get-AiCliPaths -Tool 'opencode'
        $state = Get-JsonFile $paths.ToolState
        Assert-True (-not [bool]$state.InstalledByBypass) 'Pre-existing package was marked as project-owned.'

        Uninstall-AiCliBypass -Tool 'opencode'
        $lines = @(Get-NpmLogLines $context)
        Assert-True (-not ($lines -contains 'uninstall --global opencode-ai')) 'Pre-existing package was uninstalled.'
        Assert-True (Test-Path -LiteralPath (Join-Path $context.Prefix 'opencode.cmd')) 'Pre-existing upstream shim was removed.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-KeepCli {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        Uninstall-AiCliBypass -Tool 'codex' -KeepCli

        $lines = @(Get-NpmLogLines $context)
        Assert-True (-not ($lines -contains 'uninstall --global @openai/codex')) '-KeepCli uninstalled the package.'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) '-KeepCli left the project wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) '-KeepCli left tool state.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-PathLifecycle {
    $context = New-TestContext
    try {
        $initialUserPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        Install-AiCliBypass -Tool 'claude'
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'claude'
        $userPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        Assert-Equal 1 (Get-NormalizedPathMatchCount $userPath $paths.Bin) 'Multiple tools duplicated the PATH entry.'
        Assert-True ($userPath.StartsWith($paths.Bin + ';', [StringComparison]::OrdinalIgnoreCase)) 'Wrapper directory was not prepended to user PATH.'

        Uninstall-AiCliBypass -Tool 'claude'
        Assert-Equal 1 (Get-NormalizedPathMatchCount ([System.IO.File]::ReadAllText($context.UserPathFile)) $paths.Bin) 'Intermediate uninstall removed shared PATH.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $initialUserPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Last uninstall did not restore unrelated PATH entries exactly.'
        Assert-Equal 0 (Get-NormalizedPathMatchCount $env:Path $paths.Bin) 'Last uninstall left the owned process PATH entry.'
        Assert-True (-not (Test-Path -LiteralPath $paths.GlobalState)) 'Last uninstall left global state.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'opencode'
        $preExistingPath = '  "' + $paths.Bin.ToUpperInvariant() + '\"  ;C:\Keep;C:\Keep-Longer'
        [System.IO.File]::WriteAllText($context.UserPathFile, $preExistingPath, (New-Object System.Text.UTF8Encoding($false)))
        Install-AiCliBypass -Tool 'opencode'

        $global = Get-JsonFile $paths.GlobalState
        Assert-True (-not [bool]$global.UserPathAddedByBypass) 'Equivalent pre-existing PATH entry was claimed by the project.'
        Assert-Equal 1 (Get-NormalizedPathMatchCount ([System.IO.File]::ReadAllText($context.UserPathFile)) $paths.Bin) 'Equivalent PATH entry was duplicated.'

        Uninstall-AiCliBypass -Tool 'opencode'
        Assert-Equal $preExistingPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Unowned PATH entry was changed during uninstall.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-MissingNpm {
    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'claude'
        $initialPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_NPM' (Join-Path $context.Root 'missing npm.cmd')
        Assert-Throws { Install-AiCliBypass -Tool 'claude' } 'Missing npm must terminate installation.' '*npm*'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Missing npm left a wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Missing npm left tool state.'
        Assert-Equal $initialPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Missing npm changed user PATH.'
        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Missing npm reached the fake npm process.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-InstallRollback {
    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'claude'
        $initialPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '1'
        Assert-Throws { Install-AiCliBypass -Tool 'claude' } 'Failed npm install must terminate.' '*npm*install*'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Failed npm install left a wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Failed npm install left tool state.'
        Assert-Equal $initialPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Failed npm install changed PATH.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'codex'
        $null = New-Item -ItemType Directory -Path $paths.State -Force
        $globalText = '{"SchemaVersion":1,"WrapperDirectory":"' + ($paths.Bin.Replace('\', '\\')) + '","UserPathAddedByBypass":false}'
        [System.IO.File]::WriteAllText($paths.GlobalState, $globalText, (New-Object System.Text.UTF8Encoding($false)))
        $globalBefore = [System.IO.File]::ReadAllBytes($paths.GlobalState)
        $initialUserPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        $initialProcessPath = $env:Path
        $lock = [System.IO.File]::Open($paths.GlobalState, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try {
            Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'Failure after PATH creation must terminate.' '*'
        }
        finally {
            $lock.Dispose()
        }

        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Late failure left a new wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Late failure left new tool state.'
        Assert-SequenceEqual $globalBefore ([System.IO.File]::ReadAllBytes($paths.GlobalState)) 'Late failure changed prior global state.'
        Assert-Equal $initialUserPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Late failure did not roll back user PATH.'
        Assert-Equal $initialProcessPath $env:Path 'Late failure did not roll back process PATH.'
        Assert-NpmLogContains $context 'uninstall --global @openai/codex'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-MissingShimRollback {
    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'opencode'
        $initialPath = [System.IO.File]::ReadAllText($context.UserPathFile)
        Remove-Item -LiteralPath (Join-Path $context.Prefix 'opencode.cmd') -Force
        Assert-Throws { Install-AiCliBypass -Tool 'opencode' } 'Missing upstream shim must terminate.' '*shim*'
        Assert-NpmLogContains $context 'install --global opencode-ai'
        Assert-NpmLogContains $context 'uninstall --global opencode-ai'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Missing shim left a wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Missing shim left tool state.'
        Assert-Equal $initialPath ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Missing shim changed PATH.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-FailedUninstallRetry {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'claude'
        $paths = Get-AiCliPaths -Tool 'claude'
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '1'
        Assert-Throws { Uninstall-AiCliBypass -Tool 'claude' } 'Failed npm uninstall must terminate.' '*npm*uninstall*'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'Failed uninstall removed retryable wrapper.'
        Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) 'Failed uninstall removed retryable state.'
        Assert-True (Test-Path -LiteralPath $paths.GlobalState -PathType Leaf) 'Failed uninstall removed retryable global state.'

        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '0'
        Uninstall-AiCliBypass -Tool 'claude'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Retry did not remove wrapper.'
        Assert-True (-not (Test-Path -LiteralPath $paths.ToolState)) 'Retry did not remove state.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-RepeatedUninstall {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        Remove-Item -LiteralPath $paths.ToolState -Force
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))

        Uninstall-AiCliBypass -Tool 'codex'
        Uninstall-AiCliBypass -Tool 'codex'

        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Missing-state uninstall left the known wrapper.'
        $lines = @(Get-NpmLogLines $context)
        Assert-True (-not ($lines -contains 'uninstall --global @openai/codex')) 'Missing state inferred package ownership.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-LocalEntryPoints {
    foreach ($toolName in $script:ExpectedTools.Keys) {
        $context = New-TestContext
        try {
            $expected = $script:ExpectedTools[$toolName]
            $installer = Join-Path $script:RepositoryRoot ('install-' + $toolName + '-windows.ps1')
            $uninstaller = Join-Path $script:RepositoryRoot ('uninstall-' + $toolName + '-windows.ps1')
            & $installer *> $null
            Assert-NpmLogContains $context ('install --global ' + $expected.Package)
            & $uninstaller *> $null
            Assert-NpmLogContains $context ('uninstall --global ' + $expected.Package)
        }
        finally {
            Remove-TestContext $context
        }
    }

    $context = New-TestContext
    try {
        $installer = Join-Path $script:RepositoryRoot 'install-claude-windows.ps1'
        $uninstaller = Join-Path $script:RepositoryRoot 'uninstall-claude-windows.ps1'
        & $installer *> $null
        & $uninstaller -KeepCli *> $null
        $lines = @(Get-NpmLogLines $context)
        Assert-True (-not ($lines -contains 'uninstall --global @anthropic-ai/claude-code')) 'Uninstaller entry point did not forward -KeepCli.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-RemoteBootstrap {
    $context = New-TestContext
    try {
        $entryPoint = Join-Path $script:RepositoryRoot 'install-codex-windows.ps1'
        $entryTextPath = Join-Path $context.Root 'downloaded entry point.ps1'
        $urlLog = Join-Path $context.Root 'remote URL.log'
        [System.IO.File]::WriteAllText($entryTextPath, [System.IO.File]::ReadAllText($entryPoint), (New-Object System.Text.UTF8Encoding($false)))
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_CORE' $script:CorePath
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_ENTRY' $entryTextPath
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_URL_LOG' $urlLog

        $runner = Join-Path $context.Root 'remote bootstrap runner.ps1'
        $runnerContent = @'
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod {
    param([string]$Uri, [switch]$UseBasicParsing)
    [System.IO.File]::AppendAllText($env:FAKE_REMOTE_URL_LOG, $Uri + [Environment]::NewLine)
    return [System.IO.File]::ReadAllText($env:FAKE_REMOTE_CORE)
}
$entryText = [System.IO.File]::ReadAllText($env:FAKE_REMOTE_ENTRY)
Invoke-Expression $entryText
'@
        [System.IO.File]::WriteAllText($runner, $runnerContent, (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-Equal 0 $LASTEXITCODE 'Remote bootstrap runner failed.'
        Assert-NpmLogContains $context 'install --global @openai/codex'

        $urls = @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' })
        Assert-SequenceEqual @($script:ExpectedRemoteUrl) $urls 'Remote bootstrap URL calls'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-DependencyIsolation {
    $context = New-TestContext
    try {
        $resolvedNpm = Get-AiCliNpmCommand
        Assert-Equal ([System.IO.Path]::GetFullPath($context.FakeNpm)) ([System.IO.Path]::GetFullPath($resolvedNpm)) 'npm override did not resolve to the fake command.'
        Install-AiCliBypass -Tool 'opencode'
        Assert-True (@(Get-NpmLogLines $context).Count -gt 0) 'Fake npm did not observe installation calls.'
        Assert-Equal $script:RealUserPathBefore ([Environment]::GetEnvironmentVariable('Path', 'User')) 'A test changed the real user PATH.'
    }
    finally {
        Remove-TestContext $context
    }
}

if (Test-Path -LiteralPath $script:CorePath -PathType Leaf) {
    . $script:CorePath
}

Invoke-Test 'PowerShell files parse' { Test-PowerShellSyntax }
Invoke-Test 'tool definitions are exact' { Test-ToolDefinitions }
Invoke-Test 'installs all tool wrappers' { Test-AllToolInstalls }
Invoke-Test 'wrapper preserves arguments and exit code' { Test-WrapperForwarding }
Invoke-Test 'paths and wrapper target validation are safe' { Test-PathCharactersAndWrapperValidation }
Invoke-Test 'reinstall is idempotent and failure-safe' { Test-Reinstall }
Invoke-Test 'uninstall reverses owned package' { Test-OwnedPackageUninstall }
Invoke-Test 'uninstall keeps pre-existing package' { Test-ExistingPackageUninstall }
Invoke-Test 'KeepCli retains package' { Test-KeepCli }
Invoke-Test 'PATH ownership and deduplication' { Test-PathLifecycle }
Invoke-Test 'missing npm fails without state' { Test-MissingNpm }
Invoke-Test 'npm and late failures roll back' { Test-InstallRollback }
Invoke-Test 'missing shim rolls back' { Test-MissingShimRollback }
Invoke-Test 'failed uninstall remains retryable' { Test-FailedUninstallRetry }
Invoke-Test 'repeated and missing-state uninstall succeeds' { Test-RepeatedUninstall }
Invoke-Test 'local entry points select the correct action' { Test-LocalEntryPoints }
Invoke-Test 'remote bootstrap uses the exact URL without network' { Test-RemoteBootstrap }
Invoke-Test 'tests isolate real npm and user PATH' { Test-DependencyIsolation }

Assert-Equal $script:RealUserPathBefore ([Environment]::GetEnvironmentVariable('Path', 'User')) 'The suite changed the real user PATH.'

if ($script:Failed -ne 0) {
    throw "$($script:Failed) test(s) failed; $($script:Passed) passed."
}
Write-Host "All $($script:Passed) Windows script tests passed."
