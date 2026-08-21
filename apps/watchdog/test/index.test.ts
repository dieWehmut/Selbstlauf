import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ClaudeLeaseStore } from '../src/claude/lease-store.js';
import { startWatchdogProcess } from '../src/index.js';
import type { SessionController } from '../src/server/http-server.js';

const emptySessions: SessionController = {
  list: () => [],
  pause: () => false,
  resume: () => false,
  inject: () => ({ ok: false, error: 'no sessions' }),
};

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
