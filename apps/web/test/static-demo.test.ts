import { describe, expect, it } from 'vitest';
import { createStaticDemoApi, STATIC_DEMO_STORAGE_KEY } from '../src/api/static-demo';
import { AGENT_CATALOG } from '../../cli/src/environment/catalog';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('static Pages demo API', () => {
  it('covers the full CLI catalog while preserving sample versions and manual installation policies', async () => {
    const api = createStaticDemoApi(null);
    const environment = await api.environment();
    expect(environment.tools.map(tool => tool.id)).toEqual([
      'claude', 'codex', 'gemini', 'grok', 'opencode', 'openclaw', 'qwen', 'hermes', 'pi', 'crush', 'dsh', 'cline', 'kilo',
    ]);
    for (const entry of AGENT_CATALOG) {
      expect(environment.tools.find(tool => tool.id === entry.id)).toEqual(expect.objectContaining({
        label: entry.label, packageName: entry.packageName, installCommand: entry.installCommand,
        installable: entry.updateSource === 'npm', installUrl: entry.installUrl,
      }));
    }
    expect(environment.tools.find(tool => tool.id === 'claude')).toEqual(expect.objectContaining({ installed: '2.1.274', latest: '2.1.276', state: 'outdated' }));
    for (const id of ['qwen', 'hermes', 'pi', 'crush', 'dsh', 'cline', 'kilo']) {
      expect(environment.tools.find(tool => tool.id === id)).toEqual(expect.objectContaining({ installed: null, latest: null, state: 'missing' }));
    }
    expect(environment.manualCommands).toHaveLength(12);
    expect(environment.manualCommands.every(command => command.startsWith('npm i -g '))).toBe(true);
    expect(environment.manualCommands.join('\n')).not.toContain('hermes');
    expect(await api.upgradeTool('hermes')).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('official installation guide') }));
    expect((await api.environment()).tools).toEqual(environment.tools);
  });

  it('persists a simulated install with an unknown version without inventing an upgrade', async () => {
    const storage = memoryStorage();
    const api = createStaticDemoApi(storage);
    expect(await api.upgradeTool('qwen')).toEqual(expect.objectContaining({ ok: true, output: expect.stringContaining('未安装本机软件包') }));
    const reloaded = createStaticDemoApi(storage);
    const environment = await reloaded.environment();
    expect(environment.tools.find(tool => tool.id === 'qwen')).toEqual(expect.objectContaining({ installed: 'unknown', latest: null, state: 'unknown' }));
    expect(environment.upgrades).not.toContain('qwen');
    expect(environment.missing).not.toContain('qwen');
  });

  it('returns its existing audit seed without exposing shared mutable events', async () => {
    const api = createStaticDemoApi(null);
    const history = await api.audit!(1_000);
    expect(history.map((event) => event.id)).toEqual(['demo-1', 'demo-2', 'demo-3', 'demo-4']);
    history[0].id = 'modified';
    expect((await api.audit!(1_000))[0].id).toBe('demo-1');
  });
  it('keeps demo state isolated between page loads', async () => {
    const first = createStaticDemoApi(null);
    const before = await first.sessions();
    await first.pause(before[0].id);
    expect((await first.sessions())[0].paused).toBe(true);

    const second = createStaticDemoApi(null);
    expect((await second.sessions())[0].paused).toBe(false);
  });

  it('updates configuration without mutating the caller object', async () => {
    const api = createStaticDemoApi(null);
    const draft = await api.config();
    draft.tools.codex.normalPrompt = 'demo prompt';
    const saved = await api.updateConfig(draft);
    draft.tools.codex.normalPrompt = 'changed later';
    expect(saved.tools.codex.normalPrompt).toBe('demo prompt');
    expect((await api.config()).tools.codex.normalPrompt).toBe('demo prompt');
  });

  it('can recover the demo service after an emergency stop', async () => {
    const api = createStaticDemoApi(null);
    await expect(api.install()).resolves.toBeUndefined();
    await api.stop();
    expect((await api.health()).running).toBe(false);
    await api.start();
    expect((await api.health()).running).toBe(true);
  });

  it('keeps startup-task state local to each demo instance', async () => {
    const first = createStaticDemoApi(null);
    await first.installStartup();
    expect((await first.startup()).installed).toBe(true);

    const second = createStaticDemoApi(null);
    expect((await second.startup()).installed).toBe(false);
    await first.uninstallStartup();
    expect((await first.startup()).installed).toBe(false);
  });

  it('switches Codex endpoints and parks the replaced base_url in memory', async () => {
    const api = createStaticDemoApi(null);
    const before = await api.codexProfiles();
    expect(before.active.base_url).toBe('https://external-api-platform.hkgai.net/v1');
    expect(before.current?.name).toBe('external-api-platform.hkgai.net');

    await api.applyCodexProfile([{ key: 'base_url', value: 'https://www.sevnx.lol' }]);
    const after = await api.codexProfiles();
    expect(after.active.base_url).toBe('https://www.sevnx.lol');
    expect(after.current?.name).toBe('www.sevnx.lol');
    expect(after.alternatives.base_url).toContain('https://external-api-platform.hkgai.net/v1');
  });

  it('models an install so the demo upgrade button reports a new version', async () => {
    const api = createStaticDemoApi(null);
    const before = await api.environment();
    expect(before.upgrades).toContain('claude');

    const result = await api.upgradeTool('claude');
    expect(result.ok).toBe(true);
    const after = await api.environment();
    expect(after.upgrades).not.toContain('claude');
    expect(after.tools.find((tool) => tool.id === 'claude')?.installed).toBe('2.1.276');

    const all = await api.upgradeAllTools();
    expect(all.ok).toBe(true);
    expect(all.results.map((entry) => entry.id)).toEqual(['gemini', 'opencode', 'openclaw']);
    expect((await api.environment()).upgrades).toEqual([]);

    // An unknown id is refused instead of quietly succeeding.
    expect((await api.upgradeTool('nope')).ok).toBe(false);
  });

  it('models explicit Claude Hook installation, disable, and uninstall in memory', async () => {
    const api = createStaticDemoApi(null);
    expect(await api.claudeHook()).toEqual({
      installed: false,
      enabled: false,
      restartRequired: false,
      manualReviewRequired: false,
    });

    expect(await api.installClaudeHook()).toEqual({
      installed: true,
      enabled: false,
      restartRequired: true,
      manualReviewRequired: false,
    });
    const config = await api.config();
    config.tools.claude.stopHook.enabled = true;
    await api.updateConfig(config);
    expect((await api.claudeHook()).enabled).toBe(true);

    expect(await api.disableClaudeHook()).toEqual(expect.objectContaining({ installed: true, enabled: false }));
    expect((await api.config()).tools.claude.stopHook.enabled).toBe(false);
    expect(await api.uninstallClaudeHook()).toEqual({
      installed: false,
      enabled: false,
      restartRequired: false,
      manualReviewRequired: false,
    });
  });

  it('restores every demo setting while resetting sample process state', async () => {
    const storage = memoryStorage();
    const api = createStaticDemoApi(storage);
    const config = await api.config();
    config.dryRun = false;
    config.pollIntervalMs = 4200;
    config.tools.codex.normalPrompt = 'saved prompt';
    config.tools.claude.stopHook.enabled = true;
    config.wslDistribution = 'Ubuntu-24.04';
    config.processFilters.include = ['Tabby'];
    const savedConfig = await api.updateConfig(config);
    await api.installStartup();
    await api.installClaudeHook();
    await api.applyCodexProfile([{ key: 'base_url', value: 'https://example.test/v1' }]);
    await api.upgradeTool('claude');
    await api.stop();
    await api.pause((await api.sessions())[0].id);

    const reloaded = createStaticDemoApi(storage);
    expect(savedConfig).toEqual(expect.objectContaining({
      dryRun: false, pollIntervalMs: 4200, wslDistribution: 'Ubuntu-24.04',
      processFilters: expect.objectContaining({ include: ['Tabby'] }),
      tools: expect.objectContaining({
        codex: expect.objectContaining({ normalPrompt: 'saved prompt' }),
        claude: expect.objectContaining({ stopHook: expect.objectContaining({ enabled: true }) }),
      }),
    }));
    expect(await reloaded.config()).toEqual(savedConfig);
    expect((await reloaded.startup()).installed).toBe(true);
    expect(await reloaded.claudeHook()).toEqual(expect.objectContaining({ installed: true, enabled: true }));
    expect((await reloaded.codexProfiles()).active.base_url).toBe('https://example.test/v1');
    expect((await reloaded.codexProfiles()).alternatives.base_url).toContain('https://external-api-platform.hkgai.net/v1');
    expect((await reloaded.environment()).tools.find((tool) => tool.id === 'claude')?.installed).toBe('2.1.276');
    expect((await reloaded.health()).running).toBe(false);
    expect((await reloaded.sessions())[0].paused).toBe(false);
    expect(await reloaded.inject('any')).toEqual({ dryRun: true });
    await expect(reloaded.focus('any')).rejects.toThrow('在线演示无法打开本机运行位置');
  });

  it('refuses invalid imported config using the live service constraints', async () => {
    const api = createStaticDemoApi(memoryStorage());
    const before = await api.config();
    await expect(api.updateConfig({} as never)).rejects.toThrow();
    await expect(api.updateConfig({ ...before, pollIntervalMs: 0 })).rejects.toThrow('positive finite number');
    await expect(api.updateConfig({ ...before, tools: { ...before.tools, codex: { ...before.tools.codex, goalStatuses: ['complete'] } } })).rejects.toThrow('terminal status');
    expect(await api.config()).toEqual(before);
  });

  it('falls back safely when stored data is malformed or from another schema', async () => {
    for (const raw of ['{', '{}', '{"schema":2}', '{"schema":1,"config":{}}']) {
      const storage = memoryStorage();
      storage.setItem(STATIC_DEMO_STORAGE_KEY, raw);
      expect((await createStaticDemoApi(storage).config()).pollIntervalMs).toBe(2000);
    }
  });

  it('reports blocked persistence instead of claiming a setting was saved', async () => {
    const api = createStaticDemoApi({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    const before = await api.config();
    await expect(api.updateConfig({ ...before, pollIntervalMs: 4500 })).rejects.toThrow('浏览器无法保存演示设置');
    expect(await api.config()).toEqual(before);
    await expect(api.installStartup()).rejects.toThrow('浏览器无法保存演示设置');
    expect((await api.startup()).installed).toBe(false);
  });

  it('persists simulated installation and makes uninstall undo startup and running state', async () => {
    const storage = memoryStorage();
    const api = createStaticDemoApi(storage);
    await api.installStartup();
    await api.uninstall();
    const uninstalled = createStaticDemoApi(storage);
    expect(await uninstalled.health()).toEqual(expect.objectContaining({ ok: false, running: false }));
    expect((await uninstalled.startup()).installed).toBe(false);
    await expect(uninstalled.start()).rejects.toThrow('未安装');
    await expect(uninstalled.installStartup()).rejects.toThrow('未安装');
    await uninstalled.install();
    expect((await createStaticDemoApi(storage).health()).ok).toBe(true);
    await uninstalled.start();
    await uninstalled.installStartup();
    const restored = createStaticDemoApi(storage);
    expect((await restored.health()).running).toBe(true);
    expect((await restored.startup()).installed).toBe(true);
  });

  it('loads existing schema-1 settings written before the installed field existed', async () => {
    const storage = memoryStorage();
    const api = createStaticDemoApi(storage);
    await api.updateConfig({ ...await api.config(), pollIntervalMs: 6000 });
    const saved = JSON.parse(storage.getItem(STATIC_DEMO_STORAGE_KEY)!);
    delete saved.installed;
    storage.setItem(STATIC_DEMO_STORAGE_KEY, JSON.stringify(saved));
    const legacy = createStaticDemoApi(storage);
    expect((await legacy.config()).pollIntervalMs).toBe(6000);
    expect((await legacy.health()).ok).toBe(true);
  });

  it('applies explicit null edits and keeps untouched active values across reloads', async () => {
    const storage = memoryStorage();
    const api = createStaticDemoApi(storage);
    await api.applyCodexProfile([{ key: 'model', value: 'sample-model' }, { key: 'experimental_bearer_token', value: 'sample-token' }]);
    const before = await api.codexProfiles();
    expect(before.active.base_url).toBe('https://external-api-platform.hkgai.net/v1');
    const outcome = await api.applyCodexProfile([{ key: 'experimental_bearer_token', value: null }, { key: 'base_url', value: 'https://new.test' }]);
    expect(outcome.changes).toContainEqual({ key: 'experimental_bearer_token', action: 'removed', value: null });
    const restored = createStaticDemoApi(storage);
    const after = await restored.codexProfiles();
    expect(after.active.model).toBe('sample-model');
    expect(after.active.base_url).toBe('https://new.test');
    expect(after.active.experimental_bearer_token).toBeUndefined();
    expect(after.alternatives.experimental_bearer_token).toEqual(['sample-token']);
    await restored.applyCodexProfile([{ key: 'experimental_bearer_token', value: 'sample-token' }]);
    expect((await restored.codexProfiles()).active.experimental_bearer_token).toBe('sample-token');
    await expect(restored.applyCodexProfile([{ key: 'approval_policy', value: null }])).rejects.toThrow('unsupported');
  });
});
