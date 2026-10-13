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

### The overlay follows the theme, not just the default

The earlier claim that a custom palette "follows" was only verified for the static
dark default. Driving the renderer to the light scheme and re-measuring the real
window shows the dynamic path works:

    dark   -> page bar rgb(26, 30, 34)   native strip #1A1E22
    light  -> page bar rgb(239, 243, 242) native strip #EFF3F2

Both schemes measure as one continuous row, and the capture in light theme shows
the native buttons on the same light surface as the rest of the title bar. This
works because the effect re-runs on `[bridge, palette, theme]` and reports the
colour the browser actually resolved, rather than duplicating the palette formula.

Two process notes from this check, because both nearly produced a wrong answer:

- A stale `PrintWindow` capture made the app look like it was still in light mode
  after the preference had been cleared. The screenshot timestamp was unchanged
  and only a forced re-capture showed the truth; the measurement script overwrites
  its output and a failed overwrite is silent.
- Testing the light theme wrote a real preference into the app's own storage
  (`%APPDATA%\@ai-cli-bypass\desktop\Local Storage`). It was cleared again, and a
  fresh capture confirms the default dark theme is restored on this host.

### The published release asset itself was verified

Every earlier install test used an installer built here. The asset other people
download is the one CI built in its own environment, and it is a **different
artifact** — same version, different bytes:

    local build sha256      eb9a99acfc2780c58b94679640d33175e68f2aeac4ab86fa54c28b63111a9741
    published v0.2.4 sha256 4c6805aec92959acb092929c017da98d7884cfb447ac6cb6b0c5402d8b93960b

The published file was downloaded from the release, its SHA-256 matched GitHub's
own recorded digest, and `scripts/desktop/verify-installer.ps1` then passed
against it end to end:

    installed app serves its WebUI on port 48920
    installed app owns a tray (window 'Continuation Watchdog')
    closing the installed window hides it to the tray and keeps the watchdog running
    the hidden window can be restored
    with closeToTray=false, closing the window quits and stops the watchdog
    restored the default and brought the app back up
    installed app discovered the probe process as claude PID 19628
    installed app recorded watchdog decisions for PID 19628
    installed app owns and removes its per-user logon task
    installer verification passed

That exact asset is what is now installed on this host: 0.2.4, `preload.cjs`
present, `resources/build/icon.ico` present, the renderer verification silent
(bridge loaded, renderer sandboxed, no Node globals leaked), the title bar uniform
at `#1A1E22`, the service running and four sessions discovered.

### All three published assets verified, including arm64

Only the x64 asset had ever been installed; the arm64 and combined installers were
unexamined, and the arm64 payload has a documented history of failing silently —
`useZip` exists because the NSIS 7z plugin once skipped every ARM64-filtered binary
and still exited 0 with `Selbstlauf.exe` and every DLL missing. A host that cannot
run ARM64 cannot install-test that build, so the published payloads were verified
structurally instead, which is the same failure mode:

All three digests match the SHA-256 GitHub records for the release, and
`7za t` reports `Everything is Ok` for each.

**arm64 asset** (`Selbstlauf-Setup-0.2.4-arm64.exe`, 146.09 MB):
- Payload type is `zip`, not `7z`, so the `useZip` mitigation is in effect.
- 158 files extracted, 386 MB uncompressed (not a truncated archive).
- All 17 files the acceptance script requires are present, including
  `Selbstlauf.exe`, every shipped DLL, `resources\app.asar`,
  `resources\preload.cjs`, `resources\build\icon.ico`,
  `resources\web-dist\index.html`, and both PowerShell providers.
- `Selbstlauf.exe`'s PE machine type is `0xAA64` — genuinely ARM64, not an x64
  build mislabelled.

**combined asset** (`Selbstlauf-Setup-0.2.4.exe`, 293.47 MB): it carries two
payload streams. The first is the ARM64 tree; the second was carved out and is the
x64 tree (`0x8664`), so the combined installer really does ship both.

**x64 asset** (`Selbstlauf-Setup-0.2.4-x64.exe`, 148.07 MB): digest matched and
the full `verify-installer.ps1` acceptance run passed against it, then it was
installed on this host.

#### What the structural result does and does not prove

"All files present" is weaker than "it runs", so the two payloads were compared
file by file to see how far the x64 runtime evidence reaches:

    x64 files: 158; arm64 files: 158
    only in x64: 0        only in arm64: 0
    identical: 149        differing: 9

The 9 differences are exactly the files that carry native code, and nothing else:

    Selbstlauf.exe (246,478,336 vs 226,726,400)
    ffmpeg.dll, dxcompiler.dll, dxil.dll, d3dcompiler_47.dll,
    vk_swiftshader.dll, vulkan-1.dll
    snapshot_blob.bin, v8_context_snapshot.bin

**Every application file is byte-identical between the two payloads**, including
all ten that implement the verified behaviour: `resources/app.asar` (the whole
Electron main process), `resources/preload.cjs` (the renderer bridge),
`resources/web-dist/index.html` and its bundle (the UI, title bar and settings
rail), `resources/service-dist/src/index.js` (the watchdog),
`windows-processes.ps1` and `window-focus.ps1` (discovery and reveal),
`resources/build/icon.ico`, and the three `scripts/continuation` files.

So the arm64 build differs from the verified x64 build **only** in its native
binaries: the tray, hide-on-close, the UI, the bridge and the title bar are the
same bytes. That is the strongest statement available without ARM64 hardware, and
it is deliberately stated as "the same code drives it" rather than "it was run" —
installing and running on ARM64 remains unverified.

### The title bar's height was measured against the reference at last

The top edge was the one requirement stated as "exactly like the image", and every
check up to here had compared it to an impression of that image rather than to its
pixels. Measuring the reference settles its scale instead of assuming one:

- its caption glyphs are 20 px wide and adjacent button centres are 92 px apart,
  both exactly double the Windows 11 metrics (10 px glyphs, 46 px button pitch),
  so the capture is precisely 2x DPI;
- its title bar spans 71 physical rows, i.e. **35.5 logical px** — 35 px of
  content plus the 1 px bottom border;
- its whole row is one flat colour (`#1D2026`), which the earlier colour fix had
  already matched in structure.

The app drew **40 px**, about 12% taller. Nothing caught it because the height
lived in three unrelated literals — the row, the sidebar's sticky offset and the
sidebar's height — none of them tied to `TITLE_BAR_OVERLAY.height` or to any
measurement.

Fixed in `933ccfb`: both sides are 36 px, the stylesheet uses one
`--titlebar-height` token, and a desktop test reads that stylesheet and fails if
the token and the constant disagree or if `.titlebar` stops using the token, so
the two halves of the top edge cannot drift apart again.

Measured after the change with a ratio that cancels the capture scale
(title-bar height / caption-button pitch; the pitch is 46 logical px at any DPI):

    reference: 71 / 92 = 0.772  ->  35.5 logical px
    this app : 35 / 46 = 0.761  ->  35.0 logical px
    difference: 0.5 logical px, the resolution of the measurement itself

### The menu font size was also measured from the reference

