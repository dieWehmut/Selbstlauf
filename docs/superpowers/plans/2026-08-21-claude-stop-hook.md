# Claude Stop Hook Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Windows watchdog continue the uniquely associated current Claude conversation through an opt-in Stop Hook when no trusted Console/PTY transport exists.

**Architecture:** A watchdog-owned JSON lease store is the only coordination channel between the polling controller and the Claude Stop Hook command. The hook validates `session_id`, canonical `cwd`, process identity, transcript activity, expiry, and recursion state before atomically consuming one lease and returning Claude's `decision: "block"` response. User Claude settings are edited only by explicit loopback API/UI actions through a checksum-protected installer that owns one recognizable hook entry.

**Tech Stack:** Node.js 20+, TypeScript/NodeNext, `node:test`, React/Vitest, Windows PowerShell lifecycle scripts, JSON/JSONL files with atomic replacement.

---

## File structure

- `apps/watchdog/src/claude/lease-store.ts`: validates, persists, lists, consumes, and clears per-session continuation leases.
- `apps/watchdog/src/claude/stop-hook.ts`: parses Claude Stop Hook input and produces a fail-closed decision from the lease store.
- `apps/watchdog/src/claude/stop-hook-cli.ts`: bounded UTF-8 stdin/stdout CLI wrapper; all errors produce `{}` and exit zero.
- `apps/watchdog/src/claude/hook-installation.ts`: owns exactly one user-settings Stop Hook command plus its manifest/backup/checksums.
- `apps/watchdog/src/runtime/watchdog-controller.ts`: arms and clears leases while preserving direct transport precedence.
- `apps/watchdog/src/server/http-server.ts`: exposes loopback-only hook status/install/uninstall/disable endpoints.
- `apps/watchdog/src/index.ts`: composes lease store and hook installer with the runtime and lifecycle.
- `apps/watchdog/src/domain/types.ts` and `apps/watchdog/src/domain/config.ts`: add validated disabled-by-default Stop Hook configuration and capability types.
- `apps/web/src/api/client.ts`, `apps/web/src/api/static-demo.ts`, and `apps/web/src/App.tsx`: expose and render hook configuration/status and explicit controls.
- Tests mirror each responsibility in focused files under `apps/watchdog/test` and `apps/web/test`.

## Delivery rule

Execute tasks inline and sequentially because the user explicitly requested single-threaded work. Each task uses its own `feature/continuation-claude-*` branch/worktree, starts from the latest `origin/main`, follows red-green-refactor, is pushed, then is fast-forward merged into `main`, regression-tested, and pushed immediately before the next task begins.

### Task 1: Validated Stop Hook configuration

**Files:**

- Modify: `apps/watchdog/src/domain/types.ts`
- Modify: `apps/watchdog/src/domain/config.ts`
- Modify: `apps/watchdog/test/config.test.ts`

- [ ] **Step 1: Write failing default and validation tests**

Add tests that assert this exact public shape and validation:

```ts
assert.deepEqual(defaultConfig.tools.claude.stopHook, {
  enabled: false,
  leaseTtlMs: 15_000,
  commandTimeoutMs: 1_500,
});

const parsed = parseConfig({
  ...defaultConfig,
  tools: {
    ...defaultConfig.tools,
    claude: {
      ...defaultConfig.tools.claude,
      stopHook: { enabled: true, leaseTtlMs: 20_000, commandTimeoutMs: 2_000 },
    },
  },
});
assert.equal(parsed.tools.claude.stopHook.enabled, true);
```

Also assert that zero, non-finite, or non-integer durations identify the exact `tools.claude.stopHook.*` setting.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace apps/watchdog run build --silent && node --test apps/watchdog/dist/test/config.test.js`

Expected: TypeScript or assertion failure because `stopHook` is absent.

- [ ] **Step 3: Implement the minimal frozen schema**

Add:

```ts
export interface ClaudeStopHookConfig {
  readonly enabled: boolean;
  readonly leaseTtlMs: number;
  readonly commandTimeoutMs: number;
}

