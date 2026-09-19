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

## Not verified

The native overlay hit-testing, the real tray icon rendering and a real
title-bar close are covered by stub-level unit tests only; this run did not
launch a GUI session. Everything else above was executed.