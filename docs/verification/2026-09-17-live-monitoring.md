# Live monitoring verification — 2026-09-17

This record captures a run of `scripts/verify/live-monitoring.mjs` on the Windows
on ARM host that motivated the DeepSeek Harness support and the discovery fixes.

## What the script does

1. Enumerates the same-user process table with the shipped provider and groups it
   with the shipped discovery pipeline, independently of the service.
2. Reads `$DSH_HOME` and applies the shipped liveness rule
   (`tools.dsh.sessionWindowMs`, harness host start) to decide which harness
   sessions are live.
3. Starts the real watchdog service on an ephemeral loopback port with an
   isolated state directory in dry-run mode.
4. Requires the service to report a row for every codex root process and every
   live harness session, with the correct tool, workspace, live-step flag and
   `monitor-only` transport, and requires a recorded activity/decision event with
   no injection at all.

A service that answers `/api/health` but lists nothing fails the check.

## Run

```powershell
node scripts\verify\live-monitoring.mjs
```

```text
machine agents: 8 codex root process(es), 1 DeepSeek Harness host(s), 3 live harness session(s)
  harness session-3acd60b1-9056-4191-9070-8cd3563436a7 cwd=D:\project\ai-cli-bypass runningStep=true ageSec=17
  harness session-7a950179-084b-4992-9320-f18dfeed11a2 cwd=D:\project\Orchester runningStep=true ageSec=182
  harness session-abfb742e-7776-45ab-91cb-f22ae3bdff4f cwd=D:\project\sandkasten runningStep=true ageSec=199
watchdog listening at http://127.0.0.1:55226 (state C:\Users\30119\AppData\Local\Temp\selbstlauf-live-verify-Zl7b48\ai-cli-bypass\continuation)

ok    the watchdog reports itself running
ok    the verification run stays in dry-run mode
ok    codex PID 5132 is discovered as a watched session
ok    codex PID 5132 is reported alive
ok    codex PID 62072 is discovered as a watched session
ok    codex PID 62072 is reported alive
ok    codex PID 77248 is discovered as a watched session
ok    codex PID 77248 is reported alive
ok    codex PID 79556 is discovered as a watched session
ok    codex PID 79556 is reported alive
ok    codex PID 76104 is discovered as a watched session
ok    codex PID 76104 is reported alive
ok    codex PID 73764 is discovered as a watched session
ok    codex PID 73764 is reported alive
ok    codex PID 101808 is discovered as a watched session
ok    codex PID 101808 is reported alive
ok    codex PID 103704 is discovered as a watched session
ok    codex PID 103704 is reported alive
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 is discovered as its own row
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 is reported as the dsh tool
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 is reported alive
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 reports workspace D:\project\ai-cli-bypass
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 reports runningStep=true
ok    harness session session-3acd60b1-9056-4191-9070-8cd3563436a7 stays monitor-only
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 is discovered as its own row
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 is reported as the dsh tool
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 is reported alive
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 reports workspace D:\project\Orchester
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 reports runningStep=true
ok    harness session session-7a950179-084b-4992-9320-f18dfeed11a2 stays monitor-only
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f is discovered as its own row
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f is reported as the dsh tool
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f is reported alive
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f reports workspace D:\project\sandkasten
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f reports runningStep=true
ok    harness session session-abfb742e-7776-45ab-91cb-f22ae3bdff4f stays monitor-only
ok    harness events only exist while a harness session is live
ok    the dry run wrote nothing into any process
ok    the watchdog recorded at least one activity or decision event

live monitoring verification passed
```

## Why the codex list is longer than the number of interactive CLIs

The process table of this host contained eight `codex` root processes: four
interactive `codex.js` CLIs (four different working directories) and four
`codex.exe app-server` hosts started by editor extensions. All eight are real
codex processes of the current user, so all eight are discovered; association
decides separately which of them can be continued (`codex-app-server`) and which
stay `monitor-only`.

## Defects this run uncovered

- The packaged app shipped no `windows-processes.ps1`, so the *installed* app
  discovered nothing while still serving a healthy WebUI.
- The packaged app hosts the service inside `Selbstlauf.exe`, whose image name is
  not a supported CLI, so the watchdog could not derive the current user's SID
  and same-user grouping failed closed on every poll.
- `GetOwnerSid()` cost roughly half a second per process, which made a single
  discovery pass take about a minute on a busy desktop even when it worked.