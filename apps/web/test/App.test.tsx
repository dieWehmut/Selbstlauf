import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { SessionView, WatchdogApi, WatchdogEvent } from '../src/api/client';

function api(): WatchdogApi {
  const config = {
    enabled: true, dryRun: true, pollIntervalMs: 2_000, defaultIdleTimeoutMs: 120_000,
    defaultCooldownMs: 300_000, maxAttemptsPerQuietPeriod: 1,
    tools: {
      claude: {
        enabled: true,
        normalPrompt: '请继续',
        stopHook: { enabled: false, leaseTtlMs: 15_000, commandTimeoutMs: 1_500 },
      },
      codex: { enabled: true, normalPrompt: '继续', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
      dsh: { enabled: true, normalPrompt: '继续', sessionWindowMs: 3_600_000, allowApiInput: true },
    }, processFilters: { sameUserOnly: true, include: [], exclude: [] },
  } as const;
  const sessions = [
    { id: 'goal', tool: 'codex' as const, rootPid: 10, childPids: [], conversationId: 'goal-1', goal: { status: 'paused' }, transport: 'codex-app-server' as const, alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 120_000, pendingPrompt: '/goal resume', lastDecision: 'awaiting-quiet-period', host: { processId: 20, executableName: 'Tabby.exe', label: 'Tabby', category: 'terminal' as const, windowHandle: 65_001, windowTitle: ' Orchester' } },
    { id: 'normal', tool: 'claude' as const, rootPid: 11, childPids: [], conversationId: null, goal: null, transport: 'classic-console' as const, alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 4_000, pendingPrompt: '请继续', lastDecision: 'output-observed', host: { processId: 21, executableName: 'Code.exe', label: 'Visual Studio Code', category: 'editor' as const, windowHandle: 65_002, windowTitle: 'config.toml - Visual Studio Code' } },
    { id: 'limited', tool: 'codex' as const, rootPid: 12, childPids: [], conversationId: null, goal: null, transport: 'monitor-only' as const, transportError: 'no-cwd-match', alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 150_000, pendingPrompt: '继续', lastDecision: 'cannot-inject', host: null },
    { id: 'dsh:hosted', tool: 'dsh' as const, rootPid: 13, childPids: [14], conversationId: 'session-hosted', goal: null, transport: 'dsh-web' as const, alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, quietForMs: 42_000, pendingPrompt: '继续', lastDecision: 'awaiting-quiet-period', sessionCwd: 'D:\\project\\ai-cli-bypass', runningTurn: true, host: { processId: 22, executableName: 'msedge.exe', label: 'Microsoft Edge', category: 'browser' as const, windowHandle: 65_003, windowTitle: '帮我优化排版 — DSH' } },
  ];
  return {
    health: vi.fn(async () => ({ ok: true, running: true, dryRun: true, lastPollAtMs: Date.now() - 2_000 })),
    config: vi.fn(async () => config),
    updateConfig: vi.fn(async (next) => next),
    sessions: vi.fn(async () => sessions),
    pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), inject: vi.fn(async () => undefined),
    focus: vi.fn(async () => ({ focused: true })),
    install: vi.fn(async () => undefined), startup: vi.fn(async () => ({ installed: false })), installStartup: vi.fn(async () => undefined), uninstallStartup: vi.fn(async () => undefined),
    claudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    codexProfiles: vi.fn(async () => ({ path: 'C:/demo/config.toml', exists: true, active: {}, alternatives: {}, current: null })),
    applyCodexProfile: vi.fn(async () => ({ ok: true, changes: [] })),
    installClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    uninstallClaudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    disableClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined),
  };
}

function stoppedApi(): WatchdogApi {
  const fake = api();
  fake.health = vi.fn(async () => ({ ok: true, running: false, dryRun: true, lastPollAtMs: Date.now() - 2_000 }));
  return fake;
}

