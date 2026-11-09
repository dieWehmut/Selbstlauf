import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { WebSocket } from 'ws';

import { ClaudeLeaseStore } from '../src/claude/lease-store.js';
import { parseWatchdogArguments, startWatchdogProcess } from '../src/index.js';
import type { SessionController } from '../src/server/http-server.js';

const emptySessions: SessionController = {
  list: () => [],
  pause: () => false,
  resume: () => false,
  inject: () => ({ ok: false, error: 'no sessions' }),
};

test('CLI remote flags are explicit, bounded, and keep remote control disabled by default', () => {
  assert.deepEqual(parseWatchdogArguments([]), { help: false, options: {} });
  assert.deepEqual(parseWatchdogArguments([
    '--remote-bind', '0.0.0.0', '--remote-port', '49123', '--remote-name', 'Desk',
  ]), {
    help: false,
    options: { remote: { host: '0.0.0.0', port: 49_123, name: 'Desk' } },
  });
  assert.equal(parseWatchdogArguments(['--help']).help, true);
  assert.throws(() => parseWatchdogArguments(['--remote-port', '70000']), /between 0 and 65535/u);
  assert.throws(() => parseWatchdogArguments(['--unknown']), /unknown argument/u);
});

test('shutdown closes stalled HTTP, browser preconnect and active event connections before removing the PID record', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-shutdown-sockets-'));
  const service = await startWatchdogProcess({ stateDirectory: join(root, 'ai-cli-bypass', 'continuation'), port: 0 }, emptySessions);
  const base = service.server.url();
  const url = new URL(base);
  const sockets: Socket[] = [];
  let websocket: WebSocket | undefined;
  let stopping: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const socket = async () => {
    const client = connect({ host: url.hostname, port: Number(url.port) });
    sockets.push(client);
    client.on('error', () => undefined);
    await once(client, 'connect');
    return client;
  };
  try {
    await socket(); // A browser may open a TCP connection before sending headers.
    const pending = await socket();
    pending.write(`PUT /api/config HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${base}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    const events = await socket();
    const ready = once(events, 'data');
    events.write(`GET /api/events HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\n\r\n`);
    assert.match(String((await ready)[0]), /event: ready/u);
    websocket = new WebSocket(`${base.replace('http:', 'ws:')}/api/socket`, { headers: { origin: base } });
    websocket.on('error', () => undefined);
    await once(websocket, 'open');
    const closed = sockets.map((client) => new Promise<void>((resolve) => client.once('close', () => resolve())));
    closed.push(new Promise<void>((resolve) => websocket!.once('close', () => resolve())));
    stopping = service.stop();
    await Promise.race([
      Promise.all([stopping, ...closed]),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('service shutdown left an active connection')), 2_000); }),
    ]);
    assert.ok(sockets.every((client) => client.destroyed));
    assert.equal(websocket.readyState, WebSocket.CLOSED);
    assert.equal(await pathExists(service.pidFile), false);
  } finally {
    clearTimeout(timeout);
    for (const client of sockets) client.destroy();
    websocket?.terminate();
    await (stopping ?? service.stop());
    await rm(root, { recursive: true, force: true });
  }
});

test('a rejected WebSocket upgrade cannot keep shutdown waiting on a half-open client', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-shutdown-upgrade-'));
  const service = await startWatchdogProcess({ stateDirectory: join(root, 'ai-cli-bypass', 'continuation'), port: 0 }, emptySessions);
  const url = new URL(service.server.url());
  const client = connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  client.on('error', () => undefined);
  let stopping: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(client, 'connect');
    const denied = once(client, 'data');
    client.write(`GET /api/socket HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: https://evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: YWJjZGVmZ2hpamtsbW5vcA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match(String((await denied)[0]), /^HTTP\/1\.1 403 Forbidden/u);
    // Keep our write side open even after the response's FIN, like an uncooperative client.
    stopping = service.stop();
    await Promise.race([
      stopping,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('rejected upgrade blocked shutdown')), 2_000); }),
    ]);
    assert.equal(await pathExists(service.pidFile), false);
  } finally {
    clearTimeout(timeout);
    client.destroy();
    await (stopping ?? service.stop());
    await rm(root, { recursive: true, force: true });
  }
});

