# Four-language settings verification, 2026-10-22–23

The application remains **0.9.5** and Electron remains **44.4.1**. Linux checks
run through `scripts/verify/in-conda.sh` in the newly created
`selbstlauf-settings-20261022` environment, with Node **22.23.2** and Python
**3.12.15**. Windows checks use that conda Node as the orchestrator and the
existing native Windows dependencies. No tool upgrade or dependency update is
part of this verification.

## Implemented behavior

The four language choices, Simplified Chinese, Traditional Chinese, English
and Japanese, now apply to application navigation, all 13 settings sections,
process views, agent windows, timeline labels and native menus/tray actions.
Browser writes apply after storage succeeds. Desktop writes apply after the
native preference file succeeds; browser storage is a cache and cannot undo a
confirmed native setting. Existing saved preferences without a locale default
to Simplified Chinese without resetting the other desktop preferences.

Language changes reach other same-origin browser windows and independent
desktop viewers. Old initial reads and delayed save responses cannot overwrite
newer confirmed language changes. Messages kept by the application retain
their source and named parameters so they update when the language changes.
Paths, tokens, model names, editable prompts, process output and external
diagnostic details retain their original content. Formatted sentences preserve
explicit React nodes such as the PID and prompt; they do not parse HTML.

## Executed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Web unit suite after audit history and config draft fixes | 356 passed in 29 files | `environment/web-drafts-final.log` |
| Language store and translation integrity | 24 passed, including persistence errors, native authority, delayed reads, concurrent responses, first paint, catalog coverage and parameter agreement | `test/i18n.test.tsx`, `test/translation-catalog.test.ts` |
| Browser suite | 105 passed | `environment/browser-settings-final.log` |
| Production Pages `/Selbstlauf/` | 4 passed | `environment/pages-settings-final.log` |
| Real PTY agent/browser flows | 6 passed | `environment/agents-settings-final.log` |
| Desktop unit suite | 171 passed | `environment/desktop-settings-final.log` |
| Initial native Windows language actions | 34 checks, 30 successful screenshots | `app/locale-native/locale-verification.log`, `locale-evidence.json` |
| Final packaged Windows runtime | 44 checks, 37 successful screenshots, including notifications, restored history and pet synchronization | `app/locale-runtime-final/locale-verification.log`, `locale-evidence.json` |
| Final installed Windows app, isolated directory copy | 44 checks, 37 successful screenshots, unchanged actual user configuration | `app/locale-installed-final/locale-verification.log`, `installed-evidence.json` |

All artifact paths in this report are relative to
`tmp/settings-verification-20261022/`.

`scripts/verify/settings-languages.mjs` passed first against separate temporary
production bundles, then against the final `apps/web/dist` and
`apps/web/dist-pages`. After the history and draft fixes, the final result records
**547 captures** and lists every generated filename: both surfaces,
all four locales, 13 sections, light/dark and 1280/390 widths, with lower views
for scrollable sections. It also checks cross-window language changes, reload
persistence, a real browser-storage refusal and retry, zero renderer errors,
unchanged real continuation configuration, and zero local API requests from
Pages. Old verifier-generated images are removed before a run so a prior
scroll-bottom capture cannot inflate the final count. The English settings text
audit is empty. Result and images are under
`languages/`.

Manual inspection included English wide General settings, Traditional Chinese
narrow Notifications and Japanese narrow Hook/endpoint settings. Labels remain
readable, actions remain in the viewport, and the saved Chinese continuation
prompt remains Chinese as user data.

The browser regression initially exposed two harness problems. A second window
sent the settings shortcut before React had mounted its listener; the test now
waits for the overview before sending it and opens only a closed settings
drawer. The theme first-paint test blocked only the development entry, allowing
a production entry to run. It now discovers and blocks the actual HTML module
entries, requires an empty React root, and distinguishes inline theme overrides
from stylesheet defaults. Separate development, production WebUI and Pages
checks passed 18 cases and retain 18 first-paint images and entry-block evidence.

## Separate completion gates

This report proves the language implementation and its scoped checks. The
subsequent runtime fixes for Dry run/Harness authentication and WSL distribution
cache changes, completed same-version Windows package/reinstall, and final
test totals are recorded in [the final settings report](2026-10-23-settings-final.md).
The local production Pages tests do not claim that these commits have been
published to the public site.
