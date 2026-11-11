import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { AuditEvent, HealthView, SessionView, WatchdogApi, WatchdogEvent } from '../src/api/client';
import { MONITORED_TOOL_NAMES } from '../src/api/client';
import { toolLabel } from '../src/sidebar/session-groups';
import type { EnvironmentView } from '../src/api/client';
import { applyLocale, translate, type Locale } from '../src/i18n';

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
    pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), inject: vi.fn(async () => ({ dryRun: false })),
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
    openSettings();

    // The settings page opens on the general section and can switch sections.
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    // The watchdog settings are the working view and open first.
    expect(within(tabs).getByRole('tab', { name: '常规' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));
    expect(within(tabs).getByRole('tab', { name: '关于' })).toHaveAttribute('aria-selected', 'true');
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
      expect(within(languages).getByRole('button', { name: new RegExp(language) })).toBeEnabled();
    }
  });

  /**
   * The rail is the map of the console: two labelled categories, the reference's
   * section order, and a search field that really filters it.
   */
  it('lists every settings section under its category and filters them by search', async () => {
    render(<App api={api()} />);
    openSettings();

    const rail = await screen.findByRole('tablist', { name: '设置分区' });
    const expected = [
      '常规', '外观', '通知', '键盘快捷键', '个人资料', '宠物',
      '启动与托盘', '续写与进程', '导入', '电脑操控', '手机远控', '插件', '浏览器', '关于',
    ];
    const labels = within(rail).getAllByRole('tab').map((tab) => tab.textContent);
    expect(labels).toEqual(expected);

    /**
     * The rail must name only sections whose controls change something observable.
     *
     * Four entries used to sit here that changed nothing a person could see: 家长控制 gated a
     * single switch with a local-only PIN that was never a security boundary, 信任联系人 stored
     * a name and an email that were never sent anywhere, 语音 switched a feature with no
     * implementation, and 使用统计 counted the things already on screen. They are pinned as
     * absent so a placeholder cannot quietly return.
     */
    for (const placeholder of ['家长控制', '信任联系人', '语音', '使用统计', '个性化', '应用快照']) {
      expect(labels, `${placeholder} is a section that changes nothing`).not.toContain(placeholder);
    }
    expect(labels).not.toContain('Trusted contact');
    expect(labels.some((label) => label?.includes('计费')), 'the rail promises billing again').toBe(false);

    // The two category headings are present, in order.
    expect(screen.getByText('个人')).toBeInTheDocument();
    expect(screen.getByText('集成')).toBeInTheDocument();

    // Search narrows the rail to matching entries only. The query matches one section's
    // label and nothing else, so a single row must survive.
    const search = screen.getByRole('searchbox', { name: '搜索设置' });
    fireEvent.change(search, { target: { value: '托盘' } });
    const filtered = within(rail).getAllByRole('tab').map((tab) => tab.textContent);
    expect(filtered).toEqual(['启动与托盘']);

    // A query matching nothing says so instead of showing an empty rail.
    fireEvent.change(search, { target: { value: 'zzz-no-such-section' } });
    expect(within(rail).queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('无匹配设置')).toBeInTheDocument();

    // Clearing restores the full list.
    fireEvent.change(search, { target: { value: '' } });
    expect(within(rail).getAllByRole('tab')).toHaveLength(expected.length);
  });

  it('opens mobile remote management and enables the current desktop service', async () => {
    const fake = api();
    fake.remote = vi.fn(async () => ({ enabled: false as const, host: '127.0.0.1', port: 48921, name: 'Desktop' }));
    fake.enableRemote = vi.fn(async (settings) => ({ ...settings, enabled: true as const, url: 'http://127.0.0.1:48921', pairing: { code: '123456', expiresAtMs: Date.now() + 600_000 }, devices: [] }));
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '手机远控' }));
    await screen.findByText(/手机远控尚未启用/);
    fireEvent.click(screen.getByRole('button', { name: '启用手机远控' }));
    expect(await screen.findByText('123456')).toBeInTheDocument();
    expect(fake.enableRemote).toHaveBeenCalledWith({ host: '127.0.0.1', port: 48921, name: 'Desktop' });
  });

  it.each<Locale>(['zh-CN', 'zh-TW', 'en', 'ja'])('renders navigation and settings in %s while preserving edited user data and messages', async (locale) => {
    const t = (source: string) => translate(source, {}, locale);
    act(() => applyLocale(locale));
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({ path: 'C:/user/用户路径/config.toml', exists: true, active: { model: 'my-model', experimental_bearer_token: 'raw-token' }, alternatives: {}, current: null }));
    render(<App api={fake} />);
    try {
      expect(await screen.findByRole('heading', { level: 1, name: t('进程监控') })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      fireEvent.click(await screen.findByRole('tab', { name: t('外观') }));
      const languages = screen.getByRole('group', { name: t('界面语言') });
      expect(within(languages).getAllByRole('button')).toHaveLength(4);
      expect(within(languages).getByRole('button', { name: locale === 'zh-CN' ? '简体中文' : locale === 'zh-TW' ? '繁體中文' : locale === 'en' ? 'English' : '日本語' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('tab', { name: t('常规') }));
      const prompt = screen.getByDisplayValue('请继续');
      fireEvent.change(prompt, { target: { value: '用户自己的提示 user prompt 日本語' } });
      fireEvent.click(screen.getByRole('button', { name: t('保存配置') }));
      expect(await screen.findByText(t('配置已保存'))).toBeInTheDocument();
      act(() => applyLocale(locale === 'en' ? 'ja' : 'en'));
      const nextLocale: Locale = locale === 'en' ? 'ja' : 'en';
      expect(screen.getByText(translate('配置已保存', {}, nextLocale))).toBeInTheDocument();
      expect(screen.getByDisplayValue('用户自己的提示 user prompt 日本語')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: translate('续写与进程', {}, nextLocale) }));
      expect(await screen.findByRole('textbox', { name: translate('访问令牌', {}, nextLocale) })).toHaveValue('raw-token');
      expect(screen.getByText(/C:\/user\/用户路径\/config.toml/u)).toBeInTheDocument();
      expect(document.documentElement.lang).toBe(nextLocale);
    } finally { act(() => applyLocale('zh-CN')); }
  });

  it('retranslates dynamic tool counts and endpoint errors while keeping diagnostic details unchanged', async () => {
    act(() => applyLocale('en'));
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({ path: 'C:/demo/config.toml', exists: true, active: { experimental_bearer_token: 'saved-token' }, alternatives: {}, current: null }));
    vi.mocked(fake.applyCodexProfile).mockRejectedValueOnce(new Error('disk-full: D:/用户目录'));
    render(<App api={fake} />);
    try {
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      fireEvent.click(await screen.findByRole('tab', { name: translate('关于') }));
      fireEvent.click(await screen.findByRole('button', { name: 'Update all' }));
      expect(await screen.findByText('2 tools updated')).toBeInTheDocument();
      act(() => applyLocale('zh-TW'));
      expect(screen.getByText('2 個工具已升級')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: translate('续写与进程') }));
      const token = await screen.findByRole('textbox', { name: translate('访问令牌') });
      fireEvent.change(token, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: translate('应用端点配置') }));
      expect(await screen.findByRole('alert')).toHaveTextContent('端點儲存失敗：disk-full: D:/用户目录');
      act(() => applyLocale('ja'));
      expect(screen.getByRole('alert')).toHaveTextContent('エンドポイントを保存できませんでした：disk-full: D:/用户目录');
      expect(token).toHaveValue('');
    } finally { act(() => applyLocale('zh-CN')); }
  });

  /** 返回应用 leaves the settings page again. */
  it('returns to the overview from the settings rail', async () => {
    render(<App api={api()} />);
    openSettings();
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

    // The alternative settings shortcut must match the documented binding.
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

    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '电脑操控' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '允许打开运行位置' }));

    // On 设置 the left rail is the settings rail, so the app's own sidebar — and with it
    // the 进程 nav button — is not rendered. 返回应用 is the way back.
    fireEvent.click(await screen.findByRole('button', { name: /返回应用/u }));
    expect(await within(screen.getByRole('table')).findByRole('button', { name: /打开运行位置 PID 10/u })).toBeDisabled();

    // The switch persists, so restore it for the tests that follow this one.
    localStorage.removeItem('watchdog-computer-control');
  });

  it('previews each theme and applies a custom palette to the document', async () => {
    // The tab test above leaves 'system' stored; this test starts from dark.
    localStorage.setItem('watchdog-theme', 'dark');
    localStorage.removeItem('watchdog-palette');
    render(<App api={api()} />);
    openSettings();
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

    // The stock dark scheme paints a pure-black page, and the surfaces are lifted
    // from it. `--panel-soft` is the value the desktop shell's static
    // TITLE_BAR_OVERLAY.color mirrors (apps/desktop/src/navigation.ts), so this pair
    // is what keeps the window buttons on the same strip as the painted title bar.
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#000000');
    expect(document.documentElement.style.getPropertyValue('--panel-soft')).toBe('#0d0d0d');

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
    openSettings();
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

  it('reports a rejected configuration import and changes app configuration only after a successful retry', async () => {
    const fake = api();
    const imported = { ...await fake.config(), dryRun: false };
    vi.mocked(fake.updateConfig).mockRejectedValueOnce(new Error('配置未写入磁盘'));
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '导入' }));
    fireEvent.change(screen.getByLabelText('JSON 文本'), { target: { value: JSON.stringify(imported) } });
    fireEvent.click(screen.getByRole('button', { name: '导入文本' }));
    expect(await screen.findByText('导入失败：配置未写入磁盘')).toBeInTheDocument();
    expect(screen.queryByText('已导入配置')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '常规' }));
    expect(screen.getByRole('checkbox', { name: 'Dry run' })).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: '导入' }));
    fireEvent.change(screen.getByLabelText('JSON 文本'), { target: { value: JSON.stringify(imported) } });
    fireEvent.click(screen.getByRole('button', { name: '导入文本' }));
    expect(await screen.findByText('已导入配置')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '常规' }));
    expect(screen.getByRole('checkbox', { name: 'Dry run' })).not.toBeChecked();
  });

  it('reports the local environment and offers the install commands', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();

    // The environment check lives on the About tab, beside the version card.
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));

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
    // The confirmation appears only after the write resolves, which is what the code promises.
    expect(await screen.findByText('已复制')).toBeInTheDocument();

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

  it('says so when the install commands cannot be copied', async () => {
    /**
     * The clipboard is not always available — an insecure context, or a denied permission — and this
     * button used to fall back to "not copied" with no message at all, which is indistinguishable from
     * a click that never registered. The import section reports 导入失败 with the reason, and the
     * appearance panel shows 复制失败; this one now does too.
     */
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));
    fireEvent.click(await screen.findByRole('button', { name: /手动安装命令/ }));
    const copy = screen.getByRole('button', { name: '复制安装命令' });

    // A refused write reports the failure, with the reason, rather than staying silent.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('permission denied'); }) },
    });
    fireEvent.click(copy);
    expect(await screen.findByText('复制失败')).toBeInTheDocument();
    expect(copy.getAttribute('title'), 'the reason for the failure is not offered').toContain('permission denied');

    // And so does a context with no clipboard API at all, which this app really meets: the service is
    // reached over plain HTTP, so a browser that is not on the loopback address has no `navigator.clipboard`.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    fireEvent.click(copy);
    await waitFor(() => expect(copy.getAttribute('title')).toContain('剪贴板'));
  });

  /**
   * The 通知 switches have to change something.
   *
   * All three persisted a value and nothing consulted it: 面板内通知, 续写成功时提示 and 出现错误时提示
   * were written, validated on read, and never used, so a user could switch notices off and keep being
   * shown every one. The whole area had no test, which is how that survived — the rail's own docstring
   * records sections removed for exactly this ("they changed nothing a person could observe").
   */
  const notificationsPref = (patch: Partial<{ inPanel: boolean; onSuccess: boolean; onError: boolean }>) => {
    localStorage.setItem('watchdog-notifications', JSON.stringify({
      inPanel: true, onSuccess: true, onError: true, timelineLimit: 100, ...patch,
    }));
  };

  /**
   * These tests write preference keys, and they outlive a test: a switch left off silenced a later
   * test's notice (the Codex endpoint switch asserts 端点已切换), which is how this was noticed at all.
   */
  afterEach(() => {
    for (const key of ['watchdog-notifications', 'watchdog-personalization', 'watchdog-plugins', 'watchdog-pet']) {
      localStorage.removeItem(key);
    }
  });

  /** Refresh the environment from the 关于 section, which reports success or the error it throws. */
  const refreshFromAbout = async () => {
    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));
    fireEvent.click(await screen.findByRole('button', { name: '刷新本地环境' }));
  };

  it('reports a failed environment refresh, and lets the error switch silence it', async () => {
    const failing = () => {
      const fake = api();
      fake.refreshEnvironment = vi.fn(async () => { throw new Error('探测失败'); });
      return fake;
    };

    // With the defaults, the failure is reported.
    const reported = failing();
    const first = render(<App api={reported} />);
    await refreshFromAbout();
    expect(await screen.findByText('探测失败')).toBeInTheDocument();
    first.unmount();

    // With 出现错误时提示 off, the same failure says nothing.
    notificationsPref({ onError: false });
    const silenced = failing();
    render(<App api={silenced} />);
    await refreshFromAbout();
    await waitFor(() => expect(silenced.refreshEnvironment).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('探测失败')).toBeNull());
  });

  it('silences confirmations when the success switch is off', async () => {
    notificationsPref({ onSuccess: false });
    const confirming = api();
    render(<App api={confirming} />);
    await refreshFromAbout();
    await waitFor(() => expect(confirming.refreshEnvironment).toHaveBeenCalled());
    expect(screen.queryByText('本地环境已刷新')).toBeNull();
  });

  /**
   * The upgrade notice names the tool the way its own card does.
   *
   * The card is titled with the tool's label and its button reads 升级 Claude Code, while the notice said
   * "claude 升级完成" — the package id, printed a few centimetres below the name the app had just shown.
   */
  it('reports an upgrade by the tool name its card shows', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));

    fireEvent.click(await screen.findByRole('button', { name: '升级 Claude Code' }));
    await waitFor(() => expect(fake.upgradeTool).toHaveBeenCalledWith('claude'));
    expect((await screen.findByText(/升级完成/u)).textContent, 'the notice names the package id').toBe('Claude Code 升级完成');
  });

  /**
   * The rail entry for the import section names what the section does.
   *
   * It read 导入历史 — an import *history* — while the section reads a theme or a config out of the clipboard and
   * applies it, and the app keeps no history of imports anywhere. The label arrived with the rail rebuild, so it
   * was never a feature that had been removed; it was a promise that had never been kept.
   */
  it('labels the import section for what it does', async () => {
    render(<App api={api()} />);
    openSettings();
    const rail = await screen.findByRole('tablist', { name: '设置分区' });
    const tab = within(rail).getByRole('tab', { name: /导入/u });

    fireEvent.click(tab);
    // The section's own heading is 导入, and its hint says where its input comes from.
    expect(await screen.findByRole('heading', { name: '导入' })).toBeInTheDocument();
    expect(tab.textContent, 'the rail promises an import history the app does not keep').toBe('导入');
  });

  it('still reports errors when only the success switch is off', async () => {
    // The two switches are separate: silencing confirmations must not silence failures.
    notificationsPref({ onSuccess: false });
    const failing = api();
    failing.refreshEnvironment = vi.fn(async () => { throw new Error('探测失败'); });
    render(<App api={failing} />);
    await refreshFromAbout();
    expect(await screen.findByText('探测失败')).toBeInTheDocument();
  });

  /**
   * 保留最近事件条数 is offered up to 1000, and the events page counts what it shows — but the arrival path kept
   * the newest 100 whatever the setting said, so asking for 300 showed "100 条" and the rest had already been
   * dropped. Two surfaces disagreed about one number, and the setting lost.
   */
  it('keeps as many events as the retention setting asks for, past the old hundred', async () => {
    localStorage.setItem('watchdog-notifications', JSON.stringify({ inPanel: true, onSuccess: true, onError: true, timelineLimit: 300 }));
    const fake = api();
    let emit: ((event: WatchdogEvent) => void) | null = null;
    fake.subscribe = vi.fn((listener: (event: WatchdogEvent) => void) => {
      emit = listener;
      return () => undefined;
    });
    render(<App api={fake} />);
    await waitFor(() => expect(emit).not.toBeNull());

    act(() => {
      for (let index = 0; index < 150; index += 1) {
        emit!({
          kind: 'audit',
          event: {
            id: `kept-${index}`,
            timestampMs: Date.now(),
            type: 'activity',
            sessionId: 'codex:336756',
            tool: 'codex',
            details: { source: 'codex-rollout' },
          },
        });
      }
    });
    fireEvent.click(screen.getByRole('button', { name: '事件' }));

    expect(await screen.findByText('150 条'), 'events beyond the hundredth were dropped').toBeInTheDocument();
  });

  it('loads saved audit history and merges SSE arrivals during the read without duplicates', async () => {
    const fake = api() as WatchdogApi & { audit: (limit?: number) => Promise<AuditEvent[]> };
    const history = deferred<AuditEvent[]>();
    fake.audit = vi.fn(() => history.promise);
    let emit!: (event: WatchdogEvent) => void;
    fake.subscribe = vi.fn((listener) => { emit = listener; return () => undefined; });
    render(<App api={fake} />);
    await waitFor(() => expect(fake.audit).toHaveBeenCalledWith(1_000));
    const saved: AuditEvent = { id: 'saved-history', timestampMs: 100, type: 'activity', sessionId: 'saved-process' };
    const duringRead: AuditEvent = { id: 'stream-during-read', timestampMs: 300, type: 'activity', sessionId: 'latest-process' };
    act(() => { emit({ kind: 'audit', event: duringRead }); emit({ kind: 'audit', event: duringRead }); });
    await act(async () => history.resolve([saved, { id: 'middle', timestampMs: 200, type: 'activity', sessionId: 'middle-process' }, duringRead]));
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(await screen.findByText('3 条')).toBeInTheDocument();
    const entries = document.querySelectorAll('.timeline__item');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('latest-process');
    expect(entries[1]).toHaveTextContent('middle-process');
    expect(entries[2]).toHaveTextContent('saved-process');
  });

  it('a newer empty audit snapshot clears history and an older response cannot restore it', async () => {
    const fake = api() as WatchdogApi & { audit: (limit?: number) => Promise<AuditEvent[]> };
    const older = deferred<AuditEvent[]>();
    const newest = deferred<AuditEvent[]>();
    fake.audit = vi.fn().mockResolvedValueOnce([{ id: 'old-entry', timestampMs: 1, type: 'activity', sessionId: 'obsolete-history' }]).mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise);
    render(<App api={fake} />);
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(await screen.findByText('1 条')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(fake.audit).toHaveBeenCalledTimes(3));
    await act(async () => newest.resolve([]));
    expect(await screen.findByText('0 条')).toBeInTheDocument();
    await act(async () => older.resolve([{ id: 'old-entry', timestampMs: 1, type: 'activity', sessionId: 'obsolete-history' }]));
    expect(screen.getByText('0 条')).toBeInTheDocument();
    expect(screen.queryByText('obsolete-history')).not.toBeInTheDocument();
  });

  it('a failed history read keeps SSE events and monitoring usable, and a later read recovers', async () => {
    const fake = api();
    fake.audit = vi.fn().mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce([
      { id: 'recovered-history', timestampMs: 1, type: 'activity', sessionId: 'recovered-process' },
    ]);
    let emit!: (event: WatchdogEvent) => void;
    fake.subscribe = vi.fn((listener) => { emit = listener; return () => undefined; });
    render(<App api={fake} />);
    await screen.findByRole('heading', { name: '进程监控' });
    await waitFor(() => expect(fake.audit).toHaveBeenCalledOnce());
    act(() => emit({ kind: 'audit', event: { id: 'retained-stream', timestampMs: 2, type: 'activity', sessionId: 'live-process' } }));
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(await screen.findByText('1 条')).toBeInTheDocument();
    expect(screen.getByText('live-process')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('recovered-process')).toBeInTheDocument();
    expect(fake.health).toHaveBeenCalledTimes(2);
  });

  it('turns the whole notice strip off from 面板内通知, without a reload', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });

    fireEvent.click(within(tabs).getByRole('tab', { name: '通知' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '面板内通知' }));

    fireEvent.click(within(tabs).getByRole('tab', { name: '关于' }));
    fireEvent.click(await screen.findByRole('button', { name: '刷新本地环境' }));
    await waitFor(() => expect(fake.refreshEnvironment).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('本地环境已刷新')).toBeNull());
  });

  /**
   * 界面密度 has to reach the document, not just the preference.
   *
   * The value, its validator, its default and the compact rules in `sections.css` had all been written
   * — and nothing set `data-density`, so the rules could never match and there was no control at all.
   */
  afterEach(() => { localStorage.removeItem('watchdog-personalization'); });

  it('applies a saved density on startup', async () => {
    localStorage.setItem('watchdog-personalization', JSON.stringify({ density: 'compact' }));
    render(<App api={api()} />);

    await waitFor(() => expect(document.documentElement.dataset.density).toBe('compact'));
  });

  it('changes the density from the appearance section and keeps it', async () => {
    render(<App api={api()} />);
    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '外观' }));

    // The default is comfortable, and it is on the document rather than only in the storage.
    expect(await screen.findByLabelText('界面密度')).toHaveValue('comfortable');
    expect(document.documentElement.dataset.density).toBe('comfortable');

    fireEvent.change(screen.getByLabelText('界面密度'), { target: { value: 'compact' } });
    await waitFor(() => expect(document.documentElement.dataset.density).toBe('compact'));
    expect(JSON.parse(localStorage.getItem('watchdog-personalization') ?? '{}')).toEqual({ density: 'compact' });
  });

