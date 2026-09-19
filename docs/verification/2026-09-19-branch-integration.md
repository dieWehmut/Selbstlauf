# Continuation branch integration — 2026-09-19

The continuation resumed from session `01a0b3ad-6076-7fa1-aae8-e728e769d143`
at `9aedb41`. The appearance and environment work was on local `main`, 33
commits ahead of `origin/main`, but eight older branches were not ancestors.

## Audit before merging

The following original/main commit pairs were independently compared with
`git show --format= <commit> | git patch-id --stable`. All 24 pairs match.
Branch names below have the `feature/continuation-` prefix.

| Branch | Original → main commits | Integration evidence |
| --- | --- | --- |
| codex | `9bb0a57` → `6e5ce1e`; `9d42faf` → `6399143` | Thread association and App Server transport already present |
| console | `b30d74c` → `649bd3a`; `b831b24` → `b1217a8` | Domain contract and console transport already present |
| domain | `7a61b96` → `649bd3a`; `a6495f4` → `b5f974e` | Quiet-period state machine already present |
| service | `cf017ed` → `5df6487`; `e7479f5` → `ca5ea88` | Service API, stores and isolated launcher pipes already present |
| layout | `5590d46` → `478bcc4`; `de3928a` → `0e6d71c`; `34efcc3` → `8024c15`; `1457745` → `234ebf1` | Organized scripts, executable modes, docs and idempotent remote bootstrap already present |
| webui | `ea16f75` → `3c198d7` | Management UI already present |
| pages | `cd7ae4a` → `4c13ff7`; `497e6aa` → `9f2bb1e`; `7fc14b7` → `bb68f20`; `18dbe55` → `d459666`; `9e0261e` → `238fdbe`; `b1499fc` → `4e7377b`; `51c858d` → `a519bd3`; `0b3653e` → `d625f6d`; `b161af2` → `ebe98aa` | Static demo, deployment, isolation, site URL, responsive UI and browser gate already present; shares the webui commit above |
| discovery | `17774d0` → `bb0f7de`; `c1017c3` → `f2d6de6` | Discovery and process ownership already present; boundary fix required a separate port |

`9a4d09e` moved the watchdog source and test files to `apps/cli` without changing
their contents. The old discovery TypeScript harness (`160832b`) was superseded
by the current root workspace; its old package/lockfile and additional compiler
options were not restored.

## Missing change restored

`3dcf756` had not been carried into the current implementation. Unescaped dots
and substring matching could treat `codexXjs`, `notclaude-code`, or
`@openai/codex-helper` as real agent signatures.

`4ae1edc` restores literal token matching with path boundaries, including the
four existing DeepSeek Harness entry points. Regression checks cover legitimate
Windows/POSIX paths, wrong prefixes, wrong suffixes and near-matching script
names. Existing native executable, ownership and grouping behavior is retained.

After this real code merge, `2e03e76` records the eight legacy branches using an
`ours` ancestry merge. Its tree equals its first parent's tree: it records the
audited original history without reintroducing `apps/watchdog`.

## Other integration findings

- Imported appearance themes now pass through the same normalization as saved
  palettes, including legacy themes without font or layout fields.
- Unimplemented interface languages are disabled and labeled unavailable.
- Narrow appearance rows retain readable labels while the slider shrinks.
- The packaged desktop uses Node/npm from system PATH instead of treating
  `Selbstlauf.exe` as Node. Probe and upgrade execution share the same runner.
- Executable fallback detection searches PATH; version probes use `--version`.
  Unreadable versions remain `unknown` and are excluded from bulk upgrades.
- Slow or failed npm diagnostics no longer block live monitoring or session
  controls. Real monitoring starts with empty data; examples are restricted to
  the static Pages demo.

The runtime and installation gate results are recorded separately in
`2026-09-19-final-verification.md`.
