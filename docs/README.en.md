<h1 align="center">Selbstlauf</h1>

<p align="center">
  <img src="https://count.getloli.com/get/@Selbstlauf?theme=rule34" alt="Visitors">
</p>

<div align="center">

[![Windows](https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square&logo=windows)](https://www.microsoft.com/windows)
[![PowerShell](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?style=flat-square&logo=powershell)](https://learn.microsoft.com/powershell/)
[![Tools](https://img.shields.io/badge/AI_CLI-3-2E8B57?style=flat-square)](#supported-tools)
[![License](https://img.shields.io/badge/License-MIT-333333?style=flat-square)](../LICENSE)

</div>

<div align="center">

[简体中文](../README.md) | [繁體中文](README.zh-TW.md) | English

</div>

---

## Overview

`Selbstlauf` (formerly `ai-cli-bypass`) provides one-command Windows installers and uninstallers for Claude Code, Codex CLI, and OpenCode while retaining the existing Linux root/sudo scripts. On Windows it installs the official npm package, creates an independent user-level wrapper, and injects the approval-bypass argument without replacing npm's own `.cmd` shim.

> [!WARNING]
> These scripts disable or bypass normal permission approval, sandbox, or confirmation protections. A malicious prompt, dependency, or command may read and write files or execute system operations without another prompt. Use this only in an isolated environment, container, or hardened sandbox that you fully trust. Do not run it on a daily-use machine that holds important data or credentials.

## Supported tools

| Tool | Official npm package | Windows install / uninstall | Linux install / reset | Injected argument |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-code` | `install-claude-windows.ps1` / `uninstall-claude-windows.ps1` | `install-claude-root.sh` / `reset-claude.sh` | `--dangerously-skip-permissions` |
| Codex CLI | `@openai/codex` | `install-codex-windows.ps1` / `uninstall-codex-windows.ps1` | `install-codex-root.sh` / `reset-codex.sh` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode-ai` | `install-opencode-windows.ps1` / `uninstall-opencode-windows.ps1` | `install-opencode-root.sh` / `reset-opencode.sh` | `--auto` |

## Requirements

### Windows

- Windows 10 or later
- Windows PowerShell 5.1 or later
- Node.js and npm, with `npm.cmd` available on PATH
- Native Claude Code on Windows also requires [Git for Windows](https://git-scm.com/download/win); configure Git Bash as required by its upstream documentation

The scripts change only the current user's environment and do not require administrator rights. Open a new PowerShell session if the command is not immediately available after installation.

### Linux

- Debian, Ubuntu, Fedora, RHEL, or Alpine Linux
- Node.js / npm
- The Claude Code root bypass needs `gcc`; its installer attempts to install it when missing

## One-command Windows install

Run the command for the tool you need in PowerShell:

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-opencode-windows.ps1 | iex
```

Then run `claude`, `codex`, or `opencode`. Re-running an installer is idempotent and does not recursively wrap an existing project wrapper.

## One-command Windows uninstall

```powershell
# Claude Code
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1 | iex

# Codex CLI
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1 | iex

# OpenCode
irm https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1 | iex
```

Uninstall removes this project's wrapper and state. It removes the npm package only when this project installed that package initially; a pre-existing package is preserved. Authentication, sessions, providers, and CLI configuration are never deleted.

Keep the npm CLI package and remove only the bypass wrapper:

```powershell
# Replace the URL with the matching uninstall-*-windows.ps1 when needed
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-claude-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-codex-windows.ps1'))) -KeepCli
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/uninstall-opencode-windows.ps1'))) -KeepCli
```

## Linux install and reset

Download each script before executing it so you can inspect its contents:

```bash
# Claude Code
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-claude-root.sh -o install-claude-root.sh
chmod +x install-claude-root.sh && ./install-claude-root.sh

# Codex CLI
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-codex-root.sh -o install-codex-root.sh
chmod +x install-codex-root.sh && ./install-codex-root.sh

# OpenCode
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/install-opencode-root.sh -o install-opencode-root.sh
chmod +x install-opencode-root.sh && ./install-opencode-root.sh
```

Restore each tool's normal launch behavior:

```bash
curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-claude.sh -o reset-claude.sh
chmod +x reset-claude.sh && ./reset-claude.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-codex.sh -o reset-codex.sh
chmod +x reset-codex.sh && ./reset-codex.sh

curl -L https://raw.githubusercontent.com/dieWehmut/Selbstlauf/main/reset-opencode.sh -o reset-opencode.sh
chmod +x reset-opencode.sh && ./reset-opencode.sh
```

## How it works

Each Windows entry point loads `scripts/windows/AiCliBypass.ps1`, which:

1. Installs or updates the matching official CLI package through npm.
2. Locates npm's real `.cmd` shim and leaves that upstream file unchanged.
3. Writes an independent wrapper under `%LOCALAPPDATA%\ai-cli-bypass\bin`, placing the dangerous argument before every user argument.
4. Records package and PATH ownership under `%LOCALAPPDATA%\ai-cli-bypass\state` so uninstall reverses only project-owned resources.
5. Validates and rolls back writes, reinstalls, and failure paths; wrappers preserve upstream exit codes and user arguments.

The Linux scripts use tool-specific wrappers. Claude Code additionally uses `LD_PRELOAD` to handle its root UID check.

## Troubleshooting

- **`npm.cmd` is missing**: install Node.js/npm and confirm `Get-Command npm.cmd` succeeds in a new PowerShell session.
- **The command is missing after install**: reopen PowerShell so the user PATH refreshes, or re-run the matching installer.
- **Claude Code does not start on Windows**: install Git for Windows and configure the Git Bash path as described by Claude Code upstream.
- **npm package uninstall fails**: repair the npm network or permission problem and retry; state is retained for the next attempt.
- **You only want normal approvals back**: run the matching `uninstall-*-windows.ps1`; add `-KeepCli` to retain the CLI package.

## Project structure

```text
.
|-- install-*-windows.ps1       # compatibility entry points
|-- uninstall-*-windows.ps1     # compatibility entry points
|-- install-*-root.sh           # compatibility entry points
|-- reset-*.sh                  # compatibility entry points
|-- scripts/install/windows/*   # Windows installers
|-- scripts/install/linux/*     # Linux installers
|-- scripts/uninstall/windows/* # Windows uninstallers
|-- scripts/uninstall/linux/*   # Linux reset scripts
|-- scripts/windows/AiCliBypass.ps1
|-- scripts/continuation/*      # watchdog lifecycle
|-- tests/Test-WindowsScripts.ps1
|-- tests/Test-Documentation.ps1
|-- docs/README.zh-TW.md
|-- docs/README.en.md
`-- LICENSE
```

## Codex Full Access on Windows

The Codex installer persistently writes the official Full Access settings to
the active `CODEX_HOME/config.toml`:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

This makes ordinary `codex` launches use Full Access even when an existing
PowerShell session resolves npm before the wrapper. Re-running the installer
detects the existing Codex command, skips npm and core downloads, and repairs
only bypass-owned files. Uninstall restores the previous settings unless you
changed them after installation.

> [!WARNING]
> Full Access disables normal approval and sandbox protections. Use it only in
> an environment you fully trust.

## Continuation Watchdog

The local watchdog monitors each same-user Claude/Codex process independently.
It waits for the configured quiet period, records decisions, and uses `继续`
for ordinary sessions or `/goal resume` only for a resumable Codex goal.
Enable writes only after reviewing the process and transport status in the UI.

```powershell
npm install
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\start-watchdog.ps1 -DryRun
Start-Process http://127.0.0.1:48920/
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\stop-watchdog.ps1
```

Install the per-user watchdog repeatedly without changing CLI packages. Add
`-Startup` to register an owned logon task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\install-watchdog.ps1 -DryRun -Startup
powershell -ExecutionPolicy Bypass -File .\scripts\continuation\uninstall-watchdog.ps1
```

The installer owns only `%LOCALAPPDATA%\ai-cli-bypass\continuation` and records
that boundary in `install-manifest.json`. The uninstaller validates the manifest,
PID, and repository path, removes only the owned state and owned logon task, and
leaves npm packages, CLI wrappers, authentication, sessions, and other
`ai-cli-bypass` state untouched. The local WebUI uses `/api/watchdog/start`,
`/api/watchdog/stop`, `/api/install`, `/api/startup`,
`/api/startup/install`, `/api/startup/uninstall`, and `/api/uninstall` for
these lifecycle actions.

### Local tool discovery and DeepSeek Harness

Every poll enumerates same-user processes read-only and merges each tool's root
and child processes into one logical session:

| Tool | Process signature | Session association | Input transport |
|---|---|---|---|
| Claude Code | `claude.ps1`, `claude-code` | JSONL under `~/.claude/projects` | Console / PTY / Stop Hook |
| Codex CLI | `codex.exe`, `@openai/codex`, `codex.js` | thread and goal databases under `~/.codex` | Codex App Server |
| DeepSeek Harness | `dsh.exe` / `dsh.cmd`, `@deepseek-ai/dsh`, `apps/cli/lib/bin.js` and `subprocess-local/runner.js` under `deepseek-harness` | session directories under `$DSH_HOME/sessions` plus the `storages/session_projcache` projection | Harness local session API |

One DeepSeek Harness `web` host serves many workspaces, so the host process is
not itself an agent: the watchdog expands every live harness session into its
own row. The row keeps the harness `session-…` identity, takes its workspace
from the session projection `cwd`, and measures quiet time from the newest write
to the session log or projection. `turnBoundary.lastStepBoundary.kind` states
whether a step is still running, so the UI separates "running a step" from
"waiting for input". Sessions that never received a prompt, and sessions outside
the activity window, are not listed.

The harness session log is a zstd-compressed append-only log. The watchdog reads
only its first line to recover `cwd` and never writes to it.

### Continuing a DeepSeek Harness session

The harness has no console and no PID-scoped input channel: a session is
addressed by its own identity and its owner is a long-lived `web` process. The
watchdog therefore uses the harness's own local interface. It enumerates the
loopback ports the host listens on, confirms the 401 fingerprint on `GET /`,
reads the `client-connection/browser-session` secret the harness itself stores
in `$DSH_HOME/.credentials.yaml`, signs the same browser cookie the UI uses, and
calls the same `session/prompt` endpoint (`mode: queue`) the WebUI calls.

The safety boundary is deliberately narrow:

- Only loopback http origins are contacted. The credential is read-only, used for
  that one request, never logged and never persisted.
- A session is written to only when it currently has **no unfinished step**
  (`turnOpen === false`); a running agent is never interrupted. That is a second
  gate independent of the quiet-period threshold.
- A dry run only locates the harness: it probes the origin without reading the
  credential and writes nothing. The same holds when the tool is disabled.
- Every failure (unreadable secret, wrong fingerprint, rejected cookie, vanished
  session) falls back to `monitor-only` with a stated reason instead of guessing.
- Writes go only through the harness's own session controller; no global keyboard
  or mouse API is used.

`tools.dsh.allowApiInput` (on by default) controls that channel, and
`tools.dsh.sessionWindowMs` (default one hour) decides when an inactive session
becomes history.

### Where a session runs, and revealing it

Every row reports the application the agent actually lives in rather than only a
PID: process discovery walks the ancestor chain and takes one `EnumWindows` pass
over the top-level windows those ancestors own, which recognizes **Tabby /
Windows Terminal / VS Code / Cursor / the Codex app (ChatGPT.exe) / Edge /
Chrome / Firefox** and records the window handle that can be raised. The
"running location" column shows that host and its window title, and the adjacent
button calls `POST /api/sessions/<id>/focus` to restore and raise the window.

Harness rows are the exception: their interface is served by a browser, and the
browser is not in the session's process tree. A harness row therefore finds the
browser window whose title carries the `DSH` marker (browser windows first, any
matching window second); when no window matches, the row names the harness WebUI
and opens that loopback address instead. Revealing uses window-management calls
only (`SetForegroundWindow`, `AttachThreadInput`, `SwitchToThisWindow`,
`SetWindowPos`) and never synthesizes keyboard or mouse input. When Windows
refuses the foreground change because of the foreground lock, the window is
still raised to the top of the z-order and the UI says so.

Process discovery needs `powershell.exe` (Windows PowerShell 5.1 or later). The
owner SID comes from the process token instead of a per-process WMI
`GetOwnerSid()` call, which cost nearly a minute per poll on a busy desktop; the
full discover → associate → decide chain now completes within the default
two-second poll interval.

To verify that monitoring and continuation really work on this machine instead of
checking health alone:

```powershell
npm run build
node .\scripts\verify\live-monitoring.mjs      # every local agent is found, with its location
node .\scripts\verify\dsh-continuation.mjs     # the harness really accepts a "继续"
```

`live-monitoring.mjs` enumerates this machine's processes and harness sessions
independently, then requires the running service to report a matching row for
each one with the right tool, workspace, running location and transport, and
requires recorded activity/decision events with no injection.
`dsh-continuation.mjs` owns a disposable harness session, sends `继续` through the
very transport the watchdog uses, requires the harness to accept and persist it,
and then cancels the turn it started. Real runs are recorded in
[verification/2026-09-17-live-monitoring.md](verification/2026-09-17-live-monitoring.md)
and [verification/2026-09-18-harness-continuation.md](verification/2026-09-18-harness-continuation.md).

## Desktop App and Installer

The Electron desktop shell hosts the watchdog service and the WebUI in one
window, so no separate `start-watchdog.ps1` step is required. Download the
`Selbstlauf-Setup-<version>-<arch>.exe` asset from the
[GitHub releases](https://github.com/dieWehmut/Selbstlauf/releases) and run it.
The assisted installer writes into `%LOCALAPPDATA%\Programs\Selbstlauf`, creates
desktop and start menu shortcuts, and registers an uninstaller; it targets the
current user only and needs no elevation.

Release builds are produced by `.github/workflows/release-desktop.yml`, which
runs on a `v*` tag or on demand. It builds and tests every workspace, smoke tests
the desktop shell, packages the x64 and arm64 setups, verifies the x64 setup with
`scripts/desktop/verify-installer.ps1` (complete install, shortcuts, uninstall
entry, bundled service health, served WebUI, clean uninstall), and then publishes
the installers to the GitHub release for a tagged run or keeps them as a workflow
artifact otherwise.

That verification also starts one process carrying a supported CLI signature and
requires the *installed* app to discover it, mark it alive, and record a
per-session decision before the probe is removed. Health and WebUI checks alone
are not enough: `tsc` never emits the PowerShell resource, the service resolves
it beside its own module, and an installer that omits it still starts, still
serves its WebUI, and discovers nothing.
`resources/service-dist/src/process/windows-processes.ps1` is therefore both a
packaging and an acceptance entry.

```powershell
npm install
npm run build
npm --workspace apps/desktop run package:win   # writes tmp\desktop-dist
npm --workspace apps/desktop run smoke         # headless packaged-service check
```

Once installed, **安装启动项** on the WebUI settings page registers the per-user
logon task from the installed app, and **移除启动项** removes it. The task runs
`resources\scripts\continuation\start-watchdog.ps1` inside the install root and
falls back to the bundled `service-dist` entry, so it works without a repository
checkout.

### Claude Stop Hook

The Claude Stop Hook is disabled by default. Open the local WebUI Settings page,
review the `dryRun` status, adjust the lease lifetime, command timeout, and
ordinary Claude prompt, then choose **Install Stop Hook** and save the
configuration. Installation changes only the current user's
`%USERPROFILE%\.claude\settings.json` and writes a checksum-protected ownership
manifest under the watchdog state directory. Fully exit and restart every
already-open Claude process so it loads the new Hook.

The Hook consumes one lease only when the session, process identity, working
directory, transcript path, and transcript activity fingerprint all match.
Recent output, an ambiguous association, recursive Hook input, or an expired
lease returns an empty decision and submits nothing. **Disable Stop Hook** clears
pending leases; **Uninstall Stop Hook** restores the exact original settings
bytes from the owned backup. If the settings file changed after installation,
the UI reports manual review and refuses to overwrite the user's changes.

The Hook CLI does not read transcript contents and does not use a global keyboard
API. Codex continues to use the App Server or a PID-validated terminal
transport; unsupported sessions remain `monitor-only`. Disable the Hook before
uninstalling the watchdog when desired. CLI packages, authentication, and
conversation data are not removed by these lifecycle operations.

Writes require a PID-validated classic Console bridge, a service-owned PTY, or
the Codex App Server. Unsupported ConPTY sessions remain `monitor-only`; the
service never uses a global keyboard API. The WebUI can pause sessions, change
prompts, inspect the redacted audit timeline, and remove watchdog-owned state.

### Codex endpoint switching

The local WebUI Settings page includes an endpoint panel for switching the
Codex endpoint inside `CODEX_HOME/config.toml`. It lists the active `model`,
`review_model`, `model_reasoning_effort`, `base_url`, and
`experimental_bearer_token` values, and shows every endpoint parked as a
comment as a clickable chip; choose a chip to switch back, or edit a field and
apply the panel to write a new value.

Switching mirrors how the file is maintained by hand: a matching parked line
is activated, the previously active assignment is parked as a comment, unknown
values replace the active line, and missing keys are appended after the last
top-level assignment. Unrelated content and `[section]` blocks are preserved
byte for byte. Every write is preceded by a `.bak` copy plus a `sha256` sidecar
and performed through an atomic temporary-file replace, so an interrupted
switch is recoverable by hand; writes are serialized so concurrent switches
cannot interleave.

The local routes are `GET /api/codex/profiles` and `PUT /api/codex/profiles`
(body `{ "fields": [{ "key": "base_url", "value": "..." }] }`), and every
change is recorded as a `user-override` audit event. The panel is available
only from the localhost watchdog; the Pages demo uses in-memory sample data
and never touches local files.
## WebUI demo site

Run the management UI locally with:

```powershell
npm install
npm --workspace apps/web run dev
```

The repository's `.github/workflows/deploy-pages.yml` builds the static demo on
pushes to `main` and publishes it through GitHub Actions. Enable **GitHub
Actions** as the Pages source once in repository Settings. The public project
site is [https://dieWehmut.github.io/Selbstlauf/](https://dieWehmut.github.io/Selbstlauf/).
Pages uses in-memory sample data and cannot install a local Hook or inject into
processes; those actions are available only from the localhost watchdog.

## Upstream documentation

- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI documentation](https://developers.openai.com/codex/cli/)
- [OpenCode documentation](https://opencode.ai/docs/)

## License

This project is available under the [MIT License](../LICENSE).
