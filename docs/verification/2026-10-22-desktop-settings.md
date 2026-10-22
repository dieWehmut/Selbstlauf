# Desktop settings verification — 2026-10-22

The source and unit checks run in the new `selbstlauf-settings-20261022` conda
environment through `scripts/verify/in-conda.sh`, which explicitly selects
Node 22.23.2. Dependencies come from the existing lockfile; the desktop remains
version 0.9.5 and Electron remains 44.4.1. Windows checks are orchestrated by
that conda Node and run the native Windows Node/Electron target in an independent
checkout with its existing Windows native dependencies.

## Changes verified

- Desktop shell actions retain Electron's prototype methods and their receiver,
  so the renderer's editing and zoom menus perform the actual Electron action.
- Fullscreen uses BrowserWindow's real `isFullScreen` and `setFullScreen` methods.
- Desktop state lookup supports XDG state directories and the normal Linux home
  fallback, matching the service's storage location.
- The saved terminal preference opens the selected session's service-resolved
  directory. The renderer supplies a session ID, never an arbitrary directory.
  Windows sessions running in WSL carry the distribution and Linux directory
  into `wsl.exe --distribution … --cd …`.
- Confirmed preference writes notify every desktop viewer. Concurrent independent
  patches are serialized and preserve both fields; failed writes are not broadcast.

## Real Windows application

`apps/desktop/scripts/verify-settings.mjs` drives the actual Electron window.
The final run passes these observable checks:

```text
PASS preload exposes live settings subscriptions
PASS renderer Copy reaches the real Electron clipboard
PASS renderer Paste changes the actual settings input
PASS renderer zoom increases then returns to actual size
PASS renderer fullscreen enters and leaves actual OS fullscreen
PASS independent viewer receives confirmed settings changes
PASS saved preference launches a real PowerShell ({"ok":true,"terminal":"powershell"})
PASS real PowerShell PID 42572 has the service-resolved Unicode directory
PASS close-to-tray keeps the actual main window alive and hidden
PASS turning close-to-tray off makes closing quit the actual app
PASS no renderer errors ()
```

The directory includes spaces and Chinese characters (`terminal cwd 项目 空格`).
Its value is read from the launched process's real Windows environment block
through the existing process provider. Windows 11 can delegate the console
window to another process, leaving PowerShell's own MainWindowHandle at zero;
the verification therefore checks the PowerShell process and its actual
directory rather than assuming PowerShell owns the visible window.

The first real run also caught a renderer focus bug: clicking the custom Edit
menu moved focus off the selected input, so Copy yielded an empty clipboard.
Preserving focus on menu mousedown fixes the observable failure; the complete
run then verifies Copy and Paste with the OS clipboard and the real input.

Direct `spawn` of an interactive PowerShell with detached/ignored handles also
reported success while PowerShell immediately exited. Windows terminal creation
now uses Start-Process with a normal visible console, reads the new PID and
releases inherited pipes without waiting for the user's console to close.

Screenshots live under `tmp/settings-verification-20261022/app/`:

- `01-menu-edit-dark.png`, `01-menu-zoom-dark.png`,
  `01-menu-fullscreen-dark.png`, `01-menu-appearance-light-1024.png`.
- `02-startup-preference-light-1024.png`,
  `02-startup-preference-dark-1440.png`, `02-settings-independent-viewer.png`.
- `02-terminal-preference-real-spawn.png`, `02-close-to-tray-restored.png`.

The screenshot names identify UI states, while the log proves behavior. The
terminal screenshot depicts the app after opening the terminal; its cwd proof
comes from the launched process, not from pixels.

## Linux application and coverage limits

The Linux 44.4.1 runtime was confirmed by `process.versions`. Its actual application
also passes the Copy/Paste, zoom, native fullscreen and no-renderer-error checks,
with four screenshots under `app/linux/`. Reusing a previously packaged runtime
requires copying the current bundled service, WebUI and preload into that
runtime's resources directory, because its `app.isPackaged` flag remains true
when launching the checkout. The initial missing-resource logs are retained.
The harness waits for React's initial command subscription before navigating to
settings, and checks that the real menu command opens the rail.

