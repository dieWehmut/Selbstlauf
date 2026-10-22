import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from 'node:crypto';
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexConfigProfiles } from "../src/codex/profile-store.js";

const SAMPLE = [
  'model = "deepseek-v4.1-flash"',
  'base_url = "https://external-api-platform.hkgai.net/v1"',
  '# base_url = "https://www.sevnx.lol"',
  '',
].join("\n") + "\n";

test("lists the active config plus every parked alternative", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-"));
  try {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath });
    const view = await profiles.describe();
    assert.equal(view.active.model, "deepseek-v4.1-flash");
    assert.equal(view.active.base_url, "https://external-api-platform.hkgai.net/v1");
    assert.deepEqual(view.alternatives.base_url, ["https://www.sevnx.lol"]);
    assert.equal(view.path, configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies a field set atomically and leaves a checksummed backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-apply-"));
  try {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath, now: () => 1_700_000_000_000 });
    const result = await profiles.apply([
      { key: "base_url", value: "https://www.sevnx.lol" },
    ]);
    assert.match(result.text, /^base_url = "https:/mu);
    assert.equal(result.text.includes('# base_url = "https://external-api-platform.hkgai.net/v1"'), true);
    assert.equal(await readFile(configPath, "utf8"), result.text);
    assert.equal(result.backupPath?.endsWith(".bak") === true, true);
    assert.equal(result.backupPath !== null && await readFile(result.backupPath, "utf8") === SAMPLE, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to apply into a missing config file", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-missing-"));
  try {
    const profiles = new CodexConfigProfiles({ configPath: join(root, "config.toml") });
    await assert.rejects(() => profiles.apply([{ key: "model", value: "x" }]), /config.toml/u);
    assert.deepEqual(await profiles.describe().then((view) => ({ exists: view.exists })), { exists: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent applies so the last write wins cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-race-"));
  try {
    const configPath = join(root, "config.toml");
    await mkdir(root, { recursive: true });
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath });
    await Promise.all([
      profiles.apply([{ key: "model", value: "a" }]),
      profiles.apply([{ key: "model", value: "b" }]),
    ]);
    const final = await profiles.describe();
    assert.equal(final.active.model, "b");
    assert.match(await readFile(configPath, "utf8"), /^model = "b"$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically removes an assignment, preserves its backup and reloads the parked value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-profiles-remove-'));
  try {
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, SAMPLE, { encoding: 'utf8', mode: 0o600 });
    const profiles = new CodexConfigProfiles({ configPath, now: () => 42 });
    const removed = await profiles.apply([{ key: 'base_url', value: null }]);
    assert.deepEqual(removed.changes, [{ key: 'base_url', action: 'removed', value: null }]);
    assert.equal(await readFile(removed.backupPath!, 'utf8'), SAMPLE);
    const digest = createHash('sha256').update(SAMPLE).digest('hex');
    assert.equal(await readFile(`${removed.backupPath}.meta`, 'utf8'), `sha256 ${digest}\n`);
    const reloaded = new CodexConfigProfiles({ configPath, now: () => 42 });
    const view = await reloaded.describe();
    assert.equal(view.active.base_url, undefined);
    assert.deepEqual(view.alternatives.base_url, ['https://external-api-platform.hkgai.net/v1', 'https://www.sevnx.lol']);
    const restore = await reloaded.apply([{ key: 'base_url', value: 'https://external-api-platform.hkgai.net/v1' }]);
    assert.notEqual(restore.backupPath, removed.backupPath);
    assert.equal(await readFile(removed.backupPath!, 'utf8'), SAMPLE);
    assert.equal(await readFile(restore.backupPath!, 'utf8'), removed.text);
    if (process.platform !== 'win32') {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(removed.backupPath!)).mode & 0o777, 0o600);
    }
    const before = await readdir(root);
    const noChange = await reloaded.apply([{ key: 'review_model', value: null }]);
    assert.equal(noChange.backupPath, null);
    assert.deepEqual(await readdir(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshots queued edits and rejects unsupported removals without touching any file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-profiles-remove-queue-'));
  try {
    const configPath = join(root, 'config.toml');
    await writeFile(configPath, SAMPLE, 'utf8');
    const profiles = new CodexConfigProfiles({ configPath });
    const edits = [{ key: 'base_url', value: null as string | null }];
    const pending = profiles.apply(edits);
    edits[0].value = 'https://caller-mutated.test';
    await pending;
    assert.equal((await profiles.describe()).active.base_url, undefined);
    const beforeText = await readFile(configPath, 'utf8');
    const beforeFiles = await readdir(root);
    await assert.rejects(profiles.apply([{ key: 'approval_policy', value: null }]), /unsupported/);
    assert.equal(await readFile(configPath, 'utf8'), beforeText);
    assert.deepEqual(await readdir(root), beforeFiles);
  } finally { await rm(root, { recursive: true, force: true }); }
});
