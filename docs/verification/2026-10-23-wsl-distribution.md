# WSL distribution switching — 2026-10-23

`8a0b29a` first reproduced the stale cache with real temporary SQLite databases:
A and B use the same working directory but contain `thread-A` and `thread-B`.
After a persisted A → B change, the old controller associated B with
`thread-A`. It also retained the old session/adapter and reused a deleted
snapshot after the same controller stopped and restarted. The initial regression
run passed 1/5 tests and failed those four cases; its log is
`tmp/wsl-cache-before.log`.

`0b4f52f` binds the cached home, database paths and CLI launcher to the selected
distribution. A change closes the previous WSL adapters before deleting their
temporary database copy, removes the old WSL rows, and clears cached errors and
paths. Saving the same trimmed name retains the current cache. The next poll
also detects changes read directly from the persisted config. Shutdown clears
every WSL cache field, so restart resolves a fresh snapshot. Native Codex
sessions remain open and associated.

`configChanged` applies enabled/Dry Run policy immediately, then awaits the
in-flight poll before releasing its SQLite readers. It reapplies the saved
configuration after that boundary so an older configuration load cannot keep
the previous distribution selected. Two additional regressions place a live
automatic-continuation session beyond its idle deadline, block discovery,
save either disabled or Dry Run configuration, and verify zero App Server
initializations, queued prompts or started turns.
An isolated mutation of the temporary compiled file removed the immediate
policy assignment; both new cases then failed with two attempted prompt writes
instead of zero. The compiled file was restored. This confirms those tests
exercise the timing defect, rather than only checking final saved state
(`tmp/wsl-cache-policy-mutation.log`).

All checks used `scripts/verify/in-conda.sh` with conda
`selbstlauf-settings-20261022`, actual Node 22.23.2 and the existing lockfile.
TypeScript compiled to `tmp/wsl-settings-testbuild`; no packaged build directory
was overwritten. The six initial WSL cases and related runtime, DSH transport,
WSL discovery, attribution and snapshot suites passed **81/81**. The final WSL
suite with the two write-policy regressions passed **8/8**.

`scripts/verify/settings-wsl-live.mjs` serves the existing production
`apps/web/dist` through a real `WatchdogHttpServer` on an isolated random
loopback port. It uses actual `ConfigStore`, controller and local SQLite
snapshots; injected WSL probes only report disposable fixture distributions.
The browser saves disabled → Fixture-A → Fixture-B → disabled through the real
HTTP config endpoint. Each layout verifies the selected name, the matching
conversation, refresh/reload persistence, both old snapshots removed, and the
native conversation retained. App Server startup and prompt/turn methods are
guarded and the observed counts are zero. No installed WSL distribution or
user configuration was contacted, and no real continuation was sent.

The light/dark × 1280/390 matrix passed all four groups and produced **34 PNGs**,
including each saved selection, A/B overview, B reload, disabled/native overview
and extra narrow-screen cards/sidebars. Screenshots and machine-readable
origins, artifact hash, probe calls and associations are in
`tmp/settings-verification-20261022/webui/05-wsl-distribution/`. Manual inspection
confirmed the narrow sidebar shows `Fixture-B` with `thread-B`, while the wide
settings view shows the saved distribution without overflow. This verifies the
runtime/config boundary with isolated probes; it does not claim a live WSL
installation was changed or a remote Pages deployment was published.