Linux state resolution and terminal failure/selection paths have unit coverage.
This WSL image has no installed graphical terminal executable, so a Linux external
terminal success is not claimed. Cmd, Windows Terminal, macOS terminal applications and WSL terminal
arguments are covered by command/quoting checks, not by a graphical native run
of every terminal application.

## Packaged Windows application

The same full check also passed against
`C:/Users/han/AppData/Local/Temp/selbstlauf-settings-package-20261022/win-unpacked/Selbstlauf.exe`
(version 0.9.5). The managed shell and independent viewer are started by that
packaged app's native node-pty dependency, resolved from the app's asar/unpacked
layout. The UI, service, preload and terminal action come from the package.

The external PowerShell in this run was PID 35852. Its real environment block
confirmed the run's own `terminal cwd 项目 空格` directory. Closing the package's
main window hid it with close-to-tray enabled and terminated it after that
setting was turned off. All eleven checks passed with no page errors; the
package's nine screenshots and full log live under `app/packaged/`.

No installer or live user configuration was changed by this script. Reinstalling
the same local version remains a separate final check.

## Installed 0.9.5 verification after reinstall

After the same-version reinstall, an exact copy of the installed directory was
tested in a separate path, state directory and Electron browser profile. The
full behavior check passes against that installed copy. Before any UI action,
the harness confirms from Electron itself that its main-process PID owns the
temporary `watchdog.pid.json`, that LOCALAPPDATA and userData point to the new
temporary directory, and that its service origin differs from the user's port
48920. The run's main PID was 29924; the Playwright launcher PID was 16504.
The packaged Windows executable can relaunch its main process, so the launcher
PID alone is not valid evidence of ownership.

The installed app.asar SHA-256 is
`623a6c1e21b4bdb7c93325391f77212ba174537a502d1f22d1c2c367f4f9cd08`.
The real user's config SHA-256 remains
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`
before and after the isolated verification. The user's desktop-settings.json
was absent both before and after. The evidence and nine full application
screenshots are in `app/installed-copy/`.

The actual user's installed window was also captured without changing its
focus, visibility, preferences or theme. `PrintWindow PW_RENDERFULLCONTENT`
captures HWND 5639962, belonging to installed Selbstlauf PID 14304, version
0.9.5. The image shows the user's preserved pink/dark appearance and real
monitoring state (nine processes, five writable). The image and owner/bounds
metadata are under `app/installed-readonly/installed-window-current.*`.
CopyFromScreen was unavailable in the WSL-launched Windows helper, so PrintWindow
is the capture method recorded in the metadata.

## Four-language native settings

Desktop preferences now include `locale` (`zh-CN`, `zh-TW`, `en`, `ja`). An old
file without that field reads as `zh-CN` while preserving its other preferences.
Invalid locale patches retain the currently saved language. A successful save
rebuilds the real application menu and tray context menu before notifying all
desktop viewers. Native menu labels and readable terminal, session, agent,
capture and typing errors use a desktop-only catalog; helper/OS error details,
protocol reason codes and user-created window titles keep their original values.

The desktop unit run passes 171 tests through the conda wrapper. The real Windows
check, `apps/desktop/scripts/verify-locale.mjs`, passes 34 checks on the independent
Windows checkout with Electron 44.4.1 and app version 0.9.5. Main PID 628 and the
restarted main PID 30152 each owned their temporary service record and browser
profile; the explicitly selected service port was 52407, separate from the user's
48920 service.

For each language, the check selects the actual language control, confirms the
saved file and independent agent viewer, reads `Menu.getApplicationMenu()`, and
observes the real `Tray.setContextMenu()` call without replacing Electron's
behavior. Copy reaches the OS clipboard, the translated fullscreen item enters
and leaves real OS fullscreen, and a closed-session terminal request returns the
saved language's readable error. Thirty successful screenshots cover each
language's dark/light appearance, the 960-pixel minimum window width, language
control, editing menu, fullscreen and separate viewer, plus save failure and
restart. They and the native menu JSON are under `app/locale-native/`.

The save failure is real: replacing the temporary preferences destination with
a directory makes Windows reject the atomic rename with EPERM. The control,
native menu and both viewers remain English and expose the actual error. Reload
and a new main process then restore the saved English language. No renderer
errors occurred. The real user's configuration SHA-256 remains
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`.

