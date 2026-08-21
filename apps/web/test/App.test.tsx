import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { WatchdogApi } from '../src/api/client';

function api(): WatchdogApi {
  const config = {
    enabled: true, dryRun: true, pollIntervalMs: 2_000, defaultIdleTimeoutMs: 120_000,
    defaultCooldownMs: 300_000, maxAttemptsPerQuietPeriod: 1,
    tools: {
      claude: { enabled: true, normalPrompt: '请继续' },
      codex: { enabled: true, normalPrompt: '继续', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
    }, processFilters: { sameUserOnly: true, include: [], exclude: [] },
  } as const;
  const sessions = [
    { id: 'goal', tool: 'codex' as const, rootPid: 10, childPids: [], conversationId: 'goal-1', goal: { status: 'paused' }, transport: 'codex-app-server' as const, alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 120_000, pendingPrompt: '/goal resume', lastDecision: 'awaiting-quiet-period' },
    { id: 'normal', tool: 'claude' as const, rootPid: 11, childPids: [], conversationId: null, goal: null, transport: 'classic-console' as const, alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 4_000, pendingPrompt: '请继续', lastDecision: 'output-observed' },
    { id: 'limited', tool: 'codex' as const, rootPid: 12, childPids: [], conversationId: null, goal: null, transport: 'monitor-only' as const, transportError: 'no-cwd-match', alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 150_000, pendingPrompt: '继续', lastDecision: 'cannot-inject' },
  ];
  return {
    health: vi.fn(async () => ({ ok: true, running: true, dryRun: true, lastPollAtMs: Date.now() - 2_000 })),
    config: vi.fn(async () => config),
    updateConfig: vi.fn(async (next) => next),
    sessions: vi.fn(async () => sessions),
    pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), inject: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined), startup: vi.fn(async () => ({ installed: false })), installStartup: vi.fn(async () => undefined), uninstallStartup: vi.fn(async () => undefined), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined),
  };
}

function stoppedApi(): WatchdogApi {
  const fake = api();
  fake.health = vi.fn(async () => ({ ok: true, running: false, dryRun: true, lastPollAtMs: Date.now() - 2_000 }));
  return fake;
}

describe('watchdog dashboard', () => {
  it('renders independent PIDs and goal/non-goal prompts', async () => {
    render(<App api={api()} />);
    expect(screen.getByText('Selbstlauf')).toBeInTheDocument();
    expect((await screen.findAllByText('PID 10')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('/goal resume').length).toBeGreaterThan(0);
    expect(screen.getAllByText('请继续').length).toBeGreaterThan(0);
    expect(screen.getAllByText('仅监控').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未找到同目录 Codex 线程').length).toBeGreaterThan(0);
    expect(screen.getAllByText('等待静默').length).toBeGreaterThan(0);
    expect(screen.getAllByText('输出活跃').length).toBeGreaterThan(0);
  });

  it('shows the age of the most recent watchdog poll', async () => {
    render(<App api={api()} />);
    expect(await screen.findByLabelText('Last watchdog poll')).toHaveTextContent('2s');
  });

  it('disables injection for monitor-only sessions and calls pause/inject controls', async () => {
    const fake = api();
    render(<App api={fake} />);
    const limited = (await screen.findAllByRole('button', { name: '立即续写 PID 12' }))[0];
    expect(limited).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: '立即续写 PID 10' })[0]);
    await waitFor(() => expect(fake.inject).toHaveBeenCalledWith('goal'));
    fireEvent.click(screen.getAllByRole('button', { name: '暂停 PID 10' })[0]);
    await waitFor(() => expect(fake.pause).toHaveBeenCalledWith('goal'));
  });

  it('persists editable prompt settings through the API', async () => {
    const fake = api();
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    const claude = await screen.findByDisplayValue('请继续');
    fireEvent.change(claude, { target: { value: '继续工作' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.objectContaining({ claude: expect.objectContaining({ normalPrompt: '继续工作' }) }) })));
  });

  it('persists process ownership and include/exclude filters through the API', async () => {
    const fake = api();
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    fireEvent.click(screen.getByRole('checkbox', { name: '仅监控当前用户进程' }));
    fireEvent.change(screen.getByLabelText('包含匹配'), { target: { value: 'Nexus, study-os' } });
    fireEvent.change(screen.getByLabelText('排除匹配'), { target: { value: 'node_modules' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      processFilters: { sameUserOnly: false, include: ['Nexus', 'study-os'], exclude: ['node_modules'] },
    })));
  });

  it('stops and restarts the watchdog from the local controls', async () => {
    const running = api();
    const first = render(<App api={running} />);
    fireEvent.click(await screen.findByRole('button', { name: '紧急停止' }));
    await waitFor(() => expect(running.stop).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: '启动 Watchdog' })).toBeInTheDocument();
    first.unmount();

    const stopped = stoppedApi();
    const second = render(<App api={stopped} />);
    fireEvent.click(await screen.findByRole('button', { name: '启动 Watchdog' }));
    await waitFor(() => expect(stopped.start).toHaveBeenCalledTimes(1));
    second.unmount();
  });

  it('offers lifecycle and uninstall controls in settings', async () => {
    const fake = stoppedApi();
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    expect((await screen.findAllByRole('button', { name: '启动 Watchdog' })).length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '安装 Watchdog' }));
    await waitFor(() => expect(fake.install).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '安装启动项' }));
    await waitFor(() => expect(fake.installStartup).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '移除启动项' }));
    await waitFor(() => expect(fake.uninstallStartup).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '卸载 Watchdog' })).toBeInTheDocument();
  });

  it('locks the page while the mobile drawer is open and closes it with Escape', async () => {
    render(<App api={api()} />);
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getByRole('button', { name: '进程' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(await screen.findByRole('button', { name: '打开菜单' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.querySelector('.sidebar')).toHaveClass('is-open');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
    expect(document.querySelector('.sidebar')).not.toHaveClass('is-open');
  });
});
