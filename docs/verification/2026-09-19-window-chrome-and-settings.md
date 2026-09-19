# Window chrome, settings rail, and artwork — 2026-09-19

Closes the work requested for release 0.2.0: match the reference window's top
edge, adopt the reference settings content, derive every shipped icon from the
supplied artwork, rebuild the installer, install it on this host, and publish.

## Branches and integration

Each piece was committed separately on its own branch and then merged into
`main` with `--no-ff`, so the history keeps the task boundaries.

| Branch | Purpose |
| --- | --- |
| `feature/app-icon-artwork` | Multi-frame ICO plus the WebUI icon set, and the generator that derives them |
| `feature/desktop-shell-chrome` | Custom title bar, application menus, IPC bridge, tray lifecycle, desktop preferences |
| `fix/webui-topbar-and-overflow` | Two pre-existing top-bar defects found while verifying |
| `feature/webui-chrome-settings` | 15 settings section components and the local preference layer |
| `feature/settings-rail` | The grouped rail that replaces the three-tab strip, wired to live data |
| `release/0.2.0` | Version bump |

## Window top edge

`titleBarStyle: 'hidden'` with a frozen `titleBarOverlay`
(`{ height: 40, color: '#0b1120', symbolColor: '#e2e8f0' }`) keeps the real
Windows minimise / maximise / close buttons, so hit-testing stays native. The
renderer draws the rest of the row: panel toggle, back, forward, then the
`文件 编辑 视图 帮助` buttons with working dropdowns. The whole row is a drag
region and every interactive child opts out with `no-drag`; a 148px right gutter
is reserved only under `:root[data-shell='desktop']`, so a browser build has no
dead strip. Row 2 (the existing topbar) is unchanged.

## Tray and window lifecycle

Closing the window hides it to the tray and provably leaves the bundled service
running; the tray is the only quit affordance.

- Tray menu, in order: `打开主界面`, `设置`, `开机自启` (checkbox), `关于 Selbstlauf`, separator, `退出`.
- Left click shows and focuses the window, restoring it when minimised.
- `文件 → 隐藏到托盘` replaced the former quit item; no quit affordance exists in
  the window, its menus, or the renderer.
- `退出` runs one clean shutdown: stop the service, destroy the tray, `app.quit()`.
- On a machine without a tray the window closes normally, so the app can never
  become an invisible, unreachable process.
- `开机自启` reads the startup state back from the loopback routes rather than
  trusting the click, and rebuilds the (static) Windows menu from what the
  service reports.
- Single instance: a second launch focuses the existing window instead of
  starting a second service.

## Settings navigation

The three-tab strip became a rail of two labelled categories, with `返回应用`
and a `搜索设置` field that really filters the list: `个人` holds 常规, 通知,
导入, 个人资料, 外观, 家长控制, Trusted contact, 语音, 配置, 个性化, 宠物,
键盘快捷键, 使用情况和计费 and 账户; `集成` holds 电脑操控, 应用快照, 插件 and
浏览器. Sections are mounted against live data: the timeline limit is enforced,
usage figures are computed from the current sessions and events, 电脑操控 gates
the reveal action, 个人资料 names the sidebar, and 账户 hosts the environment
panel. Config saves pass through the 家长控制 PIN gate when it is enabled, and
`Ctrl+1..3` switch pages to match the 键盘快捷键 table.

Honest limits are part of the result, not omissions: the `统一 Codex 会话历史`
switch saves a preference and says in the UI that migration and restore are not
implemented; `关闭时最小化到托盘` and `首选终端` render disabled with a
`需要桌面应用` chip outside the desktop shell; the account section shows no
"new version" strip or update button because no update source exists for it.

## Defects found and fixed

Both predate this work and were proven to do so by attribution.

- The page scrolled sideways between 701px and 929px. The 930px process table
  scrolls inside its wrapper, but its header's absolutely-positioned `.sr-only`
  label had no positioned ancestor inside that container, so its 1px box escaped
  the wrapper and grew the document scroll width by exactly the table's right
  edge. `position: relative` on `.process-table-wrap` contains it.
