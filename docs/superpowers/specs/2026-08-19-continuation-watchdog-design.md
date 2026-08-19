# Claude/Codex Continuation Watchdog Design

## Goal

Add a Windows continuation watchdog that observes each running Claude Code or
Codex process independently and submits a configurable follow-up only after a
configured period with no response. Codex sessions use `/goal resume` when the
associated thread has a resumable goal; ordinary Codex sessions and Claude
sessions use their configured normal prompt (default: `继续`). A local web UI
controls monitoring, prompts, timing, installation, and removal.

The existing bypass installers remain supported. This feature is an additional
process-monitoring service and does not change approval or sandbox policy.

## Scope and platform

The first complete implementation targets Windows 10/11, Windows PowerShell
5.1, and Node.js 20 or newer. The service only considers processes owned by the
current Windows user by default. Linux scripts remain available but are not
part of the first watchdog release.

The service discovers matching processes whether or not they were launched by
the service. Each root CLI process and its native child process are represented
as one logical session. A stable session key contains the tool, root PID, and
the discovered conversation/thread identifier when one exists. Process exit
removes the session after a short retention period so the UI can show the last
result.

## Required behavior

1. Discover Claude Code and Codex processes through Windows process metadata,
   including command line, parent PID, creation time, executable path, and
   current-user ownership.
2. Track every matching root process separately. Never use a global keyboard
   API or send input to a process that was not identified by PID and transport.
3. Record activity from the strongest available source:
   - output from a PTY created and owned by the service;
   - a classic Console screen snapshot associated with the target PID;
   - Codex rollout/thread state and App Server events.
4. A watchdog tick may inject only when the session is alive, enabled, not
   paused, has no pending injection, has exceeded `idleTimeoutMs`, and has not
   produced activity since the last check. A successful injection starts a
   cooldown; new activity resets the cooldown and retry counter.
5. Claude's normal action is a configurable text followed by Enter, defaulting
   to `继续`.
6. Codex's action is `/goal resume` when a matching row in the active Codex
   goal store has status `active` or `paused`; otherwise it is the configurable
   normal text, defaulting to `继续`.
7. Codex goals with status `complete`, `blocked`, `usage_limited`, or
   `budget_limited` are never auto-resumed by default. The UI may explicitly
   override a single session and records that override in the audit log.
8. When response activity is detected, no action is sent. Repeated idle checks
   cannot send duplicate actions until cooldown and retry rules allow it.
9. Every decision, skipped action, transport failure, and user override is
   persisted in a local redacted audit log. Prompt text may be stored, but
   credentials, full conversation transcripts, and Codex config files are not
   copied into service state.
10. The service exposes local HTTP and Server-Sent Events endpoints for the UI,
    plus explicit start/stop/pause/resume/inject-now operations.
11. Installation and uninstallation are reversible. Uninstall stops the
    service, removes only watchdog-owned files/tasks, and leaves CLI packages,
    user conversations, and existing bypass state intact.

## Transport and safety model

### Classic Console

For a process attached to a classic Windows Console, a short-lived bridge
detaches from its own console, calls `AttachConsole(targetPid)`, and writes
Unicode key events to `CONIN$` with `WriteConsoleInputW`. The same bridge reads
the visible screen buffer to produce an activity fingerprint. The bridge runs
out-of-process so attaching does not change the watchdog's own console.

If multiple matching roots share one console, the service marks the console
collision and does not auto-inject into either session until the user selects a
single target. This prevents one input from reaching the wrong conversation.

### Service-owned PTY

When the service launches a CLI, it owns the PTY input/output streams and can
capture output and write exact text to that session. The PTY adapter is the
reference integration-test transport and supports multiple simultaneous
sessions.

### ConPTY and Codex App Server

A Windows pseudoconsole's host owns the input/output pipes. An unrelated
process cannot safely recover those private pipes. Such sessions are therefore
reported as `monitor-only` unless a supported protocol is available.

For Codex, the service first associates the OS process with a thread ID from
the command line or the local thread index. It then uses a local Codex App
Server connection for thread status and, when configured, `turn/start` with the
same follow-up text. This is semantically the same conversation action but is
not a simulated keystroke. If App Server association is ambiguous or fails,
the service does not fall back to global input; it reports `cannot-inject`.

Claude ConPTY sessions that were not started by the service remain
`monitor-only` unless a classic Console transport is available. The UI offers
an explicit one-shot `relaunch --resume` action only when a discoverable Claude
session ID exists; it is disabled by default and is never performed by the
watchdog timer.

## Process and conversation association

`ProcessDiscovery` polls WMI/CIM at a configurable interval and normalizes
Windows paths and command lines. It identifies:

- Claude roots containing the Claude Code CLI entry point or the configured
  executable name;
- Codex roots containing `@openai/codex`, `codex.js`, or the configured
  executable name;
