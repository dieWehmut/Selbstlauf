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

The final run after `7d2759a` passed all 4 browser tests in 24.9 seconds:

- All 13 settings sections rendered at 1440×1000, 820×1000 and 390×844, with no
  page errors or `/api/` requests and no document horizontal overflow.
- Configuration, auto-continuation/tool switches, selected Goal statuses,
  startup, Hook, endpoints, simulated installed versions, display name,
  notifications, reveal permission, pet, plugin prompts and theme survived a
  browser reload. Desktop tray and terminal controls remained disabled in Pages.
- A searched tab stayed reachable by keyboard, and browser access displayed and
  opened the `/Selbstlauf/` application entry.
- Uninstall persisted a stopped/uninstalled demo and removed its startup state;
  a reload still refused startup until reinstall. Reinstall restored the ability
  to start. Older schema-1 preferences without the new installation field kept
  loading with their saved settings.

The final dedicated unit run passed 15/15 cases for persistence, malformed
storage, validation, isolation, installation and keyboard search. An earlier integration run including
`App.test.tsx` passed 96/96. TypeScript and a production Vite build
also passed. Screenshots are in the ignored workspace directory
`tmp/settings-verification-20261022/pages/production/`: all sections at three
widths plus reload, reinstall and keyboard states (49 production captures).
Captures wait for the settings drawer to
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
| General | Master continuation and Claude/Codex/DSH switches, idle/cooldown/poll/attempt timing, four prompts, Harness session window/API permission, Dry Run, Goal states, owner/include/exclude filters and WSL distribution save through the API. Save/install/startup/start-stop/uninstall buttons call lifecycle APIs. | Pages reload checks master/Claude/Goal/poll/prompt/Dry Run; `App.test.tsx` covers prompts, timing bounds, filters, WSL, lifecycle and Harness. Controller uses settings at `runtime/watchdog-controller.ts:425`, `:609`, `:1394`. Tool switches disable the continuation engine while existing processes remain visible. `a18b270` replaces the demo install no-op with persistent installation state and an inverse uninstall. |
| Appearance | System/light/dark theme, accent/background/foreground, UI/content font family and weight, inherited content font, translucent sidebar, density, contrast, import/copy/reset palette. They repaint CSS variables and persist browser preferences. | The later four-language stage enables Simplified Chinese, Traditional Chinese, English and Japanese throughout the rendered UI and accessible labels. The production WebUI/Pages matrix verifies all 13 sections at two widths and both themes, reload, real cross-window changes and rejected language writes with retry. |
| Notifications | In-panel/success/error switches filter notices; retained-event limit trims the timeline to 1–1000. | App tests check visible suppression and event retention; Pages checks success switch/limit after reload. |
| Keyboard shortcuts | Displays the fixed Esc/Ctrl+1/2/3/comma bindings. | App tests exercise navigation. `sections.tsx:445` is an informational table; no custom binding or persistence exists. |
| Profile | Display name appears in the account popup and is saved locally. | App tests prove the popup label; Pages proves reload. Avatar and notes do not exist in the current UI. |
| Pet | Enable and form select control the fixed ornament on every page; session-count changes trigger its bounce. | App tests check presence/bounce; Pages checks enabled/ring reload. |
| Startup and tray | Startup invokes the service installer; close-to-tray and preferred terminal use desktop settings. The terminal button resolves the selected session's service directory and launches the chosen OS terminal. | Pages verifies simulated startup persistence and both desktop controls disabled. Desktop source/tests cover real spawn arguments, unavailable executable errors and tray decisions; different native terminal windows and close behavior require installed-app screenshots. `sections.tsx:610` lists Linux/macOS/Windows choices. |
| Continuation and processes | Claude Hook lease/timeout/enable/install/disable/uninstall plus Codex model/review-model/reasoning/base URL/token and alternative-value application. | Pages proves Hook and base URL reload; App/service tests cover profile/Hook API calls and backing stores. The later explicit-null patch removes cleared active fields while retaining their original assignments as comments and producing checksummed atomic backups. Real isolated HTTP/config tests and 36 production WebUI captures are recorded in `2026-10-22-endpoint-removal.md` and `2026-10-22-web-settings-audit.md`. |
| Import | Theme/config clipboard import, pasted JSON/type selector, file read into draft, explicit text import, saved config download. Invalid JSON and rejected saves report a failure. | Web agent's import unit/browser suite exercises file/download/text/HTTP-400 retry. Pages render captures show the section; the four original Pages tests do not independently download/import a file. |
| Computer control | Reveal permission disables all process reveal buttons and guards the action. | App tests inspect disabling; Pages proves preference reload. Hosted demo focus rejects explicitly. |
| Plugins | Add/remove validated single-line prompts, combined length ≤4096; one-click continuation sends the joined list. | App tests inspect actual supplied API prompt, section tests validate input; Pages proves reload of joined list. |
| Browser | Displays current entry and resolved theme; opens the full repository subpath in a new window. | Production Pages directly checks displayed `/Selbstlauf/` and loaded popup. Desktop `file:` entry still needs installed-app browser-action evidence. |
| About | Project/release links, version/service/loop facts; environment refresh, per-outdated-tool upgrade, bulk upgrades, manual-command expansion/copy. | Pages proves a simulated upgrade survives reload; App/service tests cover refresh/error/copy/upgrade. Tool cards now offer installation for missing tools and upgrade for outdated tools; managed-agent launch errors and manual command guidance are translated. Current cards describe their installed state. Upgrade buttons use `@latest`; no upgrade was invoked on the actual machine during this work. |

