# Android remote control and desktop integration

The recovered task combines the earlier Codex-style desktop sidebar work with
an Android application matching Orchester's mobile layout, remote control, and
local testing. The user also requires stepwise commits, validation, pushes to
main, and local desktop reinstallation.

## Implemented behavior

- Desktop navigation remains fixed while the project/settings column collapses.
  Windows and WSL/Ubuntu processes are grouped by project root; the project and
  session tree occupies one sidebar and uses the Codex mark instead of the old
  folder/large icon. Long paths and narrow settings controls stay inside their
  columns.
- The Android app uses Vue/Capacitor, Orchester's four-tab navigation, rounded
  cards, six palettes, and the desktop's LXGW WenKai font. The font is byte
  identical to `C:\Users\han\project\dieWehmut.github.io\src\assets\fonts\LXGWWenKai-Regular.ttf`:
  SHA-256 `151210456c0e832ea63f17b463b838b783da0d37678bd16b27836c9a9b05d0e3`.
- Android credentials use a registered AES-GCM/Keystore plugin, not plaintext
  preferences. Native HTTP reaches the remote gateway without browser CORS.
- Devices, session records/actions, watchdog actions, and managed terminals are
  available from mobile. xterm handles ANSI/VT, cursor-based output, input and
  remote terminal resize. Failed or stale requests cannot replace another
  computer's state. Authentication expiry stops retries and permits re-pairing.
  Hardware Back returns from detail screens to their parent tab. Terminal replay
  retains a bounded 2 MiB tail while the active terminal receives complete output.
- Desktop settings manage the gateway in the same service that owns its PTYs:
  explicit enable/bind/port/name, code renewal, device revocation and disable.
  Ordinary shutdown preserves settings; disabling remote access preserves tasks.
  Pairing management remains behind the local Host/Origin boundary.

## Automated validation

Workspace suites and subsequent component validation are recorded under
`tmp/mobile-verification-20261110/`:

| Suite | Result |
| --- | --- |
| CLI | 336 passed, 11 environment-specific skips, 0 failed |
| Desktop | 171 passed |
| Mobile | 25 passed |
| Web | 351 passed |
| Remote integration and lifecycle | 36 passed |
| Shutdown and remote integration targeted regressions | 40 passed |
| Web browser, fixture and live API projects | 104 passed |
| Production Pages path and persistent settings | 4 passed |
| Android instrumentation against Linux host PTY | 4 passed |
| Android instrumentation against Windows ConPTY | 4 passed |
| Android lint | 0 errors, 26 warnings |

The remote integration test uses actual local HTTP routes and a real host PTY.
The discovered-session controller is a disposable fixture; it does not prove
focus or injection into an external live Codex conversation. Existing runtime
verification for those adapters remains separate.

Mobile browser evidence under `tmp/mobile-ui-check/` verifies responsive widths
280–1280, all six themes and reload persistence, ANSI redraw, output replay/reset
ordering, errors, deletion, resize and browser History Back. Android runtime
verification uses the installed APK and native bridge through
`scripts/verify/mobile-android-live.mjs`; the Shell is a real host process and
its output must contain a separate marker line, not only the typed command.
An independent audit of the final APK's extracted assets under `apk-ui-scope/`
also passed all nine pages at six widths (54 checks), 36 theme selections and
six persisted reloads, including About and detail-page return navigation.

To reproduce the native journey after installing Java 21 and Android SDK 36:

```sh
npm run build
npm run build:android --workspace @ai-cli-bypass/mobile
cd apps/mobile/android
./gradlew :app:assembleDebugAndroidTest :app:lintDebug --no-daemon --max-workers=2
cd ../../..
ANDROID_SERIAL=emulator-5556 node scripts/verify/mobile-android-live.mjs
```

For WSL with a Windows emulator, set `SELBSTLAUF_ADB` to the Windows SDK's
`adb.exe`. The journey uses disposable service state and cleans its gateway,
PTYs and reverse mapping. Emulator `adb reverse` proves the local link;
physical-phone Wi-Fi/VPN acceptance is not claimed.

## Final native and desktop evidence

The final debug APK is `tmp/mobile-release-20261110/Selbstlauf-0.1.0-debug.apk`
(18,615,390 bytes), SHA-256
`dbc18f528eab1f8243342e9cc4a1cfbc96530549ec52e0ba32b2beaffa4f9268`.
The instrumentation APK SHA-256 is
`48b8a6daabe9040066b153d4e1ec61c7d14cfdaa7a0f92370664694cf12090ec`.
`native-final/result.json`, `instrumentation.log`, and `hashes.json` bind the
four-test result to these artifacts and the mobile/native source.
The final native lint evidence is `native-back/lint-result.json` and
`native-back-lint.log`: zero errors and 26 warnings, with the same MainActivity
source hash as the final APK. Older lint reports in this directory predate the
native navigation and API-level fixes.

