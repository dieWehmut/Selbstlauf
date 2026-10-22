# Explicit Codex endpoint removal — 2026-10-22

`1f80ad4` adds explicit removal throughout the service, HTTP API, browser client
and Pages demo. Read views retain string values. Edit requests accept
`{ key, value: string | null }`: an omitted key stays unchanged and null comments
out every matching active top-level assignment. Existing commented alternatives,
inline labels, source quoting/escapes and nested sections remain intact. Removal
of an already absent key is idempotent, and a parked value can be reactivated.

Every complete patch is validated before mutation. Unknown/duplicate keys,
empty strings, multiline/NUL text and unsupported value types are refused. The
profile store snapshots edits before queueing, keeps uniquely named checksummed
backups even for writes in the same millisecond, retains config permissions and
atomically replaces the file. No-op patches do not create backups. Demo patches
reuse the real parser and preserve untouched active fields across browser reloads.

All checks ran through `scripts/verify/in-conda.sh` in the newly created
`selbstlauf-settings-20261022` environment with the existing lockfile and Node
22.23.2. Application version and installed tools were not upgraded. Compilation
used `tsc -p apps/cli/tsconfig.json --outDir tmp/endpoint-testbuild`; it did not
overwrite `apps/cli/dist` or the desktop's packaged bundle.

`node --test --test-concurrency=1` against the independently compiled
`config-profiles`, `profile-store` and `http-server` test files passed 31/31.
These tests inspect real isolated `config.toml` files and SHA256 backup contents,
send null through a real HTTP server, verify readback and unchanged unrelated
fields, reject invalid removals without any file change, and restore removed
values from comments. Web client/static-demo unit tests passed 19/19, including
JSON null transmission and persisted demo removal.

This first step proves the backend and browser API semantics. UI integration,
production browser screenshots and installed-app verification are separate
requirements and were not yet verified by this step.
