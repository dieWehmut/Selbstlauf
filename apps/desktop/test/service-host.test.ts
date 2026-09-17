import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertBundledDistribution,
  resolveBundledDistribution,
  startBundledService,
  type WatchdogServiceModule,
} from '../src/service-host.js';

test('resolves the repository layout when the app is not packaged', () => {
  const appRoot = resolve('apps', 'desktop');
  const distribution = resolveBundledDistribution({ appRoot });
  assert.equal(distribution.serviceEntry, resolve('apps', 'cli', 'dist', 'src', 'index.js'));
  assert.equal(distribution.staticDirectory, resolve('apps', 'web', 'dist'));
});

test('resolves packaged resources ahead of the repository layout', () => {
  const distribution = resolveBundledDistribution({
    appRoot: resolve('apps', 'desktop'),
    resourcesPath: 'C:\\Program Files\\Selbstlauf\\resources',
  });
  assert.equal(
    distribution.serviceEntry,
    resolve('C:\\Program Files\\Selbstlauf\\resources', 'service-dist', 'src', 'index.js'),
  );
  assert.equal(
    distribution.staticDirectory,
    resolve('C:\\Program Files\\Selbstlauf\\resources', 'web-dist'),
  );
});

test('ignores a blank resources path so unpackaged launches keep working', () => {
  const distribution = resolveBundledDistribution({ appRoot: resolve('apps', 'desktop'), resourcesPath: '   ' });
  assert.equal(distribution.serviceEntry, resolve('apps', 'cli', 'dist', 'src', 'index.js'));
});

test('names the missing artifact when the bundled distribution is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-distribution-'));
  try {
    assert.throws(
      () => assertBundledDistribution({ serviceEntry: join(root, 'missing.js'), staticDirectory: root }),
      /bundled watchdog service not found/u,
    );
    await writeFile(join(root, 'present.js'), '', 'utf8');
    assert.throws(
      () => assertBundledDistribution({ serviceEntry: join(root, 'present.js'), staticDirectory: join(root, 'nope') }),
      /bundled web UI not found/u,
    );
    assert.doesNotThrow(() => assertBundledDistribution({ serviceEntry: join(root, 'present.js'), staticDirectory: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('starts the bundled service with the bundled static directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-host-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const serviceEntry = join(root, 'service-dist', 'src', 'index.js');
  const staticDirectory = join(root, 'web-dist');
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(serviceEntry, '', 'utf8');

  const calls: Array<Record<string, unknown>> = [];
  const loadServiceModule = async (): Promise<WatchdogServiceModule> => ({
    startWatchdogProcess: async (serviceOptions) => {
      calls.push(serviceOptions as Record<string, unknown>);
      return { server: { url: () => 'http://127.0.0.1:48920' }, stop: async () => undefined };
    },
  });

  try {
    const host = await startBundledService({
      appRoot: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      resourcesPath: root,
      loadServiceModule,
      probeHealth: async () => false,
    });
    assert.equal(host.origin, 'http://127.0.0.1:48920');
    assert.equal(host.pid, process.pid);
    assert.equal(host.reused, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, '127.0.0.1');
    assert.equal(calls[0]?.staticDirectory, staticDirectory);
    assert.ok(stateDirectory.endsWith(join('ai-cli-bypass', 'continuation')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adopts a healthy recorded service instead of starting another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-adopt-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const serviceEntry = join(root, 'service-dist', 'src', 'index.js');
  const staticDirectory = join(root, 'web-dist');
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(serviceEntry, '', 'utf8');
  await writeFile(
    join(stateDirectory, 'watchdog.pid.json'),
    JSON.stringify({ pid: 987654, port: '48931', entryPath: 'X' }),
    'utf8',
  );

  let started = 0;
  try {
    const host = await startBundledService({
      appRoot: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      resourcesPath: root,
      probeHealth: async () => true,
      loadServiceModule: async () => ({
        startWatchdogProcess: async () => {
          started += 1;
          return { server: { url: () => 'http://127.0.0.1:1' }, stop: async () => undefined };
        },
      }),
    });
    assert.equal(host.reused, true);
    assert.equal(host.pid, 987654);
    assert.equal(host.origin, 'http://127.0.0.1:48931');
    assert.equal(started, 0);
    await host.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replaces a stale record whose service no longer answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stale-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(join(root, 'service-dist', 'src'), { recursive: true });
  await mkdir(join(root, 'web-dist'), { recursive: true });
  await writeFile(join(root, 'service-dist', 'src', 'index.js'), '', 'utf8');
  const recordPath = join(stateDirectory, 'watchdog.pid.json');
  await writeFile(recordPath, JSON.stringify({ pid: 555, port: '48999', entryPath: 'X' }), 'utf8');

  let stopped = 0;
  try {
    const host = await startBundledService({
      appRoot: root,
      environment: { LOCALAPPDATA: root } as NodeJS.ProcessEnv,
      resourcesPath: root,
      probeHealth: async () => false,
      loadServiceModule: async () => ({
        startWatchdogProcess: async () => ({
          server: { url: () => 'http://127.0.0.1:49001' },
          stop: async () => {
            stopped += 1;
          },
        }),
      }),
    });
    assert.equal(host.reused, false);
    assert.equal(host.origin, 'http://127.0.0.1:49001');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(recordPath), false, 'the stale record is removed before the new service claims it');
    await host.stop();
    assert.equal(stopped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

