import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvironmentCheck, buildCheckReport } from '../src/environment/environment-check.js';

test('reports every catalog tool with its state and install command', async () => {
  const check = new EnvironmentCheck({
    readInstalled: async () => [
      { id: 'claude', installed: '2.1.274' },
      { id: 'codex', installed: '0.155.0' },
      { id: 'gemini', installed: '0.50.0' },
      { id: 'grok', installed: null },
      { id: 'opencode', installed: '1.17.15' },
      { id: 'openclaw', installed: '2026.3.28' },
    ],
    readLatest: async () => new Map([
      ['@anthropic-ai/claude-code', '2.1.276'],
      ['@openai/codex', '0.155.0'],
      ['@google/gemini-cli', '0.60.0'],
      ['@xai-official/grok', '1.0.34'],
      ['opencode-ai', '1.18.31'],
      ['openclaw', '2026.9.4'],
    ]),
  });

  const report = await check.report();
  assert.equal(report.tools.length, 6);

  const byId = new Map(report.tools.map((tool) => [tool.id, tool]));
  assert.equal(byId.get('claude')?.state, 'outdated');
  assert.equal(byId.get('claude')?.installed, '2.1.274');
  assert.equal(byId.get('claude')?.latest, '2.1.276');
  assert.equal(byId.get('codex')?.state, 'current');
  assert.equal(byId.get('grok')?.state, 'missing');
  assert.equal(byId.get('opencode')?.state, 'outdated');
  assert.equal(byId.get('openclaw')?.state, 'outdated');

  // Every card carries the copy that the manual-install panel offers.
  for (const tool of report.tools) {
    assert.ok(tool.installCommand.startsWith('npm i -g '), tool.id);
    assert.ok(tool.label.length > 0, tool.id);
  }
});

test('lists the upgradeable tools and the ones that need a manual install', async () => {
  const report = await buildCheckReport({
    readInstalled: async () => [
      { id: 'claude', installed: '2.1.274' },
      { id: 'codex', installed: '0.155.0' },
      { id: 'gemini', installed: '0.50.0' },
      { id: 'grok', installed: null },
      { id: 'opencode', installed: '1.17.15' },
      { id: 'openclaw', installed: '2026.9.4' },
    ],
    readLatest: async () => new Map([
      ['@anthropic-ai/claude-code', '2.1.276'],
      ['@openai/codex', '0.155.0'],
      ['@google/gemini-cli', '0.50.0'],
      ['@xai-official/grok', '1.0.34'],
      ['opencode-ai', '1.17.15'],
      ['openclaw', '2026.9.4'],
    ]),
  });

  assert.deepEqual(report.upgrades, ['claude']);
  assert.deepEqual(report.missing, ['grok']);
  assert.equal(report.checkedAtMs > 0, true);
});

test('the manual command block covers every catalog tool', async () => {
  const check = new EnvironmentCheck({
    readInstalled: async () => [],
    readLatest: async () => new Map(),
  });
  const report = await check.report();
  for (const tool of report.tools) {
    assert.ok(report.manualCommands.includes(tool.installCommand), tool.id);
  }
});

test('survives a probe that throws and still answers', async () => {
  const check = new EnvironmentCheck({
    readInstalled: async () => {
      throw new Error('no package manager');
    },
    readLatest: async () => {
      throw new Error('offline');
    },
  });
  const report = await check.report();
  assert.equal(report.tools.length, 6);
  for (const tool of report.tools) assert.equal(tool.state, 'missing');
});

test('caches one scan so the panel does not re-probe on every poll', async () => {
  let scans = 0;
  const check = new EnvironmentCheck({
    readInstalled: async () => {
      scans += 1;
      return [{ id: 'codex', installed: '0.155.0' }];
    },
    readLatest: async () => new Map([['@openai/codex', '0.155.0']]),
    now: () => 1_000,
  });

  const first = await check.report();
  const second = await check.report();
  assert.equal(scans, 1, 'the second report reuses the cached scan');
  assert.equal(first.checkedAtMs, second.checkedAtMs);

  const refreshed = await check.report({ refresh: true });
  assert.equal(scans, 2, 'an explicit refresh re-probes');
  assert.equal(refreshed.checkedAtMs, 1_000);
});
