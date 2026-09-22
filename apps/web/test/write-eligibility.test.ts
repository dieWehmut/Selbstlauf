import { describe, expect, it } from 'vitest';

import type { SessionView } from '../src/api/client';
import { canWriteSession, writeEligibility } from '../src/session/write-eligibility';

/**
 * The single rule for whether a session accepts text.
 *
 * This exists because the same question was answered in two places with two different implementations, and they
 * disagreed on a real session — measured, `codex:9232` has `transport: 'monitor-only'` with
 * `transportError: 'no-cwd-match'`, so the sidebar's dot said 可写入 while the detail page said 只能监控.
 */

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'codex:1',
    tool: 'codex',
    rootPid: 100,
    childPids: [],
    conversationId: null,
    goal: null,
    transport: 'codex-app-server',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: 0,
    lastActivityAtMs: null,
    quietForMs: 0,
    host: null,
    ...overrides,
  } as unknown as SessionView;
}

describe('writeEligibility', () => {
  it('allows a live session whose transport can carry text', () => {
    for (const transport of ['codex-app-server', 'dsh-web', 'classic-console', 'claude-stop-hook']) {
      const result = writeEligibility(session({ transport: transport as SessionView['transport'] }));
      expect(result.writable, `${transport} should be writable`).toBe(true);
      expect(result.reason).toBeNull();
    }
  });

  it('refuses a transport that can only be watched, and says why', () => {
    for (const transport of ['monitor-only', 'cannot-inject', 'unknown']) {
      const result = writeEligibility(session({ transport: transport as SessionView['transport'] }));
      expect(result.writable, `${transport} should be refused`).toBe(false);
      expect(result.reason).toContain('只能监控');
    }
  });

  it("prefers the service's own reason, which is more precise than the transport name", () => {
    // `no-cwd-match` says *why* the transport could not be established, which the transport name cannot.
    const result = writeEligibility(session({ transport: 'monitor-only', transportError: 'no-cwd-match' }));
    expect(result.reason).toBe('只能监控，无法写入：no-cwd-match');
  });

  it('refuses a session that is not alive or is paused', () => {
    expect(writeEligibility(session({ alive: false })).writable).toBe(false);
    expect(writeEligibility(session({ alive: false })).reason).toContain('已停止');
    expect(writeEligibility(session({ paused: true })).writable).toBe(false);
    expect(writeEligibility(session({ paused: true })).reason).toContain('暂停');
  });

  /**
   * The master switch governs *automatic* continuation, not manual writing.
   *
   * Verified against the running service: a session reporting `enabled=false` answered 200 to a manual inject.
   * Requiring it here was a defect that made every row claim "会话无法写入" while the write would have worked.
   */
  it('allows a manual write even when automatic continuation is switched off', () => {
    const result = writeEligibility(session({ enabled: false }));
    expect(result.writable, 'the master switch must not block a manual write').toBe(true);
    expect(canWriteSession(session({ enabled: false }))).toBe(true);
  });

  it('is not affected by an unrelated transport error', () => {
    // An error that is not a blocker name leaves the session writable; the detail page surfaces the error.
    const result = writeEligibility(session({ transportError: 'something-else' }));
    expect(result.writable).toBe(true);
  });

  it('agrees with itself for every combination, which is the point of having one rule', () => {
    const transports = ['codex-app-server', 'dsh-web', 'classic-console', 'monitor-only', 'cannot-inject', 'unknown'];
    const errors = [undefined, 'no-cwd-match', 'monitor-only', 'cannot-inject', 'something-else'];
    for (const transport of transports) {
      for (const transportError of errors) {
        const target = session({ transport: transport as SessionView['transport'], transportError });
        const eligibility = writeEligibility(target);
        // The boolean shorthand and the detailed reason must never contradict each other.
        expect(canWriteSession(target)).toBe(eligibility.writable);
        // A refusal always carries a reason a person can act on; a success never carries one.
        expect(eligibility.reason === null).toBe(eligibility.writable);
      }
    }
  });
});