export interface ClaudeToolConfig {
  readonly enabled: boolean;
  readonly normalPrompt: string;
  readonly stopHook: ClaudeStopHookConfig;
}
```

Parse each duration with positive-integer validation and keep the default disabled.

- [ ] **Step 4: Run focused and complete watchdog tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass.

- [ ] **Step 5: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/domain/types.ts apps/watchdog/src/domain/config.ts apps/watchdog/test/config.test.ts
git commit -m "feat: configure Claude stop hook"
git push -u origin feature/continuation-claude-config
```

Fast-forward merge on `main`, rerun `npm test`, push `origin main`, and verify `git ls-remote origin refs/heads/main` equals local `HEAD`.

### Task 2: One-shot per-session lease store

**Files:**

- Create: `apps/watchdog/src/claude/lease-store.ts`
- Create: `apps/watchdog/test/claude-lease-store.test.ts`

- [ ] **Step 1: Write failing lease tests**

Use a temporary path and construct leases through this API:

```ts
const store = new ClaudeLeaseStore(join(root, 'claude-leases.json'), { now: () => clock });
await store.arm({
  sessionId: 'session-a',
  cwd: 'C:\\work\\A',
  prompt: '继续',
  rootPid: 100,
  processStartedAtMs: 1_000,
  activity: { size: 20, mtimeMs: 2_000 },
  ttlMs: 15_000,
});
const consumed = await store.consume({
  sessionId: 'session-a',
  cwd: 'c:/work/a/',
  activity: { size: 20, mtimeMs: 2_000 },
});
assert.equal(consumed?.prompt, '继续');
assert.equal(await store.consume(/* identical input */), null);
```

Separate tests prove exact session isolation, cwd normalization, expiry cleanup, changed transcript activity invalidation, malformed/overlong identity rejection, ambiguity fail-closed, `clearSession`, and `clearAll`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace apps/watchdog run build --silent`

Expected: module-not-found error for `src/claude/lease-store.ts`.

- [ ] **Step 3: Implement atomic storage and consumption**

Use a schema-versioned document:

```ts
interface ClaudeLeaseDocument {
  readonly schemaVersion: 1;
  readonly leases: readonly ClaudeContinuationLease[];
}
```

Serialize mutations in one in-process promise queue, write a random temporary file with mode `0o600`, and atomically replace the destination. `consume()` removes the exact matching lease before returning it. The stored prompt must pass `isValidPromptText`; identity strings have bounded lengths and no NUL/newlines.

- [ ] **Step 4: Run focused and complete watchdog tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass, including concurrent one-shot consumption.

- [ ] **Step 5: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/claude/lease-store.ts apps/watchdog/test/claude-lease-store.test.ts
git commit -m "feat: persist Claude continuation leases"
git push -u origin feature/continuation-claude-leases
```

Merge and verify using the delivery rule.

### Task 3: Fail-closed Stop Hook decision and CLI

**Files:**

- Create: `apps/watchdog/src/claude/stop-hook.ts`
- Create: `apps/watchdog/src/claude/stop-hook-cli.ts`
- Modify: `apps/watchdog/package.json`
- Create: `apps/watchdog/test/claude-stop-hook.test.ts`

- [ ] **Step 1: Write failing pure-decision tests**

Exercise this API with a real temporary lease store:

```ts
const decision = await decideClaudeStopHook(store, {
  hook_event_name: 'Stop',
  session_id: 'session-a',
  cwd: 'C:\\work\\a',
  transcript_path: transcript,
  stop_hook_active: false,
  last_assistant_message: 'ignored',
});
assert.deepEqual(decision, {
  decision: 'block',
  reason: '继续',
  systemMessage: 'Continuation watchdog submitted a follow-up.',
});
```

