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
});
