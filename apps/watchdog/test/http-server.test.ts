import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createHttpClient } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';
import { WatchdogHttpServer, type SessionController } from '../src/server/http-server.js';
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
  const service = new WatchdogHttpServer({
    configStore: new ConfigStore(join(directory, 'config.json')),
    auditStore: new AuditStore(join(directory, 'audit.jsonl')),
    sessions: controller,
    status,
    port: 0,
  });
  await service.start();
  return { service, controller };
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
  const { service, controller } = await makeServer({}, () => ({ lastPollAtMs: 12_345 }));
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
