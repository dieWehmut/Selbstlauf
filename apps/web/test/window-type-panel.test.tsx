import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionView } from '../src/api/client';
import { WINDOW_TYPE_MAX_LENGTH, WindowTypePanel, typingProblem } from '../src/process/WindowTypePanel';

/**
 * Typing a line into a session's window.
 *
 * The capability takes the foreground, which is a real cost, so two things are pinned: the cost is stated before
 * the act rather than after it, and a window that cannot be safely written to is refused with a reason instead of
 * a disabled button nobody can explain.
 */

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'codex:1',
    tool: 'codex',
    rootPid: 4242,
    childPids: [],
    conversationId: null,
    goal: null,
    runningTurn: false,
    paused: false,
    alive: true,
    quietForMs: 1000,
    transportError: undefined,
    sessionCwd: null,
    host: { label: 'Tabby', category: 'terminal', windowTitle: 'MicEye', windowHandle: 67008, processId: 1, executableName: 'Tabby.exe' },
    ...overrides,
  } as unknown as SessionView;
}

describe('typingProblem', () => {
  it('accepts an ordinary line', () => {
    expect(typingProblem('继续')).toBeNull();
    expect(typingProblem('please continue')).toBeNull();
  });

  it('refuses an empty or whitespace-only line, because a bare Enter could submit what is already there', () => {
    expect(typingProblem('')).not.toBeNull();
    expect(typingProblem('   ')).not.toBeNull();
  });

  it('refuses a newline, since a newline would submit early', () => {
    expect(typingProblem('first\nsecond')).toContain('一行');
    expect(typingProblem('first\rsecond')).toContain('一行');
  });

  it('refuses more than the documented maximum, and allows exactly it', () => {
    expect(typingProblem('x'.repeat(WINDOW_TYPE_MAX_LENGTH))).toBeNull();
    expect(typingProblem('x'.repeat(WINDOW_TYPE_MAX_LENGTH + 1))).toContain(String(WINDOW_TYPE_MAX_LENGTH));
  });
});

describe('WindowTypePanel', () => {
  it('states the focus cost before anything is typed', () => {
    // The cost is the whole reason this capability needed the user's consent, so it is stated up front.
    render(<WindowTypePanel session={session()} onType={vi.fn()} />);
    expect(screen.getByText(/切到前台/u)).toBeInTheDocument();
    expect(screen.getByText(/自动切回/u)).toBeInTheDocument();
  });

  it('types the draft with and without submitting', async () => {
    const onType = vi.fn(async () => ({ ok: true as const, typed: 2, submitted: false, focusRestored: true }));
    render(<WindowTypePanel session={session()} onType={onType} />);
    const field = screen.getByLabelText('要写入该窗口的文字');

    fireEvent.change(field, { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /写入窗口（不提交）PID 4242/u }));
    await waitFor(() => expect(onType).toHaveBeenCalledWith('codex:1', '继续', false));

    fireEvent.change(field, { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /写入并回车 PID 4242/u }));
    await waitFor(() => expect(onType).toHaveBeenCalledWith('codex:1', '继续', true));
  });

  it('reports whether focus came back, because taking it was the cost', async () => {
    const onType = vi.fn(async () => ({ ok: true as const, typed: 2, submitted: true, focusRestored: true }));
    render(<WindowTypePanel session={session()} onType={onType} />);
    fireEvent.change(screen.getByLabelText('要写入该窗口的文字'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /写入并回车 PID 4242/u }));

    const done = await screen.findByRole('status');
    expect(done.textContent).toContain('已写入 2 个字符');
    expect(done.textContent).toContain('焦点已切回');
  });

  it('says when focus could not be restored rather than claiming success alone', async () => {
    const onType = vi.fn(async () => ({ ok: true as const, typed: 2, submitted: false, focusRestored: false }));
    render(<WindowTypePanel session={session()} onType={onType} />);
    fireEvent.change(screen.getByLabelText('要写入该窗口的文字'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /写入窗口（不提交）PID 4242/u }));
    expect((await screen.findByRole('status')).textContent).toContain('焦点未切回');
  });

  it('refuses a shared window with a reason, not a bare disabled control', () => {
    /**
     * Measured: two Tabby Codex sessions share window handle 67008. Text typed into it reaches whichever terminal
     * pane holds the focus inside it, which need not be the session chosen here — a silent wrong-target failure.
     */
    render(<WindowTypePanel session={session()} onType={vi.fn()} sharedBy={2} />);
    expect(screen.getByLabelText('要写入该窗口的文字')).toBeDisabled();
    expect(screen.getByRole('button', { name: /写入并回车/u })).toBeDisabled();
    const hint = screen.getByText(/2/u, { selector: '.window-type__hint strong' });
    expect(hint).toBeInTheDocument();
    expect(screen.getByText(/无法确定/u)).toBeInTheDocument();
  });

  it('says a session with no window cannot be typed into', () => {
    render(<WindowTypePanel session={session({ host: null })} onType={vi.fn()} />);
    expect(screen.getByLabelText('要写入该窗口的文字')).toBeDisabled();
    expect(screen.getByText(/没有可写入的窗口/u)).toBeInTheDocument();
  });

  it('keeps the draft when typing is refused, and shows the reason', async () => {
    const onType = vi.fn(async () => ({ ok: false as const, reason: 'could-not-take-focus' }));
    render(<WindowTypePanel session={session()} onType={onType} />);
    fireEvent.change(screen.getByLabelText('要写入该窗口的文字'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /写入并回车 PID 4242/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could-not-take-focus/u);
    // Losing what was typed on a refusal would be worse than the refusal.
    expect(screen.getByLabelText('要写入该窗口的文字')).toHaveValue('继续');
  });

  it('does not carry a draft over to another session', () => {
    const { rerender } = render(<WindowTypePanel session={session()} onType={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('要写入该窗口的文字'), { target: { value: '给第一个' } });
    rerender(<WindowTypePanel session={session({ id: 'codex:2', rootPid: 5151 })} onType={vi.fn()} />);
    expect(screen.getByLabelText('要写入该窗口的文字')).toHaveValue('');
    expect(screen.getByText(/PID 5151/u)).toBeInTheDocument();
  });

  it('flattens a pasted multi-line block rather than welding the words together', () => {
    // A single-line field strips newlines itself; without this the words run together, which is corruption.
    render(<WindowTypePanel session={session()} onType={vi.fn()} />);
    const field = screen.getByLabelText('要写入该窗口的文字') as HTMLInputElement;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'line one\nline two' } });
    fireEvent(field, paste);
    expect(field.value).toBe('line one line two');
  });
});