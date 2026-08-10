# Windows Installers and Multilingual Documentation Design

## Goal

Add one-command Windows installation and uninstallation for Claude Code, Codex
CLI, and OpenCode without changing the existing Linux scripts. Publish matching
Simplified Chinese, Traditional Chinese, and English README files, and retain
the repository's standard MIT license.

## Scope

The change will add:

- Six user-facing PowerShell entry points at the repository root: one installer
  and one uninstaller for each supported CLI.
- A shared Windows implementation module under `scripts/windows/`.
- A Windows test harness that runs without installing real npm packages or
  changing the real user PATH.
- A Simplified Chinese root README and matching Traditional Chinese and English
  documents under `docs/`.
- README links to the existing `LICENSE` file.

The change will not alter the current Linux install/reset behavior, delete CLI
authentication or configuration data, install Node.js, or support OpenCode 2
beta packages.

## Alternatives Considered

### Six self-contained scripts

Each entry point could contain the complete installation implementation. This
would make every raw file independently executable, but it would duplicate PATH,
state, rollback, and npm handling six times.

### Shared core with six entry points (selected)

A shared PowerShell core will hold all behavior. Six small entry points will
select a tool and action. A checked-out entry point will load the local core; a
raw one-command entry point will download the core from the same repository.
This keeps the commands obvious while centralizing behavior and tests.

### Two parameterized scripts

A single installer and uninstaller could accept `-Tool`. This would minimize the
file count, but the remote PowerShell invocation would be less discoverable and
less convenient than one URL per tool.

## Supported Tools

| Tool | npm package | Command | Injected argument |
|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | `claude` | `--dangerously-skip-permissions` |
| Codex CLI | `@openai/codex` | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode-ai` | `opencode` | `--auto` |

The selected packages and arguments are the stable upstream interfaces as of
2026-08-10. The README will link to the corresponding upstream documentation
and warn that these modes remove normal approval protections.

## Files and Interfaces

The root entry points will be:

- `install-claude-windows.ps1`
- `uninstall-claude-windows.ps1`
- `install-codex-windows.ps1`
- `uninstall-codex-windows.ps1`
- `install-opencode-windows.ps1`
- `uninstall-opencode-windows.ps1`

They will load `scripts/windows/AiCliBypass.ps1` and call one of these public
functions:

```powershell
Install-AiCliBypass -Tool claude
Uninstall-AiCliBypass -Tool claude [-KeepCli]
```

The core will support Windows PowerShell 5.1 and newer. User-facing scripts will
use ASCII source where practical so Windows PowerShell does not depend on an
encoding declaration.

## Install Flow

1. Verify that the process is running on Windows and that `npm.cmd` is available.
2. Resolve the selected tool definition from a fixed internal table.
3. Detect whether the npm package existed before the first bypass installation.
4. Run the official global npm installation command and verify the resulting
   `<npm-prefix>\<command>.cmd` shim.
5. Create `%LOCALAPPDATA%\ai-cli-bypass\bin\<command>.cmd`. The wrapper calls the
   npm shim by absolute path, injects the tool's bypass argument before all user
   arguments, and returns the real process exit code.
6. Atomically write per-tool JSON state under
   `%LOCALAPPDATA%\ai-cli-bypass\state\`.
7. Prepend the wrapper directory to the current process PATH and the current
   user's persisted PATH, using case-insensitive exact-entry deduplication.
8. Print the installed command, injected mode, and a security warning.

The installer will never replace or delete an upstream npm shim. Reinstallation
will retain the original `installedByBypass` value and replace only this
project's wrapper and state atomically.

## Uninstall Flow

1. Load the tool state when present.
2. Remove only this project's wrapper and per-tool state.
3. If the npm package did not exist before the first install, uninstall that
   package unless `-KeepCli` was specified. If the package already existed,
   leave it installed.
4. When no project wrappers remain, remove the wrapper PATH entry only if this
   project originally added it, then remove empty project directories.
5. Never remove authentication, provider, session, or CLI configuration data.

Running an uninstaller repeatedly will succeed. If state is missing, it may
remove the known project wrapper but will not guess whether the upstream package
should be removed.

## State and PATH Ownership

Each tool state will contain the schema version, tool, package, target shim,
wrapper path, injected arguments, and whether the package was installed by this
project. A separate global state file will record whether this project added its
wrapper directory to the user PATH.

PATH comparison will trim trailing separators and compare entries without case
sensitivity. The implementation will use
`[Environment]::SetEnvironmentVariable()` instead of `setx`, avoiding PATH
truncation and unwanted variable expansion.

## Failure Handling

- Unsupported tools, non-Windows hosts, missing npm, failed npm commands, and
  missing generated shims will produce terminating errors.
- Wrapper and JSON files will be written to temporary siblings and moved into
  place only after their content is complete.
- If a first-time install fails after adding a package or PATH entry, the
  installer will roll back only resources created by that attempt.
- A failed reinstall will leave the last working wrapper and state intact.
- Paths will be passed as literal values and quoted in generated command files.

## Testing

`tests/Test-WindowsScripts.ps1` will provide a dependency-isolated test harness.
It will use temporary directories, a fake npm command, stub CLI shims, and mocked
user-PATH accessors. It must not modify the real user PATH or install/uninstall
real npm packages.

Coverage will include:

- PowerShell syntax parsing for the core and all six entry points.
- Correct package and injected argument for all three tools.
- User argument ordering and propagation of the target exit code.
- Paths containing spaces and non-ASCII characters.
- PATH deduplication and exact removal.
- Idempotent reinstallation without wrapper recursion.
- State-aware uninstall for pre-existing and newly installed packages.
- `-KeepCli`, repeated uninstall, missing npm, npm failure, and missing shim.
- Rollback after a partial first-time installation.

The test will first be run before implementation to demonstrate the expected
failure, then rerun after implementation until it passes.

## Documentation

The README layout will follow `diesuwa-starter`:

- Centered project title.
- Centered flat-square status/license badges.
- Centered `简体中文 | 繁體中文 | English` language navigation.
- A horizontal divider followed by a concise project description.
- Feature, safety, supported-tool, requirements, quick-start, uninstall,
  troubleshooting, project-structure, and license sections.

Language files will be:

- `README.md`: Simplified Chinese (default).
- `docs/README.zh-TW.md`: Traditional Chinese.
- `docs/README.en.md`: English.

All three documents will contain equivalent commands and safety information.
The existing standard MIT `LICENSE` with copyright `2026 dieWehmut` will remain
the authoritative license file.

## Incremental Commits and Verification

1. Commit this design after scanning for placeholders, contradictions, and scope
   gaps.
2. Add the failing Windows tests, implement the core and six entry points, run
   the isolated Windows suite, and commit the passing implementation.
3. Add the three equivalent README versions and license links, validate links,
   commands, language navigation, and content parity, then commit documentation.
4. Run the complete repository verification and inspect the final commit range
   and worktree before declaring completion.
