import { describe, expect, it } from 'vitest';

import type { SessionView } from '../src/api/client';
import {
  PINNED_GROUP_LABEL,
  groupSessionsByHost,
  livePinnedIds,
  togglePinnedId,
} from '../src/sidebar/session-groups';

function session(id: string, hostLabel: string | null, quietForMs = 1000): SessionView {
  return {
    id,
    tool: 'codex',
    rootPid: Number(id.replace(/\D/gu, '')) || 1,
    childPids: [],
    conversationId: null,
    goal: null,
    runningTurn: false,
    paused: false,
    alive: true,
    quietForMs,
    transportError: undefined,
    sessionCwd: null,
    host: hostLabel === null ? null : {
      label: hostLabel,
      category: 'terminal',
      windowTitle: null,
      windowHandle: null,
    },
  } as unknown as SessionView;
}

const sessions = [
  session('a1', 'Tabby', 5000),
  session('b2', 'Tabby', 1000),
  session('c3', 'Visual Studio Code', 3000),
  session('d4', null, 2000),
];

describe('pinned sessions', () => {
  it('lifts the pinned sessions into their own group on top', () => {
    const groups = groupSessionsByHost(sessions, ['b2']);
    expect(groups[0].label).toBe(PINNED_GROUP_LABEL);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['b2']);
    // Tapby still holds the other session, and nothing was duplicated.
    const tabby = groups.find((group) => group.label === 'Tabby');
    expect(tabby?.sessions.map((entry) => entry.id)).toEqual(['a1']);
    const all = groups.flatMap((group) => group.sessions.map((entry) => entry.id));
    expect(all.sort()).toEqual(['a1', 'b2', 'c3', 'd4']);
  });

  it('shows no pinned group at all when nothing is pinned', () => {
    const groups = groupSessionsByHost(sessions, []);
    expect(groups.some((group) => group.label === PINNED_GROUP_LABEL)).toBe(false);
    expect(groups.map((group) => group.label)).toEqual(['Tabby', 'Visual Studio Code', '未识别宿主']);
  });

  it('keeps pin order, so the most recently pinned comes first', () => {
    const groups = groupSessionsByHost(sessions, ['c3', 'a1']);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['c3', 'a1']);
  });

  it('ignores an id with no live session, so a pin survives a restart', () => {
    const groups = groupSessionsByHost(sessions, ['gone9', 'a1']);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['a1']);
    expect(groups.flatMap((group) => group.sessions)).toHaveLength(sessions.length);
  });

  it('toggles an id without duplicating or reordering the rest', () => {
    expect(togglePinnedId([], 'a1')).toEqual(['a1']);
    // Pinning puts the newest first.
    expect(togglePinnedId(['c3'], 'a1')).toEqual(['a1', 'c3']);
    // Unpinning removes it and leaves the order of the others alone.
    expect(togglePinnedId(['a1', 'c3'], 'a1')).toEqual(['c3']);
    // Toggling twice returns to the start, never a duplicate.
    expect(togglePinnedId(togglePinnedId(['c3'], 'a1'), 'a1')).toEqual(['c3']);
  });

  it('reports which pins match a live session, in pin order', () => {
    expect(livePinnedIds(['gone9', 'c3', 'a1'], sessions)).toEqual(['c3', 'a1']);
    expect(livePinnedIds([], sessions)).toEqual([]);
  });

  it('does not repeat an id that was already pinned', () => {
    // A corrupt stored value with a repeat must not produce two groups' worth of rows.
    const groups = groupSessionsByHost(sessions, ['a1', 'a1']);
    expect(groups[0].sessions.map((entry) => entry.id)).toEqual(['a1']);
  });
});