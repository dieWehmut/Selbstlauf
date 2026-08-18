# Codex Full Access Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows Codex installer persist the Codex Full Access preset and skip every npm operation when a valid Codex installation already exists.

**Architecture:** Add a narrow, ownership-aware TOML editor and Codex target discovery to the shared PowerShell core. Store only the previous owned assignments in the existing Codex state, restore them on uninstall, and add a conservative bootstrap preflight so repeated remote runs avoid loading the core. Leave Claude Code and OpenCode package behavior unchanged.

**Tech Stack:** Windows PowerShell 5.1, TOML line editing, JSON state, CMD wrappers, isolated fake npm/CLI tests.

---

### Task 1: Establish the Codex configuration contract

**Files:**
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Isolate Codex home in every Windows test**

Add `CODEX_HOME` to `$script:EnvironmentNames`. In `New-TestContext`, create
`$codexHome = Join-Path $root 'codex home'`, set the process variable, and return
it from the context object:

```powershell
$codexHome = Join-Path $root 'codex home'
$null = New-Item -ItemType Directory -Path $codexHome -Force
Set-ProcessEnvironmentValue 'CODEX_HOME' $codexHome

return [pscustomobject]@{
    # existing properties remain
    CodexHome = $codexHome
}
```

- [ ] **Step 2: Write failing Full Access and conflict tests**

Add tests that seed a CRLF UTF-8 config with unrelated content, install Codex,
and require exactly one top-level assignment for each owned key:

```powershell
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
    }
    finally { Remove-TestContext $context }
}
```

Add a second test with duplicate `approval_policy` assignments and another with
`default_permissions = ":workspace"`; both must throw and leave config bytes
unchanged.

- [ ] **Step 3: Run the focused suite and verify RED**

Run:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
```

Expected: the new Codex configuration test fails because the two Full Access
assignments and `CodexConfig` state do not exist.

### Task 2: Implement atomic Full Access configuration and restoration

**Files:**
- Modify: `scripts/windows/AiCliBypass.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Add focused config helpers**

Implement these functions in the shared core:

```powershell
function Get-AiCliCodexConfigPath {
    $home = $env:CODEX_HOME
    if ([string]::IsNullOrWhiteSpace($home)) {
        if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            throw 'Cannot determine CODEX_HOME because USERPROFILE is unavailable.'
        }
        $home = Join-Path $env:USERPROFILE '.codex'
    }
    return Join-Path (Get-AiCliFullPath $home) 'config.toml'
}

function Get-AiCliTopLevelTomlAssignments {
    param([AllowEmptyString()][string]$Text, [string[]]$Names)
    # Scan only before the first non-comment table header. Return line indexes,
    # names, values, and raw lines; reject duplicate owned names.
}

function Set-AiCliCodexFullAccess {
    param($ExistingBackup)
    # Reject default_permissions, preserve the original two assignment lines,
    # replace/insert approval_policy and sandbox_mode before the first table,
    # preserve CRLF/LF and final-newline shape, and atomically write UTF-8.
}

function Restore-AiCliCodexConfig {
    param($Backup)
    # Restore/remove only assignments still equal to this project's values.
}
```

The returned backup object must contain `Path`, `ApprovalPolicy`, and
`SandboxMode`; each setting contains `Present` and `RawLine`. Never store the
complete file text in state.

- [ ] **Step 2: Integrate config into install transaction**

For Codex, snapshot the config file in memory, call
`Set-AiCliCodexFullAccess`, add the returned object as the ordered
`CodexConfig` property on tool state, and preserve an existing backup on
reinstall. In the catch path, restore the config snapshot before removing a
newly installed package.

- [ ] **Step 3: Integrate ownership-aware uninstall**

Before deleting Codex tool state, call `Restore-AiCliCodexConfig` when the
optional `CodexConfig` property is present. If the current setting differs from
the project value, leave it unchanged and emit a warning.

- [ ] **Step 4: Add restoration, user-change, and rollback tests**

Cover an absent original key, an original non-Full-Access value, repeat install
preserving the first backup, user edits after install, and a late locked-state
failure restoring the config bytes exactly.

- [ ] **Step 5: Run the suite and verify GREEN**

Run the Windows suite. Expected: all configuration, restoration, rollback, and
existing wrapper tests pass.

### Task 3: Skip npm for an existing Codex installation

