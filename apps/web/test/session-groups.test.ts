import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_PROJECT_LABEL,
  formatDuration,
  groupSessionsByEnvironment,
  quietMs,
  sessionTone,
  toolLabel,
} from '../src/sidebar/session-groups';
import type { SessionView } from '../src/api/client';
import { writeEligibility } from '../src/session/write-eligibility';

/**
 * The sidebar's grouping and labelling rules.
 *
 * The list is how a session is found in order to act on it, so the grouping must be
 * deterministic — a list that reshuffles between polls cannot be clicked reliably —
 * and it must not drop a session that has no host.
 */
function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    tool: 'codex',
    rootPid: 100,
    childPids: [],
    conversationId: null,
    goal: null,
    transport: 'classic-console',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: 0,
    lastActivityAtMs: null,
    quietForMs: 1000,
    host: { processId: 1, executableName: 'a.exe', label: 'Tabby', category: 'terminal', windowHandle: 1, windowTitle: 'a' },
    ...overrides,
  };
}

describe('sidebar session grouping', () => {
  it('separates environments even when sessions share a terminal and Windows-mounted directory', () => {
    const groups = groupSessionsByEnvironment([
      session({ id: 'windows', sessionCwd: 'C:/project/app' }),
      session({ id: 'ubuntu', distribution: 'Ubuntu', sessionCwd: '/mnt/c/project/app' }),
      session({ id: 'debian', distribution: 'Debian', sessionCwd: '/mnt/c/project/app' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(expect.arrayContaining(['Windows', 'WSL · Ubuntu', 'WSL · Debian']));
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.projects.length === 1)).toBe(true);
  });

  it('normalizes Windows separators and casing without merging distinct POSIX roots', () => {
    const groups = groupSessionsByEnvironment([
      session({ id: 'win1', sessionCwd: 'C:/Projects/App/' }),
      session({ id: 'win2', sessionCwd: String.raw`c:\projects\app` }),
      session({ id: 'linux1', distribution: 'Ubuntu', sessionCwd: '/home/han/App' }),
      session({ id: 'linux2', distribution: 'Ubuntu', sessionCwd: '/home/han/app' }),
    ]);
    expect(groups.find((g) => g.label === 'Windows')?.projects).toHaveLength(1);
    expect(groups.find((g) => g.label.includes('Ubuntu'))?.projects).toHaveLength(2);
  });

  it('keeps Windows extended drive and UNC aliases in their original root groups', () => {
    const groups = groupSessionsByEnvironment([
      session({ id: 'drive', sessionCwd: 'C:/project/app' }),
      session({ id: 'extended-drive', sessionCwd: String.raw`\\?\C:\project\app` }),
      session({ id: 'unc', sessionCwd: String.raw`\\server\share\app` }),
      session({ id: 'extended-unc', sessionCwd: String.raw`\\?\UNC\server\share\app` }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].projects).toHaveLength(2);
    expect(groups[0].projects.map((p) => p.sessions.length)).toEqual([2, 2]);
  });

  it('identifies native Linux from its runtime even with no known project directory', () => {
    const groups = groupSessionsByEnvironment([session({ platform: 'linux', sessionCwd: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Linux');
    expect(groups[0].projects[0].path).toBeNull();
  });

  it('never treats a terminal window title as a project directory', () => {
    const groups = groupSessionsByEnvironment([session({ sessionCwd: null })]);
    expect(groups[0].projects[0].label).toBe(UNKNOWN_PROJECT_LABEL);
    expect(groups[0].projects[0].path).toBeNull();
  });

  it('keeps same-basename projects distinct and orders rows newest first', () => {
    const groups = groupSessionsByEnvironment([
      session({ id: 'old', sessionCwd: 'C:/a/app', lastActivityAtMs: 10 }),
      session({ id: 'new', sessionCwd: 'C:/a/app', lastActivityAtMs: 20 }),
      session({ id: 'other', sessionCwd: 'C:/b/app', lastActivityAtMs: 30 }),
    ]);
    expect(groups[0].projects).toHaveLength(2);
    expect(groups[0].projects.find((p) => p.sessions.length === 2)?.sessions.map((s) => s.id)).toEqual(['new', 'old']);
    expect(groupSessionsByEnvironment([])).toEqual([]);
  });

  it('labels each tool the way the process table does', () => {
    expect(toolLabel('codex')).toBe('Codex');
    expect(toolLabel('claude')).toBe('Claude Code');
    expect(toolLabel('dsh')).toBe('DeepSeek Harness');
    // An unknown tool must be shown as-is rather than as an empty label.
    expect(toolLabel('something-new')).toBe('something-new');
  });

  it('formats a duration compactly and never prints a wrong one', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(18000)).toBe('18s');
    expect(formatDuration(74000)).toBe('1m 14s');
    expect(formatDuration(132000)).toBe('2m 12s');
    // Seconds and minutes are padded, which is the form the table and the sidebar now share.
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(formatDuration(3_600_000)).toBe('1h 00m');
    // A negative or non-finite value must not print something nonsensical.
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('gives a row the tone that matches whether the session is actionable', () => {
    expect(sessionTone(session({ alive: true, paused: false }))).toBe('writable');
    /**
     * The tone now comes from the shared rule, which keys on `transport`.
     *
     * This test previously asserted the opposite — that a blocker appearing in `transportError` was what made a
     * session unwritable — and that was a second, divergent implementation. Measured on a real session,
     * `codex:9232` has `transport: 'monitor-only'` with `transportError: 'no-cwd-match'`, so the old dot rule
     * called it 可写入 while its own detail page said 只能监控.
     */
    expect(sessionTone(session({ transport: 'monitor-only' }))).toBe('monitor');
    expect(sessionTone(session({ transport: 'cannot-inject' }))).toBe('monitor');
    expect(sessionTone(session({ paused: true }))).toBe('monitor');
    // An unrelated transport error is not a reason to show "only monitoring": the session is still writable, and
    // the error is surfaced on the detail page.
    expect(sessionTone(session({ transportError: 'something-else' }))).toBe('writable');
    // A dead session is an error tone regardless of the rest.
    expect(sessionTone(session({ alive: false }))).toBe('error');
    expect(sessionTone(session({ alive: false, paused: false }))).toBe('error');
  });

  /**
   * The dot and the composer must agree, on every combination of the two fields that used to be read separately.
   *
   * This is the regression the shared rule exists to prevent, so it is pinned here as well as in the rule's own
   * tests: a row that promises 可写入 while its own page refuses is the contradiction the user reported.
   */
  it('never disagrees with the write rule about the same session', () => {
    const combinations: Partial<SessionView>[] = [
      { transport: 'classic-console', transportError: undefined },
      { transport: 'codex-app-server', transportError: undefined },
      { transport: 'monitor-only', transportError: 'no-cwd-match' },
      // The two cases where the old rules diverged: a blocker in one field but not the other.
      { transport: 'codex-app-server', transportError: 'monitor-only' },
      { transport: 'monitor-only', transportError: undefined },
    ];
    for (const combination of combinations) {
      const target = session(combination);
      const tone = sessionTone(target);
      const writable = writeEligibility(target).writable;
      expect(
        tone === 'writable',
        `the dot says ${tone} while the write rule says ${writable ? 'writable' : 'blocked'} for ${JSON.stringify(combination)}`,
      ).toBe(writable);
    }
  });
});

describe('how long a session has been quiet', () => {
  /**
   * The service sends `quietForMs: null` when it has no last-activity time at all
   * (`lastActivityAtMs === null ? null : …` in the controller). The app's surfaces disagreed about what that
   * meant: the table said nothing, while the sidebar row and the mobile card read it as `0` — claiming the
   * session had been active this very second, the opposite of "unknown".
   */
  it('prefers the service value, falls back to the last activity, and says nothing when neither exists', () => {
    expect(quietMs(session({ quietForMs: 42_000 }), 1_000_000)).toBe(42_000);
    // A zero the service really computed is kept: this is "quiet for no measurable time", not "unknown".
    expect(quietMs(session({ quietForMs: 0 }), 1_000_000)).toBe(0);
    expect(quietMs(session({ quietForMs: null, lastActivityAtMs: 900_000 }), 1_000_000)).toBe(100_000);
    expect(quietMs(session({ quietForMs: null, lastActivityAtMs: null }), 1_000_000)).toBeNull();
    // A last activity in the future cannot produce a negative silence.
    expect(quietMs(session({ quietForMs: null, lastActivityAtMs: 1_000_500 }), 1_000_000)).toBe(0);
  });

  it('writes an unknown silence as a dash rather than a duration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(18_000)).toBe('18s');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});