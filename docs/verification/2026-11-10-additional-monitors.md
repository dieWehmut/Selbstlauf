# Gemini, Antigravity and Cursor monitoring

The change adds process discovery, conversation metadata and readable output for
Gemini CLI, Antigravity and Cursor. Backend revisions are `5593f35` and `7b6493c`;
the Web/mobile interface is `e7f3bd5`. WSL probe deadlines and owned-process
cleanup are in `a621cb2`. Current Cursor state and cross-profile ownership are
corrected in `522e974`.

## Behavior

- Same-user Windows processes and processes in the configured WSL distribution
  are discovered independently. Gemini package launchers, Cursor GUI/CLI/agent
  hosts and Antigravity GUI/language-server trees are recognized. Electron
  workers do not create extra agent rows; independently launched GUI roots and
  standalone CLIs remain separate.
- A live process is required. Historical recordings, including stale persisted
  busy flags, cannot create a running process or establish a current association.
  Explicit resume IDs can associate an older conversation intentionally.
- Gemini JSON/JSONL recordings support metadata, messages, patches, checkpoints
  and rewinds. Cursor supports exported JSONL, composer/bubble databases and
  current native daemon sidecars. Antigravity supports current conversation
  summary databases and available FTS5 user/assistant bodies.
- Workspace paths and explicit IDs establish associations. Cursor's two bundled
  project-name algorithms are reproduced; lossy collisions remain unassociated.
  Explicit Cursor user-data profiles have separate conversation identities.
  Shared native transcript sources are assigned across all live profiles before
  being claimed once. Profile-owned composer metadata keeps its ownership even
  when a global JSONL file supplies the output. Updated unknown native activity
  clears older exported busy/idle flags without discarding readable messages.
- IDE hosts can expose several workspace conversations. Titles, recorded activity,
  location and supported output appear in Web and mobile views. Missing busy/idle
  metadata is shown as unknown. Missing transcript bodies have a stated reason;
  summaries are never presented as full conversations.
- The three new tools use `monitor-only`. Runtime decisions do not schedule
  automatic continuation, and Web/mobile reject prompt submission. Their Settings
  switches control monitoring independently of the global continuation switch.
  Older saved configurations receive default enabled monitoring switches.
- WSL process, home-directory and Codex-launch probes have a five-second
  execution deadline. Windows tree termination is awaited before closing the
  probe's pipes, with bounded cleanup time. Unavailable WSL records a reason and
  cannot indefinitely block native Windows monitoring. Terminal attribution is
  probed only when a WSL interop timestamp can establish an association.

## Storage and resource limits

Source files and databases remain read-only. Windows cannot lock SQLite files
over WSL's 9P share, so the reader copies a stable main/WAL/SHM set into temporary
local storage, reads committed data and removes the copy on close or failure.
Snapshot sets are limited to 256 MiB and two attempts.

Transcript files are limited to 16 MiB, with bounded directory enumeration and a
64 MiB scan budget. Composer body reads have a cumulative 64 MiB budget, with
actual UTF-8 byte checks before queries. Output is limited to 120 entries and
128 Ki UTF-16 characters; truncation preserves surrogate pairs. Antigravity FTS5
uses at most 1,000 recent row IDs and 60 matching chunks because its conversation
ID column is not indexed.

## Verification

| Check | Observed result |
| --- | --- |
| Full CLI suite after final fixes | 409 passed, 12 platform-dependent skips, zero failures |
| Final monitor/runtime/reader suite | 48 passed, zero failures |
| Reader/SQLite fixtures on Linux | 37 passed |
| Same fixtures on native Windows Node 24.21 | 36 passed, one Windows symlink-permission skip |
| Full Web suite after final interface changes | 369 passed |
| Full mobile suite | 31 passed |
| Desktop suite | 171 passed |
| CLI, Web, mobile and Desktop builds | Passed |
| Browser monitoring coverage | Windows/WSL names, icons, unknown states and disabled input passed |
| Full browser suite | 105 passed, including the new monitoring journey |
| Production Pages artifact and persistent settings | 4 passed |
| Actual WSL SQLite access from Windows | Committed WAL data read through automatic local snapshot; cleanup passed |
| Installed product metadata scan | No actual conversations; source DB/WAL/SHM hashes unchanged |
| Actual Windows WSL timeout cleanup | 6.79 seconds total; owned WSL root, child and conhost all removed |
| Current Android APK | Debug and instrumentation APKs built; all 11 mobile assets match, APK signature verified |

