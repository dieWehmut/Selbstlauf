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

No installer or live user configuration was changed by this script. Packaging
and reinstalling the same local version are separate final checks.
