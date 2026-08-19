import {
  GOAL_STATUSES,
  TOOL_NAMES,
  type CodexToolConfig,
  type GoalStatus,
  type ResumableGoalStatus,
  type WatchdogConfig,
} from './types.js';

const resumableGoalStatuses = new Set<GoalStatus>(['active', 'paused']);
const knownGoalStatuses = new Set<GoalStatus>(GOAL_STATUSES);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
}

const defaults: WatchdogConfig = {
  enabled: true,
  dryRun: false,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  tools: {
    claude: {
      enabled: true,
      normalPrompt: '继续',
    },
    codex: {
      enabled: true,
      normalPrompt: '继续',
      goalPrompt: '/goal resume',
      goalStatuses: ['active', 'paused'],
    },
  },
  processFilters: {
    sameUserOnly: true,
    include: [],
    exclude: [],
  },
};

export const defaultConfig: WatchdogConfig = deepFreeze(defaults);

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${path} must be a boolean`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string, label = path): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const number = requirePositiveNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new RangeError(`${path} must be a positive integer`);
  }
  return number;
}

function requirePrompt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${path} must be an array of strings`);
  }
  return [...value];
}

function parseCodexConfig(value: unknown): CodexToolConfig {
  const config = requireRecord(value, 'tools.codex');
  if (!Array.isArray(config.goalStatuses) || config.goalStatuses.length === 0) {
    throw new TypeError('tools.codex.goalStatuses must be a non-empty array');
  }

  const statuses = config.goalStatuses.map((status) => {
    if (typeof status !== 'string' || !knownGoalStatuses.has(status as GoalStatus)) {
      throw new TypeError(`tools.codex.goalStatuses contains unknown status: ${String(status)}`);
    }
    if (!resumableGoalStatuses.has(status as GoalStatus)) {
      throw new RangeError(`tools.codex.goalStatuses cannot auto-resume terminal status: ${status}`);
    }
    return status as ResumableGoalStatus;
  });

  return {
    enabled: requireBoolean(config.enabled, 'tools.codex.enabled'),
    normalPrompt: requirePrompt(config.normalPrompt, 'tools.codex.normalPrompt'),
    goalPrompt: requirePrompt(config.goalPrompt, 'tools.codex.goalPrompt'),
    goalStatuses: [...new Set(statuses)],
  };
}

export function parseConfig(value: unknown): WatchdogConfig {
  const config = requireRecord(value, 'config');
  const tools = requireRecord(config.tools, 'tools');
  const unknownTools = Object.keys(tools).filter(
    (tool) => !TOOL_NAMES.includes(tool as (typeof TOOL_NAMES)[number]),
  );
  if (unknownTools.length > 0) {
    throw new TypeError(`unknown tool name: ${unknownTools.join(', ')}`);
  }

  const claude = requireRecord(tools.claude, 'tools.claude');
  const processFilters = requireRecord(config.processFilters, 'processFilters');

  return deepFreeze({
    enabled: requireBoolean(config.enabled, 'enabled'),
    dryRun: requireBoolean(config.dryRun, 'dryRun'),
    pollIntervalMs: requirePositiveNumber(config.pollIntervalMs, 'pollIntervalMs'),
    defaultIdleTimeoutMs: requirePositiveNumber(
      config.defaultIdleTimeoutMs,
      'defaultIdleTimeoutMs',
      'idleTimeoutMs (defaultIdleTimeoutMs)',
    ),
    defaultCooldownMs: requirePositiveNumber(
      config.defaultCooldownMs,
      'defaultCooldownMs',
      'cooldownMs (defaultCooldownMs)',
    ),
    maxAttemptsPerQuietPeriod: requirePositiveInteger(
      config.maxAttemptsPerQuietPeriod,
      'maxAttemptsPerQuietPeriod',
    ),
    tools: {
      claude: {
        enabled: requireBoolean(claude.enabled, 'tools.claude.enabled'),
        normalPrompt: requirePrompt(claude.normalPrompt, 'tools.claude.normalPrompt'),
      },
      codex: parseCodexConfig(tools.codex),
    },
    processFilters: {
      sameUserOnly: requireBoolean(processFilters.sameUserOnly, 'processFilters.sameUserOnly'),
      include: requireStringArray(processFilters.include, 'processFilters.include'),
      exclude: requireStringArray(processFilters.exclude, 'processFilters.exclude'),
    },
  });
}