Separate tests require `{}` for `stop_hook_active`, non-Stop events, malformed fields, missing store, expired lease, changed transcript stat, and a second invocation.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog run build --silent`

Expected: module-not-found errors for the hook modules.

- [ ] **Step 3: Implement pure decision logic**

Accept `unknown`, validate only the fields used, stat the transcript without reading contents, and delegate the atomic match to `ClaudeLeaseStore.consume`. Catch all filesystem/store errors and return `{}`.

- [ ] **Step 4: Write failing CLI process tests**

Spawn `node dist/src/claude/stop-hook-cli.js --lease-file <temp>` with a single JSON document on stdin. Assert valid output is one JSON line; oversized, malformed, or unrelated input emits `{}` and exits code zero. Assert stderr never contains prompt, transcript content, settings content, or tokens.

- [ ] **Step 5: Implement bounded CLI wrapper**

Read at most 64 KiB from stdin, require exactly one JSON document, write `${JSON.stringify(decision)}\n`, and set no non-zero exit code for operational/malformed input. Export a `claude-stop-hook` package script that forwards CLI arguments.

- [ ] **Step 6: Run focused and complete watchdog tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass.

- [ ] **Step 7: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/claude apps/watchdog/test/claude-stop-hook.test.ts apps/watchdog/package.json
git commit -m "feat: add Claude stop hook command"
git push -u origin feature/continuation-claude-hook-cli
```

Merge and verify using the delivery rule.

### Task 4: Runtime lease arming and per-session capability

**Files:**

- Modify: `apps/watchdog/src/domain/types.ts`
- Modify: `apps/watchdog/src/runtime/watchdog-controller.ts`
- Modify: `apps/watchdog/src/index.ts`
- Modify: `apps/watchdog/test/runtime-controller.test.ts`
- Modify: `apps/watchdog/test/http-server.test.ts` only if the extended view type requires fixture updates

- [ ] **Step 1: Write failing runtime tests**

Inject a temporary `ClaudeLeaseStore` into `WatchdogController`. Prove:

```ts
assert.equal(session.transport, 'claude-stop-hook');
assert.equal(session.transportError, undefined);
```

after an untrusted Console probe but a unique `session_id`, enabled/installed Hook capability, and quiet automatic decision. Consume the lease and assert its prompt/PID/session identity. Separate tests prove direct Console/PTY precedence, no lease in dry-run, no lease for ambiguous association, and synchronous lease clearing on pause, stop, process exit, and config disable.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog run build --silent`

Expected: missing `claudeLeaseStore` option and `claude-stop-hook` transport type.

- [ ] **Step 3: Implement minimal controller integration**

Add `claude-stop-hook` to the transport union. Inject the store plus a `claudeHookInstalled()` status dependency. Direct transports remain first. For eligible quiet Claude sessions, arm one lease and record injection success only after `arm()` succeeds. Pause/stop/exit/disable call `clearSession` or `clearAll` before returning. Manual injection uses the same lease path when direct transport is absent.

- [ ] **Step 4: Compose the store in the process entrypoint**

Create `claude-leases.json` under the existing state directory, include it in the installation-owned path list, and pass it to the controller. The hook-installed dependency remains false until Task 5 supplies the installer status.

- [ ] **Step 5: Run focused and complete tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass.

- [ ] **Step 6: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/domain/types.ts apps/watchdog/src/runtime/watchdog-controller.ts apps/watchdog/src/index.ts apps/watchdog/src/lifecycle/installation.ts apps/watchdog/test
git commit -m "feat: arm Claude hook leases per session"
git push -u origin feature/continuation-claude-runtime
```

Merge and verify using the delivery rule.

### Task 5: Owned Claude settings installation

**Files:**

- Create: `apps/watchdog/src/claude/hook-installation.ts`
- Create: `apps/watchdog/test/claude-hook-installation.test.ts`
- Modify: `apps/watchdog/src/lifecycle/installation.ts`
- Modify: `apps/watchdog/src/index.ts`

- [ ] **Step 1: Write failing installer tests with temporary settings**

Construct:

```ts
const installer = new ClaudeHookInstallation({
  settingsPath: join(root, '.claude', 'settings.json'),
  stateDirectory: join(root, 'ai-cli-bypass', 'continuation'),
  hookCommand: `node "${hookCli}" --lease-file "${leaseFile}"`,
});
```

Assert install creates one recognizable `hooks.Stop` command and a schema-versioned ownership manifest; second install is idempotent; unrelated hooks and settings remain byte-semantically intact; malformed JSON is not modified; uninstall removes only the owned entry; checksum conflict returns `manualReviewRequired: true` without overwriting user changes; missing settings starts from `{}`.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog run build --silent`

Expected: module-not-found error for the installer.

- [ ] **Step 3: Implement checksum-protected ownership**

Use SHA-256 for pre/post checksums, an ownership manifest under the watchdog state directory, a first-install backup, and atomic JSON replacement. The owned command includes a stable marker argument `--owner selbstlauf-continuation-v1`. Parse and modify only `hooks.Stop`; never log settings values.

- [ ] **Step 4: Integrate lifecycle status**

Expose `status()`, `install()`, and `uninstall()` from process composition. Mark `installed` only when the exact owned command exists and matches the manifest. Extend watchdog uninstall to invoke Claude hook uninstall before deleting watchdog-owned state, preserving settings on manual-review conflict.

- [ ] **Step 5: Run focused and complete watchdog tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass.

- [ ] **Step 6: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/claude/hook-installation.ts apps/watchdog/src/lifecycle/installation.ts apps/watchdog/src/index.ts apps/watchdog/test/claude-hook-installation.test.ts
git commit -m "feat: own Claude stop hook installation"
git push -u origin feature/continuation-claude-install
```

Merge and verify using the delivery rule.

### Task 6: Loopback Hook API

**Files:**

- Modify: `apps/watchdog/src/server/http-server.ts`
- Modify: `apps/watchdog/src/index.ts`
- Modify: `apps/watchdog/test/http-server.test.ts`

- [ ] **Step 1: Write failing endpoint tests**

Supply a lifecycle fixture with `claudeHookStatus`, `installClaudeHook`, `uninstallClaudeHook`, and `disableClaudeHook`. Assert:

```ts
assert.deepEqual((await request(base, '/api/claude-hook')).json, {
  installed: false,
  enabled: false,
  restartRequired: false,
  manualReviewRequired: false,
});
```

Assert all three POST endpoints require a loopback origin, invoke exactly one lifecycle action, append a redacted audit event, publish `claude-hook`, clear leases, and return status. Missing lifecycle methods return 501.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/watchdog run build --silent && node --test apps/watchdog/dist/test/http-server.test.js`

Expected: 404 responses for `/api/claude-hook`.

- [ ] **Step 3: Implement endpoint and lifecycle contract**

Add the typed status/action methods, routes, audit events, and SSE publication. `disable` updates only `tools.claude.stopHook.enabled=false`; install does not silently enable it, and status derives `enabled` from validated config.

- [ ] **Step 4: Run focused and complete watchdog tests**

Run: `npm --workspace apps/watchdog test`

Expected: all watchdog tests pass.

- [ ] **Step 5: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/src/server/http-server.ts apps/watchdog/src/index.ts apps/watchdog/test/http-server.test.ts
git commit -m "feat: expose Claude hook lifecycle API"
git push -u origin feature/continuation-claude-api
```

Merge and verify using the delivery rule.

### Task 7: WebUI configuration and explicit controls

**Files:**

- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/static-demo.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/test/client.test.ts`
- Modify: `apps/web/test/App.test.tsx`
- Modify: `apps/web/test/static-demo.test.ts`

- [ ] **Step 1: Write failing API-client tests**

Assert the client calls `GET /api/claude-hook`, `POST /api/claude-hook/install`, `POST /api/claude-hook/uninstall`, and `POST /api/claude-hook/disable`, and that the config type requires `stopHook.enabled`, `leaseTtlMs`, and `commandTimeoutMs`.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/web test -- --run test/client.test.ts`