Initial harness failures are not product failures or passes: a service record
stores its port as a string; newly opened child windows change BrowserWindow
enumeration order; and Playwright keyboard injection does not trigger the
native F11 accelerator in this Windows runtime. The finished harness normalizes
the port, identifies the main window by its actual ID, and exercises the real
translated fullscreen menu. Native roles and accelerator definitions remain
covered by the menu behavior checks. The initial failed screenshot is retained
in `app/locale-native/initial-failures/`.

## Final packaged runtime and local preferences

The final Windows package at
`C:/Users/han/AppData/Local/Temp/selbstlauf-settings-package-runtime-final-20261023/win-unpacked/Selbstlauf.exe`
passes all 44 checks in the expanded native harness. It reports app version
0.9.5, Electron 44.4.1 and app.asar SHA-256
`5d2f4fbb365ff6a02a85038c9b958c0aa87f494939196b30713628b9b08329f1`.
Both actual main processes (9652 and 16976 after restart) own the same temporary
state/profile and explicitly selected service port 50713. The temporary config
starts with automation disabled and dry-run enabled. No user preferences or
automation settings are written.

The check now exercises notification and pet controls against real application
content. An unchanged config PUT creates four real audit events; a timeline
limit of two displays exactly two and still displays two after renderer reload.
Turning panel notifications off suppresses a real theme-copy success notice;
the success and error switches immediately filter that notice and a rejected
theme import. Enabling the pet and selecting the ring form displays the ring
in both the main window and an independent agent viewer, including after reload.
The notification preferences also persist and synchronize to that viewer.

The reload check originally exposed missing saved-history loading. The Web app
now reads the real audit endpoint independently of health, merges events arriving
through SSE during the read by ID and timestamp, and rejects stale responses.
Regression coverage includes concurrent arrivals, empty authoritative history,
late older responses and history-fetch failure without losing service health.
The final package includes that fix and the configuration-draft/runtime fixes
from the other settings work.

The 37 successful screenshots and native menu/process evidence are in
`app/locale-runtime-final/`; the conda orchestration log is
`app/locale-runtime-final-run.log`. This run uses the final packaged resources,
including its native PTY dependency and bundled Web app. The real user's config
SHA-256 remains
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`.

## Final installed-directory verification — 2026-10-23

After the final same-version reinstall, the exact current installed directory
`C:/Users/han/AppData/Local/Programs/Selbstlauf` was copied to
`C:/Users/han/AppData/Local/Temp/selbstlauf-locale-installed-copy-final-20261023`.
The copy's app.asar matches the actual installation's SHA-256
`5d2f4fbb365ff6a02a85038c9b958c0aa87f494939196b30713628b9b08329f1`.
The full expanded locale/local-preferences harness passes all 44 checks against
that installed copy with 37 screenshots and no renderer errors.

Electron reports version 44.4.1 and app version 0.9.5. The actual main process
16244 and restarted main process 33588 each own their temporary state/profile
`selbstlauf-locale-Xv4Imu` and service on port 55769. They do not share the user's
port 48920 or saved preferences. This avoids the installed executable's normal
single-instance behavior while verifying the installed package's own resources.

The user's config SHA-256 before and after this full run is identical:
`b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c`.
The user's desktop-settings.json is absent before and after.
`app/locale-installed-final/installed-evidence.json` records those hashes,
the source/copy executable paths and `userStateUnchanged: true`.
The same directory contains all 37 screenshots and native menu/process JSON;
`app/locale-installed-final-run.log` records orchestration by the explicitly
selected conda Node 22.23.2 and the 44 successful behavioral checks.
