import { describe, expect, it, vi } from 'vitest';
import { TerminalInputQueue, TerminalSubmitter } from '../src/agents/terminal-input';

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

describe('terminal composer retries', () => {
  const payload = (text: string) => `\x1b[200~${text}\x1b[201~`;

  it('retries a rejected Enter while retaining the original paste payload', async () => {
    const accepted: string[] = [];
    let rejected = false;
    const queue = new TerminalInputQueue(async (data) => {
      if (data === '\r' && !rejected) { rejected = true; throw new Error('Enter rejected'); }
      accepted.push(data);
    });
    const paste = vi.fn(payload);
    const submitter = new TerminalSubmitter(() => queue, paste);

    await expect(submitter.send('first')).rejects.toThrow('Enter rejected');
    await submitter.send('first');

    expect(accepted).toEqual([payload('first'), '\r']);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('resumes after the acknowledged prefix without splitting a Unicode pair', async () => {
    const accepted: string[] = [];
    let calls = 0;
    const queue = new TerminalInputQueue(async (data) => {
      if (++calls === 2) throw new Error('chunk rejected');
      accepted.push(data);
    });
    const text = `${'x'.repeat(8185)}🌍${'中文'.repeat(100)}`;
    const paste = vi.fn(payload);
    const submitter = new TerminalSubmitter(() => queue, paste);

    await expect(submitter.send(text)).rejects.toThrow('chunk rejected');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].length).toBe(8191);
    await submitter.send(text);

    expect(accepted.join('')).toBe(`${payload(text)}\r`);
    expect(accepted[1].startsWith('🌍')).toBe(true);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('finishes pending input before pasting an edited draft', async () => {
    const accepted: string[] = [];
    let rejected = false;
    const queue = new TerminalInputQueue(async (data) => {
      if (data === '\r' && !rejected) { rejected = true; throw new Error('Enter rejected'); }
      accepted.push(data);
    });
    const submitter = new TerminalSubmitter(() => queue, payload);

    await expect(submitter.send('first')).rejects.toThrow('Enter rejected');
    await submitter.send('second');

    expect(accepted).toEqual([payload('first'), '\r', payload('second'), '\r']);
  });

  it('keeps pending input when a reconnect replaces the queue', async () => {
    const accepted: string[] = [];
    let queue: TerminalInputQueue | null = new TerminalInputQueue(async (data) => {
      if (data === '\r') throw new Error('Enter rejected');
      accepted.push(data);
    });
    const paste = vi.fn(payload);
    const submitter = new TerminalSubmitter(() => queue, paste);

    await expect(submitter.send('first')).rejects.toThrow('Enter rejected');
    queue.dispose();
    queue = null;
    await expect(submitter.send('first')).rejects.toThrow('终端已关闭');
    queue = new TerminalInputQueue(async (data) => { accepted.push(data); });
    await submitter.send('first');

    expect(accepted).toEqual([payload('first'), '\r']);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('does not send Enter when preparing a paste fails and permits an explicit retry', async () => {
    const write = vi.fn(async () => undefined);
    const queue = new TerminalInputQueue(write);
    const prepare = vi.fn(payload).mockImplementationOnce(() => { throw new Error('paste unavailable'); });
    const submitter = new TerminalSubmitter(() => queue, prepare);

    await expect(submitter.send('first')).rejects.toThrow('paste unavailable');
    expect(write).not.toHaveBeenCalled();
    await submitter.send('first');
    expect(write.mock.calls).toEqual([[payload('first')], ['\r']]);
  });
});
