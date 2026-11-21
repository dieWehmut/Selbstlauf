import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentApi, AgentSession } from '../src/api/agents';
import { AgentWindows } from '../src/agents/AgentWindows';

// Exercise list management without starting an emulator; this is its real session-update callback.
vi.mock('../src/agents/AgentTerminal', () => ({
  AgentTerminal: ({ session, onSession }: { session: AgentSession; onSession: (session: AgentSession) => void }) => (
    <button onClick={() => onSession({ ...session, status: 'exited', exitCode: 0, endedAtMs: 2 })}>Report process exit</button>
  ),
}));

function session(id: string, status: AgentSession['status'] = 'running'): AgentSession {
  return { id, tool: 'custom', title: id, command: 'node', args: [], cwd: '/work', pid: 42, status,
    startedAtMs: 1, endedAtMs: status === 'exited' ? 2 : null, exitCode: status === 'exited' ? 0 : null,
    signal: null, cols: 100, rows: 30 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixture(initial = [session('first', 'exited'), session('second')]) {
  let sessions = initial;
  let changed: () => void = () => undefined;
  const api = {
    list: vi.fn(async () => sessions),
    remove: vi.fn(async (id: string) => { sessions = sessions.filter((entry) => entry.id !== id); }),
    terminate: vi.fn(async (id: string) => { sessions = sessions.map((entry) => entry.id === id ? { ...entry, status: 'exited' as const } : entry); }),
    subscribeSessions: vi.fn((listener: () => void) => { changed = listener; return () => { changed = () => undefined; }; }),
  };
  return { api, changed: () => act(() => changed()), sessions: () => sessions };
}

function Windows({ api }: { api: ReturnType<typeof fixture>['api'] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <AgentWindows api={api as unknown as AgentApi} selectedId={selected} onSelect={setSelected} onLaunch={() => undefined} />;
}

afterEach(() => sessionStorage.clear());

describe('agent window list updates', () => {
  it('lets a stopping process be ended again after reopening the page', async () => {
    const f = fixture([session('first', 'stopping')]);
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });

    fireEvent.click(screen.getByRole('button', { name: '结束进程' }));

    await waitFor(() => expect(f.api.terminate).toHaveBeenCalledWith('first'));
    expect(await screen.findByRole('button', { name: '关闭窗口' })).toBeEnabled();
  });

  it('retries an unconfirmed termination while preventing duplicate pending requests', async () => {
    const f = fixture([session('first')]);
    const pending = deferred<void>();
    f.api.terminate.mockImplementationOnce(async () => {
      f.api.list.mockResolvedValue([session('first', 'stopping')]);
      f.changed();
      throw new Error('进程还未确认退出，请稍后重试结束。');
    }).mockImplementationOnce(async () => {
      await pending.promise;
      f.api.list.mockResolvedValue([session('first', 'exited')]);
    });
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: '结束进程' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('进程还未确认退出，请稍后重试结束。');
    expect(screen.getByText(/正在退出/u)).toBeVisible();
    const retry = screen.getByRole('button', { name: '结束进程' });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(f.api.terminate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { pending.resolve(); });

    expect(await screen.findByRole('button', { name: '关闭窗口' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'first' })).toBeInTheDocument();
    expect(f.api.remove).not.toHaveBeenCalled();
  });

  it('keeps an accepted removal when the follow-up list fails', async () => {
    const f = fixture();
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    sessionStorage.setItem('selbstlauf-agent-draft:first', 'draft');
    f.api.list.mockRejectedValue(new Error('list unavailable'));

    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));

    await waitFor(() => expect(f.api.remove).toHaveBeenCalledWith('first'));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'first' })).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'second' })).toHaveAttribute('aria-selected', 'true');
    expect(sessionStorage.getItem('selbstlauf-agent-draft:first')).toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent('list unavailable');
  });

  it('does not resurrect a removed window when an older poll finishes later', async () => {
    const f = fixture();
    const previous = [...f.sessions()];
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    const pending = deferred<AgentSession[]>();
    f.api.list.mockImplementationOnce(() => pending.promise);
    f.changed();
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    await waitFor(() => expect(f.api.remove).toHaveBeenCalledWith('first'));

    await act(async () => { pending.resolve(previous); });

    expect(screen.queryByRole('tab', { name: 'first' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'second' })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not roll back a process exit reported after a poll began', async () => {
    const f = fixture([session('first')]);
    const previous = [...f.sessions()];
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    const pending = deferred<AgentSession[]>();
    f.api.list.mockImplementationOnce(() => pending.promise);
    f.changed();
    fireEvent.click(screen.getByRole('button', { name: 'Report process exit' }));
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
    // The next real list would also see the exit.
    f.api.list.mockResolvedValue([session('first', 'exited')]);

    await act(async () => { pending.resolve(previous); });

    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '结束进程' })).not.toBeInTheDocument();
  });

  it('waits for a queued refresh when a newer session change invalidates a list', async () => {
    const f = fixture([session('first')]);
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    const previous = deferred<AgentSession[]>();
    const latest = deferred<AgentSession[]>();
    f.api.list.mockImplementationOnce(() => previous.promise).mockImplementationOnce(() => latest.promise);
    f.changed();
    f.changed();

    await act(async () => { previous.resolve([session('first'), session('already removed')]); });

    expect(screen.queryByRole('tab', { name: 'already removed' })).not.toBeInTheDocument();
    await act(async () => { latest.resolve([session('first'), session('new window')]); });
    expect(screen.getByRole('tab', { name: 'new window' })).toBeInTheDocument();
    expect(f.api.list).toHaveBeenCalledTimes(3);
  });

  it('keeps a failed close visible across successful background polls', async () => {
    const f = fixture();
    f.api.remove.mockRejectedValue(new Error('close refused'));
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('close refused');

    f.changed();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('alert')).toHaveTextContent('close refused');
    expect(screen.getByRole('tab', { name: 'first' })).toBeInTheDocument();
  });

  it('retains the user selection made while another window is closing', async () => {
    const f = fixture([session('first', 'exited'), session('second'), session('third')]);
    const pending = deferred<void>();
    const remove = f.api.remove.getMockImplementation()!;
    f.api.remove.mockImplementation(async (id) => { await pending.promise; await remove(id); });
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    fireEvent.click(screen.getByRole('tab', { name: 'third' }));

    await act(async () => { pending.resolve(); });

    expect(screen.getByRole('tab', { name: 'third' })).toHaveAttribute('aria-selected', 'true');
  });

  it('discards a pending close after the API changes', async () => {
    const first = fixture();
    const second = fixture([session('other')]);
    const pending = deferred<void>();
    first.api.remove.mockImplementation(async () => { await pending.promise; });
    const onSelect = vi.fn();
    const view = render(<AgentWindows api={first.api as unknown as AgentApi} selectedId={null} onSelect={onSelect} onLaunch={() => undefined} />);
    await screen.findByRole('tab', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    view.rerender(<AgentWindows api={second.api as unknown as AgentApi} selectedId={null} onSelect={onSelect} onLaunch={() => undefined} />);
    await screen.findByRole('tab', { name: 'other' });

    await act(async () => { pending.resolve(); });

    expect(screen.getByRole('tab', { name: 'other' })).toHaveAttribute('aria-selected', 'true');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps each independent close busy until that request finishes', async () => {
    const f = fixture([session('first', 'exited'), session('second', 'exited')]);
    const first = deferred<void>();
    const second = deferred<void>();
    const remove = f.api.remove.getMockImplementation()!;
    f.api.remove.mockImplementation(async (id) => { await (id === 'first' ? first.promise : second.promise); await remove(id); });
    render(<Windows api={f.api} />);
    await screen.findByRole('tab', { name: 'first' });
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    fireEvent.click(screen.getByRole('tab', { name: 'second' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));

    await act(async () => { first.resolve(); });

    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeDisabled();
    await act(async () => { second.resolve(); });
    expect(screen.getByText('还没有智能体窗口')).toBeVisible();
  });
});
