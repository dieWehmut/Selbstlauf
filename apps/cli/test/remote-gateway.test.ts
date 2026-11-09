import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteGateway } from '../src/server/remote-gateway.js';

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly origin: string | undefined;
  readonly body: unknown;
}

async function makeLocalServer(received: ReceivedRequest[]) {
  const server = createServer((request, response) => void capture(request, response, received));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function capture(request: IncomingMessage, response: ServerResponse, received: ReceivedRequest[]) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw.length === 0 ? null : JSON.parse(raw) as unknown;
  const path = request.url ?? '/';
  received.push({ method: request.method ?? 'GET', path, origin: request.headers.origin, body });
  const payload = path === '/api/health'
    ? { ok: true, running: true }
    : { ok: true, method: request.method, path, body };
  const encoded = JSON.stringify(payload);
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

async function call(base: string, path: string, options: {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
} = {}) {
  const response = await fetch(`${base}/remote/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { response, json: text.length === 0 ? null : JSON.parse(text) as any };
}

function codeSequence(...codes: string[]) {
  let index = 0;
  return () => codes[Math.min(index++, codes.length - 1)]!;
}

test('pairs one device, persists only its token hash, and restores it after restart', async (t) => {
  const received: ReceivedRequest[] = [];
  const local = await makeLocalServer(received);
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-remote-'));
  const statePath = join(directory, 'devices.json');
  const token = 'token_abcdefghijklmnopqrstuvwxyz_0123456789';
  const gateway = new RemoteGateway({
    localBaseUrl: local.url,
    statePath,
    port: 0,
    name: 'Workstation',
    generatePairingCode: codeSequence('123456', '654321'),
    generateToken: () => token,
    generateDeviceId: () => 'device-1',
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await local.close(); await rm(directory, { recursive: true, force: true }); });

  assert.equal(gateway.pairingCode().code, '123456');
  const paired = await call(gateway.url(), '/pair', { method: 'POST', body: { code: '123456', device_name: 'My phone' } });
  assert.equal(paired.response.status, 200);
  assert.equal(paired.json.token, token);
  assert.equal(paired.response.headers.get('access-control-allow-origin'), '*');
  assert.equal(gateway.pairingCode().code, '654321');

  const stored = await readFile(statePath, 'utf8');
  assert.doesNotMatch(stored, new RegExp(token, 'u'));
  assert.match(stored, /"tokenHash": "[0-9a-f]{64}"/u);
  assert.match(stored, /"name": "My phone"/u);

  const reused = await call(gateway.url(), '/pair', { method: 'POST', body: { code: '123456', device_name: 'Another' } });
  assert.equal(reused.response.status, 401);
  const info = await call(gateway.url(), '/info', { token });
  assert.equal(info.response.status, 200);
  assert.equal(info.json.name, 'Workstation');
  assert.equal(info.json.service.running, true);

  await gateway.stop();
  const restored = new RemoteGateway({ localBaseUrl: local.url, statePath, port: 0, generatePairingCode: () => '222222' });
  await restored.start();
  const restoredInfo = await call(restored.url(), '/info', { token });
  assert.equal(restoredInfo.response.status, 200);
  await restored.stop();
});

test('requires authentication, exposes only the mobile allowlist, and blocks custom launches', async (t) => {
  const received: ReceivedRequest[] = [];
  const local = await makeLocalServer(received);
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-remote-routes-'));
  const token = 'route_token_abcdefghijklmnopqrstuvwxyz_0123456789';
  const gateway = new RemoteGateway({
    localBaseUrl: local.url,
    statePath: join(directory, 'devices.json'),
    port: 0,
    generatePairingCode: codeSequence('111111', '222222'),
    generateToken: () => token,
    generateDeviceId: () => 'routes',
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await local.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await call(gateway.url(), '/sessions')).response.status, 401);
  await call(gateway.url(), '/pair', { method: 'POST', body: { code: '111111', device_name: 'Phone' } });

  const preflight = await fetch(`${gateway.url()}/remote/v1/sessions`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/u);

  const health = await call(gateway.url(), '/health', { token });
  assert.equal(health.response.status, 200);
  assert.equal(health.json.running, true);

  for (const body of [
    { tool: 'custom', command: 'anything' },
    { tool: 'codex', command: '/tmp/not-codex' },
  ]) {
    const rejected = await call(gateway.url(), '/agents', { method: 'POST', token, body });
    assert.equal(rejected.response.status, 403);
  }
  assert.equal(received.filter((entry) => entry.path === '/api/agents').length, 0);

  const launch = await call(gateway.url(), '/agents', {
    method: 'POST', token, body: { tool: 'codex', cwd: '/work', args: ['--model', 'test'] },
  });
  assert.equal(launch.response.status, 200);
  assert.equal(launch.json.path, '/api/agents');
  const inject = await call(gateway.url(), '/sessions/codex%3A1/inject', {
    method: 'POST', token, body: { prompt: '继续' },
  });
  assert.equal(inject.response.status, 200);
  const output = await call(gateway.url(), '/agents/agent-1/output?after=7', { token });
  assert.equal(output.json.path, '/api/agents/agent-1/output?after=7');

  for (const forbidden of ['/config', '/uninstall', '/environment/upgrade']) {
    assert.equal((await call(gateway.url(), forbidden, { method: 'POST', token, body: {} })).response.status, 404);
  }
  const forwarded = received.filter((entry) => entry.path !== '/api/health');
  assert.deepEqual(forwarded.map((entry) => entry.path), [
    '/api/agents',
    '/api/sessions/codex%3A1/inject',
    '/api/agents/agent-1/output?after=7',
  ]);
  assert.ok(forwarded.every((entry) => entry.origin === local.url));
});

test('allows only one concurrent request to consume a pairing code', async (t) => {
  const received: ReceivedRequest[] = [];
  const local = await makeLocalServer(received);
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-remote-concurrent-'));
  let tokenIndex = 0;
  const gateway = new RemoteGateway({
    localBaseUrl: local.url,
    statePath: join(directory, 'devices.json'),
    port: 0,
    generatePairingCode: codeSequence('121212', '343434'),
    generateToken: () => `concurrent_token_abcdefghijklmnopqrstuvwxyz_${++tokenIndex}`,
    generateDeviceId: () => `concurrent-${tokenIndex}`,
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await local.close(); await rm(directory, { recursive: true, force: true }); });

  const attempts = await Promise.all([
    call(gateway.url(), '/pair', { method: 'POST', body: { code: '121212', device_name: 'One' } }),
    call(gateway.url(), '/pair', { method: 'POST', body: { code: '121212', device_name: 'Two' } }),
  ]);
  assert.deepEqual(attempts.map(({ response }) => response.status).sort(), [200, 401]);
  assert.equal(gateway.pairedDevices().length, 1);
  assert.equal(tokenIndex, 1);
});

test('revokes the current device and rejects expired tokens', async (t) => {
  const received: ReceivedRequest[] = [];
  const local = await makeLocalServer(received);
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-remote-expiry-'));
  let now = 1_000;
  let tokenIndex = 0;
  const tokens = ['expiry_token_abcdefghijklmnopqrstuvwxyz_0000000001', 'expiry_token_abcdefghijklmnopqrstuvwxyz_0000000002'];
  const gateway = new RemoteGateway({
    localBaseUrl: local.url,
    statePath: join(directory, 'devices.json'),
    port: 0,
    now: () => now,
    tokenTtlMs: 100,
    generatePairingCode: codeSequence('333333', '444444', '555555'),
    generateToken: () => tokens[tokenIndex++]!,
    generateDeviceId: () => `device-${tokenIndex}`,
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await local.close(); await rm(directory, { recursive: true, force: true }); });

  const first = await call(gateway.url(), '/pair', { method: 'POST', body: { code: '333333', device_name: 'One' } });
  assert.equal((await call(gateway.url(), '/device', { method: 'DELETE', token: first.json.token })).response.status, 200);
  assert.equal((await call(gateway.url(), '/info', { token: first.json.token })).response.status, 401);

  const second = await call(gateway.url(), '/pair', { method: 'POST', body: { code: '444444', device_name: 'Two' } });
  assert.equal((await call(gateway.url(), '/info', { token: second.json.token })).response.status, 200);
  now += 101;
  assert.equal((await call(gateway.url(), '/info', { token: second.json.token })).response.status, 401);
});

test('rate limits pairing attempts per client until its window expires', async (t) => {
  const received: ReceivedRequest[] = [];
  const local = await makeLocalServer(received);
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-remote-limit-'));
  let now = 10_000;
  const gateway = new RemoteGateway({
    localBaseUrl: local.url,
    statePath: join(directory, 'devices.json'),
    port: 0,
    now: () => now,
    pairingAttemptLimit: 2,
    pairingAttemptWindowMs: 50,
    generatePairingCode: codeSequence('777777', '888888'),
    generateToken: () => 'limit_token_abcdefghijklmnopqrstuvwxyz_0123456789',
    generateDeviceId: () => 'limited',
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await local.close(); await rm(directory, { recursive: true, force: true }); });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await call(gateway.url(), '/pair', {
      method: 'POST', body: { code: '000000', device_name: 'Phone' },
    })).response.status, 401);
  }
  assert.equal((await call(gateway.url(), '/pair', {
    method: 'POST', body: { code: '777777', device_name: 'Phone' },
  })).response.status, 429);
  now += 51;
  assert.equal((await call(gateway.url(), '/pair', {
    method: 'POST', body: { code: '777777', device_name: 'Phone' },
  })).response.status, 200);
});
