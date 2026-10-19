import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';
import { ManagedAgentSessions } from '../src/agents/managed-sessions.js';
import { WatchdogHttpServer } from '../src/server/http-server.js';
import { AuditStore } from '../src/store/audit-store.js';
import { ConfigStore } from '../src/store/config-store.js';
import type { AgentOutput } from '../src/agents/types.js';

test('WebSocket multiplexes real terminal output and replays only the missed range after reconnecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-socket-'));
  const agents = new ManagedAgentSessions();
  const server = new WatchdogHttpServer({ agents, port: 0,
    configStore: new ConfigStore(join(root, 'config.json')), auditStore: new AuditStore(join(root, 'audit.jsonl')),
    sessions: { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) },
  });
  await server.start();
  t.after(async () => { await agents.stop(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  const origin = server.url();
  const url = origin.replace('http:', 'ws:') + '/api/socket';
  const fixture = fileURLToPath(new URL('./fixtures/agent-terminal.js', import.meta.url));
  const first = await agents.launch({ tool: 'claude', command: process.execPath, args: [fixture] });
  const second = await agents.launch({ tool: 'opencode', command: process.execPath, args: [fixture] });
  const open = async () => {
    const socket = new WebSocket(url, { origin });
    const frames: { event: string; data: AgentOutput }[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    t.after(() => socket.terminate());
    return { socket, frames };
  };
  const waitFrame = async (frames: { event: string; data: AgentOutput }[], id: string, text: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const frame = frames.find((entry) => entry.event === 'output' && entry.data.session.id === id && entry.data.data.includes(text));
      if (frame !== undefined) return frame.data;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.fail(`Missing ${id}: ${text}`);
  };
  const client = await open();
  client.socket.send(JSON.stringify({ type: 'subscribe-output', id: first.id, after: 0 }));
  client.socket.send(JSON.stringify({ type: 'subscribe-output', id: second.id, after: 0 }));
  await waitFrame(client.frames, first.id, 'READY');
  await waitFrame(client.frames, second.id, 'READY');
  agents.input(first.id, 'socket first\r');
  agents.input(second.id, 'socket second\r');
  const before = await waitFrame(client.frames, first.id, 'REPLY socket first');
  await waitFrame(client.frames, second.id, 'REPLY socket second');
  assert.ok(!client.frames.some((frame) => frame.event === 'output' && frame.data.session.id === first.id && frame.data.data.includes('socket second')));
  client.socket.terminate();
  await once(client.socket, 'close');
  agents.input(first.id, 'missed 中文\r');
  const reconnected = await open();
  reconnected.socket.send(JSON.stringify({ type: 'subscribe-output', id: first.id, after: before.offset }));
  const replay = await waitFrame(reconnected.frames, first.id, 'REPLY missed 中文');
  assert.doesNotMatch(replay.data, /REPLY socket first/u);
  assert.equal(replay.reset, false);
  server.publish('sessions', { action: 'refresh' });
  await new Promise((done) => setTimeout(done, 20));
  assert.ok(reconnected.frames.some((frame) => frame.event === 'sessions'));
  const rejected = new WebSocket(url, { origin: 'https://example.com' });
  rejected.on('error', () => undefined);
  const [request, response] = await once(rejected, 'unexpected-response');
  assert.equal((response as { statusCode: number }).statusCode, 403);
  (response as { resume(): void }).resume();
  (request as { destroy(): void }).destroy();
  rejected.terminate();
});
