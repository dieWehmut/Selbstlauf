# Existing WSL agents in the installed desktop

The installed desktop was healthy and completed polling, but its API and window
showed no live WSL agents while the user's Codex PID 2614153 was running inside
Ubuntu-22.04. UI filters, tool switches and Linux process signatures did not cause
the omission. Running the same process script inside Linux took 1.3 seconds and
found the process; Windows command probes timed out. The command provider's error
path returned no records and thereby hid the running distribution's agents.

Windows could still read the running distribution's `/proc` through
`\\wsl.localhost\Ubuntu-22.04`. The new reader found the original Codex process
without starting a replacement task. An independent native Windows scan took
429 milliseconds, read 192 processes, resolved `/home/han` from the distribution's
default UID and passwd, and matched PID 2614153 and its WSL interop socket.

## Changed behavior

- A failed WSL command probe falls back to the live proc filesystem. Records from
  that filesystem remain discoverable when the native Windows process provider
  also fails. Both discovery operations run concurrently; the polling loop still
  waits for their completion.
- Successful fallback suppresses new command probes for 60 seconds. Home and CLI
  probes are also deferred. A later successful command probe retries preparation
  of Codex sessions first discovered through the fallback, without restarting the
  desktop.
- A fresh filesystem-discovered Codex session uses monitor-only transport. An
  existing state reader can keep its readable association; input through fallback
  requires an already handshaken, still connected App Server. Discovery never
  starts a new input process through a known unavailable command bridge.
- Only a successful cwd readlink supplies a working directory. UNC exposes this
  link as a directory on the tested host, so its cwd remains unknown. PWD and
  historic transcripts do not prove the current workspace or process liveness.
- Raw proc argv boundaries are preserved for executable detection, cwd/profile
  options and explicit conversation IDs. A prompt mentioning these options
  cannot supply process identity, a workspace or a historical resume ID.
- Real Windows checks also reproduced a cleanup failure: a two-second
  `taskkill /T` timed out and left the probe's conhost running. Cleanup now uses
  a native Toolhelp snapshot, the probe's recorded spawn interval and owner PID,
  and held process handles. Only the verified owned tree is terminated, children
  before the root, and every handle is checked afterward. A root that exited
  before verification reports unverified cleanup. Successful cleanup of the same
  child object remains idempotent. The helper has a four-second deadline, with a
  five-second outer cleanup allowance.

## Bounds and verification

The filesystem scanner has a five-second deadline, eight concurrent process
readers, at most 4,096 PIDs and a cumulative 64 MiB byte budget. Individual reads
are bounded, including 256 KiB cmdline and 64 KiB environ. Only HOME and the WSL
interop socket are selected from the environment; complete environment data is
never returned. Proc starttime is checked before and after each record, so exit
or PID reuse during a read cannot assemble a mixed process. Partial scans state
their limit or timeout. All distribution data remains read-only.

Before implementation, the original installed-app reproduction failed, three
command/runtime regressions failed, nine scanner regressions failed, two secondary
probe/input regressions failed, and three argv regressions failed. Scanner tests
were run on Linux and native Windows.

The final CLI suite passed 432 tests with 14 platform-dependent skips and no
failures (446 total). All workspace builds passed. Native Windows covered the
scanner and discovery/association fixtures, the controller failure/recovery
cases, Codex JSON-RPC and owned-tree cleanup: 85 passed, two platform-dependent
skips and no failures (87 targeted tests) against the final `41b5ed3` compiled
inputs. The native four-second cleanup test took 1.42 seconds including two
PowerShell/C# invocations, cleared its owned
parent/child tree and left a foreign process running.

A real Windows WSL probe also passed after the cleanup change: command timeout
followed by filesystem fallback took 4,015 milliseconds, returned 182 fresh
process records and matched the original user Codex PID 2614153. The probe root
and its WSL/conhost descendants were absent afterward, without manual cleanup.

## Windows package

Product code is `41b5ed3`. The final independent input manifest has 193 files,
SHA-256 `6bdc5c59ea3321a7b00422c2393785a990e9917ddc3ef8751a00e5c80e113468`.
All inputs and 169 direct packaged resources matched their expected bytes.
Packaged Electron 44.4.1 / Node 24.21 / NAPI 10 loaded ConPTY and SQLite.

The NSIS x64 installer was built with publishing disabled:
`Selbstlauf-Setup-0.9.5-x64.exe`, 171,881,280 bytes, SHA-256
`e8727968bc5db44253fc503bbff2715eaa5528da8c31ed5a9ea540b427d3aeba`.
The preserved pre-update installation/state backup is
`C:\Users\han\AppData\Local\Temp\selbstlauf-live-agent-reinstall-20261110-f1f4b09344`.

## Installed result and limits

All 404 installed files, including 333 resources, matched the packaged bytes.
Configuration SHA-256 remained
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`.
Global continuation stayed disabled, dry run stayed false, the selected
distribution stayed Ubuntu-22.04 and the managed-PTY count stayed zero.

The installed desktop PID 148680 serves `http://127.0.0.1:48920`. The original
reproduction now passes: Codex PID 2614153 is alive in the API. A native
PrintWindow capture shows `Codex · PID 2614153` in the sidebar, three WSL
processes and one Windows DSH process, matching the API's four live processes.
Completed-poll timestamps advanced three times. The application's first owned
WSL probe and conhost descendants were verified absent afterward. The user's
Codex, Tabby and DSH processes remained running; no replacement agent was used.

The first post-installer PID 147720 exited before completed-poll verification.
The same installed binary was restarted from a local Windows directory with
output redirected and then remained running across the API/window checks.
The first exit's cause is unconfirmed; its failed monitor and diagnostics are
preserved. This report does not attribute that exit to the new cleanup code.

WSL command startup remains unavailable on this host. The restored Codex rows
support live process monitoring, with unknown cwd and no associated conversation
or input channel. Actual Windows scan completion was observed in tens of
seconds despite a two-second configured scheduling interval. The physical
phone's installation and testing are outside this completed desktop check.

Local evidence includes `tmp/agent-discovery-repro-20261110/`,
`tmp/wsl-proc-filesystem-evidence-20261110.json`,
`tmp/wsl-proc-review-20261110.json`, and the installed-window PrintWindow captures.
The final package/install report is retained in
`/tmp/selbstlauf-live-agent-final-package-nxgjxx1d/final-local-update-report.json`,
with a copy beside the Windows package. The screenshot and metadata are
`tmp/desktop-agent-discovery-installed.png` and its `.json` companion.
Newly started test agents and synthetic process replays do not substitute for
the original user PID in the installed-app check.
