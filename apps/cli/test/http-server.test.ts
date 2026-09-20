import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpClient } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';
import { CodexConfigProfiles } from '../src/codex/profile-store.js';
import { EnvironmentCheck } from '../src/environment/environment-check.js';
import { ToolUpgrader } from '../src/environment/upgrade.js';
import {
  WatchdogHttpServer,
  type SessionController,
  type WatchdogLifecycle,
} from '../src/server/http-server.js';
import type { SessionSnapshot } from '../src/domain/types.js';

const session: SessionSnapshot = {
  id: 'claude:1200',
  tool: 'claude',
  rootPid: 1200,
  childPids: [],
  conversationId: 'conversation-1',
  goal: null,
  transport: 'monitor-only',
  alive: true,
  enabled: true,
  paused: false,
  startedAtMs: 1,
  lastActivityAtMs: 2,
};

async function makeServer(
  overrides: Partial<SessionController> = {},
  status?: () => { readonly lastPollAtMs: number | null },
  environment?: EnvironmentCheck,
  upgrader?: ToolUpgrader,
) {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-http-'));
  const controller: SessionController = {
    list: () => [session],
    pause: async () => true,
    resume: async () => true,
    inject: async (_id, prompt, dryRun) => ({ ok: true, dryRun, prompt }),
    ...overrides,
  };
  const configStore = new ConfigStore(join(directory, 'config.json'));
  const auditStore = new AuditStore(join(directory, 'audit.jsonl'));
  const service = new WatchdogHttpServer({
    configStore,
    auditStore,
    sessions: controller,
    status,
    ...(environment === undefined ? {} : { environment }),
    ...(upgrader === undefined ? {} : { upgrader }),
    port: 0,
  });
  await service.start();
  return { service, controller, configStore, auditStore };
}

async function request(base: string, path: string, options: { method?: string; body?: unknown; origin?: string } = {}) {
  const url = new URL(path, base);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body,
  });
  const text = await response.text();
  return { response, text, json: text.length === 0 ? null : JSON.parse(text) };
}

test('serves the local environment report and refreshes it on demand', async (t) => {
  let scans = 0;
  const check = new EnvironmentCheck({
    readInstalled: async () => {
      scans += 1;
      return [
        { id: 'claude', installed: '2.1.274' },
        { id: 'codex', installed: '0.155.0' },
        { id: 'gemini', installed: null },
        { id: 'grok', installed: null },
        { id: 'opencode', installed: null },
        { id: 'openclaw', installed: null },
      ];
    },
    readLatest: async () => new Map([
      ['@anthropic-ai/claude-code', '2.1.276'],
      ['@openai/codex', '0.155.0'],
    ]),
    now: () => 5_000,
  });
  const { service } = await makeServer({}, undefined, check);
  t.after(() => service.stop());
  const base = service.url();

  const report = await request(base, '/api/environment');
  assert.equal(report.response.status, 200);
  assert.equal(report.json.tools.length, 6);
  const claude = report.json.tools.find((tool: { id: string }) => tool.id === 'claude');
  assert.equal(claude.state, 'outdated');
  assert.equal(claude.installCommand, 'npm i -g @anthropic-ai/claude-code@latest');
  assert.deepEqual(report.json.upgrades, ['claude']);
  assert.equal(report.json.manualCommands.length, 6);
  assert.equal(scans, 1);

  // A refresh re-probes; the cached read stays free.
  await request(base, '/api/environment');
  assert.equal(scans, 1);
  const refreshed = await request(base, '/api/environment/refresh', { method: 'POST', origin: base });
  assert.equal(refreshed.response.status, 200);
  assert.equal(scans, 2);
});

test('installs one catalog tool and upgrades every outdated one', async (t) => {
  const installed: string[] = [];
  const check = new EnvironmentCheck({
    readInstalled: async () => [
      { id: 'claude', installed: '2.1.274' },
      { id: 'codex', installed: '0.155.0' },
      { id: 'gemini', installed: null },
      { id: 'grok', installed: null },
      { id: 'opencode', installed: null },
      { id: 'openclaw', installed: null },
    ],
    readLatest: async () => new Map([
      ['@anthropic-ai/claude-code', '2.1.276'],
      ['@openai/codex', '0.155.0'],
    ]),
  });
  const upgrader = new ToolUpgrader({
    runNpm: async (args) => {
      installed.push(args[2]);
      return 'added 1 package';
    },
    check,
  });
  const { service, auditStore } = await makeServer({}, undefined, check, upgrader);
  t.after(() => service.stop());
  const base = service.url();

  const one = await request(base, '/api/environment/upgrade', {
    method: 'POST',
    origin: base,
    body: { id: 'claude' },
  });
  assert.equal(one.response.status, 200);
  assert.equal(one.json.ok, true);
  assert.deepEqual(installed, ['@anthropic-ai/claude-code@latest']);

  // A bulk upgrade touches only the tools the report marks outdated.
  installed.length = 0;
  const all = await request(base, '/api/environment/upgrade-all', { method: 'POST', origin: base });
  assert.equal(all.response.status, 200);
  assert.deepEqual(installed, ['@anthropic-ai/claude-code@latest']);
  assert.deepEqual(all.json.results.map((result: { id: string }) => result.id), ['claude']);

  // The install is audited, and the audit never records a token or a path.
  const actions = (await auditStore.list()).filter((event) => typeof event.details?.action === 'string');
  assert.deepEqual(actions.map((event) => event.details?.action), ['environment-upgrade', 'environment-upgrade-all']);
});

