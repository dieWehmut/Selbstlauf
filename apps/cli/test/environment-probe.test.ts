import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNpmGlobalVersions,
  parseHermesVersion,
  readInstalledVersions,
  readLatestVersions,
} from '../src/environment/probe.js';

test('reads npm global package versions from the manager report', () => {
  const report = JSON.stringify({
    dependencies: {
      '@anthropic-ai/claude-code': { version: '2.1.274', overridden: false },
      '@openai/codex': { version: '0.155.0' },
      typescript: { version: '5.9.2' },
    },
  });
  const versions = parseNpmGlobalVersions(report);
  assert.equal(versions.get('@anthropic-ai/claude-code'), '2.1.274');
  assert.equal(versions.get('@openai/codex'), '0.155.0');
  assert.equal(versions.get('typescript'), '5.9.2');
});

test('tolerates a malformed or empty npm report instead of throwing', () => {
  assert.equal(parseNpmGlobalVersions('not json').size, 0);
  assert.equal(parseNpmGlobalVersions('').size, 0);
  assert.equal(parseNpmGlobalVersions('{}').size, 0);
  assert.equal(parseNpmGlobalVersions('{"dependencies": null}').size, 0);
});

test('skips npm entries without a usable version string', () => {
  const report = JSON.stringify({ dependencies: { plain: {}, broken: { version: 3 } } });
  assert.equal(parseNpmGlobalVersions(report).size, 0);
});

test('reads the Hermes version banner, which is not an npm package', () => {
  const banner = 'Hermes Agent v0.18.0 (2026.7.1) · upstream 0a8d4cae · local 60906be3 (+1 carried commit)';
  assert.equal(parseHermesVersion(banner), '0.18.0');
  assert.equal(parseHermesVersion('no version here'), null);
  assert.equal(parseHermesVersion(''), null);
});

test('probes every catalog tool and reports a missing tool as null', async () => {
  const installed = await readInstalledVersions({
    runNpm: async () => JSON.stringify({ dependencies: { '@openai/codex': { version: '0.155.0' } } }),
    runExecutable: async () => '',
    platform: 'win32',
    fileExists: (path) => path.includes('gemini'),
  });
  const byId = new Map(installed.map((entry) => [entry.id, entry.installed]));
  assert.equal(byId.get('codex'), '0.155.0');
  assert.equal(byId.get('gemini'), 'unknown', 'a present executable without a readable version is unknown, not missing');
  assert.equal(byId.get('claude'), null);
});

test('asks the registry for every npm-published tool', async () => {
  const asked: string[] = [];
  const latest = await readLatestVersions({
    runNpmView: async (packageName) => {
      asked.push(packageName);
      return packageName === '@openai/codex' ? '0.155.0\n' : '';
    },
  });
  assert.equal(latest.get('@openai/codex'), '0.155.0', 'trailing whitespace is trimmed');
  assert.equal(latest.has('@anthropic-ai/claude-code'), false, 'an empty answer means unknown');
  assert.deepEqual(asked.sort(), [
    '@anthropic-ai/claude-code',
    '@google/gemini-cli',
    '@openai/codex',
    '@xai-official/grok',
    'openclaw',
    'opencode-ai',
  ]);
});

test('a registry failure leaves the version unknown instead of failing the scan', async () => {
  const latest = await readLatestVersions({
    runNpmView: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(latest.size, 0);
});
