import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RemoteControlManager } from '../src/server/remote-control.js';

test('persists explicit gateway enablement across shutdown and restores hashed device credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-'));
  const options = { localBaseUrl: 'http://127.0.0.1:1', settingsPath: join(root, 'settings.json'), deviceStatePath: join(root, 'devices.json') };
  const control = new RemoteControlManager(options);
  const restored = new RemoteControlManager(options);
  const disabled = new RemoteControlManager(options);
  t.after(async () => { await control.stop(); await restored.stop(); await disabled.stop(); await rm(root, { recursive: true, force: true }); });
  await control.start();
  assert.equal(control.view().enabled, false);
  assert.equal(control.view().host, '127.0.0.1');
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Desktop' });
  const gateway = control.gateway!;
  const url = gateway.url();
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Desktop' });
  assert.equal(control.gateway, gateway);
  const pairing = await fetch(`${url}/remote/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: gateway.pairingCode().code, device_name: 'Saved phone' }),
  });
  const result = await pairing.json() as { token: string };
  assert.equal(pairing.status, 200);
  const stored = await readFile(options.settingsPath, 'utf8');
  assert.equal(JSON.parse(stored).enabled, true);
  assert.doesNotMatch(stored, /token|pairing|code/u);
  assert.ok(!stored.includes(result.token));
  await control.stop();
  await assert.rejects(fetch(`${url}/remote/v1/health`));
  assert.equal(JSON.parse(await readFile(options.settingsPath, 'utf8')).enabled, true);
  await restored.start();
  assert.equal(restored.view().enabled, true);
  assert.equal(restored.view().devices[0]?.name, 'Saved phone');
  const revoke = await fetch(`${restored.gateway!.url()}/remote/v1/device`, { method: 'DELETE', headers: { authorization: `Bearer ${result.token}` } });
  assert.equal(revoke.status, 200);
  await restored.disable();
  assert.equal(JSON.parse(await readFile(options.settingsPath, 'utf8')).enabled, false);
  await disabled.start();
  assert.equal(disabled.gateway, undefined);
});

test('rejects unsafe settings and keeps the prior gateway on failed changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-conflict-'));
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath: join(root, 'settings.json'), deviceStatePath: join(root, 'devices.json') });
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== 'string');
  t.after(async () => { await control.stop(); await new Promise<void>((resolve) => occupied.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await control.start();
  await assert.rejects(control.enable({ host: 'evil.example', port: 48921, name: 'Desktop' }), /IP bind/u);
  await assert.rejects(control.enable({ host: '127.0.0.1', port: -1, name: 'Desktop' }), /port/u);
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Working' });
  const previous = control.gateway!;
  await assert.rejects(control.enable({ host: '127.0.0.1', port: address.port, name: 'Blocked' }), /EADDRINUSE/u);
  assert.equal(control.gateway, previous);
  assert.equal(control.view().name, 'Working');
  assert.equal((await fetch(`${previous.url()}/remote/v1/health`)).status, 401);
});

test('a failed automatic restore leaves local management available for repair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-restore-'));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== 'string');
  const settingsPath = join(root, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, host: '127.0.0.1', port: address.port, name: 'Blocked' }));
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: join(root, 'devices.json') });
  t.after(async () => { await control.stop(); await new Promise<void>((resolve) => occupied.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await control.start();
  assert.equal(control.view().enabled, false);
  assert.match(control.view().error!, /EADDRINUSE/u);
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Repaired' });
  assert.equal(control.view().enabled, true);
  assert.equal(control.view().error, undefined);
});

test('serializes startup with shutdown and cannot reopen a stopped manager', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-start-stop-'));
  const settingsPath = join(root, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ version: 1, enabled: true, host: '127.0.0.1', port: 0, name: 'Desktop' }));
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: join(root, 'devices.json') });
  t.after(async () => { await control.stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([control.start(), control.stop()]);
  assert.equal(control.gateway, undefined);
  await control.start();
  assert.equal(control.gateway, undefined);
  await assert.rejects(control.enable({ host: '127.0.0.1', port: 0, name: 'Late request' }), /closing/u);
  await assert.rejects(control.disable(), /closing/u);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).enabled, true);
});

test('shutdown during a settings change does not restore or retain a listener', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-change-stop-'));
  const settingsPath = join(root, 'settings.json');
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: join(root, 'devices.json') });
  t.after(async () => { await control.stop(); await rm(root, { recursive: true, force: true }); });
  await control.start();
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Original' });
  const previous = control.gateway!;
  const stopPrevious = previous.stop.bind(previous);
  let notifyStopped!: () => void;
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { notifyStopped = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  previous.stop = async () => { await stopPrevious(); notifyStopped(); await gate; };
  const changing = control.enable({ host: '127.0.0.1', port: 0, name: 'Changed' });
  await stopped;
  const shutdown = control.stop();
  release();
  const result = await Promise.allSettled([changing, shutdown]);
  assert.equal(result[0]?.status, 'rejected');
  assert.equal(result[1]?.status, 'fulfilled');
  assert.equal(control.gateway, undefined);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).name, 'Original');
});

test('settings write failures restore the previous listener and do not commit enable or disable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-write-failure-'));
  const directory = join(root, 'settings');
  await mkdir(directory);
  const settingsPath = join(directory, 'settings.json');
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: join(root, 'devices.json') });
  t.after(async () => { await control.stop(); await rm(root, { recursive: true, force: true }); });
  await control.start();
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Original' });
  const previous = control.gateway!;
  await rename(directory, `${directory}.offline`);
  await assert.rejects(control.enable({ host: '127.0.0.1', port: 0, name: 'Unwritten' }), /ENOENT/u);
  assert.equal(control.gateway, previous);
  assert.equal(control.view().name, 'Original');
  assert.equal((await fetch(`${previous.url()}/remote/v1/health`)).status, 401);
  await assert.rejects(control.disable(), /ENOENT/u);
  assert.equal(control.gateway, previous);
  assert.equal(control.view().enabled, true);
  await rename(`${directory}.offline`, directory);
  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(saved.name, 'Original');
  assert.equal(saved.enabled, true);
});

test('a failed rollback remains visible and can be repaired from local management', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-rollback-failure-'));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== 'string');
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath: join(root, 'settings.json'), deviceStatePath: join(root, 'devices.json') });
  t.after(async () => {
    await control.stop();
    if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await control.start();
  await control.enable({ host: '127.0.0.1', port: address.port, name: 'Original' });
  const previous = control.gateway!;
  const stopPrevious = previous.stop.bind(previous);
  previous.stop = async () => {
    await stopPrevious();
    await new Promise<void>((resolve) => occupied.listen(address.port, '127.0.0.1', resolve));
  };
  await assert.rejects(control.enable({ host: '127.0.0.1', port: address.port, name: 'Changed' }), /restore.*EADDRINUSE/u);
  assert.equal(control.gateway, undefined);
  assert.match(control.view().error!, /EADDRINUSE/u);
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  await control.enable({ host: '127.0.0.1', port: address.port, name: 'Repaired' });
  assert.equal(control.view().enabled, true);
  assert.equal(control.view().error, undefined);
});

test('restores an explicit device store path without exposing it through the management API', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-control-device-path-'));
  const settingsPath = join(root, 'settings.json');
  const customPath = join(root, 'custom-devices.json');
  const control = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: customPath });
  const restored = new RemoteControlManager({ localBaseUrl: 'http://127.0.0.1:1', settingsPath, deviceStatePath: join(root, 'default-devices.json') });
  t.after(async () => { await control.stop(); await restored.stop(); await rm(root, { recursive: true, force: true }); });
  await control.start();
  await control.enable({ host: '127.0.0.1', port: 0, name: 'Desktop' });
  const gateway = control.gateway!;
  const response = await fetch(`${gateway.url()}/remote/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: gateway.pairingCode().code, device_name: 'Saved phone' }),
  });
  const { token } = await response.json() as { token: string };
  assert.equal(response.status, 200);
  await control.stop();
  await restored.start();
  assert.equal(restored.view().devices[0]?.name, 'Saved phone');
  assert.ok(!JSON.stringify(restored.view()).includes(customPath));
  const revoke = await fetch(`${restored.gateway!.url()}/remote/v1/device`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(revoke.status, 200);
  assert.deepEqual(JSON.parse(await readFile(customPath, 'utf8')).devices, []);
});
