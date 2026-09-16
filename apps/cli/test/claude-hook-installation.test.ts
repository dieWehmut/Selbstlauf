import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_HOOK_BACKUP_NAME,
  CLAUDE_HOOK_MANIFEST_NAME,
  CLAUDE_HOOK_OWNER,
  ClaudeHookInstallation,
} from '../src/claude/hook-installation.js';

const HOOK_COMMAND = 'node "C:\\tools\\stop-hook.js" --lease-file "C:\\state\\claude-leases.json" --owner selbstlauf-continuation-v1';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-hook-installation-'));
  const settingsPath = join(root, '.claude', 'settings.json');
  const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
  const installation = new ClaudeHookInstallation({
    settingsPath,
    stateDirectory,
    hookCommand: HOOK_COMMAND,
    now: () => 123_456,
  });
  return { root, settingsPath, stateDirectory, installation };
}

test('installs one recognizable Stop command and is idempotent', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();
  const original = `${JSON.stringify({
    theme: 'dark',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo existing' }] }],
      Stop: [{ matcher: 'existing', hooks: [{ type: 'command', command: 'echo stop' }] }],
    },
  }, null, 4).replaceAll('\n', '\r\n')}\r\n`;
  await writeFileEnsuringParent(settingsPath, original);

  assert.deepEqual(await installation.install(), {
    installed: true,
    restartRequired: true,
    manualReviewRequired: false,
  });
  const firstInstalledText = await readFile(settingsPath, 'utf8');
  const installed = JSON.parse(firstInstalledText) as {
    theme: string;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  assert.equal(installed.theme, 'dark');
  assert.deepEqual(installed.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: 'echo existing' }] },
  ]);
  assert.deepEqual(installed.hooks.Stop, [
    { matcher: 'existing', hooks: [{ type: 'command', command: 'echo stop' }] },
    { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 1.5 }] },
  ]);

  const manifest = JSON.parse(await readFile(join(stateDirectory, CLAUDE_HOOK_MANIFEST_NAME), 'utf8')) as {
    schemaVersion: number;
    owner: string;
    settingsPath: string;
    hookCommand: string;
    commandTimeoutMs: number;
    settingsExisted: boolean;
    backupFile: string;
    beforeSha256: string;
    afterSha256: string;
  };
  assert.deepEqual({
    schemaVersion: manifest.schemaVersion,
    owner: manifest.owner,
    settingsPath: resolve(manifest.settingsPath),
    hookCommand: manifest.hookCommand,
    commandTimeoutMs: manifest.commandTimeoutMs,
    settingsExisted: manifest.settingsExisted,
    backupFile: manifest.backupFile,
  }, {
    schemaVersion: 1,
    owner: CLAUDE_HOOK_OWNER,
    settingsPath: resolve(settingsPath),
    hookCommand: HOOK_COMMAND,
    commandTimeoutMs: 1_500,
    settingsExisted: true,
    backupFile: CLAUDE_HOOK_BACKUP_NAME,
  });
  assert.match(manifest.beforeSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.afterSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(manifest.beforeSha256, manifest.afterSha256);
  assert.equal(await readFile(join(stateDirectory, CLAUDE_HOOK_BACKUP_NAME), 'utf8'), original);

  assert.deepEqual(await installation.install(), {
    installed: true,
    restartRequired: true,
    manualReviewRequired: false,
  });
  assert.equal(await readFile(settingsPath, 'utf8'), firstInstalledText);
  assert.equal(countOccurrences(firstInstalledText, CLAUDE_HOOK_OWNER), 1);
  assert.deepEqual(await installation.status(), {
    installed: true,
    restartRequired: true,
    manualReviewRequired: false,
  });
});

test('uninstall restores the exact original settings bytes and unrelated hooks', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();
  const original = '{\r\n  "env": { "SAFE": "value" },\r\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo user" }] }] }\r\n}\r\n';
  await writeFileEnsuringParent(settingsPath, original);
  await installation.install();

  assert.deepEqual(await installation.uninstall(), {
    installed: false,
    restartRequired: false,
    manualReviewRequired: false,
  });
  assert.equal(await readFile(settingsPath, 'utf8'), original);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_MANIFEST_NAME)), false);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_BACKUP_NAME)), false);
});

