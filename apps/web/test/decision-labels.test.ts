import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decisionLabel } from '../src/App';

/**
 * Every decision the engine can report has a label in the interface.
 *
 * The `default` branch used to print the raw value, so a decision with no case showed an English identifier in a
 * Chinese interface. That is what happened with `disabled` — the state every session reports while the master
 * switch is off — and it read as "this session cannot be written to", which is exactly wrong: that switch governs
 * automatic continuation only. The user reported the resulting impression as "会话显示无法写入".
 *
 * The decision strings are read out of the **engine's own source** rather than listed here, so a new decision added
 * to the engine fails this test instead of silently reaching the user as an identifier.
 */
// The authoritative list is the engine's declared union, not a regex over its assignments: a regex found only
// three of the fourteen states, which would have left most of them unpinned.
const STATE_SOURCE = readFileSync(
  resolve(__dirname, '..', '..', 'cli', 'src', 'engine', 'session-state.ts'),
  'utf8',
);

/** The members of the engine's `LastDecision` union. */
function engineDecisions(): string[] {
  const block = /export type LastDecision\s*=([\s\S]*?);/u.exec(STATE_SOURCE)?.[1] ?? '';
  return [...block.matchAll(/'([a-z-]+)'/gu)].map((match) => match[1]!).sort();
}

describe('decision labels', () => {
  it('covers every decision the engine can report', () => {
    const decisions = engineDecisions();
    expect(decisions.length, 'no decisions were found in the engine source, so this proves nothing').toBeGreaterThan(10);
    console.log(`engine decisions (${decisions.length}): ${decisions.join(', ')}`);

    const unlabelled = decisions.filter((decision) => {
      const result = decisionLabel(decision);
      /**
       * A decision is covered only when it gets a label of its own.
       *
       * Two weaker checks were tried first and both passed while four states were still unlabelled: rejecting a
       * label equal to the identifier, and rejecting a label made only of Latin letters. The fallthrough returns
       * 未知状态, which is neither — honest about an unknown value, but it says nothing useful about a known one.
       * Requiring the fallthrough itself to be distinguishable is what makes this test mean something.
       */
      return result.label === '未知状态' || result.label === decision || /^[a-z-]+$/u.test(result.label);
    });
    expect(unlabelled, 'these decisions have no label of their own and fall through to 未知状态').toEqual([]);
  });

  it('still reports a genuinely unknown decision as unknown', () => {
    // The fallthrough must stay, or a future engine state would appear as nothing at all.
    expect(decisionLabel('some-future-decision').label).toBe('未知状态');
  });

  it('names the off switch for what it is, not "disabled"', () => {
    /**
     * The specific defect. `disabled` is the state every session reports while automatic continuation is switched
     * off, and showing the English word next to a session reads as "this session is disabled".
     */
    const result = decisionLabel('disabled');
    expect(result.label).not.toBe('disabled');
    expect(result.label).toContain('自动续写');
    // The tone must not be an error: nothing is wrong, a feature is simply switched off.
    expect(result.tone).toBe('limited');
  });

  it('still labels the decisions that already had names', () => {
    expect(decisionLabel('awaiting-quiet-period').label).toBe('等待静默');
    expect(decisionLabel('output-observed').label).toBe('输出活跃');
    expect(decisionLabel('cannot-inject').label).toBe('仅监控');
    expect(decisionLabel('cooldown').label).toBe('冷却中');
  });

  it('reports an unknown decision as an unknown state rather than showing it raw', () => {
    // A decision a future engine adds must not appear as an identifier before this build knows it.
    const result = decisionLabel('some-future-decision');
    expect(result.label).toBe('未知状态');
    expect(result.label).not.toContain('future');
  });

  it('handles a missing decision', () => {
    expect(decisionLabel(undefined).label).toBe('等待活动');
  });
});