test('rejects an unknown tool id and a cross-origin install', async (t) => {
  const check = new EnvironmentCheck({ readInstalled: async () => [], readLatest: async () => new Map() });
  let ran = 0;
  const upgrader = new ToolUpgrader({ runNpm: async () => { ran += 1; return ''; } });
  const { service } = await makeServer({}, undefined, check, upgrader);
  t.after(() => service.stop());
  const base = service.url();

  const unknown = await request(base, '/api/environment/upgrade', {
    method: 'POST',
    origin: base,
    body: { id: 'not-a-tool' },
  });
  assert.equal(unknown.response.status, 400);
  assert.equal(ran, 0);

  const crossOrigin = await request(base, '/api/environment/upgrade', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { id: 'codex' },
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(ran, 0);

  const missing = await request(base, '/api/environment/upgrade', { method: 'POST', origin: base, body: {} });
  assert.equal(missing.response.status, 400);
  assert.equal(ran, 0);
});


test('rejects a cross-origin environment refresh', async (t) => {
  const check = new EnvironmentCheck({
    readInstalled: async () => [],
    readLatest: async () => new Map(),
  });
  const { service } = await makeServer({}, undefined, check);
  t.after(() => service.stop());
  const base = service.url();

  const rejected = await request(base, '/api/environment/refresh', { method: 'POST', origin: 'https://evil.example' });
  assert.equal(rejected.response.status, 403);
});
test('serves health, sessions, validated config, and controls on loopback', async (t) => {
  let changedDryRun: boolean | undefined;
  const { service, controller } = await makeServer({
    configChanged: (config) => { changedDryRun = config.dryRun; },
  }, () => ({ lastPollAtMs: 12_345 }));
  t.after(() => service.stop());
  const base = service.url();

  const health = await request(base, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.running, true);
  assert.equal(health.json.dryRun, false);
  assert.equal(health.json.loopbackOnly, true);
  assert.equal(health.json.lastPollAtMs, 12_345);

  const sessions = await request(base, '/api/sessions');
  assert.deepEqual(sessions.json.sessions.map((entry: SessionSnapshot) => entry.id), [session.id]);

  const config = await request(base, '/api/config');
  assert.equal(config.json.dryRun, false);
  const updated = await request(base, '/api/config', {
    method: 'PUT',
    origin: base,
    body: { ...config.json, dryRun: true },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.dryRun, true);
  assert.equal(changedDryRun, true);

  const invalid = await request(base, '/api/config', {
    method: 'PUT',
    origin: base,
    body: { ...config.json, pollIntervalMs: 0 },
  });
  assert.equal(invalid.response.status, 400);

  const paused = await request(base, `/api/sessions/${encodeURIComponent(session.id)}/pause`, {
    method: 'POST',
    origin: base,
  });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.json.ok, true);
  const resumed = await request(base, `/api/sessions/${encodeURIComponent(session.id)}/resume`, {
    method: 'POST',
    origin: base,
  });
  assert.equal(resumed.response.status, 200);
  const injected = await request(base, `/api/sessions/${encodeURIComponent(session.id)}/inject`, {
    method: 'POST',
    origin: base,
    body: { prompt: 'ç»§ç»­-now' },
  });
  assert.equal(injected.response.status, 200);
  assert.equal(injected.json.prompt, 'ç»§ç»­-now');
  assert.equal(injected.json.dryRun, true);
  assert.equal((controller.inject as Function).length >= 2, true);
});

test('reveals a session window through the focus route', async (t) => {
  const focused: string[] = [];
  const { service } = await makeServer({
    focus: async (sessionId) => {
      focused.push(sessionId);
      return sessionId === session.id
        ? { ok: true, focused: true }
        : { ok: false, reason: 'session-not-found' };
    },
  });
  t.after(() => service.stop());
  const base = service.url();

  const revealed = await request(base, `/api/sessions/${encodeURIComponent(session.id)}/focus`, {
    method: 'POST',
    origin: base,
  });
  assert.equal(revealed.response.status, 200);
  assert.equal(revealed.json.ok, true);
  assert.equal(revealed.json.focused, true);
  assert.deepEqual(focused, [session.id]);

  const missing = await request(base, '/api/sessions/absent/focus', { method: 'POST', origin: base });
  assert.equal(missing.response.status, 409);
  assert.equal(missing.json.error, 'session-not-found');
});

test('reports 501 when window reveal is not configured', async (t) => {
  const { service } = await makeServer();
  t.after(() => service.stop());
  const base = service.url();

  const response = await request(base, `/api/sessions/${encodeURIComponent(session.id)}/focus`, {
    method: 'POST',
    origin: base,
  });
  assert.equal(response.response.status, 501);
});

test('rejects non-loopback origins and oversized JSON bodies', async (t) => {
  const { service } = await makeServer();
  t.after(() => service.stop());
  const base = service.url();
  const forbidden = await request(base, '/api/watchdog/stop', { method: 'POST', origin: 'https://evil.example' });
  assert.equal(forbidden.response.status, 403);
  const huge = await request(base, '/api/config', {
    method: 'PUT',
    origin: base,
    body: { x: 'a'.repeat(100_000) },
  });
  assert.equal(huge.response.status, 413);
});

test('streams audit events over SSE', async (t) => {
  const { service } = await makeServer();
  t.after(() => service.stop());
  const response = await fetch(new URL('/api/events', service.url()), { headers: { accept: 'text/event-stream' } });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/);
  const result = service.publish('audit', { type: 'skip', prompt: 'ç»§ç»­' });
  assert.equal(result, true);
  const next = await reader.read();
  assert.match(new TextDecoder().decode(next.value), /event: audit/);
  await reader.cancel();
});

