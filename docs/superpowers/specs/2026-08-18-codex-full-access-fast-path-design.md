# Codex Full Access Fast Path Design

## Goal

Make the Windows Codex installer a true one-command setup: after it succeeds,
every ordinary `codex` launch starts in the Codex **Full Access** preset, and a
repeat run with an existing Codex installation completes without invoking npm.

This change is intentionally limited to Codex. Claude Code and OpenCode keep
their current behavior until they are addressed separately.

## Current failure and root cause

The installed wrapper is correct and injects
`--dangerously-bypass-approvals-and-sandbox`. The failure occurs earlier in
command resolution: an already-running Windows process can retain a PATH that
does not contain `%LOCALAPPDATA%\ai-cli-bypass\bin`, so `codex` resolves to the
official npm `codex.ps1` instead of the project wrapper. In that case the bypass
argument never reaches Codex.

Reinstallation is slow for a separate reason. `Install-AiCliBypass` always runs
`npm install --global @openai/codex`, even when valid Codex state and an upstream
shim already exist.

Codex 0.147.0 defines the UI's Full Access preset as approval policy `never`
plus unrestricted (`danger-full-access`) local permissions. Persisting those
official settings removes the dependency on wrapper/PATH resolution.

## Required behavior

1. A successful Codex install writes the top-level Codex settings
   `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` to the
   active `$CODEX_HOME/config.toml` (or `~/.codex/config.toml` when
   `$CODEX_HOME` is unset).
2. Existing unrelated Codex configuration, comments, line endings, and UTF-8
   text remain intact.
3. The write is atomic. A parsing, validation, or write failure leaves the old
   configuration and installer state intact.
4. The installer records only the prior values/presence of the two owned keys;
   it must not copy the complete Codex config, which can contain credentials.
5. Uninstall restores the prior values only while the current values are still
   the values written by this project. User changes made afterward win.
6. When a valid existing Codex shim is available, install skips npm package
   listing, prefix lookup, and installation. It reuses the state target first,
   then a non-wrapper `codex.cmd` discovered on PATH.
7. When Codex is missing, the existing transactional npm installation and
   rollback behavior remains in place.
8. A repeated remote entry-point invocation may return from a small local
   preflight when Codex already runs and the config already expresses Full
   Access. It must not download the shared core or invoke npm on this path.
9. Managed Codex requirements are not bypassed. If Codex rejects Full Access
   because of an administrator policy, the installer reports that clearly.

## Architecture

### Codex config editor

Add focused helpers to `scripts/windows/AiCliBypass.ps1` that locate the active
Codex home, inspect top-level TOML assignments, and atomically set or restore
the two owned settings. The editor only recognizes assignments before the first
TOML table header, preventing accidental edits to similarly named keys inside a
table.

The editor rejects duplicate top-level owned keys and a simultaneous
`default_permissions` setting, because Codex does not allow
`default_permissions` and legacy `sandbox_mode` to be selected together. The
error tells the user what must be resolved instead of silently deleting their
permission-profile configuration.

The Codex tool-state JSON gains an optional `CodexConfig` object while keeping
schema version 1 so existing Claude/OpenCode state remains readable. It stores:

- the canonical config path;
- whether each owned key existed before installation;
- the original assignment line for each existing key.

On reinstall, an existing `CodexConfig` backup is preserved so the true
pre-install values are never replaced by this project's own values.

### Fast installed-package path

For Codex, target discovery follows this order:

1. a valid `TargetShim` from existing project state;
2. a `codex.cmd` found through command discovery whose canonical path is
   outside the project wrapper directory;
3. npm installation and `npm prefix --global` only when neither target exists.

Claude Code and OpenCode continue through the current npm path.

### Remote entry-point preflight

`install-codex-windows.ps1` performs a conservative preflight before loading
the shared core. It exits early only when:

- an upstream Codex command is available; and
- `approval_policy` is `never`; and
- either `sandbox_mode` is `danger-full-access` or the modern
  `default_permissions` setting is `:danger-full-access`.

Any ambiguity falls back to the shared core, preserving validation and repair.

## Transaction and rollback

The existing snapshots for wrapper and state files remain. Codex config is
updated before the new state is committed, with an in-memory snapshot used only
for immediate rollback. The snapshot is never serialized to project state.

If a later step fails, rollback restores the config bytes, wrapper, tool state,
global state, PATH, and any newly installed package in reverse order. A combined
error reports both the original failure and any rollback failure.

## Testing

Extend `tests/Test-WindowsScripts.ps1` with isolated `CODEX_HOME` fixtures and
assertions for:

- exact Full Access settings while preserving unrelated TOML;
- existing values backed up once across reinstall;
- uninstall restoration and user-change preservation;
- duplicate/conflicting configuration rejection without file changes;
- installed Codex reuse with zero npm log entries;
- missing Codex still performing one npm install;
- remote entry-point early return without loading the core;
- rollback restoring original config bytes.

Documentation tests will require the Simplified Chinese, Traditional Chinese,
and English READMEs to explain persistent Codex Full Access and the fast repeat
path.

## Safety

Full Access permits commands to modify files outside the workspace and use the
network without approval. The installer keeps the existing warning and makes
the persistent scope explicit. It does not suppress organization-managed
requirements or the user's ability to change permissions later.
