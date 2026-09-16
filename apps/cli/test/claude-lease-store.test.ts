import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ClaudeLeaseStore } from '../src/claude/lease-store.js';

function request(clock: number, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    prompt: '继续',
    rootPid: 100,
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
    ttlMs: 15_000,
    ...overrides,
    clock,
  };
}

test('arms and consumes one exact Claude session lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  let clock = 5_000;
  const store = new ClaudeLeaseStore(join(root, 'claude-leases.json'), { now: () => clock });

  const lease = await store.arm(request(clock));
  assert.equal(lease.sessionId, 'session-a');
  assert.equal(lease.expiresAtMs, 20_000);

  const consumed = await store.consume({
    sessionId: 'session-a',
    cwd: 'c:/work/a/',
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
  });
  assert.equal(consumed?.prompt, '继续');
  assert.equal(await store.consume({
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
  }), null);
});

test('isolates sessions, process identities, and changed activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  const store = new ClaudeLeaseStore(join(root, 'claude-leases.json'), { now: () => 5_000 });
  await store.arm(request(5_000));

  assert.equal(await store.consume({
    sessionId: 'session-b',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
  }), null);
  assert.equal(await store.consume({
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 2_000,
    activity: { size: 20, mtimeMs: 2_000 },
  }), null);
  assert.equal(await store.consume({
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 1_000,
    activity: { size: 21, mtimeMs: 2_001 },
  }), null);
  assert.equal((await store.list()).length, 0);
});

test('expires and clears leases without retaining stale prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  let clock = 5_000;
  const store = new ClaudeLeaseStore(join(root, 'claude-leases.json'), { now: () => clock });
  await store.arm(request(clock, { ttlMs: 100 }));
  clock = 5_100;

  assert.equal(await store.consume({
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
  }), null);
  assert.deepEqual(await store.list(), []);
  await store.arm(request(clock, { sessionId: 'session-b', cwd: 'C:\\work\\B' }));
  await store.clearSession('session-b');
  assert.deepEqual(await store.list(), []);
});

test('serializes concurrent consumption across store instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  const path = join(root, 'claude-leases.json');
  const first = new ClaudeLeaseStore(path, { now: () => 5_000 });
  const second = new ClaudeLeaseStore(path, { now: () => 5_000 });
  await first.arm(request(5_000));

  const input = {
    sessionId: 'session-a',
    cwd: 'C:\\work\\A',
    processStartedAtMs: 1_000,
    activity: { size: 20, mtimeMs: 2_000 },
  };
  const results = await Promise.all([first.consume(input), second.consume(input)]);
  assert.equal(results.filter((value) => value !== null).length, 1);
  assert.match(await readFile(path, 'utf8'), /"leases":\s*\[\]/);
});

test('rejects unsafe identities, prompts, and lease durations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  const store = new ClaudeLeaseStore(join(root, 'claude-leases.json'));

  await assert.rejects(() => store.arm(request(5_000, { sessionId: '', ttlMs: 1_000 })), /sessionId/);
  await assert.rejects(() => store.arm(request(5_000, { cwd: 'relative\\path' })), /cwd/);
  await assert.rejects(() => store.arm(request(5_000, { prompt: 'line\nbreak' })), /prompt/);
  await assert.rejects(() => store.arm(request(5_000, { ttlMs: 0 })), /ttlMs/);
});

test('creates a missing lease directory before the first arm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-store-'));
  const store = new ClaudeLeaseStore(join(root, 'nested', 'state', 'claude-leases.json'), { now: () => 5_000 });

  await store.arm(request(5_000));

  assert.equal((await store.list()).length, 1);
});