describe('watchdog dashboard', () => {

  /**
   * The poll-age chip in the topbar.
   *
   * Before the first successful poll it rendered "轮询 -- 前" — a sentence with a hole in it, where the value
   * was simply absent — and it carried `aria-label="Last watchdog poll"`, so the one thing a screen reader said
   * about it was the only English phrase in the shell.
   */
  it('says it has not polled yet instead of leaving a hole in the sentence', async () => {
    const fake = api();
    const pendingHealth = deferred<HealthView>();
    fake.health = vi.fn(() => pendingHealth.promise);
    render(<App api={fake} />);

    // The chip is icon + text, so read the element rather than matching its mixed content by text.
    const chip = await waitFor(() => {
      const found = document.querySelector('.poll-age');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(chip.textContent?.trim()).toBe('尚未轮询');
    expect(screen.queryByText(/轮询 -- 前/u), 'the empty value reads as a sentence').toBeNull();
    expect(screen.queryByLabelText('Last watchdog poll'), 'the accessible name is English').toBeNull();
  });

  it('names the poll age in the words it shows', async () => {
    const fake = api();
    render(<App api={fake} />);

    // The default fixture polls two seconds ago, so the chip reads as a duration — and its accessible name is
    // that same text, not a separate English label. (`duration` writes its units tersely: 2s, 3m 24s.)
    await waitFor(() => expect(document.querySelector('.poll-age')?.textContent ?? '').toMatch(/轮询 \d+s 前/u));
    expect(document.querySelector('.poll-age')?.getAttribute('aria-label')).toBeNull();
  });

  /**
   * The timeline said the engine's words, not the user's.
   *
   * Each event line was `Object.values(details).join(' · ')`: values only, no keys, nothing translated — so a
   * decision event printed "awaiting-quiet-period" and a decision's own timestamp printed as an epoch number,
   * under a chip that did translate the event's type.
   */
  it('describes an audit payload in words rather than the engine\'s own', async () => {
    const fake = api();
    let emit: ((event: WatchdogEvent) => void) | null = null;
    fake.subscribe = vi.fn((listener: (event: WatchdogEvent) => void) => {
      emit = listener;
      return () => undefined;
    });
    render(<App api={fake} />);
    await waitFor(() => expect(emit).not.toBeNull());

    act(() => {
      emit!({
        kind: 'audit',
        event: {
          id: 'audit-1',
          timestampMs: Date.now(),
          type: 'decision',
          sessionId: 'codex:336756',
          tool: 'codex',
          details: { decision: 'awaiting-quiet-period', atMs: 1_789_000_000_000 },
        },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '事件' }));

    const line = await screen.findByText(/等待静默/u);
    expect(line.textContent, 'the decision is not named').toContain('决策：等待静默');
    expect(line.textContent, 'the timestamp is not written as a time').toMatch(/时间：\d{2}:\d{2}:\d{2}/u);
    expect(screen.queryByText(/awaiting-quiet-period/u), 'the engine identifier is shown to the user').toBeNull();
  });

  /**
   * Every surface has to agree about a session whose quiet time is unknown.
   *
   * The service sends `quietForMs: null` when it has no last-activity time at all. The table said nothing; the
   * mobile card and the detail page printed "0s", and the sidebar row did too — a claim that the session had
   * been active this very second, which is the opposite of "unknown".
   */
  it('agrees with itself about a session whose quiet time is unknown', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    fake.sessions = vi.fn(async () => [{ ...template!, id: 'unknown-quiet', quietForMs: null, lastActivityAtMs: null }]);
    render(<App api={fake} />);

    const table = await waitFor(() => {
      const cell = document.querySelector('.process-table tbody tr td:nth-child(5) strong');
      expect(cell).not.toBeNull();
      return cell as HTMLElement;
    });
    expect(table.textContent, 'the table claims a duration for an unknown silence').toBe('—');
    expect(document.querySelector('.sidebar-row__meta')?.textContent, 'the sidebar row claims 0s').toBe('—');

    // The card and the detail page label the value with a <dt>, so one query covers both.
    const labelled = () => [...document.querySelectorAll('dt')]
      .filter((term) => term.textContent === '静默')
      .map((term) => term.nextElementSibling?.textContent ?? '');
    let values = labelled();
    expect(values.length, 'the card is missing its 静默 row').toBeGreaterThanOrEqual(1);
    expect(new Set(values), 'the card disagrees with the table').toEqual(new Set(['—']));

    // And the detail page, reached the way a person reaches it. It replaces the overview, so this is the
    // detail page's own row.
    const list = screen.getByRole('group', { name: '进程列表' });
    fireEvent.click(within(list).getByTitle(/PID/u));
    expect(await screen.findByRole('heading', { name: '进程详情' })).toBeInTheDocument();
    values = labelled();
    expect(values, 'the detail page is missing its 静默 row').toEqual(['—']);
  });

  /**
   * One duration, written one way.
   *
   * The table's 静默 column and the sidebar row beside it format the same value with two different functions:
   * the table wrote `2m 5s` where the sidebar wrote `2m 05s`, and the unknown glyph differed too (`--` against
   * `—`). Both are correct durations; showing them together in two shapes is the defect.
   */
  it('writes a silence the same way in the sidebar and the table', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    // 2m 05s: the padding is what the two formatters disagreed about.
    fake.sessions = vi.fn(async () => [{ ...template!, id: 'padded-quiet', quietForMs: 125_000 }]);
    render(<App api={fake} />);

    const table = await waitFor(() => {
      const cell = document.querySelector('.process-table tbody tr td:nth-child(5) strong');
      expect(cell).not.toBeNull();
      return cell as HTMLElement;
    });
    const sidebar = document.querySelector('.sidebar-row__meta');
    expect(sidebar?.textContent).toBe('2m 05s');
    expect(table.textContent, 'the table writes the same duration differently').toBe(sidebar?.textContent);
  });

  /**
   * A tool the table does not know must not be called Claude.
   *
   * There were two `toolLabel`s: the sidebar's, which names every tool it knows and otherwise prints the raw
   * name, and App's own, which ended `return 'Claude'`. The web client casts the sessions response without
   * validating it, so a newer service can send a tool this build has never heard of — and the table then said
   * "Claude" for it while the sidebar row beside it said the truth.
   */
  it('names an unknown tool honestly in the table as well as the sidebar', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    // A future service may name a tool this client has never seen.
    fake.sessions = vi.fn(async () => [{ ...template!, id: 'unknown-tool', tool: 'future-agent' as SessionView['tool'] }]);
    render(<App api={fake} />);

    const table = await waitFor(() => {
      const cell = document.querySelector('.process-table tbody tr td:nth-child(1) strong');
      expect(cell).not.toBeNull();
      return cell as HTMLElement;
    });
    const sidebar = document.querySelector('.sidebar-row__label');
    expect(document.querySelector('.sidebar-row__open')?.getAttribute('title')).toContain('future-agent');
    expect(table.textContent).toBe('future-agent');
  });

  /**
   * A session whose tool the config does not describe must not take the app down with it.
   *
   * `nextPrompt` reads `config.tools[session.tool].normalPrompt`. The web client casts the sessions response
   * without validating it, so a service reporting another tool with no pending prompt reaches that lookup with no
   * entry and throws *while the table renders*. There is no error boundary above it, so React unmounts the tree and
   * the whole console goes blank.
   */
  it('renders a session whose tool the config does not describe', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    fake.sessions = vi.fn(async () => [{
      ...template!,
      id: 'unknown-tool-no-prompt',
      tool: 'future-agent' as SessionView['tool'],
      pendingPrompt: null,
    }]);
    render(<App api={fake} />);

    // The row is there, named, with a stated absence where its next input would be.
    expect((await screen.findAllByText('future-agent')).length, 'the table did not survive the unknown tool').toBeGreaterThan(0);
    expect(document.querySelector('.process-table tbody tr td:nth-child(6)')?.textContent, 'the prompt cell says nothing at all').toBe('—');
  });

  /**
   * A transport this build does not know is refused, and named.
   *
   * The write rule named the transports it could *not* write to and treated everything else as writable, so an
   * unknown one made the row promise 可写入 and offer 立即续写 for a write the service would refuse — the
   * contradiction the rule exists to prevent. The badge's text came from a closed Record, so the same transport
   * rendered as an empty pill beside the dot.
   */
  it('refuses and names a transport it has never heard of', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    fake.sessions = vi.fn(async () => [{ ...template!, id: 'unknown-transport', transport: 'exec-pty' as SessionView['transport'] }]);
    render(<App api={fake} />);

    // Named, rather than an empty chip. Both the table and the mobile card show it.
    expect((await screen.findAllByText('exec-pty')).length, 'the badge is an empty chip').toBeGreaterThan(0);
    expect(document.querySelector('.capability')?.className, 'an unknown transport is offered as writable').toContain('capability--limited');
    // And the one-click write is not offered for it, in either rendering.
    const injects = await screen.findAllByRole('button', { name: /立即续写 PID/u });
    expect(injects.length).toBeGreaterThan(0);
    for (const button of injects) {
      expect(button, 'an unknown transport offers a write the service would refuse').toBeDisabled();
    }
  });

  it('keeps example sessions in the static demo', () => {
    vi.stubEnv('VITE_STATIC_DEMO', 'true');
    const view = render(<App />);
    try {
      expect(document.querySelector('.sidebar-processes__title')).toBeInTheDocument();
      expect(screen.getAllByText('PID 336756').length).toBeGreaterThan(0);
      /**
       * And it says it is a preview, on every surface that reports the connection.
       *
       * With the demo's own api supplied, `refresh()` succeeds and the app reported a live console (实时同步,
       * 服务在线, a green online light) for a page with no service behind it — which left these `staticDemo`
       * words as unreachable branches in the one build that needed them.
       */
      expect(screen.getAllByText('离线预览').length, 'the demo does not say it is a preview').toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('样例数据'), 'the same state is described two ways').toBeNull();
      expect(screen.queryByText('实时同步'), 'the demo claims a live connection').toBeNull();
      expect(document.querySelector('.status-light')).not.toHaveClass('is-online');
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

    expect(await screen.findByText('实时同步')).toBeInTheDocument();
    expect(screen.getAllByText('PID 10').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '暂停 PID 10' })[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '恢复 PID 10' })[0]).toBeEnabled());

    openSettings();
    fireEvent.click(screen.getByRole('tab', { name: '关于' }));
    expect(screen.queryByRole('heading', { name: '本地环境检查' })).not.toBeInTheDocument();
    await act(async () => pendingEnvironment.resolve(environment));
    expect(await screen.findByRole('heading', { name: '本地环境检查' })).toBeInTheDocument();
    expect(screen.getByText('2.1.274')).toBeInTheDocument();

    // Returning to monitoring preserves the connection state after the environment scan.
    fireEvent.click(await screen.findByRole('button', { name: /返回应用/u }));
    expect(await screen.findByText('实时同步')).toBeInTheDocument();
  });

  it('keeps monitoring online when the environment scan rejects', async () => {
    const fake = api();
    const pendingEnvironment = deferred<EnvironmentView>();
    fake.environment = vi.fn(() => pendingEnvironment.promise);
    render(<App api={fake} />);

    await act(async () => pendingEnvironment.reject(new Error('npm lookup failed')));
    expect(await screen.findByText('实时同步')).toBeInTheDocument();
    expect(screen.getAllByText('PID 10').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '紧急停止' })).toBeEnabled();
  });

  it('removes the account footer and provider summary', async () => {
    render(<App api={api()} />);
    await screen.findByRole('group', { name: '进程列表' });
    expect(document.querySelector('.account-bar, .account-popup, .sidebar-tools')).toBeNull();
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
    // The compact sidebar has no separate brand block.
    expect(screen.queryByText('Selbstlauf')).not.toBeInTheDocument();
  });

  /** Every process retains one root row with an accessible identity and both actions. */
  it('shows the root path on every sidebar process row', async () => {
    render(<App api={api()} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    // A row holds two controls — the body that opens the process and the pin — so the rows
    // are read by their wrapper rather than by counting buttons.
    const rows = list.querySelectorAll('.sidebar-row');
    expect(rows.length).toBeGreaterThan(1);

    for (const row of rows) {
      const path = row.querySelector('.sidebar-row__path');
      expect(path, `a row has no path: ${row.textContent}`).not.toBeNull();
      const text = path?.textContent ?? '';
      expect(text.length, 'the root path line is empty').toBeGreaterThan(0);
      expect(row.querySelector('.sidebar-row__open')?.getAttribute('title')).toContain('PID');
      // Every row still offers both actions.
      expect(row.querySelector('.sidebar-row__open'), 'row has no open control').not.toBeNull();
      expect(row.querySelector('.sidebar-row__pin'), 'row has no pin control').not.toBeNull();
    }

    // Known paths and unknown-root process identities both retain useful labels.
    const all = [...rows].map((row) => row.querySelector('.sidebar-row__path')?.textContent ?? '');
    expect(all.every((text) => text.length > 0)).toBe(true);
    expect(all.some((text) => text.includes('ai-cli-bypass'))).toBe(true);
  });

  it('lists only the sessions that are still running', async () => {
    /**
     * The service keeps a session after its process exits (`alive: false`) because its audit trail refers to
     * it. Those are history, not things to act on: including them filled the sidebar with rows for processes
     * that had been gone for hours — measured on a real machine, 25 rows for 5 live processes — and every
     * action on one could only fail. This pins the filter, which the all-alive fixtures above cannot.
     */
    const fake = api();
    const live = await fake.sessions();
    fake.sessions = vi.fn(async () => [
      ...live,
      { ...live[0]!, id: 'exited-1', rootPid: 900, alive: false },
      { ...live[0]!, id: 'exited-2', rootPid: 901, alive: false },
    ]);

    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    const rows = list.querySelectorAll('.sidebar-row');
    expect(rows).toHaveLength(live.length);
    // The metric counts what is listed, so the two cannot disagree.
    expect(within(screen.getByRole('region', { name: '运行概览' })).getByText('发现进程')).toBeInTheDocument();
    expect(screen.getAllByText(String(live.length)).length).toBeGreaterThan(0);

    // And the dead ones are absent from the table as well.
    expect(screen.queryByText('PID 900')).not.toBeInTheDocument();
    expect(screen.queryByText('PID 901')).not.toBeInTheDocument();
  });

  it('shows the age of the most recent watchdog poll', async () => {
    render(<App api={api()} />);
    // Read the chip's own text: it is its accessible name now, rather than an English aria-label laid over
    // Chinese text — which is also what this test used to query by.
    await waitFor(() => expect(document.querySelector('.poll-age')?.textContent ?? '').toMatch(/轮询 \d+s 前/u));
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
    openSettings();
    fireEvent.click(screen.getByRole('checkbox', { name: '允许续写 DeepSeek Harness' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({ dsh: expect.objectContaining({ allowApiInput: false }) }),
    })));
  });

  it('adds the new monitoring switches to a legacy config and persists their values', async () => {
    const fake = api();
    render(<App api={fake} />);
    await screen.findByRole('group', { name: '进程列表' });
    openSettings();
    for (const label of MONITORED_TOOL_NAMES.map(toolLabel)) {
      expect(await screen.findByRole('checkbox', { name: `监控 ${label}` })).toBeChecked();
    }
    expect(screen.getAllByText('控制该工具的监控；输入能力取决于会话')).toHaveLength(MONITORED_TOOL_NAMES.length);
    fireEvent.click(screen.getByRole('checkbox', { name: '监控 Cursor' }));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.objectContaining({
        ...Object.fromEntries(MONITORED_TOOL_NAMES.map(tool => [tool, { enabled: tool !== 'cursor', normalPrompt: '继续' }])),
        claude: expect.objectContaining({ normalPrompt: '请继续' }),
        gemini: { enabled: true, normalPrompt: '继续' },
        antigravity: { enabled: true, normalPrompt: '继续' },
        cursor: { enabled: false, normalPrompt: '继续' },
      }),
    })));
  });

  it('shows new monitoring association and disabled states and refuses input without a transport', async () => {
    const fake = api();
    const [template] = await fake.sessions();
    fake.sessions = vi.fn(async () => (['gemini', 'antigravity', 'cursor'] as const).map((tool, index) => ({
      ...template!, id: `${tool}:monitor`, tool, rootPid: 80 + index, goal: null, conversationId: null,
      pendingPrompt: null, transport: 'monitor-only' as const, runningTurn: undefined, quietForMs: 3_600_000,
      lastDecision: index === 2 ? 'disabled' : 'association-required', enabled: index !== 2,
      transportError: 'No uniquely associated live conversation was found',
    })));
    render(<App api={fake} />);
    await screen.findByRole('group', { name: '进程列表' });
    for (const [index, tool] of ['Gemini CLI', 'Antigravity', 'Cursor'].entries()) {
      expect(screen.getAllByText(tool).length).toBeGreaterThan(0);
      const row = document.querySelector(`[data-session-id="${['gemini', 'antigravity', 'cursor'][index]}:monitor"]`)!;
      expect(row).toHaveTextContent(index === 2 ? '监控已关闭' : '状态未知');
      for (const inject of screen.getAllByRole('button', { name: `立即续写 PID ${80 + index}` })) {
        expect(inject).toBeDisabled();
      }
    }
    expect(screen.queryByText('空闲')).not.toBeInTheDocument();
    expect(screen.getAllByText('未关联会话').length).toBeGreaterThan(0);
    expect(screen.getAllByText('监控已关闭').length).toBeGreaterThan(0);
    expect(screen.queryByText('自动续写已关闭')).not.toBeInTheDocument();
    expect(screen.getAllByText('尚未唯一关联到活动会话。').length).toBeGreaterThan(0);
    for (const cell of document.querySelectorAll('.process-table tbody tr td:nth-child(6)')) {
      expect(cell).toHaveTextContent('—');
    }
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

  /**
   * The 续写插件 prompts have to reach the write they are documented to reach.
   *
   * The section says "这些提示词会依次拼接，作为手动续写时使用的提示" and the preference was read by
   * nothing but the section: the one-click 立即续写 called `inject` with no prompt, so the list was a
   * notebook. The typed composer line still wins, because that path always supplies one.
   */
  it('sends the 续写插件 prompts joined, on a one-click continuation', async () => {
    localStorage.setItem('watchdog-plugins', JSON.stringify({ prompts: ['继续', '保持现有风格'] }));
    const fake = api();
    render(<App api={fake} />);

    fireEvent.click((await screen.findAllByRole('button', { name: '立即续写 PID 10' }))[0]);
    await waitFor(() => expect(fake.inject).toHaveBeenCalledWith('goal', '继续 保持现有风格'));
  });

  it('leaves the one-click continuation to the service when the plugin list is empty', async () => {
    // The contrast case, and the shape every existing caller expects: no prompt argument at all.
    const fake = api();
    render(<App api={fake} />);

    fireEvent.click((await screen.findAllByRole('button', { name: '立即续写 PID 10' }))[0]);
    await waitFor(() => expect(fake.inject).toHaveBeenCalledWith('goal'));
  });

  it('refuses a plugin prompt list the service could not carry', async () => {
    // The service accepts one line of at most 4096 characters, so a longer join is refused and said so
    // rather than truncated: silently dropping the end of a prompt is worse than not sending it.
    localStorage.setItem('watchdog-plugins', JSON.stringify({ prompts: ['x'.repeat(4096), 'y'] }));
    const fake = api();
    render(<App api={fake} />);

    fireEvent.click((await screen.findAllByRole('button', { name: '立即续写 PID 10' }))[0]);
    expect(await screen.findByText(/超过 4096 字符/u)).toBeInTheDocument();
    expect(fake.inject, 'an over-long prompt was sent anyway').not.toHaveBeenCalled();
  });

  /**
   * The desktop pet has to be on screen wherever the app is.
   *
   * It was rendered by the 宠物 settings section, so it existed only while that section was open: a
   * corner ornament nobody saw while using the app, and a pulse that could only fire if the session
   * count happened to change during the visit. Its own stylesheet is `position: fixed` at the window's
   * bottom-right, which says where it belongs — the shell, not the settings page.
   */
  it('shows the desktop pet on every page, not only where it is configured', async () => {
    localStorage.setItem('watchdog-pet', JSON.stringify({ enabled: true, form: 'ring' }));
    const fake = api();
    render(<App api={fake} />);

    expect(document.querySelector('.workspace-pet--ring'), 'the pet is missing from the overview').not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(document.querySelector('.workspace-pet--ring'), 'the pet vanished on another page').not.toBeNull();
  });

  it('shows the pet as soon as its switch is turned on', async () => {
    const fake = api();
    render(<App api={fake} />);
    expect(document.querySelector('.workspace-pet')).toBeNull();

    openSettings();
    const tabs = await screen.findByRole('tablist', { name: '设置分区' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '宠物' }));
    fireEvent.click(screen.getByLabelText('桌面宠物'));
    await waitFor(() => expect(document.querySelector('.workspace-pet')).not.toBeNull());

    // And leaving the section — the case that used to remove it — does not take it away.
    fireEvent.click(within(tabs).getByRole('tab', { name: '常规' }));
    expect(document.querySelector('.workspace-pet'), 'the pet only appears on its own settings page').not.toBeNull();
  });

  it('bounces the pet when the number of sessions changes', async () => {
    localStorage.setItem('watchdog-pet', JSON.stringify({ enabled: true, form: 'dot' }));
    const fake = api();
    let sessions = await fake.sessions();
    fake.sessions = vi.fn(async () => sessions);
    render(<App api={fake} />);
    await waitFor(() => expect(document.querySelector('.workspace-pet')).not.toBeNull());
    expect(document.querySelector('.workspace-pet.is-pulsing'), 'the pet was already bouncing').toBeNull();

    sessions = sessions.slice(1);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(document.querySelector('.workspace-pet.is-pulsing')).not.toBeNull());
  });

  it('persists editable prompt settings through the API', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    const claude = await screen.findByDisplayValue('请继续');
    fireEvent.change(claude, { target: { value: '继续工作' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.objectContaining({ claude: expect.objectContaining({ normalPrompt: '继续工作' }) }) })));
  });

  it('keeps the config numbers inside the range the service accepts', async () => {
    /**
     * The service rejects anything outside its own bounds — `requirePositiveNumber` and
     * `requirePositiveInteger` in `apps/cli/src/domain/config.ts` — so a field holding 0, a negative or a
     * fractional value can only fail when 保存 is pressed. The inputs declare `min` attributes that nothing
     * enforced, and two fields in the same panel already clamped their value, which is what made the rest
     * look like an oversight rather than a decision.
     */
    const fake = api();
    render(<App api={fake} />);
    openSettings();

    // A counted value: zero and fractions are refused by the service, and only whole numbers are taken.
    fireEvent.change(await screen.findByLabelText('每轮最大尝试'), { target: { value: '0' } });
    expect(screen.getByLabelText('每轮最大尝试')).toHaveValue(1);
    fireEvent.change(screen.getByLabelText('每轮最大尝试'), { target: { value: '1.5' } });
    expect(screen.getByLabelText('每轮最大尝试')).toHaveValue(1);

    // A millisecond interval with a declared floor of its own.
    fireEvent.change(screen.getByLabelText('轮询间隔（毫秒）'), { target: { value: '0' } });
    expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(250);

    // A seconds field, which the panel holds in milliseconds.
    fireEvent.change(screen.getByLabelText('静默阈值（秒）'), { target: { value: '-5' } });
    expect(screen.getByLabelText('静默阈值（秒）')).toHaveValue(1);
    fireEvent.change(screen.getByLabelText('冷却时间（秒）'), { target: { value: '0' } });
    expect(screen.getByLabelText('冷却时间（秒）')).toHaveValue(1);

    // And what is sent is what the service will accept.
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      pollIntervalMs: 250,
      defaultIdleTimeoutMs: 1_000,
      defaultCooldownMs: 1_000,
      maxAttemptsPerQuietPeriod: 1,
    })));
  });

  it('persists process ownership and include/exclude filters through the API', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(screen.getByRole('checkbox', { name: '仅监控当前用户进程' }));
    fireEvent.change(screen.getByLabelText('包含匹配'), { target: { value: 'Nexus, study-os' } });
    fireEvent.change(screen.getByLabelText('排除匹配'), { target: { value: 'node_modules' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      processFilters: { sameUserOnly: false, include: ['Nexus', 'study-os'], exclude: ['node_modules'] },
    })));
  });

  it('persists the WSL distribution, and defaults it to off', async () => {
    /**
     * WSL sessions live in a Linux pid namespace and are invisible to the Windows process table, so the
     * distribution has to be named explicitly. It is empty by default because looking inside one costs a
     * subprocess per poll, which nobody should pay for without choosing to.
     */
    const fake = api();
    render(<App api={fake} />);
    openSettings();

    const field = screen.getByLabelText('WSL 发行版名称');
    expect(field).toHaveValue('');

    fireEvent.change(field, { target: { value: 'Ubuntu-22.04' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ wslDistribution: 'Ubuntu-22.04' }),
    ));
  });

  /**
   * The master switch governs *automatic* continuation, not manual writing.
   *
   * This is a defect that shipped and was reported by the user: with the master switch off — which is how the app
   * was configured, to stop it continuing sessions on its own — every row said "会话无法写入", while the service
   * would in fact have accepted the write. Verified against the running service: a session reporting
   * `enabled=false` answered `200` to a manual inject.
   *
   * The fixture above has `enabled: true` everywhere, which is exactly why no test caught it.
   */
  it('allows a manual write when the master switch is off, because the service does', async () => {
    const fake = api();
    const sessions = await fake.sessions();
    // Every session reports enabled=false, as they do when automatic continuation is switched off.
    fake.sessions = vi.fn(async () => sessions.map((session) => ({ ...session, enabled: false })));

    render(<App api={fake} />);
    await screen.findByRole('group', { name: '进程列表' });
    fireEvent.click(screen.getAllByRole('button', { name: /立即续写 PID/u })[0]!);

    await waitFor(() => expect(fake.inject).toHaveBeenCalled());
    // And the row must not claim it is unwritable.
    expect(screen.queryByText(/该会话不可写入/u)).not.toBeInTheDocument();
  });

  it('still refuses a session the service can only watch, and says why', async () => {
    // A monitor-only session has nowhere to put the text, which is the real blocker.
    const fake = api();
    const sessions = await fake.sessions();
    const monitorOnly = sessions.find((session) => session.transport === 'monitor-only');
    expect(monitorOnly, 'the fixture needs a monitor-only session').toBeDefined();

    render(<App api={fake} />);
    await screen.findByRole('group', { name: '进程列表' });
    // Open the detail page for the monitor-only session.
    const row = document.querySelector(`.sidebar-row[data-session-id="${monitorOnly!.id}"] .sidebar-row__open`);
    expect(row, 'the monitor-only session should have a sidebar row').not.toBeNull();
    fireEvent.click(row!);

    // The composer explains the reason rather than offering a control that cannot work.
    expect(await screen.findByText(/只能监控，无法写入/u)).toBeInTheDocument();
  });

  it('renders and manages the explicit Claude Stop Hook settings', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    // The Claude Stop Hook lives on 配置, beside the endpoint panel; it used to be
    // mounted on 常规 while the rail's 配置 entry rendered nothing at all.
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));

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
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));

    expect(await screen.findByRole('heading', { name: '端点配置' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://first.example/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-6-astra')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'https://second.example/v1' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([
      { key: 'base_url', value: 'https://second.example/v1' },
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
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));

    const url = await screen.findByLabelText('接口地址');
    fireEvent.change(url, { target: { value: 'https://third.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '应用端点配置' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([
      { key: 'base_url', value: 'https://third.example/v1' },
    ]));
  });

  it('removes a cleared endpoint token and retains its empty draft across service refreshes', async () => {
    const fake = api();
    let token: string | undefined = 'saved-token';
    fake.codexProfiles = vi.fn(async () => ({
      path: 'C:/demo/config.toml', exists: true,
      active: { model: 'unchanged-model', ...(token === undefined ? {} : { experimental_bearer_token: token }) },
      alternatives: {}, current: { name: 'current', fields: [{ key: 'model', value: 'unchanged-model' }, ...(token === undefined ? [] : [{ key: 'experimental_bearer_token', value: token }])] },
    }));
    fake.applyCodexProfile = vi.fn(async () => { token = undefined; return { ok: true, changes: [{ key: 'experimental_bearer_token', value: null, action: 'removed' }] }; });
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    const input = await screen.findByRole('textbox', { name: '访问令牌' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(fake.codexProfiles).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '应用端点配置' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([{ key: 'experimental_bearer_token', value: null }]));
    await waitFor(() => expect(screen.getByRole('button', { name: '应用端点配置' })).toBeDisabled());
    expect(input).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('unchanged-model');
  });

  it('retains failed endpoint edits for retry and submits pending removals with a selected alternative', async () => {
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({
      path: 'C:/demo/config.toml', exists: true,
      active: { base_url: 'https://first.example/v1', experimental_bearer_token: 'saved-token' },
      alternatives: { base_url: ['https://second.example/v1'] },
      current: { name: 'first.example', fields: [{ key: 'base_url', value: 'https://first.example/v1' }, { key: 'experimental_bearer_token', value: 'saved-token' }] },
    }));
    vi.mocked(fake.applyCodexProfile).mockRejectedValueOnce(new Error('磁盘不可写'));
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '访问令牌' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '应用端点配置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('端点保存失败：磁盘不可写');
    expect(screen.getByRole('textbox', { name: '访问令牌' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'https://second.example/v1' }));
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenLastCalledWith([
      { key: 'experimental_bearer_token', value: null },
      { key: 'base_url', value: 'https://second.example/v1' },
    ]));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('does not submit absent fields left blank or values restored to their saved value', async () => {
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({ path: 'C:/demo/config.toml', exists: true, active: { model: 'saved-model' }, alternatives: {}, current: null }));
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    const save = await screen.findByRole('button', { name: '应用端点配置' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '评审模型' }), { target: { value: '  ' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '模型' }), { target: { value: 'changed-model' } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: '模型' }), { target: { value: 'saved-model' } });
    expect(save).toBeDisabled();
    expect(fake.applyCodexProfile).not.toHaveBeenCalled();
  });

  it('keeps endpoint controls busy until readback and preserves a deletion when readback fails', async () => {
    const fake = api();
    const original = { path: 'C:/demo/config.toml', exists: true, active: { experimental_bearer_token: 'saved-token' }, alternatives: {}, current: null };
    let resolveApply!: () => void;
    const applied = new Promise<void>((resolve) => { resolveApply = resolve; });
    fake.codexProfiles = vi.fn().mockResolvedValueOnce(original).mockRejectedValueOnce(new Error('回读失败')).mockResolvedValue({ ...original, active: {} });
    fake.applyCodexProfile = vi.fn(async () => { await applied; return { ok: true, changes: [{ key: 'experimental_bearer_token', value: null, action: 'removed' }] }; });
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    const token = await screen.findByRole('textbox', { name: '访问令牌' });
    const save = screen.getByRole('button', { name: '应用端点配置' });
    fireEvent.change(token, { target: { value: '' } });
    fireEvent.click(save);
    expect(token).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '接口地址' })).toBeDisabled();
    expect(save).toBeDisabled();
    resolveApply();
    expect(await screen.findByRole('alert')).toHaveTextContent('端点保存失败：回读失败');
    expect(token).toHaveValue('');
    expect(token).toBeEnabled();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(token).toHaveValue('');
    expect(save).toBeDisabled();
  });

  it('can remove an existing empty assignment after the user explicitly clears its draft', async () => {
    const fake = api();
    fake.codexProfiles = vi.fn(async () => ({ path: 'C:/demo/config.toml', exists: true, active: { experimental_bearer_token: '' }, alternatives: {}, current: null }));
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    const token = await screen.findByRole('textbox', { name: '访问令牌' });
    const save = screen.getByRole('button', { name: '应用端点配置' });
    expect(save).toBeDisabled();
    fireEvent.change(token, { target: { value: 'temporary-draft' } });
    fireEvent.change(token, { target: { value: '' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(fake.applyCodexProfile).toHaveBeenCalledWith([{ key: 'experimental_bearer_token', value: null }]));
  });

  it('ignores a refresh response started before an endpoint deletion was saved', async () => {
    const fake = api();
    const original = { path: 'C:/demo/config.toml', exists: true, active: { experimental_bearer_token: 'saved-token' }, alternatives: {}, current: null };
    const stale = deferred<typeof original>();
    fake.codexProfiles = vi.fn().mockResolvedValueOnce(original).mockReturnValueOnce(stale.promise).mockResolvedValue({ ...original, active: {} });
    render(<App api={fake} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '续写与进程' }));
    const token = await screen.findByRole('textbox', { name: '访问令牌' });
    fireEvent.change(token, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(fake.codexProfiles).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '应用端点配置' }));
    await waitFor(() => expect(fake.codexProfiles).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(token).toBeEnabled());
    await act(async () => { stale.resolve(original); await stale.promise; });
    expect(token).toHaveValue('');
    expect(screen.getByRole('button', { name: '应用端点配置' })).toBeDisabled();
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
    openSettings();
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

