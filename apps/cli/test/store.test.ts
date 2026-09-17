import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/domain/config.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore, redactAuditEvent } from '../src/store/audit-store.js';
import {
  resolveStartScriptPath,
  START_SCRIPT_CANDIDATES,
  START_SCRIPT_ENVIRONMENT_VARIABLE,
  STARTUP_TASK_NAME,
  WatchdogInstallation,
  type StartupTaskScheduler,
} from '../src/lifecycle/installation.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

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
    ownedPaths: string[];
  };
  assert.deepEqual(manifest.startupTask, { name: STARTUP_TASK_NAME, owned: true });
  assert.ok(manifest.ownedPaths.includes('claude-leases.json'));
  assert.ok(manifest.ownedPaths.includes('claude-leases.json.lock'));
  assert.ok(manifest.ownedPaths.includes('claude-hook-manifest.json'));
  assert.ok(manifest.ownedPaths.includes('claude-settings.backup.json'));
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

test('startup task action resolves the script beside the module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-startup-script-'));
  const repositoryRoot = join(root, 'repository');
  const moduleDirectory = join(repositoryRoot, 'apps', 'cli', 'dist', 'src', 'lifecycle');
  const script = join(repositoryRoot, 'scripts', 'continuation', 'start-watchdog.ps1');
  await mkdir(join(repositoryRoot, 'scripts', 'continuation'), { recursive: true });
  await writeFile(script, "# fixture\n", 'utf8');
  const moduleUrl = pathToFileURL(join(moduleDirectory, 'installation.js')).href;
  assert.deepEqual(START_SCRIPT_CANDIDATES, [
    ['..', '..', '..', '..', '..', 'scripts', 'continuation', 'start-watchdog.ps1'],
    ['..', '..', '..', 'scripts', 'continuation', 'start-watchdog.ps1'],
  ]);
  assert.equal(await resolveStartScriptPath(undefined, moduleUrl), resolve(script));

  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const calls: string[] = [];
  const scheduler: StartupTaskScheduler = {
    query: async () => false,
    create: async (_name, action) => { calls.push(action); },
    remove: async () => undefined,
  };
  const installation = new WatchdogInstallation({
    stateDirectory,
    repositoryRoot,
    startScriptPath: script,
    platform: 'win32',
    scheduler,
  });
  await installation.installStartup({ port: 49_002 });
  const action = calls[0] ?? '';
  assert.match(action, /-File ".*start-watchdog\.ps1" -Port 49002 -NoBuild$/);
});

test('a packaged layout resolves service-dist resources next to the module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-startup-packaged-'));
  // resources/service-dist/src/lifecycle -> resources/scripts/continuation
  const resources = join(root, 'resources');
  const moduleDirectory = join(resources, 'service-dist', 'src', 'lifecycle');
  const script = join(resources, 'scripts', 'continuation', 'start-watchdog.ps1');
  await mkdir(join(resources, 'scripts', 'continuation'), { recursive: true });
  await writeFile(script, "# fixture\n", 'utf8');
  const moduleUrl = pathToFileURL(join(moduleDirectory, 'installation.js')).href;
  assert.equal(await resolveStartScriptPath(undefined, moduleUrl), resolve(script));
  // An explicit setting wins, and the environment variable overrides the search.
  assert.equal(await resolveStartScriptPath(' C:\\custom\\start.ps1 ', moduleUrl), resolve('C:\\custom\\start.ps1'));
  const original = process.env[START_SCRIPT_ENVIRONMENT_VARIABLE];
  process.env[START_SCRIPT_ENVIRONMENT_VARIABLE] = script;
  try {
    assert.equal(await resolveStartScriptPath(undefined, moduleUrl), resolve(script));
  } finally {
    if (original === undefined) delete process.env[START_SCRIPT_ENVIRONMENT_VARIABLE];
    else process.env[START_SCRIPT_ENVIRONMENT_VARIABLE] = original;
  }
  // A missing script names the repository-layout candidate instead of guessing.
  const emptyModule = pathToFileURL(join(root, 'nowhere', 'installation.js')).href;
  assert.equal(
    await resolveStartScriptPath(undefined, emptyModule),
    resolve(root, 'nowhere', '..', '..', '..', '..', '..', 'scripts', 'continuation', 'start-watchdog.ps1'),
  );
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
