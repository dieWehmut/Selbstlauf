import {
  createSessionState,
  snapshotSessionState,
  type LastDecision,
  type SessionState,
  type SessionStateSnapshot,
} from './session-state.js';

export interface WatchdogEngineOptions {
  readonly idleTimeoutMs: number;
  readonly cooldownMs: number;
  readonly maxAttemptsPerQuietPeriod?: number;
}

export interface InjectionIntent {
  readonly sessionId: string;
  readonly issuedAtMs: number;
  readonly attempt: number;
}

export class WatchdogEngine {
  private readonly idleTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly maxAttemptsPerQuietPeriod: number;
  private readonly sessions = new Map<string, SessionState>();

  public constructor(options: WatchdogEngineOptions) {
    this.idleTimeoutMs = requirePositiveNumber(options.idleTimeoutMs, 'idleTimeoutMs');
    this.cooldownMs = requirePositiveNumber(options.cooldownMs, 'cooldownMs');
    this.maxAttemptsPerQuietPeriod = requirePositiveInteger(
      options.maxAttemptsPerQuietPeriod ?? 1,
      'maxAttemptsPerQuietPeriod',
    );
  }

  public observeOutput(sessionId: string, atMs: number): void {
    assertSessionId(sessionId);
    assertTimestamp(atMs);

    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = createSessionState(sessionId, atMs);
      this.sessions.set(sessionId, state);
    } else if (!state.alive) {
      // A late output event must not resurrect a process that discovery marked dead.
      return;
    }

    state.lastActivityAt = Math.max(state.lastActivityAt ?? atMs, atMs);
    state.pending = false;
    state.attempts = 0;
    state.lastInjectionAt = null;
    state.retryAfterAt = null;
    state.lastDecision = 'output-observed';
    state.lastDecisionAt = atMs;
    if (state.lastTickAt !== null && atMs > state.lastTickAt) {
      state.lastTickAt = atMs;
    }
  }

  public observeSession(
    sessionId: string,
    atMs: number,
    options: { readonly enabled?: boolean; readonly paused?: boolean; readonly alive?: boolean } = {},
  ): void {
    assertSessionId(sessionId);
    assertTimestamp(atMs);

    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = createSessionState(sessionId, atMs);
      this.sessions.set(sessionId, state);
    }

    state.alive = options.alive ?? true;
    state.enabled = options.enabled ?? state.enabled;
    state.paused = options.paused ?? state.paused;
    if (state.lastActivityAt === null) {
      state.lastActivityAt = atMs;
    }
    state.lastDecision = state.alive ? 'new' : 'process-exited';
    state.lastDecisionAt = atMs;
  }

  public tick(nowMs = Date.now()): readonly InjectionIntent[] {
    assertTimestamp(nowMs);
    const intents: InjectionIntent[] = [];

    for (const state of this.sessions.values()) {
      if (this.isClockRollback(state, nowMs)) {
        this.decide(state, 'clock-rollback', nowMs);
        continue;
      }
      state.lastTickAt = nowMs;

      if (!state.alive) {
        this.decide(state, 'process-exited', nowMs);
        continue;
      }
      if (!state.enabled) {
        this.decide(state, 'disabled', nowMs);
        continue;
      }
      if (state.paused) {
        this.decide(state, 'paused', nowMs);
        continue;
      }
      if (state.pending) {
        this.decide(state, 'injection-pending', nowMs);
        continue;
      }
      if (state.attempts >= this.maxAttemptsPerQuietPeriod) {
        this.decide(state, 'max-attempts', nowMs);
        continue;
      }
      if (state.retryAfterAt !== null && nowMs < state.retryAfterAt) {
        this.decide(state, 'cooldown', nowMs);
        continue;
      }
      if (state.lastActivityAt === null || nowMs - state.lastActivityAt <= this.idleTimeoutMs) {
        this.decide(state, 'awaiting-quiet-period', nowMs);
        continue;
      }

      state.pending = true;
      this.decide(state, 'injection-pending', nowMs);
      intents.push(
        Object.freeze({
          sessionId: state.sessionId,
          issuedAtMs: nowMs,
          attempt: state.attempts + 1,
        }),
      );
    }

    return Object.freeze(intents);
  }

  public recordInjectionSuccess(sessionId: string, atMs: number): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.pending) {
      return false;
    }

    const effectiveAt = this.monotonicEventTime(state, atMs);
    state.pending = false;
    state.attempts += 1;
    state.lastInjectionAt = effectiveAt;
    state.retryAfterAt = effectiveAt + this.cooldownMs;
    this.decide(state, 'injected', effectiveAt);
    return true;
  }

  public recordTransportError(sessionId: string, atMs: number): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.pending) {
      return false;
    }

    const effectiveAt = this.monotonicEventTime(state, atMs);
    state.pending = false;
    state.retryAfterAt = effectiveAt + this.cooldownMs;
    this.decide(state, 'transport-error', effectiveAt);
    return true;
  }

  public pause(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return false;
    }
    state.paused = true;
    state.pending = false;
    state.retryAfterAt = null;
    this.decide(state, 'paused', this.stateTime(state));
    return true;
  }

  public resume(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.alive) {
      return false;
    }
    state.paused = false;
    this.decide(state, 'resumed', this.stateTime(state));
    return true;
  }

  public setEnabled(sessionId: string, enabled: boolean): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return false;
    }
    state.enabled = enabled;
    if (!enabled) {
      state.pending = false;
    }
    this.decide(state, enabled ? 'enabled' : 'disabled', this.stateTime(state));
    return true;
  }

  public markExited(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return false;
    }
    state.alive = false;
    state.pending = false;
    this.decide(state, 'process-exited', this.stateTime(state));
    return true;
  }

  public setAlive(sessionId: string, alive: boolean): boolean {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return false;
    }
    state.alive = alive;
    if (!alive) {
      state.pending = false;
    }
    this.decide(state, alive ? 'resumed' : 'process-exited', this.stateTime(state));
    return true;
  }

  public removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  public getState(sessionId: string): SessionStateSnapshot | null {
    const state = this.sessions.get(sessionId);
    return state === undefined ? null : snapshotSessionState(state);
  }

  public getStates(): readonly SessionStateSnapshot[] {
    return Object.freeze([...this.sessions.values()].map(snapshotSessionState));
  }

  private isClockRollback(state: SessionState, nowMs: number): boolean {
    return (
      (state.lastTickAt !== null && nowMs < state.lastTickAt) ||
      (state.lastActivityAt !== null && nowMs < state.lastActivityAt)
    );
  }

  private monotonicEventTime(state: SessionState, atMs: number): number {
    assertTimestamp(atMs);
    return Math.max(atMs, state.lastTickAt ?? atMs);
  }

  private stateTime(state: SessionState): number {
    return state.lastTickAt ?? state.lastActivityAt ?? 0;
  }

  private decide(state: SessionState, decision: LastDecision, atMs: number): void {
    state.lastDecision = decision;
    state.lastDecisionAt = atMs;
  }
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
}

function assertTimestamp(atMs: number): void {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    throw new TypeError('timestamp must be a finite number');
  }
}

function requirePositiveNumber(value: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${path} must be a positive finite number`);
  }
  return value;
}

function requirePositiveInteger(value: number, path: string): number {
  const number = requirePositiveNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new RangeError(`${path} must be a positive integer`);
  }
  return number;
}
