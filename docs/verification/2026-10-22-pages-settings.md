# Pages settings verification — 2026-10-22

The work uses the new `selbstlauf-settings-20261022` conda environment,
Node 22.23.2 and the existing package lock. Commands run through
`scripts/verify/in-conda.sh` because shell initialization otherwise prepends the
host's Node 24 even inside `conda run`. The initial direct-conda 13-test run is
preliminary; the same tests were rerun successfully with the environment's Node.
No dependency versions or application version were updated.

## Local production artifact

`eb613e7` persists demo settings in `selbstlauf-pages-demo-v1` local storage.
Watchdog configuration uses the live service's `parseConfig`, so invalid JSON
objects, nonpositive timing and terminal Goal statuses are rejected. Startup,
Hook installation, Codex endpoint alternatives, simulated tool versions and
running state survive reload. Sample sessions reset, and injection remains a
dry run even when the saved Dry Run switch is off. Opening a local host reports
that a hosted demo cannot focus a local window. A storage failure rolls back
state and reports an error.

`9f46738` adds a production Pages gate. The command
`scripts/verify/in-conda.sh npm --workspace apps/web run test:pages` builds with
`VITE_STATIC_DEMO=true` and `VITE_BASE_PATH=/Selbstlauf/`, then serves the artifact
from `apps/web/dist-pages` on port 4187. The live bundle packaged by Electron is
still `apps/web/dist`.

The final run at this step passed all 3 browser tests in 21.4 seconds:

- All 13 settings sections rendered at 1440×1000, 820×1000 and 390×844, with no
  page errors or `/api/` requests and no document horizontal overflow.
- Configuration, auto-continuation/tool switches, selected Goal statuses,
  startup, Hook, endpoints, simulated installed versions, display name,
  notifications, reveal permission, pet, plugin prompts and theme survived a
  browser reload. Desktop tray and terminal controls remained disabled in Pages.
- A searched tab stayed reachable by keyboard, and browser access displayed and
  opened the `/Selbstlauf/` application entry.

Unit verification passed 13/13 dedicated cases for persistence, malformed
storage, validation, isolation and keyboard search; an integration run including
`App.test.tsx` passed 96/96. TypeScript and a production Vite build
also passed. Screenshots are in the ignored workspace directory
`tmp/settings-verification-20261022/pages/production/`: all sections at three
widths plus reload and keyboard states. Captures wait for the settings drawer to
close and disable animations so the actual panel is visible.

## Existing deployed site

