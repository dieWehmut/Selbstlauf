import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_CATALOG,
  compareVersions,
  decideToolState,
} from '../src/environment/catalog.js';

test('describes every supported agent with its package and install command', () => {
  const names = AGENT_CATALOG.map((entry) => entry.id);
  assert.deepEqual(names, ['claude', 'codex', 'gemini', 'grok', 'opencode', 'openclaw']);

  for (const entry of AGENT_CATALOG) {
    assert.ok(entry.label.length > 0, `${entry.id} has a label`);
    assert.ok(entry.packageName.length > 0, `${entry.id} has a package`);
    assert.match(entry.installCommand, /^npm i -g /u, `${entry.id} documents its install command`);
  }
});

test('compares dotted versions numerically, not as strings', () => {
  assert.equal(compareVersions('2.1.274', '2.1.276'), -1);
  assert.equal(compareVersions('0.60.0', '0.50.0'), 1);
  assert.equal(compareVersions('1.17.15', '1.17.15'), 0);
  assert.equal(compareVersions('2.1.9', '2.1.10'), -1, 'a string compare would order 9 after 10');
  assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing segment counts as zero');
  assert.equal(compareVersions('2026.3.28', '2026.9.4'), -1, 'date versions compare segment-wise');
});

test('reports an outdated tool, an up-to-date tool, and a missing tool', () => {
  assert.equal(decideToolState({ installed: '2.1.274', latest: '2.1.276' }), 'outdated');
  assert.equal(decideToolState({ installed: '0.155.0', latest: '0.155.0' }), 'current');
  assert.equal(decideToolState({ installed: null, latest: '1.0.34' }), 'missing');
});

test('never claims an update when the latest version is unknown', () => {
  assert.equal(decideToolState({ installed: '1.0.0', latest: null }), 'unknown');
  assert.equal(decideToolState({ installed: '1.0.0', latest: 'not-a-version' }), 'unknown');
});

test('treats a newer installed build as current, never as outdated', () => {
  assert.equal(decideToolState({ installed: '2.2.0', latest: '2.1.276' }), 'current');
});
