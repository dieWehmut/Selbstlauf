# Windows Installers and Multilingual README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tested one-command Windows install/uninstall entry points for Claude Code, Codex CLI, and OpenCode, then publish equivalent Simplified Chinese, Traditional Chinese, and English documentation.

**Architecture:** Six small root entry points select a tool and delegate to one shared PowerShell 5.1 core. The core installs official npm packages, creates non-recursive wrappers in a project-owned user bin directory, records ownership in JSON, and reverses only changes it owns. Self-contained PowerShell tests use fake npm and CLI commands plus a file-backed user PATH so verification never mutates the real user environment.

**Tech Stack:** Windows PowerShell 5.1+, CMD wrappers, npm global packages, JSON state, Git, Markdown.

---

## File Map

- Create `.gitattributes`: pin shell and documentation line endings.
- Create `scripts/windows/AiCliBypass.ps1`: tool registry, npm execution,
  wrapper generation, state, PATH, rollback, install, and uninstall behavior.
- Create `install-claude-windows.ps1`: Claude install entry point.
- Create `uninstall-claude-windows.ps1`: Claude uninstall entry point.
- Create `install-codex-windows.ps1`: Codex install entry point.
- Create `uninstall-codex-windows.ps1`: Codex uninstall entry point.
- Create `install-opencode-windows.ps1`: OpenCode install entry point.
- Create `uninstall-opencode-windows.ps1`: OpenCode uninstall entry point.
- Create `tests/Test-WindowsScripts.ps1`: isolated behavioral tests.
- Create `tests/Test-Documentation.ps1`: README/license/link parity tests.
- Modify `README.md`: Simplified Chinese default documentation.
- Create `docs/README.zh-TW.md`: Traditional Chinese documentation.
- Create `docs/README.en.md`: English documentation.
- Keep `LICENSE`: authoritative MIT license, verified but not rewritten.

### Task 1: Establish the failing Windows contract

**Files:**
- Create: `.gitattributes`
- Create: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Pin line endings**

Add:

```gitattributes
* text=auto
*.sh text eol=lf
*.ps1 text eol=crlf
*.cmd text eol=crlf
*.md text eol=lf
```

- [ ] **Step 2: Add a dependency-isolated test harness**

The harness must define concrete assertions and scenario helpers:

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Passed = 0
$script:Failed = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
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
```

`New-TestContext` must create a directory whose name contains a space, a fake
`npm.cmd`, an npm prefix, command shims for all three CLIs, an npm log, and a
file-backed user PATH. It must set these process variables and restore them in
`Remove-TestContext`:

```powershell
AI_CLI_BYPASS_HOME
AI_CLI_BYPASS_NPM
AI_CLI_BYPASS_USER_PATH_FILE
FAKE_NPM_PREFIX
FAKE_NPM_LOG
FAKE_NPM_PACKAGE_PRESENT
FAKE_NPM_FAIL_INSTALL
FAKE_NPM_FAIL_UNINSTALL
```

The fake npm command must log every invocation, print `FAKE_NPM_PREFIX` for
`prefix --global`, use `FAKE_NPM_PACKAGE_PRESENT` as the exit status for
`list --global`, and honor the two failure switches for install/uninstall.
Each fake CLI shim must log arguments to `<command>-args.txt` and exit with the
integer in `FAKE_CLI_EXIT`.

- [ ] **Step 3: Add explicit failing cases**

The initial suite must invoke the not-yet-created core and assert:

```powershell
Invoke-Test 'PowerShell files parse' { Test-PowerShellSyntax }
Invoke-Test 'tool definitions are exact' { Test-ToolDefinitions }
Invoke-Test 'installs all tool wrappers' { Test-AllToolInstalls }
Invoke-Test 'wrapper preserves arguments and exit code' { Test-WrapperForwarding }
Invoke-Test 'reinstall is idempotent' { Test-Reinstall }
Invoke-Test 'uninstall reverses owned package' { Test-OwnedPackageUninstall }
Invoke-Test 'uninstall keeps pre-existing package' { Test-ExistingPackageUninstall }
Invoke-Test 'KeepCli retains package' { Test-KeepCli }
Invoke-Test 'PATH ownership and deduplication' { Test-PathLifecycle }
Invoke-Test 'missing npm fails without state' { Test-MissingNpm }
Invoke-Test 'npm failure rolls back' { Test-InstallRollback }
Invoke-Test 'missing shim rolls back' { Test-MissingShimRollback }
Invoke-Test 'repeated uninstall succeeds' { Test-RepeatedUninstall }