Read-only GitHub inspection confirmed Pages uses the workflow build type and
the public URL `https://diewehmut.github.io/Selbstlauf/`. The latest successful
deployment run was
[38395614484](https://github.com/dieWehmut/Selbstlauf/actions/runs/38395614484),
created 2026-10-13, at SHA `708f111143dde04e9cbfae6676ee45fd59241a8a`.

Chromium loaded the existing site at desktop and mobile widths on 2026-10-22.
Both responses were HTTP 200 with no page errors. Its bundle was
`/Selbstlauf/assets/index-BKFhxeE4.js`; captures of the overview, general,
continuation, appearance and browser sections are in
`tmp/settings-verification-20261022/pages/remote/`, alongside
`remote-report.json`. This is evidence of the older deployed site, not evidence
that the new settings are deployed. No push or publication was performed.

## Requirement audit of the 13 current settings sections

This inventory describes the current implementation, not a claim that the full
user goal is complete. The production Pages suite proves rendering, browser
persistence and the stated demo boundaries. Live runtime effects require the
corresponding service or installed desktop evidence.

| Section | Controls and implemented effect | Evidence and remaining scope |
| --- | --- | --- |
| General | Master continuation and Claude/Codex/DSH switches, idle/cooldown/poll/attempt timing, four prompts, Harness session window/API permission, Dry Run, Goal states, owner/include/exclude filters and WSL distribution save through the API. Save/install/startup/start-stop/uninstall buttons call lifecycle APIs. | Pages reload checks master/Claude/Goal/poll/prompt/Dry Run; `App.test.tsx` covers prompts, timing bounds, filters, WSL, lifecycle and Harness. Controller uses settings at `runtime/watchdog-controller.ts:425`, `:609`, `:1394`. Tool switches disable the continuation engine; their UI statement about stopping discovery is stronger than the controller implements. Demo `install()` is still a no-op at `static-demo.ts:209`. |
| Appearance | System/light/dark theme, accent/background/foreground, UI/content font family and weight, inherited content font, translucent sidebar, density, contrast, import/copy/reset palette. They repaint CSS variables and persist browser preferences. | Pages proves light-theme reload; App/palette/theme browser tests inspect other tokens and geometry. Locale row at `App.tsx:1790` has only simplified Chinese; traditional Chinese, English and Japanese are disabled. It is not a working language setting. |
| Notifications | In-panel/success/error switches filter notices; retained-event limit trims the timeline to 1–1000. | App tests check visible suppression and event retention; Pages checks success switch/limit after reload. |
| Keyboard shortcuts | Displays the fixed Esc/Ctrl+1/2/3/comma bindings. | App tests exercise navigation. `sections.tsx:445` is an informational table; no custom binding or persistence exists. |
| Profile | Display name appears in the account popup and is saved locally. | App tests prove the popup label; Pages proves reload. Avatar and notes do not exist in the current UI. |
| Pet | Enable and form select control the fixed ornament on every page; session-count changes trigger its bounce. | App tests check presence/bounce; Pages checks enabled/ring reload. |
| Startup and tray | Startup invokes the service installer; close-to-tray and preferred terminal use desktop settings. The terminal button resolves the selected session's service directory and launches the chosen OS terminal. | Pages verifies simulated startup persistence and both desktop controls disabled. Desktop source/tests cover real spawn arguments, unavailable executable errors and tray decisions; different native terminal windows and close behavior require installed-app screenshots. `sections.tsx:610` lists Linux/macOS/Windows choices. |
| Continuation and processes | Claude Hook lease/timeout/enable/install/disable/uninstall plus Codex model/review-model/reasoning/base URL/token and alternative-value application. | Pages proves Hook and base URL reload; App/service tests cover profile/Hook API calls and backing stores. Empty endpoint fields are filtered at `App.tsx:1288`; clearing an existing token/model does not remove it from live config. The profile API has no delete operation. |
| Import | Theme/config clipboard import, pasted JSON/type selector, file read into draft, explicit text import, saved config download. Invalid JSON and rejected saves report a failure. | Web agent's import unit/browser suite exercises file/download/text/HTTP-400 retry. Pages render captures show the section; the three Pages tests do not independently download/import a file. |
| Computer control | Reveal permission disables all process reveal buttons and guards the action. | App tests inspect disabling; Pages proves preference reload. Hosted demo focus rejects explicitly. |
| Plugins | Add/remove validated single-line prompts, combined length ≤4096; one-click continuation sends the joined list. | App tests inspect actual supplied API prompt, section tests validate input; Pages proves reload of joined list. |
| Browser | Displays current entry and resolved theme; opens the full repository subpath in a new window. | Production Pages directly checks displayed `/Selbstlauf/` and loaded popup. Desktop `file:` entry still needs installed-app browser-action evidence. |
| About | Project/release links, version/service/loop facts; environment refresh, per-outdated-tool upgrade, bulk upgrades, manual-command expansion/copy. | Pages proves a simulated upgrade survives reload; App/service tests cover refresh/error/copy/upgrade. `App.tsx:1134` offers install action only for outdated tools, so missing/unknown/current cards cannot install or repair through the UI. Upgrade buttons use `@latest`; no upgrade was invoked on the actual machine during this work. |

Current unsupported locale controls, fixed shortcuts, incomplete endpoint
clearing, missing-tool install UX, simulated/no-op installation, and absent
installed-app/remote-new-version evidence remain explicit audit gaps. The
Pages-only checks cannot close the full app/WebUI/Pages goal by themselves.
