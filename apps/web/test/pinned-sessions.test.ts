import { describe, expect, it } from 'vitest';

import type { SessionView } from '../src/api/client';
import {
  groupSessionsByEnvironment,
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
  it('keeps pinned sessions inside their environment and project, without duplication', () => {
    const input = sessions.map((s, i) => ({ ...s, sessionCwd: i < 2 ? 'C:/project/a' : 'C:/project/b' }));
    const groups = groupSessionsByEnvironment(input, ['b2', 'gone9', 'b2']);
    const projects = groups.flatMap((g) => g.projects);
    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.sessions.some((s) => s.id === 'b2'))?.sessions.map((s) => s.id)).toEqual(['b2', 'a1']);
    expect(projects.flatMap((p) => p.sessions.map((s) => s.id)).sort()).toEqual(['a1', 'b2', 'c3', 'd4']);
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

});
