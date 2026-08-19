import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultConfig, parseConfig } from '../src/domain/config.js';

test('default config is deeply frozen', () => {
  assert.equal(Object.isFrozen(defaultConfig), true);
  assert.equal(Object.isFrozen(defaultConfig.tools), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.codex), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.codex.goalStatuses), true);
});

test('parses a valid config into an independent frozen value', () => {
  const input = structuredClone(defaultConfig);
  const parsed = parseConfig(input);

  assert.deepEqual(parsed, defaultConfig);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.processFilters.include), true);
});

test('rejects a non-positive idle timeout and identifies the setting', () => {
  assert.throws(
    () => parseConfig({ ...defaultConfig, defaultIdleTimeoutMs: 0 }),
    /idleTimeoutMs/,
  );
});

test('rejects non-positive poll and cooldown durations', () => {
  assert.throws(
    () => parseConfig({ ...defaultConfig, pollIntervalMs: -1 }),
    /pollIntervalMs/,
  );
  assert.throws(
    () => parseConfig({ ...defaultConfig, defaultCooldownMs: 0 }),
    /cooldownMs/,
  );
});

test('rejects unknown tool names', () => {
  const input = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  const tools = input.tools as Record<string, unknown>;
  tools.opencode = { enabled: true, normalPrompt: 'continue' };

  assert.throws(() => parseConfig(input), /unknown tool.*opencode/i);
});