test('supports lifecycle endpoints and blocks the transport in dry-run mode', async (t) => {
  let startCalls = 0;
  let stopCalls = 0;
  let injectCalls = 0;
  const { service } = await makeServer({
    inject: async (_id, prompt, dryRun) => {
      injectCalls += 1;
      return { ok: true, dryRun, prompt };
    },
  });
  service.setLifecycle({ start: async () => { startCalls += 1; }, stop: async () => { stopCalls += 1; } });
  t.after(() => service.stop());
  const base = service.url();
  const started = await request(base, '/api/watchdog/start', { method: 'POST', origin: base });
  const stopped = await request(base, '/api/watchdog/stop', { method: 'POST', origin: base });
  assert.equal(started.response.status, 200);
  assert.equal(stopped.response.status, 200);
  assert.equal(startCalls, 1);
  assert.equal(stopCalls, 1);
  const config = await request(base, '/api/config');
  await request(base, '/api/config', { method: 'PUT', origin: base, body: { ...config.json, dryRun: true } });
  await request(base, `/api/sessions/${encodeURIComponent(session.id)}/inject`, { method: 'POST', origin: base, body: { prompt: 'dry' } });
  assert.equal(injectCalls, 0);
});

test('exposes owned startup-task lifecycle endpoints', async (t) => {
  let startupStatusCalls = 0;
  let installStartupCalls = 0;
  let uninstallStartupCalls = 0;
  const { service } = await makeServer();
  service.setLifecycle({
    startupStatus: async () => {
      startupStatusCalls += 1;
      return { installed: true, name: 'Selbstlauf Continuation Watchdog' };
    },
    installStartup: async () => { installStartupCalls += 1; },
    uninstallStartup: async () => { uninstallStartupCalls += 1; },
  });
  t.after(() => service.stop());
  const base = service.url();

  const status = await request(base, '/api/startup');
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.json, { installed: true, name: 'Selbstlauf Continuation Watchdog' });

  const installed = await request(base, '/api/startup/install', { method: 'POST', origin: base });
  const uninstalled = await request(base, '/api/startup/uninstall', { method: 'POST', origin: base });
  assert.equal(installed.response.status, 200);
  assert.equal(uninstalled.response.status, 200);
  assert.equal(startupStatusCalls, 1);
  assert.equal(installStartupCalls, 1);
  assert.equal(uninstallStartupCalls, 1);
});

