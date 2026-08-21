import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createHttpClient } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';
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
    body: { prompt: '继续-now' },
  });
  assert.equal(injected.response.status, 200);
  assert.equal(injected.json.prompt, '继续-now');
  assert.equal(injected.json.dryRun, true);
  assert.equal((controller.inject as Function).length >= 2, true);
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
  const result = service.publish('audit', { type: 'skip', prompt: '继续' });
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
