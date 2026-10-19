import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ManagedAgentSessions } from '../src/agents/managed-sessions.js';
import { WatchdogHttpServer } from '../src/server/http-server.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';
import type { AgentOutput, AgentSessionView } from '../src/agents/types.js';

test('HTTP starts a real PTY and streams its output across reconnects; writes require the service origin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-http-'));
  const agents = new ManagedAgentSessions();
  const server = new WatchdogHttpServer({
    configStore: new ConfigStore(join(root, 'config.json')), auditStore: new AuditStore(join(root, 'audit.jsonl')),
    agents, sessions: { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) }, port: 0,
  });
  await server.start();
  t.after(async () => { await agents.stop(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const origin = server.url();
  const call = (path: string, method = 'GET', body?: unknown, source = origin) => fetch(`${origin}/api${path}`, {
    method, headers: { origin: source, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const request = { tool: 'opencode', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/agent-terminal.js', import.meta.url))] };
  assert.equal((await call('/agents', 'POST', request, 'https://example.com')).status, 403);
  assert.equal((await call('/agents', 'POST', request, 'http://127.0.0.1:1')).status, 403);
  assert.equal(agents.list().length, 0);
  const launch = await call('/agents', 'POST', request);
  assert.equal(launch.status, 201);
  const session = await launch.json() as AgentSessionView;
  const endpoint = `/agents/${session.id}`;
  assert.equal((await call(`${endpoint}/input`, 'POST', { data: 'bad\r' }, 'https://example.com')).status, 403);
  assert.equal((await call(`${endpoint}/resize`, 'POST', { cols: 92, rows: 28 })).status, 200);
  const stream = await call(`${endpoint}/events`);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/u);
  const reader = stream.body!.getReader();
  t.after(() => reader.cancel());
  await call(`${endpoint}/input`, 'POST', { data: 'HTTP 中文\r' });
  let received = '';
  let cursor = 0;
  const decoder = new TextDecoder();
  while (!received.includes('REPLY HTTP 中文')) {
    const result = await reader.read();
    assert.equal(result.done, false);
    received += decoder.decode(result.value, { stream: true });
  }
  for (const frame of received.split('\n\n')) {
    const payload = /data: (.+)/u.exec(frame)?.[1];
    if (payload !== undefined) cursor = (JSON.parse(payload) as AgentOutput).offset;
  }
  assert.ok(cursor > 0);
  await reader.cancel();
  await call(`${endpoint}/input`, 'POST', { data: 'after reconnect\r' });
  const reconnected = await fetch(`${origin}/api${endpoint}/events`, { headers: { 'last-event-id': String(cursor) } });
  const again = reconnected.body!.getReader();
  t.after(() => again.cancel());
  let recovered = '';
  while (!recovered.includes('REPLY after reconnect')) {
    const result = await again.read();
    assert.equal(result.done, false);
    recovered += decoder.decode(result.value, { stream: true });
  }
  assert.doesNotMatch(recovered, /REPLY HTTP 中文/u);
  await again.cancel();
  const output = await (await call(`${endpoint}/output`)).json() as AgentOutput;
  assert.match(output.data, /REPLY HTTP 中文/u);
  assert.equal((await call(`${endpoint}/output?after=-1`)).status, 400);
  assert.equal((await call(`${endpoint}/input`, 'POST', null)).status, 400);
  assert.equal((await call('/agents/claude%3A1234/input', 'POST', { data: 'bad' })).status, 404);
  assert.equal((await call(endpoint, 'DELETE')).status, 409);
  assert.equal((await call(`${endpoint}/terminate`, 'POST')).status, 200);
  const ended = await (await call(`${endpoint}/output`)).json() as AgentOutput;
  assert.equal(ended.session.status, 'exited');
  assert.equal((await call(endpoint, 'DELETE')).status, 200);
  assert.equal((await call(`${endpoint}/output`)).status, 404);
});
