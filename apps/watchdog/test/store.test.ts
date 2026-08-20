import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/domain/config.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore, redactAuditEvent } from '../src/store/audit-store.js';

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

test('config store keeps the cached last-valid value but rejects a malformed cold start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watchdog-invalid-config-'));
  const path = join(directory, 'config.json');
  const store = new ConfigStore(path);
  await store.save({ ...defaultConfig, dryRun: true });
  await writeFile(path, '{ malformed');
  assert.equal((await store.load()).dryRun, true);
  await assert.rejects(() => new ConfigStore(path).load(), /JSON|Unexpected|position/i);
});
