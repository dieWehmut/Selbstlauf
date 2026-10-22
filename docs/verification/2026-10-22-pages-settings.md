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
