import { describe, expect, it, vi } from 'vitest';
import { TerminalInputQueue } from '../src/agents/terminal-input';

describe('terminal input ordering', () => {
  it('serializes keystrokes and sends an Enter after a full multiline paste', async () => {
    const seen: string[] = [];
    const queue = new TerminalInputQueue(async (data) => {
      await new Promise((done) => setTimeout(done, data === 'first' ? 10 : 0));
      seen.push(data);
    });
    await Promise.all([queue.send('first'), queue.send('\x1b[200~你好\nsecond line\x1b[201~'), queue.send('\r')]);
    expect(seen).toEqual(['first', '\x1b[200~你好\nsecond line\x1b[201~', '\r']);
  });

  it('splits a large paste without changing the text or splitting a Unicode pair', async () => {
    const chunks: string[] = [];
    const queue = new TerminalInputQueue(async (data) => { chunks.push(data); });
    const paste = `${'a'.repeat(8191)}🌍${'中文'.repeat(9000)}`;
    await queue.send(paste);
    expect(chunks.join('')).toBe(paste);
    expect(chunks.every((chunk) => chunk.length <= 8192)).toBe(true);
    expect(chunks[0].length).toBe(8191);
    expect(chunks[1].startsWith('🌍')).toBe(true);
  });

  it('refuses queued input after a failure and resumes only when explicitly reset', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(undefined);
    const queue = new TerminalInputQueue(write);
    const first = queue.send('first');
    const later = queue.send('\r');
    await expect(first).rejects.toThrow('connection lost');
    await expect(later).rejects.toThrow('connection lost');
    expect(write).toHaveBeenCalledTimes(1);
    queue.resetFailure();
    await queue.send('retry');
    expect(write).toHaveBeenLastCalledWith('retry');
  });

  it('does not send queued text after the window is disposed', async () => {
    const write = vi.fn(async () => undefined);
    const queue = new TerminalInputQueue(write);
    const pending = queue.send('old window');
    queue.dispose();
    await expect(pending).rejects.toThrow('终端已关闭');
    expect(write).not.toHaveBeenCalled();
  });
});
