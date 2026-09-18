import { describe, expect, it } from 'vitest';
import { createStaticDemoApi } from '../src/api/static-demo';

describe('static Pages demo API', () => {
  it('keeps demo state isolated between page loads', async () => {
    const first = createStaticDemoApi();
    const before = await first.sessions();
    await first.pause(before[0].id);
    expect((await first.sessions())[0].paused).toBe(true);

    const second = createStaticDemoApi();
    expect((await second.sessions())[0].paused).toBe(false);
  });

  it('updates configuration without mutating the caller object', async () => {
    const api = createStaticDemoApi();
    const draft = await api.config();
    draft.tools.codex.normalPrompt = 'demo prompt';
    const saved = await api.updateConfig(draft);
    draft.tools.codex.normalPrompt = 'changed later';
    expect(saved.tools.codex.normalPrompt).toBe('demo prompt');
    expect((await api.config()).tools.codex.normalPrompt).toBe('demo prompt');
  });

  it('can recover the demo service after an emergency stop', async () => {
    const api = createStaticDemoApi();
    await expect(api.install()).resolves.toBeUndefined();
    await api.stop();
    expect((await api.health()).running).toBe(false);
    await api.start();
    expect((await api.health()).running).toBe(true);
  });

  it('keeps startup-task state local to each demo instance', async () => {
    const first = createStaticDemoApi();
    await first.installStartup();
    expect((await first.startup()).installed).toBe(true);

    const second = createStaticDemoApi();
    expect((await second.startup()).installed).toBe(false);
    await first.uninstallStartup();
    expect((await first.startup()).installed).toBe(false);
  });

  it('switches Codex endpoints and parks the replaced base_url in memory', async () => {
    const api = createStaticDemoApi();
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
    const api = createStaticDemoApi();
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
    const api = createStaticDemoApi();
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
});