**Files:**
- Modify: `scripts/windows/AiCliBypass.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Write the failing zero-npm test**

Install Codex once, clear the fake npm log, reinstall, and require zero log
lines while keeping the same target and original config backup:

```powershell
[System.IO.File]::WriteAllText($context.NpmLog, '', (New-Object System.Text.UTF8Encoding($false)))
Install-AiCliBypass -Tool 'codex'
Assert-Equal 0 @(Get-NpmLogLines $context).Count 'Existing Codex reinstall invoked npm.'
```

Add a no-state case that places the fake prefix on PATH and verifies discovery
of its `codex.cmd` without npm.

- [ ] **Step 2: Verify RED**

Run the Windows suite. Expected: the zero-npm assertion fails with an
`install --global @openai/codex` log entry.

- [ ] **Step 3: Implement safe target discovery**

Add `Find-AiCliExistingTargetShim` that accepts only an existing `.cmd` outside
the project wrapper directory. For Codex, reuse validated state first, then
enumerate `Get-Command codex.cmd -All`; only call npm installation and prefix
lookup when discovery returns null. Preserve `InstalledByBypass` from state,
and set it false for a discovered pre-existing target.

- [ ] **Step 4: Verify GREEN and generic behavior**

Run the Windows suite. Expected: Codex reinstall has no npm calls, missing
Codex still installs once, and Claude/OpenCode npm assertions remain unchanged.

### Task 4: Add the remote bootstrap fast path

**Files:**
- Modify: `install-codex-windows.ps1`
- Modify: `tests/Test-WindowsScripts.ps1`
- Test: `tests/Test-WindowsScripts.ps1`

- [ ] **Step 1: Write the failing bootstrap preflight test**

After one remote bootstrap install, clear the URL and npm logs, invoke the same
downloaded entry text again, and assert both logs remain empty. The test runner
must expose the fake upstream Codex directory on PATH.

- [ ] **Step 2: Verify RED**

Run the Windows suite. Expected: the second invocation downloads the core.

- [ ] **Step 3: Implement conservative local preflight**

At the start of `install-codex-windows.ps1`, resolve the active Codex config,
scan only top-level assignments, and return early when a non-wrapper Codex
command exists with `approval_policy = "never"` and either accepted Full Access
sandbox key. Print:

```powershell
Write-Host 'Codex is already installed and configured for Full Access; skipped npm and wrapper setup.'
Write-Warning 'Full Access disables normal approval and sandbox protections. Use it only in an environment you trust.'
return
```

Any duplicate, missing, or conflicting assignment falls through to the core.

- [ ] **Step 4: Verify GREEN**

Run the Windows suite. Expected: the first bootstrap loads the exact core URL;
the second loads no URL and invokes no npm.

### Task 5: Document persistent Codex Full Access

**Files:**
- Modify: `README.md`
- Modify: `docs/README.zh-TW.md`
- Modify: `docs/README.en.md`
- Modify: `tests/Test-Documentation.ps1`
- Test: `tests/Test-Documentation.ps1`

- [ ] **Step 1: Add failing documentation assertions**

Require every README to contain the literal keys `approval_policy`,
`sandbox_mode`, and `danger-full-access`, plus language-appropriate text that
the setting is persistent and repeat setup skips npm.

- [ ] **Step 2: Verify RED**

Run the documentation suite. Expected: it fails on the first missing config
key.

- [ ] **Step 3: Update all three READMEs**

Explain that the Codex installer persists Full Access, ordinary `codex`
launches no longer depend on wrapper PATH resolution, repeat runs skip npm, and
uninstall restores settings owned by this project. Retain the prominent danger
warning.

- [ ] **Step 4: Verify GREEN**

Run the documentation suite. Expected: `All documentation tests passed.`

### Task 6: Complete verification

**Files:**
- Verify: all modified production, test, and documentation files

- [ ] **Step 1: Run syntax, behavior, and documentation tests**

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1
git diff --check
```

Expected: both suites exit zero and `git diff --check` prints nothing.

- [ ] **Step 2: Run a real isolated Codex config resolution check**

Use a temporary `CODEX_HOME` containing the generated settings and run:

```powershell
codex --strict-config --version
```

Expected: exit zero, proving Codex 0.147.0 accepts the emitted configuration.
Do not invoke an API-backed Codex turn.

- [ ] **Step 3: Review the final diff and commit**

Confirm only the shared core, Codex entry point, tests, three READMEs, and plan
artifacts changed. Commit with:

```powershell
git add scripts/windows/AiCliBypass.ps1 install-codex-windows.ps1 tests/Test-WindowsScripts.ps1 tests/Test-Documentation.ps1 README.md docs/README.zh-TW.md docs/README.en.md docs/superpowers/plans/2026-08-18-codex-full-access-fast-path.md
git commit -m "fix: persist Codex full access on Windows"
```