test('missing settings starts from an empty object and uninstall removes only the created file', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();

  await installation.install();
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 1.5 }] }],
    },
  });
  assert.equal(await readFile(join(stateDirectory, CLAUDE_HOOK_BACKUP_NAME), 'utf8'), '');

  await installation.uninstall();
  assert.equal(await pathExists(settingsPath), false);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_MANIFEST_NAME)), false);
});

test('malformed settings are never modified and create no ownership state', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();
  const malformed = '{ "hooks": ';
  await writeFileEnsuringParent(settingsPath, malformed);

  const result = await installation.install();
  assert.equal(result.installed, false);
  assert.equal(result.restartRequired, false);
  assert.equal(result.manualReviewRequired, true);
  assert.match(result.lastError ?? '', /settings JSON is invalid/i);
  assert.equal(await readFile(settingsPath, 'utf8'), malformed);
  assert.deepEqual(await readdir(stateDirectory).catch(() => [] as string[]), []);
});

test('install refuses to overwrite settings changed during the operation', async () => {
  const { root, settingsPath, stateDirectory } = await fixture();
  const original = '{"theme":"dark"}\n';
  const concurrentChange = '{"theme":"light","changedByUser":true}\n';
  await writeFileEnsuringParent(settingsPath, original);
  const installation = new ClaudeHookInstallation({
    settingsPath,
    stateDirectory,
    hookCommand: HOOK_COMMAND,
    commandTimeoutMs: async () => {
      await writeFile(settingsPath, concurrentChange, 'utf8');
      return 1_500;
    },
  });

  const result = await installation.install();
  assert.equal(result.installed, false);
  assert.equal(result.manualReviewRequired, true);
  assert.match(result.lastError ?? '', /changed during installation/i);
  assert.equal(await readFile(settingsPath, 'utf8'), concurrentChange);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_MANIFEST_NAME)), false);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_BACKUP_NAME)), false);
  assert.ok(root.length > 0);
});

test('checksum conflicts require manual review without overwriting user changes', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();
  await writeFileEnsuringParent(settingsPath, '{"theme":"dark"}\n');
  await installation.install();
  const changed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  changed.theme = 'light';
  changed.userChange = true;
  const changedText = `${JSON.stringify(changed, null, 2)}\n`;
  await writeFile(settingsPath, changedText, 'utf8');

  const result = await installation.uninstall();
  assert.equal(result.installed, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.manualReviewRequired, true);
  assert.match(result.lastError ?? '', /changed after installation/i);
  assert.equal(await readFile(settingsPath, 'utf8'), changedText);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_MANIFEST_NAME)), true);
  assert.equal(await pathExists(join(stateDirectory, CLAUDE_HOOK_BACKUP_NAME)), true);
});

test('a modified owned Hook entry is not reported as installed', async () => {
  const { settingsPath, installation } = await fixture();
  await installation.install();
  const changed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> };
  };
  const owned = changed.hooks.Stop.at(-1)?.hooks[0];
  assert.ok(owned !== undefined);
  owned.timeout = 9;
  await writeFile(settingsPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');

  const status = await installation.status();
  assert.equal(status.installed, false);
  assert.equal(status.manualReviewRequired, true);
});

test('uninstall follows the owned manifest after the repository command path changes', async () => {
  const { settingsPath, stateDirectory, installation } = await fixture();
  const original = '{"theme":"dark"}\n';
  await writeFileEnsuringParent(settingsPath, original);
  await installation.install();
  const relocated = new ClaudeHookInstallation({
    settingsPath,
    stateDirectory,
    hookCommand: 'node "D:\\relocated\\stop-hook.js" --lease-file "D:\\relocated\\leases.json" --owner selbstlauf-continuation-v1',
  });

  const status = await relocated.status();
  assert.equal(status.installed, false);
  assert.equal(status.manualReviewRequired, true);
  assert.deepEqual(await relocated.uninstall(), {
    installed: false,
    restartRequired: false,
    manualReviewRequired: false,
  });
  assert.equal(await readFile(settingsPath, 'utf8'), original);
});

async function writeFileEnsuringParent(path: string, contents: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
