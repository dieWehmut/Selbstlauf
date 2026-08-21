export const TOOL_NAMES = ['claude', 'codex'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const GOAL_STATUSES = [
  'active',
  'paused',
  'complete',
  'blocked',
  'usage_limited',
  'budget_limited',
  'unknown',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type ResumableGoalStatus = Extract<GoalStatus, 'active' | 'paused'>;

export const TRANSPORT_KINDS = [
  'classic-console',
  'pty',
  'codex-app-server',
  'monitor-only',
  'cannot-inject',
  'unknown',
] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export interface GoalSnapshot {
  readonly status: GoalStatus;
  readonly updatedAtMs?: number;
}

export interface SessionSnapshot {
  readonly id: string;
  readonly tool: ToolName;
  readonly rootPid: number;
  readonly childPids: readonly number[];
  readonly conversationId: string | null;
  readonly goal: GoalSnapshot | null;
  readonly transport: TransportKind;
  readonly alive: boolean;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number | null;
}

export interface ToolConfig {
  readonly enabled: boolean;
  readonly normalPrompt: string;
}

export interface ClaudeStopHookConfig {
  readonly enabled: boolean;
  readonly leaseTtlMs: number;
  readonly commandTimeoutMs: number;
}

export interface ClaudeToolConfig extends ToolConfig {
  readonly stopHook: ClaudeStopHookConfig;
}

export interface CodexToolConfig extends ToolConfig {
  readonly goalPrompt: string;
  readonly goalStatuses: readonly ResumableGoalStatus[];
}

export interface WatchdogConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly pollIntervalMs: number;
  readonly defaultIdleTimeoutMs: number;
  readonly defaultCooldownMs: number;
  readonly maxAttemptsPerQuietPeriod: number;
  readonly tools: {
    readonly claude: ClaudeToolConfig;
    readonly codex: CodexToolConfig;
  };
  readonly processFilters: {
    readonly sameUserOnly: boolean;
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
}

export type AuditEventType =
  | 'activity'
  | 'config-change'
  | 'decision'
  | 'injection'
  | 'skip'
  | 'transport-error'
  | 'user-override';

export interface AuditEvent {
  readonly id: string;
  readonly timestampMs: number;
  readonly type: AuditEventType;
  readonly sessionId?: string;
  readonly tool?: ToolName;
  readonly prompt?: string;
  readonly details?: Readonly<Record<string, boolean | number | string | null>>;
}