test('process composition starts and stops the authenticated remote facade when requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-index-remote-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const processHandle = await startWatchdogProcess({
    stateDirectory,
    host: '127.0.0.1',
    port: 0,
    remote: { host: '127.0.0.1', port: 0, name: 'Test workstation' },
  }, emptySessions);
  try {
    assert.ok(processHandle.remoteGateway !== undefined);
    const remote = processHandle.remoteGateway;
    assert.equal((await fetch(`${remote.url()}/remote/v1/health`)).status, 401);
    const pairing = remote.pairingCode();
    const pairedResponse = await fetch(`${remote.url()}/remote/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, device_name: 'Test phone' }),
    });
    assert.equal(pairedResponse.status, 200);
    const paired = await pairedResponse.json() as { token: string };
    const health = await fetch(`${remote.url()}/remote/v1/health`, {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    assert.equal(health.status, 200);
    const local = processHandle.server.url();
    const management = await fetch(`${local}/api/remote`);
    const managed = await management.json() as { enabled: boolean; pairing: { code: string }; devices: { id: string; name: string }[] };
    assert.equal(managed.enabled, true);
    assert.equal(managed.devices[0]?.name, 'Test phone');
    assert.notEqual(managed.pairing.code, pairing.code);
    assert.ok(!JSON.stringify(managed).includes(paired.token));
    assert.ok(!JSON.stringify(managed).includes('tokenHash'));
    const forbiddenHeaders: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of forbiddenHeaders) {
      assert.equal((await fetch(`${local}/api/remote`, { headers })).status, 403);
    }
    // fetch replaces Host in Node 24; send the rebinding authority over HTTP
    // directly so this regression checks the real header reaching the server.
    assert.equal(await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${local}/api/remote`, { headers: { host: `rebound.example:${new URL(local).port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    }), 403);
    assert.equal((await fetch(`${local}/api/remote/pairing`, { method: 'POST' })).status, 403);
    const refreshed = await fetch(`${local}/api/remote/pairing`, { method: 'POST', headers: { origin: local } });
    const fresh = await refreshed.json() as { pairing: { code: string } };
    assert.equal(refreshed.status, 200);
    assert.notEqual(fresh.pairing.code, managed.pairing.code);
    assert.equal((await fetch(`${remote.url()}/remote/v1/remote`, { headers: { authorization: `Bearer ${paired.token}` } })).status, 404);
    assert.equal((await fetch(`${remote.url()}/remote/v1/remote/pairing`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}` } })).status, 404);
    for (const path of ['/remote/enable', '/remote/disable']) {
      assert.equal((await fetch(`${remote.url()}/remote/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${paired.token}` } })).status, 404);
    }
    const revoked = await fetch(`${local}/api/remote/devices/${managed.devices[0]!.id}`, { method: 'DELETE', headers: { origin: local } });
    assert.equal(revoked.status, 200);
    assert.deepEqual((await revoked.json() as { devices: unknown[] }).devices, []);
    assert.equal((await fetch(`${remote.url()}/remote/v1/health`, { headers: { authorization: `Bearer ${paired.token}` } })).status, 401);
    assert.equal((await fetch(`${local}/api/remote/devices/missing`, { method: 'DELETE', headers: { origin: local } })).status, 404);
    const pid = JSON.parse(await readFile(processHandle.pidFile, 'utf8')) as { remotePort?: string };
    assert.equal(pid.remotePort, new URL(remote.url()).port);
  } finally {
    await processHandle.stop();
    assert.equal(await pathExists(processHandle.pidFile), false);
    await rm(root, { recursive: true, force: true });
  }
});

