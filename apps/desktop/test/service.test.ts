import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWatchdogRecord, resolveStateDirectory, waitForHealth, watchdogOrigin } from '../src/service.js';

test('resolves the watchdog state directory from the local app data root', () => {
  assert.equal(
    resolveStateDirectory({ LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' } as NodeJS.ProcessEnv),
    join('C:\\Users\\demo\\AppData\\Local', 'ai-cli-bypass', 'continuation'),
  );
  assert.throws(() => resolveStateDirectory({} as NodeJS.ProcessEnv), /LOCALAPPDATA/u);
});

test('reads only well-formed watchdog records', async () => {
  const state = await mkdtemp(join(tmpdir(), 'desktop-service-'));
  try {
    assert.equal(await readWatchdogRecord(state), null);
    await writeFile(join(state, 'watchdog.pid.json'), '{"pid":42,"port":"48920","entryPath":"X"} ', 'utf8');
    assert.deepEqual(await readWatchdogRecord(state), { pid: 42, port: '48920', entryPath: 'X' });
    await writeFile(join(state, 'watchdog.pid.json'), '{"pid":0,"port":"48920"}', 'utf8');
    assert.equal(await readWatchdogRecord(state), null);
    await writeFile(join(state, 'watchdog.pid.json'), 'not json', 'utf8');
    assert.equal(await readWatchdogRecord(state), null);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('builds a loopback origin and waits for a healthy service', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const origin = watchdogOrigin(address.port);
  assert.equal(origin, `http://127.0.0.1:${address.port}`);
  try {
    assert.equal(await waitForHealth(origin, { timeoutMs: 2_000 }), true);
    assert.equal(await waitForHealth(watchdogOrigin(1), { timeoutMs: 300, intervalMs: 50 }), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
