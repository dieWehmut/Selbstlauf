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

Writes require a PID-validated classic Console bridge, a service-owned PTY, or
the Codex App Server. Unsupported ConPTY sessions remain `monitor-only`; the
service never uses a global keyboard API. The WebUI can pause sessions, change
prompts, inspect the redacted audit timeline, and remove watchdog-owned state.

## Upstream documentation

- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex CLI documentation](https://developers.openai.com/codex/cli/)
- [OpenCode documentation](https://opencode.ai/docs/)

## License

This project is available under the [MIT License](../LICENSE).