- `.icon-button` also sets `display` and is declared after `.mobile-menu`, so the
  drawer's hamburger rendered at every width. A min-width query now hides it
  above the 960px drawer breakpoint.

Both are covered by new browser tests.

## Icon artwork

`scripts/desktop/generate-icon-assets.ps1` derives every shipped icon from
`assets/selbstlauf-icon-source.png` using only built-in GDI+, so regeneration
needs no third-party tooling and no path outside the repository.

- `apps/desktop/build/icon.ico`: a real 7-frame PNG ICO (16/24/32/48/64/128/256).
- `apps/web/public/{favicon-32,apple-touch-icon,icon}.png` and
  `apps/web/src/assets/brand.png`.
- A fresh `--dir` package was produced and the icon extracted back out of
  `Selbstlauf.exe` to confirm electron-builder accepts the multi-frame ICO and
  embeds the new artwork.

## Gates on merged `main`

| Gate | Result |
| --- | --- |
| `npm --workspace apps/cli test` | 243 passed, 0 failed |
| `npm --workspace apps/desktop test` | 71 passed, 0 failed |
| `npm --workspace apps/web test` | 90 passed across four files |
| `npm run build` | CLI, desktop and production WebUI built |
| `npm --workspace apps/web run test:browser` | 15 passed |
| `npm --workspace apps/desktop run smoke` | service, index and asset all served |
| `tests/Test-WindowsScripts.ps1` | All 35 passed |
| `tests/Test-Documentation.ps1` | Passed |

## Release and installation on this host

`npm --workspace apps/desktop run package:win` produced x64, arm64 and combined
installers at 0.2.0. The x64 setup was installed with `/currentuser`, the
supported silent form for this per-user product; plain `/S` asks for elevation
because NSIS defaults an assisted installer to an all-users path.

- Installer: `tmp/desktop-dist/Selbstlauf-Setup-0.2.0-x64.exe`, SHA-256
  `5630B905B0E0B3919F7AF3E1121CDD91E91358DCBC41D71C5BB47DEA6CB39382`.
- Installed per-user into `%LOCALAPPDATA%\Programs\Selbstlauf`: 158 files, an
  `HKCU` uninstall entry at 0.2.0, and desktop + Start Menu shortcuts.
- The installed executable's own icon was extracted back out and is the supplied
  artwork, so the new ICO survives packaging.
- The installed app was launched and served its WebUI on `127.0.0.1:48920`:
  `watchdogRunning: true`, and it discovered four live sessions (three Codex roots
  and one DeepSeek Harness root) with their host applications.
- The served bundle contains the new UI: the `文件 编辑 视图 帮助` row with a
  working `文件` dropdown (`返回应用`, `隐藏到托盘`), the 18-entry settings rail,
  and zero page errors.
- A second launch of the installed executable did **not** start a second service:
  `startedAtMs` was unchanged and the process count stayed at one app tree, which
  confirms the single-instance lock.

### Real GUI verification found a shipping bug

The unit tests and the HTTP checks above all passed while the packaged app was
still broken, so the installed window was driven directly: `WM_CLOSE` was sent to
the app's real top-level window — the same message the title bar's X and Alt+F4
produce — and the result was measured.

The first run failed:

    window still exists: False        app processes alive: 0 of 4
    window visible after close: False service after close: running= (stopped)

Closing the window quit the whole app and stopped the bundled service, the exact
opposite of the documented behaviour.

**Cause.** Both the window and the tray load the icon from an absolute path, but
`electron-builder.config.mjs` never copied `build/icon.ico` into `resources`.
`win.icon` only brands the executable; it does not place the file in resources.
In a packaged build `resolveWindowIconPath` therefore returned `undefined`,
`createIcon` produced `null`, and `new Tray(null)` threw, so `installTray`
degraded to a null tray. With no tray, `lifecycle.handleWindowClose` deliberately
falls through to a normal close — it is written that way so the app can never
become an invisible, unreachable process — and `window-all-closed` then stopped
the service and quit. The trap is that this graceful degradation made a missing
asset look like a lifecycle decision rather than a packaging defect.