test('process composition exposes an explicit Claude Hook installer without modifying settings on start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-index-hook-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const settingsPath = join(root, '.claude', 'settings.json');
  const original = '{"theme":"dark"}\r\n';
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsPath, original, 'utf8');

  const processHandle = await startWatchdogProcess({
    stateDirectory,
    claudeSettingsPath: settingsPath,
    host: '127.0.0.1',
    port: 0,
  }, emptySessions);
  try {
    const origin = processHandle.server.url();
    assert.equal((await (await fetch(`${origin}/api/remote`)).json() as { enabled: boolean }).enabled, false);
    assert.equal((await fetch(`${origin}/api/remote/pairing`, { method: 'POST', headers: { origin } })).status, 409);
    const leaseStore = new ClaudeLeaseStore(join(stateDirectory, 'claude-leases.json'));
    assert.equal(await readFile(settingsPath, 'utf8'), original);
    assert.deepEqual(await processHandle.claudeHook.status(), {
      installed: false,
      restartRequired: false,
      manualReviewRequired: false,
    });

    await armFixtureLease(leaseStore, root, 'install-session');
    const installedResponse = await fetch(`${origin}/api/claude-hook/install`, {
      method: 'POST',
      headers: { origin },
    });
    assert.equal(installedResponse.status, 200);
    const installed = await installedResponse.json();
    assert.deepEqual(installed, {
      installed: true,
      enabled: false,
      restartRequired: true,
      manualReviewRequired: false,
    });
    assert.deepEqual(await leaseStore.list(), []);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }> };
    };
    const owned = settings.hooks.Stop.at(-1)?.hooks[0];
    assert.equal(owned?.type, 'command');
    assert.equal(owned?.timeout, 1.5);
    assert.match(owned?.command ?? '', /stop-hook-cli\.js" --lease-file ".*claude-leases\.json" --owner selbstlauf-continuation-v1$/u);

    const configResponse = await fetch(`${origin}/api/config`);
    const config = await configResponse.json() as Record<string, any>;
    await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...config,
        tools: {
          ...config.tools,
          claude: {
            ...config.tools.claude,
            stopHook: { ...config.tools.claude.stopHook, enabled: true },
          },
        },
      }),
    });
    await armFixtureLease(leaseStore, root, 'disable-session');
    const disabledResponse = await fetch(`${origin}/api/claude-hook/disable`, {
      method: 'POST',
      headers: { origin },
    });
    assert.deepEqual(await disabledResponse.json(), {
      installed: true,
      enabled: false,
      restartRequired: true,
      manualReviewRequired: false,
    });
    assert.deepEqual(await leaseStore.list(), []);

    const disabledConfig = await fetch(`${origin}/api/config`).then((response) => response.json()) as Record<string, any>;
    await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...disabledConfig,
        tools: {
          ...disabledConfig.tools,
          claude: {
            ...disabledConfig.tools.claude,
            stopHook: { ...disabledConfig.tools.claude.stopHook, enabled: true },
          },
        },
      }),
    });
    await armFixtureLease(leaseStore, root, 'uninstall-session');
    const uninstalledResponse = await fetch(`${origin}/api/claude-hook/uninstall`, {
      method: 'POST',
      headers: { origin },
    });
    assert.deepEqual(await uninstalledResponse.json(), {
      installed: false,
      enabled: true,
      restartRequired: false,
      manualReviewRequired: false,
    });
    assert.deepEqual(await leaseStore.list(), []);
    assert.equal(await readFile(settingsPath, 'utf8'), original);
  } finally {
    await processHandle.stop();
    assert.equal(await pathExists(processHandle.pidFile), false);
    await rm(root, { recursive: true, force: true });
  }
});

