import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { HealthView, SessionView, WatchdogApi, WatchdogEvent } from '../src/api/client';
import type { EnvironmentView } from '../src/api/client';

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
    environment: vi.fn(async () => environment),
    refreshEnvironment: vi.fn(async () => environment),
    upgradeTool: vi.fn(async (id: string) => ({ id, ok: true, output: 'added 1 package' })),
    upgradeAllTools: vi.fn(async () => ({
      ok: true,
      results: environment.upgrades.map((id) => ({ id, ok: true, output: 'added 1 package' })),
    })),
    installClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    uninstallClaudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    disableClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined),
  };
}

const environment: EnvironmentView = {
  tools: [
    { id: 'claude', label: 'Claude Code', packageName: '@anthropic-ai/claude-code', installed: '2.1.274', latest: '2.1.276', state: 'outdated', installCommand: 'npm i -g @anthropic-ai/claude-code@latest' },
    { id: 'codex', label: 'Codex', packageName: '@openai/codex', installed: '0.155.0', latest: '0.155.0', state: 'current', installCommand: 'npm i -g @openai/codex@latest' },
    { id: 'gemini', label: 'Gemini CLI', packageName: '@google/gemini-cli', installed: '0.50.0', latest: '0.60.0', state: 'outdated', installCommand: 'npm i -g @google/gemini-cli@latest' },
    { id: 'grok', label: 'Grok Build', packageName: '@xai-official/grok', installed: null, latest: '1.0.34', state: 'missing', installCommand: 'npm i -g @xai-official/grok@latest' },
  ],
  upgrades: ['claude', 'gemini'],
  missing: ['grok'],
  manualCommands: [
    'npm i -g @anthropic-ai/claude-code@latest',
    'npm i -g @openai/codex@latest',
    'npm i -g @google/gemini-cli@latest',
    'npm i -g @xai-official/grok@latest',
  ],
  checkedAtMs: 1,
};

