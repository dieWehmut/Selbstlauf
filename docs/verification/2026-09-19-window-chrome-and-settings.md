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

## Not verified

The tray icon's on-screen appearance in the notification area, and the native title-bar overlay's
hit-testing, are the two things automation cannot reach: both need a real click at coordinates the
harness cannot verify, and pixel measurement is not the same as seeing the icon in place. Everything
else above was executed. The tray's *behaviour* — menu labels, reveal, checkbox, close-to-tray in all
three configurations — is covered by unit tests and was additionally confirmed in the packaged app.