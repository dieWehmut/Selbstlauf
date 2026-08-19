# Claude/Codex Continuation Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor every discoverable Claude Code and Codex process independently and safely submit a configurable continuation after a verified quiet period, with a local management UI and reversible Windows installation.

**Architecture:** A Node.js 22 service owns the watchdog state machine, process discovery, policy, persistence, and loopback HTTP/SSE API. Windows PowerShell provides a fail-closed classic-console bridge; service-owned PTYs and Codex App Server are additional transports. A Vite/React UI consumes the API and renders process capability, timing, policy, and audit state. Existing bypass entry points remain as compatibility shims while scripts move under responsibility-based directories.

**Tech Stack:** Node.js 22 ESM, TypeScript, built-in `node:test`/`node:sqlite`, Windows PowerShell 5.1, Vite, React, `lucide-react`, CSS, and Playwright for browser acceptance.

---

## Task 1: Bootstrap the workspace and domain contract

**Files:**
- Create: `package.json`
- Create: `apps/watchdog/package.json`
- Create: `apps/watchdog/tsconfig.json`
- Create: `apps/watchdog/src/domain/types.ts`
- Create: `apps/watchdog/src/domain/config.ts`
- Create: `apps/watchdog/src/domain/policy.ts`
- Create: `apps/watchdog/test/config.test.ts`
- Create: `apps/watchdog/test/policy.test.ts`

- [ ] **Step 1: Add the failing config and policy tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, parseConfig } from '../src/domain/config.js';
import { chooseCodexPrompt } from '../src/domain/policy.js';

test('rejects a non-positive timeout and preserves the caller error', () => {
  assert.throws(() => parseConfig({ ...defaultConfig, defaultIdleTimeoutMs: 0 }), /idleTimeoutMs/);
});

test('routes resumable Codex goals to the goal command', () => {
  assert.equal(chooseCodexPrompt({ status: 'paused' }, defaultConfig.tools.codex), '/goal resume');
});

