import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_CATALOG, decideToolState } from '../src/environment/catalog.js';
import { ToolUpgrader, isKnownToolId } from '../src/environment/upgrade.js';

test('recognizes only catalog tool ids', () => {
  for (const entry of AGENT_CATALOG) assert.equal(isKnownToolId(entry.id), true, entry.id);
  assert.equal(isKnownToolId('nope'), false);
  assert.equal(isKnownToolId(''), false);
  assert.equal(isKnownToolId('codex; rm -rf /'), false);
});

test('runs the catalog install command for the requested tool', async () => {
  const runs: Array<readonly string[]> = [];
  const upgrader = new ToolUpgrader({
    runNpm: async (args) => {
      runs.push(args);
      return 'added 1 package';
    },
  });

  const result = await upgrader.upgrade('codex');
  assert.equal(result.ok, true);
  assert.equal(result.id, 'codex');
  assert.deepEqual(runs, [['i', '-g', '@openai/codex@latest']]);
  assert.equal(result.output, 'added 1 package');
});

test('refuses an unknown tool instead of running an arbitrary command', async () => {
  let ran = 0;
  const upgrader = new ToolUpgrader({ runNpm: async () => { ran += 1; return ''; } });
  const result = await upgrader.upgrade('openclaw; calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown tool/u);
  assert.equal(ran, 0, 'nothing is executed for an unknown id');
});

test('reports a failed install without throwing', async () => {
  const upgrader = new ToolUpgrader({
    runNpm: async () => {
      throw new Error('EACCES: permission denied');
    },
  });
  const result = await upgrader.upgrade('claude');
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /EACCES/u);
});

test('upgrades every outdated tool and reports each outcome', async () => {
  const installed = new Map<string, string | null>([
    ['claude', '2.1.274'],
    ['codex', '0.155.0'],
    ['gemini', '0.50.0'],
    ['grok', null],
    ['opencode', '1.17.15'],
    ['openclaw', '2026.3.28'],
  ]);
  const latest = new Map<string, string>([
    ['@anthropic-ai/claude-code', '2.1.276'],
    ['@openai/codex', '0.155.0'],
    ['@google/gemini-cli', '0.60.0'],
    ['@xai-official/grok', '1.0.34'],
    ['opencode-ai', '1.18.31'],
    ['openclaw', '2026.9.4'],
  ]);

  const attempted: string[] = [];
  const upgrader = new ToolUpgrader({
    runNpm: async (args) => {
      attempted.push(args[2]);
      return 'ok';
    },
    report: async () => ({
      tools: AGENT_CATALOG.map((entry) => {
        // The state comes from the versions, so the fixture exercises the same
        // decision the panel uses instead of asserting a hard-coded answer.
        const local = installed.get(entry.id) ?? null;
        const published = latest.get(entry.packageName) ?? null;
        return {
          id: entry.id,
          label: entry.label,
          packageName: entry.packageName,
          installed: local,
          latest: published,
          state: decideToolState({ installed: local, latest: published }),
          installCommand: entry.installCommand,
        };
      }),
      upgrades: [],
      missing: [],
      manualCommands: [],
      checkedAtMs: 1,
    }),
  });

  const results = await upgrader.upgradeAll();
  // Only the outdated tools are touched; the current and missing ones are left alone.
  assert.deepEqual(attempted, [
    '@anthropic-ai/claude-code@latest',
    '@google/gemini-cli@latest',
    'opencode-ai@latest',
    'openclaw@latest',
  ]);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(results.map((result) => result.id), ['claude', 'gemini', 'opencode', 'openclaw']);
});

test('serializes upgrades so two installs never run at once', async () => {
  let active = 0;
  let peak = 0;
  const upgrader = new ToolUpgrader({
    runNpm: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 'ok';
    },
  });

  await Promise.all([upgrader.upgrade('codex'), upgrader.upgrade('claude'), upgrader.upgrade('gemini')]);
  assert.equal(peak, 1, 'a global npm install cannot run concurrently with another');
});
