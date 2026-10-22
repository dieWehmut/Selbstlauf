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