function stoppedApi(): WatchdogApi {
  const fake = api();
  fake.health = vi.fn(async () => ({ ok: true, running: false, dryRun: true, lastPollAtMs: Date.now() - 2_000 }));
  return fake;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ImportErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert">Appearance crashed</div> : this.props.children; }
}

  it('organizes settings into tabs and follows the system theme', async () => {
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    // The settings page opens on the general section and can switch sections.
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    // The watchdog settings are the working view and open first.
    expect(within(tabs).getByRole('tab', { name: '常规' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(tabs).getByRole('tab', { name: '账户' }));
    expect(within(tabs).getByRole('tab', { name: '账户' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('本地环境检查')).toBeInTheDocument();

    // The appearance control offers light, dark, and follow-system previews.
    fireEvent.click(within(tabs).getByRole('tab', { name: '外观' }));
    const appearance = await screen.findByRole('radiogroup', { name: '外观主题' });
    fireEvent.click(within(appearance).getByRole('radio', { name: '跟随系统' }));
    // A system preference resolves through the media query, not a stored literal.
    expect(localStorage.getItem('watchdog-theme')).toBe('system');

    const languages = screen.getByRole('group', { name: '界面语言' });
    expect(within(languages).getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true');
    for (const language of ['繁體中文', 'English', '日本語']) {
      expect(within(languages).getByRole('button', { name: new RegExp(language) })).toBeDisabled();
    }
  });

  /**
   * The rail is the map of the console: two labelled categories, the reference's
   * section order, and a search field that really filters it.
   */
  it('lists every settings section under its category and filters them by search', async () => {
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    const rail = await screen.findByRole('tablist', { name: '设置分区' });
    const expected = [
      '常规', '通知', '导入', '个人资料', '外观', '家长控制', '信任联系人',
      '语音', '配置', '个性化', '宠物', '键盘快捷键', '使用统计', '账户',
      '电脑操控', '应用快照', '插件', '浏览器',
    ];
    const labels = within(rail).getAllByRole('tab').map((tab) => tab.textContent);
    expect(labels).toEqual(expected);

    /**
     * The rail must not name a section something the app does not have.
     *
     * Two entries had drifted: 信任联系人 appeared in English as "Trusted contact" while
     * its own panel said 信任联系人, and 使用统计 was labelled 使用情况和计费 — promising
     * billing, of which the application has no concept at all. Both were found by reading
     * the labels against the panels they open, so the labels are pinned here.
     */
    expect(labels).not.toContain('Trusted contact');
    expect(labels.some((label) => label?.includes('计费')), 'the rail promises billing again').toBe(false);

    // The two category headings are present, in order.
    expect(screen.getByText('个人')).toBeInTheDocument();
    expect(screen.getByText('集成')).toBeInTheDocument();

    // Search narrows the rail to matching entries only.
    const search = screen.getByRole('searchbox', { name: '搜索设置' });
    fireEvent.change(search, { target: { value: '家长' } });
    const filtered = within(rail).getAllByRole('tab').map((tab) => tab.textContent);
    expect(filtered).toEqual(['家长控制']);

    // A query matching nothing says so instead of showing an empty rail.
    fireEvent.change(search, { target: { value: 'zzz-no-such-section' } });
    expect(within(rail).queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('无匹配设置')).toBeInTheDocument();

    // Clearing restores the full list.
    fireEvent.change(search, { target: { value: '' } });
    expect(within(rail).getAllByRole('tab')).toHaveLength(expected.length);
  });

  /** 返回应用 leaves the settings page again. */
  it('returns to the overview from the settings rail', async () => {
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByRole('tablist', { name: '设置分区' });

    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
  });

  /**
   * The 键盘快捷键 section must document exactly the bindings the app honours,
   * so the binding is exercised here rather than merely listed.
   */
  it('switches pages with the documented Ctrl+1..3 bindings', async () => {
    render(<App api={api()} />);
    await screen.findByRole('heading', { name: '进程监控' });

    fireEvent.keyDown(window, { key: '2', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: '事件记录' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();

    // Ctrl+, is what the bottom bar's menu advertises beside 设置. It was displayed
    // without being bound, so pressing it did nothing while the menu claimed otherwise.
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();

    // The documented list matches the implemented set, and nothing more.
    fireEvent.click(await screen.findByRole('tab', { name: '键盘快捷键' }));
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    expect(rows.some((row) => row.includes('Ctrl+1'))).toBe(true);
    expect(rows.some((row) => row.includes('Ctrl+2'))).toBe(true);
    expect(rows.some((row) => row.includes('Ctrl+3'))).toBe(true);
    expect(rows.some((row) => row.includes('Ctrl+,'))).toBe(true);
    expect(rows.some((row) => row.includes('Esc'))).toBe(true);
    // A binding nobody implemented must not be advertised.
    expect(rows.some((row) => /Ctrl\+(4|5|S|P)/u.test(row))).toBe(false);
  });

  /** 电脑操控 owns the reveal switch, which really disables the table action. */
  it('disables the reveal action when 电脑操控 turns it off', async () => {
    render(<App api={api()} />);
    await screen.findByRole('heading', { name: '进程监控' });
    // The table and the mobile card both render the action, so scope to the table.
    const table = screen.getByRole('table');
    const reveal = await within(table).findByRole('button', { name: /打开运行位置 PID 10/u });
    expect(reveal).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('tab', { name: '电脑操控' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '允许打开运行位置' }));

    // On 设置 the left rail is the settings rail, so the app's own sidebar — and with it
    // the 进程 nav button — is not rendered. 返回应用 is the way back.
    fireEvent.click(await screen.findByRole('button', { name: /返回应用/u }));
    expect(await within(screen.getByRole('table')).findByRole('button', { name: /打开运行位置 PID 10/u })).toBeDisabled();

    // The switch persists, so restore it for the tests that follow this one.
    localStorage.removeItem('watchdog-computer-control');
  });

  /**
   * 个人资料's display name is adopted by the bottom bar's popup.
   *
   * The sidebar has no header block any more, so the identity it used to show — the mark
   * and the display name — lives in the popup the bottom bar opens.
   */
  it('shows the profile display name in the bottom bar popup', async () => {
    render(<App api={api()} />);
    // The top brand block is gone from the sidebar.
    expect(document.querySelector('.sidebar > .brand')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('tab', { name: '个人资料' }));
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Orchester' } });

    fireEvent.click(await screen.findByRole('button', { name: /返回应用/u }));

    // The name is shown by the bottom bar's popup, so open it.
    fireEvent.click(screen.getByRole('button', { name: /服务在线|服务未连接|离线预览/u }));
    const region = screen.getByRole('region', { name: '账户与状态' });
    expect(within(region).getByText('Orchester')).toBeInTheDocument();

    // Leave the stored profile clean for the next test in this file.
    localStorage.removeItem('watchdog-profile');
  });




  it('previews each theme and applies a custom palette to the document', async () => {
    // The tab test above leaves 'system' stored; this test starts from dark.
    localStorage.setItem('watchdog-theme', 'dark');
    localStorage.removeItem('watchdog-palette');
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '外观' }));

    // All three previews are offered, and the stored preference marks one.
    const previews = await screen.findByRole('radiogroup', { name: '外观主题' });
    expect(within(previews).getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'false');
    expect(within(previews).getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true');

    // The diff names the surface, the accent, and the contrast in effect.
    const diff = screen.getByTestId('theme-diff').textContent ?? '';
    expect(diff).toContain('accent: "#e6b65b"');
    expect(diff).toContain('contrast: 68');

    // The type rows are independent: the interface stack and the reading stack
    // can differ, and "same as UI" stops mattering once they do.
    fireEvent.change(screen.getByRole('combobox', { name: 'UI 字体' }), { target: { value: 'mono' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--ui-font')).toBe('var(--mono)'));
    expect(document.documentElement.style.getPropertyValue('--content-font')).toBe('var(--mono)');
    fireEvent.change(screen.getByRole('combobox', { name: '内容字体' }), { target: { value: 'serif' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--content-font')).toContain('Georgia'));

    // The contrast slider lifts the surfaces away from the page background.
    const beforeContrast = document.documentElement.style.getPropertyValue('--panel');
    fireEvent.change(screen.getByRole('slider', { name: '对比度' }), { target: { value: '20' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--panel')).not.toBe(beforeContrast));
    expect(JSON.parse(localStorage.getItem('watchdog-palette') ?? '{}').dark.contrast).toBe(20);

    // A translucent sidebar is a document-level flag the stylesheet reads.
    fireEvent.click(screen.getByRole('checkbox', { name: '半透明侧边栏' }));
    await waitFor(() => expect(document.documentElement.dataset.sidebar).toBe('translucent'));

    // Picking an accent repaints the document root, which every rule derives from.
    fireEvent.change(screen.getByRole('combobox', { name: '强调色' }), { target: { value: '#e05c93' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#e05c93'));
    // The override is per scheme and survives a reload.
    expect(JSON.parse(localStorage.getItem('watchdog-palette') ?? '{}').dark.accent).toBe('#e05c93');

    // Switching scheme shows the other scheme's untouched defaults.
    fireEvent.click(within(previews).getByRole('radio', { name: '浅色' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a56a08'));

    // Resetting returns the scheme to the stock palette.
    fireEvent.click(within(previews).getByRole('radio', { name: '深色' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#e6b65b'));
  });

  it.each([
    ['legacy colors', {}],
    ['invalid optional settings', { contrast: 'invalid', uiType: null, contentType: false, translucentSidebar: 'yes' }],
  ])('imports %s with usable default appearance controls', async (_label, optionalSettings) => {
    localStorage.setItem('watchdog-theme', 'dark');
    localStorage.removeItem('watchdog-palette');
    Object.assign(navigator, { clipboard: { readText: async () => JSON.stringify({
      accent: '#4c9cd4', background: '#102030', foreground: '#f0e0d0', ...optionalSettings,
    }) } });
    render(<ImportErrorBoundary><App api={api()} /></ImportErrorBoundary>);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    expect(await screen.findByText('主题已导入')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'UI 字体' })).toHaveValue('system');
    expect(screen.getByRole('combobox', { name: '内容字体' })).toHaveValue('same');
    expect(screen.getByRole('slider', { name: '对比度' })).toHaveValue('68');
    expect(screen.getByRole('checkbox', { name: '半透明侧边栏' })).not.toBeChecked();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#4c9cd4'));
    expect(JSON.parse(localStorage.getItem('watchdog-palette') ?? '{}').dark).toEqual({
      accent: '#4c9cd4', background: '#102030', foreground: '#f0e0d0', contrast: 68,
      translucentSidebar: false,
      uiType: { family: 'system', weight: 400 },
      contentType: { family: 'system', weight: 400, sameAsUi: true },
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'UI 字体' }), { target: { value: 'mono' } });
    expect(document.documentElement.style.getPropertyValue('--ui-font')).toBe('var(--mono)');
  });

  it('reports the local environment and offers the install commands', async () => {
    const fake = api();
    render(<App api={fake} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    // The environment check lives on the About tab, beside the version card.
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '账户' }));

    // The panel names each agent with its installed and published version.
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('2.1.274')).toBeInTheDocument();
    expect(screen.getByText('2.1.276')).toBeInTheDocument();

    // A missing tool says so instead of pretending it is current.
    expect(screen.getAllByText('未安装').length).toBeGreaterThan(0);

    // The manual install block is available behind its toggle.
    fireEvent.click(screen.getByRole('button', { name: /手动安装命令/ }));
    const block = await screen.findByTestId('manual-commands');
    expect(block.textContent).toContain('npm i -g @openai/codex@latest');

    // The block can be copied as one runnable script.
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: '复制安装命令' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('npm i -g @openai/codex@latest');

    // Every outdated card offers its own install button.
    expect(screen.getByRole('button', { name: '升级 Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '升级 Gemini CLI' })).toBeInTheDocument();
    // A current tool is not offered a pointless reinstall.
    expect(screen.queryByRole('button', { name: '升级 Codex' })).toBeNull();

    // Pressing one installs exactly that tool and re-reads the report.
    fireEvent.click(screen.getByRole('button', { name: '升级 Claude Code' }));
    await waitFor(() => expect(fake.upgradeTool).toHaveBeenCalledWith('claude'));
    // The bulk button upgrades everything the report marks outdated.
    fireEvent.click(screen.getByRole('button', { name: '全部升级' }));
    await waitFor(() => expect(fake.upgradeAllTools).toHaveBeenCalled());

    // Refreshing asks the service to re-probe rather than reusing its cache.
    fireEvent.click(screen.getByRole('button', { name: '刷新本地环境' }));
    await waitFor(() => expect(fake.refreshEnvironment).toHaveBeenCalled());
  });


describe('watchdog dashboard', () => {
  it('shows no example sessions while the local service is still connecting', () => {
    const fake = api();
    const pendingHealth = deferred<HealthView>();
    fake.health = vi.fn(() => pendingHealth.promise);
    render(<App api={fake} />);

    expect(screen.getByText('0 个进程')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /立即续写 PID/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(screen.getByText('暂无事件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进程' }));
    expect(screen.queryByText('样例数据')).not.toBeInTheDocument();
  });

  it('keeps example sessions in the static demo', () => {
    vi.stubEnv('VITE_STATIC_DEMO', 'true');
    const view = render(<App />);
    try {
      expect(screen.getByText('4 个进程')).toBeInTheDocument();
      expect(screen.getAllByText('PID 336756').length).toBeGreaterThan(0);
      expect(screen.getByText('样例数据')).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.unstubAllEnvs();
    }
  });

  it('updates monitoring and session controls while the environment scan is pending', async () => {
    const fake = api();
    const pendingEnvironment = deferred<EnvironmentView>();
    let sessions = await fake.sessions();
    fake.environment = vi.fn(() => pendingEnvironment.promise);
    fake.sessions = vi.fn(async () => sessions);
    fake.pause = vi.fn(async (id: string) => {
      sessions = sessions.map((session) => session.id === id ? { ...session, paused: true } : session);
    });
    render(<App api={fake} />);

    expect(await screen.findByText('服务在线')).toBeInTheDocument();
    expect(screen.getAllByText('PID 10').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '暂停 PID 10' })[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '恢复 PID 10' })[0]).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('tab', { name: '账户' }));
    expect(screen.queryByRole('heading', { name: '本地环境检查' })).not.toBeInTheDocument();
    await act(async () => pendingEnvironment.resolve(environment));
    expect(await screen.findByRole('heading', { name: '本地环境检查' })).toBeInTheDocument();
    expect(screen.getByText('2.1.274')).toBeInTheDocument();

    // The 服务在线 indicator belongs to the app sidebar, which 设置 replaces with the
    // settings rail, so it is asserted on the way back — the state it reports must not
    // have been disturbed by the pending environment scan.
    fireEvent.click(await screen.findByRole('button', { name: /返回应用/u }));
    expect(await screen.findByText('服务在线')).toBeInTheDocument();
  });

  it('keeps monitoring online when the environment scan rejects', async () => {
    const fake = api();
    const pendingEnvironment = deferred<EnvironmentView>();
    fake.environment = vi.fn(() => pendingEnvironment.promise);
    render(<App api={fake} />);

    await act(async () => pendingEnvironment.reject(new Error('npm lookup failed')));
    expect(await screen.findByText('服务在线')).toBeInTheDocument();
    expect(screen.getAllByText('PID 10').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '紧急停止' })).toBeEnabled();
  });

  /**
   * The Selbstlauf mark, now in the bottom bar's popup rather than a sidebar header.
   * The asset is imported, so Vite rewrites the URL for the Pages sub-path too.
   */
  it('shows the Selbstlauf mark in the bottom bar popup', async () => {
    render(<App api={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: /服务在线|服务未连接|离线预览/u }));
    const mark = await screen.findByTestId('brand-mark');
    expect(mark.querySelector('img')?.getAttribute('src')).toContain('brand');
    expect(mark.querySelector('img')?.getAttribute('alt')).toBe('');
  });

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
    expect((await screen.findAllByText('PID 10')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('/goal resume').length).toBeGreaterThan(0);
    expect(screen.getAllByText('请继续').length).toBeGreaterThan(0);
    expect(screen.getAllByText('仅监控').length).toBeGreaterThan(0);
    expect(screen.getAllByText('未找到同目录 Codex 线程').length).toBeGreaterThan(0);
    expect(screen.getAllByText('等待静默').length).toBeGreaterThan(0);
    expect(screen.getAllByText('输出活跃').length).toBeGreaterThan(0);
    // The app's own name is no longer shown on the dashboard: the sidebar has no brand
    // block, and the identity lives in the bottom bar's popup.
    expect(screen.queryByText('Selbstlauf')).not.toBeInTheDocument();
  });

  /**
   * Every sidebar row names its conversation, not only the selected one.
   *
   * Which conversation a process is in decides whether continuing it makes sense, so it
   * belongs on the row rather than one click away. The value comes from the same helper
   * the process table uses, so the two views cannot describe one session differently.
   */
  it('shows a conversation on every sidebar process row', async () => {
    render(<App api={api()} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    const rows = within(list).getAllByRole('button');
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows) {
      const conversation = row.querySelector('.sidebar-processes__conversation');
      expect(conversation, `a row has no conversation: ${row.textContent}`).not.toBeNull();
      // Either a real conversation id or the explicit 未关联, never an empty line.
      const text = conversation?.textContent ?? '';
      expect(text.length, 'the conversation line is empty').toBeGreaterThan(0);
      expect(text).toMatch(/·/u);
    }

    // The fixtures carry both cases, so both must be visible somewhere in the list.
    const all = rows.map((row) => row.querySelector('.sidebar-processes__conversation')?.textContent ?? '');
    expect(all.some((text) => text.includes('未关联'))).toBe(true);
    expect(all.some((text) => text.includes('Goal') || text.includes('普通对话') || text.includes('等待输入') || text.includes('步骤执行中'))).toBe(true);
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
    // The Claude Stop Hook lives on 配置, beside the endpoint panel; it used to be
    // mounted on 常规 while the rail's 配置 entry rendered nothing at all.
    fireEvent.click(await screen.findByRole('tab', { name: '配置' }));

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
    fireEvent.click(await screen.findByRole('tab', { name: '配置' }));

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
    fireEvent.click(await screen.findByRole('tab', { name: '配置' }));

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

describe('window title bar', () => {
  const titlebar = () => document.querySelector('.titlebar') as HTMLElement;

  it('renders the panel toggle, history arrows, and the four menus', () => {
    render(<App api={api()} />);
    const bar = titlebar();
    expect(bar).not.toBeNull();

    // The row is the window's title bar, so it offers the sidebar toggle, the
    // in-app history arrows, and the four menu buttons in reference order.
    expect(within(bar).getByRole('button', { name: '收起侧栏' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: '后退' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: '前进' })).toBeInTheDocument();
    expect(
      within(bar)
        .getAllByRole('button')
        .filter((button) => ['文件', '编辑', '视图', '帮助'].includes(button.textContent ?? ''))
        .map((button) => button.textContent),
    ).toEqual(['文件', '编辑', '视图', '帮助']);

    // The heading stays in the second row; the title bar carries no title text.
    expect(screen.getByRole('heading', { name: '进程监控' })).toBeInTheDocument();
    expect(bar.textContent).not.toContain('Selbstlauf');
  });

  it('drives the existing sidebar compact state from the panel toggle', () => {
    render(<App api={api()} />);
    const toggle = within(titlebar()).getByRole('button', { name: '收起侧栏' });
    fireEvent.click(toggle);
    // The toggle is wired to the same state the bottom bar's menu uses.
    expect(document.querySelector('.app-shell')).toHaveClass('app-shell--compact');
    expect(within(titlebar()).getByRole('button', { name: '展开侧栏' })).toBeInTheDocument();
  });

  it('lists discovered processes grouped by the host they run inside', async () => {
    const fake = api();
    render(<App api={fake} />);
    await screen.findByText('0 个进程').catch(() => undefined);

    // The fixtures carry no host, so every process must land in the named fallback
    // group rather than being dropped from the list.
    const list = await screen.findByRole('group', { name: '进程列表' });
    expect(within(list).getByText('未识别宿主')).toBeInTheDocument();
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(4);
    // Each row names its tool and its silence, which is what makes it findable.
    expect(rows[0].textContent).toMatch(/Codex|Claude|DeepSeek Harness/u);
  });

  it('opens a process detail page when a session is chosen from the sidebar', async () => {
    const fake = api();
    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    const row = within(list).getAllByRole('button')[0];
    fireEvent.click(row);

    // The main area switches to that process, and the row stays marked as selected.
    expect(await screen.findByRole('heading', { name: '进程详情' })).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(list).getAllByRole('button').filter((item) => item.getAttribute('aria-current') === 'true')).toHaveLength(1);
    // And it can be left again.
    fireEvent.click(screen.getByRole('button', { name: /返回列表/u }));
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
  });

  it('filters the sidebar process list without touching the page', async () => {
    const fake = api();
    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    expect(within(list).getAllByRole('button')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('搜索进程'), { target: { value: 'zzz-no-match' } });
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    expect(within(list).getByText('没有匹配的进程')).toBeInTheDocument();
    // The page itself must not have changed.
    expect(screen.getByRole('heading', { name: '进程监控' })).toBeInTheDocument();
  });

  it('opens the bottom bar menu upwards and closes it on Escape', async () => {
    const fake = api();
    render(<App api={fake} />);
    await screen.findByText('0 个进程');

    const trigger = screen.getByRole('button', { name: /服务在线|服务未连接|离线预览/u });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu', { name: '账户与状态菜单' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: '账户与状态菜单' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // The entries the menu offers, using capabilities the app already has. The theme
    // entry names the scheme it switches *to*, so it is matched by shape rather than by
    // an exact string that depends on the environment's colour scheme.
    const labels = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^切换到(亮色|暗色)主题$/u);
    expect(labels[1]).toBe('设置Ctrl+,');
    expect(labels[2]).toBe('收起侧栏');

    /**
     * A `role="menu"` may only contain menu items, separators and groups.
     *
     * The service-status block used to sit inside the menu as a plain `<div>`, which is
     * invalid and can make a screen reader skip the menu entirely. It now lives in the
     * popup region that contains the menu, so the menu's own children are all valid —
     * checked here so it cannot drift back.
     */
    const childRoles = Array.from(menu.children).map((child) => child.getAttribute('role'));
    expect(childRoles).toEqual(['menuitem', 'menuitem', 'menuitem']);
    // The status must still be reachable, just outside the menu.
    expect(screen.getByText(/个可写入/u)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '账户与状态' })).toContainElement(menu);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '账户与状态菜单' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the bottom bar menu on a press outside it', async () => {
    const fake = api();
    render(<App api={fake} />);
    await screen.findByText('0 个进程');
    fireEvent.click(screen.getByRole('button', { name: /服务在线|服务未连接|离线预览/u }));
    expect(screen.getByRole('menu', { name: '账户与状态菜单' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: '账户与状态菜单' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '账户与状态' })).not.toBeInTheDocument();
  });

  it('collapses the sidebar from the bottom bar menu', async () => {
    render(<App api={api()} />);
    await screen.findByText('0 个进程');
    fireEvent.click(screen.getByRole('button', { name: /服务在线|服务未连接|离线预览/u }));
    fireEvent.click(screen.getByRole('menuitem', { name: '收起侧栏' }));
    expect(document.querySelector('.app-shell')).toHaveClass('app-shell--compact');
  });

  it('opens 文件 with 返回应用 and 隐藏到托盘 as menu items', async () => {
    const fake = api();
    render(<App api={fake} />);
    // Start somewhere other than the overview so 返回应用 has work to do.
    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();

    fireEvent.click(within(titlebar()).getByRole('button', { name: '文件' }));
    const menu = screen.getByRole('menu', { name: '文件' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.replace(/Ctrl.*$/u, ''))).toEqual(['返回应用', '隐藏到托盘']);
    // There is no quit item in the renderer's menus; the tray owns the exit.
    expect(within(menu).queryByRole('menuitem', { name: '退出' })).toBeNull();

    // 隐藏到托盘 needs the desktop bridge, so a plain browser disables it.
    expect(within(menu).getByRole('menuitem', { name: '隐藏到托盘' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: '隐藏到托盘' })).toHaveAttribute('aria-disabled', 'true');

    // 返回应用 returns to the overview heading and closes the drawer.
    fireEvent.click(within(menu).getByRole('menuitem', { name: '返回应用' }));
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
    expect(document.querySelector('.sidebar')).not.toHaveClass('is-open');
  });

  it('shows the standard editing roles and the help links', async () => {
    render(<App api={api()} />);
    const bar = titlebar();

    fireEvent.click(within(bar).getByRole('button', { name: '编辑' }));
    expect(
      within(screen.getByRole('menu', { name: '编辑' }))
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.replace(/Ctrl.*$/u, '')),
    ).toEqual(['撤销', '重做', '剪切', '复制', '粘贴', '全选']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(within(bar).getByRole('button', { name: '帮助' }));
    const help = screen.getByRole('menu', { name: '帮助' });
    expect(within(help).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '项目主页',
      '关于 Selbstlauf',
    ]);
  });

  it('disables the bridge-backed view items in a plain browser', async () => {
    render(<App api={api()} />);
    fireEvent.click(within(titlebar()).getByRole('button', { name: '视图' }));
    const menu = screen.getByRole('menu', { name: '视图' });
    for (const label of ['重新加载', '实际大小', '放大', '缩小', '切换全屏']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(label) });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('aria-disabled', 'true');
    }
    // Clicking a disabled item must not throw even though there is no bridge.
    expect(() => fireEvent.click(within(menu).getByRole('menuitem', { name: /重新加载/u }))).not.toThrow();
  });

  it('exercises the desktop bridge when one is installed', async () => {
    const shell = {
      reload: vi.fn(), toggleFullScreen: vi.fn(), zoom: vi.fn(), quit: vi.fn(),
      openExternal: vi.fn(async () => undefined),
    };
    let deliver: ((payload: { command?: string; section?: string }) => void) | undefined;
    Object.assign(window, {
      selbstlaufDesktop: {
        shell,
        onCommand: (listener: (payload: { command?: string; section?: string }) => void) => {
          deliver = listener;
          return () => undefined;
        },
      },
    });
    const view = render(<App api={api()} />);
    try {
      // The desktop shell is marked on the document, which is what scopes the
      // reserved gutter for the native window buttons.
      await waitFor(() => expect(document.documentElement.dataset.shell).toBe('desktop'));
      expect(within(titlebar()).getByRole('button', { name: '收起侧栏' })).toBeInTheDocument();

      fireEvent.click(within(titlebar()).getByRole('button', { name: '视图' }));
      const menu = screen.getByRole('menu', { name: '视图' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: /放大/u }));
      await waitFor(() => expect(shell.zoom).toHaveBeenCalledWith(1));
      fireEvent.click(within(titlebar()).getByRole('button', { name: '视图' }));
      fireEvent.click(within(screen.getByRole('menu', { name: '视图' })).getByRole('menuitem', { name: /缩小/u }));
      await waitFor(() => expect(shell.zoom).toHaveBeenCalledWith(-1));
      fireEvent.click(within(titlebar()).getByRole('button', { name: '视图' }));
      fireEvent.click(within(screen.getByRole('menu', { name: '视图' })).getByRole('menuitem', { name: /重新加载/u }));
      await waitFor(() => expect(shell.reload).toHaveBeenCalled());
      fireEvent.click(within(titlebar()).getByRole('button', { name: '视图' }));
      fireEvent.click(within(screen.getByRole('menu', { name: '视图' })).getByRole('menuitem', { name: /切换全屏/u }));
      await waitFor(() => expect(shell.toggleFullScreen).toHaveBeenCalled());

      // 帮助 -> 项目主页 goes out through the shell rather than navigating away.
      fireEvent.click(within(titlebar()).getByRole('button', { name: '帮助' }));
      fireEvent.click(within(screen.getByRole('menu', { name: '帮助' })).getByRole('menuitem', { name: '项目主页' }));
      await waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/dieWehmut/Selbstlauf'));

      // The native menu bar and the tray drive the page through the same channel.
      act(() => deliver?.({ command: 'open-settings' }));
      expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
      act(() => deliver?.({ command: 'back-to-app' }));
      expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();

      /**
       * The tray's 关于 Selbstlauf sends `open-settings` **with** the account
       * section, so the named section must actually be selected. Verified live
       * against the installed app before this assertion was added: the tray item
       * landed on 账户 and showed 关于 and 本地环境检查.
       */
      act(() => deliver?.({ command: 'open-settings', section: 'account' }));
      const rail = await screen.findByRole('tablist', { name: '设置分区' });
      expect(within(rail).getByRole('tab', { name: '账户' })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByRole('heading', { name: '关于' })).toBeInTheDocument();

      // An unknown section opens the settings page rather than doing nothing.
      act(() => deliver?.({ command: 'open-settings', section: 'no-such-section' }));
      expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
    } finally {
      view.unmount();
      delete (window as { selbstlaufDesktop?: unknown }).selbstlaufDesktop;
      delete document.documentElement.dataset.shell;
    }
  });

  it('keeps only one menu open at a time and closes on Escape or an outside click', () => {
    render(<App api={api()} />);
    const bar = titlebar();
    fireEvent.click(within(bar).getByRole('button', { name: '文件' }));
    expect(screen.getByRole('menu', { name: '文件' })).toBeInTheDocument();

    // Opening another menu closes the first.
    fireEvent.click(within(bar).getByRole('button', { name: '帮助' }));
    expect(screen.queryByRole('menu', { name: '文件' })).toBeNull();
    expect(screen.getByRole('menu', { name: '帮助' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(within(bar).getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('menu', { name: '编辑' })).toBeInTheDocument();
    // A press outside the dropdown dismisses it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('walks in-app history with the back and forward arrows', async () => {
    render(<App api={api()} />);
    const back = () => within(titlebar()).getByRole('button', { name: '后退' });
    const forward = () => within(titlebar()).getByRole('button', { name: '前进' });

    // Nothing has been visited yet, so both arrows start unavailable.
    expect(back()).toBeDisabled();
    expect(back()).toHaveAttribute('aria-disabled', 'true');
    expect(forward()).toBeDisabled();

    fireEvent.click((await screen.findAllByRole('button', { name: '设置' }))[0]);
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
    expect(back()).toBeEnabled();
    expect(back()).toHaveAttribute('aria-disabled', 'false');
    expect(forward()).toBeDisabled();

    // 后退 returns to the previous page and enables 前进.
    fireEvent.click(back());
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
    expect(back()).toBeDisabled();
    expect(forward()).toBeEnabled();

    // 前进 re-advances, then the forward stack is empty again.
    fireEvent.click(forward());
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
    expect(forward()).toBeDisabled();
    expect(back()).toBeEnabled();
  });

  it('clears the forward stack when a new page is visited after going back', async () => {
    render(<App api={api()} />);
    const back = () => within(titlebar()).getByRole('button', { name: '后退' });
    const forward = () => within(titlebar()).getByRole('button', { name: '前进' });

    fireEvent.click((await screen.findAllByRole('button', { name: '事件' }))[0]);
    expect(await screen.findByRole('heading', { name: '事件记录' })).toBeInTheDocument();
    fireEvent.click(back());
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
    expect(forward()).toBeEnabled();

    // A fresh navigation forks the history, exactly like a browser.
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]);
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
    expect(forward()).toBeDisabled();
  });
});
