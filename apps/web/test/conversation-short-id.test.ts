import { describe, expect, it } from 'vitest';

import { conversationShortId } from '../src/sidebar/session-groups';

/**
 * The shortened id a compact row shows must actually distinguish one session from another.
 *
 * The first version simply took the first eight characters, which turned
 * `session-b9dbc639-0a40-4eec-91cd-f627991f8f6a` into `session-` — a prefix every DeepSeek
 * Harness session shares, so two rows rendered identically. It was visible in the running app
 * before this test existed.
 */
describe('conversationShortId', () => {
  it('drops a shared type prefix rather than showing it alone', () => {
    const short = conversationShortId('session-b9dbc639-0a40-4eec-91cd-f627991f8f6a');
    expect(short).not.toBe('session-');
    expect(short).toBe('b9dbc639');
  });

  it('distinguishes two sessions of the same kind', () => {
    const a = conversationShortId('session-b9dbc639-0a40-4eec-91cd-f627991f8f6a');
    const b = conversationShortId('session-4f21c0a8-0e75-4f7a-9f0b-2a63b91d0f52');
    expect(a).not.toBe(b);
  });

  it('keeps a short id intact, so nothing is lost', () => {
    expect(conversationShortId('demo-goal')).toBe('demo-goal');
    expect(conversationShortId('01a0bd1e')).toBe('01a0bd1e');
    expect(conversationShortId('01a01a5d')).toBe('01a01a5d');
  });

  it('shows a long hex id unchanged up to eight characters', () => {
    expect(conversationShortId('01a0bd1e-19cf-7601-9e23-c97a3c7739c2')).toBe('01a0bd1e');
  });

  it('reports nothing for an absent or empty id', () => {
    expect(conversationShortId(null)).toBeNull();
    expect(conversationShortId(undefined)).toBeNull();
    expect(conversationShortId('')).toBeNull();
  });

  it('never returns a bare prefix that carries no information', () => {
    // Any id whose leading segment is alphabetic must either keep enough to identify it or be
    // shortened past that segment.
    for (const id of [
      'session-b9dbc639-0a40-4eec-91cd-f627991f8f6a',
      'conversation-01a0bd1e-19cf-7601',
      'chat-abcdef1234567890',
    ]) {
      const short = conversationShortId(id);
      expect(short, `${id} shortened to nothing useful`).not.toMatch(/^[A-Za-z]+-$/u);
      expect((short ?? '').length).toBeGreaterThan(0);
    }
  });
});