The later language and endpoint stages close the previously disabled-language
and endpoint-clearing gaps. Shortcuts remain fixed bindings. Installed native
behavior and the final same-version reinstall remain the root task’s gates;
new remote deployment is outside the authorized local work. The Pages checks
retain their explicit browser-demo boundaries.


## Four-language follow-up and production evidence

`4121d16` adds persisted and synchronized interface languages, `4f36b9a`
updates native desktop preferences/menus, `23b706d` translates the App, and
`0e1621f`/`bbd0001` translate reusable settings, sidebar, agents, process panels
and timeline helpers. The component catalog contains 341 messages in
Traditional Chinese, English and Japanese, keyed by complete source messages.
Dynamic PID/count/file/path values use named parameters. User input, window
names, tokens and process transcripts remain data. `FormattedMessage` inserts
explicit React nodes into complete translated sentences without parsing HTML.
Language changes update xterm accessible names without reconnecting its process.

The scoped component checks passed 139/139 cases across 12 suites: the original
123 component cases, 13 language behavior cases, and 3 catalog gates. The gates
verify complete translations, matching placeholders, shared-key consistency and
literal/FormattedMessage source coverage. TypeScript noEmit passed. Additional
managed-agent error normalization passed the 16 language/catalog cases while
retaining raw command/path diagnostics.

Root’s production gate `scripts/verify/settings-languages.mjs` ran with the same
Node 22 wrapper and separately built `tmp/language-web-build` and
`tmp/language-pages-build`. Its result records **558 captures** of real local
WebUI/HTTP and static Pages at Simplified Chinese, Traditional Chinese, English
and Japanese, light/dark, 1280/390 widths, all 13 sections, top/bottom where
scrolling is needed. Both surfaces retain language on reload, synchronize to a
second actual browser window, preserve the prior locale when storage rejects a
write, and persist a successful retry. There were no page errors, Pages made no
local API requests, the real continuation configuration was unchanged, and the
English settings Han-text audit is `[]`. The result and screenshots are in
`tmp/settings-verification-20261022/languages/`. These are local production
artifacts; the older published GitHub Pages deployment described above was not
changed.

## Pre-bundle theme regression follow-up — 2026-10-23

Two old browser cases used a `/src/main.tsx` route to block the app, which missed
hashed production entries. Their failure snapshots contained the whole React
app, so they did not represent the promised pre-bundle state. The corrected
helper reads the served HTML’s module entry URLs, blocks those actual requests,
asserts every declared entry was blocked and `#root` is empty, and records that
evidence. It retains the original dark/corrupt-palette assertion of no inline
boot color override and separately records the stylesheet’s computed default;
production CSS legitimately supplies `--bg: #000000` before JavaScript runs.

The same six cases passed on isolated strict-port development (4189), production
WebUI (4190), and production Pages `/Selbstlauf/` (4191): **18/18 in 7.1 seconds**.
There are 18 PNG captures and per-case traces/evidence in
`tmp/settings-verification-20261022/pages/theme-boot/`. Production entries
`/assets/index-CYj57UvE.js` and `/Selbstlauf/assets/index-BLoQ1Fp4.js` were blocked
with an empty React root. Manual inspection confirmed the saved pale background
already paints the blank pre-bundle Pages frame and the rendered app keeps it.
No production build output was overwritten and no push/publication was made.
