import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { WatchdogApi, WatchdogConfig, WatchdogEvent } from '../src/api/client';

function fixture() {
  let saved: WatchdogConfig = {
    enabled: true, dryRun: true, pollIntervalMs: 2000, defaultIdleTimeoutMs: 120000,
    defaultCooldownMs: 300000, maxAttemptsPerQuietPeriod: 1, wslDistribution: '',
    tools: {
      claude: { enabled: true, normalPrompt: 'saved Claude prompt', stopHook: { enabled: false, leaseTtlMs: 15000, commandTimeoutMs: 1500 } },
      codex: { enabled: true, normalPrompt: 'saved Codex prompt', goalPrompt: '/goal resume', goalStatuses: ['active', 'paused'] },
      dsh: { enabled: true, normalPrompt: '继续', sessionWindowMs: 3600000, allowApiInput: true },
    },
    processFilters: { sameUserOnly: true, include: ['original'], exclude: [] },
  };
  let receive: ((event: WatchdogEvent) => void) | undefined;
  const api: WatchdogApi = {
    health: vi.fn(async () => ({ ok: true, running: true, dryRun: saved.dryRun, lastPollAtMs: Date.now() })),
    config: vi.fn(async () => structuredClone(saved)),
    updateConfig: vi.fn(async (next) => { saved = structuredClone(next); return structuredClone(saved); }),
    sessions: vi.fn(async () => []), audit: vi.fn(async () => []),
    pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), inject: vi.fn(async () => ({ dryRun: false })),
    focus: vi.fn(async () => ({ focused: true })),
    install: vi.fn(async () => undefined), startup: vi.fn(async () => ({ installed: false })), installStartup: vi.fn(async () => undefined), uninstallStartup: vi.fn(async () => undefined),
    claudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    codexProfiles: vi.fn(async () => ({ path: '/fixture/config.toml', exists: true, active: {}, alternatives: {}, current: null })),
    applyCodexProfile: vi.fn(async () => ({ ok: true, changes: [] })),
    environment: vi.fn(async () => ({ tools: [], upgrades: [], missing: [], manualCommands: [], checkedAtMs: 1 })),
    refreshEnvironment: vi.fn(async () => ({ tools: [], upgrades: [], missing: [], manualCommands: [], checkedAtMs: 1 })),
    upgradeTool: vi.fn(async (id) => ({ id, ok: true, output: '' })), upgradeAllTools: vi.fn(async () => ({ ok: true, results: [] })),
    installClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    uninstallClaudeHook: vi.fn(async () => ({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false })),
    disableClaudeHook: vi.fn(async () => ({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false })),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), uninstall: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => { receive = listener; return () => undefined; }),
  };
  return { api, saved: () => saved, external: (next: WatchdogConfig) => { saved = structuredClone(next); }, notify: () => act(() => { receive?.({ kind: 'config', data: saved }); }) };
}

async function settings(f: ReturnType<typeof fixture>) {
  render(<App api={f.api} />);
  await screen.findByRole('heading', { name: '进程监控' });
  fireEvent.keyDown(document, { key: ',', ctrlKey: true });
  await screen.findByRole('tablist', { name: '设置分区' });
  await waitFor(() => expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(2000));
}
function section(name: string) {
  fireEvent.click(within(screen.getByRole('tablist', { name: '设置分区' })).getByRole('tab', { name }));
}
async function refresh(f: ReturnType<typeof fixture>) {
  const before = vi.mocked(f.api.config).mock.calls.length;
  f.notify();
  await waitFor(() => expect(vi.mocked(f.api.config).mock.calls.length).toBeGreaterThan(before));
  await act(async () => { await Promise.resolve(); });
}

afterEach(() => { vi.restoreAllMocks(); });

it('retains edited timing, prompts, and filters during routine polling and repeated service events', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  const f = fixture(); await settings(f);
  fireEvent.change(screen.getByLabelText('轮询间隔（毫秒）'), { target: { value: '1750' } });
  fireEvent.change(screen.getByLabelText('Claude', { exact: true }), { target: { value: 'unfinished local prompt' } });
  fireEvent.change(screen.getByLabelText('包含匹配'), { target: { value: 'local, edits' } });
  const poll = interval.mock.calls.find((call) => call[1] === 10000)?.[0];
  expect(poll).toBeTypeOf('function');
  await act(async () => { (poll as () => void)(); });
  await refresh(f);
  expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(1750);
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('unfinished local prompt');
  expect(screen.getByLabelText('包含匹配')).toHaveValue('local, edits');
  section('续写与进程');
  fireEvent.change(screen.getByLabelText('Lease 有效期（毫秒）'), { target: { value: '17000' } });
  await refresh(f);
  expect(screen.getByLabelText('Lease 有效期（毫秒）')).toHaveValue(17000);
  section('常规');
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('unfinished local prompt');
});

