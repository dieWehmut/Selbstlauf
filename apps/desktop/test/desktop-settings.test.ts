import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_SETTINGS_FILE,
  normalizeDesktopSettings,
  readDesktopSettings,
  resolveDesktopSettingsPath,
  updateDesktopSettings,
  writeDesktopSettings,
} from '../src/desktop-settings.js';

async function withStateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-settings-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('uses the documented defaults when the file is missing', async () => {
  await withStateDirectory(async (directory) => {
    assert.deepEqual(DEFAULT_DESKTOP_SETTINGS, { closeToTray: true, preferredTerminal: null });
    assert.deepEqual(await readDesktopSettings(directory), { closeToTray: true, preferredTerminal: null });
    // The file lives beside the service state, not inside the service's config.
    assert.equal(resolveDesktopSettingsPath(directory), join(directory, DESKTOP_SETTINGS_FILE));
    assert.equal(DESKTOP_SETTINGS_FILE, 'desktop-settings.json');
  });
});

test('falls back to the defaults on corrupt JSON', async () => {
  await withStateDirectory(async (directory) => {
    await writeFile(resolveDesktopSettingsPath(directory), '{ this is not json', 'utf8');
    assert.deepEqual(await readDesktopSettings(directory), DEFAULT_DESKTOP_SETTINGS);

    await writeFile(resolveDesktopSettingsPath(directory), '["an array is not settings"]', 'utf8');
    assert.deepEqual(await readDesktopSettings(directory), DEFAULT_DESKTOP_SETTINGS);

    await writeFile(resolveDesktopSettingsPath(directory), 'null', 'utf8');
    assert.deepEqual(await readDesktopSettings(directory), DEFAULT_DESKTOP_SETTINGS);
  });
});

test('keeps the fields it understands and defaults the rest', () => {
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: false }), { closeToTray: false, preferredTerminal: null });
  assert.deepEqual(normalizeDesktopSettings({ closeToTray: 'yes' }), DEFAULT_DESKTOP_SETTINGS);
  assert.deepEqual(normalizeDesktopSettings({ preferredTerminal: 'wt.exe' }), {
    closeToTray: true,
    preferredTerminal: 'wt.exe',
  });
  assert.deepEqual(normalizeDesktopSettings({ preferredTerminal: '   ' }), {
    closeToTray: true,
    preferredTerminal: null,
  });
  // A patch naming only unknown keys leaves the current values alone.
  assert.deepEqual(updatePatch({ closeToTray: false, preferredTerminal: null }, { nonsense: 1 }), {
    closeToTray: false,
    preferredTerminal: null,
  });
});

/** The merge half of `updateDesktopSettings`, without touching the disk. */
function updatePatch(current: typeof DEFAULT_DESKTOP_SETTINGS, patch: unknown) {
  return normalizeDesktopSettings(
    { ...current, ...(patch !== null && typeof patch === 'object' ? (patch as object) : {}) },
    current,
  );
}

test('writes settings and reads them back', async () => {
  await withStateDirectory(async (directory) => {
    const saved = await writeDesktopSettings(directory, { closeToTray: false, preferredTerminal: 'wt.exe' });
    assert.deepEqual(saved, { closeToTray: false, preferredTerminal: 'wt.exe' });
    assert.deepEqual(await readDesktopSettings(directory), { closeToTray: false, preferredTerminal: 'wt.exe' });

    const raw = await readFile(resolveDesktopSettingsPath(directory), 'utf8');
    assert.match(raw, /"closeToTray": false/u);
    assert.equal(raw.endsWith('\n'), true, 'the file stays newline-terminated');
  });
});

test('leaves no temp file behind and writes atomically', async () => {
  await withStateDirectory(async (directory) => {
    await writeDesktopSettings(directory, { closeToTray: true, preferredTerminal: null });
    await writeDesktopSettings(directory, { closeToTray: false, preferredTerminal: null });
    // A rename-based write leaves exactly one file, so a crash cannot expose a
    // half-written settings file to the next launch.
    assert.deepEqual(await readdir(directory), [DESKTOP_SETTINGS_FILE]);
    assert.deepEqual(await readDesktopSettings(directory), { closeToTray: false, preferredTerminal: null });
  });
});

test('creates the state directory when it does not exist yet', async () => {
  await withStateDirectory(async (directory) => {
    const nested = join(directory, 'ai-cli-bypass', 'continuation');
    await writeDesktopSettings(nested, DEFAULT_DESKTOP_SETTINGS);
    assert.deepEqual(await readDesktopSettings(nested), DEFAULT_DESKTOP_SETTINGS);
  });
});

test('updateDesktopSettings merges a patch over what is on disk', async () => {
  await withStateDirectory(async (directory) => {
    await writeDesktopSettings(directory, { closeToTray: true, preferredTerminal: 'wt.exe' });
    const next = await updateDesktopSettings(directory, { closeToTray: false });
    // The untouched field survives; only the patched one changes.
    assert.deepEqual(next, { closeToTray: false, preferredTerminal: 'wt.exe' });
    assert.deepEqual(await readDesktopSettings(directory), next);
  });
});

test('an update from a corrupt file recovers to the defaults plus the patch', async () => {
  await withStateDirectory(async (directory) => {
    await writeFile(resolveDesktopSettingsPath(directory), 'not json at all', 'utf8');
    const next = await updateDesktopSettings(directory, { closeToTray: false });
    assert.deepEqual(next, { closeToTray: false, preferredTerminal: null });
  });
});