describe('watchdog dashboard', () => {
  it('shows where each session runs and opens that window', async () => {
    const fake = api();
    render(<App api={fake} />);
    expect((await screen.findAllByText('Tabby')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Visual Studio Code').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Microsoft Edge').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未识别宿主').length).toBeGreaterThan(0);

    // A session with a resolved window offers the reveal action; one without a
    // host keeps it disabled.
    const reveal = (await screen.findAllByRole('button', { name: '打开运行位置 PID 10' }))[0];
    expect(reveal).not.toBeDisabled();
    fireEvent.click(reveal);
    await waitFor(() => expect(fake.focus).toHaveBeenCalledWith('goal'));
    expect((await screen.findAllByRole('button', { name: '打开运行位置 PID 12' }))[0]).toBeDisabled();
  });
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

  it('renders a continuable DeepSeek Harness session with its workspace and live step', async () => {
    const fake = api();
    render(<App api={fake} />);
    expect((await screen.findAllByText('DeepSeek Harness')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('session-hosted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('步骤执行中').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Harness API').length).toBeGreaterThan(0);
    // The harness session is writable in this fixture, so manual continuation is
    // offered exactly like it is for a Console session.
    const harnessInject = (await screen.findAllByRole('button', { name: '立即续写 PID 13' }))[0];
    expect(harnessInject).not.toBeDisabled();
    fireEvent.click(harnessInject);
    await waitFor(() => expect(fake.inject).toHaveBeenCalledWith('dsh:hosted'));
  });

  it('persists the harness write switch through the API', async () => {
    const fake = api();
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    fireEvent.click(screen.getByRole('checkbox', { name: '允许续写 DeepSeek Harness' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({ dsh: expect.objectContaining({ allowApiInput: false }) }),
    })));
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

  it('renders and manages the explicit Claude Stop Hook settings', async () => {
    const fake = api();
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);

    expect(await screen.findByRole('heading', { name: 'Claude Stop Hook' })).toBeInTheDocument();
    expect(screen.getByText(/~\/\.claude\/settings\.json/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '启用 Claude Stop Hook' })).not.toBeChecked();
    expect(screen.getByLabelText('Lease 有效期（毫秒）')).toHaveValue(15_000);
    expect(screen.getByLabelText('命令超时（毫秒）')).toHaveValue(1_500);

    fireEvent.click(screen.getByRole('button', { name: '安装 Stop Hook' }));
    await waitFor(() => expect(fake.installClaudeHook).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('需重启 Claude')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卸载 Stop Hook' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '启用 Claude Stop Hook' }));
    fireEvent.change(screen.getByLabelText('Lease 有效期（毫秒）'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('命令超时（毫秒）'), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        claude: expect.objectContaining({
          stopHook: { enabled: true, leaseTtlMs: 20_000, commandTimeoutMs: 1_800 },
        }),
      }),
    })));

    fireEvent.click(await screen.findByRole('button', { name: '停用 Stop Hook' }));
    await waitFor(() => expect(fake.disableClaudeHook).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '卸载 Stop Hook' }));
    await waitFor(() => expect(fake.uninstallClaudeHook).toHaveBeenCalledTimes(1));
  });

  it('switches Codex endpoints through the profile API and refreshes the view', async () => {
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({
      path: 'C:/demo/config.toml',
      exists: true,
      active: { base_url: 'https://first.example/v1', model: 'gpt-6-astra' },
      alternatives: { base_url: ['https://second.example/v1'] },
      current: { name: 'first.example', fields: [{ key: 'base_url', value: 'https://first.example/v1' }, { key: 'model', value: 'gpt-6-astra' }] },
    }));
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);

    expect(await screen.findByRole('heading', { name: '端点配置' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://first.example/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-6-astra')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'https://second.example/v1' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([
      { key: 'base_url', value: 'https://second.example/v1' },
      { key: 'model', value: 'gpt-6-astra' },
    ]));
    expect(await screen.findByText('Codex 端点已切换')).toBeInTheDocument();
  });

  it('applies edited endpoint fields from the settings panel', async () => {
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({
      path: 'C:/demo/config.toml',
      exists: true,
      active: { base_url: 'https://first.example/v1' },
      alternatives: {},
      current: { name: 'first.example', fields: [{ key: 'base_url', value: 'https://first.example/v1' }] },
    }));
    render(<App api={fake} />);
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);

    const url = await screen.findByLabelText('接口地址');
    fireEvent.change(url, { target: { value: 'https://third.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '应用端点配置' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([
      { key: 'base_url', value: 'https://third.example/v1' },
    ]));
  });

  it('allows exact-session Stop Hook continuation while monitor-only remains disabled', async () => {
    const fake = api();
    const isolatedSessions: SessionView[] = [
      {
        id: 'hook', tool: 'claude', rootPid: 21, childPids: [], conversationId: 'session-hook', goal: null,
        transport: 'claude-stop-hook', alive: true, enabled: true, paused: false, startedAtMs: 1,
        lastActivityAtMs: 2, quietForMs: 130_000, pendingPrompt: '请继续', lastDecision: 'awaiting-quiet-period',
      },
      {
        id: 'monitor', tool: 'claude', rootPid: 22, childPids: [], conversationId: 'session-monitor', goal: null,
        transport: 'monitor-only', alive: true, enabled: true, paused: false, startedAtMs: 1,
        lastActivityAtMs: 2, quietForMs: 130_000, pendingPrompt: '请继续', lastDecision: 'cannot-inject',
      },
    ];
    fake.sessions = vi.fn(async (): Promise<SessionView[]> => isolatedSessions);
    render(<App api={fake} />);

    const hookAction = (await screen.findAllByRole('button', { name: '立即续写 PID 21' }))[0];
    const monitorAction = screen.getAllByRole('button', { name: '立即续写 PID 22' })[0];
    expect(hookAction).toBeEnabled();
    expect(monitorAction).toBeDisabled();
    fireEvent.click(hookAction);
    await waitFor(() => expect(fake.inject).toHaveBeenCalledWith('hook'));
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

  it('refreshes authoritative state when a named realtime event arrives', async () => {
    const fake = api();
    const sessions = vi.mocked(fake.sessions);
    const claudeHook = vi.mocked(fake.claudeHook);
    let receive: ((event: WatchdogEvent) => void) | undefined;
    fake.subscribe = vi.fn((listener) => {
      receive = listener;
      return () => undefined;
    });
    render(<App api={fake} />);
    await waitFor(() => expect(sessions).toHaveBeenCalled());
    const callsBefore = sessions.mock.calls.length;
    receive?.({ kind: 'sessions', data: { action: 'inject', sessionId: 'goal' } });
    await waitFor(() => expect(sessions.mock.calls.length).toBeGreaterThan(callsBefore));
    const hookCallsBefore = claudeHook.mock.calls.length;
    receive?.({ kind: 'claude-hook', data: { installed: true } });
    await waitFor(() => expect(claudeHook.mock.calls.length).toBeGreaterThan(hookCallsBefore));
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
