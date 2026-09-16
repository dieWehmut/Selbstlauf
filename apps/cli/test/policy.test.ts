import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultConfig } from '../src/domain/config.js';
import { chooseCodexPrompt } from '../src/domain/policy.js';

test('routes resumable Codex goals to the goal command', () => {
  assert.equal(
    chooseCodexPrompt({ status: 'active' }, defaultConfig.tools.codex),
    '/goal resume',
  );
  assert.equal(
    chooseCodexPrompt({ status: 'paused' }, defaultConfig.tools.codex),
    '/goal resume',
  );
});

test('routes a missing goal to the configured normal prompt', () => {
  assert.equal(
    chooseCodexPrompt(null, defaultConfig.tools.codex),
    '继续',
  );
});

test('routes terminal and unknown goals to the normal prompt', () => {
  for (const status of [
    'complete',
    'blocked',
    'usage_limited',
    'budget_limited',
    'unknown',
  ] as const) {
    assert.equal(
      chooseCodexPrompt({ status }, defaultConfig.tools.codex),
      '继续',
    );
  }
});

test('uses the configured prompts and resumable statuses', () => {
  const config = {
    ...defaultConfig.tools.codex,
    normalPrompt: 'carry on',
    goalPrompt: '/goal continue',
    goalStatuses: ['paused'] as const,
  };

  assert.equal(chooseCodexPrompt({ status: 'paused' }, config), '/goal continue');
  assert.equal(chooseCodexPrompt({ status: 'active' }, config), 'carry on');
});
