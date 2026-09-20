/**
 * Repeated and concurrent saves to the config store.
 *
 * The existing test proves a *rejected* save leaves no temporary file behind. What it
 * does not cover is the path that runs on every real save: on Windows `rename` refuses
 * to replace an existing file, so `replaceAtomically` falls into its backup branch —
 * rename the old file aside, rename the new one in, delete the backup. That branch is
 * what the app exercises every time a user saves, and a leak in it would leave
 * `.tmp`/`.bak` files accumulating in the state directory.
 *
 * It also matters that concurrent saves cannot interleave into a corrupt document:
 * the renderer, the tray and the service can all write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore } from '../src/store/config-store.js';
import { defaultConfig } from '../src/domain/config.js';

test('many successful saves leave only the config file behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-config-repeat-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  await store.load();

  // Each save replaces an existing file, which is the branch that stages a backup.
  for (let i = 0; i < 25; i += 1) {
    await store.save({ ...defaultConfig, dryRun: i % 2 === 0 });
  }

  const entries = (await readdir(directory)).sort();
  assert.deepEqual(
    entries,
    ['config.json'],
    `repeated saves left extra files behind: ${entries.join(', ')}`,
  );

  // And the file is still a single valid document, not a concatenation.
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { dryRun?: boolean };
  assert.equal(typeof parsed.dryRun, 'boolean');
  assert.equal(raw.trimEnd().endsWith('}'), true, 'the config file is not a complete JSON document');
});

test('concurrent saves never produce a corrupt or partial document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-config-concurrent-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  await store.load();

  // Interleave writers that each set a different prompt, then check the result is one
  // of them rather than a blend of two.
  const prompts = Array.from({ length: 12 }, (_, i) => `writer-${i}`);
  await Promise.all(prompts.map((prompt) => store.save({
    ...defaultConfig,
    tools: { ...defaultConfig.tools, claude: { ...defaultConfig.tools.claude, normalPrompt: prompt } },
  })));

  const raw = await readFile(path, 'utf8');
  // A partial write would make this throw; a blend would fail the membership check.
  const parsed = JSON.parse(raw) as { tools: { claude: { normalPrompt?: string } } };
  assert.ok(
    prompts.includes(parsed.tools.claude.normalPrompt ?? ''),
    `the saved document is not one complete writer's value: ${parsed.tools.claude.normalPrompt}`,
  );

  const entries = (await readdir(directory)).sort();
  assert.deepEqual(entries, ['config.json'], `concurrent saves left: ${entries.join(', ')}`);

  // The store must also still read back what it last wrote.
  const loaded = await store.load();
  assert.equal(loaded.tools.claude.normalPrompt, parsed.tools.claude.normalPrompt);
});

test('a save that is rejected mid-sequence does not damage the accepted document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-config-mixed-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  await store.load();

  await store.save({
    ...defaultConfig,
    tools: { ...defaultConfig.tools, claude: { ...defaultConfig.tools.claude, normalPrompt: 'kept' } },
  });

  // A rejected save must leave the good document exactly as it was.
  await assert.rejects(() => store.save({ ...defaultConfig, pollIntervalMs: -1 }));
  await assert.rejects(() => store.save('not an object'));
  await assert.rejects(() => store.save(null));

  const loaded = await store.load();
  assert.equal(loaded.tools.claude.normalPrompt, 'kept');
  const entries = (await readdir(directory)).sort();
  assert.deepEqual(entries, ['config.json'], `rejected saves left: ${entries.join(', ')}`);
});