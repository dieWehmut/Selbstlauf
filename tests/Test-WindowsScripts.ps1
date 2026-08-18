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
    'CODEX_HOME',
    'FAKE_NPM_PREFIX',
    'FAKE_NPM_LOG',
    'FAKE_NPM_PACKAGE_PRESENT',
    'FAKE_NPM_FAIL_INSTALL',
    'FAKE_NPM_FAIL_UNINSTALL',
    'FAKE_NPM_RESTORE_SHIM',
    'FAKE_NPM_RESTORE_SOURCE',
    'FAKE_NPM_STDERR',
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
    $codexHome = Join-Path $root 'codex home'
    $prefixName = 'npm prefix {0}' -f $unicodeName
    if ($PercentInPrefix) {
        $prefixName += ' %AI_CLI_UNUSED%'
    }
    $prefix = Join-Path $root $prefixName
    $npmLog = Join-Path $root 'npm calls.log'
    $cliLogDirectory = Join-Path $root 'cli logs'
    $userPathFile = Join-Path $root 'persisted user path.txt'
    $fakeNpm = Join-Path $fakeBin 'npm.cmd'

    $null = New-Item -ItemType Directory -Path $fakeBin, $testHome, $codexHome, $prefix, $cliLogDirectory -Force
    Write-TestText -Path $npmLog -Text '' -Encoding (New-Object System.Text.UTF8Encoding($false))
    Write-TestText -Path $userPathFile -Text 'C:\Existing Tool;C:\Unrelated' -Encoding (New-Object System.Text.UTF8Encoding($false))

    $fakeNpmContent = @'