A full-width CJK glyph advances exactly the font size, which makes the reference's
label size readable straight off its pixels: its 文件 glyphs start 14 logical px
apart, so its menu text is **14px**. This app drew **12px**, which showed up in the
capture as a shorter ink height (11 logical px against the reference's 13.5) and as
every following element sitting further right than it should.

Fixed in `e2a2262`; a browser test pins the size and records that the number is a
measurement, so changing it needs a new one. Confirmed by capturing this app's bar
at `deviceScaleFactor: 2` and comparing it with the reference at the same DPI: the
menu pitch — button width plus gap, read glyph centre to glyph centre — is 51.75
logical px in the reference and 52.5 here, inside the anti-aliasing noise.

#### What pixel comparison can and cannot settle

The measurements that are independent of the icon library are all matched: the row
height (from the background-to-border transition), the font metrics (from CJK glyph
advances), and the flat background colour.

The remaining position differences come from *ink centres*, which depend on each
icon's own artwork. The reference uses a different icon set, so comparing ink
centroids compares two drawings rather than two layouts. Those differences were
deliberately **not** fitted — adjusting padding to chase another library's glyph
bearings would move the layout away from the reference's intentions, not toward
them. This is recorded so the remaining offset is a known, reasoned limit rather
than an untested claim.

### One rail entry rendered nothing at all

The rail advertises 18 sections and a test pinned that count, but only four of them
were ever opened by any test. Adding one that walks all eighteen and requires each
to render a heading found that **配置 produced an empty panel**: it had no render
branch whatsoever. The panels that belong to it — the Claude Stop Hook block and
the Codex endpoint panel — were mounted under 常规 instead, which is why the entry
had never been noticed as broken.

Fixed in `55fff6f`: 配置 renders the Stop Hook block and the endpoint panel with the
config save bar, and the three unit tests plus four browser tests that located those
panels right after opening settings now select 配置 first, which is where the rail
says they live.

The new `settings-sections.spec.ts` visits every entry, requires a heading, and
fails on any page error — the check that found this. Browser suite: 15 to 16 passing.

This is the second defect in this work found only by exercising the surface rather
than the code that describes it: the rail's *data* was correct and tested, while one
of its *sections* was not wired up.

### The 事件 page and cross-page navigation were never exercised in a browser

Only 设置 was ever navigated to by the browser suite, so the 事件记录 page's layout
rested on jsdom alone — and jsdom does no layout, so an overflow, a collapsed
column or a document that scrolled sideways would not have shown up anywhere.
Navigation *between* pages was untested too: each page was checked in isolation, and
the title bar's 后退/前进 arrows were only asserted to exist.

Both are now covered and both pass (`b2f857b`):

- `timeline.spec.ts` opens 事件记录 at 1280x900 and 390x844 and asserts the heading,
  that rows render, that every row stays inside the viewport, and that the document
  never scrolls sideways.
- `navigation.spec.ts` walks 进程 → 事件 → 设置, edits a config field, navigates away
  and back, then drives the 后退 and 前进 arrows and confirms they move through the
  same history. It revisits all three pages three more times and requires the shell
  to stay intact — one `.app-shell`, one `.titlebar`, one `.settings-rail` — with no
  page error and no horizontal overflow.

No defect was found in either: the timeline lays out correctly at both widths and the
history arrows work. That is a real result rather than a formality, because these
were the two largest surfaces with no browser coverage at all.

The config assertion is deliberately loose — whether an uncommitted draft survives a
page change is a product decision — so the test requires the field to show a real
value rather than NaN, instead of pinning one behaviour.

Browser suite: 16 to 18 passing.

### The app was never tested with its service gone

Every browser test served a healthy API, so the failure path — the one a user
actually meets when the watchdog dies mid-session — had no browser coverage at all.

`service-outage.spec.ts` (`6ac44a6`) aborts `**/api/**` with `connectionrefused`
(a dead service rather than an HTTP error body), waits past a poll interval, and
then requires:

- the shell, title bar and current page are all still present, since an unhandled
  rejection would take the tree down;
- 事件 and 设置 still navigate and render with the service gone;
- all 18 settings sections still render rather than hanging blank;
- restoring the API recovers the app with no reload.

It passes with no defect found: the app stays intact, every section still renders,
and it recovers on its own. The installed-application check below exercised the same
surface once more against the packaged bundle.

Browser suite: 18 to 19 passing.

### The shipped desktop layout was never rendered by a test

No committed browser test installed the desktop bridge, so `data-shell='desktop'` —
the mode the installed app actually runs in — was never rendered anywhere in the
suite. Every browser test exercised the plain web build. The reserve that keeps the
page's own controls from sitting under the OS window buttons therefore had no
coverage, and a mistake in it would be invisible in every other test and obvious to
a user.

`desktop-shell.spec.ts` (`dcf3299`) installs the bridge and asserts:

- the shell switches itself into `data-shell="desktop"`;
- the computed right padding is exactly 148px and every title-bar control's right
  edge falls before the gutter begins, so nothing intrudes into the native buttons;
- the colour the renderer reports through `setTitleBarOverlay` is exactly the colour
  the page painted — the mechanism that lets the native strip follow a custom palette
  or the light theme, now checked against the live computed style rather than
  asserted by construction;
- the three named commands the menu bar and tray send (`open-settings`,
  `open-settings` with `section: 'account'`, `back-to-app`) drive the UI;
- the reserve drops to 4px below the 700px breakpoint and stays 148px at 900px.

No defect found. Two notes worth keeping: the `onCommand` payload is
`{ command, section }` rather than a bare string, and the first version of this test
asserted the release at 900px when the breakpoint is 700px — the test was wrong
rather than the CSS, which is why the breakpoint is now pinned from both sides.

Browser suite: 19 to 20 passing.

### The rail declared itself a tablist and did not behave like one

No browser test had ever asserted a focus state, an `aria-expanded`, or a tab index
anywhere in the app. Checking the rail against the roles it advertises found two
missing pieces of the WAI-ARIA tabs pattern (`1376966`):

- **No roving tabindex**: all 18 tabs were in the page tab order, so reaching the
  last section cost one Tab press per section.
- **No arrow-key navigation**: the keys did nothing on a control that announces
  itself as a tab list. The file's only `onKeyDown` was on the search input,
  guarding Enter against submitting the form.

Fixed with an `onKeyDown` on the list and `tabIndex={selected ? 0 : -1}` per tab:
Arrow Up/Down and Left/Right move by one, Home/End jump to the ends, and focus
follows the selection via `requestAnimationFrame` — needed because the newly selected
tab becomes the only one in the tab order, so without moving focus the roving
tabindex would strand the user.

`rail-aria.spec.ts` pins it: exactly one tab in the page tab order and it is the
selected one, ArrowDown/ArrowUp move by one with focus following, Home/End reach
indices 0 and 17, and focus never leaves the rail. It reported `18 of 18` before the
fix and passes after.

`titlebar-keyboard.spec.ts` covers the same ground for the title bar menus, which
were already correct: `aria-haspopup`/`aria-expanded` track the open state, Escape
closes, opening one menu closes the other, outside clicks dismiss, and focus does not
fall to the body.

Browser suite: 20 to 22 passing.

### A mislabeled release, caught and cleaned up

The 0.2.8 version bump first ran through a `node -e` one-liner whose quoting failed,
so it exited before writing the package files. The tag was pushed anyway: v0.2.8 was
tagged while `apps/desktop` and `apps/web` still declared 0.2.7, and CI built and
uploaded an installer named `Selbstlauf-Setup-0.2.7-x64.exe` onto the **v0.2.8**
release. That file was not the real 0.2.7 either — its digest differed from the one on
the v0.2.7 release — so anyone downloading "0.2.7" from the v0.2.8 page would have got
neither version.

Fixed by committing the version bump, moving the tag to the corrected commit, and
deleting the three mislabeled assets. Every release now lists exactly three correctly
named assets. The lesson is about process rather than code: a version bump that fails
must not leave a tag behind, so the version is now confirmed in all three places —
both `package.json` files and `APP_VERSION` — before tagging.

### The release path now refuses a mismatched tag, proved in CI

The mislabeled asset above had a root cause in the pipeline rather than the code: the
release workflow asserted that both architectures were packaged, but nothing compared
the tag with the declared version, so a tag pushed while the package files still said
0.2.7 produced a `Selbstlauf-Setup-0.2.7-x64.exe` attached to the v0.2.8 release.

`tests/Test-VersionConsistency.ps1` (`cf6661a`) now compares every declaration — both
workspace manifests, `APP_VERSION` in the renderer, and the two `package-lock.json`
entries — and with `-Tag` refuses a tag that disagrees. The release workflow runs it
in the `test` job before anything is built.

Proved rather than assumed, by pushing a deliberately mismatched `v0.2.9` tag:

    job 'test'    : failure
      - Assert the tag matches the declared version : failure
      - Build workspaces                            : skipped
    job 'package' : skipped

No installer was built, no release appeared, and `releases/tags/v0.2.9` returns 404.
The test tag was then deleted. A well-formed tag was left alone: the v0.2.8 run
remains green.

### Installing over an existing version was never tested

The gate installed a build, exercised it, and uninstalled it. It never installed one
version over another — the path a user actually takes when they install a newer
version, and a different code path inside NSIS, because an upgrade must replace the
existing app directory rather than merge into it and must not add a second uninstall
entry.

`verify-installer.ps1` now takes an optional `-UpgradeFrom <installer>`: it installs
that build first, plants a file in the app directory, then installs the build under
test over it without uninstalling. It asserts the app reports the new version, exactly
one uninstall entry remains and shows that version, the full payload is present, and
the planted file is gone — which separates "the new payload was laid down" from "the
old files were left where they were".

Run against the two published assets, 0.2.7 to 0.2.8:

    previous build installed: version 0.2.7 (expected 0.2.8 after the upgrade)
    upgrade check passed: 0.2.7 -> 0.2.8, one uninstall entry, payload replaced

The release workflow runs the same check, upgrading from the most recently published
release, and skips with an explicit warning when none exists so that a check which did
not run is never reported as a pass.

### The static file handler had never run in a test

No test had ever passed a `staticDirectory` to the HTTP server, so the code path that
serves the entire renderer was uncovered — neither its routing nor its
directory-escape guard had ever executed. The guard is security-relevant: the service
is reachable from any process on loopback, and it is the kind of code that reads as
correct while doing nothing.

Six tests now cover it (`04151f8`), all passing:

- the shell at `/`, and a real asset with a JavaScript content type — a wrong type
  would make the browser refuse to execute the bundle;
- a nested directory with its own index, and a file-less deep link falling back to the
  shell, which is what a refresh on a settings route needs;
- a missing file *with an extension* is **not** answered with the shell, since the
  browser would otherwise parse HTML as JavaScript;
- eight traversal attacks — `/../secret.txt`, `/assets/../../secret.txt`,
  `/..%2fsecret.txt`, `/%2e%2e/secret.txt`, `/....//secret.txt` and more — are all
  refused, and none leaks a file planted outside the served directory;
- an encoded traversal does not fall through to the shell;
- the API routes still work with a static directory configured, so the static handler
  cannot shadow them.

The traversal test plants a real file outside the static root and asserts its contents
never appear in any response, which is stronger than asserting a status code.

CLI suite: 243 to 249 passing.

### A real concurrency bug in the config store

Testing repeated and concurrent saves — a path with no coverage — found a genuine
defect (`ccf8697`). The existing test proved a *rejected* save leaves no temporary
file, but nothing exercised the branch that runs on **every** real save. On Windows
`rename` refuses to replace an existing file, so `replaceAtomically` falls into its
backup branch (move the old file aside, move the new one in, delete the backup), and
that branch was untested under concurrency.

Two concurrent saves raced there: the first moved `config.json` aside, the second then
failed with ENOENT because only EEXIST/EPERM/ENOTEMPTY were treated as recoverable.

    Error: ENOENT: no such file or directory, rename '...\config.json' -> '...\config.json.<uuid>.bak'

This is reachable in normal use — the renderer's settings form, the tray and the
service's lifecycle routes can all write at once — and it presents to a user as a
setting that reverts after appearing to save.

Two changes: `save()` now serializes through a promise queue (validating before
queueing, and absorbing a rejection so later saves are not poisoned), and
`replaceAtomically` treats an already-vanished destination as "nothing to back up".

Verified three ways: 25 sequential saves, 12 concurrent saves in-process, and **8
independent processes** writing the same file at once — zero failures, a document that
parses, one complete writer's value rather than a blend, and no `.tmp`/`.bak`
leftovers. Released as 0.2.9 and confirmed present in the shipped bundle.

### Collapsing the sidebar hid nothing useful

Collapsing the sidebar narrowed the grid to a 76px column and hid the brand and nav
labels with `display: none`, leaving a permanent strip of unlabelled icons down the
side of every page: not readable, and barely any space reclaimed.

At the user's request it now removes the sidebar from the layout and gives the content
the full width (`3531145`). The hide rule is scoped to `min-width: 961px` on purpose —
below that the sidebar is a drawer opened from the topbar, and hiding it there would
make navigation unreachable — and the narrow-width block restores `display: flex`. The
rail-only rules (centred brand, hidden labels, 12px padding) were deleted rather than
left in place.

Measured on the **installed** 0.3.0:

    expanded  - sidebar visible: true
    collapsed - sidebar visible: false
    workspace x: 236 -> 0
    workspace width: 914 -> 1150   (the full window)
    horizontal overflow: 0
    restored  - sidebar visible: true | width back to 914

`sidebar-collapse.spec.ts` pins it: hidden rather than narrowed, `.workspace` starting
at the window's left edge (the check that proves no 76px strip remains), full width, no
sideways scroll, exact geometry on restore, and — after collapsing at 1280px and
narrowing to 900px — a drawer that still opens at 236px with readable brand and nav
labels.

### The sidebar now lists processes, and a mouse-click bug it uncovered

The sidebar held only three navigation entries, so the discovered processes lived
solely in the main table. At the user's request it now lists them too, grouped the way
the reference sidebar groups its conversations (`206fa66`, `eb2ae45`, released as 0.4.0):

- **grouped by run location** — the host the CLI runs inside, which the table already
  shows as 运行位置 — ordered by category then label so the list does not reshuffle
  between polls, with rows ordered by longest silence first;
- a session with no host is kept under **未识别宿主** rather than dropped;
- selecting a row opens a **process detail page** that reuses the table's own fields and
  helpers, so a value means the same thing in both views;
- the **bottom bar opens a menu upwards** out of the sidebar footer — a downward menu
  would fall off the bottom of the window — offering the theme switch, 设置 and 收起侧栏.

**A pre-existing bug this uncovered.** Clicking a dropdown item with the mouse did
nothing: the menu closed and the action never ran, because the document-level `mousedown`
handler closed the menu before the item's `onClick` fired. This affected the title bar's
文件/编辑/视图/帮助 menus too, so 返回应用 and 隐藏到托盘 were unreachable by mouse. It
survived because the unit tests use `fireEvent.click`, which fires no `mousedown`, and
the one browser test that activated a menu item used the keyboard. Both handlers now
ignore presses that start inside the menu.

Verified on the **installed** 0.4.0 against its live service, not demo data:

    group headings: ["Tabby", "Codex 应用", "Selbstlauf", "DeepSeek Harness 网页界面"]
    rows: 5
    detail opened: 进程详情 | selected rows: 1
    menu bottom: 543 | bar top: 551  -> opens UPWARDS: true
    closed by Escape: true | page errors: (none)

Suites: web 90 to 104, browser 24 to 27.

#### Two testing notes

The browser suite runs the app with `VITE_STATIC_DEMO: 'true'`, so it **never calls
`/api`** and neither a `page.route` nor a `window.fetch` override can change the session
list. The scrolling test therefore shrinks the window until the sidebar's own list really
overflows, rather than inventing data — and it asserts the overflow happened, so it cannot
pass while proving nothing.

Adding a process list also made `getByRole('button', { name: '进程' })` ambiguous, since a
nav entry and a process row can share a name; the affected tests now scope that lookup to
the `nav`.

### A defect I introduced, caught and fixed in the next release

The first version of the sidebar list put `role="listitem"` on its `<button>` rows. That
overrides the element's button role, so the rows stopped being exposed as activatable at
all — a screen reader announced list items with no way to know they could be pressed,
even though a mouse still worked. The browser suite reported `by role button: 0`
(`20edc63`, released as 0.4.1).

The rows are now plain buttons inside a labelled `role="group"`, which is what they are: a
group of controls that select a process, not a list of static items. The browser suite now
asserts the rows are reachable as buttons, that no `listitem` role has taken over, and that
a row can be focused and activated with the keyboard. The four unit tests and one browser
test that had located rows by `listitem` now use the real roles, which is itself evidence
the roles had been wrong.

Verified on the **installed** 0.4.1:

    group found: 1
    rows exposed as buttons: 3
    rows exposed as listitem: 0
    row focused: true
    h1 after Enter: 进程详情 | selected rows: 1

### A second ARIA mistake in the same popup

The bottom bar's popup put its service-status block inside `role="menu"` as a plain
`<div>`. ARIA allows only menu items, separators and groups as menu children, so the
markup was invalid and a screen reader may skip the entire menu because of it — the three
items would then be unreachable, a worse outcome than the visual problem it was meant to
avoid. Fixed in `c893471` (0.4.2): the popup is now a labelled `role="region"` containing
the status block and a `role="menu"` holding only the three items.

This is the **second ARIA mistake in this one popup**, and both were found the same way —
by asking what the accessibility tree actually exposes rather than reading the markup:
`role="listitem"` on the previous release's rows hid that they were buttons, and this one
hid the menu items. Both now have assertions that pin the real roles: every child of the
menu must carry `role="menuitem"`, the status must remain reachable, and the menu must sit
inside its region.

Verified on the **installed** 0.4.2:

    sidebar rows as buttons: 3 | as listitem: 0
    detail page: 进程详情 | selected rows: 1
    menu children roles: ["menuitem","menuitem","menuitem"]
    status readable: 1 | opens UPWARDS: true | closed by Escape: true
    page errors: (none)

### The UI advertised a shortcut that was never bound

The bottom bar's menu displayed `Ctrl+,` beside 设置 — the conventional binding for
preferences — while **nothing bound it**, so pressing it did nothing. The 键盘快捷键
settings list had drifted the same way: its own contract is "exactly the shortcuts the
application honours today", and it listed four keys while the menu displayed a fifth that
did not exist (`6ebd80a`, 0.4.3).

`Ctrl+,` is now bound alongside `Ctrl+1/2/3` and added to the documented list. The check was
extended behaviourally rather than just in its strings: the unit test presses it and requires
it to reach 设置, and a new browser test presses **every** documented page shortcut and then
reads back both the menu hint and the settings table, so the three cannot disagree.

Verified on the **installed** 0.4.3:

    menu 设置 item: "设置Ctrl+,"
    h1 after Ctrl+,: Watchdog 设置   -> works: true
    shortcuts list mentions Ctrl+,: true | Ctrl+1: true
    page errors: (none)

### A flaky CI failure, distinguished from a defect

The first v0.4.3 run failed at *"Verify the x64 installer installs a complete, self-owned
app"*. Rather than assume either a flake or a defect, the same check was reproduced locally
against a freshly built 0.4.3 installer: it **passed**, including the tray, hide-on-close,
discovery and logon-task checks. Nothing install-related had changed in that release — the
diff was version numbers and web sources only.

The failed job was then re-run and **passed**, confirming it was environmental rather than a
regression. Both jobs are green and the release is published. Worth recording because the
temptation is to treat a re-run as proof of nothing: here the local reproduction is what
made the re-run meaningful.

### A light scrollbar on a dark page, and a rail naming features that do not exist

Both were found by reading a screenshot of the dark theme against the rendered app rather
than by reading the markup.

**The scrollbar.** No `color-scheme` was declared anywhere, so the browser drew its own
scrollbars, form controls and focus rings **light** regardless of the app's colours — the
bright bar down the settings rail and the process list. `:root` now declares
`color-scheme: dark`, the light theme opts back into `light`, and both scroll regions get a
thin themed scrollbar, declared with the standard properties *and* the `-webkit-`
pseudo-elements because Firefox and Electron honour different ones (`d4ffe23`, 0.4.4).

**The rail labels.** Two entries had drifted from the panel each one opens:

- `trusted-contact` read **"Trusted contact"** — the single English label among otherwise
  Chinese ones, while its own panel is titled **信任联系人**.
- `usage` read **使用情况和计费**, "usage and billing", while the panel is titled
  **使用统计** and computes session and event counts. The application has no billing concept
  anywhere, so the rail advertised a feature that does not exist.

Both now match their panels. The unit test that pins the rail's labels also rejects a
billing label outright, rather than only comparing strings.

Verified on the **installed** 0.4.4 — which matters here, because headless Chromium uses
overlay scrollbars and reports a width of 0, so it cannot show the defect at all:

    color-scheme (dark theme): dark
    rail scrollbar: width=thin  color=color(srgb .22 .27 .30 / .7) transparent
    webkit scrollbar rules matching the rail: 5   <- what Electron actually paints with
    labels include 信任联系人: true | 使用统计: true | promises billing: false

Two browser tests assert the declared scheme in both themes, that both scroll regions use a
thin themed scrollbar, that the rail genuinely overflows at 1249x704 so the scrollbar is
exercised rather than hypothetically styled, and that neither removed label has crept back.

### The settings page had two left columns, and its title bar scrolled away

Both were structural, and both were fixed together (`9c52c73`).

**Two left rails.** 设置 stacked the app sidebar — brand, navigation, process list, footer
— and then the settings section rail inside the content area. The rail *is* the navigation
for that page, so it now takes the sidebar's grid slot and the app sidebar is not rendered
at all on 设置. Leaving the page goes through 返回应用 in the rail or the title bar's history
arrows. Below the 961px drawer breakpoint the rail is a drawer opened by the same topbar
button, and picking a section closes it.

**A title bar that scrolled.** The shell was a document that scrolled, so a long settings
section pushed the window's own title bar off the top. The shell is now a viewport-height
grid whose middle column scrolls (`height: 100vh; overflow: hidden`, with `.workspace` as
the scroll container), so the title bar is at the top by construction; the page title row
sticks inside the scrolling column so the service controls stay reachable.

Verified against the **running service** rather than an invented API stub, at 1249x704 and
360x780:

    on 设置: app sidebar 0 | rail column 1 | brand / process list / account bar all 0
    rail column width 268 | content starts at x=268
    titlebar y: 0 -> 0 after scrolling | stays at top: true
    topbar pinned at 36 | content actually scrolled: true
    narrow: drawer opens, picking a section closes it, 0 horizontal overflow
    page errors: (none)

Two browser tests pin this as **geometry** — the rail's column position and width, the
content starting to its right, and the title bar's y before and after a scroll that the test
asserts actually happened — because "at the top" and "is the left column" are layout facts
that a class name would not prove.

#### A note on how this was verified

The first attempts used hand-written API stubs, and the app crashed with
`Cannot read properties of undefined`. That was the stub being incomplete — the settings
pages read `processFilters`, `tools` and more — not a defect in the change. Proxying `/api`
to the live service removed that whole class of false alarm, and is the reason the numbers
above can be trusted: a probe that invents its own data ends up testing its own invention.

Several existing tests had to change because they navigated back by clicking the sidebar's
进程 button, which is no longer on the page; they now use 返回应用.

### Collapsing on 设置 left the rail's column behind

Found immediately after the layout change above, by collapsing the rail on 设置 and reading
the geometry rather than by looking at the page (`4745767`, 0.5.1). The rail disappeared but
its **268px column stayed reserved**, squeezing the content into the left third of a 1249px
window — a collapsed page that looked broken rather than collapsed.

The cause was CSS rule order, not logic: `.app-shell--settings` and `.app-shell--compact`
are both single-class selectors, so they have equal specificity and whichever appears later
in the stylesheet wins. The settings rule is later, so it kept overriding the collapsed
state's single-column grid. Doubling the class on the collapsed selector —
`.app-shell--settings.app-shell--compact` — makes the collapsed state authoritative wherever
it sits in the file, instead of depending on the order of two unrelated blocks.

Verified on the **installed** 0.5.1:

    on 设置: app sidebar 0 | rail column 268px 981px | content x=268
    titlebar y 0 -> 0 after scrolling | stays at top: true
    collapsed: 1249px | content x=0 width=1249 | column reclaimed: true
    rail hidden: true | panels still rendered: 5
    restored: 268px 981px | exact geometry back: true
    page errors: (none)

The two new browser tests assert the invariant as geometry on **both** pages, so a shared
rule cannot regress for one while passing for the other. They were shown to catch the bug
rather than merely pass: with the fix removed they fail with `Expected: 1249, Received: 268`
— precisely the squeezed layout — and pass again once it is restored.

### The sidebar's brand header, and a conversation on every row

Two changes at the user's request (`5be3cf7`, 0.6.0).

**No brand block at the top of the sidebar.** It repeated the app's own name above the
navigation on every page without carrying anything actionable. The identity is not dropped:
the mark and the display name that 个人资料 sets moved into the popup the bottom bar opens,
beside the service status they belong with.

**Every process row names its conversation**, not only the selected one — which conversation
a process is in is what decides whether continuing it makes sense, so it belongs on the row
rather than one click away. `conversationLabel` moved into `./sidebar/session-groups` and is
imported by the process table too, so the two views cannot describe one session differently.

#### A defect this uncovered, of the same class as the previous one

Removing the header left the drawer's close control as the sidebar's only first child, and
it appeared at **every** width — including column widths where there is no drawer — pushing
the navigation down a whole row. `.icon-button` sets `display: inline-grid` and comes later
in the stylesheet, so at equal specificity it outranked `.sidebar-close { display: none }`.

That is the **same mistake as the collapsed-column fix in 0.5.1**: two single-class selectors
of equal specificity, decided by file order rather than by intent. Both selectors are now
doubled with `.icon-button` so the outcome does not depend on where a rule sits.

Verified on the **installed** 0.6.0, against its live service:

    1249px: sidebar brand 0 | app name in sidebar 0 | drawer close VISIBLE? no
            nav starts at y=52 | 4 of 4 rows carry a conversation
    360px:  sidebar brand 0 | drawer close VISIBLE? yes (drawer mode) | nav y=96
    popup carries the identity: true | status: true | page errors: none

A browser test compares every sidebar row against the process-table row for the same session
part by part — the table splits the label and the id into two elements while the sidebar shows
one line — so the shared helper is checked end to end rather than assumed.

### The conversation on a row was visible but not searchable

Adding the conversation to each sidebar row made text visible that the row's filter did not
look at: it matched `conversationId` but not the label, so typing 普通对话, 未关联 or 等待输入 —
all plainly on screen — returned **nothing** (`dc4ad31`, 0.6.1). The filter now searches the
same line the row displays.

#### A test that passed while the bug was present

The first version of the regression test searched the *first* row's label. That row's label
was "Goal" for a session whose `conversationId` is `demo-goal` — the id matched incidentally,
so the test **passed with the bug still in the code**. What exposed it was removing the fix
and finding the test still green.

The test now collects every distinct label on screen, requires at least one that cannot appear
in a session's own fields, and searches those. Proved by removing the fix again: it fails with
`searching "普通对话" found nothing, but that label is on a row`, and passes once restored.

Verified on the **installed** 0.6.1 against its live service:

    labels on screen: ["Goal", "普通对话", "步骤执行中"]
      search "Goal"      -> 2 rows, all show it
      search "普通对话"   -> 1 row,  all show it
      search "步骤执行中" -> 1 row,  all show it
    cleared -> 4 rows | page errors: none

#### Why the defects in this area were found behaviourally, not statically

Three defects in the sidebar have now been found by driving the real interface — the reserved
collapsed column (0.5.1), the drawer close control showing at every width (0.6.0), and this
one. The first two share a cause (equal-specificity rules decided by file order), so a static
audit of the stylesheet was attempted for that pattern. It was abandoned: a careful version
reported **19,256 candidates**, almost all ordinary CSS, which is a worse signal than the three
targeted behavioural checks that found the real ones. A report nobody can act on is not a
check.

### A sweep of every breakpoint boundary, which found nothing

Three defects in this area had been found by driving the interface, so the useful complement
was a systematic sweep rather than another targeted probe. Breakpoint boundaries are where
layout regressions hide: the rule one pixel either side of 700 or 960 is different, and each
side had only ever been checked at the two or three widths an existing test happened to use.

`breakpoint-sweep.spec.ts` (`189b737`) covers sixteen widths — both sides of each declared
breakpoint, plus 320 through 1920 — across all four pages (进程, 事件, 设置, 进程详情), checking
each for horizontal overflow, a missing or collapsed key element, anything past the right edge,
and that the settings rail is a column above the drawer breakpoint and off-canvas below it.

**It reported no defects.** That is the result worth recording: the layout holds across the
range rather than only at the widths already covered.

Two of my own probe assumptions were wrong and would each have produced a false report:

- `isVisible()` returned true for the settings rail while its drawer was closed, which looked
  like a defect at **eleven** widths. The rail is deliberately parked off-canvas with a
  `transform`, and `isVisible()` only means "not `display:none`" — the check is now whether it
  is genuinely on screen (measured: `x = -236` while closed, content not squeezed, and
  `elementFromPoint` returns the workspace rather than the rail).
- A generic "starts off the left edge" check flagged that same off-canvas drawer, for the same
  reason. Being off-canvas is the correct state there, so it is asserted separately.

No release came from this round: it changes only tests, so a new installer would carry no
functional difference from the installed 0.6.1.

### The sidebar rebuilt to the reference's shape, pinning, motion, and a rail without placeholders

Four requests, all verified on the built app (`0.7.0`).

**The sidebar reads like the reference's list.** Rows are two compact lines — the tool and its
silence, then the conversation — instead of three, and the host is no longer repeated on the row
because it is the group heading directly above it. A row is now a container with two children
rather than one button, because a `<button>` cannot contain another `<button>`: the pin control
would have been invalid HTML and unreachable.

**Pinning.** Hovering a row (or focusing it) reveals a pin that lifts the process into a 置顶
group on top. It is a *move*, not a copy, so the list stays a partition of the sessions; it keeps
pin order; it survives a reload; and the group does not appear when nothing is pinned. An id whose
session has exited is ignored rather than pruned, so a session that returns finds its pin again.

**设置 is gone from the top navigation**, as asked. It is reached from the bottom bar's popup and
`Ctrl+,` — the binding the popup advertises, and the one every test now uses.

**Motion**, all of it short and small (.18–.22s): rows fade and rise as the list is rebuilt, the
navigation icon eases on hover, and a settings panel rises when a section is chosen. The panel is
keyed on the section so React remounts it and the animation actually replays. All of it collapses
to nothing under `prefers-reduced-motion` — verified by disabling that rule and watching the test
fail with `.sidebar-row animation is 0.18s`.

#### The rail no longer lists sections that change nothing

Four sections were removed rather than left as placeholders: 家长控制 (a local-only PIN gating one
switch, never a security boundary), 信任联系人 (a name and email never sent anywhere), 语音 (a
switch with no implementation) and 使用统计 (counts of what was already on screen). 个性化 folded
into 外观, 应用快照 went with them, 配置 became 续写与进程 and 账户 became 关于. A new
**启动与托盘** lifts startup, close behaviour and the preferred terminal out of 电脑操控, where
window behaviour had been filed under "what the app may do to this machine".

Removing 家长控制 had a consequence worth naming: it put a PIN prompt in front of saving the
config. Leaving that prompt would have asked a user with the preference already stored for a PIN
**with no section left to change or clear it**, so the prompt went too.

#### A defect the screenshots caught

The compact row shortened a conversation id to its first eight characters, which turned
`session-b9dbc639-0a40-4eec-…` into **`session-`** — a prefix every DeepSeek Harness session
shares, so two rows rendered identically. A leading alphabetic segment is now dropped when enough
of the id remains, and the id is shown whole when it is short, so `demo-goal` is not clipped to
`demo-goa`. This was found by looking at the rendered sidebar, not by reading the code; the
nine tests in `conversation-short-id.test.ts` were written from the failure.

Verified on the built app against the live service:

    nav labels: ["进程","事件"] | nav height 79px for two rows | 设置 in nav: false
    groups: Tabby / Codex 应用 / DeepSeek Harness 网页界面 -> with a pin: 置顶 first
    rows: Codex | Goal · complete · 01a0bd1e | 1h 36m
          DeepSeek Harness | 步骤执行中 · b9dbc639 | 6s      (was `session-`)
    rail: 常规 外观 通知 键盘快捷键 个人资料 宠物 / 启动与托盘 续写与进程 导入历史
          电脑操控 插件 浏览器 关于                    (13, was 18)
    page errors: none

Suites: web 105 -> 101 (four sections' tests removed with them, nine id tests added), browser
38 -> 41.

### The window preview, and why input injection was not built

A process detail page now shows a still of the window that process runs in, plus a
**切换到该窗口** button. The user asked for both that and the ability to type into the preview;
the second half was measured, found not viable, and is documented rather than faked.

#### What the measurements established

Every claim below comes from running the real capturer, not from reading documentation. All of it
was done with windows this session created itself — an earlier probe of mine had launched Notepad
and closed a window the user had unsaved work in, so from then on no other application was
targeted, no process was terminated by name, and no input was sent anywhere.

| Case | Result |
| --- | --- |
| Visible window | Captures at 945x600, text legible |
| **Occluded** window (fully behind another) | **Captures with its own content intact** — 162 distinct colours, identical to unoccluded |
| **Minimized** window | **Absent from the source list entirely**, not merely blank; returns on restore |
| Source id vs the service's handle | Exact match (`window:67008:0` ↔ `hwnd 67008`) |
| One window per process | No — two Codex sessions share Tabby's `hwnd 67008` |
| Cost of one capture pass | ~300ms, **flat** as windows go from 0 to 15 open |

The occluded result is what makes the feature worth having: it shows a session the user cannot
currently see. (A window already in front needs no preview.) The minimized result is why the panel
names that state in words instead of rendering an empty frame. The flat cost is why it is fetched
on demand rather than on a timer.

#### Why typing into the preview was not built

| Route | Foreground | Background (unfocused) |
| --- | --- | --- |
| Electron `sendInputEvent` | works (own window only) | — |
| `PostMessage WM_CHAR` | **works** — field received `xyz`, real `input` events | **no effect at all** — empty field, zero events |

A continuation is only useful if it arrives while the user is looking elsewhere, and the unfocused
case does nothing. Making it work would require seizing the foreground (interrupting what the user
is doing) or `AttachThreadInput` (fragile, often blocked). The app already writes continuations
through *validated* transports — the console bridge, the Codex adapter and the DSH web host — so
extending those is the correct route rather than synthesising keystrokes.

#### Design

The renderer asks for a preview **by session id, never by window handle**. The main process resolves
the handle through the service's own session list, so the capability is bounded to windows this app
already monitors and cannot be pointed at an arbitrary window. `windowPreview` is the one
asynchronous shell action, so it is dispatched separately from the synchronous
`applyShellAction` — which also keeps that function unit-testable without Electron — and a rejected
request resolves to a stated `unsupported` outcome rather than throwing across IPC, where the
renderer would only see an opaque "Error invoking remote method".

#### Verification

The packaged app, driven over the DevTools protocol (`0.8.0`):

    bridge shell keys: [reload, toggleFullScreen, zoom, quit, openExternal,
                        setTitleBarOverlay, windowPreview]
    dsh  pid=7984 hwnd=null    -> no-window
    codex pid=30780 hwnd=67008 -> minimized      (the user's windows are minimized)
    "nope:1" -> unsupported: that session is no longer running
    ""       -> unsupported: windowPreview needs a session id
    detail page panel: shows 窗口已最小化，无法抓取画面… | page errors: none

Because every window the user's sessions run in was minimized, that run could only exercise the
`minimized` state. The **captured** path was therefore proven separately, by importing the built
production module (`apps/desktop/dist/src/window-preview.js` — the same file packed into
`app.asar`) and driving it with Electron's real capturer against a window the probe created:

    captureSessionWindow -> captured
      size 945x600 | sharedBy 2 (two sessions pointed at one window)
      dataUrl 26506 chars -> decodes to a real PNG (signature verified, image inspected)
    no-window -> no-window | minimized -> minimized | unknown -> unsupported

Suites: desktop 92 -> 109, web 101 -> 111, browser 41 -> 42.

#### The captured path on a real watched session

Every window the user's sessions ran in was minimized, so the first packaged run could only reach
the `minimized` state, and the happy path had been proven only against a window this session created
itself. That is a real gap, since seeing a live process's window is the point of the feature.

Closed by driving the **published** install: the app's own `focus` endpoint — the exact call the
切换到该窗口 button makes — was used to raise the Tabby window that Codex sessions share, the preview
was requested again, and the window was then put back to minimized, the state it was found in.

    target: codex pid=30780 hwnd=67008 title="copilot-segmentation"
    state before:              minimized=True
    preview before:            minimized
    focus endpoint -> 200 {"ok":true,"sessionId":"codex:30780","focused":true}
    state after focus:         minimized=False
    preview after:             captured
      size 960x569 | sharedBy 3
      136541 bytes | decodes to a real PNG: true
    panel shows an image:      true
      caption: 此窗口内有 3 个受监控进程，画面为整个窗口 · copilot-segmentation
    state restored:            minimized=True
    preview after restore:     minimized

The captured image was inspected by eye: it is the real Tabby terminal with its live Codex session in
it, which is exactly the "what is happening in the session I cannot see" case the feature exists for.
`sharedBy` read 3 rather than the earlier 2 because a further Codex session had appeared in the same
window in the meantime — the count is live, as intended.

#### The published asset, verified rather than assumed

The push to `github.com` failed for a period: the API and npm were reachable while the git endpoint
returned connection resets and timeouts. The local commits and the `v0.8.0` tag were kept, the remote
was queried and confirmed to still be at 0.7.0 with no `v0.8.0` tag and no release, and the push was
retried until it succeeded rather than left as an unstated failure. CI then succeeded and published
three assets. The downloaded `Selbstlauf-Setup-0.8.0-x64.exe` matched the published digest, and the
installed app was confirmed to be running the **released** bundle (`index-CwC321Gp.js`, on disk and
loaded) rather than a local build — a distinction a version check alone cannot make.

#### The "fetched on demand, not on every poll" claim, measured

The design rests on the preview being fetched once per user action: a capture pass enumerates and
captures **every** window on the machine and costs ~300ms, so re-firing it on the app's 2s poll would
burn that continuously for a picture that changes only when the user acts. The app replaces its
session objects on every poll, so the preview component re-renders constantly and the claim is not
obvious from the code.

Measured by counting captures **in the app's main process**, with `desktopCapturer.getSources`
wrapped before the app's own entry module is imported, and driving the real UI over the DevTools
protocol:

    captures before opening a detail page:  0
    captures after opening the detail page: 1   (delta 1 — one fetch)
    40s of normal polling, sampled every 5s: 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1
      growth during 40s of polling: 0
    refresh button:                          1 -> 2
    switching to another process:            2 -> 3

So it captures exactly once per user action and never on the poll.

#### A probe of mine that measured nothing, and reported it as a result

The first attempt at that measurement wrapped `window.selbstlaufDesktop.shell.windowPreview` from the
renderer and counted zero calls over 45 seconds. It printed "the preview did NOT re-capture" — but
the same run also showed the **refresh button** producing no call, which is what gave it away. The
bridge is frozen (`Object.isFrozen(shell) === true`) and `window.selbstlaufDesktop` is non-writable
and non-configurable, so the patch was **silently refused** and the counter could never have moved.

The count was therefore meaningless, and the honest form of it would have been "instrumentation
failed", not "the claim holds". Measuring in the main process — at the point where the capture
actually happens — gave a number that means something.

Two further attempts failed before that one worked, and both are worth recording because each looked
like a result: writing `--remote-debugging-port` into `process.argv` leaves nothing listening (it must
go through `app.commandLine.appendSwitch`), and a probe left the app's own `main.js` importing while a
top-level `await` before `app.whenReady()` kept Electron from ever starting.

#### A stale window handle: the message promised something impossible

The preview matches a session to its window by handle, and the service re-resolves that handle from
the PID on every poll — so a handle can be stale by the time a preview is asked for. If a recycled
handle ever matched a different window, the panel would show **another window's content under this
process's name**, which is worse than showing nothing. That needed measuring rather than assuming.

Measured with a window this probe created, destroyed mid-run:

    live handle      -> captured
    destroyed handle -> minimized
    stale handle now matches any window: no

So a stale handle never resolves to another window — the exact-handle match is what makes it safe.
But it exposed a defect of a different kind: **a destroyed window produces exactly the same signal as
a minimized one**, because both are simply absent from the capture layer's source list with no
separate signal to tell them apart. The panel therefore said *"窗口已最小化，无法抓取画面。还原该
窗口后点刷新即可查看"* — telling the user to restore a window that no longer existed.

The state cannot be split honestly, since the evidence does not distinguish the two. What could be
fixed was the **wording**, so the message no longer claims to know which case applies:

    无法抓取该窗口的画面。通常是最小化了，还原它后点“刷新”即可查看。

Two tests were added: one that a stale handle never falls back to another window, and one that the
message does not promise restoration will help. Desktop suite 109 -> 111.

#### The same over-claiming, one state over

Fixing the minimized wording left the same mistake in the neighbouring state. The panel said a session
with no window was necessarily DeepSeek Harness:

    该进程没有自己的窗口（DeepSeek Harness 是网页界面），因此没有可预览的画面。

A null window handle has several causes, so the live service was queried to see which apply:

    sessions with no window: 1
      dsh | category=browser | label="DeepSeek Harness 网页界面"

The claim is therefore **right for every session on this machine and wrong as a general statement**: a
Codex session in a bare console, a shell, or a host whose window lookup failed also has no window, and
being told it was DeepSeek Harness is a message about the wrong tool. It is the same defect as the
minimized wording — asserting one cause for a state that has more than one — found by looking for the
pattern rather than by waiting for a report.

The reason is now derived from the session rather than hardcoded: a harness session explains that its
interface is a browser page, an identified host is named (运行位置：控制台), and an unknown one says the
window could not be identified. Two tests pin it, and **both fail when the hardcoded message is put
back** — verified by reverting the fix, watching them fail, and restoring it. Web suite 111 -> 113.

#### A real accessibility audit, which found a real contrast failure

The suite checked accessibility by *structure* — the rail is a valid tablist, sidebar rows stay exposed
as buttons, a menu holds only menu items. Those were all written from bugs already found, so they can
only catch bugs of a kind already known. `axe-core` was added as a dev dependency and now runs an
independent WCAG 2.1 A/AA rule set over every page, in both themes, with the settings drawer on a
narrow viewport audited separately because it is a different structure.

**It found a genuine failure, in the sidebar rebuilt this cycle.** `--faint` carried the group
headings, the silence times and the conversation lines at **3.29:1 against a required 4.5:1**, and the
light theme was worse at **2.95:1**. Those are text a person reads to decide what to act on, not
decoration:

    dark  --faint #637078  3.29:1 FAIL   (group heading, silence, conversation)
    light --faint #829095  2.95:1 FAIL

The first fix was **aimed at the wrong surface** and the audit caught that too: solving against the
sidebar background (#1a1e22) left the *selected* row's timestamp at 4.36:1, because selection changes
the row background to the lighter #1e2326. Both tokens are now solved against the true binding surface
in each theme:

    dark  --muted #9ea2a5  --faint #868b8d   4.86:1 on the sidebar, 4.60:1 on a selected row
    light --muted #4f575b  --faint #5f686a   5.11:1 on the panel,   4.60:1 on a selected row

The light theme had less headroom: `--muted` was only 4.95:1, so pushing `--faint` to AA with the
original `--muted` would have made `--faint` **darker** than `--muted` and inverted the visual
hierarchy. Both were therefore solved together, and `--faint` remains the dimmer of the two.

#### Two ways the audit itself was wrong before it was right

Both are recorded because each looked like a finding:

- **Measuring during an animation.** The audit injected axe and ran it immediately after navigating,
  while the row and panel enter animations were still running. axe samples *computed* colour, so a fade
  reads as a blended mid-transition value and is reported as a contrast failure. It reported sidebar
  failures that vanished once animations settled; the audit now awaits `document.getAnimations()`.
- **A path that did not exist.** The axe bundle was read from `process.cwd()`, which Playwright sets to
  `apps/web`, so the file was not found. Resolved through `createRequire(...).resolve` instead.

To prove the audit cannot pass vacuously, `--faint` was temporarily set to `#2a3238` — genuinely
unreadable — and the suite failed with contrast violations on all five pages. It was then restored.

Browser suite: 42 -> 45. Every page now reports zero WCAG A/AA violations.

#### The audit's own blind spot: transient surfaces

The audits above load a page and audit it, so they can only ever see what is on screen when a page is
loaded. Everything that exists only while it is open — the bottom-bar popup, the four title-bar
dropdowns, the hover-revealed pin — was invisible to them. The popup in particular had been
restructured this cycle into a header, label/value rows and two menu groups without ever being audited.

Audits were added for those states, and the gap was then **proved** rather than assumed: the popup's
keyboard-shortcut colour was temporarily set to an unreadable value, and

    ok  1  process list, detail page and settings rail
    ok  2  light theme
    ok  3  settings drawer
    x   4  bottom bar popup, its menus and the pin control   <- only this one caught it
    ok  5  popup in the light theme

Only the new test failed, which is exactly the point: the page-level audits pass regardless, because the
popup is not open while they run. The colour was restored and all five pass.

Browser suite: 45 -> 47.

#### A release failed by its own last step

`v0.8.4` was a test-only change, yet its `package` job failed. The log named the cause precisely:

    API rate limit exceeded for 52.159.245.176

The in-place upgrade check queried `api.github.com` **without a token**, so it fell under the anonymous
limit of 60 requests per hour per IP — shared by the runners. The defect is not the rate limit: it is
that this call happens **last**, after every installer has been verified, so a 403 from an unrelated
quota failed a release whose artefacts were fine.

Fixed in two layers, because either alone leaves the hole open:

1. The call is now **authenticated** (`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`), raising the limit to
   5000/hour.
2. A failure is **caught**. The check exists to add confidence; when it cannot run it says so and exits
   0, as it already did when there was no previous release. A transient 403 is not a defect in the
   artefact.

`tests/Test-ReleaseWorkflow.ps1` guards this and runs in CI **before** anything is built. It requires
that every `api.github.com` call sits in a step declaring its own token, and that an API failure is
caught.

#### The guard was wrong first, and passed when it should not have

The first version looked for a token anywhere in a 30-line window before the call. It passed even after
the token line was **deleted**, because the script body still mentioned `$env:GH_TOKEN` further down — a
mention is not a declaration, so the guard was reading text rather than structure.

It now walks back to the call's own `- name:` and requires `GH_TOKEN:` inside that step. Proved by
deleting the token line again: the guard fails with `release-desktop.yml:123 is in a step that does not
declare GH_TOKEN`, and passes once restored. The second version is what makes the check worth having,
since the first would have shipped a guard that could never fire.

#### Keyboard focus: two real defects, and two things that only looked like defects

axe validates names, roles and contrast. It does **not** check whether a keyboard user can reach a
control, see where focus is, or use the thing once focused — which is exactly the question for the pin,
since it is invisible until hovered or focused. Two real defects were found, and two apparent defects
were disproved.

**Real: focus was lost after pinning.** Pinning lifts the row into the 置顶 group, so React unmounts the
old row and mounts a new one, destroying the focused button. Measured:

    before Enter: {"cls":"sidebar-row__pin","label":"置顶 PID 336756"}
    after Enter:  {"tag":"body","isBody":true}        <- focus dropped to the document
    after Tab:    {"cls":"sidebar-row__open"}         <- restarted from the top

A keyboard user pinning several rows was thrown back to the start after each one, and a second Enter
landed on a different row — which **unpinned** the first. Fixed by remembering the session id on the pin
press and restoring focus to that row's pin once the move has rendered. It is keyed by id rather than
position, because the whole point is that the position changed.

**Real: the focus ring was invisible in the dark theme.** The browser default is `auto 1px rgb(16,16,16)`
— near-black — which against the dark sidebar (#1a1e22) is **1.14:1**, well under the 3:1 WCAG 2.2
"Focus Appearance" asks for. The light theme was fine at **17.01:1**, so only the dark one was broken,
and only for keyboard users. A themed ring now gives **8.95:1** dark and **4.02:1** light.

**Not a defect: the pin is not invisible when focused.** The first probe read `opacity: 0` on a focused
pin and looked like a serious finding. The pin fades in over .16s and the probe was reading the first
frame of that transition:

    +0ms opacity 0    +100ms opacity 0.90    +300ms opacity 1    +800ms opacity 1

The settled value is 1, so a focused pin is fully shown. Measuring during a transition is how a probe
invents a defect.

**Not a defect: tests do not leak pins to each other.** One intermittent suite failure looked like
`localStorage` leaking between specs in a worker, since a pinned row reorders the list. It was traced
properly: a test that pins a row, followed by a test reading `localStorage` before load, shows `null` —
Playwright gives every test a fresh context. The contamination was **within** a single test that
navigated twice. A shared isolation fixture was written for this and then **removed**, because it solved
a problem that did not exist; the spec records what was measured instead.

Both real fixes are pinned by `focus-appearance.spec.ts`, and each test was proved to catch its defect by
reverting the fix:

    ring reverted   -> "the dark focus ring is auto 1px rgb(16,16,16) at 1.14:1 against its surface"
    focus reverted  -> "focus was lost after activating the pin"

Browser suite: 47 -> 49, verified stable over three consecutive runs.

#### The tray at runtime, and a correction to this document

The tray had been listed below as unverified for several rounds on the grounds that clicking its icon
"by hand" had not been done. That was the wrong framing, and checking it produced no new defect — only a
correction worth recording.

What was measured in the packaged app this round:

    packaged icon exists: true   nativeImage size 256x256, empty=false
    16x16: 256/256 opaque pixels, 40 distinct colours, 177 saturated
    Tray constructed from the packaged icon: yes
    window hidden -> tray reveal -> visible=true, focused=true
    window minimized -> tray reveal -> visible=true, minimized=false, focused=true
    handleWindowClose (closeToTray=true,  tray present): returned=true,  preventDefault=true
    handleWindowClose (closeToTray=false, tray present): returned=false, preventDefault=false
    handleWindowClose (closeToTray=true,  NO tray):       returned=false, preventDefault=false

So hide-to-tray works from both hidden and minimised states, and the three close behaviours agree with
their intent. But **all three of those close cases are already covered by `lifecycle.test.ts`**, and the
tray menu, its labels, its reveal-then-command behaviour and the checkbox's non-optimistic repaint are
covered by `tray.test.ts`. The renderer's handling of the tray's `open-settings` command — including the
account section — is covered in `App.test.tsx`. This round therefore **found no defect and closed no
real gap**; what it did was confirm the packaged build behaves as the unit tests already asserted.

The honest statement of what remains unverified is narrower than what used to be written here: the
*appearance* of the tray icon in the notification area, and the native title-bar overlay's hit-testing.
Neither is reachable by automation without synthesising clicks at coordinates the harness cannot verify.
The tray icon was extracted and measured (fully opaque, colourful, legible at 32px, washed out at 16px,
which is the source PNG's own lightness rather than a defect) — but measuring pixels is not the same as
seeing it sit correctly among other notification icons.

#### The native-button gutter, and a first test that could not fail

The renderer reserves 148px on the right of the title bar so the OS-drawn minimise/maximise/close
buttons sit on the same surface. Two things were checked.

**The desktop override at `@media (max-width: 700px)` is unreachable.** `DEFAULT_WINDOW_POLICY` sets
`minWidth: 960`, so a real desktop window never reaches 700px. Forcing `data-shell="desktop"` at 690px
does apply the rule (`padding-right: 4px`), which confirms it is live CSS rather than a typo — it simply
cannot be reached. Dead CSS is not a defect, but the styling it implies is untested, and that is worth
knowing if the minimum is ever lowered.

**The gutter is never occupied.** Measured at every width a window can take (960, 1024, 1100, 1249,
1440, 1920), sampling the gutter rectangle with `elementFromPoint` and scrolling the longest page hard:

    960px:  reserve=148px, gutter at x=822..950   -> title bar
    1249px: reserve=148px, gutter at x=1111..1239 -> title bar
    1920px: reserve=148px, gutter at x=1782..1910 -> title bar
    after scrolling to 99999 -> still the title bar

The **first version of this test could not fail**, and finding that out is the useful part. It asserted
that no control *inside* `.titlebar` reached the gutter — but the gutter is `padding-right` on that very
element, so its content box shrinks and nothing inside can get there by construction. Setting the reserve
to 0 left the test green. It was rewritten to sample `elementFromPoint`, which is the question that
matters: what is actually painted where the OS buttons will be. Proved by setting the reserve to 0 again
— the gutter then reports `none` at every width, and the test fails naming the pixels:

    960px: x=970 in the gutter is occupied by none, not the title bar
    1249px: x=1259 in the gutter is occupied by none, not the title bar

Restored afterwards; browser suite 49 -> 51.

#### Is the tray icon wrong, or is the artwork pale?

The tray icon reads as a pale smudge in the notification area, and the original request was for every icon
location to use the user's own `C:\Users\han\picture\Selbstlauf.png`. Three candidate causes were checked,
and the answer is the third.

**Not the packaging.** The packaged `.ico` carries a proper 7-entry ladder (16, 24, 32, 48, 64, 128, 256),
each stored as a PNG inside the container. Extracting the purpose-drawn 16x16 and comparing it with a
downscale of the 256 gives **56% vs 55% near-white and 0% dark ink for both** — equivalent, so which entry
is used makes no visible difference.

**Not the resampling.** Electron loads only the 256px entry (`getScaleFactors()` returns `[1]`), so Windows
scales one image to whatever the DPI needs instead of being handed the art drawn for that size. Measured:
resampling differs from the purpose-drawn art by a **mean of 0.85/255** at 16, 24, 32 and 48px, worst case
8/255 — imperceptible. Adding multiple representations is possible and would change nothing, so it was not
done.

**It is the artwork.** The supplied `Selbstlauf.png` is 1254x1254 and **66% near-white**; the packaged icon
is 64%, and at tray size both are **55%**. The packaged icon is a faithful derivation of the user's own
image.

So there is nothing to fix: the tray icon's lightness is a property of the artwork chosen, not of the build.
Changing it would mean altering that image, which is the user's to decide — noted as something they may want
to consider, not as a defect.

Against real taskbar colours, for the record: mean contrast **10.82:1** on a dark taskbar (100% of pixels
distinguishable), **2.99:1** on an accented one, **1.41:1** on a light one (52% distinguishable). A plain
white glyph on that same light taskbar is **1.11:1**, so a pale icon on a light taskbar is a general
limitation rather than something specific to this one.

#### The service can already carry typed text; the UI cannot reach it

The original request had two halves — show each process's window, and let it be operated. The first was
built. For the second, injection through the mouse/keyboard was measured and rejected (a `WM_CHAR` reaches
a *foreground* window and does nothing to a background one, so it could not deliver a continuation to the
session the user is not looking at). What was not checked until now is whether the app's own validated
transports could carry it instead.

**They can, and the endpoint already exists.** `POST /api/sessions/:id/inject` reads the prompt from the
request body:

    const prompt = parsePrompt((body as Record<string, unknown>).prompt, session, config);
    const result = await this.sessions.inject(sessionId, prompt, false);

`parsePrompt` accepts any single line up to 4096 characters, falls back to the configured prompt when none
is supplied, and refuses an empty, multi-line or oversized one. The capability is implemented, tested
(`http-server.test.ts` asserts a custom `继续-now` reaches the controller) and **unreachable from the UI**:
the web client's `inject(id)` sends no body at all, so the interface can only ever use the configured
prompt. That is a genuine gap between what the service offers and what a person can do, and it is what
"operate the input bar" would need — no keystroke synthesis involved.

Not built in this round, because turning it into a text field that writes into live sessions is a
capability change with a real blast radius and the user should choose it rather than discover it.

**A near-miss worth recording.** The first probe sent injection requests *without* an `Origin` header and
was refused with `loopback origin required` — the deliberate CSRF guard on mutating requests. At the time
`dryRun` was **false** on the running service, so had that guard not been there, the probe would have
written test text into the user's live sessions. The guard is what prevented it, and the probe was rewritten
to target only a non-existent session id so every path returns before any write.

Rules that had no coverage are now tested — empty, whitespace-only, multi-line, carriage-return, non-string
and 4097 characters are each refused, and exactly 4096 is accepted. Proved by weakening the empty-prompt
check: the suite fails with `empty should be refused`, and passes once restored. CLI suite 252 -> 253.

#### Writing a line into a session — the second half of the original request

The request had two halves: show each process's window, and let it be operated. The first was built. The
second had been answered with "keystroke injection does not work", which was true of *keystrokes* and wrong
about the capability: the app's own validated transport already carries arbitrary text.

`POST /api/sessions/:id/inject` reads the prompt from the request body, and `parsePrompt` accepts any single
line up to 4096 characters. The web client never sent a body, so the UI could only use the configured
prompt — the capability was implemented, tested, and unreachable. That gap is now closed with a field on the
process detail page, which also makes the framing honest: **the app already writes text into sessions**
(立即续写 does exactly that), so this is not a new capability class, it is letting the person choose the
words.

The transport is reused, so nothing new can be written that the existing path could not already write, and
the rules are mirrored in the UI so a refusal is explained rather than arriving as an HTTP 400 nobody can
interpret: empty, whitespace-only and over-length drafts are refused with reasons, a non-writable session
disables the field and says why, and a failed send **keeps the draft** and reports the cause.

**The defect this uncovered.** The first version validated a pasted newline the way the service does. A probe
showed the rule could never fire, and why:

    field type: text
    after setting 'a\nb', the field holds: "ab"
    after a multi-line paste, the field holds: "line oneline twoline three"

`<input type="text">` applies the HTML value-sanitization algorithm, so line breaks are **deleted before any
handler sees them** — the words were being welded together and no validation could object, because no
newline ever arrived. Rejecting newlines was therefore dead code guarding a state that cannot occur, while
the real damage went unnoticed. Fixed with an `onPaste` handler, which sees the clipboard text with its
breaks intact and converts them to spaces:

    in a real browser, pasting three lines now holds: "line one line two line three"

Proved by removing the handler: the test fails with `expected '' to be 'line one line two line three'`, and
passes once restored.

Suites: web 113 -> 127, browser 51 -> 53.

#### The composer is audited as its own subtree, not merely as part of a page

The composer was added after the accessibility audits were written, so it was checked rather than assumed.
The page-level audit over 进程详情 does include it — but a passing page audit proves nothing about a specific
component unless axe actually examined it, which is exactly how the bottom-bar popup went unaudited for a
cycle.

So axe was run against the composer element directly, and the evidence recorded is a **non-zero pass count**
rather than the absence of violations:

    composer present=1 visible=true
    fieldLabel:        "要发送到该会话的文字"
    fieldDescribedBy:  "prompt-composer-hint"  (resolves: true)
    buttonLabel:       "发送到 PID 336756"
    violations: []   passes: 12   incomplete: []

Twelve rules were evaluated inside the subtree, which is what shows it was inspected rather than skipped.
That is now a permanent test: it asserts the field's accessible name, that its `aria-describedby` resolves,
that the send button names its target PID, and that the pass count is above zero.

Proved by removing the field's `aria-describedby`: the test fails with `the hint is not connected to the
field`, and passes once restored. Browser suite 53 -> 54.

**No release came from this round.** It changes only tests, so a new installer would be functionally identical
to the installed 0.9.0 — the same reasoning applied to the breakpoint sweep, and the same reasoning that
0.8.7 and 0.8.8 should have followed and did not.

#### The request the composer sends, and a harness that cannot show it

The composer had been verified up to the send and no further, because a real send writes into a live session.
That left the most consequential part unchecked: whether pressing Send produces the right request. It now is,
at two levels.

**At the client** (`inject-request.test.ts`), with `fetch` stubbed so nothing leaves the process:

    POST /api/sessions/codex%3A17448/inject
    content-type: application/json
    body: {"prompt":"继续，并按上面的计划做完"}

The id is URL-encoded because a session id contains a colon, and the no-prompt call must send **no body at
all** — a body there would silently stop the one-click action from using the configured continuation prompt.
Both are pinned, and both fail when the client is reverted to its previous bodyless form.

**In the packaged app**, with the request observed and **aborted before delivery**, so no session could be
written to:

    request: POST http://127.0.0.1:48920/api/sessions/codex%3A17448/inject
      origin: http://127.0.0.1:48920
    URL names the panel's PID:         true
    body carries the typed line:       true
    Origin present (service needs it): true
    after abort -> draft kept: "继续，并按上面的计划做完" | failure reported: "发送失败：Failed to fetch"

The `Origin` is worth naming: the service **refuses a mutating request without a loopback Origin** — measured
earlier when a probe of mine got `loopback origin required`. Had the client omitted it, the composer would
have failed with a 403 in production while every unit test passed.

**A test that could not work, found by trying it.** The first version of the request check was written in the
browser suite and reported `no request was made`. The cause was the harness, not the composer: that suite runs
with `VITE_STATIC_DEMO=true`, where `static-demo.ts` defines `inject: async () => undefined`, so the app makes
no API call at all. A request-shape test in that suite could only ever be silent, which is why the assertions
now live at the client and the packaged app instead. The demo stub's no-op is recorded here so the next person
does not read that suite's silence as a passing check.

Web suite 127 -> 131. **No release**: tests only.

#### A dry run was reported as a delivery

Continuing the same feature, one state had not been considered: **Dry Run**. With it enabled the service
answers

    200 { ok: true, dryRun: true, prompt, sessionId }

and writes nothing — it records a `skip` event in its audit. The composer announced **已发送：…** for that,
telling the user their line had reached the session when it had not. It is the same shape of defect as the
earlier ones: a state with more than one meaning reported as a single one.

Fixed by carrying the outcome rather than discarding it. `inject` now returns `InjectionOutcome`
(`{ dryRun, prompt }`), `mutateSession` passes it back, and the composer says which of the two happened:

    dryRun true  -> 未真正写入（Dry Run）："…" 只记录了跳过，没有发送到会话。
    dryRun false -> 已发送："…"

The demo API used by the browser suite was also wrong in the same direction: it returned `undefined` for
`inject`, so a build with no service behind it claimed to have written. It now reports `{ dryRun: true }`,
which is the honest answer for a demo and matches what the real service returns in Dry Run.

Three tests pin it — a dry run is not announced as sent, a real write is, and a stale dry-run notice is
cleared when the next send really writes. Proved by neutralising the branch: both dry-run tests fail with
`Unable to find an element with the text: /未真正写入/u`, and pass once restored. Web suite 131 -> 134.

**Verified on the published 0.9.1 with Dry Run genuinely enabled** — the one case where sending is safe,
because nothing is written:

    dryRun before: false | dryRun now: true
    panel says: 未真正写入（Dry Run）：dry-run verification line 只记录了跳过，没有发送到会话。
      says 未真正写入 (correct):      true
      claims 已发送 (the old defect): false

#### My verification left the watchdog inert, and its own restore failed

A mistake worth recording plainly. To test that case I enabled Dry Run on the running service, and the script's
restore step then **did not take** — it hung and exited before restoring, and a first manual attempt also
returned without changing anything. Dry Run was left **on**, which means the watchdog would have been running
but writing nothing: enabled, polling every 2s, and never continuing a session.

Confirmed and corrected afterwards:

    running: True | dryRun: False | config dryRun: False | enabled: True | poll: 2000ms

So the state is healthy. But the lesson is that a verification which *changes the user's configuration* must
not rely on a best-effort restore inside the same script that might die — it has to be checked after the fact,
which is what caught it here. The measurement was strong (the full round trip, field to service to audit), but
it briefly left the user's own tool disabled, and that is not an acceptable cost for a test.

#### Two defects the user found by looking at the app

Both were reported directly, and both were real. Neither was visible from the tests, because the tests use
fixtures that happen to avoid the conditions.

**The process list was full of rows labelled 运行位置: Selbstlauf.** Measured against the live service: the
sidebar rendered **25 rows for 5 live processes**, of which **19 were grouped under "Selbstlauf"** — this
application's own window, used as the host of sessions it had spawned. Two causes compounded:

1. `selbstlauf.exe` was in the recognised-host table. The app's window is an ancestor of every CLI the
   watchdog continues, so it was picked as the host — and "inside Selbstlauf" is never where a session
   actually runs.
2. Those 19 rows were **already dead**. The service keeps a session with `alive: false` after its process
   exits, because its audit trail refers to it; the UI listed them anyway, so the sidebar filled with
   processes that had been gone for hours and every action on one could only fail.

Fixed by excluding this application from host resolution entirely (an exclusion set rather than a low rank,
because any rank can still win) and by deriving a `liveSessions` list that the process views, the metric and
the detail lookup all read. The events page remains where audit history belongs.

Verified against the live service: **5 alive, 20 dead**, and the dead ones' pids no longer exist.

**The DeepSeek Harness session had no window although its window was open.** The harness window is found by
title, and the configured marker was `DSH`. The real window is titled

    Reference attachments for goal objective — DeepSeek Harness

which contains **no `DSH`**. Measured both ways: the new marker matches that window (`handle 66830`), the old
one matched **nothing**. So the session was reported as having no window at all — which also cost it the
window preview and 切换到该窗口, both of which had been built and verified against a *different* title.

Fixed by listing both the full product name and the abbreviation. The hint now carries `titleMarkers` rather
than a single `titleMarker`, and all are matched.

#### A test that passed for the wrong reason

The first version of the Selbstlauf exclusion test passed even after the exclusion was neutralised — because
the table entry had also been removed, so nothing could produce the label by either path. A test that passes
for a reason other than the one it names is not a test of that reason. Restoring the table entry and
neutralising *only* the exclusion made it fail (`Expected values to be strictly equal`), which is when it
became worth keeping.

Both fixes are pinned: CLI 255 -> 256, web 134 -> 135. Each was proved by reverting it — the exclusion test
fails with the label reappearing, and the live filter fails with `expected 6 rows to have a length of 4`.

#### The fix for the harness window broke the packaged app completely

Worth recording in full, because it is the most damaging mistake of this session. Passing two markers to the
PowerShell provider as **repeated** `-WindowTitleMarker` arguments is invalid: PowerShell raises
`ParameterAlreadyBound`, the provider call throws, and the app **discovers nothing at all**:

    Windows process provider failed: ... -WindowTitleMarker DeepSeek Harness -WindowTitleMarker DSH
    windows-processes.ps1 : 无法绑定参数，因为参数"WindowTitleMarker"指定了多次

The release check caught it — `the installed app never discovered probe PID 8472; it listed 0 session(s)` —
which is exactly what that check exists for. A `[string[]]` parameter must be bound **once** with
comma-separated values, which is what it now does; verified by calling the provider directly (16 records, 18
windows) before rebuilding.

The lesson: the first version of the marker fix was validated only through the *pure* classification
function and its tests, which never exercise the argument marshalling between Node and PowerShell. The
integration check is what covered that seam, and it is the reason this was caught before shipping.

#### Three layout changes asked for directly

1. **The bottom status bar is flush in the sidebar's bottom corners.** The sidebar's padding is cancelled by
   negative margins, so the bar reaches the edges: measured side and bottom gaps of **0/1/0px**, down from
   12/13/14px, and its height **51px → 42px**.
2. **The popup is flush against that bar.** It sat `8px` above it as a floating card; it now meets it exactly,
   square at the bottom and rounded only at its free top edge.
3. **The page heading row scrolls away.** It was `sticky` under the window title bar, which kept an empty
   heading strip across the top of every scrolled page. The title bar is the row that must stay reachable, and
   it still is: measured, the heading moves to `-250` while the title bar stays at `0`.

One existing test asserted the old behaviour — "the page title row sticks under it rather than scrolling off
too" — and was inverted deliberately rather than deleted, so the change is pinned.

Browser suite 54 -> 57.

#### A corrupted stylesheet, from my own tooling

`apps/web/src/styles/index.css` stopped being valid UTF-8: a comment line I had appended through a PowerShell
`Add-Content` had been written in the console's code page, leaving bytes that no UTF-8 decoder accepts. It was
found because the file could not be read, located by validating the bytes, and repaired by rewriting the one
affected comment. Nothing else in the file was touched.

#### The harness window took three attempts, and only the third was right

The same seam — how Node marshals arguments into PowerShell — produced two opposite failures, and the second
one **passed CI while still being wrong**. Worth recording in full.

`apps/cli/src/process/windows-processes.ps1` declares its window-title markers, and the provider passes them.
Under PowerShell's `-File` mode, arguments arrive as **literal strings**, not PowerShell expressions, so an
array parameter cannot be bound from a command line at all. All three forms were measured:

| Form | Result |
| --- | --- |
| `-WindowTitleMarker a -WindowTitleMarker b` | `parameter is specified more than once` → the call throws |
| `-WindowTitleMarker "a,b"` into `[string[]]` | binds the **single string** `a,b` → matches nothing |
| `-WindowTitleMarker "a,b"` into `[string]`, split in the script | two markers ✅ |

1. **0.9.2 shipped the first form.** The provider call threw, so the app **discovered nothing at all** — and
   the installer check caught it: `the installed app never discovered probe PID 8472; it listed 0 session(s)`.
   That check is the only reason this did not ship silently.
2. **0.9.4 shipped the second form.** Discovery worked again, so **CI passed** — but the marker matched no
   window, and the harness session still reported no window. The installer check could not catch this, because
   it only asserts that a process is *discovered*.
3. **0.9.5 takes a single `[string]` and splits it in the script**, which is the only form that works.

The evidence for the third, against the real window: the harness session's record previously had **zero**
windows attached, and now carries

    windowHandle: 66830
    windowTitle:  Reference attachments for goal objective — DeepSeek Harness

and the session is hosted by **Microsoft Edge**, the browser actually showing it, rather than the bare fallback
label. The window panel now shows both **刷新** and **切换到该窗口**; it reports 无法抓取该窗口的画面 because the
window genuinely *is* minimised (measured `Iconic = True`), which is the accurate answer.

A regression test now covers this seam in `discovery.test.ts` — it asserts the parameter appears **exactly
once** and carries `DeepSeek Harness,DSH` comma-joined. Proved by restoring the repeated-parameter form: the
suite fails with `the parameter must appear exactly once, or PowerShell rejects it`. CLI suite 256 -> 258.

The general lesson: three failures in this area all lived in the **marshalling between Node and PowerShell**,
and none was reachable from the pure classification tests, which call the classifier directly and never spawn
the script. The integration check covered one direction of the mistake; the other direction needed a test at
the boundary itself, which is what was missing.

#### All four reported problems, verified on the installed 0.9.5

    === the harness session ===
      host:         Microsoft Edge (browser)
      windowHandle: 66830
      windowTitle:  Reference attachments for goal objective — DeepSeek Harness

    === the process list as rendered ===
      rows: 5 | groups: ["置顶","Tabby","Codex 应用","Microsoft Edge"]
      no Selbstlauf group: true

    === the reported problems ===
      1. Selbstlauf as a session host:  gone
      2. live-only listing:             5 alive, 0 dead kept for audit
      3. harness window found:          true

The bottom bar measures 0/1/0px gaps with height 42px, the popup meets it at 0px, and the page heading scrolls
from 36 to −264 while the window title bar stays at 0.

#### Four of the five reported problems, fixed and verified

Reported directly, in one message: the Codex app's interface could not be seen; 命令提示符 was monitoring
itself; Tabby was monitored twice; a minimized window could not be previewed; and WSL processes were not
monitored at all. Four are fixed.

**1. The watchdog was listing its own transport as a session.**

It runs a `codex app-server` child to continue Codex sessions. That child carries a codex signature on its
command line, so discovery found it and listed the watchdog's own transport — labelled 命令提示符 after the
`cmd.exe` wrapping it. Measured ancestry:

    Selbstlauf.exe -> cmd.exe (call "codex" "app-server" --listen stdio://) -> node.exe codex.js app-server

The watchdog and everything descending from it are now excluded from discovery. Descendants, not just the
process, because the signature is on the child while the app itself has none.

**2. One Tabby conversation was listed as two processes.**

A codex process started underneath a codex session but separated by a process carrying no signature became its
own root, and therefore its own row. Measured: the CLI `node.exe … codex.js` (30780) and the
`codex.exe app-server` it spawned (17448), reached through `node_repl.exe` and a `cua-repl` node, **both
resolved to the same conversation id `01a0bd1e…`**. Session roots are now folded into a same-tool strict
ancestor, so one conversation is one row; two genuinely independent sessions still stay apart, which a test
pins.

Verified on the live machine: `groups: 4`, watchdog transport absent, `codex pid=30780 children=[17448,21856,26480]`.

**3. The Codex app's window could not be seen, and a minimized window could not be previewed.**

One cause behind both: **a minimized window is not enumerated by `desktopCapturer` at all**, and the ChatGPT
window (handle 3932904) was minimized. Measured both ways:

    desktopCapturer while minimized: the window is absent from getSources entirely
    PrintWindow at its restore rect: flat image (2 distinct colours) — a minimized window has no surface
    restore briefly, then capture:    51% non-dominant pixels, 1547 colours, 75KB PNG

So a minimized window is now shown for a moment, captured, and minimized again. Both directions use the
**non-activating** variants (`SW_SHOWNOACTIVATE` / `SW_SHOWMINNOACTIVE`), so a preview never takes focus:
measured, the foreground window is identical before and after. The caption says the window was shown briefly
so a blink is explained rather than mysterious.

**A defect this uncovered, in the first version of the fix.** The undo inferred its action from the window and
had it exactly backwards — it minimized any window that was *not* minimized. In the preview flow that means a
window the user has open, whose first capture fails and so triggers the restore path, would be **minimized on
them**. The caller's own record is now the only thing consulted; with `false` nothing runs at all. Verified on
a real window:

    visible + WasMinimized=false -> changed:false, still visible (untouched)
    visible + WasMinimized=true  -> changed:true,  now minimized (the undo)

Passing that flag hit the **same PowerShell `-File` binding rule as the window-title markers**: a `[bool]`
parameter cannot be bound from a command line at all — `-Flag $true`, `-Flag 1` and `-Flag true` are each
rejected with "Boolean parameters accept only Boolean values and numbers". It is a `[string]` compared in the
script, which is the form that works.

**Verified on a real packaged build** (two windows minimized, one visible):

    rows: 4 | groups: ["Tabby","Codex 应用","Microsoft Edge"]
    no Selbstlauf host: true | no 命令提示符 host: true
    conversations listed more than once: none
    every preview produced an image (100KB–199KB)
    windows all back in their original minimized state: true
    focus unchanged by previewing: true

**5. WSL — the transport conclusion was wrong, and the right answer is much simpler.**

My first conclusion was that WSL continuation needs a helper running inside the distribution. That was based on
the pty measurements below, which are real, but it generalised from them to the wrong answer. Codex exposes its
own **JSON-RPC transport**, exactly the one the watchdog already speaks to continue Windows Codex sessions, and
`wsl.exe` pipes stdio across the boundary perfectly well:

    codex app-server inside WSL, driven through wsl.exe stdio:
      ok=true
      id 1 (initialize)  -> keys: userAgent, codexHome, platformFamily, platformOs
      id 2 (thread/list) -> 3 thread(s)
        thread 01a0be49-... cwd=/home/han/project/copilot-segmentation status={"type":"notLoaded"}
        thread 01a0bdc6-... cwd=/home/han/project/copilot-segmentation
        thread 01a0bdc4-... cwd=/home/han/project

So **WSL continuation reuses the existing transport**; no helper inside the distribution is needed. The one
obstacle was mundane: `codex` is a script whose shebang needs `node`, and `wsl.exe -e` supplies no PATH —
resolved by invoking an explicit node binary, which is also how the native session on this machine runs.

**Why the pty route was a dead end (measured on a pty this test owned, never the user's live session):**

    every /dev/pts/N      owner=han  mode=crw--w----  WRITABLE
    write to the slave    -> succeeded, and did NOT arrive (the process received nothing)
    write to the master   -> succeeded, and did NOT arrive either

Writing to a pty *slave* succeeds and feeds the terminal's **output** stream, not the process's input; only the
**master** carries input, and the `/proc/<holder>/fd/<master>` route was refused delivery too. That is a true
statement about terminals — and it was the wrong place to look, because the CLI already has a transport that
does not involve a terminal at all. The lesson is the same one this session has produced repeatedly: a
measurement can be correct and still mislead, if it answers a question that did not need answering that way.

What remains genuinely absent for a WSL session, measured: a Linux pid is not a Windows pid, so there is **no
`host.windowHandle`** — no window to preview, and nothing to reveal. Those sessions will be listed without a
window, and the UI already words that state honestly.

Suites: CLI 258 -> 262, desktop 111 -> 129, web 135 -> 137, browser 57.

#### WSL support, and the wrong turn that delayed it

The fifth reported problem — "wsl里面的没监控到" — is now implemented. Getting there required correcting a
conclusion I had already committed.

**First conclusion, and why it was wrong.** I measured that a WSL session's terminal cannot be written into from
outside, and concluded that continuing one needs a helper inside the distribution. The measurement was correct;
the inference was not. Codex exposes its own JSON-RPC transport — the same one the watchdog already speaks — and
`wsl.exe` pipes stdio across the boundary:

    codex app-server inside WSL, driven through wsl.exe stdio:
      ok=true
      id 1 (initialize)  -> keys: userAgent, codexHome, platformFamily, platformOs
      id 2 (thread/list) -> 3 thread(s)

The only obstacle was mundane: `codex` is a script whose shebang needs `node`, and `wsl.exe -e` supplies no
PATH — resolved by passing an explicit node, which is how the native session runs anyway.

**What was built.** A distribution needs three things the Windows path does not provide, and each was measured
before it was written:

1. **Discovery.** WSL processes live in a Linux pid namespace and are absent from the Windows process table
   entirely. A probe piped over **stdin** (`sh -s`) reads them — measured 57 records in 216ms. The probe is piped
   rather than passed as an argument because that is where every exploratory probe broke: quotes have to survive
   PowerShell, then `cmd`, then the Linux shell.
2. **Identity.** A Linux pid is unrelated to a Windows pid of the same number, so session ids carry the
   distribution: `wsl:Ubuntu-22.04:codex:98051`. Without it two different processes could share a key.
3. **State.** This is the piece that took the longest, and the answer was not what I expected.

**SQLite cannot read a WSL database where it lives.** Measured three ways:

    same bytes on local NTFS             -> opens, 3 threads
    live database over \\wsl.localhost   -> database is locked
    a copy placed back INSIDE the distro -> database is locked (identical)

The distribution's root is ext4, but Windows reaches it over **9P**, which does not provide the file locking
SQLite requires. It is a filesystem limit, not a URI problem — `pathToFileURL` also produces an authority SQLite
rejects, which I fixed first and which turned out not to be the cause. So the state is **copied to local disk**
before reading, including the `-wal` and `-shm` sidecars, because a database in WAL mode is not consistent
without them.

**Verified on the installed build**, with WSL enabled:

    sessions: 5 alive
      id=wsl:Ubuntu-22.04:codex:98051
          tool=codex host= conv=01a0be49-a23f-7ed2-8762-5697f90ebeb2 transport=codex-app-server

The conversation resolved, the transport is the app-server, and the host is empty — correct, because a Linux
process has no Win32 window to preview or reveal.

WSL is **opt-in**: `wslDistribution` is empty by default, because looking inside a distribution costs a
subprocess per poll and only helps someone who runs a CLI there. It is settable in 常规, and a stopped or
missing distribution is a stated reason rather than an error, because WSL must never stop the Windows sessions
from being watched.

**Two test defects found while doing this**, both worth recording because both would have misled the next person:

- The first WSL host test **passed with the rule removed**, because its fixture had no ancestor that could
  classify as a host — so `classifySessionHost` returned null either way and the rule was never exercised. It now
  carries a Tabby ancestor and a Tabby window on purpose, and fails with
  `a WSL session must not borrow a Windows window as its host` when the rule is removed.
- `Test-WindowsScripts.ps1` was **flaky, about one run in six**: its temp-directory cleanup raced a transient
  Windows handle and failed with `Cannot remove item ... because it is being used by another process`, which was
  then reported as whichever test happened to be running. The cleanup now retries. Six consecutive runs pass.

Suites: CLI 262 -> 280, web 137 -> 138.

### The four earlier fixes were installed without a release

Installing requires a build. Rather than cut a version, a local package was built and installed over 0.9.5, so
the installed app and the published release now differ while sharing a version number:

    installed 0.9.5 (local build)   one Tabby row, no 命令提示符, minimized previews | fix present
    published 0.9.5                 two Tabby rows for one conversation              | fix absent

That is a deliberate trade the user chose, and the cost is worth naming: the version number no longer identifies
which build is installed.

#### Grouping by application, the scrollbar, and what input simulation actually costs

Three requests, two of them settled and one deliberately not built.

**1. Scrollbars.** Measured on the installed app: of four scrolling containers, **only one** was themed, and
`.workspace` — the main column, which is scrolled constantly — rendered a **15px browser-default bar** with
`scrollbar-color: auto`. A default bar beside a themed one reads as a rendering fault. All five regions now
share one definition (10px layout, ~4px thumb, themed track and hover).

**A regression the fix introduced, caught by the layout suite.** The first version added
`scrollbar-gutter: stable`, which reserves the scrollbar's width permanently — **11px in Chromium** — and that
pushed the sidebar's flush footer off its right edge. The pinned check failed with
`the bar is inset from the right edge` (11 where at most 1 was allowed). The gutter is removed and the reason
recorded in the stylesheet. Worth keeping as an example of one pinned rule catching a change made for a
different reason.

**2. Grouping follows the application, not the operating system.** A Codex session in WSL now sits under Tabby.
That needed a measurable link between a Linux process and a Windows terminal, because the distribution side
offers none: its ancestry dead-ends at `Relay → SessionLeader → systemd`, and no environment variable names a
terminal. The link is the **interop socket** WSL sets in everything an invocation launches — one per `wsl.exe`,
created when it starts:

    socket 66223_interop created  2026-09-20 15:44:09   (the codex session, on pts/8)
    wsl.exe 30044 started         2026-09-20 15:44:08   (wsl.exe < cmd.exe < Tabby.exe)

One second apart, under Tabby. The session now reports `host=Tabby` with **no window handle** — the window
belongs to the terminal, and pointing a preview at it would show the wrong thing under this row's name — so
the sidebar groups it with Tabby while the detail page still says truthfully that it has no window of its own.
The distribution is kept only as a fallback for a session whose launcher cannot be established:

    sidebar groups: ["Tabby","Codex 应用","Microsoft Edge"]   (no WSL group)
    WSL row host  : Tabby | WSL · Ubuntu-22.04

**Two defects found while building this**, both in my own code and both caught by measurement rather than by
tests:

- `Get-Date -UFormat %s` returns **local time treated as UTC**. Every launcher start time was 8 hours out, so
  nothing paired at all. Replaced with `[DateTimeOffset]::new(...).ToUnixTimeSeconds()`.
- The pairing treated **any equal delta as ambiguous**. Launching WSL from Tabby starts `30044` and its child
  `12620` in the same second, so both matched the socket identically and the guard rejected a pairing that was
  in fact unambiguous. The decision is now made on the *terminal*, not the process: several `wsl.exe` in one
  chain share an answer, and only a genuine disagreement between terminals is unresolved.

**3. Input simulation was NOT built, and the measurements are why.**

The request was 实现操控窗口内页面 完全地模拟. Four routes were measured, all against windows **this session
created**, never the user's applications:

| Route | Result |
| --- | --- |
| `PostMessage(WM_CHAR)` into a background window | **delivers nothing** (10 characters posted, empty control) |
| `PrintWindow` | unrelated to input; unclear |
| `SendInput` | **delivers**, but only to the **foreground** window |
| `SetForegroundWindow` from a background process | returns **False** under Windows' foreground lock |
| `AttachThreadInput` + `SetFocus` | **works, and visibly steals focus** — measured, the foreground window changed |
| UI Automation `ValuePattern`/`InvokePattern` | the window is reachable, but its **child controls are absent from the automation tree while it is minimized** |

So the only route that actually delivers input has to take the foreground first, and the one route that needs no
focus stops working in exactly the state this feature exists for — a session the user is not looking at. Since
this app's whole purpose is to continue background sessions, a feature that yanks focus away would cost more
than it gives. **Nothing was built.** That is a judgement worth the user's decision rather than mine, so it is
reported rather than implemented.

Suites: CLI 280 -> 291, browser 57 -> 59.

#### Driving a window's contents, and the cost that had to be accepted

The request was 实现操控窗口内页面 完全地模拟. Four routes were measured, all against windows **this session
created** — never a user application, because an earlier probe in this project destroyed unsaved Notepad edits:

| Route | Result |
| --- | --- |
| `PostMessage(WM_CHAR)` into a background window | **delivers nothing** (10 characters posted, control empty) |
| `SendInput` | **delivers**, but only to the **foreground** window |
| `SetForegroundWindow` from a background process | returns **False** under Windows' foreground lock |
| `AttachThreadInput` + `SetFocus` | **works, and visibly steals focus** |
| UI Automation `ValuePattern`/`InvokePattern` | the window is reachable, but its **child controls are absent from the automation tree while it is minimized** |

So the only route that delivers input must take the foreground. That was put to the user rather than decided
unilaterally, and they chose it knowing the cost. What is built therefore states its cost **before** acting:

    发送时会把该窗口切到前台约 1 秒（Windows 不允许后台程序发送键盘输入），随后自动切回原来的窗口。

**A defect found by measuring, not by testing.** The first version sent the whole string in one `SendInput`
batch and reported `typed:20, sentInputs:20` while the control received only **the first five characters** — a
silent partial delivery, which for a prompt box is worse than a failure. A tight per-character loop failed the
same way; only per-character sends **with a pause between them** delivered the full line. The message queue
cannot keep up with input arriving faster than it processes. The helper now paces the keystrokes, and the
reason is recorded where the pause is.

The apparent truncation in the test harness was itself a **reading artefact** the first time: the helper was in
fact delivering, and the test read the control before its message loop had processed the input. Confirmed by
having the target window report its own state from its own message loop:

    after 0.7s the target reports: 'TYPED-BY-HELPER-42'
    delivered completely: True

**The hazard that shaped the design.** A window is typed into by giving it the foreground, so the text goes to
whatever holds the keyboard focus *inside* it. Measured on this machine, two Tabby Codex sessions share window
handle 67008 — so typing there would reach whichever terminal pane happened to be focused, which need not be the
session the person selected. That is a silent wrong-target failure, and nothing in the window's own state reveals
which pane it is. A window hosting more than one monitored session is therefore **refused**, with the reason
stated, and so is a session with no window. Verified on the installed build:

    3 panels refusing typing (2 shared windows, 1 with no window)
    2 panels allowing typing

The renderer still never names a window: it names a session, and the main process resolves it against the
service's own list, exactly as the preview does.

Suites: desktop 129 -> 141, web 141 -> 154. Installed as a local build; no release was cut.

#### Two reported defects: the icons, and a write gate that was stricter than the service

**1. Every session read as unwritable, and the app caused it.**

Reported as "现在各个进程页面都显示会话无法写入 我要能控制对应的输入框". The cause was mine, and it came from an
earlier fix in this same session: the master switch `config.enabled` had been turned off to stop the watchdog
continuing sessions on its own, and the UI's `canInject` required `session.enabled`. So the flag that governs
*automatic* continuation also disabled *manual* writing.

It should not have. Verified against the running service — a session reporting `enabled=false` answered **HTTP
200** to a manual inject, and the audit log records manual injections as their own action:

    session: codex:30780 (enabled=false)
    HTTP 200
    body: {"ok":true,"prompt":"dry-run probe: nothing is written",...}

So the UI was stricter than the service, and its message ("该会话不可写入") was simply false. `canInject` now
requires only a live, unpaused session whose transport can carry text, and the refusal names the actual reason
from the service's own `transportError` rather than a bare disabled control.

No test caught this because the shared fixture sets `session.enabled: true` everywhere. A test now pins the real
configuration, and it fails when the old rule is restored:

    × allows a manual write when the master switch is off, because the service does
      → expected "spy" to be called at least once

**2. Each tool now shows its own icon rather than a generic glyph.**

The art is the publishers' own, from the most faithful source available on this machine:

| Tool | Source | Result |
| --- | --- | --- |
| codex | the running Codex app window's icon, read via `WM_GETICON` | the genuine OpenAI mark, 128×128 |
| dsh | the harness's own `favicon.svg` | the DeepSeek whale, 300×300 |
| claude | `anthropic.com`'s favicon | the Anthropic mark, 256×256 |

The Claude CLI ships **no** icon at all — it is terminal-only, and the desktop app is not installed here — so the
publisher's own site is the honest source. Both vector sources were rasterized through Electron, which is a real
browser and already a dependency; the first attempt drew the whale in a corner because forcing `width`/`height` on
an SVG root does not scale its content, which rendering through an `<img>` fixes.

A missing asset falls back to the previous glyph rather than leaving a broken image, and that fallback is tested by
aborting the requests.

**A test that was wrong about the browser.** The first version waited for *every* `.tool-icon__image` to decode and
timed out. The measurement explains it: the settings page renders four more instances whose container is not
mounted, so their boxes are zero sized and a lazy image inside one is never fetched — `complete` stays false even
though the art is known. Requiring those to complete hangs on correct behaviour, so the assertion now covers only
the images the browser actually laid out: `tool icons rendered: 12, on screen: 7`.

Suites: web 154 -> 156, browser 59 -> 61.

#### One question, two implementations, and a row that contradicted its own page

Continuing the same report, one more defect surfaced and it was structural rather than a single wrong condition:
**"can this session be written to" was answered in two places, by two different rules.**

    the sidebar's dot      checked `transportError` against a blocker list
    the composer's gate    checked `transport`      against a blocker list

Those are different fields, so they could disagree — and they did, on a real session. Measured:

    codex:9232   transport = 'monitor-only'   transportError = 'no-cwd-match'
      dot rule      'no-cwd-match' is not a blocker name  -> 可写入
      composer rule 'monitor-only' is a blocker           -> 只能监控

So a row promised 可写入 while its own detail page refused. Probed across the combinations, **4 of 7 disagreed**,
including both fields being set in the opposite way from what each rule expected.

Fixed by giving the question one owner: `apps/web/src/session/write-eligibility.ts` now holds the rule and the
reason text, and the dot, the composer and the process table all read from it. The master switch is deliberately
absent for the reason established earlier — the service does not consult it for a manual write.

The old dot rule had a test, and that test asserted the wrong field. It is corrected rather than deleted, and a new
test pins the agreement itself, so the two can never silently diverge again:

    × never disagrees with the write rule about the same session
      → the dot says writable while the write rule says blocked for
        {"transport":"monitor-only","transportError":"no-cwd-match"}

Suites: web 156 -> 164.

#### The word "disabled" next to every session

Verifying the write fix on the installed app turned up a third defect, and it plausibly *is* the impression the
user reported. Every session's decision chip displayed the raw English word:

    dsh pid=7984       lastDecision=disabled -> displays: disabled
    codex pid=30780    lastDecision=disabled -> displays: disabled
    codex pid=9232     lastDecision=disabled -> displays: disabled
    codex pid=32256    lastDecision=disabled -> displays: disabled
    codex pid=98051    lastDecision=disabled -> displays: disabled

The cause: `decisionLabel` had a case for ten of the engine's states and a `default` that printed the raw value.
`disabled` — the state reported while the master switch is off, which is how this app is configured — had no case,
so a Chinese interface showed the English word. Read beside a session, **"disabled" means "this session is
disabled"**, which is exactly the wrong conclusion and matches the complaint closely.

Fixed by labelling the engine's complete union. The union is declared, so the list is taken from it rather than
guessed:

    engine decisions (14): awaiting-quiet-period, clock-rollback, cooldown, disabled, enabled, injected,
    injection-pending, max-attempts, new, output-observed, paused, process-exited, resumed, transport-error

`disabled` now reads **自动续写已关闭** — which says what is actually true: a feature is switched off, nothing is
wrong with the session. Four further states had no label either (`injection-pending`, `resumed`, `enabled`,
`clock-rollback`), all now named.

**A test that was weaker than it looked, twice.** The first version rejected a label equal to the identifier; the
second also rejected labels made only of Latin letters. **Both passed while four states were still unlabelled**,
because the fallthrough returns 未知状态, which is neither. Requiring the fallthrough to be distinguishable is what
makes it mean something, and it now fails with the state named:

    × covers every decision the engine can report
      → these decisions have no label of their own and fall through to 未知状态:
        expected [ 'injection-pending' ] to deeply equal []

Suites: web 164 -> 170.

#### Two input boxes that were not duplicates, presented as if they were

Reported from a screenshot: the process detail page showed two rows both headed **INPUT**, each with the same field
and the same button — one titled 写入这一行 and one 把这一行写进窗口. It reads as the same control shown twice.

They are **not** the same mechanism, and measuring that is what shaped the fix:

| Panel | How it writes | Cost | Works for |
| --- | --- | --- | --- |
| 写入这一行 | the session's own transport (codex app-server / harness API) | none | 4 of 5 sessions |
| 把这一行写进窗口 | synthesized keystrokes into the window | **takes the foreground** | 2 of 5 sessions |

So neither is redundant: the composer is strictly better wherever it works, and the window panel is the only way in
for a session the service can watch but not write. **The defect was that they looked identical**, not that both
existed. The second is now a collapsed disclosure — different icon, different wording, and a summary that states the
cost (or the reason it cannot be used) *before* it is opened, so nothing that would change the decision is hidden.
It starts expanded only when nothing else can write.

**A bug the tests caught while making that change.** The body was `hidden` while collapsed, but its CSS set
`display: flex`, and an author rule beats the user-agent stylesheet's `[hidden] { display: none }`. So the "collapsed"
panel would still have shown its field. Found by a test that renders it collapsed and finds the input still present
— a jsdom query cannot see `display: none`, which is exactly why asserting on the DOM rather than on the intent is
worth doing. The field is now not rendered at all while collapsed, which also removes it from what an assistive
technology could reach.

**A test that asserted something impossible.** The first browser test checked that the collapsed summary was present
and could be opened. It failed with `summaries=0`, and the reason is the harness: the browser suite runs with
`VITE_STATIC_DEMO=true`, so there is no desktop bridge and the window-typing panel is not rendered at all. The test
was asserting on something that cannot exist there. It now pins the half that *is* real in that harness — exactly one
input box, and it is the composer — and the disclosure itself was verified in the installed app instead.

Suites: web 170 -> 171, browser 61 -> 63.

### The dark page went pure black, and every derived surface moved with it

The dark theme's page background was `#0d1216`, a blue-grey. It is now `#000000`, and the literals that describe
the same colour before the bundle runs were moved with it:

    apps/web/src/App.tsx           DEFAULT_PALETTES.dark.background   #0d1216 -> #000000
    apps/web/src/styles/index.css  :root background, --bg            #0d1216 -> #000000
    apps/web/index.html            <meta name="theme-color">         #10151a -> #000000
    apps/desktop/src/navigation.ts window backgroundColor            #0b1120 -> #000000
    apps/desktop/src/navigation.ts TITLE_BAR_OVERLAY.color           #1a1e22 -> #0d0d0d

Nothing else needed to change, because every surface in this app is *derived* rather than written down: the
palette effect mixes each one from the background toward white,

    lift(w) = mix(background, #ffffff, w + contrast / 1400)

so the same slider that produced a run of blue-greys now produces a run of neutral greys. Measured with the
built-in dark palette (contrast 68), by evaluating that mix independently of the app:

    --panel         #0f0f0f      --panel-soft   #0d0d0d
    --panel-raised  #121212      --line         #3d3e3f

**The comments' contrast claims were checked, not copied.** The round that changed the colours had written
specific ratios into the stylesheet and the stylesheet's tests; all five reproduce exactly against the new
surfaces:

    --faint on a selected row (#121212)     5.43:1      --muted on a selected row   7.28:1
    --faint on the sidebar   (#0d0d0d)      5.64:1      --muted on the sidebar      7.56:1
    --accent on the sidebar                10.37:1
    the browser default ring (rgb(16,16,16)) on the sidebar: 1.02:1

The last line is the one that justifies the focus ring: the user-agent's ring is now 1.02:1 against the sidebar,
i.e. indistinguishable, which is why `:focus-visible` draws `--accent` (10.37:1) instead.

**A colour is only correct if all three of its owners agree**, and that is what the tests pin. `App.test.tsx`
now reads the two tokens the desktop shell mirrors after the palette is applied —

    --bg          #000000
    --panel-soft  #0d0d0d

— and `apps/desktop/test/navigation.test.ts` pins the static `TITLE_BAR_OVERLAY.color` to the same `#0d0d0d`, so
the OS window buttons cannot drift back onto a differently coloured strip than the painted title bar.

Suites on this tree: web 171, browser 63, desktop 141 — all passing.

### The light theme painted its rail, its cards and its selection the same colour

Reading the resolved tokens in a browser — not the stylesheet — showed the light theme had one
surface colour instead of three:

    light  page rgb(238, 242, 241)   --panel-soft #eff3f2   --panel #eff3f2   --panel-raised #eff3f2

All three derive from `weight + contrast/1400` of the distance from the background to white. That
scales with the page: on the dark theme's `#000000` the weights land 13, 15 and 18 levels apart,
which is why the dark theme looks right. On `#eef2f1` there are only **13 levels** of headroom
below white, and `0.004 + 68/1400 = 0.0526` of that is **one level**, so all three weights round
into the same one.

Measured in the browser on the tree before the fix, with a new spec that reads the paint rather
than the intent:

    light  rail (rgb(239,243,242))            step from page  1     (1.007:1 — invisible)
    light  selected row (rgb(239,243,242))    step from rail  0     (the same paint, exactly)

So on the light theme a session row's hover and selection changed **nothing but the inset ring**:
the fill the stylesheet uses to express both was the colour it was drawn on. The dark theme's
equivalents were 13 and 5 levels.

**The fix keeps one rule per kind of surface rather than one rule for all of them.** A raised
surface still lifts toward white (a card is lighter than the page in both schemes). A *recessed*
surface — the rail, its search field, the input and chip backgrounds, the title bar — now steps
toward the text colour instead, which is the direction that has room on both pages:

    --panel-soft  dark  #0d0d0d  (unchanged: a dark page's text colour is near-white, so the
                                 two directions already agreed there)
    --panel-soft  light #e3e7e7  (was #eff3f2, the page's own colour)

**The light stylesheet had already described this surface.** Its comment solved `--faint` and
`--muted` against a "darkest surface" it named `#e2e8e6`, which no longer existed as a token —
the recessed rail now resolves to `#e3e7e7`, within a level of the value that reasoning assumed.
The ratios were recomputed for it:

    --faint #5f686a   5.11:1 on a card, 4.59:1 on the rail   (AA, and no longer inverted)
    --muted #4f575b   6.59:1 on a card, 5.92:1 on the rail
    --accent #a56a08  3.61:1 on the rail                     (the focus ring's own 3:1 bar)

The light block's literals were moved to the values the effect now produces (`--panel` and
`--panel-raised` `#eff3f2`, `--panel-soft` `#e3e7e7`, `--line` `#b7bdbd`, `--accent-strong`
`#774c06`), because a literal that disagrees with the paint is what the next section is about.

**The test was run against the old code to prove it means something.** With the derivation
reverted it fails, naming the colour it found:

    × the light theme paints the page, its rail and a selected row apart
      → the light rail (rgb(239, 243, 242)) is not a visible step from the page (rgb(238, 242, 241))

and with the fix in place it reports a step of 11 from the page and 12 from the rail. The bar is
4 levels, below the 5 the dark theme's own selection uses, so it is not a new demand.

**Found while fixing this, and recorded for the next round:** `--line-strong` is not derived — it
is a literal in each block — and in the light theme it is `#bac9c4` against a `--line` of
`#b7bdbd`, i.e. the *strong* line is the lighter of the two. What that actually does was measured
in the next round, and the guess made here about the consequence was wrong; see below.

Suites: web 171 (unchanged), browser 63 -> 65.

### The dark block's literals were left behind, and a test now compares every one

The move to a pure-black dark page changed the *derived* colours, but five literals in `:root`
still described the palette it replaced. They are what the window paints before the bundle runs,
so the first frame of every launch was a blue-grey rail and blue-grey cards on a black page:

    --panel         #141b20  ->  #0f0f0f        --line           #2a353b  ->  #3d3e3f
    --panel-soft    #11181d  ->  #0d0d0d        --accent-strong  #f4ca75  ->  #edca89
    --panel-raised  #192228  ->  #121212

Each new value is the effect's own output, so the two now agree by construction rather than by
review. The dark block's comment says so, and names the browser spec that checks it.

**The check reads the stylesheet and the browser, not two copies of the code.** `theme-surfaces.spec.ts`
now parses every custom property out of both `:root` blocks with Node, then compares each of the
eight colour tokens the palette effect writes against the colour the renderer actually resolved for
that theme. Reading both sides out of the source would only have proved the source agrees with
itself; the renderer is the side that matters, and it is what produced this list when the test was
run against the old file:

    dark --panel:         stylesheet #141b20 vs renderer #0f0f0f
    dark --panel-soft:    stylesheet #11181d vs renderer #0d0d0d
    dark --panel-raised:  stylesheet #192228 vs renderer #121212
    dark --line:          stylesheet #2a353b vs renderer #3d3e3f
    dark --accent-strong: stylesheet #f4ca75 vs renderer #edca89

Tokens the effect does not write (`--line-soft`, `--line-whisper`, `--green`, `--red`, `--blue`)
have no derived value to compare against, so they are not covered. `--line-strong` was in that
list when this was written; the next round derived it.

Suites: web 171 (unchanged), browser 65 -> 66.

### The opaque line was the one colour a custom palette did not move

The previous round left a note saying `--line-strong` was inverted in the light theme and that a
hover border was therefore *fainter* than the border it replaced. **The second half of that was
wrong**, and checking the consequence before acting on it is what this round rests on.

The token paints exactly two things — an icon button's hover border and the scrollbar thumb — and
the border a hover *replaces* is not `--line` but `--line-whisper`, a 26% (dark) / 36% (light)
translucent mix of it. Composited over what is actually behind them, in the browser:

    dark    rest border (whisper over the topbar)  1.10:1      shipped hover border  1.92:1
    light   rest border                            1.19:1      shipped hover border  1.53:1

The affordance was intact. The inversion had no visible effect at all, because nothing in the
stylesheet paints `--line` itself — it only feeds `--line-soft`, `--line-whisper` and `--mesh-line`.
Two real defects were sitting under it:

1. **`--line-strong` was the only colour token the palette effect did not write.** The appearance
   section lets the user set a background, a foreground, an accent and a contrast; eight tokens
   followed the palette and this one stayed at the built-in value. Measured with a custom dark
   palette (background `#101820`, contrast 90): every token moved except `--line-strong`, which
   stayed `#39464d`.
2. **That dark value was a blue-grey**, left over from the palette the pure-black page replaced,
   while every other colour in the app had become neutral.

Both are fixed by deriving it, one fixed step above `--line` (`+0.08`), which keeps the pair in
order and keeps the contrast slider's slope. Measured in the browser, before → after:

    dark   #39464d -> #505152    hover border 1.92:1 -> 2.36:1    scrollbar thumb 1.55:1 -> 1.78:1
    light  #bac9c4 -> #a6acad    hover border 1.53:1 -> 2.06:1    scrollbar thumb 1.25:1 -> 1.51:1

The literals in both blocks carry the derived values, and the literal test covers this token as the
ninth.

**The tests were run against the old code first.** The border spec fails on the light theme alone,
with the pair named:

    × the light theme strengthens an icon button border on hover
      → the light --line-strong (#bac9c4) is not a further step from a raised surface than --line (#b7bdbd)

and the palette-coverage test fails with `--line-strong` as the single stuck token. That last test
is the one that could not have been written before: for a token the effect does not write, its
literal and its resolved value agree by definition, so only a *custom* palette can show that nothing
derives it.

**A colour helper that composites before it compares.** `paint.ts` parses the three forms a
resolved colour arrives in — `rgb()`, `color(srgb … / a)` for anything built with `color-mix()`,
and the bare hex a custom property returns — and composites a translucent colour over its backdrop
before measuring contrast. Without that step the rest border, a 26%-opacity hairline, would have
been compared as though it were opaque.

**One full run failed, and it was the machine rather than the change.** `service-outage.spec.ts`
("survives the service going away mid-session") exceeded the 30s test timeout in the first full
run of this tree. It was reproduced alone — **passed, 19.1s** — and the same full suite was re-run:
**69 passed in 2.0m**, with the breakpoint sweep taking 1.6m in the second run against 3.5m in the
first, i.e. the first run was competing for the machine. No behaviour this round touched the
service-outage path; the diff is colour tokens and specs. Recorded because a re-run only means
something next to a local reproduction.

Two later full-suite runs on the same tree were hit by the same effect, and the numbers are the
evidence for calling it environmental rather than a defect:

    run                wall time   result
    2 workers          2.0m        69 passed           <- the clean run
    2 workers          6.5m        64 passed, 5 timeouts across unrelated specs (goto, screenshot, click)
    --workers=1       29.7m        67 passed, 2 timeouts (service-outage, sidebar-header-and-conversations)
    2 workers          4.7m        69 passed, 2 timeouts (breakpoint-sweep, service-outage)
    2 workers          8.1m        68 passed, 3 timeouts (breakpoint-sweep, window-preview, dashboard)
    --last-failed      1.5m, 2.2m  all five re-ran green
    2 workers (73)     9.6m        65 passed, 4 timeouts (dashboard, focus-appearance, navigation, theme-surfaces)
    --last-failed      3.5m        6 of 7 green; the seventh, the light-theme accessibility audit, passed alone in 1.2m
    2 workers (85)     2.6m        85 passed          <- the clean run on the round-13 tree
    2 workers (85)     —           83 passed, 2 timeouts (theme-surfaces, theme-status-colours); --last-failed 2/2 green
    2 workers (89)     —           4 timeouts (pet, theme-surfaces, two dashboard cases); --last-failed 4/4 green
    2 workers (89)     —           5 goto timeouts; --last-failed 4/5 green, the fifth (titlebar-keyboard) 40s alone
    2 workers (89)     4.2m        88 passed, 1 click timeout (sidebar-processes); --last-failed 1/1 green in 12s
    2 workers (89)     3.2m        89 passed          <- clean run on the round-22 tree
    2 workers (89)     5.2m        87 passed, 2 timeouts (breakpoint-sweep, dashboard table scroll); --last-failed 2/2 green in 3.4m
    2 workers (89)     4.9m        88 passed, 1 timeout (breakpoint-sweep); --last-failed 1/1 green in 1.6m
    2 workers (89)     4.4m        87 passed, 2 goto timeouts (theme-chrome, theme-status-colours); --last-failed re-run green
                                 (the second invocation printed "No tests found", which is how a green re-run shows)
    2 workers (89)     4.3m        88 passed, 1 goto timeout (tool-icons); --last-failed 1/1 green in 12.6s

Every reported spec passes on its own: `service-outage` in **19.1s** on the first reproduction and
**3.9m** on a later one — a 12x spread on a test that did not change — and
`sidebar-header-and-conversations` passed in the same chunk run that failed the first. The host was
carrying several other browser processes throughout (8 logical CPUs, with the GUI's own browser
among them). `--last-failed` re-ran every timeout from the round-3 tree green as well (three specs,
2.2m).

**So on this host the full-suite result is not a reliable gate while other browsers are running; the
per-spec runs are.** The 2.0m 69/69 run is the only complete pass, and everything a timeout touched
has been re-run green since. Worth recording because "it timed out" and "it is broken" are different
claims, and only a reproduction separates them.

Suites: web 171 (unchanged), browser 66 -> 69.

### Two browser tests that were weaker than they read

Extending the desktop shell's overlay check turned up two tests that were not testing what their
comments said.

**1. The desktop overlay was only ever checked in the default theme.** `desktop-shell.spec.ts`
already compared the colour the renderer reports — the colour the main process paints the native
window strip with — against the colour the page painted, but once, at startup, on the dark theme.
The path the effect exists for, *reporting again when the palette or the theme moves*, was never
exercised. It is now: the test switches to the light theme, requires a **new** report to arrive,
and re-checks the pair. Measured: `rgb(13, 13, 13)` on the dark theme and `rgb(227, 231, 231)` on
the light one, each equal to the painted bar — which is the same invariant the split top edge was
about, now checked wherever the theme can change.

**2. The light half of `theme-chrome.spec.ts` had never run.** It looked for the theme control as
`getByRole('button', { name: /浅色/ })` and skipped the assertion when nothing matched. The control
is a radio in the 外观主题 group, so nothing ever matched — measured on the same build with a
throwaway probe:

    getByRole(button, /浅色/) count: 0
    getByRole(radio, 浅色) count: 1

It now uses the radio, asserts that the switch actually happened (`aria-checked`, then
`data-theme`) before reading `color-scheme`, and reads it only then. The claim it was making does
hold — the light theme does opt back into light chrome — but it can no longer pass while asserting
nothing, and a renamed, moved or re-roled control fails here.

Suites: web 171 (unchanged), browser 69 (none added; two tests strengthened).

### The status colours went below AA on the light rail

Round 1 made the light theme's rail darker than its cards so that the rail and its selection would
stop collapsing into one colour. That was measured against surfaces — and it moved the surface the
*status colours* are painted on, which nothing checked.

`--green`, `--red` and `--blue` are literals rather than derived tokens: they mean something, so a
user's background must not move them. Their contrast is therefore a function of the surface behind
them, and chips and pills paint *themselves* with `--panel-soft` — the token round 1 changed.
Measured in the browser, on the elements the demo paints:

    light   ready state chip   #247c59 on #e3e7e7 (its own --panel-soft fill)   4.11:1   below AA, 10px
            ready capability   green on a 9% wash of itself over the card      4.08:1   below AA, 10px
            emergency stop     red on a 7% wash of itself over the page        4.25:1   below AA, 12px
            online indicator   the green dot against the page                  4.54:1   (3:1 bar, fine)
    dark    the same four                                                      9.54 / 8.24 / 7.92 / 10.31:1

The chip was 4.58:1 before round 1, so the rail change cost it 0.47. The matrix of every status
colour against every surface said the same thing and named the surface:

    --green on --panel-soft 4.11:1        --red 4.23:1        --blue 4.36:1

**The fix darkens only the light theme's three status colours**, to the lightest values that clear
4.5:1 on every surface *and* on each colour's own wash — a chip fills itself with a 9% wash of the
colour it writes, which is why the painted numbers sit below the plain-surface ones:

    green  #247c59 -> #206f50   4.88 on the rail, 4.81 on its wash
    red    #b5493e -> #a74339   4.81, 4.82
    blue   #2e718d -> #2b6983   4.88, 4.83

The dark theme's values are 7.5:1 or better everywhere and are untouched. Run against the old file
the new spec fails, naming all three.

**Two measurement traps, each of which produced a wrong number first.** `sidebar-row-in` eases
opacity from 0 over .18s, and a row read mid-animation reported a background of `rgb(185, 188, 188)`
— a colour no rule declares, against which the green dot would have "measured" 2.68:1 on a surface
it is not on. And `.button` eases its background over .18s, so a mid-transition read returns
`oklab(…)`, which is not a colour that ever reaches the screen. The spec therefore waits for the
rows to reach opacity 1 and for two consecutive reads to agree before it measures anything.

**A limit this leaves open, deliberately.** The status colours are literals, so a *custom* palette
moves the surfaces under them and can re-open this; the matrix is checked against the built-in
palettes only. Deriving them would make them follow a user's background, which is the wrong
trade for a colour that means "writable" or "failed" — so the honest thing is to record the limit
rather than paper over it.

Suites: web 171 (unchanged), browser 69 -> 71.

### The overview had no empty state, so a quiet machine showed a table with no rows

Every launch begins with zero sessions until the first poll lands, and a machine with nothing running
stays at zero. The overview rendered the table's header row and an empty card list — six column
titles, an empty `<tbody>`, and nothing else. The sidebar list and the 事件 page have both explained
their empty state since they were built; the overview panel, which is the larger surface and the
first one on screen, did not.

The new test's failure output is the clearest description of what was there:

    <table class="process-table">
      <thead>… <th>进程</th> <th>运行位置</th> <th>能力</th> <th>对话</th> <th>静默</th>
             <th>下一输入</th> <th><span class="sr-only">操作</span></th> …</thead>
      <tbody />
    </table>
    <div class="session-cards" />

An empty table is also announced as a table with no data, which reads as a broken render rather than
as a state. The panel now says it in words, and neither the table nor the card list is rendered:

    尚未发现进程
    进程出现后会自动出现在这里，同时列在左侧列表。

The wording mirrors the detail page's own empty state (`进程出现后会自动出现在左侧列表。`), so the
same situation is not described in two different voices.

**Where it could not be tested.** The browser suite runs with `VITE_STATIC_DEMO=true` and the demo
always has four sessions, so no browser spec can reach a zero-session overview. The regression test
is therefore a jsdom one in `App.test.tsx`, next to the connecting-state test that already exercised
exactly this state without asserting anything about it. The browser's `dashboard` and
`accessibility` specs (21 tests) confirm the populated path is untouched.

Suites: web 171 -> 172; browser 71 (unchanged).

### The suite had no way to test the transport, so nothing about it was tested

Chasing the empty state above led to a larger hole. The browser suite had one server, and it sets
`VITE_STATIC_DEMO`, so the bundle used the in-memory demo API and **never touched the network**.
Measured: **0** API requests on load — the only URLs containing `/api/` were Vite serving
`src/api/*.ts` modules.

That made `service-outage.spec.ts` unable to test what it described. It intercepted the API and
aborted it to kill the service; the app never made the request, so nothing about the transport was
ever exercised — not an outage, not a rejected poll, not a recovery, and not the state the app
*starts* in when no service is running, which is the first screen of every launch.

The suite now runs two servers and two projects:

    demo      4174  VITE_STATIC_DEMO=true    everything that wants deterministic data
    live-api  4175  the variable unset       service-outage, and a new no-service spec

`service-outage.spec.ts` is rewritten for the live server. While the service is "up" its requests are
answered from `createStaticDemoApi()` — the app's own demo source, so the two cannot drift — and the
outage is a real `connectionrefused` on a real request. It also asserts the **reconnect** now: the
section reports 实时同步 again and the sessions come back, which is the difference between recovering
and merely not crashing.

`no-service.spec.ts` is new, and it is the browser half of the empty state above: with no service at
all, the shell works, the process section explains itself, the table is not drawn, every settings
section renders, and there are no page errors. That state could not be reached before.

**Two traps, both of which made a version of these specs test the wrong thing.**

1. The app's own modules live under `/src/api/`, so a `**`+`/api/`+`**` route glob matches
   `/src/api/client.ts` too — answering it with JSON replaces the bundle and the page never renders.
   The rewritten spec failed exactly this way before it matched on the URL's pathname instead.
2. The dev server proxies `/api` to the port the real watchdog listens on, so "no service" would
   have depended on whether the host happened to be running one: on a machine where it is, the app
   would connect and `no-service` would fail for the wrong reason. It refuses the connection
   explicitly now, so the state is identical everywhere.

Both specs wait for the observable state (等待连接, then 实时同步) rather than sleeping a fixed
interval: a fixed six-second sleep passed here and timed out elsewhere on the same tree, which is a
property of the machine rather than of the app. They also take a longer per-test budget, because they
wait on real poll cycles across two state changes.

**One environment event worth recording.** Mid-round, `node_modules` was emptied outside this
session's commands (451 packages had to be reinstalled) and the tree was re-verified afterwards: web
172, desktop 142, `tsc --noEmit`, and the specs above all pass on the repaired install. The full
suite's own result stayed load-dependent — see the table below.

Suites: web 172; browser 71 -> 73.

### A custom palette was a way back into every defect the palette had already fixed

The appearance section accepts any background and foreground. Everything below was measured with
`#eef2f1` chosen on the **dark** theme — a light page, which is what the dark theme does not expect:

    --bg #eef2f1   --panel #eff3f2   --panel-soft #eff3f2   --panel-raised #eff3f2
    rail against page                                            1.007:1
    a selected row                                               identical to the rail it sits on
    --accent-strong #edca89 on #eff3f2                           1.36:1   (it is text)
    ready chip green #74c69d on rgb(227, 231, 231)               1.63:1   (it is text)

The first two lines are the defect round 1 fixed, re-entered through the custom-palette door: the
effect branched on `theme === 'dark'`, which is only equivalent while the two built-in palettes are
the ones in use. The other two are the same mistake in the other direction — text colours mixed
toward white on a page that is not dark.

**Fixed by asking the palette instead of the theme.** The new `src/theme/palette.ts` holds relative
luminance, contrast ratio and `isLight`; the effect now uses the background's own lightness to decide
which way a recessed surface steps and which way `--accent-strong` is pushed. The built-in palettes
resolve exactly as before — black takes the dark branch, `#eef2f1` the light one — and a browser case
pins that by measuring the rail-vs-page and selected-vs-rail steps under the custom palette as well as
under the defaults.

**And by solving the text colours rather than trusting them.** `readableText(colour, surfaces,
target)` returns its colour unchanged when it already clears the bar, and otherwise pushes it toward
whichever end of the scale the surfaces are not, by the smallest 5% step that works. The direction is
chosen by asking which end *can* reach the bar, because a mid-grey page rules white out (3.95:1 at
best there) and a near-black one rules black out. The status colours are derived now from a
`STATUS_COLOURS` constant — the stylesheet literals stay as first-paint defaults and are equal to the
derived values for the built-in palettes — and clamped at 4.8 rather than 4.5, since a chip paints
itself with a 9% wash of the colour it writes.

This closes, for the status and accent text, the limit the status-colour section above recorded as
deliberately open: a literal cannot promise anything about a background it was not solved for.

    custom light page on the dark theme        before -> after
      ready chip, green on the rail             1.63:1 -> 5.48:1     #74c69d -> #3a634f
      accent-strong on the panel                1.36:1 -> 5.12:1     (4.60:1 on the rail)
    built-in dark and light                     every value byte-identical, asserted

Nine unit tests cover the helpers — including the mid-grey page, where white cannot reach the bar at
all and the direction therefore has to be black — and the browser case is run against the previous
`App.tsx` to show it fails, naming the chip at 1.63:1.

Suites: web 172 -> 183; browser 73 -> 76.

### The window opened in the dark colours and corrected itself

The saved theme and palette live in localStorage and were read only by the app, so until the bundle
had loaded and React had rendered, the stylesheet's own `:root` literals painted — the dark ones.
Measured against the **built** app with the bundle held back and a light palette saved, which is
exactly the first frame a user gets:

    before   data-theme unset   html rgb(0, 0, 0)   body rgb(0, 0, 0)   color-scheme dark   --bg #000000
    after    data-theme light   html rgb(253, 246, 227)   body rgb(253, 246, 227)   color-scheme light

The desktop shell reveals its window on first paint, so that frame is not hypothetical: a user whose
theme is light, or who saved a light custom palette, watched the app open black and turn light.

**The fix ships as a file, because an inline script is forbidden here.** The service that serves this
bundle sends `script-src 'self'` (`apps/cli/src/server/http-server.ts`), so the usual inline
`<script>` in the head would be blocked in the packaged app and in the desktop shell. `public/theme-boot.js`
is a same-origin file instead: a classic, non-deferred script in the head, which runs before the first
paint, resolves the saved theme, and applies the saved palette's `--bg`, `--text` and `--accent`.

`:root`'s own `background` was a literal in both blocks; it is now `var(--bg)`, so the element that
paints the very first pixel follows a saved palette too rather than crossing to the built-in colour.
Measured after that change: html and body both report the saved `rgb(253, 246, 227)`.

**A boot script duplicates logic the app already has, so the drift is pinned rather than trusted.**
The rules mirror `resolveTheme()` *and* the `useState` initialiser in `src/App.tsx` that sanitises
`watchdog-theme` — anything unrecognised resolves to `dark`, not to the system preference. A boot
script that fell back to the system would paint one theme and be corrected to another on a light
machine, so `theme-boot.spec.ts` holds the bundle back and asserts the pre-bundle state for: a saved
light theme with a palette, a saved dark theme, `system` under both media settings, and an unreadable
preference (`banana` + malformed JSON) which must resolve to `dark`. One more case lets the bundle run
and requires the script and the app to agree afterwards.

**And the script cannot be trusted to be well-formed, either.** The first version declared `stored`
twice; that is a `SyntaxError`, which `try`/`catch` cannot catch, so the whole file failed and the page
silently kept the dark first frame — the exact symptom being fixed. The spec caught it immediately
(`Identifier 'stored' has already been declared`, with `data-theme` unset), which is the argument for
testing the behaviour rather than reading the file.

Suites: web 183 (unchanged), browser 75 -> 80 (five boot cases).

**A note on the counts in this section.** The per-round deltas above were added up by hand as files
were written, and one of them was off by one — the round-7 line says 76 where the total was 75. The
authoritative number is what Playwright itself reports: `--list` gives **80 tests in 31 files** on
this tree. Kept rather than quietly corrected, because an arithmetic slip in a record that is relied
on for exactly this kind of claim is worth seeing.

### The browser's own chrome stayed dark

`theme-color` tints a tab strip or an address bar. It shipped as a static `#000000` in `index.html`
and nothing ever moved it, so a light-theme user's browser chrome stayed dark however long the app
ran — and a custom background never reached it at all. Measured before the fix:

    light theme, once the bundle has run     meta content #000000   (the page is rgb(238, 242, 241))
    saved light palette, before the bundle   meta content #000000   (the page is #fdf6e3)

The fix has two halves, because there are two moments, and each covers what the other cannot:

  - `theme-boot.js` sets it from a saved palette's background before the bundle runs, next to `--bg` —
    the same case the first frame gets wrong.
  - the palette effect sets it from the resolved background on every palette and theme change, which
    covers the built-in light page (`#eef2f1`), a live switch in the appearance section, and a custom
    palette.

The tests were written first: both halves failed, naming the light page and the saved palette.

Suites: web 183 (unchanged); browser 80 -> 81.

### The theme swatch was not the theme

The appearance section's preview cards derived their own colours: `mix(background, foreground,
0.1 | 0.05)` for the rail and `0.16 | 0.04` for the sheet, fixed, and never reading `contrast`. The
app derives `--panel-soft` and `--panel` from the background with `weight + contrast / 1400`.
Measured in the browser on the dark theme, on the 深色 card — the one that stands for what is on
screen:

    preview rail   rgb(23, 24, 24)      the app paints #0d0d0d
    preview sheet  rgb(37, 38, 38)      the app paints #0f0f0f
    contrast 68 -> 100                  moved the app to #131313 / #151515, swatches unmoved

The mismatch is visible in a single gesture on the same panel: dragging the contrast slider repaints
the app and leaves the swatch it is supposed to preview exactly where it was. A swatch that does not
show the theme it is chosen by is worse than no swatch.

**Fixed by there being one derivation.** `paletteSurfaces(palette)` now lives in
`src/theme/palette.ts` and is called by both the palette effect and `ThemePreviewCard`; the card's
own formula and the effect's local `mixColor` are gone, leaving the module's `mix` as the only blend
in the app. It takes no theme parameter — the direction comes from the palette's own background,
which is what round 7 made possible and what lets the card for the *other* theme be correct while
this one is on screen.

Measured after:

    dark card    rail rgb(13, 13, 13) = the painted rail    sheet rgb(15, 15, 15) = the painted panel
    light card   rail rgb(227, 231, 231), sheet rgb(239, 243, 242)   (the light palette's own surfaces)
    contrast 68 -> 100   app rail rgb(13, 13, 13) -> rgb(19, 19, 19), swatch with it, step for step

Three unit tests pin the derivation — the built-in palettes' exact values, that every surface moves
with the slider, and that the direction is the palette's — and the browser case was run against the
previous `App.tsx`: both halves fail, naming `rgb(23, 24, 24)` against `rgb(13, 13, 13)` and the
frozen swatch.

Suites: web 183 -> 186; browser 81 -> 83.

### The diff pane described choices the user had not made

`ThemeDiffPreview` sits under the three theme cards and says in its own words that it shows "what the
theme ships with against what the current choices resolve to". It shipped with three rows: `surface`
(a token *name*), `accent` and `contrast` — while the appearance list directly above it offers colour
pickers for 背景 and 前景. Measured in the browser:

    set 背景 to #fdf6e3    app --bg #fdf6e3      diff byte-identical
    set 前景 to #2b2b2b    app --text #2b2b2b    diff byte-identical
    set contrast to 100    app repaints          diff: contrast: 100

So the pane presented a diff of a palette whose two colour choices it did not mention. **The first
version of this measurement was itself wrong**, and it is worth recording: the probe set the colour
input's `value` directly, React's value tracker swallowed the event, and neither the app nor the diff
changed — which would have "shown" a diff that tracked nothing. The second measurement went through
the prototype setter, and `--bg #fdf6e3` is what made the claim about the diff meaningful.

Fixed by listing every field the palette holds, in the order the list offers them — `surface`,
`background`, `foreground`, `accent`, `contrast` — rendered from `THEME_DIFF_FIELDS` with the line
numbers computed rather than written out. `surface` stays a name because the palette really does hold
a *toggle* (`translucentSidebar`), not a surface colour.

Measured after:

    set 背景 #fdf6e3, 前景 #2b2b2b, contrast 100
      after pane:  surface: "sidebar", background: "#fdf6e3", foreground: "#2b2b2b", accent: "#e6b65b", contrast: 100
      stock pane:  surface: "sidebar", background: "#000000", foreground: "#e9eef0", accent: "#e6b65b", contrast: 68

The new browser case asserts all three changes, plus that the stock pane does not follow the user —
which is what makes it a diff. Against the previous `App.tsx` it fails at the first assertion: the old
pane has no `background:` row at all.

Suites: web 186 (unchanged); browser 83 -> 84.

### Absurd session values: two silent clips and a table that grew without bound

The live-API project can serve arbitrary session data, which nothing had ever done: the demo project's
in-memory API always has the same four quiet sessions. One session was given a 120-character id, a
200-character conversation id, a 300-character workspace path, an absurdly long window title and host
label, and a 260-character prompt.

Measured before the fixes, against a **baseline** pass of the same build with the demo's own values:

    process table     baseline 939px, fitting its wrapper   ->  extreme 2525px, 1586px of scroll
    detail 运行位置   host cell [286 < 520] — wider than its box, and the workspace's own
                      `overflow-x: hidden` cut it off mid-word with no ellipsis
    narrow cards      card header [608 < 2019], the same silent clip inside `.session-card { overflow: hidden }`

Three changes:

  - **`.host-badge` is capped and ellipsised**, with the full label in a `title`. It was
    `display: inline-flex` with `nowrap` and no cap, so a long host name made its pill 520px wide in a
    286px cell. It is `inline-block` now, because `text-overflow` applies to the box rather than to a
    flex item.
  - **`.process-id span` and the new `.conversation-id` wrap anywhere.** They wrap rather than
    ellipsise, and the first attempt got that wrong in an instructive way: a `max-width` with
    `white-space: nowrap` made the table *wider for the demo's own values* — the baseline went from
    939px (fits) to 1225px with 286px of scroll — because content that used to wrap was forced onto one
    line. `overflow-wrap: anywhere` bounds the absurd case and hides nothing.

    after     baseline 939px, fitting   ->  extreme 985px, 46px of scroll

**The spec compares against a baseline, not a fixed width.** Absolute widths depend on the window and
on the data, and this table is deliberately allowed to scroll (`overflow-x: auto` with bounded columns
elsewhere). What a change can be held to is the *increase* caused by absurd content, so the same build
is measured twice — with the demo's own sessions and with the absurd one — over the same real HTTP
server, and the growth is what is asserted. Run against the previous CSS the test fails on exactly that:
1586px of growth.

Suites: web 186 (unchanged); browser 84 -> 85.

### A copy that failed said nothing

The environment panel's 复制 button copies the whole manual-install block as one script. The clipboard
is not always available — an insecure context, a denied permission, or a browser that is not on the
loopback address, where `navigator.clipboard` is not defined at all, which is reachable here because
the service is served over plain HTTP — and the click had two outcomes: a confirmation, or nothing at
all. A failure was indistinguishable from a click that never registered. The code's own comment already
named the cause ("the clipboard is not always available … so the confirmation only appears after the
write resolves"), so the intent was understood and only the failure half was missing.

Two siblings in the same app did better: the import section throws `当前环境不支持读取剪贴板` and
reports `导入失败：…`, and the appearance panel's copy tracks `done`/`failed` and shows 复制失败. The
button now does the same:

    复制  ->  已复制            the write resolved
    复制  ->  复制失败          refused, or no clipboard API at all, with the reason in `title`

`aria-live="polite"` was added with it, because the button's accessible name is its constant
`aria-label`: the visible label change was invisible to a screen reader, both for the confirmation and
for the failure.

**The rest of the app was checked for the same silence.** Every other `catch` in `App.tsx` already
reports: the three that do not are deliberate and documented — a corrupt saved palette, an older bridge
with no settings fields, and the poll/environment retries that surface as 等待连接.

Both halves are pinned now: the existing success test asserts 已复制, and the new one asserts 复制失败
with the reason for a refused write and for a missing clipboard API. Run against the previous code the
new test fails at its first assertion, because the label never changed.

Suites: web 186 -> 187; browser 85 (unchanged).

### Three notification switches that changed nothing

The 通知 section offered four controls. One worked — 保留最近事件条数, read by the timeline — and the
other three were written to localStorage, validated on read, and **consulted by nothing**:

    面板内通知          "在面板内显示状态变化提示"
    续写成功时提示      "成功写入一次续写后给出提示"
    出现错误时提示      "写入失败或传输异常时给出提示"

So a user could switch notices off and keep being shown every one. This is the defect the rail's own
docstring records other sections being removed for ("they changed nothing a person could observe"), and
it survived because **no test touched notices at all** — the pref key appears in no test file.

The strip now carries a tone, and the three switches filter on it:

    notice = { text, tone: 'info' | 'error' }        failures pass 'error'
    shown  = notifications.inPanel
             && (tone === 'error' ? notifications.onError : notifications.onSuccess)

Two things had to change with it:

  - **The app had to hear about a change.** `notifications` was re-read on every render, which only
    worked because the app polls; the 通知 section now pushes through `onChange`, so a switch takes
    effect immediately (there is a test for that specifically, since "it works if you wait for the next
    poll" is not the same claim).
  - **One label had to stop over-promising.** `续写成功时提示` gated every confirmation, not only a
    continuation write, so it is now `操作成功时提示` with the hint `成功完成一次操作后给出提示`. The
    alternative — gating only the write notices — would have left the other 已复制/已保存/已启动
    confirmations unsilenceable and the switch still narrower than its neighbours imply.

**A test-ordering bug the suite caught.** These tests write the preference, and localStorage outlives a
test: the switch left off silenced a *later* test's notice (the Codex endpoint switch asserts 端点已切换).
An `afterEach` clears the key now. Worth recording because the failure looked like an unrelated
regression in a spec this change never touched.

Suites: web 187 -> 191; browser 85 (unchanged).

**Found while checking the rest of the preferences:** the same sweep turned up a *personalization*
preference that was unreachable rather than inert — `PersonalizationPref.density` had a default, a
validator and `PERSONALIZATION_DEFAULTS`, `sections.css` carried `:root[data-density='compact']`
overrides, and **nothing anywhere set `data-density`**: no control, and the two imports in
`sections.tsx` were unused. No user was being told anything untrue, so it was dead code rather than a
defect of the kind above — and it is now wired, in the next section.

### The density preference was wired rather than deleted

Three compact rules had been written and could never match, because nothing set the attribute they key
off. They name three surfaces, and the appearance section now offers 界面密度 (舒适 / 紧凑) with a hint
that lists exactly those — the alternative was deleting a preference whose styles were already
designed:

    comfortable   settings section 22px   appearance row 15px   process-table cell 16px
    compact       settings section 15/16px  appearance row 10px  process-table cell 10px

The app owns the value: an effect puts it on the document root, the section pushes changes up, and it is
stored under the preference's own key, so it survives a reload and is independent of the theme (a
palette change does not reset it). `theme-boot.js` applies a saved density before the bundle as well —
the same argument as the saved theme, since a user who chose compact should not watch comfortable
spacing correct itself.

Measured in the browser rather than asserted from the class name: the test reads the computed padding of
all three surfaces in both states, checks the choice survives a reload, and the boot spec holds the
bundle back to check the pre-bundle attribute. The `sections.tsx` imports that existed only for the
unused pref are gone.

Suites: web 191 -> 193; browser 85 -> 87 (a density case in each of the appearance and boot specs;
    `--list` reports 87 tests in 33 files, and the full run is green in 2.2m).

### The profile section offered two fields nothing rendered

个人资料 had three fields. 显示名称 works — the account popup's header shows it. The other two were
stored, validated on read, and rendered by nothing:

    头像    默认 / 浅色 / 深色        no part of the app shows an avatar
    备注    a three-row textarea     no part of the app shows a note

Same class as the notification switches, and the same reason it survived: **no test touched the section
at all**. The rail's own docstring has the precedent — sections that "changed nothing a person could
observe" were removed rather than left as placeholders — so the two fields are gone rather than given
invented behaviour. `ProfilePref`, `isProfilePref` and `PROFILE_DEFAULTS` carry `displayName` alone now;
a value stored by an older build still validates, because extra keys are ignored rather than rejected.

**My own sentence was the first thing caught.** The rewritten hint said the name appears "在账户弹窗与
底部栏"; reading the markup showed the bottom bar shows the *service status and the session count*, and
only the popup header shows the name. Writing a claim beside a control and then checking it against the
app is the discipline the rest of this record is about, and it applies to a hint added five minutes
earlier as much as to one from the first version.

A test pins the section to what it can show: 显示名称 present, 头像 and 备注 absent — so re-adding either
means wiring it first.

Suites: web 193 -> 194; browser 87 (unchanged).

**Found in the same sweep, now wired:** 续写插件 told the user that "这些提示词会依次拼接，作为手动续写时使用的提示". Measured, the preference was read by nothing but the section — `PREF_KEYS.plugins`, `isPluginsPref` and `PLUGINS_DEFAULTS` appeared only in `desktop-prefs.ts` and `sections.tsx` — and neither write path consulted it: the one-click 立即续写 called `mutateSession(session, 'inject')` with no prompt, and the composer sends only what was typed, so a stored list was a notebook.

### The plugin prompts now reach the continuation they promised

The section states a behaviour, so it was wired rather than deleted:

    one-click 立即续写   sends the stored prompts joined with a space
    a typed line        still wins, because that path always supplies one
    a join over the cap refused, not truncated

The cap is not a guess: the service accepts only `a non-empty single line of at most 4096 characters`
(`http-server.ts`), so a longer join is reported — 续写插件提示词拼接后共 N 字符，超过 4096 字符上限，未发送 —
and **nothing is sent**. Truncating would silently drop the end of a prompt, which is worse than saying it
was not delivered. The hint now says exactly that, including the join and the limit.

Three tests pin it: the joined send, the empty-list contrast case (the call keeps its old
single-argument shape, so no existing caller changes), and the refusal, which also asserts the request was
not made at all. Notes on the mechanics: the prompts are read at click time rather than held in state, so a
list edited in the settings section is used by the next click without a reload; and the typed path is
protected structurally, by `prompt ?? pluginPromptLine()`.

Suites: web 194 -> 197; browser 87 (unchanged).

### The desktop pet only existed on its own settings page

宠物 promises "在窗口右下角显示一个小小的状态装饰", and its stylesheet is `position: fixed; right: 22px;
bottom: 22px` — the window's corner. The ornament was rendered *by the settings section*, so it existed only
while that section was open: invisible while actually using the app, and its pulse ("会话数量变化时轻轻跳动
一下") could only fire if the session count happened to change during the visit. The shell draws it now and
the section is controls only, so it is on screen on every page.

Measured in the browser, on two pages, with a settle-then-measure routine:

    overview      46px square, 22px from the right and bottom
    events page   46px square, 22px from the right and bottom

**The first run of that test failed, and the failure was informative rather than a flake**: it measured 52px
at 19px, then 46px at 16px. The pet arrives with a CSS transition, so the box was caught mid-flight — the
same discipline the status-colour spec needed for the sidebar row's entry animation.

**Placing the ornament in the shell exposed a wrinkle the section had hidden.** Mounted before the first
poll, the session count goes 0 → N when the data arrives, which is a change — so the pet bounced once on
every launch, before anyone had looked at it. A count that arrives from nothing is the app loading, not a
signal; only a change from a count the user was already watching bounces now. This showed up as a test that
passed alone and failed in the full file, because the timing fell either side of the first load.

Suites: web 197 -> 200; browser 87 -> 88.

### The config numbers were held to ranges nothing enforced

检测节奏 offers four number fields and the Harness and Stop Hook rows three more. Every one declares a `min`
— 1 second, 250 ms, 1 attempt — and **nothing enforced it**, so a field could hold `0`, a negative, or a
fraction. The service refuses exactly those values (`requirePositiveNumber` and `requirePositiveInteger` in
`apps/cli/src/domain/config.ts`), so the only way to find out was to press 保存 and read the service's
rejection — after leaving the field and its declared range.

Two controls in the same panel already clamped their value (the notifications list limit and the Harness
activity window), which is what made the rest look like an oversight rather than a decision.

`clampNumber(raw, min, max?)` now enforces each field's own declared floor and truncates, because every one
of these settings is a whole count of milliseconds or seconds — 每轮最大尝试 accepted `1.5` in the field and
was refused by the service as a non-integer. `Number('')` is `0`, so clearing a field yields its minimum
rather than a save that fails.

The test types `0`, `-5` and `1.5` into the fields, asserts what the controls now show, and then asserts what
保存 actually sends — a clamped field that still sent the unclamped draft would pass the first half alone.

Suites: web 200 -> 201; browser 88 (unchanged).

### A console with forty sessions, in which every count agrees

The demo project always serves the same four quiet sessions, so nothing about a *full* console had ever been
rendered: not a sidebar list long enough to scroll on its own, not a table with dozens of rows, and not the
counts the metric strip promises once they have to add up. The live-API project can serve forty sessions
across four hosts, which is what `scale.spec.ts` does.

**The counts are checked against other surfaces, not against arithmetic in the test** — a number that agrees
with the code that produced it but not with what is painted is the defect being looked for:

    metric strip   发现进程 40   可写入 32   Codex Goal 10   服务状态 运行中
    table          40 rows, 32 with a 可写入 badge, 10 whose conversation cell starts with "Goal"
    sidebar        40 rows, 32 writable dots and 8 monitor dots
    account bar    "40 个进程"
    groups         Tabby(10)  Windows Terminal(10)  Visual Studio Code(10)  Microsoft Edge(10)

Everything agrees: 发现进程 against the rows and the account bar, 可写入 against both the table's badges and
the sidebar's dots (the same single owner, `writeEligibility`, feeds all three), Codex Goal against the
conversation cells, and each group against the sessions served for that host. The shell holds too — the page
does not scroll sideways, the table fits, the sidebar list scrolls inside itself, and filtering forty rows
still finds the one that matches.

**Nothing was wrong.** Recorded as a sweep that found nothing rather than dressed up as a fix: the first row
appears about 1.6s after navigation, the same order as with four sessions, so scale is not costing anything
either. What the round does add is the invariant — four surfaces that must keep agreeing as the console fills
up.

Suites: web 201 (unchanged); browser 88 -> 89.

### The jsdom tests were running on a budget their own measurements overran

Three times this session a `App.test.tsx` case failed with `Test timed out in 5000ms` and passed when run
alone. The last one makes the cause unambiguous: run by itself, with nothing else on the machine, it takes
**4.9s** — 98% of Vitest's default budget — because it renders the whole application, holds an environment
scan pending, and then exercises several controls across the resulting updates. Survivability was a coin
toss, and the slower file-level runs (78s under load against ~12s idle) decided it.

`vitest.config.ts` now sets `testTimeout: 20_000`, with that measurement in the comment. Twenty seconds is
four times the slowest honest test here, so a genuine hang still fails; what stops failing is a loaded
machine's honest test.

Suites: web 201 (unchanged); browser 89 (unchanged).

### Two panels that printed the engine's own words

Both were found by asking the same question of every panel: *is this string something a person wrote, or
something the engine named?* In each case the same value was already translated on a neighbouring surface.

  - **浏览器访问 → 当前主题** printed `light` / `dark` — the raw identifier, between 访问地址 and 在浏览器中打开,
    in a panel that is otherwise entirely Chinese. The appearance section names the same two things 浅色 and
    深色. The row held the right *value* (it reads the resolved theme, not the preference), so only the wording
    was wrong.
  - **进程详情 → 传输错误** printed the engine's reason code — `no-cwd-match` — while the capability badge a few
    lines above it printed 未找到同目录 Codex 线程 for the very same field. `transportReason()` already held a
    table of nineteen of those mappings; the detail row simply never called it.

Both now read through the one owner each: `THEME_NAMES` in the settings sections, and `transportReason()` in the
detail row — whose own fallback still passes an unknown engine string through rather than hiding it, so an
unmapped reason stays legible instead of disappearing.

Tests: the section asserts 深色 and 浅色 and that no raw identifier is on the page; the detail case opens the
session whose engine error is `no-cwd-match` and asserts the row explains it, failing before the change with
exactly `传输错误no-cwd-match`.

**Found in the same sweep, queued:** the timeline's detail line renders `Object.values(event.details).join(' · ')`
— values only, no keys, no translation — so the three demo events print `awaiting-quiet-period`, `monitor-only`
and `dsh-session`. The chip above each line translates the event's *type*, but the payload beside it is still the
engine's vocabulary, and dropping the keys means a reader cannot tell which field a value belongs to. The next
round should decide that line's shape — labelled fields, with known values translated — rather than translating
the strings in place.

Suites: web 201 -> 203; browser 89 (unchanged).

### The timeline said the engine's words

Each audit line was `Object.values(event.details).join(' · ')` — **values only, no keys, nothing translated** —
so the demo timeline read:

    codex:336756 · awaiting-quiet-period
    codex:333616 · monitor-only
    dsh:session-4f21c0a8 · dsh-session

under a chip that *did* translate the event's type (决策/跳过/活动). A reader could not tell which field a value
belonged to, and a decision event's `atMs` printed as `1789000000000` — an epoch number where every other
timestamp in the app is a time.

`timeline/audit-details.ts` owns the payload's shape: key labels (`action` → 操作, `reason` → 原因, …), the
vocabularies that live there (eighteen action codes taken from the call sites that write them, three activity
sources, three tools), booleans as 是/否 with `ok` as 成功/失败 because it is a verdict rather than a flag, and
`atMs` through this app's own `time()`. Two vocabularies are **passed in rather than copied** — the engine's
decisions (the status chip's labels) and its transport reasons (the capability badge's) — so a reason reads the
same wherever it appears, and no import cycle is created to reach them. Anything unmapped is printed under its own
key: a payload this build has never seen stays legible instead of disappearing. A `null` value says nothing at
all, because the engine writes nulls for "no reason" and 原因：null would be words spent on an absence.

The same values now read:

    决策：等待静默 · 时间：14:32:05        (was: 1789000000000 · awaiting-quiet-period)
    原因：仅监控模式                      (was: monitor-only)
    来源：Harness 会话                    (was: dsh-session)

Eight module tests cover the shape, the vocabularies, the delegation, the timestamp, the unknown key, the null
and the free-form `process-discovery: …` reason (passed through whole, since translating its tail would leave a
half-English line). The app-level test emits a real audit event through the subscription and asserts the line —
and was run against the old rendering first, where it failed with `Unable to find an element with the text:
/等待静默/`.

The longer lines were the risk, so `timeline.spec.ts` was run too: rows still fit a 390px viewport, which jsdom
could never have told us.

Suites: web 203 -> 212 (a new 15th test file); browser 89 (unchanged).

### The timeline kept a hundred events however many you asked for

保留最近事件条数 accepts up to **1000** and the events page counts what it shows, but the arrival path — the one
subscription that receives audit events — kept the newest **100** whatever the setting said. Two surfaces
disagreed about one number and the setting lost: a value of 300 showed "100 条", and the shortfall was not merely
hidden, those events had already been dropped.

`TIMELINE_LIMIT_MAX` now owns the ceiling and both sides read it: the field clamps to it, and the subscription
keeps to it. The subscription's closure is created once and cannot read the *current* setting, so keeping the
ceiling the setting may ask for is what makes the setting honest; `visibleEvents` still slices down to whatever it
currently says. (The alternative — reading the live setting in the closure — would mean re-subscribing on every
change, which would drop the stream and the events already held.)

The test sets 300, delivers 150 events through the subscription, and asserts the page counts 150. Against the old
code it failed with `Unable to find an element with the text: 150 条`.

Suites: web 212 -> 213; browser 89 (unchanged).

### The poll-age chip said "轮询 -- 前", and its name was English

Two small things in the same chip, both about a value that is not there yet. Before the first successful poll —
which is the state of a machine whose service is not running — the topbar rendered:

    轮询 -- 前

a sentence with a hole where the number belongs. (`duration()` writes `--` for "no value", which is right for a
cell that holds a value and wrong for a phrase that needs one: the chip now says 尚未轮询.)

And the chip carried `aria-label="Last watchdog poll"`, an accessible name that both replaced the visible text and
was the only English phrase in the shell — a screen reader heard English where the panel says 轮询 2s 前. The label
is gone: the visible text is a complete phrase and is now the accessible name, so what is announced and what is
shown agree.

Axe does not catch the second one — `label-content-name-mismatch` applies to controls, and this is a static span —
which is why a foreign-language name on a non-interactive element can sit in a page that passes a serious/critical
audit. The audit was asked for evidence rather than assumed: the chip's `--` state had never been asserted by any
test.

Three tests now cover the chip: the never-polled phrase, the age in the words it shows with no `aria-label`, and
the existing age test, whose query moved from `findByLabelText('Last watchdog poll')` to the visible text — the
same assertion of intent, made through what a person actually sees.

Suites: web 213 -> 215; browser 89 (unchanged).

### Six menu items that responded to a click by doing nothing

The renderer draws its own `文件 编辑 视图 帮助` row inside the custom title bar. `menu.ts` records why the native
template is still installed — it keeps the standard accelerators alive — and its 编辑 submenu carries the six
commands as Electron roles with `CmdOrCtrl` accelerators. The **renderer's own 编辑 items** carried no `action`, no
`url` and no handler: clicking 复制 or 粘贴 did nothing at all, in the desktop app as well as in a browser. Six of
that row's seventeen items were dead.

They go through the bridge now, which is how the row's 视图 items already worked:

    renderer    each 编辑 item carries an action and needsBridge; runMenuAction calls shell.<command>()
    preload     undo / redo / cut / copy / paste / selectAll, each a named action, never a free-form channel
    main        SHELL_ACTIONS gains the six; applyShellAction performs them on the window's **web contents**
                (Electron puts the editing commands there, not on the BrowserWindow), and skips one an older
                surface does not implement rather than throwing

In a plain browser they are disabled with the same 仅在桌面应用中可用 reason the view items use: the browser has its
own shortcuts for these, and the app cannot reach a window's editing surface.

Tests: desktop — each command reaches the web contents, a surface without one is skipped, and the allow-list grew
deliberately — that last case failed first, because an existing test pins the catalogue exactly. Web — the
plain-browser case asserts all six are disabled with the reason, and the bridge case clicks each one and asserts its
own method was called. The plain-browser case was run against the old menu first, where it failed: the items were
enabled and inert.

Suites: web 215 -> 216; desktop 142 -> 145; browser 89 (unchanged).

### Three surfaces said "0s" where one said nothing

The service sends `quietForMs: null` when it has no last-activity time to measure from
(`lastActivityAtMs === null ? null : …` in the watchdog controller), and the app's own surfaces had **three
different answers** for what that means:

    process table    quietForMs ?? (lastActivityAtMs ? now - lastActivityAtMs : null)   → "--" when unknown
    detail page      same computation, then `?? 0` on the way out                       → "0s"
    mobile card      quietForMs ?? 0                                                    → "0s"
    sidebar row      formatSilence(quietForMs ?? 0)                                      → "0s"

So a session with no activity timestamp at all read as *actively working this second* on three of four
surfaces, and as "unknown" on the fourth — and the mobile card and the table are the same list at different
widths, so the same session changed its story when the window narrowed. The web's `SessionView.quietForMs` type
said `number | undefined` while the service sends null, which is how the mismatch stayed invisible: the compiler
believed a null could not arrive, and `?? 0` looked like a default rather than a claim.

`quietMs(session, now)` now owns the rule — the service's value if it has one (a real `0` is kept), else a live
fallback to the last activity, else **null** — and `formatSilence` writes null as `—`. The table, the detail
page, the mobile card and the sidebar row all read through it, and the type now admits the null the service
actually sends. (Session *ordering* still treats an unknown silence as `0`, i.e. sorts it last; that is an
ordering rather than a value on screen, and it is recorded here rather than changed silently.)

Tests: `quietMs` covers the four cases including a clock that moved backwards, `formatSilence(null)` is `—`, and
the app-level case serves one session with both timestamps null and asserts every surface agrees — the table
cell, the sidebar row and every 静默 row on the card and the detail page. It failed first with
`the sidebar row claims 0s: expected '0s' to be '—'`.

Suites: web 216 -> 219; browser 89 (unchanged).

### Two duration formatters, side by side

Having just unified four call sites into one `quietMs`, the next thing to check was whether the *formatting* had
the same problem. It did, and more visibly: the app had two functions that both wrote a duration.

    table / card / detail   `duration()`       2m 5s     unknown: --
    sidebar row             `formatSilence()`  2m 05s    unknown: —

They are shown **beside each other** for the same session — the overview table's 静默 column and the sidebar row
that selected it — so a session quiet for two minutes and five seconds read as `2m 5s` in one and `2m 05s` in the
other, with two different glyphs for "unknown" between them.

One function now: `formatDuration` keeps the padded form and the em dash, the table, the card, the detail page,
the sidebar row and the topbar's poll age all read through it, and the app's own `duration` is gone. Padding is
what survived because it is what the column and the row need to line up; the em dash is the app's existing "no
value" convention.

Tests: the formatter's cases moved to the surviving name with the padding pinned (`2m 05s`), and a new
cross-surface case serves a session quiet for 2m 05s and asserts the sidebar row and the table cell are the same
string. It failed first with `the table writes the same duration differently: expected '2m 5s' to be '2m 05s'`.

Suites: web 219 -> 220; browser 89 (unchanged).

### Two `toolLabel`s, and one of them said "Claude"

The app named a session's tool in two places. The sidebar used `session-groups.toolLabel`, which names every tool
it knows and otherwise prints the tool's own name; `App` had its own:

    session-groups   codex → Codex, claude → Claude, opencode → opencode, dsh → DeepSeek Harness, else the raw name
    App              codex → Codex, dsh → DeepSeek Harness, **everything else → 'Claude'**

The union (`ToolName = 'claude' | 'codex' | 'dsh'`) makes those equivalent *today*, which is exactly why nothing
caught it. But the web client casts the sessions response without validating it — established two rounds ago —
so a newer service can report a tool this build has never heard of, and the table then called it **Claude** while
the sidebar row beside it printed what the service actually said. `opencode` is the realistic case: it is in the
environment catalogue the app can install, so a service reporting it as a *session's* tool is not far-fetched.

App's copy is gone. The table, the mobile card, the detail page and the sidebar all read the one owner, whose
fallback is the tool's own name rather than another tool's. The timeline's payload reader held a third copy of the
same three names as a map; it now takes `tool` as a delegate, beside its decision and reason vocabularies, so the
app has one place that knows what a tool is called.

The test serves a session whose tool is `opencode` (cast, because the union refuses to admit it) and asserts the
table and the sidebar agree. It failed first with `the table calls an unknown tool Claude: expected 'Claude' to be
'opencode'`.

Suites: web 220 -> 221; browser 89 (unchanged).

### Two cells labelled 服务状态, answering different questions

The next thing the "how many places describe this one thing" lens turned up was a label doing double duty:

    overview strip   服务状态   运行中 / 已停止 / 离线     "is the watchdog running"
    account popup    服务状态   在线 / 未连接              "can this page reach the service"

With a reachable service whose watchdog is stopped, both are on screen at once and they read **已停止** beside
**在线** — under the same two words, in opposite colours, and a screen reader heard the same label twice. Both
values were true; the *label* was the defect, because it named two questions at once.

The strip's cell now says **Watchdog** — the word the app's own buttons use (启动 Watchdog / 停止 Watchdog) — and
the popup's fact says **连接状态**. The account bar's button keeps 服务在线 / 服务未连接, which is a sentence about
the connection rather than a competing label.

The test serves a reachable service with the watchdog stopped and asserts the strip names the watchdog, the popup
names the connection, and no surface still uses the old shared words. It failed first with
`the strip does not name the watchdog: expected '(no Watchdog cell)' to contain '已停止'`.

Suites: web 221 -> 222; browser 89 (unchanged).

### The demo said it was a live console

The same lens turned up one state described two ways — 样例数据 above the table and 离线预览 below it — and following
it found the reason, which was larger than the wording.

`main.tsx` **always** supplies the static demo's api (`<App api={VITE_STATIC_DEMO ? createStaticDemoApi() : undefined} />`),
so in the demo build `refresh()` succeeds against memory and `connected` becomes true. Every surface that reports the
connection therefore said **实时同步 / 服务在线 / 在线**, and the chip's light went green — for a page whose data is
built into the bundle and which has no service at all. The app's own preview wording sat behind `connected === false`,
which no build could reach: in the demo `connected` is always true, and everywhere else `staticDemo` is false. The
deployed Pages preview was the one build that needed those words, and it could not show them.

Display state is now derived in one place:

    const live = connected && !staticDemo;

Every surface that reports the connection reads `live` — the overview chip and its light, the account bar's button,
the popup's 连接状态 fact and its dot, the Watchdog cell's fallback, and the 关于 section's own row. The demo now says
离线预览 in all of them, with its light off, and the `staticDemo` branches are live code again.

A consequence handled rather than discovered later: `theme-status-colours.spec.ts` measured the online indicator's
green, which the demo no longer paints. Its non-text surface is now the sidebar's writable dot — the same `--green`
in the same role, and present in the demo — with the substitution recorded in the spec itself.

Tests: a demo-project browser case asserts all three surfaces say 离线预览 and the chip's light is not online; the
jsdom static-demo case asserts the same and that neither 样例数据 nor 实时同步 appears anywhere. Both were written
against the old build first — the browser one failed with `unexpected value "实时同步"`.

Suites: web 222 (unchanged); browser 89 -> 90.

## Not verified

The tray icon's on-screen appearance in the notification area, and the native title-bar overlay's
hit-testing, are the two things automation cannot reach: both need a real click at coordinates the
harness cannot verify, and pixel measurement is not the same as seeing the icon in place. Everything
else above was executed. The tray's *behaviour* — menu labels, reveal, checkbox, close-to-tray in all
three configurations — is covered by unit tests and was additionally confirmed in the packaged app.