it('merges external changes into untouched fields while retaining local nested and filter drafts', async () => {
  const f = fixture(); await settings(f);
  fireEvent.change(screen.getByLabelText('Claude', { exact: true }), { target: { value: 'local Claude' } });
  fireEvent.change(screen.getByLabelText('包含匹配'), { target: { value: 'local include' } });
  section('续写与进程');
  fireEvent.change(screen.getByLabelText('Lease 有效期（毫秒）'), { target: { value: '19000' } });
  const external = structuredClone(f.saved());
  external.tools.claude.normalPrompt = 'external competing Claude';
  external.tools.claude.stopHook.commandTimeoutMs = 2300;
  external.tools.claude.stopHook.leaseTtlMs = 21000;
  external.processFilters.include = ['external include'];
  external.processFilters.exclude = ['external exclude'];
  external.pollIntervalMs = 2750;
  f.external(external); await refresh(f);
  expect(screen.getByLabelText('Lease 有效期（毫秒）')).toHaveValue(19000);
  expect(screen.getByLabelText('命令超时（毫秒）')).toHaveValue(2300);
  section('常规');
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('local Claude');
  expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(2750);
  expect(screen.getByLabelText('包含匹配')).toHaveValue('local include');
  expect(screen.getByLabelText('排除匹配')).toHaveValue('external exclude');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(f.api.updateConfig).toHaveBeenCalled());
  expect(vi.mocked(f.api.updateConfig).mock.calls[0][0]).toMatchObject({ pollIntervalMs: 2750, tools: { claude: { normalPrompt: 'local Claude', stopHook: { leaseTtlMs: 19000, commandTimeoutMs: 2300 } } }, processFilters: { include: ['local include'], exclude: ['external exclude'] } });
  await screen.findByText('配置已保存');
  f.external({ ...structuredClone(f.saved()), pollIntervalMs: 3250 });
  await refresh(f);
  expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(3250);
  const confirmed = structuredClone(f.saved());
  confirmed.tools.claude.normalPrompt = 'external after successful save';
  confirmed.processFilters.include = ['after-save include'];
  f.external(confirmed); await refresh(f);
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('external after successful save');
  expect(screen.getByLabelText('包含匹配')).toHaveValue('after-save include');
});

it('retains drafts on failed saves and merges untouched values before retrying', async () => {
  const f = fixture(); await settings(f);
  vi.mocked(f.api.updateConfig).mockRejectedValueOnce(new Error('fixture config write failed'));
  fireEvent.change(screen.getByLabelText('Claude', { exact: true }), { target: { value: 'retry local prompt' } });
  fireEvent.change(screen.getByLabelText('排除匹配'), { target: { value: 'retry exclude' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('fixture config write failed');
  const external = structuredClone(f.saved()); external.pollIntervalMs = 3500;
  f.external(external); await refresh(f);
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('retry local prompt');
  expect(screen.getByLabelText('排除匹配')).toHaveValue('retry exclude');
  expect(screen.getByLabelText('轮询间隔（毫秒）')).toHaveValue(3500);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存');
  expect(f.saved()).toMatchObject({ pollIntervalMs: 3500, tools: { claude: { normalPrompt: 'retry local prompt' } }, processFilters: { exclude: ['retry exclude'] } });
});

it('retains edits made while a save is pending and discards an older refresh response after confirmation', async () => {
  const f = fixture(); await settings(f);
  let resolveRead!: (config: WatchdogConfig) => void;
  const old = structuredClone(f.saved());
  vi.mocked(f.api.config).mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  f.notify(); await waitFor(() => expect(resolveRead).toBeTypeOf('function'));
  let confirm!: (config: WatchdogConfig) => void;
  vi.mocked(f.api.updateConfig).mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
  fireEvent.change(screen.getByLabelText('Claude', { exact: true }), { target: { value: 'submitted prompt' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(confirm).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('Claude', { exact: true }), { target: { value: 'newer local draft' } });
  const submitted = structuredClone(vi.mocked(f.api.updateConfig).mock.calls[0][0]);
  f.external(submitted);
  await act(async () => { confirm(submitted); });
  await screen.findByText('配置已保存');
  await act(async () => { resolveRead(old); });
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('newer local draft');
  section('导入');
  section('常规');
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('newer local draft');
  await refresh(f);
  expect(screen.getByLabelText('Claude', { exact: true })).toHaveValue('newer local draft');
});