- native child processes spawned by either root, which are attached to the
  root record rather than shown as duplicate sessions.

Codex thread IDs are extracted from `resume <uuid>` arguments first. For an
initial `codex` invocation, the service matches the process working directory,
creation time, and active thread index; if more than one thread remains
possible it leaves the thread unknown and refuses automatic injection. Goal
state is read-only from `goals_1.sqlite` through a small helper with a
parameterized query. The helper returns only status and timestamps.

Claude session IDs are read from the session index/JSONL metadata when a
unique project-and-process match exists. Ambiguous matches remain monitor-only.

## Configuration

Configuration is stored in a watchdog-owned JSON file under
`%LOCALAPPDATA%\\ai-cli-bypass\\continuation`. The schema includes:

```json
{
  "enabled": true,
  "pollIntervalMs": 2000,
  "defaultIdleTimeoutMs": 120000,
  "defaultCooldownMs": 300000,
  "maxAttemptsPerQuietPeriod": 1,
  "tools": {
    "claude": { "enabled": true, "normalPrompt": "继续" },
    "codex": {
      "enabled": true,
      "normalPrompt": "继续",
      "goalPrompt": "/goal resume",
      "goalStatuses": ["active", "paused"]
    }
  },
  "processFilters": { "sameUserOnly": true, "include": [], "exclude": [] }
}
```

All values are validated before an atomic write. UI updates apply to new
ticks; a pending action retains the snapshot of the policy that authorized it.

## Local web UI

The first screen is an operational dashboard, not a marketing page. It contains:

- a compact header with watchdog state, poll age, and start/stop control;
- a process table with tool, PID/thread, goal state, activity age,
  transport capability, next action, and pause/inject controls;
- an event timeline for skips, injections, output recovery, and failures;
- a settings view for prompts, timeout/cooldown, filters, and dry-run mode;
- an install/uninstall panel for the watchdog service and optional startup task.

The visual language takes the desktop sidebar/mobile drawer and theme handling
from `prompt/dieWehmut.github.io`, and the dense console timeline, status chips,
and settings panel patterns from `prompt/Glimmer`. It uses original component
code, a restrained dark/light palette, keyboard-accessible controls, and
responsive tables that collapse into process cards on narrow screens.

## API contract

The backend serves the built UI and exposes:

- `GET /api/health`
- `GET /api/config`, `PUT /api/config`
- `GET /api/sessions`
- `GET /api/events` (SSE)
- `POST /api/watchdog/start`, `/api/watchdog/stop`
- `POST /api/sessions/:id/pause`, `/resume`, `/inject`
- `POST /api/install`, `/api/uninstall`

All mutating routes validate JSON, require a loopback origin, and emit an audit
event. The server binds to `127.0.0.1` by default and chooses the next free
port in a documented range when the requested port is occupied.

## Error handling

- Process disappearance is a normal state transition, not a service failure.
- WMI, SQLite, App Server, or ConsoleBridge errors are recorded per session;
  one broken process cannot stop the polling loop.
- Ambiguous association or shared-console collisions fail closed.
- A failed injection does not advance the retry counter and never retries more
  often than the configured cooldown.
- Malformed config is rejected and the last valid config remains active.

## Testing and acceptance

Unit tests cover config validation, process grouping, PID/thread association,
goal status policy, state-machine timing, duplicate suppression, and audit
redaction. Integration tests use fake Claude/Codex processes with controllable
stdout and stdin, a fake goal database, and a fake ConsoleBridge.

Windows acceptance covers classic Console injection, separate PIDs, response
activity cancellation, goal/non-goal routing, unavailable ConPTY transport,
service install/uninstall, and a clean restart. Browser acceptance covers
desktop and mobile layouts, settings persistence, live SSE updates, pause and
manual injection, and visible error/capability states.

## Delivery slices

The implementation is split into independently reviewable branches and commits:

1. `continuation-domain`: schemas, config, policy, and watchdog state machine.
2. `continuation-discovery`: Windows process discovery and grouping.
3. `continuation-console`: ConsoleBridge and classic-console transport.
4. `continuation-codex`: Codex goal/rollout association and App Server adapter.
5. `continuation-claude`: Claude session association and transport adapter.
6. `continuation-service`: HTTP/SSE API, persistence, and lifecycle commands.
7. `continuation-webui`: responsive dashboard and settings UI.
8. `continuation-layout`: compatibility entry points, directory organization,
   documentation, and end-to-end verification.

Each slice is test-first, committed separately, and reviewed for spec
compliance before code quality. The final integration keeps the original
installer URLs working through root-level compatibility shims.

## Security and user control

This tool can submit commands to coding agents that may have broad filesystem
and network permissions. It defaults to same-user processes, dry-run disabled
unless selected, fail-closed association, loopback-only HTTP, and an emergency
global stop. The UI always shows the exact text and target PID/thread before a
manual injection and records the result.