if ($script:Failed -ne 0) {
    throw "$($script:Failed) test(s) failed; $($script:Passed) passed."
}
Write-Host "All $($script:Passed) Windows script tests passed."
```

The suite must build the non-ASCII path segment from character values so the
test source remains safe under Windows PowerShell 5.1:

```powershell
$unicodeName = ([string][char]0x6D4B) + ([string][char]0x8BD5)
```

- [ ] **Step 4: Run the suite and verify the red state**

Run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
```

Expected: non-zero exit because `scripts/windows/AiCliBypass.ps1` and the six
entry points do not exist. Confirm the failure is caused by missing production
files, not a syntax error in the test harness.

### Task 2: Implement shared definitions, paths, state, and npm helpers

**Files:**
- Create: `scripts/windows/AiCliBypass.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Define the public interface and exact tool registry**

Start the core with:

```powershell
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

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
```

- [ ] **Step 2: Add deterministic filesystem and process dependencies**

Implement these helpers with the stated behavior:

```powershell
Get-AiCliHome             # AI_CLI_BYPASS_HOME, else LOCALAPPDATA\ai-cli-bypass
Get-AiCliPaths            # Home, Bin, State, ToolState, GlobalState, Wrapper
Get-AiCliNpmCommand       # AI_CLI_BYPASS_NPM, else Get-Command npm.cmd
Invoke-AiCliNpm           # execute, preserve stdout, throw on unexpected exit
Read-AiCliJson            # literal path, ConvertFrom-Json
Write-AiCliAtomicText     # sibling temp + File.Replace/File.Move
Write-AiCliJson           # ConvertTo-Json -Depth 6 + UTF-8 without BOM
```

`Get-AiCliHome` must throw when neither `LOCALAPPDATA` nor `USERPROFILE` is
available. `Get-AiCliNpmCommand` must validate that an override exists before
returning it.

- [ ] **Step 3: Add exact PATH operations with a test store**

Implement:

```powershell
Get-AiCliUserPath
Set-AiCliUserPath
Test-AiCliPathEntry
Add-AiCliPathEntry
Remove-AiCliPathEntry
```

When `AI_CLI_BYPASS_USER_PATH_FILE` is set, the get/set pair must read/write
that file. Otherwise it must call:

```powershell
[Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', $value, 'User')
```

Comparison must be `OrdinalIgnoreCase` after trimming whitespace, quotes, and a
trailing slash. Adding must prepend exactly one entry to both user and current
process PATH. Removing must preserve all non-matching entries and their order.

- [ ] **Step 4: Run focused helper tests**

Run the full test command from Task 1. Expected: definition, state, and PATH
helper cases pass; install/uninstall and missing entry-point cases still fail.

### Task 3: Implement transactional installation and wrappers

**Files:**
- Modify: `scripts/windows/AiCliBypass.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Implement wrapper generation**

Add a function with this contract:

```powershell
function New-AiCliWrapperContent {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
}
```

It must reject double quotes or newlines in the target, double each literal `%`
in the target, and return ASCII CRLF content equivalent to:

```bat
@echo off
setlocal DisableDelayedExpansion
call "C:\absolute\npm-prefix\codex.cmd" --dangerously-bypass-approvals-and-sandbox %*
set "AI_CLI_BYPASS_EXIT=%ERRORLEVEL%"
endlocal & exit /b %AI_CLI_BYPASS_EXIT%
```

The target must be an absolute upstream npm shim outside the project wrapper
directory. This invariant prevents recursion.

- [ ] **Step 2: Implement package detection and installation**

Add:

```powershell
Test-AiCliPackageInstalled # npm list --global --depth=0 <package>
Get-AiCliNpmPrefix         # npm prefix --global; require a rooted path
Install-AiCliPackage       # npm install --global <package>
Uninstall-AiCliPackage     # npm uninstall --global <package>
```

`Test-AiCliPackageInstalled` may accept npm exit codes 0 and 1; any other code
must terminate. Installation and uninstallation require exit code 0.

- [ ] **Step 3: Implement `Install-AiCliBypass`**

Use this signature:

```powershell
function Install-AiCliBypass {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'opencode')][string]$Tool)
}
```

The function must:

1. Require `$env:OS -eq 'Windows_NT'`.
2. Load existing tool/global state before changing anything.
3. Preserve `InstalledByBypass` on reinstall; otherwise set it to the inverse
   of the initial package-presence check.
4. Install the official package and require `<npm-prefix>\<command>.cmd`.
5. Require the target and wrapper canonical paths to differ.
6. Atomically write the wrapper, tool state, and global state.
7. Add PATH ownership only when the exact user entry was absent.
8. On failure, restore the prior wrapper/state; remove a package and PATH entry
   only when the current first-time attempt created them.

Tool state properties must be exactly:

```powershell
SchemaVersion
Tool
Package
Command
TargetShim
WrapperPath
Arguments
InstalledByBypass
```

Global state properties must be exactly:

```powershell
SchemaVersion
WrapperDirectory
UserPathAddedByBypass
```

- [ ] **Step 4: Verify install behavior**

Run the Task 1 test command. Expected: all three installation cases, argument
forwarding, target exit code, space/non-ASCII paths, reinstall, PATH dedupe,
missing npm, npm failure, missing shim, and rollback pass. Uninstall and entry
point cases may remain red.

### Task 4: Implement state-aware uninstallation

**Files:**
- Modify: `scripts/windows/AiCliBypass.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Implement last-wrapper detection and cleanup**

Add helpers that enumerate only these project-owned names in the bin directory:

```powershell
claude.cmd
codex.cmd
opencode.cmd
```

Directory cleanup must use exact paths beneath `Get-AiCliHome` and remove only
empty `bin`, `state`, and home directories.

- [ ] **Step 2: Implement `Uninstall-AiCliBypass`**

Use:

```powershell
function Uninstall-AiCliBypass {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'opencode')][string]$Tool,
        [switch]$KeepCli
    )
}
```

When state says `InstalledByBypass` and `KeepCli` is false, run npm uninstall
before deleting state so a failed npm removal remains retryable. Then remove the
known wrapper and tool state. On the last wrapper, remove the PATH entry only
when global state says `UserPathAddedByBypass`, delete global state, and remove
empty project directories. With missing tool state, remove only the known
project wrapper and perform last-wrapper cleanup; never infer package ownership.

- [ ] **Step 3: Verify uninstall behavior**

Run the Task 1 test command. Expected: owned package removal, preservation of a
pre-existing package, `-KeepCli`, exact PATH ownership, failed npm retryability,
and repeated uninstall all pass. Only entry-point tests may remain red.

### Task 5: Add six one-command entry points

**Files:**
- Create: `install-claude-windows.ps1`
- Create: `uninstall-claude-windows.ps1`
- Create: `install-codex-windows.ps1`
- Create: `uninstall-codex-windows.ps1`
- Create: `install-opencode-windows.ps1`
- Create: `uninstall-opencode-windows.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Add a common bootstrap pattern to every entry point**