**Fix** (`f0af534`). Copy the icon to `resources/build/icon.ico` as an
extraResource, and probe the packaged resources path *and* the repository layout
in `resolveWindowIconPath`. A regression test models the real asymmetry:
`resourcesPath` holds the icon while `appRoot` (the unpacked asar) has no `build/`
directory at all.

**Re-verified on this host after reinstalling**, against the real window:

    window still exists: True         window visible after close: False
    app processes alive: 4 of 4       service after close: running=True, startedAtMs unchanged
    window visible after restore: True

The tray itself is confirmed by enumeration of the app's own top-level windows,
which includes `Electron_NotifyIconHostWindow` — the hidden host window Electron
creates only when a `Tray` really exists. UI Automation cannot see Windows 11's
tray icons, so that window class is the mechanical evidence.

No 0.2.0 or earlier package shipped the asset, so this defect was present in
every packaged build; it is fixed in the next release.

Release `v0.2.0` was published by `.github/workflows/release-desktop.yml` (the
`test` and `package` jobs both succeeded) with all three installers attached:
[github.com/dieWehmut/Selbstlauf/releases/tag/v0.2.0](https://github.com/dieWehmut/Selbstlauf/releases/tag/v0.2.0).
The published 0.2.0 assets predate `f0af534`, so installing from that release
reproduces the close-quits bug.

### 0.2.1 supersedes those assets

`v0.2.1` carries the fix and is the release to install:
[github.com/dieWehmut/Selbstlauf/releases/tag/v0.2.1](https://github.com/dieWehmut/Selbstlauf/releases/tag/v0.2.1)
(x64, arm64 and combined installers, all attached). The x64 setup was installed on
this host and reports `FileVersion 0.2.1`, and the packaged icon is present at
`resources/build/icon.ico`.

Final acceptance on that installed build, driving the app's own window:

    tray host windows: 1              (Electron_NotifyIconHostWindow)
    window hidden not destroyed: true service kept running: true
    service not restarted: true       app still alive: true
    window restorable: true           ACCEPTANCE: PASS

### The release gate now catches this class of bug

`v0.2.0` passed `scripts/desktop/verify-installer.ps1` in full while closing the
window quit the application and stopped the service, because that script checked
the install's files, shortcuts, service health, process discovery and logon task —
but never the icon asset and never the window lifecycle. That is the gap that let
the defect ship, so both are now asserted against the installed app:

- `resources/build/icon.ico` must exist (an unconditional file check).
- `WM_CLOSE` is sent to the app's real top-level window, and the run requires it
  to hide rather than be destroyed, to keep the app and `Electron_NotifyIconHostWindow`
  alive, to leave `watchdogRunning` true with an unchanged `startedAtMs`, and to be
  restorable.

The gate was validated in **both** directions rather than assumed:

- Against a deliberately repackaged build with the icon copy removed, it fails with
  `installed app is missing resources\build\icon.ico`.
- Against the correct 0.2.1 build it passes, printing `installed app owns a tray`,
  `closing the installed window hides it to the tray and keeps the watchdog running`
  and `the hidden window can be restored`.

Two further problems surfaced while proving the gate:

- The script invoked the installer with a bare `/S`. This product is per-user, so
  an assisted NSIS installer then defaults to an all-users path, asks for
  elevation, and in a non-interactive session hangs indefinitely instead of
  failing. Both the installer and the uninstaller now pass `/currentuser` and are
  bounded by `InstallTimeoutSeconds`.
- Driving the window needs a real interactive desktop. On a headless runner "no
  visible window" cannot be told apart from "the tray is broken", so that section
  is now skipped with a warning when there is no desktop session, and
  `-SkipWindowLifecycle` makes it explicit. The icon assertion stays
  unconditional, because that is the check that actually guards the packaging.

### The real window's top edge was still split in two (`v0.2.2`)

Every check above passed and the UI still did not match the reference in the one
place that matters most: the top edge. A browser tab cannot show it, because the
native window buttons only exist in the real window. So the installed app's own
window was captured (`PrintWindow` with `PW_RENDERFULLCONTENT`, which Electron's
compositor requires) and its pixels were measured:

    page title bar (empty area)   #1A1E22
    native button strip           #0B1120

Two visibly different strips across one 40px row. `TITLE_BAR_OVERLAY.color` was a
hardcoded `#0b1120` while the renderer paints the bar from `--panel-soft`, which
the palette effect derives as `mix(background, #ffffff, 0.004 + contrast/1400)` —
`#1a1e22` for the built-in dark palette.

Two things were wrong, and the second is the one worth remembering:

1. The static colour did not match, so the initial paint was split.
2. The dynamic correction could never arrive. `registerShellHandlers` ran *after*
   `hostAndLaunch` resolved, but the renderer reports its colour as soon as it
   paints — during load. The report hit `No handler registered`, and the preload's
   fire-and-forget `ipcRenderer.invoke` swallowed the rejection, so nothing was
   ever repainted and nothing was ever logged. Isolated by probing the live
   renderer from the main process: `window.selbstlaufDesktop` is present and the
   effect reports `#1a1e22`; with a stub bridge the same code path is exercised
   and produces exactly the painted `rgb(26, 30, 34)`.

Fixed in `730f394`: the overlay colour matches the built-in palette, the handlers
register before any window opens, `setTitleBarOverlay` is allowed to run without a
live window, and the renderer reports the colour it actually painted so a custom
palette or the light theme follows. Re-verified on a fresh install:

    y=20  page=#1A1E22   native-strip=#1A1E22

The whole row now measures one colour, and the capture shows a single continuous
title bar.

### The renderer bridge never loaded (`v0.2.3`)

Chasing why the dynamic title-bar colour report never arrived uncovered a much
larger defect: `window.selbstlaufDesktop` was **undefined in the shipped app**.
Everything built on it — the `文件 编辑 视图 帮助` menus, the settings store
behind `关闭时最小化到托盘` and `首选终端`, the tray's `设置` / `关于` commands —
was silently dead. Nothing logged an error, because every bridge call is
fire-and-forget, and the unit tests passed because they exercised stub bridges
rather than the real one.

Two independent defects had to be fixed:

1. **The window options were flattened.** `DesktopWindowOptions` extended
   `DesktopWebPreferences`, which put `contextIsolation`, `sandbox`, `preload` and
   the rest on the *top* level. Electron reads them only from `webPreferences`, so
   it ignored every one of them — the renderer ran on Electron's defaults and got
   no preload at all. The tests asserted the flattened shape, which is why a
   security regression of this size looked green.

2. **The preload was an ES module.** Once the options were nested the preload
   finally loaded, and immediately failed with `Cannot use import statement
   outside a module`: a sandboxed preload cannot be ESM. It is now
   `preload.cjs` (CommonJS), with the packaging config, path resolution and
   installer manifest following.

Both were found only after adding the two diagnostics that should have existed
from the start, and which are now permanent:

- `webContents.on('preload-error')` writes the failure and its reason to stderr.
- `verifyPreloadBridge()` checks once after load and reports a missing bridge.

`verifyPreloadBridge` is what produced the decisive line — `preload bridge
missing: window.selbstlaufDesktop is not available in the renderer` — in both the
dev tree and the packaged build, and the `preload-error` listener is what then
gave the exact reason.

Evidence after the fix:

- The installed app starts with **no** bridge or preload error where it
  previously reported a missing bridge.
- Serving the installed bundle with a recording stub shows the renderer reporting
  `#1a1e22`, exactly the painted `rgb(26, 30, 34)`, with `data-shell="desktop"`
  and the four menu buttons present.
- `scripts/desktop/verify-installer.ps1` passes end to end on the rebuilt x64
  installer: WebUI served, tray owned, close hides to the tray and keeps the
  watchdog running, the window restores, the probe process is discovered and
  decided on, and the per-user logon task is created and removed.

### One cleanup step still needs elevation

This host previously carried a **per-machine** 0.1.0 installation at
`C:\Users\han\software\Selbstlauf` whose uninstaller requires an elevated
confirmation. That directory was removed by hand, but two leftovers cannot be
deleted from an unelevated session and remain:

- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\1cb81a0d-dabd-5e19-9fd9-86ff38a6ca44` (0.1.0)
- `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Selbstlauf.lnk`, which now
  points at the deleted 0.1.0 path

Both need one administrator action: run the old uninstaller from an elevated
prompt, or delete that registry key and shortcut. This does not affect the 0.2.0
installation, whose `HKCU` entry and shortcuts are correct and working.

### The renderer's privileges are now checked, not assumed (`v0.2.4`)

The bridge check added in 0.2.3 proved only that the preload loaded. It could not
detect the other half of the bug it was written for: flattening `webPreferences`
made Electron ignore `sandbox`, `contextIsolation` and `preload` **together**, so
the renderer ran with weaker defaults while every options-level unit test passed.

`verifyPreloadBridge` now reads the renderer's own globals, because the options
object is what lied:

- `window.require` / `module` / `Buffer` / `global` must be unreachable from the
  page — what context isolation plus `nodeIntegration: false` buy.
- `window.electron` and `window.ipcRenderer` must not leak past the contextBridge.
- `process.sandboxed` must not be `false`; `null` (no `process` at all) is the
  strongest isolation and is accepted rather than treated as a failure.

The check was verified to actually fire, not merely to pass: pointing the preload
at a missing file reports both `preload failed: … ENOENT` and `renderer
verification failed: window.selbstlaufDesktop is not available in the renderer`,
while a healthy build starts silent. It is covered by unit tests in both
directions, and the nested `webPreferences` type now rejects the flattened
spelling at compile time, which is the exact regression that shipped.

`v0.2.4` was installed on this host: 0.2.4, `preload.cjs` present, the app running,
the service live, and the renderer check silent (bridge present, renderer
sandboxed, no Node globals leaked). `scripts/desktop/verify-installer.ps1` passes
end to end on its x64 installer.

### Both branches of the close-to-tray switch are now gated

The settings bridge and the behaviour it controls were the last part of the
renderer bridge that had never been exercised against a real build, so they were
verified live and then folded into the release gate.

Live evidence, gathered from a temporary probe since removed:

- `settings.get()` returns `{ closeToTray: true, preferredTerminal: null }` when no
  file exists, and `settings.set()` persists both fields — `get` then reported
  `{ closeToTray: false, preferredTerminal: 'powershell' }`.
- `onCommand` is a function, so the menu and tray command channel is reachable.
- The write landed in `desktop-settings.json` with **no temp file left behind**,
  which is the atomic temp-and-rename path.
- With `closeToTray: false` persisted, closing the window quit the app and stopped
  the service. With the file removed, the same gesture hid the window and kept the
  service running, and the window restored. Both measured with `WM_CLOSE` against
  the app's own window.

`scripts/desktop/verify-installer.ps1` now asserts both branches on every release:
the default must hide and keep the service, and `closeToTray=false` must quit and
stop it. The check restores the default and restarts the app afterwards, because
the quit deliberately leaves nothing running and the discovery and logon-task
checks that follow need a live app — the first draft of this change passed its own
assertions and then failed several steps later with a connection error.

### The tray and menu commands reach the real renderer

The command channel behind the tray's `设置` / `关于 Selbstlauf` and the `文件`
menu's `返回应用` was driven live through the app's own `sendToRenderer` — the
production path, not a copy of it — with the DOM read back afterwards:

    openSettings          -> h1 "Watchdog 设置", settings rail present, 常规 selected
    openSettings(account) -> 账户 selected, headings 关于 / 本地环境检查
    backToApp             -> h1 "进程监控"

All three land where the labels promise, so the tray menu items and the menu bar
are wired to the same working channel.

The renderer test had delivered `open-settings` with no section, which left the
half the tray actually uses unasserted; it now requires `账户` to be selected for
`section: 'account'` and requires an unknown section to still open the settings
page rather than doing nothing.

## Not verified

The native title-bar overlay's hit-testing and clicking the tray icon by hand
were not exercised; the tray's existence is proved by the app's
`Electron_NotifyIconHostWindow`, and hide-on-close by a real `WM_CLOSE` against
the installed window. Everything else above was executed.