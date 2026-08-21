# Claude Stop Hook Continuation Design

## Status

Approved working design for the Claude capability of the continuation
watchdog. This document extends the monitor-only behavior in the
`2026-08-19-continuation-watchdog-design.md` specification. It does not grant
the watchdog permission to edit a user's Claude configuration automatically.

## Problem

The watchdog can identify a Claude process and detect quiet JSONL activity, but
an unrelated process cannot safely recover the private ConPTY streams owned by
the VS Code Claude extension. A global keyboard fallback would be ambiguous
and could send a prompt to the wrong conversation. The implementation therefore
needs a semantic, per-session continuation path that Claude itself invokes.

## Goals and non-goals

Goals:

- Continue the exact Claude conversation identified by `session_id` and
  normalized `cwd` after the watchdog has observed a quiet period.
- Keep each lease bound to one process/session and consume it at most once.
- Preserve the existing monitor-only result when no supported write path is
  available.
- Make installation, status, and removal explicit, reversible, and auditable.
- Test the decision logic without touching the user's real Claude settings or
  active conversations.

Non-goals:

- No global keyboard input, window activation, or screen-coordinate injection.
- No automatic `claude --resume` relaunch from the watchdog timer.
- No direct connection to the private VS Code WebSocket. The extension's
  private client is not a stable external API and can disconnect an existing
  client.
- No copying of transcripts, credentials, IDE lock tokens, or API keys into
  watchdog state.
- No assumption that every Claude process exposes the native messaging bus.

## Supported paths

The controller chooses the strongest validated path for each session:

1. A service-owned PTY or validated classic Console continues to use the
   existing direct transport.
2. A Claude native messaging socket is used only when the process explicitly
   exposes a socket and authenticated token through a supported session-owned
   environment. The socket is never guessed from filenames or shared between
   sessions.
3. An opted-in Claude Stop Hook is used for sessions that have a discoverable
   `session_id` and `cwd` but no direct transport. The hook is invoked by Claude
   at the end of a turn and can enqueue a user message by returning a block
   decision with the continuation text.
4. Otherwise the session remains `monitor-only` and the audit log records why
   no write path was available.

The first implementation slice delivers the Stop Hook path and leaves native
messaging as an explicit adapter boundary. Adding a native adapter later must
not change the lease or safety rules.

## Data flow

```text
process scan + JSONL activity
        |
        v
watchdog quiet decision --(session_id, cwd, prompt, expiry)--> lease store
        |
        +--> direct transport, when already validated
        |
        +--> Claude Stop Hook command, when hook is installed
                    |
                    v
             JSON stdin: session_id, cwd, stop_hook_active, transcript_path
                    |
                    v
             validate lease + current session identity + expiry/activity
                    |
          +---------+----------+
          |                    |
       no-op                 block
   exit 0, no JSON       decision=block, reason=prompt
                              |
                              v
                 Claude enqueues the prompt in this session
```

The watchdog arms a lease only after the same quiet checks that currently
precede an automatic injection. A lease contains an opaque random id, the
normalized `session_id`, normalized `cwd`, prompt, source process id and
creation time, expiry time, and an activity generation observed at arm time.
The prompt is bounded by the existing configuration validation. The lease
store is local to the watchdog and is not a transcript store.

## Stop Hook protocol

The hook command reads one UTF-8 JSON document from standard input and writes
one JSON decision to standard output. It must finish within a short timeout and
must exit successfully for all malformed, stale, or unrelated input. A hook
failure must never block Claude by accident.

Expected input fields used by this feature:

- `hook_event_name`: must be `Stop` (or the supported equivalent documented by
  the installed Claude version).
- `session_id`: exact Claude conversation id.
- `cwd`: current working directory.
- `transcript_path`: used only as a local identity/activity hint; its contents
  are not copied or returned.
- `stop_hook_active`: when true, the hook returns a no-op to prevent recursive
  Stop Hook loops.
- `last_assistant_message`: ignored for content and never persisted.

For an eligible lease, the hook returns an object equivalent to:

```json
{
  "decision": "block",
  "reason": "继续",
  "systemMessage": "Continuation watchdog submitted a follow-up."
}
```

The exact reason is the configured prompt, not an instruction assembled from
untrusted transcript text. `systemMessage` is optional and contains no secret
or transcript data. For every other case the hook returns `{}` and exits zero.

The hook atomically consumes a matching lease before returning `block`. A
second concurrent invocation therefore returns `{}`. If the transcript file
mtime/size or watchdog activity generation changed since arming, the lease is
discarded and the hook returns `{}`. Expired leases are deleted lazily and by
periodic cleanup. `stop_hook_active=true` always wins over a lease.

## Session identity and fail-closed rules

Identity comparison uses:

