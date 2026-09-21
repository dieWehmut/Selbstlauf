export const TOOL_NAMES = ['claude', 'codex', 'dsh'] as const;
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
  'claude-stop-hook',
  'dsh-web',
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

export interface DshToolConfig extends ToolConfig {
  /**
   * DeepSeek Harness sessions whose newest recorded activity is older than
   * this window are treated as history rather than live agents.
   */
  readonly sessionWindowMs: number;
  /**
   * Whether a quiet harness session may be continued through the harness's own
   * loopback session API. When false, or when the harness host cannot be
   * authenticated, the tool stays `monitor-only`.
   */
  readonly allowApiInput: boolean;
}

export interface WatchdogConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly pollIntervalMs: number;
  readonly defaultIdleTimeoutMs: number;
  readonly defaultCooldownMs: number;
  readonly maxAttemptsPerQuietPeriod: number;
  /**
   * The WSL distribution to look inside, or an empty string for "do not".
   *
   * WSL sessions live in a Linux pid namespace and are invisible to the Windows process table, so they can
   * only be found by running a probe inside the distribution. That makes this opt-in rather than automatic:
   * it costs a subprocess per poll, and only helps someone who runs a CLI there.
   */
  readonly wslDistribution: string;
  readonly tools: {
    readonly claude: ClaudeToolConfig;
    readonly codex: CodexToolConfig;
    readonly dsh: DshToolConfig;
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