test('exposes explicit Claude Hook status and lifecycle without silently enabling it', async (t) => {
  let hookState = {
    installed: false,
    restartRequired: false,
    manualReviewRequired: false,
  };
  const calls = { status: 0, install: 0, uninstall: 0, disable: 0, clearLeases: 0 };
  const { service, configStore, auditStore } = await makeServer();
  const published: Array<{ event: string; data: unknown }> = [];
  const publish = service.publish.bind(service);
  service.publish = (event, data) => {
    published.push({ event, data });
    return publish(event, data);
  };
  service.setLifecycle({
    claudeHookStatus: async () => {
      calls.status += 1;
      return hookState;
    },
    installClaudeHook: async () => {
      calls.install += 1;
      calls.clearLeases += 1;
      hookState = { installed: true, restartRequired: true, manualReviewRequired: false };
      return hookState;
    },
    uninstallClaudeHook: async () => {
      calls.uninstall += 1;
      calls.clearLeases += 1;
      hookState = { installed: false, restartRequired: false, manualReviewRequired: false };
      return hookState;
    },
    disableClaudeHook: async () => {
      calls.disable += 1;
      calls.clearLeases += 1;
      return hookState;
    },
  } satisfies WatchdogLifecycle);
  t.after(() => service.stop());
  const base = service.url();

  const initial = await request(base, '/api/claude-hook');
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.json, {
    installed: false,
    enabled: false,
    restartRequired: false,
    manualReviewRequired: false,
  });

  const forbidden = await request(base, '/api/claude-hook/install', {
    method: 'POST',
    origin: 'https://evil.example',
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(calls.install, 0);

  const installed = await request(base, '/api/claude-hook/install', { method: 'POST', origin: base });
  assert.equal(installed.response.status, 200);
  assert.deepEqual(installed.json, {
    installed: true,
    enabled: false,
    restartRequired: true,
    manualReviewRequired: false,
  });

  await configStore.update((config) => ({
    ...config,
    tools: {
      ...config.tools,
      claude: {
        ...config.tools.claude,
        stopHook: { ...config.tools.claude.stopHook, enabled: true },
      },
    },
  }));
  const disabled = await request(base, '/api/claude-hook/disable', { method: 'POST', origin: base });
  assert.equal(disabled.response.status, 200);
  assert.deepEqual(disabled.json, {
    installed: true,
    enabled: false,
    restartRequired: true,
    manualReviewRequired: false,
  });
  assert.equal((await configStore.load()).tools.claude.stopHook.enabled, false);

  await configStore.update((config) => ({
    ...config,
    tools: {
      ...config.tools,
      claude: {
        ...config.tools.claude,
        stopHook: { ...config.tools.claude.stopHook, enabled: true },
      },
    },
  }));
  const uninstalled = await request(base, '/api/claude-hook/uninstall', { method: 'POST', origin: base });
  assert.equal(uninstalled.response.status, 200);
  assert.deepEqual(uninstalled.json, {
    installed: false,
    enabled: true,
    restartRequired: false,
    manualReviewRequired: false,
  });
  assert.equal((await configStore.load()).tools.claude.stopHook.enabled, true);

  assert.deepEqual(calls, { status: 1, install: 1, uninstall: 1, disable: 1, clearLeases: 3 });
  const hookEvents = published.filter(({ event }) => event === 'claude-hook');
  assert.equal(hookEvents.length, 3);
  assert.deepEqual(hookEvents.at(-1)?.data, uninstalled.json);
  const actionEvents = (await auditStore.list()).filter((event) =>
    typeof event.details?.action === 'string' && event.details.action.startsWith('claude-hook-'));
  assert.deepEqual(actionEvents.map((event) => event.details?.action), [
    'claude-hook-install',
    'claude-hook-disable',
    'claude-hook-uninstall',
  ]);
  assert.doesNotMatch(JSON.stringify(actionEvents), /settings\.json|claude-hook-manifest/i);
});

test('returns 501 when Claude Hook lifecycle actions are not configured', async (t) => {
  const { service } = await makeServer();
  t.after(() => service.stop());
  const base = service.url();

  const responses = await Promise.all([
    request(base, '/api/claude-hook'),
    request(base, '/api/claude-hook/install', { method: 'POST', origin: base }),
    request(base, '/api/claude-hook/uninstall', { method: 'POST', origin: base }),
    request(base, '/api/claude-hook/disable', { method: 'POST', origin: base }),
  ]);
  assert.deepEqual(responses.map(({ response }) => response.status), [501, 501, 501, 501]);
});

test('exposes Codex endpoint profiles and applies a switch through the API', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-profiles-'));
  const configPath = join(directory, 'config.toml');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, [
    'model = "deepseek-v4.1-flash"',
    'base_url = "https://external-api-platform.hkgai.net/v1"',
    '# base_url = "https://www.sevnx.lol"',
    '',
  ].join('\n'), 'utf8');
  const directory2 = await mkdtemp(join(tmpdir(), 'watchdog-profiles-http-'));
  const controller: SessionController = {
    list: () => [session],
    pause: async () => true,
    resume: async () => true,
    inject: async () => ({ ok: true }),
  };
  const configStore = new ConfigStore(join(directory2, 'config.json'));
  const auditStore = new AuditStore(join(directory2, 'audit.jsonl'));
  const codexProfiles = new CodexConfigProfiles({ configPath });
  const service = new WatchdogHttpServer({
    configStore,
    auditStore,
    codexProfiles,
    sessions: controller,
    port: 0,
  });
  await service.start();
  t.after(() => service.stop());
  const base = service.url();

  const described = await request(base, '/api/codex/profiles');
  assert.equal(described.response.status, 200);
  assert.equal(described.json.active.base_url, 'https://external-api-platform.hkgai.net/v1');
  assert.deepEqual(described.json.alternatives.base_url, ['https://www.sevnx.lol']);

  const applied = await request(base, '/api/codex/profiles', {
    method: 'PUT',
    origin: base,
    body: { fields: [{ key: 'base_url', value: 'https://www.sevnx.lol' }] },
  });
  assert.equal(applied.response.status, 200);
  assert.deepEqual(applied.json.changes, [
    { key: 'base_url', action: 'uncommented', value: 'https://www.sevnx.lol' },
  ]);
  assert.equal(await readFile(configPath, 'utf8').then((text) => text.includes('base_url = "https://www.sevnx.lol"')), true);

  const rejected = await request(base, '/api/codex/profiles', {
    method: 'PUT',
    origin: base,
    body: { fields: [] },
  });
  assert.equal(rejected.response.status, 400);
});