test('watchdog uninstall refuses a changed Claude settings file and keeps ownership state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-index-hook-conflict-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const settingsPath = join(root, '.claude', 'settings.json');
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(settingsPath, '{"theme":"dark"}\n', 'utf8');
  const processHandle = await startWatchdogProcess({
    stateDirectory,
    claudeSettingsPath: settingsPath,
    host: '127.0.0.1',
    port: 0,
  }, emptySessions);
  try {
    await processHandle.claudeHook.install();
    const changed = `${JSON.stringify({
      ...JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>,
      changedByUser: true,
    }, null, 2)}\n`;
    await writeFile(settingsPath, changed, 'utf8');
    const origin = processHandle.server.url();
    const response = await fetch(`${origin}/api/uninstall`, { method: 'POST', headers: { origin } });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /changed after installation/i);
    assert.equal(await readFile(settingsPath, 'utf8'), changed);
    assert.equal(await pathExists(join(stateDirectory, 'claude-hook-manifest.json')), true);
    assert.equal(await pathExists(join(stateDirectory, 'claude-settings.backup.json')), true);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  } finally {
    await processHandle.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('composes the Codex profile store and applies endpoint switches end to end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-index-codex-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const configPath = join(root, '.codex', 'config.toml');
  const original = [
    'model = "deepseek-v4.1-flash"',
    'base_url = "https://external-api-platform.hkgai.net/v1"',
    '# base_url = "https://www.sevnx.lol"',
    '',
  ].join('\n');
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(configPath, original, 'utf8');
  const processHandle = await startWatchdogProcess({
    stateDirectory,
    codexConfigPath: configPath,
    host: '127.0.0.1',
    port: 0,
  }, emptySessions);
  try {
    const origin = processHandle.server.url();
    const describedResponse = await fetch(`${origin}/api/codex/profiles`);
    assert.equal(describedResponse.status, 200);
    const described = await describedResponse.json() as Record<string, any>;
    assert.equal(described.active.base_url, 'https://external-api-platform.hkgai.net/v1');
    assert.deepEqual(described.alternatives.base_url, ['https://www.sevnx.lol']);
    assert.equal(described.current.name, 'external-api-platform.hkgai.net');

    const appliedResponse = await fetch(`${origin}/api/codex/profiles`, {
      method: 'PUT',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [
        { key: 'base_url', value: 'https://www.sevnx.lol' },
        { key: 'model', value: 'deepseek-v4.1-flash' },
      ] }),
    });
    assert.equal(appliedResponse.status, 200);
    const applied = await appliedResponse.json() as Record<string, any>;
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.changes.find((change: any) => change.key === 'base_url'), {
      key: 'base_url', action: 'uncommented', value: 'https://www.sevnx.lol',
    });

    const written = await readFile(configPath, 'utf8');
    assert.equal(written.includes('base_url = "https://www.sevnx.lol"'), true);
    assert.equal(written.includes('# base_url = "https://external-api-platform.hkgai.net/v1"'), true);
    assert.equal(written.includes('model = "deepseek-v4.1-flash"'), true);

    const writtenFiles = await readdir(join(root, '.codex'));
    assert.equal(writtenFiles.some((name) => name.endsWith('.bak')), true);
    const backupName = writtenFiles.find((name) => name.endsWith('.bak'))!;
    assert.equal(await readFile(join(root, '.codex', backupName), 'utf8'), original);

    const auditLines = (await readFile(join(stateDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n');
    const override = auditLines.map((line) => JSON.parse(line)).find((event) => event.details?.action === 'codex-profile-apply');
    assert.equal(override?.type, 'user-override');
    assert.equal(override?.details?.keys, 'base_url,model');

    const rejected = await fetch(`${origin}/api/codex/profiles`, {
      method: 'PUT',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [] }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await processHandle.stop();
    assert.equal(await pathExists(processHandle.pidFile), false);
    await rm(root, { recursive: true, force: true });
  }
});

async function armFixtureLease(store: ClaudeLeaseStore, cwd: string, sessionId: string): Promise<void> {
  await store.arm({
    sessionId,
    cwd,
    prompt: 'continue',
    rootPid: 1_200,
    processStartedAtMs: 1_000,
    activity: { size: 10, mtimeMs: 20 },
    ttlMs: 30_000,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