Runtime tests include global continuation disabled while monitoring remains
enabled, individual monitoring disabled, pause/resume, process exit, same-PID
Windows/WSL isolation, corrupt-source isolation, stable first-observed timestamps,
copied composer IDs in different profiles and a shared native source claimed once.
Stalled WSL process and home probes also verify that all three native Windows
tools remain visible and that the completed-poll timestamp advances. Real-child
timeout tests cover cancellation and process cleanup.
Cross-profile tests switch process enumeration order, retain unknown process
start times over later polls, preserve profile-owned workspaces and reserve
shared recordings for an explicit CLI resume. Three-source Cursor fixtures
check original activity timestamps rather than timestamps of intermediate merges.
JSON/SQLite fixtures use the verified product schemas, not model-response mocks.

Actual startup snapshots were captured for Cursor GUI PID 80444 (window 599086),
Antigravity GUI PID 80556 (window 271414) with language-server child 82044, and
Gemini CLI 0.67.0 PID 2712424 at its trust/authentication prompt. Replaying those
snapshots through the final discovery code produced the same roots and working
directories. Independent Cursor CLI and detached-daemon grouping also have fixture
coverage. Only test-owned processes were stopped afterward; no AI request was sent.

Commands for repeatable checks:

```sh
npm test --workspace @ai-cli-bypass/cli
npm test --workspace @ai-cli-bypass/web
npm test --workspace @ai-cli-bypass/mobile
npm test --workspace @ai-cli-bypass/desktop
npm run build
npm run test:browser --workspace @ai-cli-bypass/web -- monitor-tools.spec.ts
```

The full browser suite ran with the host's existing runtime libraries supplied
through `LD_LIBRARY_PATH=/home/han/.local/share/codex-dev-tools/media/lib`.
The GitHub Pages workflow installs Chromium and its system dependencies itself.

Local evidence is retained in `tmp/additional-monitors-*.log`,
`tmp/monitor-adapters-review-20261110.md`, `tmp/monitor-ui-readonly-review/`, and
`/tmp/selbstlauf-monitor-evidence-9s0718ws/`. The extended
`scripts/verify/live-monitoring.mjs` also checks these tools when they are running.
The real timeout cleanup evidence is in
`/tmp/selbstlauf-package-retry-dnbsqwvq/windows-wsl-owned-tree-check-attempt2.json`;
its runner SHA-256 matches the final built module.

## Windows package

An independent staging checkout reused verified Windows native dependencies.
All 189 build inputs matched an immutable manifest. The NSIS x64 build used
`--publish never` and `npmRebuild=false`; 165 packaged resources matched their
inputs, and packaged Electron successfully loaded ConPTY and SQLite.

Final installer: `Selbstlauf-Setup-0.9.5-x64.exe`, 171,863,658 bytes; SHA-256
`5328647c48c611bd96daffda070d530d46bf1e048584772afceeff45f630cbc6`.
The immutable final input manifest is
`e4e4c117a9a452d53e72b9e4c99ad21ea9e4f84909ae8962791595018963435c`,
with product code from `522e974`.

The final package was installed over the existing application. All 400 installed
files match the packaged bytes. Configuration SHA-256 stayed
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`;
global automatic continuation remained disabled, the selected distribution stayed
`Ubuntu-22.04`, and the managed-PTY count stayed zero. The installed service PID
103080 completed polling again, including while WSL shell startup timed out.
The preserved installation/state backup is
`C:\Users\han\AppData\Local\Temp\selbstlauf-monitor-reinstall-final-20261110-c7132e4bd6`.

The installed API then observed real test-owned applications: Cursor PID 91044
(window 274308), Antigravity PID 75168 (window 1060710, language-server child
57936), and Gemini CLI 0.67.0 PID 107776 in native Windows ConPTY. All three
reported `alive: true`, `monitor-only` and the correct scratch workspace. Cursor's
own startup composer metadata was associated with its isolated profile; the
other two remained explicitly unassociated without a recorded conversation.
Gemini reached its trust/authentication prompt without a fatal startup error.
Completed-poll timestamps advanced throughout these checks. Typed inputs, login
selections and AI requests were all zero.

The final package and installed API evidence is retained in
`/tmp/selbstlauf-package-final-8t1ebqvu/`, with copies beside the installation
backup. Historical startup/replay evidence above supplements the final installed
process checks; it is not substituted for them.

## Practical limits

No completed model conversation from these tools is present locally. Process
startup, Cursor startup metadata and source access were tested against real installations; conversation
output and busy state were checked with schema-faithful fixtures. A billable live
model turn is not claimed.

The Android APK is built and verified, but the user's physical phone is not
connected or authorized for debugging. No installation or test on that phone is
claimed. This host also currently times out when starting a WSL shell; the bounded
failure path and native Windows monitoring are verified without changing the
selected distribution or restarting the user's WSL processes.

Old Antigravity encrypted/protobuf stores and unknown schemas remain unavailable.
Cursor daemon output outside the supported default project roots may be unavailable
while known sidecar metadata remains visible. Configured Cursor GUI profiles are
supported; other product-specific environment overrides are not inferred. Storage
budgets can omit sessions beyond their bounded enumeration.