- exact `session_id` after rejecting empty, overlong, or malformed values;
- canonicalized absolute `cwd` with Windows case/separator normalization;
- the lease's process creation time when the watchdog has it;
- optional transcript path containment under the expected Claude project
  directory.

The hook never selects a lease by prompt, PID alone, most-recent file, or
window title. If more than one lease could match, it returns `{}` and records
an ambiguity event without revealing paths or tokens. If the watchdog is not
running, the hook is a no-op.

## Configuration and installation ownership

The watchdog configuration gains an explicit Claude hook section:

```json
{
  "tools": {
    "claude": {
      "enabled": true,
      "normalPrompt": "继续",
      "stopHook": {
        "enabled": false,
        "leaseTtlMs": 15000,
        "commandTimeoutMs": 1500
      }
    }
  }
}
```

The default remains disabled until the user enables and installs it. The UI
must show that enabling the feature modifies the user Claude settings and that
existing Claude processes need to be restarted to load a newly installed hook.

Installation edits only the user's Claude settings file through a structured
JSON read/write. Before the first owned edit, the installer records a backup
with a checksum and an ownership manifest in watchdog state. It adds one
recognizable command entry under the `Stop` hook list and preserves unrelated
entries and formatting semantics supported by the parser. If the existing
file is malformed, installation stops without writing it.

Uninstallation removes only the exact command entry recorded in the ownership
manifest. It restores the backup only when the current checksum proves that no
unowned change occurred after installation. Otherwise it leaves the file in
place, reports a manual-review state, and removes only watchdog leases and
service-owned files. Re-running install is idempotent and never creates
duplicate owned entries.

The installer does not read or print API keys, IDE lock tokens, or native bus
authentication values. File permissions and atomic replacement follow the
existing config-store conventions.

## HTTP and WebUI surface

The local API adds:

- `GET /api/claude-hook` for enabled/installed/loaded status and the last
  install error, with paths redacted to relative labels;
- `POST /api/claude-hook/install` to perform the explicit user-approved
  install;
- `POST /api/claude-hook/uninstall` to remove only the owned entry;
- `POST /api/claude-hook/disable` to stop arming leases without editing the
  user's file.

All mutating routes remain loopback-only, require the existing origin check,
write an audit event, and clear all leases before changing enabled state. The
dashboard shows per-session capability as `direct`, `stop-hook`, or
`monitor-only`, plus the reason for a no-op. It never displays hook tokens or
full transcript paths.

## Error handling and recovery

- Hook parse errors, lease-store I/O errors, and stale identity are no-ops and
  are rate-limited in the audit log.
- A direct transport failure does not silently fall back to a global input
  mechanism; the controller may arm a Stop Hook lease on the next eligible
  quiet decision only if the feature is installed and enabled.
- Stop, pause, uninstall, process exit, configuration disable, and watchdog
  shutdown clear leases synchronously before returning success.
- A process restart creates a new process-creation identity, so old leases
  cannot target the replacement process even if the `session_id` is reused.
- Hook command timeouts terminate only the hook child process and do not stop
  the watchdog or Claude.

## Test strategy

Tests are test-first and split into independently mergeable slices:

1. Lease store and pure hook decision tests cover exact identity matching,
   expiry, activity invalidation, atomic one-shot consumption, recursion
   prevention, malformed input, and ambiguity.
2. Hook CLI tests cover UTF-8 JSON stdin/stdout, bounded prompt output,
   timeout behavior, and no-op exit semantics using a temporary lease file.
3. Controller tests cover arming/clearing leases for each session, direct
   transport precedence, monitor-only fallback, and process-exit cleanup.
4. Settings installer tests use temporary JSON files and verify ownership,
   idempotence, malformed-file refusal, checksum-protected uninstall, and
   preservation of unrelated hooks.
5. HTTP/WebUI tests cover explicit install/uninstall, status rendering,
   disabled defaults, and live capability updates.
6. A controlled integration test starts a fake Claude hook process with a
   temporary settings directory. It proves one continuation is delivered to
   the matching session and that a second session receives nothing. It never
   touches the real `%USERPROFILE%\\.claude` directory.

Acceptance on a real machine requires an explicit install, a Claude restart,
and a user-created quiet turn. Until those actions occur, the dashboard must
continue to report the current process as monitor-only or direct according to
its validated transport; it must not claim that the hook is active.

## Delivery and rollback

Each implementation slice is developed on its own short-lived feature branch,
tested, committed, pushed, and fast-forward merged into `main` immediately.
The first commit is this design. Subsequent commits are lease core, hook CLI,
controller/API, settings installer, and WebUI/integration verification. A
rollback removes only the latest owned code and does not alter user Claude
settings; an explicit uninstall handles the settings entry separately.