/** Open settings through the documented shortcut, available on every page. */
function openSettings() {
  fireEvent.keyDown(document, { key: ',', ctrlKey: true });
}

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
    expect(document.querySelector('.app-shell')).toHaveClass('app-shell--compact');
    expect(within(titlebar()).getByRole('button', { name: '展开侧栏' })).toBeInTheDocument();
  });

  it('opens a process detail page when a session is chosen from the sidebar', async () => {
    const fake = api();
    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    const row = list.querySelectorAll('.sidebar-row__open')[0] as HTMLElement;
    fireEvent.click(row);

    // The main area switches to that process, and the row stays marked as selected.
    expect(await screen.findByRole('heading', { name: '进程详情' })).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(list.querySelectorAll('.sidebar-row__open[aria-current="true"]')).toHaveLength(1);
    // And it can be left again.
    fireEvent.click(screen.getByRole('button', { name: /返回列表/u }));
    expect(await screen.findByRole('heading', { name: '进程监控' })).toBeInTheDocument();
  });

  it('explains a transport error in words, not as the engine identifier', async () => {
    /**
     * The engine reports `no-cwd-match`. The capability badge translates it — 未找到同目录 Codex 线程 — while
     * the detail page's 传输错误 row printed the raw identifier: the same value, explained on one surface and
     * not on the other. That is the class the decision chip's English "disabled" belonged to.
     */
    const fake = api();
    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    fireEvent.click(within(list).getByTitle(/PID 12/u));

    expect(await screen.findByRole('heading', { name: '进程详情' })).toBeInTheDocument();
    const row = (await screen.findByText('传输错误')).closest('div');
    expect(row?.textContent, 'the row does not explain the error').toContain('未找到同目录 Codex 线程');
    expect(screen.queryByText('no-cwd-match'), 'the engine identifier is shown to the user').toBeNull();
  });

  it('filters the sidebar process list without touching the page', async () => {
    const fake = api();
    render(<App api={fake} />);
    const list = await screen.findByRole('group', { name: '进程列表' });
    expect(list.querySelectorAll('.sidebar-row')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('搜索进程'), { target: { value: 'zzz-no-match' } });
    expect(list.querySelectorAll('.sidebar-row')).toHaveLength(0);
    expect(within(list).getByText('没有匹配的进程')).toBeInTheDocument();
    // The page itself must not have changed.
    expect(screen.getByRole('heading', { name: '进程监控' })).toBeInTheDocument();
  });

  it('opens 文件 with 返回应用 and 隐藏到托盘 as menu items', async () => {
    const fake = api();
    render(<App api={fake} />);
    // Start somewhere other than the overview so 返回应用 has work to do.
    openSettings();
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

  /**
   * The 编辑 items were clickable and did nothing.
   *
   * They carried no action, no URL and no handler, so 撤销/重做/剪切/复制/粘贴/全选 were menu items that responded
   * to a click by doing nothing at all — in the desktop app as well as here. They go through the bridge now, and
   * a browser is told so rather than being offered six dead items.
   */
  it('disables the bridge-backed 编辑 items in a plain browser', async () => {
    render(<App api={api()} />);
    fireEvent.click(within(titlebar()).getByRole('button', { name: '编辑' }));
    const menu = screen.getByRole('menu', { name: '编辑' });

    for (const label of ['撤销', '重做', '剪切', '复制', '粘贴', '全选']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(label) });
      expect(item, `${label} offers a click that cannot do anything`).toBeDisabled();
      expect(item).toHaveAttribute('title', '仅在桌面应用中可用');
    }
  });

  it('exercises the desktop bridge when one is installed', async () => {
    const shell = {
      reload: vi.fn(), toggleFullScreen: vi.fn(), zoom: vi.fn(), quit: vi.fn(),
      undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(),
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

      // 编辑: each item performs its own command, so none of them is a click that does nothing.
      const edits = [
        ['撤销', 'undo'], ['重做', 'redo'], ['剪切', 'cut'], ['复制', 'copy'], ['粘贴', 'paste'], ['全选', 'selectAll'],
      ] as const;
      for (const [label, method] of edits) {
        fireEvent.click(within(titlebar()).getByRole('button', { name: '编辑' }));
        fireEvent.click(within(screen.getByRole('menu', { name: '编辑' })).getByRole('menuitem', { name: new RegExp(label) }));
        await waitFor(() => expect(shell[method], `${label} did not reach the bridge`).toHaveBeenCalled());
      }

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
      expect(within(rail).getByRole('tab', { name: '关于' })).toHaveAttribute('aria-selected', 'true');
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

    openSettings();
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
    openSettings();
    expect(await screen.findByRole('heading', { name: 'Watchdog 设置' })).toBeInTheDocument();
    expect(forward()).toBeDisabled();
  });
});

