import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/domain/config.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore, redactAuditEvent } from '../src/store/audit-store.js';
import { STARTUP_TASK_NAME, WatchdogInstallation, type StartupTaskScheduler } from '../src/lifecycle/installation.js';

test('config store writes a validated document atomically and preserves the previous value on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-config-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  assert.deepEqual(await store.load(), defaultConfig);

  const updated = await store.save({
    ...defaultConfig,
    dryRun: true,
    tools: { ...defaultConfig.tools, claude: { ...defaultConfig.tools.claude, normalPrompt: '继续一下' } },
  });
  assert.equal(updated.dryRun, true);
  assert.equal((await store.load()).tools.claude.normalPrompt, '继续一下');

  await assert.rejects(() => store.save({ ...defaultConfig, pollIntervalMs: 0 }), /pollIntervalMs/);
  assert.equal((await store.load()).dryRun, true);
  assert.deepEqual((await readdir(directory)).sort(), ['config.json']);
  assert.match(await readFile(path, 'utf8'), /继续一下/);
});

test('audit store redacts secrets and absolute credential paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-audit-'));
  const store = new AuditStore(join(directory, 'audit.jsonl'));
  await store.append({
    id: 'event-1',
    timestampMs: 1,
    type: 'injection',
    prompt: '继续',
    details: {
      authorization: 'Bearer super-secret-token-value',
      apiKey: 'sk-1234567890abcdef',
      credentialPath: 'C:\\Users\\me\\.codex\\auth.json',
      safe: 'active',
    },
  });

  const events = await store.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, '继续');
  assert.equal(events[0].details?.safe, 'active');
  assert.equal(events[0].details?.authorization, '[redacted]');
  assert.equal(events[0].details?.apiKey, '[redacted]');
  assert.equal(events[0].details?.credentialPath, '[redacted-path]');
  assert.equal(redactAuditEvent({ ...events[0], details: { secret: 'Bearer abcdefghijkl' } }).details?.secret, '[redacted]');
});

test('watchdog installation owns startup task creation and removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-startup-owner-'));
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const calls: string[] = [];
  let exists = false;
  const scheduler: StartupTaskScheduler = {
    query: async (name) => { calls.push(`query:${name}`); return exists; },
    create: async (name, action) => { calls.push(`create:${name}:${action}`); exists = true; },
    remove: async (name) => { calls.push(`remove:${name}`); exists = false; },
  };
  const installation = new WatchdogInstallation({
    stateDirectory,
    repositoryRoot: root,
    platform: 'win32',
    scheduler,
    now: () => 123,
  });

  await installation.installStartup({ port: 49_001, dryRun: true });
  assert.deepEqual(await installation.startupStatus(), { installed: true, name: STARTUP_TASK_NAME });
  const manifest = JSON.parse(await readFile(join(stateDirectory, 'install-manifest.json'), 'utf8')) as {
    startupTask: { name: string; owned: boolean } | null;
  };
  assert.deepEqual(manifest.startupTask, { name: STARTUP_TASK_NAME, owned: true });
  assert.match(calls.find((call) => call.startsWith('create:')) ?? '', /-Port 49001 -NoBuild -DryRun$/);

  await installation.uninstallStartup();
  assert.deepEqual(await installation.startupStatus(), { installed: false });
  assert.ok(calls.includes(`remove:${STARTUP_TASK_NAME}`));

  await installation.installStartup();
  await installation.removeOwnedState();
  assert.ok(calls.filter((call) => call === `remove:${STARTUP_TASK_NAME}`).length >= 2);
});

test('refuses to replace an unowned startup task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-startup-unowned-'));
  const scheduler: StartupTaskScheduler = {
    query: async () => true,
    create: async () => { throw new Error('create should not be called'); },
    remove: async () => { throw new Error('remove should not be called'); },
  };
  const installation = new WatchdogInstallation({
    stateDirectory: join(root, 'ai-cli-bypass', 'continuation'),
    repositoryRoot: root,
    platform: 'win32',
    scheduler,
  });
  await assert.rejects(() => installation.installStartup(), /unowned scheduled task/);
});

test('config store keeps the cached last-valid value but rejects a malformed cold start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-invalid-config-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  await store.save({ ...defaultConfig, dryRun: true });
  await writeFile(path, '{ malformed');
  assert.equal((await store.load()).dryRun, true);
  await assert.rejects(() => new ConfigStore(path).load(), /JSON|Unexpected|position/i);
});
