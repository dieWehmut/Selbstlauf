# Settings completion and final local reinstall — 2026-10-23

The current 13 settings sections are implemented and verified across the
desktop app, production WebUI and local production GitHub Pages build. Work was
split between desktop, WebUI and Pages tasks and committed in separate changes.
The final local Windows installation contains the completed runtime and UI,
including the subsequent Harness, WSL, history and configuration-draft fixes.
The application remains **0.9.5**, Electron remains **44.4.1**, and the existing
dependency lockfile is unchanged. No global tool upgrade was executed.

Linux builds, tests and verification scripts ran through
`scripts/verify/in-conda.sh` in the new `selbstlauf-settings-20261022`
environment: Node **22.23.2**, Python **3.12.15**. Native Windows checks used
that conda Node as their orchestrator and the existing Windows Node/Electron
dependencies in an independent checkout.

## Implemented settings

The [Web settings audit](2026-10-22-web-settings-audit.md) maps all 13 sections
to their implementation and behavioral evidence. It covers actual service
configuration, appearance and four languages, notifications and event limits,
fixed keyboard shortcuts, profile name, pet appearance, startup/tray and
terminal selection, Claude Hook and Codex endpoint editing, import/export,
computer-action permission, ordered continuation prompts, browser entry and
environment/version status.

Later changes close the runtime defects found by the audit:

- Disabling Dry Run immediately attempts Harness authentication. Successful
  authentication and permission checks enable its real writable transport;
  failed authentication keeps it monitor-only. Repeated Dry Run transitions
  retain correct credentials and permission behavior.
- Changing the WSL distribution discards the previous distribution's cached
  home, SQLite snapshot, launch lookup and adapters. Disabling input takes
  effect before an older poll can resume.
- Reload fetches saved audit history and merges concurrent streamed events
  without duplicates or late responses restoring stale history.
- Service refreshes preserve unsaved configuration fields, while successful
  saves acknowledge only the submitted draft. Failed saves retain edits for
  retry, including edits made while a request is pending.
- Clearing a Codex endpoint field removes its active assignment, preserves
  comments and produces a checksummed backup. Untouched and absent fields are
  not submitted as deletions.

Settings that require the local service remain explicitly simulated on static
Pages. Local browser preferences, four-language rendering, persistence and
the `/Selbstlauf/` entry work there. The Pages build was tested locally;
**no push, remote publication or new release was performed**.

## Final checks

All evidence paths below are relative to
`tmp/settings-verification-20261022/`. These final totals supersede earlier
stage totals in the individual reports.

| Check | Final result | Evidence |
| --- | --- | --- |
| CLI unit suite | 322 total: 311 passed, 11 Windows-specific skipped, 0 failed | `environment/cli-runtime-final.log` |
| Web unit suite | 356 passed across 29 files | `environment/web-drafts-final.log` |
| Browser regression suite | 105 passed | `environment/browser-settings-final.log` |
| Production Pages `/Selbstlauf/` | 4 passed | `environment/pages-settings-final.log` |
| Actual PTY agent/browser flows | 6 passed | `environment/agents-settings-final.log` |
| Desktop unit suite | 171 passed | `environment/desktop-settings-final.log` |
| All workspace production builds | Passed | `environment/build-settings-final.log` |
| Web TypeScript noEmit | Passed | `environment/web-type-final.log` |
| Four-language final WebUI/Pages matrix | Passed; 547 captures with filename manifest | `languages/result.json` |
| Production WebUI with real isolated service | Passed; all 13 sections, real config/Hook/endpoint files and restart | `live/result.json` |
| Real HTTP endpoint editing | Passed; 36 captures | `webui/03-endpoints/result.json` |
| Real signed Harness Dry Run transitions | Passed; 32 captures | `webui/04-dsh-dryrun/result.json` |
| WSL configuration/cache/write policy | Passed; real HTTP, SQLite and read-only fixture probes, 34 captures | `webui/05-wsl-distribution/result.json` |
| Drafts and concurrent service refreshes | Passed; real HTTP and two windows, 28 captures | `webui/05-config-drafts/result.json` |
| Native Windows startup helper | 8 passed; temporary scheduler task removed, existing task unchanged | `startup-task/result.json` |
| Final packaged Windows runtime | 44 passed, 37 successful captures, no renderer errors | `app/locale-runtime-final/locale-verification.log` |
| Exact copy of final installed Windows app | 44 passed, 37 successful captures, no renderer errors | `app/locale-installed-final/locale-verification.log` |