Each file must set strict error behavior, prefer the checked-out core at
`scripts/windows/AiCliBypass.ps1`, and otherwise load this exact raw URL:

```powershell
https://raw.githubusercontent.com/dieWehmut/ai-cli-bypass/main/scripts/windows/AiCliBypass.ps1
```

The bootstrap must validate that the downloaded text is non-empty, compile it
with `[scriptblock]::Create()`, dot-source it, and then verify that the expected
public function exists before calling it.

- [ ] **Step 2: Wire the installers**

Each installer ends with exactly one matching call:

```powershell
Install-AiCliBypass -Tool 'claude'
Install-AiCliBypass -Tool 'codex'
Install-AiCliBypass -Tool 'opencode'
```

- [ ] **Step 3: Wire the uninstallers**

Each uninstaller starts with `param([switch]$KeepCli)` and ends with one matching
call:

```powershell
Uninstall-AiCliBypass -Tool 'claude' -KeepCli:$KeepCli
Uninstall-AiCliBypass -Tool 'codex' -KeepCli:$KeepCli
Uninstall-AiCliBypass -Tool 'opencode' -KeepCli:$KeepCli
```

- [ ] **Step 4: Finish entry-point tests**

Parse all seven PowerShell production files with:

```powershell
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
```

Execute each entry point from a checked-out path using the fake environment and
assert that its matching package/action appears in the npm log. Stub
`Invoke-RestMethod` to return the local core text and execute an entry-point copy
with no local core, proving the raw bootstrap path without network access.

- [ ] **Step 5: Run the complete Windows suite**

