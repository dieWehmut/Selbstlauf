import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_HOST_LABEL,
  formatSilence,
  groupSessionsByHost,
  sessionTone,
  toolLabel,
} from '../src/sidebar/session-groups';
import type { SessionView } from '../src/api/client';

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
  it('groups sessions by the host they run inside', () => {
    const groups = groupSessionsByHost([
      session({ id: 'a', host: { processId: 1, executableName: 'a', label: 'Tabby', category: 'terminal', windowHandle: 1, windowTitle: null } }),
      session({ id: 'b', host: { processId: 2, executableName: 'b', label: 'Visual Studio Code', category: 'editor', windowHandle: 2, windowTitle: null } }),
      session({ id: 'c', host: { processId: 3, executableName: 'c', label: 'Tabby', category: 'terminal', windowHandle: 3, windowTitle: null } }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Tabby', 'Visual Studio Code']);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(groups[1].sessions).toHaveLength(1);
  });

  it('keeps a session without a host under a named fallback rather than dropping it', () => {
    const groups = groupSessionsByHost([
      session({ id: 'a', host: null }),
      session({ id: 'b', host: undefined }),
      session({ id: 'c', host: { processId: 1, executableName: 'x', label: '', category: 'unknown', windowHandle: null, windowTitle: null } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNKNOWN_HOST_LABEL);
    expect(groups[0].sessions.map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c']);
  });

  /**
   * Grouping follows the application, not the operating system.
   *
   * The user asked for a Codex session running inside WSL, started from Tabby, to sit with Tabby rather than in
   * a group of its own — "应该以应用分类而不是以系统分类". Measured, that is possible: the session's interop socket
   * pairs it with the `wsl.exe` under Tabby, so it carries a Tabby host like any native session.
   */
  it('groups a WSL session with the terminal that launched it, not by its distribution', () => {
    const host = (label: string) => ({
      processId: 1,
      executableName: `${label}.exe`,
      label,
      category: 'terminal' as const,
      windowHandle: null,
      windowTitle: null,
    });

    const groups = groupSessionsByHost([
      session({ id: 'native', host: host('Tabby') }),
      // The same terminal, but the session runs inside a distribution.
      session({ id: 'wsl', host: host('Tabby'), distribution: 'Ubuntu-22.04' }),
      // A distribution whose launching terminal could not be established still groups by the distribution.
      session({ id: 'orphan', host: null, distribution: 'Debian' }),
    ]);

    const tabby = groups.find((group) => group.label === 'Tabby');
    expect(tabby?.sessions.map((entry) => entry.id).sort()).toEqual(['native', 'wsl']);
    // No separate WSL group exists for the attributed session, which is the point of the request.
    expect(groups.map((group) => group.label)).not.toContain('WSL: Ubuntu-22.04');
    // The unattributed one still names its distribution rather than being called unrecognised.
    expect(groups.map((group) => group.label)).toContain('WSL: Debian');
  });

  it('falls back to the distribution when a WSL session has no attributed terminal', () => {
    const groups = groupSessionsByHost([
      session({ id: 'w1', host: null, distribution: 'Ubuntu-22.04' }),
      session({ id: 'w2', host: null, distribution: 'Ubuntu-22.04' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('WSL: Ubuntu-22.04');
    expect(groups[0].sessions.map((entry) => entry.id).sort()).toEqual(['w1', 'w2']);
    expect(UNKNOWN_HOST_LABEL).not.toBe(groups[0].label);
  });

  it('orders groups by category so the list does not reshuffle between polls', () => {
    // Inserted in an order that is neither the category order nor alphabetical, to
    // prove the sort is doing the work.
    const input = [
      session({ id: '3', host: { processId: 3, executableName: 'z', label: 'dsh-shortcut', category: 'console', windowHandle: null, windowTitle: null } }),
      session({ id: '1', host: { processId: 1, executableName: 'x', label: 'Tabby', category: 'terminal', windowHandle: 1, windowTitle: null } }),
      session({ id: '2', host: { processId: 2, executableName: 'y', label: 'Visual Studio Code', category: 'editor', windowHandle: 2, windowTitle: null } }),
    ];
    const first = groupSessionsByHost(input).map((group) => group.label);
    expect(first).toEqual(['Tabby', 'Visual Studio Code', 'dsh-shortcut']);

    // A different input order must give the same output.
    expect(groupSessionsByHost([input[2], input[0], input[1]]).map((group) => group.label)).toEqual(first);
  });

  it('sorts rows within a group by the longest silence first', () => {
    const groups = groupSessionsByHost([
      session({ id: 'fresh', quietForMs: 1000 }),
      session({ id: 'old', quietForMs: 600000 }),
      session({ id: 'middle', quietForMs: 60000 }),
      session({ id: 'unknown', quietForMs: undefined }),
    ]);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['old', 'middle', 'fresh', 'unknown']);
  });

  it('produces no groups for an empty session list', () => {
    expect(groupSessionsByHost([])).toEqual([]);
  });

  it('labels each tool the way the process table does', () => {
    expect(toolLabel('codex')).toBe('Codex');
    expect(toolLabel('claude')).toBe('Claude');
    expect(toolLabel('dsh')).toBe('DeepSeek Harness');
    // An unknown tool must be shown as-is rather than as an empty label.
    expect(toolLabel('something-new')).toBe('something-new');
  });

  it('formats silence compactly and never prints a wrong duration', () => {
    expect(formatSilence(0)).toBe('0s');
    expect(formatSilence(18000)).toBe('18s');
    expect(formatSilence(74000)).toBe('1m 14s');
    expect(formatSilence(132000)).toBe('2m 12s');
    expect(formatSilence(3600000)).toBe('1h 00m');
    expect(formatSilence(3900000)).toBe('1h 05m');
    // A negative or non-finite value must not print something nonsensical.
    expect(formatSilence(-1)).toBe('—');
    expect(formatSilence(Number.NaN)).toBe('—');
    expect(formatSilence(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('gives a row the tone that matches whether the session is actionable', () => {
    expect(sessionTone(session({ alive: true, paused: false, transportError: undefined }))).toBe('writable');
    // A blocker in transportError is what makes a live session unwritable, which is the
    // same rule the process table's own badge uses.
    expect(sessionTone(session({ transportError: 'monitor-only' }))).toBe('monitor');
    expect(sessionTone(session({ transportError: 'cannot-inject' }))).toBe('monitor');
    expect(sessionTone(session({ paused: true }))).toBe('monitor');
    // An unrelated transport error is not a reason to show "only monitoring": the
    // session is still writable, and the error is surfaced on the detail page.
    expect(sessionTone(session({ transportError: 'something-else' }))).toBe('writable');
    // A dead session is an error tone regardless of the rest.
    expect(sessionTone(session({ alive: false }))).toBe('error');
    expect(sessionTone(session({ alive: false, paused: false, transportError: undefined }))).toBe('error');
  });
});