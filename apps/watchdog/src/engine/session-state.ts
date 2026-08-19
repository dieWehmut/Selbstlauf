export type LastDecision =
  | 'new'
  | 'output-observed'
  | 'awaiting-quiet-period'
  | 'injection-pending'
  | 'injected'
  | 'transport-error'
  | 'cooldown'
  | 'max-attempts'
  | 'paused'
  | 'resumed'
  | 'disabled'
  | 'enabled'
  | 'process-exited'
  | 'clock-rollback';

/** Mutable state owned exclusively by WatchdogEngine. */
export interface SessionState {
  readonly sessionId: string;
  lastActivityAt: number | null;
  lastInjectionAt: number | null;
  retryAfterAt: number | null;
  pending: boolean;
  attempts: number;
  paused: boolean;
  enabled: boolean;
  alive: boolean;
  lastDecision: LastDecision;
  lastDecisionAt: number;
  lastTickAt: number | null;
}

export interface SessionStateSnapshot {
  readonly sessionId: string;
  readonly lastActivityAt: number | null;
  readonly lastInjectionAt: number | null;
  readonly retryAfterAt: number | null;
  readonly pending: boolean;
  readonly attempts: number;
  readonly paused: boolean;
  readonly enabled: boolean;
  readonly alive: boolean;
  readonly lastDecision: LastDecision;
  readonly lastDecisionAt: number;
  readonly lastTickAt: number | null;
}

export function createSessionState(sessionId: string, atMs: number): SessionState {
  return {
    sessionId,
    lastActivityAt: atMs,
    lastInjectionAt: null,
    retryAfterAt: null,
    pending: false,
    attempts: 0,
    paused: false,
    enabled: true,
    alive: true,
    lastDecision: 'new',
    lastDecisionAt: atMs,
    lastTickAt: null,
  };
}

export function snapshotSessionState(state: SessionState): SessionStateSnapshot {
  return Object.freeze({
    sessionId: state.sessionId,
    lastActivityAt: state.lastActivityAt,
    lastInjectionAt: state.lastInjectionAt,
    retryAfterAt: state.retryAfterAt,
    pending: state.pending,
    attempts: state.attempts,
    paused: state.paused,
    enabled: state.enabled,
    alive: state.alive,
    lastDecision: state.lastDecision,
    lastDecisionAt: state.lastDecisionAt,
    lastTickAt: state.lastTickAt,
  });
}