describe('working settings integration', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'selbstlaufDesktop'); });

  it('saves the automatic continuation and per-tool switches with only resumable Goal states', async () => {
    const fake = api();
    render(<App api={fake} />);
    openSettings();
    for (const label of ['启用自动续写', '监控 Claude Code', '监控 Codex', '监控 DeepSeek Harness']) {
      fireEvent.click(await screen.findByRole('checkbox', { name: label }));
    }
    expect(screen.queryByRole('checkbox', { name: 'Goal 状态 complete' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Goal 状态 paused' }));
    expect(screen.getByRole('checkbox', { name: 'Goal 状态 active' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(fake.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      tools: expect.objectContaining({
        claude: expect.objectContaining({ enabled: false }),
        codex: expect.objectContaining({ enabled: false, goalStatuses: ['active'] }),
        dsh: expect.objectContaining({ enabled: false }),
      }),
    })));
  });

  it('keeps the current density, pet and palette after rejected storage writes', async () => {
    render(<App api={api()} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '外观' }));
    const previousAccent = document.documentElement.style.getPropertyValue('--accent');
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      fireEvent.change(screen.getByRole('combobox', { name: '界面密度' }), { target: { value: 'compact' } });
      expect(screen.getByRole('alert')).toHaveTextContent('保存失败');
      expect(screen.getByRole('combobox', { name: '界面密度' })).toHaveValue('comfortable');
      fireEvent.change(screen.getByRole('combobox', { name: '强调色' }), { target: { value: '#e05c93' } });
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe(previousAccent);
      fireEvent.click(screen.getByRole('tab', { name: '宠物' }));
      fireEvent.click(screen.getByRole('checkbox', { name: '桌面宠物' }));
      expect(screen.getByRole('checkbox', { name: '桌面宠物' })).not.toBeChecked();
      expect(document.querySelector('.workspace-pet')).toBeNull();
    } finally { write.mockRestore(); }
  });

  it('disables unavailable desktop settings and reports their real read error', async () => {
    Object.assign(window, { selbstlaufDesktop: { settings: {
      get: async () => { throw new Error('设置文件无法读取'); }, set: vi.fn(),
    } } });
    render(<App api={api()} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '启动与托盘' }));
    expect(await screen.findByText('读取桌面设置失败：设置文件无法读取')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '关闭时最小化到托盘' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '首选终端' })).toBeDisabled();
  });

  it('waits for desktop writes, retains the old value on failure and adopts changes from another window', async () => {
    const saving = deferred<unknown>();
    let receive: ((value: { closeToTray: boolean; preferredTerminal: string | null }) => void) | undefined;
    const set = vi.fn(() => saving.promise);
    const unsubscribe = vi.fn();
    Object.assign(window, { selbstlaufDesktop: { platform: 'linux', settings: {
      get: async () => ({ closeToTray: true, preferredTerminal: 'system' }), set,
      onChange: (listener: typeof receive) => { receive = listener; return unsubscribe; },
    } } });
    const rendered = render(<App api={api()} />);
    openSettings();
    fireEvent.click(await screen.findByRole('tab', { name: '启动与托盘' }));
    const toggle = screen.getByRole('checkbox', { name: '关闭时最小化到托盘' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.queryByRole('option', { name: 'PowerShell' })).toBeNull();
    expect(screen.getByRole('option', { name: 'GNOME Terminal' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    act(() => saving.reject(new Error('磁盘写入失败')));
    expect(await screen.findByText('保存桌面设置失败：磁盘写入失败')).toBeInTheDocument();
    expect(toggle).toBeChecked();
    act(() => receive?.({ closeToTray: false, preferredTerminal: 'konsole' }));
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: '首选终端' })).toHaveValue('konsole');
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('opens the selected session through the desktop terminal action and reports a real refusal', async () => {
    const openTerminal = vi.fn().mockResolvedValueOnce({ ok: true, terminal: 'konsole' }).mockResolvedValueOnce({ ok: false, reason: '终端应用未安装' });
    Object.assign(window, { selbstlaufDesktop: { shell: { openTerminal } } });
    render(<App api={api()} />);
    const button = (await screen.findAllByRole('button', { name: '打开终端 PID 13' }))[0];
    fireEvent.click(button);
    await waitFor(() => expect(openTerminal).toHaveBeenCalledWith('dsh:hosted'));
    expect(await screen.findByText('已打开终端：konsole')).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText('终端应用未安装')).toBeInTheDocument();
  });
  it('explains an empty process list instead of showing a table with no rows', async () => {
    /**
     * The connecting state above is also the state of a machine where nothing has been discovered:
     * zero sessions. The overview rendered the table's header row and an empty card list, so the
     * first screen of a quiet machine was six column titles and nothing else — and an empty table
     * is announced as a table with no data, which reads as a rendering fault rather than a state.
     * The sidebar list and the 事件 page both explain their empty state; this panel did not.
     */
    const fake = api();
    fake.sessions = vi.fn(async () => []);
    render(<App api={fake} />);

    const section = screen.getByRole('heading', { name: '独立进程' }).closest('section');
    expect(section, 'the process section is not rendered at all').not.toBeNull();
    expect(within(section!).getByText('尚未发现进程')).toBeInTheDocument();
    expect(
      within(section!).queryByRole('table'),
      'an empty table is announced as a table with no data',
    ).not.toBeInTheDocument();
  });
  it('shows no example sessions while the local service is still connecting', () => {
    const fake = api();
    const pendingHealth = deferred<HealthView>();
    fake.health = vi.fn(() => pendingHealth.promise);
    render(<App api={fake} />);

    expect(screen.queryAllByRole('button', { name: /立即续写 PID/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '事件' }));
    expect(screen.getByText('暂无事件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进程' }));
    expect(screen.queryByText('样例数据')).not.toBeInTheDocument();
  });
});