@echo off
setlocal DisableDelayedExpansion
>>"%FAKE_NPM_LOG%" echo %*
if /I "%~1"=="list" exit /b %FAKE_NPM_PACKAGE_PRESENT%
if /I "%~1"=="install" if "%FAKE_NPM_FAIL_INSTALL%"=="1" exit /b 41
if /I "%~1"=="install" if not "%FAKE_NPM_RESTORE_SHIM%"=="" copy /Y "%FAKE_NPM_RESTORE_SOURCE%" "%FAKE_NPM_RESTORE_SHIM%" >nul
if /I "%~1"=="uninstall" if "%FAKE_NPM_FAIL_UNINSTALL%"=="1" exit /b 42
if /I "%~1"=="prefix" echo %FAKE_NPM_PREFIX%
if "%FAKE_NPM_STDERR%"=="1" >&2 echo npm warning: using cached metadata
exit /b 0
'@
    Write-TestText -Path $fakeNpm -Text ($fakeNpmContent -replace "(?<!`r)`n", "`r`n")

    foreach ($toolName in $script:ExpectedTools.Keys) {
        $command = $script:ExpectedTools[$toolName].Command
        $shimPath = Join-Path $prefix ($command + '.cmd')
        $shimLines = @(
            '@echo off'
            'setlocal DisableDelayedExpansion'
        )
        $shimLines += @(
            ('>>"%FAKE_CLI_LOG_DIR%\' + $command + '-args.txt" echo %*')
            'exit /b %FAKE_CLI_EXIT%'
        )
        if ($toolName -eq 'codex') {
            # Unreachable, but structurally matches the executable line in npm's Windows shim.
            $shimLines += 'endLocal & goto #_undefined_# 2>NUL || "%dp0%\node_modules\@openai\codex\bin\codex.js" %*'
        }
        Write-TestText -Path $shimPath -Text (($shimLines -join "`r`n") + "`r`n")
    }

    $codexPackageEntry = Join-Path $prefix 'node_modules\@openai\codex\bin\codex.js'
    Write-TestText -Path $codexPackageEntry -Text '// fake Codex package entry'

    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_HOME' $testHome
    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_NPM' $fakeNpm
    Set-ProcessEnvironmentValue 'AI_CLI_BYPASS_USER_PATH_FILE' $userPathFile
    Set-ProcessEnvironmentValue 'CODEX_HOME' $codexHome
    Set-ProcessEnvironmentValue 'FAKE_NPM_PREFIX' $prefix
    Set-ProcessEnvironmentValue 'FAKE_NPM_LOG' $npmLog
    Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '1'
    Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '0'
    Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '0'
    Set-ProcessEnvironmentValue 'FAKE_NPM_RESTORE_SHIM' $null
    Set-ProcessEnvironmentValue 'FAKE_NPM_RESTORE_SOURCE' $null
    Set-ProcessEnvironmentValue 'FAKE_NPM_STDERR' '0'
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
        CodexHome = $codexHome
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
            $expectedStateProperties = @('SchemaVersion', 'Tool', 'Package', 'Command', 'TargetShim', 'WrapperPath', 'Arguments', 'InstalledByBypass')
            if ($toolName -eq 'codex') {
                $expectedStateProperties += 'CodexConfig'
            }
            Assert-SequenceEqual $expectedStateProperties @($state.PSObject.Properties.Name) "Tool state properties for $toolName"
            Assert-Equal 1 $state.SchemaVersion "Tool schema for $toolName"
            Assert-Equal $toolName $state.Tool "Tool state name for $toolName"
            Assert-Equal $expected.Package $state.Package "Tool state package for $toolName"
            Assert-Equal $expected.Command $state.Command "Tool state command for $toolName"
            Assert-Equal ([System.IO.Path]::GetFullPath($upstream)) $state.TargetShim "Target path for $toolName"
            Assert-Equal ([System.IO.Path]::GetFullPath($paths.Wrapper)) $state.WrapperPath "Wrapper path for $toolName"
            Assert-SequenceEqual @($expected.Argument) @($state.Arguments) "State arguments for $toolName"
            Assert-True ([bool]$state.InstalledByBypass) "Fresh package ownership missing for $toolName."
            if ($toolName -eq 'codex') {
                Assert-True ($null -ne $state.CodexConfig) 'Fresh Codex install did not record config ownership.'
                Assert-Equal ([System.IO.Path]::GetFullPath((Join-Path $context.CodexHome 'config.toml'))) $state.CodexConfig.Path 'Fresh Codex config path mismatch.'
            }

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

        $exitCode = Invoke-CmdFile -CommandPath $paths.Wrapper -Arguments 'alpha "two words" 100%' -RunnerDirectory $context.Root
        Assert-Equal 37 $exitCode 'Wrapper did not propagate the target exit code.'

        $argumentLog = Join-Path $context.CliLogDirectory 'codex-args.txt'
        Assert-True (Test-Path -LiteralPath $argumentLog -PathType Leaf) 'Codex target was not called.'
        $arguments = [System.IO.File]::ReadAllText($argumentLog, [System.Text.Encoding]::Default).Trim()
        Assert-Equal '--dangerously-bypass-approvals-and-sandbox alpha "two words" 100%' $arguments 'Wrapper did not preserve and inject user arguments.'
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
        Assert-True ($wrapperText.Contains($target.Replace('%', '%%'))) 'Percent characters in the target were not escaped for batch parsing.'
        Assert-True (-not $wrapperText.Contains('call "')) 'Wrapper still uses CALL and reparses user arguments.'

        $exitCode = Invoke-CmdFile -CommandPath $paths.Wrapper -Arguments 'plain' -RunnerDirectory $context.Root
        Assert-Equal 0 $exitCode 'Wrapper failed for a path containing spaces, non-ASCII, and percent characters.'
        Assert-True (Test-Path -LiteralPath (Join-Path $context.CliLogDirectory 'claude-args.txt')) 'Target in special-character path was not executed.'

        Assert-Throws { New-AiCliWrapperContent -Target 'relative\claude.cmd' -Arguments @('--flag') } 'Drive-relative wrapper targets must fail.' '*absolute*'
        Assert-Throws { New-AiCliWrapperContent -Target 'C:relative\claude.cmd' -Arguments @('--flag') } 'Drive-relative wrapper targets must fail.' '*absolute*'
        Assert-Throws { New-AiCliWrapperContent -Target '\root-relative\claude.cmd' -Arguments @('--flag') } 'Root-relative wrapper targets must fail.' '*absolute*'
        Assert-Throws { New-AiCliWrapperContent -Target ('C:\bad"path\claude.cmd') -Arguments @('--flag') } 'Quoted wrapper targets must fail.' '*quotes*'
        Assert-Throws { New-AiCliWrapperContent -Target ("C:\bad`npath\claude.cmd") -Arguments @('--flag') } 'Multiline wrapper targets must fail.' '*newlines*'

        $insideBin = Join-Path $paths.Bin 'nested\claude.cmd'
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $insideBin) -Force
        Write-TestText -Path $insideBin -Text "@exit /b 0`r`n"
        Assert-Throws { New-AiCliWrapperContent -Target $insideBin -Arguments @('--flag') } 'Targets beneath the wrapper directory must fail.' '*wrapper directory*'

        $junction = Join-Path $context.Root 'wrapper-bin-junction'
        $null = New-Item -ItemType Junction -Path $junction -Target $paths.Bin
        $junctionTarget = Join-Path $junction 'aliased.cmd'
        Write-TestText -Path (Join-Path $paths.Bin 'aliased.cmd') -Text "@exit /b 0`r`n"
        Assert-Throws { New-AiCliWrapperContent -Target $junctionTarget -Arguments @('--flag') } 'Junction aliases into the wrapper directory must fail.' '*wrapper directory*'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexFullAccessConfig {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "model = `"gpt-test`"`r`n`r`n[features]`r`ngoals = true`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'

        $after = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-Equal 1 ([regex]::Matches($after, '(?m)^approval_policy\s*=\s*"never"\s*$')).Count 'approval_policy was not set exactly once.'
        Assert-Equal 1 ([regex]::Matches($after, '(?m)^sandbox_mode\s*=\s*"danger-full-access"\s*$')).Count 'sandbox_mode was not set exactly once.'
        Assert-True $after.Contains('model = "gpt-test"') 'Unrelated top-level config changed.'
        Assert-True $after.Contains("[features]`r`ngoals = true") 'Unrelated table config changed.'
        Assert-True (-not [regex]::IsMatch($after, "(?<!`r)`n")) 'Config line endings changed.'

        $state = Get-JsonFile (Get-AiCliPaths -Tool 'codex').ToolState
        Assert-True ($null -ne $state.CodexConfig) 'Codex config ownership was not recorded.'
        Assert-Equal ([System.IO.Path]::GetFullPath($configPath)) $state.CodexConfig.Path 'Codex config path was not recorded.'
        Assert-True (-not [bool]$state.CodexConfig.ApprovalPolicy.Present) 'Absent approval_policy was recorded as present.'
        Assert-True (-not [bool]$state.CodexConfig.SandboxMode.Present) 'Absent sandbox_mode was recorded as present.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Uninstall did not remove settings owned by this install.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = ([char]34 + 'approval\u005fpolicy' + [char]34 + ' = ' + [char]34 + 'on-request' + [char]34 + "`r`n" +
            [char]34 + 'sandbox\u005fmode' + [char]34 + ' = ' + [char]34 + 'workspace-write' + [char]34 + "`r`n" +
            'Approval_Policy = "leave-me"' + "`r`n" +
            'Sandbox_Mode = "leave-me"' + "`r`n")
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True $active.Contains('"approval\u005fpolicy" = "never"') 'Unicode-escaped approval_policy key was not updated.'
        Assert-True $active.Contains('"sandbox\u005fmode" = "danger-full-access"') 'Unicode-escaped sandbox_mode key was not updated.'
        Assert-True $active.Contains('Approval_Policy = "leave-me"') 'Case-distinct approval key was treated as owned.'
        Assert-True $active.Contains('Sandbox_Mode = "leave-me"') 'Case-distinct sandbox key was treated as owned.'
        Assert-Equal 0 ([regex]::Matches($active, '(?m)^approval_policy\s*=')).Count 'Escaped approval_policy created a duplicate bare key.'
        Assert-Equal 0 ([regex]::Matches($active, '(?m)^sandbox_mode\s*=')).Count 'Escaped sandbox_mode created a duplicate bare key.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Escaped and case-distinct Codex keys were not restored exactly.'
    }
    finally {
        Remove-TestContext $context
    }

}