test('routes a missing goal to the configured normal prompt', () => {
  assert.equal(chooseCodexPrompt(null, defaultConfig.tools.codex), '继续');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "config|routes"`
Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement the minimal typed contract**

Define `ToolName`, `GoalStatus`, `TransportKind`, `SessionSnapshot`, `WatchdogConfig`, and `AuditEvent` in `types.ts`. Export a frozen `defaultConfig`, a `parseConfig` validator that rejects unknown tool names and non-positive durations, and `chooseCodexPrompt` that returns `goalPrompt` only for `active`/`paused` statuses and returns `normalPrompt` otherwise.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "config|routes"`
Expected: all focused tests pass with no warnings.

- [ ] **Step 5: Commit the domain slice**

```powershell
git add package.json apps/watchdog
git commit -m "feat: add continuation watchdog domain contract"
```

## Task 2: Implement the quiet-period state machine

**Files:**
- Create: `apps/watchdog/src/engine/watchdog.ts`
- Create: `apps/watchdog/src/engine/session-state.ts`
- Create: `apps/watchdog/test/watchdog.test.ts`

- [ ] **Step 1: Write failing timing and duplicate-suppression tests**

```ts
test('does not inject while output is recent', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });
  engine.observeOutput('s1', 1_000);
  assert.deepEqual(engine.tick(1_050), []);
});

test('injects once after quiet time and waits for new output', () => {
  const engine = new WatchdogEngine({ idleTimeoutMs: 100, cooldownMs: 500 });
  engine.observeOutput('s1', 1_000);
  assert.deepEqual(engine.tick(1_101).map((x) => x.sessionId), ['s1']);
  assert.deepEqual(engine.tick(1_202), []);
  engine.observeOutput('s1', 1_250);
  assert.deepEqual(engine.tick(1_351).map((x) => x.sessionId), ['s1']);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "quiet|injects"`
Expected: FAIL because `WatchdogEngine` is missing.

- [ ] **Step 3: Implement deterministic state transitions**

Store `lastActivityAt`, `lastInjectionAt`, `pending`, `attempts`, `paused`, and `lastDecision` per session. `tick(now)` returns immutable injection intents only when all safety predicates pass. `observeOutput` clears `pending` and resets attempts. A transport error leaves the intent uncommitted and records a retry-after timestamp.

- [ ] **Step 4: Verify GREEN and edge cases**

Add tests for paused sessions, process exit, clock rollback, cooldown, and max attempts. Run: `npm --workspace apps/watchdog test`.

- [ ] **Step 5: Commit the engine slice**

```powershell
git add apps/watchdog/src/engine apps/watchdog/test/watchdog.test.ts
git commit -m "feat: add quiet-period watchdog state machine"
```

## Task 3: Discover and group Windows processes

**Files:**
- Create: `apps/watchdog/src/process/process-provider.ts`
- Create: `apps/watchdog/src/process/discovery.ts`
- Create: `apps/watchdog/src/process/windows-processes.ps1`
- Create: `apps/watchdog/test/discovery.test.ts`

- [ ] **Step 1: Add fixture-driven failing discovery tests**

Feed a fixture containing a Claude Node root, its shell parent, two Codex Node/native pairs, and an unrelated Node process. Assert that the result has three logical sessions, that native children are attached to their root, and that a different-user record is excluded.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "group|different-user"`
Expected: FAIL because the provider and grouping functions are missing.

- [ ] **Step 3: Implement the PowerShell JSON provider**

`windows-processes.ps1` must query `Win32_Process`, call `GetOwner()` for the SID, and emit only JSON fields `{pid,parentPid,name,commandLine,executablePath,creationDate,userSid}`. The Node provider invokes it with `-NoProfile -NonInteractive`, parses one JSON document, and converts dates to epoch milliseconds.

- [ ] **Step 4: Implement deterministic grouping and tool detection**

Recognize Claude by `claude-code`, `claude.ps1`, or configured executable names; recognize Codex by `@openai/codex`, `codex.js`, or `codex.exe`. Walk parent links to choose the oldest matching root and attach matching native children. Keep ambiguous roots as separate records with `transport: 'unknown'`.

- [ ] **Step 5: Run tests and commit**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "discovery|group"`

```powershell
git add apps/watchdog/src/process apps/watchdog/test/discovery.test.ts
git commit -m "feat: discover and group Claude and Codex processes"
```

## Task 4: Add the Windows ConsoleBridge and transports

**Files:**
- Create: `native/windows/ConsoleBridge.ps1`
- Create: `apps/watchdog/src/transport/console-bridge.ts`
- Create: `apps/watchdog/src/transport/transport.ts`
- Create: `apps/watchdog/src/transport/pty-transport.ts`
- Create: `apps/watchdog/test/transport.test.ts`

- [ ] **Step 1: Write failing bridge contract tests**

Use a fake bridge executable and assert that `probe(pid)` returns `classic-console`, that `write(pid, '继续')` sends exactly one text sequence plus Enter, and that a failed attach returns `cannot-inject` without retrying through a global key API.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "bridge|cannot-inject"`
Expected: FAIL because transport modules are missing.

- [ ] **Step 3: Implement `ConsoleBridge.ps1`**

Add an `Add-Type` C# definition for `FreeConsole`, `AttachConsole`, `GetConsoleProcessList`, `CreateFile`, `WriteConsoleInputW`, `ReadConsoleOutputCharacterW`, and `GetConsoleScreenBufferInfo`. Accept `probe`, `snapshot`, and `write` commands as JSON lines, detach before each attach, return structured errors, and always free the console in `finally`.

- [ ] **Step 4: Implement Node transport adapters**

`ConsoleTransport` spawns the bridge with an argument-safe JSON payload and exposes `probe`, `activityFingerprint`, and `write`. `PtyTransport` wraps a service-owned child stream behind the same interface. No adapter may call `SendKeys`, `SendInput`, or write to a process without a validated PID.

- [ ] **Step 5: Verify bridge behavior on Windows and commit**

Run: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File native/windows/ConsoleBridge.ps1 -SelfTest`
Expected: `ConsoleBridge self-test passed`.

Run: `npm --workspace apps/watchdog test`.

```powershell
git add native/windows apps/watchdog/src/transport apps/watchdog/test/transport.test.ts
git commit -m "feat: add fail-closed Windows console transports"
```

## Task 5: Associate Codex threads, goals, and activity

**Files:**
- Create: `apps/watchdog/src/codex/sqlite-state.ts`
- Create: `apps/watchdog/src/codex/thread-association.ts`
- Create: `apps/watchdog/src/codex/app-server.ts`
- Create: `apps/watchdog/src/codex/codex-adapter.ts`
- Create: `apps/watchdog/test/codex-adapter.test.ts`

- [ ] **Step 1: Write failing goal-routing and ambiguity tests**

Use a temporary SQLite database with the production `thread_goals` schema. Assert `active` and `paused` map to `/goal resume`, absent rows map to the normal prompt, terminal statuses are skipped, and two equally recent threads produce `unknown` rather than a guessed association.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "goal|ambiguous"`
Expected: FAIL because the Codex adapter is missing.

- [ ] **Step 3: Implement read-only SQLite access**

Use Node 22 `node:sqlite` `DatabaseSync` in read-only URI mode. Parameterize every thread ID and return `{status,updatedAtMs}` only. Never copy rollout contents or credentials into watchdog state. Add a clear `unsupported-runtime` error when `node:sqlite` is unavailable.

- [ ] **Step 4: Implement process-to-thread matching and rollout activity**

Extract UUIDs after `resume` from command lines. For initial commands, match normalized `cwd`, creation time, and the active thread index; return ambiguity explicitly. Track the associated rollout file's size/mtime and thread turn status as activity signals.

- [ ] **Step 5: Implement the App Server JSON-RPC transport**

Start one local `codex app-server --listen stdio://` child lazily. Send `initialize`/`initialized`, then `thread/resume`, `thread/list`, and `turn/start` requests with request IDs. Parse notifications, ignore unknown methods, reject concurrent turns, and close the child on service shutdown. The adapter records whether each injection used App Server versus Console.

- [ ] **Step 6: Run tests and commit**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "Codex|goal|thread"`.

```powershell
git add apps/watchdog/src/codex apps/watchdog/test/codex-adapter.test.ts
git commit -m "feat: route Codex continuation by goal and thread state"
```

## Task 6: Add Claude association, persistence, and service API

**Files:**
- Create: `apps/watchdog/src/claude/claude-adapter.ts`
- Create: `apps/watchdog/src/store/config-store.ts`
- Create: `apps/watchdog/src/store/audit-store.ts`
- Create: `apps/watchdog/src/server/http-server.ts`
- Create: `apps/watchdog/src/index.ts`
- Create: `apps/watchdog/test/http-server.test.ts`
- Create: `scripts/continuation/start-watchdog.ps1`
- Create: `scripts/continuation/stop-watchdog.ps1`

- [ ] **Step 1: Write failing API tests**

Start the server on an ephemeral loopback port with fake discovery and transport dependencies. Assert `GET /api/health`, config validation via `PUT /api/config`, `GET /api/sessions`, SSE event delivery, pause/resume, manual injection, and loopback-only binding.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog test -- --test-name-pattern "API|SSE|loopback"`
Expected: FAIL because the HTTP server is missing.

- [ ] **Step 3: Implement Claude session association**

Resolve a unique Claude session JSONL by project path and recent process creation. Use file size/mtime as an activity signal. Expose `monitor-only` when no unique session or writable Console/PTY transport exists. Never run a relaunch automatically.

- [ ] **Step 4: Implement atomic stores and redacted audit events**

Write config to a temporary sibling and replace atomically. Store only session metadata, prompt text, status, and timestamps. Redact token-like values and absolute credential paths from audit details.

- [ ] **Step 5: Implement HTTP/SSE routes and lifecycle**

Use Node's `http` module, strict JSON size limits, origin checks, and loopback binding. Broadcast session/config/audit changes over SSE. `start-watchdog.ps1` launches the Node entry point with a PID file; `stop-watchdog.ps1` validates the PID belongs to this service before stopping it.

- [ ] **Step 6: Run tests and commit**

Run: `npm --workspace apps/watchdog test`.

```powershell
git add apps/watchdog/src apps/watchdog/test/http-server.test.ts scripts/continuation
git commit -m "feat: expose watchdog service and local control API"
```

## Task 7: Build the responsive management WebUI

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/components/{Header,ProcessTable,SessionCard,EventTimeline,SettingsPanel,CapabilityBadge}.tsx`
- Create: `apps/web/src/styles/index.css`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/test/App.test.tsx`
- Create: `apps/web/playwright.config.ts`

- [ ] **Step 1: Add failing UI tests**

Render fixture sessions and assert that each PID appears, goal/non-goal next actions differ, an unavailable transport shows a non-actionable state, the pause and inject buttons call the API, and settings persist after reload.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/web test`
Expected: FAIL because the React app is missing.

- [ ] **Step 3: Implement the operational dashboard**

Use semantic tables on desktop and stacked session cards below 760px. Include live SSE updates, an explicit dry-run indicator, status/capability badges, exact pending prompt text, and a global emergency stop. Use Lucide icons with accessible labels/tooltips for actions.

- [ ] **Step 4: Apply the reference-inspired visual system**

Adapt the sidebar/drawer and theme token approach from `prompt/dieWehmut.github.io`; adapt dense timeline, status chips, settings panel, and terminal treatment from `prompt/Glimmer`. Keep original CSS and assets, use stable dimensions, avoid decorative blobs/gradients, and ensure light/dark contrast and mobile overflow are tested.

- [ ] **Step 5: Build and run browser tests**

Run: `npm --workspace apps/web run build`; then `npx playwright test --config apps/web/playwright.config.ts` against the local service. Capture desktop `1440x900` and mobile `390x844` screenshots and assert the session table/cards are nonblank and non-overlapping.

- [ ] **Step 6: Commit the UI slice**

```powershell
git add apps/web
git commit -m "feat: add continuation watchdog management UI"
```

## Task 8: Organize scripts, install/uninstall, docs, and integration

**Files:**
- Move/Create: `scripts/install/windows/*`, `scripts/install/linux/*`, `scripts/uninstall/windows/*`, `scripts/uninstall/linux/*`
- Modify: root `install-*.ps1`, `uninstall-*.ps1`, `install-*.sh`, `reset-*.sh` compatibility shims
- Modify: `README.md`, `docs/README.en.md`, `docs/README.zh-TW.md`
- Modify: `tests/Test-Documentation.ps1`, `tests/Test-WindowsScripts.ps1`
- Create: `scripts/continuation/install-watchdog.ps1`
- Create: `scripts/continuation/uninstall-watchdog.ps1`

- [ ] **Step 1: Add failing layout and documentation checks**

Require the new directories, root compatibility entry points, documented start/stop/UI URLs, configurable prompts, process-level limitations, and uninstall ownership boundaries.

- [ ] **Step 2: Verify RED**

Run: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1`
Expected: FAIL on the missing watchdog sections and directory assertions.

- [ ] **Step 3: Move scripts without breaking public URLs**

Use `git mv` for responsibility-based directories. Root files remain tiny forwarding wrappers that preserve existing raw GitHub URLs and parameter behavior. Keep `scripts/windows/AiCliBypass.ps1` as a forwarding-compatible core path used by existing tests and remote installers.

- [ ] **Step 4: Add reversible watchdog installation**

The installer creates `%LOCALAPPDATA%\\ai-cli-bypass\\continuation`, writes validated defaults, optionally registers a per-user Scheduled Task only when `-Startup` is supplied, and records owned paths in a manifest. The uninstaller stops the service, removes the task only if the manifest owns it, deletes owned files, and leaves npm packages and bypass state untouched.

- [ ] **Step 5: Update documentation and run existing suites**

Document process discovery, classic Console/App Server/ConPTY capability states, default prompts, safety warnings, WebUI commands, and uninstall behavior in all three README variants. Run the Windows and shell suites plus `git diff --check`.

- [ ] **Step 6: Commit the organization slice**

```powershell
git add scripts install-*.ps1 uninstall-*.ps1 README.md docs tests
git commit -m "docs: organize scripts and document watchdog lifecycle"
```

## Task 9: Full verification and integration review

**Files:**
- Verify all changed files and generated build output

- [ ] **Step 1: Run the complete test matrix**

```powershell
npm test
npm run build
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-WindowsScripts.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Documentation.ps1
bash .\tests\test_claude.sh
git diff --check
```

Expected: every command exits zero, with no untracked generated files.

- [ ] **Step 2: Exercise real read-only process discovery**

Run the service with dry-run enabled, verify the current Claude/Codex process list appears with distinct PIDs and Codex goal statuses, and confirm no audit event contains an injection while dry-run is active.

- [ ] **Step 3: Exercise a safe classic-console fixture**

Launch two fake interactive processes in separate consoles, wait past a 1-second test timeout, verify each receives only its own configured prompt, then produce output and verify no second prompt is sent during cooldown.

- [ ] **Step 4: Review requirements and branch history**

Check every requirement in the design spec against a test or runtime artifact. Ensure each delivery branch has focused commits, no subagent changed unrelated files, and compatibility entry points still resolve.

- [ ] **Step 5: Request final code review and integrate**

Dispatch a spec-compliance reviewer first, then a code-quality reviewer. Resolve all important findings, merge the feature branches into the integration branch, rerun the complete matrix, and only then offer the finishing-branch options.
