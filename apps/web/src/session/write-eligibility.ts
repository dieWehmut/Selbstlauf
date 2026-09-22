import type { SessionView } from '../api/client';

/**
 * Whether a session can be written to, and why not.
 *
 * **One rule, in one place.** This existed twice with two different implementations, and they disagreed on a real
 * session — measured on this machine, `codex:9232` has `transport: 'monitor-only'` with
 * `transportError: 'no-cwd-match'`:
 *
 *     the sidebar's dot checked `transportError`  -> 'no-cwd-match' is not a blocker name -> dot said 可写入
 *     the composer checked `transport`            -> 'monitor-only' is a blocker          -> page said 只能监控
 *
 * A row whose dot promises "可写入" while its own detail page refuses is exactly the contradiction that had to
 * stop. Both surfaces now call this, so they cannot drift apart again.
 *
 * **The master switch is deliberately not consulted.** `session.enabled` is the flag for *automatic*
 * continuation, and the service never checks it for a manual write — verified against the running service, where
 * a session reporting `enabled=false` answered 200 to a manual inject. Requiring it here was a defect that made
 * every row claim "会话无法写入" while the write would have worked.
 */

/** Transport kinds that can only be watched: there is nowhere to put the text. */
const MONITOR_ONLY_TRANSPORTS: readonly string[] = ['monitor-only', 'cannot-inject', 'unknown'];

export interface WriteEligibility {
  readonly writable: boolean;
  /** A concrete reason when it is not, suitable for showing to a person. Null when writable. */
  readonly reason: string | null;
}

/**
 * Whether this session can accept text, and why not when it cannot.
 *
 * The transport is the real blocker: a session the service can only watch has no channel to carry a prompt. The
 * service's own `transportError` is preferred as the explanation, because it is more precise than the transport
 * name — it says *why* the transport could not be established.
 */
export function writeEligibility(session: SessionView): WriteEligibility {
  if (!session.alive) return { writable: false, reason: '该会话已停止' };
  if (session.paused) return { writable: false, reason: '该会话已被暂停，恢复后才能写入' };
  if (MONITOR_ONLY_TRANSPORTS.includes(session.transport)) {
    return {
      writable: false,
      reason: session.transportError !== undefined && session.transportError.length > 0
        ? `只能监控，无法写入：${session.transportError}`
        : '只能监控，无法写入',
    };
  }
  return { writable: true, reason: null };
}

/** Shorthand for the many call sites that only need the boolean. */
export function canWriteSession(session: SessionView): boolean {
  return writeEligibility(session).writable;
}