Run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
```

Expected: exit code 0 and `All <N> Windows script tests passed.` with no real
npm packages or real user PATH changes.

- [ ] **Step 6: Inspect and commit the Windows implementation**

Run:

```powershell
git diff --check
git status --short
```

Confirm only `.gitattributes`, the shared core, six entry points, and the Windows
test are pending. Then commit:

```powershell
git add .gitattributes scripts/windows/AiCliBypass.ps1 tests/Test-WindowsScripts.ps1 install-claude-windows.ps1 uninstall-claude-windows.ps1 install-codex-windows.ps1 uninstall-codex-windows.ps1 install-opencode-windows.ps1 uninstall-opencode-windows.ps1
git commit -m "feat: add Windows CLI bypass installers"
```

### Task 6: Write three equivalent README files and license validation

**Files:**
- Modify: `README.md`
- Create: `docs/README.zh-TW.md`
- Create: `docs/README.en.md`
- Create: `tests/Test-Documentation.ps1`
- Verify: `LICENSE`

- [ ] **Step 1: Add documentation contract tests first**

The test must load all three README files as UTF-8 and assert:

```powershell
$windowsScripts = @(
    'install-claude-windows.ps1', 'uninstall-claude-windows.ps1',
    'install-codex-windows.ps1', 'uninstall-codex-windows.ps1',
    'install-opencode-windows.ps1', 'uninstall-opencode-windows.ps1'
)
$linuxScripts = @(
    'install-claude-root.sh', 'reset-claude.sh',
    'install-codex-root.sh', 'reset-codex.sh',
    'install-opencode-root.sh', 'reset-opencode.sh'
)
```

Every README must mention every script, all three package names, all three
injected arguments, Node.js/npm, PowerShell 5.1, the security warning, and MIT.
It must also assert that Markdown code fences are balanced and every relative
README/license link resolves from the source file's directory.

Verify `LICENSE` contains:

```text
MIT License
Copyright (c) 2026 dieWehmut
```

- [ ] **Step 2: Run the documentation test in the red state**

Run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1
```

Expected: non-zero exit because the two translated README files and the new
Windows content do not exist.

- [ ] **Step 3: Rewrite the Simplified Chinese root README**

Follow the reference structure exactly at the top:

```html
<h1 align="center">ai-cli-bypass</h1>

<p align="center">
  <img src="https://count.getloli.com/get/@ai-cli-bypass?theme=rule34" alt="Visitors">
</p>

<div align="center">
  <!-- flat-square Windows, PowerShell, three-tool, and MIT badges -->
</div>

<div align="center">

简体中文 | [繁體中文](docs/README.zh-TW.md) | [English](docs/README.en.md)

</div>

---
```

Then add equivalent sections for overview, features, security warning,
supported tools, requirements, Windows quick start, Windows uninstall,
`-KeepCli`, Linux quick start/reset, implementation details, troubleshooting,
project structure, upstream documentation, and MIT license.

- [ ] **Step 4: Add Traditional Chinese and English counterparts**

Use these exact language bars:

```markdown
[简体中文](../README.md) | 繁體中文 | [English](README.en.md)
```

```markdown
[简体中文](../README.md) | [繁體中文](README.zh-TW.md) | English
```

Commands, filenames, tables, warnings, and coverage must stay equivalent; only
prose is translated. The docs-level license link is `../LICENSE`.

- [ ] **Step 5: Run documentation and Windows verification**

Run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
git diff --check
```

Expected: both suites exit 0; no whitespace errors.

- [ ] **Step 6: Commit documentation separately**

```powershell
git add README.md docs/README.zh-TW.md docs/README.en.md tests/Test-Documentation.ps1 LICENSE
git commit -m "docs: add multilingual Windows usage guides"
```

`LICENSE` may remain unstaged when its verified content is unchanged.

### Task 7: Completion audit

**Files:**
- Verify all files from Tasks 1-6.

- [ ] **Step 1: Run authoritative verification from a clean test context**

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1
bash .\tests\test_claude.sh
```

The existing Linux integration test may be reported as skipped/unavailable when
the current Windows host has no Bash or external Claude installation; that does
not replace the two required Windows/documentation suites.

- [ ] **Step 2: Audit every requested artifact**

Confirm with `rg --files` and content searches that all six Windows entry points,
the core, three READMEs, tests, and `LICENSE` exist. Confirm every language page
contains every Windows install/uninstall command and all safety flags.

- [ ] **Step 3: Inspect commit boundaries and worktree**

```powershell
git log --oneline -4
git show --stat --oneline HEAD~2..HEAD
git status --short --branch
```

Expected: separate design, implementation, and documentation commits, with no
uncommitted task files. Do not claim completion if any requested artifact or
verification result is missing.
