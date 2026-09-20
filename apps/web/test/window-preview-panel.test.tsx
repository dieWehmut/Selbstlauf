import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionView } from '../src/api/client';
import { SessionWindowPreview } from '../src/process/SessionWindowPreview';
import type { WindowPreviewResult } from '../src/App';

/**
 * The window preview panel.
 *
 * Its whole job is to be honest about what it can show. Three of its four states are ordinary
 * rather than failures — a session with no window, a minimized window, and an environment
 * without a capturer — and each must say which one applies, because "I can see nothing" is not
 * something a person can act on.
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
    host: {
      label: 'Tabby',
      category: 'terminal',
      windowTitle: ' copilot-segmentation',
      windowHandle: 67008,
      processId: 67008,
      executableName: 'Tabby.exe',
    },
    ...overrides,
  } as unknown as SessionView;
}

const captured: WindowPreviewResult = {
  state: 'captured',
  dataUrl: 'data:image/png;base64,AAAA',
  width: 960,
  height: 600,
  sharedBy: 1,
};

describe('SessionWindowPreview', () => {
  it('shows the captured window with a caption naming the process', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => captured} />);

    const image = await screen.findByRole('img', { name: /PID 4242/u });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(image).toHaveAttribute('width', '960');
    expect(screen.getByText(/PID 4242 所在窗口/u)).toBeInTheDocument();
    // The window title is included, so the picture is identifiable.
    expect(screen.getByText(/copilot-segmentation/u)).toBeInTheDocument();
  });

  it('says when several processes share the window, so the picture is not misread', async () => {
    // Two Codex sessions inside one Tabby window is the real case.
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ ...captured, sharedBy: 2 })} />);
    expect(await screen.findByText(/此窗口内有 2 个受监控进程/u)).toBeInTheDocument();
  });

  it('names a minimized window instead of showing an empty frame', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ state: 'minimized' })} />);
    expect(await screen.findByText(/窗口已最小化/u)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('explains that a session with no window has nothing to show', async () => {
    const dsh = session({
      id: 'dsh:1',
      tool: 'dsh',
      host: {
        label: 'DeepSeek Harness 网页界面',
        category: 'browser',
        windowTitle: null,
        windowHandle: null,
        processId: 7984,
        executableName: 'dsh-shortcut.exe',
      },
    });
    render(<SessionWindowPreview session={dsh} requestPreview={async () => ({ state: 'no-window' })} />);
    expect(await screen.findByText(/它没有自己的窗口|没有自己的窗口/u)).toBeInTheDocument();
  });

  it('disables the switch-to-window button when there is no window to switch to', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ state: 'no-window' })} />);
    const button = await screen.findByRole('button', { name: /切换到该窗口/u });
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('reports that this environment cannot capture, rather than appearing broken', async () => {
    render(<SessionWindowPreview session={session()} />);
    expect(await screen.findByText(/不能预览窗口|不支持窗口预览/u)).toBeInTheDocument();
  });

  it('surfaces the reason a capture failed', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ state: 'unsupported', reason: '服务不可用' })} />);
    expect(await screen.findByText('服务不可用')).toBeInTheDocument();
  });

  it('asks for a preview once per session, not on every render', async () => {
    const request = vi.fn(async () => captured);
    const { rerender } = render(<SessionWindowPreview session={session()} requestPreview={request} />);
    await screen.findByRole('img');
    rerender(<SessionWindowPreview session={session()} requestPreview={request} />);
    rerender(<SessionWindowPreview session={session()} requestPreview={request} />);
    // A capture pass walks every window on the machine, so repeating it per render would be
    // both wasteful and visibly flickery.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('switches to the window through the supplied action', async () => {
    const onOpenWindow = vi.fn();
    const target = session();
    render(<SessionWindowPreview session={target} requestPreview={async () => captured} onOpenWindow={onOpenWindow} />);

    fireEvent.click(await screen.findByRole('button', { name: /切换到该窗口/u }));
    expect(onOpenWindow).toHaveBeenCalledWith(target);
  });

  it('refreshes on request', async () => {
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      return { ...captured, dataUrl: `data:image/png;base64,N${call}` };
    });
    render(<SessionWindowPreview session={session()} requestPreview={request} />);

    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: '刷新窗口预览' }));
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,N2'));
  });
});