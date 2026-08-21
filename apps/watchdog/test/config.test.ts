import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultConfig, parseConfig } from '../src/domain/config.js';

test('default config is deeply frozen', () => {
  assert.equal(Object.isFrozen(defaultConfig), true);
  assert.equal(Object.isFrozen(defaultConfig.tools), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.claude), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.claude.stopHook), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.codex), true);
  assert.equal(Object.isFrozen(defaultConfig.tools.codex.goalStatuses), true);
  assert.deepEqual(defaultConfig.tools.claude.stopHook, {
    enabled: false,
    leaseTtlMs: 15_000,
    commandTimeoutMs: 1_500,
  });
});

test('parses a valid config into an independent frozen value', () => {
  const input = structuredClone(defaultConfig);
  const parsed = parseConfig(input);

  assert.deepEqual(parsed, defaultConfig);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.processFilters.include), true);
});

test('parses enabled Claude Stop Hook durations', () => {
  const parsed = parseConfig({
    ...defaultConfig,
    tools: {
      ...defaultConfig.tools,
      claude: {
        ...defaultConfig.tools.claude,
        stopHook: {
          enabled: true,
          leaseTtlMs: 20_000,
          commandTimeoutMs: 2_000,
        },
      },
    },
  });

  assert.deepEqual(parsed.tools.claude.stopHook, {
    enabled: true,
    leaseTtlMs: 20_000,
    commandTimeoutMs: 2_000,
  });
  assert.equal(Object.isFrozen(parsed.tools.claude.stopHook), true);
});

test('defaults a legacy Claude config to a disabled Stop Hook', () => {
  const legacy = structuredClone(defaultConfig) as unknown as {
    tools: { claude: Record<string, unknown> };
  };
  delete legacy.tools.claude.stopHook;

  const parsed = parseConfig(legacy);

  assert.deepEqual(parsed.tools.claude.stopHook, defaultConfig.tools.claude.stopHook);
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

test('rejects invalid Claude Stop Hook durations and identifies each setting', () => {
  const withStopHook = (stopHook: unknown) => ({
    ...defaultConfig,
    tools: {
      ...defaultConfig.tools,
      claude: { ...defaultConfig.tools.claude, stopHook },
    },
  });

  assert.throws(
    () => parseConfig(withStopHook({ enabled: true, leaseTtlMs: 0, commandTimeoutMs: 1_500 })),
    /tools\.claude\.stopHook\.leaseTtlMs/,
  );
  assert.throws(
    () => parseConfig(withStopHook({ enabled: true, leaseTtlMs: 15_000, commandTimeoutMs: Number.POSITIVE_INFINITY })),
    /tools\.claude\.stopHook\.commandTimeoutMs/,
  );
  assert.throws(
    () => parseConfig(withStopHook({ enabled: true, leaseTtlMs: 15_000.5, commandTimeoutMs: 1_500 })),
    /tools\.claude\.stopHook\.leaseTtlMs/,
  );
});

test('rejects unknown tool names', () => {
  const input = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  const tools = input.tools as Record<string, unknown>;
  tools.opencode = { enabled: true, normalPrompt: 'continue' };

  assert.throws(() => parseConfig(input), /unknown tool.*opencode/i);
});