Packaged UI acceptance discovered a shutdown defect: a partial HTTP request
could leave the service stop promise pending after the listen port closed.
Revision `099f269` closes active HTTP connections during shutdown and destroys
rejected upgraded sockets after sending 403. Two real-service regressions cover
partial bodies, browser preconnects, SSE, accepted/rejected WebSockets and PID
removal. The final CLI suite passed 336 tests with 11 environment skips; the
targeted shutdown/remote set passed 40. Final desktop packaging uses this fix.

The final Windows package, GUI and native Android test all use production
revision `099f269f9a8624f3921a29f9dd616442c85eae70`. Evidence is copied under
`windows-final/`, preserving the package's manifests and evidence paths:

- `build-manifest.json`: 176 stable copied inputs, with source/build hashes.
- `package-verification.json`: 154 resources match the snapshot; both native
  Node and packaged Electron 44.4.1 ConPTY probes pass.
- `evidence/packaged-ui/`: process/project sidebar and real desktop remote
  settings enable, renew-code and disable pass. Widths 1440, 1100, 900 and 520
  have no horizontal overflow or renderer errors. `cleanup.json` confirms
  normal quit, closed service, removed PID record and no forced cleanup.
- `evidence/native-remote-windows/`: the final APK passes all four native tests
  against actual Windows Electron/node-pty ConPTY. The screenshot contains the
  independent `SELBSTLAUF_NATIVE_LINK` output line and subsequent PowerShell
  prompt. `runtime.json` binds this result to the final package revision.
- `final-artifact-manifest.json`: installer/APK hashes, runtime results and
  hashes of the complete package/UI/native evidence.

The Windows native runner retains a node-pty `AttachConsole failed` diagnostic
from stop-time console enumeration. Its fallback completed, all four tests
passed, and `evidence/qa-process-cleanup.json` confirms no QA shell or service
remained. Multi-generation child-process trees were not exercised by this test.

The installer is
`C:\Users\han\AppData\Local\Temp\selbstlauf-remote-package-release-20261110-46wii2e6\package\Selbstlauf-Setup-0.9.5-x64.exe`
(171,761,869 bytes), SHA-256
`9ac534062145863d0ac1259f30a48a4d2541f893f5c706fdd4d98d7e74567d6c`.
The packaged and installed `app.asar` SHA-256 is
`fdb40a1dc5bb31acc4e16ed76ab18ac1493fc073a749cb9936e9f13500d053f3`.

Fresh local reinstallation succeeded using `reinstall-local-windows.ps1` with
that package. `windows-final/installed/` records:

- Version 0.9.5 installed at `C:\Users\han\AppData\Local\Programs\Selbstlauf`.
- All 389 packaged files match their installed counterparts; no missing or
  differing files (`installed-files-verification.json`).
- Service health is `ok: true` at `http://127.0.0.1:48920` after restarting the
  installed executable.
- Configuration SHA-256 before and after is identical:
  `b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`.
- `installed-window-current.png` and its metadata capture the actual installed
  executable using PrintWindow, with the fixed navigation visible.
- The three detected Codex processes are correctly classified as WSL/Ubuntu.
  For every session, the service's working directory matches both live
  `/proc/<pid>/cwd` and the associated Codex thread's `cwd`: two use
  `/home/han/project`, one uses `/mnt/c/users/han/project/miceye`. The visible
  `project` and `miceye` names therefore reflect actual process/thread metadata
  (`apk-ui-scope/installed-project-audit.json`).

The previous installation and service state are backed up at
`C:\Users\han\AppData\Local\Temp\selbstlauf-remote-reinstall-20261110-ksi4w145`.
Chromium local preferences are also backed up separately; the location is in
`profile-backup.json`. Disposable gateway, GUI harness and shell processes have
exited. Temporary app pairing data was cleared only on the dedicated
`selbstlauf-qa` emulator; the final installed Android app was reopened for use
(`native-test-state-cleanup.json`).

Final production revision `099f269` passed the complete remote workflow:
[GitHub Actions run 42703461965](https://github.com/dieWehmut/Selbstlauf/actions/runs/42703461965).
Responsive browser tests, production Pages tests, build and deployment all
completed successfully. `ci-production-final.json` records the authoritative
revision, event, job and step results. The subsequent report commit changes only
this verification document.