function Test-CodexCommentDelimiterConfigSafety {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = '# """' + "`r`n" +
            'model = "gpt-test"' + "`r`n" +
            '[features]' + "`r`n" +
            'goals = true' + "`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'

        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        $approvalIndex = $active.IndexOf('approval_policy = "never"', [StringComparison]::Ordinal)
        $sandboxIndex = $active.IndexOf('sandbox_mode = "danger-full-access"', [StringComparison]::Ordinal)
        $tableIndex = $active.IndexOf('[features]', [StringComparison]::Ordinal)
        Assert-True ($approvalIndex -ge 0 -and $approvalIndex -lt $tableIndex) 'approval_policy was inserted inside or after a table after a comment-only triple quote.'
        Assert-True ($sandboxIndex -ge 0 -and $sandboxIndex -lt $tableIndex) 'sandbox_mode was inserted inside or after a table after a comment-only triple quote.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Comment-delimiter config was not restored byte-for-byte.'
    }
    finally {
        Remove-TestContext $context
    }

}

function Test-CodexAbsentConfigIsRemoved {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        Assert-True (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) 'Test context unexpectedly started with a Codex config.'

        Install-AiCliBypass -Tool 'codex'
        Assert-True (Test-Path -LiteralPath $configPath -PathType Leaf) 'Install did not create the missing Codex config.'
        $state = Get-JsonFile (Get-AiCliPaths -Tool 'codex').ToolState
        Assert-True (-not [bool]$state.CodexConfig.ConfigExisted) 'Missing Codex config was recorded as pre-existing.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-True (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) 'Uninstall left a Codex config that was created by the bypass.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexConfigBomIsPreserved {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'model = "gpt-test"' + "`r`n"
        $utf8Bom = New-Object System.Text.UTF8Encoding($true)
        Write-TestText -Path $configPath -Text $before -Encoding $utf8Bom
        $beforeBytes = [System.IO.File]::ReadAllBytes($configPath)
        Assert-True ($beforeBytes.Length -ge 3 -and $beforeBytes[0] -eq 0xEF -and $beforeBytes[1] -eq 0xBB -and $beforeBytes[2] -eq 0xBF) 'Test config did not contain a UTF-8 BOM.'

        Install-AiCliBypass -Tool 'codex'
        $activeBytes = [System.IO.File]::ReadAllBytes($configPath)
        Assert-True ($activeBytes.Length -ge 3 -and $activeBytes[0] -eq 0xEF -and $activeBytes[1] -eq 0xBB -and $activeBytes[2] -eq 0xBF) 'Install dropped the Codex config UTF-8 BOM.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-SequenceEqual $beforeBytes ([System.IO.File]::ReadAllBytes($configPath)) 'Uninstall did not preserve the original BOM and config bytes.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexRejectsUnrelatedExternalShim {
    $context = New-TestContext
    try {
        $externalDirectory = Join-Path $context.Root 'unrelated codex'
        $null = New-Item -ItemType Directory -Path $externalDirectory -Force
        $externalShim = Join-Path $externalDirectory 'codex.cmd'
        $externalPackageEntry = Join-Path $externalDirectory 'node_modules\@openai\codex\bin\codex.js'
        Write-TestText -Path $externalPackageEntry -Text '// spoofed package entry'
        Write-TestText -Path $externalShim -Text ("@echo off" + [Environment]::NewLine + "rem node_modules\@openai\codex\bin\codex.js" + [Environment]::NewLine + "exit /b 0" + [Environment]::NewLine)

        # The official-looking fixture remains outside PATH and is found only after npm install.
        $fakeNpmBin = Split-Path -Parent $context.FakeNpm
        $systemPath = Join-Path $env:SystemRoot 'System32'
        Set-ProcessEnvironmentValue 'Path' ($externalDirectory + ';' + $fakeNpmBin + ';' + $systemPath)

        Install-AiCliBypass -Tool 'codex'

        Assert-NpmLogContains $context 'list --global --depth=0 @openai/codex'
        Assert-NpmLogContains $context 'install --global @openai/codex'
        $state = Get-JsonFile (Get-AiCliPaths -Tool 'codex').ToolState
        Assert-Equal ([System.IO.Path]::GetFullPath((Join-Path $context.Prefix 'codex.cmd'))) $state.TargetShim 'Unrelated external codex.cmd was reused instead of the npm shim.'
        Assert-True (-not [string]::Equals([System.IO.Path]::GetFullPath($externalShim), [System.IO.Path]::GetFullPath([string]$state.TargetShim), [StringComparison]::OrdinalIgnoreCase)) 'Unrelated external codex.cmd was recorded as the target.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexConfigRestoreAndUserChanges {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "model = `"gpt-test`"`r`napproval_policy = `"on-request`" # keep me`r`nsandbox_mode = `"workspace-write`"`r`n[features]`r`ngoals = true`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True $active.Contains('approval_policy = "never" # keep me') 'Updating approval_policy removed its inline comment.'
        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Uninstall did not restore original Codex settings.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "approval_policy = `"on-request`"`r`nsandbox_mode = `"workspace-write`"`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        Install-AiCliBypass -Tool 'codex'

        $changed = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false))).Replace('approval_policy = "never"', 'approval_policy = "on-request"')
        [System.IO.File]::WriteAllText($configPath, $changed, (New-Object System.Text.UTF8Encoding($false)))
        Uninstall-AiCliBypass -Tool 'codex'

        $after = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True $after.Contains('approval_policy = "on-request"') 'Uninstall overwrote a user-edited Codex setting.'
        Assert-True $after.Contains('sandbox_mode = "workspace-write"') 'Uninstall did not restore an unchanged Codex setting.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexConfigRestorePreservesSameValueEdits {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "approval_policy = `"on-request`"`r`nsandbox_mode = `"workspace-write`"`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        Install-AiCliBypass -Tool 'codex'

        $edited = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false))) -replace
            'approval_policy = "never"', 'approval_policy    = "never" # user formatting'
        [System.IO.File]::WriteAllText($configPath, $edited, (New-Object System.Text.UTF8Encoding($false)))
        Uninstall-AiCliBypass -Tool 'codex'

        $after = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True $after.Contains('approval_policy    = "never" # user formatting') 'Uninstall removed a same-value user edit to approval_policy.'
        Assert-True $after.Contains('sandbox_mode = "workspace-write"') 'Uninstall did not restore the untouched sandbox_mode setting.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexConfigConflicts {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "approval_policy = `"on-request`"`r`napproval_policy = `"never`"`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        $beforeBytes = [System.IO.File]::ReadAllBytes($configPath)
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'Duplicate Codex settings must be rejected.' '*duplicate*'
        Assert-SequenceEqual $beforeBytes ([System.IO.File]::ReadAllBytes($configPath)) 'Duplicate Codex settings changed the config.'
        Assert-True (-not (Test-Path -LiteralPath (Get-AiCliPaths -Tool 'codex').Wrapper)) 'Duplicate Codex settings left a wrapper.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "default_permissions = `":workspace`"`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        $beforeBytes = [System.IO.File]::ReadAllBytes($configPath)
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'default_permissions must not be silently replaced.' '*default_permissions*'
        Assert-SequenceEqual $beforeBytes ([System.IO.File]::ReadAllBytes($configPath)) 'default_permissions conflict changed the config.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = ([char]34 + 'approval_policy' + [char]34 + ' = ' + [char]34 + 'on-request' + [char]34 + "`r`n" +
            [char]39 + 'sandbox_mode' + [char]39 + ' = ' + [char]34 + 'workspace-write' + [char]34 + "`r`n")
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-Equal 1 ([regex]::Matches($active, '(?m)^\s*"approval_policy"\s*=\s*"never"\s*$')).Count 'Quoted approval_policy key was not updated.'
        Assert-Equal 1 ([regex]::Matches($active, '(?m)^\s*''sandbox_mode''\s*=\s*"danger-full-access"\s*$')).Count 'Literal-quoted sandbox_mode key was not updated.'
        Assert-Equal 0 ([regex]::Matches($active, '(?m)^\s*approval_policy\s*=')).Count 'Quoted approval_policy created a duplicate bare key.'
        Assert-Equal 0 ([regex]::Matches($active, '(?m)^\s*sandbox_mode\s*=')).Count 'Quoted sandbox_mode created a duplicate bare key.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Quoted Codex keys were not restored exactly.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'description = """' + "`r`n" + 'still open' + "`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        $beforeBytes = [System.IO.File]::ReadAllBytes($configPath)

        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'An unterminated TOML string must block installation.' '*unterminated*'
        Assert-SequenceEqual $beforeBytes ([System.IO.File]::ReadAllBytes($configPath)) 'Unterminated TOML changed the config.'
        Assert-True (-not (Test-Path -LiteralPath (Get-AiCliPaths -Tool 'codex').Wrapper)) 'Unterminated TOML left a wrapper.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexMultilineConfigSafety {
    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = "instructions = `"`"`"`r`nsandbox_mode = `"workspace-write`"`r`n`"`"`"`r`nmodel = `"gpt-test`"`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        Assert-True $active.Contains('sandbox_mode = "workspace-write"') 'A multiline string assignment was mistaken for a top-level setting.'
        Assert-Equal 1 ([regex]::Matches($active, '(?m)^sandbox_mode\s*=\s*"danger-full-access"\s*$')).Count 'Full Access sandbox setting was not inserted outside the multiline string.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Multiline Codex config was not restored byte-for-byte.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'instructions = """' + "`r`n" +
            'keep this text # """' + "`r`n" +
            '[features]' + "`r`n" +
            'goals = true' + "`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        $sandboxIndex = $active.IndexOf('sandbox_mode = "danger-full-access"', [StringComparison]::Ordinal)
        $tableIndex = $active.IndexOf('[features]', [StringComparison]::Ordinal)
        Assert-True ($sandboxIndex -ge 0 -and $sandboxIndex -lt $tableIndex) 'A hash-containing multiline string moved Full Access below the first table.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Hash-containing multiline config was not restored exactly.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'description = """inline # """' + "`r`n" +
            '[features]' + "`r`n" +
            'goals = true' + "`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        $sandboxIndex = $active.IndexOf('sandbox_mode = "danger-full-access"', [StringComparison]::Ordinal)
        $tableIndex = $active.IndexOf('[features]', [StringComparison]::Ordinal)
        Assert-True ($sandboxIndex -ge 0 -and $sandboxIndex -lt $tableIndex) 'A same-line hash-containing multiline string moved Full Access below the first table.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Same-line multiline Codex config was not restored exactly.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'instructions = """' + "`r`n" +
            'content' + "`r`n" +
            '""" # """' + "`r`n" +
            '[features]' + "`r`n" +
            'goals = true' + "`r`n"
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))

        Install-AiCliBypass -Tool 'codex'
        $active = [System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))
        $sandboxIndex = $active.IndexOf('sandbox_mode = "danger-full-access"', [StringComparison]::Ordinal)
        $tableIndex = $active.IndexOf('[features]', [StringComparison]::Ordinal)
        Assert-True ($sandboxIndex -ge 0 -and $sandboxIndex -lt $tableIndex) 'A delimiter in a post-close comment moved Full Access below the first table.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-Equal $before ([System.IO.File]::ReadAllText($configPath, (New-Object System.Text.UTF8Encoding($false)))) 'Post-close comment config was not restored exactly.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexHomeChangeIsRejected {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $otherHome = Join-Path $context.Root 'other codex home'
        $null = New-Item -ItemType Directory -Path $otherHome -Force
        Set-ProcessEnvironmentValue 'CODEX_HOME' $otherHome
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'Changing CODEX_HOME must not reuse an old config backup.' '*CODEX_HOME changed*'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $otherHome 'config.toml'))) 'A changed CODEX_HOME was modified before rejection.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexExistingTargetSkipsNpm {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'Path' ($context.Prefix + ';' + $env:Path)
        Install-AiCliBypass -Tool 'codex'

        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'An existing Codex shim caused npm operations.'
        $state = Get-JsonFile (Get-AiCliPaths -Tool 'codex').ToolState
        Assert-True (-not [bool]$state.InstalledByBypass) 'A discovered Codex package was marked as project-owned.'
        Assert-Equal ([System.IO.Path]::GetFullPath((Join-Path $context.Prefix 'codex.cmd'))) $state.TargetShim 'Discovered Codex target was not recorded.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexTargetReplacementDoesNotInheritOwnership {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $oldTarget = Join-Path $context.Prefix 'codex.cmd'
        $replacementDirectory = Join-Path $context.Root 'replacement npm bin'
        $replacementTarget = Join-Path $replacementDirectory 'codex.cmd'
        $null = New-Item -ItemType Directory -Path $replacementDirectory -Force
        $replacementPackageEntry = Join-Path $replacementDirectory 'node_modules\@openai\codex\bin\codex.js'
        Write-TestText -Path $replacementPackageEntry -Text '// replacement Codex package entry'
        [System.IO.File]::WriteAllBytes($replacementTarget, [System.IO.File]::ReadAllBytes($oldTarget))
        Remove-Item -LiteralPath $oldTarget -Force
        Set-ProcessEnvironmentValue 'Path' ($replacementDirectory + ';' + $env:Path)
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))

        Install-AiCliBypass -Tool 'codex'
        $state = Get-JsonFile $paths.ToolState
        Assert-Equal ([System.IO.Path]::GetFullPath($replacementTarget)) $state.TargetShim 'Replacement Codex target was not selected.'
        Assert-True (-not [bool]$state.InstalledByBypass) 'Replacement Codex target inherited ownership from the deleted shim.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-True (-not (@(Get-NpmLogLines $context) -contains 'uninstall --global @openai/codex')) 'Uninstall removed a replacement Codex package it did not install.'
        Assert-True (Test-Path -LiteralPath $replacementTarget -PathType Leaf) 'Uninstall removed the replacement Codex shim.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexRecreatedPackageClaimsOwnership {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '0'
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $firstState = Get-JsonFile $paths.ToolState
        Assert-True (-not [bool]$firstState.InstalledByBypass) 'Pre-existing Codex package was unexpectedly claimed.'

        $target = Join-Path $context.Prefix 'codex.cmd'
        $restoreSource = Join-Path $context.Root 'saved codex.cmd'
        [System.IO.File]::WriteAllBytes($restoreSource, [System.IO.File]::ReadAllBytes($target))
        Remove-Item -LiteralPath $target -Force
        Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '1'
        Set-ProcessEnvironmentValue 'FAKE_NPM_RESTORE_SHIM' $target
        Set-ProcessEnvironmentValue 'FAKE_NPM_RESTORE_SOURCE' $restoreSource
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))

        Install-AiCliBypass -Tool 'codex'
        $secondState = Get-JsonFile $paths.ToolState
        Assert-True ([bool]$secondState.InstalledByBypass) 'A Codex package recreated by this invocation was not claimed.'
        Assert-NpmLogContains $context 'install --global @openai/codex'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-NpmLogContains $context 'uninstall --global @openai/codex'
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
        $firstConfigState = $firstState.CodexConfig
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))

        Install-AiCliBypass -Tool 'codex'

        $secondState = Get-JsonFile $paths.ToolState
        Assert-True ([bool]$secondState.InstalledByBypass) 'Reinstall did not preserve original package ownership.'
        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Existing Codex reinstall invoked npm.'
        Assert-Equal $firstState.TargetShim $secondState.TargetShim 'Reinstall changed the upstream target unexpectedly.'
        Assert-Equal ([string]$firstConfigState.ApprovalPolicy.RawLine) ([string]$secondState.CodexConfig.ApprovalPolicy.RawLine) 'Reinstall replaced the original Codex config backup.'
        Assert-True (-not [string]::Equals($secondState.TargetShim, $secondState.WrapperPath, [StringComparison]::OrdinalIgnoreCase)) 'Reinstall created a recursive wrapper.'
        Assert-Equal 1 (Get-NormalizedPathMatchCount ([System.IO.File]::ReadAllText($context.UserPathFile)) $paths.Bin) 'Reinstall duplicated the user PATH entry.'
        Assert-Equal 1 (Get-NormalizedPathMatchCount $env:Path $paths.Bin) 'Reinstall duplicated the process PATH entry.'

        $wrapperBeforeFailure = [System.IO.File]::ReadAllBytes($paths.Wrapper)
        $stateBeforeFailure = [System.IO.File]::ReadAllBytes($paths.ToolState)
        $globalBeforeFailure = [System.IO.File]::ReadAllBytes($paths.GlobalState)
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $configBeforeFailure = [System.IO.File]::ReadAllBytes($configPath)
        Remove-Item -LiteralPath (Join-Path $context.Prefix 'codex.cmd') -Force
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '1'
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'A failed reinstall must throw.' '*npm*install*'
        Assert-NpmLogContains $context 'uninstall --global @openai/codex'
        Assert-SequenceEqual $wrapperBeforeFailure ([System.IO.File]::ReadAllBytes($paths.Wrapper)) 'Failed reinstall changed wrapper bytes.'
        Assert-SequenceEqual $stateBeforeFailure ([System.IO.File]::ReadAllBytes($paths.ToolState)) 'Failed reinstall changed tool state bytes.'
        Assert-SequenceEqual $globalBeforeFailure ([System.IO.File]::ReadAllBytes($paths.GlobalState)) 'Failed reinstall changed global state bytes.'
        Assert-SequenceEqual $configBeforeFailure ([System.IO.File]::ReadAllBytes($configPath)) 'Failed reinstall changed Codex config bytes.'

        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_INSTALL' '0'
        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'A stale-state reinstall without a recreated shim must throw.' '*shim*'
        Assert-NpmLogContains $context 'install --global @openai/codex'
        Assert-NpmLogContains $context 'uninstall --global @openai/codex'
        Assert-SequenceEqual $wrapperBeforeFailure ([System.IO.File]::ReadAllBytes($paths.Wrapper)) 'Stale-state reinstall changed wrapper bytes.'
        Assert-SequenceEqual $stateBeforeFailure ([System.IO.File]::ReadAllBytes($paths.ToolState)) 'Stale-state reinstall changed tool state bytes.'
        Assert-SequenceEqual $globalBeforeFailure ([System.IO.File]::ReadAllBytes($paths.GlobalState)) 'Stale-state reinstall changed global state bytes.'
        Assert-SequenceEqual $configBeforeFailure ([System.IO.File]::ReadAllBytes($configPath)) 'Stale-state reinstall changed Codex config bytes.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexConfigPreflightBeforeNpmMutation {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'FAKE_NPM_PACKAGE_PRESENT' '0'
        Remove-Item -LiteralPath (Join-Path $context.Prefix 'codex.cmd') -Force
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $before = 'default_permissions = ' + [char]34 + ':workspace' + [char]34 + [Environment]::NewLine
        Write-TestText -Path $configPath -Text $before -Encoding (New-Object System.Text.UTF8Encoding($false))
        $beforeBytes = [System.IO.File]::ReadAllBytes($configPath)

        Assert-Throws { Install-AiCliBypass -Tool 'codex' } 'Codex config conflicts must be rejected before npm mutation.' '*default_permissions*'
        $npmLines = @(Get-NpmLogLines $context)
        Assert-True (-not ($npmLines -contains 'install --global @openai/codex')) 'A pre-existing Codex package was mutated before config validation.'
        Assert-SequenceEqual $beforeBytes ([System.IO.File]::ReadAllBytes($configPath)) 'Config preflight changed the conflicting Codex config.'
        Assert-True (-not (Test-Path -LiteralPath (Get-AiCliPaths -Tool 'codex').Wrapper)) 'Config preflight left a wrapper.'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-NpmStderrWarning {
    $context = New-TestContext
    try {
        Set-ProcessEnvironmentValue 'FAKE_NPM_STDERR' '1'
        Install-AiCliBypass -Tool 'claude'
        $paths = Get-AiCliPaths -Tool 'claude'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'A non-fatal npm warning prevented installation.'
        Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) 'A non-fatal npm warning prevented state creation.'
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

    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'claude'
        $processBefore = $paths.Bin + ';' + $env:Path
        Set-ProcessEnvironmentValue 'Path' $processBefore
        Install-AiCliBypass -Tool 'claude'
        Uninstall-AiCliBypass -Tool 'claude'
        Assert-Equal $processBefore $env:Path 'Uninstall removed a pre-existing process PATH entry.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        $paths = Get-AiCliPaths -Tool 'claude'
        $userBefore = $paths.Bin + ';' + [System.IO.File]::ReadAllText($context.UserPathFile)
        [System.IO.File]::WriteAllText($context.UserPathFile, $userBefore, (New-Object System.Text.UTF8Encoding($false)))
        $processBefore = $env:Path
        Install-AiCliBypass -Tool 'claude'
        Uninstall-AiCliBypass -Tool 'claude'
        Assert-Equal $processBefore $env:Path 'Uninstall left a process PATH entry owned by this install.'
        Assert-Equal $userBefore ([System.IO.File]::ReadAllText($context.UserPathFile)) 'Unowned user PATH entry was changed.'
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
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $configText = "model = `"gpt-test`"`r`n[features]`r`ngoals = true`r`n"
        Write-TestText -Path $configPath -Text $configText -Encoding (New-Object System.Text.UTF8Encoding($false))
        $configBefore = [System.IO.File]::ReadAllBytes($configPath)
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
        Assert-SequenceEqual $configBefore ([System.IO.File]::ReadAllBytes($configPath)) 'Late failure did not restore Codex config bytes.'
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

function Test-CodexLockedConfigUninstallRetry {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $lock = [System.IO.File]::Open($configPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try {
            Assert-Throws { Uninstall-AiCliBypass -Tool 'codex' } 'Locked Codex config must prevent destructive uninstall.' '*'
        }
        finally {
            $lock.Dispose()
        }
        $lines = @(Get-NpmLogLines $context)
        Assert-True (-not ($lines -contains 'uninstall --global @openai/codex')) 'Locked config uninstall removed the npm package before restoring settings.'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'Locked config uninstall removed the retryable wrapper.'
        Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) 'Locked config uninstall removed retryable state.'

        Uninstall-AiCliBypass -Tool 'codex'
        Assert-NpmLogContains $context 'uninstall --global @openai/codex'
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper)) 'Retry did not remove the Codex wrapper.'
    }
    finally {
        Remove-TestContext $context
    }

    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $fullAccessBefore = [System.IO.File]::ReadAllBytes($configPath)
        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '1'
        Assert-Throws { Uninstall-AiCliBypass -Tool 'codex' } 'A failed npm uninstall must roll Codex config back to Full Access.' '*npm*uninstall*'
        Assert-SequenceEqual $fullAccessBefore ([System.IO.File]::ReadAllBytes($configPath)) 'Failed npm uninstall left Codex in normal mode.'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'Failed npm uninstall removed the wrapper.'
        Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) 'Failed npm uninstall removed state.'

        Set-ProcessEnvironmentValue 'FAKE_NPM_FAIL_UNINSTALL' '0'
        Uninstall-AiCliBypass -Tool 'codex'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-CodexInvalidWrapperBlocksUninstall {
    $context = New-TestContext
    try {
        Install-AiCliBypass -Tool 'codex'
        $paths = Get-AiCliPaths -Tool 'codex'
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $fullAccessBefore = [System.IO.File]::ReadAllBytes($configPath)
        Remove-Item -LiteralPath $paths.Wrapper -Force
        $null = New-Item -ItemType Directory -Path $paths.Wrapper -Force
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))

        Assert-Throws { Uninstall-AiCliBypass -Tool 'codex' } 'A non-file wrapper must be rejected before destructive uninstall work.' '*non-file wrapper*'

        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Invalid wrapper path allowed npm uninstall to run.'
        Assert-SequenceEqual $fullAccessBefore ([System.IO.File]::ReadAllBytes($configPath)) 'Invalid wrapper path changed the Codex Full Access config.'
        Assert-True (Test-Path -LiteralPath $paths.ToolState -PathType Leaf) 'Invalid wrapper path removed retryable state.'
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
            & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer *> $null
            Assert-Equal 0 $LASTEXITCODE "Fresh-process installer failed for $toolName."
            Assert-NpmLogContains $context ('install --global ' + $expected.Package)
            & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $uninstaller *> $null
            Assert-Equal 0 $LASTEXITCODE "Fresh-process uninstaller failed for $toolName."
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
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer *> $null
        Assert-Equal 0 $LASTEXITCODE 'Fresh-process Claude installer failed.'
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $uninstaller -KeepCli *> $null
        Assert-Equal 0 $LASTEXITCODE 'Fresh-process Claude uninstaller failed.'
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
try {
    Invoke-Expression $entryText
    exit 0
}
catch {
    exit 77
}
'@
        [System.IO.File]::WriteAllText($runner, $runnerContent, (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-Equal 0 $LASTEXITCODE 'Remote bootstrap runner failed.'
        Assert-NpmLogContains $context 'install --global @openai/codex'

        $urls = @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' })
        Assert-SequenceEqual @($script:ExpectedRemoteUrl) $urls 'Remote bootstrap URL calls'

        $paths = Get-AiCliPaths -Tool 'codex'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'Initial remote bootstrap did not create the Codex wrapper.'
        Remove-Item -LiteralPath $paths.Wrapper -Force
        Assert-True (-not (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf)) 'Remote wrapper repair fixture still had the wrapper.'
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($urlLog, '', (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-Equal 0 $LASTEXITCODE 'Remote bootstrap wrapper repair runner failed.'
        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Remote bootstrap wrapper repair invoked npm.'
        Assert-SequenceEqual @($script:ExpectedRemoteUrl) @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' }) 'Remote bootstrap wrapper repair URL calls'
        Assert-True (Test-Path -LiteralPath $paths.Wrapper -PathType Leaf) 'Remote bootstrap did not recreate a deleted Codex wrapper.'

        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($urlLog, '', (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-Equal 0 $LASTEXITCODE 'Repeated remote bootstrap runner failed.'
        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Repeated remote bootstrap invoked npm.'
        Assert-Equal 0 @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' }).Count 'Repeated remote bootstrap downloaded the core.'

        $escapedConfig = '"approval\u005fpolicy" = "never"' + "`r`n" +
            '"sandbox\u005fmode" = "danger-full-access"' + "`r`n"
        [System.IO.File]::WriteAllText((Join-Path $context.CodexHome 'config.toml'), $escapedConfig, (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($urlLog, '', (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-Equal 0 $LASTEXITCODE 'Remote bootstrap rejected escaped Full Access keys.'
        Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Escaped Full Access preflight invoked npm.'
        Assert-Equal 0 @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' }).Count 'Escaped Full Access preflight downloaded the core.'

        $statePath = (Get-AiCliPaths -Tool 'codex').ToolState
        [System.IO.File]::WriteAllText($statePath, '{not-json', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($urlLog, '', (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-True ($LASTEXITCODE -ne 0) 'Remote bootstrap ignored malformed Codex state.'
        Assert-SequenceEqual @($script:ExpectedRemoteUrl) @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' }) 'Malformed-state remote bootstrap URL calls'
    }
    finally {
        Remove-TestContext $context
    }
}

function Test-RemotePreflightRejectsPermissionConflicts {
    $context = New-TestContext
    try {
        $entryPoint = Join-Path $script:RepositoryRoot 'install-codex-windows.ps1'
        $entryTextPath = Join-Path $context.Root 'downloaded entry point.ps1'
        $urlLog = Join-Path $context.Root 'remote conflict URL.log'
        $configPath = Join-Path $context.CodexHome 'config.toml'
        $conflicting = "approval_policy = `"never`"`r`n" +
            "sandbox_mode = `"danger-full-access`"`r`n" +
            "default_permissions = `":danger-full-access`"`r`n"
        Write-TestText -Path $configPath -Text $conflicting -Encoding (New-Object System.Text.UTF8Encoding($false))
        $before = [System.IO.File]::ReadAllBytes($configPath)
        [System.IO.File]::WriteAllText($entryTextPath, [System.IO.File]::ReadAllText($entryPoint), (New-Object System.Text.UTF8Encoding($false)))
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_CORE' $script:CorePath
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_ENTRY' $entryTextPath
        Set-ProcessEnvironmentValue 'FAKE_REMOTE_URL_LOG' $urlLog

        $runner = Join-Path $context.Root 'remote conflict runner.ps1'
        $runnerContent = @'
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod {
    param([string]$Uri, [switch]$UseBasicParsing)
    [System.IO.File]::AppendAllText($env:FAKE_REMOTE_URL_LOG, $Uri + [Environment]::NewLine)
    return [System.IO.File]::ReadAllText($env:FAKE_REMOTE_CORE)
}
$entryText = [System.IO.File]::ReadAllText($env:FAKE_REMOTE_ENTRY)
try {
    Invoke-Expression $entryText
    exit 0
}
catch {
    exit 77
}
'@
        [System.IO.File]::WriteAllText($runner, $runnerContent, (New-Object System.Text.UTF8Encoding($false)))
        & $script:PowerShellExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner *> $null
        Assert-True ($LASTEXITCODE -ne 0) 'Remote preflight accepted conflicting permission formats.'
        Assert-SequenceEqual @($script:ExpectedRemoteUrl) @([System.IO.File]::ReadAllLines($urlLog) | Where-Object { $_ -ne '' }) 'Remote conflict preflight URL calls'
        Assert-SequenceEqual $before ([System.IO.File]::ReadAllBytes($configPath)) 'Conflict rejection changed the Codex config.'
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
Invoke-Test 'Codex persists Full Access settings' { Test-CodexFullAccessConfig }
Invoke-Test 'Codex ignores comment-only triple delimiters' { Test-CodexCommentDelimiterConfigSafety }
Invoke-Test 'Codex removes a config it created' { Test-CodexAbsentConfigIsRemoved }
Invoke-Test 'Codex preserves UTF-8 config BOMs' { Test-CodexConfigBomIsPreserved }
Invoke-Test 'Codex restores settings and respects user changes' { Test-CodexConfigRestoreAndUserChanges }
Invoke-Test 'Codex preserves same-value config edits' { Test-CodexConfigRestorePreservesSameValueEdits }
Invoke-Test 'Codex rejects ambiguous permission settings' { Test-CodexConfigConflicts }
Invoke-Test 'Codex protects multiline config and home ownership' { Test-CodexMultilineConfigSafety; Test-CodexHomeChangeIsRejected }
Invoke-Test 'existing Codex target skips npm' { Test-CodexExistingTargetSkipsNpm }
Invoke-Test 'replacement Codex targets do not inherit ownership' { Test-CodexTargetReplacementDoesNotInheritOwnership }
Invoke-Test 'recreated Codex packages become owned' { Test-CodexRecreatedPackageClaimsOwnership }
Invoke-Test 'Codex rejects unrelated external shims' { Test-CodexRejectsUnrelatedExternalShim }
Invoke-Test 'reinstall is idempotent and failure-safe' { Test-Reinstall }
Invoke-Test 'Codex config preflight precedes npm mutation' { Test-CodexConfigPreflightBeforeNpmMutation }
Invoke-Test 'npm stderr warnings do not fail successful commands' { Test-NpmStderrWarning }
Invoke-Test 'uninstall reverses owned package' { Test-OwnedPackageUninstall }
Invoke-Test 'uninstall keeps pre-existing package' { Test-ExistingPackageUninstall }
Invoke-Test 'KeepCli retains package' { Test-KeepCli }
Invoke-Test 'PATH ownership and deduplication' { Test-PathLifecycle }
Invoke-Test 'missing npm fails without state' { Test-MissingNpm }
Invoke-Test 'npm and late failures roll back' { Test-InstallRollback }
Invoke-Test 'missing shim rolls back' { Test-MissingShimRollback }
Invoke-Test 'failed uninstall remains retryable' { Test-FailedUninstallRetry }
Invoke-Test 'locked Codex config uninstall remains retryable' { Test-CodexLockedConfigUninstallRetry }
Invoke-Test 'invalid Codex wrapper blocks destructive uninstall work' { Test-CodexInvalidWrapperBlocksUninstall }
Invoke-Test 'repeated and missing-state uninstall succeeds' { Test-RepeatedUninstall }
Invoke-Test 'local entry points select the correct action' { Test-LocalEntryPoints }
Invoke-Test 'remote bootstrap repairs wrappers and avoids repeat work' { Test-RemoteBootstrap }
Invoke-Test 'remote preflight rejects conflicting permission formats' { Test-RemotePreflightRejectsPermissionConflicts }
Invoke-Test 'tests isolate real npm and user PATH' { Test-DependencyIsolation }

Assert-Equal $script:RealUserPathBefore ([Environment]::GetEnvironmentVariable('Path', 'User')) 'The suite changed the real user PATH.'

if ($script:Failed -ne 0) {
    throw "$($script:Failed) test(s) failed; $($script:Passed) passed."
}
Write-Host "All $($script:Passed) Windows script tests passed."