The final language matrix covers both surfaces, four languages, all 13 sections,
light/dark, 1280/390 widths and lower views where scrolling is needed. It also
verifies reload, another browser window, an actual storage refusal and retry,
zero renderer errors, zero Pages local API requests and an empty English UI
Han-text audit. The earlier 558-image run used temporary bundles; the final
547-image manifest describes the current production bundles without stale
images from earlier runs. See [the language report](2026-10-23-languages.md).

Both final native runs verify actual menu/tray translation, OS clipboard,
fullscreen, independent viewers, preference write failure and process restart.
They also exercise actual notification switches, saved timeline restoration,
event limits and pet appearance across pages and windows. Existing real
PowerShell working-directory and close-to-tray evidence, and its platform
limits, are recorded in [the desktop report](2026-10-22-desktop-settings.md).
The scheduler check proves task registration, action and trigger XML; it did
not trigger a real Windows login. WSL probes used disposable fixtures and did
not alter the installed distribution. Upgrade calls have scoped command and
failure tests; no global upgrade was performed.

## Final installation and preserved state

The final installer was built with publication disabled and installed locally
over the existing same-version application:

```text
Installation: C:\Users\han\AppData\Local\Programs\Selbstlauf
Version: 0.9.5
Installer SHA-256:
29e854c96d97589166ede55815ee3497996180d5c5c51aca7707bcc85ebebc93
Installed app.asar SHA-256:
5d2f4fbb365ff6a02a85038c9b958c0aa87f494939196b30713628b9b08329f1
User config SHA-256 before and after:
b9423f6297145f859cba41845d80ae20d25208524b286f378a358082af46229c
```

All **404 packaged files**, including **333 resource files**, match the installed
files byte for byte. A separate comparison confirms all **13 current WebUI
build files** and **89 current CLI build files** match the installed resource
copies. `package-lock.json` retains its original SHA-256. The user's desktop
preference file was absent before and after; no new user preference was created
by validation.

The reinstaller backed up both the prior installation and state under
`C:\Users\han\AppData\Local\Temp\selbstlauf-settings-reinstall-final-20261023`,
restarted the installed app, and confirmed its normal service at
`http://127.0.0.1:48920` with `ok: true`, `running: true`, and the preserved
`dryRun: false`. Installer results and complete file hashes are in
`install-final/reinstall-result.json` and `install-final/resource-hashes.json`.

The installed behavioral verification uses an exact directory copy with its
own process, state, Electron profile and port, checked before any UI action.
User configuration hashes remain unchanged after that run as recorded in
`app/locale-installed-final/installed-evidence.json`.

The actual installed user window was additionally captured read-only through
`PrintWindow PW_RENDERFULLCONTENT`: PID **41812**, HWND **12460006**, version
**0.9.5**. No focus, visibility or preference was changed. The image shows the
preserved dark/pink appearance and live monitoring. The PNG and ownership
metadata are under `app/installed-readonly-final/installed-window-current.*`.

Representative final captures:

- [Installed user's unchanged window](../../tmp/settings-verification-20261022/app/installed-readonly-final/installed-window-current.png)
- [Installed app Japanese settings at minimum width](../../tmp/settings-verification-20261022/app/locale-installed-final/ja-appearance-light-960.png)
- [Installed app saved timeline after reload](../../tmp/settings-verification-20261022/app/locale-installed-final/preferences-timeline-restored-after-reload.png)
- [Production WebUI General settings](../../tmp/settings-verification-20261022/languages/webui-zh-CN-light-1280-general-top.png)

Screenshots, traces, isolated test state and installer binaries are local
verification artifacts under ignored temporary directories. The committed
reports and scripts describe how the evidence was produced; they do not imply
those artifacts or this application revision are hosted on GitHub Pages.
