# Final continuation verification — 2026-09-19

This closes the work resumed from `01a0b3ad-6076-7fa1-aae8-e728e769d143`.
The branch audit and missing discovery fix are documented in
[the integration record](2026-09-19-branch-integration.md).

## Source and browser gates

All commands ran in the target checkout, `D:\project\ai-cli-bypass`. The final
workspace tests used the repository's default timeouts. No timeout settings were
changed to obtain the final results.

| Gate | Result |
| --- | --- |
| `npm --workspace apps/cli test` | 243 passed; zero failed, cancelled or skipped |
| `npm --workspace apps/desktop test` | 24 passed; zero failed, cancelled or skipped |
| `npm --workspace apps/web test` | 35 passed across three files |
| `npm run build` | CLI, desktop and production WebUI built successfully |
| `npm --workspace apps/web run test:browser` | 10 passed on the final UI implementation |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tests/Test-WindowsScripts.ps1` | All 35 passed |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tests/Test-Documentation.ps1` | Passed |

The browser checks cover the process table, mobile drawer, Claude Hook controls,
Codex endpoint settings, environment panel, light/dark appearance previews and
narrow-screen layouts. The appearance screenshots were compared with the supplied
references; the contrast label remains on one line at 360 pixels.

The new regressions were observed failing before their fixes: literal process
boundaries, malformed/legacy theme import, packaged npm resolution, PATH
fallback/unknown versions, and slow environment scans. Earlier parallel runs
encountered a WMI timeout and a WebUI test timeout under host load; both affected
suites passed in the final serialized/default-timeout runs above.

## Real monitoring on this host

`node scripts/verify/live-monitoring.mjs --dry-run` passed. It found all nine
currently running Codex roots, reported them alive, located each in the Codex
app, Tabby or Visual Studio Code, and recorded monitoring activity/decisions.
No continuation was sent to a process.

There were no live DeepSeek Harness hosts or sessions during this check. The
Harness unit/integration cases passed in the CLI suite; this run does not claim
a new live Harness continuation proof.

## Installation

`npm --workspace apps/desktop run package:win -- --arm64 --publish never`
completed successfully. The repository target configuration generated ARM64,
x64 and combined installers. The ARM64 installer was installed explicitly as
the current user into `%LOCALAPPDATA%\Programs\Selbstlauf`, retaining the
existing watchdog configuration byte-for-byte.

- Application code commit: `5297a3e3d5b236336f7f9f177dab28486e5d5351`.
- Installer: `tmp/desktop-final-20260919/Selbstlauf-Setup-0.1.0-arm64.exe`.
- Installer SHA-256:
  `5B7E70F5633D0656D0941091C0DE655CDD91BC3AB3FCDE7399C2D524A3F85D11`.
- The installed executable's PE machine type is ARM64 (`0xAA64`).
- All 51 checked files match the build: compiled service modules, WebUI assets,
  both PowerShell providers, the executable, `app.asar` and preload module.

The installed app, PID `145956`, owns the service on `http://127.0.0.1:48920`.
Its first discovery poll completed, it reported all nine sessions with locations,
and the existing `dryRun: true` setting remained enabled. An isolated browser
loaded the installed WebUI, reached live synchronization, displayed the three
appearance previews and produced no page errors. Its screenshot is retained
locally as `tmp/installed-final-appearance.png`.

The environment API was read from the installed app, rather than a checkout
process. It returned actual npm versions (not the `unknown` fallback):

| Tool | Installed | Published at verification | State |
| --- | --- | --- | --- |
| Claude Code | 2.1.274 | 2.1.277 | outdated |
| Codex | 0.155.0 | 0.155.1 | outdated |
| Gemini CLI | 0.50.0 | 0.60.0 | outdated |
| Grok Build | absent | 1.0.34 | missing |
| OpenCode | 1.17.15 | 1.18.31 | outdated |
| OpenClaw | 2026.3.28 | 2026.9.5 | outdated |

No agent CLI was installed or upgraded during this verification. Install command
execution and serialization are covered by the environment tests, which capture
the process boundary without modifying global packages.

## Scope notes

The UI currently supports Simplified Chinese; the other language choices are
explicitly unavailable. Nonstandard npm shim layouts were not exercised, and
unreadable native CLI version formats intentionally remain `unknown`.