Expected: missing client methods/type fields.

- [ ] **Step 3: Implement client and static demo state**

Add `ClaudeHookStatusView` and the four API methods. Keep the Pages demo non-mutating outside memory and show installation/restart states realistically.

- [ ] **Step 4: Write failing component tests**

Assert Settings renders a disabled-by-default “Claude Stop Hook” card, duration inputs, install/uninstall buttons, explicit text about changing `~/.claude/settings.json`, and “restart Claude required” after install. Assert a `claude-stop-hook` session enables injection while `monitor-only` remains disabled.

- [ ] **Step 5: Implement the WebUI card and session capability rendering**

Load hook status with health/config/sessions/startup; refresh it on `claude-hook` SSE; save the config fields through the existing config update; call explicit lifecycle actions with current notice/error handling. Preserve the reference-inspired sidebar, dense status chips, responsive table/cards, and mobile drawer.

- [ ] **Step 6: Run Web tests and build**

Run: `npm --workspace apps/web test`

Run: `npm --workspace apps/web run build`

Expected: all Web tests pass and Vite build exits zero.

- [ ] **Step 7: Commit, push, merge, and push main**

```powershell
git add apps/web/src apps/web/test
git commit -m "feat: manage Claude stop hook in webui"
git push -u origin feature/continuation-claude-webui
```

Merge and verify using the delivery rule. The existing Pages Action will publish the updated static demo from `main`.

### Task 8: Controlled integration, docs, and final audit

**Files:**

- Create: `apps/watchdog/test/claude-stop-hook-integration.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-21-claude-stop-hook-design.md` only if implementation details required a reviewed clarification

- [ ] **Step 1: Write failing controlled integration test**

Create two temporary Claude sessions, one lease, and invoke the built CLI twice. Prove only the matching session receives one `decision: "block"`, the second session and repeat invocation receive `{}`, and no real `%USERPROFILE%\\.claude` path is opened. Add a test-time guard that throws if any target resolves outside the temporary root.

- [ ] **Step 2: Verify RED, then make only the required integration fixes**

Run: `npm --workspace apps/watchdog run build --silent && node --test apps/watchdog/dist/test/claude-stop-hook-integration.test.js`

Expected first run: fail on the unproven integration behavior. Make the smallest product fixes needed and rerun to PASS.

- [ ] **Step 3: Document explicit installation and restart**

Document local launch, WebUI install, enabling the hook, restarting existing Claude processes, safe uninstall/manual-review behavior, and that no global keyboard fallback exists. Keep the GitHub Pages URL `https://dieWehmut.github.io/Selbstlauf/` current.

- [ ] **Step 4: Run complete verification**

Run, read, and record fresh output for:

```powershell
npm test
npm run build
npm --workspace apps/web exec playwright test
git diff --check
git status --short --branch
git ls-remote origin refs/heads/main
```

Start a dry-run watchdog on a free loopback port, inspect `/api/health`, `/api/sessions`, and `/api/claude-hook`, and stop it through the owned script. Verify multiple Codex processes are independent, active/paused goals choose `/goal resume`, ordinary Codex chooses configured normal prompt, terminal goals skip, Claude quiet sessions arm only exact-session leases when installed/enabled, and active response changes suppress action.

- [ ] **Step 5: Commit, push, merge, and push main**

```powershell
git add apps/watchdog/test/claude-stop-hook-integration.test.ts README.md docs/superpowers/specs/2026-08-21-claude-stop-hook-design.md
git commit -m "test: verify Claude hook continuation end to end"
git push -u origin feature/continuation-claude-acceptance
```

Merge to `main`, repeat the complete verification on merged `main`, push, verify remote SHA, and inspect the public GitHub Pages deployment. Do not mark the persistent goal complete until the requirement-by-requirement audit has authoritative evidence for Claude, both Codex modes, no-action-on-response, per-window isolation, configurable WebUI, uninstall, organized scripts, Actions/Pages, and remote `main` synchronization.
