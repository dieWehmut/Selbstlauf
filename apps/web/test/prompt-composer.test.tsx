import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionView } from '../src/api/client';
import { PROMPT_MAX_LENGTH, SessionPromptComposer, promptProblem } from '../src/process/SessionPromptComposer';

/**
 * Writing a typed line into a session.
 *
 * The app already writes text into sessions (立即续写 sends the configured prompt), so this is not a new
 * capability class — it lets the person choose the words. That makes two things worth pinning: the rules
 * match what the service enforces, so a refusal is explained rather than arriving as an HTTP 400, and the
 * draft belongs to one session so it cannot be sent to the wrong one.
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
    host: { label: 'Tabby', category: 'terminal', windowTitle: null, windowHandle: 1, processId: 1, executableName: 'Tabby.exe' },
    ...overrides,
  } as unknown as SessionView;
}

describe('promptProblem', () => {
  it('accepts an ordinary line', () => {
    expect(promptProblem('继续')).toBeNull();
    expect(promptProblem('please continue')).toBeNull();
  });

  it('refuses an empty or whitespace-only line, which would send nothing', () => {
    expect(promptProblem('')).not.toBeNull();
    expect(promptProblem('   ')).not.toBeNull();
  });

  it('refuses a newline rather than silently truncating it', () => {
    // The service takes one line; truncating would look like the app dropping text.
    expect(promptProblem('first\nsecond')).toContain('一行');
    expect(promptProblem('first\rsecond')).toContain('一行');
  });

  it('refuses more than the documented maximum, and allows exactly it', () => {
    expect(promptProblem('x'.repeat(PROMPT_MAX_LENGTH))).toBeNull();
    expect(promptProblem('x'.repeat(PROMPT_MAX_LENGTH + 1))).toContain(String(PROMPT_MAX_LENGTH));
  });
});

describe('SessionPromptComposer', () => {
  it('sends the typed line to the session', async () => {
    const onSend = vi.fn(async () => undefined);
    const target = session();
    render(<SessionPromptComposer session={target} canSend onSend={onSend} />);

    fireEvent.change(screen.getByLabelText('要发送到该会话的文字'), { target: { value: '继续，并按计划做完' } });
    fireEvent.click(screen.getByRole('button', { name: /发送到 PID 4242/u }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(target, '继续，并按计划做完'));
    // The confirmation names what was sent, so the user can see it landed where they meant.
    expect(await screen.findByText(/已发送/u)).toBeInTheDocument();
    expect(screen.getByText('继续，并按计划做完')).toBeInTheDocument();
  });

  it('says where the text will go, since it lands in a running session', () => {
    render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    expect(screen.getByText(/PID 4242/u)).toBeInTheDocument();
    expect(screen.getByText(/立即续写/u)).toBeInTheDocument();
  });

  it('refuses an over-long line, and allows exactly the maximum', () => {
    render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: /发送到 PID 4242/u });
    const field = screen.getByLabelText('要发送到该会话的文字');

    // The field caps at the maximum itself, so the refusal is reachable only from a programmatic draft.
    expect(field).toHaveAttribute('maxlength', String(PROMPT_MAX_LENGTH));

    fireEvent.change(field, { target: { value: 'x'.repeat(PROMPT_MAX_LENGTH) } });
    expect(send).toBeEnabled();
  });

  /**
   * A pasted multi-line block must not be silently welded together.
   *
   * Measured: `<input type="text">` applies the HTML value-sanitization algorithm, so a pasted
   * `line one\nline two` would arrive as `line oneline two` — the breaks deleted before any validation
   * could object. That damage happens *before* React's `onChange`, which is why the fix is an `onPaste`
   * handler: it sees the clipboard text with its breaks intact and converts them to spaces.
   *
   * The paste event is dispatched directly, because `fireEvent.change` cannot exercise this path — it
   * assigns to `field.value` after the handler runs, so the browser's sanitization wins and the test would
   * only be measuring jsdom.
   */
  it('turns pasted line breaks into spaces rather than losing them', () => {
    render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    const field = screen.getByLabelText('要发送到该会话的文字') as HTMLInputElement;

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'line one\nline two\nline three' },
    });
    fireEvent(field, paste);

    expect(field.value).toBe('line one line two line three');
    expect(field.value).not.toContain('\n');
  });

  it('leaves a single-line paste untouched', () => {
    // An ordinary paste must not be intercepted, so selection and undo behave normally.
    render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    const field = screen.getByLabelText('要发送到该会话的文字') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '继续' } });

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => ' now' } });
    fireEvent(field, paste);

    // Not prevented, so the browser performs the insert itself; the value is unchanged in jsdom.
    expect(paste.defaultPrevented).toBe(false);
  });

  it('cannot send while the line is invalid, and explains why', () => {
    render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: /发送到 PID 4242/u });
    expect(send).toBeDisabled();

    // Whitespace alone is a refusal the user can act on, stated in words.
    fireEvent.change(screen.getByLabelText('要发送到该会话的文字'), { target: { value: '   ' } });
    expect(send).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/请输入/u);
  });

  it('is disabled, and says so, for a session that cannot be written to', () => {
    render(<SessionPromptComposer session={session()} canSend={false} onSend={vi.fn()} />);
    expect(screen.getByLabelText('要发送到该会话的文字')).toBeDisabled();
    expect(screen.getByRole('button', { name: /发送到 PID 4242/u })).toBeDisabled();
    expect(screen.getByText(/不可写入/u)).toBeInTheDocument();
  });

  it('keeps a failed send in the field and reports it', async () => {
    // Losing what was typed on a failure would be worse than the failure itself.
    const onSend = vi.fn(async () => { throw new Error('API 409'); });
    render(<SessionPromptComposer session={session()} canSend onSend={onSend} />);

    fireEvent.change(screen.getByLabelText('要发送到该会话的文字'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /发送到 PID 4242/u }));

    expect(await screen.findByText(/发送失败/u)).toBeInTheDocument();
    expect(screen.getByLabelText('要发送到该会话的文字')).toHaveValue('继续');
  });

  it('does not carry a draft over to another session', () => {
    // A line written for one process must not be one click away from being sent to a different one.
    const { rerender } = render(<SessionPromptComposer session={session()} canSend onSend={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('要发送到该会话的文字'), { target: { value: '给第一个进程' } });
    expect(screen.getByLabelText('要发送到该会话的文字')).toHaveValue('给第一个进程');

    rerender(<SessionPromptComposer session={session({ id: 'codex:2', rootPid: 5151 })} canSend onSend={vi.fn()} />);
    expect(screen.getByLabelText('要发送到该会话的文字')).toHaveValue('');
    expect(screen.getByText(/PID 5151/u)).toBeInTheDocument();
  });

  it('submits from the keyboard, since the field holds one line', async () => {
    const onSend = vi.fn(async () => undefined);
    render(<SessionPromptComposer session={session()} canSend onSend={onSend} />);

    const field = screen.getByLabelText('要发送到该会话的文字');
    fireEvent.change(field, { target: { value: '继续' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(expect.anything(), '继续'));
  });
});