import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SessionOutputPanel } from '../src/process/SessionOutputPanel';
import type { SessionOutputView } from '../src/api/client';

function response(sessionId: string, text: string): SessionOutputView {
  return { sessionId, state: 'ready', source: 'claude-jsonl', entries: [{ id: '1', role: 'assistant', text, timestampMs: null }], truncated: false };
}

it('renders escaped conversation output and refreshes it from the selected session', async () => {
  const request = vi.fn().mockResolvedValueOnce(response('claude:1', '<script>原样文本</script>')).mockResolvedValue(response('claude:1', '更新后的实际输出'));
  render(<SessionOutputPanel sessionId="claude:1" requestOutput={request} />);
  expect(await screen.findByText('<script>原样文本</script>')).toBeInTheDocument();
  expect(document.querySelector('.session-output script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新会话输出' }));
  expect(await screen.findByText('更新后的实际输出')).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith('claude:1');
});

it('does not mix output from a previous session whose request finishes late', async () => {
  let finish!: (result: SessionOutputView) => void;
  const request = vi.fn((id: string) => id === 'first' ? new Promise<SessionOutputView>((resolve) => { finish = resolve; }) : Promise.resolve(response(id, '第二窗口输出')));
  const view = render(<SessionOutputPanel sessionId="first" requestOutput={request} />);
  view.rerender(<SessionOutputPanel sessionId="second" requestOutput={request} />);
  expect(await screen.findByText('第二窗口输出')).toBeInTheDocument();
  finish(response('first', '第一窗口旧输出'));
  await Promise.resolve();
  expect(screen.queryByText('第一窗口旧输出')).toBeNull();
});

it('shows the real association refusal and rejects a response belonging to another session', async () => {
  const request = vi.fn().mockResolvedValueOnce({ sessionId: 'one', state: 'unavailable', source: null, entries: [], truncated: false, reason: 'association-required' }).mockResolvedValue(response('other', '别的窗口'));
  render(<SessionOutputPanel sessionId="one" requestOutput={request} />);
  expect(await screen.findByText(/尚未唯一关联/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刷新会话输出' }));
  expect(await screen.findByText('无法读取该会话的输出数据。')).toBeInTheDocument();
  expect(screen.queryByText('别的窗口')).toBeNull();
});