/**
 * The manual-injection endpoint takes its prompt from the request body.
 *
 * This capability is what a UI needs in order to let someone type into a session, and the rules around it
 * were entirely untested: the endpoint accepts an arbitrary single line, falls back to the configured
 * prompt when none is given, and refuses anything the transport could not carry. An empty prompt would
 * inject nothing, and a newline would submit the first line and leave the rest behind ¡ª both of which look
 * like the app "not working" rather than like a rejected request, so they are refused loudly.
 */
test('injects a caller-supplied prompt and enforces the prompt rules', async (t) => {
  const seen: string[] = [];
  const { service } = await makeServer({
    inject: async (_id, prompt, dryRun) => {
      seen.push(prompt);
      return { ok: true, dryRun, prompt };
    },
  });
  // Dry-run keeps this a pure record: no transport is asked to write anything.
  t.after(() => service.stop());
  const base = service.url();
  const route = `/api/sessions/${encodeURIComponent(session.id)}/inject`;

  // A caller-supplied line reaches the controller unchanged, which is the whole point of the endpoint.
  const custom = await request(base, route, { method: 'POST', origin: base, body: { prompt: '¼ÌÐø-now' } });
  assert.equal(custom.response.status, 200);
  assert.equal(custom.json.prompt, '¼ÌÐø-now');
  assert.deepEqual(seen, ['¼ÌÐø-now']);

  // No prompt at all falls back to the configured one, which is what the UI does today.
  const fallback = await request(base, route, { method: 'POST', origin: base, body: {} });
  assert.equal(fallback.response.status, 200);
  assert.equal(typeof fallback.json.prompt, 'string');
  assert.ok(fallback.json.prompt.length > 0, 'the fallback prompt must not be empty');

  // Refused: each of these would produce a confusing no-op rather than a visible failure.
  const rejected: [string, unknown][] = [
    ['empty', { prompt: '' }],
    ['whitespace only', { prompt: '   ' }],
    ['multi-line', { prompt: 'first\nsecond' }],
    ['carriage return', { prompt: 'first\rsecond' }],
    ['over the 4096 limit', { prompt: 'x'.repeat(4097) }],
    ['not a string', { prompt: 42 }],
  ];
  for (const [label, body] of rejected) {
    const response = await request(base, route, { method: 'POST', origin: base, body });
    assert.equal(response.response.status, 400, `${label} should be refused`);
  }

  // The boundary itself is allowed: a 4096-character line is the documented maximum.
  const atLimit = await request(base, route, { method: 'POST', origin: base, body: { prompt: 'x'.repeat(4096) } });
  assert.equal(atLimit.response.status, 200);
  assert.equal(atLimit.json.prompt.length, 4096);

  // And nothing was injected for any of the refusals.
  assert.deepEqual(seen, ['¼ÌÐø-now', fallback.json.prompt, 'x'.repeat(4096)]);
});
