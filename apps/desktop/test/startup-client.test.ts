import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readStartupState, setStartupInstalled, type StartupClientOptions } from '../src/startup-client.js';

/**
 * `startup-client` drives the tray's 开机自启 checkbox.
 *
 * It had no tests of its own: the tray tests inject a stub `readStartup`, so the
 * real HTTP behaviour — and especially the failure modes that decide whether the
 * checkbox lies — were never exercised. A checkbox that shows the requested
 * value instead of the service's answer is worse than no checkbox.
 *
 * These run against a real loopback server so the request shape is covered too.
 */

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly origin: string | undefined;
}

async function withService(
  handler: (request: { method: string; path: string }) => { status: number; body: string } | 'hang' | 'close',
  run: (options: StartupClientOptions, recorded: Recorded[]) => Promise<void>,
): Promise<void> {
  const recorded: Recorded[] = [];
  const server: Server = createServer((request, response) => {
    recorded.push({
      method: request.method ?? '',
      path: request.url ?? '',
      origin: request.headers.origin as string | undefined,
    });
    const outcome = handler({ method: request.method ?? '', path: request.url ?? '' });
    if (outcome === 'close') {
      // A socket reset is what an unreachable service looks like.
      request.socket.destroy();
      return;
    }
    if (outcome === 'hang') return;
    response.writeHead(outcome.status, { 'content-type': 'application/json' });
    response.end(outcome.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ origin: `http://127.0.0.1:${port}` }, recorded);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('reads the installed state from the service', async () => {
  await withService(
    () => ({ status: 200, body: '{"installed":true}' }),
    async (options, recorded) => {
      const state = await readStartupState(options);
      assert.deepEqual(state, { installed: true, reachable: true });
      assert.deepEqual(recorded, [{ method: 'GET', path: '/api/startup', origin: options.origin }]);
    },
  );
});

test('reports installed:false as a real answer, not as unreachable', async () => {
  await withService(
    () => ({ status: 200, body: '{"installed":false}' }),
    async (options) => {
      assert.deepEqual(await readStartupState(options), { installed: false, reachable: true });
    },
  );
});

test('installing posts to the install route and reads the state back', async () => {
  // The service reports the truth after the toggle; the client must return that,
  // not the value it asked for.
  await withService(
    (request) => (request.method === 'POST'
      ? { status: 200, body: '{"ok":true,"installed":true}' }
      : { status: 200, body: '{"installed":true}' }),
    async (options, recorded) => {
      const state = await setStartupInstalled(options, true);
      assert.deepEqual(state, { installed: true, reachable: true });
      assert.deepEqual(
        recorded.map((r) => `${r.method} ${r.path}`),
        ['POST /api/startup/install', 'GET /api/startup'],
        'the state is always read back after a toggle',
      );
    },
  );
});

test('uninstalling posts to the uninstall route', async () => {
  await withService(
    (request) => (request.method === 'POST'
      ? { status: 200, body: '{"ok":true,"installed":false}' }
      : { status: 200, body: '{"installed":false}' }),
    async (options, recorded) => {
      await setStartupInstalled(options, false);
      assert.equal(recorded[0]?.path, '/api/startup/uninstall');
      assert.equal(recorded[0]?.method, 'POST');
    },
  );
});

test('a failed install is reported as the state the service actually has', async () => {
  // The install silently fails: the service still says installed:false. The
  // checkbox must follow the service, otherwise it shows a task that is not there.
  await withService(
    (request) => (request.method === 'POST'
      ? { status: 500, body: '{"error":"nope"}' }
      : { status: 200, body: '{"installed":false}' }),
    async (options) => {
      assert.deepEqual(await setStartupInstalled(options, true), { installed: false, reachable: true });
    },
  );
});

test('an unreachable service is unknown rather than an error', async () => {
  await withService(
    () => 'close',
    async (options) => {
      assert.deepEqual(await readStartupState(options), { installed: null, reachable: false });
    },
  );
});

test('an error status is unreachable, and a body without a boolean is unknown', async () => {
  await withService(
    () => ({ status: 503, body: '{"installed":true}' }),
    async (options) => {
      assert.deepEqual(await readStartupState(options), { installed: null, reachable: false });
    },
  );
  await withService(
    () => ({ status: 200, body: '{"installed":"yes"}' }),
    async (options) => {
      assert.deepEqual(
        await readStartupState(options),
        { installed: null, reachable: true },
        'the service answered, but not with a boolean',
      );
    },
  );
  await withService(
    () => ({ status: 200, body: 'not json at all' }),
    async (options) => {
      assert.deepEqual(await readStartupState(options), { installed: null, reachable: false });
    },
  );
});

test('setStartupInstalled never throws when the service is down', async () => {
  await withService(
    () => 'close',
    async (options) => {
      assert.deepEqual(await setStartupInstalled(options, true), { installed: null, reachable: false });
    },
  );
});