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

  it('names an uncapturable window without claiming to know why', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ state: 'minimized' })} />);
    // A minimized window is now shown briefly to capture it, so reaching this state means the window could
    // not be shown at all — usually it has just closed. A closed window and one that refuses to appear are
    // indistinguishable here, so the message must not assert the minimized case: that advice cannot be
    // followed once the window is gone. It offers the retry instead, which is what actually helps.
    const note = await screen.findByText(/抓不到该窗口的画面/u);
    expect(note.textContent).toContain('刷新');
    expect(note.textContent).not.toContain('还原它');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('says when the picture came from a window that was shown briefly', async () => {
    // The window may have blinked, so the caption explains why and says its state was put back.
    render(
      <SessionWindowPreview
        session={session()}
        requestPreview={async () => ({ ...captured, sharedBy: 1, restoredFromMinimized: true })}
      />,
    );
    expect(await screen.findByText(/原本最小化，已临时显示后还原/u)).toBeInTheDocument();
  });

  it('says nothing about restoring when the window was already showing', async () => {
    render(<SessionWindowPreview session={session()} requestPreview={async () => ({ ...captured, sharedBy: 1 })} />);
    await screen.findByRole('img');
    expect(screen.queryByText(/临时显示后还原/u)).not.toBeInTheDocument();
  });

  it('explains a harness session has no window of its own', async () => {
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
    const note = await screen.findByText(/没有自己的窗口/u);
    expect(note.textContent).toContain('DeepSeek Harness');
  });

  /**
   * A null handle has more than one cause, so the message must not assert a single one.
   *
   * The wording used to claim *every* session without a window was DeepSeek Harness. That is true
   * for every session on this machine and wrong in general — a Codex session in a bare console has
   * no window either, and being told it was DeepSeek Harness is a message about the wrong tool.
   */
  it('does not claim a non-harness session is DeepSeek Harness', async () => {
    const consoleSession = session({
      id: 'codex:9',
      tool: 'codex',
      host: {
        label: '控制台',
        category: 'console',
        windowTitle: null,
        windowHandle: null,
        processId: 9001,
        executableName: 'cmd.exe',
      },
    });
    render(<SessionWindowPreview session={consoleSession} requestPreview={async () => ({ state: 'no-window' })} />);
    const note = await screen.findByText(/没有可预览的窗口/u);
    expect(note.textContent).not.toContain('DeepSeek Harness');
    // It names the host the service actually identified rather than guessing the kind.
    expect(note.textContent).toContain('控制台');
  });

  it('says a window could not be identified when the host is unknown', async () => {
    const unknown = session({ id: 'codex:8', tool: 'codex', host: null });
    render(<SessionWindowPreview session={unknown} requestPreview={async () => ({ state: 'no-window' })} />);
    const note = await screen.findByText(/未识别出该进程所在的窗口/u);
    expect(note.textContent).not.toContain('DeepSeek Harness');
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